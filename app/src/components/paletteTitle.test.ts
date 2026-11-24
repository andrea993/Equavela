// The tooltip of a palette entry names every chord of its command.

import { describe, expect, it } from "vitest";
import { PALETTE_KINDS, paletteSections } from "../catalog/palettes";
import { entryTitle } from "./Palettes";

const entry = (command: string) =>
  PALETTE_KINDS.flatMap((kind) => paletteSections(kind)).flatMap((section) => section.entries)
    .find((e) => e.action.kind === "command" && e.action.command === command);

describe("the tooltip of a palette entry", () => {
  it("lists both chords of Boolean equality and of greater or equal", () => {
    expect(entryTitle(entry("boolEq")!)).toBe("Boolean equality (Ctrl+= or Ctrl+Shift+E)");
    expect(entryTitle(entry("greaterEq")!)).toMatch(/\(Ctrl\+0 or Ctrl\+Shift\+G\)$/);
  });

  it("keeps a single chord as it was", () => {
    expect(entryTitle(entry("lessEq")!)).toMatch(/\(Ctrl\+9\)$/);
  });
});
