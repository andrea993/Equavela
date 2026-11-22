import { describe, expect, it } from "vitest";
import type { PageSetup } from "../equavelaApi";
import { placeOnPage } from "./insert";

const setup = { width: 612, height: 792, margins: { top: 72, right: 72, bottom: 72, left: 72 } } as PageSetup;

describe("a new region that does not fit on its page", () => {
  it("stays where it is asked for when it fits above the bottom margin", () => {
    expect(placeOnPage(setup, 2, 400, 220)).toEqual({ page: 2, y: 400 });
    expect(placeOnPage(setup, 2, 500, 220)).toEqual({ page: 2, y: 500 });
  });
  it("starts at the top of the next page's printable area otherwise", () => {
    expect(placeOnPage(setup, 2, 501, 220)).toEqual({ page: 3, y: 72 });
    expect(placeOnPage(setup, 1, 700, 72)).toEqual({ page: 2, y: 72 });
  });
  it("leaves a region taller than the printable area, or one asked for in the header, alone", () => {
    expect(placeOnPage(setup, 1, 300, 700)).toEqual({ page: 1, y: 300 });
    expect(placeOnPage(setup, 1, 10, 220)).toEqual({ page: 1, y: 10 });
  });
});
