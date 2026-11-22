// The inline math of a text region that is open in the editor: it draws
// the result or the error mark of the last committed text, with the same mark-up as the read-only view, and it
// follows the results as they arrive (the recalculation that a `SetText` triggers).

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RegionView from "./RegionView";
import { createRegionEditStore, RegionEditContext, type RegionEdit, type RegionEditStore } from "./regionEdit";
import { formatFromSettings } from "../results/format";
import type { PageSetup, RegionEntry, RegionKey, RichText, ViewRegion } from "../equavelaApi";

afterEach(cleanup);

const noop = () => undefined;

const SETUP: PageSetup = {
  size: "A4",
  width: 595.28,
  height: 841.89,
  margins: { top: 72, right: 54, bottom: 72, left: 54 },
  header: { left: "", center: "", right: "" },
  footer: { left: "", center: "", right: "" },
};

const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
const EVALUATE = { type: "Evaluate", expr: { type: "Ident", name: name("a") }, unit: null };
const PARAGRAPHS: RichText = [
  {
    runs: [
      { kind: "text", text: "The ratio " },
      { kind: "math", text: "a =", statement: EVALUATE },
    ],
  },
];
const REGION: ViewRegion = {
  id: "t1",
  page: 1,
  x: 54,
  y: 72,
  enabled: true,
  kind: "text",
  text: "The ratio □",
  width: null,
  paragraphs: PARAGRAPHS,
};
const KEY: RegionKey = { document: "/demo/demo.eqv", region_id: "t1\u001einline0", instance: 0 };
const INLINE: ReadonlyMap<string, RegionEntry> = new Map([
  [KEY.region_id, { key: KEY, state: "value", value: { type: "real", value: 0.5 } }],
]);
const INLINE_AGAIN: ReadonlyMap<string, RegionEntry> = new Map([
  [KEY.region_id, { key: KEY, state: "value", value: { type: "real", value: 2 } }],
]);
const INLINE_FAILED: ReadonlyMap<string, RegionEntry> = new Map([
  [
    KEY.region_id,
    {
      key: KEY,
      state: "error",
      failure: { kind: "evaluation", message: "division by zero", span: null, blocked_by: null, julia_type: null },
    },
  ],
]);
const NO_ENTRIES = new Map<string, RegionEntry>();

/** The text editor open on the region, as the page view publishes it. */
function editing(): RegionEdit {
  return {
    regionId: REGION.id,
    editor: null,
    breaks: [],
    textEdit: {
      initial: PARAGRAPHS,
      point: null,
      layout: "en-US",
      mathTarget: { current: null },
      clipboard: null,
      onReady: noop,
      onChange: noop,
      onLeave: noop,
      onHandle: noop,
      onFormat: noop,
    },
    completions: [],
    completionIndex: 0,
  };
}

/** The region drawn by the page view: the text editor when it is open (`edit`), else the read-only view. */
function page(store: RegionEditStore, inlineEntries: ReadonlyMap<string, RegionEntry>) {
  return (
    <RegionEditContext.Provider value={store}>
      <RegionView
        region={REGION}
        setup={SETUP}
        left={0}
        top={0}
        dragOffset={null}
        selected={false}
        entry={undefined}
        inlineEntries={inlineEntries}
        diagnostics={[]}
        format={formatFromSettings()}
        onPointerDown={noop}
        onSize={noop}
      />
    </RegionEditContext.Provider>
  );
}

function open(inlineEntries: ReadonlyMap<string, RegionEntry>) {
  const store = createRegionEditStore();
  store.set(editing());
  return render(page(store, inlineEntries));
}

const shown = (container: HTMLElement) => container.querySelector("[data-testid=result]")?.textContent;

/** A math region with a font of its own. */
const MATH: ViewRegion = {
  id: "m1",
  page: 1,
  x: 54,
  y: 200,
  enabled: true,
  kind: "math",
  text: "a =",
  statement: EVALUATE,
  format: {
    "math-font.size": "15",
    "math-font.color": "#c00000",
    "math-font.highlight": "#ffff00",
  },
};

/** The region drawn by the page view with an empty edit store. */
function regionPage(region: ViewRegion) {
  return (
    <RegionEditContext.Provider value={createRegionEditStore()}>
      <RegionView
        region={region}
        setup={SETUP}
        left={0}
        top={0}
        dragOffset={null}
        selected={false}
        entry={undefined}
        diagnostics={[]}
        format={formatFromSettings()}
        onPointerDown={noop}
        onSize={noop}
      />
    </RegionEditContext.Provider>
  );
}

const mathBox = (container: HTMLElement) => container.querySelector<HTMLElement>(".math")!;

describe("the math font of a math region", () => {
  it("draws the size, the text colour and the highlight on the math box", () => {
    const { container } = render(regionPage(MATH));
    const box = mathBox(container);
    // 15 pt (an older step, still drawn) = 20 px with 25 px of line, the conversion a text run uses.
    expect(box.style.getPropertyValue("--fs")).toBe("20px");
    expect(box.style.lineHeight).toBe("25px");
    expect(box.style.getPropertyValue("--math-color")).toBe("#c00000");
    expect(box.style.backgroundColor).toBe("rgb(255, 255, 0)");
    // The colour is a variable and not the `color` declaration, so the red of a failed region
    // (`.region.state-error .math`) still wins over a font colour.
    expect(box.style.color).toBe("");
    // The declaration is on the box that holds the math and its result, so both are drawn with it.
    expect(box.querySelector(".result") ?? box.querySelector(".op, .id, .num-lit")).not.toBeNull();
  });

  it("draws a region without a font of its own exactly as before", () => {
    const { container } = render(regionPage({ ...MATH, format: undefined }));
    // No declaration at all: the stylesheet draws the reference application's 11 pt (14.667 px on 18 px of line) in black.
    expect(mathBox(container).getAttribute("style")).toBeNull();
  });

  it("ignores a size outside 6 to 72 pt and a colour that is not #rrggbb", () => {
    const { container } = render(
      regionPage({ ...MATH, format: { "math-font.size": "100", "math-font.color": "red" } }),
    );
    expect(mathBox(container).getAttribute("style")).toBeNull();
  });
});

describe("inline math of a text region that is open in the editor", () => {
  it("draws the result of the last committed text, as the read-only view does", () => {
    const open_ = open(INLINE);
    expect(open_.container.querySelector("[data-testid=text-editor]")).not.toBeNull();
    expect(shown(open_.container)).toBe("0.5");
    // The same mark-up in the read-only view: the editor closed on the same results.
    const idle = render(page(createRegionEditStore(), INLINE));
    expect(idle.container.querySelector("[data-testid=text-view]")).not.toBeNull();
    expect(shown(idle.container)).toBe("0.5");
  });

  it("draws the error mark of a run that failed, open or not", () => {
    const open_ = open(INLINE_FAILED);
    const mark = open_.container.querySelector("[data-testid=inline-error]");
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("title")).toContain("division by zero");
    const idle = render(page(createRegionEditStore(), INLINE_FAILED));
    expect(idle.container.querySelector("[data-testid=inline-error]")).not.toBeNull();
  });

  it("follows the results when the committed text is evaluated again", () => {
    const store = createRegionEditStore();
    store.set(editing());
    const { container, rerender } = render(page(store, INLINE));
    expect(shown(container)).toBe("0.5");
    // The analysis of the committed text sends its results again (`SetText` and the recalculation).
    rerender(page(store, INLINE_AGAIN));
    expect(shown(container)).toBe("2");
    // A run whose result is not in yet draws no value, as in a math region.
    rerender(page(store, NO_ENTRIES));
    expect(shown(container)).toBeUndefined();
  });
});
