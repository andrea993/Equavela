// Math on the system clipboard, as a text region needs to tell it from prose.
// The clipboard holds plain text only (`clipboard.ts`), so a text that
// parses as math is not enough: "load" is a name and also a word. A paste becomes an inline math
// region when the text is exactly what the app itself copied from a math editor, or the snippet of
// one math region copied on the sheet; any other text pastes as text.

let lastMathCopy: string | null = null;

/** Remembers the text a math editor just put on the clipboard (copy or cut). */
export function rememberMathCopy(text: string): void {
  lastMathCopy = text;
}

/** The linear text of the one math region a regions snippet holds, else null. */
export function mathOfSnippet(text: string): string | null {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0 || !/^- id: /.test(lines[0]) || lines.filter((line) => /^- id: /.test(line)).length !== 1) return null;
  const math = lines.filter((line) => /^ {2}math: /.test(line));
  if (math.length !== 1 || lines.some((line) => /^ {2}(text|include|julia|plot|image|area|table):/.test(line))) return null;
  try {
    const value: unknown = JSON.parse(math[0].replace(/^ {2}math: /, ""));
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

/** The math a pasted text stands for: what the app copied from a math editor, or one math region. */
export function mathOfPaste(text: string): string | null {
  if (text.trim() === "") return null;
  if (lastMathCopy !== null && text === lastMathCopy) return text;
  return mathOfSnippet(text);
}
