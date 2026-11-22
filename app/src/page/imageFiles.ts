// Image files from the browser side: which files are images
// and their content as base64. The core decides what is really an image (magic bytes, SVG
// sanitizing); this only filters obvious non-images before they are read.

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/svg+xml"];

/** Whether a file looks like a PNG, JPEG or SVG (by media type, else by extension). */
export function isImageFile(file: { name: string; type: string }): boolean {
  if (file.type) return IMAGE_TYPES.includes(file.type);
  return /\.(png|jpe?g|svg)$/i.test(file.name);
}

/** Whether a path names a PNG, JPEG or SVG file. */
export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|svg)$/i.test(path);
}

/** The content of a file as base64 (no `data:` prefix). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("the file could not be read"));
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** An image on the system clipboard (async API, needs permission), or null. */
export async function readClipboardImage(): Promise<File | null> {
  try {
    const items = (await navigator.clipboard?.read?.()) ?? [];
    for (const item of items) {
      const type = item.types.find((t) => IMAGE_TYPES.includes(t));
      if (type) return new File([await item.getType(type)], "clipboard", { type });
    }
  } catch {
    /* denied or unavailable */
  }
  return null;
}
