import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(cleanup);

async function openDemo() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(document.querySelector('[data-region-id="m1"]')).not.toBeNull());
}

/** Types `text` into an input the way a user does, then puts the caret at `caret` (default: the end). */
function fill(input: HTMLInputElement, text: string, caret = text.length) {
  fireEvent.change(input, { target: { value: text } });
  input.setSelectionRange(caret, caret);
}

const GREEK = { key: "g", code: "KeyG", ctrlKey: true };
const SUBSCRIPT = { US: { key: "-", code: "Minus", ctrlKey: true }, IT: { key: "-", code: "Slash", ctrlKey: true } };

/** One text input per kind of search field of the app. */
const FIELDS: [string, () => HTMLInputElement][] = [
  ["the find bar", () => screen.getByLabelText(S.status.find) as HTMLInputElement],
  ["the command palette", () => {
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    return within(screen.getByRole("dialog", { name: S.commands.title })).getByLabelText(S.commands.search) as HTMLInputElement;
  }],
  ["the function catalogue", () => {
    fireEvent.keyDown(window, { key: "F2", code: "F2" });
    return within(screen.getByRole("dialog", { name: S.catalogue.title })).getByLabelText(S.catalogue.search) as HTMLInputElement;
  }],
  ["the palette search", () => {
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.symbols }));
    return within(screen.getByRole("dialog", { name: S.ribbon.palette.symbols })).getByLabelText(S.ribbon.palette.search) as HTMLInputElement;
  }],
  ["the variables filter", () => {
    fireEvent.click(screen.getByTestId("panel-toggle"));
    return screen.getByLabelText(S.panel.variables.filter) as HTMLInputElement;
  }],
];

describe.each(FIELDS)("Ctrl+G and Ctrl+- in %s", (_name, field) => {
  it("toggles the letter before the caret to Greek and back, keeping the caret", async () => {
    window.localStorage.clear();
    await openDemo();
    const input = field();
    fill(input, "pa", 1);
    fireEvent.keyDown(input, GREEK);
    expect(input.value).toBe("πa");
    expect(input.selectionStart).toBe(1);
    fireEvent.keyDown(input, GREEK);
    expect(input.value).toBe("pa");
    expect(input.selectionStart).toBe(1);
  });

  it("is a no-op for an empty field, a non-letter and a caret at the start", async () => {
    window.localStorage.clear();
    await openDemo();
    const input = field();
    fireEvent.keyDown(input, GREEK);
    expect(input.value).toBe("");
    fill(input, "7");
    fireEvent.keyDown(input, GREEK);
    expect(input.value).toBe("7");
    fill(input, "ab", 0);
    fireEvent.keyDown(input, GREEK);
    expect(input.value).toBe("ab");
  });

  it("inserts the literal-subscript separator on US and Italian key events", async () => {
    window.localStorage.clear();
    await openDemo();
    const input = field();
    fill(input, "x");
    fireEvent.keyDown(input, SUBSCRIPT.US);
    expect(input.value).toBe("x_");
    fireEvent.keyDown(input, SUBSCRIPT.IT);
    expect(input.value).toBe("x__");
    fill(input, "xmax", 1);
    fireEvent.keyDown(input, SUBSCRIPT.IT);
    expect(input.value).toBe("x_max");
    expect(input.selectionStart).toBe(2);
  });
});

describe("what the chords do for the search", () => {
  it("handled chords do not reach the global key handler or the browser", async () => {
    await openDemo();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    const input = screen.getByLabelText(S.status.find) as HTMLInputElement;
    fill(input, "p");
    const event = new KeyboardEvent("keydown", { ...GREEK, bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    window.removeEventListener("keydown", seen);
    expect(event.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(input.value).toBe("π");
  });

  it("the find bar finds a name with a literal subscript typed with Ctrl+-", async () => {
    await openDemo();
    const input = screen.getByLabelText(S.status.find) as HTMLInputElement;
    fill(input, "M");
    fireEvent.keyDown(input, SUBSCRIPT.IT);
    fireEvent.change(input, { target: { value: `${input.value}max` } });
    expect(input.value).toBe("M_max");
    expect(screen.getByText(S.status.findCount(1, 2))).not.toBeNull();
  });

  it("searching a Greek letter finds the Greek symbol", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.symbols }));
    const symbols = screen.getByRole("dialog", { name: S.ribbon.palette.symbols });
    const input = within(symbols).getByLabelText(S.ribbon.palette.search) as HTMLInputElement;
    fill(input, "a");
    fireEvent.keyDown(input, GREEK);
    expect(input.value).toBe("α");
    expect(within(symbols).getAllByRole("button").map((b) => b.textContent)).toContain("α");
  });

  it("the variables filter keeps the names with the subscript", async () => {
    window.localStorage.clear();
    await openDemo();
    fireEvent.click(screen.getByTestId("panel-toggle"));
    const filter = screen.getByLabelText(S.panel.variables.filter) as HTMLInputElement;
    fill(filter, "M");
    fireEvent.keyDown(filter, SUBSCRIPT.US);
    fireEvent.change(filter, { target: { value: `${filter.value}max` } });
    const rows = await screen.findAllByTestId("variable-row");
    expect(rows.length).toBeGreaterThan(0);
    // the name is typeset: M with the literal subscript max
    for (const row of rows) expect(row.querySelector(".name-cell")?.textContent).toBe("Mmax");
  });
});
