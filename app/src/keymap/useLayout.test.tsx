import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardLayout } from "./useLayout";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useKeyboardLayout", () => {
  it("key events from an Italian keyboard override a Keyboard Map that says US", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      keyboard: { getLayoutMap: async () => new Map([["BracketLeft", "["]]) },
    });
    const { result } = renderHook(() => useKeyboardLayout());
    await waitFor(() => expect(result.current.effective).toBe("en-US"));
    // '-' on the physical Slash key: an Italian keyboard.
    act(() => result.current.learn({ key: "-", code: "Slash", ctrlKey: true }));
    expect(result.current.effective).toBe("it-IT");
  });

  it("follows the Keyboard Map and ignores (and removes) a layout stored by an older version", async () => {
    window.localStorage.setItem("sheet.keyboardLayout", "en-US");
    vi.stubGlobal("navigator", {
      ...navigator,
      keyboard: { getLayoutMap: async () => new Map([["BracketLeft", "è"]]) },
    });
    const { result } = renderHook(() => useKeyboardLayout());
    await waitFor(() => expect(result.current.effective).toBe("it-IT"));
    expect(window.localStorage.getItem("sheet.keyboardLayout")).toBeNull();
    // There is no way to override it.
    expect("change" in result.current).toBe(false);
    expect("setting" in result.current).toBe(false);
  });
});
