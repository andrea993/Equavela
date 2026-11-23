// The physical Ctrl key as the system reports it. On Windows AltGr arrives as Ctrl+Alt, so the
// browser's `ctrlKey` cannot tell `Ctrl+AltGr+è` from `AltGr+è`; the app's native keyboard hook
// sends the real state (`real-ctrl`). Elsewhere it stays unknown and the keymap reads the event.

let realCtrl: boolean | undefined;

/** Whether the physical Ctrl key is down, or undefined where the system does not say. */
export function realCtrlDown(): boolean | undefined {
  return realCtrl;
}

export function setRealCtrl(down: boolean | undefined): void {
  realCtrl = down;
}
