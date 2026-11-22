// Copy, cut and paste of sub-expressions in the structural math editor. The clipboard holds the
// canonical linear text: the editor sends the selected node as an AST to Rust, which
// prints it; pasted text is parsed by Rust and comes back as an AST, so the Rust parser and
// printer stay the only authority on the text form. The model functions (`copyKind`, `pasteExpr`,
// `pasteStatement`, `pasteArgs`) are pure and tested on their own.
//
// A run of consecutive call arguments travels as the list of its arguments
// in linear text, `a, b`, through the argument-list calls of the same bridge (`printArgs`,
// `parseArgs`).

import { S } from "../strings";
import {
  copyKind,
  inCallArgument,
  pasteArgs,
  pasteExpr,
  pasteProgramLines,
  pasteStatement,
  runCommand,
  selectedArgs,
  selectedNode,
  selectedProgram,
  type EditorState,
} from "./model";
import { toEditing, toEditingArgs, toWire, toWireArgs, WireError, type Node } from "./tree";

/** The Rust bridge calls the clipboard needs. */
export interface MathIO {
  print(statement: unknown): Promise<string>;
  parse(text: string): Promise<unknown>;
  /** The canonical text of a list of call arguments. */
  printArgs(args: unknown[]): Promise<string>;
  /** The call arguments `text` holds (`a, b`), or a `parse` error. */
  parseArgs(text: string): Promise<unknown[]>;
}

const errorText = (error: unknown) =>
  error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error);

/** The canonical linear text of the selection, or an error message for the user. */
export async function copyMath(io: MathIO, state: EditorState): Promise<{ text: string } | { error: string }> {
  if (state.argSelection) return copyArgs(io, state);
  const kind = copyKind(state);
  if (!kind) return { error: S.clipboard.nothingToCopy };
  const node = selectedNode(state);
  try {
    // Program lines travel as a program holding them, the linear text a program prints.
    const expr = kind === "program" ? selectedProgram(state) : node;
    const wire = toWire(kind === "statement" ? node : ({ type: "ExprRegion", expr } as Node));
    return { text: await io.print(wire) };
  } catch (error) {
    if (error instanceof WireError) return { error: S.clipboard.incomplete(error.message) };
    return { error: S.clipboard.copyFailed(errorText(error)) };
  }
}

/** The text of a run of arguments, or an error message for the user. */
async function copyArgs(io: MathIO, state: EditorState): Promise<{ text: string } | { error: string }> {
  const args = selectedArgs(state);
  if (args.length === 0) return { error: S.clipboard.nothingToCopy };
  try {
    return { text: await io.printArgs(toWireArgs(args)) };
  } catch (error) {
    if (error instanceof WireError) return { error: S.clipboard.incomplete(error.message) };
    return { error: S.clipboard.copyFailed(errorText(error)) };
  }
}

/** The editor after deleting the selection (cut = copy, then this). */
export const cutSelection = (state: EditorState): EditorState => runCommand(state, "backspace");

/** The arguments the pasted text holds, or the message of the parser that refused it. */
async function parseArgList(io: MathIO, text: string): Promise<{ args: Node[] } | { error: string }> {
  try {
    return { args: toEditingArgs(await io.parseArgs(text)) };
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** The editor after pasting `text` at the selection, or an error message for the user. */
export async function pasteMath(
  io: MathIO,
  state: EditorState,
  text: string,
): Promise<{ state: EditorState } | { error: string }> {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return { error: S.clipboard.empty };
  // A run of arguments lands at an argument position: on the arguments of the selected run,
  // or on the argument of a call the caret is in when the text holds more than one argument. One
  // expression keeps the ordinary paste of (into a box, over a selection, into a name).
  const hasRun = state.argSelection !== undefined;
  const inArgument = inCallArgument(state);
  if (hasRun || inArgument) {
    const list = await parseArgList(io, clean);
    if (hasRun || ("args" in list && list.args.length > 1)) {
      if (!("args" in list)) return { error: S.clipboard.notMath(list.error) };
      const next = pasteArgs(state, list.args);
      return next ? { state: next } : { error: S.clipboard.noTarget };
    }
  }
  let tree: Node;
  try {
    tree = toEditing(await io.parse(clean));
  } catch (error) {
    // A list of arguments is no expression: outside a call there is nowhere to put it.
    const list = await parseArgList(io, clean);
    if ("args" in list && list.args.length > 1) return { error: S.clipboard.argumentsNeedCall };
    return { error: S.clipboard.notMath(errorText(error)) };
  }
  // A program pasted on a line of a program brings its lines into it.
  const lines = tree.type === "ExprRegion" && tree.expr.type === "Program" ? pasteProgramLines(state, tree.expr) : null;
  if (lines) return { state: lines };
  const next = tree.type === "ExprRegion" ? pasteExpr(state, tree.expr) : pasteStatement(state, tree);
  return next ? { state: next } : { error: S.clipboard.noTarget };
}
