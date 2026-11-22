// command names in the chrome font, glyph entries in the math font.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { buildCommandItems } from "../catalog/commands";
import { S } from "../strings";
import { CommandPalette } from "./CommandPalette";

afterEach(cleanup);

it("marks glyph entries for the math font and leaves command names in the chrome font", () => {
  render(<CommandPalette items={buildCommandItems("en-US")} onRun={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("searchbox", { name: S.commands.search }), { target: { value: "save worksheet" } });
  expect(screen.getByText("Save worksheet").className).toBe("command-label");
  fireEvent.change(screen.getByRole("searchbox", { name: S.commands.search }), { target: { value: "kN" } });
  expect(screen.getAllByText("kN")[0].className).toBe("command-label glyph");
  const css = readFileSync("src/styles/chrome.css", "utf8");
  expect(css).toMatch(/\.command-label \{[^}]*font-family: "Noto Sans";/);
  expect(css).toMatch(/\.command-label\.glyph \{[^}]*"MC Math"/);
});
