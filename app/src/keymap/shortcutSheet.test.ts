import { describe, expect, it } from "vitest";

import { KEYMAP } from "./keymap";
import { shortcutSheet } from "./shortcutSheet";

describe("the keyboard shortcut sheet", () => {
  it("lists every chord, key and math character of the keymap", () => {
    const rows = shortcutSheet();
    const has = (cmd: string, keys: string) => rows.some((row) => row.cmd === cmd && row.keys === keys);
    for (const chord of KEYMAP.ctrl) expect(has(chord.cmd, chord.label), `${chord.label} ${chord.cmd}`).toBe(true);
    for (const [ch, cmd] of Object.entries(KEYMAP.chars)) expect(has(cmd, ch), `${ch} ${cmd}`).toBe(true);
    for (const key of KEYMAP.keys) expect(rows.some((row) => row.cmd === key.cmd && row.context === key.ctx), key.cmd).toBe(true);
    expect(rows).toHaveLength(KEYMAP.ctrl.length + KEYMAP.keys.length + Object.keys(KEYMAP.chars).length);
  });

  it("names commands with their palette title, and spells the others", () => {
    const rows = shortcutSheet();
    expect(rows.find((row) => row.cmd === "save")?.label).toBe("Save worksheet");
    expect(rows.find((row) => row.cmd === "newProgramLine")?.label).toBe("New program line");
    expect(rows.find((row) => row.cmd === "insertSearch")?.keys).toBe("Ctrl+Shift+Space");
    for (const row of rows) expect(row.label, row.cmd).toMatch(/^[A-Z]/);
  });

  it("shows the US keys of a chord, for every layout", () => {
    expect(shortcutSheet().find((row) => row.cmd === "globalDefine")?.keys).toBe("Ctrl+Shift+~");
    expect(shortcutSheet().find((row) => row.cmd === "try")?.keys).toBe("Ctrl+[");
  });
});
