import { describe, expect, it } from "vitest";
import type { RegionEntry, ViewRegion } from "../equavelaApi";
import { reuseEntries, reuseRegions, sameValue } from "./reuse";

const math = (id: string, text: string, y = 72): ViewRegion =>
  ({ id, kind: "math", page: 1, x: 54, y, enabled: true, text, statement: { type: "Evaluate", expr: { name: text } } }) as unknown as ViewRegion;
const entry = (id: string, value: number): RegionEntry =>
  ({ key: { document: "d", region_id: id, instance: 0 }, state: "value", value: { kind: "real", value } }) as unknown as RegionEntry;

describe("sameValue", () => {
  it("compares JSON-like values structurally", () => {
    expect(sameValue({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(true);
    expect(sameValue({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });
});

describe("reuseRegions", () => {
  it("keeps the previous object of every region that did not change", () => {
    const before = [math("a", "x"), math("b", "y"), math("c", "z")];
    const after = [math("a", "x"), math("b", "y2"), math("c", "z")];
    const out = reuseRegions(before, after);
    expect(out[0]).toBe(before[0]);
    expect(out[1]).toBe(after[1]);
    expect(out[2]).toBe(before[2]);
  });

  it("returns the previous array when nothing changed", () => {
    const before = [math("a", "x"), math("b", "y")];
    expect(reuseRegions(before, [math("a", "x"), math("b", "y")])).toBe(before);
  });

  it("follows added, removed and reordered regions", () => {
    const before = [math("a", "x"), math("b", "y")];
    const out = reuseRegions(before, [math("b", "y"), math("c", "w")]);
    expect(out).not.toBe(before);
    expect(out[0]).toBe(before[1]);
    expect(out.map((r) => r.id)).toEqual(["b", "c"]);
  });
});

describe("reuseEntries", () => {
  it("keeps unchanged results by key", () => {
    const before = [entry("a", 1), entry("b", 2)];
    const out = reuseEntries(before, [entry("a", 1), entry("b", 3)]);
    expect(out[0]).toBe(before[0]);
    expect(out[1]).not.toBe(before[1]);
  });
});
