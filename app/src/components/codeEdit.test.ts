// the specification : the text operations of the Code tab.
import { describe, expect, it } from "vitest";
import {
  commentPrefix,
  duplicateLines,
  findMatch,
  indentLines,
  lineOffset,
  moveLines,
  outdentLines,
  replaceAll,
  replaceMatch,
  toggleComment,
  type Edit,
} from "./codeEdit";

/** `|` marks the caret, `[` and `]` a selection. */
function at(marked: string): Edit {
  const start = marked.search(/[|[]/);
  const caret = marked.includes("|");
  const end = caret ? start : marked.indexOf("]") - 1;
  return { text: marked.replace(/[|[\]]/g, ""), start, end };
}
function show({ text, start, end }: Edit): string {
  return start === end ? text.slice(0, start) + "|" + text.slice(start) : text.slice(0, start) + "[" + text.slice(start, end) + "]" + text.slice(end);
}

describe("toggle comment", () => {
  it("adds `# ` at the common indentation and removes it again", () => {
    const added = toggleComment(at("  [a = 1\n    b = 2]\nc"));
    expect(added.text).toBe("  # a = 1\n  #   b = 2\nc");
    expect(toggleComment(added).text).toBe("  a = 1\n    b = 2\nc");
  });
  it("keeps blank lines and the caret's line", () => {
    expect(show(toggleComment(at("x = |1")))).toBe("# x = |1");
    expect(toggleComment(at("[a\n\nb]")).text).toBe("# a\n\n# b");
    expect(toggleComment(at("|\n"))).toEqual(at("|\n"));
  });
  it("uncomments a line written without the space", () => {
    expect(toggleComment(at("#x|")).text).toBe("x");
  });
});

describe("indent and outdent", () => {
  it("indents every touched line and keeps a selection ending at a line start off the next line", () => {
    expect(indentLines(at("[a\nb\n]c")).text).toBe("    a\n    b\nc");
    expect(show(outdentLines(at("    a|")))).toBe("a|");
    expect(outdentLines(at("[\tx\n  y]")).text).toBe("x\ny");
  });
});

describe("duplicate and move lines", () => {
  it("duplicates the line below, with the caret on the copy", () => {
    expect(show(duplicateLines(at("a|b\nc")))).toBe("ab\na|b\nc");
  });
  it("moves lines up and down and stops at the edges", () => {
    expect(show(moveLines(at("a\nb|\nc"), "up"))).toBe("b|\na\nc");
    expect(show(moveLines(at("a\nb|\nc"), "down"))).toBe("a\nc\nb|");
    expect(moveLines(at("a|\nb"), "up")).toEqual(at("a|\nb"));
    expect(moveLines(at("a\nb|"), "down")).toEqual(at("a\nb|"));
  });
});

describe("find, replace and go to line", () => {
  it("finds forward and backward, wrapping", () => {
    expect(findMatch(at("ab|ab"), "ab")).toEqual({ start: 2, end: 4 });
    expect(findMatch(at("ab[ab]"), "ab")).toEqual({ start: 0, end: 2 });
    expect(findMatch(at("ab[ab]"), "ab", true)).toEqual({ start: 0, end: 2 });
    expect(findMatch(at("x|"), "q")).toBeNull();
  });
  it("replaces the selected match and selects the next one, or all of them", () => {
    expect(show(replaceMatch(at("[ab] ab"), "ab", "x"))).toBe("x [ab]");
    expect(replaceAll(at("|ab ab"), "ab", "x")).toEqual({ edit: { text: "x x", start: 0, end: 0 }, count: 2 });
  });
  it("finds the start of a line", () => {
    expect(lineOffset("a\nbb\nc", 3)).toBe(5);
    expect(lineOffset("a\nbb", 9)).toBe(2);
  });
  it("comments only Julia, TOML and YAML files", () => {
    expect(commentPrefix("julia/src/A.jl")).toBe("# ");
    expect(commentPrefix("notes.md")).toBeNull();
  });
});
