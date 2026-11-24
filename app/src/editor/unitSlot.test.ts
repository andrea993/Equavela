import { describe, expect, it } from "vitest";
import { handleKey } from "./controller";
import { initialState, type EditorState } from "./model";
import { get, sexpr, toEditing, toWire, withUnitSlot } from "./tree";

const key = (s: EditorState, k: string) => handleKey(s, { key: k, code: k.length > 1 ? k : "" }).state;
const keys = (s: EditorState, text: string) => [...text].reduce(key, s);

describe("the unit slot after the result of an evaluation", () => {
  it("is offered empty and stored as no unit", () => {
    const s = keys(initialState(), "x=");
    expect(get(s.root, [1]).type).toBe("Placeholder");
    expect(toWire(s.root)).toMatchObject({ type: "Evaluate", unit: null });
  });

  it("is reached with the right arrow, and what is typed there is the unit", () => {
    const s = keys(key(keys(initialState(), "v="), "ArrowRight"), "km");
    expect(sexpr(s.root)).toBe("(= v km)");
    expect(toWire(s.root)).toMatchObject({ type: "Evaluate", unit: { type: "Ident" } });
  });

  it("also follows a definition shown with its value", () => {
    const s = keys(initialState(), "a:1=");
    expect(toWire(s.root)).toMatchObject({ type: "Define", tail: { type: "Eval", unit: null } });
    const slot = s.root.tail as { unit: { type: string } };
    expect(slot.unit.type).toBe("Placeholder");
  });

  it("is added to a stored evaluation when it is opened for editing", () => {
    const stored = toEditing({ type: "Evaluate", expr: { type: "Ident", name: { segments: [{ text: "x", subscript: false }], label: null } }, unit: null });
    expect(get(withUnitSlot(stored), [1]).type).toBe("Placeholder");
  });
});
