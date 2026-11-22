import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

afterEach(cleanup);

it("discovers and exports a backup without opening its missing original project", async () => {
  const backend = createMockBackend({ fast: true });
  await backend.writeProjectTextRecovery("/missing/project", "src/test.jl", "f(x) = x + 1\n", "", "old-version");
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  const sourceRead = vi.spyOn(backend, "projectReadText");
  fireEvent.click(screen.getByRole("tab", { name: "Help" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.commandPalette }));
  const search = await screen.findByRole("searchbox", { name: S.commands.search });
  fireEvent.change(search, { target: { value: "Recovered text files" } });
  fireEvent.keyDown(search, { key: "Enter" });
  const dialog = await screen.findByRole("dialog", { name: S.project.recoveryBrowserTitle });
  const entry = await within(dialog).findByRole("button", { name: /src\/test\.jl/ });
  fireEvent.click(entry);
  await within(dialog).findByText("f(x) = x + 1");
  fireEvent.click(within(dialog).getByRole("button", { name: S.project.recoverySaveCopy }));
  await within(dialog).findByText(S.project.recoverySavedCopy("/recovered/test.jl"));
  expect((await backend.listProjectTextRecoveries()).entries).toHaveLength(1);
  expect(sourceRead).not.toHaveBeenCalled();
  expect(screen.queryByRole("navigation", { name: S.project.explorer })).toBeNull();

  fireEvent.click(within(dialog).getByRole("button", { name: S.project.recoveryDiscard }));
  const confirmation = within(dialog).getByRole("group", { name: S.project.recoveryDiscardConfirm });
  fireEvent.click(within(confirmation).getByRole("button", { name: S.project.recoveryDiscard }));
  await waitFor(() => expect(within(dialog).queryByRole("button", { name: /src\/test\.jl/ })).toBeNull());
  expect((await backend.listProjectTextRecoveries()).entries).toHaveLength(0);
});
