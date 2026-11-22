// The spell checker of the text regions.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpellingDialog, languageLabel } from "../components/SpellingDialog";
import type { RichText } from "../equavelaApi";
import { SpellCache } from "./checker";
import { misspeltWords, occurrenceOf } from "./highlight";
import { replaceOccurrence } from "./rewrite";
import { ignoreList, tokenize, withIgnored } from "./tokenize";

afterEach(cleanup);

describe("the words of the prose", () => {
  it("keeps apostrophes and hyphens inside a word and skips numbers and addresses", () => {
    const words = tokenize("L'altro well-known beam, 2nd x1 doesn’t a@b.it www.example.com").map((t) => t.word);
    expect(words).toEqual(["L'altro", "well-known", "beam", "doesn’t"]);
    const [first] = tokenize("  beam");
    expect([first.start, first.end]).toEqual([2, 6]);
  });

  it("stores the ignore list sorted, one space between words", () => {
    expect([...ignoreList(" Navier  Stokes ")]).toEqual(["Navier", "Stokes"]);
    expect(withIgnored("Stokes", "Navier")).toBe("Navier Stokes");
    expect(withIgnored(undefined, "teh")).toBe("teh");
  });
});

describe("the cache of checks", () => {
  it("asks for a batch once, answers later, and marks a missing dictionary as unchecked", async () => {
    const check = vi.fn(async (language: string, words: string[]) =>
      language === "it_IT" ? { available: false, correct: words.map(() => true) } : { available: true, correct: words.map((w) => w !== "teh") },
    );
    const cache = new SpellCache(check, 0);
    const heard = vi.fn();
    cache.subscribe(heard);
    expect(cache.status("en_US", "teh")).toBeUndefined();
    expect(cache.status("en_US", "the")).toBeUndefined();
    cache.status("it_IT", "perche");
    await waitFor(() => expect(heard).toHaveBeenCalled());
    expect(check).toHaveBeenCalledWith("en_US", ["teh", "the"]);
    expect(cache.status("en_US", "teh")).toBe(false);
    expect(cache.status("en_US", "the")).toBe(true);
    expect(cache.status("it_IT", "perche")).toBe(true);
    expect(cache.isUnavailable("it_IT")).toBe(true);
    cache.accept("teh");
    expect(cache.status("en_US", "teh")).toBe(true);
  });

  it("asks again for the wrong words once a word is added: it can make them right", async () => {
    const added = new Set<string>();
    const check = vi.fn(async (_: string, words: string[]) => ({
      available: true,
      correct: words.map((w) => added.has(w.replace(/^dell'/, ""))),
    }));
    const cache = new SpellCache(check, 0);
    const heard = vi.fn();
    cache.subscribe(heard);
    cache.status("it_IT", "dell'inverter");
    await waitFor(() => expect(cache.status("it_IT", "dell'inverter")).toBe(false));
    added.add("inverter");
    cache.accept("inverter");
    expect(cache.status("it_IT", "inverter")).toBe(true);
    expect(cache.status("it_IT", "dell'inverter")).toBeUndefined();
    await waitFor(() => expect(cache.status("it_IT", "dell'inverter")).toBe(true));
  });
});

describe("the misspelt words of the page", () => {
  it("reads the prose of text regions only, never inline math or other regions", async () => {
    document.body.innerHTML = `
      <div data-region-id="t1" data-kind="text"><p><span>teh beam teh</span> <span class="math tx-math">teh</span></p></div>
      <div data-region-id="m1" data-kind="math"><span>teh</span></div>`;
    const cache = new SpellCache(async (_l, words) => ({ available: true, correct: words.map((w) => w !== "teh") }), 0);
    const context = { cache, languageOf: () => "en_US", ignore: new Set<string>() };
    misspeltWords(document.body, context);
    await waitFor(() => expect(misspeltWords(document.body, context)).toHaveLength(2));
    const words = misspeltWords(document.body, context);
    expect(words.every((w) => w.regionId === "t1")).toBe(true);
    expect(occurrenceOf(words[1], document.querySelector<HTMLElement>("[data-region-id=t1]")!)).toBe(1);
    expect(misspeltWords(document.body, { ...context, ignore: new Set(["teh"]) })).toHaveLength(0);
  });
});

describe("a correction rewrites one occurrence", () => {
  const text: RichText = [
    { runs: [{ kind: "text", text: "teh beam" }, { kind: "math", text: "teh", statement: null } as never] },
    { runs: [{ kind: "text", text: "and teh span, tehran" }] },
  ];
  it("replaces the k-th whole word in reading order and leaves math and longer words alone", () => {
    const next = replaceOccurrence(text, "teh", 1, "the")!;
    expect(next[0].runs[0]).toEqual({ kind: "text", text: "teh beam" });
    expect(next[1].runs[0]).toEqual({ kind: "text", text: "and the span, tehran" });
    expect(replaceOccurrence(text, "teh", 5, "the")).toBeNull();
  });
});

describe("Spelling…", () => {
  it("names a downloadable language in English and keeps the id when it has no name", () => {
    expect(languageLabel("it_IT")).toBe("Italian (Italy)");
    expect(languageLabel("ca_ES_valencia")).toBe("Catalan (Spain, Valencian)");
    expect(languageLabel("not a tag")).toBe("not a tag");
  });

  it("downloads a dictionary only after the user agreed, then lists it as installed", async () => {
    const list = [
      { id: "en_US", locales: ["en_US"], installed: true, bundled: true },
      { id: "it_IT", locales: ["it_IT", "it_CH"], installed: false, bundled: false },
    ];
    const install = vi.fn(async (id: string) => {
      list.find((l) => l.id === id)!.installed = true;
    });
    const onApply = vi.fn();
    render(
      <SpellingDialog
        worksheetLanguage="en_US"
        regions={{ count: 1, language: null }}
        languages={async () => list.map((l) => ({ ...l }))}
        install={install}
        uninstall={async () => {}}
        license={async () => "licence text"}
        onApply={onApply}
        onInstalled={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("spell-download")).not.toHaveProperty("disabled", true));
    fireEvent.click(screen.getByTestId("spell-download"));
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByTestId("spell-consent").textContent).toMatch(/github\.com\/LibreOffice\/dictionaries/);
    fireEvent.click(screen.getByTestId("spell-consent-yes"));
    await waitFor(() => expect(install).toHaveBeenCalledWith("it_IT"));
    await waitFor(() => expect([...screen.getByTestId("spell-worksheet").querySelectorAll("option")].map((o) => o.value)).toContain("it_IT"));
    fireEvent.change(screen.getByTestId("spell-worksheet"), { target: { value: "it_IT" } });
    fireEvent.change(screen.getByTestId("spell-region"), { target: { value: "en_US" } });
    fireEvent.click(screen.getByTestId("spell-apply"));
    expect(onApply).toHaveBeenCalledWith({ worksheet: "it_IT", region: "en_US" });
  });
});
