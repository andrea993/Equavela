// Copy, cut, paste and mouse selection in the structural editor, and regions on the clipboard.

import { describe, expect, it, vi } from "vitest";
import { ctrl, named, typed } from "../keymap/testKeys";
import { mockParse, mockParseArgs, mockPrint, mockPrintArgs } from "../mock/mockMath";
import { regionsSnippet } from "../page/regionsClipboard";
import type { ViewRegion } from "../equavelaApi";
import { handleKey } from "./controller";
import { copyMath, cutSelection, pasteMath, type MathIO } from "./clipboard";
import { copyKind, focusAt, initialState, placeCaret, runCommand, selectRange, selectedNode, type EditorState } from "./model";
import { allPaths, get, ident, isEmptyStatement, sexpr, toEditing, toWire, type Node } from "./tree";

/** The editor's IO with the mock printer and parser standing in for the Rust bridge. */
const io: MathIO = {
  print: async (statement) => mockPrint(statement as Record<string, unknown>),
  parse: async (text) => mockParse(text),
  printArgs: async (args) => mockPrintArgs(args as Record<string, unknown>[]),
  parseArgs: async (text) => mockParseArgs(text),
};

/** An editor after typing `text` on the US layout, through the keymap. */
const state = (text: string): EditorState =>
  typed(text, "en-US").reduce((s, key) => handleKey(s, key, "en-US").state, initialState());
const root = (s: EditorState) => sexpr(s.root);
/** What the editor shows for text pasted as mock-parsed math. */
const tree = (text: string) => sexpr(toEditing(mockParse(text)));

describe("mock printer and parser (stand-ins for Rust)", () => {
  it("round-trips the supported subset", () => {
    for (const text of ["a := (x + y)·z", "x^2", "f(a, 2)/b", "-3 + y", "a - b - c"]) {
      expect(mockPrint(mockParse(text))).toBe(text);
    }
    expect(() => mockParse("a := := 1")).toThrow();
  });
});

describe("copy", () => {
  it("copies the selected sub-expression as canonical text", async () => {
    const s = state("x+y"); // the caret is in y
    expect(copyKind(s)).toBe("expr");
    expect(await copyMath(io, s)).toEqual({ text: "y" });
    const whole = selectRange(s, [0, 0], [0, 1]);
    expect(whole.explicit).toBe(true);
    expect(await copyMath(io, whole)).toEqual({ text: "x + y" });
  });

  it("copies a whole definition when the root statement is selected", async () => {
    const all = { ...state("a:3"), focus: [] as number[], explicit: true, caret: null };
    expect(copyKind(all)).toBe("statement");
    expect(await copyMath(io, all)).toEqual({ text: "a := 3" });
  });

  it("refuses an empty box", async () => {
    const empty = initialState();
    expect(copyKind(empty)).toBeNull();
    expect(await copyMath(io, empty)).toHaveProperty("error");
  });
});

describe("cut", () => {
  it("copies then deletes the selection (a box is left); the editor's undo takes it back", async () => {
    const s = selectRange(state("x+y"), [0, 0], [0, 1]);
    expect(await copyMath(io, s)).toEqual({ text: "x + y" });
    const cut = cutSelection(s);
    expect(isEmptyStatement(cut.root)).toBe(true);
    expect(root(runCommand(cut, "undo"))).toBe(root(s));
  });
});

describe("paste", () => {
  it("leaves the caret at the end of what was pasted, so = evaluates it", async () => {
    const then = async (start: EditorState, text: string, keys: string) => {
      const pasted = await pasteMath(io, start, text);
      if (!("state" in pasted)) throw new Error(pasted.error);
      return root(typed(keys, "en-US").reduce((s, key) => handleKey(s, key, "en-US").state, pasted.state));
    };
    expect(await then(initialState(), "Mmax", "=")).toBe("(= Mmax)");
    expect(await then(initialState(), "x + y", "=")).toBe("(= (+ x y))");
    expect(await then(initialState(), "f(a, b)", "=")).toBe("(= (call f a b))");
    expect(await then(state("2*"), "x", "=")).toBe("(= (· 2 x))");
  });

  it("replaces an empty placeholder with the parsed expression", async () => {
    const result = await pasteMath(io, initialState(), "a/b + 2");
    expect("state" in result && root(result.state)).toBe(tree("a/b + 2"));
  });

  it("replaces the selected sub-expression and the editor's history can undo it", async () => {
    const s = state("x+y");
    const selected = { ...s, explicit: true };
    expect(sexpr(selectedNode(selected))).toBe("y");
    const result = await pasteMath(io, selected, "z^2");
    expect("state" in result && root(result.state)).toBe(root(state("x+z^2")));
    if ("state" in result) expect(root(runCommand(result.state, "undo"))).toBe(root(s));
  });

  it("types a plain name or number into the name at the caret", async () => {
    const s = placeCaret(state("abc"), [0], "R", { seg: 0, offset: 1 });
    const result = await pasteMath(io, s, "XY");
    expect("state" in result && root(result.state)).toBe(tree("aXYbc"));
  });

  it("pastes a whole statement only into an empty region", async () => {
    const result = await pasteMath(io, initialState(), "a := 3");
    expect("state" in result && root(result.state)).toBe(tree("a := 3"));
    expect(await pasteMath(io, state("x"), "a := 3")).toHaveProperty("error");
  });

  it("explains when there is nothing to paste into or the text is not math", async () => {
    expect(await pasteMath(io, state("x+y"), "(1+2)")).toHaveProperty("error"); // no selection to replace
    expect(await pasteMath(io, initialState(), "   ")).toHaveProperty("error");
    expect(await pasteMath(io, initialState(), "a := := 1")).toHaveProperty("error");
  });
});

describe("cells of a matrix", () => {
  // A 2×3 matrix [a b c; d e f]: cell i is at [0, i].
  const matrix: Node = {
    type: "ExprRegion",
    expr: { type: "Matrix", rows: 2, cols: 3, cells: ["a", "b", "c", "d", "e", "f"].map((n) => ident(n)) },
  };
  const s = focusAt(matrix, [0, 0], "R");

  it("copies selected cells as the smaller matrix they form", async () => {
    const block = selectRange(s, [0, 1], [0, 5]);
    expect(sexpr(selectedNode(block))).toBe(sexpr({ type: "Matrix", rows: 2, cols: 2, cells: ["b", "c", "e", "f"].map((n) => ident(n)) }));
    expect(copyKind(block)).toBe("expr");
    // A row of the matrix is a row vector, a column a column vector.
    expect(sexpr(selectedNode(selectRange(s, [0, 0], [0, 2])))).toBe(sexpr({ type: "Matrix", rows: 1, cols: 3, cells: ["a", "b", "c"].map((n) => ident(n)) }));
    expect(sexpr(selectedNode(selectRange(s, [0, 1], [0, 4])))).toBe(sexpr({ type: "Matrix", rows: 2, cols: 1, cells: ["b", "e"].map((n) => ident(n)) }));
    // What goes to the Rust printer is a valid matrix (the mock printer has no matrices).
    expect(() => toWire({ type: "ExprRegion", expr: selectedNode(block) } as Node)).not.toThrow();
  });

  it("selects the whole matrix when the drag goes from a cell to the matrix itself", () => {
    const whole = selectRange(s, [0, 1], [0]);
    expect(whole.matrixSelection).toBeUndefined();
    expect(whole.explicit).toBe(true);
    expect(whole.focus).toEqual([0]);
  });
});

describe("mouse selection", () => {
  it("selects the smallest node that contains both ends of the drag", () => {
    const s = state("x+y*z");
    // x is [0,0]; the product is [0,1] with y [0,1,0] and z [0,1,1]
    expect(sexpr(selectedNode(selectRange(s, [0, 1, 0], [0, 1, 1])))).toBe("(· y z)");
    expect(sexpr(selectedNode(selectRange(s, [0, 0], [0, 1, 1])))).toBe("(+ x (· y z))");
    const same = selectRange(s, [0, 0], [0, 0]);
    expect(same.explicit).toBe(true);
    expect(sexpr(selectedNode(same))).toBe("x");
  });
});

describe("a run of call arguments", () => {
  it("copies the run as the list of its arguments in linear text", async () => {
    const s = state("f(a,b,c)");
    // [0] is the call (the region is transparent); child 0 is the callee, children 1..3 the arguments.
    expect(await copyMath(io, selectRange(s, [0, 1], [0, 3]))).toEqual({ text: "a, b, c" });
    expect(await copyMath(io, selectRange(s, [0, 3], [0, 2]))).toEqual({ text: "b, c" });
    // An argument that is a sub-expression keeps its text, in order.
    expect(await copyMath(io, selectRange(state("f(a+b,d)"), [0, 1, 1], [0, 2]))).toEqual({ text: "a + b, d" });
  });

  it("cut copies the run and removes its arguments, in one undo step", async () => {
    const s = state("f(a,b,c)");
    const run = selectRange(s, [0, 2], [0, 3]);
    expect(await copyMath(io, run)).toEqual({ text: "b, c" });
    const cut = cutSelection(run);
    expect(root(cut)).toBe(tree("f(a)"));
    expect(root(runCommand(cut, "undo"))).toBe(root(s));
    // A call keeps one argument: cutting every argument leaves an empty one.
    const all = cutSelection(selectRange(s, [0, 1], [0, 3]));
    expect(sexpr(all.root)).toBe("(call f □)");
  });

  it("pastes a run at the argument of the caret: f(x) and a, b give f(a, b)", async () => {
    const atName = placeCaret(state("f(x)"), [0, 1], "R");
    const result = await pasteMath(io, atName, "a, b");
    expect("state" in result && root(result.state)).toBe(root(state("f(a,b)")));
    // Undo of a paste is one step.
    if ("state" in result) expect(root(runCommand(result.state, "undo"))).toBe(root(atName));
  });

  it("pastes a run over the selected run in its place", async () => {
    const s = state("f(x,y,z)");
    const run = selectRange(s, [0, 1], [0, 2]); // x, y
    const replaced = await pasteMath(io, run, "a, b");
    expect("state" in replaced && root(replaced.state)).toBe(root(state("f(a,b,z)")));
    if ("state" in replaced) expect(root(runCommand(replaced.state, "undo"))).toBe(root(s));
    // One argument replaces the run with one argument too.
    const one = await pasteMath(io, run, "w");
    expect("state" in one && root(one.state)).toBe(root(state("f(w,z)")));
  });

  it("refuses a list of several arguments outside a call, and keeps the paste of one expression", async () => {
    expect(await pasteMath(io, state("x+y"), "a, b")).toHaveProperty("error");
    expect(await pasteMath(io, initialState(), "a, b")).toHaveProperty("error");
    // One expression keeps the ordinary paste of : it types into the name at the caret.
    const atName = placeCaret(state("f(x)"), [0, 1], "R");
    const typedName = await pasteMath(io, atName, "ab");
    expect("state" in typedName && root(typedName.state)).toBe(root(state("f(xab)")));
    // Inside a call, text that is not a list of arguments is still refused with the parse message.
    expect(await pasteMath(io, placeCaret(state("f(x)"), [0, 1], "R"), "a := 3")).toHaveProperty("error");
  });
});

describe("regions on the clipboard", () => {
  /** No picture in these regions: reading one is a test failure. */
  const noImage = async (resource: string): Promise<string> => {
    throw new Error(`unexpected image \`${resource}\``);
  };
  const regions = [
    { id: "r2", page: 1, x: 54, y: 140, enabled: true, kind: "text", text: "Beam **load**\n\nSecond", width: null, paragraphs: [{ runs: [] }] },
    { id: "r1", page: 1, x: 54, y: 72, enabled: true, kind: "math", text: "L := 3.5 m", statement: {} },
    { id: "r3", page: 2, x: 54, y: 50, enabled: true, kind: "include", path: "libs/h.eqv" },
    { id: "r4", page: 2, x: 54, y: 90, enabled: true, kind: "julia", block: { using: [], imports: [], code: null, defines: [] } },
    { id: "r5", page: 1, x: 300, y: 72, enabled: true, kind: "math", text: "", statement: mockParse("a/b") },
  ] as unknown as ViewRegion[];

  it("copies a plot with its mapping in JSON form, which the worksheet reader accepts", async () => {
    const plot = {
      version: 1,
      type: "xy",
      size: [300, 200],
      axes: { x: {}, y: {} },
      traces: [{ id: "t1", x: "x", y: "sin(x)", presentation: "line" }],
    };
    const region = { id: "p", page: 1, x: 54, y: 72, enabled: true, kind: "plot", plot } as unknown as ViewRegion;
    const result = await regionsSnippet([region], async () => "", noImage);
    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.snippet).toBe(`- id: p\n  page: 1\n  at: [54, 72]\n  plot: ${JSON.stringify(plot)}\n`);
  });

  it("writes a readable snippet of the worksheet regions list in reading order", async () => {
    const print = vi.fn(async (s: unknown) => mockPrint(s as Record<string, unknown>));
    const { snippet, copied, skipped } = await regionsSnippet(regions, print, noImage);
    expect(copied).toBe(5);
    expect(skipped).toBe(0);
    expect(snippet).toBe(
      [
        "- id: r1",
        "  page: 1",
        "  at: [54, 72]",
        '  math: "L := 3.5 m"',
        "- id: r5",
        "  page: 1",
        "  at: [300, 72]",
        '  math: "a/b"',
        "- id: r2",
        "  page: 1",
        "  at: [54, 140]",
        '  text: "Beam **load**\\n\\nSecond"',
        "- id: r3",
        "  page: 2",
        "  at: [54, 50]",
        '  include: "libs/h.eqv"',
        "- id: r4",
        "  page: 2",
        "  at: [54, 90]",
        "  julia: {}",
        "",
      ].join("\n"),
    );
    // only a math region without stored text is printed from its AST
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("copies a Julia region with its box, imports and code", async () => {
    const julia = {
      id: "j1",
      page: 1,
      x: 60,
      y: 80,
      enabled: true,
      kind: "julia",
      block: {
        playing: false,
        size: [300, 120],
        using: ["LinearAlgebra"],
        imports: [{ name: "area", package: "Geometry", function: "area" }],
        code: "function f(x)\n  x + 1\nend",
        defines: ["area"],
      },
    } as unknown as ViewRegion;
    const { snippet, copied, skipped } = await regionsSnippet([julia], async () => "", noImage);
    expect(copied).toBe(1);
    expect(skipped).toBe(0);
    expect(snippet).toBe(
      [
        "- id: j1",
        "  page: 1",
        "  at: [60, 80]",
        "  julia:",
        "    size: [300, 120]",
        "    playing: false",
        '    using: ["LinearAlgebra"]',
        "    import:",
        '      "area": "Geometry.area"',
        '    define: ["area"]',
        '    code: "function f(x)\\n  x + 1\\nend"',
        "",
      ].join("\n"),
    );
  });

  it("carries the bytes of an image region after the list", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwUBAP3l4wAAAABJRU5ErkJggg==";
    const image = { id: "i1", page: 1, x: 54, y: 100, enabled: true, kind: "image", resource: "img2", media: "png", size: [144, 108] } as ViewRegion;
    const load = vi.fn(async () => `data:image/png;base64,${png}`);
    const { snippet, copied, skipped } = await regionsSnippet([image], async () => "", load);
    expect(copied).toBe(1);
    expect(skipped).toBe(0);
    expect(load).toHaveBeenCalledWith("img2");
    expect(snippet).toBe(
      [
        "- id: i1",
        "  page: 1",
        "  at: [54, 100]",
        "  image:",
        "    resource: img2",
        "    size: [144, 108]",
        "resources:",
        "  img2:",
        "    media: png",
        `    base64: "${png}"`,
        "",
      ].join("\n"),
    );
  });

  it("stores an SVG as its text, as the file does, and once for two regions that share it", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const bytes = Uint8Array.from(svg, (character) => character.charCodeAt(0));
    const url = `data:image/svg+xml;base64,${btoa(String.fromCharCode(...bytes))}`;
    const regions = [
      { id: "i1", page: 1, x: 54, y: 100, enabled: true, kind: "image", resource: "img1", media: "svg", size: [144, 108] },
      { id: "i2", page: 1, x: 54, y: 300, enabled: true, kind: "image", resource: "img1", media: "svg", size: [144, 108] },
    ] as ViewRegion[];
    const { snippet, copied } = await regionsSnippet(regions, async () => "", async () => url);
    expect(copied).toBe(2);
    expect(snippet).toContain(`    media: svg\n    text: ${JSON.stringify(svg)}\n`);
    expect(snippet.match(/resources:/g)).toHaveLength(1);
    expect(snippet.match(/^  img1:$/gm)).toHaveLength(1);
  });

  it("leaves out an image whose bytes cannot be read and reports it", async () => {
    const image = { id: "i1", page: 1, x: 54, y: 100, enabled: true, kind: "image", resource: "img7", media: "png", size: [144, 108] } as ViewRegion;
    const unreadable = async () => {
      throw { kind: "region", message: "no image resource `img7`" };
    };
    const { snippet, copied, skipped } = await regionsSnippet([image], async () => "", unreadable);
    expect(copied).toBe(0);
    expect(skipped).toBe(1);
    expect(snippet).toBe("");
  });

  it("writes an area with its title, band and collapsed flag", async () => {
    const area = { id: "a1", page: 1, x: 54, y: 100, enabled: true, kind: "area", title: 'Beam "A"', height: 120, collapsed: true } as ViewRegion;
    const member = { id: "m1", page: 1, x: 72, y: 140, enabled: true, kind: "math", text: "L := 3 m", statement: {} } as ViewRegion;
    const { snippet, copied, skipped } = await regionsSnippet([member, area], async () => "", noImage);
    expect(copied).toBe(2);
    expect(skipped).toBe(0);
    expect(snippet).toBe(
      [
        "- id: a1",
        "  page: 1",
        "  at: [54, 100]",
        "  area:",
        '    title: "Beam \\"A\\""',
        "    height: 120",
        "    collapsed: true",
        "- id: m1",
        "  page: 1",
        "  at: [72, 140]",
        '  math: "L := 3 m"',
        "",
      ].join("\n"),
    );
  });
});

describe("program blocks on the clipboard", () => {
  // The Rust bridge prints a program as linear text and parses it back; here the wire tree itself is the
  // text, so the model's copy and paste of program lines is what is tested.
  const wireIO: MathIO = { ...io, print: async (statement) => JSON.stringify(statement), parse: async (text) => JSON.parse(text) };
  const program = (): EditorState => {
    const keys = [...typed("x:", "en-US"), ...typed("]", "en-US"), ...typed("a", "en-US"), ...typed("}", "en-US"), ...typed("1", "en-US")];
    return keys.reduce((s, key) => handleKey(s, key, "en-US").state, initialState());
  };
  const pathOf = (s: EditorState, type: string) => allPaths(s.root).find((path) => get(s.root, path).type === type)!;
  const emptyLine = (s: EditorState) =>
    allPaths(s.root).find((path) => get(s.root, path).type === "ExprStmt" && get(s.root, [...path, 0]).type === "Placeholder")!;
  const leafNamed = (s: EditorState, name: string) => allPaths(s.root).find((path) => sexpr(get(s.root, path)) === name && get(s.root, path).type === "Ident")!;

  it("copies an if block and pastes it as program lines on an empty line", async () => {
    const s = program();
    expect(root(s)).toBe("(:= x (program (if (if a 1)) □))");
    const block = focusAt(s.root, pathOf(s, "If"), "R", true);
    expect(copyKind(block)).toBe("program");
    const copied = await copyMath(wireIO, block);
    expect("text" in copied).toBe(true);
    const text = (copied as { text: string }).text;
    // The empty second line of the program takes the block.
    const empty = focusAt(s.root, [...emptyLine(s), 0]);
    const pasted = await pasteMath(wireIO, empty, text);
    expect("state" in pasted && root(pasted.state)).toBe("(:= x (program (if (if a 1)) (if (if a 1))))");
  });

  it("undoes a pasted block in one step", async () => {
    const s = program();
    const text = (await copyMath(wireIO, focusAt(s.root, pathOf(s, "If"), "R", true))) as { text: string };
    const pasted = await pasteMath(wireIO, placeCaret(s, leafNamed(s, "a"), "R"), text.text);
    if (!("state" in pasted)) throw new Error("no paste");
    const undone = handleKey(pasted.state, { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false } as never, "en-US").state;
    expect(root(undone)).toBe(root(s));
  });

  it("pastes a block below a line that holds something", async () => {
    const s = program();
    const text = (await copyMath(wireIO, focusAt(s.root, pathOf(s, "If"), "R", true))) as { text: string };
    const onA = placeCaret(s, leafNamed(s, "a"), "R");
    const pasted = await pasteMath(wireIO, onA, text.text);
    expect("state" in pasted && root(pasted.state)).toBe("(:= x (program (if (if a 1)) (if (if a 1)) □))");
  });

  it("copies an else if under an empty if to be filled in", async () => {
    const keys = [
      ...typed("x:", "en-US"), ...typed("]", "en-US"), ...typed("a", "en-US"), ...typed("}", "en-US"), ...typed("1", "en-US"),
      named("ArrowDown"), ctrl("Semicolon", ";"), ...typed("b", "en-US"), named("Tab"), ...typed("2", "en-US"),
    ];
    const s = keys.reduce((x, key) => handleKey(x, key, "en-US").state, initialState());
    expect(root(s)).toBe("(:= x (program (if (if a 1) (elseif b 2))))");
    const elseIf = allPaths(s.root).filter((path) => get(s.root, path).type === "Branch")[1];
    const copied = (await copyMath(wireIO, focusAt(s.root, elseIf, "R", true))) as { text: string };
    expect(sexpr(toEditing(JSON.parse(copied.text)))).toBe("(program (if (if □ □) (elseif b 2)))");
  });

  it("copies one branch as an if of its own", async () => {
    const s = program();
    const branch = focusAt(s.root, pathOf(s, "Branch"), "R", true);
    expect(selectedNode(branch).type).toBe("Branch");
    expect(copyKind(branch)).toBe("program");
    const text = (await copyMath(wireIO, branch)) as { text: string };
    expect(JSON.parse(text.text).expr.body[0].type).toBe("If");
  });
});
