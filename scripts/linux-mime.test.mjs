// Exercise the shipped shared-mime-info file without installing it into the user's desktop.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Linux worksheet MIME magic distinguishes worksheets from Objective-C++ and FreeMind", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "equavela-mime-test-"));
  const data = join(dir, "data"), mime = join(data, "mime");
  mkdirSync(join(mime, "packages"), { recursive: true });
  copyFileSync(resolve("packaging/linux/equavela-worksheet.xml"), join(mime, "packages", "equavela-worksheet.xml"));
  // `xdg-mime` asks GLib (`gio info`) under GNOME; without a desktop session it falls back to
  // `file`, which knows nothing of the installed database.
  const env = { ...process.env, XDG_CURRENT_DESKTOP: "GNOME", XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_DIRS: "/usr/local/share:/usr/share" };
  execFileSync("update-mime-database", [mime], { env });
  const query = (name, contents) => {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return execFileSync("xdg-mime", ["query", "filetype", path], { env, encoding: "utf8" }).trim();
  };
  assert.equal(query("worksheet.eqv", "format: equavela-worksheet/1\nregions: []\n"), "application/x-equavela-worksheet");
  assert.equal(query("bom.eqv", "\uFEFFformat: equavela-worksheet/1\nregions: []\n"), "application/x-equavela-worksheet");
  assert.notEqual(query("source.mm", "#include <iostream>\nint main() { return 0; }\n"), "application/x-equavela-worksheet");
  assert.notEqual(query("mindmap.mm", '<map version="1.0.1"><node TEXT="example"/></map>\n'), "application/x-equavela-worksheet");
});

test("Linux desktop entry passes selected worksheet paths to Equavela", { skip: process.platform !== "linux" }, () => {
  const desktop = resolve("packaging/linux/equavela.desktop");
  execFileSync("desktop-file-validate", [desktop]);
  const text = readFileSync(desktop, "utf8");
  assert.match(text, /^Exec=equavela-app %F$/m);
  assert.match(text, /^MimeType=application\/x-equavela-worksheet;application\/x-equavela-portable;$/m);
});
