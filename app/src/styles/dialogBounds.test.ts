// the specification : a dialog never runs below the window; it scrolls inside instead. jsdom does
// not apply stylesheets, so the rules are read from the shipped chrome.css (as paletteDensity.test.ts).
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = ["src/styles/chrome.css", "app/src/styles/chrome.css"].filter(existsSync).map((path) => readFileSync(path, "utf8"))[0]
  .replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";

it("bounds every dialog by the window and scrolls it inside", () => {
  expect(rule(".dialog-backdrop")).toMatch(/padding-top: var\(--dialog-top\)/);
  expect(rule(".dialog-backdrop")).toMatch(/--dialog-top: min\(120px, 12vh\)/);
  const dialog = rule(".dialog");
  expect(dialog).toMatch(/max-height: calc\(100vh - var\(--dialog-top, 0px\)/);
  expect(dialog).toMatch(/overflow: auto/);
  expect(dialog).toMatch(/overscroll-behavior: contain/);
});
