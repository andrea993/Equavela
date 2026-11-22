// What navigating a plot means for the data it draws: the x range the
// user panned or zoomed to becomes the sample interval of every trace whose x the plot samples
// itself. The library reports that range as a `plotly_relayout` event; this module turns the event
// into a value the backend understands, and debounces the calls so a drag does not ask for a
// calculation per frame.

/** An x range the plot is showing, in data units. */
export type ViewRange = { min: number; max: number };

/** How long the events of one gesture are gathered before the plot is resampled, ms. */
export const VIEW_DEBOUNCE_MS = 150;

/**
 * The x range a `plotly_relayout` event asks for: the new range, `null` for
 * reset-to-data-range (autorange), or `undefined` when the event says nothing about the x range —
 * a y-only pan, a drag-mode change or a click on the mode bar.
 *
 * `logarithmic` is the scale of the x axis: the library reports the range of a log axis as the
 * exponents of its ends, so `-1` … `1` is 0.1 … 10. A range that survives no rule of the interval
 * is not reported at all (`implicit_x_bounds` in the core would replace it with the default one).
 */
export function relayoutViewRange(
  event: Record<string, unknown>,
  logarithmic = false,
): ViewRange | null | undefined {
  if (event["xaxis.autorange"] === true) return null;
  const ends = event["xaxis.range"];
  const min = event["xaxis.range[0]"] ?? (Array.isArray(ends) ? ends[0] : undefined);
  const max = event["xaxis.range[1]"] ?? (Array.isArray(ends) ? ends[1] : undefined);
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  const [low, high] = logarithmic ? [10 ** min, 10 ** max] : [min, max];
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(low < high)) return undefined;
  return { min: low, max: high };
}

/** Whether two ranges are the same interval, to the precision the event carries. */
export function sameViewRange(a: ViewRange | null, b: ViewRange | null): boolean {
  if (a === null || b === null) return a === b;
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-12 * Math.max(1, Math.abs(x), Math.abs(y));
  return close(a.min, b.min) && close(a.max, b.max);
}

export type ViewSender = {
  /** Reports the range the plot shows; calls made within `delay` ms are gathered. */
  push(range: ViewRange | null): void;
  /** Sends what is waiting now (a plot that goes away or a test). */
  flush(): void;
  /** Drops what is waiting without sending it. */
  cancel(): void;
};

/**
 * Debounces the view changes of one plot: only the last range of a gesture is sent, once
 * the gesture is over, and a range the plot already has is not sent again — that also stops the
 * round trip (data → redraw → same range) from asking for another calculation.
 */
export function createViewSender(send: (range: ViewRange | null) => void, delay = VIEW_DEBOUNCE_MS): ViewSender {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ViewRange | null = null;
  let last: ViewRange | null = null;
  let sent = false;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    push(range) {
      // The first range of a plot sends even when it is the default one: the plot may have been
      // navigated before the data arrived.
      if (sent && sameViewRange(range, last)) return;
      pending = range;
      stop();
      timer = setTimeout(() => {
        timer = null;
        last = pending;
        sent = true;
        send(pending);
      }, delay);
    },
    flush() {
      if (timer === null) return;
      stop();
      last = pending;
      sent = true;
      send(pending);
    },
    cancel: stop,
  };
}
