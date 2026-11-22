// The picture of a copied image region: a PNG that goes on
// the system clipboard beside the regions snippet, so another application pastes a picture. Every
// other selection is pictured as SVG and PNG by `picture/regionPictures.ts`.

import { ptToPx } from "../layout/geometry";
import type { ViewRegion } from "../equavelaApi";

/** The bytes of a base64 string as a PNG blob. */
export function pngBlob(base64: string): Blob {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

/** A PNG of a drawable picture at `width` x `height` pixels. */
function drawn(image: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("no canvas"));
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no PNG"))), "image/png"),
  );
}

/**
 * The picture of an image region from its data URL: a PNG as stored, a JPEG at its natural size, an
 * SVG at twice the size the region is drawn at (a vector has no natural size of its own).
 */
export async function imagePicture(region: Extract<ViewRegion, { kind: "image" }>, dataUrl: string): Promise<Blob> {
  const comma = dataUrl.indexOf(",");
  if (region.media === "png" && comma >= 0 && dataUrl.slice(0, comma).includes(";base64")) {
    return pngBlob(dataUrl.slice(comma + 1));
  }
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  if (region.media === "svg") return drawn(image, ptToPx(region.size[0]) * 2, ptToPx(region.size[1]) * 2);
  return drawn(image, image.naturalWidth, image.naturalHeight);
}
