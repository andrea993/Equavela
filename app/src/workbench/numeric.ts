// The numeric choices of a math region: the algorithm and stopping rules of a solving call
// (`find`, `minerr`, `minimize`, `maximize`) and the method of the numeric derivatives written in
// the region. They are the region's `numeric` mapping, which keeps only the keys that differ from
// the defaults.

export type NumericOptions = Record<string, string>;
export type SolvingFunction = "find" | "minerr" | "minimize" | "maximize";

type Json = { [key: string]: unknown };

const SOLVING: readonly SolvingFunction[] = ["find", "minerr", "minimize", "maximize"];

export const FIND_ALGORITHMS = ["auto", "levenberg-marquardt", "trust-region", "newton"] as const;
export const OPTIMIZE_ALGORITHMS = ["auto", "slsqp", "mma", "ccsaq", "lbfgs", "cobyla", "nelder-mead", "penalty"] as const;

export function algorithmsOf(fn: SolvingFunction): readonly string[] {
  return fn === "find" || fn === "minerr" ? FIND_ALGORITHMS : OPTIMIZE_ALGORITHMS;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}

function nameText(name: unknown): string {
  if (!isObject(name) || !Array.isArray(name.segments)) return "";
  return name.segments.map((segment) => (isObject(segment) ? String(segment.text ?? "") : "")).join("");
}

/** The expression a statement evaluates or defines, where a solving call stands. */
function mainExpression(statement: unknown): unknown {
  if (!isObject(statement)) return null;
  switch (statement.type) {
    case "Evaluate":
    case "Symbolic":
    case "ExprRegion":
      return statement.expr;
    case "Define":
    case "GlobalDefine":
      return statement.rhs;
    default:
      return null;
  }
}

/** The solving function the region calls (`Find(x) =`, `s := Minimize(f, x)`), if any. */
export function solvingFunction(statement: unknown): SolvingFunction | null {
  const expr = mainExpression(statement);
  if (!isObject(expr) || expr.type !== "Call" || !isObject(expr.callee) || expr.callee.type !== "Ident") return null;
  const name = nameText(expr.callee.name).toLowerCase();
  return (SOLVING as readonly string[]).includes(name) ? (name as SolvingFunction) : null;
}

const DERIVATIVE_NODES = new Set(["Deriv", "Partial", "PrimeDeriv", "Gradient"]);

/** Whether the statement holds a numeric derivative (`ⅆ`, `∂`, `f′`, `∇` or a `Jacob` call). */
export function hasDerivative(statement: unknown): boolean {
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!isObject(node)) return false;
    if (typeof node.type === "string" && DERIVATIVE_NODES.has(node.type)) return true;
    if (node.type === "Call" && isObject(node.callee) && node.callee.type === "Ident" && nameText(node.callee.name) === "Jacob") return true;
    return Object.values(node).some(visit);
  };
  // A symbolic evaluation differentiates exactly: its derivatives are not numeric.
  return isObject(statement) && statement.type !== "Symbolic" && visit(statement);
}

/** The defaults the runtime applies when a key is absent. */
export const NUMERIC_DEFAULTS: Readonly<Record<string, string>> = {
  algorithm: "auto",
  derivatives: "auto",
  "max-evaluations": "10000",
  "x-tolerance": "1e-10",
  "f-tolerance": "1e-12",
};

/** `options` with `key` set to `value`, or removed when `value` is null, empty or the default. */
export function withNumeric(options: NumericOptions | undefined, key: string, value: string | null): NumericOptions | null {
  const next: NumericOptions = { ...(options ?? {}) };
  const text = value?.trim() ?? "";
  if (text === "" || text === NUMERIC_DEFAULTS[key]) delete next[key];
  else next[key] = text;
  if (key === "derivatives" && next.derivatives === undefined) delete next["derivative-tolerance"];
  return Object.keys(next).length === 0 ? null : next;
}

/** Whether a field's text is a valid value of `key`. */
export function validNumeric(key: string, text: string): boolean {
  const value = text.trim();
  if (value === "") return true;
  if (key === "max-evaluations") return /^[0-9]+$/.test(value) && Number(value) > 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}
