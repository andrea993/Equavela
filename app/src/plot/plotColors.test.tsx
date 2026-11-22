// The colour of a trace is chosen with the shared picker (GitHub): one choice is one undo
// step, the picker offers the colours the worksheet already uses, and Automatic gives the palette colour back.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("./plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(cleanup);

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const undoButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => /^(Undo|Nothing to undo)/.test(b.title))!;

async function insertPlot() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
  await waitFor(() => expect(document.querySelector('[data-testid^="plot-r"]')).not.toBeNull());
  // The trace fields act on the selected trace: pick the first one in the trace list.
  await act(async () => {
    fireEvent.click(within(screen.getByRole("listbox", { name: S.plot.traceList })).getAllByRole("option")[0]);
  });
}

const chip = (label: string) => screen.getByRole("button", { name: label }).querySelector<HTMLElement>(".color-chip")!;

describe("the colour of a trace", () => {
  it("one choice is one undo step, Automatic gives the palette colour back", async () => {
    await insertPlot();
    // The first trace is drawn in the palette's blue until it has a colour of its own.
    expect(chip(S.plot.lineColor).style.background).toMatch(/#1f5fbf|rgb\(31, 95, 191\)/i);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: S.plot.lineColor }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: S.plot.lineColor })).getByRole("button", { name: "Dark red" }));
    });
    await waitFor(() => expect(chip(S.plot.lineColor).style.background).toMatch(/#c00000|rgb\(192, 0, 0\)/i));
    expect(undoButton().title).toBe("Undo Edit plot");
    // One undo goes back to the colour from before the choice.
    await act(async () => {
      fireEvent.click(undoButton());
    });
    await waitFor(() => expect(chip(S.plot.lineColor).style.background).toMatch(/#1f5fbf|rgb\(31, 95, 191\)/i));
    // Automatic after an explicit colour: the field falls back to the palette colour.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: S.plot.lineColor }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: S.plot.lineColor })).getByRole("button", { name: "Dark red" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: S.plot.lineColor }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: S.plot.lineColor })).getByRole("button", { name: S.plot.automaticColor }));
    });
    await waitFor(() => expect(chip(S.plot.lineColor).style.background).toMatch(/#1f5fbf|rgb\(31, 95, 191\)/i));
  });

  it("the picker of a new trace offers the colours the first one already has", async () => {
    await insertPlot();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: S.plot.lineColor }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: S.plot.lineColor })).getByRole("button", { name: "Dark red" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.addTrace }));
    });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: S.plot.traceList })).getAllByRole("option").length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: S.plot.lineColor }));
    });
    const row = await screen.findByTestId("worksheet-colors");
    const colours = [...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(colours).toContain("#c00000");
    // The second trace's own palette colour is there too (orange-red).
    expect(colours).toContain("#c8461c");
  });
});
