import { describe, expect, it } from "vitest";
import { commandTitle } from "../catalog/commands";
import { contextDisabled, contextEntries, contextLabel, FIELD_COMMANDS, type ContextTarget } from "./contextMenu";

const TARGETS: ContextTarget[] = ["math", "text", "plot", "image", "include", "julia", "area", "multiple", "field", "sheet"];

describe("the right-click menus", () => {
  it("every entry is a command the app has, a field command or a separator", () => {
    for (const target of TARGETS) {
      for (const cmd of contextEntries(target)) {
        if (cmd === "-") continue;
        const known = commandTitle(cmd) !== null || cmd in FIELD_COMMANDS || ["copy", "cut", "paste", "selectAll", "deleteRegions"].includes(cmd);
        expect(known, `${target}: ${cmd}`).toBe(true);
        expect(contextLabel(cmd)).not.toBe(cmd);
      }
    }
  });

  it("a menu never starts or ends with a separator nor has two in a row", () => {
    for (const target of TARGETS) {
      const entries = contextEntries(target);
      expect(entries[0], target).not.toBe("-");
      expect(entries.at(-1), target).not.toBe("-");
      entries.forEach((cmd, i) => expect(cmd === "-" && entries[i - 1] === "-", target).toBe(false));
    }
  });

  it("each kind of region offers what is useful on it", () => {
    expect(contextEntries("math")).toEqual(expect.arrayContaining(["copy", "resultFormat", "mathFont", "toggleRegionEnabled", "deleteRegions"]));
    expect(contextEntries("text")).toEqual(expect.arrayContaining(["textAlignCenter", "textStyleHeading1"]));
    expect(contextEntries("plot")).toEqual(expect.arrayContaining(["plotAddTrace", "plotRemoveTrace", "plotAutoScale", "plotToggleGrid"]));
    expect(contextEntries("image")).toEqual(expect.arrayContaining(["imageReplace", "imageOriginalSize"]));
    expect(contextEntries("area")).toContain("toggleArea");
    expect(contextEntries("sheet")).toEqual(expect.arrayContaining(["paste", "insertMath", "insertPlot", "insertImage", "addPageBreak"]));
    expect(contextEntries("field")).toEqual(["fieldCut", "fieldCopy", "fieldPaste", "-", "fieldSelectAll"]);
    // No browser command in any menu: nothing of Back, Reload, Save as, Print the page or Inspect.
    for (const target of TARGETS) for (const cmd of contextEntries(target)) expect(cmd).not.toMatch(/reload|inspect|back|forward|viewSource/i);
  });

  it("the font commands need a math region and the edit commands a selection; the sheet and fields need neither", () => {
    expect(contextDisabled("mathFont", { selected: 1, canFormatMath: false, kind: "text" })).toBe(true);
    expect(contextDisabled("mathFont", { selected: 1, canFormatMath: true, kind: "math" })).toBe(false);
    expect(contextDisabled("copy", { selected: 0, canFormatMath: false, kind: "math" })).toBe(true);
    expect(contextDisabled("copy", { selected: 2, canFormatMath: false, kind: "multiple" })).toBe(false);
    expect(contextDisabled("paste", { selected: 0, canFormatMath: false, kind: "math" })).toBe(false);
    expect(contextDisabled("selectAll", { selected: 0, canFormatMath: false, kind: "sheet" })).toBe(false);
    expect(contextDisabled("fieldCut", { selected: 0, canFormatMath: false, kind: "field" })).toBe(false);
  });
});

it("names the disable toggle by what it will do, in sentence case like the other entries", () => {
  expect(contextLabel("toggleRegionEnabled")).toBe("Disable evaluation");
  expect(contextLabel("toggleRegionEnabled", true)).toBe("Enable evaluation");
  for (const cmd of ["increaseFontSize", "decreaseFontSize", "resetMathFont", "mathFont", "resultFormat"]) {
    const words = contextLabel(cmd).split(" ").slice(1);
    expect(words.every((word) => word === word.toLowerCase())).toBe(true);
  }
});
