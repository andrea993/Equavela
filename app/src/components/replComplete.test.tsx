// the specification : Tab completion in the REPL panel.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReplResult } from "../equavelaApi";
import { ReplPanel } from "./ReplPanel";
import { afterTab, charactersBefore, commonPrefix, indents, replaceCharacters } from "./replComplete";

afterEach(cleanup);

const target = { key: "/work/p/julia", label: "project environment · julia" };
const done = (value: string | null): ReplResult => ({ incomplete: false, output: "", value, error: null, trace: null, duration: 0.001 });

function panel(complete: (text: string, position: number) => Promise<{ items: string[]; from: number; to: number }>) {
  render(<ReplPanel target={target} height={220} onHeight={vi.fn()} run={vi.fn(async () => done(null))} complete={complete} stop={vi.fn()} onClose={vi.fn()} />);
  return screen.getByRole("textbox", { name: "Julia input" }) as HTMLTextAreaElement;
}

/** Types `text` into the input, caret at its end, and presses Tab. */
function tab(input: HTMLTextAreaElement, text: string, init: KeyboardEventInit = {}) {
  fireEvent.change(input, { target: { value: text } });
  input.setSelectionRange(text.length, text.length);
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  return event;
}

it("counts characters, not UTF-16 units, and finds the common prefix", () => {
  expect(charactersBefore("a😀b", 3)).toBe(2);
  expect(commonPrefix(["println", "print", "printstyled"])).toBe("print");
  expect(commonPrefix(["α", "β"])).toBe("");
  expect(replaceCharacters("a😀bc", 2, 3, "XY")).toEqual({ text: "a😀XYc", caret: 5 });
  expect(indents("", 0)).toBe(true);
  expect(indents("x = 1\n  ", 8)).toBe(true);
  expect(indents("x = 1", 5)).toBe(false);
});

it("completes one candidate at once, a common prefix first, and lists the rest", () => {
  expect(afterTab("pri", { items: ["println"], from: 0, to: 3 })).toEqual({ kind: "edit", text: "println", caret: 7 });
  expect(afterTab("x = \\alpha", { items: ["α"], from: 4, to: 10 })).toEqual({ kind: "edit", text: "x = α", caret: 5 });
  expect(afterTab("pr", { items: ["print", "println"], from: 0, to: 2 })).toEqual({ kind: "edit", text: "print", caret: 5 });
  expect(afterTab("print", { items: ["print", "println"], from: 0, to: 5 })).toEqual({ kind: "list", items: ["print", "println"], from: 0, to: 5 });
  expect(afterTab("zzz", { items: [], from: 0, to: 3 })).toEqual({ kind: "none" });
});

it("Tab completes a name defined earlier and keeps the focus in the input", async () => {
  const complete = vi.fn(async () => ({ items: ["myvar"], from: 0, to: 3 }));
  const input = panel(complete);
  input.focus();
  const event = tab(input, "myv");
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(input.value).toBe("myvar"));
  expect(complete).toHaveBeenCalledWith("myv", 3);
  expect(document.activeElement).toBe(input);
});

it("Tab turns \\alpha into α", async () => {
  const input = panel(async () => ({ items: ["α"], from: 0, to: 6 }));
  tab(input, "\\alpha");
  await waitFor(() => expect(input.value).toBe("α"));
});

it("Tab with several matches opens a list: arrows pick, Enter inserts, Escape closes", async () => {
  const items = ["println", "printstyled"];
  const input = panel(async () => ({ items, from: 0, to: 5 }));
  tab(input, "print");
  const list = await screen.findByRole("listbox", { name: "Completions" });
  expect(list.querySelectorAll("[role=option]")).toHaveLength(2);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(list.querySelector("[aria-selected=true]")!.textContent).toBe("printstyled");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(input.value).toBe("print");
  tab(input, "print");
  await screen.findByRole("listbox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("printstyled");
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("a click on a candidate inserts it", async () => {
  const input = panel(async () => ({ items: ["println", "printstyled"], from: 0, to: 5 }));
  tab(input, "print");
  fireEvent.mouseDown(await screen.findByRole("option", { name: "println" }));
  expect(input.value).toBe("println");
});

it("Tab indents a blank line in a multiline expression", async () => {
  const complete = vi.fn(async () => ({ items: ["x"], from: 0, to: 0 }));
  const input = panel(complete);
  tab(input, "if x\n");
  await waitFor(() => expect(input.value).toBe("if x\n    "));
  expect(complete).not.toHaveBeenCalled();
});

it("Tab with a name but no candidate changes nothing, and Shift+Tab never moves the focus", async () => {
  const complete = vi.fn(async () => ({ items: [], from: 0, to: 3 }));
  const input = panel(complete);
  tab(input, "zzz");
  await waitFor(() => expect(complete).toHaveBeenCalled());
  expect(input.value).toBe("zzz");
  const event = tab(input, "zzz", { shiftKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(complete).toHaveBeenCalledTimes(1);
});

// An empty prompt discovers the environment namespace rather than inserting indentation.
it("lists initial candidates including Project on Tab at an empty prompt", async () => {
  const complete = vi.fn(async () => ({ items: ["Project", "println"], from: 0, to: 0 }));
  const input = panel(complete);
  const event = tab(input, "");
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
  expect(complete).toHaveBeenCalledWith("", 0);
  expect(screen.getByRole("option", { name: "Project" })).toBeTruthy();
  expect(input.value).toBe("");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input.value).toBe("Project"));
});
