// the specification : a result box does not stop the page's wheel scroll.

/** The scrolling box of a result: the clipped classic matrix. */
const BOXES = ".result-matrix-scroll";

/** Pixels of one wheel line, for wheels that report lines (Firefox, some mice under Linux). */
const LINE_PX = 16;

/**
 * The box under a wheel event that should hand the scroll to the page: a box without the keyboard,
 * for a vertical wheel. A horizontal wheel, Shift, Ctrl (zoom) or a focused box keep the default.
 */
export function boxPassingWheel(
  event: Pick<WheelEvent, "target" | "deltaX" | "deltaY" | "shiftKey" | "ctrlKey">,
  active: Element | null,
): Element | null {
  if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return null;
  const target = event.target instanceof Element ? event.target : null;
  const box = target?.closest(BOXES) ?? null;
  if (!box || (active && box.contains(active))) return null;
  return box;
}

/** The wheel's vertical step in pixels, whatever unit the device reports it in. */
export function wheelPixels(event: Pick<WheelEvent, "deltaY" | "deltaMode">, pageHeight: number): number {
  if (event.deltaMode === 1) return event.deltaY * LINE_PX;
  if (event.deltaMode === 2) return event.deltaY * pageHeight;
  return event.deltaY;
}
