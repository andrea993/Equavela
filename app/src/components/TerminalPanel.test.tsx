import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Backend } from "../backend";
import { TerminalPanel } from "./TerminalPanel";

const mocks = vi.hoisted(() => ({ terminals: [] as any[], observers: [] as any[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; focus = vi.fn(); write = vi.fn(); writeln = vi.fn(); reset = vi.fn(); dispose = vi.fn();
  input = (_data: string) => {};
  constructor() { mocks.terminals.push(this); }
  loadAddon() {} open() {} onData(callback: (data: string) => void) { this.input = callback; return { dispose: vi.fn() }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
class Observer {
  constructor(public callback: () => void) { mocks.observers.push(this); }
  observe() {} disconnect = vi.fn();
}
vi.stubGlobal("ResizeObserver", Observer);
afterEach(() => { cleanup(); mocks.terminals.length = 0; mocks.observers.length = 0; });
const snapshot = (generation: number, sequence: number, data: number[] = []) => ({ generation, sequence, data });
const makeBackend = () => ({
  terminalOpen: vi.fn(async () => snapshot(1, 1, [65])),
  terminalRead: vi.fn(async () => snapshot(1, 1)),
  terminalWrite: vi.fn(async () => {}),
  terminalResize: vi.fn(async () => {}),
}) as unknown as Backend;
const props = (backend: Backend, project: string | null = null) => ({ backend, project, target: { key: project ?? "generic", label: project ?? "generic" }, height: 220, onHeight: vi.fn(), onClose: vi.fn() });

it("opens, forwards terminal input and resize, and disposes without closing the kernel", async () => {
  const backend = makeBackend();
  const view = render(<TerminalPanel {...props(backend)} />);
  expect(mocks.terminals[0].focus).toHaveBeenCalled();
  await waitFor(() => expect(backend.terminalOpen).toHaveBeenCalledWith(null, 80, 24));
  await waitFor(() => expect(mocks.terminals[0].write).toHaveBeenCalledWith(new Uint8Array([65])));
  act(() => { mocks.terminals[0].input("\u0003"); mocks.observers[0].callback(); });
  await waitFor(() => expect(backend.terminalWrite).toHaveBeenCalledWith(null, "\u0003"));
  expect(backend.terminalResize).toHaveBeenCalledWith(null, 80, 24);
  view.unmount();
  expect(mocks.terminals[0].dispose).toHaveBeenCalled();
  expect(mocks.observers[0].disconnect).toHaveBeenCalled();
});

it("resets on generation changes and ignores pending reads from a previous environment", async () => {
  const backend = makeBackend();
  let resolveOld!: (value: ReturnType<typeof snapshot>) => void;
  vi.mocked(backend.terminalRead).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  const view = render(<TerminalPanel {...props(backend, "one")} />);
  await waitFor(() => expect(backend.terminalRead).toHaveBeenCalledWith("one", 1));
  const old = mocks.terminals[0];
  view.rerender(<TerminalPanel {...props(backend, "two")} />);
  await waitFor(() => expect(backend.terminalOpen).toHaveBeenCalledWith("two", 80, 24));
  await act(async () => resolveOld(snapshot(2, 2, [66])));
  expect(old.reset).not.toHaveBeenCalled();
  expect(old.write).not.toHaveBeenCalledWith(new Uint8Array([66]));
  vi.mocked(backend.terminalRead).mockResolvedValue(snapshot(2, 3, [67]));
  await waitFor(() => expect(mocks.terminals[1].reset).toHaveBeenCalled());
  expect(mocks.terminals[1].write).toHaveBeenCalledWith(new Uint8Array([67]));
});

 it("queues input until open and ignores a late open after unmount", async () => {
  const backend = makeBackend();
  let finish!: (value: ReturnType<typeof snapshot>) => void;
  vi.mocked(backend.terminalOpen).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<TerminalPanel {...props(backend)} />);
  act(() => mocks.terminals[0].input("x"));
  expect(backend.terminalWrite).not.toHaveBeenCalled();
  view.unmount();
  await act(async () => finish(snapshot(1, 1, [65])));
  expect(backend.terminalWrite).not.toHaveBeenCalled();
  expect(mocks.terminals[0].write).not.toHaveBeenCalled();
  expect(backend.terminalRead).not.toHaveBeenCalled();
});

it("sends queued input once open completes", async () => {
  const backend = makeBackend();
  let finish!: (value: ReturnType<typeof snapshot>) => void;
  vi.mocked(backend.terminalOpen).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<TerminalPanel {...props(backend, "project")} />);
  act(() => mocks.terminals[0].input("abc"));
  expect(backend.terminalWrite).not.toHaveBeenCalled();
  await act(async () => finish(snapshot(1, 0)));
  await waitFor(() => expect(backend.terminalWrite).toHaveBeenCalledWith("project", "abc"));
});

it("replays the new generation from zero instead of applying the old offset", async () => {
  const backend = makeBackend();
  vi.mocked(backend.terminalOpen).mockResolvedValue(snapshot(1, 99, [65]));
  vi.mocked(backend.terminalRead).mockImplementation(async (_project, after) =>
    after === 0 ? snapshot(2, 7, [106, 117, 108, 105, 97, 62, 32]) : snapshot(2, 7));
  render(<TerminalPanel {...props(backend)} />);
  await waitFor(() => expect(mocks.terminals[0].reset).toHaveBeenCalled());
  expect(backend.terminalRead).toHaveBeenCalledWith(null, 99);
  expect(backend.terminalRead).toHaveBeenCalledWith(null, 0);
  expect(mocks.terminals[0].write).toHaveBeenCalledWith(new Uint8Array([106, 117, 108, 105, 97, 62, 32]));
});

it("reports repeated read failures once and backs off", async () => {
  const backend = makeBackend();
  vi.mocked(backend.terminalRead).mockRejectedValue({ message: "disconnected" });
  render(<TerminalPanel {...props(backend)} />);
  await waitFor(() => expect(backend.terminalRead).toHaveBeenCalledTimes(2));
  expect(mocks.terminals[0].writeln).toHaveBeenCalledTimes(1);
  expect(mocks.terminals[0].writeln).toHaveBeenCalledWith(expect.stringContaining("disconnected"));
});

it("restarts the REPL from the Restart button of its header", async () => {
  const backend = makeBackend();
  const onRestart = vi.fn();
  const view = render(<TerminalPanel {...props(backend)} onRestart={onRestart} />);
  view.getByRole("button", { name: "Restart" }).click();
  expect(onRestart).toHaveBeenCalledTimes(1);
});
