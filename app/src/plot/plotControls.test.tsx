// the plot controls live in the contextual Plot tab, the plot region keeps only the plot
// and its math placeholders, selecting a trace drives the tab, and an outside click hides it all.
// Runs on the mock backend.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("./plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), relayout: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(cleanup);

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const plotEl = () => document.querySelector<HTMLElement>('[data-testid^="plot-r"]');
const tabPanel = () => screen.getByRole("tabpanel", { name: S.ribbon.tabs.plot });
const tracePanel = () => screen.getByRole("tabpanel", { name: S.ribbon.tabs.trace });
const openTraceTab = () => fireEvent.click(screen.getByRole("tab", { name: S.ribbon.tabs.trace }));
const openPlotTab = () => fireEvent.click(screen.getByRole("tab", { name: S.ribbon.tabs.plot }));
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
const removeButton = () => screen.getByRole("button", { name: S.ribbon.commands.removeTrace }) as HTMLButtonElement;
const traceOptions = () => within(screen.getByRole("listbox", { name: S.plot.traceList })).getAllByRole("option");
const ySlots = (plot: HTMLElement) =>
  [...plot.querySelectorAll<HTMLElement>("[data-trace-id]")].filter((slot) => slot.getAttribute("aria-label") === S.plot.yExpression);

/** Opens the demo and inserts a plot, which is the selection afterwards. */
async function insertPlot() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
  return waitFor(() => {
    expect(plotEl()).not.toBeNull();
    return plotEl() as HTMLElement;
  });
}

const press = async (target: Element) => {
  await act(async () => {
    fireEvent.pointerDown(target, { button: 0, clientX: 5, clientY: 5 });
  });
};

/** Clicking the empty page, as a user clicks outside the plot. */
const clickOutside = async () => {
  await act(async () => {
    fireEvent.pointerDown(document.querySelector(".page")!, { button: 0, clientX: 600, clientY: 1100 });
    fireEvent.pointerUp(window, { button: 0, clientX: 600, clientY: 1100 });
  });
};

describe("the plot region holds only the plot and its placeholders", () => {
  it("contains no select, button, input or details, selected or not", async () => {
    const plot = await insertPlot();
    const controls = () => plot.querySelectorAll("select, button, input, details, summary, label");
    expect(controls()).toHaveLength(0);
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    await clickOutside();
    await waitFor(() => expect(plot.getAttribute("data-editing")).toBe("false"));
    expect(controls()).toHaveLength(0);
    // Only the plot canvas and the math placeholders (and, when needed, a status note) are children.
    for (const child of [...plot.children]) {
      const classes = child.className.toString();
      // The legend is part of the plot and holds no control, only spans; the outer area that
      // moves the plot covers the margins, never a placeholder or the
      // plot, and holds no control either. The hidden mirror only measures the placeholders.
      expect(/plot-canvas|plot-legend|plot-slots|plot-note|plot-badge|plot-move-area|plot-measure/.test(classes), classes).toBe(true);
    }
  });

  it("puts every placeholder inside a margin container, so none can sit over the plot or another placeholder", async () => {
    const plot = await insertPlot();
    for (const slot of within(plot).getAllByTestId("plot-slot")) {
      expect(slot.closest(".plot-slots"), slot.getAttribute("aria-label") ?? "").not.toBeNull();
    }
    // Several traces share the one y column: still no other container.
    openTraceTab();
    for (let i = 2; i <= 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.addTrace }));
      await waitFor(() => expect(traceOptions()).toHaveLength(i));
    }
    expect(ySlots(plot)).toHaveLength(5);
    expect(plot.querySelectorAll(".plot-slots.y")).toHaveLength(1);
    for (const slot of ySlots(plot)) expect(slot.closest(".plot-slots.y .expressions")).not.toBeNull();
  });
});

describe("cursor coordinates in the plot area", () => {
  it("shows transformed axis values only while the pointer is inside the data rectangle", async () => {
    await insertPlot();
    const host = document.querySelector<HTMLElement>(".plot-canvas")!;
    host.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100,
      toJSON: () => ({}),
    });
    Object.assign(host, { _fullLayout: {
      xaxis: { _offset: 10, _length: 100, p2d: (pixel: number) => pixel / 10 },
      yaxis: { _offset: 20, _length: 80, p2d: (pixel: number) => 10 - pixel / 8 },
    } });
    fireEvent.pointerMove(host, { clientX: 70, clientY: 80 });
    await waitFor(() => expect(screen.getByTestId("plot-cursor-coordinates").textContent).toBe("x = 5; y = 5"));
    expect(screen.getByTestId("plot-cursor-coordinates").classList.contains("no-print")).toBe(true);
    fireEvent.pointerLeave(host);
    await waitFor(() => expect(screen.queryByTestId("plot-cursor-coordinates")).toBeNull());
  });
});

describe("the Plot and Trace tabs", () => {
  it("shows general plot controls in Plot and trace controls in Trace", async () => {
    await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    const panel = tabPanel();
    for (const group of [S.ribbon.groups.plotType, S.ribbon.groups.axes, S.plot.legend, S.plot.referenceLines, S.ribbon.groups.labels, S.ribbon.groups.region]) {
      expect(within(panel).getByRole("group", { name: group }), group).toBeTruthy();
    }
    expect(within(panel).getByRole("combobox", { name: S.plot.gridSpacing })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: S.plot.legendPosition })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: S.plot.legendSize })).toBeTruthy();

    openTraceTab();
    const traceTab = tracePanel();
    for (const group of [S.ribbon.groups.traces, S.plot.selectedTrace, S.plot.traceType, S.ribbon.groups.traceStyle, S.plot.legend]) {
      expect(within(traceTab).getByRole("group", { name: group }), group).toBeTruthy();
    }
    expect(within(traceTab).getByRole("button", { name: S.ribbon.commands.addTrace })).toBeTruthy();
    expect(traceOptions()).toHaveLength(1);
    // No trace is selected on a new plot: Remove Trace and the trace controls wait for one.
    expect(removeButton().disabled).toBe(true);
    expect(within(traceTab).getByText(S.plot.selectTraceHint)).toBeTruthy();
    expect(within(traceTab).getByRole("combobox", { name: S.plot.lineStyle })).toHaveProperty("disabled", true);
  });

  it("changes legend corner position and font size from the Plot tab, one undo step each", async () => {
    await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));

    const pos = () => screen.getByRole("combobox", { name: S.plot.legendPosition }) as HTMLSelectElement;
    const size = () => screen.getByRole("combobox", { name: S.plot.legendSize }) as HTMLSelectElement;
    expect(pos().value).toBe("top-right");
    expect(size().value).toBe("12");

    fireEvent.change(pos(), { target: { value: "bottom-left" } });
    await waitFor(() => expect(pos().value).toBe("bottom-left"));

    fireEvent.change(size(), { target: { value: "18" } });
    await waitFor(() => expect(size().value).toBe("18"));

    // Undo restores the previous size, then the previous position.
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(size().value).toBe("12"));
    expect(pos().value).toBe("bottom-left");
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(pos().value).toBe("top-right"));
  });

  it("adds, edits and removes a fixed reference line from the Plot tab", async () => {
    await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    fireEvent.click(screen.getByRole("button", { name: S.plot.addVerticalReferenceLine }));
    await screen.findByRole("group", { name: S.plot.referenceLineValue });
    fireEvent.click(screen.getByRole("button", { name: `${S.plot.removeReferenceLine}: ${S.plot.verticalReferenceLine(1)}` }));
    await waitFor(() => expect(screen.queryByRole("group", { name: S.plot.referenceLineValue })).toBeNull());
  });

  it("selecting a trace on the plot selects it in the list and enables its controls", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    openTraceTab();
    await press(ySlots(plot)[0]);
    await waitFor(() => expect(traceOptions()[0].getAttribute("aria-selected")).toBe("true"));
    expect(plot.getAttribute("data-selected-trace")).toBe("trace-1");
    expect(removeButton().disabled).toBe(true); // the only trace stays
    expect(screen.queryByText(S.plot.selectTraceHint)).toBeNull();
    expect(screen.getByRole("combobox", { name: S.plot.lineStyle })).toHaveProperty("disabled", false);
    expect(screen.getByRole("combobox", { name: S.plot.yAxisSelector })).toHaveProperty("value", "left");
  });

  it("picking a trace in the list drives Remove Trace, and removing it is one undo step", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    openTraceTab();
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.addTrace }));
    await waitFor(() => expect(traceOptions()).toHaveLength(2));
    // Add Trace selects the new trace.
    await waitFor(() => expect(traceOptions()[1].getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(traceOptions()[0]);
    await waitFor(() => expect(traceOptions()[0].getAttribute("aria-selected")).toBe("true"));
    expect(plot.getAttribute("data-selected-trace")).toBe("trace-1");
    expect(selectedTab()).toBe(S.ribbon.tabs.trace);
    expect(removeButton().disabled).toBe(false);
    fireEvent.click(removeButton());
    await waitFor(() => expect(traceOptions()).toHaveLength(1));
    expect(ySlots(plot).map((slot) => slot.dataset.traceId)).toEqual(["trace-2"]);
    expect(removeButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(traceOptions()).toHaveLength(2));
  });

  it("edits the style of the selected trace only", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    openTraceTab();
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.addTrace }));
    await waitFor(() => expect(traceOptions()).toHaveLength(2));
    fireEvent.click(traceOptions()[0]);
    const lineStyle = () => screen.getByRole("combobox", { name: S.plot.lineStyle }) as HTMLSelectElement;
    fireEvent.change(lineStyle(), { target: { value: "dash" } });
    await waitFor(() => expect(lineStyle().value).toBe("dash"));
    fireEvent.change(screen.getByRole("combobox", { name: S.plot.markerShape }), { target: { value: "diamond" } });
    await waitFor(() => expect((screen.getByRole("combobox", { name: S.plot.markerShape }) as HTMLSelectElement).value).toBe("diamond"));
    // The other trace keeps the defaults; the presentation buttons act on the selected trace.
    fireEvent.click(traceOptions()[1]);
    await waitFor(() => expect(lineStyle().value).toBe("solid"));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.markers }));
    await waitFor(() => expect(screen.getByRole("button", { name: S.ribbon.commands.markers }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(traceOptions()[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: S.ribbon.commands.lines }).getAttribute("aria-pressed")).toBe("true"));
    expect(plot.getAttribute("data-selected-trace")).toBe("trace-1");
  });

  it("sets the trace type of the selected trace from the Trace type group", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    openTraceTab();
    const panel = tracePanel();
    const typeButton = (name: string) => within(panel).getByRole("button", { name }) as HTMLButtonElement;
    // A new plot is a line trace.
    expect(within(panel).getByRole("group", { name: S.plot.traceType })).toBeTruthy();
    expect(typeButton(S.ribbon.commands.lineTrace).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(typeButton(S.ribbon.commands.stemTrace));
    await waitFor(() => expect(typeButton(S.ribbon.commands.stemTrace).getAttribute("aria-pressed")).toBe("true"));
    expect(typeButton(S.ribbon.commands.lineTrace).getAttribute("aria-pressed")).toBe("false");
    // The type is independent of the presentation: setting a type keeps the presentation.
    expect(within(panel).getByRole("button", { name: S.ribbon.commands.lines }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(typeButton(S.ribbon.commands.barTrace));
    await waitFor(() => expect(typeButton(S.ribbon.commands.barTrace).getAttribute("aria-pressed")).toBe("true"));
    // One undo step puts the type back.
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(typeButton(S.ribbon.commands.stemTrace).getAttribute("aria-pressed")).toBe("true"));
    // The type is not a control on the plot itself.
    expect(plot.querySelectorAll("button, select")).toHaveLength(0);
  });

  it("saves per-trace legend visibility and a custom label without changing the other trace", async () => {
    await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    openTraceTab();
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.addTrace }));
    await waitFor(() => expect(traceOptions()).toHaveLength(2));
    const show = () => screen.getByRole("checkbox", { name: S.plot.showInLegend }) as HTMLInputElement;
    const label = () => screen.getByRole("textbox", { name: S.plot.legendLabel }) as HTMLInputElement;
    // A new trace is hidden from the legend; showing it changes only that trace.
    expect(show().checked).toBe(false);
    fireEvent.click(show());
    await waitFor(() => expect(show().checked).toBe(true));
    fireEvent.change(label(), { target: { value: "Measured response" } });
    expect(label().value).toBe("Measured response");
    fireEvent.blur(label());
    fireEvent.click(traceOptions()[0]);
    await waitFor(() => expect(show().checked).toBe(false));
    expect(label().value).toBe("");
    fireEvent.click(traceOptions()[1]);
    await waitFor(() => expect(label().value).toBe("Measured response"));
  });

  it("writes the plot title and an axis title in the tab and the plot draws them", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    // An empty field has no band to press, so it is started here.
    expect(plot.querySelector(".plot-labels")).toBeNull();
    const plotTitle = () => screen.getByRole("textbox", { name: S.plot.plotTitle }) as HTMLInputElement;
    fireEvent.change(plotTitle(), { target: { value: "Climb rate" } });
    fireEvent.blur(plotTitle());
    // One undo step for the whole title, and the plot draws it above the plot area.
    const title = await waitFor(() => {
      const found = plot.querySelector<HTMLElement>(".plot-labels.title .plot-label");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(title.textContent).toBe("Climb rate");
    expect(title.closest(".plot-labels")?.getAttribute("class")).toContain("title");
    // A y-axis title takes its own band at the left edge, and the tick labels follow it.
    const yTitle = screen.getByRole("textbox", { name: S.plot.yTitle }) as HTMLInputElement;
    fireEvent.change(yTitle, { target: { value: "Speed" } });
    fireEvent.blur(yTitle);
    await waitFor(() => expect(plot.querySelector(".plot-labels.y")?.textContent).toBe("Speed"));
  });

  it("saves a grid spacing from the tab", async () => {
    await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    const spacing = () => screen.getByRole("combobox", { name: S.plot.gridSpacing }) as HTMLSelectElement;
    fireEvent.change(spacing(), { target: { value: "5" } });
    await waitFor(() => expect(spacing().value).toBe("5"));
  });

  it("assigns the selected trace to the right y axis and toggles its scale in the tab, with no control on the plot", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    expect(screen.queryByRole("button", { name: S.ribbon.commands.logY2 })).toBeNull();
    await press(ySlots(plot)[0]);
    openTraceTab();
    const axis = await screen.findByRole("combobox", { name: S.plot.yAxisSelector });
    fireEvent.change(axis, { target: { value: "right" } });
    openPlotTab();
    const logY2 = await screen.findByRole("button", { name: S.ribbon.commands.logY2 });
    expect(logY2.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(logY2);
    await waitFor(() => expect(screen.getByRole("button", { name: S.ribbon.commands.logY2 }).getAttribute("aria-pressed")).toBe("true"));
    // The right limits are placeholders on the plot; the toggle and the label are not.
    expect(within(plot).getAllByTestId("plot-slot")).toHaveLength(8);
    expect(within(plot).getByRole("group", { name: S.plot.y2Max })).toBeTruthy();
    expect(plot.querySelectorAll("button, select")).toHaveLength(0);
    expect(within(plot).queryByText(S.plot.yAxisRight)).toBeNull();
  });

  it("edits the selected trace's y expression in the tab and the plot placeholder follows", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    await press(ySlots(plot)[0]);
    openTraceTab();
    const panel = tracePanel();
    const field = await waitFor(() => {
      const found = within(panel).getByRole("group", { name: S.plot.yExpression });
      expect(found.querySelector("[data-testid=inline-math]")).not.toBeNull();
      return found;
    });
    await press(field);
    const math = field.querySelector<HTMLElement>("[data-testid=inline-math]")!;
    await waitFor(() => expect(math.classList.contains("editing")).toBe(true));
    await act(async () => void fireEvent.keyDown(math, { key: "3", code: "Digit3" }));
    await act(async () => void fireEvent.keyDown(math, { key: "Escape", code: "Escape" }));
    await waitFor(() => expect(ySlots(plot)[0].textContent).toContain("3"));
    // The plot is still the selection: the tab did not go away while the field was used.
    expect(selectedTab()).toBe(S.ribbon.tabs.trace);
  });
});

describe("an axis limit is a number or an expression", () => {
  /** Types `text` into a placeholder: one key per character, then Escape commits it. */
  const typeInto = async (slot: HTMLElement, keys: string[]) => {
    await press(slot);
    const math = await waitFor(() => {
      const found = slot.querySelector<HTMLElement>("[data-testid=inline-math]");
      expect(found).not.toBeNull();
      return found!;
    });
    for (const key of keys) {
      await act(async () => void fireEvent.keyDown(math, { key, code: `Key${key.toUpperCase()}` }));
    }
    await act(async () => void fireEvent.keyDown(math, { key: "Escape", code: "Escape" }));
  };

  it("shows a typed expression in its placeholder and reports a limit the calculation cannot use", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    const yMax = () => within(plot).getByRole("group", { name: S.plot.yMax });

    // A number stays a number: the placeholder shows it and nothing is reported.
    await typeInto(yMax(), ["5"]);
    await waitFor(() => expect(yMax().textContent).toContain("5"));
    expect(within(plot).queryByTestId("plot-limit-error")).toBeNull();

    // An expression is stored and shown as math; the plot uses the value the session calculates.
    // The demo worksheet does not define `L`, so this one is a reported limit failure.
    await typeInto(yMax(), ["L"]);
    await waitFor(() => expect(yMax().textContent).toContain("L"));
    const note = await within(plot).findByTestId("plot-limit-error");
    expect(note.textContent).toContain(S.plot.yMax);
    expect(note.textContent).toContain("L");
    // The plot keeps drawing: a broken limit is never a plot-data error.
    expect(plot.getAttribute("data-state")).not.toBe("error");
  });
});

describe("hiding the controls", () => {
  it("an outside click removes the tab, the trace selection and the placeholder chrome; pressing a placeholder brings them back", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    await press(ySlots(plot)[0]);
    await waitFor(() => expect(plot.getAttribute("data-selected-trace")).toBe("trace-1"));
    expect(plot.getAttribute("data-editing")).toBe("true");

    await clickOutside();
    await waitFor(() => expect(screen.queryByRole("tab", { name: S.ribbon.tabs.plot })).toBeNull());
    expect(plot.getAttribute("data-editing")).toBe("false");
    expect(plot.getAttribute("data-selected-trace")).toBe("");
    expect(plot.classList.contains("editing")).toBe(false);
    expect(plot.querySelector(".plot-slot.selected")).toBeNull();

    // A press on a placeholder of the unselected plot selects the plot and its tab again, with no trace.
    await press(within(plot).getByRole("group", { name: S.plot.xMin }));
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    expect(plot.getAttribute("data-editing")).toBe("true");
    expect(plot.getAttribute("data-selected-trace")).toBe("");
    openTraceTab();
    expect(removeButton().disabled).toBe(true);
  });
});

describe("plot type", () => {
  it("switches XY to Polar and back from the Type group of the Plot tab, one undo step each", async () => {
    const plot = await insertPlot();
    await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
    const type = () => screen.getByRole("combobox", { name: S.plot.type }) as HTMLSelectElement;
    expect(plot.querySelectorAll("select")).toHaveLength(0);
    expect(type().value).toBe("xy");
    expect(within(plot).getAllByTestId("plot-slot")).toHaveLength(6);
    fireEvent.change(type(), { target: { value: "polar" } });
    await waitFor(() => expect(type().value).toBe("polar"));
    // Polar: angle and radius labels, no limit placeholders, no Axes group.
    await waitFor(() => expect(within(plot).getAllByTestId("plot-slot")).toHaveLength(2));
    expect(within(plot).getByRole("group", { name: S.plot.polarRadius })).toBeTruthy();
    expect(within(plot).getByRole("group", { name: S.plot.polarAngle })).toBeTruthy();
    expect(screen.queryByRole("group", { name: S.ribbon.groups.axes })).toBeNull();
    fireEvent.change(type(), { target: { value: "xy" } });
    await waitFor(() => expect(within(plot).getAllByTestId("plot-slot")).toHaveLength(6));
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(type().value).toBe("polar"));
    expect(within(plot).getAllByTestId("plot-slot")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(type().value).toBe("xy"));
  });
});

it("switches to contour with three editable expressions and restores XY in one undo step", async () => {
  const plot = await insertPlot();
  await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
  fireEvent.change(within(tabPanel()).getByRole("combobox", { name: S.plot.type }), { target: { value: "contour" } });
  await waitFor(() => expect(within(plot).getByLabelText(S.plot.zExpression)).not.toBeNull());
  expect(within(plot).getByLabelText(S.plot.xExpression)).not.toBeNull();
  expect(within(plot).getByLabelText(S.plot.yExpression)).not.toBeNull();
  expect(within(tabPanel()).queryByRole("button", { name: S.ribbon.commands.markers })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: S.quickAccess.undo }));
  await waitFor(() => expect((within(tabPanel()).getByRole("combobox", { name: S.plot.type }) as HTMLSelectElement).value).toBe("xy"));
  expect(within(plot).queryByLabelText(S.plot.zExpression)).toBeNull();
});
