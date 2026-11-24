import { describe, expect, it } from "vitest";
import { hasDerivative, solvingFunction, validNumeric, withNumeric } from "./numeric";
import { ribbonContext } from "./commandContext";
import type { ViewRegion } from "../equavelaApi";

const ident = (text: string) => ({ type: "Ident", name: { segments: [{ text, subscript: false }], label: null } });
const call = (fn: string, ...args: unknown[]) => ({ type: "Call", callee: ident(fn), args: args.map((expr) => ({ type: "Expr", expr })) });
const math = (id: string, statement: unknown, numeric?: Record<string, string>) =>
  ({ id, page: 1, x: 0, y: 0, enabled: true, kind: "math", text: "", statement, numeric }) as unknown as ViewRegion;

describe("numeric choices", () => {
  it("finds the solving function of a region", () => {
    expect(solvingFunction({ type: "Evaluate", expr: call("Find", ident("x")) })).toBe("find");
    expect(solvingFunction({ type: "Define", target: {}, rhs: call("minimize", ident("f"), ident("x")) })).toBe("minimize");
    expect(solvingFunction({ type: "Evaluate", expr: call("odesolve", ident("y")) })).toBeNull();
    expect(solvingFunction({ type: "Evaluate", expr: ident("x") })).toBeNull();
  });

  it("finds numeric derivatives, not symbolic ones", () => {
    const deriv = { type: "Deriv", var: { name: ident("x").name }, order: null, body: ident("x") };
    expect(hasDerivative({ type: "Evaluate", expr: deriv })).toBe(true);
    expect(hasDerivative({ type: "Evaluate", expr: call("Jacob", ident("F"), ident("x")) })).toBe(true);
    expect(hasDerivative({ type: "Symbolic", expr: deriv, keywords: [] })).toBe(false);
    expect(hasDerivative({ type: "Evaluate", expr: ident("x") })).toBe(false);
  });

  it("keeps only the keys that differ from the defaults", () => {
    expect(withNumeric(undefined, "algorithm", "slsqp")).toEqual({ algorithm: "slsqp" });
    expect(withNumeric({ algorithm: "slsqp" }, "algorithm", "auto")).toBeNull();
    expect(withNumeric({ "max-evaluations": "50" }, "max-evaluations", "")).toBeNull();
    // Going back to automatic derivatives drops the finite-difference tolerance.
    expect(withNumeric({ derivatives: "finite-differences", "derivative-tolerance": "1e-6" }, "derivatives", "auto")).toBeNull();
    expect(validNumeric("max-evaluations", "1.5")).toBe(false);
    expect(validNumeric("x-tolerance", "1e-8")).toBe(true);
    expect(validNumeric("max-time", "-2")).toBe(false);
  });

  it("shows the Solver tab for a selected solving region and the Differentiation tab for derivatives", () => {
    const deriv = { type: "Evaluate", expr: { type: "PrimeDeriv", function: ident("f"), order: 1 } };
    const regions = [math("s", { type: "Evaluate", expr: call("Find", ident("x")) }, { algorithm: "newton" }), math("d", deriv), math("p", { type: "Evaluate", expr: ident("x") })];
    const base = { textEditing: false, mathEditing: false, inMatrix: false, matrixResult: false, regions, plotTraceSelections: {} };
    expect(ribbonContext({ ...base, selection: ["s"] })).toEqual({ kind: "solver", regionId: "s", fn: "find", numeric: { algorithm: "newton" } });
    expect(ribbonContext({ ...base, selection: ["d"] })).toEqual({ kind: "derivative", regionId: "d", numeric: {} });
    expect(ribbonContext({ ...base, selection: ["p"] })).toBeNull();
    // While the region is edited too.
    expect(ribbonContext({ ...base, mathEditing: true, selection: [], mathRegionId: "s" })?.kind).toBe("solver");
  });
});
