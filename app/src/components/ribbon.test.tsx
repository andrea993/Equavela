// The command UI: context and tab rules, no dead buttons
//, tooltips with the layout's chords, palette parity, the insert panel family
// and its section chips with the scroll spy, compact mode, and the Plot and
// Area tabs on the mock backend.

import { readFileSync } from "node:fs";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { buildCommandItems, searchCommands } from "../catalog/commands";
import { PALETTE_KINDS, paletteSections } from "../catalog/palettes";
import { UNIT_GROUPS } from "../catalog/units";
import { shortcutLabel } from "../keymap/keymap";
import { createMockBackend } from "../mock/mockBackend";
import type { PlotSpec, ViewRegion } from "../equavelaApi";
import { S } from "../strings";
import { TitleBar } from "./Chrome";
import {
  applyPlotCommand,
  PLOT_COMMANDS,
  ribbonContext,
  type RibbonContext,
} from "../workbench/commandContext";
import { panelSections, scrollTarget, topSection } from "./Palettes";
import { Ribbon, type RibbonProps } from "./Ribbon";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const SPEC: PlotSpec = {
  version: 1,
  type: "xy",
  size: [240, 160],
  axes: {
    x: { scale: "linear", unit: null, min: 0, max: 10, show_grid: true, title: "" },
    y: { scale: "linear", unit: null, min: null, max: null, show_grid: true, title: "" },
  },
  traces: [{ id: "trace-1", x: "t", y: "t^2", presentation: "line" }],
};
const PLOT: ViewRegion = { id: "pl1", page: 1, x: 300, y: 600, enabled: true, kind: "plot", plot: SPEC };
const TWO_TRACE_PLOT: ViewRegion = {
  ...PLOT,
  plot: {
    ...SPEC,
    traces: [
      SPEC.traces[0],
      { id: "trace-2", x: "t", y: "t^2", presentation: "line" },
    ],
  },
};
const AREA: ViewRegion = { id: "ar1", page: 1, x: 54, y: 190, enabled: true, kind: "area", title: "Loads", height: 100, collapsed: false };
const IMAGE: ViewRegion = { id: "im1", page: 1, x: 54, y: 300, enabled: true, kind: "image", resource: "img1", media: "svg", size: [180, 90] };

describe("context and tab rules", () => {
  const regions = [PLOT, AREA, IMAGE, { ...PLOT, id: "m", kind: "math", text: "a", statement: null } as ViewRegion];
  const base = {
    textEditing: false,
    mathEditing: false,
    inMatrix: false,
    matrixResult: false,
    selection: [] as string[],
    regions,
    plotTraceSelections: {} as Record<string, string>,
  };

  it("text editing wins over everything, then the matrix caret, then one selected plot or area", () => {
    expect(ribbonContext({ ...base, textEditing: true, mathEditing: true, inMatrix: true })).toEqual({ kind: "text" });
    expect(ribbonContext({ ...base, mathEditing: true, inMatrix: true, selection: ["pl1"] })).toEqual({ kind: "matrix" });
    expect(ribbonContext({ ...base, mathEditing: true, selection: ["pl1"] })).toBeNull();
    expect(ribbonContext({ ...base, selection: ["pl1"] })).toEqual({
      kind: "plot",
      regionId: "pl1",
      plot: SPEC,
      selectedTraceId: null,
    });
    expect(ribbonContext({ ...base, selection: ["pl1"], plotTraceSelections: { pl1: "trace-1" } })).toEqual({
      kind: "plot",
      regionId: "pl1",
      plot: SPEC,
      selectedTraceId: "trace-1",
    });
    expect(ribbonContext({ ...base, selection: ["ar1"] })).toEqual({ kind: "area", regionId: "ar1", collapsed: false });
    expect(ribbonContext({ ...base, selection: ["im1"] })).toEqual({ kind: "image", regionId: "im1" });
    expect(ribbonContext({ ...base, selection: ["pl1", "ar1"] })).toBeNull();
    expect(ribbonContext({ ...base, selection: ["m"] })).toBeNull();
  });

  it("a matrix result opens the Matrix tab too, on the region being edited or the one selected", () => {
    // The caret is not in the matrix (a result after `=`), but the region draws a matrix result.
    expect(ribbonContext({ ...base, mathEditing: true, matrixResult: true })).toEqual({ kind: "matrix" });
    // The same on a selected region that is not being edited, and only for one whole selection.
    expect(ribbonContext({ ...base, selection: ["m"], matrixResult: true })).toEqual({ kind: "matrix" });
    expect(ribbonContext({ ...base, selection: ["m", "pl1"], matrixResult: true })).toBeNull();
    // Text editing still wins.
    expect(ribbonContext({ ...base, textEditing: true, mathEditing: true, matrixResult: true })).toEqual({ kind: "text" });
  });

});

describe("plot commands", () => {
  it("change only what they name and report a no-op as null", () => {
    expect(applyPlotCommand(SPEC, "plotAddTrace")?.traces.map((t) => t.id)).toEqual(["trace-1", "trace-2"]);
    expect(applyPlotCommand(SPEC, "plotRemoveTrace")).toBeNull();
    expect(applyPlotCommand(SPEC, "plotRemoveTrace", "trace-1")).toBeNull();
    const two = applyPlotCommand(SPEC, "plotAddTrace")!;
    expect(applyPlotCommand(two, "plotRemoveTrace", "trace-2")?.traces.map((t) => t.id)).toEqual(["trace-1"]);
    expect(applyPlotCommand(two, "plotRemoveTrace", "trace-1")?.traces.map((t) => t.id)).toEqual(["trace-2"]);
    expect(applyPlotCommand(two, "plotRemoveTrace", "missing")).toBeNull();
    expect(applyPlotCommand(SPEC, "plotLines")).toBeNull();
    expect(applyPlotCommand(SPEC, "plotMarkers")?.traces[0].presentation).toBe("markers");
    expect(applyPlotCommand(SPEC, "plotLogY")?.axes.y.scale).toBe("log10");
    expect(applyPlotCommand(applyPlotCommand(SPEC, "plotLogY")!, "plotLogY")?.axes.y.scale).toBe("linear");
    const auto = applyPlotCommand(SPEC, "plotAutoScale")!;
    expect([auto.axes.x.min, auto.axes.x.max]).toEqual([null, null]);
    expect(applyPlotCommand(auto, "plotAutoScale")).toBeNull();
    // one toggle for the x axis and the left y axis, and the right y axis keeps its own side.
    const crossed = applyPlotCommand(SPEC, "plotToggleAxes")!;
    expect([crossed.axes.x.position, crossed.axes.y.position]).toEqual(["origin", "origin"]);
    const back = applyPlotCommand(crossed, "plotToggleAxes")!;
    expect([back.axes.x.position, back.axes.y.position]).toEqual(["boundary", "boundary"]);
    const gridOff = applyPlotCommand(SPEC, "plotToggleGrid")!;
    expect(gridOff.axes.x.show_grid).toBe(false);
    expect(gridOff.axes.y.show_grid).toBe(false);
    expect(applyPlotCommand(gridOff, "plotToggleGrid")?.axes.x.show_grid).toBe(true);
  });

  it("the presentation buttons act on the selected trace, else on every trace", () => {
    const two = applyPlotCommand(SPEC, "plotAddTrace")!;
    expect(applyPlotCommand(two, "plotMarkers", "trace-2")?.traces.map((t) => t.presentation)).toEqual(["line", "markers"]);
    expect(applyPlotCommand(two, "plotMarkers")?.traces.map((t) => t.presentation)).toEqual(["markers", "markers"]);
    // The selected trace already has it: nothing to do, even if the other trace differs.
    const mixed = applyPlotCommand(two, "plotMarkers", "trace-2")!;
    expect(applyPlotCommand(mixed, "plotMarkers", "trace-2")).toBeNull();
    expect(applyPlotCommand(mixed, "plotLines", "trace-2")?.traces.map((t) => t.presentation)).toEqual(["line", "line"]);
  });

  it("the trace type commands set the type of the selected trace, else of every trace", () => {
    expect(applyPlotCommand(SPEC, "plotLineTrace")).toBeNull();
    expect(applyPlotCommand(SPEC, "plotStemTrace")?.traces[0]).toMatchObject({ type: "stems", presentation: "line" });
    expect(applyPlotCommand(SPEC, "plotBarTrace")?.traces[0].type).toBe("bars");
    expect(applyPlotCommand(SPEC, "plotStepTrace")?.traces[0].type).toBe("steps");
    const two = applyPlotCommand(SPEC, "plotAddTrace")!;
    expect(applyPlotCommand(two, "plotStemTrace", "trace-2")?.traces.map((t) => t.type ?? "lines")).toEqual(["lines", "stems"]);
    expect(applyPlotCommand(two, "plotBarTrace")?.traces.map((t) => t.type)).toEqual(["bars", "bars"]);
    // The selected trace already draws that way: nothing to do, even if the other trace differs.
    const mixed = applyPlotCommand(two, "plotStemTrace", "trace-2")!;
    expect(applyPlotCommand(mixed, "plotStemTrace", "trace-2")).toBeNull();
    // Back to lines drops the stored field, which is the file default.
    const back = applyPlotCommand(mixed, "plotLineTrace", "trace-2")!;
    expect(back.traces.map((t) => t.type)).toEqual([undefined, undefined]);
  });

  it("the right axis keeps its limits through Auto Scale and Grid, and Log Right Y needs a trace on it", () => {
    expect(applyPlotCommand(SPEC, "plotLogY2")).toBeNull();
    const right = {
      ...SPEC,
      axes: { ...SPEC.axes, y2: { ...SPEC.axes.y, min: 1, max: 5 } },
      traces: [{ ...SPEC.traces[0], y_axis: "right" as const }],
    };
    expect(applyPlotCommand(right, "plotLogY2")?.axes.y2?.scale).toBe("log10");
    const auto = applyPlotCommand(right, "plotAutoScale")!;
    expect([auto.axes.y2?.min, auto.axes.y2?.max]).toEqual([null, null]);
    expect(applyPlotCommand(right, "plotToggleGrid")?.axes.y2?.max).toBe(5);
    // Axes at Origin never touches the right y axis: it belongs to its own side.
    const origin = applyPlotCommand({ ...right, axes: { ...right.axes, y2: { ...right.axes.y2!, position: "origin" as const } } }, "plotToggleAxes")!;
    expect(origin.axes.y2?.position).toBe("origin");
    expect(origin.axes.x.position).toBe("origin");
  });
});

function ribbonProps(overrides: Partial<RibbonProps> = {}): RibbonProps {
  return {
    hasDoc: true,
    hasSelection: false,
    fastSymbolicEnabled: false,
    onFastSymbolic: vi.fn(),
    onMatrixNested: vi.fn(),
    selectionDisabled: false,
    running: false,
    calcMode: "auto",
    viewMode: "page",
    context: null,
    matrixControls: null,
    matrixDisplay: null,
    matrixSize: null,
    compact: false,
    textFormat: null,
    onTextFormat: vi.fn(),
    onTextSize: vi.fn(),
    onTextColor: vi.fn(),
    onTextHighlight: vi.fn(),
    textBackground: null,
    onTextBackground: vi.fn(),
    onParagraphStyle: vi.fn(),
    onTextAlign: vi.fn(),
    onInsertInlineMath: vi.fn(),
    canFormatResult: false,
    mathSize: null,
    onMathSize: () => {},
    canFormatMath: false,
    problems: 0,
    panelOpen: false,
    onCommand: vi.fn(),
    onEditorCommand: vi.fn(),
    onMatrixDisplay: vi.fn(),
    onMatrixSize: vi.fn(),
    onPlotSpec: vi.fn(),
    onPlotSelectTrace: vi.fn(),
    onPalette: vi.fn(),
    openPalettes: [],
    ...overrides,
  };
}

const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

describe("the ribbon component", () => {
  it("shows Insert by default and keeps the active task tab after each command", () => {
    const onCommand = vi.fn();
    render(<Ribbon {...ribbonProps({ onCommand })} />);
    const sheet = screen.getByRole("tab", { name: "Insert" });
    expect(sheet.getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel", { name: "Insert" })).getByRole("button", { name: S.ribbon.commands.math })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith("insertPlot");
    expect(sheet.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: S.ribbon.commands.plot })).toBeTruthy();
    fireEvent.keyDown(sheet, { key: "ArrowRight" });
    expect(selectedTab()).toBe("Math");
    expect(screen.getByRole("tabpanel", { name: "Math" })).toBeTruthy();
  });

  it("inserts formula templates directly from Insert using the math editor commands", () => {
    const onEditorCommand = vi.fn();
    render(<Ribbon {...ribbonProps({ onEditorCommand })} />);
    const panel = screen.getByRole("tabpanel", { name: "Insert" });
    fireEvent.click(within(panel).getByRole("button", { name: "Fraction" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Integral" }));
    expect(onEditorCommand.mock.calls).toEqual([["frac"], ["integral"]]);
  });

  it("shows the contextual tab only while its context lasts", () => {
    const { rerender } = render(<Ribbon {...ribbonProps()} />);
    expect(selectedTab()).toBe("Insert");
    fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
    const matrix: RibbonContext = { kind: "matrix" };
    rerender(<Ribbon {...ribbonProps({ context: matrix, matrixControls: { canDeleteRow: true, canDeleteColumn: false } })} />);
    expect(selectedTab()).toBe(S.ribbon.tabs.matrix);
    expect(screen.getByRole("tab", { name: S.ribbon.tabs.matrix }).classList.contains("contextual")).toBe(true);
    expect((screen.getByRole("button", { name: S.ribbon.commands.deleteMatrixColumn }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<Ribbon {...ribbonProps()} />);
    expect(screen.queryByRole("tab", { name: S.ribbon.tabs.matrix })).toBeNull();
    expect(selectedTab()).toBe("Calculate");
  });

  it("the Results group offers the worksheet default without a selection", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ hasDoc: false, onCommand })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const button = () =>
      screen.getByRole("button", { name: S.ribbon.commands.worksheetFormat }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    rerender(<Ribbon {...ribbonProps({ hasDoc: true, onCommand })} />);
    expect(button().disabled).toBe(false);
    // The region command still needs one selected or edited math region.
    expect((screen.getByRole("button", { name: S.ribbon.commands.resultFormat }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button());
    expect(onCommand).toHaveBeenCalledWith("worksheetFormat");
  });

  it("the Settings group of the Calculate tab opens the calculation settings", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ hasDoc: false, onCommand })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
    const button = () =>
      screen.getByRole("button", { name: S.ribbon.commands.calculationSettings }) as HTMLButtonElement;
    // It needs a worksheet and no target inside it.
    expect(button().disabled).toBe(true);
    rerender(<Ribbon {...ribbonProps({ hasDoc: true, onCommand })} />);
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(onCommand).toHaveBeenCalledWith("calculationSettings");
  });

  it("the Text tab has colour pickers for the selection and a background for the region", () => {
    const onTextColor = vi.fn();
    const onTextHighlight = vi.fn();
    const onTextBackground = vi.fn();
    const base = { context: { kind: "text" as const }, onTextColor, onTextHighlight, onTextBackground };
    const { rerender } = render(<Ribbon {...ribbonProps(base)} />);
    fireEvent.click(screen.getByRole("tab", { name: S.ribbon.tabs.text }));
    const picker = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;
    const chip = (label: string) => (picker(label).querySelector(".color-chip") as HTMLElement).style.background;
    const choose = (label: string, swatch: string) => {
      fireEvent.click(picker(label));
      fireEvent.click(within(screen.getByRole("dialog", { name: label })).getByRole("button", { name: swatch }));
    };
    // No text region open: the colour commands are off; no region to fill either.
    for (const label of [S.text.textColor, S.text.highlight, S.text.regionBackground]) expect(picker(label).disabled).toBe(true);
    rerender(
      <Ribbon
        {...ribbonProps({
          ...base,
          textFormat: { bold: false, italic: false, underline: false, sub: false, sup: false, size: null, color: "#ff0000", highlight: null, style: "normal", align: "left" },
          textBackground: { color: "#ffff00" },
        })}
      />,
    );
    expect(chip(S.text.textColor)).toBe("rgb(255, 0, 0)");
    expect(chip(S.text.highlight)).toBe("");
    expect(chip(S.text.regionBackground)).toBe("rgb(255, 255, 0)");
    // The palette is a grid of squares named by their colour; a click picks one and closes it.
    choose(S.text.textColor, "Blue");
    expect(onTextColor).toHaveBeenCalledWith("#0000c0");
    expect(screen.queryByRole("dialog", { name: S.text.textColor })).toBeNull();
    fireEvent.click(picker(S.text.textColor));
    fireEvent.click(screen.getByRole("button", { name: S.text.defaultColor }));
    expect(onTextColor).toHaveBeenLastCalledWith(null);
    choose(S.text.highlight, "Yellow");
    expect(onTextHighlight).toHaveBeenCalledWith("#ffff00");
    fireEvent.click(picker(S.text.regionBackground));
    fireEvent.click(screen.getByRole("button", { name: S.text.noColor }));
    expect(onTextBackground).toHaveBeenCalledWith(null);
    // "More colors…" opens the RGB picker; the hex field and the channels move the colour, OK applies it.
    fireEvent.click(picker(S.text.textColor));
    fireEvent.click(screen.getByRole("button", { name: S.text.moreColors }));
    const dialog = screen.getByRole("dialog", { name: new RegExp(S.text.moreColors) });
    fireEvent.change(within(dialog).getByLabelText(S.text.hexCode), { target: { value: "#12ab56" } });
    expect((within(dialog).getByLabelText(S.text.green) as HTMLInputElement).value).toBe("171");
    fireEvent.change(within(dialog).getByLabelText(S.text.blue), { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: S.text.ok }));
    expect(onTextColor).toHaveBeenLastCalledWith("#12ab00");
    // The colour just made is offered again under the recent colours.
    fireEvent.click(picker(S.text.textColor));
    expect(screen.getByText(S.text.recentColors)).toBeTruthy();
  });

  it("the Text tab has a Paragraph group and a Text Styles group with the current state pressed", () => {
    const onTextAlign = vi.fn();
    const onParagraphStyle = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ onTextAlign, onParagraphStyle })} />);
    // The tab appears while a text region is being edited.
    rerender(<Ribbon {...ribbonProps({ context: { kind: "text" }, onTextAlign, onParagraphStyle })} />);
    fireEvent.click(screen.getByRole("tab", { name: S.ribbon.tabs.text }));
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    // No text region open: the paragraph commands are disabled inside their tab.
    for (const label of [S.text.alignCenter, S.text.styleHeading1]) expect(button(label).disabled).toBe(true);
    // With the editor reporting a state, the pressed buttons follow the paragraph at the caret.
    rerender(
      <Ribbon
        {...ribbonProps({
          context: { kind: "text" },
          textFormat: { bold: false, italic: false, underline: false, sub: false, sup: false, size: null, color: null, highlight: null, style: "heading1", align: "center" },
          onTextAlign,
          onParagraphStyle,
        })}
      />,
    );
    expect(button(S.text.alignCenter).getAttribute("aria-pressed")).toBe("true");
    expect(button(S.text.alignLeft).getAttribute("aria-pressed")).toBe("false");
    expect(button(S.text.styleHeading1).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button(S.text.alignRight));
    expect(onTextAlign).toHaveBeenCalledWith("right");
    fireEvent.click(button(S.text.styleTitle));
    expect(onParagraphStyle).toHaveBeenCalledWith("title");
    // No chord is shown on either layout: the tooltip is the label alone.
    expect(button(S.text.alignCenter).title).toBe(S.text.alignCenter);
  });

  it("the Insert tab has no Solve Block button", () => {
    render(<Ribbon {...ribbonProps()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    expect(screen.queryByRole("button", { name: "Solve Block" })).toBeNull();
  });

  it("the Matrix tab offers insert above/below/left/right and Clear Cells", () => {
    const onEditorCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps()} />);
    rerender(
      <Ribbon
        {...ribbonProps({
          context: { kind: "matrix" },
          matrixControls: { canDeleteRow: true, canDeleteColumn: true },
          onEditorCommand,
        })}
      />,
    );
    const commands: Array<[string, string]> = [
      [S.ribbon.commands.insertRowAbove, "addRowAbove"],
      [S.ribbon.commands.insertRowBelow, "addRow"],
      [S.ribbon.commands.insertColumnLeft, "addColumnLeft"],
      [S.ribbon.commands.insertColumnRight, "addColumn"],
      [S.ribbon.commands.clearMatrixCells, "clearCells"],
    ];
    for (const [label, command] of commands) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onEditorCommand).toHaveBeenLastCalledWith(command);
    }
    expect(onEditorCommand).toHaveBeenCalledTimes(commands.length);
  });

  it("a matrix result with matrix elements offers Expand nested", () => {
    const onMatrixNested = vi.fn();
    const { rerender } = render(
      <Ribbon {...ribbonProps({ context: { kind: "matrix" }, matrixControls: null, matrixDisplay: { indices: false, nested: true }, onMatrixNested })} />,
    );
    const box = screen.getByRole("checkbox", { name: S.ribbon.commands.expandNested }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onMatrixNested).toHaveBeenCalledWith(false);
    // A matrix of numbers has nothing to expand: no checkbox.
    rerender(<Ribbon {...ribbonProps({ context: { kind: "matrix" }, matrixControls: null, matrixDisplay: { indices: false, nested: null }, onMatrixNested })} />);
    expect(screen.queryByRole("checkbox", { name: S.ribbon.commands.expandNested })).toBeNull();
  });

  it("on a matrix result the Matrix tab carries the display commands only", () => {
    const onMatrixDisplay = vi.fn();
    const onEditorCommand = vi.fn();
    // The tab appears while the context lasts: no context first, then the matrix result.
    const { rerender } = render(<Ribbon {...ribbonProps()} />);
    // A region that shows its indices: the box is checked.
    rerender(
      <Ribbon
        {...ribbonProps({
          context: { kind: "matrix" },
          matrixControls: null,
          matrixDisplay: { indices: true, nested: null },
          onMatrixDisplay,
          onEditorCommand,
        })}
      />,
    );
    const box = screen.getByRole("checkbox", { name: S.ribbon.commands.showIndices }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    // None of the commands that edit the matrix the user typed is shown on a result.
    for (const label of [S.ribbon.commands.insertRowAbove, S.ribbon.commands.clearMatrixCells, S.ribbon.commands.insertMatrix]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    fireEvent.click(box);
    expect(onMatrixDisplay).toHaveBeenCalledWith(false);
    expect(onEditorCommand).not.toHaveBeenCalled();
    // A region without indices: the same group, unchecked.
    rerender(
      <Ribbon
        {...ribbonProps({
          context: { kind: "matrix" },
          matrixDisplay: { indices: false, nested: null },
          onMatrixDisplay,
        })}
      />,
    );
    expect((screen.getByRole("checkbox", { name: S.ribbon.commands.showIndices }) as HTMLInputElement).checked).toBe(false);
    // No matrix result to act on: no checkbox at all.
    rerender(<Ribbon {...ribbonProps({ context: { kind: "matrix" }, matrixControls: { canDeleteRow: true, canDeleteColumn: true } })} />);
    expect(screen.queryByRole("checkbox", { name: S.ribbon.commands.showIndices })).toBeNull();
    expect(screen.getByRole("button", { name: S.ribbon.commands.insertRowAbove })).not.toBeNull();
  });

  it("the Size group shows the rows and columns of the matrix, read only", () => {
    const { rerender } = render(<Ribbon {...ribbonProps()} />);
    rerender(<Ribbon {...ribbonProps({ context: { kind: "matrix" }, matrixShape: { rows: 3, cols: 4 } })} />);
    const label = screen.getByTestId("matrix-shape");
    expect(label.textContent).toBe(S.matrixSize.shape(3, 4));
    expect(label.querySelector("input")).toBeNull();
    // A result that is not shown has no matrix to describe.
    rerender(<Ribbon {...ribbonProps({ context: { kind: "matrix" }, matrixShape: null })} />);
    expect(screen.queryByTestId("matrix-shape")).toBeNull();
  });

  it("the Display group carries the Elements to see before scrolling box", () => {
    const onMatrixSize = vi.fn();
    const onMatrixDisplay = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps()} />);
    // A matrix result: the threshold in force beside the display checkbox.
    rerender(
      <Ribbon
        {...ribbonProps({
          context: { kind: "matrix" },
          matrixDisplay: { indices: true, nested: null },
          matrixSize: { rows: 20, cols: 8 },
          onMatrixSize,
          onMatrixDisplay,
        })}
      />,
    );
    const box = () => screen.getByRole("group", { name: S.matrixSize.label });
    const rows = () => within(box()).getByRole("textbox", { name: S.matrixSize.rows }) as HTMLInputElement;
    const cols = () => within(box()).getByRole("textbox", { name: S.matrixSize.columns }) as HTMLInputElement;
    expect(rows().value).toBe("20");
    expect(cols().value).toBe("8");

    // A field commits on Enter, once, with the other field as it stands.
    fireEvent.change(rows(), { target: { value: "30" } });
    expect(onMatrixSize).not.toHaveBeenCalled();
    rows().focus();
    fireEvent.keyDown(rows(), { key: "Enter" });
    expect(onMatrixSize).toHaveBeenCalledWith(30, 8);
    // A field the display cannot read writes nothing and goes back to the value in force.
    fireEvent.change(cols(), { target: { value: "0" } });
    fireEvent.blur(cols());
    expect(onMatrixSize).toHaveBeenCalledTimes(1);
    expect(cols().value).toBe("8");
    // The value in force again: no edit either.
    fireEvent.change(cols(), { target: { value: "8" } });
    fireEvent.blur(cols());
    expect(onMatrixSize).toHaveBeenCalledTimes(1);

    // The threshold is the worksheet's, so the box is there for a matrix being typed, where there
    // is no result to show the checkbox for.
    rerender(
      <Ribbon
        {...ribbonProps({ context: { kind: "matrix" }, matrixControls: { canDeleteRow: true, canDeleteColumn: true }, matrixSize: { rows: 12, cols: 12 } })}
      />,
    );
    expect(rows().value).toBe("12");
    expect(cols().value).toBe("12");
    expect(screen.queryByRole("checkbox", { name: S.ribbon.commands.showIndices })).toBeNull();

    // No worksheet, no threshold to set.
    rerender(<Ribbon {...ribbonProps({ context: { kind: "matrix" }, matrixControls: { canDeleteRow: true, canDeleteColumn: true } })} />);
    expect(screen.queryByRole("group", { name: S.matrixSize.label })).toBeNull();
  });

  it("the Image tab offers Original Size, Replace… and Delete", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ onCommand })} />);
    // A selection appears: its tab is selected.
    rerender(<Ribbon {...ribbonProps({ context: { kind: "image", regionId: "im1" }, hasSelection: true, onCommand })} />);
    expect(selectedTab()).toBe(S.ribbon.tabs.image);
    for (const label of [S.ribbon.commands.originalSize, S.ribbon.commands.replaceImage, S.ribbon.commands.deleteRegion]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    expect(onCommand.mock.calls.map((call) => call[0])).toEqual(["imageOriginalSize", "imageReplace", "deleteRegions"]);
  });

  it("the Plot tab's Axes at Origin toggle shows its state and sends its command", () => {
    const onCommand = vi.fn();
    const boxed = { kind: "plot" as const, regionId: "p", plot: SPEC, selectedTraceId: null };
    // The tab appears when the context begins.
    const { rerender } = render(<Ribbon {...ribbonProps({ onCommand })} />);
    rerender(<Ribbon {...ribbonProps({ context: boxed, hasSelection: true, onCommand })} />);
    const toggle = () => screen.getByRole("button", { name: S.ribbon.commands.axesAtOrigin });
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    // No reference application chord on either layout: the tooltip is the label alone.
    expect(toggle().getAttribute("title")).toBe(S.ribbon.commands.axesAtOrigin);
    fireEvent.click(toggle());
    expect(onCommand).toHaveBeenCalledWith("plotToggleAxes");
    // A plot whose axes cross shows the toggle pressed.
    const crossed = { ...boxed, plot: applyPlotCommand(SPEC, "plotToggleAxes")! };
    rerender(<Ribbon {...ribbonProps({ context: crossed, hasSelection: true, onCommand })} />);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("has no placeholder buttons on any tab", () => {
    const contexts: RibbonContext[] = [
      { kind: "text" },
      { kind: "matrix" },
      { kind: "plot", regionId: "p", plot: SPEC, selectedTraceId: null },
      { kind: "area", regionId: "a", collapsed: true },
      { kind: "image", regionId: "im1" },
    ];
    for (const context of [null, ...contexts]) {
      cleanup();
      render(<Ribbon {...ribbonProps({ context })} />);
      for (const tab of screen.queryAllByRole("tab")) {
        fireEvent.click(tab);
        for (const button of within(screen.getByRole("tabpanel")).queryAllByRole("button")) {
          expect(button.getAttribute("title") ?? "", button.textContent ?? "").not.toMatch(/later|not available/i);
        }
      }
    }
  });

  it("puts the chord in tooltips", () => {
    {
      cleanup();
      render(<Ribbon {...ribbonProps()} />);
      fireEvent.click(screen.getByRole("tab", { name: "Math" }));
      const label = screen.getByRole("button", { name: S.ribbon.commands.labels });
      expect(label.getAttribute("title")).toBe(`${S.ribbon.commands.labels} (${shortcutLabel("label")})`);
      expect(screen.getByRole("button", { name: S.ribbon.search }).getAttribute("title")).toContain(shortcutLabel("commandPalette")!);
      fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
      expect(screen.getByRole("button", { name: S.ribbon.commands.recalculate }).getAttribute("title")).toBe(`${S.ribbon.commands.recalculate} (F5)`);
    }
  });

  it("the Calculate tab disables the selected regions and enables them again", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ onCommand })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
    const disable = () => screen.getByRole("button", { name: S.ribbon.commands.disableRegion }) as HTMLButtonElement;
    // nothing selected, nothing to disable.
    expect(disable().disabled).toBe(true);
    expect(disable().getAttribute("title")).toBe(S.ribbon.needsRegion);
    rerender(<Ribbon {...ribbonProps({ onCommand, hasSelection: true })} />);
    expect(disable().disabled).toBe(false);
    expect(disable().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(disable());
    expect(onCommand).toHaveBeenCalledWith("toggleRegionEnabled");
    // Every selected region disabled: the same button now enables them.
    rerender(<Ribbon {...ribbonProps({ onCommand, hasSelection: true, selectionDisabled: true })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
    const enable = screen.getByRole("button", { name: S.ribbon.commands.enableRegion });
    expect(enable.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(enable);
    expect(onCommand).toHaveBeenLastCalledWith("toggleRegionEnabled");
  });

  it("the search field opens the command palette and the compact toggle asks for compact mode", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ onCommand })} />);
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.search }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.compact }));
    expect(onCommand.mock.calls.map((c) => c[0])).toEqual(["commandPalette", "toggleCompactRibbon"]);
    rerender(<Ribbon {...ribbonProps({ compact: true })} />);
    expect(screen.getByRole("navigation", { name: S.ribbon.label }).classList.contains("compact")).toBe(true);
  });

  it("shows all worksheet file actions together with an icon and label", () => {
    const onCommand = vi.fn();
    render(<Ribbon {...ribbonProps({ onCommand, hasDoc: true })} />);
    fireEvent.click(screen.getByRole("tab", { name: "File" }));
    const file = within(screen.getByRole("tabpanel", { name: "File" }));
    const worksheet = within(file.getByRole("group", { name: "Worksheet" }));
    expect(worksheet.getAllByRole("button")).toHaveLength(5);
    expect(file.queryByRole("group", { name: "Worksheet actions" })).toBeNull();
    for (const [name, command] of [
      ["New worksheet", "newDocument"],
      ["Open worksheet…", "openDocument"],
      ["Save worksheet", "save"],
      ["Save worksheet as…", "saveAs"],
      ["Close worksheet", "closeDocument"],
    ]) {
      const button = worksheet.getByRole("button", { name });
      expect(button.querySelector(".ribbon-icon")).not.toBeNull();
      expect(button.classList.contains("icon-only")).toBe(false);
      fireEvent.click(button);
      expect(onCommand).toHaveBeenLastCalledWith(command);
    }
  });

  it("puts Import the reference application, Export PDF and Print in the IO group of the Document tab; the title bar has no File menu", () => {
    const onCommand = vi.fn();
    render(
      <>
        <TitleBar doc={null} modified={false} recentFiles={[]} recentProjects={[]} onOpenRecentProject={vi.fn()} onNew={vi.fn()} onOpen={vi.fn()} onOpenRecent={vi.fn()} onSave={vi.fn()} onSaveAs={vi.fn()} onUndo={vi.fn()} onRedo={vi.fn()} />
        <Ribbon {...ribbonProps({ onCommand, hasDoc: true })} />
      </>,
    );
    expect(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).queryByRole("tab", { name: "File" })).toBeNull();
    expect(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).queryByRole("button", { name: "Import" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "File" }));
    const io = screen.getByRole("group", { name: S.ribbon.groups.io });
    const labels = within(io).getAllByRole("button").map((button) => button.textContent ?? "");
    const wanted = [S.ribbon.commands.importMcdx, S.ribbon.commands.exportPdf, S.ribbon.commands.print];
    expect(labels).toHaveLength(wanted.length);
    wanted.forEach((label, at) => expect(labels[at]).toContain(label));
    fireEvent.click(within(io).getByRole("button", { name: S.ribbon.commands.importMcdx }));
    expect(onCommand).toHaveBeenCalledWith("importMcdx");
  });

  it("puts Page Setup in a Page group of the Document tab, disabled while no worksheet is open", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ onCommand, hasDoc: true })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    const page = screen.getByRole("group", { name: S.ribbon.groups.page });
    const button = within(page).getByRole("button", { name: S.ribbon.commands.pageSetup });
    // No chord on either layout, so the tooltip is the label alone.
    expect(button.getAttribute("title")).toBe(S.ribbon.commands.pageSetup);
    fireEvent.click(button);
    expect(onCommand).toHaveBeenCalledWith("pageSetup");
    rerender(<Ribbon {...ribbonProps({ hasDoc: false })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    expect(
      (within(screen.getByRole("group", { name: S.ribbon.groups.page })).getByRole("button", { name: S.ribbon.commands.pageSetup }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("puts Header and Footer next to Page Setup, same group, same no-chord rule", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ onCommand, hasDoc: true })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    const page = screen.getByRole("group", { name: S.ribbon.groups.page });
    const buttons = within(page).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([S.ribbon.commands.pageSetup, S.ribbon.commands.headerFooter]);
    expect(buttons.every((button) => button.querySelector(".ribbon-icon"))).toBe(true);
    const button = within(page).getByRole("button", { name: S.ribbon.commands.headerFooter });
    // No reference application chord is known on either layout, so the tooltip is the label alone.
    expect(button.getAttribute("title")).toBe(S.ribbon.commands.headerFooter);
    fireEvent.click(button);
    expect(onCommand).toHaveBeenCalledWith("headerFooter");
    rerender(<Ribbon {...ribbonProps({ hasDoc: false })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    expect(
      (within(screen.getByRole("group", { name: S.ribbon.groups.page })).getByRole("button", { name: S.ribbon.commands.headerFooter }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("command palette parity", () => {
  it("lists the commands of the new places", () => {
    const ids = new Set(buildCommandItems().map((item) => item.id));
    for (const cmd of [...PLOT_COMMANDS, "toggleArea", "toggleRegionEnabled", "imageOriginalSize", "imageReplace", "insertPlot", "insertInclude", "importMcdx", "nextProblem", "previousProblem", "problemsPanel", "sidePanel", "toggleCompactRibbon", "worksheetFormat", "calculationSettings", "increaseFontSize", "decreaseFontSize", "mathFont", "resetMathFont", "matrixShowIndices"]) {
      expect(ids.has(`cmd:${cmd}`), cmd).toBe(true);
    }
    for (const command of ["addRowAbove", "addRow", "addColumnLeft", "addColumn", "clearCells", "deleteRow", "deleteColumn", "selectRow", "selectColumn", "label", "literalSubscript", "toggleBreak"]) expect(ids.has(`matrix:${command}`), command).toBe(true);
  });

  it("gives Original Size, Replace and Disable Region no chord on either layout: no reference application chord is known", () => {
    {
      expect(shortcutLabel("imageOriginalSize")).toBeNull();
      expect(shortcutLabel("imageReplace")).toBeNull();
      expect(shortcutLabel("toggleRegionEnabled")).toBeNull();
      const items = buildCommandItems();
      for (const cmd of ["imageOriginalSize", "imageReplace", "toggleRegionEnabled"]) {
        expect(items.find((item) => item.id === `cmd:${cmd}`)?.shortcut ?? null).toBeNull();
      }
    }
  });

  it("gives Axes at Origin no chord on either layout: no reference application chord is known", () => {
    {
      const item = buildCommandItems().find((entry) => entry.id === "cmd:plotToggleAxes");
      expect(item?.shortcut ?? null).toBeNull();
      expect(item?.label).toBe("Plot: axes at the origin");
    }
  });

  it("gives Calculation Settings… no chord on either layout: no reference application chord is known", () => {
    {
      expect(shortcutLabel("calculationSettings")).toBeNull();
      const item = buildCommandItems().find((entry) => entry.id === "cmd:calculationSettings");
      expect(item?.shortcut ?? null).toBeNull();
      expect(item?.label).toBe("Calculation settings…");
    }
  });

  it("the Math Formatting group of the Calculate tab needs a math region and has no chord", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ hasDoc: false, onCommand })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    const commands = [
      S.ribbon.commands.decreaseFontSize,
      S.ribbon.commands.increaseFontSize,
      S.ribbon.commands.mathFont,
      S.ribbon.commands.resetMathFont,
    ];
    // no target inside the worksheet, so the four commands are disabled and say why.
    for (const command of commands) {
      expect(button(command).disabled).toBe(true);
      expect(button(command).title).toBe(S.mathFont.noRegion);
    }
    rerender(<Ribbon {...ribbonProps({ hasDoc: true, canFormatMath: true, onCommand })} />);
    for (const command of commands) {
      // No chord on the US or the Italian layout, so the tooltip is the label alone.
      expect(button(command).disabled).toBe(false);
      expect(button(command).title).toBe(command);
    }
    fireEvent.click(button(S.ribbon.commands.increaseFontSize));
    expect(onCommand).toHaveBeenCalledWith("increaseFontSize");
    expect(screen.getByRole("group", { name: S.ribbon.groups.mathFormatting })).toBeTruthy();
    {
      for (const cmd of ["increaseFontSize", "decreaseFontSize", "mathFont", "resetMathFont"]) {
        expect(shortcutLabel(cmd)).toBeNull();
        expect(buildCommandItems().find((item) => item.id === `cmd:${cmd}`)?.shortcut ?? null).toBeNull();
      }
    }
    // The palette finds them by what a user would type.
    expect(searchCommands(buildCommandItems(), "increase font").some((item) => item.id === "cmd:increaseFontSize")).toBe(true);
    expect(searchCommands(buildCommandItems(), "highlight colour").some((item) => item.id === "cmd:mathFont")).toBe(true);
  });

  it("the Label Styles group of the Calculate tab needs only a worksheet and has no chord", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<Ribbon {...ribbonProps({ hasDoc: false, onCommand })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    // no target inside the worksheet, only an open worksheet.
    expect(button(S.ribbon.commands.labelStyles).disabled).toBe(true);
    expect(button(S.ribbon.commands.labelStyles).title).toBe(S.labelStyles.needsWorksheet);
    rerender(<Ribbon {...ribbonProps({ hasDoc: true, onCommand })} />);
    expect(button(S.ribbon.commands.labelStyles).disabled).toBe(false);
    // No chord on the US or the Italian layout, so the tooltip is the label alone.
    expect(button(S.ribbon.commands.labelStyles).title).toBe(S.ribbon.commands.labelStyles);
    fireEvent.click(button(S.ribbon.commands.labelStyles));
    expect(onCommand).toHaveBeenCalledWith("labelStyles");
    expect(screen.getByRole("group", { name: S.ribbon.groups.labelStyles })).toBeTruthy();
    {
      expect(shortcutLabel("labelStyles")).toBeNull();
      const item = buildCommandItems().find((entry) => entry.id === "cmd:labelStyles");
      expect(item?.shortcut ?? null).toBeNull();
      expect(item?.label).toBe("Label styles…");
    }
    // The palette finds it by what a user would type.
    expect(searchCommands(buildCommandItems(), "italic label style").some((item) => item.id === "cmd:labelStyles")).toBe(true);
  });

  it("gives Show indices a palette entry and no chord on either layout", () => {
    {
      expect(shortcutLabel("matrixShowIndices")).toBeNull();
      const item = buildCommandItems().find((entry) => entry.id === "cmd:matrixShowIndices");
      expect(item?.label).toBe("Matrix: show indices");
      expect(item?.shortcut ?? null).toBeNull();
    }
    // It is found by what a user would type, on both layouts (search is over English labels).
    expect(searchCommands(buildCommandItems(), "show indices").some((item) => item.id === "cmd:matrixShowIndices")).toBe(true);
    expect(searchCommands(buildCommandItems(), "matrix index").some((item) => item.id === "cmd:matrixShowIndices")).toBe(true);
  });

  it("gives Worksheet Format… no chord on either layout: no reference application chord is known", () => {
    {
      expect(shortcutLabel("worksheetFormat")).toBeNull();
      const item = buildCommandItems().find((entry) => entry.id === "cmd:worksheetFormat");
      expect(item?.shortcut ?? null).toBeNull();
      expect(item?.label).toBe("Worksheet format…");
    }
  });

  it("searchable Header and footer carries no chord on either layout", () => {
    {
      expect(shortcutLabel("headerFooter")).toBeNull();
      const item = buildCommandItems().find((entry) => entry.id === "cmd:headerFooter");
      expect(item?.label).toBe("Header and footer…");
      expect(item?.shortcut ?? null).toBeNull();
    }
    // The palette finds it by what a reference application user would type.
    expect(searchCommands(buildCommandItems(), "footer")[0]?.id).toBe("cmd:headerFooter");
    expect(searchCommands(buildCommandItems(), "page number")[0]?.id).toBe("cmd:headerFooter");
  });

  it("searchable Page setup carries no chord either: no reference application chord is known", () => {
    {
      expect(shortcutLabel("pageSetup")).toBeNull();
      const item = buildCommandItems().find((entry) => entry.id === "cmd:pageSetup");
      expect(item?.label).toContain("Page setup");
      expect(item?.shortcut ?? null).toBeNull();
    }
    // The palette searches English labels on both layouts.
    expect(searchCommands(buildCommandItems(), "margins page")[0]?.id).toBe("cmd:pageSetup");
    expect(searchCommands(buildCommandItems(), "page orientation")[0]?.id).toBe("cmd:pageSetup");
  });

  it("keeps the reference application import searchable and the palette shortcut available on US and Italian layouts", () => {
    {
      expect(buildCommandItems().some((item) => item.id === "cmd:importMcdx")).toBe(true);
      expect(shortcutLabel("commandPalette")).toBe("Ctrl+K");
    }
  });
});

describe("the sections of an insert panel", () => {
  it("gives every palette one chip per section of its own list, in list order", () => {
    for (const kind of PALETTE_KINDS) {
      expect(panelSections(kind, "", "").map((section) => section.title)).toEqual(
        paletteSections(kind).map((section) => section.title),
      );
    }
    // A section per dimension in the Units palette: one chip per dimension.
    expect(panelSections("units", "", "")).toHaveLength(UNIT_GROUPS.length);
  });

  it("finds the section at the top of the list and where a chip scrolls it", () => {
    const tops = [0, 300, 600];
    expect(topSection(tops, 0)).toBe(0);
    expect(topSection(tops, 299)).toBe(0);
    expect(topSection(tops, 300)).toBe(1);
    expect(topSection(tops, 5000)).toBe(2);
    expect(scrollTarget(tops, 1, 2000)).toBe(300);
    // The last sections cannot reach the top: the list scrolls as far as it goes.
    expect(scrollTarget(tops, 2, 400)).toBe(400);
    expect(scrollTarget(tops, 0, -10)).toBe(0);
  });
});

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);

async function openWith(extra: ViewRegion[]) {
  const backend = createMockBackend({ fast: true, extraRegions: extra });
  render(<App backend={backend} />);
  await waitFor(() => expect(region(extra[0].id)).not.toBeNull());
  return backend;
}

describe("contextual tabs in the window (mock backend)", () => {
  it("a selected plot brings the Plot tab; its commands change the plot as undo steps; deselecting removes it", async () => {
    await openWith([PLOT]);
    expect(screen.queryByRole("tab", { name: S.ribbon.tabs.plot })).toBeNull();
    fireEvent.pointerDown(region("pl1")!, { button: 0, clientX: 420, clientY: 820 });
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 420, clientY: 820 }));
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    expect(screen.getByRole("tab", { name: S.ribbon.tabs.trace })).toBeTruthy();
    const logY = screen.getByRole("button", { name: S.ribbon.commands.logY });
    expect(logY.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(logY);
    await waitFor(() => expect(screen.getByRole("button", { name: S.ribbon.commands.logY }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("tab", { name: S.ribbon.tabs.trace }));
    expect((screen.getByRole("button", { name: S.ribbon.commands.removeTrace }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.addTrace }));
    await waitFor(() => expect((screen.getByRole("button", { name: S.ribbon.commands.removeTrace }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect((screen.getByRole("button", { name: S.ribbon.commands.removeTrace }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: S.ribbon.tabs.plot }));
    expect(screen.getByRole("button", { name: S.ribbon.commands.logY }).getAttribute("aria-pressed")).toBe("true");
    // Escape clears the selection: both Plot and Trace tabs leave, Insert is back.
    await act(async () => void fireEvent.keyDown(window, { key: "Escape", code: "Escape" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: S.ribbon.tabs.plot })).toBeNull());
    expect(screen.queryByRole("tab", { name: S.ribbon.tabs.trace })).toBeNull();
    expect(screen.getByRole("tab", { name: "Insert" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Remove Trace removes the selected trace, keeps one trace, and is one undo step", async () => {
    await openWith([TWO_TRACE_PLOT]);
    fireEvent.pointerDown(region("pl1")!, { button: 0, clientX: 420, clientY: 820 });
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 420, clientY: 820 }));
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    fireEvent.click(screen.getByRole("tab", { name: S.ribbon.tabs.trace }));
    const remove = () => screen.getByRole("button", { name: S.ribbon.commands.removeTrace }) as HTMLButtonElement;
    const traceSlots = () => [...region("pl1")!.querySelectorAll<HTMLElement>("[data-trace-id]")];
    expect(remove().disabled).toBe(true);
    fireEvent.pointerDown(traceSlots().find((slot) => slot.dataset.traceId === "trace-1")!, { button: 0 });
    await waitFor(() => expect(remove().disabled).toBe(false));
    fireEvent.click(remove());
    await waitFor(() =>
      expect(traceSlots().every((slot) => slot.dataset.traceId === "trace-2")).toBe(true),
    );
    expect(remove().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() =>
      expect(new Set(traceSlots().map((slot) => slot.dataset.traceId))).toEqual(new Set(["trace-1", "trace-2"])),
    );
  });

  it("the command palette lists no plot command without a selected plot", async () => {
    await openWith([PLOT]);
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const dialog = await screen.findByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(dialog).getByLabelText(S.commands.search), { target: { value: "logarithmic y" } });
    expect(within(dialog).queryByText("Plot: logarithmic y axis")).toBeNull();
  });

  it("the command palette lists no Image tab command without a selected image", async () => {
    await openWith([PLOT]);
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const dialog = await screen.findByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(dialog).getByLabelText(S.commands.search), { target: { value: "image original size" } });
    expect(within(dialog).queryByText("Image: original size")).toBeNull();
  });

  it("a selected area brings the Area tab, whose button collapses and expands it", async () => {
    await openWith([AREA]);
    const header = region("ar1")!.querySelector(".area-header")!;
    fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 300 });
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 300 }));
    // the header press selected the area without collapsing it
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.area));
    expect(region("ar1")!.querySelector<HTMLElement>("[data-testid=area]")!.dataset.collapsed).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.collapseArea }));
    await waitFor(() => expect(region("ar1")!.querySelector<HTMLElement>("[data-testid=area]")!.dataset.collapsed).toBe("true"));
    await waitFor(() => expect(screen.getByRole("button", { name: S.ribbon.commands.expandArea })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.expandArea }));
    await waitFor(() => expect(region("ar1")!.querySelector<HTMLElement>("[data-testid=area]")!.dataset.collapsed).toBe("false"));
    expect(screen.getByRole("button", { name: S.ribbon.commands.collapseArea })).not.toBeNull();
  });

  it("compact mode is remembered per user", async () => {
    await openWith([PLOT]);
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.compact }));
    expect(screen.getByRole("navigation", { name: S.ribbon.label }).classList.contains("compact")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem("equavela.ribbon")!)).toEqual({ compact: true });
    cleanup();
    await openWith([PLOT]);
    expect(screen.getByRole("navigation", { name: S.ribbon.label }).classList.contains("compact")).toBe(true);
  });

  /** The chips of a panel's section row. */
  const chipsOf = (panel: HTMLElement) =>
    within(within(panel).getByRole("group", { name: S.ribbon.palette.sections })).getAllByRole("button");

  /** Gives the panel's list a layout jsdom does not compute: sections 400 px apart, a 200 px window. */
  function stubList(panel: HTMLElement) {
    const list = panel.querySelector<HTMLElement>(".palette-body")!;
    const sections = [...panel.querySelectorAll<HTMLElement>(".palette-section")];
    const tops = sections.map((_, index) => index * 400);
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: tops[tops.length - 1] + 100 });
    sections.forEach((section, index) => Object.defineProperty(section, "offsetTop", { configurable: true, value: tops[index] }));
    return { list, tops };
  }

  it("the insert panel's chips are the groups of the open palette, with no palette switch", async () => {
    await openWith([PLOT]);
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.operators }));
    const panel = screen.getByRole("dialog", { name: S.ribbon.palette.operators });
    const titles = paletteSections("operators").map((section) => section.title);
    expect(chipsOf(panel).map((chip) => chip.textContent)).toEqual(titles);
    // The panel is not a second way to the other palettes: that is the Math tab's buttons now.
    expect(within(panel).queryAllByRole("button", { name: /^Switch to / })).toEqual([]);
    // A panel opens with its list at the top: the first chip is the current one.
    expect(chipsOf(panel)[0].getAttribute("aria-current")).toBe("true");
    expect(chipsOf(panel)[1].getAttribute("aria-current")).toBeNull();
    // A press with the pointer does not take the keyboard from the math editor.
    const press = createEvent.mouseDown(chipsOf(panel)[2]);
    fireEvent(chipsOf(panel)[2], press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("a chip scrolls its section to the top and the highlight follows the list", async () => {
    await openWith([PLOT]);
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.operators }));
    const panel = screen.getByRole("dialog", { name: S.ribbon.palette.operators });
    const { list, tops } = stubList(panel);
    fireEvent.click(chipsOf(panel)[2]);
    expect(list.scrollTop).toBe(tops[2]);
    expect(chipsOf(panel)[2].getAttribute("aria-current")).toBe("true");
    expect(chipsOf(panel)[0].getAttribute("aria-current")).toBeNull();
    // The panel stays open and keeps its palette: a chip navigates, it does not insert.
    expect(screen.getByRole("dialog", { name: S.ribbon.palette.operators })).not.toBeNull();
    // The highlight follows a scroll of the wheel, the bar or the keyboard.
    list.scrollTop = tops[4];
    fireEvent.scroll(list);
    expect(chipsOf(panel)[4].getAttribute("aria-current")).toBe("true");
    expect(chipsOf(panel)[2].getAttribute("aria-current")).toBeNull();
    // The last sections cannot reach the top: the list scrolls as far as it can and their chip stays on.
    const last = tops.length - 1;
    fireEvent.click(chipsOf(panel)[last]);
    expect(list.scrollTop).toBe(tops[last] - 100);
    fireEvent.scroll(list);
    expect(chipsOf(panel)[last].getAttribute("aria-current")).toBe("true");
    // A real scroll takes the highlight back to the section that is at the top.
    list.scrollTop = tops[5];
    fireEvent.scroll(list);
    expect(chipsOf(panel)[5].getAttribute("aria-current")).toBe("true");
    expect(chipsOf(panel)[last].getAttribute("aria-current")).toBeNull();
  });

  it("with a query only the chips of the groups with matches stay", async () => {
    await openWith([PLOT]);
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.operators }));
    const panel = screen.getByRole("dialog", { name: S.ribbon.palette.operators });
    fireEvent.change(within(panel).getByLabelText(S.ribbon.palette.search), { target: { value: "psi" } });
    // psi is a unit: the only group left is the Pressure group of the Units palette.
    expect(chipsOf(panel).map((chip) => chip.textContent)).toEqual([`${S.ribbon.paletteShort.units}: Pressure`]);
    expect(chipsOf(panel)[0].getAttribute("aria-current")).toBe("true");
    expect(within(panel).getByRole("button", { name: "psi" })).not.toBeNull();
    // One chip per section shown, in list order.
    expect([...panel.querySelectorAll(".palette-section h3")].map((heading) => heading.textContent)).toEqual(
      chipsOf(panel).map((chip) => chip.textContent),
    );
  });

  it("the Units palette has a chip per dimension, through a prefix change", async () => {
    await openWith([PLOT]);
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.unitsPalette }));
    const panel = screen.getByRole("dialog", { name: S.ribbon.palette.units });
    // A section per dimension: the longest chip row, which the stylesheet wraps
    // (styles/paletteSections.test.ts, since jsdom applies no stylesheet).
    const dimensions = UNIT_GROUPS.map((group) => group.title);
    expect(chipsOf(panel).map((chip) => chip.textContent)).toEqual(dimensions);
    // A prefix regroups the entries, not the groups: the chips stay one per dimension.
    fireEvent.click(within(within(panel).getByRole("group", { name: S.ribbon.palette.prefixes })).getAllByRole("button")[1]);
    expect(within(panel).getByRole("button", { name: "pm" })).not.toBeNull();
    expect(chipsOf(panel).map((chip) => chip.textContent)).toEqual(dimensions);
  });

  it("disables the selected region, dims it and undoes it as one step", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.pointerDown(region("m1")!, { button: 0 });
    await waitFor(() => expect(region("m1")?.classList.contains("selected")).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
    expect((screen.getByRole("button", { name: S.ribbon.commands.disableRegion }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.disableRegion }));
    await waitFor(() => expect(region("m1")!.classList.contains("disabled")).toBe(true));
    // The same button now offers the way back, pressed.
    fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
    const enable = await screen.findByRole("button", { name: S.ribbon.commands.enableRegion });
    expect(enable.getAttribute("aria-pressed")).toBe("true");
    await act(async () => void fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true }));
    await waitFor(() => expect(region("m1")!.classList.contains("disabled")).toBe(false));
    expect(screen.getByRole("button", { name: S.ribbon.commands.disableRegion })).not.toBeNull();
  });

  it("a disabled region can be enabled again from the same button", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.pointerDown(region("m1")!, { button: 0 });
    await waitFor(() => expect(region("m1")?.classList.contains("selected")).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.disableRegion }));
    await waitFor(() => expect(region("m1")!.classList.contains("disabled")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: S.ribbon.commands.enableRegion }));
    await waitFor(() => expect(region("m1")!.classList.contains("disabled")).toBe(false));
  });

  it("from the command palette without a selection it says to select a region first", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const dialog = await screen.findByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(dialog).getByLabelText(S.commands.search), { target: { value: "disable region" } });
    await act(async () => void fireEvent.keyDown(dialog, { key: "Enter" }));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.ribbon.needsRegion));
  });
});

// one fixed ribbon body height. jsdom has no layout, so the tests hold the
// CSS contract and the structure; the pixels are measured in the browser.
describe("the ribbon body has one fixed height", () => {
  const css = readFileSync("src/styles/chrome.css", "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = (selector: string) =>
    [...css.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g)]
      .filter((m) => m[2].split(",").some((s) => s.trim() === selector))
      .map((m) => m[3]);

  const CONTEXTS: Record<string, RibbonContext> = {
    text: { kind: "text" },
    matrix: { kind: "matrix" },
    plot: { kind: "plot", regionId: "pl1", plot: SPEC, selectedTraceId: null },
    area: { kind: "area", regionId: "ar1", collapsed: false },
    image: { kind: "image", regionId: "im1" },
  };
  const withContext = (context: RibbonContext) =>
    ribbonProps({ context, matrixControls: { canDeleteRow: true, canDeleteColumn: true } });

  it("the body height is one constant that no tab, width or mode overrides", () => {
    const base = rules(".ribbon-body").join("\n");
    expect(base).toMatch(/height:\s*var\(--ribbon-body-height\)/);
    expect(base).not.toMatch(/min-height|max-height|flex-wrap/);
    expect(base).toMatch(/overflow-y:\s*hidden/);
    expect(base).toMatch(/overflow-x:\s*auto/);
    expect(css.match(/--ribbon-body-height:\s*\d+px/g)).toHaveLength(1);
    // Compact mode (by choice or narrow window) only switches the variable to the compact height
    //; no rule sets a height of its own, and no group wraps.
    expect(rules(".ribbon.compact").join("\n")).toMatch(/--ribbon-body-height:\s*var\(--ribbon-compact-height\)/);
    for (const selector of [".ribbon.compact .ribbon-body", ".ribbon .ribbon-body"]) {
      expect(rules(selector).join("\n")).not.toMatch(/height\s*:/);
    }
    for (const selector of [".ribbon-group", ".ribbon-commands", ".ribbon-fields"]) {
      expect(rules(selector).join("\n")).not.toMatch(/flex-wrap:\s*wrap/);
    }
  });

  it("the body is as low as its tallest content: three 18 px rows and a group title", () => {
    const px = (name: string) => Number(css.match(new RegExp(`${name}:\\s*(\\d+)px`))![1]);
    const body = px("--ribbon-body-height");
    expect(body).toBe(80);
    expect(rules(".ribbon-group").join("\n")).toMatch(
      /height:\s*calc\(var\(--ribbon-body-height\) - var\(--ribbon-body-top\) - var\(--ribbon-scrollbar\)\)/,
    );
    expect(rules(".ribbon-field-row").join("\n")).toMatch(/height:\s*18px/);
    expect(rules(".plot-trace-list").join("\n")).toMatch(/repeat\(3, 18px\)/);
    const title = Number(rules(".ribbon-group-title").join("\n").match(/line-height:\s*(\d+)px/)![1]);
    // Three rows of 18 px with 1 px gaps, the title, the top padding and the scrollbar reserve.
    expect(3 * 18 + 2 + title + px("--ribbon-body-top") + px("--ribbon-scrollbar")).toBeLessThanOrEqual(body);
  });

  it("compact mode keeps a field to its control and hides the hints, so nothing is clipped", () => {
    expect(rules(".ribbon.compact .ribbon-hint").join("\n")).toMatch(/display:\s*none/);
    expect(rules(".ribbon.compact .ribbon-field > .ribbon-field-label").join("\n")).toMatch(/display:\s*none/);
    expect(rules(".ribbon.compact .ribbon-field").join("\n")).toMatch(/flex-direction:\s*row/);
  });

  it("compact mode is one row of icons in a lower body", () => {
    const px = (name: string) => Number(css.match(new RegExp(`${name}:\\s*(\\d+)px`))![1]);
    const compact = px("--ribbon-compact-height");
    expect(compact).toBeLessThan(px("--ribbon-body-height") / 2);
    // One icon button (16 px icon line, 3 px padding twice, 1 px border twice) fits above the scrollbar.
    expect(16 + 2 * 3 + 2 + px("--ribbon-body-top") + px("--ribbon-scrollbar")).toBeLessThanOrEqual(compact);
    for (const selector of [".ribbon.compact .ribbon-commands.stacked", ".ribbon.compact .ribbon-fields", ".ribbon.compact .plot-trace-list"]) {
      expect(rules(selector).join("\n")).toMatch(/grid-template-rows:\s*auto/);
    }
  });

  it("renders one contextual body whose children are groups", () => {
    const contexts = Object.values(CONTEXTS);
    const { rerender } = render(<Ribbon {...withContext(contexts[0])} />);
    const body = document.querySelector(".ribbon-body")!;
    for (const context of contexts) {
      rerender(<Ribbon {...withContext(context)} />);
      expect(document.querySelectorAll(".ribbon-body")).toHaveLength(1);
      expect(document.querySelector(".ribbon-body")).toBe(body);
      expect(body.children.length).toBeGreaterThan(0);
      for (const child of body.children) expect(child.classList.contains("ribbon-group")).toBe(true);
    }
    rerender(<Ribbon {...ribbonProps()} />);
    expect(screen.getByRole("tabpanel", { name: "Insert" })).toBe(body);
  });

  it("Math exposes the font-size commands by name and tooltip", () => {
    render(<Ribbon {...ribbonProps({ canFormatMath: true })} />);
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    for (const label of [S.ribbon.commands.decreaseFontSize, S.ribbon.commands.increaseFontSize]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.textContent).toContain(label);
      expect(button.getAttribute("title")).toContain(label);
    }
    expect(screen.getByRole("button", { name: S.ribbon.commands.mathFont }).classList.contains("icon-only")).toBe(false);
  });
});

describe("the Code and Image file tabs", () => {
  it("shows only the Code tab for a text file and sends its commands", () => {
    const onCommand = vi.fn();
    render(<Ribbon {...ribbonProps({ onCommand, file: { kind: "text", julia: true, modified: true, moduleLoaded: false } })} />);
    const nav = screen.getByRole("navigation", { name: S.ribbon.label });
    expect(within(nav).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Code"]);
    fireEvent.click(within(nav).getByRole("button", { name: "Toggle line comment" }));
    fireEvent.click(within(nav).getByRole("button", { name: "Find" }));
    fireEvent.click(within(nav).getByRole("checkbox", { name: S.juliaModule.load }));
    expect(onCommand.mock.calls.map(([cmd]) => cmd)).toEqual(["codeToggleComment", "codeFind", "fileToggleModule"]);
    expect(within(nav).getByRole("button", { name: "Restart kernel" })).toBeTruthy();
  });

  it("has no Julia group for other text files and an Image file tab for images", () => {
    const { rerender } = render(<Ribbon {...ribbonProps({ file: { kind: "text", julia: false, modified: false, moduleLoaded: null } })} />);
    expect(screen.queryByRole("button", { name: "Restart kernel" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<Ribbon {...ribbonProps({ file: { kind: "image", julia: false, modified: false, moduleLoaded: null } })} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Image file"]);
    expect(screen.getByRole("button", { name: "Show in folder" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Find" })).toBeNull();
  });
});

it("shows an arrow at a ribbon edge with more commands past it", async () => {
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
  const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get() { return this.classList?.contains("ribbon-body") ? 2000 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList?.contains("ribbon-body") ? 500 : 0; } });
  try {
    render(<Ribbon {...ribbonProps({ context: { kind: "plot", regionId: "p", plot: SPEC, selectedTraceId: null } })} />);
    const right = await waitFor(() => screen.getByTestId("ribbon-scroll-right"));
    expect(screen.queryByTestId("ribbon-scroll-left")).toBeNull();
    const body = document.querySelector<HTMLElement>(".ribbon-body")!;
    body.scrollBy = ((options: ScrollToOptions) => { body.scrollLeft += options.left ?? 0; body.dispatchEvent(new Event("scroll")); }) as never;
    fireEvent.click(right);
    await waitFor(() => expect(screen.getByTestId("ribbon-scroll-left")).toBeTruthy());
  } finally {
    if (width) Object.defineProperty(HTMLElement.prototype, "scrollWidth", width);
    if (client) Object.defineProperty(HTMLElement.prototype, "clientWidth", client);
  }
});
