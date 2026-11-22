// The shell must not hand the user the browser's tools (GitHub ): no developer tools chord,
// in a debug build or in a release one.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The tests run with the app folder as the working directory.
const read = (path: string) => readFileSync(resolve(process.cwd(), "src-tauri", path), "utf8");

describe("the Tauri shell", () => {
  it("the main window has its devtools off", () => {
    const config = JSON.parse(read("tauri.conf.json")) as { app: { windows: { label: string; devtools?: boolean }[] } };
    const main = config.app.windows.find((window) => window.label === "main");
    expect(main?.devtools).toBe(false);
  });

  it("no cargo feature turns the devtools on in a release build", () => {
    const manifest = read("Cargo.toml");
    expect(manifest).not.toMatch(/features\s*=\s*\[[^\]]*"devtools"/);
    expect(manifest).not.toMatch(/^devtools\s*=/m);
  });

  // Tauri injects a Ctrl+Shift+I listener into every debug build that invokes this command, which opens
  // the developer tools whatever the WebView2 settings say (GitHub ).
  it("the main window may not call Tauri's developer tools toggle", () => {
    const capability = JSON.parse(read("capabilities/default.json")) as { permissions: string[] };
    expect(capability.permissions).toContain("core:webview:deny-internal-toggle-devtools");
    expect(capability.permissions).not.toContain("core:webview:allow-internal-toggle-devtools");
  });
});
