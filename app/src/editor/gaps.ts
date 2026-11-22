// reading-order caret positions derived from the editable tree.
import type { Caret, Side } from "./model";
import { BIG_OPS, children, textParts, type Node, type Path } from "./tree";

export interface Gap {
  focus: Path;
  side: Side;
  caret: Caret | null;
}

const BOXES = new Set([
  "Paren", "Abs", "Det", "Norm", "Root", "Conj", "RealPart", "ImagPart", "Vectorize", "Matrix",
  "Div", "Program",
]);
const PREFIXES = new Set(["Neg", "Not", "Return", "For", "While", "Branch", "Try"]);
const SUFFIXES = new Set([
  "Pow", "Index", "Column", "Row", "Call", "FunctionHead",
  "Factorial", "Percent", "Permille", "Transpose", "PrimeDeriv",
]);

/** Whether the outer edge differs from the edge of the first or last child. */
function hasOuterEdge(node: Node, side: Side): boolean {
  if (side === "R" && (
    (node.type === "Evaluate" && !node.unit) ||
    (node.type === "Define" && node.tail?.type === "Eval" && !node.tail.unit)
  )) return true;
  return BOXES.has(node.type) || BIG_OPS.has(node.type) ||
    (node.type === "JuliaCall" && !node.bare) ||
    (side === "L" ? PREFIXES : SUFFIXES).has(node.type);
}

type GapToken =
  | { kind: "edge"; owner: Path; side: Side }
  | { kind: "join"; owner: Path; slot: number };

interface GapSequence {
  positions: Gap[];
  tokens: Map<number, GapToken>;
  spans: Map<string, readonly [number, number]>;
}

let cached: { root: Node; sequence: GapSequence } | undefined;
const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;

export function* textGapOffsets(text: string): Iterable<number> {
  yield 0;
  if (graphemes) {
    for (const { segment, index } of graphemes.segment(text)) yield index + segment.length;
  } else {
    let offset = 0;
    for (const character of text) {
      offset += character.length;
      yield offset;
    }
  }
}

/** Positions are transient. A new tree has new positions and spans. */
export function caretGaps(root: Node): GapSequence {
  if (cached?.root === root) return cached.sequence;
  const positions: Gap[] = [];
  const spans: GapSequence["spans"] = new Map();
  const tokens: GapSequence["tokens"] = new Map();
  const crossing = (token: GapToken) => tokens.set(positions.length - 1, token);

  function visit(node: Node, focus: Path) {
    const start = positions.length;
    const append = (side: Side, caret: Caret | null = null) => positions.push({ focus, side, caret });
    const slots = children(node);
    const parts = textParts(node);
    if (parts.length > 0) {
      if (node.type === "Str") {
        append("L");
        crossing({ kind: "edge", owner: focus, side: "L" });
      }
      parts.forEach((text, seg) => {
        for (const offset of textGapOffsets(text)) {
          append(seg === 0 && offset === 0 ? "L" : "R", { seg, offset });
        }
      });
      if (node.type === "Str") {
        crossing({ kind: "edge", owner: focus, side: "R" });
        append("R");
      }
    } else if (slots.length > 0) {
      if (hasOuterEdge(node, "L")) {
        append("L");
        crossing({ kind: "edge", owner: focus, side: "L" });
      }
      // Editing children are in reading order. The 2-D slot conventions are in .
      slots.forEach((slot, index) => {
        if (index > 0) crossing({ kind: "join", owner: focus, slot: index });
        visit(slot, [...focus, index]);
      });
      if (hasOuterEdge(node, "R")) {
        crossing({ kind: "edge", owner: focus, side: "R" });
        append("R");
      }
    } else {
      append("L");
      if (node.type !== "Placeholder") append("R");
    }
    spans.set(focus.join("."), [start, positions.length - 1]);
  }

  visit(root, []);
  const result = { positions, spans, tokens };
  cached = { root, sequence: result };
  return result;
}

export function gapSpan(sequence: GapSequence, path: Path): readonly [number, number] | undefined {
  return sequence.spans.get(path.join("."));
}

export function gapIndex(sequence: GapSequence, gap: Gap): number | undefined {
  const span = gapSpan(sequence, gap.focus);
  if (!span) return undefined;
  if (gap.caret) {
    for (let i = span[0]; i <= span[1]; i++) {
      const position = sequence.positions[i];
      if (position.caret?.seg === gap.caret.seg && position.caret.offset === gap.caret.offset) return i;
    }
  }
  return span[gap.side === "L" ? 0 : 1];
}

/** The structural token traversed by the adjacent gap step, if any. */
export function adjacentToken(root: Node, gap: Gap, side: Side): GapToken | undefined {
  const sequence = caretGaps(root);
  const index = gapIndex(sequence, gap);
  return index === undefined ? undefined : sequence.tokens.get(side === "L" ? index - 1 : index);
}
