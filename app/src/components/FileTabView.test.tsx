// the Load in worksheets checkbox above a project `.jl` file.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTabView, runCodeCommand, type CodeHistory } from "./FileTabView";
import type { FileTab } from "../workbench/useWorkbench";

afterEach(cleanup);

const tab = { id: "/p/julia/src/Thermo.jl", path: "julia/src/Thermo.jl", kind: "text", text: "module Thermo\nend\n", saved: "module Thermo\nend\n", version: "1" } as FileTab;

it("shows Load in worksheets beside Save, unchecked by default, and reports a toggle", () => {
  const onToggle = vi.fn();
  const handlers = { onEdit: vi.fn(), onSave: vi.fn(), onReload: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<FileTabView tab={tab} {...handlers} module={{ loaded: false, onToggle }} />);
  const box = screen.getByRole("checkbox", { name: "Load in worksheets" }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  expect(onToggle).toHaveBeenCalledWith(true);
  rerender(<FileTabView tab={tab} {...handlers} module={{ loaded: true, onToggle }} />);
  expect((screen.getByRole("checkbox", { name: "Load in worksheets" }) as HTMLInputElement).checked).toBe(true);
  rerender(<FileTabView tab={tab} {...handlers} />);
  expect(screen.queryByRole("checkbox")).toBeNull();
});

describe("the Code commands of a text tab", () => {
  function Harness({ path = "julia/src/A.jl", initial = "a = 1\nb = 2\n", onHistory }: { path?: string; initial?: string; onHistory?: (history: CodeHistory | null) => void }) {
    const [text, setText] = useState(initial);
    return <FileTabView tab={{ ...tab, path, text }} onEdit={setText} onSave={vi.fn()} onReload={vi.fn()} onClose={vi.fn()} onHistory={onHistory} />;
  }
  const flush = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  it("toggles a comment, undoes and redoes it, from the keys and from runCodeCommand", async () => {
    render(<Harness />);
    const editor = screen.getByRole("textbox", { name: "julia/src/A.jl" }) as HTMLTextAreaElement;
    editor.setSelectionRange(0, 0);
    fireEvent.keyDown(editor, { key: "/", ctrlKey: true });
    await flush();
    expect(editor.value).toBe("# a = 1\nb = 2\n");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    await flush();
    expect(editor.value).toBe("a = 1\nb = 2\n");
    expect(runCodeCommand("redo")).toBe(true);
    await flush();
    expect(editor.value).toBe("# a = 1\nb = 2\n");
    // The Italian layout types `/` with Shift.
    editor.setSelectionRange(0, 0);
    fireEvent.keyDown(editor, { key: "/", ctrlKey: true, shiftKey: true });
    await flush();
    expect(editor.value).toBe("a = 1\nb = 2\n");
  });

  it("reports its history for quick-access Undo and Redo, and null once closed", async () => {
    const onHistory = vi.fn();
    const { unmount } = render(<Harness onHistory={onHistory} />);
    expect(onHistory).toHaveBeenLastCalledWith({ canUndo: false, canRedo: false });
    const editor = screen.getByRole("textbox", { name: "julia/src/A.jl" }) as HTMLTextAreaElement;
    editor.setSelectionRange(0, 0);
    fireEvent.keyDown(editor, { key: "/", ctrlKey: true });
    await flush();
    expect(onHistory).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    expect(runCodeCommand("undo")).toBe(true);
    await flush();
    expect(onHistory).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true });
    expect(runCodeCommand("redo")).toBe(true);
    await flush();
    expect(onHistory).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    unmount();
    expect(onHistory).toHaveBeenLastCalledWith(null);
  });

  it("moves and duplicates lines, and indents a selection with Tab", async () => {
    render(<Harness />);
    const editor = screen.getByRole("textbox", { name: "julia/src/A.jl" }) as HTMLTextAreaElement;
    editor.setSelectionRange(0, 0);
    fireEvent.keyDown(editor, { key: "ArrowDown", altKey: true });
    await flush();
    expect(editor.value).toBe("b = 2\na = 1\n");
    fireEvent.keyDown(editor, { key: "ArrowDown", altKey: true, shiftKey: true });
    await flush();
    expect(editor.value).toBe("b = 2\na = 1\na = 1\n");
    editor.setSelectionRange(0, editor.value.length);
    fireEvent.keyDown(editor, { key: "Tab" });
    await flush();
    expect(editor.value.startsWith("    b = 2\n    a = 1")).toBe(true);
  });

  it("finds, replaces all and goes to a line in the bar", async () => {
    render(<Harness initial={"x = 1\nx = 2\ny = x\n"} />);
    const editor = screen.getByRole("textbox", { name: "julia/src/A.jl" }) as HTMLTextAreaElement;
    fireEvent.keyDown(editor, { key: "h", ctrlKey: true });
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), { target: { value: "x" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), { target: { value: "z" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await flush();
    expect(editor.value).toBe("z = 1\nz = 2\ny = z\n");
    expect(screen.getByRole("status").textContent).toBe("3 replaced");
    fireEvent.keyDown(editor, { key: "g", ctrlKey: true });
    await flush();
    const line = screen.getByRole("textbox", { name: "Line number" });
    fireEvent.change(line, { target: { value: "3" } });
    fireEvent.keyDown(line, { key: "Enter" });
    await flush();
    expect(editor.selectionStart).toBe(12);
    expect(screen.queryByRole("search")).toBeNull();
  });
});

describe("completion in a .jl text tab", () => {
  function Harness({ complete, initial = "function area(b)\nend\n" }: { complete?: (text: string, position: number) => Promise<{ items: string[]; from: number; to: number }>; initial?: string }) {
    const [text, setText] = useState(initial);
    return <FileTabView tab={{ ...tab, path: "julia/src/A.jl", text }} onEdit={setText} onSave={vi.fn()} onReload={vi.fn()} onClose={vi.fn()} complete={complete} />;
  }
  // A change puts the caret at the end of the new value, as typing at the end does.
  const type = (editor: HTMLTextAreaElement, value: string) => fireEvent.change(editor, { target: { value } });

  it("offers the file's names at once and accepts the selected one with Enter", async () => {
    render(<Harness />);
    const editor = screen.getByRole("textbox", { name: "julia/src/A.jl" }) as HTMLTextAreaElement;
    type(editor, "function area(b)\nend\nar");
    const list = await screen.findByRole("listbox", { name: "Completions" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["area"]);
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(editor.value).toBe("function area(b)\nend\narea"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("adds the kernel's items, drops a late answer and closes with Escape", async () => {
    let answer!: (value: { items: string[]; from: number; to: number }) => void;
    const complete = vi.fn(() => new Promise<{ items: string[]; from: number; to: number }>((resolve) => { answer = resolve; }));
    render(<Harness complete={complete} initial="" />);
    const editor = screen.getByRole("textbox", { name: "julia/src/A.jl" }) as HTMLTextAreaElement;
    type(editor, "pri");
    expect(complete).toHaveBeenCalledWith("pri", 3);
    await act(async () => answer({ items: ["print", "println"], from: 0, to: 3 }));
    const list = screen.getByRole("listbox", { name: "Completions" });
    // The kernel's items first, then the editor's own words (a keyword here).
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["print", "println", "primitive type"]);
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    // The answer to an older caret position is not shown.
    type(editor, "prix");
    type(editor, "prix = 1");
    await act(async () => answer({ items: ["printx"], from: 0, to: 4 }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on Ctrl+Space and works without a kernel", async () => {
    render(<Harness complete={() => Promise.reject(new Error("no kernel"))} initial="fun" />);
    const editor = screen.getByRole("textbox", { name: "julia/src/A.jl" }) as HTMLTextAreaElement;
    editor.setSelectionRange(3, 3);
    fireEvent.keyDown(editor, { key: " ", ctrlKey: true });
    const list = await screen.findByRole("listbox", { name: "Completions" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["function"]);
  });
});
