// The Plotly partial bundle: only the trace types used by Equavela plots. Loaded
// lazily (`import("./plotlyBundle")`) so the worksheet opens without parsing it.

import bar from "plotly.js/lib/bar";
import contour from "plotly.js/lib/contour";
import Plotly from "plotly.js/lib/core";
import scatter from "plotly.js/lib/scatter";
import scattergl from "plotly.js/lib/scattergl";
import scatterpolar from "plotly.js/lib/scatterpolar";

// `bar` draws the bars of a bar trace; `contour` draws an explicit-grid contour
// plot; the rest are the trace types of .
Plotly.register([bar, scatter, scattergl, scatterpolar, contour]);

export default Plotly;
