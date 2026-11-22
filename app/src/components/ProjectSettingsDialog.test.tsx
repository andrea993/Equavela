import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenedProject } from "../equavelaApi";
import { S } from "../strings";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

afterEach(cleanup);

function openedProject(environment: string | null = "julia"): OpenedProject {
  return {
    root: "/work/beam",
    manifest: {
      format: "equavela-project/1",
      project_id: "11111111-1111-4111-8111-111111111111",
      name: "Beam",
      worksheets: [
        { id: "sheet-main", path: "worksheets/main.eqv" },
        { id: "sheet-check", path: "worksheets/check.eqv" },
      ],
      environment,
    },
    worksheet: null,
  };
}

it("shows the project and closes on Apply, with no main worksheet to choose", () => {
  const onClose = vi.fn();
  render(<ProjectSettingsDialog project={openedProject()} onEnvironment={async () => {}} onReveal={() => {}} onClose={onClose} />);
  expect(screen.getByText("/work/beam")).toBeTruthy();
  expect(screen.getByText("11111111-1111-4111-8111-111111111111")).toBeTruthy();
  expect(screen.getByText("julia")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: S.project.applySettings }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("names the shared environment of a project without one", () => {
  render(<ProjectSettingsDialog project={openedProject(null)} onEnvironment={async () => {}} onReveal={() => {}} onClose={() => {}} />);
  expect(screen.getByText(S.project.sharedEnvironment)).toBeTruthy();
});

it("calls the environment and reveal actions", async () => {
  const onEnvironment = vi.fn(async () => {});
  const onReveal = vi.fn();
  render(<ProjectSettingsDialog project={openedProject()} onEnvironment={onEnvironment} onReveal={onReveal} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: S.project.manageEnvironment }));
  await waitFor(() => expect(onEnvironment).toHaveBeenCalledTimes(1));
  const reveal = screen.getByRole("button", { name: S.project.revealFolder }) as HTMLButtonElement;
  await waitFor(() => expect(reveal.disabled).toBe(false));
  fireEvent.click(reveal);
  expect(onReveal).toHaveBeenCalledTimes(1);
});

it("shows an environment action failure", async () => {
  render(<ProjectSettingsDialog project={openedProject()} onEnvironment={async () => { throw new Error("kernel unavailable"); }} onReveal={() => {}} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: S.project.manageEnvironment }));
  expect((await screen.findByRole("alert")).textContent).toContain("kernel unavailable");
  expect(screen.getByRole("dialog", { name: S.project.settingsTitle })).toBeTruthy();
});

it("traps Tab focus and closes on Escape", async () => {
  render(<button type="button">opener</button>);
  const opener = screen.getByRole("button", { name: "opener" });
  opener.focus();
  const project = openedProject();
  const { unmount } = render(<ProjectSettingsDialog project={project} onEnvironment={async () => {}} onReveal={() => {}} onClose={() => unmount()} />);
  const dialog = screen.getByRole("dialog", { name: S.project.settingsTitle });
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);

  fireEvent.keyDown(last, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: S.project.settingsTitle })).toBeNull());
});
