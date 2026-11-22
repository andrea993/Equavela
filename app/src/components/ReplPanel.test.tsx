// the specification : the Julia REPL panel.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReplResult } from "../equavelaApi";
import { ReplPanel } from "./ReplPanel";

afterEach(cleanup);

const done = (value: string | null, extra: Partial<ReplResult> = {}): ReplResult => ({ incomplete: false, output: "", value, error: null, trace: null, duration: 0.012, ...extra });
const target = { key: "/work/p/julia", label: "project environment · julia" };

function panel(run: (code: string) => Promise<ReplResult>, props: Partial<Parameters<typeof ReplPanel>[0]> = {}) {
  return render(<ReplPanel target={target} height={220} onHeight={vi.fn()} run={run} complete={async () => ({ items: [], from: 0, to: 0 })} stop={vi.fn()} onClose={vi.fn()} {...props} />);
}

it("runs the input on Enter and shows the input, output, value and duration", async () => {
  const run = vi.fn(async () => done("42", { output: "hi\n" }));
  panel(run);
  const input = screen.getByRole("textbox", { name: "Julia input" });
  fireEvent.change(input, { target: { value: "println(\"hi\"); 6 * 7" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const log = screen.getByRole("log", { name: "REPL output" });
  await waitFor(() => expect(log.textContent).toContain("42"));
  expect(run).toHaveBeenCalledWith("println(\"hi\"); 6 * 7");
  expect(log.querySelector(".repl-input")!.textContent).toBe("println(\"hi\"); 6 * 7");
  expect(log.querySelector(".repl-output")!.textContent).toBe("hi\n");
  expect(log.textContent).toContain("12 ms");
  expect((input as HTMLTextAreaElement).value).toBe("");
});

it("goes on on a new line when the expression is incomplete, and Shift+Enter adds a line", async () => {
  const run = vi.fn(async () => ({ ...done(null), incomplete: true }));
  panel(run);
  const input = screen.getByRole("textbox", { name: "Julia input" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "function f(x)" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input.value).toBe("function f(x)\n"));
  expect(screen.getByRole("log").querySelectorAll(".repl-entry")).toHaveLength(0);
  run.mockClear();
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(run).not.toHaveBeenCalled();
});

it("shows an error with its folded trace, walks the history and clears with Ctrl+L", async () => {
  const run = vi.fn()
    .mockResolvedValueOnce(done(null, { error: "kaput", trace: "Stacktrace:\n [1] boom()" }))
    .mockResolvedValueOnce(done("1"));
  panel(run);
  const input = screen.getByRole("textbox", { name: "Julia input" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "boom()" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("log").querySelector(".repl-error")).not.toBeNull());
  const error = screen.getByRole("log").querySelector(".repl-error") as HTMLDetailsElement;
  expect(within(error).getByText("kaput")).toBeTruthy();
  expect(error.open).toBe(false);
  fireEvent.change(input, { target: { value: "1" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("log").querySelectorAll(".repl-entry")).toHaveLength(2));
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("1");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(input.value).toBe("boom()");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.value).toBe("1");
  fireEvent.keyDown(input, { key: "l", ctrlKey: true });
  expect(screen.getByRole("log").querySelectorAll(".repl-entry")).toHaveLength(0);
});

it("says when it switches kernel, and Stop interrupts a running evaluation", async () => {
  let finish!: (result: ReplResult) => void;
  const stop = vi.fn();
  const { rerender } = panel(() => new Promise((resolve) => { finish = resolve; }), { stop });
  const input = screen.getByRole("textbox", { name: "Julia input" });
  fireEvent.change(input, { target: { value: "sleep(10)" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const stopButton = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
  expect(stopButton.disabled).toBe(false);
  fireEvent.click(stopButton);
  expect(stop).toHaveBeenCalled();
  await act(async () => finish(done(null, { error: "InterruptException" })));
  rerender(<ReplPanel target={{ key: "/data/standalone", label: "shared environment · standalone" }} height={220} onHeight={vi.fn()} run={vi.fn()} complete={vi.fn()} stop={stop} onClose={vi.fn()} />);
  expect(screen.getByRole("log").textContent).toContain("Now running in shared environment · standalone");
});
