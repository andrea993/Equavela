// the specification : a modal dialog owns the keyboard.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { installModalFocus } from "./modalFocus";

afterEach(cleanup);
const frame = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));

function Sheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => installModalFocus(document), []);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>Page setup</button>
      <button type="button" data-testid="behind">Draft view</button>
      {open && (
        <section role="dialog" aria-modal="true" aria-label="Page setup" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <select data-testid="first"><option>A4</option></select>
          <input data-testid="middle" />
          <button type="button" data-testid="last" onClick={() => setOpen(false)}>Cancel</button>
        </section>
      )}
    </>
  );
}

it("keeps Tab and Shift+Tab inside the dialog, focuses it on open and gives the keyboard back on close", async () => {
  const { getByTestId, queryByRole } = render(<Sheet />);
  const opener = getByTestId("opener");
  opener.focus();
  fireEvent.click(opener);
  await frame();
  // the first control takes the keyboard.
  expect(document.activeElement).toBe(getByTestId("first"));
  // Shift+Tab from the first control goes to the last, Tab from the last to the first.
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(getByTestId("last"));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(getByTestId("first"));
  // A focus behind the dialog is taken back.
  await act(async () => getByTestId("behind").focus());
  await frame();
  expect(document.activeElement).toBe(getByTestId("first"));
  // A key that reaches a control behind the dialog anyway activates nothing there.
  let behindClicks = 0;
  getByTestId("behind").addEventListener("click", () => behindClicks++);
  const behindKey = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  getByTestId("behind").dispatchEvent(behindKey);
  expect(behindKey.defaultPrevented).toBe(true);
  expect(behindClicks).toBe(0);
  expect(document.activeElement).toBe(getByTestId("first"));
  // Escape reaches the dialog and the opener gets the keyboard back.
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await frame();
  expect(queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});
