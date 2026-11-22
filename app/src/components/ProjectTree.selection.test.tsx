import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenedProject, TreeEntry } from "../equavelaApi";
import { ProjectTree, type ProjectTreeActions } from "./ProjectTree";

afterEach(cleanup);

const project = {
  root: "/work/multi",
  manifest: {
    format: "equavela-project/1" as const,
    project_id: "multi",
    name: "Multi",
    worksheets: [
      { id: "one", path: "one.eqv" },
      { id: "two", path: "two.eqv" },
    ],
    main_worksheet: "one",
  },
  worksheet: {} as never,
} as OpenedProject;

const entries: TreeEntry[] = [
  { path: "one.eqv", kind: "worksheet", size: 1 },
  { path: "two.eqv", kind: "worksheet", size: 1 },
  { path: "group", kind: "folder", size: 0 },
  { path: "group/child.eqv", kind: "worksheet", size: 1 },
  { path: "destination", kind: "folder", size: 0 },
  { path: "notes.txt", kind: "other", size: 1 },
];

function setup() {
  const actions: ProjectTreeActions = {
    open: vi.fn(), create: vi.fn(), rename: vi.fn(), move: vi.fn(), delete: vi.fn(),
    import: vi.fn(), reveal: vi.fn(), openFile: vi.fn(), openExternal: vi.fn(),
    openMany: vi.fn(), moveMany: vi.fn(), deleteMany: vi.fn(),
  };
  render(<ProjectTree project={project} entries={entries} activeRoot={null} actions={actions} />);
  const tree = screen.getByRole("tree", { name: "Multi" });
  const row = (path: string) => tree.querySelector(`[data-path="${path}"]`) as HTMLElement;
  return { actions, tree, row };
}

it("supports modifier toggles, visible-order ranges, keyboard extension, and roving focus", () => {
  const { actions, tree, row } = setup();
  expect(tree.getAttribute("aria-multiselectable")).toBe("true");
  fireEvent.click(row("one.eqv"));
  expect(row("one.eqv").getAttribute("aria-selected")).toBe("true");
  fireEvent.click(row("two.eqv"), { ctrlKey: true });
  expect(row("one.eqv").getAttribute("aria-selected")).toBe("true");
  expect(row("two.eqv").getAttribute("aria-selected")).toBe("true");
  expect(actions.open).toHaveBeenCalledTimes(1);
  fireEvent.click(row("group"), { shiftKey: true });
  expect(row("two.eqv").getAttribute("aria-selected")).toBe("true");
  expect(row("group").getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(row("group"), { key: "ArrowDown", shiftKey: true });
  expect(row("group/child.eqv").getAttribute("aria-selected")).toBe("true");
  expect(row("group/child.eqv").tabIndex).toBe(0);
  fireEvent.keyDown(row("group/child.eqv"), { key: "Escape" });
  expect(row("group/child.eqv").getAttribute("aria-selected")).toBe("true");
  expect(row("one.eqv").getAttribute("aria-selected")).toBe("false");
});

it("preserves a selected group in the context menu and dispatches one bulk delete", () => {
  const { actions, row } = setup();
  fireEvent.click(row("one.eqv"));
  fireEvent.click(row("two.eqv"), { metaKey: true });
  fireEvent.contextMenu(row("two.eqv"));
  const menu = screen.getByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Move selected items to trash" })).toBeTruthy();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Move selected items to trash" }));
  expect(actions.deleteMany).toHaveBeenCalledTimes(1);
  expect(actions.deleteMany).toHaveBeenCalledWith([
    { path: "one.eqv", folder: false, files: 0 },
    { path: "two.eqv", folder: false, files: 0 },
  ]);
  expect(actions.delete).not.toHaveBeenCalled();
});

it("drags selected rows as one JSON group and removes descendants covered by a folder", () => {
  const { actions, row } = setup();
  fireEvent.click(row("group"));
  fireEvent.click(row("group"));
  fireEvent.click(row("group/child.eqv"), { ctrlKey: true });
  const values = new Map<string, string>();
  const dataTransfer = {
    types: ["application/x-equavela-paths"],
    setData: (key: string, value: string) => values.set(key, value),
    getData: (key: string) => values.get(key) ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
  fireEvent.dragStart(row("group/child.eqv"), { dataTransfer });
  expect(JSON.parse(values.get("application/x-equavela-paths") ?? "[]")).toEqual(["group"]);
  fireEvent.dragOver(row("destination"), { dataTransfer });
  fireEvent.drop(row("destination"), { dataTransfer });
  expect(actions.moveMany).toHaveBeenCalledTimes(1);
  expect(actions.moveMany).toHaveBeenCalledWith(["group"], "destination");
  expect(actions.move).not.toHaveBeenCalled();
});

it("opens supported selected files together and keeps plain click activation", () => {
  const { actions, row } = setup();
  fireEvent.click(row("one.eqv"));
  expect(actions.open).toHaveBeenCalledWith("/work/multi/one.eqv");
  fireEvent.click(row("two.eqv"), { ctrlKey: true });
  expect(actions.open).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(row("two.eqv"), { key: "Enter" });
  expect(actions.openMany).toHaveBeenCalledWith(["one.eqv", "two.eqv"]);
});
