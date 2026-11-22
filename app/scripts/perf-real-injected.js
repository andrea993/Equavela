// Loaded only by the opt-in e2e-perf build, into the worksheet webview: waits for the
// worksheet the app was started with, runs the GUI latency benchmark and posts its report to the driver.
(async () => {
  if (window.__equavelaPerfStarted) return;
  window.__equavelaPerfStarted = true;
  const endpoint = __ENDPOINT__;
  const options = __OPTIONS__;
  const post = (path, body) => fetch(endpoint + path, { method: 'POST', body: JSON.stringify(body) });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline && !(window.__equavelaPerf && document.querySelector('[data-region-id]'))) await wait(100);
    if (!document.querySelector('[data-region-id]')) throw new Error('the worksheet did not open');
    await post('/progress', { stage: 'opened', regions: document.querySelectorAll('[data-region-id]').length });
    const report = await window.__equavelaPerf.run({ ...options, progress: (stage) => void post('/progress', { stage }) });
    await post('', { ok: true, report, text: await window.__equavelaPerf.format(report) });
  } catch (error) {
    await post('', { ok: false, error: `${error && error.message ? error.message : error}\n${(error && error.stack) || ''}` });
  }
})();
