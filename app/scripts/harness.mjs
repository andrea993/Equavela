// Check bookkeeping and DOM readers shared by the real-backend drivers (e2e-real.mjs, e2e-exit.mjs).

export function harness(b) {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  };
  const until = async (fn, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await b.sleep(100);
    }
    return false;
  };
  const q = (sel) => b.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
  const count = (sel) => b.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = (sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent ?? null`);
  /** Result text of a region (null when none). */
  const result = (id) => b.eval(`document.querySelector('[data-region-id="${id}"] [data-testid=result]')?.textContent ?? null`);
  /** Source text of a math region as drawn. */
  const mathText = (id) => b.eval(`document.querySelector('[data-region-id="${id}"] .math')?.textContent ?? null`);
  const kernelStatus = () => b.eval("document.querySelector('[data-testid=kernel-status]')?.textContent ?? ''");
  /** Math regions in document order. */
  const mathIds = () => b.eval(`[...document.querySelectorAll('[data-kind=math]')].map((e) => e.dataset.regionId)`);
  /** Kernel ready, no calculation in progress, no region waiting for a result. */
  const idle = async (ms = 120000) => {
    await b.sleep(300);
    return until(
      async () =>
        /ready/i.test(await kernelStatus()) &&
        !(await q("[data-testid=progress]")) &&
        (await count("[data-region-id].state-pending")) === 0,
      ms,
    );
  };
  const useLayout = (id) =>
    b.eval(
      `(() => { const s = document.querySelector('[data-testid=keyboard-layout]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(id)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`,
    );
  /** A point of page `n` (1-based) where the sheet is empty, in client coordinates. */
  const blankPoint = (page = 1, minTop = 0) =>
    b.eval(`(() => {
      const pg = document.querySelectorAll('.sheet .page')[${page - 1}];
      if (!pg) return null;
      const r = pg.getBoundingClientRect();
      const regions = [...document.querySelectorAll('[data-region-id]')].map((e) => e.getBoundingClientRect());
      const top = Math.max(r.top, ${minTop}) + 20;
      for (let y = top; y < Math.min(r.bottom - 60, innerHeight - 70); y += 12)
        for (let x = r.left + 100; x < r.right - 100; x += 24) {
          const el = document.elementFromPoint(x, y);
          if (el && (el === pg || el.classList.contains('page') || el.classList.contains('sheet'))) {
            const clear = regions.every((b) => x < b.left - 12 || x > b.right + 12 || y < b.top - 12 || y > b.bottom + 12);
            if (clear) return [x, y];
          }
        }
      return null;
    })()`);
  const done = () => {
    const failed = results.filter((x) => !x).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    return failed;
  };
  return { check, until, q, count, text, result, mathText, mathIds, kernelStatus, idle, useLayout, blankPoint, done };
}
