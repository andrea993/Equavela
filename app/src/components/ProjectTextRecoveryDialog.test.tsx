import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectTextRecovery, ProjectTextRecoveryListing } from "../equavelaApi";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import { ProjectTextRecoveryDialog } from "./ProjectTextRecoveryDialog";

afterEach(cleanup);

const listing: ProjectTextRecoveryListing = {
  entries: [
    { id: "old", root: "/gone/old-project", path: "src/beam.jl", modified_ms: 1_780_000_000_000 },
    { id: "new", root: "/gone/new-project", path: "data/loads.csv", modified_ms: 1_780_000_000_001 },
  ],
  unreadable: 2,
};
const recovered = (text: string): ProjectTextRecovery => ({ text, saved: "2026-11-16T10:00:00Z", version: "v2" });

it("lists source paths and previews selected backups without binding to their missing projects", async () => {
  const read = vi.fn(async (id: string) => recovered(id === "old" ? "module Beam\nend" : "load,stress\n1,2"));
  render(<ProjectTextRecoveryDialog load={async () => listing} read={read} exportCopy={async () => null} discard={async () => {}} onClose={() => {}} />);
  expect(await screen.findByText("/gone/old-project")).toBeTruthy();
  expect(screen.getByText("src/beam.jl")).toBeTruthy();
  expect(screen.getByText(S.project.recoveryUnreadable(2))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /data\/loads\.csv/ }));
  await waitFor(() => expect(document.querySelector(".project-text-recovery-preview pre")?.textContent).toBe("load,stress\n1,2"));
  fireEvent.click(screen.getByRole("button", { name: /src\/beam\.jl/ }));
  await waitFor(() => expect(document.querySelector(".project-text-recovery-preview pre")?.textContent).toBe("module Beam\nend"));
  expect(read).toHaveBeenNthCalledWith(2, "old");
});

it("ignores stale preview responses when selection changes quickly", async () => {
  let resolveOld!: (value: ProjectTextRecovery) => void;
  const read = vi.fn((id: string) => id === "old"
    ? new Promise<ProjectTextRecovery>((resolve) => { resolveOld = resolve; })
    : Promise.resolve(recovered("newer selection")));
  render(<ProjectTextRecoveryDialog load={async () => listing} read={read} exportCopy={async () => null} discard={async () => {}} onClose={() => {}} />);
  await screen.findByText("/gone/old-project");
  fireEvent.click(screen.getByRole("button", { name: /src\/beam\.jl/ }));
  fireEvent.click(screen.getByRole("button", { name: /data\/loads\.csv/ }));
  expect(await screen.findByText("newer selection")).toBeTruthy();
  resolveOld(recovered("stale preview"));
  await waitFor(() => expect(screen.queryByText("stale preview")).toBeNull());
});

it("ignores stale refresh responses", async () => {
  const resolvers: ((value: ProjectTextRecoveryListing) => void)[] = [];
  const load = vi.fn(() => new Promise<ProjectTextRecoveryListing>((resolve) => resolvers.push(resolve)));
  render(<ProjectTextRecoveryDialog load={load} read={async () => recovered("x")} exportCopy={async () => null} discard={async () => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: S.project.refreshResources }));
  fireEvent.click(screen.getByRole("button", { name: S.project.refreshResources }));
  expect(load).toHaveBeenCalledTimes(3);
  resolvers[2](listing);
  await screen.findByText("/gone/old-project");
  resolvers[1]({ entries: [], unreadable: 0 });
  await waitFor(() => expect(screen.getByText("/gone/old-project")).toBeTruthy());
});

it("exports a recovered copy without discarding the backup and treats chooser cancellation as no-op", async () => {
  const exportCopy = vi.fn().mockResolvedValueOnce("/recovered/beam.jl").mockResolvedValueOnce(null);
  const discard = vi.fn(async () => {});
  render(<ProjectTextRecoveryDialog load={async () => listing} read={async () => recovered("source") } exportCopy={exportCopy} discard={discard} onClose={() => {}} />);
  await screen.findByText("/gone/old-project");
  fireEvent.click(screen.getByRole("button", { name: /src\/beam\.jl/ }));
  await screen.findByText("source");
  const save = screen.getByRole("button", { name: S.project.recoverySaveCopy });
  fireEvent.click(save);
  expect(await screen.findByText(S.project.recoverySavedCopy("/recovered/beam.jl"))).toBeTruthy();
  expect(discard).not.toHaveBeenCalled();
  fireEvent.click(save);
  await waitFor(() => expect(exportCopy).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(S.project.recoverySavedCopy("/recovered/beam.jl"))).toBeNull();
  expect(discard).not.toHaveBeenCalled();
});

it("requires explicit discard confirmation, then refreshes the listing", async () => {
  const discard = vi.fn(async () => {});
  const load = vi.fn().mockResolvedValueOnce(listing).mockResolvedValueOnce({ entries: [], unreadable: 0 });
  render(<ProjectTextRecoveryDialog load={load} read={async () => recovered("text")} exportCopy={async () => null} discard={discard} onClose={() => {}} />);
  await screen.findByText("/gone/old-project");
  fireEvent.click(screen.getByRole("button", { name: /src\/beam\.jl/ }));
  await screen.findByText("text");
  fireEvent.click(screen.getByRole("button", { name: S.project.recoveryDiscard }));
  expect(discard).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: S.project.recoveryDiscardConfirm })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("group", { name: S.project.recoveryDiscardConfirm })).getByRole("button", { name: S.project.recoveryDiscard }));
  await waitFor(() => expect(discard).toHaveBeenCalledWith("old"));
  expect(await screen.findByText(S.project.recoveryEmpty)).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it("shows read errors and closes on Escape while restoring the previous focus", async () => {
  render(<button type="button">opener</button>);
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  const onClose = vi.fn();
  const { unmount } = render(<ProjectTextRecoveryDialog load={async () => ({ entries: listing.entries.slice(0, 1), unreadable: 1 })} read={async () => { throw { message: "backup cannot be read" }; }} exportCopy={async () => null} discard={async () => {}} onClose={() => { onClose(); unmount(); }} />);
  await screen.findByText("/gone/old-project");
  fireEvent.click(screen.getByRole("button", { name: /src\/beam\.jl/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("backup cannot be read");
  const dialog = screen.getByRole("dialog", { name: S.project.recoveryBrowserTitle });
  const close = screen.getByRole("button", { name: S.environment.close });
  close.focus();
  fireEvent.keyDown(close, { key: "Tab" });
  expect(document.activeElement).toBe(dialog.querySelector("button"));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(document.activeElement).toBe(opener);
});

it("reads, exports and discards mock backups without needing an original project folder", async () => {
  const backend = createMockBackend({ fast: true });
  const entry = { id: "/gone/project/src/code.jl", root: "/gone/project", path: "src/code.jl", modified_ms: 1_780_000_000_000 };
  const newer = { id: "/other/project/readme.txt", root: "/other/project", path: "readme.txt", modified_ms: entry.modified_ms + 10 };
  backend.seedTextRecoveryEntries([entry, newer], { [entry.id]: recovered("recovered Julia source") }, 1);
  expect(await backend.listProjectTextRecoveries()).toEqual({ entries: [newer, entry], unreadable: 1 });
  expect(await backend.readProjectTextRecovery(entry.id)).toEqual(recovered("recovered Julia source"));
  expect(await backend.exportProjectTextRecovery(entry.id)).toBe("/recovered/code.jl");
  await backend.discardProjectTextRecoveryEntry(entry.id);
  await backend.discardProjectTextRecoveryEntry(entry.id);
  expect(await backend.listProjectTextRecoveries()).toEqual({ entries: [newer], unreadable: 1 });
});
