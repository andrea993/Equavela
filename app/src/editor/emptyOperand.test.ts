import { describe, expect, it } from "vitest";
import { handleKey } from "./controller";
import { initialState, runCommand, type EditorState } from "./model";
import { get, sexpr } from "./tree";

const key = (s: EditorState, ch: string) => handleKey(s, { key: ch, code: "" }).state;

describe("an operator typed in an empty operand", () => {
  it.each([
    ["+", "(+ (+ a □) □)"],
    ["*", "(· (· a □) □)"],
    ["<", "(< (< a □) □)"],
  ])("joins the chain as the same text typed in a row: a %s □ %s □", (op, expected) => {
    const s = key(key(key(initialState(), "a"), op), op);
    expect(sexpr(s.root.expr)).toBe(expected);
    expect(get(s.root, s.focus).type).toBe("Placeholder");
  });

  it("does the same for the space and for and, so no parentheses appear", () => {
    for (const command of ["gap", "and"] as const) {
      let s = key(initialState(), "a");
      for (let i = 0; i < 3; i++) s = runCommand(s, command);
      const glyph = command === "gap" ? "␣" : "∧";
      expect(sexpr(s.root.expr)).toBe(`(${glyph} (${glyph} (${glyph} a □) □) □)`);
    }
  });

  it("keeps a fraction and a power structural: the new operator goes in their slot", () => {
    expect(sexpr(key(key(key(initialState(), "a"), "/"), "/").root.expr)).toBe("(/ a (/ □ □))");
    expect(sexpr(key(key(key(initialState(), "a"), "^"), "^").root.expr)).toBe("(^ a (^ □ □))");
  });
});
