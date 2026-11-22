// the specification : the words a `.jl` text tab completes by itself.
import { describe, expect, it } from "vitest";
import { localCompletions, mergeCompletions, opensCompletion, wordBefore } from "./codeCompletion";

describe("local completion", () => {
  it("finds the name being typed, Greek letters included", () => {
    expect(wordBefore("y = σ_ma", 8)).toEqual({ word: "σ_ma", from: 4 });
  });
  it("offers keywords and the file's own names, not the name being typed", () => {
    const text = "function area(b, h)\n    b * h\nend\nar";
    expect(localCompletions(text, text.length)).toEqual({ items: ["area"], from: text.length - 2, to: text.length });
    expect(localCompletions("fun", 3).items).toEqual(["function"]);
  });
  it("leaves names after a dot to the kernel", () => {
    expect(localCompletions("Base.pri", 8).items).toEqual([]);
  });
  it("opens after a name character or a dot after a name, not after a number", () => {
    expect(opensCompletion("x = pr", 6)).toBe(true);
    expect(opensCompletion("Base.", 5)).toBe(true);
    expect(opensCompletion("1.", 2)).toBe(false);
    expect(opensCompletion("x = 12", 6)).toBe(false);
    expect(opensCompletion("x = ", 4)).toBe(false);
  });
  it("puts the kernel's items first and keeps the local ones for the same name", () => {
    const local = { items: ["printme"], from: 4, to: 7 };
    expect(mergeCompletions(local, { items: ["print", "println"], from: 4, to: 7 }).items).toEqual(["print", "println", "printme"]);
    expect(mergeCompletions(local, null)).toBe(local);
  });
});
