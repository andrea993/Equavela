// What a plot region needs from the window: its calculated data, a way to save an edited
// specification, and the conversion between the stored expression text and the math editor's
// tree. Provided by `Workbench` for the active worksheet so the page components need no
// backend prop.

import { createContext } from "react";
import type { Node } from "../editor/tree";
import type { PlotSpec } from "../equavelaApi";
import type { PlotFrame } from "./frame";
import type { ViewRange } from "./view";

export type PlotEnv = {
  /** Changes whenever calculated plot data may have changed (an edit, a finished pass). */
  revision: number;
  /** Asks for the calculated data of a plot region (rejects while a calculation runs). */
  load(regionId: string): Promise<PlotFrame>;
  /** Stores an edited specification: one undo step. */
  save(regionId: string, plot: PlotSpec): void;
  /** The editing tree of a stored expression (an empty text gives an empty placeholder). */
  toTree(text: string): Promise<Node>;
  /** The stored text of an edited expression; rejects while it is incomplete. */
  toText(tree: Node): Promise<string>;
  /** The selected trace id of a plot, or null when none is selected. */
  selectedTrace(regionId: string): string | null;
  /** Selects (or clears, with null) a trace of a plot. Screen-only state. */
  selectTrace(regionId: string, traceId: string | null): void;
  /**
   * Reports the x range the plot is showing on screen, which is the sample interval of its
   * implicit x trace; `null` is reset-to-data-range. Screen-only: never an undo step.
   */
  view(regionId: string, range: ViewRange | null): void;
  /** Makes a plot region the sheet selection, which brings up the Plot tab. */
  selectRegion(regionId: string): void;
};

export const PlotContext = createContext<PlotEnv | null>(null);
