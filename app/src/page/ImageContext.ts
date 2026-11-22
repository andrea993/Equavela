// What an image region needs from the window: the bytes of its resource as a data URL. Provided by
// `Workbench` for the active worksheet so the page components need no backend prop. The URLs are
// cached per worksheet and resource id; the cache is dropped when an edit can change what a
// resource id means (an image was added, undo, redo), see `dropImages`.

import { createContext } from "react";

export type ImageEnv = {
  /** The data URL of a resource (cached). */
  load(resource: string): Promise<string>;
};

export const ImageContext = createContext<ImageEnv | null>(null);

const cache = new Map<string, Promise<string>>();

/** An `ImageEnv` for one worksheet; `fetch` reads a resource from the backend. */
export function imageEnv(worksheet: string, fetch: (resource: string) => Promise<string>): ImageEnv {
  return {
    load(resource) {
      const key = `${worksheet}\u0000${resource}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = fetchWhenFree(fetch, resource);
        cache.set(key, pending);
        // A failure is not remembered: the next draw asks again.
        pending.catch(() => cache.delete(key));
      }
      return pending;
    },
  };
}

/** Whether a command error says the worksheet is busy (a calculation holds the session). */
function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { kind?: unknown }).kind === "busy";
}

/** Reads a resource, asking again while a calculation holds the worksheet (like the plots do). */
async function fetchWhenFree(fetch: (resource: string) => Promise<string>, resource: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(resource);
    } catch (error) {
      if (!isBusy(error) || attempt >= 240) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Forgets every cached resource of a worksheet. */
export function dropImages(worksheet: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${worksheet}\u0000`)) cache.delete(key);
}
