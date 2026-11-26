import { describe, expect, it } from "vitest";
import { functionManualPath, manualAnchor, manualSlug } from "./manual";

describe("manual links", () => {
  it("follows the anchors and pages of the manual's generator", () => {
    expect(manualSlug("Array characteristics and linear algebra")).toBe("array-characteristics-and-linear-algebra");
    expect(manualAnchor("lsolve")).toBe("f-lsolve");
    expect(manualAnchor("J0.sc")).toBe("f-J0_2esc");
    expect(manualAnchor("Γ")).toBe("f-_393");
    expect(functionManualPath({ name: "lsolve", category: "Array characteristics and linear algebra" })).toBe(
      "manual/functions/array-characteristics-and-linear-algebra.html#f-lsolve",
    );
    expect(functionManualPath({ name: "odesolve", category: "Differential equations" })).toBe("manual/functions/differential-equations.html#f-odesolve");
  });
});
