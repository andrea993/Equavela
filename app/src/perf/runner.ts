// GUI latency benchmark. It drives the open worksheet with the
// same DOM events the user's keyboard and mouse produce (the key handler and the page view listen to
// window and element events; the app already replays keys this way) and measures how long each
// interaction takes until the next frame is presented, or, for interactions that wait on the backend,
// until the first frame after the last DOM change they caused. Frame-bound figures include the wait for
// the display's next frame, so their floor is one frame (16.7 ms at 60 Hz), not zero.
// It runs in any webview: Chromium with the mock backend
// (`?backend=mock&fixture=...`), WebKitGTK and WebView2 in the real app (`app/scripts/perf-real.mjs`).
//
// Not part of the normal UI: `main.tsx` exposes `window.__equavelaPerf.run()`, which loads this
// module on demand.

export type Stats = { n: number; mean: number; p50: number; p95: number; max: number };

export type PerfReport = {
  userAgent: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  regions: number;
  domNodes: number;
  /** Load to first drawn region and to a quiet main thread, ms since the page started. */
  open: { firstRegionMs: number | null; settledMs: number };
  scenarios: Record<string, Stats & { samples: number[] }>;
  /** A calculation pass: its duration and the frame gaps while it ran (ms). */
  pass: { durationMs: number; frameGaps: Stats } | null;
  notes: string[];
};

export type PerfOptions = {
  /** Interactions per scenario (default 30). */
  repeat?: number;
  /** Also run a full calculation pass (Ctrl+F5) and measure the frames meanwhile. */
  pass?: boolean;
  /** Progress callback (the real-app driver forwards it). */
  progress?: (stage: string) => void;
};

const frame = () => new Promise<number>((resolve) => requestAnimationFrame((t) => resolve(t)));
/** After the next frame has been painted: rAF runs before the paint, a task queued from it after. */
const presented = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/** Waits until two consecutive frames arrive less than `gap` ms apart (the main thread is free). */
async function settled(gap = 34, timeout = 20000): Promise<void> {
  const start = performance.now();
  let previous = await frame();
  let quiet = 0;
  while (quiet < 2 && performance.now() - start < timeout) {
    const now = await frame();
    quiet = now - previous < gap ? quiet + 1 : 0;
    previous = now;
  }
}

/**
 * For interactions that wait on the backend: the time from `t0` to the first presented frame in which
 * `done` holds (the visible effect of the interaction itself, not later work such as the results of
 * the automatic calculation it starts). -1 when it never holds within `timeout`.
 */
async function until(t0: number, done: () => boolean, timeout = 30000): Promise<number> {
  while (performance.now() - t0 < timeout) {
    await presented();
    if (done()) return performance.now() - t0;
  }
  return -1;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    n: sorted.length,
    mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

const KEYS: Record<string, { key: string; code: string }> = {
  down: { key: "ArrowDown", code: "ArrowDown" },
  up: { key: "ArrowUp", code: "ArrowUp" },
  escape: { key: "Escape", code: "Escape" },
  backspace: { key: "Backspace", code: "Backspace" },
  end: { key: "End", code: "End" },
  f5: { key: "F5", code: "F5" },
  z: { key: "z", code: "KeyZ" },
  plus: { key: "+", code: "Equal" },
  "1": { key: "1", code: "Digit1" },
};

function key(name: keyof typeof KEYS | string, mods: { ctrl?: boolean; shift?: boolean } = {}) {
  const k = KEYS[name] ?? { key: name, code: "" };
  const event = new KeyboardEvent("keydown", {
    key: k.key,
    code: k.code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift || name === "plus",
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  window.dispatchEvent(new KeyboardEvent("keyup", { key: k.key, code: k.code, bubbles: true }));
}

function pointer(target: Element, x: number, y: number) {
  const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: "mouse" };
  target.dispatchEvent(new PointerEvent("pointerdown", init));
  target.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("click", init));
}

const area = () => document.querySelector<HTMLElement>(".worksheet-area");
const regions = () => [...document.querySelectorAll<HTMLElement>("[data-region-id]")];

/** Math regions whose box is inside the visible part of the worksheet area. */
function visibleMath(): HTMLElement[] {
  const box = area()?.getBoundingClientRect();
  if (!box) return [];
  return [...document.querySelectorAll<HTMLElement>("[data-kind=math][data-region-id]")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.top > box.top + 20 && r.bottom < box.bottom - 20 && r.left > box.left && r.right < box.right;
  });
}

/** Scrolls the worksheet so that a fraction (0..1) of its height is at the top of the view. */
async function scrollToFraction(fraction: number) {
  const el = area();
  if (!el) return;
  el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * fraction);
  await settled();
}

/** Leaves any editing and clears the selection: a press on empty sheet, then Escape. */
async function neutral() {
  key("escape");
  await settled();
  key("escape");
  await settled();
}

/** Waits until no calculation is running and no region waits for a result (at most `timeout` ms). */
async function calculationIdle(timeout = 120000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    const running =
      document.querySelector("[data-testid=progress]") !== null ||
      document.querySelector("[data-region-id].state-pending") !== null;
    if (!running) break;
    await frame();
  }
  await settled();
}

async function measure(samples: number[], act: () => void, done?: () => boolean) {
  const t0 = performance.now();
  act();
  if (done) {
    const ms = await until(t0, done);
    if (ms >= 0) samples.push(ms);
  } else {
    await presented();
    samples.push(performance.now() - t0);
  }
  // Interactions never overlap: the next one starts on a quiet main thread.
  await settled();
}

export async function run(options: PerfOptions = {}): Promise<PerfReport> {
  const repeat = options.repeat ?? 30;
  const progress = options.progress ?? (() => undefined);
  const notes: string[] = [];
  const scenarios: PerfReport["scenarios"] = {};
  const record = (name: string, samples: number[]) => {
    scenarios[name] = { ...stats(samples), samples: samples.map((s) => Math.round(s * 10) / 10) };
  };

  // ---- open ---------------------------------------------------------------------------------
  progress("open");
  const firstRegionMs = performance.getEntriesByName("equavela:first-region")[0]?.startTime ?? null;
  await settled(34, 60000);
  const settledMs = performance.now();
  if (!area()) throw new Error("no worksheet is open");
  await neutral();

  // ---- browser floor: an empty frame, and the crosshair moved on the DOM without React -------------
  // They separate the browser's own cost (style, layout, paint of the whole sheet) from the app's.
  progress("browserFloor");
  const idle: number[] = [];
  for (let i = 0; i < repeat; i++) await measure(idle, () => undefined);
  record("idleFrame", idle);
  const mark = document.querySelector<SVGElement>("[data-testid=crosshair]");
  if (mark) {
    const moves: number[] = [];
    const top = parseFloat(mark.style.top || "0");
    for (let i = 0; i < repeat; i++) {
      await measure(moves, () => {
        mark.style.top = `${top + (i % 2 ? 0 : 4)}px`;
      });
    }
    mark.style.top = `${top}px`;
    record("domCrosshairMove", moves);
  }

  // ---- crosshair steps in the middle of the worksheet ---------------------------------------
  progress("crosshair");
  await scrollToFraction(0.5);
  // A press on empty sheet in the middle of the view puts the crosshair there.
  const view = area()!.getBoundingClientRect();
  const sheet = document.querySelector(".sheet .page") ?? area()!;
  const empty = document.elementFromPoint(view.left + 30, view.top + view.height / 2);
  pointer(empty && !empty.closest("[data-region-id]") ? empty : sheet, view.left + 30, view.top + view.height / 2);
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: view.left + 30, clientY: view.top + view.height / 2 }));
  await settled();
  const crosshair: number[] = [];
  for (let i = 0; i < repeat; i++) await measure(crosshair, () => key(i % 2 ? "up" : "down"));
  record("crosshairStep", crosshair);
  await neutral();

  // ---- crosshair steps over empty sheet ------------------------------------------------------
  // The steps above may enter regions they land on (that is what the arrows do). These stay near the
  // right edge of the printable area, where the generated worksheets put nothing: the step alone.
  progress("crosshairEmpty");
  const page = [...document.querySelectorAll<HTMLElement>(".sheet .page")].find((el) => {
    const r = el.getBoundingClientRect();
    return r.top < view.top + view.height / 2 && r.bottom > view.top + view.height / 2;
  });
  if (page) {
    const r = page.getBoundingClientRect();
    // 54 pt right margin plus a few points, in client pixels (the page is drawn at the zoom).
    const scale = r.width / page.offsetWidth;
    const x = r.right - (54 + 9) * (96 / 72) * scale;
    const y = view.top + view.height / 2;
    pointer(document.elementFromPoint(x, y) ?? page, x, y);
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y }));
    await settled();
    const steps: number[] = [];
    let entered = 0;
    for (let i = 0; i < repeat; i++) {
      await measure(steps, () => key(i % 2 ? "up" : "down"));
      if (document.querySelector(".region.editing")) {
        entered++;
        await neutral();
      }
    }
    record("crosshairEmpty", steps);
    if (entered > 0) notes.push(`crosshairEmpty: ${entered} of ${repeat} steps landed on a region`);
  } else {
    notes.push("crosshairEmpty: no page in the middle of the view");
  }
  await neutral();

  // ---- click on a math region (starts editing it) -------------------------------------------
  progress("click");
  const clicks: number[] = [];
  for (let i = 0; i < repeat; i++) {
    const candidates = visibleMath();
    if (candidates.length === 0) {
      notes.push("click: no visible math region");
      break;
    }
    const el = candidates[(i * 7) % candidates.length];
    const r = el.getBoundingClientRect();
    const target = document.elementFromPoint(r.left + Math.min(8, r.width / 2), r.top + r.height / 2) ?? el;
    await measure(clicks, () => {
      pointer(target, r.left + Math.min(8, r.width / 2), r.top + r.height / 2);
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
    });
  }
  record("clickRegion", clicks);

  // ---- keystrokes inside a math region ------------------------------------------------------
  progress("keystroke");
  const keystrokes: number[] = [];
  const editing = () => document.querySelector(".region.editing, [data-editing=true]") !== null;
  if (!editing()) notes.push("keystroke: no region is being edited after the clicks; typing starts a new region");
  key("end");
  await settled();
  // Type "+1+1..." then remove it again, so the region ends as it was and leaving it commits nothing.
  const typed: string[] = [];
  for (let i = 0; i < repeat; i++) {
    const name = i % 2 === 0 ? "plus" : "1";
    typed.push(name);
    await measure(keystrokes, () => key(name));
  }
  for (let i = 0; i < typed.length; i++) await measure(keystrokes, () => key("backspace"));
  record("keystroke", keystrokes);
  await neutral();

  // ---- scrolling ----------------------------------------------------------------------------
  progress("scroll");
  await scrollToFraction(0.2);
  const scrolls: number[] = [];
  for (let i = 0; i < repeat; i++) {
    await measure(scrolls, () => {
      const el = area()!;
      el.scrollTop += el.clientHeight * 0.8;
      el.dispatchEvent(new Event("scroll"));
    });
  }
  record("scrollPage", scrolls);

  // ---- an edit committed to the backend, and its undo -----------------------------------------
  progress("commit");
  await scrollToFraction(0.05);
  const commits: number[] = [];
  const undos: number[] = [];
  for (let i = 0; i < Math.min(5, repeat); i++) {
    const candidates = visibleMath();
    if (candidates.length === 0) {
      notes.push("commit: no visible math region");
      break;
    }
    const el = candidates[i % candidates.length];
    const id = el.dataset.regionId!;
    const region = () => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
    const text = () => region()?.querySelector(".math")?.textContent ?? null;
    const original = text();
    const r = el.getBoundingClientRect();
    pointer(document.elementFromPoint(r.left + 4, r.top + r.height / 2) ?? el, r.left + 4, r.top + r.height / 2);
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
    await settled();
    key("end");
    key("plus");
    key("1");
    await settled();
    // Escape leaves the region and commits it: done when the region shows the committed text outside
    // the editor. It is measured with no calculation running; the undo right after it is measured while
    // the automatic calculation of the commit runs, which makes the backend refuse the edit until the
    // kernel has been interrupted (useWorkbench `edit`): that is what the user meets when editing fast.
    await calculationIdle();
    const before = commits.length;
    await measure(commits, () => key("escape"), () => !region()?.classList.contains("editing") && text() !== original);
    if (commits.length === before) {
      notes.push(`commit: region ${id} did not show a committed change`);
      await neutral();
      continue;
    }
    await measure(undos, () => key("z", { ctrl: true }), () => text() === original);
    await neutral();
  }
  record("commitEdit", commits);
  record("undoDuringCalc", undos);

  // ---- a full calculation pass --------------------------------------------------------------
  let pass: PerfReport["pass"] = null;
  if (options.pass) {
    progress("pass");
    const gaps: number[] = [];
    const t0 = performance.now();
    key("f5", { ctrl: true });
    let previous = await frame();
    // The pass is over when the progress indicator has gone (and it did appear, or 3 s passed).
    let seen = false;
    while (performance.now() - t0 < 600000) {
      const now = await frame();
      gaps.push(now - previous);
      previous = now;
      const showing = document.querySelector("[data-testid=progress]") !== null;
      seen ||= showing;
      if ((seen || now - t0 > 3000) && !showing && document.querySelectorAll("[data-region-id].state-pending").length === 0) break;
    }
    pass = { durationMs: Math.round(performance.now() - t0), frameGaps: stats(gaps) };
    if (!seen) notes.push("pass: the progress indicator never appeared");
  }

  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    regions: regions().length,
    domNodes: document.getElementsByTagName("*").length,
    open: { firstRegionMs: firstRegionMs === null ? null : Math.round(firstRegionMs), settledMs: Math.round(settledMs) },
    scenarios,
    pass,
    notes,
  };
}

/** Prints a report as a compact table (console and the driver's terminal). */
export function formatReport(report: PerfReport): string {
  const lines = [
    `${report.userAgent}`,
    `regions ${report.regions}, DOM nodes ${report.domNodes}, viewport ${report.viewport.width}x${report.viewport.height}@${report.devicePixelRatio}`,
    `open: first region ${report.open.firstRegionMs ?? "?"} ms, settled ${report.open.settledMs} ms`,
    "scenario          n    mean     p50     p95     max  (ms)",
  ];
  for (const [name, s] of Object.entries(report.scenarios)) {
    const f = (v: number) => v.toFixed(1).padStart(8);
    lines.push(`${name.padEnd(14)}${String(s.n).padStart(5)}${f(s.mean)}${f(s.p50)}${f(s.p95)}${f(s.max)}`);
  }
  if (report.pass) lines.push(`pass: ${report.pass.durationMs} ms, frame gap p95 ${report.pass.frameGaps.p95} max ${report.pass.frameGaps.max}`);
  for (const note of report.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}
