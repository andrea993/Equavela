// The Recent menu of the title bar: it lists the
// worksheets opened, imported or saved, most recent first, and choosing one opens it. Runs on the
// mock backend; the list lives in localStorage.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { readRecentFiles, RECENT_FILES_KEY, writeRecentFiles } from "../recentFiles";
import { S } from "../strings";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

/** The page's test hook (`Workbench.tsx`), typed for the calls of these tests. */
function pageOpen(): (path: string) => Promise<boolean> {
  return (window as unknown as { __equavela: { openPath: (path: string) => Promise<boolean> } })
    .__equavela.openPath;
}

const openPath = (path: string) => act(async () => void (await pageOpen()(path)));
const recentButton = () => screen.getByRole("button", { name: S.quickAccess.recent }) as HTMLButtonElement;
const recentMenu = () => screen.queryByRole("menu", { name: S.quickAccess.recentFiles });

/** Starts the app with no startup worksheet, so the recent list starts from the test's seed. */
async function startApp(options: { seed?: string[]; paths?: boolean } = {}) {
  if (options.seed) writeRecentFiles(options.seed);
  const backend = createMockBackend({ fast: true });
  vi.spyOn(backend, "initialWorksheet").mockResolvedValue(null);
  if (options.paths !== false) {
    // The mock serves the demo worksheet whatever the path is: keep the path the caller asked for,
    // as the real backend does (the Recent menu remembers the file that was opened).
    const served = backend.openWorksheet.bind(backend);
    vi.spyOn(backend, "openWorksheet").mockImplementation(async (path) => {
      const opened = await served(path);
      return { ...opened, root: path, view: { ...opened.view, document: path } };
    });
  }
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

describe("the Recent button of the title bar", () => {
  it("is disabled while no worksheet has been opened, with a tooltip", async () => {
    await startApp({ paths: false });
    expect(recentButton().disabled).toBe(true);
    expect(recentButton().title).toBe(S.quickAccess.noRecentFiles);
    expect(recentMenu()).toBeNull();
  });

  it("lists the recent files, most recent first, and choosing one opens it", async () => {
    const backend = await startApp({ seed: ["/work/one.eqv", "/work/two.eqv"] });
    expect(recentButton().disabled).toBe(false);
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.querySelector(".recent-file-name")?.textContent)).toEqual(["one.eqv", "two.eqv"]);
    expect(items[0].textContent).toContain("/work");
    // The list is a keyboard menu: the first entry has the focus, the arrows walk the entries.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.click(items[1]);
    expect(recentMenu()).toBeNull();
    await waitFor(() => expect(readRecentFiles()).toEqual(["/work/two.eqv", "/work/one.eqv"]));
    expect(vi.mocked(backend.openWorksheet)).toHaveBeenCalledWith("/work/two.eqv");
  });

  it("closes on Escape and returns the focus to its button, and on a press outside", async () => {
    await startApp({ seed: ["/work/one.eqv"] });
    await openMenu();
    fireEvent.keyDown(recentMenu()!, { key: "Escape" });
    expect(recentMenu()).toBeNull();
    expect(document.activeElement).toBe(recentButton());
    await openMenu();
    fireEvent.pointerDown(document.querySelector(".page")!);
    expect(recentMenu()).toBeNull();
  });

  it("brings a worksheet already open to the front instead of opening a second copy", async () => {
    const backend = await startApp();
    await openPath("/work/one.eqv");
    await waitFor(() => expect(recentButton().disabled).toBe(false));
    const opened = vi.mocked(backend.openWorksheet).mock.calls.length;
    const tabs = screen.getAllByRole("tab").filter((tab) => tab.closest(".doc-tabs") !== null);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /one/ }).getAttribute("aria-selected")).toBe("true"),
    );
    expect(vi.mocked(backend.openWorksheet).mock.calls.length).toBe(opened);
    expect(screen.getAllByRole("tab").filter((tab) => tab.closest(".doc-tabs") !== null)).toHaveLength(tabs.length);
  });

  it("adds a worksheet to the list when it is saved", async () => {
    await startApp({ paths: false });
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.saveAs }));
    await waitFor(() => expect(readRecentFiles()).toContain("/mock/Untitled-1.eqv"));
    await waitFor(() => expect(recentButton().disabled).toBe(false));
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem").textContent).toContain("Untitled-1.eqv");
  });

  it("keeps the stored list across a restart", async () => {
    window.localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(["/work/kept.eqv"]));
    cleanup();
    await startApp();
    expect(recentButton().disabled).toBe(false);
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem").textContent).toContain("kept.eqv");
  });
});
