//  (GitHub ): a Plot tab field is one ribbon row high. A taller expression is drawn scaled
// down to the row; while it is edited it opens full size in a fixed box anchored at the field, because the
// ribbon groups clip anything taller than their rows. jsdom has no layout: the heights are stubbed.

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mockParse, mockPrint } from "../mock/mockMath";
import { toEditing, toWire, type Node } from "../editor/tree";
import { PlotContext, type PlotEnv } from "./PlotContext";
import { Slot } from "./PlotSlot";

const env = {
  revision: 0,
  toTree: async (text: string) => toEditing(mockParse(text || "□")),
  toText: async (tree: Node) => mockPrint(toWire(tree) as Record<string, unknown>),
} as unknown as PlotEnv;

// The slot is a row of 18 px; the typeset math is 36 px high, as a fraction is.
const saved = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight"),
};
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 36 });
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      return this.classList.contains("plot-slot") ? 18 : 0;
    },
  });
});
afterEach(() => {
  cleanup();
  if (saved.offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", saved.offsetHeight);
  if (saved.clientHeight) Object.defineProperty(Element.prototype, "clientHeight", saved.clientHeight);
});

const renderSlot = async (fitRow: boolean) => {
  const { container } = render(
    <PlotContext.Provider value={env}>
      <Slot text="s/2" label="y" className="ribbon-expression" onCommit={() => undefined} fitRow={fitRow} />
    </PlotContext.Provider>,
  );
  const math = await waitFor(() => {
    const found = container.querySelector<HTMLElement>('[data-testid="inline-math"]');
    expect(found?.firstElementChild).toBeTruthy();
    return found!;
  });
  return math;
};

it("draws a taller expression scaled down to the ribbon row", async () => {
  const math = await renderSlot(true);
  await waitFor(() => expect((math.firstElementChild as HTMLElement).style.zoom).toBe(String(16 / 36)));
  expect(math.classList.contains("floating")).toBe(false);
});

it("opens the edited expression full size in a box anchored at the field", async () => {
  const math = await renderSlot(true);
  await act(async () => {
    math.focus();
    fireEvent.focus(math);
  });
  await waitFor(() => expect(math.classList.contains("floating")).toBe(true));
  expect((math.firstElementChild as HTMLElement).style.zoom).toBe("");
  expect(math.style.left).toMatch(/px$/);
  await act(async () => {
    fireEvent.blur(math.closest(".plot-slot")!, { relatedTarget: document.body });
  });
  await waitFor(() => expect(math.classList.contains("floating")).toBe(false));
  expect(math.style.left).toBe("");
});

it("leaves a slot on the plot itself unscaled", async () => {
  const math = await renderSlot(false);
  expect((math.firstElementChild as HTMLElement).style.zoom).toBe("");
});
