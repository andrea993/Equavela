// Screenshots of an example project in the real Linux app: opens
// app/scripts/fixtures/showcase/Steel beam design on a private Xvfb (never the user's display),
// trusts its worksheets in a scratch data folder, and saves PNGs where the page asks for them.
// Build once: pnpm --dir app build && cargo build -p equavela-app --features e2e-project,tauri/custom-protocol
// Run from the repository root: node app/scripts/showcase-project-linux.mjs <output folder>
// The project is copied to a scratch folder first, so the fixture is never changed.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve('target/debug/equavela-app');
const shots = resolve(process.argv[2] ?? 'app/scripts/out/showcase');
const scratch = mkdtempSync(join(tmpdir(), 'equavela-showcase-'));
const root = join(scratch, 'Steel beam design');
cpSync(resolve('app/scripts/fixtures/showcase/Steel beam design'), root, { recursive: true });
mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'equavela-showcase-data-'));
// The example's worksheets are trusted, so its Julia block runs.
writeFileSync(join(data, 'trusted-worksheets.json'), JSON.stringify({ trusted: [join(root, 'worksheets/beam.eqv'), join(root, 'worksheets/checks.eqv')] }));
const options = {
  showcase: {
    root,
    expand: ['assets/images/beam.svg', 'data/loads.csv', 'julia/src/SteelBeamDesign.jl', 'worksheets/beam.eqv'],
    shots: [
      { name: '1-beam', wait: '[data-region-id="m14"] .result', settle: 5000 },
      { name: '1b-beam-julia', scroll: '[data-region-id="m15"]', settle: 1500 },
      { name: '2-checks', open: 'worksheets/checks.eqv', wait: '[data-region-id="m4"] .result', settle: 2000 },
      { name: '3-julia', open: 'julia/src/SteelBeamDesign.jl', settle: 1000 },
      { name: '4-compact', open: 'worksheets/beam.eqv', press: 'Compact ribbon (icons only)', settle: 1500 },
    ],
  },
};
const secret = randomBytes(16).toString('hex');
let finish;
const done = new Promise((resolve) => { finish = resolve; });
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const path = req.url.slice(secret.length + 1);
    if (path === '/shot') {
      const { name } = JSON.parse(body);
      const xenv = { ...process.env, DISPLAY: ':120' };
      let ids = '';
      try { ids = execFileSync('xdotool', ['search', '--name', 'Equavela'], { encoding: 'utf8', env: xenv }).trim(); } catch (e) { console.log('xdotool', e.message); }
      console.log(`shot ${name}`);
      const target = ids.split('\n').filter(Boolean).pop();
      execFileSync('import', ['-display', ':120', '-window', target ?? 'root', join(shots, `${name}.png`)]);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    res.writeHead(200).end('ok');
    if (path === '/progress') console.log(`  ${body}`);
    else if (path === '') finish(body);
  });
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const env = {
  ...process.env,
  EQUAVELA_E2E_PROJECT_ENDPOINT: `http://127.0.0.1:${server.address().port}/${secret}`,
  EQUAVELA_E2E_PROJECT_OPTIONS: JSON.stringify(options),
  EQUAVELA_MULTI_INSTANCE: '1',
  EQUAVELA_DRIVER_DATA_DIR: data,
  WEBKIT_DISABLE_DMABUF_RENDERER: '1',
  WEBKIT_DISABLE_COMPOSITING_MODE: '1',
};
const xvfb = spawn('Xvfb', [':120', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: true });
await new Promise((ok) => setTimeout(ok, 1500));
// Only the virtual screen: never the user's Wayland session.
const appEnv = { ...env, DISPLAY: ':120', GDK_BACKEND: 'x11' };
delete appEnv.WAYLAND_DISPLAY;
const child = spawn(exe, [], { env: appEnv, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
const timer = setTimeout(() => finish('{"ok":false,"error":"timeout"}'), 420000);
console.log(await done);
clearTimeout(timer);
try { process.kill(-child.pid, 'SIGTERM'); } catch {}
try { process.kill(-xvfb.pid, 'SIGTERM'); } catch {}
server.close();
