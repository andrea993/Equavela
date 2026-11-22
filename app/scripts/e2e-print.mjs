// Print / PDF regression in the real desktop app (Tauri + WebView2 + Julia kernel), the specification,
//  and . For each case (A4 portrait, Letter landscape) a fixture worksheet with math,
// text, a full-width text block and a plot is opened and:
//   1. the print view is entered (window.__equavela.enterPrint) with `print` media emulated; checks: chrome and
//      `no-print` elements are hidden, one block per page of exactly the page-setup size, every region is at
//      the same offset from its page corner as in the page view (page breaks equal the screen), every text
//      element uses a bundled font;
//   2. each page block is screenshotted at 2 px per point;
//   3. the PDF is exported through window.__equavela.exportPdf(path) (no dialog) and the view is left;
//   4. app/scripts/pdf-compare.py rasterises the PDF with PyMuPDF and compares it with the screenshots,
// and checks page count, exact page size, embedded bundled fonts, vector text.
// Needs a debug build (`pnpm --dir app tauri build --debug --no-bundle`), `pip install pymupdf numpy pillow`,
// and runs from the repository root:
//   node app/scripts/e2e-print.mjs [--case a4|letter] [outDir]
// Outputs (PDFs, screenshots, diff images, report.json) go to outDir (default app/scripts/out/print, ignored
// by git). Exit code = number of failed checks. Linux: the same script (adjust EXE in real-app.mjs and the
// CDP attachment, which is WebView2 specific, for WebKitGTK) is the regression gate of section 6;
// it has not been run there.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startApp, keyboard } from "./real-app.mjs";
import { harness } from "./harness.mjs";

const args = process.argv.slice(2);
const caseArg = args.includes("--case") ? args[args.indexOf("--case") + 1] : null;
const out = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--case").at(-1) ?? "app/scripts/out/print";
const PPP = 2;
const TALL_VIEWPORT_PX = 4000;
const PYTHON =process.env.PYTHON ?? "python";

const fixture = readFileSync("app/scripts/fixtures/print/print.eqv", "utf8");
const CASES = {
  // `split`: the regions that straddle the bottom edge of their page, as [id, page it starts on]: the print view
  // draws the lower part at the top of the next page. The Letter landscape page is 612 pt high and the plot
  // p1 (y 474, 220 pt high) ends 82 pt below it; on A4 (842 pt) nothing straddles.
  a4: { name: "a4", text: fixture, width: 595.28, height: 841.89, split: [] },
  letter: {
    name: "letter",
    text: fixture.replace("  size: A4\n", "  size: Letter\n  orientation: landscape\n"),
    width: 792,
    height: 612,
    split: [["p1", 1]],
  },
};

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

async function runCase(c, port) {
  console.log(`\n=== case ${c.name} ===`);
  const caseOut = join(out, c.name).replaceAll("\\", "/");
  mkdirSync(caseOut, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "equavela-print-")).replaceAll("\\", "/");
  const file = `${dir}/print.eqv`;
  writeFileSync(file, c.text);
  const pdf = resolve(`${caseOut}/export.pdf`).replaceAll("\\", "/");

  const b = await startApp({ port, args: [file] });
  const h = harness(b);
  try {
    await h.until(async () => (await b.eval("location.href")).includes("tauri.localhost") && (await h.q("[data-testid=kernel-status]")), 30000);
    // The page view mounts only the regions and pages near the visible part of the sheet, so the
    // checks that read the page view (page count, the plot on page 2, the offsets of every region) need a viewport
    // as tall as the whole sheet: the window is emulated that tall, as a user would see it on a very tall monitor.
    // Print is not affected: the print view mounts everything whatever the viewport.
    const width = await b.eval("window.innerWidth");
    await b.send("Emulation.setDeviceMetricsOverride", { width, height: TALL_VIEWPORT_PX, deviceScaleFactor: 0, mobile: false });
    await b.sleep(500);
    check("kernel ready and results calculated", await h.idle(240000), await h.kernelStatus());
    await b.sleep(1500);
    check("the fixture is open with its results", (await h.result("m4")) !== null && (await h.result("m7")) !== null, `M_max = ${await h.result("m4")}, det = ${await h.result("m7")}`);
    check("the SVG and the PNG are drawn as <img> elements with data URLs", await h.until(() => b.eval(`[...document.querySelectorAll("[data-testid=image] img")].filter((i) => i.complete && i.naturalWidth > 0).length === 2`), 20000));
    check("the plot is drawn", await h.until(() => b.eval(`!!document.querySelector('[data-testid=plot-canvas] svg.main-svg')`), 20000));
    check("both y axes and both assigned traces are drawn", await h.until(() => b.eval(`(() => { const p = document.querySelector('[data-testid=plot-canvas]'); return !!p?.querySelector('g.y2') && p.querySelectorAll('.scatterlayer g.trace').length === 2; })()`), 20000));

    // each axis title is drawn once, by the app's band, never also by the drawing library.
    check("each axis title is drawn once, and the library draws none", await b.eval(`(() => {
      const p = document.querySelector('[data-testid=plot-canvas]')?.closest('.plot-region');
      const count = (s) => p?.querySelectorAll(s).length;
      const library = [...(p?.querySelectorAll('svg.main-svg .xtitle, svg.main-svg .ytitle, svg.main-svg .y2title') ?? [])].filter((e) => e.textContent.trim() !== '').length;
      return count('.axis-title.x') === 1 && count('.axis-title.y') === 1 && count('.axis-title.y2') === 1 && library === 0;
    })()`));

    // ---- page view: where every region is, relative to its page ------------------------------------------
    const offsets = (printing) =>
      b.eval(`(() => {
        const sel = ${printing ? "'.sheet > .print-page'" : "'.sheet > .page'"};
        const pages = [...document.querySelectorAll(sel)].map((p) => p.getBoundingClientRect());
        const sheet = document.querySelector('.sheet');
        const zoom = sheet.getBoundingClientRect().width / sheet.offsetWidth || 1;
        const scale = ${printing} ? 1 : zoom;
        const out = {};
        for (const e of document.querySelectorAll('[data-region-id]')) {
          const r = e.getBoundingClientRect();
          const mid = r.top + 2;
          let i = pages.findIndex((p) => mid >= p.top && mid < p.bottom);
          if (i < 0) i = pages.length - 1;
          out[e.dataset.regionId] = [i + 1, (r.left - pages[i].left) / scale, (r.top - pages[i].top) / scale, r.width / scale, r.height / scale];
        }
        return { pages: pages.length, out };
      })()`);
    const screen = await offsets(false);
    check("the page view has pages and regions", screen.pages >= 1 && Object.keys(screen.out).length >= 14, `${screen.pages} pages, ${Object.keys(screen.out).length} regions`);
    const hasStar = () => b.eval(`/\\*/.test(document.querySelector('.doc-tab.active .doc-tab-name')?.textContent ?? '')`);
    check("the worksheet is not modified before printing", !(await hasStar()));
    await b.shot(`${caseOut}/page-view.png`, { x: 0, y: 0, width: 1280, height: 800 });

    // ---- Ctrl+P goes through the keymap to window.print() (stubbed: the native dialog is not driven) ------------
    await b.eval(`(() => {
      window.__printCalls = [];
      window.print = () => {
        window.__printCalls.push({
          view: document.documentElement.classList.contains('print-view'),
          rule: document.querySelector('style[data-print-page]')?.textContent ?? null,
          blocks: document.querySelectorAll('.sheet > .print-page').length,
        });
        window.dispatchEvent(new Event('afterprint'));
      };
    })()`);
    await keyboard(b).chord("p");
    await h.until(async () => (await b.eval(`window.__printCalls.length`)) > 0, 10000);
    const calls = await b.eval(`window.__printCalls`);
    check("Ctrl+P opens the print dialog from the print view with the page setup's paper size", calls.length === 1 && calls[0].view && calls[0].blocks === screen.pages && calls[0].rule === `@page { size: ${c.width}pt ${c.height}pt; margin: 0; }`, JSON.stringify(calls));
    await b.sleep(300);
    check("the print view is left after the dialog", !(await b.eval(`document.documentElement.classList.contains('print-view')`)));

    // ---- print view with print media --------------------------------------------------------------------
    await b.eval(`window.__equavela.enterPrint(null)`);
    await b.eval(`window.__equavela.printReady()`);
    await b.send("Emulation.setEmulatedMedia", { media: "print" });
    await b.sleep(500);
    const print = await offsets(true);
    check("print view: same page count as the page view", print.pages === screen.pages, `${print.pages} / ${screen.pages}`);
    const blocks = await b.eval(`[...document.querySelectorAll('.sheet > .print-page')].map((p) => { const r = p.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })`);
    const wantW = (c.width * 4) / 3;
    const wantH = (c.height * 4) / 3;
    check("print view: every page block is exactly the page-setup size", blocks.every((r) => Math.abs(r[2] - wantW) < 0.02 && Math.abs(r[3] - wantH) < 0.02), JSON.stringify(blocks.map((r) => r.slice(2).map((v) => +v.toFixed(2)))));
    check("print view: pages are contiguous blocks without a gap", blocks.every((r, i) => i === 0 || Math.abs(r[1] - (blocks[i - 1][1] + blocks[i - 1][3])) < 0.02));
    let worst = 0;
    const moved = [];
    for (const [id, p] of Object.entries(screen.out)) {
      const q = print.out[id];
      if (!q) {
        moved.push(`${id} missing`);
        continue;
      }
      const d = Math.max(Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]), Math.abs(p[3] - q[3]), Math.abs(p[4] - q[4]));
      worst = Math.max(worst, d);
      if (q[0] !== p[0] || d > 0.51) moved.push(`${id} page ${p[0]}->${q[0]} d=${d.toFixed(2)}`);
    }
    check("print view: every region on the same page, at the same offset and size as in the page view", moved.length === 0, moved.join("; ") || `largest difference ${worst.toFixed(3)} px`);
    const hidden = await b.eval(`(() => {
      const shown = [...document.querySelectorAll('.chrome, .no-print')].filter((e) => getComputedStyle(e).display !== 'none');
      return shown.map((e) => e.className.toString().slice(0, 40));
    })()`);
    // A collapsed area: the band is printed, its member is not, and a region below it
    // is drawn where the screen draws it and still shows the result calculated from the hidden member.
    const area = await b.eval(`({
      band: document.querySelectorAll('.print-page [data-testid=area][data-collapsed=true]').length,
      member: document.querySelector('[data-region-id=hm]') === null,
      below: document.querySelector('[data-region-id=ar_res]') !== null,
    })`);
    check("print view: a collapsed area prints its band and not its members", area.band === 1 && area.member && area.below, JSON.stringify(area));
    check("a result calculated from a region inside the collapsed area is shown", (await h.result("ar_res")) === "42", String(await h.result("ar_res")));
    // A straddling region is printed split: its lower part is drawn again on the next page, at the offset that
    // makes the two parts continuous (its top above the page block by the page height); it carries no data-region-id,
    // so the checks above saw each region once.
    const parts = await b.eval(`[...document.querySelectorAll('[data-continued-of]')].map((e) => {
      const page = e.closest('.print-page');
      const pages = [...document.querySelectorAll('.sheet > .print-page')];
      const p = page.getBoundingClientRect();
      const r = e.getBoundingClientRect();
      return [e.dataset.continuedOf, pages.indexOf(page) + 1, (r.top - p.top) * 0.75, r.height * 0.75];
    })`);
    const wantParts = c.split.map(([id, page]) => [id, page + 1, screen.out[id][2] * 0.75 - c.height, screen.out[id][4] * 0.75]);
    check(
      "print view: a region that straddles a page edge continues at the top of the next page",
      parts.length === wantParts.length &&
        parts.every((q, i) => q[0] === wantParts[i][0] && q[1] === wantParts[i][1] && Math.abs(q[2] - wantParts[i][2]) < 0.6 && Math.abs(q[3] - wantParts[i][3]) < 0.6),
      JSON.stringify({ parts, wantParts }),
    );
    check("print view: chrome, crosshair, guides and placeholders are hidden", hidden.length === 0, hidden.join(", "));
    // The header and the footer of the fixture are document content on every page:
    // the pixel diff below is what checks that they look the same on the screen and in the PDF.
    const lines = await b.eval(`[...document.querySelectorAll('.sheet > .print-page')].map((p) => ({
      header: p.querySelector('.header-line')?.textContent ?? null,
      footer: p.querySelector('.footer-line')?.textContent ?? null,
    }))`);
    check(
      "print view: every page carries the fixture's header and footer",
      lines.length === print.pages &&
        lines.every((page) => (page.header ?? "").includes("Beam under a uniform load") && (page.footer ?? "").includes(".eqv")),
      JSON.stringify(lines),
    );
    const pageSheet = await b.eval(`(() => { const s = getComputedStyle(document.querySelector('.sheet')); return s.transform; })()`);
    check("print view: no zoom transform", pageSheet === "none", pageSheet);

    // fonts: every element with text in the print view uses a bundled font
    await b.send("DOM.enable");
    await b.send("CSS.enable");
    await b.eval(`(() => { let n = 0; for (const e of document.querySelectorAll('.print-page *')) { if ([...e.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) { e.setAttribute('data-fc', '1'); n++; } } return n; })()`);
    const root = await b.send("DOM.getDocument", { depth: 0 });
    const nodes = await b.send("DOM.querySelectorAll", { nodeId: root.root.nodeId, selector: "[data-fc]" });
    const system = new Set();
    let glyphs = 0;
    for (const nodeId of nodes.nodeIds) {
      const r = await b.send("CSS.getPlatformFontsForNode", { nodeId });
      for (const f of r.fonts) {
        if (f.glyphCount > 0) glyphs += f.glyphCount;
        if (f.glyphCount > 0 && !f.isCustomFont) system.add(f.familyName);
      }
    }
    check("print view: no text uses a system font", nodes.nodeIds.length > 20 && system.size === 0, `${nodes.nodeIds.length} elements, ${glyphs} glyphs, system fonts: ${[...system].join(", ") || "none"}`);
    await b.eval(`document.querySelectorAll('[data-fc]').forEach((e) => e.removeAttribute('data-fc'))`);

    // screenshots of each page block at PPP px per point (the clip scale is multiplied by the device pixel ratio)
    const dpr = await b.eval(`window.devicePixelRatio`);
    for (let i = 0; i < blocks.length; i++) {
      const r = await b.eval(`(() => { const p = document.querySelectorAll('.sheet > .print-page')[${i}].getBoundingClientRect(); return [p.left + scrollX, p.top + scrollY, p.width, p.height]; })()`);
      const shot = await b.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: r[0], y: r[1], width: r[2], height: r[3], scale: (PPP * 0.75) / dpr },
      });
      writeFileSync(`${caseOut}/page-${i + 1}.png`, Buffer.from(shot.data, "base64"));
    }
    await b.send("Emulation.setEmulatedMedia", { media: "" });
    await b.eval(`window.__equavela.leavePrint()`);
    await b.sleep(300);
    check("leaving the print view restores the page view", (await offsets(false)).pages === screen.pages && !(await b.eval(`document.documentElement.classList.contains('print-view')`)));

    // ---- export, the test hook takes a path and opens no dialog ------------------------------------------
    const written = await b.eval(`window.__equavela.exportPdf(${JSON.stringify(pdf)})`);
    check("Export PDF writes the file at the given path", written?.replaceAll("\\", "/") === pdf && existsSync(pdf), `${written} (${existsSync(pdf) ? statSync(pdf).size : 0} bytes)`);
    check("the view is back to normal after the export", !(await b.eval(`document.documentElement.classList.contains('print-view')`)) && (await offsets(false)).pages === screen.pages);
    check("the message bar reports the export", ((await h.text(".message-bar")) ?? "").includes("PDF saved"), (await h.text(".message-bar")) ?? "");
    check("printing does not modify the worksheet", !(await hasStar()));
    check("results are still shown after printing", (await h.result("m4")) !== null);

    // ---- the comparison (PyMuPDF) -------------------------------------------------------------------------
    let output = "";
    let code = 0;
    try {
      output = execFileSync(
        PYTHON,
        ["-I", "app/scripts/pdf-compare.py", "--pdf", pdf, "--shots", caseOut, "--out", caseOut, "--ppp", String(PPP), "--expect-pages", String(print.pages), "--page-size", String(c.width), String(c.height), "--expect-images", "400x200", "--expect-fill", "f2b134", "--expect-text", "42", "--forbid-text", "hidden_marker"],
        { encoding: "utf8" },
      );
    } catch (error) {
      output = (error.stdout ?? "") + (error.stderr ?? "");
      code = error.status ?? 1;
    }
    process.stdout.write(output.replace(/^/gm, "  "));
    check("pdf-compare.py: page count, size, fonts, vector text and pixel diff", code === 0, `exit ${code}`);
  } finally {
    await Promise.race([b.close(), new Promise((r) => setTimeout(r, 5000))]);
  }
}

mkdirSync(out, { recursive: true });
const selected = caseArg ? [CASES[caseArg]] : Object.values(CASES);
let port = 9696;
for (const c of selected) await runCase(c, port++);
console.log(`\n${failed === 0 ? "ALL PASSED" : failed + " FAILED"}`);
process.exit(failed);
