// Import of a real the reference application worksheet in the real desktop app:
//   1. `window.__equavela.openPath(<.mcdx>)` (what File > Import and the Open dialog do after the native
//      dialog) imports the file as a new UNTITLED worksheet with regions on the page;
//   2. the notice says how many regions came over and what is missing;
//   3. the kernel computes the imported math (a result shows up);
//   4. the `.mcdx` is untouched (bytes and modified time) and nothing was written next to it.
// Usage: EQUAVELA_MCDX_SAMPLE=<path of a .mcdx> EQUAVELA_APP_EXE=<equavela-app.exe> node app/scripts/e2e-import.mjs
// The sample is only read; it is never copied. Exit code = number of failed checks.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

const sample = process.env.EQUAVELA_MCDX_SAMPLE;
if (!sample || !existsSync(sample)) {
  console.log("EQUAVELA_MCDX_SAMPLE is not set (or missing): skipped");
  process.exit(0);
}
const { startApp } = await import("./real-app.mjs");
const { harness } = await import("./harness.mjs");

const folder = dirname(sample);
const fingerprint = () => ({
  sha: createHash("sha256").update(readFileSync(sample)).digest("hex"),
  mtime: statSync(sample).mtimeMs,
  listing: readdirSync(folder).sort().join("|"),
});
const before = fingerprint();

const b = await startApp({ port: 9698, args: [] });
const h = harness(b);
const { check, until } = h;
let failed = 1;
try {
  await until(async () => (await b.eval("location.href")).includes("tauri.localhost") && (await h.q("[data-testid=kernel-status]")), 30000);
  await until(async () => (await b.eval("typeof window.__equavela")) === "object", 30000);
  const tabs = () => b.eval(`[...document.querySelectorAll('.doc-tab-name')].map((e) => e.textContent)`);
  await until(async () => (await tabs()).length >= 1, 30000); // the start-up worksheet
  const count = (await tabs()).length;
  await b.eval(`void window.__equavela.openPath(${JSON.stringify(sample.replaceAll("\\", "/"))})`);
  check("a new tab opens", await until(async () => (await tabs()).length === count + 1, 60000), JSON.stringify(await tabs()));
  const name = (await tabs()).at(-1);
  check("the worksheet is untitled", /^Untitled/.test(name), name);
  check("regions are on the page", await until(async () => (await h.count("[data-region-id]")) > 0, 30000), `${await h.count("[data-region-id]")}`);
  const body = await b.eval("document.body.innerText");
  const notice = /Imported (\d+) of (\d+) regions from [^\n]*/.exec(body);
  check("the notice reports the import", notice !== null, notice ? notice[0] : "no notice");
  console.log(`INFO  ${notice ? notice[0] : ""} regions on the first page: ${await h.count("[data-region-id]")}`);
  const ids = await h.mathIds();
  const got = await until(async () => {
    for (const id of ids) if ((await h.result(id)) !== null) return true;
    return false;
  }, 240000);
  check("the kernel computes imported math (a result shows)", got);
  const after = fingerprint();
  check("the .mcdx is unchanged", after.sha === before.sha && after.mtime === before.mtime);
  check("nothing was written next to it", after.listing === before.listing);
  failed = 0;
} catch (error) {
  console.log("ERROR", error?.stack ?? error);
} finally {
  await b.close().catch(() => {});
}
process.exit(h.done() + failed);
