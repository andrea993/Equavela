// Replacing one misspelt word in the stored text of a region: the k-th whole-word
// occurrence of the word in the text runs, in reading order. One undo step, as every text edit.

import type { RichText } from "../equavelaApi";
import { tokenize } from "./tokenize";

export function replaceOccurrence(paragraphs: RichText, word: string, occurrence: number, replacement: string): RichText | null {
  let index = 0;
  let done = false;
  const next = paragraphs.map((paragraph) => ({
    ...paragraph,
    runs: paragraph.runs.map((run) => {
      if (done || run.kind !== "text") return run;
      for (const token of tokenize(run.text)) {
        if (token.word !== word) continue;
        if (index === occurrence) {
          done = true;
          return { ...run, text: run.text.slice(0, token.start) + replacement + run.text.slice(token.end) };
        }
        index += 1;
      }
      return run;
    }),
  }));
  return done ? next : null;
}
