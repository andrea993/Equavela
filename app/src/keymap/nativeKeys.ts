// The physical Ctrl key. On Windows AltGr arrives as Ctrl+Alt: the browser's `ctrlKey` cannot tell
// `Ctrl+AltGr+è` from `AltGr+è`, and Chromium reports AltGr keys with `ctrlKey` false anyway.
//
// The page can tell them apart from the key events themselves. AltGr makes the system press a Left
// Ctrl of its own: it is reported as a `Control` keydown (ControlLeft) right before the `AltGraph`
// keydown, within the same instant. A Ctrl the user presses is a `Control` keydown that is not
// followed by an AltGraph, or one that comes while AltGr is already down, well after it. (A native
// keyboard hook reported the same thing as an event, but Windows did not deliver the hook's calls
// while the application's own window had the focus, so the state is read here.)

/** A Control keydown this close to an AltGraph keydown is the Ctrl that AltGr synthesizes. */
const FAKE_CTRL_MS = 10;

let leftDown = false;
let rightDown = false;
let leftIsAltGr = false;
let altGrDown = false;
let leftDownAt = Number.NEGATIVE_INFINITY;
let altGrDownAt = Number.NEGATIVE_INFINITY;

/** Whether a Ctrl key the user pressed is down: AltGr's own Ctrl does not count. */
export function realCtrlDown(): boolean {
  return rightDown || (leftDown && !leftIsAltGr);
}

export interface TrackedKey {
  type: string;
  key: string;
  code: string;
  timeStamp: number;
  repeat?: boolean;
}

/** Feeds the tracker with a `keydown` or `keyup`. */
export function trackKey(event: TrackedKey): void {
  if (event.repeat) return;
  const down = event.type === "keydown";
  if (event.key === "Control") {
    if (event.code === "ControlRight") rightDown = down;
    else if (!down) {
      leftDown = false;
      leftIsAltGr = false;
    } else if (altGrDown && event.timeStamp - altGrDownAt > FAKE_CTRL_MS) {
      // Ctrl pressed while AltGr is already down.
      leftDown = true;
      leftIsAltGr = false;
      leftDownAt = event.timeStamp;
    } else if (!leftDown) {
      leftDown = true;
      leftIsAltGr = false;
      leftDownAt = event.timeStamp;
    }
  } else if (event.key === "AltGraph") {
    if (down && !altGrDown) {
      altGrDown = true;
      altGrDownAt = event.timeStamp;
      if (leftDown && event.timeStamp - leftDownAt <= FAKE_CTRL_MS) leftIsAltGr = true;
    } else if (!down) {
      altGrDown = false;
    }
  }
}

/** Forgets every key (the window lost the focus: key-ups will not arrive). */
export function resetKeys(): void {
  leftDown = rightDown = leftIsAltGr = altGrDown = false;
  leftDownAt = altGrDownAt = Number.NEGATIVE_INFINITY;
}

/** Starts tracking the window's key events, before any handler sees them; returns the cleanup. */
export function installKeyTracking(target: Window = window): () => void {
  const onKey = (event: KeyboardEvent) => trackKey(event);
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("keyup", onKey, true);
  target.addEventListener("blur", resetKeys);
  return () => {
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("keyup", onKey, true);
    target.removeEventListener("blur", resetKeys);
  };
}
