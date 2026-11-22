import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JuliaView } from "./JuliaView";
import { resetRunningRegions, trackRunningRegion } from "../workbench/runningRegion";

afterEach(() => { cleanup(); resetRunningRegions(); });

const block = { using: [], imports: [], code: "x = 1", defines: [] };

describe("a Julia block on the page", () => {
  it("indents and unindents selected lines without replacing their contents", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return frames.length; });
    render(<JuliaView block={{ ...block, code: "one\ntwo\nthree" }} selected startEditing />);
    const editor = screen.getByTestId("julia-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(0, 7);
    fireEvent.keyDown(editor, { key: "Tab" });
    frames.splice(0).forEach((cb) => cb(0));
    expect(editor.value).toBe("    one\n    two\nthree");
    fireEvent.keyDown(editor, { key: "Tab", shiftKey: true });
    frames.splice(0).forEach((cb) => cb(0));
    expect(editor.value).toBe("one\ntwo\nthree");
    vi.restoreAllMocks();
  });

  it("indents an empty first selected line without touching the next line", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return frames.length; });
    render(<JuliaView block={{ ...block, code: "\nnext" }} selected startEditing />);
    const editor = screen.getByTestId("julia-editor") as HTMLTextAreaElement;
    editor.setSelectionRange(0, 1);
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.value).toBe("    \nnext");
    vi.restoreAllMocks();
  });
  it("opens the editor on a press of the code and commits once on Escape", () => {
    const onChange = vi.fn();
    const { container } = render(<JuliaView block={block} selected={false} onChange={onChange} />);
    fireEvent.click(container.querySelector(".julia-code-box")!);
    const editor = screen.getByTestId("julia-editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "using Statistics\nx = 2" } });
    // the header follows the code being typed.
    expect(container.querySelector(".julia-head")!.textContent).toContain("using Statistics");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ code: "using Statistics\nx = 2" });
    expect(screen.queryByTestId("julia-editor")).toBeNull();
  });

  it("writes nothing when the code did not change", () => {
    const onChange = vi.fn();
    const { container } = render(<JuliaView block={block} selected={false} onChange={onChange} />);
    fireEvent.click(container.querySelector(".julia-code-box")!);
    fireEvent.keyDown(screen.getByTestId("julia-editor"), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles play and stop, and a stopped block is marked", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <JuliaView block={{ ...block, playing: false }} selected={false} onChange={onChange} />,
    );
    expect(container.querySelector(".julia-region")!.classList.contains("stopped")).toBe(true);
    fireEvent.click(screen.getByTestId("julia-play"));
    expect(onChange).toHaveBeenLastCalledWith({ playing: true });
    rerender(<JuliaView block={block} selected={false} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("julia-play"));
    expect(onChange).toHaveBeenLastCalledWith({ playing: false });
  });

  it("opens the editor at once on a new block, and the button is screen only", () => {
    render(<JuliaView block={{ ...block, code: null, playing: false }} selected startEditing />);
    expect(screen.getByTestId("julia-editor")).toBeTruthy();
    expect(screen.getByTestId("julia-play").classList.contains("no-print")).toBe(true);
  });
});

describe("a Julia block of an untrusted worksheet", () => {
  it("is drawn stopped whatever the file stores, and its button asks to play", () => {
    const onChange = vi.fn();
    const { container } = render(<JuliaView block={block} selected={false} trusted={false} onChange={onChange} />);
    expect(container.querySelector(".julia-region")!.classList.contains("stopped")).toBe(true);
    fireEvent.click(screen.getByTestId("julia-play"));
    expect(onChange).toHaveBeenLastCalledWith({ playing: true });
  });
});

describe("the box of a Julia block", () => {
  it("is drawn at the stored size, and a block without one grows with its code", () => {
    const { container, rerender } = render(
      <JuliaView block={block} selected={false} size={{ w: 234, h: 153 }} />,
    );
    const box = () => container.querySelector<HTMLElement>(".julia-region")!;
    expect(box().classList.contains("sized")).toBe(true);
    // 234 x 153 pt in CSS px (1 pt = 4/3 px).
    expect(box().style.width).toBe("312px");
    expect(box().style.height).toBe("204px");
    rerender(<JuliaView block={block} selected={false} />);
    expect(box().classList.contains("sized")).toBe(false);
    expect(box().style.width).toBe("");
    expect(box().style.height).toBe("");
  });

  it("grows to the code while the code is edited, so the field sits on the letters", () => {
    const { container } = render(<JuliaView block={block} selected={false} size={{ w: 234, h: 153 }} />);
    const box = () => container.querySelector<HTMLElement>(".julia-region")!;
    expect(box().classList.contains("editing")).toBe(false);
    fireEvent.click(container.querySelector(".julia-code-box")!);
    expect(box().classList.contains("editing")).toBe(true);
    fireEvent.keyDown(screen.getByTestId("julia-editor"), { key: "Escape" });
    expect(box().classList.contains("editing")).toBe(false);
  });
});

describe("Run and the state of a Julia block", () => {
  it("runs from its button without changing the enabled state, and a disabled block has no Run", () => {
    const onChange = vi.fn();
    const { rerender } = render(<JuliaView block={block} selected={false} state="value" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("julia-run"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ run: true });
    expect(screen.getByTestId("julia-state").textContent).toBe("done");
    expect(screen.getByTestId("julia-play").getAttribute("aria-pressed")).toBe("true");
    rerender(<JuliaView block={{ ...block, playing: false }} selected={false} onChange={onChange} />);
    expect(screen.queryByTestId("julia-run")).toBeNull();
    expect(screen.getByTestId("julia-state").textContent).toBe("disabled");
  });

  it("commits and runs with Ctrl+Enter, keeping the editor open, and marks edited code", () => {
    const onChange = vi.fn();
    const { container } = render(<JuliaView block={block} selected={false} onChange={onChange} />);
    fireEvent.click(container.querySelector(".julia-code-box")!);
    const editor = screen.getByTestId("julia-editor");
    fireEvent.change(editor, { target: { value: "y = 3\n" } });
    expect(screen.getByTestId("julia-state").textContent).toContain("edited");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(onChange.mock.calls).toEqual([[{ code: "y = 3\n", run: true }]]);
    expect(screen.getByTestId("julia-editor")).toBeTruthy();
  });

  it("shows the state in words, with the error message as its tooltip", () => {
    const { rerender } = render(<JuliaView block={block} selected={false} state="error" failure="boom" />);
    const state = screen.getByTestId("julia-state");
    expect(state.textContent).toBe("error");
    expect(state.getAttribute("title")).toBe("boom");
    expect(state.classList.contains("no-print")).toBe(true);
    rerender(<JuliaView block={block} selected={false} state="stale" />);
    expect(screen.getByTestId("julia-state").textContent).toBe("stale");
    rerender(<JuliaView block={block} selected={false} trusted={false} />);
    expect(screen.getByTestId("julia-state").textContent).toBe("not trusted");
  });

  it("Shift+Enter sends one commit/run/insert request and a disabled cell never runs", () => {
    const onChange = vi.fn();
    const { rerender } = render(<JuliaView block={block} selected startEditing onChange={onChange} />);
    const editor = screen.getByTestId("julia-editor");
    fireEvent.change(editor, { target: { value: "y = 3" } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(onChange.mock.calls).toEqual([[{ code: "y = 3", run: true, insertBelow: true }]]);
    rerender(<JuliaView block={{ ...block, playing: false }} selected startEditing onChange={onChange} />);
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("shows running immediately only for its exact region instance and restores the stored state", () => {
    const key = { document: "/a.eqv", region_id: "j1", instance: 1 };
    const onChange = vi.fn();
    render(<JuliaView block={block} selected startEditing state="value" regionKey={key} onChange={onChange} />);
    act(() => trackRunningRegion({ worksheet: "w1", event: "region_started", key: { ...key, instance: 0 } }));
    expect(screen.getByTestId("julia-state").textContent).toBe("done");
    act(() => trackRunningRegion({ worksheet: "w1", event: "region_started", key }));
    expect(screen.getByTestId("julia-state").textContent).toBe("running");
    expect((screen.getByTestId("julia-run") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId("julia-editor"), { key: "Enter", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    act(() => trackRunningRegion({ worksheet: "w1", event: "region_updated", entry: { key: { ...key, instance: 0 }, state: "value" } as never }));
    expect(screen.getByTestId("julia-state").textContent).toBe("running");
    act(() => trackRunningRegion({ worksheet: "w1", event: "region_updated", entry: { key, state: "value" } as never }));
    expect(screen.getByTestId("julia-state").textContent).toBe("done");
    expect((screen.getByTestId("julia-run") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the output of a Julia cell", () => {
  it("shows the duration, and an Output button that opens a screen-only box", () => {
    const output = { text: "hello\nworld\n", duration_ms: 1250 };
    render(<JuliaView block={block} selected={false} state="value" output={output} />);
    expect(screen.getByTestId("julia-state").textContent).toBe("done · 1.3 s");
    const toggle = screen.getByTestId("julia-output-toggle");
    expect(toggle.textContent).toBe("Output (2)");
    expect(screen.queryByTestId("julia-output")).toBeNull();
    fireEvent.click(toggle);
    const box = screen.getByTestId("julia-output");
    expect(box.textContent).toContain("hello\nworld");
    expect(box.classList.contains("no-print")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("julia-output")).toBeNull();
  });

  it("shows an error's message and folded trace, and nothing without output", () => {
    const { rerender } = render(
      <JuliaView block={block} selected={false} state="error" failure="kaput" output={{ text: "", duration_ms: 8, trace: "Stacktrace:\n [1] boom()" }} />,
    );
    expect(screen.getByTestId("julia-state").textContent).toBe("error · 8 ms");
    fireEvent.click(screen.getByTestId("julia-output-toggle"));
    const box = screen.getByTestId("julia-output");
    expect(box.querySelector("summary")!.textContent).toBe("Stack trace: kaput");
    expect(box.querySelector("details")!.open).toBe(false);
    rerender(<JuliaView block={block} selected={false} state="stale" />);
    expect(screen.queryByTestId("julia-output-toggle")).toBeNull();
    expect(screen.getByTestId("julia-state").textContent).toBe("stale");
  });
});

describe("indentation and completion in the editor of a block", () => {
  const raf = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });

  it("indents the line after a block opener and moves a typed end back", async () => {
    render(<JuliaView block={{ ...block, code: "function f(x)" }} selected startEditing />);
    const field = screen.getByTestId("julia-editor") as HTMLTextAreaElement;
    field.setSelectionRange(13, 13);
    fireEvent.keyDown(field, { key: "Enter" });
    await raf();
    expect(field.value).toBe("function f(x)\n    ");
    expect(field.selectionStart).toBe(18);
    fireEvent.change(field, { target: { value: "function f(x)\n    2x\n    end", selectionStart: 28, selectionEnd: 28 } });
    await raf();
    expect(field.value).toBe("function f(x)\n    2x\nend");
  });

  it("offers the keywords and the kernel's names while a name is typed", async () => {
    const { JuliaCompleteContext } = await import("./JuliaView");
    const complete = vi.fn(async () => ({ items: ["println", "print"], from: 0, to: 3 }));
    render(
      <JuliaCompleteContext.Provider value={complete}>
        <JuliaView block={{ ...block, code: "" }} selected startEditing />
      </JuliaCompleteContext.Provider>,
    );
    const field = screen.getByTestId("julia-editor") as HTMLTextAreaElement;
    field.focus();
    fireEvent.change(field, { target: { value: "pri", selectionStart: 3, selectionEnd: 3 } });
    const list = await screen.findByRole("listbox");
    await act(async () => { await Promise.resolve(); });
    expect(complete).toHaveBeenCalledWith("pri", 3);
    expect(list.textContent).toContain("println");
    fireEvent.keyDown(field, { key: "Enter" });
    await raf();
    expect(field.value).toBe("println");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
