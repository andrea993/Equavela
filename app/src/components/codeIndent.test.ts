import { describe, expect, it } from "vitest";
import { dedentTyped, newlineIndented } from "./codeIndent";

/** Enter at the `|` of `code`; the result with `|` at the caret. */
function enter(code: string, julia = true): string {
  const at = code.indexOf("|");
  const edit = newlineIndented({ text: code.replace("|", ""), start: at, end: at }, julia);
  return `${edit.text.slice(0, edit.start)}|${edit.text.slice(edit.start)}`;
}

/** Typing ends at the `|`: the line is re-indented when it starts with `end` and the like. */
function typed(code: string): string {
  const at = code.indexOf("|");
  const edit = dedentTyped({ text: code.replace("|", ""), start: at, end: at });
  return `${edit.text.slice(0, edit.start)}|${edit.text.slice(edit.start)}`;
}

describe("automatic indentation", () => {
  it("indents the line after a block opener", () => {
    expect(enter("function f(x)|")).toBe("function f(x)\n    |");
    expect(enter("    for i in 1:3|")).toBe("    for i in 1:3\n        |");
    expect(enter("if a > 0|")).toBe("if a > 0\n    |");
    expect(enter("map(xs) do x|")).toBe("map(xs) do x\n    |");
    expect(enter("mutable struct P|")).toBe("mutable struct P\n    |");
    expect(enter("else|")).toBe("else\n    |");
  });

  it("keeps the indentation of a line that opens nothing or closes what it opens", () => {
    expect(enter("    x = 1|")).toBe("    x = 1\n    |");
    expect(enter("    for i in 1:3 s += i end|")).toBe("    for i in 1:3 s += i end\n    |");
    expect(enter("    y = a[end]|")).toBe("    y = a[end]\n    |");
    expect(enter("    v = [i for i in 1:3]|")).toBe("    v = [i for i in 1:3]\n    |");
    expect(enter('    s = "if then"|')).toBe('    s = "if then"\n    |');
    expect(enter("    x = 1 # for each|")).toBe("    x = 1 # for each\n    |");
    expect(enter("abstract type Shape end|")).toBe("abstract type Shape end\n|");
  });

  it("indents inside an open bracket and goes back when it closes", () => {
    expect(enter("f(a,|")).toBe("f(a,\n    |");
    expect(enter("f(a,\n    b)|")).toBe("f(a,\n    b)\n|");
  });

  it("puts the closer of a bracket pair on its own line", () => {
    expect(enter("x = [|]")).toBe("x = [\n    |\n]");
    expect(enter("    f(|)")).toBe("    f(\n        |\n    )");
  });

  it("moves the rest of the line down, and an end there goes back to its opener", () => {
    expect(enter("if a |   b")).toBe("if a\n    |b");
    expect(enter("function f()\n    x = 1|end")).toBe("function f()\n    x = 1\n|end");
  });

  it("keeps the indentation only outside Julia", () => {
    expect(enter("  for x|", false)).toBe("  for x\n  |");
  });

  it("moves end, else and a closer back to the line that opened them", () => {
    expect(typed("function f(x)\n    y = x\n    end|")).toBe("function f(x)\n    y = x\nend|");
    expect(typed("if a\n    b\n    else|")).toBe("if a\n    b\nelse|");
    expect(typed("    for i in 1:2\n        if i > 1\n            x\n            end|")).toBe("    for i in 1:2\n        if i > 1\n            x\n        end|");
    expect(typed("v = [\n    1,\n    ]|")).toBe("v = [\n    1,\n]|");
    // anything else is left alone
    expect(typed("function f(x)\n    y = x\n    ending|")).toBe("function f(x)\n    y = x\n    ending|");
    expect(typed("x = 1\nend|")).toBe("x = 1\nend|");
  });
});

it("leaves no trailing spaces on the line Enter leaves", () => {
  expect(enter("function f()\n    |")).toBe("function f()\n\n    |");
});
