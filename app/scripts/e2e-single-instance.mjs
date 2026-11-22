// Single-instance forwarding on a built app (Windows/WebView2, DevTools protocol):
//   1. start the app with a .eqv; start it again with another .eqv path (what a double-click on a second
//      file does);
//   2. the second process exits by itself, exactly one app process stays, and exactly one kernel
//      (julia) process is a child of it;
//   3. the running instance shows the new file in a new tab, its window is restored,
//      and a relative path resolves against the working directory of the second launch;
//   4. a launch without a file only focuses the window.
// Usage (repository root): EQUAVELA_APP_EXE=<exe> node app/scripts/e2e-single-instance.mjs
// Exit code = number of failed checks. The app it starts is killed at the end.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const { startApp, EXE } = await import("./real-app.mjs");
const { harness } = await import("./harness.mjs");

const dir = mkdtempSync(resolve(tmpdir(), "equavela-single-")).replaceAll("\\", "/");
const head = "format: equavela-worksheet/3\npage:\n  size: A4\n  margins: {top: 72, right: 54, bottom: 72, left: 54}\n";
const region = (id, y, math) => `  - id: ${id}\n    page: 1\n    at: [54, ${y}]\n    math: "${math}"\n`;
for (const [name, math] of [["first", "1+1="], ["second", "2+2="], ["third", "3+3="]]) {
  writeFileSync(`${dir}/${name}.eqv`, `${head}regions:\n${region("m1", 100, math)}`);
}

const powershell = (command) => execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim();
const exePath = resolve(EXE).replaceAll("/", "\\");
const appProcesses = () =>
  powershell(`(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exePath}' } | Measure-Object).Count`);
// The top-level window of the app process (user32), by the handle read while it is visible.
let handle = "0";
const window = (call, argument = "") =>
  powershell(
    `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);'; ` +
      `[W.U]::${call}([IntPtr]${handle}${argument === "" ? "" : ", " + argument})` + (call === "SendMessage" ? " | Out-Null" : ""),
  );
const second = (args, cwd) =>
  new Promise((done) => {
    const child = spawn(resolve(EXE), args, { cwd, stdio: "ignore" });
    const timer = setTimeout(() => done({ code: "timeout", pid: child.pid }), 15000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ code, pid: child.pid });
    });
  });

const b = await startApp({ port: 9698, args: [`${dir}/first.eqv`] });
const h = harness(b);
const { check, until } = h;
let failed = 1;
try {
  const tabs = () => b.eval(`[...document.querySelectorAll('.doc-tab-name')].map((e) => e.textContent)`);
  check("the first instance shows its worksheet", await until(async () => (await tabs()).includes("first"), 30000), JSON.stringify(await tabs()));
  check("its kernel computes 1+1= = 2", await until(async () => (await h.result("m1")) === "2", 240000), `${await h.result("m1")}`);
  check("one app process before the second launch", appProcesses() === "1", appProcesses());

  // Minimise, then launch again with a path: the window must come back.
  handle = powershell(`(Get-Process -Id ${b.pid}).MainWindowHandle`);
  // WM_SYSCOMMAND / SC_MINIMIZE: what the minimise button does (the app's own window state follows it).
  window("SendMessage", "0x112, [IntPtr]0xF020, [IntPtr]0");
  await new Promise((r) => setTimeout(r, 500));
  check("the window is minimised before the second launch", window("IsIconic") === "True", window("IsIconic"));
  const before = await tabs();
  const result = await second([`${dir}/second.eqv`], dir);
  check("the second launch exits by itself with code 0", result.code === 0, JSON.stringify(result));
  check("a new tab 'second' appears in the running instance", await until(async () => (await tabs()).includes("second"), 20000), JSON.stringify(await tabs()));
  check("exactly one new tab", (await tabs()).length === before.length + 1, JSON.stringify(await tabs()));
  check("the window was restored", await until(async () => window("IsIconic") === "False", 5000), window("IsIconic"));
  check("still one app process", appProcesses() === "1", appProcesses());

  // A relative path resolves against the cwd of the second launch.
  const relative = await second(["third.eqv"], dir);
  check("a relative path: second launch exits with code 0", relative.code === 0, JSON.stringify(relative));
  check("a new tab 'third' appears", await until(async () => (await tabs()).includes("third"), 20000), JSON.stringify(await tabs()));

  // No file: nothing opens.
  const count = (await tabs()).length;
  const bare = await second([], dir);
  check("a launch without a file exits with code 0", bare.code === 0, JSON.stringify(bare));
  await new Promise((r) => setTimeout(r, 1500));
  check("and opens nothing", (await tabs()).length === count, JSON.stringify(await tabs()));

  await h.idle(240000);
  check("the forwarded worksheet computes 2+2= = 4", await until(async () => (await h.result("m1")) !== null, 60000));
  const kernels = powershell(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${b.pid} AND Name='julia.exe'" | Measure-Object).Count`);
  check("exactly one kernel process under the first instance", kernels === "1", kernels);
  check("still one app process at the end", appProcesses() === "1", appProcesses());
  failed = 0;
} catch (error) {
  console.log("ERROR", error?.stack ?? error);
} finally {
  await b.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(h.done() + failed);
