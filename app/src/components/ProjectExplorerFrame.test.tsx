import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectExplorerFrame } from "./ProjectExplorerFrame";

const KEY = "equavela.projectExplorer";

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});
afterEach(cleanup);

function mount(props: { inspectorOpen?: boolean; onOpen?: () => void } = {}) {
  return render(<ProjectExplorerFrame inspectorOpen={props.inspectorOpen ?? false} onOpen={props.onOpen ?? vi.fn()}>
    <nav aria-label="Project tree">Tree</nav>
  </ProjectExplorerFrame>);
}

it("uses safe defaults for malformed persisted settings", () => {
  window.localStorage.setItem(KEY, "{not json");
  mount();
  expect(screen.getByRole("navigation", { name: "Project tree" })).toBeTruthy();
  expect(screen.getByRole("separator", { name: "Resize project explorer" }).getAttribute("aria-valuenow")).toBe("240");
  expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ open: true, width: 240 });
});

it("persists collapse and reopen while preserving the selected width", () => {
  mount();
  fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
  fireEvent.click(screen.getByRole("button", { name: "Collapse project explorer" }));
  expect(screen.queryByRole("navigation", { name: "Project tree" })).toBeNull();
  expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ open: false, width: 250 });
  fireEvent.click(screen.getByRole("button", { name: "Expand project explorer" }));
  expect(screen.getByRole("navigation", { name: "Project tree" })).toBeTruthy();
  expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("250");
});

it("resizes with separator keyboard controls and clamps to its limits", () => {
  mount();
  const separator = screen.getByRole("separator");
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator.getAttribute("aria-valuenow")).toBe("160");
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator.getAttribute("aria-valuenow")).toBe("160");
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator.getAttribute("aria-valuenow")).toBe("420");
});

it("resizes by dragging and stops tracking after pointer release", () => {
  mount();
  const separator = screen.getByRole("separator");
  const pointer = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x });
    fireEvent(separator, event);
  };
  pointer("pointerdown", 240);
  pointer("pointermove", 320);
  expect(separator.getAttribute("aria-valuenow")).toBe("320");
  pointer("pointerup", 320);
  pointer("pointermove", 400);
  expect(separator.getAttribute("aria-valuenow")).toBe("320");
});

it("opens as a narrow drawer and mutually excludes the right inspector", () => {
  const onOpen = vi.fn();
  const view = mount({ onOpen });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
  fireEvent(window, new Event("resize"));
  fireEvent.click(screen.getByRole("button", { name: "Collapse project explorer" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand project explorer" }));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(view.container.querySelector(".project-explorer-frame")?.getAttribute("data-narrow")).toBe("true");
  view.rerender(<ProjectExplorerFrame inspectorOpen onOpen={onOpen}><nav aria-label="Project tree">Tree</nav></ProjectExplorerFrame>);
  expect(screen.queryByRole("navigation", { name: "Project tree" })).toBeNull();
  expect(screen.getByRole("button", { name: "Expand project explorer" })).toBeTruthy();
});

it("returns keyboard focus to the reopen button when Escape hides the drawer", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
  render(<ProjectExplorerFrame inspectorOpen={false} onOpen={vi.fn()}><button>Tree item</button></ProjectExplorerFrame>);
  const item = screen.getByRole("button", { name: "Tree item" });
  item.focus();
  fireEvent.keyDown(item, { key: "Escape" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand project explorer" }));
  expect(screen.queryByRole("button", { name: "Tree item" })).toBeNull();
});


it("keeps the resize separator usable in the narrow drawer", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
  mount();
  const separator = screen.getByRole("separator", { name: "Resize project explorer" });
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator.getAttribute("aria-valuenow")).toBe("420");
});


it("resizes immediately from the visible narrow width while preserving the stored desktop width", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  window.localStorage.setItem(KEY, JSON.stringify({ open: true, width: 420 }));
  mount();
  const separator = screen.getByRole("separator", { name: "Resize project explorer" });
  expect(separator.getAttribute("aria-valuenow")).toBe("272");
  expect(separator.getAttribute("aria-valuemax")).toBe("272");
  expect(JSON.parse(window.localStorage.getItem(KEY)!).width).toBe(420);
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator.getAttribute("aria-valuenow")).toBe("262");
  const pointer = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x });
    fireEvent(separator, event);
  };
  pointer("pointerdown", 200);
  pointer("pointermove", 190);
  expect(separator.getAttribute("aria-valuenow")).toBe("252");
  pointer("pointerup", 190);
});
