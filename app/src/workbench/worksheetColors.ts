// The colours a worksheet already uses (GitHub ): the colour every plot trace is drawn in (its own
// or the palette colour of its position), the markers' colours, the text colours and highlights, the math
// fonts of the math regions. The colour picker offers them as a row, so a colour is taken from the trace of
// another plot, or from a text, with one click and without leaving the app.

import { mathFontOf } from "../math/font";
import type { ViewRegion } from "../equavelaApi";
import { defaultTraceColor } from "../plot/palette";

/** `#rrggbb` lower case, or null when the text is not a colour. */
const colour = (text: string | null | undefined): string | null =>
  text && /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : null;

/** The distinct colours of the regions, in the order they are first met (page order, then trace order). */
export function worksheetColors(regions: readonly ViewRegion[]): string[] {
  const seen = new Set<string>();
  const add = (text: string | null | undefined) => {
    const value = colour(text);
    if (value) seen.add(value);
  };
  for (const region of regions) {
    if (region.kind === "plot") {
      region.plot.traces.forEach((trace, index) => {
        const line = colour(trace.line?.color) ?? defaultTraceColor(index);
        add(line);
        add(trace.marker?.color);
      });
    } else if (region.kind === "text") {
      add(region.background);
      for (const paragraph of region.paragraphs) {
        for (const run of paragraph.runs) {
          if (run.kind === "text") {
            add(run.color);
            add(run.highlight);
          }
        }
      }
    } else if (region.kind === "math") {
      const font = mathFontOf(region.format);
      if (region.format && Object.keys(region.format).some((key) => key.startsWith("math-font."))) {
        add(font.color);
        add(font.highlight);
      }
    }
  }
  return [...seen];
}
