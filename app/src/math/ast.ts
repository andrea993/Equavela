// Types of the canonical AST as it arrives from Rust (serde form of `core/src/ast.rs`):
// every node is an object whose `type` names the variant. The nodes are deliberately
// loosely typed: the Rust side is the authority and the renderer reads fields by name.

export type Segment = { text: string; subscript: boolean };
export type Name = { segments: Segment[]; label?: string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = { type: string } & Record<string, any>;
export type Expr = Node;
export type Stmt = Node;
export type Target = Node;
export type Statement = Node;

export function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** The text of a name without markup: `F_max` for a literal subscript. */
export function nameText(name: Name): string {
  return name.segments
    .map((segment, index) =>
      segment.subscript ? (index > 0 ? "_" : "") + segment.text : segment.text,
    )
    .join("");
}
