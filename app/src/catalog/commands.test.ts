import { describe, expect, it } from "vitest";
import { UNIT_NAMES } from "../math/units";
import { BUILTIN_ENTRIES } from "./builtins";
import { buildCommandItems, commandApplies, equationInsertionItems, searchCommands, type CommandScope } from "./commands";

const items = buildCommandItems("en-US");

it("keeps equation search to special symbols and structures", () => {
  const equation = equationInsertionItems(items);
  const find = (query: string) => searchCommands(equation, query, 60, true);
  expect(find("integ")[0]?.label).toBe("∫");
  expect(find("alpha").map((item) => item.label)).toEqual(["α", "Α"]);
  expect(find("trunc")).toEqual([]);
  expect(find("kg").some((item) => item.label === "kg")).toBe(false);
  expect(equation.some((item) => item.run.kind === "action" && item.run.action.kind === "unit")).toBe(false);
  expect(equation.some((item) => item.run.kind === "action" && item.run.action.kind === "command" && item.run.action.command === "add")).toBe(false);
  expect(searchCommands(items, "trunc")[0]?.label).toBe("trunc");
  expect(searchCommands(items, "kg")[0]?.label).toBe("kg");
});

it("lists the Insert tab's regions only for a search on empty space", () => {
  const commands = (atCrosshair: boolean) => equationInsertionItems(items, atCrosshair)
    .flatMap((item) => item.run.kind === "window" ? [item.run.cmd] : []);
  expect(commands(false)).toEqual(["matrixDialog"]);
  expect(new Set(commands(true))).toEqual(new Set([
    "matrixDialog", "insertText", "insertTextRegion", "insertPlot", "insertTable", "insertImage",
    "insertArea", "insertInclude", "insertJulia", "addPageBreak",
  ]));
  const find = (query: string) => searchCommands(equationInsertionItems(items, true), query, 60, true)[0];
  expect(find("table")?.run).toEqual({ kind: "window", cmd: "insertTable" });
  expect(find("plot")?.run).toEqual({ kind: "window", cmd: "insertPlot" });
  expect(find("include")?.run).toEqual({ kind: "window", cmd: "insertInclude" });
});

describe("matrix commands", () => {
  it("are in the command palette and run editor commands", () => {
    const found = searchCommands(items, "delete row")[0];
    expect(found.label).toBe("Delete row");
    expect(found.run).toEqual({ kind: "action", action: { kind: "command", command: "deleteRow" } });
    expect(searchCommands(items, "delete column")[0].run).toEqual({ kind: "action", action: { kind: "command", command: "deleteColumn" } });
    expect(searchCommands(items, "select row")[0].label).toBe("Select row");
    expect(searchCommands(items, "insert row above")[0].run).toEqual({ kind: "action", action: { kind: "command", command: "addRowAbove" } });
    expect(searchCommands(items, "insert column left")[0].run).toEqual({ kind: "action", action: { kind: "command", command: "addColumnLeft" } });
    expect(searchCommands(items, "clear cells")[0].run).toEqual({ kind: "action", action: { kind: "command", command: "clearCells" } });
  });
});
const find = (id: string) => items.find((item) => item.id === id);

describe("text paragraph styles and alignment", () => {
  const commands = [
    "textAlignLeft",
    "textAlignCenter",
    "textAlignRight",
    "textAlignJustify",
    "textStyleNormal",
    "textStyleTitle",
    "textStyleSubtitle",
    "textStyleHeading1",
    "textStyleHeading2",
    "textStyleHeading3",
  ];

  it("has a palette entry for each Text tab paragraph command, with no chord on either layout", () => {
    for (const cmd of commands) {
      expect(find(`cmd:${cmd}`)?.run).toEqual({ kind: "window", cmd });
      // No reference application chord is known on the US or the Italian layout: the palette entry has no shortcut.
      expect(find(`cmd:${cmd}`)?.shortcut ?? null).toBeNull();
      expect(buildCommandItems("it-IT").find((item) => item.id === `cmd:${cmd}`)?.shortcut ?? null).toBeNull();
    }
  });

  it("is searchable by what the command does", () => {
    expect(searchCommands(items, "justify")[0]?.id).toBe("cmd:textAlignJustify");
    expect(searchCommands(items, "heading 2")[0]?.id).toBe("cmd:textStyleHeading2");
    expect(searchCommands(items, "align centre")[0]?.id).toBe("cmd:textAlignCenter");
  });
});

describe("plot trace types", () => {
  it("has a palette entry for each type, with no chord on either layout", () => {
    for (const [cmd, label] of [
      ["plotLineTrace", "Plot: line trace"],
      ["plotStemTrace", "Plot: stem trace"],
      ["plotBarTrace", "Plot: bar trace"],
      ["plotStepTrace", "Plot: step trace"],
    ] as const) {
      expect(find(`cmd:${cmd}`)?.label).toBe(label);
      expect(find(`cmd:${cmd}`)?.run).toEqual({ kind: "window", cmd });
      // No reference application chord is known on the US or the Italian layout: the palette entry has no shortcut.
      expect(find(`cmd:${cmd}`)?.shortcut ?? null).toBeNull();
      expect(buildCommandItems("it-IT").find((item) => item.id === `cmd:${cmd}`)?.shortcut ?? null).toBeNull();
    }
    // The presentation commands keep their own entries: the two are different things.
    expect(find("cmd:plotLines")?.label).toBe("Plot: lines");
  });

  it("is searchable by what the command does", () => {
    expect(searchCommands(items, "stem trace")[0]?.id).toBe("cmd:plotStemTrace");
    expect(searchCommands(items, "bar trace")[0]?.id).toBe("cmd:plotBarTrace");
  });
});

describe("find and replace", () => {
  it("has a palette entry for Replace with and no chord for it on either layout", () => {
    const replace = items.find((item) => item.id === "cmd:replace");
    expect(replace?.label).toBe("Replace with…");
    expect(replace?.run).toEqual({ kind: "window", cmd: "replace" });
    expect(replace?.shortcut).toBeNull();
    expect(buildCommandItems("it-IT").find((item) => item.id === "cmd:replace")?.shortcut).toBeNull();
    expect(searchCommands(items, "replace with")[0].id).toBe("cmd:replace");
  });
});

describe("command palette catalogue", () => {
  it("covers every built-in function and every unit name of the shared table", () => {
    for (const entry of BUILTIN_ENTRIES) expect(find(`fn:${entry.name}`), entry.name).toBeDefined();
    const units = new Set(items.filter((i) => i.group === "Unit").map((i) => i.label));
    expect(units).toEqual(new Set(UNIT_NAMES));
  });

  it("lists commands, palettes, operators, symbols, constants and symbolic keywords with shortcuts", () => {
    expect(find("cmd:calculate")?.shortcut).toBe("F5");
    expect(find("cmd:functionCatalogue")?.shortcut).toBe("F2");
    expect(find("cmd:undo")?.shortcut).toBe("Ctrl+Z");
    const groups = new Set(items.map((i) => i.group));
    for (const group of ["Command", "Palette", "Operator", "Symbol", "Programming", "Constant", "Symbolic", "Unit", "Function"]) {
      expect(groups.has(group as never), group).toBe(true);
    }
    const global = items.find((i) => i.group === "Operator" && i.label === "≡");
    expect(global?.shortcut).toBe("Ctrl+Shift+~");
    expect(buildCommandItems("it-IT").find((i) => i.group === "Operator" && i.label === "≡")?.shortcut).toBe("Ctrl+Shift+ò");
    expect(items.some((i) => i.group === "Symbolic" && i.label === "simplify")).toBe(true);
  });

  it("omits entries the editor cannot run yet", () => {
    expect(items.some((i) => i.label === "‖")).toBe(false);
    // A symbol that is a name character can be run.
    expect(items.some((i) => i.label === "∀")).toBe(true);
  });

  it("ranks exact and prefix matches first and requires every word", () => {
    expect(searchCommands(items, "stack")[0].label).toBe("stack");
    expect(searchCommands(items, "kn").slice(0, 2).map((i) => i.label).sort()).toEqual(["Kn", "kN"]);
    expect(searchCommands(items, "kN")[0].label).toBe("kN");
    expect(searchCommands(items, "global definition").map((i) => i.label)).toContain("≡");
    expect(searchCommands(items, "zzzzzz")).toEqual([]);
    expect(searchCommands(items, "").every((i) => i.group === "Command" || i.group === "Palette")).toBe(true);
    expect(searchCommands(items, "m", 5)).toHaveLength(5);
  });
});

describe("the palette's scope", () => {
  const items = buildCommandItems("en-US");
  const worksheet: CommandScope = { fileTab: null, project: false, object: null, selectedKind: null, mathEditing: false, inMatrix: false };
  const listed = (scope: CommandScope) => items.filter((item) => commandApplies(item, scope)).map((item) => item.label);

  it("hides Code, project, Plot, Image and editing commands that cannot act on a plain worksheet", () => {
    const shown = listed(worksheet);
    for (const hidden of ["Code: Find", "Close project", "Project settings…", "Plot: add trace", "Image: original size", "Insert row below", "Literal subscript", "Matrix: show indices", "Julia: reset to content size"]) {
      expect(shown).not.toContain(hidden);
    }
    for (const kept of ["Insert XY plot", "New project…", "Open project…", "Save worksheet", "Operators palette"]) expect(shown).toContain(kept);
  });

  it("lists each family when its object is in front", () => {
    expect(listed({ ...worksheet, fileTab: "text", project: true })).toEqual(expect.arrayContaining(["Code: Find", "Code: Show file in folder", "Close project"]));
    expect(listed({ ...worksheet, fileTab: "image", project: true })).not.toContain("Code: Find");
    expect(listed({ ...worksheet, fileTab: "image", project: true })).toContain("Code: Show file in folder");
    expect(listed({ ...worksheet, object: "plot", selectedKind: "plot" })).toContain("Plot: add trace");
    expect(listed({ ...worksheet, object: "image", selectedKind: "image" })).toContain("Image: original size");
    expect(listed({ ...worksheet, selectedKind: "julia" })).toContain("Julia: reset to content size");
    expect(listed({ ...worksheet, object: "matrix", mathEditing: true, inMatrix: true })).toEqual(expect.arrayContaining(["Insert row below", "Literal subscript", "Matrix: show indices"]));
    expect(listed({ ...worksheet, mathEditing: true })).toContain("Literal subscript");
    expect(listed({ ...worksheet, mathEditing: true })).not.toContain("Insert row below");
  });

  it("finds Insert XY plot first for `plot` with no plot selected", () => {
    const available = items.filter((item) => commandApplies(item, worksheet));
    expect(searchCommands(available, "plot")[0].label).toBe("Insert XY plot");
  });
});
