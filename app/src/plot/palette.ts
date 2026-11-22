/** The colours of the traces, in trace order: a trace without a colour of its own is drawn with `PALETTE[index]`. */
export const PALETTE = ["#1f5fbf", "#c8461c", "#2a8a3a", "#7a3fb0", "#9a7400", "#00778a"] as const;

/** The colour the trace at `index` is drawn with when it has none of its own. */
export const defaultTraceColor = (index: number): string => PALETTE[index % PALETTE.length];
