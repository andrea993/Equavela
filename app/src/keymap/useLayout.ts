// The active keyboard layout for the keymap: always the system layout, never a
// user choice. Key events are ground truth (`layoutFromEvent`); without a proof the layout is the
// one detected with the Keyboard Map API (WebView2 / Chromium; WebKitGTK on Linux has none), else
// US. Ctrl chords are additionally resolved from the produced character (`keymap.resolve`).

import { useCallback, useEffect, useState } from "react";
import { clearLegacyLayoutSetting, detectLayout, layoutFromEvent, type KeyInput, type LayoutId } from "./keymap";

export function useKeyboardLayout() {
  const [detected, setDetected] = useState<LayoutId | null>(null);
  // The layout proved by key events: it wins over the Keyboard Map API, which can answer with a
  // different layout than the one the keys really have.
  const [learned, setLearned] = useState<LayoutId | null>(null);

  useEffect(() => {
    // A choice stored by an older version must not override the system layout.
    clearLegacyLayoutSetting();
    let cancelled = false;
    void detectLayout().then((layout) => {
      if (!cancelled && layout) setDetected(layout);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Learns the layout from a key event, also when the Keyboard Map API said something else. */
  const learn = useCallback((ev: KeyInput) => {
    const layout = layoutFromEvent(ev);
    if (layout) setLearned((current) => (current === layout ? current : layout));
  }, []);

  const effective: LayoutId = learned ?? detected ?? "en-US";
  return { effective, learn };
}
