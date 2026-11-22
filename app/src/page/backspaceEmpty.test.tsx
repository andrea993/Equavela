// the specification : Backspace on an empty expression removes the region.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

afterEach(cleanup);

const key = async (k: string, code: string) =>
  act(async () => {
    fireEvent.keyDown(window, { key: k, code });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

describe("Backspace on an empty expression", () => {
  it("the first Backspace erases the content, the second removes the region", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).toBeNull());
    await key("a", "KeyA");
    expect(document.querySelector(".region.editing")).not.toBeNull();
    await key("Backspace", "Backspace");
    expect(document.querySelector(".region.editing")).not.toBeNull();
    await key("Backspace", "Backspace");
    await waitFor(() => expect(document.querySelector(".region.editing")).toBeNull());
    expect(document.querySelectorAll("[data-region-id]")).toHaveLength(0);
  });
});
