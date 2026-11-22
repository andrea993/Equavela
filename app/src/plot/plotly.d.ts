// Plotly ships no types for its `lib/*` partial-bundle entry points; the adapter only uses
// `register`, `react`, `relayout` and `purge`.
declare module "plotly.js/lib/core" {
  const Plotly: {
    register(modules: unknown[]): void;
    react(element: HTMLElement, data: unknown[], layout: unknown, config: unknown): Promise<unknown>;
    relayout(element: HTMLElement, layout: Record<string, unknown>): Promise<unknown>;
    purge(element: HTMLElement): void;
  };
  export default Plotly;
}
declare module "plotly.js/lib/bar" {
  const trace: unknown;
  export default trace;
}
declare module "plotly.js/lib/scatter" {
  const trace: unknown;
  export default trace;
}
declare module "plotly.js/lib/scattergl" {
  const trace: unknown;
  export default trace;
}

declare module "plotly.js/lib/contour" {
  const trace: unknown;
  export default trace;
}
