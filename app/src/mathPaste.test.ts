import { beforeEach, describe, expect, it } from "vitest";
import { mathOfPaste, mathOfSnippet, rememberMathCopy } from "./mathPaste";

describe("math on the clipboard", () => {
  beforeEach(() => rememberMathCopy("\u0000"));

  it("takes the text a math editor copied, and only that text", () => {
    rememberMathCopy("a := (x + y)·z");
    expect(mathOfPaste("a := (x + y)·z")).toBe("a := (x + y)·z");
    // prose that parses as a name is still prose
    expect(mathOfPaste("load")).toBeNull();
    expect(mathOfPaste("  ")).toBeNull();
  });

  it("takes the math of a snippet that holds one math region", () => {
    const snippet = ["- id: r1", "  page: 1", "  at: [54, 72]", '  math: "L := 3.5 m"', ""].join("\n");
    expect(mathOfSnippet(snippet)).toBe("L := 3.5 m");
    expect(mathOfPaste(snippet)).toBe("L := 3.5 m");
  });

  it("leaves a snippet with several regions or with another kind of region as text", () => {
    const two = ["- id: a", "  page: 1", "  at: [0, 0]", '  math: "a := 1"', "- id: b", "  page: 1", "  at: [0, 9]", '  math: "b := 2"', ""].join("\n");
    expect(mathOfSnippet(two)).toBeNull();
    const text = ["- id: a", "  page: 1", "  at: [0, 0]", '  text: "hello"', ""].join("\n");
    expect(mathOfSnippet(text)).toBeNull();
    expect(mathOfSnippet('- id: a\n  math: "x"\n  text: "y"\n')).toBeNull();
    expect(mathOfSnippet("just some words")).toBeNull();
  });
});
