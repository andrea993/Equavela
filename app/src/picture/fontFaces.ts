// The bundled faces as the browser chooses them, for drawing text as outlines. Every
// face the app draws with is an `@font-face` rule with a WOFF source: the rules are read
// from the document, and a face's file is parsed once, when a picture first needs it.

import { parse, type Font } from "opentype.js";

export type FaceRule = {
  family: string;
  style: "normal" | "italic" | "oblique";
  /** The weights the face covers, inclusive. */
  weight: [number, number];
  /** The code points it covers: inclusive ranges; empty is every code point. */
  ranges: [number, number][];
  /** The URL of its WOFF file. */
  url: string;
};

/** `U+0460-052F, U+20B4, U+2D??` as ranges; an empty or absent range is everything. */
export function parseUnicodeRange(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const part of text.split(",")) {
    const item = part.trim().replace(/^u\+/i, "");
    if (!item) continue;
    if (item.includes("?")) {
      ranges.push([parseInt(item.replace(/\?/g, "0"), 16), parseInt(item.replace(/\?/g, "F"), 16)]);
    } else if (item.includes("-")) {
      const [a, b] = item.split("-");
      ranges.push([parseInt(a, 16), parseInt(b, 16)]);
    } else {
      const point = parseInt(item, 16);
      ranges.push([point, point]);
    }
  }
  return ranges.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

/** The family names of a `font-family` value, in order, unquoted. */
export function familyList(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/\s*(?:"([^"]*)"|'([^']*)'|([^,]+))\s*(?:,|$)/g)) {
    const name = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (name) names.push(name);
  }
  return names;
}

const WEIGHTS: Record<string, number> = { normal: 400, bold: 700 };

function weightOf(value: string): [number, number] {
  const parts = value.trim().split(/\s+/).map((part) => WEIGHTS[part] ?? Number(part));
  const [a, b] = [parts[0], parts[1] ?? parts[0]];
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : [400, 400];
}

/** The WOFF URL of a `src` value (a WOFF2-only face has none: the format the parser reads is WOFF). */
export function woffUrl(src: string): string | null {
  for (const match of src.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)\s*(?:format\(\s*["']?([\w-]+)["']?\s*\))?/g)) {
    const url = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    const format = match[4];
    if (format === "woff" || (!format && /\.woff(\?|#|$)/i.test(url))) return url;
  }
  return null;
}

/** The `@font-face` rules of the document that have a WOFF source. */
export function documentFaces(sheets: Iterable<CSSStyleSheet> = Array.from(document.styleSheets)): FaceRule[] {
  const faces: FaceRule[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) {
        const style = rule.style;
        const url = woffUrl(style.getPropertyValue("src"));
        if (!url) continue;
        const fontStyle = style.getPropertyValue("font-style").trim();
        faces.push({
          family: familyList(style.getPropertyValue("font-family"))[0] ?? "",
          style: fontStyle.startsWith("italic") ? "italic" : fontStyle.startsWith("oblique") ? "oblique" : "normal",
          weight: weightOf(style.getPropertyValue("font-weight") || "400"),
          ranges: parseUnicodeRange(style.getPropertyValue("unicode-range")),
          url: new URL(url, rule.parentStyleSheet?.href ?? document.baseURI).href,
        });
      } else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of sheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A sheet from another origin cannot be read; the app has none.
    }
  }
  return faces;
}

const covers = (face: FaceRule, point: number) =>
  face.ranges.length === 0 || face.ranges.some(([a, b]) => point >= a && point <= b);

/**
 * The faces of `family` that cover `point`, best first by the CSS matching rules in short: the asked
 * style (italic, then oblique, then normal, or the other way round for normal), then the nearest weight.
 */
export function candidates(faces: readonly FaceRule[], family: string, point: number, style: string, weight: number): FaceRule[] {
  const name = family.toLowerCase();
  const order = style.startsWith("italic") || style.startsWith("oblique") ? ["italic", "oblique", "normal"] : ["normal", "oblique", "italic"];
  const distance = (face: FaceRule) =>
    weight < face.weight[0] ? face.weight[0] - weight : weight > face.weight[1] ? weight - face.weight[1] : 0;
  return faces
    .filter((face) => face.family.toLowerCase() === name && covers(face, point))
    .sort((a, b) => order.indexOf(a.style) - order.indexOf(b.style) || distance(a) - distance(b));
}

const fonts = new Map<string, Promise<Font | null>>();

/** The parsed font of a face, read once; null when it cannot be read. */
export function loadFont(url: string): Promise<Font | null> {
  let font = fonts.get(url);
  if (!font) {
    font = fetch(url)
      .then((response) => response.arrayBuffer())
      .then((buffer) => parse(buffer))
      .catch(() => null);
    fonts.set(url, font);
  }
  return font;
}

/** The face and parsed font that draw `char` for an element's font, as the browser falls back. */
export async function faceFor(
  faces: readonly FaceRule[],
  families: readonly string[],
  char: string,
  style: string,
  weight: number,
): Promise<{ face: FaceRule; font: Font } | null> {
  const point = char.codePointAt(0) ?? 0;
  for (const family of families) {
    for (const face of candidates(faces, family, point, style, weight).slice(0, 1)) {
      const font = await loadFont(face.url);
      if (font && font.charToGlyphIndex(char) > 0) return { face, font };
    }
  }
  return null;
}
