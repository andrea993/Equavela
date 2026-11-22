import { describe, expect, it } from "vitest";
import {
  CROSSHAIR_MAX_REPEAT_STEPS,
  crosshairBeside,
  crosshairRepeatSteps,
  moveCrosshair,
  moveDraftCrosshair,
  regionAt,
  type PageBox,
} from "./crosshair";

const box: PageBox = { width: 595.28, height: 841.89, margins: { top: 72, right: 54, bottom: 72, left: 54 } };
const at = (page: number, x: number, y: number) => ({ page, x, y });

describe("moving the crosshair with the arrows", () => {
  it("moves beyond the paper width and across paper-height guides in draft view", () => {
    expect(moveDraftCrosshair(box, at(1, 600, 300), "right").x).toBe(603);
    const next = moveDraftCrosshair(box, at(1, 600, box.height - 1), "down");
    expect(next.page).toBe(2);
    expect(next.y).toBeCloseTo(2);
    expect(moveDraftCrosshair(box, next, "up").y).toBeCloseTo(box.height - 1);
  });
  it("moves one grid step (3 pt) in each direction", () => {
    expect(moveCrosshair(box, at(1, 300, 300), "right")).toEqual(at(1, 303, 300));
    expect(moveCrosshair(box, at(1, 300, 300), "left")).toEqual(at(1, 297, 300));
    expect(moveCrosshair(box, at(1, 300, 300), "down")).toEqual(at(1, 300, 303));
    expect(moveCrosshair(box, at(1, 300, 300), "up")).toEqual(at(1, 300, 297));
    expect(moveCrosshair(box, at(1, 300, 300), "right", 4)).toEqual(at(1, 312, 300));
  });

  it("stays between the margins at the left and the right", () => {
    expect(moveCrosshair(box, at(1, 54, 300), "left")).toEqual(at(1, 54, 300));
    expect(moveCrosshair(box, at(1, 54.5, 300), "left").x).toBe(54);
    const rightEdge = box.width - box.margins.right;
    const far = moveCrosshair(box, at(1, rightEdge, 300), "right");
    expect(far.x).toBeLessThanOrEqual(rightEdge + 1.5);
    expect(moveCrosshair(box, far, "right").x).toBe(far.x);
  });

  it("stops at the top of the first page", () => {
    expect(moveCrosshair(box, at(1, 99, 72), "up")).toEqual(at(1, 99, 72));
  });

  it("crosses page breaks downwards and upwards", () => {
    const nextPage = moveCrosshair(box, at(1, 99, 768), "down");
    expect(nextPage).toEqual(at(2, 99, 72));
    const back = moveCrosshair(box, at(2, 99, 72), "up");
    expect(back.page).toBe(1);
    expect(back.y).toBe(771);
  });
});

describe("accelerating while an arrow is held", () => {
  it("keeps the first press precise and grows the step with the repeats up to a cap", () => {
    expect(crosshairRepeatSteps(0)).toBe(1);
    expect(crosshairRepeatSteps(1)).toBe(1);
    expect(crosshairRepeatSteps(2)).toBe(2);
    expect(crosshairRepeatSteps(3)).toBe(2);
    expect(crosshairRepeatSteps(6)).toBe(4);
    expect(crosshairRepeatSteps(1000)).toBe(CROSSHAIR_MAX_REPEAT_STEPS);
  });
});

describe("regions under and beside the crosshair", () => {
  const rects = [
    { id: "a", page: 1, x: 54, y: 100, w: 100, h: 20 },
    { id: "b", page: 1, x: 54, y: 130, w: 100, h: 20 },
    { id: "c", page: 2, x: 54, y: 100, w: 100, h: 20 },
  ];

  it("finds the region the crosshair moved onto, on its own page", () => {
    expect(regionAt(rects, at(1, 60, 110))).toBe("a");
    expect(regionAt(rects, at(1, 60, 135))).toBe("b");
    expect(regionAt(rects, at(2, 60, 110))).toBe("c");
    expect(regionAt(rects, at(1, 60, 125))).toBeNull();
    expect(regionAt(rects, at(1, 300, 110))).toBeNull();
  });

  it("puts the crosshair outside the region where typing would start a line", () => {
    const rect = { page: 1, x: 99, y: 201, w: 120, h: 30 };
    // Left and right: on the region's first line, as the crosshair stands for typing.
    expect(crosshairBeside(box, rect, "right")).toEqual(at(1, 222, 210));
    expect(crosshairBeside(box, rect, "left")).toEqual(at(1, 96, 210));
    // Up and down: a line typed there ends or starts one grid step from the box.
    expect(crosshairBeside(box, rect, "up")).toEqual(at(1, 99, 192));
    expect(crosshairBeside(box, rect, "down")).toEqual(at(1, 99, 243));
  });

  it("keeps a math region's line below its rise", () => {
    const rect = { page: 1, x: 99, y: 201, w: 120, h: 60, rise: 24 };
    expect(crosshairBeside(box, rect, "right")).toEqual(at(1, 222, 234));
    expect(crosshairBeside(box, rect, "up")).toEqual(at(1, 99, 192));
    expect(crosshairBeside(box, rect, "down")).toEqual(at(1, 99, 273));
  });

  it("continues on the next page in draft view", () => {
    const rect = { page: 1, x: 99, y: 800, w: 120, h: 36 };
    const below = crosshairBeside(box, rect, "down", "draft");
    expect(below.page).toBe(2);
    expect(below.y).toBeCloseTo(800 + 36 + 12 - box.height);
    expect(crosshairBeside(box, rect, "right", "draft")).toEqual(at(1, 222, 809));
    expect(crosshairBeside(box, { ...rect, x: 600 }, "right", "draft").x).toBe(723);
  });

  it("stays inside the printable area", () => {
    const edge = { page: 1, x: 54, y: 72, w: 100, h: 20 };
    expect(crosshairBeside(box, edge, "left").x).toBe(54);
    expect(crosshairBeside(box, edge, "up").y).toBe(72);
  });
});
