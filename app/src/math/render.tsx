// Rendering of the canonical AST as DOM.
// Layout is plain inline flow with inline-blocks
// for fractions, matrices and big operators; every line, fence and bar is an SVG with a
// stroke of at least 1 pt (rule R5), never a CSS border.
//
// Addressing (math editor): when a `path` is passed, every node is wrapped in an unstyled
// inline `<span class="node" data-path="i.j.k">` (program lines carry the attribute on
// their own block element), where the path is the node's path of child indices in the
// editor's tree (`editor/tree.ts`, `childRefs`). The editor positions its editing lines
// and hit-tests clicks with these elements. The wrappers have no box of their own, so the
// layout is the same with or without them.

import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";
import { BINARY_GLYPH, ELLIPSIS_GLYPH, GLYPH, level } from "./glyphs";
import { isNode, nameText, type Expr, type Name, type Node, type Stmt, type Target } from "./ast";
import { UNIT_NAMES } from "./units";
import { LABEL_KINDS, LabelStylesContext, nameStyle, type LabelKind, type NameStyle } from "./labels";
import { spanOf } from "../editor/tree";
import type { MathBreak } from "../equavelaApi";

/** Stroke width of document lines in CSS px: 1.4 px = 1.05 pt (R5: at least 1 pt). */
export const STROKE = 1.4;

export type Path = readonly number[];

const pathKey = (path: Path) => path.join(".");
const at = (path: Path | undefined, ...rest: number[]): Path | undefined =>
  path ? [...path, ...rest] : undefined;

/** The presentation breaks of the statement being drawn, by node path. */
type BreakInfo = { before: boolean; offsets: number[] };
const NO_BREAKS: ReadonlyMap<string, BreakInfo> = new Map();
export const MathBreaksContext = createContext<ReadonlyMap<string, BreakInfo>>(NO_BREAKS);

function breakMap(breaks: readonly MathBreak[] | undefined): ReadonlyMap<string, BreakInfo> {
  if (!breaks || breaks.length === 0) return NO_BREAKS;
  const map = new Map<string, BreakInfo>();
  for (const lineBreak of breaks) {
    const key = pathKey(lineBreak.path);
    const info = map.get(key) ?? { before: false, offsets: [] };
    if (lineBreak.offset === undefined) info.before = true;
    else if (!info.offsets.includes(lineBreak.offset)) info.offsets.push(lineBreak.offset);
    map.set(key, info);
  }
  return map;
}

/**
 * A presentation line break: a subtle gray return arrow at the end of the previous line, the
 * line break itself, and the indentation of the continuation line. The arrow is an editing aid
 * (no-print), the indentation is part of the drawing on screen and in the PDF.
 */
function LineBreak() {
  return (
    <>
      <span className="eq-break-arrow no-print" aria-hidden="true">
        ↵
      </span>
      <br className="eq-break" />
      <span className="eq-break-indent" aria-hidden="true" />
    </>
  );
}

/**
 * A string literal, split at its presentation break offsets without changing its value. Each
 * drawn piece carries `data-str-offset` (its position in the string) so the editor can map a
 * click on a continuation line to the right character; the quotes are their own spans, which
 * keeps a click on a quote outside the text.
 */
function StrView({ text, path }: { text: string; path: Path | undefined }) {
  const breaks = useContext(MathBreaksContext);
  const offsets = path ? [...(breaks.get(pathKey(path))?.offsets ?? [])] : [];
  const sorted = [...new Set(offsets)].filter((offset) => offset >= 0 && offset <= text.length).sort((a, b) => a - b);
  const parts: ReactNode[] = [
    <span className="str-quote" key="open">{`“`}</span>,
  ];
  let from = 0;
  const push = (to: number) => {
    if (to > from) {
      parts.push(
        <span key={`text-${from}`} data-str-offset={from}>
          {text.slice(from, to)}
        </span>,
      );
    }
  };
  sorted.forEach((offset, index) => {
    push(offset);
    parts.push(<LineBreak key={`break-${index}`} />);
    from = offset;
  });
  push(text.length);
  parts.push(<span className="str-quote" key="close">{`”`}</span>);
  return <span className="str">{parts}</span>;
}

/** Wraps a node's elements so that its path can be found in the DOM. */
function N({ path, node, children }: { path: Path | undefined; node?: unknown; children: ReactNode }) {
  if (!path) return <>{children}</>;
  const span = spanOf(node);
  return (
    <span className="node" data-path={pathKey(path)} data-span={span ? `${span.start}-${span.end}` : undefined}>
      {children}
    </span>
  );
}

// ---- name context: which names are units -------------------------------------------------

export type MathNames = {
  /** Unit names of the shared unit table (`kernel/EqRuntime/src/units.tsv`). */
  units: ReadonlySet<string>;
  /**
   * Whether this subtree is a **unit context** — a slot that can only hold a unit: the unit override
   * after the result of an evaluation, a plot axis display unit
   * . Every plain name there is a unit; in a value position a name
   * is a unit only with its explicit label, so a plain unit-like name draws as a variable.
   */
  unitContext?: boolean;
};

export const MathNamesContext = createContext<MathNames>({ units: UNIT_NAMES });

/**
 * Adds the simple names a statement defines (definition targets and function names) to `names`. The
 * page view keeps the names of the whole worksheet across edits, so it needs one statement at a
 * time; `definedNames` below is the same walk over a list.
 */
export function addDefinedNames(names: Set<string>, statement: unknown): void {
  if (!isNode(statement) || (statement.type !== "Define" && statement.type !== "GlobalDefine")) return;
  const target = statement.target;
  if (!isNode(target)) return;
  if (target.type === "Ident") names.add(nameText(target.name));
  else if (target.type === "FunctionHead") names.add(nameText(target.name.name));
  else if (target.type === "Call" && isNode(target.callee) && target.callee.type === "Ident") {
    names.add(nameText(target.callee.name));
  }
}

/** The simple names defined by a list of statements (definition targets and function names). */
export function definedNames(statements: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) addDefinedNames(names, statement);
  return names;
}

/** Whether a name is a unit: the explicit label, or any plain name of a unit context. */
function isUnitName(name: Name, names: MathNames): boolean {
  if (name.label === "unit") return true;
  if (!names.unitContext || name.label || name.segments.length !== 1) return false;
  return names.units.has(name.segments[0].text);
}

/** The label of a name as written; a label the model does not know
 *  draws as a variable. */
function labelOfSuffix(label: string): LabelKind {
  return (LABEL_KINDS as readonly string[]).includes(label) ? (label as LabelKind) : "var";
}

/**
 * The label a name is drawn with: its **explicit** label, else the **contextual**
 * one the drawing already resolves — the head of a call is a function, a name inside a unit context is
 * a unit, and
 * every other name is a variable. The `Given` of a solve block is a keyword at its own view
 * (`isGivenKeyword`). Nothing here is written to the file: a contextual label stays contextual
 * .
 */
export function labelOfName(name: Name, names: MathNames, callee = false): LabelKind {
  if (name.label) return labelOfSuffix(name.label);
  if (callee) return "fn";
  if (isUnitName(name, names)) return "unit";
  return "var";
}

/**
 * The declarations and the colour attribute of a name of `kind`: nothing when the worksheet
 * stores no style that differs from the built-in one, so a default worksheet draws as before.
 */
function useNameStyle(kind: LabelKind): NameStyle {
  return nameStyle(useContext(LabelStylesContext), kind);
}

// ---- drawn elements ---------------------------------------------------------------------

/** A horizontal rule stretched over its container (fraction bar, overbar). */
function HRule({ className }: { className: string }) {
  return (
    <svg className={className} width="100%" height={4} aria-hidden="true">
      <line x1="0" y1="2" x2="100%" y2="2" stroke="currentColor" strokeWidth={STROKE} />
    </svg>
  );
}

/** A vertical rule stretched over the height of its container. */
function VRule({ className }: { className: string }) {
  return (
    <svg className={className} width={4} height="100%" aria-hidden="true">
      <line x1="2" y1="0" x2="2" y2="100%" stroke="currentColor" strokeWidth={STROKE} />
    </svg>
  );
}

export type FenceKind = "paren" | "bracket" | "bar" | "dbar" | "angle";

const FENCE_PATHS: Record<FenceKind, { left: string; right: string }> = {
  paren: { left: "M5.5,1 C1.5,25 1.5,75 5.5,99", right: "M0.5,1 C4.5,25 4.5,75 0.5,99" },
  bracket: { left: "M5.5,1 H1.5 V99 H5.5", right: "M0.5,1 H4.5 V99 H0.5" },
  bar: { left: "M3,0 V100", right: "M3,0 V100" },
  dbar: { left: "M1.5,0 V100 M4.5,0 V100", right: "M1.5,0 V100 M4.5,0 V100" },
  angle: { left: "M5.5,1 L1.5,50 L5.5,99", right: "M0.5,1 L4.5,50 L0.5,99" },
};

/**
 * The vectorize arrow: a rule over the whole width of its operand, and an
 * arrowhead of fixed size at its right end.
 */
function VectorizeArrow() {
  return (
    <svg className="vec-arrow" height={6} aria-hidden="true" overflow="visible">
      <line x1="0" y1="3" x2="100%" y2="3" stroke="currentColor" strokeWidth={1} />
      <svg x="100%" overflow="visible">
        <polyline points="-4,0.5 0,3 -4,5.5" fill="none" stroke="currentColor" strokeWidth={1} strokeLinejoin="round" />
      </svg>
    </svg>
  );
}

/**
 * A square bracket of any height: the vertical rule runs over the whole height
 * and the two short rules sit at its very ends, in pixels. A stretched path would put them at 1 % and
 * 99 % of the height, far inside a tall matrix.
 */
export function BracketSide({ side }: { side: "left" | "right" }) {
  const stem = side === "left" ? 1.5 : 4.5;
  const tip = side === "left" ? 5.5 : 0.5;
  const half = STROKE / 2;
  return (
    <svg className={`fence-side ${side}`} width={6} aria-hidden="true" overflow="visible">
      <line x1={stem} y1="0" x2={stem} y2="100%" stroke="currentColor" strokeWidth={STROKE} />
      <line x1={stem} y1={half} x2={tip} y2={half} stroke="currentColor" strokeWidth={STROKE} />
      <svg y="100%" overflow="visible">
        <line x1={stem} y1={-half} x2={tip} y2={-half} stroke="currentColor" strokeWidth={STROKE} />
      </svg>
    </svg>
  );
}

function FenceSide({ kind, side }: { kind: FenceKind; side: "left" | "right" }) {
  if (kind === "bracket") return <BracketSide side={side} />;
  const wide = kind === "dbar" ? 7 : 6;
  return (
    <svg
      className={`fence-side ${side}`}
      width={wide}
      viewBox={`0 0 ${wide} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={FENCE_PATHS[kind][side]}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Content between two stretching fences; keeps the baseline of its content. */
export function Fenced({ kind, children, className = "" }: { kind: FenceKind; children: ReactNode; className?: string }) {
  return (
    <span className={`fenced ${kind} ${className}`}>
      <FenceSide kind={kind} side="left" />
      {children}
      <FenceSide kind={kind} side="right" />
    </span>
  );
}

/** Boolean equality: two heavy bars, so it can never be mistaken for evaluation. */
export function BooleanEquals() {
  return (
    <span className="op booleq" role="img" aria-label="boolean equals" data-glyph="==">
      <svg viewBox="0 0 11 12" aria-hidden="true">
        <line x1="0.5" y1="4" x2="10.5" y2="4" stroke="currentColor" strokeWidth={2.4} />
        <line x1="0.5" y1="8.5" x2="10.5" y2="8.5" stroke="currentColor" strokeWidth={2.4} />
      </svg>
    </span>
  );
}

function Op({ glyph, className = "" }: { glyph: string; className?: string }) {
  return <span className={`op ${className}`}>{glyph}</span>;
}

/**
 * A node the renderer has no view for: a neutral placeholder, never the type name. A bare
 * `Placeholder` where a statement or a program line is expected is the normal grey placeholder;
 * anything else is a bug worth a warning in development.
 */
function UnknownNode({ type, where, line = false }: { type: string; where: string; line?: boolean }) {
  if (type !== "Placeholder" && import.meta.env?.DEV) {
    console.warn(`math renderer: no view for ${where} node type "${type}"`);
  }
  return line ? (
    <span className="line">
      <Placeholder />
    </span>
  ) : (
    <Placeholder />
  );
}

function Placeholder() {
  return <span className="ph" role="img" aria-label="placeholder" />;
}

/** The differential `d` of derivatives and integrals: an upright Latin d (ISO 80000-2). */
function Differential() {
  return <span className="up diff">d</span>;
}

// ---- names and leaves -------------------------------------------------------------------

const GREEK = /^[Ͱ-Ͽ]/;

/**
 * The text of a name as drawn: the plus and minus that belong to a name (U+02D6, U+02D7) take the
 * shapes of + and −; their own glyphs are small raised marks. One character for one, so
 * caret offsets are unchanged.
 */
const shown = (text: string) => text.replace(/˖/g, "+").replace(/˗/g, "−");

/**
 * A name part as drawn: the apostrophes stand upright whatever the style of the name, so `x''` never
 * reads as the slanted prime derivative `x″`. The characters are the same, one for one.
 */
function NamePart({ text }: { text: string }) {
  const pieces = shown(text).split(/('+)/).filter((piece) => piece !== "");
  if (pieces.length === 1 && !pieces[0].startsWith("'")) return <>{pieces[0]}</>;
  return <>{pieces.map((piece, i) => (piece.startsWith("'") ? <span key={i} className="apos">{piece}</span> : piece))}</>;
}

function NameView({ name, upright = false, callee = false }: { name: Name; upright?: boolean; callee?: boolean }) {
  const names = useContext(MathNamesContext);
  const [first, ...rest] = name.segments;
  const paint = useNameStyle(labelOfName(name, names, callee));
  if (!first) return null;
  const unit = !callee && isUnitName(name, names);
  const klass = (text: string) =>
    // A unit is italic, but a Greek unit (Ω, μ) stays upright. A Greek letter
    // of any other name follows its style like a Latin one.
    unit ? (GREEK.test(text) ? "id up unit" : "id unit") : upright ? "id up" : "id";
  return (
    // The label style of the worksheet: the letters carry the declarations
    // of and the name carries the attribute that selects the colour rule of the stylesheet. Both
    // are empty for a label the worksheet does not style, so nothing changes for a default worksheet.
    <span className="name" data-name={nameText(name)} data-label={paint.label ?? undefined} style={paint.style}>
      <span className={klass(first.text)} style={paint.style}><NamePart text={first.text} /></span>
      {rest.map((segment, index) =>
        segment.subscript ? (
          // A literal subscript is drawn in the style of its name.
          <span key={index} className={klass(segment.text).replace(/^id/, "sub lit")} style={paint.style}>
            <NamePart text={segment.text} />
          </span>
        ) : (
          <span key={index} className={klass(segment.text)} style={paint.style}>
            <NamePart text={segment.text} />
          </span>
        ),
      )}
    </span>
  );
}

/** A binder name (`∑`, `∫`, `ⅆ`, `lim`, `for` variable): a name or, while editing, `□`. */
function VarView({ v, path }: { v: Node; path: Path | undefined }) {
  return (
    <N path={path} node={v}>
      {v.type === "Placeholder" || !v.name ? <Placeholder /> : <NameView name={v.name} />}
    </N>
  );
}

// ---- expressions ------------------------------------------------------------------------

/** Wraps `expr` in safety parentheses when it binds weaker than `min`. */
/** Constructs taller than a line of text: an exponent on them goes to their top. */
const TALL = new Set(["Div", "Matrix", "Sum", "Prod", "Integral", "Deriv", "Partial", "Limit", "Gradient", "Program", "Column"]);

/** Whether a power's base holds a construct taller than a line of text, at any depth. */
export function tallBase(expr: unknown): boolean {
  if (Array.isArray(expr)) return expr.some(tallBase);
  if (!expr || typeof expr !== "object") return false;
  const node = expr as { type?: unknown };
  if (typeof node.type === "string" && TALL.has(node.type)) return true;
  return Object.values(expr).some(tallBase);
}

function operand(expr: Expr, path: Path | undefined, min: number, strict = false): ReactNode {
  const lvl = level(expr.type);
  const needs = strict ? lvl <= min : lvl < min;
  const view = <MathExpr expr={expr} path={path} />;
  return needs && expr.type !== "Paren" && expr.type !== "Placeholder" ? (
    <Fenced kind="paren" className={breaks(expr) ? "multiline" : ""}>{view}</Fenced>
  ) : (
    view
  );
}

const BREAKABLE = new Set(["Add", "Sub", "Mul", "InlineDiv"]);

/**
 * Whether an equation break lies on this level of the expression: in a chain of breakable
 * operators that no fence interrupts. A fence around such a chain
 * holds several lines and is centred on the math axis, as the reference application draws it.
 */
export function breaks(expr: Expr): boolean {
  if (!BREAKABLE.has(expr.type)) return false;
  const node = expr as Expr & { split?: boolean; left: Expr; right: Expr };
  return !!node.split || breaks(node.left) || breaks(node.right);
}

function binary(node: Expr, path: Path | undefined, glyph: ReactNode, lvl: number): ReactNode {
  return (
    <>
      {operand(node.left, at(path, 0), lvl)}
      {glyph}
      {operand(node.right, at(path, 1), lvl, true)}
    </>
  );
}

/** Call arguments; `first` is the child index of the first argument. */
function args(list: Node[], path: Path | undefined, first: number): ReactNode {
  return list.map((arg, index) => (
    <Fragment key={index}>
      {index > 0 && <span className="comma">, </span>}
      {arg.type === "InlineDef" ? (
        <N path={at(path, first + index)}>
          <TargetView target={arg.target} path={at(path, first + index, 0)} />
          <Op glyph={GLYPH.local} className="local" />
          <MathExpr expr={arg.value} path={at(path, first + index, 1)} />
        </N>
      ) : (
        <MathExpr expr={arg.expr} path={at(path, first + index)} />
      )}
    </Fragment>
  ));
}

function Fraction({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  return (
    <span className="frac">
      <span className="num">{top}</span>
      <span className="bar-wrap">
        <HRule className="bar" />
      </span>
      <span className="den">{bottom}</span>
    </span>
  );
}

function Radical({ index, children }: { index?: ReactNode; children: ReactNode }) {
  return (
    <span className="root">
      <svg className="radical" width={12} viewBox="0 0 12 100" preserveAspectRatio="none" aria-hidden="true">
        <path
          d="M0.5,58 L3,54 L6,92 L11.5,1"
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {index !== undefined && <span className="root-index sup">{index}</span>}
      <span className="radicand">
        <HRule className="over-rule" />
        {children}
      </span>
    </span>
  );
}

function BigOperator({
  glyph,
  upper,
  lower,
}: {
  glyph: string;
  upper?: ReactNode;
  lower?: ReactNode;
}) {
  return (
    <span className="bigop">
      <span className="bigop-upper">{upper ?? " "}</span>
      <span className="bigop-glyph">{glyph}</span>
      <span className="bigop-lower">{lower ?? " "}</span>
    </span>
  );
}

function Binder({ node, path }: { node: Expr; path: Path | undefined }) {
  // The variable of a big operator with its bounds: `k = lo` below, `hi` above.
  // A free slot is any expression: drawn as it was typed.
  const free = node.var.type !== "Ident" && node.var.type !== "Placeholder";
  const variable = free ? <MathExpr expr={node.var} path={at(path, 0)} /> : <VarView v={node.var} path={at(path, 0)} />;
  const glyph = node.type === "Sum" ? GLYPH.sum : GLYPH.product;
  return node.bounds ? (
    <BigOperator
      glyph={glyph}
      upper={<MathExpr expr={node.bounds.hi} path={at(path, 2)} />}
      lower={
        <>
          {variable}
          <Op glyph={node.bounds.glyph === "define" ? GLYPH.define : GLYPH.evaluate} />
          <MathExpr expr={node.bounds.lo} path={at(path, 1)} />
        </>
      }
    />
  ) : (
    <BigOperator glyph={glyph} lower={variable} />
  );
}

function body(expr: Expr, path: Path | undefined): ReactNode {
  return <span className="opbody"><MathExpr expr={expr} path={path} /></span>;
}

function Derivative({ node, path, partial }: { node: Expr; path: Path | undefined; partial: boolean }) {
  const d = partial ? <span className="up">{GLYPH.partial}</span> : <Differential />;
  const varNode = node.var_expr ?? node.var;
  const free = varNode.type !== undefined && varNode.type !== "Ident" && varNode.type !== "Placeholder";
  const variable = free ? <MathExpr expr={varNode} path={at(path, 0)} /> : <VarView v={varNode} path={at(path, 0)} />;
  // The order shows twice; only the numerator copy is addressable.
  const order = (addressable: boolean) =>
    node.order ? (
      <span className="sup">
        <MathExpr expr={node.order} path={addressable ? at(path, 1) : undefined} />
      </span>
    ) : null;
  return (
    <>
      <Fraction
        top={
          <>
            {d}
            {order(true)}
          </>
        }
        bottom={
          <>
            {d}
            {variable}
            {order(false)}
          </>
        }
      />
      {body(node.body, at(path, node.order ? 2 : 1))}
    </>
  );
}

export function MathExpr({ expr, path }: { expr: Expr; path?: Path }): ReactNode {
  const breaks = useContext(MathBreaksContext);
  const info = path ? breaks.get(pathKey(path)) : undefined;
  return (
    <>
      {info?.before && <LineBreak />}
      <N path={path} node={expr}>{exprContent(expr, path)}</N>
    </>
  );
}

function exprContent(expr: Expr, path: Path | undefined): ReactNode {
  switch (expr.type) {
    case "Num":
      return <span className="num-lit">{expr.text}</span>;
    case "Imag":
      return (
        <span className="num-lit">
          {expr.text}
          <span className="up">{expr.symbol}</span>
        </span>
      );
    case "Str":
      return <StrView text={expr.text} path={path} />;
    case "Placeholder":
      return <Placeholder />;
    case "Ident":
      if (isGivenKeyword(expr.name)) {
        // The keyword that opens a solve block, in the keyword style
        // of the worksheet.
        return <GivenKeyword text={expr.name.segments[0].text} />;
      }
      // A `julia.` name is drawn upright, as the Julia reference it stands for.
      return <NameView name={expr.name} upright={isJuliaName(expr.name)} />;
    case "Paren":
      return (
        <Fenced kind="paren" className={breaks(expr.expr) ? "multiline" : ""}>
          <MathExpr expr={expr.expr} path={at(path, 0)} />
        </Fenced>
      );
    case "InlineDef":
      // A parenthesised local definition: the target, the
      // one glyph of `←` and the value, exactly as a program's local definition draws them.
      return (
        <>
          <TargetView target={expr.target} path={at(path, 0)} />
          <Op glyph={GLYPH.local} className="local" />
          <MathExpr expr={expr.value} path={at(path, 1)} />
        </>
      );

    case "Neg":
      return (
        <>
          <Op glyph={GLYPH.minus} className="prefix" />
          {operand(expr.expr, at(path, 0), 10)}
        </>
      );
    case "Not":
      return (
        <>
          <Op glyph={GLYPH.not} className="prefix" />
          {operand(expr.expr, at(path, 0), 5)}
        </>
      );
    case "Factorial":
      return (
        <>
          {operand(expr.expr, at(path, 0), 13)}
          <span className="postfix">!</span>
        </>
      );
    // the reference application's percent: the value and the sign with no space, the same on screen and in the
    // PDF.
    case "Percent":
      return (
        <>
          {operand(expr.expr, at(path, 0), 13)}
          <span className="postfix">{GLYPH.percent}</span>
        </>
      );
    // The per mille, drawn like the percent.
    case "Permille":
      return (
        <>
          {operand(expr.expr, at(path, 0), 13)}
          <span className="postfix">{GLYPH.permille}</span>
        </>
      );
    case "Transpose":
      return (
        <>
          {operand(expr.expr, at(path, 0), 13)}
          <span className="sup up">T</span>
        </>
      );
    // The real and imaginary part: the black-letter sign and the operand in parentheses.
    case "RealPart":
    case "ImagPart":
      return (
        <>
          <span className="up">{expr.type === "RealPart" ? "ℜ" : "ℑ"}</span>
          <Fenced kind="paren" className="call">
            <MathExpr expr={expr.expr} path={at(path, 0)} />
          </Fenced>
        </>
      );
    case "Conj":
      return (
        <span className="overline">
          <HRule className="over-rule" />
          <MathExpr expr={expr.expr} path={at(path, 0)} />
        </span>
      );
    case "Abs":
    case "Det":
      return <Fenced kind="bar"><MathExpr expr={expr.expr} path={at(path, 0)} /></Fenced>;
    case "Norm":
      return <Fenced kind="dbar"><MathExpr expr={expr.expr} path={at(path, 0)} /></Fenced>;
    case "Vectorize":
      return (
        <span className="vectorize">
          <VectorizeArrow />
          <MathExpr expr={expr.expr} path={at(path, 0)} />
        </span>
      );

    case "Add":
    case "Sub":
    case "Mul":
    case "InlineDiv": {
      const lvl = level(expr.type);
      const glyph = <Op glyph={BINARY_GLYPH[expr.type]} className={expr.type === "Mul" ? "times" : "binary"} />;
      return (
        <>
          {operand(expr.left, at(path, 0), lvl)}
          {/* An equation break: a forced line break before the
              operator, so the operator starts the continuation line, which begins at the left edge
              of the innermost fence (or of the region), as in the reference application. */}
          {expr.split && <LineBreak />}
          {glyph}
          {operand(expr.right, at(path, 1), lvl, true)}
        </>
      );
    }
    case "Cross":
      return binary(expr, path, <Op glyph={GLYPH.cross} className="binary" />, 8);
    // The polar form: both operands are products, the sign sits tight between them.
    case "Polar":
      return (
        <>
          {operand(expr.left, at(path, 0), 8)}
          <Op glyph="∠" />
          {operand(expr.right, at(path, 1), 8)}
        </>
      );
    // The convolutions, spaced like ×.
    case "Conv":
    case "CircConv":
      return binary(expr, path, <Op glyph={expr.type === "Conv" ? "∗" : "⊛"} className="binary" />, 8);
    case "Juxt":
      return (
        <>
          {operand(expr.left, at(path, 0), 8)}
          <span className="juxt" />
          {operand(expr.right, at(path, 1), 8, true)}
        </>
      );
    case "Div":
      return (
        <Fraction
          top={<MathExpr expr={expr.left} path={at(path, 0)} />}
          bottom={<MathExpr expr={expr.right} path={at(path, 1)} />}
        />
      );
    case "Pow": {
      const base = operand(expr.left, at(path, 0), 13);
      const exponent = <span className="sup"><MathExpr expr={expr.right} path={at(path, 1)} /></span>;
      // A tall base (a fraction in parentheses, a matrix): the exponent at its top right.
      return tallBase(expr.left) ? <span className="pow tall">{base}{exponent}</span> : <>{base}{exponent}</>;
    }
    case "Eq":
      return binary(expr, path, <BooleanEquals />, 6);
    case "Ne":
    case "Lt":
    case "Gt":
    case "Le":
    case "Ge":
    case "In":
      return binary(expr, path, <Op glyph={BINARY_GLYPH[expr.type]} className="rel" />, 6);
    case "And":
      return binary(expr, path, <Op glyph={GLYPH.and} className="binary" />, 4);
    case "Or":
      return binary(expr, path, <Op glyph={GLYPH.or} className="binary" />, 3);
    case "Xor":
      return binary(expr, path, <Op glyph={GLYPH.xor} className="binary" />, 3);
    case "Gap":
      return binary(expr, path, <Op glyph={GLYPH.gap} className="gap" />, 3);

    case "Root":
      return (
        <Radical index={expr.index ? <MathExpr expr={expr.index} path={at(path, 0)} /> : undefined}>
          <MathExpr expr={expr.radicand} path={at(path, expr.index ? 1 : 0)} />
        </Radical>
      );
    case "Call": {
      const callee: Expr = expr.callee;
      const head =
        callee.type === "Ident" ? (
          <N path={at(path, 0)} node={callee}>
            <NameView name={callee.name} upright={isFunctionLike(callee.name)} callee />
          </N>
        ) : (
          operand(callee, at(path, 0), 13)
        );
      return (
        <>
          {head}
          <Fenced kind="paren" className="call">{args(expr.args, path, 1)}</Fenced>
        </>
      );
    }
    case "JuliaCall":
      return (
        <>
          <span className="id up">{expr.package}</span>
          <span className="op">{expr.package === "julia" ? "." : "::"}</span>
          {expr.package === "julia" && typeof expr.name === "string" && !expr.name.includes(".") ? (
            <span className="name" data-name={expr.name}>
              <span className="id up">{expr.name}</span>
            </span>
          ) : (
            <span className="id up">{expr.name}</span>
          )}
          {/* `julia.k` with no parentheses: a Julia value or a registered function. */}
          {!expr.bare && <Fenced kind="paren" className="call">{args(expr.args, path, 0)}</Fenced>}
        </>
      );
    case "Index": {
      // A name that already carries a literal subscript draws its index one level lower.
      const nested = expr.base.type === "Ident" && expr.base.name.segments.some((segment: { subscript: boolean }) => segment.subscript);
      return (
        <>
          {operand(expr.base, at(path, 0), 13)}
          <span className={`sub idx${nested ? " nested" : ""}`}>
            {expr.indices.map((index: Expr, i: number) => (
              <Fragment key={i}>
                {i > 0 && <span className="comma">, </span>}
                <MathExpr expr={index} path={at(path, i + 1)} />
              </Fragment>
            ))}
          </span>
        </>
      );
    }
    case "Column":
    case "Row": {
      const [open, close] = expr.type === "Column" ? ["⟨", "⟩"] : ["⟪", "⟫"];
      return (
        <>
          {operand(expr.base, at(path, 0), 13)}
          <span className="sup">
            <span className="up">{open}</span>
            <MathExpr expr={expr.index} path={at(path, 1)} />
            <span className="up">{close}</span>
          </span>
        </>
      );
    }
    case "PrimeDeriv":
      return (
        <>
          <MathExpr expr={expr.function} path={at(path, 0)} />
          <span className="prime">{GLYPH.prime.repeat(expr.order)}</span>
        </>
      );
    case "Matrix":
      return <MatrixView rows={expr.rows} cols={expr.cols} cells={expr.cells} path={path} />;
    case "EllipsisCell":
      return <EllipsisCellView form={expr.form} />;
    case "Range":
      return (
        <>
          <MathExpr expr={expr.first} path={at(path, 0)} />
          {expr.second && (
            <>
              <span className="comma">, </span>
              <MathExpr expr={expr.second} path={at(path, 1)} />
            </>
          )}
          <Op glyph={GLYPH.range} className="range" />
          <MathExpr expr={expr.last} path={at(path, expr.second ? 2 : 1)} />
        </>
      );
    case "Sum":
    case "Prod":
      return (
        <>
          <Binder node={expr} path={path} />
          {body(expr.body, at(path, expr.bounds ? 3 : 1))}
        </>
      );
    case "Integral": {
      const b = expr.bounds ? 2 : expr.domain ? 1 : 0;
      return (
        <>
          <span className="integral">
            <span className="int-glyph">{GLYPH.integral}</span>
            {expr.bounds ? (
              <span className="int-bounds">
                <span className="int-hi"><MathExpr expr={expr.bounds.hi} path={at(path, 1)} /></span>
                <span className="int-lo"><MathExpr expr={expr.bounds.lo} path={at(path, 0)} /></span>
              </span>
            ) : expr.domain ? (
              <span className="int-bounds">
                <span className="int-hi" aria-hidden="true" />
                <span className="int-lo"><MathExpr expr={expr.domain} path={at(path, 0)} /></span>
              </span>
            ) : null}
          </span>
          {body(expr.body, at(path, b))}
          <span className="differential">
            <Differential />
            <VarView v={expr.var} path={at(path, b + 1)} />
          </span>
        </>
      );
    }
    case "Deriv":
      return <Derivative node={expr} path={path} partial={false} />;
    case "Partial":
      return <Derivative node={expr} path={path} partial />;
    // The gradient: ∇ with its variables as the subscript, then the body.
    case "Gradient":
      return (
        <>
          <span className="up">∇</span>
          <span className="sub">
            {(expr.vars as Expr[]).map((v, i) => (
              <span key={i}>
                {i > 0 && <span className="op">,</span>}
                <VarView v={v} path={at(path, i)} />
              </span>
            ))}
          </span>
          {body(expr.body, at(path, expr.vars.length))}
        </>
      );
    case "Limit":
      return (
        <>
          <span className="limit">
            <span className="limit-word up">lim</span>
            <span className="limit-under">
              <VarView v={expr.var} path={at(path, 0)} />
              <Op glyph="→" className="binary" />
              <MathExpr expr={expr.target} path={at(path, 1)} />
              {expr.side === "right" && <span className="sup">+</span>}
              {expr.side === "left" && <span className="sup">{GLYPH.minus}</span>}
            </span>
          </span>
          {body(expr.body, at(path, 2))}
        </>
      );
    case "Program":
      return <ProgramView body={expr.body} path={path} />;
    default:
      return <UnknownNode type={expr.type} where="expression" />;
  }
}

/** A name that is a function head reads upright (`sin`, `rows`); one letter stays italic. */
/** The solve-block keyword `Given` (any case), drawn in the keyword style instead of as a variable. */
function GivenKeyword({ text }: { text: string }) {
  const paint = useNameStyle("kw");
  return (
    <span className="name kw" data-name="Given" data-label={paint.label ?? undefined} style={paint.style}>
      {text}
    </span>
  );
}

/** The solve-block keyword `Given` (any case), drawn upright and bold instead of as a variable. */
export function isGivenKeyword(name: Name): boolean {
  return name.segments.length === 1 && !name.segments[0].subscript && name.segments[0].text.toLowerCase() === "given" && !name.label;
}

/** Whether a name is a `julia.` reference. */
function isJuliaName(name: Name): boolean {
  return name.segments.length === 1 && name.segments[0].text.startsWith("julia.");
}

function isFunctionLike(name: Name): boolean {
  const text = name.segments.map((segment) => segment.text).join("");
  return text.length > 1 && !GREEK.test(text) && /^[A-Za-z][A-Za-z0-9.]*$/.test(text);
}

/**
 * A display-only ellipsis cell of a matrix: the glyph itself, and
 * nothing else — no box and no placeholder. Screen and print draw the same glyph.
 */
function EllipsisCellView({ form }: { form: string }) {
  const glyph = ELLIPSIS_GLYPH[form] ?? ELLIPSIS_GLYPH.horizontal;
  return (
    <span className="ellipsis-cell" data-form={form} aria-label="ellipsis cell">
      {glyph}
    </span>
  );
}

function MatrixView({ rows, cols, cells, path }: { rows: number; cols: number; cells: Expr[]; path: Path | undefined }) {
  return (
    <span className="matrix">
      <FenceSide kind="bracket" side="left" />
      <span className="matrix-grid" style={{ gridTemplateColumns: `repeat(${cols}, auto)` }}>
        {Array.from({ length: rows * cols }, (_, i) => (
          <span key={i} className="cell" data-cell-path={path ? pathKey([...path, i]) : undefined}>
            {cells[i] ? <MathExpr expr={cells[i]} path={at(path, i)} /> : null}
          </span>
        ))}
      </span>
      <FenceSide kind="bracket" side="right" />
    </span>
  );
}

/**
 * An input table: a matrix grid without brackets, a rule under the
 * names and under the units, the units in the unit colour. It keeps the matrix's classes so the
 * editor's cell hits, selection and drags work on it as on a matrix.
 */
function TableView({ units, grid, path }: { units: boolean; grid: Expr; path: Path | undefined }) {
  const { rows, cols, cells } = grid as unknown as { rows: number; cols: number; cells: Expr[] };
  const role = (row: number) => (row === 0 ? " table-name" : units && row === 1 ? " table-unit" : "");
  return (
    <span className={`matrix table${units ? " with-units" : ""}`} data-path={path ? pathKey(path) : undefined}>
      <span className="matrix-grid" style={{ gridTemplateColumns: `repeat(${cols}, auto)` }}>
        {Array.from({ length: rows * cols }, (_, i) => (
          <span key={i} className={`cell${role(Math.floor(i / cols))}`} data-cell-path={path ? pathKey([...path, i]) : undefined}>
            {cells[i] ? <MathExpr expr={cells[i]} path={at(path, i)} /> : null}
          </span>
        ))}
      </span>
    </span>
  );
}

// ---- targets ----------------------------------------------------------------------------

/**
 * A target in its wire shape (left of `:=`, `≡`, `←`). The editor's tree holds targets as
 * expressions; those are drawn by `MathExpr` (the same look).
 */
export function TargetView({ target, path }: { target: Target; path?: Path }): ReactNode {
  switch (target.type) {
    case "Index": {
      const nested = target.base.type === "Ident" && target.base.name.segments.some((segment: { subscript: boolean }) => segment.subscript);
      return (
        <N path={path} node={target}>
          <TargetView target={target.base} path={at(path, 0)} />
          <span className={`sub idx${nested ? " nested" : ""}`}>
            {target.indices.map((index: Expr, i: number) => (
              <Fragment key={i}>
                {i > 0 && <span className="comma">, </span>}
                <MathExpr expr={index} path={at(path, i + 1)} />
              </Fragment>
            ))}
          </span>
        </N>
      );
    }
    case "Column":
    case "Row": {
      const [open, close] = target.type === "Column" ? ["⟨", "⟩"] : ["⟪", "⟫"];
      return (
        <N path={path} node={target}>
          <TargetView target={target.base} path={at(path, 0)} />
          <span className="sup">
            <span className="up">{open}</span>
            <MathExpr expr={target.index} path={at(path, 1)} />
            <span className="up">{close}</span>
          </span>
        </N>
      );
    }
    case "Paren":
      if (!target.target) break;
      return (
        <N path={path} node={target}>
          <Fenced kind="paren"><TargetView target={target.target} path={at(path, 0)} /></Fenced>
        </N>
      );
    case "Transpose":
      // In the editing form the target is the transpose of an expression.
      if (!target.target) break;
      return (
        <N path={path} node={target}>
          <TargetView target={target.target} path={at(path, 0)} />
          <span className="sup up">T</span>
        </N>
      );
    case "Destructure":
      return (
        <N path={path} node={target}>
          <span className="matrix">
            <FenceSide kind="bracket" side="left" />
            <span className="matrix-grid" style={{ gridTemplateColumns: `repeat(${target.cols}, auto)` }}>
              {target.cells.map((cell: Target, i: number) => (
                <span key={i} className="cell" data-cell-path={path ? pathKey([...path, i]) : undefined}><TargetView target={cell} path={at(path, i)} /></span>
              ))}
            </span>
            <FenceSide kind="bracket" side="right" />
          </span>
        </N>
      );
    // A left side that cannot be defined: drawn as the expression it is.
    case "Invalid":
      return <MathExpr expr={target.expr} path={at(path, 0)} />;
    case "FunctionHead":
      return (
        <N path={path} node={target}>
          <N path={at(path, 0)} node={target.name}>
            <NameView name={target.name.name} upright={isFunctionLike(target.name.name)} callee />
          </N>
          <Fenced kind="paren" className="call">
            {target.params.map((param: { name: Name }, i: number) => (
              <Fragment key={i}>
                {i > 0 && <span className="comma">, </span>}
                <N path={at(path, i + 1)} node={param}>
                  <NameView name={param.name} />
                </N>
              </Fragment>
            ))}
          </Fenced>
        </N>
      );
  }
  return <MathExpr expr={target} path={path} />;
}

// ---- programs ---------------------------------------------------------------------------

function Keyword({ children }: { children: ReactNode }) {
  return <span className="kw">{children}</span>;
}

/** Program lines; `first` is the child index of the first line. */
function Lines({ lines, path, first = 0 }: { lines: Stmt[]; path: Path | undefined; first?: number }) {
  return (
    <span className="prog-lines">
      {lines.map((stmt, i) => (
        <StmtView key={i} stmt={stmt} path={at(path, first + i)} />
      ))}
    </span>
  );
}

/** A program block: a vertical bar on the left and one line per statement. */
function ProgramView({ body: lines, path }: { body: Stmt[]; path: Path | undefined }) {
  return (
    <span className="prog">
      <VRule className="prog-bar" />
      <Lines lines={lines} path={path} />
    </span>
  );
}

function Indented({ lines, path, first }: { lines: Stmt[]; path: Path | undefined; first: number }) {
  return (
    <span className="prog-body">
      <VRule className="prog-bar" />
      <Lines lines={lines} path={path} first={first} />
    </span>
  );
}

const dataPath = (path: Path | undefined) => (path ? { "data-path": pathKey(path) } : {});

function StmtView({ stmt, path }: { stmt: Stmt; path: Path | undefined }): ReactNode {
  const attrs = dataPath(path);
  switch (stmt.type) {
    case "LocalDef":
      return (
        <span className="line" {...attrs}>
          <TargetView target={stmt.target} path={at(path, 0)} />
          <Op glyph={GLYPH.local} className="local" />
          <MathExpr expr={stmt.rhs} path={at(path, 1)} />
        </span>
      );
    case "If":
      return (
        <span className="block" {...attrs}>
          {stmt.branches.map(
            (branch: { kind: string; cond: Expr; body: Stmt[] }, i: number) => {
              const b = at(path, i);
              return (
                <span key={i} className="branch" {...dataPath(b)}>
                  <span className="line head">
                    <Keyword>{branch.kind === "if" ? "if" : branch.kind === "elseif" ? "else if" : "also if"}</Keyword>
                    <MathExpr expr={branch.cond} path={at(b, 0)} />
                  </span>
                  <Indented lines={branch.body} path={b} first={1} />
                </span>
              );
            },
          )}
          {stmt.else && (
            <>
              <span className="line head"><Keyword>else</Keyword></span>
              <Indented lines={stmt.else} path={path} first={stmt.branches.length} />
            </>
          )}
        </span>
      );
    case "For":
      return (
        <span className="block" {...attrs}>
          <span className="line head">
            <Keyword>for</Keyword>
            <VarView v={stmt.var} path={at(path, 0)} />
            <Op glyph={GLYPH.element} className="rel" />
            <MathExpr expr={stmt.source} path={at(path, 1)} />
          </span>
          <Indented lines={stmt.body} path={path} first={2} />
        </span>
      );
    case "While":
      return (
        <span className="block" {...attrs}>
          <span className="line head">
            <Keyword>while</Keyword>
            <MathExpr expr={stmt.cond} path={at(path, 0)} />
          </span>
          <Indented lines={stmt.body} path={path} first={1} />
        </span>
      );
    case "Try":
      return (
        <span className="block" {...attrs}>
          <span className="line head"><Keyword>try</Keyword></span>
          <Indented lines={stmt.body} path={path} first={0} />
          <span className="line head">
            <Keyword>on error</Keyword>
          </span>
          <Indented lines={stmt.handler} path={path} first={stmt.body.length} />
        </span>
      );
    case "Break":
      return <span className="line" {...attrs}><Keyword>break</Keyword></span>;
    case "Continue":
      return <span className="line" {...attrs}><Keyword>continue</Keyword></span>;
    case "Return":
      return (
        <span className="line" {...attrs}>
          <Keyword>return</Keyword>
          <MathExpr expr={stmt.expr} path={at(path, 0)} />
        </span>
      );
    case "ExprStmt":
      return (
        <span className="line" {...attrs}>
          <MathExpr expr={stmt.expr} path={at(path, 0)} />
        </span>
      );
    default:
      return <UnknownNode type={stmt.type} where="program line" line />;
  }
}

// ---- statements -------------------------------------------------------------------------

/** The keywords of a symbolic evaluation, shown above the arrow as the reference application does. */
function SymbolicArrow({ keywords, path, first }: { keywords: Node[]; path: Path | undefined; first: number }) {
  if (!keywords || keywords.length === 0) {
    return <Op glyph={GLYPH.symbolic} className="symbolic" />;
  }
  return (
    <span className="op symbolic keyed">
      <span className="keywords">
        {keywords.map((group, i) => {
          const g = at(path, first + i);
          return (
            // One keyword line per group, top to bottom: no comma between groups.
            <span key={i} className="keyword-line">
              <N path={g}>
                <N path={at(g, 0)}>
                  {group.keyword.type === "Placeholder" ? (
                    <Placeholder />
                  ) : (
                    <span className="up">{nameText(group.keyword.name)}</span>
                  )}
                </N>
                {group.args.map((arg: Expr, j: number) => (
                  <Fragment key={j}>
                    <span className="comma">, </span>
                    <MathExpr expr={arg} path={at(g, j + 1)} />
                  </Fragment>
                ))}
              </N>
            </span>
          );
        })}
      </span>
      {/* The arrow is as long as the keywords above it: a shaft that stretches and a fixed head. */}
      <span className="arrow" role="img" aria-label={GLYPH.symbolic}>
        {/* The glyph as text: the region's text and a copy read an arrow, the drawing shows it. */}
        <span hidden>{GLYPH.symbolic}</span>
        <span className="arrow-body">
          <span className="shaft" />
          <svg className="head" viewBox="0 0 6 8" aria-hidden="true">
            <path d="M0.6 0.6 L5.2 4 L0.6 7.4" fill="none" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
    </span>
  );
}

/** What follows `=` or `→`: the value, a unit override or the symbolic result. */
export type ResultSlot = ReactNode;

/**
 * A math region's statement. `result` is drawn after the evaluation operator (`=` or
 * `→`); a statement without an evaluation operator ignores it. With `path` (normally `[]`)
 * every node is addressable (see the header).
 */
export function MathStatement({
  statement,
  result,
  path,
  unitSlot = false,
  breaks,
}: {
  statement: Stmt;
  result?: ResultSlot;
  path?: Path;
  /** Draw the unit override after the result (editing: the unit is then addressable). */
  unitSlot?: boolean;
  /** Presentation-only line breaks of the statement. */
  breaks?: readonly MathBreak[];
}) {
  return (
    <MathBreaksContext.Provider value={breakMap(breaks)}>
      <N path={path} node={statement}>{statementContent(statement, result, path, unitSlot)}</N>
    </MathBreaksContext.Provider>
  );
}

/**
 * The unit override of an evaluation. It is a **unit context**: every plain name in
 * it is a unit, so the text stays plain and the names draw as units.
 */
function UnitSlot({ unit, path }: { unit: Expr | null | undefined; path: Path | undefined }) {
  const outer = useContext(MathNamesContext);
  const names = useMemo(() => ({ units: outer.units, unitContext: true }), [outer.units]);
  if (!unit) return null;
  return (
    <span className="unit-slot">
      <MathNamesContext.Provider value={names}>
        <MathExpr expr={unit} path={path} />
      </MathNamesContext.Provider>
    </span>
  );
}

function statementContent(statement: Stmt, result: ResultSlot, path: Path | undefined, unitSlot: boolean): ReactNode {
  switch (statement.type) {
    case "Define": {
      const tail = statement.tail as Node | null;
      return (
        <>
          <TargetView target={statement.target} path={at(path, 0)} />
          <Op glyph={GLYPH.define} className="define" />
          <MathExpr expr={statement.rhs} path={at(path, 1)} />
          {tail?.type === "Eval" && (
            <>
              <Op glyph={GLYPH.evaluate} className="evaluate" />
              {result}
              {unitSlot && <UnitSlot unit={tail.unit} path={at(path, 2)} />}
            </>
          )}
          {tail?.type === "Sym" && (
            <>
              <SymbolicArrow keywords={tail.keywords} path={path} first={2} />
              {result}
            </>
          )}
        </>
      );
    }
    case "GlobalDefine":
      return (
        <>
          <TargetView target={statement.target} path={at(path, 0)} />
          <Op glyph={GLYPH.globalDefine} className="global" />
          <MathExpr expr={statement.rhs} path={at(path, 1)} />
        </>
      );
    case "Evaluate":
      return (
        <>
          <MathExpr expr={statement.expr} path={at(path, 0)} />
          <Op glyph={GLYPH.evaluate} className="evaluate" />
          {result}
          {unitSlot && <UnitSlot unit={statement.unit} path={at(path, 1)} />}
        </>
      );
    case "Symbolic":
      return (
        <>
          <MathExpr expr={statement.expr} path={at(path, 0)} />
          <SymbolicArrow keywords={statement.keywords} path={path} first={1} />
          {result}
        </>
      );
    case "ExprRegion":
      return <MathExpr expr={statement.expr} path={at(path, 0)} />;
    case "Table":
      return <TableView units={statement.units} grid={statement.grid} path={at(path, 0)} />;
    default:
      return <UnknownNode type={statement.type} where="statement" />;
  }
}

/** Whether a statement shows a result after an operator (`=` or `→`). */
export function showsResult(statement: unknown): boolean {
  if (!isNode(statement)) return false;
  switch (statement.type) {
    case "Evaluate":
    case "Symbolic":
      return true;
    case "Define":
      return isNode(statement.tail);
    default:
      return false;
  }
}

/** The unit override of an evaluation (`e = … unit`), when there is one. */
export function unitOverride(statement: unknown): Expr | null {
  if (!isNode(statement)) return null;
  const unit =
    statement.type === "Evaluate"
      ? statement.unit
      : statement.type === "Define" && isNode(statement.tail) && statement.tail.type === "Eval"
        ? statement.tail.unit
        : null;
  // The empty slot of the editor is no override.
  return isNode(unit) && unit.type !== "Placeholder" ? (unit as Expr) : null;
}
