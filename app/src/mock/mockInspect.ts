// The mock backend's inspection: definitions, references and the include tree derived from the
// regions' ASTs in TypeScript (the real one is `core/src/session/inspect.rs`, which resolves
// names exactly as the code generator does). It follows the same visibility rule: a use sees the
// latest definition above it in reading order (or any `≡` definition), parameters and locals of a
// function body are not references. Unit warnings need the dimension analysis, which the mock
// does not have.

import { isNode, nameText, type Node } from "../math/ast";
import { builtinEntry } from "../catalog/builtins";
import physicalConstants from "../../../kernel/EqRuntime/src/constants.tsv?raw";
import { inlineRegionId } from "../text/value";
import type {
  DefinitionInfo,
  DefinitionValue,
  Inspection,
  KernelValue,
  RegionKey,
  ReferenceInfo,
  ViewRegion,
} from "../equavelaApi";

type MathRegion = Extract<ViewRegion, { kind: "math" }>;

const physicalNames = new Set(physicalConstants.split("\n").flatMap((line) => {
  const [name, alias] = line.trim().split(/\s+/);
  if (!name || name.startsWith("#")) return [];
  return [name === "@alias" ? alias : name];
}));
const mathConstants = new Map<string, number | "nan" | "infinity">([
  ["π", Math.PI], ["e", Math.E], ["γ", 0.5772156649015329], ["∞", "infinity"], ["NaN", "nan"],
]);

function mockIntrinsic(name: string, label: string | null): ReferenceInfo["intrinsic"] {
  if (!label || label === "const" || label === "sys") {
    const value = mathConstants.get(name);
    if (value !== undefined) return { kind: "constant", value };
    if (physicalNames.has(name)) return { kind: "constant" };
    if (["ORIGIN", "TOL", "CTOL"].includes(name)) return { kind: "system" };
  }
  if ((!label || label === "fn") && builtinEntry(name)) return { kind: "builtin" };
  return undefined;
}

const real = (value: number) => ({ type: "real" as const, value });

/** Values of the demo worksheet's variables, as the kernel would answer a peek. */
export function demoDefinitionValues(name: string): Pick<DefinitionValue, "value" | "size" | "error" | "display_unit"> {
  const matrix = (rows: number, cols: number, fill: (i: number, j: number) => number): KernelValue => {
    const values: KernelValue[] = [];
    for (let j = 0; j < cols; j++) for (let i = 0; i < rows; i++) values.push(real(fill(i, j)));
    return { type: "matrix", rows, cols, storage: { type: "inline", values } };
  };
  switch (name) {
    case "L":
      return { value: { type: "quantity", magnitude: real(3.5), dimension: [{ base: "length", power: [1, 1] }] }, size: null, error: null };
    case "q":
      return {
        value: {
          type: "quantity",
          magnitude: real(12000),
          dimension: [
            { base: "mass", power: [1, 1] },
            { base: "time", power: [-2, 1] },
          ],
        },
        size: null,
        error: null,
        // written in the definition, `q := 12 kN/m`
        display_unit: { text: "kN/m", divisor: 1000 },
      };
    case "M_max":
      return {
        value: {
          type: "quantity",
          magnitude: real(18375),
          dimension: [
            { base: "length", power: [2, 1] },
            { base: "mass", power: [1, 1] },
            { base: "time", power: [-2, 1] },
          ],
        },
        size: null,
        error: null,
        // the evaluation `M_max = … kN·m`
        display_unit: { text: "kN·m", divisor: 1000 },
      };
    case "k":
      return { value: real(2.5), size: null, error: null };
    case "A":
      return { value: matrix(3, 3, (i, j) => [1, 2, 3, 4, 5, 6, 7, 8, 10][i * 3 + j]), size: null, error: null };
    case "z":
      return { value: { type: "complex", real: 3, imag: 4 }, size: null, error: null };
    case "B":
      return { value: null, size: [15, 15], error: null };
    case "v":
      return { value: matrix(1, 5, (_, j) => j * 0.5), size: null, error: null };
    case "w":
      return { value: null, size: null, error: "missing is undefined" };
    default:
      return { value: null, size: null, error: "not calculated yet" };
  }
}

const definedName = (target: Node | undefined): { name: string; fn: boolean } | null => {
  if (!target || !isNode(target)) return null;
  if (target.type === "Ident") return { name: nameText(target.name), fn: false };
  if (target.type === "FunctionHead") return { name: nameText(target.name.name), fn: true };
  if (target.type === "Call" && isNode(target.callee) && target.callee.type === "Ident") {
    return { name: nameText(target.callee.name), fn: true };
  }
  return null;
};

/** The text before the definition operator, as written. */
const signatureOf = (region: MathRegion): string => {
  const text = region.text;
  const cut = [":=", "≡", "←"].map((op) => text.indexOf(op)).filter((i) => i >= 0);
  return cut.length ? text.slice(0, Math.min(...cut)).trim() : text.trim();
};

export function mockInspect(
  documentId: string,
  regions: ViewRegion[],
  keyOf: (regionId: string) => RegionKey,
): Inspection {
  const math = regions
    .flatMap((region): MathRegion[] => {
      if (!region.enabled) return [];
      if (region.kind === "math") return [region];
      if (region.kind !== "text") return [];
      return region.paragraphs.flatMap((paragraph) => paragraph.runs)
        .filter((run) => run.kind === "math")
        .flatMap((run, index) => run.disabled || !run.statement ? [] : [{
          id: inlineRegionId(region.id, index), kind: "math", page: region.page, x: region.x, y: region.y,
          enabled: true, text: run.text, statement: run.statement,
        }]);
    })
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const definitions: DefinitionInfo[] = [];
  const versions = new Map<string, number>();
  math.forEach((region, rank) => {
    const statement = region.statement as Node;
    if (!isNode(statement) || (statement.type !== "Define" && statement.type !== "GlobalDefine")) return;
    const defined = definedName(statement.target as Node);
    if (!defined) return;
    const version = (versions.get(defined.name) ?? 0) + 1;
    versions.set(defined.name, version);
    definitions.push({
      name: defined.name,
      label: defined.fn ? "fn" : "var",
      key: keyOf(region.id),
      version,
      global: statement.type === "GlobalDefine",
      signature: signatureOf(region),
      kernel_name: kernelName(defined.name, version),
      rank,
    });
  });
  const references: ReferenceInfo[] = [];
  math.forEach((region, rank) => {
    const statement = region.statement as Node;
    if (!isNode(statement)) return;
    const params = new Set<string>();
    if (statement.type === "Define" && statement.target?.type === "FunctionHead") {
      for (const p of statement.target.params as { name: Parameters<typeof nameText>[0] }[]) params.add(nameText(p.name));
    }
    const walk = (node: unknown, skipTarget: Node | null) => {
      if (Array.isArray(node)) return node.forEach((n) => walk(n, skipTarget));
      if (!isNode(node) || node === skipTarget) return;
      if (node.type === "Ident" && node.span && node.name) {
        const name = nameText(node.name);
        if (!params.has(name)) {
          const visible = (!node.name.label || ["var", "fn"].includes(node.name.label)) ? definitions
            .filter((d) => d.name === name && (d.rank < rank || d.global))
            .sort((a, b) => b.rank - a.rank)[0] : undefined;
          references.push({
            key: keyOf(region.id),
            start: node.span.start,
            end: node.span.end,
            name,
            definition: visible?.key ?? null,
            definition_name: visible?.name,
            version: visible?.version ?? null,
            intrinsic: visible ? undefined : mockIntrinsic(name, node.name.label),
          });
        }
      }
      for (const [k, v] of Object.entries(node)) if (k !== "span" && typeof v === "object") walk(v, skipTarget);
    };
    walk(statement, statement.type === "Define" || statement.type === "GlobalDefine" ? (statement.target as Node) : null);
  });
  const includes = regions
    .filter((r): r is Extract<ViewRegion, { kind: "include" }> => r.kind === "include")
    .map((region) => {
      const base = documentId.replace(/[^/\\]*$/, "");
      return {
        document: `${base}${region.path}`,
        parent: documentId,
        region_id: region.id,
        exports: [],
        found: false,
      };
    });
  return {
    root: documentId,
    definitions,
    references,
    warnings: [],
    includes,
    ranks: math.map((region, rank) => [keyOf(region.id), rank] as [RegionKey, number]),
  };
}

/**
 * The kernel name of a definition (codegen.rs `worksheet_ident`) for a linear-text name such as
 * `M_max`: the first segment, `_s` and the literal subscript, then `_v` and the version. Other
 * characters are written `_<hex>_` as the codegen does.
 */
export function kernelName(name: string, version: number): string {
  const escape = (text: string, start: boolean) => [...text].map((c, i) =>
    /[\p{L}]/u.test(c) || (/[0-9]/.test(c) && !(start && i === 0)) ? c : `_${c.codePointAt(0)!.toString(16)}_`).join("");
  const [head, ...rest] = name.split("_");
  const sub = rest.join("_");
  return `${escape(head, true)}${sub ? `_s${escape(sub, false)}` : ""}_v${version}`;
}
