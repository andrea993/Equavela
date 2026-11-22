import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";

afterEach(cleanup);

async function press(key: string) {
  await act(async () => { fireEvent.keyDown(window, { key, code: key }); });
}

it.each(["Backspace", "Delete"])("%s exposes an operator gap, accepts a replacement and can remove it into a product", async key => {
  const backend = createMockBackend({ fast: true });
  const added = vi.spyOn(backend, "addMathRegion");
  render(<App backend={backend} />);
  await waitFor(() => expect(document.querySelector('[data-region-id="m1"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  await waitFor(() => expect(document.querySelectorAll(".region")).toHaveLength(0));
  for (const k of ["a", "+", "b", "ArrowLeft"]) await press(k);
  if (key === "Delete") await press("ArrowLeft");
  await press(key);
  const math = () => document.querySelector(".region.editing .math")!;
  expect(math().querySelectorAll(".ph")).toHaveLength(1);
  expect(math().textContent).not.toContain("+");
  await press("-");
  expect(math().querySelectorAll(".ph")).toHaveLength(0);
  expect(math().querySelectorAll(".name")).toHaveLength(2);
  await press("Backspace");
  expect(math().querySelectorAll(".ph")).toHaveLength(1);
  await press("Backspace");
  expect(math().querySelectorAll(".ph")).toHaveLength(0);
  await press("Enter");
  await waitFor(() => expect(document.querySelector(".region.editing")).toBeNull());
  expect(added).toHaveBeenCalledTimes(1);
  expect(added.mock.calls[0][4]).toMatchObject({ type: "ExprRegion", expr: {
    type: "Juxt", left: { type: "Ident", name: { segments: [{ text: "a" }] } },
    right: { type: "Ident", name: { segments: [{ text: "b" }] } },
  } });
});
