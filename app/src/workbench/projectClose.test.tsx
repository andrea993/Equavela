import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMockBackend } from "../mock/mockBackend";
import { useWorkbench } from "./useWorkbench";

afterEach(cleanup);

async function openModifiedProjectText() {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.loadProject("new", "/work/beam", "Beam"));
  await act(async () => { await hook.result.current.actions.openProjectWorksheet("/work/beam/worksheets/main.eqv"); });
  await act(async () => hook.result.current.actions.openProjectFile("julia/src/Beam.jl", "text"));
  const fileId = "/work/beam/julia/src/Beam.jl";
  await waitFor(() => expect(hook.result.current.fileTabs.some((tab) => tab.id === fileId)).toBe(true));
  const text = hook.result.current.fileTabs.find((tab) => tab.id === fileId)!.text;
  await act(async () => hook.result.current.actions.editFile(fileId, `${text}\n# unsaved change`));
  return { backend, hook, fileId };
}

async function answerPrompt(hook: Awaited<ReturnType<typeof openModifiedProjectText>>["hook"], answer: string) {
  await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
  await act(async () => hook.result.current.actions.answer(answer));
}

it("keeps project files and worksheets open when window close is canceled", async () => {
  const { hook, fileId } = await openModifiedProjectText();
  let closing: Promise<boolean>;
  act(() => { closing = hook.result.current.actions.requestCloseAll(); });
  await answerPrompt(hook, "cancel");

  await expect(closing!).resolves.toBe(false);
  expect(hook.result.current.fileTabs.some((tab) => tab.id === fileId && tab.text !== tab.saved)).toBe(true);
  expect(hook.result.current.state.docs.length).toBeGreaterThan(0);
});

it("discards modified project text and allows window close", async () => {
  const { hook } = await openModifiedProjectText();
  let closing: Promise<boolean>;
  act(() => { closing = hook.result.current.actions.requestCloseAll(); });
  await answerPrompt(hook, "discard");

  await expect(closing!).resolves.toBe(true);
  expect(hook.result.current.fileTabs).toHaveLength(0);
  expect(hook.result.current.state.docs).toHaveLength(0);
});

it("saves modified project text and allows window close", async () => {
  const { backend, hook, fileId } = await openModifiedProjectText();
  const write = vi.spyOn(backend, "projectWriteText");
  const editedText = hook.result.current.fileTabs.find((tab) => tab.id === fileId)!.text;
  let closing: Promise<boolean>;
  act(() => { closing = hook.result.current.actions.requestCloseAll(); });
  await answerPrompt(hook, "save");

  await expect(closing!).resolves.toBe(true);
  expect(write).toHaveBeenCalledWith("/work/beam", "julia/src/Beam.jl", editedText, "v1");
  expect(hook.result.current.fileTabs).toHaveLength(0);
  expect(hook.result.current.state.docs).toHaveLength(0);
});

it("keeps modified project text open when its save fails during window close", async () => {
  const { backend, hook, fileId } = await openModifiedProjectText();
  vi.spyOn(backend, "projectWriteText").mockRejectedValueOnce({ message: "disk is read-only" });
  let closing: Promise<boolean>;
  act(() => { closing = hook.result.current.actions.requestCloseAll(); });
  await answerPrompt(hook, "save");

  await expect(closing!).resolves.toBe(false);
  expect(hook.result.current.fileTabs.some((tab) => tab.id === fileId && tab.text !== tab.saved)).toBe(true);
  expect(hook.result.current.state.docs.length).toBeGreaterThan(0);
});

it("keeps the project open when Close project is canceled", async () => {
  const { hook, fileId } = await openModifiedProjectText();
  let closing: Promise<boolean>;
  act(() => { closing = hook.result.current.actions.closeProject(); });
  await answerPrompt(hook, "cancel");
  await expect(closing!).resolves.toBe(false);
  expect(hook.result.current.project?.root).toBe("/work/beam");
  expect(hook.result.current.fileTabs.some(tab => tab.id === fileId)).toBe(true);
});

it("closes the project after saving and retains unrelated worksheets and recent projects", async () => {
  const { backend, hook } = await openModifiedProjectText();
  const unrelated = hook.result.current.state.docs.filter(doc => !doc.root.startsWith("/work/beam/"));
  const write = vi.spyOn(backend, "projectWriteText");
  let closing: Promise<boolean>;
  act(() => { closing = hook.result.current.actions.closeProject(); });
  await answerPrompt(hook, "save");
  await expect(closing!).resolves.toBe(true);
  await waitFor(() => expect(hook.result.current.project).toBeNull());
  expect(hook.result.current.state.docs.map(doc => doc.id)).toEqual(unrelated.map(doc => doc.id));
  expect(hook.result.current.fileTabs).toHaveLength(0);
  expect(write).toHaveBeenCalledOnce();
  expect(hook.result.current.recentProjects).toContain("/work/beam");
});

it("retains file tabs from a previous project when closing the current project", async () => {
  const { hook, fileId } = await openModifiedProjectText();
  await act(async () => hook.result.current.actions.loadProject("new", "/work/other", "Other"));
  await act(async () => { await hook.result.current.actions.openProjectWorksheet("/work/other/worksheets/main.eqv"); });
  await act(async () => { expect(await hook.result.current.actions.closeProject()).toBe(true); });
  expect(hook.result.current.project).toBeNull();
  expect(hook.result.current.fileTabs.some(tab => tab.id === fileId && tab.text !== tab.saved)).toBe(true);
  expect(hook.result.current.state.docs.some(doc => doc.root === "/work/beam/worksheets/main.eqv")).toBe(true);
  expect(hook.result.current.state.docs.some(doc => doc.root.startsWith("/work/other/"))).toBe(false);
});

it("retains text typed while a close-and-save write is in progress", async () => {
  const { backend, hook, fileId } = await openModifiedProjectText();
  const originalWrite = backend.projectWriteText;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const write = vi.spyOn(backend, "projectWriteText").mockImplementation(async (...args) => {
    await pending;
    return originalWrite(...args);
  });
  let closing: Promise<boolean>;
  act(() => { closing = hook.result.current.actions.closeFile(fileId); });
  await answerPrompt(hook, "save");
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  act(() => hook.result.current.actions.editFile(fileId, "# typed during save"));
  await act(async () => { release(); await closing!; });
  await expect(closing!).resolves.toBe(false);
  const tab = hook.result.current.fileTabs.find(tab => tab.id === fileId)!;
  expect(tab.text).toBe("# typed during save");
  expect(tab.text).not.toBe(tab.saved);
});
