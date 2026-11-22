// The cache of spell checks: a word is asked of the backend once per
// language, in batches, and the answers come back asynchronously, so typing never waits for the
// dictionary. Listeners hear when new answers arrived.

export type CheckWords = (language: string, words: string[]) => Promise<{ available: boolean; correct: boolean[] }>;

export class SpellCache {
  private known = new Map<string, Map<string, boolean>>();
  private pending = new Map<string, Set<string>>();
  private unavailable = new Set<string>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private check: CheckWords, private delayMs = 30) {}

  /** `true` correct, `false` wrong, `undefined` not known yet (it is asked for). */
  status(language: string, word: string): boolean | undefined {
    if (this.unavailable.has(language)) return true;
    const answer = this.known.get(language)?.get(word);
    if (answer !== undefined) return answer;
    let queue = this.pending.get(language);
    if (!queue) this.pending.set(language, (queue = new Set()));
    queue.add(word);
    this.schedule();
    return undefined;
  }

  /** Whether the dictionary of a language is missing (the text is then not checked). */
  isUnavailable(language: string): boolean {
    return this.unavailable.has(language);
  }

  /** A word the user accepted: right in every language from now on. The words found wrong are asked
   *  again, since the new word can make them right too (`dell'inverter`, `inverter-based`). */
  accept(word: string): void {
    for (const answers of this.known.values()) {
      for (const [known, correct] of answers) if (!correct) answers.delete(known);
      answers.set(word, true);
    }
    this.emit();
  }

  /** Forgets everything (a dictionary was installed or removed). */
  clear(): void {
    this.known.clear();
    this.unavailable.clear();
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  private schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  private async flush() {
    const batches = [...this.pending.entries()];
    this.pending.clear();
    for (const [language, words] of batches) {
      const list = [...words];
      try {
        const result = await this.check(language, list);
        if (!result.available) {
          this.unavailable.add(language);
          continue;
        }
        let answers = this.known.get(language);
        if (!answers) this.known.set(language, (answers = new Map()));
        list.forEach((word, index) => answers!.set(word, result.correct[index] ?? true));
      } catch {
        // A failed check leaves the words unknown: they are not underlined.
        this.unavailable.add(language);
      }
    }
    this.emit();
  }
}
