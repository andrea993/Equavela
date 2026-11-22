// The pictures of copied regions: an SVG built from the page as drawn,
// and a PNG drawn from that SVG. Nothing is captured from the screen.

import { useSyncExternalStore } from "react";
import { regionSvg } from "./regionSvg";

// The regions being pictured stay mounted while their selection is set aside (the page view mounts
// only the regions near the visible part of the sheet, and the selected ones).
let pictured: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function setPictured(ids: ReadonlySet<string>) {
  pictured = ids;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The ids of the regions being pictured, which the page view keeps mounted. */
export function usePictured(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => pictured, () => pictured);
}

export type RegionPictures = { svg: Blob; png: Blob };

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The scale of the PNG: twice the size the regions have at 100 percent zoom. */
const PNG_SCALE = 2;

/** A PNG of an SVG drawn on a white canvas `scale` times its size. */
export async function rasterize(svg: string, width: number, height: number, scale = PNG_SCALE): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no PNG"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The pictures of the regions `ids` as printed: the selection, which brings the editing chrome, is set
 * aside for the measuring pass and given back, and the `region-capture` rules hide what only the
 * screen draws. `zoom` is the sheet's zoom.
 */
export async function regionPictures(
  ids: readonly string[],
  selection: readonly string[],
  select: (ids: string[]) => void,
  zoom: number,
): Promise<RegionPictures> {
  setPictured(new Set(ids));
  select([]);
  let built: Promise<{ svg: string; width: number; height: number }>;
  try {
    await frame();
    await frame();
    document.documentElement.classList.add("region-capture");
    const wanted = new Set(ids);
    const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-region-id]")).filter((element) =>
      wanted.has(element.dataset.regionId ?? ""),
    );
    // Only the outermost element of each region: a region's parts carry its id too.
    const outer = roots.filter((element) => !roots.some((other) => other !== element && other.contains(element)));
    built = regionSvg(outer, zoom);
  } finally {
    document.documentElement.classList.remove("region-capture");
    select([...selection]);
    setPictured(new Set());
  }
  const { svg, width, height } = await built;
  return { svg: new Blob([svg], { type: "image/svg+xml" }), png: await rasterize(svg, width, height) };
}
