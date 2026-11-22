#!/usr/bin/env node
// Generates the GUI benchmark worksheets and, for each, the `open_worksheet` JSON the
// mock backend serves in a plain browser. Output (git-ignored):
//   app/perf-fixtures/large-{1k,5k,20k}.eqv open them in the desktop app, or drive app/scripts/perf-real.mjs
//   app/perf-fixtures/large-{1k,5k,20k}.json http://localhost:1420/?backend=mock&fixture=/perf-fixtures/large-5k.json
//
//   node scripts/perf/make-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve('app/perf-fixtures');
mkdirSync(dir, { recursive: true });
execFileSync('node', ['scripts/perf/gen-worksheet.mjs', '--all', '--out-dir', dir], { stdio: 'inherit' });
for (const size of ['1k', '5k', '20k']) {
  const sheet = join(dir, `large-${size}.eqv`);
  execFileSync('cargo', ['run', '-q', '-p', 'equavela-app', '--example', 'opened_json', '--', sheet, join(dir, `large-${size}.json`)], { stdio: 'inherit' });
  console.log(`large-${size}: ${sheet} and its mock fixture`);
}
