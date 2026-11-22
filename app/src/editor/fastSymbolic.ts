import { allPaths, childRefs, get, type Node } from "./tree";
import type { EditorState } from "./model";

export const FAST_SYMBOLIC = [
  { id: "simplify", key: "s", label: "Simplify", needs: "expression" },
  { id: "expand", key: "e", label: "Expand", needs: "expression" },
  { id: "factor", key: "f", label: "Factor", needs: "expression" },
  { id: "solve", key: "v", label: "Solve", needs: "equation" },
  { id: "collect", key: "c", label: "Collect", needs: "variable" },
  { id: "differentiate", key: "d", label: "Differentiate", needs: "variable" },
  { id: "integrate", key: "i", label: "Integrate", needs: "variable" },
  { id: "partial_fractions", key: "p", label: "Partial Fractions", needs: "variable" },
  { id: "float", key: "n", label: "Float", needs: "expression" },
  { id: "combine", key: "b", label: "Combine", needs: "scalar" },
  { id: "rectangular", key: "r", label: "Rectangular", needs: "scalar" },
  { id: "continued_fraction", key: "q", label: "Continued Fraction", needs: "continued" },
  { id: "coefficients", key: "o", label: "Coefficients", needs: "variable" },
  { id: "series", key: "y", label: "Series", needs: "variable" },
  { id: "laplace", key: "l", label: "Laplace Transform", needs: "variable" },
  { id: "inverse_laplace", key: "u", label: "Inverse Laplace Transform", needs: "variable" },
  { id: "fourier", key: "w", label: "Fourier Transform", needs: "variable" },
  { id: "inverse_fourier", key: "j", label: "Inverse Fourier Transform", needs: "variable" },
  { id: "z_transform", key: "z", label: "Z Transform", needs: "variable" },
  { id: "inverse_z_transform", key: "x", label: "Inverse Z Transform", needs: "variable" },
] as const;

export type FastSymbolicOperation = (typeof FAST_SYMBOLIC)[number]["id"];
export type FastSymbolicOptions = { inPlace: boolean; worksheetVariables: boolean };
export type FastSymbolicVariable = {
  segments: { text: string; subscript: boolean }[];
  label?: string | null;
};
export type FastSymbolicInput = {
  regionId: string | null;
  page: number;
  x: number;
  y: number;
  statement: unknown;
  operation: FastSymbolicOperation;
  variable: FastSymbolicVariable | null;
  worksheetVariables: boolean;
};

function unparen(expr: Node): Node {
  while (expr.type === "Paren") expr = expr.expr;
  return expr;
}

export function fastSymbolicContext(editor: EditorState | null) {
  const root = editor?.root;
  const body = root?.type === "Define" || root?.type === "GlobalDefine" ? 1
    : root?.type === "ExprRegion" || root?.type === "Evaluate" || root?.type === "Symbolic" ? 0 : null;
  const expr = root && body !== null ? unparen(get(root, [body])) : null;
  const expression = !!expr && expr.type !== "Placeholder";
  const equation = expr?.type === "Eq" ||
    (expr?.type === "Matrix" && expr.cells.length > 0 && expr.cells.every((cell: Node) => unparen(cell).type === "Eq"));
  const scalar = !equation && expr?.type !== "Matrix";
  let variable: FastSymbolicVariable | null = null;
  if (editor && root && editor.explicit && editor.focus[0] === body &&
      !editor.argSelection && !editor.termSelection && !editor.matrixSelection) {
    const node = get(root, editor.focus);
    const parent = get(root, editor.focus.slice(0, -1));
    const role = childRefs(parent)[editor.focus.at(-1)!]?.[0];
    if (node.type === "Ident" && role !== "callee") {
      const spelling = node.name.segments.map((part: { text: string }) => part.text).join("");
      if (node.name.label === "var" || (!node.name.label && !["π", "∞", "NaN"].includes(spelling))) {
        variable = node.name;
      }
    }
  }
  const names = new Set<string>();
  if (expr && scalar && !variable) {
    for (const path of allPaths(expr)) {
      const node = get(expr, path);
      if (node.type !== "Ident" || node.name.label && node.name.label !== "var") continue;
      if (path.length && childRefs(get(expr, path.slice(0, -1)))[path.at(-1)!]?.[0] === "callee") continue;
      names.add(JSON.stringify(node.name.segments));
    }
  }
  const eligible = {
    expression: true,
    scalar,
    continued: scalar && (!!variable || names.size <= 1),
    equation: !!variable && equation,
    variable: scalar && !!variable,
  };
  return {
    variable,
    entries: FAST_SYMBOLIC.map(item => ({ ...item, enabled: expression && !!eligible[item.needs] })),
  };
}
