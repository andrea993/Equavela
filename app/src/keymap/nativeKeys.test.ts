import { beforeEach, describe, expect, it } from "vitest";
import { realCtrlDown, resetKeys, trackKey } from "./nativeKeys";

let now = 1000;
const down = (key: string, code: string, dt = 0) => trackKey({ type: "keydown", key, code, timeStamp: (now += dt) });
const up = (key: string, code: string, dt = 0) => trackKey({ type: "keyup", key, code, timeStamp: (now += dt) });

describe("the physical Ctrl key, read from the key events", () => {
  beforeEach(() => resetKeys());

  it("is down while a Ctrl the user pressed is down", () => {
    expect(realCtrlDown()).toBe(false);
    down("Control", "ControlLeft", 100);
    expect(realCtrlDown()).toBe(true);
    up("Control", "ControlLeft", 100);
    expect(realCtrlDown()).toBe(false);
    down("Control", "ControlRight", 100);
    expect(realCtrlDown()).toBe(true);
    up("Control", "ControlRight", 100);
    expect(realCtrlDown()).toBe(false);
  });

  it("is not down for the Ctrl that AltGr synthesizes (Control then AltGraph at once)", () => {
    down("Control", "ControlLeft", 100);
    down("AltGraph", "AltRight", 0.2);
    expect(realCtrlDown()).toBe(false);
    down("[", "BracketLeft", 40);
    expect(realCtrlDown()).toBe(false);
    up("Control", "ControlLeft", 60);
    up("AltGraph", "AltRight", 0.2);
    expect(realCtrlDown()).toBe(false);
  });

  it("is down for Left Ctrl pressed before AltGr", () => {
    down("Control", "ControlLeft", 100);
    down("AltGraph", "AltRight", 250);
    expect(realCtrlDown()).toBe(true);
    down("[", "BracketLeft", 80);
    expect(realCtrlDown()).toBe(true);
    up("AltGraph", "AltRight", 60);
    up("Control", "ControlLeft", 60);
    expect(realCtrlDown()).toBe(false);
  });

  it("is down for Right Ctrl with AltGr, whatever the order", () => {
    down("Control", "ControlLeft", 100);
    down("AltGraph", "AltRight", 0.2);
    down("Control", "ControlRight", 200);
    expect(realCtrlDown()).toBe(true);
    up("Control", "ControlRight", 100);
    expect(realCtrlDown()).toBe(false);
  });

  it("is down for Left Ctrl pressed while AltGr is already down", () => {
    down("Control", "ControlLeft", 100);
    down("AltGraph", "AltRight", 0.2);
    expect(realCtrlDown()).toBe(false);
    down("Control", "ControlLeft", 300);
    expect(realCtrlDown()).toBe(true);
    up("Control", "ControlLeft", 100);
    expect(realCtrlDown()).toBe(false);
  });

  it("forgets the keys when the window loses the focus", () => {
    down("Control", "ControlLeft", 100);
    expect(realCtrlDown()).toBe(true);
    resetKeys();
    expect(realCtrlDown()).toBe(false);
  });
});
