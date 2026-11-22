// The header and footer text, with no
// DOM: the three tokens, the literal braces that are not tokens, the date of the drawing and the
// one-line rule the dialog and the core agree on.

import { describe, expect, it } from "vitest";
import {
  TOKENS,
  emptyLine,
  fileNameOf,
  isEmptyLine,
  pageLineProblem,
  renderLine,
  renderSlot,
  todayIso,
} from "./pageText";

const values = { page: 3, date: "2026-11-04", file: "beam.eqv" };

describe("tokens", () => {
  it("replaces the three tokens with the value of the page they are drawn on", () => {
    expect(renderSlot("Page {page}", values)).toBe("Page 3");
    expect(renderSlot("{date}", values)).toBe("2026-11-04");
    expect(renderSlot("{file} - {page}/{page}", values)).toBe("beam.eqv - 3/3");
    expect(TOKENS.page).toBe("{page}");
  });

  it("leaves every other brace exactly as it was typed", () => {
    expect(renderSlot("Beam {x} analysis", values)).toBe("Beam {x} analysis");
    expect(renderSlot("a lone { brace", values)).toBe("a lone { brace");
    expect(renderSlot("{Page} is not a token", values)).toBe("{Page} is not a token");
    expect(renderSlot("", values)).toBe("");
    expect(renderSlot("no tokens here", values)).toBe("no tokens here");
  });

  it("renders each slot of a line on its own", () => {
    const line = { left: "{file}", center: "Beam", right: "Page {page}" };
    expect(renderLine(line, values)).toEqual({ left: "beam.eqv", center: "Beam", right: "Page 3" });
  });

  it("takes the file name of the worksheet's path, and the untitled name as it is", () => {
    expect(fileNameOf("/home/user/beam.eqv")).toBe("beam.eqv");
    expect(fileNameOf("C:\\work\\portico.eqv")).toBe("portico.eqv");
    expect(fileNameOf("Untitled-2")).toBe("Untitled-2");
  });

  it("dates the drawing with the local date, not the UTC one", () => {
    // 00:30 local on 5 November is still 4 November in UTC in Rome: the drawing is dated the 5th.
    expect(todayIso(new Date(2026, 10, 5, 0, 30))).toBe("2026-11-05");
    expect(todayIso(new Date(2026, 0, 9, 23, 59))).toBe("2026-01-09");
  });
});

describe("an empty line", () => {
  it("draws nothing when all three slots are empty, and something as soon as one is not", () => {
    expect(isEmptyLine(emptyLine())).toBe(true);
    expect(isEmptyLine(undefined)).toBe(true);
    expect(isEmptyLine({ left: "", center: "Beam", right: "" })).toBe(false);
    expect(isEmptyLine({ left: "", center: "", right: " " })).toBe(false);
  });
});

describe("one line of text", () => {
  it("accepts what a single-line field can hold and refuses a control character", () => {
    expect(pageLineProblem(emptyLine())).toBeNull();
    expect(pageLineProblem({ left: "Beam", center: "Page {page}", right: "2026-11-04" })).toBeNull();
    expect(pageLineProblem({ left: "one\ntwo", center: "", right: "" })).toBe("line");
    expect(pageLineProblem({ left: "", center: "", right: "a\tb" })).toBe("line");
  });
});
