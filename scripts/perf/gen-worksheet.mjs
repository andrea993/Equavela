#!/usr/bin/env node
// scripts/perf/gen-worksheet.mjs
//
// Generates large synthetic Equavela worksheets for the GUI performance benchmarks.
// Plain Node.js (ESM, no dependencies, Node 20+). Writes `format: equavela-worksheet/3` files
//  whose math is the linear syntax of `the specification`.
// Every construct emitted here is copied from a real fixture:
//   app/src/mock/demo.eqv, app/scripts/fixtures/real-smoke/{main,plot}.eqv,
//   app/scripts/fixtures/print/print.eqv, core/tests/fixtures/mcdx/{areas,plots,inlinemath}.expected.eqv
//
// Usage:
//   node scripts/perf/gen-worksheet.mjs --regions 5000 --out /tmp/large-5k.eqv [--seed 1] [--mix default]
//   node scripts/perf/gen-worksheet.mjs --all --out-dir /tmp/sheets
//   add --check to verify the file that was just written (region count, page bounds, no overlaps).
//
// The layout is synthetic: pages are A4 with the fixture margins {72, 54, 72, 54}, regions are
// stacked top to bottom in the printable area (y = 72 … 769.89) with a 12 pt gap and snapped to
// the 3 pt grid, some rows hold a definition and an evaluation side by side (x = 54 and x = 300),
// and the content spills over as many pages as needed. Region heights are conservative estimates
// (24 pt for a one-line math region, 18 pt per line for programs and wrapped text, 66 pt for a 3×3
// matrix, the stored size for plots, one row per table line), so the generated sheets never look
// cramped. The output is byte-identical to what the application's own writer (`core/src/
// worksheet_writer.rs`) produces for the same model.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------------------------
// Page geometry (A4 portrait, points)
// ---------------------------------------------------------------------------------------------

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = { top: 72, right: 54, bottom: 72, left: 54 };
const GRID = 3; // the page view snaps positions to the 3 pt grid
const GAP = 12; // vertical gap between two stacked rows
const TOP = MARGIN.top; // 72
const BOTTOM = PAGE_HEIGHT - MARGIN.bottom; // 769.89
const LEFT_X = MARGIN.left; // 54 — first column
const RIGHT_X = 300; // second column of a side-by-side row
const RIGHT_EDGE = PAGE_WIDTH - MARGIN.right; // 541.28
const PRINTABLE_WIDTH = RIGHT_EDGE - LEFT_X; // 487.28
const MIN_AREA_HEIGHT = 24;
const BAND_START_OFFSET = 24; // first member line: below the 21 pt area header
const DEFAULT_TEXT_WIDTH = 480;
const AREA_BOTTOM_PADDING = 6;

// Content estimators, in points. Deliberately conservative: the benchmark measures the GUI, and
// overlapping regions would make the generated sheet unrepresentative.
const LINE_HEIGHT = 18; // one line of a program or of wrapped text
const MATH_LINE_HEIGHT = 24; // one line of math (the size a math region occupies)
const CHAR_WIDTH = 6.4; // average advance of a 12 pt proportional digit/letter
const CHARS_PER_LINE_DIVISOR = 6.2; // for wrapped text: width divided by this
const PLOT_WIDTH = 300;
const PLOT_HEIGHT = 195;
const PLOT_LABEL_HEIGHT = 18; // the x expression row under the plot
const TABLE_ROW_HEIGHT = 21;
const TABLE_COLUMN_WIDTH = 70;
const PAIR_MAX_WIDTH = 234; // x = 54 and x = 300 leave 246 pt, minus a 12 pt gap between the columns
const MATRIX_HEIGHT = 66; // a 3×3 matrix literal is three rows tall (demo.eqv leaves ~70 pt)
const MATRIX_PATTERN = /\[[^\]]*;[^\]]*\]/; // `[1, 2; 3, 4]`: a matrix, not a vector

const SHEET_SIZES = [
  { regions: 1000, file: 'large-1k.eqv' },
  { regions: 5000, file: 'large-5k.eqv' },
  { regions: 20000, file: 'large-20k.eqv' },
];

// ---------------------------------------------------------------------------------------------
// Content mix. Weights are percentages of the region count; the remainder is definitions
// ("rest more definitions": 50 % instead of the 45 % of the brief).
// ---------------------------------------------------------------------------------------------

const MIXES = {
  default: [
    { kind: 'definition', weight: 50 }, // 45 % definitions + the rest
    { kind: 'evaluation', weight: 25 },
    { kind: 'text', weight: 15 },
    { kind: 'block', weight: 5 }, // programs, matrices, range variables
    { kind: 'area', weight: 3 }, // an area band plus a few member regions
    { kind: 'plot', weight: 1 },
    { kind: 'table', weight: 1 },
  ],
};

const NUMBERS = ['1.5', '2', '2.5', '3', '4.25', '0.5', '6', '7.5'];
const DIVISORS = ['2', '4', '8'];

const HEADINGS = ['Load case', 'Section', 'Check', 'Input summary', 'Result summary', 'Beam model'];

const PLAIN_SENTENCES = [
  'The values above come from the supplier test report; the numbers are rounded.',
  'This section records the verification steps for the beam model and its supports.',
  'No wind load is considered in this case; gravity alone is applied to the span.',
  'The check below repeats the calculation with the rounded inputs of the previous page.',
  'All dimensions are in metres and all forces in kilonewtons unless stated otherwise.',
  'The reviewer signed off the geometry and the material constants in the same meeting.',
  'Results follow the reference application conventions for units and result formats.',
  'The remaining cases reuse the same model with a modified load position.',
];

const MATH_SENTENCES = [
  (name) => `The factor $${name}$ is fixed by the test report.`,
  (name) => `With $${name}$ known, the check below needs no further input.`,
  (name) => `The value $${name}$ is reused on the next page.`,
  (name) => `The geometry uses $${name}$ as entered by the reviewer.`,
];

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Snap a coordinate to the 3 pt grid the page view uses. */
function snap(value) {
  return Math.round(value / GRID) * GRID;
}

/** The shortest text for a coordinate; every position and height of this script is a whole point. */
function num(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Math text as a quoted YAML scalar. */
function quoteMathText(text) {
  if (/[\\"]/.test(text) && !text.includes("'")) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// a string stays plain when it certainly reads back as itself.
const YAML_RESERVED = new Set(['y', 'n', 'yes', 'no', 'on', 'off', 'true', 'false', 'null', 'nan', 'inf', 'infinity']);

function isPlainYamlText(value) {
  if (value === '' || YAML_RESERVED.has(value.toLowerCase())) return false;
  if (!/^(?:[A-Za-z_]|\/|\.\/|\.\.\/)/.test(value)) return false;
  if (!/^[A-Za-z0-9 _\-./(),]+$/.test(value)) return false;
  return value === value.trimEnd() && !value.includes('  ');
}

/** Ordinary single-line text as a YAML scalar. */
function quoteText(text) {
  if (isPlainYamlText(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** mulberry32: a tiny seeded PRNG, so the same seed always produces the same worksheet. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Random {
  constructor(seed) {
    this.next = mulberry32(seed);
  }

  float() {
    return this.next();
  }

  int(maxExclusive) {
    return Math.floor(this.next() * maxExclusive);
  }

  chance(probability) {
    return this.next() < probability;
  }

  pick(items) {
    return items[this.int(items.length)];
  }

  shuffle(items) {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const swap = items[i];
      items[i] = items[j];
      items[j] = swap;
    }
    return items;
  }
}

/** Largest-remainder allocation of `total` regions over the weighted mix. */
function allocateCounts(total, mix) {
  const weightSum = mix.reduce((sum, entry) => sum + entry.weight, 0);
  const exact = mix.map((entry) => (total * entry.weight) / weightSum);
  const counts = exact.map((value) => Math.floor(value));
  const remaining = total - counts.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i += 1) {
    counts[byRemainder[i % byRemainder.length].index] += 1;
  }
  return counts;
}

function estimateTextLines(paragraphs, width) {
  const charsPerLine = Math.max(20, Math.floor(width / CHARS_PER_LINE_DIVISOR));
  let lines = 0;
  for (const paragraph of paragraphs) {
    lines += Math.max(1, Math.ceil(paragraph.length / charsPerLine));
  }
  return lines;
}

function estimateMathWidth(lines) {
  const longest = lines.reduce((max, line) => Math.max(max, [...line].length), 1);
  return CHAR_WIDTH * longest + 12;
}

// ---------------------------------------------------------------------------------------------
// Region descriptors. A descriptor carries its layout extents and the data needed to render its
// YAML body; `page`, `x` and `y` are filled in by the layout pass.
// ---------------------------------------------------------------------------------------------

function mathRegion(text) {
  const lines = text.split('\n');
  const width = estimateMathWidth(lines);
  const height = lines.length === 1 ? MATH_LINE_HEIGHT : LINE_HEIGHT * lines.length + 6;
  return { kind: 'math', text, width, height };
}

function textRegion({ paragraphs, width }) {
  const lines = estimateTextLines(paragraphs, width ?? DEFAULT_TEXT_WIDTH);
  return {
    kind: 'text',
    paragraphs,
    width: width ?? null,
    height: LINE_HEIGHT * lines + 6,
  };
}

function areaRegion(title) {
  return { kind: 'area', title, height: MIN_AREA_HEIGHT, collapsed: false };
}

function plotRegion(traces) {
  return {
    kind: 'plot',
    traces,
    size: [PLOT_WIDTH, PLOT_HEIGHT],
    width: PLOT_WIDTH,
    height: PLOT_HEIGHT + PLOT_LABEL_HEIGHT,
  };
}

function tableRegion(columns) {
  const rows = columns[0].cells.length;
  return {
    kind: 'table',
    columns,
    width: TABLE_COLUMN_WIDTH * columns.length,
    height: TABLE_ROW_HEIGHT * (rows + 1) + 6,
  };
}

// ---------------------------------------------------------------------------------------------
// YAML bodies
// ---------------------------------------------------------------------------------------------

function mathBody(region) {
  const lines = region.text.split('\n');
  if (lines.length === 1) return [`    math: ${quoteMathText(region.text)}`];
  return ['    math: |', ...lines.map((line) => `      ${line}`)];
}

function textBody(region) {
  const { paragraphs, width } = region;
  if (width === null) return [`    text: ${quoteText(paragraphs.join('\n\n'))}`];
  if (paragraphs.length === 1) {
    return ['    text:', `      width: ${num(width)}`, `      text: ${quoteText(paragraphs[0])}`];
  }
  const block = [];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) block.push('');
    block.push(`        ${paragraph}`);
  });
  return ['    text:', `      width: ${num(width)}`, '      text: |', ...block];
}

function areaBody(region) {
  const lines = ['    area:'];
  if (region.title !== '') lines.push(`      title: ${quoteText(region.title)}`);
  lines.push(`      height: ${num(region.height)}`);
  if (region.collapsed) lines.push('      collapsed: true');
  return lines;
}

function plotBody(region) {
  return [
    '    plot:',
    '      version: 1',
    '      type: xy',
    `      size: [${num(region.size[0])}, ${num(region.size[1])}]`,
    '      traces:',
    ...region.traces.map(
      (trace) => `        - {id: ${trace.id}, x: ${quoteMathText(trace.x)}, y: ${quoteMathText(trace.y)}}`,
    ),
  ];
}

function tableBody(region) {
  const lines = ['    table:', '      columns:'];
  for (const column of region.columns) {
    lines.push(`      - name: ${column.name}`);
    if (column.unit) lines.push(`        unit: ${column.unit}`);
    lines.push('        cells:');
    for (const cell of column.cells) lines.push(`          - "${cell}"`);
  }
  return lines;
}

function renderBody(region) {
  switch (region.kind) {
    case 'math':
      return mathBody(region);
    case 'text':
      return textBody(region);
    case 'area':
      return areaBody(region);
    case 'plot':
      return plotBody(region);
    case 'table':
      return tableBody(region);
    default:
      throw new Error(`unknown region kind \`${region.kind}\``);
  }
}

// ---------------------------------------------------------------------------------------------
// The generator: a token stream of region kinds, turned into blocks (single regions, side-by-side
// rows, areas with members), then laid out page by page.
// ---------------------------------------------------------------------------------------------

class WorksheetGenerator {
  constructor({ regions, seed, mix }) {
    this.random = new Random(seed);
    this.regionTarget = regions;
    this.mix = mix;
    this.regions = [];
    this.nextId = 0;
    this.counters = { v: 0, L: 0, f: 0, t: 0, A: 0, S: 0, c: 0 };
    // Names available to later regions, so the dependency graph has depth and fan-out.
    this.plainScalars = [];
    this.unitScalars = [];
    this.functions = [];
    this.programs = [];
    this.matrices = [];
    this.ranges = [];
    this.vectors = [];
  }

  name(prefix) {
    this.counters[prefix] += 1;
    return `${prefix}_${this.counters[prefix]}`;
  }

  addRegion(descriptor) {
    this.nextId += 1;
    const region = { id: `r${this.nextId}`, page: 1, x: LEFT_X, y: TOP, ...descriptor };
    this.regions.push(region);
    return region;
  }

  // --- tokens ---------------------------------------------------------------------------------

  tokenStream() {
    const counts = allocateCounts(this.regionTarget, this.mix);
    const tokens = [];
    this.mix.forEach((entry, index) => {
      for (let i = 0; i < counts[index]; i += 1) tokens.push(entry.kind);
    });
    this.random.shuffle(tokens);
    // The first token is a range variable and the second a plain scalar: every plot then has a
    // range to sample and the first evaluations have something to reference.
    moveKindTo(tokens, 'definition', 0);
    moveKindTo(tokens, 'definition', 1);
    return tokens;
  }

  // --- definitions ----------------------------------------------------------------------------

  makeScalarDefinition() {
    const random = this.random;
    const name = this.name('v');
    const pool = this.plainScalars;
    let text;
    if (pool.length === 0) {
      text = `${name} := ${random.pick(NUMBERS)}`;
    } else {
      const a = random.pick(pool);
      const others = pool.filter((entry) => entry !== a);
      const b = others.length > 0 ? random.pick(others) : null;
      switch (random.int(4)) {
        case 0:
          text = `${name} := ${a}·${random.pick(NUMBERS)} + ${random.pick(NUMBERS)}`;
          break;
        case 1:
          text =
            b === null
              ? `${name} := (${a} + ${random.pick(NUMBERS)})/${random.pick(DIVISORS)}`
              : `${name} := (${a} + ${b})/${random.pick(DIVISORS)}`;
          break;
        case 2:
          text = `${name} := ${a}^2 + ${random.pick(NUMBERS)}`;
          break;
        default:
          text =
            b === null
              ? `${name} := ${a}·${random.pick(NUMBERS)} - ${random.pick(NUMBERS)}`
              : `${name} := ${a}·${b} - ${random.pick(NUMBERS)}`;
          break;
      }
    }
    this.plainScalars.push(name);
    return { ...mathRegion(text), hint: `${name} =` };
  }

  makeUnitDefinition() {
    const random = this.random;
    const name = this.name('L');
    const pool = this.unitScalars;
    let text;
    if (pool.length === 0) {
      text = `${name} := ${random.pick(NUMBERS)}·m@unit`;
    } else {
      const a = random.pick(pool);
      const others = pool.filter((entry) => entry !== a);
      const b = others.length > 0 ? random.pick(others) : null;
      switch (random.int(3)) {
        case 0:
          text = `${name} := ${a}·${random.pick(NUMBERS)}`;
          break;
        case 1:
          text = b === null ? `${name} := ${a}/${random.pick(DIVISORS)}` : `${name} := ${a} + ${b}`;
          break;
        default:
          text = `${name} := ${a}·${random.pick(NUMBERS)} + ${random.pick(NUMBERS)}·m@unit`;
          break;
      }
    }
    this.unitScalars.push(name);
    return { ...mathRegion(text), hint: random.chance(0.25) ? `${name} = … m` : `${name} =` };
  }

  makeFunctionDefinition() {
    const random = this.random;
    const name = this.name('f');
    let text;
    switch (random.int(3)) {
      case 0:
        text = `${name}(x) := x^2 + ${random.pick(NUMBERS)}`;
        break;
      case 1:
        text = `${name}(x) := x^2·sin(x)`;
        break;
      default:
        text = `${name}(x) := sin(x)·${random.pick(NUMBERS)} + x`;
        break;
    }
    this.functions.push(name);
    return { ...mathRegion(text), hint: `${name}(2) =` };
  }

  makeRangeDefinition() {
    const random = this.random;
    const name = this.name('t');
    const text = random.chance(0.5) ? `${name} := 0..4` : `${name} := 0, 0.5..2`;
    this.ranges.push(name);
    return { ...mathRegion(text), hint: `${name} =` };
  }

  makeProgramDefinition() {
    const random = this.random;
    const name = this.name('S');
    const lines = random.chance(0.5)
      ? [`${name}(n) := program`, '  s ← 0', '  for i ∈ 1..n', '    s ← s + i·i', '  s']
      : [
          `${name}(n) := program`,
          '  s ← 0',
          '  for i ∈ 1..4',
          '    if i > 2',
          '      s ← s + i^2',
          '    else',
          '      s ← s + i',
          '  s',
        ];
    this.programs.push(name);
    return { ...mathRegion(lines.join('\n')), hint: `${name}(5) =` };
  }

  makeMatrixDefinition() {
    const random = this.random;
    const name = this.name('A');
    const text = random.chance(0.5)
      ? `${name} := [1, 2, 3; 4, 5, 6; 7, 8, 10]`
      : `${name} := [2, 0, 1; 1, 3, 2; 0, 1, 4]`;
    this.matrices.push(name);
    return {
      ...mathRegion(text),
      height: MATRIX_HEIGHT,
      hint: random.chance(0.4) ? `\\det(${name}) =` : `tr(${name}) =`,
    };
  }

  makeDefinition() {
    const roll = this.random.float();
    if (roll < 0.14) return this.makeUnitDefinition();
    if (roll < 0.26) return this.makeFunctionDefinition();
    return this.makeScalarDefinition();
  }

  /** The 5 % "programs, matrices and range variables" group. */
  makeBlock() {
    const roll = this.random.float();
    if (roll < 0.4) return this.makeProgramDefinition();
    if (roll < 0.75) return this.makeMatrixDefinition();
    return this.makeRangeDefinition();
  }

  // --- evaluations ----------------------------------------------------------------------------

  makeEvaluation(preferred) {
    if (preferred !== undefined) return mathRegion(preferred);
    const random = this.random;
    const choices = ['sum'];
    if (this.plainScalars.length > 0) choices.push('plain', 'plain');
    if (this.unitScalars.length > 0) choices.push('unit');
    if (this.functions.length > 0) choices.push('function');
    if (this.matrices.length > 0) choices.push('matrix');
    if (this.programs.length > 0) choices.push('program');
    if (this.vectors.length > 0) choices.push('vector');
    switch (random.pick(choices)) {
      case 'plain': {
        const a = random.pick(this.plainScalars);
        const others = this.plainScalars.filter((entry) => entry !== a);
        switch (random.int(3)) {
          case 0:
            return mathRegion(`${a} =`);
          case 1:
            return mathRegion(
              others.length > 0
                ? `${a} + ${random.pick(others)} =`
                : `${a} + ${random.pick(NUMBERS)} =`,
            );
          default:
            return mathRegion(`${a}·2 - ${random.pick(NUMBERS)} =`);
        }
      }
      case 'unit': {
        const a = random.pick(this.unitScalars);
        return mathRegion(random.chance(0.4) ? `${a} = … m` : `${a} =`);
      }
      case 'function': {
        const f = random.pick(this.functions);
        return mathRegion(random.chance(0.5) ? `${f}(2) =` : `${f}(3) + 1 =`);
      }
      case 'matrix': {
        const a = random.pick(this.matrices);
        return mathRegion(random.chance(0.4) ? `\\det(${a}) =` : `tr(${a}) =`);
      }
      case 'program': {
        const name = random.pick(this.programs);
        return mathRegion(`${name}(5) =`);
      }
      case 'vector': {
        const name = random.pick(this.vectors);
        return mathRegion(`${name}[1] =`);
      }
      default:
        return mathRegion('∑[n ∈ 1..8] 1/n^2 =');
    }
  }

  // --- text, areas, plots, tables -------------------------------------------------------------

  makeText() {
    const random = this.random;
    const definedNames = [...this.plainScalars, ...this.unitScalars, ...this.ranges];
    switch (random.int(5)) {
      case 0:
        return textRegion({ paragraphs: [`${random.pick(HEADINGS)} ${this.nextId + 1}`], width: null });
      case 1:
        return textRegion({ paragraphs: [random.pick(PLAIN_SENTENCES)], width: DEFAULT_TEXT_WIDTH });
      case 2:
        return textRegion({
          paragraphs: [random.pick(PLAIN_SENTENCES), random.pick(PLAIN_SENTENCES)],
          width: DEFAULT_TEXT_WIDTH,
        });
      case 3: {
        if (definedNames.length === 0) {
          return textRegion({ paragraphs: [random.pick(PLAIN_SENTENCES)], width: 300 });
        }
        const sentence = random.pick(MATH_SENTENCES)(random.pick(definedNames));
        return textRegion({ paragraphs: [sentence], width: 300 });
      }
      default: {
        if (definedNames.length === 0) {
          return textRegion({ paragraphs: [random.pick(PLAIN_SENTENCES)], width: DEFAULT_TEXT_WIDTH });
        }
        const sentence = random.pick(MATH_SENTENCES)(random.pick(definedNames));
        return textRegion({ paragraphs: [sentence, random.pick(PLAIN_SENTENCES)], width: DEFAULT_TEXT_WIDTH });
      }
    }
  }

  makePlot() {
    const random = this.random;
    const range = random.pick(this.ranges); // the first definition token always creates one
    const forms = [`${range}^2`, `sin(${range})`, `${range}·2 + 1`, `${range}^3/2`];
    const count = 1 + random.int(Math.min(3, forms.length));
    const traces = [];
    for (let i = 0; i < count; i += 1) {
      traces.push({ id: `trace-${i + 1}`, x: range, y: forms[i] });
    }
    return plotRegion(traces);
  }

  makeTable() {
    const random = this.random;
    const rows = 3 + random.int(3);
    const columnCount = random.chance(0.5) ? 2 : 3;
    const columns = [];
    for (let index = 0; index < columnCount; index += 1) {
      const name = this.name('c');
      const unit = index === columnCount - 1 && random.chance(0.4) ? 'kg' : null;
      const cells = [];
      for (let row = 0; row < rows; row += 1) {
        cells.push(random.chance(0.3) ? (0.5 * (1 + random.int(9))).toFixed(1) : String(1 + random.int(20)));
      }
      columns.push({ name, unit, cells });
      this.vectors.push(name);
    }
    return tableRegion(columns);
  }

  makeAreaBand() {
    const random = this.random;
    const label = random.pick(['Load case', 'Inputs', 'Results', 'Geometry']);
    const title = random.chance(0.75) ? `${label} ${this.nextId + 1}` : '';
    return this.addRegion(areaRegion(title));
  }

  // --- blocks ---------------------------------------------------------------------------------

  buildBlocks() {
    const tokens = this.tokenStream();
    const consumed = new Array(tokens.length).fill(false);
    const blocks = [];
    let definitionsSeen = 0;

    const nextFree = (from) => {
      for (let index = from; index < tokens.length; index += 1) {
        if (!consumed[index]) return index;
      }
      return -1;
    };

    for (let index = 0; index < tokens.length; index += 1) {
      if (consumed[index]) continue;
      consumed[index] = true;
      const kind = tokens[index];

      if (kind === 'area') {
        const wanted = 2 + this.random.int(3);
        // Pick the member tokens first: a band without members is legal in the format, but an
        // empty band is not a useful benchmark region, so that token becomes a definition.
        const memberTokens = [];
        for (let scan = index + 1; scan < tokens.length && memberTokens.length < wanted; scan += 1) {
          if (consumed[scan]) continue;
          const other = tokens[scan];
          if (other === 'plot' || other === 'table' || other === 'area') continue;
          memberTokens.push(scan);
        }
        if (memberTokens.length === 0) {
          blocks.push({ kind: 'single', region: this.addRegion(this.makeDefinition()) });
          continue;
        }
        const area = this.makeAreaBand();
        area.collapsed = this.random.chance(0.34);
        const members = [];
        for (const scan of memberTokens) {
          const other = tokens[scan];
          if (other === 'definition') {
            definitionsSeen += 1;
            members.push(this.addRegion(this.makeDefinition()));
          } else if (other === 'evaluation') {
            members.push(this.addRegion(this.makeEvaluation()));
          } else if (other === 'text') {
            members.push(this.addRegion(this.makeText()));
          } else {
            members.push(this.addRegion(this.makeBlock()));
          }
          consumed[scan] = true;
        }
        const offsets = [];
        let cursor = BAND_START_OFFSET;
        for (const member of members) {
          offsets.push(cursor);
          cursor = snap(cursor + member.height + GAP);
        }
        const height = Math.max(MIN_AREA_HEIGHT, snap(cursor - GAP + AREA_BOTTOM_PADDING));
        if (height > BOTTOM - TOP) {
          throw new Error(`area band of ${height} pt does not fit on a page`);
        }
        blocks.push({ kind: 'area', area, members, offsets, height });
        continue;
      }

      if (kind === 'definition') {
        const first = definitionsSeen === 0;
        const second = definitionsSeen === 1;
        definitionsSeen += 1;
        if (first) {
          blocks.push({ kind: 'single', region: this.addRegion(this.makeRangeDefinition()) });
          continue;
        }
        if (second) {
          blocks.push({ kind: 'single', region: this.addRegion(this.makeScalarDefinition()) });
          continue;
        }
        const partner = nextFree(index + 1);
        const pair = partner >= 0 && tokens[partner] === 'evaluation' && this.random.chance(0.35);
        const definition = this.addRegion(this.makeDefinition());
        if (!pair) {
          blocks.push({ kind: 'single', region: definition });
          continue;
        }
        consumed[partner] = true;
        // A row only holds two regions side by side when both fit their column.
        const evaluation = this.addRegion(this.makeEvaluation(definition.hint));
        if (definition.width > PAIR_MAX_WIDTH || evaluation.width > PAIR_MAX_WIDTH) {
          blocks.push({ kind: 'single', region: definition });
          blocks.push({ kind: 'single', region: evaluation });
          continue;
        }
        blocks.push({
          kind: 'pair',
          left: definition,
          right: evaluation,
          height: Math.max(definition.height, evaluation.height),
        });
        continue;
      }

      if (kind === 'evaluation') {
        blocks.push({ kind: 'single', region: this.addRegion(this.makeEvaluation()) });
        continue;
      }

      if (kind === 'text') {
        blocks.push({ kind: 'single', region: this.addRegion(this.makeText()) });
        continue;
      }

      if (kind === 'plot') {
        blocks.push({ kind: 'single', region: this.addRegion(this.makePlot()) });
        continue;
      }

      if (kind === 'table') {
        blocks.push({ kind: 'single', region: this.addRegion(this.makeTable()) });
        continue;
      }

      blocks.push({ kind: 'single', region: this.addRegion(this.makeBlock()) });
    }

    return blocks;
  }

  generate() {
    const blocks = this.buildBlocks();
    const pages = layOut(blocks);
    if (this.regions.length !== this.regionTarget) {
      throw new Error(`generated ${this.regions.length} regions, expected ${this.regionTarget}`);
    }
    return { regions: this.regions, pages, blocks };
  }
}

function moveKindTo(tokens, kind, position) {
  if (position >= tokens.length || tokens[position] === kind) return;
  const found = tokens.indexOf(kind, position + 1);
  if (found < 0) return;
  const swap = tokens[position];
  tokens[position] = tokens[found];
  tokens[found] = swap;
}

/** Stacks the blocks down the printable area, starting a new page when a block does not fit. */
function layOut(blocks) {
  let page = 1;
  let cursor = TOP;

  const nextSlot = (height) => {
    if (cursor + height > BOTTOM + 1e-9) {
      page += 1;
      cursor = TOP;
    }
    if (cursor + height > BOTTOM + 1e-9) {
      throw new Error(`a ${height} pt block does not fit on an A4 page`);
    }
    const y = cursor;
    cursor = snap(cursor + height + GAP);
    return { page, y };
  };

  for (const block of blocks) {
    if (block.kind === 'single') {
      const slot = nextSlot(block.region.height);
      block.region.page = slot.page;
      block.region.x = LEFT_X;
      block.region.y = slot.y;
      continue;
    }
    if (block.kind === 'pair') {
      const slot = nextSlot(block.height);
      block.left.page = slot.page;
      block.left.x = LEFT_X;
      block.left.y = slot.y;
      block.right.page = slot.page;
      block.right.x = RIGHT_X;
      block.right.y = slot.y;
      continue;
    }
    const slot = nextSlot(block.height);
    block.area.page = slot.page;
    block.area.x = LEFT_X;
    block.area.y = slot.y;
    block.area.height = block.height;
    block.members.forEach((member, index) => {
      member.page = slot.page;
      member.x = LEFT_X;
      member.y = snap(slot.y + block.offsets[index]);
    });
  }

  return page;
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

function renderWorksheet(regions) {
  const lines = [
    'format: equavela-worksheet/3',
    'page:',
    '  size: A4',
    `  margins: {top: ${num(MARGIN.top)}, right: ${num(MARGIN.right)}, bottom: ${num(MARGIN.bottom)}, left: ${num(MARGIN.left)}}`,
    'settings:',
    '  format.precision: 3',
    'regions:',
  ];
  for (const region of regions) {
    lines.push(`  - id: ${region.id}`);
    lines.push(`    page: ${region.page}`);
    lines.push(`    at: [${num(region.x)}, ${num(region.y)}]`);
    lines.push(...renderBody(region));
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// --check: read the file back and verify the geometry it stores.
//
// The extents are recomputed from the stored region content with the same conservative estimator
// the generator uses (a one-line math region 24 pt high, 18 pt per program or text line, the
// plot's stored size plus its expression row, a table's rows). Areas are containers: a band
// is checked against the other bands and the page, and each of its members against the band.
// ---------------------------------------------------------------------------------------------

function readBlock(lines, start, indent) {
  const pad = ' '.repeat(indent);
  const raw = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line !== '' && !line.startsWith(pad)) break;
    raw.push(line);
    index += 1;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  // The indentation of a block scalar is not part of its value.
  const collected = raw.map((line) => (line.startsWith(pad) ? line.slice(indent) : line));
  return { lines: collected, text: collected.join('\n'), next: index };
}

function unquoteYaml(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseWorksheet(text) {
  const lines = text.split('\n');
  if (lines[0] !== 'format: equavela-worksheet/3') {
    throw new Error(`first line is \`${lines[0]}\`, expected the worksheet format key`);
  }
  const regions = [];
  let region = null;
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    const header = /^ {2}- id: (\S+)$/.exec(line);
    if (header) {
      region = { id: header[1], page: null, x: null, y: null, kind: null };
      regions.push(region);
      index += 1;
      continue;
    }
    if (region === null) {
      index += 1;
      continue;
    }
    let match;
    if ((match = /^ {4}page: (\d+)$/.exec(line))) {
      region.page = Number(match[1]);
      index += 1;
      continue;
    }
    if ((match = /^ {4}at: \[([^,]+), ([^\]]+)\]$/.exec(line))) {
      region.x = Number(match[1]);
      region.y = Number(match[2]);
      index += 1;
      continue;
    }
    if (line.startsWith('    math: ')) {
      region.kind = 'math';
      const value = line.slice('    math: '.length);
      if (value === '|') {
        const block = readBlock(lines, index + 1, 6);
        region.math = block.text;
        region.mathLines = block.lines.length;
        index = block.next;
      } else {
        region.math = unquoteYaml(value);
        region.mathLines = 1;
        index += 1;
      }
      continue;
    }
    if (line === '    text:' || line.startsWith('    text: ')) {
      region.kind = 'text';
      region.width = null;
      if (line === '    text:') {
        index += 1;
        while (index < lines.length && /^ {6}(width|text):/.test(lines[index])) {
          const field = /^ {6}(width|text): ?(.*)$/.exec(lines[index]);
          if (field[1] === 'width') {
            region.width = Number(field[2]);
            index += 1;
          } else if (field[2] === '|') {
            const block = readBlock(lines, index + 1, 8);
            region.text = block.text;
            index = block.next;
          } else {
            region.text = unquoteYaml(field[2]);
            index += 1;
          }
        }
        continue;
      }
      region.text = unquoteYaml(line.slice('    text: '.length));
      index += 1;
      continue;
    }
    if (line === '    area:') {
      region.kind = 'area';
      region.title = '';
      region.height = null;
      region.collapsed = false;
      index += 1;
      while (index < lines.length && /^ {6}(title|height|collapsed):/.test(lines[index])) {
        const field = /^ {6}(title|height|collapsed): ?(.*)$/.exec(lines[index]);
        if (field[1] === 'title') region.title = unquoteYaml(field[2]);
        else if (field[1] === 'height') region.height = Number(field[2]);
        else region.collapsed = field[2] === 'true';
        index += 1;
      }
      continue;
    }
    if (line === '    plot:') {
      region.kind = 'plot';
      region.size = null;
      index += 1;
      while (index < lines.length && /^ {6}/.test(lines[index])) {
        const field = /^ {6}size: \[([^,]+), ([^\]]+)\]$/.exec(lines[index]);
        if (field) region.size = [Number(field[1]), Number(field[2])];
        index += 1;
      }
      continue;
    }
    if (line === '    table:') {
      region.kind = 'table';
      region.columns = 0;
      const firstColumnCells = [];
      let inFirstColumn = false;
      index += 1;
      while (index < lines.length && /^ {6}/.test(lines[index])) {
        if (/^ {6}- name: /.test(lines[index])) {
          region.columns += 1;
          inFirstColumn = region.columns === 1;
        } else if (/^ {10}- /.test(lines[index]) && inFirstColumn) {
          firstColumnCells.push(lines[index]);
        }
        index += 1;
      }
      region.rows = firstColumnCells.length;
      continue;
    }
    index += 1;
  }
  return regions;
}

function regionExtents(region) {
  switch (region.kind) {
    case 'math': {
      if (region.mathLines === 1) {
        return {
          width: CHAR_WIDTH * [...region.math].length + 12,
          height: MATRIX_PATTERN.test(region.math) ? MATRIX_HEIGHT : MATH_LINE_HEIGHT,
        };
      }
      const longest = Math.max(...region.math.split('\n').map((line) => [...line].length), 1);
      return { width: CHAR_WIDTH * longest + 12, height: LINE_HEIGHT * region.mathLines + 6 };
    }
    case 'text': {
      const width = region.width ?? DEFAULT_TEXT_WIDTH;
      return {
        width,
        height: LINE_HEIGHT * estimateTextLines(region.text.split('\n\n'), width) + 6,
      };
    }
    case 'plot':
      return { width: region.size[0], height: region.size[1] + PLOT_LABEL_HEIGHT };
    case 'table':
      return {
        width: TABLE_COLUMN_WIDTH * region.columns,
        height: TABLE_ROW_HEIGHT * (region.rows + 1) + 6,
      };
    case 'area':
      return { width: PRINTABLE_WIDTH, height: region.height };
    default:
      throw new Error(`region \`${region.id}\` has no known kind`);
  }
}

function checkWorksheet(text, expectedRegions) {
  const problems = [];
  const regions = parseWorksheet(text);
  if (regions.length !== expectedRegions) {
    problems.push(`region count is ${regions.length}, expected ${expectedRegions}`);
  }
  const ids = new Set();
  regions.forEach((region, index) => {
    const expectedId = `r${index + 1}`;
    if (region.id !== expectedId) {
      problems.push(`region ${index + 1} has id \`${region.id}\`, expected \`${expectedId}\``);
    }
    if (ids.has(region.id)) problems.push(`duplicate region id \`${region.id}\``);
    ids.add(region.id);
    if (region.kind === null) problems.push(`region \`${region.id}\` has no content key`);
    if (!Number.isInteger(region.page) || region.page < 1) {
      problems.push(`region \`${region.id}\` has page ${region.page}`);
    }
    if (!Number.isFinite(region.x) || !Number.isFinite(region.y)) {
      problems.push(`region \`${region.id}\` has a non-finite position`);
    }
  });

  const pages = regions.map((region) => region.page);
  for (let index = 1; index < pages.length; index += 1) {
    if (pages[index] < pages[index - 1]) {
      problems.push(
        `region \`${regions[index].id}\` starts page ${pages[index]} after page ${pages[index - 1]}`,
      );
      break;
    }
  }
  const pageCount = Math.max(...pages, 1);
  for (const page of new Set(pages)) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      problems.push(`page ${page} is out of range`);
    }
  }

  const rects = regions.map((region) => {
    const extents = regionExtents(region);
    const rect = {
      region,
      x1: region.x,
      y1: region.y,
      x2: region.x + extents.width,
      y2: region.y + extents.height,
    };
    if (rect.x1 < LEFT_X - 1e-6) {
      problems.push(`region \`${region.id}\` starts left of the margin (x = ${rect.x1})`);
    }
    if (rect.x2 > RIGHT_EDGE + 1e-6) {
      problems.push(`region \`${region.id}\` reaches x = ${rect.x2}, past the right margin`);
    }
    if (rect.y1 < TOP - 1e-6) {
      problems.push(`region \`${region.id}\` starts above the printable area (y = ${rect.y1})`);
    }
    if (rect.y2 > BOTTOM + 1e-6) {
      problems.push(`region \`${region.id}\` ends at y = ${rect.y2}, below the printable area`);
    }
    return rect;
  });

  const overlaps = (a, b) =>
    a.x1 < b.x2 - 1e-6 && b.x1 < a.x2 - 1e-6 && a.y1 < b.y2 - 1e-6 && b.y1 < a.y2 - 1e-6;

  // Only regions of the same page can overlap, so the comparisons are bucketed by page.
  const byPage = new Map();
  for (const rect of rects) {
    const bucket = byPage.get(rect.region.page) ?? { content: [], bands: [] };
    if (rect.region.kind === 'area') bucket.bands.push(rect);
    else bucket.content.push(rect);
    byPage.set(rect.region.page, bucket);
  }

  for (const [page, bucket] of byPage) {
    for (let i = 0; i < bucket.content.length; i += 1) {
      for (let j = i + 1; j < bucket.content.length; j += 1) {
        if (overlaps(bucket.content[i], bucket.content[j])) {
          problems.push(
            `regions \`${bucket.content[i].region.id}\` and \`${bucket.content[j].region.id}\` overlap on page ${page}`,
          );
        }
      }
    }
    for (let i = 0; i < bucket.bands.length; i += 1) {
      const band = bucket.bands[i];
      for (let j = i + 1; j < bucket.bands.length; j += 1) {
        if (overlaps(band, bucket.bands[j])) {
          problems.push(`areas \`${band.region.id}\` and \`${bucket.bands[j].region.id}\` overlap on page ${page}`);
        }
      }
      const members = bucket.content.filter(
        (rect) => rect.y1 >= band.y1 + 21 - 1e-6 && rect.y1 < band.y2 - 1e-6,
      );
      if (members.length === 0) problems.push(`area \`${band.region.id}\` has no member region`);
      for (const member of members) {
        if (member.y2 > band.y2 + 1e-6) {
          problems.push(`member \`${member.region.id}\` ends below its area \`${band.region.id}\``);
        }
      }
    }
  }

  const kinds = new Map();
  for (const region of regions) {
    kinds.set(region.kind, (kinds.get(region.kind) ?? 0) + 1);
  }

  return { problems, regions, pageCount, kinds };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const USAGE = `usage:
  node scripts/perf/gen-worksheet.mjs --regions <count> --out <file.eqv> [--seed <n>] [--mix default] [--check]
  node scripts/perf/gen-worksheet.mjs --all --out-dir <dir> [--seed <n>] [--mix default] [--check]

  --regions <n>   number of regions to generate
  --out <file>    the worksheet file to write
  --all           write large-1k.eqv, large-5k.eqv and large-20k.eqv into --out-dir
  --out-dir <dir> directory for --all (created when missing)
  --seed <n>      PRNG seed, so the same seed always produces the same worksheet (default 1)
  --mix <name>    content mix, only \`default\` (45 % definitions + the rest, 25 % evaluations,
                  15 % text, 5 % programs/matrices/ranges, 3 % areas, 1 % plots, 1 % tables)
  --check         re-read the written file and verify region count, page bounds and overlaps
  -h, --help      this text`;

function fail(message) {
  process.stderr.write(`gen-worksheet: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { regions: null, out: null, outDir: null, all: false, seed: 1, mix: 'default', check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) fail(`\`${argument}\` needs a value`);
      return argv[index];
    };
    switch (argument) {
      case '--regions': {
        const text = value();
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed < 1) {
          fail(`\`--regions\` needs a positive integer, got \`${text}\``);
        }
        options.regions = parsed;
        break;
      }
      case '--out':
        options.out = value();
        break;
      case '--out-dir':
        options.outDir = value();
        break;
      case '--seed': {
        const text = value();
        const parsed = Number(text);
        if (!Number.isInteger(parsed) || parsed < 0) {
          fail(`\`--seed\` needs a non-negative integer, got \`${text}\``);
        }
        options.seed = parsed;
        break;
      }
      case '--mix': {
        const name = value();
        if (!Object.hasOwn(MIXES, name)) {
          fail(`unknown mix \`${name}\` (known: ${Object.keys(MIXES).join(', ')})`);
        }
        options.mix = name;
        break;
      }
      case '--all':
        options.all = true;
        break;
      case '--check':
        options.check = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        fail(`unknown argument \`${argument}\``);
    }
  }
  if (options.all) {
    if (options.regions !== null || options.out !== null) {
      fail('`--all` cannot be combined with `--regions`/`--out`');
    }
    if (options.outDir === null) fail('`--all` needs `--out-dir`');
  } else {
    if (options.regions === null) fail('one of `--regions` or `--all` is required');
    if (options.out === null) fail('`--regions` needs `--out`');
    if (options.outDir !== null) fail('`--out-dir` is only used with `--all`');
  }
  return options;
}

function writeOne({ regions, seed, mix, path, check }) {
  const generator = new WorksheetGenerator({ regions, seed, mix: MIXES[mix] });
  const { regions: generated, pages } = generator.generate();
  const text = renderWorksheet(generated);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text);
  const bytes = Buffer.byteLength(text);
  let line = `wrote ${path} — ${generated.length} regions, ${pages} pages, ${bytes} bytes`;

  if (check) {
    const { problems, pageCount } = checkWorksheet(text, regions);
    if (problems.length > 0) {
      process.stderr.write(`check failed for ${path}:\n`);
      for (const problem of problems.slice(0, 20)) process.stderr.write(`  - ${problem}\n`);
      if (problems.length > 20) process.stderr.write(`  ... and ${problems.length - 20} more\n`);
      process.exit(1);
    }
    line += ` (checked: ${pageCount} pages, no overlaps)`;
  }
  process.stdout.write(`${line}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.all) {
    for (const sheet of SHEET_SIZES) {
      writeOne({
        regions: sheet.regions,
        seed: options.seed,
        mix: options.mix,
        path: join(options.outDir, sheet.file),
        check: options.check,
      });
    }
    return;
  }
  writeOne({
    regions: options.regions,
    seed: options.seed,
    mix: options.mix,
    path: options.out,
    check: options.check,
  });
}

main();
