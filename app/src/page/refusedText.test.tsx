// the specification : a text the backend refuses never traps the editor. The first Escape tries
// to store it and, refused, the message says that Escape discards; the next Escape discards it.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

afterEach(cleanup);

const textBox = () => document.querySelector<HTMLElement>("[data-testid=text-editor]");

async function press(key: string, target: Element | Window = window) {
  await act(async () => {
    const code = key === " " ? "Space" : key === "Escape" ? "Escape" : `Key${key.toUpperCase()}`;
    fireEvent.keyDown(target, { key, code });
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

it("a refused text says how to leave, and the next Escape discards it", async () => {
  const backend = createMockBackend({ fast: true });
  backend.addTextRegion = async () => {
    throw { kind: "parse", message: "the inline math does not parse" };
  };
  render(<App backend={backend} />);
  await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
  await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).toBeNull());
  for (const key of "ciao ") await press(key);
  await waitFor(() => expect(textBox()).not.toBeNull());
  const editable = () => textBox()!.querySelector("[contenteditable=true]") ?? textBox()!;
  // The first Escape tries to store it: refused, the editor stays and the message says what to do.
  await press("Escape", editable());
  await waitFor(() => expect(document.body.textContent).toContain("press Esc to discard the changes"));
  await waitFor(() => expect(textBox()).not.toBeNull());
  expect(textBox()!.textContent).toContain("ciao");
  // The next Escape discards it.
  await press("Escape", editable());
  await waitFor(() => expect(textBox()).toBeNull());
  expect(document.querySelectorAll("[data-region-id]")).toHaveLength(0);
});
