// the specification : Insert > Include asks for the file first; cancelling inserts
// nothing, and a chosen file becomes the path of the new include region.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

afterEach(cleanup);

const includes = () => document.querySelectorAll(".include-region").length;

async function openInsert(backend = createMockBackend({ fast: true })) {
  render(<App backend={backend} />);
  await waitFor(() => expect(document.querySelector("[data-region-id]")).not.toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  return backend;
}

describe("Insert > Include", () => {
  it("asks for the file and inserts the region with the chosen path", async () => {
    const backend = await openInsert();
    const choose = vi.spyOn(backend, "chooseIncludePath").mockResolvedValue("libs/new.eqv");
    const before = includes();
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.include }));
    await waitFor(() => expect(includes()).toBe(before + 1));
    expect(choose).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("libs/new.eqv").length).toBeGreaterThan(0);
  });

  it("inserts nothing when the dialog is cancelled", async () => {
    const backend = await openInsert();
    const choose = vi.spyOn(backend, "chooseIncludePath").mockResolvedValue(null);
    const add = vi.spyOn(backend, "addRegion");
    const before = includes();
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.include }));
    await waitFor(() => expect(choose).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(add).not.toHaveBeenCalled();
    expect(includes()).toBe(before);
  });
});
