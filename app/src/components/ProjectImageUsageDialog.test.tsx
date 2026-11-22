import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectImageUsage } from "../equavelaApi";
import { S } from "../strings";
import { ProjectImageUsageDialog } from "./ProjectImageUsageDialog";

afterEach(cleanup);

const rows: ProjectImageUsage[] = [
  { path: "assets/images/beam.png", worksheets: ["worksheets/main.eqv"], problem: null },
  { path: "assets/images/missing.svg", worksheets: ["worksheets/check.eqv"], problem: "file is missing" },
  { path: "assets/images/unused.jpg", worksheets: [], problem: null },
];

it("shows available, unavailable and unused resources and opens owner worksheets", async () => {
  const load = vi.fn(async () => rows);
  const onOpenWorksheet = vi.fn(async () => {});
  render(<ProjectImageUsageDialog load={load} onOpenWorksheet={onOpenWorksheet} onClose={() => {}} />);
  expect(await screen.findByText("assets/images/beam.png")).toBeTruthy();
  expect(screen.getByText(S.project.resourceUnavailable).parentElement?.textContent).toContain("file is missing");
  expect(screen.getByText(S.project.resourceUnused)).toBeTruthy();
  expect(screen.getAllByText(S.project.resourceAvailable).length).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "worksheets/main.eqv" }));
  await waitFor(() => expect(onOpenWorksheet).toHaveBeenCalledWith("worksheets/main.eqv"));
  expect(load).toHaveBeenCalledTimes(1);
});

it("refreshes on demand and clears stale rows when refreshing fails", async () => {
  const load = vi.fn().mockResolvedValueOnce(rows).mockRejectedValueOnce(new Error("project is unavailable"));
  render(<ProjectImageUsageDialog load={load} onOpenWorksheet={async () => {}} onClose={() => {}} />);
  expect(await screen.findByText("assets/images/beam.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: S.project.refreshResources }));
  expect((await screen.findByRole("alert")).textContent).toContain("project is unavailable");
  expect(screen.queryByText("assets/images/beam.png")).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
});

it("shows the empty state and restores focus after Escape closes", async () => {
  render(<button type="button">opener</button>);
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  const { unmount } = render(<ProjectImageUsageDialog load={async () => []} onOpenWorksheet={async () => {}} onClose={() => unmount()} />);
  expect(await screen.findByText(S.project.noImageResources)).toBeTruthy();
  const dialog = screen.getByRole("dialog", { name: S.project.imageUsageTitle });
  const last = screen.getByRole("button", { name: S.environment.close });
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(dialog.querySelector("button"));
  fireEvent.keyDown(last, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: S.project.imageUsageTitle })).toBeNull());
  expect(document.activeElement).toBe(opener);
});

it("reports initial load failures without displaying old data", async () => {
  render(<ProjectImageUsageDialog load={async () => { throw { message: "cannot read project" }; }} onOpenWorksheet={async () => {}} onClose={() => {}} />);
  expect((await screen.findByRole("alert")).textContent).toContain("cannot read project");
  expect(screen.queryByText("assets/images/beam.png")).toBeNull();
});

it("keeps focus inside and permits closing during a pending read-only scan", () => {
  const onClose = vi.fn();
  render(<ProjectImageUsageDialog load={() => new Promise(() => {})} onOpenWorksheet={async () => {}} onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: S.project.imageUsageTitle });
  expect(document.activeElement).toBe(dialog);
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: S.environment.close }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});
