// Canned results of the demo worksheet (`demo.eqv`) for the browser mock: what the
// kernel would answer, keyed by region id. Values are in the wire format of
// `the specification`.

import type { KernelValue, RegionState } from "../equavelaApi";

const real = (value: number) => ({ type: "real" as const, value });
const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
const ident = (text: string) => ({ type: "Ident", name: name(text) });
const num = (text: string) => ({ type: "Num", text });
const call = (fn: string, argument: unknown) => ({
  type: "Call",
  callee: ident(fn),
  args: [{ type: "Expr", expr: argument }],
});
const mul = (left: unknown, right: unknown) => ({ type: "Mul", left, right, split: false });

/** Column-major storage from rows. */
function matrix(rows: number[][]): KernelValue {
  const r = rows.length;
  const c = rows[0].length;
  const values: KernelValue[] = [];
  for (let j = 0; j < c; j++) for (let i = 0; i < r; i++) values.push(real(rows[i][j]));
  return { type: "matrix", rows: r, cols: c, storage: { type: "inline", values } };
}

function identity(n: number): KernelValue {
  return matrix(Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
}

const ok = (value: KernelValue | null, display_unit?: { text: string; divisor: number }): RegionState => ({
  state: "value",
  value,
  ...(display_unit ? { display_unit } : {}),
});

/** d/dx of x^2 sin(x): 2 x sin(x) + x^2 cos(x), as the symbolic engine returns it. */
const derivative = {
  type: "Add",
  split: false,
  left: mul(mul(num("2"), ident("x")), call("sin", ident("x"))),
  right: mul({ type: "Pow", left: ident("x"), right: num("2") }, call("cos", ident("x"))),
};

export function cannedState(
  regionId: string,
  root: string,
): RegionState | null {
  switch (regionId) {
    case "m4":
      return ok(
        {
          type: "quantity",
          magnitude: real(18375),
          dimension: [
            { base: "length", power: [2, 1] },
            { base: "mass", power: [1, 1] },
            { base: "time", power: [-2, 1] },
          ],
        },
        { text: "kN·m", divisor: 1000 },
      );
    case "m6":
      return ok(matrix([[1, 2, 3], [4, 5, 6], [7, 8, 10]]));
    case "m7":
      return ok(real(-3));
    case "m10":
      return ok(real(1051.9722));
    case "m12":
      return ok({ type: "symbolic", expr: derivative, text: "2·x·sin(x) + x^2·cos(x)" });
    case "m13":
      return ok(real(1.5497677));
    case "m14":
      return ok(real(1 / 3));
    case "m16":
      return {
        state: "error",
        failure: {
          kind: "evaluation",
          message: "the name `missing` is not defined",
          span: { start: 5, end: 12 },
          blocked_by: null,
          julia_type: null,
        },
      };
    case "m17":
      return {
        state: "error",
        failure: {
          kind: "blocked",
          message: "depends on failed region m16",
          span: null,
          blocked_by: { document: root, region_id: "m16", instance: 0 },
          julia_type: null,
        },
      };
    case "m20":
      return ok({ type: "complex", real: 3, imag: 4 });
    case "m22":
      return ok(identity(15));
    default:
      // Definitions, comments and Julia regions have no displayed value.
      return ok(null);
  }
}
