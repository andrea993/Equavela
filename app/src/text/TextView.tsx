// Read-only render of a text region: what the page shows when the region is not being
// edited and what is printed. It is styled by the same
// stylesheet as the editor (`styles/text.css`: semantic `sup` / `sub` elements and the classes
// `tx-b`, `tx-i`, `tx-u`), which is what makes the idle editor pixel-identical to it.

import { Fragment, type ReactNode } from "react";
import { MathStatement } from "../math/render";
import { toEditing } from "../editor/tree";
import { mathFontOf, mathFontStyle } from "../math/font";
import type { RichRun, RichText } from "../equavelaApi";
import { paragraphStyle, runStyle, textWidthStyle, type InlineResult, type TextWidth } from "./value";

export function runClass(run: { bold?: boolean; italic?: boolean; underline?: boolean }): string | undefined {
  const classes = [run.bold && "tx-b", run.italic && "tx-i", run.underline && "tx-u"].filter(Boolean);
  return classes.length ? classes.join(" ") : undefined;
}

/** Inline math: the statement drawn by the math renderer, or its text when it does not parse. */
export function InlineMathView({
  statement,
  text,
  result,
  index,
  disabled = false,
  format,
}: {
  statement: unknown;
  text: string;
  result?: ReactNode;
  index?: number;
  /** The run is disabled; `format` carries its math font. */
  disabled?: boolean;
  format?: Record<string, string>;
}): ReactNode {
  if (statement === null || statement === undefined) {
    return (
      <span className={`tx-math tx-bad${disabled ? " tx-disabled" : ""}`} data-testid="inline-math-bad">
        {text}
      </span>
    );
  }
  return (
    <span
      className={`math tx-math${disabled ? " tx-disabled" : ""}`}
      style={format ? mathFontStyle(mathFontOf(format)) : undefined}
      data-testid="inline-math"
      data-inline-index={index}
    >
      <MathStatement statement={toEditing(statement) as never} result={result} path={[]} />
    </span>
  );
}

function Run({ run, result, index }: { run: RichRun; result?: ReactNode; index?: number }): ReactNode {
  if (run.kind === "math") {
    return <InlineMathView statement={run.statement} text={run.text} result={result} index={index} disabled={run.disabled} format={run.format} />;
  }
  let node: ReactNode = run.text;
  if (run.sub) node = <sub>{node}</sub>;
  if (run.sup) node = <sup>{node}</sup>;
  return (
    <span className={runClass(run)} style={runStyle(run)}>
      {node}
    </span>
  );
}

export function TextView({
  paragraphs,
  width,
  background,
  inlineResult,
}: {
  paragraphs: RichText;
  width: TextWidth;
  /** The fill of the whole region as #rrggbb. */
  background?: string;
  inlineResult?: InlineResult;
}) {
  // The index of a math run counts every math run of the text, in reading order.
  let mathIndex = 0;
  return (
    <div className="tx-root text-region" style={textWidthStyle(width, background)} data-testid="text-view">
      {paragraphs.map((paragraph, i) => (
        // The paragraph's style and alignment are drawn by the same CSS helper the editor uses, so the
        // page and the print are one picture.
        <p
          key={i}
          className="tx-p"
          style={paragraphStyle(paragraph.style, paragraph.align)}
          data-style={paragraph.style && paragraph.style !== "normal" ? paragraph.style : undefined}
          data-align={paragraph.align ?? "left"}
        >
          {paragraph.runs.length === 0 ? (
            <br />
          ) : (
            paragraph.runs.map((run, j) => {
              // The renderer wants the editing form; the editor that is open on the region has it already
              //.
              const result = run.kind === "math" ? inlineResult?.(mathIndex, toEditing(run.statement), run.format) : undefined;
              const index = run.kind === "math" ? mathIndex++ : undefined;
              return (
                <Fragment key={j}>
                  <Run run={run} result={result} index={index} />
                </Fragment>
              );
            })
          )}
        </p>
      ))}
    </div>
  );
}
