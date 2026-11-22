import { describe, expect, it } from "vitest";
import { browserChord, guardBrowserChords, type BrowserChord } from "./browserChords";

const press = (code: string, mods: Partial<KeyboardEventInit> = {}, key?: string) =>
  new KeyboardEvent("keydown", { code, key: key ?? code.replace(/^Key|^Digit/, ""), cancelable: true, bubbles: true, ...mods });

describe("browser chords", () => {
  const reserved: [string, KeyboardEventInit & { code: string }, BrowserChord][] = [
    ["F12", { code: "F12", key: "F12" }, "devtools"],
    ["Ctrl+Shift+I", { code: "KeyI", key: "I", ctrlKey: true, shiftKey: true }, "devtools"],
    ["Ctrl+Shift+J", { code: "KeyJ", key: "J", ctrlKey: true, shiftKey: true }, "devtools"],
    ["Ctrl+Shift+C", { code: "KeyC", key: "C", ctrlKey: true, shiftKey: true }, "devtools"],
    ["Cmd+Alt+I", { code: "KeyI", key: "i", metaKey: true, altKey: true }, "devtools"],
    ["F5", { code: "F5", key: "F5" }, "reload"],
    ["Ctrl+F5", { code: "F5", key: "F5", ctrlKey: true }, "reload"],
    ["Ctrl+R", { code: "KeyR", key: "r", ctrlKey: true }, "reload"],
    ["Ctrl+Shift+R", { code: "KeyR", key: "R", ctrlKey: true, shiftKey: true }, "reload"],
    ["Ctrl+U", { code: "KeyU", key: "u", ctrlKey: true }, "view-source"],
    ["Ctrl+P", { code: "KeyP", key: "p", ctrlKey: true }, "print"],
    ["Ctrl+S", { code: "KeyS", key: "s", ctrlKey: true }, "save"],
    ["Ctrl+O", { code: "KeyO", key: "o", ctrlKey: true }, "open"],
    ["Ctrl+F", { code: "KeyF", key: "f", ctrlKey: true }, "find"],
    ["F3", { code: "F3", key: "F3" }, "find"],
    ["Ctrl+Plus", { code: "Equal", key: "+", ctrlKey: true, shiftKey: true }, "zoom"],
    ["Ctrl+Minus", { code: "Minus", key: "-", ctrlKey: true }, "zoom"],
    ["Ctrl+0", { code: "Digit0", key: "0", ctrlKey: true }, "zoom"],
    ["Ctrl+T", { code: "KeyT", key: "t", ctrlKey: true }, "window"],
    ["Ctrl+W", { code: "KeyW", key: "w", ctrlKey: true }, "window"],
    ["Alt+Left", { code: "ArrowLeft", key: "ArrowLeft", altKey: true }, "history"],
    ["F7", { code: "F7", key: "F7" }, "caret-browsing"],
  ];
  it.each(reserved)("%s is a browser chord and its default action is cancelled", (_name, init, kind) => {
    const event = new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
    expect(browserChord({ key: event.key, code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey })).toBe(kind);
    guardBrowserChords(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("the keys of editing and the keys the app owns are left alone", () => {
    for (const [code, mods] of [
      ["KeyA", { ctrlKey: true }], ["KeyC", { ctrlKey: true }], ["KeyV", { ctrlKey: true }], ["KeyX", { ctrlKey: true }],
      ["KeyZ", { ctrlKey: true }], ["KeyY", { ctrlKey: true }], ["KeyB", { ctrlKey: true }], ["KeyI", { ctrlKey: true }],
      ["KeyK", { ctrlKey: true }], ["KeyM", { ctrlKey: true }], ["KeyS", { ctrlKey: true, shiftKey: true }],
      ["KeyJ", { ctrlKey: true }], ["Enter", {}], ["ArrowLeft", {}], ["KeyI", {}], ["F2", {}], ["F6", {}],
    ] as [string, Partial<KeyboardEventInit>][]) {
      const event = press(code, mods);
      guardBrowserChords(event);
      expect(event.defaultPrevented, `${code} ${JSON.stringify(mods)}`).toBe(false);
    }
  });

  it("AltGr on the Italian layout (Ctrl+Alt) is a character, never a browser chord", () => {
    for (const code of ["KeyR", "KeyP", "Digit0", "KeyW", "Minus"]) {
      const event = press(code, { ctrlKey: true, altKey: true });
      guardBrowserChords(event);
      expect(event.defaultPrevented, code).toBe(false);
    }
  });

  it("the event is not stopped: a handler of the application still sees Ctrl+Shift+I (Integral)", () => {
    const seen: boolean[] = [];
    const handler = (event: KeyboardEvent) => seen.push(event.defaultPrevented);
    window.addEventListener("keydown", guardBrowserChords, true);
    window.addEventListener("keydown", handler);
    window.dispatchEvent(press("KeyI", { ctrlKey: true, shiftKey: true }, "I"));
    window.removeEventListener("keydown", guardBrowserChords, true);
    window.removeEventListener("keydown", handler);
    expect(seen).toEqual([true]);
  });
});
