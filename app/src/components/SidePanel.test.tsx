import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocState } from "../workbench/useWorkbench";
import type { DefinitionInfo, Inspection, RegionKey } from "../equavelaApi";
import SidePanel from "./SidePanel";
import { valueId } from "../inspect/inspection";
import { S } from "../strings";

const key = (id: string, document = "/w.eqv"): RegionKey => ({ document, region_id: id, instance: 0 });
const definition = (name: string, id: string, document = "/w.eqv"): DefinitionInfo => ({
  name,
  label: "var",
  key: key(id, document),
  version: 1,
  global: false,
  signature: name,
  kernel_name: `${name}_v1`,
  rank: 0,
});

const inspection: Inspection = {
  root: "/w.eqv",
  definitions: [definition("mine", "r1"), definition("theirs", "x1", "/lib.eqv")],
  references: [],
  warnings: [],
  includes: [
    { document: "/lib.eqv", parent: "/w.eqv", region_id: "i1", exports: [definition("theirs", "x1", "/lib.eqv")], found: true },
    { document: "/gone.eqv", parent: "/w.eqv", region_id: "i2", exports: [], found: false },
  ],
  ranks: [[key("r1"), 0]],
};

function panel(tab: "variables" | "includes", onOpenDocument = vi.fn(), data = inspection, onJump = vi.fn()) {
  const doc = { root: "/w.eqv", view: { regions: [] }, results: [], diagnostics: [] } as unknown as DocState;
  render(
    <SidePanel
      doc={doc}
      inspection={data}
      warnings={[]}
      values={new Map()}
      ensureValues={() => {}}
      cursor={null}
      format={{ precision: 4 } as never}
      tab={tab}
      onTab={() => {}}
      onJump={onJump}
      onOpenDocument={onOpenDocument}
      onClose={() => {}}
    />,
  );
  return onOpenDocument;
}

afterEach(() => { cleanup(); window.localStorage.removeItem("equavela.sidePanelWidth"); Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 }); });

describe("side panel includes and variables", () => {
  it("lists only the names of the current worksheet under Variables", () => {
    panel("variables");
    const rows = screen.getAllByTestId("variable-row").map((row) => row.textContent ?? "");
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("mine");
    expect(rows.join(" ")).not.toContain("theirs");
  });

  it("shows each include as an accordion that is closed until opened", () => {
    const open = panel("includes");
    const [lib, gone] = screen.getAllByTestId("include-row") as HTMLButtonElement[];
    expect(lib.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("export-row").length).toBe(0);
    fireEvent.click(lib);
    expect(lib.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("export-row").map((row) => row.textContent)).toEqual(["theirs"]);
    fireEvent.click(lib);
    expect(screen.queryAllByTestId("export-row").length).toBe(0);
    // a missing file has nothing to open or expand
    expect(gone.disabled).toBe(true);
    expect(screen.getAllByTestId("include-open").length).toBe(1);
    // opening the file in a tab is its own button, not the accordion toggle
    fireEvent.click(screen.getByTestId("include-open"));
    expect(open).toHaveBeenCalledWith("/lib.eqv");
  });

  it("filters Includes by path and exported name, revealing matches inside collapsed files", () => {
    const nested = "C:/shared/props.eqv";
    const matching = definition("density", "r2", nested);
    const unrelated = definition("viscosity", "r3", nested);
    const data: Inspection = {
      ...inspection,
      includes: [...inspection.includes, {
        document: nested, parent: "/lib.eqv", region_id: "i3", exports: [matching, unrelated], found: true,
      }],
    };
    const jump = vi.fn();
    panel("includes", vi.fn(), data, jump);
    const input = screen.getByRole("searchbox", { name: S.panel.includes.filter });
    const search = (value: string) => fireEvent.change(input, { target: { value } });
    search("SHARED\\PROPS");
    expect(screen.getAllByTestId("include-row").map((row) => row.textContent)).toEqual(["lib.eqv", "props.eqv"]);
    search(" density ");
    const matches = screen.getAllByTestId("export-row");
    expect(matches.map((row) => row.textContent)).toEqual(["density"]);
    fireEvent.click(matches[0]);
    expect(jump).toHaveBeenCalledWith(matching.key);
    search("no match");
    expect(screen.getByText(S.panel.includes.noMatches)).not.toBeNull();
    search("");
    expect(screen.getAllByTestId("include-row")).toHaveLength(2);
    expect(screen.queryByTestId("export-row")).toBeNull();
  });
});

describe("REPL names in the Variables tab", () => {
  it("shows one row per name with every definition's REPL name in order", () => {
    const redefined: Inspection = {
      ...inspection,
      definitions: [
        { ...definition("x", "r1"), kernel_name: "x_v1", rank: 0 },
        { ...definition("y", "r2"), kernel_name: "y_v1", rank: 1 },
        { ...definition("x", "r3"), version: 2, kernel_name: "x_v2", rank: 2 },
      ],
    };
    const doc = { root: "/w.eqv", view: { regions: [] }, results: [], diagnostics: [] } as unknown as DocState;
    render(
      <SidePanel doc={doc} inspection={redefined} warnings={[]} values={new Map()} ensureValues={() => {}} cursor={null}
        format={{ precision: 4 } as never} tab="variables" onTab={() => {}} onJump={() => {}} onOpenDocument={() => {}}
        onClose={() => {}} moduleName="beam" />,
    );
    const rows = screen.getAllByTestId("variable-row");
    expect(rows).toHaveLength(2);
    const names = screen.getAllByTestId("variable-repl");
    expect(names.map((cell) => cell.textContent)).toEqual(["y_v1", "x_v1, x_v2"]);
    expect(names[0].previousElementSibling?.className).toBe("row-value");
    expect(names[0].previousElementSibling?.previousElementSibling?.className).toBe("row-name");
    expect(names[0].parentElement).toBe(rows[0]);
  });
});

it("shows the REPL name of a definition in the worksheet's hover card", async () => {
  const { default: HoverCard } = await import("./HoverCard");
  const definitionInfo = { ...definition("M_max", "r1"), kernel_name: "M_smax_v2" };
  render(
    <HoverCard hover={{ rect: { left: 0, top: 0, bottom: 10, right: 10 } } as never} info={{ kind: "definition", definition: definitionInfo, own: true } as never}
      value={undefined} root="/w.eqv" pageOf={() => 1} format={{ precision: 4 } as never} moduleName="beam" />,
  );
  expect(screen.getByTestId("hover-repl").textContent).toContain("Project.beam.M_smax_v2");
});


it("resizes the inspector by keyboard and pointer, clamps and restores its width", () => {
  panel("variables");
  const separator = screen.getByRole("separator", { name: "Resize side panel" });
  fireEvent.keyDown(separator, { key: "End" });
  expect(separator.getAttribute("aria-valuenow")).toBe("420");
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator.getAttribute("aria-valuenow")).toBe("420");
  fireEvent.keyDown(separator, { key: "Home" });
  expect(separator.getAttribute("aria-valuenow")).toBe("220");
  const pointer = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x });
    fireEvent(separator, event);
  };
  pointer("pointerdown", 500);
  pointer("pointermove", 400);
  expect(separator.getAttribute("aria-valuenow")).toBe("320");
  pointer("pointerup", 400);
  pointer("pointermove", 300);
  expect(separator.getAttribute("aria-valuenow")).toBe("320");
  expect(window.localStorage.getItem("equavela.sidePanelWidth")).toBe("320");
  cleanup();
  panel("variables");
  expect(screen.getByRole("separator", { name: "Resize side panel" }).getAttribute("aria-valuenow")).toBe("320");
});


it("resizes immediately from the visible narrow width and preserves the saved width until then", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  window.localStorage.setItem("equavela.sidePanelWidth", "420");
  panel("variables");
  const separator = screen.getByRole("separator", { name: "Resize side panel" });
  expect(separator.getAttribute("aria-valuenow")).toBe("272");
  expect(separator.getAttribute("aria-valuemax")).toBe("272");
  expect(window.localStorage.getItem("equavela.sidePanelWidth")).toBe("420");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(separator.getAttribute("aria-valuenow")).toBe("262");
  const pointer = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x });
    fireEvent(separator, event);
  };
  pointer("pointerdown", 100);
  pointer("pointermove", 110);
  expect(separator.getAttribute("aria-valuenow")).toBe("252");
  pointer("pointerup", 110);
});

describe("readable math in the side panel", () => {
  it("draws names as math and values in the unit the worksheet shows", () => {
    const target = { type: "Ident", name: { segments: [{ text: "M", subscript: false }, { text: "max", subscript: true }], label: null } };
    const doc = {
      root: "/w.eqv",
      view: {
        regions: [
          { id: "r1", page: 1, x: 0, y: 0, enabled: true, kind: "math", text: "M_max := 1", statement: { type: "Define", target, rhs: { type: "Num", text: "1" }, tail: null } },
        ],
      },
      results: [],
      diagnostics: [],
    } as unknown as DocState;
    const values = new Map([
      [valueId({ ...definition("M_max", "r1") }), {
        name: "M_max",
        version: 1,
        value: { type: "quantity", magnitude: { type: "real", value: 18375 }, dimension: [{ base: "mass", power: [1, 1] }] },
        size: null,
        error: null,
        display_unit: { text: "kN·m", divisor: 1000 },
      }],
    ]) as never;
    render(
      <SidePanel doc={doc} inspection={{ ...inspection, definitions: [{ ...definition("M_max", "r1"), kernel_name: "M_smax_v1" }] }}
        warnings={[]} values={values} ensureValues={() => {}} cursor={{ document: "/w.eqv", region_id: "r1", instance: 0 }}
        format={{ precision: 4 } as never} tab="variables" onTab={() => {}} onJump={() => {}} onOpenDocument={() => {}}
        onClose={() => {}} />,
    );
    const row = screen.getByTestId("variable-row");
    expect(row.querySelector(".name-cell .sub")?.textContent).toBe("max");
    expect(row.querySelector(".name-cell")?.textContent).not.toContain("_");
    expect(row.querySelector(".row-value")?.textContent).toContain("kN·m");
    expect(screen.getByText(/Names visible/).textContent).toContain("page 1");
    expect(screen.getByText(/Names visible/).textContent).not.toContain("r1");
  });
});

it("draws math regions in the Outline as math, without internal text", () => {
  const unit = (text: string) => ({ type: "Ident", name: { segments: [{ text, subscript: false }], label: "unit" } });
  const statement = {
    type: "Define",
    target: { type: "Ident", name: { segments: [{ text: "q", subscript: false }], label: null } },
    rhs: { type: "Juxt", left: { type: "Num", text: "12" }, right: { type: "Div", left: unit("kN"), right: unit("m") } },
    tail: null,
  };
  const doc = {
    root: "/w.eqv",
    view: { regions: [{ id: "r1", page: 1, x: 0, y: 0, enabled: true, kind: "math", text: "q := 12 kN@unit/m@unit", statement }] },
    results: [],
    diagnostics: [],
  } as unknown as DocState;
  render(
    <SidePanel doc={doc} inspection={inspection} warnings={[]} values={new Map()} ensureValues={() => {}} cursor={null}
      format={{ precision: 4 } as never} tab="outline" onTab={() => {}} onJump={() => {}} onOpenDocument={() => {}}
      onClose={() => {}} />,
  );
  const row = screen.getByTestId("outline-row");
  expect(row.querySelector(".row-math")).not.toBeNull();
  expect(row.textContent).not.toContain("@unit");
  expect(row.textContent).toContain("kN");
});
