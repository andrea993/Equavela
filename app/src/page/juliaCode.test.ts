import { describe, expect, it } from "vitest";
import { juliaHeader, tokenizeJulia } from "./juliaCode";

describe("the syntax colours of a Julia block", () => {
  it("gives the code back exactly and marks keywords, strings, comments and numbers", () => {
    const code = 'function f(x)\n  # half\n  return x / 2.5e3 # end\nend\ns = "a#b" * """\nq"""\n#= block\n=# y = 0x1F';
    const tokens = tokenizeJulia(code);
    expect(tokens.map((token) => token.text).join("")).toBe(code);
    const of = (kind: string) => tokens.filter((token) => token.kind === kind).map((token) => token.text);
    expect(of("keyword")).toEqual(["function", "return", "end"]);
    expect(of("comment")).toEqual(["# half", "# end", "#= block\n=#"]);
    expect(of("string")).toEqual(['"a#b"', '"""\nq"""']);
    expect(of("number")).toEqual(["2.5e3", "0x1F"]);
  });

  it("does not colour a digit inside a name", () => {
    expect(tokenizeJulia("x2 = a_1").filter((token) => token.kind !== "plain")).toEqual([]);
  });
});

describe("the header derived from the code", () => {
  it("takes column-0 using and import lines, outside comments", () => {
    const header = juliaHeader(
      "using LinearAlgebra, Statistics\nimport Statistics: mean, std\n  using Indented\n# using Commented\nusing A: x\nimport Base: show!\nusing LinearAlgebra",
    );
    expect(header.using).toEqual(["LinearAlgebra", "Statistics"]);
    expect(header.imports).toEqual([
      { name: "mean", package: "Statistics", function: "mean" },
      { name: "std", package: "Statistics", function: "std" },
    ]);
  });
});
