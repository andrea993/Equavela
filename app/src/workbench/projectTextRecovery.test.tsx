import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMockBackend } from "../mock/mockBackend";
import type { FileTab } from "./useWorkbench";
import { useWorkbench } from "./useWorkbench";

afterEach(cleanup);

async function project() {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.loadProject("new", "/work/beam", "Beam"));
  return { backend, hook, root: "/work/beam", path: "julia/src/Beam.jl", id: "/work/beam/julia/src/Beam.jl" };
}

async function answerRecovery(hook: Awaited<ReturnType<typeof project>>["hook"], answer: "recover" | "discard" | "cancel") {
  await waitFor(() => expect(hook.result.current.state.prompt?.title).toBe("Recovered text file"));
  await act(async () => hook.result.current.actions.answer(answer));
}

async function seedRecovery(backend: Awaited<ReturnType<typeof project>>["backend"], root: string, path: string) {
  const disk = await backend.projectReadText(root, path);
  const recoveredText = `${disk.text}# recovered edit\n`;
  await backend.writeProjectTextRecovery(root, path, recoveredText, disk.text, disk.version);
  return { disk, recoveredText };
}

it("backs up only modified text tabs and leaves the project file untouched", async () => {
  const { backend, hook, root, path, id } = await project();
  await act(async () => hook.result.current.actions.openProjectFile(path, "text"));
  const tab = hook.result.current.fileTabs.find((item) => item.id === id)!;
  const original = await backend.projectReadText(root, path);
  const edited = `${tab.text}# edit\n`;
  await act(async () => hook.result.current.actions.editFile(id, edited));
  await act(async () => hook.result.current.actions.autosave());

  expect(await backend.projectTextRecoveryFor(root, path)).toEqual({
    text: edited,
    saved: original.text,
    version: original.version,
  });
  expect(await backend.projectReadText(root, path)).toEqual(original);

  await act(async () => hook.result.current.actions.editFile(id, tab.text));
  await act(async () => hook.result.current.actions.autosave());
  expect(await backend.projectTextRecoveryFor(root, path)).toBeNull();
});

it("restores recovered text with its saved baseline and version", async () => {
  const { backend, hook, root, path, id } = await project();
  const { disk, recoveredText } = await seedRecovery(backend, root, path);
  await act(async () => { void hook.result.current.actions.openProjectFile(path, "text"); });
  await answerRecovery(hook, "recover");

  const tab = hook.result.current.fileTabs.find((item) => item.id === id)!;
  expect(tab).toMatchObject({ text: recoveredText, saved: disk.text, version: disk.version });
  expect(tab.text).not.toBe(tab.saved);
  expect(await backend.projectTextRecoveryFor(root, path)).toMatchObject({ text: recoveredText, saved: disk.text, version: disk.version });
  expect(await backend.projectReadText(root, path)).toEqual(disk);
});

it("discards the recovery backup and opens the on-disk text", async () => {
  const { backend, hook, root, path, id } = await project();
  const { disk } = await seedRecovery(backend, root, path);
  await act(async () => { void hook.result.current.actions.openProjectFile(path, "text"); });
  await answerRecovery(hook, "discard");

  expect(hook.result.current.fileTabs.find((item) => item.id === id)).toMatchObject({ text: disk.text, saved: disk.text, version: disk.version });
  expect(await backend.projectTextRecoveryFor(root, path)).toBeNull();
  expect(await backend.projectReadText(root, path)).toEqual(disk);
});

it("cancels recovery without opening a tab or changing the worksheet", async () => {
  const { backend, hook, root, path, id } = await project();
  await seedRecovery(backend, root, path);
  const worksheetIds = hook.result.current.state.docs.map((doc) => doc.id);
  await act(async () => { void hook.result.current.actions.openProjectFile(path, "text"); });
  await answerRecovery(hook, "cancel");

  expect(hook.result.current.fileTabs.some((tab) => tab.id === id)).toBe(false);
  expect(hook.result.current.state.docs.map((doc) => doc.id)).toEqual(worksheetIds);
  expect(await backend.projectTextRecoveryFor(root, path)).not.toBeNull();
});

it("keeps recovered edits and backup when the source changed before Save", async () => {
  const { backend, hook, root, path, id } = await project();
  const { disk, recoveredText } = await seedRecovery(backend, root, path);
  backend.changeProjectTextExternally(root, path, "changed outside Equavela\n");
  await backend.writeProjectTextRecovery(root, path, recoveredText, disk.text, disk.version);
  await act(async () => { void hook.result.current.actions.openProjectFile(path, "text"); });
  await answerRecovery(hook, "recover");

  const tab = hook.result.current.fileTabs.find((item) => item.id === id) as FileTab;
  expect(await act(async () => hook.result.current.actions.saveFile(id))).toBe(false);
  expect(hook.result.current.fileTabs.find((item) => item.id === id)).toMatchObject({ text: recoveredText, saved: disk.text, version: disk.version });
  expect(await backend.projectTextRecoveryFor(root, path)).toMatchObject({ text: recoveredText, version: disk.version });
  expect(await backend.projectReadText(root, path)).toMatchObject({ text: "changed outside Equavela\n", version: "v2" });
  expect(tab.text).toBe(recoveredText);
});

it("clears the recovery sidecar after a successful save", async () => {
  const { backend, hook, root, path, id } = await project();
  const { disk, recoveredText } = await seedRecovery(backend, root, path);
  await act(async () => { void hook.result.current.actions.openProjectFile(path, "text"); });
  await answerRecovery(hook, "recover");

  await act(async () => { expect(await hook.result.current.actions.saveFile(id)).toBe(true); });
  expect(await backend.projectTextRecoveryFor(root, path)).toBeNull();
  expect(await backend.projectReadText(root, path)).toMatchObject({ text: recoveredText, version: "v2" });
  expect(hook.result.current.fileTabs.find((tab) => tab.id === id)).toMatchObject({ text: recoveredText, saved: recoveredText, version: "v2" });
  expect(disk.text).not.toBe(recoveredText);
});

it("backs up a still-open dirty buffer again after discarding its stored copy in the browser", async () => {
  const { backend, hook, root, path, id } = await project();
  await act(async () => hook.result.current.actions.openProjectFile(path, "text"));
  act(() => hook.result.current.actions.editFile(id, "# current unsaved work"));
  await act(async () => hook.result.current.actions.autosave());
  const entry = (await backend.listProjectTextRecoveries()).entries[0];
  await act(async () => hook.result.current.actions.discardRecoveredTextEntry(entry.id));
  expect(await backend.projectTextRecoveryFor(root, path)).toBeNull();
  await act(async () => hook.result.current.actions.autosave());
  expect((await backend.projectTextRecoveryFor(root, path))?.text).toBe("# current unsaved work");
});

it("still opens the source and retains the backup when recovery cannot be read", async () => {
  const { backend, hook, root, path, id } = await project();
  const { disk } = await seedRecovery(backend, root, path);
  const discard = vi.spyOn(backend, "discardProjectTextRecovery");
  vi.spyOn(backend, "projectTextRecoveryFor").mockRejectedValueOnce({ message: "invalid recovery JSON" });
  await act(async () => hook.result.current.actions.openProjectFile(path, "text"));
  expect(hook.result.current.fileTabs.find(tab => tab.id === id)?.text).toBe(disk.text);
  expect(hook.result.current.state.message).toContain("invalid recovery JSON");
  expect(discard).not.toHaveBeenCalled();
  await act(async () => { expect(await hook.result.current.actions.closeFile(id)).toBe(true); });
  expect(discard).not.toHaveBeenCalled();
});

it("waits for an in-flight backup before saving so it cannot resurrect afterward", async () => {
  const { backend, hook, root, path, id } = await project();
  await act(async () => hook.result.current.actions.openProjectFile(path, "text"));
  const tab = hook.result.current.fileTabs.find((item) => item.id === id)!;
  await act(async () => hook.result.current.actions.editFile(id, `${tab.text}# edit\n`));

  let releaseBackup!: () => void;
  let markBackupStarted!: () => void;
  const backupGate = new Promise<void>((resolve) => { releaseBackup = resolve; });
  const backupStarted = new Promise<void>((resolve) => { markBackupStarted = resolve; });
  const writeBackup = backend.writeProjectTextRecovery.bind(backend);
  vi.spyOn(backend, "writeProjectTextRecovery").mockImplementation(async (...args) => {
    markBackupStarted();
    await backupGate;
    await writeBackup(...args);
  });
  const writeSource = vi.spyOn(backend, "projectWriteText");

  let autosaving!: Promise<void>;
  act(() => { autosaving = hook.result.current.actions.autosave(); });
  await backupStarted;
  const saving = hook.result.current.actions.saveFile(id);
  await Promise.resolve();
  expect(writeSource).not.toHaveBeenCalled();

  releaseBackup();
  await act(async () => { await Promise.all([autosaving, saving]); });
  expect(writeSource).toHaveBeenCalledTimes(1);
  expect(await backend.projectTextRecoveryFor(root, path)).toBeNull();
  expect((await backend.projectReadText(root, path)).text).toContain("# edit");
});

it("does not back up a later tab that closed while an earlier backup was pending", async () => {
  const { backend, hook, path, id } = await project();
  await act(async () => hook.result.current.actions.openProjectFile(path, "text"));
  await act(async () => hook.result.current.actions.openProjectFile("julia/Project.toml", "text"));
  act(() => {
    hook.result.current.actions.editFile(id, "# first");
    hook.result.current.actions.editFile("/work/beam/julia/Project.toml", "# second");
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = backend.writeProjectTextRecovery;
  const backup = vi.spyOn(backend, "writeProjectTextRecovery").mockImplementation(async (...args) => {
    await gate;
    return original(...args);
  });
  let autosaving!: Promise<void>;
  act(() => { autosaving = hook.result.current.actions.autosave(); });
  await waitFor(() => expect(backup).toHaveBeenCalledOnce());
  let closing!: Promise<boolean>;
  act(() => { closing = hook.result.current.actions.closeFile("/work/beam/julia/Project.toml"); });
  await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
  await act(async () => { hook.result.current.actions.answer("discard"); await closing; });
  await act(async () => { release(); await autosaving; });
  expect(backup).toHaveBeenCalledOnce();
  expect(await backend.projectTextRecoveryFor("/work/beam", "julia/Project.toml")).toBeNull();
});
