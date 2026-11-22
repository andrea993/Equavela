// Single-instance forwarding on Linux, where tauri-plugin-single-instance uses D-Bus and the
// Windows driver (e2e-single-instance.mjs, DevTools protocol) cannot run:
//   1. start the app on a private Xvfb display with a.eqv; start it again with a relative path, b.eqv, from the
//      worksheets' directory (what a double-click on a second file does);
//   2. the second process exits by itself, and exactly one app process and one Equavela window stay;
//   3. the running instance opens b.eqv, resolved against the working directory of the second launch (seen
//      with inotify: nothing else in the window says which worksheet a tab holds);
//   4. a launch without a file exits too, opens nothing and leaves one window.
// Raising the window is not checked: a bare Xvfb has no window manager to raise it.
// Usage (repository root): EQUAVELA_APP_EXE=<exe> node app/scripts/e2e-single-instance-linux.mjs
// (default target/release/equavela-app). Exit code = number of failed checks.

import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exe = resolve(process.env.EQUAVELA_APP_EXE || 'target/release/equavela-app');
const fixture = resolve('app/scripts/fixtures/print/print.eqv');
const dir = mkdtempSync(join(tmpdir(), 'equavela-single-instance-'));
copyFileSync(fixture, join(dir, 'a.eqv'));
copyFileSync(fixture, join(dir, 'b.eqv'));
const display = `:${90 + Math.floor(Math.random() * 9)}`;
const env = { ...process.env, DISPLAY: display, GDK_BACKEND: 'x11', EQUAVELA_DRIVER_DATA_DIR: mkdtempSync(join(tmpdir(), 'equavela-si-data-')) };
delete env.WAYLAND_DISPLAY;
delete env.EQUAVELA_MULTI_INSTANCE;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const appProcesses = () => execFileSync('pgrep', ['-x', 'equavela-app'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((pid) => { try { return execFileSync('cat', [`/proc/${pid}/environ`]).includes(Buffer.from(`DISPLAY=${display}\0`)); } catch { return false; } });
const windows = () => execFileSync('python3', ['-I', 'app/scripts/x11-titles.py', display], { encoding: 'utf8' })
  .split('\n').filter((title) => title === 'Equavela').length;
const exited = (child, ms) => new Promise((done) => {
  const timer = setTimeout(() => done(null), ms);
  child.once('exit', (code) => { clearTimeout(timer); done(code); });
});

const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x900x24'], { stdio: 'ignore' });
const opens = [];
const watcher = spawn('python3', ['-I', '-u', 'app/scripts/inotify-opens.py', dir], { stdio: ['ignore', 'pipe', 'inherit'] });
watcher.stdout.on('data', (chunk) => opens.push(...chunk.toString().split('\n').filter(Boolean)));
let first;
try {
  await sleep(1000);
  first = spawn(exe, [join(dir, 'a.eqv')], { cwd: dir, env, stdio: 'ignore' });
  // The window is up once one Equavela window exists.
  for (let i = 0; i < 60 && windows() === 0; i++) await sleep(500);
  check('the first instance shows its window', windows() === 1);
  check('the first instance opened a.eqv', opens.includes('a.eqv'), opens.join(','));

  opens.length = 0;
  const second = spawn(exe, ['b.eqv'], { cwd: dir, env, stdio: 'ignore' });
  const code = await exited(second, 20000);
  check('the second launch exits by itself', code !== null, 'still running after 20 s');
  for (let i = 0; i < 20 && !opens.includes('b.eqv'); i++) await sleep(500);
  check('the running instance opens the forwarded b.eqv (a relative path, resolved against the second launch)', opens.includes('b.eqv'), opens.join(',') || 'no open');
  const pids = appProcesses();
  check('exactly one app process is left', pids.length === 1 && pids[0] === String(first.pid), pids.join(','));
  check('exactly one Equavela window is left', windows() === 1, String(windows()));

  opens.length = 0;
  const third = spawn(exe, [], { cwd: dir, env, stdio: 'ignore' });
  check('a launch without a file exits too', (await exited(third, 20000)) !== null);
  await sleep(1500);
  check('a launch without a file opens nothing', opens.filter((name) => name.endsWith('.eqv')).length === 0, opens.join(','));
  check('still one app process and one window', appProcesses().length === 1 && windows() === 1);
} finally {
  first?.kill();
  watcher.kill();
  await sleep(500);
  xvfb.kill();
}
console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`);
process.exit(failed);
