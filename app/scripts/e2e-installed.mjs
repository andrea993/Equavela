// Checks of an INSTALLED build: the exe that the NSIS installer put on disk, not the
// debug build. Driven through the DevTools protocol like the other real-app drivers:
//   1. the app starts and opens a .eqv worksheet given on the command line (what a double-click on a
//      .eqv file does after the file association);
//   2. the kernel starts from the shipped runtime and computes `1+1=`;
//   3. symbolics work with the shipped Python (derivative of x^3 gives 3·x2), offline-capable;
//   4. a second worksheet opens by path through the test hook (the native dialog cannot be driven);
//   5. a `.eqv` file that is not a worksheet is refused with "is not a worksheet" and nothing else changes;
//   6. the kernel process is the shipped Julia with the shipped sysimage, and the per-user depot exists.
// Usage (repository root): node app/scripts/e2e-installed.mjs <path of the installed equavela-app.exe>
// Exit code = number of failed checks. The app it starts is killed at the end.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const exe = process.argv[2];
if (!exe || !existsSync(exe)) throw new Error("usage: node app/scripts/e2e-installed.mjs <installed equavela-app.exe>");
process.env.EQUAVELA_APP_EXE = exe;
const { startApp } = await import("./real-app.mjs");
const { harness } = await import("./harness.mjs");

const dir = mkdtempSync(join(tmpdir(), "equavela-installed-")).replaceAll("\\", "/");
const head = "format: equavela-worksheet/3\npage:\n  size: A4\n  margins: {top: 72, right: 54, bottom: 72, left: 54}\n";
const region = (id, y, math) => `  - id: ${id}\n    page: 1\n    at: [54, ${y}]\n    math: "${math}"\n`;
const first = `${dir}/first.eqv`;
const second = `${dir}/second.eqv`;
const foreign = `${dir}/foreign.eqv`;
writeFileSync(first, `${head}regions:\n${region("m1", 100, "1+1=")}${region("m2", 140, "ⅆ[x] x^3 →")}`);
writeFileSync(second, `${head}regions:\n${region("a1", 100, "a := 5")}${region("a2", 140, "a·2 =")}`);
writeFileSync(foreign, '<map version="1.0.1"><node TEXT="not a worksheet"/></map>\n');

const started = Date.now();
const b = await startApp({ port: 9697, args: [first] });
const h = harness(b);
const { check, until } = h;
let failed = 1;
try {
  await until(async () => (await b.eval("location.href")).includes("tauri.localhost") && (await h.q("[data-testid=kernel-status]")), 30000);
  check("the installed app starts (tauri.localhost, no mock badge)", !(await h.q(".mock-badge")));
  const tabs = () => b.eval(`[...document.querySelectorAll('.doc-tab-name')].map((e) => e.textContent)`);
  check("the .eqv given on the command line is open", await until(async () => (await tabs()).includes("first"), 10000), JSON.stringify(await tabs()));
  console.log(`INFO  window and worksheet up after ${((Date.now() - started) / 1000).toFixed(1)} s`);

  const seen = {};
  const gotResult = await until(async () => {
    for (const id of ["m1", "m2"]) if (seen[id] === undefined && (await h.result(id)) !== null) seen[id] = ((Date.now() - started) / 1000).toFixed(1);
    return seen.m1 !== undefined && seen.m2 !== undefined;
  }, 180000);
  check("the kernel computes 1+1= = 2", gotResult && (await h.result("m1")) === "2", `${await h.result("m1")}`);
  console.log(`INFO  launch to first result 1+1=: ${seen.m1} s; to the symbolic result: ${seen.m2} s (work plan: first calculation under 5 s)`);
  check("kernel status is ready", await h.idle(240000), await h.kernelStatus());
  check("symbolics: d/dx x^3 = 3·x2", (await h.result("m2")) === "3·x2", `${await h.result("m2")}`);

  const before = await tabs();
  await b.eval(`void window.__equavela.openPath(${JSON.stringify(second)})`);
  check("a second worksheet opens by path", await until(async () => (await tabs()).length === before.length + 1, 20000), JSON.stringify(await tabs()));
  await h.idle(120000);
  check("the second worksheet computes a·2 = 10", (await h.result("a2")) === "10", `${await h.result("a2")}`);

  const count = (await tabs()).length;
  await b.eval(`void window.__equavela.openPath(${JSON.stringify(foreign)})`);
  const refused = await until(async () => /is not a worksheet/.test(await b.eval("document.body.innerText")), 10000);
  check("a .eqv that is not a worksheet is refused", refused);
  check("and no tab was added", (await tabs()).length === count, JSON.stringify(await tabs()));

  // Windows reports only the executable as command line of julia.exe, so the sysimage is looked for
  // among the modules mapped into the kernel process instead.
  const installDir = dirname(exe).replaceAll("/", "\\").toLowerCase();
  const listing = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-Process julia -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith('" +
        installDir +
        "') } | ForEach-Object { $p = $_; $_.Modules | Where-Object { $_.FileName -match 'equavelakernel' } | ForEach-Object { $p.Path + ' | ' + $_.FileName } }; Get-Process julia -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith('" +
        installDir +
        "') } | ForEach-Object { 'PROCESS ' + $_.Path }",
    ],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .filter(Boolean);
  check("the kernel is the shipped Julia", listing.some((line) => line.startsWith("PROCESS")), listing.join(" ## "));
  check("started with the shipped sysimage", listing.some((line) => /sysimage[\\/]equavelakernel\.dll/i.test(line) && !line.startsWith("PROCESS")), listing.join(" ## "));
  const depot = join(process.env.LOCALAPPDATA ?? "", "local.equavela.desktop", "depot");
  check("the per-user depot was created", existsSync(depot), depot);
  failed = 0;
} catch (error) {
  console.log("ERROR", error?.stack ?? error);
} finally {
  await b.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(h.done() + failed);
