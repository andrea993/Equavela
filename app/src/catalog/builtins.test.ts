import { describe, expect, it } from "vitest";
import { BUILTIN_ENTRIES, builtinEntry, searchBuiltins } from "./builtins";

describe("built-in catalogue", () => {
  it("has a complete, well-formed entry per built-in", () => {
    expect(BUILTIN_ENTRIES.length).toBeGreaterThan(100);
    for (const entry of BUILTIN_ENTRIES) {
      expect(entry.signature.startsWith(entry.name)).toBe(true);
      expect(entry.description.length).toBeGreaterThan(3);
      expect(entry.category.length).toBeGreaterThan(0);
    }
    expect(new Set(BUILTIN_ENTRIES.map((e) => e.name)).size).toBe(BUILTIN_ENTRIES.length);
  });

  it("looks entries up by name", () => {
    expect(builtinEntry("stack")?.signature).toBe("stack(A, B, C, …)");
    expect(builtinEntry("nope")).toBeUndefined();
  });

  it("searches name first, then signature, category and description", () => {
    const names = searchBuiltins("stac").map((e) => e.name);
    expect(names[0]).toBe("stack");
    expect(searchBuiltins("hyperbolic").length).toBeGreaterThan(5);
    expect(searchBuiltins("   ")).toHaveLength(BUILTIN_ENTRIES.length);
    expect(searchBuiltins("zzzzzz")).toEqual([]);
  });
});
