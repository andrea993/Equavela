// the specification : the project commands in a group of their own in the title bar.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
afterEach(cleanup);

it("offers New, Open and, for a standalone worksheet, Convert to project apart from the quick access", async () => {
  const backend = createMockBackend({ fast: true });
  const choose = vi.spyOn(backend, "chooseFolder").mockResolvedValue(null);
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  const group = screen.getByRole("toolbar", { name: S.quickAccess.projectLabel });
  expect(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).queryByRole("button", { name: S.project.newTitle })).toBeNull();
  fireEvent.click(within(group).getByRole("button", { name: S.project.newTitle }));
  expect(await screen.findByRole("dialog", { name: S.project.newTitle })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: S.project.cancel }));
  fireEvent.click(within(group).getByRole("button", { name: S.project.openTitle }));
  await waitFor(() => expect(choose).toHaveBeenCalledWith(S.project.browseProject, undefined));
  // The demo worksheet is standalone: it can become a project.
  fireEvent.click(within(group).getByRole("button", { name: S.project.convertTitle }));
  expect(await screen.findByRole("dialog", { name: S.project.convertTitle })).toBeTruthy();
});
