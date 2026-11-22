// Native Linux export smoke/regression driver. Run after:
// pnpm --dir app build && cargo build -p equavela-app --features e2e-print,tauri/custom-protocol
// node app/scripts/e2e-linux-print.mjs
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

/** Whether a binary PPM (P6, as `pdftoppm` writes it) has a pixel within `tolerance` of `rgb`. */
function hasColor(ppm, rgb, tolerance) {
  // Header: P6, width, height, maxval, each followed by whitespace; comments are not written by pdftoppm.
  let at = 0;
  const fields = [];
  while (fields.length < 4) {
    while (/\s/.test(String.fromCharCode(ppm[at]))) at++;
    let start = at;
    while (!/\s/.test(String.fromCharCode(ppm[at]))) at++;
    fields.push(ppm.subarray(start, at).toString('latin1'));
  }
  at++;
  for (let i = at; i + 2 < ppm.length; i += 3) {
    if (Math.abs(ppm[i] - rgb[0]) <= tolerance && Math.abs(ppm[i + 1] - rgb[1]) <= tolerance && Math.abs(ppm[i + 2] - rgb[2]) <= tolerance) return true;
  }
  return false;
}
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = readFileSync('app/scripts/fixtures/print/print.eqv', 'utf8');
const cases = [
  { name: 'a4', text: fixture, width: 595.28, height: 841.89 },
  { name: 'letter', text: fixture.replace('  size: A4\n', '  size: Letter\n  orientation: landscape\n'), width: 792, height: 612 },
];
const root = mkdtempSync(join(tmpdir(), 'equavela-linux-print-'));
let failures = 0;
for (const test of cases) {
  const file = join(root, `${test.name}.eqv`);
  const output = join(root, `${test.name} # output.pdf`);
  writeFileSync(file, test.text);
  const secret = randomBytes(24).toString('hex');
  let deliver;
  const response = new Promise((resolveResponse) => { deliver = resolveResponse; });
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && req.url === `/${secret}/snapshot`) {
      const deadline = Date.now() + 30000;
      const poll = () => {
        if (existsSync(`${output}.png`)) res.writeHead(200).end('ok');
        else if (Date.now() >= deadline) res.writeHead(504).end('snapshot timed out');
        else setTimeout(poll, 50);
      };
      poll();
      return;
    }
    if (req.method !== 'POST' || ![`/${secret}`, `/${secret}/progress`].includes(req.url)) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200).end('ok');
      if (req.url.endsWith('/progress')) console.log(`Waiting for ${test.name}: ${body}`);
      else deliver(body);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/${secret}`;
  const child = spawn('xvfb-run', ['-a', resolve('target/debug/equavela-app'), file], {
    env: { ...process.env, EQUAVELA_E2E_PRINT_ENDPOINT: endpoint, EQUAVELA_E2E_PRINT_OUTPUT: output },
    stdio: 'inherit', detached: true,
  });
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } };
  const interrupted = () => { stop(); process.exit(130); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  let timer;
  try {
    const body = await Promise.race([
      response,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out waiting for the app')), 210000); }),
      new Promise((_, reject) => child.once('exit', (code) => reject(new Error(`app exited (${code})`)))),
      new Promise((_, reject) => child.once('error', reject)),
    ]);
    const result = JSON.parse(body);
    if (!result.ok) throw new Error(result.error);
    if (result.written !== output || result.expectedPages !== 2) throw new Error(`unexpected worksheet or output: ${body}`);
    const info = execFileSync('pdfinfo', [output], { encoding: 'utf8' });
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (pages !== result.expectedPages) throw new Error(`page count: screen ${result.expectedPages}, PDF ${pages}`);
    const size = info.match(/^Page size:\s+([0-9.]+) x ([0-9.]+) pts/m);
    if (!size || Math.abs(Number(size[1]) - test.width) > 0.01 || Math.abs(Number(size[2]) - test.height) > 0.01) {
      throw new Error(`wrong page size: ${size?.[0] ?? 'missing'}`);
    }
    const text = execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' });
    if (!text.trim()) throw new Error('PDF has no extractable text');
    const boxes = execFileSync('pdftotext', ['-bbox', output, '-'], { encoding: 'utf8' });
    for (const [word, expectedX] of [['Print', 54], ['g', 180]]) {
      const match = boxes.match(new RegExp(`<word xMin="([0-9.]+)"[^>]*>${word}</word>`));
      if (!match || Math.abs(Number(match[1]) - expectedX) > 0.1) {
        throw new Error(`${word} x coordinate: expected ${expectedX} pt, got ${match?.[1] ?? 'missing'}`);
      }
    }
    const firstY = boxes.match(/<word xMin="[0-9.]+" yMin="([0-9.]+)"[^>]*>Print<\/word>/);
    const secondY = boxes.match(/<word xMin="[0-9.]+" yMin="([0-9.]+)"[^>]*>Full-width<\/word>/);
    if (!firstY || !secondY || Math.abs(Number(secondY[1]) - Number(firstY[1]) - 27) > 0.1) {
      throw new Error('vertical distance between the first two text regions differs from 27 pt');
    }
    // The checks the Windows driver makes with pdf-compare.py (e2e-print.mjs), with Poppler only.
    // The PNG resource is embedded at its own size.
    const images = execFileSync('pdfimages', ['-list', output], { encoding: 'utf8' });
    if (!/^\s*\d+\s+\d+\s+image\s+400\s+200\b/m.test(images)) throw new Error(`the 400x200 PNG is not in the PDF:\n${images}`);
    // A collapsed area: a result calculated from its member is printed, the member is not.
    const layout = execFileSync('pdftotext', ['-layout', output, '-'], { encoding: 'utf8' });
    // The header and the footer are document content, printed on every page with the tokens of that
    // page: the centre header slot, `{file}` and `{page}` in the footer/header.
    if (!text.includes('Beam under a uniform load')) throw new Error('the page header is not printed');
    if (!text.includes(`${test.name}.eqv`)) throw new Error('the {file} token of the footer is not printed');
    for (const pageNumber of [1, 2]) {
      if (!layout.includes(`Page ${pageNumber}`)) throw new Error(`the {page} token is not printed on page ${pageNumber}`);
    }
    if (!/Checked \d{4}-\d{2}-\d{2}/.test(text)) throw new Error('the {date} token of the footer is not printed');
    if (!/=\s*42\b/.test(layout)) throw new Error('the result calculated from the collapsed area (42) is not printed');
    if (/:=\s*41\b/.test(layout)) throw new Error('the member of the collapsed area (:= 41) is printed');
    // The SVG resource is drawn: its yellow circle (#f2b134) is on one of the pages.
    let yellow = false;
    for (let page = 1; page <= pages && !yellow; page++) {
      const ppm = execFileSync('pdftoppm', ['-r', '48', '-f', String(page), '-l', String(page), output], { maxBuffer: 64 << 20 });
      yellow = hasColor(ppm, [0xf2, 0xb1, 0x34], 12);
    }
    if (!yellow) throw new Error('the SVG image (its #f2b134 circle) is not drawn');
    console.log(`PASS ${test.name}: ${pages} pages, vector text and position checks, images and collapsed area, ${output}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${test.name}: ${error.message}`);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    stop();
    await new Promise((done) => server.close(done));
  }
}
console.log(`Artifacts: ${root}`);
process.exitCode = failures ? 1 : 0;
