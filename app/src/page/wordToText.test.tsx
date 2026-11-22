// the specification : a new math region that is one plain word becomes a text box
// when a Space is typed; Ctrl+Z straight after brings the math back.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

afterEach(cleanup);

async function openEmpty() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
  await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).toBeNull());
}

async function type(keys: string) {
  for (const ch of keys) {
    await act(async () => {
      const code = ch === " " ? "Space" : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : `Digit${ch}`;
      fireEvent.keyDown(window, { key: ch, code });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

const textBox = () => document.querySelector("[data-testid=text-editor]");
const mathEditing = () => document.querySelector(".region.editing, [data-testid=editing-lines], .editing-lines");

describe("a word and a Space", () => {
  it("a word stays math, and a Space turns it into a text box with the word and the space", async () => {
    await openEmpty();
    await type("ciao");
    expect(textBox()).toBeNull();
    expect(mathEditing()).not.toBeNull();
    await type(" ");
    await waitFor(() => expect(textBox()).not.toBeNull());
    expect(textBox()!.textContent).toBe("ciao ");
  });

  it("other math keeps the math editor on a Space", async () => {
    await openEmpty();
    await type("a+b ");
    expect(textBox()).toBeNull();
  });

  it("Ctrl+Z straight after the conversion brings the math back, without the space", async () => {
    await openEmpty();
    await type("ciao ");
    await waitFor(() => expect(textBox()).not.toBeNull());
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(textBox()).toBeNull());
    expect(document.body.textContent).toContain("ciao");
    expect(document.body.textContent).not.toContain("ciao ");
    // And the caret is at the end of the word: typing goes on in the math.
    await type("2");
    expect(document.body.textContent).toContain("ciao2");
  });
});
