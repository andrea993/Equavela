// the specification : the full path of a document tab and its context menu.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentTabs } from "./Chrome";
import type { DocState, FileTab } from "../workbench/useWorkbench";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const doc = (id: string, root: string) => ({ id, root, name: root.split("/").pop(), modified: false }) as unknown as DocState & { modified: boolean };
const file = { id: "/work/p/julia/src/P.jl", path: "julia/src/P.jl", kind: "text", text: "", saved: "", version: "1" } as FileTab;

function tabs(handlers: Partial<Parameters<typeof DocumentTabs>[0]> = {}) {
  return render(
    <DocumentTabs
      docs={[doc("a", "/work/calcs/beam.eqv"), doc("b", "Untitled-1")]}
      activeId="a"
      onActivate={vi.fn()}
      onClose={vi.fn()}
      files={[file]}
      {...handlers}
    />,
  );
}

it("shows the full path after resting on a tab, and says when there is no file", () => {
  vi.useFakeTimers();
  tabs();
  const saved = screen.getAllByRole("tab")[0];
  fireEvent.pointerEnter(saved);
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => vi.advanceTimersByTime(400));
  expect(screen.getByRole("tooltip").textContent).toBe("/work/calcs/beam.eqv");
  fireEvent.pointerLeave(saved);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.pointerEnter(screen.getAllByRole("tab")[1]);
  act(() => vi.advanceTimersByTime(400));
  expect(screen.getByRole("tooltip").textContent).toBe("Not saved yet: this worksheet has no file");
  fireEvent.pointerEnter(screen.getAllByRole("tab")[2]);
  act(() => vi.advanceTimersByTime(400));
  expect(screen.getByRole("tooltip").textContent).toBe("/work/p/julia/src/P.jl");
});

it("offers Show in folder, Copy path and Close on a right click", () => {
  const onReveal = vi.fn();
  const onCopyPath = vi.fn();
  const onClose = vi.fn();
  tabs({ onReveal, onCopyPath, onClose });
  fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Show in folder" }));
  expect(onReveal).toHaveBeenCalledWith("/work/calcs/beam.eqv");
  fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
  expect(onCopyPath).toHaveBeenCalledWith("/work/calcs/beam.eqv");
  fireEvent.contextMenu(screen.getAllByRole("tab")[0]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
  expect(onClose).toHaveBeenCalledWith("a");
  // An untitled worksheet has nothing to show or copy.
  fireEvent.contextMenu(screen.getAllByRole("tab")[1]);
  expect((screen.getByRole("menuitem", { name: "Show in folder" }) as HTMLButtonElement).getAttribute("aria-disabled") === "true"
    || (screen.getByRole("menuitem", { name: "Show in folder" }) as HTMLButtonElement).disabled).toBe(true);
});
