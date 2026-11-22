// Loaded only by the opt-in e2e-print build, into the local worksheet webview.
(async () => {
  if (window.__equavelaLinuxPrintTestStarted) return;
  window.__equavelaLinuxPrintTestStarted = true;
  const endpoint = __ENDPOINT__;
  const output = __OUTPUT__;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const progress = (state) => void fetch(endpoint + '/progress', { method: 'POST', body: JSON.stringify(state) });
  try {
    progress({ stage: 'started' });
    const deadline = Date.now() + 180000;
    let reported = false;
    while (Date.now() < deadline) {
      const regions = document.querySelectorAll('[data-region-id]');
      const plot = document.querySelector('[data-testid="plot-canvas"] svg.main-svg');
      const result = document.querySelector('[data-region-id="m4"][data-state="value"] [data-testid="result"]');
      const determinant = document.querySelector('[data-region-id="m7"][data-state="value"] [data-testid="result"]');
      if (window.__equavela && regions.length >= 14 && result && determinant) break;
      if (!reported && Date.now() > deadline - 150000) {
        reported = true;
        progress({ regions: regions.length, plot: !!plot, result: !!result, status: document.querySelector('[data-testid="kernel-status"]')?.textContent, message: document.querySelector('.message-bar')?.textContent });
      }
      await wait(100);
    }
    if (!window.__equavela || !document.querySelector('[data-region-id="m4"][data-state="value"] [data-testid="result"]') || !document.querySelector('[data-region-id="m7"][data-state="value"] [data-testid="result"]')) {
      throw new Error('worksheet did not become ready');
    }
    window.__equavela.enterPrint(null);
    progress({ stage: 'print-view' });
    await window.__equavela.printReady();
    while (Date.now() < deadline && !document.querySelector('[data-testid="plot-canvas"][data-state="ready"] svg.main-svg')) {
      const canvas = document.querySelector('[data-testid="plot-canvas"]');
      if (canvas?.dataset.state === 'error') throw new Error('plot evaluation failed');
      await wait(100);
    }
    if (!document.querySelector('[data-testid="plot-canvas"][data-state="ready"] svg.main-svg')) throw new Error('print plot did not render');
    const plot = document.querySelector('[data-testid="plot-canvas"] svg.main-svg');
    while (Date.now() < deadline && (!plot.querySelector('g.y2') || plot.querySelectorAll('.scatterlayer g.trace').length !== 2)) {
      await wait(100);
    }
    if (!plot.querySelector('g.y2') || plot.querySelectorAll('.scatterlayer g.trace').length !== 2) {
      throw new Error(`print plot is missing the right y axis or an assigned trace (y2=${!!plot.querySelector('g.y2')}, traces=${plot.querySelectorAll('.scatterlayer g.trace').length})`);
    }
    const y2 = document.querySelector('[data-testid="plot-canvas"]')?._fullLayout?.yaxis2;
    if (y2?.type !== 'log' || y2.range?.join(',') !== '0,3' || y2._vals?.map((tick) => tick.text).join(',') !== '1,10,100,1000') {
      throw new Error(`right y-axis log scale or limits are wrong: ${JSON.stringify({ type: y2?.type, range: y2?.range, ticks: y2?._vals?.map((tick) => tick.text) })}`);
    }
    await window.__equavela.printReady();
    const expectedPages = document.querySelectorAll('.sheet > .print-page').length;
    // WebKitGTK cannot emulate print media through its public API. Apply the same print CSS on
    // screen for the native snapshot, then remove it before the actual print operation.
    const printCss = [];
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSMediaRule && rule.conditionText === 'print') {
          printCss.push(...Array.from(rule.cssRules, (inner) => inner.cssText));
        }
      }
    }
    const previewStyle = document.createElement('style');
    previewStyle.textContent = printCss.join('\n');
    document.head.append(previewStyle);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pages = [...document.querySelectorAll('.sheet > .print-page')].map((page) => {
      const rect = page.getBoundingClientRect();
      return { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height };
    });
    document.title = 'equavela-e2e-snapshot';
    const snapshot = await fetch(endpoint + '/snapshot');
    if (!snapshot.ok) throw new Error('snapshot was not captured');
    previewStyle.remove();
    window.__equavela.leavePrint();
    progress({ stage: 'export', expectedPages });
    const written = await window.__equavela.exportPdf(output);
    if (!written) throw new Error(document.querySelector('.message-bar')?.textContent || 'export failed');
    await fetch(endpoint, { method: 'POST', body: JSON.stringify({ ok: true, written, expectedPages, pages }) });
  } catch (error) {
    await fetch(endpoint, { method: 'POST', body: JSON.stringify({ ok: false, error: String(error) }) });
  }
})();
