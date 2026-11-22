// A small printer and parser of linear math for the browser mock.
// It covers numbers, names with an explicit label,
// `+ - · / ^`, parentheses, calls and `:=`, which is enough to exercise the
// clipboard in the browser; anything else is refused with the same error shape as the real commands.

type Node = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const refuse = (message: string) => ({ kind: "parse", message });

/** The labels the mock writes and reads: a unit carries its label. */
const LABELS: readonly string[] = ["var", "fn", "unit", "const", "sys", "kw", "julia"];

const ident = (text: string, label: string | null = null): Node => ({
  type: "Ident",
  name: { segments: [{ text, subscript: false }], label },
});

/** The printed name with its explicit label suffix (`m@unit`, D3). */
function printName(name: Node): string {
  const text = name.segments.map((s: { text: string }) => s.text).join(".");
  return name.label ? `${text}@${name.label}` : text;
}

function printExpr(e: Node): string {
  switch (e.type) {
    case "Num":
      return e.text;
    case "Ident":
      return printName(e.name);
    case "Placeholder":
      return "□";
    case "Add":
      return `${printExpr(e.left)} + ${printExpr(e.right)}`;
    case "Sub":
      return `${printExpr(e.left)} - ${printExpr(e.right)}`;
    case "Mul":
      return `${printExpr(e.left)}·${printExpr(e.right)}`;
    case "Juxt":
      return `${printExpr(e.left)} ${printExpr(e.right)}`;
    case "Div":
    case "InlineDiv":
      return `${printExpr(e.left)}/${printExpr(e.right)}`;
    case "Pow":
      return `${printExpr(e.left)}^${printExpr(e.right)}`;
    case "Neg":
      return `-${printExpr(e.expr)}`;
    case "Paren":
      return `(${printExpr(e.expr)})`;
    case "Call":
      return `${printExpr(e.callee)}(${e.args.map((a: Node) => printExpr(a.type === "Expr" ? a.expr : a)).join(", ")})`;
    default:
      throw refuse(`the mock cannot print ${e.type}`);
  }
}

export function mockPrint(statement: Node): string {
  switch (statement.type) {
    case "ExprRegion":
      return printExpr(statement.expr);
    case "Evaluate":
      return `${printExpr(statement.expr)} =`;
    case "Define":
      return `${printExpr(statement.target)} := ${printExpr(statement.rhs)}`;
    default:
      throw refuse(`the mock cannot print ${statement.type}`);
  }
}

type Token = { kind: "num" | "id" | "op"; text: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-zα-ωΑ-Ω_][\w.]*(?:@[a-z]+)?)|(:=|[-+*/^()·,=]))/y;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) {
      if (text.slice(at).trim() === "") break;
      throw refuse(`unexpected \`${text.slice(at).trim()[0]}\``);
    }
    at = re.lastIndex;
    tokens.push(m[1] ? { kind: "num", text: m[1] } : m[2] ? { kind: "id", text: m[2] } : { kind: "op", text: m[3] });
  }
  return tokens;
}

/** The token parser of the mock: expressions, `:=`, and the end-of-input check. */
function parser(text: string) {
  const tokens = tokenize(text.trim());
  let i = 0;
  const peek = () => tokens[i];
  const take = (op: string) => {
    if (peek()?.kind === "op" && peek().text === op) {
      i++;
      return true;
    }
    return false;
  };
  const atom = (): Node => {
    const t = tokens[i++];
    if (!t) throw refuse("unexpected end of input");
    if (t.kind === "num") return { type: "Num", text: t.text };
    if (t.kind === "id") {
      // An explicit label after `@` is part of the name's identity: `m@unit`.
      const [text, label] = t.text.split("@");
      if (label !== undefined && !LABELS.includes(label)) throw refuse(`unknown label \`@${label}\``);
      if (take("(")) {
        const args: Node[] = [];
        if (!take(")")) {
          do args.push({ type: "Expr", expr: expr() });
          while (take(","));
          if (!take(")")) throw refuse("expected `)`");
        }
        return { type: "Call", callee: ident(text, label ?? null), args };
      }
      return ident(text, label ?? null);
    }
    if (t.text === "(") {
      const inner = expr();
      if (!take(")")) throw refuse("expected `)`");
      return { type: "Paren", expr: inner };
    }
    throw refuse(`unexpected \`${t.text}\``);
  };
  const power = (): Node => {
    const base = atom();
    return take("^") ? { type: "Pow", left: base, right: unary() } : base;
  };
  const unary = (): Node => (take("-") ? { type: "Neg", expr: unary() } : power());
  const term = (): Node => {
    let left = unary();
    for (;;) {
      if (take("*") || take("·")) left = { type: "Mul", left, right: unary(), split: false };
      else if (take("/")) left = { type: "InlineDiv", left, right: unary(), split: false };
      else if (peek() && (peek().kind === "id" || peek().kind === "num" || (peek().kind === "op" && peek().text === "(")))
        left = { type: "Juxt", left, right: unary() };
      else return left;
    }
  };
  const expr = (): Node => {
    let left = term();
    for (;;) {
      if (take("+")) left = { type: "Add", left, right: term(), split: false };
      else if (take("-")) left = { type: "Sub", left, right: term(), split: false };
      else return left;
    }
  };
  /** Fails unless every token was consumed. */
  const end = () => {
    if (i < tokens.length) throw refuse(`unexpected \`${tokens[i].text}\``);
  };
  return { expr, take, end };
}

export function mockParse(text: string): Node {
  const p = parser(text);
  const first = p.expr();
  let statement: Node;
  if (p.take(":=")) {
    if (first.type !== "Ident") throw refuse("the left side of := must be a name");
    statement = { type: "Define", target: { type: "Ident", name: first.name }, rhs: p.expr(), tail: null };
  } else statement = { type: "ExprRegion", expr: first };
  p.end();
  return statement;
}

/** The mock of `print_math_args`: the arguments of a run as `a, b`. */
export function mockPrintArgs(args: Node[]): string {
  return args.map((arg) => printExpr(arg.type === "Expr" ? arg.expr : arg)).join(", ");
}

/** The mock of `parse_math_args`: a comma-separated list of call arguments. */
export function mockParseArgs(text: string): Node[] {
  const p = parser(text);
  const args: Node[] = [];
  for (;;) {
    args.push({ type: "Expr", expr: p.expr() });
    if (!p.take(",")) break;
  }
  p.end();
  return args;
}
