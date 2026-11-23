import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRef, StrictMode } from "react";
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, COPY_COMMAND, createEditor, ElementNode, getNearestEditorFromDOMNode, UNDO_COMMAND } from "lexical";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { toEditing, toWire } from "../editor/tree";
import type { MathRun, RichText } from "../equavelaApi";
import TextEditor from "./lexical/TextEditor";
import { InlineMath, TextEnvContext } from "./InlineMath";
import { $readValue, $setAlign, $setParagraphStyle, $setRunColor, $setRunHighlight, $writeValue, roundTrip } from "./lexical/convert";
import { MathNode } from "./lexical/MathNode";
import { TextParagraphNode } from "./lexical/TextParagraphNode";
import { TextView } from "./TextView";
import { isEmptyText, paragraphCss, paragraphStyle, sameText, type InlineActive, type MathClipboard, type MathTarget, type TextHandle } from "./value";
import { rememberMathCopy } from "../mathPaste";

afterEach(cleanup);

const id = (text: string) => ({ type: "Ident", name: { segments: [{ text, subscript: false }], label: null } });
const ratio = { type: "ExprRegion", expr: { type: "Div", left: id("a"), right: id("b") } };

const VALUE: RichText = [
  {
    runs: [
      { kind: "text", text: "The ratio " },
      { kind: "math", text: "a/b", statement: ratio },
      { kind: "text", text: " is " },
      { kind: "text", text: "important", bold: true },
      { kind: "text", text: " for r" },
      { kind: "text", text: "2", sup: true },
      { kind: "text", text: " here, " },
      { kind: "text", text: "big", italic: true, underline: true, size: 18 },
    ],
  },
  { runs: [] },
  { runs: [{ kind: "text", text: "Second ", sub: true }, { kind: "math", text: "x +", statement: null }] },
];

describe("text value", () => {
  it("compares values ignoring run splits and empty runs", () => {
    const split: RichText = [{ runs: [{ kind: "text", text: "ab" }] }];
    const other: RichText = [
      { runs: [{ kind: "text", text: "a" }, { kind: "text", text: "" }, { kind: "text", text: "b" }] },
      { runs: [] },
    ];
    expect(sameText(split, other)).toBe(true);
    expect(sameText(split, [{ runs: [{ kind: "text", text: "ab", bold: true }] }])).toBe(false);
    expect(isEmptyText([{ runs: [] }, { runs: [{ kind: "text", text: "" }] }])).toBe(true);
    expect(isEmptyText([{ runs: [{ kind: "math", text: "", statement: ratio }] }])).toBe(false);
  });

  it("treats a style or an alignment change as a change of the value", () => {
    const plain: RichText = [{ runs: [{ kind: "text", text: "ab" }] }];
    expect(sameText(plain, [{ style: "normal", align: "left", runs: [{ kind: "text", text: "ab" }] }])).toBe(true);
    expect(sameText(plain, [{ align: "center", runs: [{ kind: "text", text: "ab" }] }])).toBe(false);
    expect(sameText(plain, [{ style: "heading1", runs: [{ kind: "text", text: "ab" }] }])).toBe(false);
  });

  it("draws a paragraph with the CSS of its style and alignment, on whole-px lines", () => {
    // One helper builds the CSS of the render and of the editor, so it is spelled once.
    // the reference application's Normal, 10 pt.
    expect(paragraphStyle("normal", "left")).toEqual({
      fontSize: "13.333px",
      fontWeight: 400,
      lineHeight: "17px",
      textAlign: "left",
    });
    expect(paragraphStyle("heading1", "center")).toEqual({
      fontSize: "21.333px",
      fontWeight: 700,
      lineHeight: "27px",
      marginBottom: "12px",
      textAlign: "center",
    });
    expect(paragraphStyle("title")).toMatchObject({ fontSize: "37.333px", lineHeight: "47px" });
    expect(paragraphStyle("subtitle")).toMatchObject({ fontSize: "24px", lineHeight: "30px" });
    expect(paragraphStyle("heading2")).toMatchObject({ fontSize: "17.333px", lineHeight: "22px" });
    expect(paragraphStyle("heading3")).toMatchObject({ fontSize: "16px", lineHeight: "20px" });
    // the string form used by the editor's paragraph element says the same thing
    expect(paragraphCss("heading1", "center")).toBe(
      "font-size: 21.333px; font-weight: 700; line-height: 27px; margin-bottom: 12px; text-align: center",
    );
    // The default 20 px space after stays in the stylesheet, where the last paragraph of a region has none.
    expect(paragraphCss("normal")).toBe("font-size: 13.333px; font-weight: 400; line-height: 17px; text-align: left");
    // the reference application's style sizes in points, on whole-px line heights.
    const points = { normal: 10, title: 28, subtitle: 18, heading1: 16, heading2: 13, heading3: 12 } as const;
    for (const [style, pt] of Object.entries(points) as [keyof typeof points, number][]) {
      const css = paragraphCss(style);
      expect(Number(/font-size: ([\d.]+)px/.exec(css)![1])).toBeCloseTo((pt * 4) / 3, 3);
      expect(css).toMatch(/line-height: \d+px/);
    }
  });
});

describe("Lexical conversion", () => {
  it("value to editor state to value keeps formats, sizes, empty paragraphs and math", () => {
    const back = roundTrip(VALUE);
    expect(sameText(back, VALUE)).toBe(true);
    // the math AST goes through the editing tree and back unchanged
    const math = back[0].runs.find((run) => run.kind === "math");
    expect(math && math.kind === "math" ? math.statement : null).toEqual(toWire(toEditing(ratio)));
    expect(back[1].runs).toEqual([]);
    const unparsed = back[2].runs[1];
    expect(unparsed).toEqual({ kind: "math", text: "x +", statement: null });
  });

  it("keeps the disabled flag and the own result format of an inline equation", () => {
    const value: RichText = [
      {
        runs: [
          { kind: "text", text: "a " },
          { kind: "math", text: "", statement: toWire(toEditing(ratio)), disabled: true, format: { "format.precision": "5" } },
          { kind: "math", text: "", statement: toWire(toEditing(ratio)) },
        ],
      },
    ];
    const back = roundTrip(value);
    expect(sameText(back, value)).toBe(true);
    const [first, second] = back[0].runs.filter((run) => run.kind === "math");
    expect(first).toMatchObject({ disabled: true, format: { "format.precision": "5" } });
    expect(second).not.toHaveProperty("disabled");
    expect(second).not.toHaveProperty("format");
    // A changed flag or format is a change of the text (it must reach the document).
    const enabled = { ...(value[0].runs[1] as MathRun), disabled: false };
    expect(sameText(back, [{ runs: [value[0].runs[0], enabled, value[0].runs[2]] }])).toBe(false);
  });

  it("keeps the paragraph style and alignment through the editor", () => {
    const value: RichText = [
      { style: "heading1", runs: [{ kind: "text", text: "Chapter 1" }] },
      { align: "center", runs: [{ kind: "text", text: "Centred body" }] },
      { style: "subtitle", align: "justify", runs: [{ kind: "text", text: "Both" }] },
      { runs: [{ kind: "text", text: "normal" }] },
    ];
    expect(sameText(roundTrip(value), value)).toBe(true);
    // a plain paragraph carries no attributes at all
    const plain = roundTrip([{ runs: [] }]);
    expect(plain).toEqual([{ runs: [] }]);
  });
});

/** A headless editor over the same nodes as the component: commands and their history can be driven directly. */
function headless(initial: RichText) {
  const editor = createEditor({
    namespace: "text-test",
    nodes: [MathNode, TextParagraphNode],
    onError: (error) => {
      throw error;
    },
  });
  registerHistory(editor, createEmptyHistoryState(), 0);
  editor.update(() => $writeValue(initial), { discrete: true });
  const value = () => editor.getEditorState().read($readValue);
  return { editor, value };
}

const THREE: RichText = [
  { runs: [{ kind: "text", text: "One" }] },
  { runs: [{ kind: "text", text: "Two" }] },
  { runs: [{ kind: "text", text: "Three" }] },
];

describe("paragraph commands", () => {
  it("styles every paragraph the selection touches, as one undo step", async () => {
    const { editor, value } = headless(THREE);
    editor.update(() => {
      const root = $getRoot();
      root.select(0, root.getChildrenSize());
      $setParagraphStyle("heading2");
    }, { discrete: true });
    expect(value().map((paragraph) => paragraph.style)).toEqual(["heading2", "heading2", "heading2"]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(value().map((paragraph) => paragraph.style)).toEqual([undefined, undefined, undefined]);
  });

  it("aligns the paragraph at the caret only, as one undo step", async () => {
    const { editor, value } = headless(THREE);
    editor.update(() => {
      const second = $getRoot().getChildAtIndex(1);
      if (second instanceof ElementNode) second.select(0, 0);
      $setAlign("center");
    }, { discrete: true });
    expect(value().map((paragraph) => paragraph.align)).toEqual([undefined, "center", undefined]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(value().map((paragraph) => paragraph.align)).toEqual([undefined, undefined, undefined]);
  });

  it("keeps the character formatting of a styled paragraph and its runs intact", () => {
    const { editor, value } = headless([
      { runs: [{ kind: "text", text: "Chapter " }, { kind: "text", text: "one", bold: true, size: 15 }] },
    ]);
    editor.update(() => {
      const root = $getRoot();
      root.select(0, root.getChildrenSize());
      $setParagraphStyle("title");
      $setAlign("right");
    }, { discrete: true });
    expect(value()).toEqual([
      {
        style: "title",
        align: "right",
        runs: [{ kind: "text", text: "Chapter " }, { kind: "text", text: "one", bold: true, size: 15 }],
      },
    ]);
  });
});

describe("text colour and highlight", () => {
  const COLORED: RichText = [
    {
      runs: [
        { kind: "text", text: "plain " },
        { kind: "text", text: "red", color: "#ff0000" },
        { kind: "text", text: " on yellow", color: "#ff0000", highlight: "#ffff80" },
        { kind: "text", text: " big", size: 18, highlight: "#c6efce" },
      ],
    },
  ];

  it("keeps the colour and the highlight of a run through the editor", () => {
    const back = roundTrip(COLORED);
    expect(sameText(back, COLORED)).toBe(true);
    expect(back[0].runs).toEqual([
      { kind: "text", text: "plain " },
      { kind: "text", text: "red", color: "#ff0000" },
      { kind: "text", text: " on yellow", color: "#ff0000", highlight: "#ffff80" },
      { kind: "text", text: " big", size: 18, highlight: "#c6efce" },
    ]);
  });

  it("counts a change of colour or highlight as a change of the text", () => {
    const plain: RichText = [{ runs: [{ kind: "text", text: "ab" }] }];
    expect(sameText(plain, [{ runs: [{ kind: "text", text: "ab", color: "#ff0000" }] }])).toBe(false);
    expect(sameText(plain, [{ runs: [{ kind: "text", text: "ab", highlight: "#ffff80" }] }])).toBe(false);
  });

  it("draws the colour, the highlight and the fill of the region with the same style in the view", () => {
    const { container } = render(<TextView paragraphs={COLORED} width={400} background="#fdfdd5" />);
    const spans = [...container.querySelectorAll<HTMLElement>("p span")];
    const red = spans.find((span) => span.textContent === "red")!;
    expect(red.style.color).toBe("rgb(255, 0, 0)");
    const marked = spans.find((span) => span.textContent === " on yellow")!;
    expect(marked.style.backgroundColor).toBe("rgb(255, 255, 128)");
    expect((container.querySelector(".text-region") as HTMLElement).style.backgroundColor).toBe("rgb(253, 253, 213)");
  });

  it("sets the colour and the highlight of the selected text, as one undo step each", async () => {
    const { editor, value } = headless([{ runs: [{ kind: "text", text: "Colour me" }] }]);
    editor.update(() => {
      const root = $getRoot();
      root.select(0, root.getChildrenSize());
      $setRunColor("#ff0000");
    }, { discrete: true });
    editor.update(() => {
      const root = $getRoot();
      root.select(0, root.getChildrenSize());
      $setRunHighlight("#ffff80");
    }, { discrete: true });
    expect(value()[0].runs).toEqual([{ kind: "text", text: "Colour me", color: "#ff0000", highlight: "#ffff80" }]);
    editor.update(() => {
      const root = $getRoot();
      root.select(0, root.getChildrenSize());
      $setRunColor(null);
    }, { discrete: true });
    expect(value()[0].runs).toEqual([{ kind: "text", text: "Colour me", highlight: "#ffff80" }]);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(value()[0].runs).toEqual([{ kind: "text", text: "Colour me", color: "#ff0000", highlight: "#ffff80" }]);
  });
});

describe("TextView", () => {
  it("renders formats with the shared classes and semantic elements, math through the math renderer", () => {
    const { container } = render(<TextView paragraphs={VALUE} width={400} />);
    const root = container.querySelector(".text-region")!;
    expect(root.querySelectorAll("p.tx-p")).toHaveLength(3);
    expect(root.querySelector(".tx-b")?.textContent).toBe("important");
    expect(root.querySelector("sup")?.textContent).toBe("2");
    expect(root.querySelector("sub")?.textContent).toBe("Second ");
    expect((root.querySelector(".tx-i.tx-u") as HTMLElement).style.fontSize).toBe("24px");
    expect((root.querySelector(".tx-i.tx-u") as HTMLElement).style.lineHeight).toBe("30px");
    expect(root.querySelector(".math.tx-math")).not.toBeNull();
    expect(root.querySelector(".tx-bad")?.textContent).toBe("x +");
  });

  it("draws the style and the alignment of every paragraph", () => {
    const value: RichText = [
      { style: "heading1", runs: [{ kind: "text", text: "Chapter 1" }] },
      { align: "center", runs: [{ kind: "text", text: "Centred" }] },
      { style: "subtitle", align: "justify", runs: [{ kind: "text", text: "Both" }] },
      { runs: [] },
    ];
    const { container } = render(<TextView paragraphs={value} width={400} />);
    const paragraphs = [...container.querySelectorAll<HTMLElement>("p.tx-p")];
    expect(paragraphs.map((p) => [p.dataset.style, p.dataset.align, p.style.textAlign])).toEqual([
      ["heading1", "left", "left"],
      [undefined, "center", "center"],
      ["subtitle", "justify", "justify"],
      [undefined, "left", "left"],
    ]);
    expect([paragraphs[0].style.fontSize, paragraphs[0].style.fontWeight, paragraphs[0].style.lineHeight]).toEqual([
      "21.333px",
      "700",
      "27px",
    ]);
    expect(paragraphs[2].style.fontSize).toBe("24px");
    // the paragraph CSS is the one the editor's own paragraph carries (the same helper)
    expect(paragraphs[1].getAttribute("style")).toContain("text-align: center");
  });

  it("draws a sum with a free lower slot and the := glyph as typed, without error", () => {
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const ident = (text: string) => ({ type: "Ident", name: name(text) });
    const sum = {
      type: "ExprRegion",
      expr: {
        type: "Sum",
        var: { name: name("") },
        index: { type: "Factorial", expr: ident("j") },
        bounds: { lo: ident("k"), hi: { type: "Placeholder" }, glyph: "define" },
        body: ident("j"),
      },
    };
    const paragraphs: RichText = [{ runs: [{ kind: "math", text: "∑[j! := k..□] j", statement: sum }] }];
    const { container } = render(<TextView paragraphs={paragraphs} width={400} />);
    expect(container.querySelector(".tx-bad")).toBeNull();
    const shown = container.querySelector(".bigop-lower")?.textContent ?? "";
    expect(shown).toContain("j");
    expect(shown).toContain("!");
    expect(shown).toContain(":=");
    expect(shown).toContain("k");
  });

  it("draws the result of an inline run after its operator, indexed over every math run", () => {
    const eval_ = { type: "Evaluate", expr: id("a"), unit: null };
    const paragraphs: RichText = [
      {
        runs: [
          { kind: "math", text: "a/b", statement: ratio },
          { kind: "text", text: " then " },
          { kind: "math", text: "a =", statement: eval_ },
        ],
      },
    ];
    const asked: number[] = [];
    const { container } = render(
      <TextView
        paragraphs={paragraphs}
        width={400}
        inlineResult={(index) => {
          asked.push(index);
          return <span data-testid="inline-result">{`r${index}`}</span>;
        }}
      />,
    );
    expect(asked).toEqual([0, 1]);
    const shown = container.querySelectorAll('[data-testid="inline-result"]');
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toBe("r1");
  });
});

describe("InlineMath", () => {
  it("draws no result for a run that the committed text did not have", () => {
    const asked = vi.fn((index: number) => <span data-testid="result">{`r${index}`}</span>);
    const env = { mathTarget: null, clipboard: null, inlineResult: asked };
    const props = {
      tree: toEditing({ type: "Evaluate", expr: id("a"), unit: null }),
      autoFocus: false,
      onTree: () => undefined,
      onLeave: () => undefined,
      onEmpty: () => undefined,
      onFocused: () => undefined,
    };
    // A run inserted while editing, or whose math changed, has no index: no result is drawn for it.
    const { container, rerender } = render(
      <TextEnvContext.Provider value={env}>
        <InlineMath {...props} resultIndex={null} />
      </TextEnvContext.Provider>,
    );
    expect(asked).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid=result]")).toBeNull();
    // With the index it had in the committed text, the same run draws its result.
    rerender(
      <TextEnvContext.Provider value={env}>
        <InlineMath {...props} resultIndex={0} />
      </TextEnvContext.Provider>,
    );
    expect(asked).toHaveBeenCalledWith(0, props.tree);
    expect(container.querySelector("[data-testid=result]")?.textContent).toBe("r0");
  });

  it("reports its own history for quick-access Undo and Redo while it is edited", async () => {
    let active: InlineActive | null = null;
    const onTree = vi.fn();
    const env = { mathTarget: null, clipboard: null, onInline: (next: InlineActive | null) => { active = next; } };
    const { getByTestId } = render(
      <TextEnvContext.Provider value={env}>
        <InlineMath tree={toEditing({ type: "ExprRegion", expr: id("a") })} autoFocus onTree={onTree} onLeave={() => undefined} onEmpty={() => undefined} onFocused={() => undefined} />
      </TextEnvContext.Provider>,
    );
    await waitFor(() => expect(active).not.toBeNull());
    expect([active!.canUndo, active!.canRedo]).toEqual([false, false]);
    const math = getByTestId("inline-math");
    await act(async () => { fireEvent.keyDown(math, { key: "b", code: "KeyB" }); });
    await waitFor(() => expect(active!.canUndo).toBe(true));
    const typed = onTree.mock.calls.at(-1)![0];
    await act(async () => active!.undo());
    await waitFor(() => expect(active!.canRedo).toBe(true));
    expect(onTree.mock.calls.at(-1)![0]).not.toBe(typed);
    await act(async () => active!.redo());
    await waitFor(() => expect(active!.canRedo).toBe(false));
  });
});

/**
 * Renders the editor with a value and hands back the current value, the handle and the format state. It opens
 * with the caret at the start of the text, which is a real selection in the editor (jsdom has no caret range
 * from a point); the commands act on the paragraph of that caret.
 */
function openEditor(initial: RichText, onChange = vi.fn(), onFormat = vi.fn(), clipboard: MathClipboard | null = null) {
  const state: { handle: TextHandle | null; value: RichText } = { handle: null, value: initial };
  const view = render(
    <TextEditor
      initial={initial}
      point={null}
      atStart
      onReady={() => undefined}
      onChange={(value) => {
        state.value = value;
        onChange(value);
      }}
      onLeave={() => undefined}
      onHandle={(handle) => {
        state.handle = handle;
      }}
      onFormat={onFormat}
      mathTarget={{ current: null }}
      clipboard={clipboard}
      width={400}
    />,
  );
  return { ...view, state, onChange, onFormat };
}

describe("TextEditor", () => {
  it("copies selected plain text through the WebKit clipboard event and async clipboard API", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const { container } = openEditor([{ runs: [{ kind: "text", text: "Copy this text" }] }]);
      const root = container.querySelector<HTMLElement>("[contenteditable=true]")!;
      const editor = getNearestEditorFromDOMNode(root)!;
      await waitFor(() => expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe("Copy this text"));
      await act(async () => {
        editor.update(() => {
          const text = $getRoot().getFirstDescendant();
          if ($isTextNode(text)) text.select(0, text.getTextContentSize());
        });
      });
      expect(editor.getEditorState().read(() => {
        const selection = $getSelection();
        return $isRangeSelection(selection) ? [selection.isCollapsed(), selection.getTextContent()] : null;
      })).toEqual([false, "Copy this text"]);
      const setData = vi.fn();
      const scope = globalThis as unknown as { ClipboardEvent?: unknown };
      scope.ClipboardEvent ??= class extends Event {};
      const ClipboardEventConstructor = scope.ClipboardEvent as new (type: string, init: EventInit) => Event;
      const event = new ClipboardEventConstructor("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { setData } });
      await act(async () => { editor.dispatchCommand(COPY_COMMAND, event as ClipboardEvent); });
      expect(event.defaultPrevented).toBe(true);
      expect(setData).toHaveBeenCalledWith("text/plain", "Copy this text");
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("Copy this text"));
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("pastes plain clipboard text through a keyboard gesture", async () => {
    const { state, container } = openEditor([{ runs: [{ kind: "text", text: "Before " }] }]);
    const root = container.querySelector<HTMLElement>("[contenteditable=true]")!;
    fireEvent.keyDown(root, { key: "v", code: "KeyV", ctrlKey: true });
    const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-hidden="true"]');
    expect(box).not.toBeNull();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "PASTE_OK" } });
    await act(async () => { box!.dispatchEvent(event); });
    await waitFor(() => expect(state.value[0].runs.some((run) => run.kind === "text" && run.text.includes("PASTE_OK"))).toBe(true));
  });

  it("reports edits to math at the end of a text block", async () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<TextEditor initial={[{ runs: [{ kind: "text", text: "Text " }, { kind: "math", text: "", statement: { type: "ExprRegion", expr: id("x") } }] }]} point={null} onReady={() => undefined} onChange={onChange} onLeave={() => undefined} onHandle={() => undefined} onFormat={() => undefined} mathTarget={{ current: null }} clipboard={null} width={400} />);
    const math = getByTestId("inline-math");
    act(() => { math.focus(); fireEvent.keyDown(math, { key: "y", code: "KeyY" }); });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const value = onChange.mock.calls.at(-1)?.[0] as RichText;
    expect(value[0].runs.at(-1)).toMatchObject({ kind: "math", statement: { type: "ExprRegion", expr: id("xy") } });
    act(() => math.blur());
  });

  it("draws the results of the idle inline math of an open region, by committed index", async () => {
    const evaluate = { type: "Evaluate", expr: id("a"), unit: null };
    const value: RichText = [
      {
        runs: [
          { kind: "text", text: "The ratio " },
          { kind: "math", text: "a/b", statement: ratio },
          { kind: "text", text: " is " },
          { kind: "math", text: "a =", statement: evaluate },
        ],
      },
    ];
    const asked: number[] = [];
    const { container } = render(
      <TextEditor
        initial={value}
        point={null}
        onReady={() => undefined}
        onChange={() => undefined}
        onLeave={() => undefined}
        onHandle={() => undefined}
        onFormat={() => undefined}
        mathTarget={{ current: null }}
        clipboard={null}
        width={400}
        inlineResult={(index) => {
          asked.push(index);
          return <span data-testid="inline-result">{`r${index}`}</span>;
        }}
      />,
    );
    // Every idle run is asked for the result of the position it had in the committed text.
    expect(asked).toEqual([0, 1]);
    // A bare expression draws no result: only the evaluation keeps the slot.
    const results = () => [...container.querySelectorAll('[data-testid="inline-result"]')].map((node) => node.textContent);
    expect(results()).toEqual(["r1"]);
    // The math being typed into has no result from the last text: it comes with the next commit.
    const math = container.querySelectorAll<HTMLElement>('[data-testid="inline-math"]')[1];
    act(() => {
      math.focus();
      fireEvent.keyDown(math, { key: "y", code: "KeyY" });
    });
    await waitFor(() => expect(results()).toEqual([]));
    act(() => math.blur());
  });

  it("mounts without effect errors, reports its baseline, offers a handle and unmounts cleanly", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ready = vi.fn();
    const handle = vi.fn<(h: TextHandle | null) => void>();
    const mathTarget = createRef<MathTarget | null>() as { current: MathTarget | null };
    const { container, unmount } = render(
      <StrictMode>
      <TextEditor
        initial={VALUE}
        point={null}
        onReady={ready}
        onChange={() => undefined}
        onLeave={() => undefined}
        onHandle={handle}
        onFormat={() => undefined}
        mathTarget={mathTarget}
        clipboard={null}
        width={400}
      />
      </StrictMode>,
    );
    const editor = container.querySelector("[data-testid=text-editor]");
    expect(editor?.getAttribute("contenteditable")).toBe("true");
    expect(editor?.querySelectorAll("p")).toHaveLength(3);
    act(() => undefined);
    expect(ready).toHaveBeenCalled();
    expect(sameText(ready.mock.calls[0][0], VALUE)).toBe(true);
    expect(handle.mock.calls.at(-1)?.[0]).not.toBeNull();
    unmount();
    expect(handle.mock.calls.at(-1)?.[0]).toBeNull();
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([]);
    errors.mockRestore();
  });

  it("sets a paragraph style through the handle and draws it with the style's CSS", async () => {
    const { state, container } = openEditor([
      { runs: [{ kind: "text", text: "First paragraph" }] },
      { runs: [{ kind: "text", text: "Second paragraph" }] },
    ]);
    const paragraphs = () => [...container.querySelectorAll<HTMLElement>("p")];
    // The editor opens with the caret at the end of its text (the last paragraph).
    await act(async () => state.handle!.setParagraphStyle("heading1"));
    expect(paragraphs()[1].dataset.style).toBe("heading1");
    expect(paragraphs()[1].style.fontSize).toBe("21.333px");
    expect(paragraphs()[1].style.fontWeight).toBe("700");
    expect(paragraphs()[0].style.fontSize).toBe("13.333px");
    expect(state.value.at(-1)).toMatchObject({ style: "heading1" });
  });

  it("sets an alignment through the handle and draws it with text-align", async () => {
    const { state, container } = openEditor([{ runs: [{ kind: "text", text: "Centred paragraph" }] }]);
    const paragraph = () => container.querySelector<HTMLElement>("p")!;
    await act(async () => state.handle!.setAlign("center"));
    expect(paragraph().dataset.align).toBe("center");
    expect(paragraph().style.textAlign).toBe("center");
    expect(state.value[0]).toMatchObject({ align: "center" });
  });

  it("pastes math copied from a math editor as an inline math region", async () => {
    // jsdom has no DragEvent or ClipboardEvent, which Lexical's own paste handler looks up.
    const scope = globalThis as unknown as { DragEvent?: unknown; ClipboardEvent?: unknown };
    scope.DragEvent ??= class extends Event {};
    scope.ClipboardEvent ??= class extends Event {};
    const tree = toEditing({ type: "ExprRegion", expr: id("x") });
    const clipboard = { statement: async (source: string) => (source === "x" ? tree : null) } as unknown as MathClipboard;
    const onChange = vi.fn();
    const { state, container } = openEditor([{ runs: [{ kind: "text", text: "Load " }] }], onChange, vi.fn(), clipboard);
    await act(async () => state.handle!.focus());
    const root = container.querySelector<HTMLElement>("[contenteditable=true]")!;
    const paste = async (text: string) => {
      await act(async () => {
        fireEvent.paste(root, { clipboardData: { getData: () => text, types: ["text/plain"] } });
      });
    };
    // Exactly what a math editor copied: an inline math region at the caret. (Other text takes
    // Lexical's own paste, which jsdom cannot run; `mathOfPaste` covers the choice, mathPaste.test.)
    rememberMathCopy("x");
    await paste("x");
    await waitFor(() => expect(container.querySelectorAll("[data-testid=inline-math]").length).toBe(1));
    await waitFor(() => expect(state.value[0].runs.some((run) => run.kind === "math")).toBe(true));
    // The caret was at the start of the block: the math goes there and the text stays after it.
    expect(state.value[0].runs[0]).toMatchObject({ kind: "math", statement: { type: "ExprRegion" } });
    expect(state.value[0].runs.some((run) => run.kind === "text" && run.text.includes("Load"))).toBe(true);
  });

  describe("deleting inline math with the keyboard", () => {
    const value = (): RichText => [{ runs: [{ kind: "text", text: "ab " }, { kind: "math", text: "x", statement: { type: "ExprRegion", expr: id("x") } }, { kind: "text", text: " cd" }] }];
    const shape = (v: RichText) => v[0].runs.map((run) => (run.kind === "math" ? "[math]" : run.text)).join("");
    // The caret is in the text, next to the math: `before` puts it right before the math, else right after it.
    const open = async (before: boolean) => {
      const { state, container } = openEditor(value());
      const root = container.querySelector<HTMLElement>("[contenteditable=true]")!;
      const editor = getNearestEditorFromDOMNode(root)!;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      await act(async () => {
        editor.update(() => {
          const math = $getRoot().getFirstDescendant()?.getNextSibling();
          if (!(math instanceof MathNode)) throw new Error("no math");
          if (before) math.selectPrevious();
          else math.selectNext(0, 0);
        });
      });
      return { state, root, editor };
    };
    const press = async (root: HTMLElement, key: string) => {
      await act(async () => { fireEvent.keyDown(root, { key, code: key }); });
    };

    beforeAll(() => {
      const range = Range.prototype as unknown as Record<string, unknown>;
      range.getBoundingClientRect ??= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
      range.getClientRects ??= () => [];
    });

    it("Backspace right after inline math deletes it", async () => {
      const { state, root } = await open(false);
      await press(root, "Backspace");
      await waitFor(() => expect(shape(state.value)).toBe("ab  cd"));
    });

    it("Delete right before inline math deletes it", async () => {
      const { state, root } = await open(true);
      await press(root, "Delete");
      await waitFor(() => expect(shape(state.value)).toBe("ab  cd"));
    });

    it("is one undo step", async () => {
      const { state, root, editor } = await open(false);
      await press(root, "Backspace");
      await waitFor(() => expect(shape(state.value)).toBe("ab  cd"));
      await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
      await waitFor(() => expect(shape(state.value)).toBe("ab [math] cd"));
    });

    it("deletes inline math that is alone in its paragraph", async () => {
      const { state, container } = openEditor([{ runs: [{ kind: "math", text: "x", statement: { type: "ExprRegion", expr: id("x") } }] }]);
      const root = container.querySelector<HTMLElement>("[contenteditable=true]")!;
      const editor = getNearestEditorFromDOMNode(root)!;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      await act(async () => { editor.update(() => $getRoot().selectEnd()); });
      await press(root, "Backspace");
      await waitFor(() => expect(state.value[0].runs.some((run) => run.kind === "math")).toBe(false));
    });
  });

  describe("crossing inline math with the arrows", () => {
    const value = (): RichText => [{ runs: [{ kind: "text", text: "ab " }, { kind: "math", text: "xy", statement: { type: "ExprRegion", expr: id("xy") } }, { kind: "text", text: " cd" }] }];
    const open = async (before: boolean) => {
      const { container } = openEditor(value());
      const root = container.querySelector<HTMLElement>("[contenteditable=true]")!;
      const editor = getNearestEditorFromDOMNode(root)!;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      await act(async () => {
        editor.update(() => {
          const math = $getRoot().getFirstDescendant()?.getNextSibling();
          if (!(math instanceof MathNode)) throw new Error("no math");
          if (before) math.selectPrevious();
          else math.selectNext(0, 0);
        });
      });
      // The browser's caret, where the arrow decides (jsdom does not move it with Lexical's selection).
      const texts = root.querySelectorAll("[data-lexical-text]");
      const text = (before ? texts[0] : texts[1]).firstChild as Text;
      window.getSelection()!.collapse(text, before ? text.data.length : 0);
      const math = container.querySelector<HTMLElement>("[data-testid=inline-math]")!;
      return { root, editor, math };
    };
    const press = async (target: HTMLElement, key: string) => {
      await act(async () => { fireEvent.keyDown(target, { key, code: key }); });
    };
    // The text and the offset of the text editor's caret.
    const caret = (editor: ReturnType<typeof getNearestEditorFromDOMNode>) =>
      editor!.getEditorState().read(() => {
        const selection = $getSelection();
        return $isRangeSelection(selection) ? [selection.anchor.getNode().getTextContent(), selection.anchor.offset] : null;
      });
    // Arrows inside the math until it lets the keyboard go (at most `limit` presses).
    const walk = async (math: HTMLElement, key: string, limit = 8) => {
      for (let i = 0; i < limit && math.classList.contains("editing"); i++) await press(math, key);
    };

    beforeAll(() => {
      const range = Range.prototype as unknown as Record<string, unknown>;
      range.getBoundingClientRect ??= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
      range.getClientRects ??= () => [];
    });

    it("Right enters at the start, walks through and leaves to the text after", async () => {
      const { root, editor, math } = await open(true);
      await press(root, "ArrowRight");
      await waitFor(() => expect(math.classList.contains("editing")).toBe(true));
      expect(document.activeElement).toBe(math);
      await walk(math, "ArrowRight");
      await waitFor(() => expect(math.classList.contains("editing")).toBe(false));
      await waitFor(() => expect(caret(editor)).toEqual([" cd", 0]));
    });

    it("Left enters at the end: one more Left at the start leaves to the text before", async () => {
      const { root, editor, math } = await open(false);
      await press(root, "ArrowLeft");
      await waitFor(() => expect(math.classList.contains("editing")).toBe(true));
      await walk(math, "ArrowLeft");
      await waitFor(() => expect(caret(editor)).toEqual(["ab ", 3]));
    });

    it("a click on the math of a closed text opens the text with the math editing", async () => {
      const elementFromPoint = document.elementFromPoint;
      document.elementFromPoint = () => document.querySelector("[data-testid=inline-math] .math, [data-testid=inline-math]");
      try {
        const { container } = render(
          <TextEditor initial={value()} point={{ x: 5, y: 5 }} onReady={() => undefined} onChange={() => undefined} onLeave={() => undefined} onHandle={() => undefined} onFormat={() => undefined} mathTarget={{ current: null }} clipboard={null} width={400} />,
        );
        const math = await waitFor(() => container.querySelector<HTMLElement>("[data-testid=inline-math]")!);
        await waitFor(() => expect(math.classList.contains("editing")).toBe(true));
        expect(document.activeElement).toBe(math);
      } finally {
        document.elementFromPoint = elementFromPoint;
      }
    });

    it("enters at the near edge: from the left, one Left leaves again", async () => {
      const { root, editor, math } = await open(true);
      await press(root, "ArrowRight");
      await waitFor(() => expect(math.classList.contains("editing")).toBe(true));
      await press(math, "ArrowLeft");
      await waitFor(() => expect(math.classList.contains("editing")).toBe(false));
      await waitFor(() => expect(caret(editor)).toEqual(["ab ", 3]));
    });
  });

  describe("pasting at the caret", () => {
    const tree = toEditing({ type: "ExprRegion", expr: id("x") });
    const clipboard = { statement: async (source: string) => (source === "x" ? tree : null) } as unknown as MathClipboard;
    // jsdom has no layout: Lexical measures the caret range when it moves the DOM selection.
    beforeAll(() => {
      const range = Range.prototype as unknown as Record<string, unknown>;
      range.getBoundingClientRect ??= () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
      range.getClientRects ??= () => [];
    });
    const where = [{ at: "the start", offset: 0, before: "", after: "Hello world" }, { at: "the middle", offset: 5, before: "Hello", after: " world" }, { at: "the end", offset: 11, before: "Hello world", after: "" }];
    // Pastes "x" (copied from a math editor) with the caret at `offset` of paragraph `index`, the way a key
    // press does: the browser puts the caret at the start of the editable when the focus comes back from the
    // hidden box that reads the clipboard.
    const pasteAt = async (index: number, offset: number, replace = 0) => {
      const { state, container } = openEditor([{ runs: [{ kind: "text", text: "First line" }] }, { runs: [{ kind: "text", text: "Hello world" }] }], vi.fn(), vi.fn(), clipboard);
      const root = container.querySelector<HTMLElement>("[contenteditable=true]")!;
      const editor = getNearestEditorFromDOMNode(root)!;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      await act(async () => {
        editor.update(() => {
          const text = ($getRoot().getChildren()[index] as ElementNode).getFirstChild();
          if ($isTextNode(text)) text.select(offset, offset + replace);
        });
      });
      rememberMathCopy("x");
      fireEvent.keyDown(root, { key: "v", code: "KeyV", ctrlKey: true });
      const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-hidden="true"]')!;
      await act(async () => {
        editor.update(() => $getRoot().selectStart());
      });
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: () => "x" } });
      await act(async () => {
        box.dispatchEvent(event);
      });
      await waitFor(() => expect(state.value.flatMap((p) => p.runs).some((run) => run.kind === "math")).toBe(true));
      return { state, editor };
    };
    const texts = (paragraph: RichText[number]) => {
      const out: string[] = [];
      for (const run of paragraph.runs) out.push(run.kind === "math" ? "[math]" : run.text);
      return out.join("");
    };

    for (const { at, offset, before, after } of where) {
      it(`inserts the math at ${at} of a paragraph, not at the start of the region`, async () => {
        const { state } = await pasteAt(1, offset);
        expect(texts(state.value[0])).toBe("First line");
        expect(texts(state.value[1])).toBe(`${before}[math]${after}`);
      });
    }

    it("replaces the selected text with the math and leaves the caret right after it", async () => {
      const { state, editor } = await pasteAt(1, 5, 6);
      expect(texts(state.value[1])).toBe("Hello[math]");
      expect(editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return "no caret";
        const node = selection.anchor.getNode();
        const top = node.getTopLevelElement();
        const end = $isElementNode(node) ? selection.anchor.offset === node.getChildrenSize() : selection.anchor.offset === node.getTextContentSize();
        return [top?.getIndexWithinParent(), end];
      })).toEqual([1, true]);
    });

    it("is one undo step", async () => {
      const { state, editor } = await pasteAt(1, 5);
      await act(async () => {
        editor.dispatchCommand(UNDO_COMMAND, undefined);
      });
      expect(texts(state.value[1])).toBe("Hello world");
    });
  });

  it("reports the style and the alignment of the paragraph at the selection for the Text tab", async () => {
    const onFormat = vi.fn();
    const { state } = openEditor([{ style: "heading2", align: "right", runs: [{ kind: "text", text: "A heading" }] }], vi.fn(), onFormat);
    await act(async () => state.handle!.focus());
    expect(onFormat.mock.calls.at(-1)?.[0]).toMatchObject({ style: "heading2", align: "right" });
  });

});
