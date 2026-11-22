//  (GitHub ): a paste into an axis expression stays in the edit, and leaving the slot
// commits it. A keyboard paste reads the clipboard through a hidden textarea, so the focus leaves the
// slot for a moment: that is not leaving the slot.

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { pasteMath } from "../editor/clipboard";
import { mockParse, mockParseArgs, mockPrint, mockPrintArgs } from "../mock/mockMath";
import { toEditing, toWire, type Node } from "../editor/tree";
import { TextEnvContext } from "../text/InlineMath";
import type { MathClipboard } from "../text/value";
import { PlotContext, type PlotEnv } from "./PlotContext";
import { Slot } from "./PlotSlot";

afterEach(cleanup);

const io = {
  print: async (statement: unknown) => mockPrint(statement as Record<string, unknown>),
  parse: async (text: string) => mockParse(text),
  printArgs: async (args: unknown[]) => mockPrintArgs(args as Record<string, unknown>[]),
  parseArgs: async (text: string) => mockParseArgs(text),
};

const env = {
  revision: 0,
  toTree: async (text: string) => toEditing(mockParse(text || "□")),
  toText: async (tree: Node) => mockPrint(toWire(tree) as Record<string, unknown>),
} as unknown as PlotEnv;

const clipboard = {
  copy: async () => null,
  paste: async (state, pending) => {
    const text = await pending;
    const pasted = text === null ? null : await pasteMath(io, state, text);
    return pasted && "state" in pasted ? pasted.state : null;
  },
} as MathClipboard;

it("keeps a pasted expression and commits it when the slot is left", async () => {
  const onCommit = vi.fn();
  const { container, rerender } = render(
    <PlotContext.Provider value={env}>
      <TextEnvContext.Provider value={{ layout: "en-US", mathTarget: null, clipboard }}>
        <Slot text="f(x)" label="y" onCommit={onCommit} />
      </TextEnvContext.Provider>
    </PlotContext.Provider>,
  );
  const math = await waitFor(() => {
    const found = container.querySelector<HTMLElement>('[data-testid="inline-math"]');
    expect(found).not.toBeNull();
    return found!;
  });
  // Edit the existing expression: delete it, then paste a new one in its place.
  await act(async () => {
    math.focus();
    fireEvent.focus(math);
  });
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      fireEvent.keyDown(math, { key: "Backspace", code: "Backspace" });
    });
  }
  expect(math.textContent).not.toContain("f");
  await act(async () => {
    fireEvent.keyDown(math, { key: "v", code: "KeyV", ctrlKey: true });
  });
  // The keyboard paste lands in the hidden textarea: the focus has left the slot for it.
  const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-hidden="true"]')!;
  expect(box).not.toBeNull();
  fireEvent.blur(math, { relatedTarget: box });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => "g(x) + 1" } });
  await act(async () => {
    box.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  // Reading the clipboard committed nothing.
  expect(onCommit).not.toHaveBeenCalled();
  await waitFor(() => expect(math.textContent).toContain("g"));
  // A click outside the plot leaves the slot: the pasted expression is committed.
  await act(async () => {
    fireEvent.blur(math, { relatedTarget: document.body });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await waitFor(() => expect(onCommit).toHaveBeenCalledWith("g(x) + 1"));
  expect(onCommit).toHaveBeenCalledTimes(1);
  // The stored text comes back as the slot's text; it shows the pasted expression.
  rerender(
    <PlotContext.Provider value={env}>
      <TextEnvContext.Provider value={{ layout: "en-US", mathTarget: null, clipboard }}>
        <Slot text="g(x) + 1" label="y" onCommit={onCommit} />
      </TextEnvContext.Provider>
    </PlotContext.Provider>,
  );
  await waitFor(() => expect(math.isConnected ? math.textContent : container.textContent).toContain("g"));
});
