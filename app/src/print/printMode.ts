// The print view. A module-level store, not React state, because the
// print engines (and the `beforeprint` event) need the view to be in place synchronously and from
// outside React: `enterPrint()` marks `html.print-view` and notifies the subscribers (`PageView`
// draws one block per page, `PlotCanvas` switches to SVG), `leavePrint()` undoes it.

import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

let printing = false;
const listeners = new Set<() => void>();
let pageRule: HTMLStyleElement | null = null;

function notify() {
  for (const listener of [...listeners]) listener();
}

/** The paper size proposed to the system print dialog (points), after the orientation. */
export type PaperSize = { widthPt: number; heightPt: number };

/** The `@page` rule of the print view: `size: auto` for the PDF adapters, the paper size for the dialog. */
export function pageRuleText(paper: PaperSize | null): string {
  const size = paper ? `${paper.widthPt}pt ${paper.heightPt}pt` : "auto";
  return `@page { size: ${size}; margin: 0; }`;
}

let currentPaper: PaperSize | null = null;

/**
 * Puts the document into the print view. Idempotent. `paper` is the paper size proposed to the
 * system dialog (`null`: `size: auto`, for the PDF adapters); left out, a view that is already on
 * keeps its paper (the `beforeprint` event that the dialog itself raises must not reset it).
 */
export function enterPrint(paper?: PaperSize | null): void {
  if (typeof document === "undefined") return;
  if (paper !== undefined) currentPaper = paper;
  else if (!printing) currentPaper = null;
  document.documentElement.classList.add("print-view");
  pageRule ??= document.createElement("style");
  pageRule.dataset.printPage = "true";
  pageRule.textContent = pageRuleText(currentPaper);
  if (!pageRule.isConnected) document.head.appendChild(pageRule);
  if (!printing) {
    printing = true;
    notify();
  }
}

/** Leaves the print view. Idempotent. */
export function leavePrint(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.remove("print-view");
  pageRule?.remove();
  currentPaper = null;
  if (printing) {
    printing = false;
    notify();
  }
}

export function isPrinting(): boolean {
  return printing;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while the print view is on. */
export function usePrinting(): boolean {
  return useSyncExternalStore(subscribe, isPrinting, () => false);
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Resolves when the print view is drawn: the fonts are loaded, every plot has been drawn as SVG
 * and two animation frames have passed. A plot that cannot be drawn does not hold the
 * print forever (`timeoutMs`).
 */
export async function printReady(timeoutMs = 20000): Promise<void> {
  await document.fonts?.ready;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const plots = [...document.querySelectorAll<HTMLElement>("[data-testid=plot-canvas]")];
    const drawn = plots.every(
      (plot) =>
        plot.dataset.printing === "true" &&
        (Number(plot.dataset.drawn) >= 1 || plot.querySelector(".plot-unavailable") !== null),
    );
    if (drawn) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await frame();
  await frame();
}

/**
 * Runs `work` inside the print view and always leaves it. The view is ready (`printReady`) before
 * `work` starts.
 */
export async function withPrintView<T>(paper: PaperSize | null, work: () => Promise<T>): Promise<T> {
  enterPrint(paper);
  exportRunning = true;
  try {
    await printReady();
    return await work();
  } finally {
    exportRunning = false;
    leavePrint();
  }
}

/**
 * Wires the browser's own print events to the print view, so a print that the system starts (not
 * only Export PDF… and Print…) also gets it: `beforeprint` enters it synchronously (the print
 * engine lays out right after the event), `afterprint` leaves it unless an export is running.
 * Returns the function that removes the listeners.
 */
export function installPrintEvents(): () => void {
  const before = () => flushSync(() => enterPrint());
  const after = () => {
    if (!exportRunning) leavePrint();
  };
  window.addEventListener("beforeprint", before);
  window.addEventListener("afterprint", after);
  return () => {
    window.removeEventListener("beforeprint", before);
    window.removeEventListener("afterprint", after);
  };
}

let exportRunning = false;
