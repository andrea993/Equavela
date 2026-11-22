// Bundled fonts only: nothing is loaded from the system or a CDN, and no
// font-family anywhere in the CSS has a generic or system fallback. Every weight and style the UI draws has its
// own face: a missing one (bold italic units) is synthesised by the engine, and a PDF then holds an
// unembedded Type3 font.
import "@fontsource/noto-sans/400.css";
import "@fontsource/noto-sans/400-italic.css";
import "@fontsource/noto-sans/700.css";
import "@fontsource/noto-sans/700-italic.css";
import "@fontsource/noto-sans-mono/400.css";
import "@fontsource/stix-two-text/400.css";
import "@fontsource/stix-two-text/400-italic.css";
import "@fontsource/stix-two-text/700.css";
import "@fontsource/stix-two-text/700-italic.css";
import stixMath from "@fontsource/stix-two-math/files/stix-two-math-latin-400-normal.woff2?url";
// The WOFF of the same face is listed too: the browser never needs it, the outlines of a copied
// picture are read from it.
import stixMathWoff from "@fontsource/stix-two-math/files/stix-two-math-latin-400-normal.woff?url";

// The fontsource package for STIX Two Math declares only a Latin unicode-range, but the
// file holds the full glyph set (spike C): declare it again without a range.
const style = document.createElement("style");
style.textContent = `@font-face {
  font-family: "MC Math";
  src: url(${stixMath}) format("woff2"), url(${stixMathWoff}) format("woff");
  font-display: block;
}`;
document.head.append(style);
