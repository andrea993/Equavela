// The code of a Julia block as the page draws it:
// a small tokenizer of our own for the syntax colours, and the `using` / `import` lines the header
// shows while the code is being typed. The core derives the stored fields with the same rules
// (`core/src/julia_code.rs`, `declarations`).

export type JuliaTokenKind = "keyword" | "string" | "comment" | "number" | "plain";
export type JuliaToken = { kind: JuliaTokenKind; text: string };

const KEYWORDS = new Set([
  "abstract", "baremodule", "begin", "break", "catch", "const", "continue", "do", "else", "elseif",
  "end", "export", "false", "finally", "for", "function", "global", "if", "import", "in", "let",
  "local", "macro", "module", "mutable", "nothing", "primitive", "quote", "return", "struct",
  "true", "try", "type", "using", "where", "while",
]);

const IDENT = /[A-Za-z_ -￿][A-Za-z0-9_! -￿]*/y;
const NUMBER = /(?:0x[0-9a-fA-F_]+|0b[01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?(?:im)?)/y;

/** Splits `code` into tokens whose texts, joined, give `code` back exactly. */
export function tokenizeJulia(code: string): JuliaToken[] {
  const tokens: JuliaToken[] = [];
  const push = (kind: JuliaTokenKind, text: string) => {
    if (text === "") return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && kind === "plain") last.text += text;
    else tokens.push({ kind, text });
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    if (rest.startsWith("#=")) {
      const end = code.indexOf("=#", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      push("comment", code.slice(i, stop));
      i = stop;
    } else if (code[i] === "#") {
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? code.length : end;
      push("comment", code.slice(i, stop));
      i = stop;
    } else if (rest.startsWith('"""')) {
      const end = code.indexOf('"""', i + 3);
      const stop = end < 0 ? code.length : end + 3;
      push("string", code.slice(i, stop));
      i = stop;
    } else if (code[i] === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"' && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      const stop = Math.min(code[j] === '"' ? j + 1 : j, code.length);
      push("string", code.slice(i, stop));
      i = stop;
    } else if (/[A-Za-z_ -￿]/.test(code[i])) {
      IDENT.lastIndex = i;
      const word = IDENT.exec(code)![0];
      push(KEYWORDS.has(word) ? "keyword" : "plain", word);
      i += word.length;
    } else if (/[0-9]/.test(code[i]) || (code[i] === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      NUMBER.lastIndex = i;
      const number = NUMBER.exec(code)?.[0] || code[i];
      push("number", number);
      i += number.length;
    } else {
      push("plain", code[i]);
      i += 1;
    }
  }
  return tokens;
}

export type JuliaHeader = {
  using: string[];
  imports: { name: string; package: string; function: string }[];
};

const MODULE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const WORKSHEET_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The header of a block whose code is `code`: the modules of the column-0
 * `using A, B` lines and the names of the `import P: f, g` lines, outside comments and strings.
 */
export function juliaHeader(code: string): JuliaHeader {
  const using: string[] = [];
  const imports: JuliaHeader["imports"] = [];
  let inBlock = false;
  for (const line of code.split("\n")) {
    if (inBlock) {
      if (line.includes("=#")) inBlock = false;
      continue;
    }
    if (line.startsWith("#=") && !line.includes("=#", 2)) {
      inBlock = true;
      continue;
    }
    const body = line.replace(/#.*$/, "").trimEnd();
    const usingLine = /^using\s+(.+)$/.exec(body);
    if (usingLine && !usingLine[1].includes(":")) {
      for (const item of usingLine[1].split(",").map((part) => part.trim())) {
        if (MODULE_PATH.test(item) && !using.includes(item)) using.push(item);
      }
      continue;
    }
    const importLine = /^import\s+([^:\s]+)\s*:\s*(.+)$/.exec(body);
    if (importLine && MODULE_PATH.test(importLine[1])) {
      for (const name of importLine[2].split(",").map((part) => part.trim())) {
        if (WORKSHEET_NAME.test(name) && !imports.some((item) => item.name === name)) {
          imports.push({ name, package: importLine[1], function: name });
        }
      }
    }
  }
  return { using, imports };
}
