// The SVG picture of regions as drawn. The page is measured in one
// synchronous pass, while nothing can paint: the transforms inside the regions are set aside so every
// box is measured where layout put it, pseudo-elements get real stand-ins, and each character is
// measured where the browser drew it. The SVG is then written from those measurements, every
// character as the outline of its glyph in the bundled face.

import type { Font } from "opentype.js";
import { documentFaces, faceFor, familyList, type FaceRule } from "./fontFaces";

type Box = { x: number; y: number; w: number; h: number };
type Paint = { fill: string; opacity: number };

/** One character to draw: its baseline origin and the rotation of its glyph, in picture px. */
type CharMark = {
  char: string;
  x: number;
  y: number;
  rotate: number;
  size: number;
  families: string[];
  style: string;
  weight: number;
  paint: Paint;
};

type Mark =
  | { kind: "group"; transform: string | null; clip: Box | null; children: Mark[] }
  | { kind: "rect"; box: Box; paint: Paint }
  | { kind: "chars"; chars: CharMark[] }
  | { kind: "svg"; markup: string; texts: CharMark[][]; defs: string }
  | { kind: "image"; box: Box; src: string };

/** A color as SVG 1.1 paint: `#rrggbb` and its opacity. Null when it draws nothing. */
export function paintOf(color: string, opacity = 1): Paint | null {
  const match = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/);
  if (!match) return color.startsWith("#") ? { fill: color, opacity } : null;
  const alpha = match[4] === undefined ? 1 : match[4].endsWith("%") ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
  if (alpha * opacity <= 0) return null;
  const hex = [match[1], match[2], match[3]].map((v) => Math.round(Number(v)).toString(16).padStart(2, "0")).join("");
  return { fill: `#${hex}`, opacity: alpha * opacity };
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** The attributes of an `<svg>` that only place its viewport; its group keeps the rest. */
const VIEWPORT_ATTRIBUTES = new Set(["x", "y", "width", "height", "viewBox", "preserveAspectRatio", "overflow", "version", "aria-hidden"]);

const num = (value: number) => String(Math.round(value * 100) / 100);
const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const paintAttrs = (paint: Paint) =>
  `fill="${paint.fill}"${paint.opacity < 1 ? ` fill-opacity="${num(paint.opacity)}"` : ""}`;

/** The SVG presentation properties copied onto a cloned SVG element (the page CSS does not travel). */
const SVG_PROPERTIES = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "visibility",
];

/** A computed `fill` or `stroke` as SVG 1.1 paint. Readers such as Inkscape take no `rgba()`, and draw
 * a transparent one black; it becomes a hex color with its alpha moved into the opacity. */
function svgPaint(value: string, opacity: string): [string, string | null] {
  const url = value.match(/url\(\s*["']?([^"')]*)["']?\s*\)/);
  if (url) return [`url(${url[1]})`, opacity || null];
  if (!value || value === "none") return ["none", null];
  const paint = paintOf(value, opacity ? parseFloat(opacity) : 1);
  return paint ? [paint.fill, paint.opacity < 1 ? num(paint.opacity) : null] : ["none", null];
}

/** The SVG presentation attributes of an element's computed style, in SVG 1.1 terms. */
export function presentationAttributes(get: (property: string) => string): [string, string][] {
  const attributes: [string, string][] = [];
  for (const property of SVG_PROPERTIES) {
    if (property === "fill-opacity" || property === "stroke-opacity") continue;
    const value = get(property);
    if (property === "fill" || property === "stroke") {
      const [paint, opacity] = svgPaint(value, get(`${property}-opacity`));
      attributes.push([property, paint]);
      if (opacity) attributes.push([`${property}-opacity`, opacity]);
    } else if (value) {
      attributes.push([property, value]);
    }
  }
  return attributes;
}

/** The attributes resolved to user units when written as a percentage of the viewport. */
const LENGTHS = ["x", "y", "width", "height", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry"];

/**
 * The transform that maps a viewBox into a viewport box, by `preserveAspectRatio` (`align` and
 * `meetOrSlice` as the DOM enumerates them; 1 is none, 2 to 10 run xMinYMin to xMaxYMax).
 */
export function viewportTransform(
  box: Box,
  view: { x: number; y: number; width: number; height: number } | null,
  align: number,
  meetOrSlice: number,
): string {
  const place = `translate(${num(box.x)} ${num(box.y)})`;
  if (!view || !(view.width > 0) || !(view.height > 0)) return place;
  let sx = box.w / view.width;
  let sy = box.h / view.height;
  let dx = 0;
  let dy = 0;
  if (align >= 2 && align <= 10) {
    const scale = meetOrSlice === 2 ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = scale;
    dx = (box.w - view.width * scale) * (((align - 2) % 3) / 2);
    dy = (box.h - view.height * scale) * (Math.floor((align - 2) / 3) / 2);
  }
  const fine = (value: number) => String(Math.round(value * 1e6) / 1e6);
  return `translate(${num(box.x + dx)} ${num(box.y + dy)}) scale(${fine(sx)} ${fine(sy)})` +
    (view.x || view.y ? ` translate(${num(-view.x)} ${num(-view.y)})` : "");
}

const STAND_IN_RULE = "[data-picture-before]::before, [data-picture-after]::after { content: none !important; }";

/** The text of a `content` value (`"⋮"`), or null for none. */
function contentText(value: string): string | null {
  if (!value || value === "none" || value === "normal") return null;
  const match = value.match(/^"((?:[^"\\]|\\.)*)"$/) ?? value.match(/^'((?:[^'\\]|\\.)*)'$/);
  return match ? match[1].replace(/\\(.)/g, "$1") : null;
}

/** Measures the regions as drawn now. `zoom` is the sheet's scale; the picture is at 100 percent. */
function measure(roots: readonly HTMLElement[], zoom: number): { marks: Mark[]; bounds: Box } {
  const undo: (() => void)[] = [];
  const rule = document.createElement("style");
  rule.textContent = STAND_IN_RULE;
  document.head.append(rule);
  undo.push(() => rule.remove());
  try {
    // Pseudo-elements become real elements for the pass (the ellipses of a matrix at rest, lines).
    for (const root of roots) {
      for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
        if (element.closest("svg")) continue;
        for (const which of ["before", "after"] as const) {
          const style = getComputedStyle(element, `::${which}`);
          const text = contentText(style.content);
          if (text === null) continue;
          const standIn = document.createElement("span");
          for (const property of Array.from(style)) {
            standIn.style.setProperty(property, style.getPropertyValue(property));
          }
          standIn.textContent = text;
          element.setAttribute(`data-picture-${which}`, "");
          if (which === "before") element.prepend(standIn);
          else element.append(standIn);
          undo.push(() => {
            standIn.remove();
            element.removeAttribute(`data-picture-${which}`);
          });
        }
      }
    }
    // Transforms inside the regions are set aside: boxes are measured untransformed and the transform
    // is written on the group that draws them.
    const transforms = new Map<Element, { matrix: DOMMatrix; origin: [number, number] }>();
    for (const root of roots) {
      for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
        if (element.parentElement?.closest("svg")) continue;
        const style = getComputedStyle(element);
        if (style.transform === "none" || !style.transform) continue;
        const [ox, oy] = style.transformOrigin.split(" ").map((v) => parseFloat(v) || 0);
        transforms.set(element, { matrix: new DOMMatrix(style.transform), origin: [ox, oy] });
        const previous = element.style.getPropertyValue("transform");
        const priority = element.style.getPropertyPriority("transform");
        element.style.setProperty("transform", "none", "important");
        undo.push(() => element.style.setProperty("transform", previous, priority));
      }
    }

    const first = roots[0].getBoundingClientRect();
    const originX = first.left;
    const originY = first.top;
    const local = (rect: DOMRect | DOMRectReadOnly): Box => ({
      x: (rect.left - originX) / zoom,
      y: (rect.top - originY) / zoom,
      w: rect.width / zoom,
      h: rect.height / zoom,
    });
    const metrics = new Map<string, { ascent: number; descent: number }>();
    const context = document.createElement("canvas").getContext("2d");
    const fontMetrics = (font: string) => {
      let found = metrics.get(font);
      if (!found) {
        found = { ascent: 0, descent: 0 };
        if (context) {
          context.font = font;
          const measured = context.measureText(" ");
          found = { ascent: measured.fontBoundingBoxAscent ?? 0, descent: measured.fontBoundingBoxDescent ?? 0 };
        }
        metrics.set(font, found);
      }
      return found;
    };

    const charsOf = (node: Text, style: CSSStyleDeclaration, opacity: number): CharMark[] => {
      const paint = paintOf(style.color, opacity);
      if (!paint) return [];
      const size = parseFloat(style.fontSize) || 16;
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const { ascent, descent } = fontMetrics(font);
      const vertical = style.writingMode.startsWith("vertical") || style.writingMode.startsWith("sideways");
      const families = familyList(style.fontFamily);
      const weight = parseInt(style.fontWeight, 10) || 400;
      const marks: CharMark[] = [];
      const text = node.data;
      const range = document.createRange();
      for (let i = 0; i < text.length; ) {
        const char = String.fromCodePoint(text.codePointAt(i) ?? 32);
        const end = i + char.length;
        if (!/^[\s​-‍⁠﻿]$/u.test(char)) {
          range.setStart(node, i);
          range.setEnd(node, end);
          const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 || r.height > 0);
          if (rect) {
            const box = local(rect);
            // The glyph's ascent and descent are centred in its box, as the line lays them out.
            if (vertical) {
              const x = box.x + (box.w - (ascent + descent)) / 2 + descent;
              marks.push({ char, x, y: box.y, rotate: 90, size, families, style: style.fontStyle, weight, paint });
            } else {
              const y = box.y + (box.h - (ascent + descent)) / 2 + ascent;
              marks.push({ char, x: box.x, y, rotate: 0, size, families, style: style.fontStyle, weight, paint });
            }
          }
        }
        i = end;
      }
      return marks;
    };

    // Every SVG viewport is written as plain groups: a nested `<svg>`, its viewBox and lengths in
    // percent are lost or misplaced when an editor such as Inkscape ungroups the picture.
    let viewports = 0;
    const flatten = (original: SVGSVGElement, copy: Element, box: Box, overflow: string, defs: string[]) => {
      const outer = document.createElementNS(SVG_NS, "g");
      for (const attribute of Array.from(copy.attributes)) {
        if (!VIEWPORT_ATTRIBUTES.has(attribute.name) && !attribute.name.startsWith("xmlns")) {
          outer.setAttribute(attribute.name, attribute.value);
        }
      }
      const inner = document.createElementNS(SVG_NS, "g");
      const ratio = original.preserveAspectRatio.baseVal;
      inner.setAttribute("transform", viewportTransform(box, original.viewBox.baseVal, ratio.align, ratio.meetOrSlice));
      while (copy.firstChild) inner.appendChild(copy.firstChild);
      if (overflow !== "visible") {
        const id = `mmv${viewports++}`;
        defs.push(`<clipPath id="${id}"><rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}"/></clipPath>`);
        outer.setAttribute("clip-path", `url(#${id})`);
      }
      outer.appendChild(inner);
      copy.replaceWith(outer);
      return outer;
    };

    const svgMark = (svg: SVGSVGElement, opacity: number): Mark | null => {
      const box = local(svg.getBoundingClientRect());
      const clone = svg.cloneNode(true) as SVGSVGElement;
      const originals = [svg, ...Array.from(svg.querySelectorAll("*"))];
      const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
      const texts: CharMark[][] = [];
      originals.forEach((original, index) => {
        const copy = copies[index];
        const style = getComputedStyle(original);
        if (style.display === "none") {
          copy.remove();
          return;
        }
        for (const [property, value] of presentationAttributes((name) => style.getPropertyValue(name))) {
          copy.setAttribute(property, value);
        }
        // A transform set in CSS (Plotly places its ticks so) travels as the attribute.
        const transform = original === svg ? "none" : style.transform;
        if (transform && transform !== "none") copy.setAttribute("transform", transform);
        copy.removeAttribute("class");
        copy.removeAttribute("style");
        for (const name of LENGTHS) {
          if (!copy.getAttribute(name)?.includes("%")) continue;
          const length = (original as unknown as Record<string, { baseVal?: { value?: unknown } } | undefined>)[name]?.baseVal?.value;
          if (typeof length === "number") copy.setAttribute(name, num(length));
        }
        if (original instanceof SVGTextElement) {
          // Text in an SVG (Plotly's ticks and titles) is outlined like the rest: each character at its
          // position in the text's own coordinates, under the same transforms.
          const paint = paintOf(style.fill, (parseFloat(style.fillOpacity) || 1) * (parseFloat(style.opacity) || 1));
          const marks: CharMark[] = [];
          const count = original.getNumberOfChars();
          const content = original.textContent ?? "";
          const size = parseFloat(style.fontSize) || 12;
          const families = familyList(style.fontFamily);
          const weight = parseInt(style.fontWeight, 10) || 400;
          for (let i = 0; i < count && paint && style.visibility !== "hidden"; ) {
            const char = String.fromCodePoint(content.codePointAt(i) ?? 32);
            if (!/^\s$/u.test(char)) {
              try {
                const at = original.getStartPositionOfChar(i);
                marks.push({ char, x: at.x, y: at.y, rotate: original.getRotationOfChar(i), size, families, style: style.fontStyle, weight, paint });
              } catch {
                // A character that is not drawn (past a clipped end) has no position.
              }
            }
            i += char.length;
          }
          const group = document.createElementNS(SVG_NS, "g");
          group.setAttribute("data-picture-text", String(texts.length));
          const placed = copy.getAttribute("transform");
          if (placed) group.setAttribute("transform", placed);
          copy.replaceWith(group);
          texts.push(marks);
        }
      });
      const color = paintOf(getComputedStyle(svg).color);
      if (color) clone.setAttribute("color", color.fill);
      if (opacity < 1) clone.setAttribute("opacity", num(opacity));
      clone.removeAttribute("aria-hidden");
      const defs: string[] = [];
      // The nested viewports at their own boxes, then the root at its box on the page (in a holder
      // only so that it can be replaced).
      originals.forEach((original, index) => {
        const copy = copies[index];
        if (index === 0 || !(original instanceof SVGSVGElement) || !clone.contains(copy)) return;
        const at: Box = { x: original.x.baseVal.value, y: original.y.baseVal.value, w: original.width.baseVal.value, h: original.height.baseVal.value };
        flatten(original, copy, at, getComputedStyle(original).overflow, defs);
      });
      document.createElementNS(SVG_NS, "g").appendChild(clone);
      const root = flatten(svg, clone, box, getComputedStyle(svg).overflow, defs);
      return { kind: "svg", markup: new XMLSerializer().serializeToString(root), texts, defs: defs.join("") };
    };

    const walk = (element: Element, opacity: number): Mark[] => {
      if (element instanceof SVGSVGElement) {
        const mark = svgMark(element, opacity);
        return mark ? [mark] : [];
      }
      if (!(element instanceof HTMLElement)) return [];
      const style = getComputedStyle(element);
      if (style.display === "none") return [];
      const own = opacity * (parseFloat(style.opacity) || (style.opacity === "0" ? 0 : 1));
      if (own <= 0) return [];
      const visible = style.visibility !== "hidden" && style.visibility !== "collapse";
      const box = local(element.getBoundingClientRect());
      const marks: Mark[] = [];
      if (visible) {
        const background = paintOf(style.backgroundColor, own);
        if (background && box.w > 0 && box.h > 0) marks.push({ kind: "rect", box, paint: background });
        const sides = [
          ["Top", (w: number) => ({ x: box.x, y: box.y, w: box.w, h: w })],
          ["Bottom", (w: number) => ({ x: box.x, y: box.y + box.h - w, w: box.w, h: w })],
          ["Left", (w: number) => ({ x: box.x, y: box.y, w, h: box.h })],
          ["Right", (w: number) => ({ x: box.x + box.w - w, y: box.y, w, h: box.h })],
        ] as const;
        for (const [side, rect] of sides) {
          const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
          const kind = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
          const paint = paintOf(style.getPropertyValue(`border-${side.toLowerCase()}-color`), own);
          if (width > 0 && paint && kind !== "none" && kind !== "hidden") marks.push({ kind: "rect", box: rect(width), paint });
        }
        if (element instanceof HTMLImageElement && element.currentSrc) {
          marks.push({ kind: "image", box, src: element.currentSrc });
        } else if (element instanceof HTMLCanvasElement) {
          try {
            marks.push({ kind: "image", box, src: element.toDataURL("image/png") });
          } catch {
            // A tainted canvas cannot be read; the app draws none.
          }
        }
      }
      const children: Mark[] = [];
      for (const child of Array.from(element.childNodes)) {
        if (child instanceof Text) {
          if (!visible) continue;
          const chars = charsOf(child, style, own);
          if (chars.length > 0) children.push({ kind: "chars", chars });
        } else if (child instanceof Element) {
          children.push(...walk(child, own));
        }
      }
      // Visibility is inherited, so a hidden element's visible children still draw.
      const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
      const transform = transforms.get(element);
      const clip = clips
        ? { x: box.x + element.clientLeft, y: box.y + element.clientTop, w: element.clientWidth, h: element.clientHeight }
        : null;
      let matrix: string | null = null;
      if (transform) {
        const { a, b, c, d, e, f } = transform.matrix;
        const ox = box.x + transform.origin[0];
        const oy = box.y + transform.origin[1];
        matrix = `translate(${num(ox)} ${num(oy)}) matrix(${[a, b, c, d, e, f].map(num).join(" ")}) translate(${num(-ox)} ${num(-oy)})`;
      }
      // The clip holds the content, not the element's own box; the transform holds both.
      const inner: Mark[] = clip ? [{ kind: "group", transform: null, clip, children }] : children;
      const all = [...marks, ...inner];
      return matrix ? [{ kind: "group", transform: matrix, clip: null, children: all }] : all;
    };

    const marks = roots.flatMap((root) => walk(root, 1));
    const boxes = roots.map((root) => local(root.getBoundingClientRect()));
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    return { marks, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  } finally {
    for (const step of undo.reverse()) step();
  }
}

/** Writes the marks as SVG, every character as its glyph's outline. */
async function write(marks: readonly Mark[], faces: readonly FaceRule[]): Promise<{ body: string; defs: string }> {
  const glyphs = new Map<string, string>();
  const defs: string[] = [];
  let clips = 0;
  const glyphId = (font: Font, url: string, char: string, size: number): string | null => {
    const glyph = font.charToGlyph(char);
    const key = `${url}|${glyph.index}|${size}`;
    let id = glyphs.get(key);
    if (id === undefined) {
      const data = glyph.getPath(0, 0, size).toPathData(2);
      id = data ? `g${glyphs.size}` : "";
      glyphs.set(key, id);
      if (data) defs.push(`<path id="${id}" d="${data}"/>`);
    }
    return id || null;
  };
  const chars = async (list: readonly CharMark[]): Promise<string> => {
    const out: string[] = [];
    for (const mark of list) {
      const found = await faceFor(faces, mark.families, mark.char, mark.style, mark.weight);
      // Placed by a transform, not `x`/`y`: an editor that ungroups a clipped group (Inkscape) applies
      // the clip to a `<use>` as if its `x`/`y` were part of its transform, so the clip slides away.
      const place = `transform="translate(${num(mark.x)} ${num(mark.y)})${mark.rotate ? ` rotate(${num(mark.rotate)})` : ""}"`;
      if (!found) {
        // No bundled face draws it: the character stays text.
        out.push(`<text ${place} font-size="${num(mark.size)}" ${paintAttrs(mark.paint)}>${escapeXml(mark.char)}</text>`);
        continue;
      }
      const id = glyphId(found.font, found.face.url, mark.char, mark.size);
      if (id) out.push(`<use xlink:href="#${id}" ${place} ${paintAttrs(mark.paint)}/>`);
    }
    return out.join("");
  };
  const render = async (list: readonly Mark[]): Promise<string> => {
    const out: string[] = [];
    for (const mark of list) {
      switch (mark.kind) {
        case "rect":
          out.push(`<rect x="${num(mark.box.x)}" y="${num(mark.box.y)}" width="${num(mark.box.w)}" height="${num(mark.box.h)}" ${paintAttrs(mark.paint)}/>`);
          break;
        case "chars":
          out.push(await chars(mark.chars));
          break;
        case "image":
          out.push(`<image x="${num(mark.box.x)}" y="${num(mark.box.y)}" width="${num(mark.box.w)}" height="${num(mark.box.h)}" preserveAspectRatio="none" xlink:href="${escapeXml(await dataUrl(mark.src))}"/>`);
          break;
        case "svg": {
          defs.push(mark.defs);
          let markup = mark.markup;
          for (let i = 0; i < mark.texts.length; i++) {
            const drawn = await chars(mark.texts[i]);
            // The serializer writes the empty stand-in group as `<g data-picture-text="i" …/>`.
            markup = markup.replace(new RegExp(`<g data-picture-text="${i}"([^>]*?)/>`), (_m, rest: string) => `<g${rest}>${drawn}</g>`);
          }
          out.push(markup);
          break;
        }
        case "group": {
          const attributes: string[] = [];
          if (mark.transform) attributes.push(`transform="${mark.transform}"`);
          if (mark.clip) {
            const id = `c${clips++}`;
            defs.push(`<clipPath id="${id}"><rect x="${num(mark.clip.x)}" y="${num(mark.clip.y)}" width="${num(mark.clip.w)}" height="${num(mark.clip.h)}"/></clipPath>`);
            attributes.push(`clip-path="url(#${id})"`);
          }
          out.push(`<g ${attributes.join(" ")}>${await render(mark.children)}</g>`);
          break;
        }
      }
    }
    return out.join("");
  };
  const body = await render(marks);
  return { body, defs: defs.join("") };
}

/** An image source as a data URL, which the SVG embeds. */
async function dataUrl(src: string): Promise<string> {
  if (src.startsWith("data:")) return src;
  const blob = await (await fetch(src)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The margin around the regions in the picture, CSS px. */
const MARGIN = 4;

export type RegionSvg = { svg: string; width: number; height: number };

/**
 * The SVG of the regions drawn by `roots` (their page elements), at 100 percent zoom. The measuring
 * pass is synchronous; it must run while the page shows the regions as they are to be pictured.
 */
export function regionSvg(roots: readonly HTMLElement[], zoom: number): Promise<RegionSvg> {
  if (roots.length === 0) return Promise.reject(new Error("nothing to picture"));
  const { marks, bounds } = measure(roots, zoom);
  const faces = documentFaces();
  return write(marks, faces).then(({ body, defs }) => {
    const width = Math.ceil(bounds.w + 2 * MARGIN);
    const height = Math.ceil(bounds.h + 2 * MARGIN);
    const shift = `translate(${num(MARGIN - bounds.x)} ${num(MARGIN - bounds.y)})`;
    // Sized in points, the size the regions have on paper (1 px = 0.75 pt).
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" ` +
      `width="${num(width * 0.75)}pt" height="${num(height * 0.75)}pt" viewBox="0 0 ${width} ${height}">` +
      `<defs>${defs}</defs><g transform="${shift}">${body}</g></svg>`;
    return { svg, width, height };
  });
}
