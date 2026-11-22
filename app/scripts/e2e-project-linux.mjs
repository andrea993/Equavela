// Project UI check on the real Linux app: New Project, Open Project,
// their in-dialog errors and the navigator, driven by `e2e-project-injected.js` with real DOM events, the real
// Tauri commands and the real file system. Build once:
//   pnpm --dir app build && cargo build -p equavela-app --features e2e-project,tauri/custom-protocol
// Run from the repository root (under xvfb-run by default; `--display` uses the real display):
//   node app/scripts/e2e-project-linux.mjs [--display]
// EQUAVELA_APP_EXE selects another binary.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

const display = process.argv.includes('--display');
const layout = process.argv.includes('--layout');
// Layout checks use xdotool on the driver's own display. Run the entire driver under Xvfb:
// xvfb-run -a env GDK_BACKEND=x11 node app/scripts/e2e-project-linux.mjs --display --layout
if (layout && !display) throw new Error('--layout requires --display; run the driver itself under xvfb-run');
const exe = resolve(process.env.EQUAVELA_APP_EXE || 'target/debug/equavela-app');
if (!existsSync(exe)) {
  console.error(`missing ${exe}; build it with: pnpm --dir app build && cargo build -p equavela-app --features e2e-project,tauri/custom-protocol`);
  process.exit(2);
}
// A syntax error in the injected script would only show as a silent timeout: parse it first.
try {
  const injected = readFileSync(new URL('./e2e-project-injected.js', import.meta.url), 'utf8');
  new Script(injected.replace('__ENDPOINT__', '""').replace('__OPTIONS__', '{}'));
} catch (error) {
  console.error(`e2e-project-injected.js does not parse: ${error.message}`);
  process.exit(2);
}
const base = mkdtempSync(join(tmpdir(), 'equavela-project-e2e-'));
const driverData = mkdtempSync(join(tmpdir(), 'equavela-project-data-'));
const options = {
  layout,
  name: 'Bridge è ü',
  root: join(base, 'bridge project'),
  missing: join(base, 'missing'),
  environmentRoot: join(base, 'with environment'),
  archive: join(base, 'bridge.eqvz'),
  extracted: join(base, 'extracted project'),
  standalone: join(base, 'sizing.eqv'),
  portable: join(base, 'sizing è.eqvz'),
  converted: join(base, 'converted project'),
  provider: join(base, 'Thermo'),
  nativeCsv: join(base, 'drop-samples.csv'),
  nativePng: join(base, 'drop-picture.png'),
};
const PROJECT_TOML = '[deps]\nExample = "7876af07-990d-54b4-ab0e-23690620f79a"\n';
const MANIFEST = 'equavela-project.yaml';
// the app's trash goes to a folder of this run, never the user's own trash.
const trashHome = join(base, 'xdg-data');
mkdirSync(trashHome, { recursive: true });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEElEQVR4nGP4z8Dwn4EBDAAZ+wP9PKaI+AAAAABJRU5ErkJggg==';
writeFileSync(options.nativeCsv, 'x,y\n1,2\n');
writeFileSync(options.nativePng, Buffer.from(PNG, 'base64'));
const ASSET_SHEET = [
  'format: equavela-worksheet/3',
  'regions:',
  '  - id: r1',
  '    at: [54, 72]',
  '    image:',
  '      resource: img1',
  '      size: [60, 30]',
  'resources:',
  '  img1:',
  '    media: png',
  '    asset: assets/images/beam.png',
  '',
].join('\n');

const secret = randomBytes(24).toString('hex');
let deliver;
const response = new Promise((done) => { deliver = done; });
// Steps the page asks of the driver: they answer before the page goes on.
const steps = {
  '/recovery-project-move': ({ restore }) => {
    const moved = options.converted + ' moved';
    renameSync(restore ? moved : options.converted, restore ? options.converted : moved);
    return { ok: existsSync(restore ? options.converted : moved) && !existsSync(restore ? moved : options.converted) };
  },
  '/drop-copy': ({ image }) => {
    const source = image ? options.nativePng : options.nativeCsv;
    const target = join(options.root, image ? 'assets/images/drop-picture.png' : 'worksheets/drop-samples.csv');
    return { ok: existsSync(source) && existsSync(target) && readFileSync(source).equals(readFileSync(target)) };
  },
  '/resize': ({ width, height }) => {
    if (!layout || ![700, 1280].includes(width) || height !== 800) throw new Error('unsupported test window size');
    const id = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(child.pid)], { encoding: 'utf8' }).trim().split('\n')[0];
    execFileSync('xdotool', ['windowsize', id, String(width), String(height)]);
    return { ok: true };
  },
  '/disk': ({ root }) => {
    const manifest = readFileSync(join(root, MANIFEST), 'utf8');
    return { ok: existsSync(join(root, 'worksheets', 'main.eqv')) && manifest.includes(options.name) && /^environment: julia$/m.test(manifest) && existsSync(join(root, 'julia')) };
  },
  '/asset': ({ root }) => {
    mkdirSync(join(root, 'assets', 'images'), { recursive: true });
    writeFileSync(join(root, 'assets', 'images', 'beam.png'), Buffer.from(PNG, 'base64'));
    writeFileSync(join(root, 'worksheets', 'main.eqv'), ASSET_SHEET);
    return { ok: true };
  },
  // what extraction put on disk, and no staging folder beside it.
  '/archive': ({ root }) => {
    const manifest = readFileSync(join(root, MANIFEST), 'utf8');
    const files = ['worksheets/main.eqv', 'assets/images/beam.png'].every((file) => existsSync(join(root, file)));
    const leftovers = readdirSync(base).filter((name) => name.includes('eqvz-stage'));
    return { ok: manifest.includes(options.name) && files && existsSync(join(root, 'julia')) && leftovers.length === 0 };
  },
  '/asset-remove': ({ root }) => {
    rmSync(join(root, 'assets', 'images', 'beam.png'));
    return { ok: true };
  },
  // a standalone worksheet with its own environment, to save as a portable document.
  '/standalone': () => {
    mkdirSync(join(base, 'env'));
    writeFileSync(join(base, 'env', 'Project.toml'), PROJECT_TOML);
    writeFileSync(options.standalone, 'format: equavela-worksheet/3\nenvironment: env\nregions:\n  - id: a\n    at: [54, 72]\n    math: "a := 2"\n');
    return { ok: true };
  },
  // the archive's entries and the folder the environment was materialized in.
  '/portable': ({ directory }) => {
    const entries = execFileSync('unzip', ['-Z1', options.portable], { encoding: 'utf8' }).trim().split('\n').sort();
    const sheet = execFileSync('unzip', ['-p', options.portable, 'worksheets/main.eqv'], { encoding: 'utf8' });
    const wanted = ['julia/Project.toml', 'manifest.json', 'worksheets/main.eqv'];
    const materialized = readFileSync(join(directory, 'Project.toml'), 'utf8');
    const ok = entries.join() === wanted.join() && sheet.includes('a := 2') && !sheet.includes('environment:')
      && materialized === PROJECT_TOML && directory.startsWith(env.EQUAVELA_DRIVER_DATA_DIR);
    return { ok, detail: JSON.stringify({ entries, directory }) };
  },
  // the converted project's files; the document it came from is unchanged.
  '/converted': () => {
    const sheet = readFileSync(join(options.converted, 'worksheets', 'sizing è.eqv'), 'utf8');
    const manifest = readFileSync(join(options.converted, MANIFEST), 'utf8');
    const environment = readFileSync(join(options.converted, 'julia', 'Project.toml'), 'utf8');
    return { ok: sheet.includes('a := 2') && /^environment: julia$/m.test(manifest) && environment === PROJECT_TOML && existsSync(options.portable) };
  },
  // the renamed worksheet on disk and in the manifest, then in the trash.
  '/worksheets': ({ removed }) => {
    const manifest = readFileSync(join(options.converted, MANIFEST), 'utf8');
    const file = existsSync(join(options.converted, 'worksheets', 'Checks v2.eqv'));
    const old = existsSync(join(options.converted, 'worksheets', 'Checks.eqv'));
    const declared = manifest.includes('path: worksheets/Checks v2.eqv');
    const trashed = existsSync(join(trashHome, 'Trash', 'files', 'Checks v2.eqv'));
    const leftovers = readdirSync(options.converted).filter((name) => name.endsWith('.tmp'));
    return { ok: !old && file === !removed && declared === !removed && trashed === removed && leftovers.length === 0 };
  },
  // the specification: a provider project that exports c_p and keeps k private.
  '/reference-provider': () => {
    const sheet = '11111111-1111-4111-8111-1111111111aa';
    mkdirSync(join(options.provider, 'worksheets'), { recursive: true });
    writeFileSync(join(options.provider, 'worksheets', 'main.eqv'), [
      'format: equavela-worksheet/3',
      'regions:',
      '  - id: k',
      '    at: [0, 10]',
      '    math: "k := 2"',
      '  - id: cp',
      '    at: [0, 30]',
      '    math: "c_p(T) := k·T"',
      '',
    ].join('\n'));
    writeFileSync(join(options.provider, MANIFEST), [
      'format: equavela-project/1',
      'project_id: 11111111-1111-4111-8111-111111111111',
      'name: Thermo',
      'worksheets:',
      `- id: ${sheet}`,
      '  path: worksheets/main.eqv',
      `main_worksheet: ${sheet}`,
      'exports:',
      '- id: 11111111-1111-4111-8111-1111111111c1',
      `  worksheet: ${sheet}`,
      '  region: cp',
      '',
    ].join('\n'));
    return { ok: true };
  },
  // A consumer worksheet that uses the export, its own `k` and the provider's private `k`.
  '/reference-consumer': () => {
    writeFileSync(join(options.converted, 'worksheets', 'uses.eqv'), [
      'format: equavela-worksheet/3',
      'regions:',
      '  - id: own',
      '    at: [0, 10]',
      '    math: "k := 5"',
      '  - id: use',
      '    at: [0, 30]',
      '    math: "Thermo.c_p(300) ="',
      '  - id: mine',
      '    at: [0, 50]',
      '    math: "k ="',
      '  - id: private',
      '    at: [0, 70]',
      '    math: "Thermo.k ="',
      '',
    ].join('\n'));
    return { ok: true };
  },
  // what Ctrl+S wrote.
  '/julia-file': () => ({ ok: readFileSync(join(options.converted, 'julia', 'tools.jl'), 'utf8') === 'area(b, h) = b * h\n' }),
  '/text-backup': () => {
    const directory = join(driverData, 'recovery', 'project-text');
    const records = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8'))) : [];
    const record = records.find(item => item.root === options.converted && item.path === 'julia/tools.jl');
    return {
      present: !!record,
      quarantined: existsSync(join(directory, 'corrupt')) && readdirSync(join(directory, 'corrupt')).some(name => readFileSync(join(directory, 'corrupt', name), 'utf8') === '{damaged recovery'),
      ok: record?.recovery.text === 'area(b, h) = b * h\n'
        && readFileSync(join(options.converted, 'julia', 'tools.jl'), 'utf8') === record?.recovery.saved,
    };
  },
  '/corrupt-text-backup': () => {
    const directory = join(driverData, 'recovery', 'project-text');
    const file = readdirSync(directory).filter(name => name.endsWith('.json')).find(name => {
      const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      return record.root === options.converted && record.path === 'julia/tools.jl';
    });
    if (!file) return { ok: false };
    writeFileSync(join(directory, file), '{damaged recovery');
    return { ok: true };
  },
  // a copy whose declared environment folder is gone.
  '/environment': ({ root, copy }) => {
    cpSync(root, copy, { recursive: true });
    rmSync(join(copy, 'julia'), { recursive: true });
    return { ok: true };
  },
};
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const path = req.url.slice(secret.length + 1);
  if (req.method !== 'POST' || !req.url.startsWith(`/${secret}`) || !['', '/progress', ...Object.keys(steps)].includes(path)) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
  req.on('end', () => {
    if (steps[path]) {
      let answer;
      try { answer = steps[path](JSON.parse(body)); } catch (error) { answer = { ok: false, error: error.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
      return;
    }
    res.writeHead(200).end('ok');
    if (path === '/progress') console.log(`  ${body}`);
    else deliver(body);
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const env = {
  ...process.env,
  EQUAVELA_E2E_PROJECT_ENDPOINT: `http://127.0.0.1:${server.address().port}/${secret}`,
  EQUAVELA_E2E_PROJECT_OPTIONS: JSON.stringify(options),
  EQUAVELA_MULTI_INSTANCE: '1',
  XDG_DATA_HOME: trashHome,
  // Only the virtual screen: with WAYLAND_DISPLAY set, GTK would open the window on the user's
  // own Wayland session instead of Xvfb.
  GDK_BACKEND: 'x11',
  EQUAVELA_DRIVER_DATA_DIR: driverData,
};
if (!display) delete env.WAYLAND_DISPLAY;
const command = display ? [exe] : ['xvfb-run', '-a', '-s', '-screen 0 1600x1000x24', exe];
console.log(`starting ${display ? 'on the display' : 'under xvfb'} in ${base}`);
const child = spawn(command[0], command.slice(1), { env, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } };
process.once('SIGINT', () => { stop(); process.exit(130); });
let timer;
let failed = false;
try {
  const body = await Promise.race([
    response,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out waiting for the app')), 600_000); }),
    new Promise((_, reject) => child.once('exit', (code, signal) => reject(new Error(`app exited (${code ?? signal})`)))),
  ]);
  const result = JSON.parse(body);
  for (const { label, ok, detail } of result.checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` (${detail})`}`);
  if (!result.ok) throw new Error(result.error);
  console.log(`${result.checks.length} checks passed`);
} catch (error) {
  failed = true;
  console.error(`FAIL ${error.message}`);
} finally {
  clearTimeout(timer);
  stop();
  server.close();
}
process.exit(failed ? 1 : 0);
