import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportReportDialog } from "./Chrome";
import { S } from "../strings";
import type { ImportReport } from "../equavelaApi";

const report: ImportReport = {
  regions_total: 5,
  regions_imported: 3,
  page_breaks: 0,
  issues: [
    { code: "plot-not-imported", region: "12", message: "a 3D plot is not imported" },
    { code: "include-not-imported", region: "7", message: "include of `other.mcdx` is not imported yet" },
  ],
  notes: [{ code: "plot-limits-frozen", region: "9", message: "the x limit -π/ω_0 was frozen to -1.57" }],
};

afterEach(cleanup);

describe("the import report", () => {
  it("lists every issue and note with its region and message, and hints how to bring an include over", () => {
    render(<ImportReportDialog report={report} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: S.importReport.title });
    expect(within(dialog).getByText(S.importReport.summary(3, 5))).toBeTruthy();
    const issues = within(dialog).getByRole("region", { name: S.importReport.issues });
    const rows = within(issues).getAllByRole("row").slice(1).map((row) => row.textContent);
    expect(rows).toEqual([
      "plot-not-imported12a 3D plot is not imported",
      "include-not-imported7include of `other.mcdx` is not imported yet",
    ]);
    expect(within(dialog).getByText(S.importReport.includeHint)).toBeTruthy();
    const notes = within(dialog).getByRole("region", { name: S.importReport.notes });
    expect(within(notes).getByText("plot-limits-frozen")).toBeTruthy();
  });

  it("says so when nothing was imported in the session, and closes with Close or Escape", () => {
    const onClose = vi.fn();
    render(<ImportReportDialog report={null} onClose={onClose} />);
    expect(screen.getByText(S.importReport.none)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: S.importReport.close }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("Help > Keyboard Shortcuts", () => {
  it("shows the sheet of the active layout grouped by context, and switches layout", async () => {
    const { ShortcutSheetDialog } = await import("./Chrome");
    render(<ShortcutSheetDialog initialLayout="it-IT" onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: S.shortcutSheet.title });
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toContain(S.shortcutSheet.layouts["it-IT"]);
    expect(within(dialog).getByRole("region", { name: S.shortcutSheet.contexts.global })).toBeTruthy();
    expect(within(dialog).getAllByText("Ctrl+Shift+ò").length).toBeGreaterThan(0);
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "en-US" } });
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toContain(S.shortcutSheet.layouts["en-US"]);
    expect(within(dialog).queryByText("Ctrl+Shift+ò")).toBeNull();
  });
});
