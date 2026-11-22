// a bold italic text (unit names, bold italic text runs) must have a bundled bold italic face.
// Without one the engine synthesises it and the exported PDF holds a nameless, unembedded Type3 font.
import { describe, expect, it } from "vitest";
import source from "./fonts.ts?raw";

describe("bundled font faces", () => {
  it.each(["stix-two-text", "noto-sans"])("%s has a bold italic face", (family) => {
    expect(source).toContain(`@fontsource/${family}/700-italic.css`);
  });
});
