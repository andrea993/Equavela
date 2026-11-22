// GUI latency benchmark on the real desktop app. For each worksheet it
// starts the app with that worksheet, lets the page run `app/src/perf/runner.ts` (injected by the opt-in
// `e2e-perf` feature) and collects the report through a local endpoint.
//
// Build once (release: the numbers must come from optimised code):
//   pnpm --dir app build && cargo build --release -p equavela-app --features e2e-perf,tauri/custom-protocol
// Run (worksheets from scripts/perf/gen-worksheet.mjs):
//   node app/scripts/perf-real.mjs [--display] [--repeat 30] [--pass] [--memory-max 5G] [--out DIR] sheet1.eqv ...
//
// The app runs in its own systemd user scope capped at `--memory-max` (default 5G, no swap): a worksheet that
// makes the webview grow without bound kills only the app, never the user's session (a 20k-region run once
// took ~9 GB and the OOM killer took the desktop down with it). The scope's peak memory is part of the report.
//
// By default the app runs under xvfb-run on a 1920x1080 virtual screen (software rendering, nothing on the
// user's desktop). `--display` uses the real display instead (GPU compositing, closer to what the user sees;
// a window appears). EQUAVELA_APP_EXE selects another binary. Linux only for now: on Windows the same
// runner can be driven through the DevTools protocol of `real-app.mjs`.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const value = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const [, v] = args.splice(i, 2);
  return v;
};
const display = flag('--display');
const pass = flag('--pass');
const repeat = Number(value('--repeat', '30'));
const memoryMax = value('--memory-max', '5G');
const out = resolve(value('--out', mkdtempSync(join(tmpdir(), 'equavela-perf-'))));
const exe = resolve(process.env.EQUAVELA_APP_EXE || 'target/release/equavela-app');
if (args.length === 0) {
  console.error('usage: node app/scripts/perf-real.mjs [--display] [--repeat N] [--pass] [--out DIR] sheet.eqv ...');
  process.exit(2);
}
if (!existsSync(exe)) {
  console.error(`missing ${exe}; build it with: pnpm --dir app build && cargo build --release -p equavela-app --features e2e-perf,tauri/custom-protocol`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

let failures = 0;
for (const source of args.map((a) => resolve(a))) {
  // The benchmark commits edits, so the app autosaves a recovery file next to the worksheet; a leftover one
  // would make the next run stop at the "restore?" prompt. Every run opens a fresh copy instead.
  const sheet = join(mkdtempSync(join(tmpdir(), 'equavela-perf-sheet-')), basename(source));
  copyFileSync(source, sheet);
  const secret = randomBytes(24).toString('hex');
  let deliver;
  const response = new Promise((done) => { deliver = done; });
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST' || ![`/${secret}`, `/${secret}/progress`].includes(req.url)) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 4_000_000) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200).end('ok');
      if (req.url.endsWith('/progress')) console.log(`  ${basename(sheet)}: ${body}`);
      else deliver(body);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/${secret}`;
  const env = {
    ...process.env,
    EQUAVELA_E2E_PERF_ENDPOINT: endpoint,
    EQUAVELA_E2E_PERF_OPTIONS: JSON.stringify({ repeat, pass }),
    EQUAVELA_MULTI_INSTANCE: '1',
    EQUAVELA_DRIVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'equavela-perf-data-')),
  };
  const app = display ? [exe, sheet] : ['xvfb-run', '-a', '-s', '-screen 0 1920x1080x24', exe, sheet];
  const unit = `equavela-perf-${secret.slice(0, 12)}`;
  const scope = ['--user', '--scope', '--quiet', `--unit=${unit}`, '-p', `MemoryMax=${memoryMax}`, '-p', 'MemorySwapMax=0'];
  console.log(`${basename(sheet)}: starting ${display ? 'on the display' : 'under xvfb'}, memory capped at ${memoryMax}`);
  const child = spawn('systemd-run', [...scope, ...app], { env, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
  const peak = () => {
    try {
      const bytes = Number(execFileSync('systemctl', ['--user', 'show', '-p', 'MemoryPeak', '--value', `${unit}.scope`], { encoding: 'utf8' }).trim());
      return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1048576) : null;
    } catch {
      return null;
    }
  };
  const stop = () => {
    try { execFileSync('systemctl', ['--user', 'stop', `${unit}.scope`], { stdio: 'ignore' }); } catch { /* already gone */ }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
  };
  const interrupted = () => { stop(); process.exit(130); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  let timer;
  try {
    const body = await Promise.race([
      response,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out waiting for the app')), 1_800_000); }),
      new Promise((_, reject) => child.once('exit', (code, signal) => reject(new Error(
        code === 137 || signal === 'SIGKILL' ? `app killed: over the ${memoryMax} memory cap` : `app exited (${code ?? signal})`)))),
      new Promise((_, reject) => child.once('error', reject)),
    ]);
    const result = JSON.parse(body);
    if (!result.ok) throw new Error(result.error);
    const file = join(out, `${basename(sheet).replace(/\.eqv$/, '')}.json`);
    const peakMiB = peak();
    writeFileSync(file, JSON.stringify({ sheet: source, display: display ? 'display' : 'xvfb', peakMemoryMiB: peakMiB, ...result.report }, null, 2));
    console.log(result.text);
    console.log(`peak memory of the app scope (webview, backend, Julia kernel, X server): ${peakMiB ?? '?'} MiB`);
    console.log(`  report: ${file}\n`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${basename(sheet)}: ${error.message}`);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    stop();
    await new Promise((done) => server.close(done));
  }
}
console.log(`Reports: ${out}`);
process.exitCode = failures ? 1 : 0;
