import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

afterEach(cleanup);

const items: ContextMenuItem[] = [
  { kind: "item", id: "copy", label: "Copy", shortcut: "Ctrl+C" },
  { kind: "item", id: "cut", label: "Cut", disabled: true },
  { kind: "separator" },
  { kind: "item", id: "paste", label: "Paste" },
];

const open = () => {
  const onChoose = vi.fn();
  const onClose = vi.fn();
  render(<ContextMenu x={10} y={10} items={items} label="Context menu" onChoose={onChoose} onClose={onClose} />);
  return { onChoose, onClose, menu: screen.getByRole("menu") };
};

describe("ContextMenu", () => {
  it("draws the items with their shortcuts, a separator, and disabled entries", () => {
    const { menu } = open();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["CopyCtrl+C", "Cut", "Paste"]);
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();
    expect((screen.getByText("Cut").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(menu.className).toContain("chrome");
  });

  it("a click chooses the command and closes the menu; a disabled item does nothing", () => {
    const { onChoose, onClose } = open();
    fireEvent.click(screen.getByText("Cut"));
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Paste"));
    expect(onChoose).toHaveBeenCalledWith("paste");
    expect(onClose).toHaveBeenCalled();
  });

  it("the arrows skip disabled items, Enter chooses, Escape closes, and no key reaches the sheet", () => {
    const { onChoose, onClose, menu } = open();
    const reachedSheet = vi.fn();
    document.addEventListener("keydown", reachedSheet);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith("paste");
    onChoose.mockClear();
    fireEvent.keyDown(menu, { key: "End" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith("copy");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(reachedSheet).not.toHaveBeenCalled();
    document.removeEventListener("keydown", reachedSheet);
  });

  it("a press outside the menu closes it, a press inside does not", () => {
    const { onClose } = open();
    fireEvent.pointerDown(screen.getByText("Copy"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("its own context menu is the app's: the native one is prevented", () => {
    const { menu } = open();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    menu.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
