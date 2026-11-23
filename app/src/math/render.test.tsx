import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import demo from "../mock/demo.opened.json";
import type { OpenedWorksheet } from "../equavelaApi";
import { BINARY_GLYPH, ELLIPSIS_GLYPH, GLYPH, level } from "./glyphs";
import { isGivenKeyword, labelOfName, MathNamesContext, MathStatement } from "./render";
import { DEFAULT_LABEL_STYLES, labelStylesOf, LabelStylesContext, type LabelKind, type LabelStyle } from "./labels";
import { UNIT_NAMES } from "./units";
import { allPaths, toEditing } from "../editor/tree";

afterEach(cleanup);

const opened = demo as unknown as OpenedWorksheet;

/** Renders the statement of a demo region (the AST comes from the Rust command output). */
function renderRegion(id: string) {
  const region = opened.view.regions.find((r) => r.id === id);
  if (!region || region.kind !== "math") throw new Error(`no math region ${id}`);
  return render(
    <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
      <div className="math">
        <MathStatement statement={region.statement as never} />
      </div>
    </MathNamesContext.Provider>,
  ).container;
}

const text = (container: HTMLElement) => (container.textContent ?? "").replace(/\s+/g, "");

/** Renders a hand-built statement (the serde shape of `core/src/ast.rs`). */
function renderStatement(statement: unknown) {
  return render(
    <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
      <div className="math">
        <MathStatement statement={statement as never} />
      </div>
    </MathNamesContext.Provider>,
  ).container;
}

const name = (value: string) => ({ segments: [{ text: value, subscript: false }], label: null });
const ident = (value: string) => ({ type: "Ident", name: name(value) });

describe("operator glyphs stay distinct", () => {
  it("draws definition, global definition, evaluation, symbolic and local assignment differently", () => {
    expect(renderRegion("m1").querySelector(".op.define")?.textContent).toBe(":=");
    expect(renderRegion("m8").querySelector(".op.global")?.textContent).toBe("≡");
    expect(renderRegion("m6").querySelector(".op.evaluate")?.textContent).toBe("=");
    expect(renderRegion("m12").querySelector(".op.symbolic")?.textContent).toBe("→");
    expect(renderRegion("m9").querySelector(".op.local")?.textContent).toBe("←");
    const glyphs = [GLYPH.define, GLYPH.globalDefine, GLYPH.evaluate, GLYPH.symbolic, GLYPH.local];
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("draws Boolean equality as a bold drawn sign, not as the evaluation glyph", () => {
    const container = renderRegion("m15");
    const bool = container.querySelector(".op.booleq");
    expect(bool).not.toBeNull();
    expect(bool?.getAttribute("data-glyph")).toBe("==");
    expect(bool?.getAttribute("aria-label")).toBe("boolean equals");
    // No text "=": it is two heavy SVG bars.
    expect(bool?.textContent).toBe("");
    expect(bool?.querySelectorAll("line")).toHaveLength(2);
    expect(container.querySelector(".op.evaluate")).toBeNull();
    expect(container.querySelector(".op.define")).toBeNull();
  });

  it("uses the typographic glyphs of the spec for the other operators", () => {
    expect(BINARY_GLYPH.Sub).toBe("−");
    expect(BINARY_GLYPH.Mul).toBe("·");
    expect(BINARY_GLYPH.Ne).toBe("≠");
    expect(BINARY_GLYPH.Le).toBe("≤");
    expect(BINARY_GLYPH.Ge).toBe("≥");
    expect(BINARY_GLYPH.In).toBe("∈");
    expect(BINARY_GLYPH.Xor).toBe("⊕");
    expect(BINARY_GLYPH.And).toBe("∧");
    expect(BINARY_GLYPH.Or).toBe("∨");
  });
});

describe("Greek letters of names", () => {
  it("draws a Greek variable in italic like a Latin one, and a Greek unit upright", () => {
    for (const letter of ["α", "φ", "ϕ", "Ω"]) {
      const view = renderStatement({ type: "ExprRegion", expr: ident(letter) });
      expect(view.querySelector(".id")?.classList.contains("up"), letter).toBe(false);
    }
    const unit = renderStatement({
      type: "ExprRegion",
      expr: { type: "Ident", name: { segments: [{ text: "Ω", subscript: false }], label: "unit" } },
    });
    expect(unit.querySelector(".id")?.classList.contains("up")).toBe(true);
  });
});

describe("gradient", () => {
  it("draws ∇ with the variables as its subscript, then the body", () => {
    const view = renderStatement({
      type: "ExprRegion",
      expr: { type: "Gradient", vars: [{ name: name("x") }, { name: name("y") }], body: ident("f") },
    });
    expect(text(view)).toBe("∇x,yf");
  });
});

describe("polar form", () => {
  it("draws the angle sign between magnitude and angle, and needs no parentheses after +", () => {
    const polar = { type: "Polar", left: { type: "Num", text: "5" }, right: ident("θ") };
    expect(text(renderStatement({ type: "ExprRegion", expr: polar }))).toBe("5∠θ");
    expect(text(renderStatement({ type: "ExprRegion", expr: { type: "Add", left: ident("a"), right: polar, split: false } }))).toBe("a+5∠θ");
  });
});

describe("convolutions", () => {
  it("draws the glyph between the operands", () => {
    expect(text(renderStatement({ type: "ExprRegion", expr: { type: "Conv", left: ident("a"), right: ident("b") } }))).toBe("a∗b");
    expect(text(renderStatement({ type: "ExprRegion", expr: { type: "CircConv", left: ident("a"), right: ident("b") } }))).toBe("a⊛b");
  });
});

describe("real and imaginary part", () => {
  it("draws the black-letter sign and the operand in parentheses", () => {
    // The parentheses are drawn like a call's (a fence), so the text is the sign and the operand.
    const re = renderStatement({ type: "ExprRegion", expr: { type: "RealPart", expr: ident("z") } });
    expect(text(re)).toBe("ℜz");
    expect(re.querySelector(".fenced.paren.call")).not.toBeNull();
    expect(text(renderStatement({ type: "ExprRegion", expr: { type: "ImagPart", expr: ident("z") } }))).toBe("ℑz");
  });
});

describe("per mille", () => {
  it("draws the value and the sign with no space, like the percent", () => {
    const view = renderStatement({ type: "ExprRegion", expr: { type: "Permille", expr: { type: "Num", text: "2.5" } } });
    expect(text(view)).toBe("2.5‰");
    expect(view.querySelector(".postfix")?.textContent).toBe("‰");
  });
});

describe("signs in names", () => {
  it("draws the plus and minus of a name with the shapes of + and −, keeping the name", () => {
    const view = renderStatement({
      type: "ExprRegion",
      expr: { type: "Ident", name: { segments: [{ text: "V", subscript: false }, { text: "˖", subscript: true }], label: null } },
    });
    expect(view.querySelector(".sub.lit")?.textContent).toBe("+");
    expect(view.querySelector(".name")?.getAttribute("data-name")).toContain("˖");
    expect(text(renderStatement({ type: "ExprRegion", expr: ident("a˗b") }))).toBe("a−b");
  });
});

describe("statements of the demo worksheet", () => {
  it("renders a definition with a unit", () => {
    expect(text(renderRegion("m1"))).toBe("L:=3.5m");
  });

  it("renders stacked fractions, powers and literal subscripts", () => {
    const container = renderRegion("m3");
    expect(container.querySelector(".frac .num")?.textContent).toContain("L");
    expect(container.querySelector(".frac .den")?.textContent).toBe("8");
    expect(container.querySelector(".sup")?.textContent).toBe("2");
    const subscript = container.querySelector(".name .sub.lit");
    expect(subscript?.textContent).toBe("max");
  });

  it("renders matrices with brackets and one cell per element", () => {
    const container = renderRegion("m5");
    expect(container.querySelectorAll(".matrix-grid .cell")).toHaveLength(9);
    expect(container.querySelectorAll(".matrix > svg.fence-side")).toHaveLength(2);
    expect(text(container)).toContain("123456");
  });

  it("keeps an absolute value inside a fraction in flow: only the fraction rule is out of flow", async () => {
    // `.frac .bar` used to match the bars of |Z|^2 in a denominator and lift it out of the line.
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/styles/math.css`, "utf8");
    expect(css).not.toMatch(/\.frac \.bar\s*\{/);
    expect(css).toMatch(/\.frac > \.bar-wrap > \.bar\s*\{/);
  });

  it("breaks the line at an equation break, the operator first, inside its fence", () => {
    const id = (name: string) => ({ type: "Ident", name: { segments: [{ text: name, subscript: false }] } });
    // a·(b - c + d), broken before `-` and before `+`.
    const inner = {
      type: "Add",
      split: true,
      left: { type: "Sub", split: true, left: id("b"), right: id("c") },
      right: id("d"),
    };
    const statement = {
      type: "ExprRegion",
      expr: { type: "Mul", left: id("a"), right: { type: "Paren", expr: inner } },
    };
    const container = render(<MathStatement statement={statement as never} path={[]} />).container;
    const fence = container.querySelector(".fenced.multiline")!;
    expect(fence).not.toBeNull();
    const breaks = [...fence.querySelectorAll("br.eq-break")];
    expect(breaks).toHaveLength(2);
    // Each break comes right before its operator, after the arrow and the indent of the
    // continuation line.
    expect(breaks.map((br) => br.nextElementSibling?.nextElementSibling?.textContent)).toEqual(["−", "+"]);
    expect(fence.querySelectorAll(".eq-break-arrow")).toHaveLength(2);
    expect(fence.querySelectorAll(".eq-break-indent")).toHaveLength(2);
    // The outer product has no break of its own.
    expect(container.querySelectorAll(".fenced.multiline")).toHaveLength(1);
  });

  it("breaks a line before a node and inside a string without changing the string", () => {
    const id = (name: string) => ({ type: "Ident", name: { segments: [{ text: name, subscript: false }] } });
    const statement = {
      type: "ExprRegion",
      expr: {
        type: "Call",
        callee: id("f"),
        args: [
          { type: "Expr", expr: id("a") },
          { type: "Expr", expr: { type: "Str", text: "hello" } },
        ],
      },
    };
    // A break before the first argument: the argument starts the continuation line.
    const between = render(
      <MathStatement statement={statement as never} path={[]} breaks={[{ path: [0, 1] }]} />,
    ).container;
    const br = between.querySelector(".fenced br.eq-break");
    expect(br).not.toBeNull();
    expect(br?.nextElementSibling?.nextElementSibling?.textContent).toBe("a");
    // A break inside the string: two drawn lines, the same string value.
    const inside = render(
      <MathStatement statement={statement as never} path={[]} breaks={[{ path: [0, 2], offset: 2 }]} />,
    ).container;
    const str = inside.querySelector(".str")!;
    expect(str.querySelector("br.eq-break")).not.toBeNull();
    // The arrow is the editing aid; the string's own characters are all there, none added.
    expect(text(str as HTMLElement).replaceAll("↵", "")).toBe("“hello”");
  });

  it("draws a display-only ellipsis cell with its own glyph, not a placeholder", () => {
    const cell = (form: string) => ({ type: "EllipsisCell", form });
    const statement = {
      type: "ExprRegion",
      expr: {
        type: "Matrix",
        rows: 2,
        cols: 2,
        cells: [{ type: "Num", text: "1" }, cell("horizontal"), cell("vertical"), cell("diagonal")],
      },
    };
    const container = render(<MathStatement statement={statement as never} path={[]} />).container;
    const cells = [...container.querySelectorAll(".matrix-grid .cell")];
    expect(cells).toHaveLength(4);
    // Each form draws its own glyph, and an ordinary cell draws none of them.
    expect(cells.map((c) => c.querySelector(".ellipsis-cell")?.textContent)).toEqual([
      undefined,
      "⋯",
      "⋮",
      "⋱",
    ]);
    expect(cells.map((c) => c.querySelector(".ellipsis-cell")?.getAttribute("data-form"))).toEqual([
      undefined,
      "horizontal",
      "vertical",
      "diagonal",
    ]);
    // The cell is its glyph, never the grey empty-slot placeholder; the brackets stay.
    expect(container.querySelector(".ph")).toBeNull();
    expect(container.querySelectorAll(".matrix > svg.fence-side")).toHaveLength(2);
    // Three forms, three distinct glyphs, none shared with the placeholder or the result slot.
    expect(new Set(Object.values(ELLIPSIS_GLYPH)).size).toBe(3);
    expect(Object.values(ELLIPSIS_GLYPH)).not.toContain("□");
    expect(Object.values(ELLIPSIS_GLYPH)).not.toContain("…");
  });

  it("draws a transposed target with its T", () => {
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const statement = {
      type: "Define",
      target: { type: "Transpose", target: { type: "Ident", name: name("V") } },
      rhs: { type: "Ident", name: name("W") },
      tail: null,
    };
    const container = render(<MathStatement statement={statement as never} path={[]} />).container;
    expect(container.textContent).toContain("VT");
  });

  it("draws a nested destructuring target as a matrix inside a cell", () => {
    // The cell of the outer grid that is itself a matrix draws its own brackets and grid, so
    // screen and print show the nested array the target unpacks.
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const cell = (text: string) => ({ type: "Ident", name: name(text) });
    const statement = {
      type: "Define",
      target: {
        type: "Destructure",
        rows: 2,
        cols: 2,
        cells: [
          cell("A11"),
          {
            type: "Destructure",
            rows: 2,
            cols: 1,
            cells: [cell("A211"), cell("A212")],
          },
          cell("A12"),
          cell("A22"),
        ],
      },
      rhs: {
        type: "Call",
        callee: { type: "Ident", name: name("f") },
        args: [{ type: "Expr", expr: cell("x") }],
      },
      tail: null,
    };
    const container = render(<MathStatement statement={statement as never} path={[]} />).container;
    // Two grids: the four cells of the target and the two cells of the nested matrix.
    expect(container.querySelectorAll(".matrix-grid")).toHaveLength(2);
    expect(container.querySelectorAll(".matrix-grid > .cell")).toHaveLength(6);
    expect(container.querySelectorAll(".matrix > svg.fence-side")).toHaveLength(4);
    // Reading order: the outer cells with the nested matrix in its cell, then the call (whose
    // parentheses are fences, not text).
    expect(text(container)).toBe("A11A211A212A12A22:=fx");
  });

  it("breaks a line inside a program line, by an explicit break and by an equation break", () => {
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const id = (text: string) => ({ type: "Ident", name: name(text) });
    const program = (split: boolean) => ({
      type: "Define",
      target: id("f"),
      rhs: {
        type: "Program",
        body: [{ type: "LocalDef", target: id("y"), rhs: { type: "Add", left: id("a"), right: id("b"), split } }],
      },
      tail: null,
    });
    const explicit = render(<MathStatement statement={program(false) as never} path={[]} breaks={[{ path: [1, 0, 1, 1] }]} />).container;
    expect(explicit.querySelectorAll("br.eq-break")).toHaveLength(1);
    cleanup();
    const equation = render(<MathStatement statement={program(true) as never} path={[]} />).container;
    expect(equation.querySelectorAll("br.eq-break")).toHaveLength(1);
  });

  it("renders a program block with a bar, keywords and nested bodies", () => {
    const container = renderRegion("m9");
    expect(container.querySelector(".prog > svg.prog-bar")).not.toBeNull();
    const keywords = [...container.querySelectorAll(".kw")].map((k) => k.textContent);
    expect(keywords).toEqual(["for", "if", "else"]);
    // `for` body and `if` bodies: three nested bars besides the program bar.
    expect(container.querySelectorAll(".prog-body > svg.prog-bar").length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll(".op.local")).toHaveLength(3);
  });

  it("renders the symbolic derivative, the sum and the integral", () => {
    const derivative = renderRegion("m11");
    // Parentheses are drawn as SVG fences, so they are not in the text.
    expect(text(derivative)).toBe("fx:=x2·sinx");
    expect(derivative.querySelectorAll(".fenced.call")).toHaveLength(2);
    const d = renderRegion("m12");
    expect(d.querySelectorAll(".frac")).toHaveLength(1);
    // Upright Latin d (not the double-struck ⅆ glyph), twice in d/dx.
    expect(d.querySelectorAll(".diff")).toHaveLength(2);
    expect(d.textContent).not.toContain("ⅆ");
    const sum = renderRegion("m13");
    expect(sum.querySelector(".bigop-glyph")?.textContent).toBe("∑");
    expect(sum.querySelector(".bigop-upper")?.textContent).toBe("10");
    const integral = renderRegion("m14");
    expect(integral.querySelector(".int-glyph")?.textContent).toBe("∫");
  });

  it("renders absolute value for the determinant and the range operator", () => {
    expect(renderRegion("m7").querySelectorAll(".fenced.bar")).toHaveLength(1);
    expect(renderRegion("m18").querySelector(".op.range")?.textContent).toBe("..");
  });

  it("renders complex literals and unknown nodes without throwing", () => {
    expect(text(renderRegion("m19"))).toBe("z:=3+4i");
    const unknown = render(<MathStatement statement={{ type: "Nope" }} />).container;
    // Never the type name: a neutral placeholder (and a development warning).
    expect(unknown.textContent).not.toContain("Nope");
    expect(unknown.querySelector(".ph")).not.toBeNull();
  });

  it("has an entry for every math region of the fixture", () => {
    const ids = opened.view.regions.filter((r) => r.kind === "math").map((r) => r.id);
    expect(ids.length).toBeGreaterThan(15);
    for (const id of ids) {
      expect(renderRegion(id).querySelector(".unknown")).toBeNull();
      cleanup();
    }
  });
});

describe("precedence levels", () => {
  it("orders the levels as the syntax spec does", () => {
    expect(level("Or")).toBeLessThan(level("And"));
    expect(level("And")).toBeLessThan(level("Eq"));
    expect(level("Eq")).toBeLessThan(level("Add"));
    expect(level("Add")).toBeLessThan(level("Mul"));
    expect(level("Mul")).toBeLessThan(level("Neg"));
    expect(level("Neg")).toBeLessThan(level("Div"));
    expect(level("Div")).toBeLessThan(level("Pow"));
    expect(level("Pow")).toBeLessThan(level("Call"));
    expect(level("Call")).toBeLessThan(level("Ident"));
  });
});

describe("addressable nodes (math editor)", () => {
  it("every node of every demo statement has an element with its path, and nothing else", () => {
    for (const region of opened.view.regions) {
      if (region.kind !== "math") continue;
      const tree = toEditing(region.statement);
      const container = render(
        <div className="math">
          <MathStatement statement={tree as never} path={[]} unitSlot />
        </div>,
      ).container;
      const inDom = new Set([...container.querySelectorAll("[data-path]")].map((e) => e.getAttribute("data-path")));
      const expected = new Set(allPaths(tree).map((p) => p.join(".")));
      for (const key of expected) expect(inDom.has(key), `${region.id}: ${key}`).toBe(true);
      for (const key of inDom) expect(expected.has(key ?? ""), `${region.id}: extra ${key}`).toBe(true);
      cleanup();
    }
  });

  it("does not draw a name of the unit table as a unit in a value position", () => {
    // `g` is the gram in the unit table; in a value position a plain name is a name, so it is drawn
    // as a variable everywhere — inside a program and outside it — and only `g@unit` is the gram.
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const program = {
      type: "Define",
      target: { type: "FunctionHead", name: { name: name("Z") }, params: [] },
      rhs: {
        type: "Program",
        body: [
          {
            type: "LocalDef",
            target: { type: "FunctionHead", name: { name: name("g") }, params: [{ name: name("x") }] },
            rhs: { type: "Ident", name: name("x") },
          },
          { type: "ExprStmt", expr: { type: "Call", callee: { type: "Ident", name: name("g") }, args: [{ type: "Expr", expr: { type: "Num", text: "2" } }] } },
          // The function read as a value: the case the name context decides (it is not the gram).
          { type: "LocalDef", target: { type: "Ident", name: name("y") }, rhs: { type: "Ident", name: name("g") } },
        ],
      },
      tail: null,
    };
    const container = render(
      <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
        <div className="math">
          <MathStatement statement={program as never} />
        </div>
      </MathNamesContext.Provider>,
    ).container;
    for (const drawn of container.querySelectorAll('[data-name="g"] .id')) {
      expect(drawn.className).not.toContain("unit");
    }
    expect(container.querySelector('[data-name="x"] .id')?.className).not.toContain("unit");
    cleanup();
    // The same name outside a program is a variable too: nothing makes a unit of a plain name.
    const plain = render(
      <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
        <div className="math">
          <MathStatement statement={{ type: "ExprRegion", expr: { type: "Ident", name: name("g") } } as never} />
        </div>
      </MathNamesContext.Provider>,
    ).container;
    expect(plain.querySelector('[data-name="g"] .id')?.className).not.toContain("unit");
    cleanup();
    // The label is what makes it the gram, and then it is drawn as a unit.
    const labelled = render(
      <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
        <div className="math">
          <MathStatement
            statement={
              {
                type: "ExprRegion",
                expr: { type: "Ident", name: { segments: [{ text: "g", subscript: false }], label: "unit" } },
              } as never
            }
          />
        </div>
      </MathNamesContext.Provider>,
    ).container;
    expect(labelled.querySelector('[data-name="g"] .id')?.className).toContain("unit");
  });

  it("draws a labelled unit bold italic and blue, and a plain unit-like name as a variable", () => {
    // demo.eqv: `L := 3.5 m@unit` — the litre-like `L` is a variable, the metre carries its label.
    const container = renderRegion("m1");
    const unit = container.querySelector('[data-name="m"] .id');
    expect(unit?.className).toContain("unit");
    expect(unit?.className).not.toContain("up");
    expect(container.querySelector('[data-name="L"] .id')?.className).toBe("id");
    // A unit override is a unit context: the plain names there draw as units.
    const override = render(
      <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
        <div className="math">
          <MathStatement
            unitSlot
            statement={
              {
                type: "Evaluate",
                expr: { type: "Ident", name: { segments: [{ text: "M_max", subscript: false }], label: null } },
                unit: { type: "Mul", left: ident("kN"), right: ident("m"), split: false },
              } as never
            }
          />
        </div>
      </MathNamesContext.Provider>,
    ).container;
    for (const drawn of override.querySelectorAll('.unit-slot [data-name] .id')) {
      expect(drawn.className).toContain("unit");
    }
    expect(override.querySelectorAll('.unit-slot [data-name]')).toHaveLength(2);
  });
});

describe("the label styles of the worksheet", () => {
  const name = (text: string, label: string | null = null) => ({ segments: [{ text, subscript: false }], label });
  const expr = (n: unknown) => ({ type: "ExprRegion", expr: n });
  const styled = (overrides: Partial<Record<LabelKind, Partial<LabelStyle>>>) => {
    const styles = labelStylesOf(undefined);
    for (const [kind, patch] of Object.entries(overrides)) {
      styles[kind as LabelKind] = { ...styles[kind as LabelKind], ...patch };
    }
    return styles;
  };
  const draw = (statement: unknown, labels = DEFAULT_LABEL_STYLES) =>
    render(
      <LabelStylesContext.Provider value={labels}>
        <div className="math">
          <MathStatement statement={statement as never} />
        </div>
      </LabelStylesContext.Provider>,
    ).container;

  it("resolves the label of a name: explicit first, then the contextual one", () => {
    const names = { units: UNIT_NAMES };
    expect(labelOfName(name("x"), names)).toBe("var");
    // A plain name is never a unit: the unit table says which spellings are available, the label
    // says which one is meant.
    expect(labelOfName(name("m"), names)).toBe("var");
    expect(labelOfName(name("m", "unit"), names)).toBe("unit");
    expect(labelOfName(name("m"), names, true)).toBe("fn");
    expect(labelOfName(name("sin"), names, true)).toBe("fn");
    expect(labelOfName(name("R", "const"), names)).toBe("const");
    expect(labelOfName(name("ORIGIN", "sys"), names)).toBe("sys");
    expect(labelOfName(name("Given"), names)).toBe("var");
    expect(labelOfName(name("solve", "kw"), names)).toBe("kw");
    // Inside a unit context every plain name is a unit.
    expect(labelOfName(name("m"), { units: UNIT_NAMES, unitContext: true })).toBe("unit");
  });

  it("declares nothing for a worksheet that stores no style, so the drawing is the one before LS", () => {
    const container = draw(expr({ type: "Ident", name: name("x") }));
    const shown = container.querySelector<HTMLElement>('[data-name="x"]')!;
    // The name names its label, whose stylesheet rule draws the built-in colour.
    expect(shown.getAttribute("data-label")).toBe("var");
    expect(shown.getAttribute("style")).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-name="x"] .id')!.getAttribute("style")).toBeNull();
  });

  it("draws a name in the style of its explicit label", () => {
    const labels = styled({ const: { italic: false, color: "#c00000" } });
    const container = draw(expr({ type: "Ident", name: name("R", "const") }), labels);
    const shown = container.querySelector<HTMLElement>('[data-name="R"]')!;
    // The colour is the attribute that selects the stylesheet rule of, not an inline colour.
    expect(shown.getAttribute("data-label")).toBe("const");
    const segment = shown.querySelector<HTMLElement>(".id")!;
    expect(segment.style.fontStyle).toBe("normal");
    expect(segment.style.color).toBe("");
  });

  it("gives a function and a unit the style of their contextual labels", () => {
    const labels = styled({ fn: { bold: true }, unit: { italic: false, underline: true } });
    const container = draw(
      expr({ type: "Call", callee: { type: "Ident", name: name("rows") }, args: [] }),
      labels,
    );
    const fn = container.querySelector<HTMLElement>('[data-name="rows"]')!;
    expect(fn.querySelector<HTMLElement>(".id")!.style.fontWeight).toBe("700");
    cleanup();
    // The unit label is what gives the name the unit style: `m@unit`.
    const unit = draw(expr({ type: "Ident", name: { ...name("m"), label: "unit" } }), labels).querySelector<HTMLElement>(
      '[data-name="m"]',
    )!;
    expect(unit.querySelector<HTMLElement>(".id")!.style.fontStyle).toBe("normal");
    expect(unit.querySelector<HTMLElement>(".id")!.style.textDecoration).toBe("underline");
  });

  it("draws the Given keyword of a solve block in the keyword style", () => {
    const labels = styled({ kw: { bold: false, color: "#008000" } });
    const container = draw(expr({ type: "Ident", name: name("Given") }), labels);
    const keyword = container.querySelector<HTMLElement>(".name.kw")!;
    expect(keyword.getAttribute("data-label")).toBe("kw");
    expect(keyword.style.fontWeight).toBe("400");
  });

  it("draws a literal subscript in the style of its name", () => {
    const subscript = { segments: [{ text: "F", subscript: false }, { text: "max", subscript: true }], label: null };
    const plain = draw(expr({ type: "Ident", name: subscript })).querySelector<HTMLElement>(".sub")!;
    expect(plain.getAttribute("style")).toBeNull();
    // A variable's subscript takes the class of the base letters: italic, as `.id` is.
    expect(plain.classList.contains("up")).toBe(false);
    cleanup();
    const call = draw(expr({ type: "Call", callee: { type: "Ident", name: subscript }, args: [] }));
    // A function's subscript is upright like the function name.
    expect(call.querySelector<HTMLElement>(".sub.lit")!.classList.contains("up")).toBe(true);
    cleanup();
    const italic = draw(expr({ type: "Ident", name: subscript }), styled({ var: { italic: true } }));
    // Italic is the built-in value of a variable, so even asking for it declares nothing.
    expect(italic.querySelector<HTMLElement>(".sub")!.getAttribute("style")).toBeNull();
    cleanup();
    const upright = draw(expr({ type: "Ident", name: subscript }), styled({ var: { italic: false } }));
    expect(upright.querySelector<HTMLElement>(".sub")!.style.fontStyle).toBe("normal");
  });
});

describe("nodes without a view", () => {
  it("a bare Placeholder statement or program line renders as the grey placeholder, never as text", () => {
    const bareRoot = render(<MathStatement statement={{ type: "Placeholder" } as never} path={[]} />);
    expect(bareRoot.container.textContent).not.toMatch(/Placeholder|</);
    expect(bareRoot.container.querySelector(".ph")).not.toBeNull();
    cleanup();
    const program = {
      type: "Define",
      target: { type: "Name", name: { segments: [{ text: "f", subscript: false }], label: null } },
      rhs: { type: "Program", body: [{ type: "Placeholder" }] },
      tail: null,
    };
    const line = render(<MathStatement statement={program as never} path={[]} />);
    expect(line.container.textContent).not.toMatch(/Placeholder/);
    expect(line.container.querySelector(".line .ph")).not.toBeNull();
    cleanup();
    const unknown = render(<MathStatement statement={{ type: "Nonsense" } as never} path={[]} />);
    expect(unknown.container.textContent).not.toMatch(/Nonsense/);
  });
});

describe("the Given keyword of a solve block", () => {
  const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
  const given = (text: string) => ({ type: "ExprRegion", expr: { type: "Ident", name: name(text) } });
  const draw = (statement: unknown) =>
    render(
      <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
        <div className="math">
          <MathStatement statement={statement as never} />
        </div>
      </MathNamesContext.Provider>,
    ).container;

  it("is drawn in the keyword style, in any case, and a variable is not", () => {
    for (const text of ["Given", "given", "GIVEN"]) {
      cleanup();
      const container = draw(given(text));
      const keyword = container.querySelector(".name.kw");
      expect(keyword?.textContent).toBe(text);
      expect(container.querySelector(".id")).toBeNull();
    }
    cleanup();
    const variable = draw(given("x"));
    expect(variable.querySelector(".kw")).toBeNull();
    expect(variable.querySelector(".id")?.textContent).toBe("x");
  });

  it("is recognised only as a plain name", () => {
    expect(isGivenKeyword(name("Given"))).toBe(true);
    expect(isGivenKeyword({ segments: [{ text: "Given", subscript: false }, { text: "1", subscript: true }] })).toBe(false);
    expect(isGivenKeyword(name("Given2"))).toBe(false);
    expect(isGivenKeyword({ ...name("Given"), label: "unit" })).toBe(false);
  });
});

describe("the lower slot of a sum or product", () => {
  const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
  const ident = (text: string) => ({ type: "Ident", name: name(text) });
  const draw = (expr: unknown) =>
    render(
      <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
        <div className="math">
          <MathStatement statement={toEditing({ type: "ExprRegion", expr }) as never} />
        </div>
      </MathNamesContext.Provider>,
    ).container;
  const lower = (container: HTMLElement) => container.querySelector(".bigop-lower")?.textContent;
  const above = (container: HTMLElement) =>
    (container.querySelector(".bigop-upper")?.textContent ?? "").trim();

  it("draws a condition in the lower slot, as typed, with nothing above the sigma", () => {
    const container = draw({
      type: "Sum",
      var: { name: name("") },
      index: { type: "Ne", left: ident("i"), right: ident("j") },
      bounds: null,
      body: { type: "Index", base: ident("a"), indices: [ident("i")] },
    });
    expect(container.querySelector(".bigop-glyph")?.textContent).toBe("∑");
    expect(lower(container)).toBe("i≠j");
    expect(above(container)).toBe("");
    // The condition keeps its own relational sign, never the evaluation or definition glyph.
    expect(container.querySelector(".op.rel")?.textContent).toBe("≠");
    expect(container.querySelector(".op.evaluate")).toBeNull();
    expect(container.querySelector(".op.define")).toBeNull();
    // The body is drawn after the operator.
    expect(container.textContent).toContain("a");
  });

  it("draws every relational glyph of a condition as its own sign", () => {
    for (const [type, glyph] of [
      ["Ne", "≠"],
      ["Lt", "<"],
      ["Gt", ">"],
      ["Le", "≤"],
      ["Ge", "≥"],
    ]) {
      cleanup();
      const container = draw({
        type: "Prod",
        var: { name: name("") },
        index: { type, left: ident("i"), right: ident("j") },
        bounds: null,
        body: ident("i"),
      });
      expect(container.querySelector(".bigop-glyph")?.textContent).toBe("∏");
      expect(lower(container)).toBe(`i${glyph}j`);
      expect(above(container)).toBe("");
    }
  });

  it("draws an index-only sum as the index under the sigma, with nothing above and no glyph around it", () => {
    const container = draw({ type: "Sum", var: { name: name("i") }, bounds: null, body: ident("i") });
    expect(lower(container)).toBe("i");
    expect(above(container)).toBe("");
    expect(container.textContent).not.toContain("=");
  });
});

describe("a call of an element of an array", () => {
  const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
  const ident = (text: string) => ({ type: "Ident", name: name(text) });
  const draw = (expr: unknown) =>
    render(
      <MathNamesContext.Provider value={{ units: UNIT_NAMES }}>
        <div className="math">
          <MathStatement statement={toEditing({ type: "ExprRegion", expr }) as never} />
        </div>
      </MathNamesContext.Provider>,
    ).container;
  const element = (indices: unknown[]) => ({
    type: "Call",
    callee: { type: "Index", base: ident("Fn"), indices },
    args: [{ type: "Expr", expr: ident("x") }],
  });

  it("draws the element and then the argument list, with nothing in between", () => {
    const container = draw(element([ident("i")]));
    // The index is the ordinary drawn index (its brackets are the `sub idx` decoration) and the
    // arguments are the ordinary call fence, next to each other with no operator and no space.
    expect(container.querySelector(".sub.idx")?.textContent).toBe("i");
    expect(container.querySelector(".fenced.call")).not.toBeNull();
    // The brackets are CSS decoration, so the text is the element's name, its index and the
    // argument, with no operator or space between the element and the argument list.
    expect(text(container)).toBe("Fnix");
  });

  it("draws two indices and several arguments with the separators of a call", () => {
    const container = draw(element([ident("i"), ident("j")]));
    expect(container.querySelector(".sub.idx")?.textContent).toBe("i, j");
    const call = {
      type: "Call",
      callee: { type: "Index", base: ident("Fn"), indices: [ident("i")] },
      args: [
        { type: "Expr", expr: ident("x") },
        { type: "Expr", expr: ident("y") },
      ],
    };
    cleanup();
    const two = draw(call);
    expect(two.querySelector(".fenced.call")?.textContent).toContain(",");
  });

  it("draws a name used as an element as a value, not as a callee", () => {
    const container = draw(element([ident("i")]));
    // A callee is drawn upright (`isFunctionLike` + `callee`); an element is a variable.
    const drawn = container.querySelector('[data-name="Fn"] .id');
    expect(drawn?.className).not.toContain("up");
    expect(container.querySelector('[data-name="Fn"]')).not.toBeNull();
  });
});

describe("a parenthesised local definition", () => {
  it("draws the pair, the target, one \u2190 and the value, as the text prints", () => {
    // `y := g(x)/(z \u2190 3)`: the denominator is the definition and its pair is drawn once,
    // because in a box the pair of the form is the grouping pair too (no second pair).
    const statement = {
      type: "Define",
      target: ident("y"),
      rhs: {
        type: "Div",
        left: { type: "Call", callee: ident("g"), args: [{ type: "Expr", expr: ident("x") }] },
        right: {
          type: "Paren",
          expr: { type: "InlineDef", target: ident("z"), value: { type: "Num", text: "3" } },
        },
      },
      tail: null,
    };
    const container = renderStatement(statement);
    // The fraction bar and the call's fences are drawn, not written, so only the operands
    // and the operator glyphs are text.
    expect(text(container)).toBe("y:=gxz\u21903");
    expect(container.querySelectorAll(".frac").length).toBe(1);
    expect(container.querySelectorAll(".op.local").length).toBe(1);
    expect(container.querySelector(".op.local")?.textContent).toBe(GLYPH.local);
    // One pair for the definition, plus the pair of the call.
    expect(container.querySelectorAll(".fenced.paren").length).toBe(2);
    expect(container.querySelectorAll(".fenced.paren:not(.call)").length).toBe(1);
  });

  it("draws a destructuring definition under a postfix operator", () => {
    const statement = {
      type: "ExprRegion",
      expr: {
        type: "Transpose",
        expr: {
          type: "Paren",
          expr: {
            type: "InlineDef",
            target: {
              type: "Destructure",
              rows: 1,
              cols: 2,
              cells: [ident("a"), ident("b")],
            },
            value: { type: "Matrix", rows: 1, cols: 2, cells: [{ type: "Num", text: "1" }, { type: "Num", text: "2" }] },
          },
        },
      },
    };
    const container = renderStatement(statement);
    expect(container.querySelectorAll(".op.local").length).toBe(1);
    expect(container.querySelectorAll(".fenced.paren").length).toBe(1);
    expect(container.querySelectorAll(".matrix").length).toBe(2);
    expect(text(container)).toContain("ab\u219012");
  });

  it("draws a range inside the row operator, the column operator and the index", () => {
    // The brackets of a row or column are drawn in the superscript and the range is the
    // ordinary `..` of the operator table, so screen and print show what the text says.
    const range = (first: unknown, second: unknown, last: unknown) => ({
      type: "Range",
      first,
      second,
      last,
    });
    const n0 = { type: "Num", text: "0" };

    const row = renderStatement({
      type: "ExprRegion",
      expr: { type: "Row", base: ident("M"), index: range(n0, null, ident("n")) },
    });
    expect(text(row)).toBe("M\u27ea0..n\u27eb");
    expect(row.querySelector(".sup > .up:first-child")?.textContent).toBe("\u27ea");
    expect(row.querySelector(".sup .op.range")?.textContent).toBe(GLYPH.range);

    const column = renderStatement({
      type: "ExprRegion",
      expr: { type: "Column", base: ident("M"), index: range({ type: "Num", text: "1" }, null, { type: "Num", text: "3" }) },
    });
    expect(text(column)).toBe("M\u27e81..3\u27e9");
    expect(column.querySelector(".sup .op.range")?.textContent).toBe(GLYPH.range);

    // An index draws its brackets as decoration, so the text is the name and the range.
    const index = renderStatement({
      type: "ExprRegion",
      expr: { type: "Index", base: ident("v"), indices: [range({ type: "Num", text: "2" }, null, { type: "Num", text: "5" })] },
    });
    expect(text(index)).toBe("v2..5");
    expect(index.querySelector(".sub.idx .op.range")?.textContent).toBe(GLYPH.range);
    expect(index.querySelectorAll(".sub.idx .op.range")).toHaveLength(1);

    // The step form keeps its comma, as the text prints it (rule 3 of section 13).
    const step = renderStatement({
      type: "ExprRegion",
      expr: { type: "Row", base: ident("M"), index: range(n0, { type: "Num", text: "2" }, ident("n")) },
    });
    expect(text(step)).toBe("M\u27ea0,2..n\u27eb");
    expect(step.querySelectorAll(".sup .comma")).toHaveLength(1);
  });

  it("draws the index of a subscripted name one level lower", () => {
    const subscripted = {
      type: "Ident",
      name: {
        segments: [
          { text: "a", subscript: false },
          { text: "b", subscript: true },
        ],
        label: null,
      },
    };
    const indexed = renderStatement({
      type: "ExprRegion",
      expr: { type: "Index", base: subscripted, indices: [ident("i"), ident("j")] },
    });
    const nested = indexed.querySelector(".sub.idx.nested");
    expect(nested).not.toBeNull();
    expect(nested?.textContent).toBe("i, j");
    // The literal subscript keeps its ordinary level; the index is the second level.
    expect(indexed.querySelector(".sub.lit")?.textContent).toBe("b");
    expect(indexed.querySelector(".sub.idx:not(.nested)")).toBeNull();
    // A plain name's index stays at the ordinary subscript level.
    const plain = renderStatement({
      type: "ExprRegion",
      expr: { type: "Index", base: ident("v"), indices: [ident("i")] },
    });
    expect(plain.querySelector(".sub.idx")).not.toBeNull();
    expect(plain.querySelector(".sub.idx.nested")).toBeNull();
    // An assignment target follows the same drawing.
    const target = renderStatement({
      type: "Define",
      target: { type: "Index", base: subscripted, indices: [ident("i")] },
      rhs: ident("x"),
      tail: null,
    });
    expect(target.querySelector(".sub.idx.nested")?.textContent).toBe("i");
  });

  it("draws the reference application's percent after its value with no space", () => {
    const percent = (expr: unknown) => ({ type: "Percent", expr });

    const value = renderStatement({
      type: "ExprRegion",
      expr: percent({ type: "Num", text: "3.4" }),
    });
    // The sign is the operator glyph, directly after the value: one string on screen and in
    // the PDF, with no space between them.
    expect(text(value)).toBe("3.4%");
    expect(value.querySelector(".postfix")?.textContent).toBe(GLYPH.percent);
    // The value keeps its own rendering (a number is upright, not a name).
    expect(value.querySelector(".num-lit")?.textContent).toBe("3.4");

    // A definition and an evaluation carry it like any postfix operator.
    const definition = renderStatement({
      type: "Define",
      target: ident("x"),
      rhs: percent({ type: "Num", text: "3.4" }),
      tail: null,
    });
    expect(text(definition)).toBe("x:=3.4%");
    const evaluation = renderStatement({
      type: "Evaluate",
      expr: percent({ type: "Num", text: "3.4" }),
      unit: null,
    });
    expect(text(evaluation)).toBe("3.4%=");
    // Its operand is grouped by the rendering rule of the postfix level (13).
    const sum = renderStatement({
      type: "ExprRegion",
      expr: percent({
        type: "Add",
        left: ident("a"),
        right: ident("b"),
        split: false,
      }),
    });
    expect(sum.querySelectorAll(".fenced.paren")).toHaveLength(1);
    expect(text(sum)).toBe("a+b%");
  });
});

describe("the vectorize arrow", () => {
  const id = (name: string) => ({ type: "Ident", name: { segments: [{ text: name, subscript: false }], label: null } });
  it("is a rule over the whole operand with the head at its right end", () => {
    const operand = { type: "Add", left: { type: "Mul", left: id("A"), right: id("B") }, right: id("C") };
    const { container } = render(
      <MathStatement statement={toEditing({ type: "ExprRegion", expr: { type: "Vectorize", expr: operand } }) as never} path={[]} />,
    );
    const vectorize = container.querySelector(".vectorize")!;
    const arrow = vectorize.querySelector("svg.vec-arrow")!;
    // The arrow is drawn, not a fixed-size glyph, and the whole operand is under it.
    expect(vectorize.textContent).not.toContain("→");
    expect(arrow.querySelector("line")!.getAttribute("x2")).toBe("100%");
    expect(arrow.querySelector("svg")!.getAttribute("x")).toBe("100%");
    expect(vectorize.textContent?.replace(/\s+/g, "")).toContain("A");
    expect(vectorize.textContent?.replace(/\s+/g, "")).toContain("C");
  });

  it("spans only the part of the expression it is applied to", () => {
    // x + vec(A·B): the arrow is over A·B alone, not over x.
    const expr = { type: "Add", left: id("x"), right: { type: "Vectorize", expr: { type: "Mul", left: id("A"), right: id("B") } } };
    const { container } = render(<MathStatement statement={toEditing({ type: "ExprRegion", expr }) as never} path={[]} />);
    const vectorize = container.querySelector(".vectorize")!;
    expect(vectorize.querySelector("svg.vec-arrow")).not.toBeNull();
    expect(vectorize.textContent?.replace(/\s+/g, "")).not.toContain("x");
    expect(vectorize.textContent?.replace(/\s+/g, "")).toContain("A");
    expect(container.querySelectorAll("svg.vec-arrow")).toHaveLength(1);
  });
});

describe("an exponent on a tall base", () => {
  const num = (text: string) => ({ type: "Num", text });
  const power = (left: unknown) => ({ type: "ExprRegion", expr: { type: "Pow", left, right: num("2") } });

  it("puts the exponent of a fraction in parentheses at the top right of the base", () => {
    const container = renderStatement(power({ type: "Paren", expr: { type: "Div", left: ident("a"), right: ident("b") } }));
    const pow = container.querySelector(".pow.tall");
    expect(pow).not.toBeNull();
    expect(pow!.querySelector(":scope > .sup")?.textContent).toBe("2");
    expect(pow!.querySelector(".fenced .frac")).not.toBeNull();
  });

  it("keeps the ordinary raise for a base one line high", () => {
    expect(renderStatement(power(ident("x"))).querySelector(".pow")).toBeNull();
    expect(renderStatement(power({ type: "Paren", expr: { type: "Add", left: ident("x"), right: num("1") } })).querySelector(".pow")).toBeNull();
  });
});

describe("symbolic keyword lines", () => {
  it("draws each keyword group on its own line, with commas only before a keyword's arguments", () => {
    const group = (keyword: string, ...args: unknown[]) => ({ type: "KeywordGroup", keyword: ident(keyword), args });
    const container = renderStatement({ type: "Symbolic", expr: ident("x"), keywords: [group("simplify"), group("solve", ident("x"))] });
    const lines = container.querySelectorAll(".keywords > .keyword-line");
    expect([...lines].map((line) => line.textContent)).toEqual(["simplify", "solve, x"]);
    expect(container.querySelector(".keywords > .comma")).toBeNull();
  });
});
