// The recent projects of the Recent menu:
// the projects created, opened or extracted, above the recent worksheets. Runs on the mock backend;
// the list lives in localStorage.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { RECENT_PROJECTS_KEY, readRecentFiles, writeRecentFiles } from "../recentFiles";
import { S } from "../strings";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const recentButton = () => screen.getByRole("button", { name: S.quickAccess.recent }) as HTMLButtonElement;
const recentMenu = () => screen.queryByRole("menu", { name: S.quickAccess.recentFiles });

async function startApp(seed: { files?: string[]; projects?: string[] } = {}) {
  if (seed.files) writeRecentFiles(seed.files);
  if (seed.projects) writeRecentFiles(seed.projects, RECENT_PROJECTS_KEY);
  const backend = createMockBackend({ fast: true });
  vi.spyOn(backend, "initialWorksheet").mockResolvedValue(null);
  render(<App backend={backend} />);
  await waitFor(() => expect(screen.getByRole("button", { name: S.quickAccess.new })).toBeTruthy());
  return backend;
}

async function openMenu() {
  fireEvent.click(recentButton());
  return waitFor(() => {
    const menu = recentMenu();
    expect(menu).not.toBeNull();
    return menu as HTMLElement;
  });
}

async function command(label: string) {
  fireEvent.click(screen.getByRole("tab", { name: "Help" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.commandPalette }));
  const search = await screen.findByRole("searchbox", { name: S.commands.search });
  fireEvent.change(search, { target: { value: label } });
  fireEvent.keyDown(search, { key: "Enter" });
}

async function newProject(name: string, root: string) {
  await command("new project");
  const dialog = await screen.findByRole("dialog", { name: S.project.newTitle });
  fireEvent.change(within(dialog).getByLabelText(S.project.name), { target: { value: name } });
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: root } });
  fireEvent.click(within(dialog).getByRole("button", { name: S.project.create }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: S.project.newTitle })).toBeNull());
}

describe("recent projects", () => {
  it("enables the Recent button with only recent projects, and shows no headings", async () => {
    await startApp({ projects: ["/work/beam"] });
    expect(recentButton().disabled).toBe(false);
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(1);
    expect(items[0].querySelector(".recent-file-name")?.textContent).toBe("beam");
    expect(items[0].textContent).toContain("/work");
    expect(within(menu).queryByText(S.quickAccess.recentProjects)).toBeNull();
    expect(within(menu).queryByText(S.quickAccess.recentWorksheets)).toBeNull();
  });

  it("lists the projects above the worksheets, under headings, with one keyboard order", async () => {
    await startApp({ files: ["/work/one.eqv"], projects: ["/work/beam", "/work/frame"] });
    const menu = await openMenu();
    const headings = [...menu.querySelectorAll(".recent-heading")].map((h) => h.textContent);
    expect(headings).toEqual([S.quickAccess.recentProjects, S.quickAccess.recentWorksheets]);
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.querySelector(".recent-file-name")?.textContent)).toEqual(["beam", "frame", "one.eqv"]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
  });

  it("remembers a project when it is created and reopens it from the menu", async () => {
    const backend = await startApp();
    await newProject("Beam", "/work/beam");
    await newProject("Frame", "/work/frame");
    expect(JSON.parse(window.localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]")).toEqual(["/work/frame", "/work/beam"]);
    const openProject = vi.spyOn(backend, "openProject");
    const menu = await openMenu();
    fireEvent.click(within(menu).getAllByRole("menuitem")[1]);
    expect(recentMenu()).toBeNull();
    await waitFor(() => expect(openProject).toHaveBeenCalledWith("/work/beam"));
    const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
    await waitFor(() => expect(explorer.textContent).toContain("Beam"));
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]")).toEqual(["/work/beam", "/work/frame"]),
    );
    // Opening a project is not opening a recent file: the worksheet list keeps its own entries.
    expect(readRecentFiles()).not.toContain("/work/beam");
  });

  it("reports a project that no longer opens, opens nothing and keeps the entry", async () => {
    await startApp({ projects: ["/work/gone"] });
    const menu = await openMenu();
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem")));
    await waitFor(() => expect(document.body.textContent).toContain("Project not found."));
    expect(screen.queryByRole("navigation", { name: S.project.explorer })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]")).toEqual(["/work/gone"]);
  });

  it("does not remember a project that failed to be created", async () => {
    await startApp();
    await command("new project");
    const dialog = await screen.findByRole("dialog", { name: S.project.newTitle });
    fireEvent.change(within(dialog).getByLabelText(S.project.name), { target: { value: "Rel" } });
    fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "relative" } });
    fireEvent.click(within(dialog).getByRole("button", { name: S.project.create }));
    await within(dialog).findByRole("alert");
    expect(window.localStorage.getItem(RECENT_PROJECTS_KEY)).toBeNull();
  });
});
