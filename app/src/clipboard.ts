// System clipboard access that works in the Tauri webviews (WebView2, WebKitGTK) and in a
// browser without a permission prompt: writing uses the async clipboard API and falls back to
// `execCommand("copy")` on a hidden textarea; reading from a keyboard gesture lets the browser
// paste natively into a hidden textarea (no permission needed) and reads what arrived there.
// Math is its canonical linear text and regions are a snippet of the worksheet `regions:` list
// (readable, and the same text on both platforms); a copied image or plot also puts a PNG beside the
// snippet.

function hiddenBox(): HTMLTextAreaElement {
  const box = document.createElement("textarea");
  box.setAttribute("aria-hidden", "true");
  box.dataset.clipboardBox = "true";
  box.tabIndex = -1;
  box.style.cssText = "position:fixed;left:-1000px;top:0;width:1px;height:1px;opacity:0;";
  document.body.appendChild(box);
  return box;
}

/**
 * Whether the focus went to the hidden textarea a clipboard read or write uses: the editor that
 * had the keyboard gets it back at once, so its blur is not a leave.
 */
export function isClipboardBox(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.dataset.clipboardBox === "true";
}

/** Writes plain text to the clipboard; resolves to whether it worked. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* denied or unavailable: use the fallback */
  }
  const previous = document.activeElement as HTMLElement | null;
  const box = hiddenBox();
  box.value = text;
  box.focus({ preventScroll: true });
  box.select();
  let ok = false;
  try {
    ok = typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    ok = false;
  }
  box.remove();
  previous?.focus?.({ preventScroll: true });
  return ok;
}

/**
 * Reads the clipboard during a paste key press: call it synchronously from the `keydown` handler
 * and do not call `preventDefault`, so that the browser's own paste lands in a hidden textarea.
 * The focus returns to where it was. Resolves to null when nothing arrives.
 */
export function readClipboardFromGesture(timeoutMs = 700): Promise<string | null> {
  const previous = document.activeElement as HTMLElement | null;
  const box = hiddenBox();
  box.focus({ preventScroll: true });
  return new Promise((resolve) => {
    let done = false;
    const finish = (text: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      box.remove();
      previous?.focus?.({ preventScroll: true });
      resolve(text);
    };
    box.addEventListener("paste", (event) => {
      event.preventDefault();
      finish(event.clipboardData?.getData("text/plain") ?? null);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** Reads the clipboard outside a key press (a ribbon button): needs the async API and permission. */
export async function readClipboard(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Writes text and pictures in one clipboard write: another
 * application pastes a picture (the SVG or the PNG, whichever it takes), Equavela the text. Call it
 * synchronously from the key press (the clipboard item takes promises, so the work may finish later).
 * Resolves to what was written: both, the text alone (no picture could be made, or the web view
 * refuses the item), or nothing.
 */
export type PictureCopy = { written: "both" | "text" | "failed"; reason?: string };

/** The pictures of a copy: a PNG always, an SVG when there is one. */
export type Pictures = { png: Blob; svg: Blob | null };

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function writeClipboardWithPicture(
  text: Promise<string | null>,
  pictures: Promise<Pictures>,
  withSvg: boolean,
): Promise<PictureCopy> {
  // A picture that fails is reported by the outcome, never as an unhandled rejection.
  pictures.catch(() => undefined);
  const write = navigator.clipboard?.write?.bind(navigator.clipboard);
  let reason = "the web view has no clipboard items";
  if (write && typeof ClipboardItem !== "undefined") {
    const plain = text.then((value) => {
      if (value === null) throw new Error("nothing to copy");
      return new Blob([value], { type: "text/plain" });
    });
    plain.catch(() => undefined);
    const png = pictures.then((p) => p.png);
    const svg = pictures.then((p) => p.svg ?? Promise.reject(new Error("no SVG")));
    png.catch(() => undefined);
    svg.catch(() => undefined);
    // The SVG type first; a web view that refuses it gets the item again without it.
    for (const types of withSvg ? [true, false] : [false]) {
      try {
        const item: Record<string, Promise<Blob>> = { "text/plain": plain, "image/png": png };
        if (types) item["image/svg+xml"] = svg;
        await write([new ClipboardItem(item)]);
        return { written: "both" };
      } catch (error) {
        // No picture, or the item was refused: the text alone, below.
        reason = await pictures.then(() => reasonOf(error), reasonOf);
      }
    }
  }
  const value = await text.catch(() => null);
  if (value === null) return { written: "failed", reason };
  return { written: (await writeClipboard(value)) ? "text" : "failed", reason };
}

/** A blob as base64, for a native command. */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Text and a picture through a native writer: no key press is needed, so the
 * picture may take its time. Without the writer, or when it fails, the text goes alone.
 */
export async function writeClipboardNatively(
  text: string,
  pictures: Promise<Pictures>,
  native: (text: string, png: string, svg: string | null) => Promise<void>,
): Promise<PictureCopy> {
  try {
    const { png, svg } = await pictures;
    await native(text, await base64Of(png), svg ? await svg.text() : null);
    return { written: "both" };
  } catch (error) {
    return { written: (await writeClipboard(text)) ? "text" : "failed", reason: reasonOf(error) };
  }
}
