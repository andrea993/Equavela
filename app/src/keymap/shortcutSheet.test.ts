import { describe, expect, it } from "vitest";
import { LAYOUTS, LAYOUT_IDS } from "./keymap";
import { shortcutSheet } from "./shortcutSheet";

describe("the keyboard shortcut sheet", () => {
  it.each(LAYOUT_IDS)("lists every chord, key and math character of the %s table", (layout) => {
    const rows = shortcutSheet(layout);
    const has = (cmd: string, keys: string) => rows.some((row) => row.cmd === cmd && row.keys === keys);
    const table = LAYOUTS[layout];
    for (const chord of table.ctrl) expect(has(chord.cmd, chord.pdf), `${chord.pdf} ${chord.cmd}`).toBe(true);
    for (const [ch, cmd] of Object.entries(table.chars)) expect(has(cmd, ch), `${ch} ${cmd}`).toBe(true);
    for (const key of table.keys) expect(rows.some((row) => row.cmd === key.cmd && row.context === key.ctx), key.cmd).toBe(true);
    expect(rows).toHaveLength(table.ctrl.length + table.keys.length + Object.keys(table.chars).length);
  });

  it("names commands with their palette title, and spells the others", () => {
    const rows = shortcutSheet("en-US");
    expect(rows.find((row) => row.cmd === "save")?.label).toBe("Save worksheet");
    expect(rows.find((row) => row.cmd === "newProgramLine")?.label).toBe("New program line");
    expect(rows.find((row) => row.cmd === "insertSearch")?.keys).toBe("Ctrl+Shift+Space");
    for (const row of rows) expect(row.label, row.cmd).toMatch(/^[A-Z]/);
  });

  it("shows the chords each layout really has (Italian chords differ)", () => {
    const us = shortcutSheet("en-US").find((row) => row.cmd === "globalDefine")?.keys;
    const it = shortcutSheet("it-IT").find((row) => row.cmd === "globalDefine")?.keys;
    expect(us).toBeTruthy();
    expect(it).toBe("Ctrl+Shift+ò");
    expect(us).not.toBe(it);
  });
});
