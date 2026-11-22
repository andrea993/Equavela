// Regions on the clipboard: a snippet of the worksheet `regions:` list,
// readable plain text that Rust parses back with the worksheet reader (`paste_regions`).
// Strings are JSON-quoted (valid YAML). An image region carries the bytes of its picture in a
// `resources:` section after the list; an area carries its title, band and
// collapsed flag and its members are copied by the caller, so a pasted area is whole.
// A Julia region is written as its `julia:` block. A plot is written as its `plot:` mapping in
// JSON form, which the worksheet reader accepts as it does the file's own flow style.

import type { ViewRegion } from "../equavelaApi";

export type RegionsSnippet = { snippet: string; copied: number; skipped: number };

/** The bytes of one resource, in the form the file stores them: `base64`, or `text` for an SVG. */
type SnippetResource = { media: string; base64?: string; text?: string };

/**
 * A resource as the snippet writes it: the bytes of its data URL, which is base64. An SVG
 * is stored as its sanitized text so the snippet stays readable. Throws when the data
 * URL carries no base64, and the caller leaves that region out.
 */
async function snippetResource(
  loadImage: (resource: string) => Promise<string>,
  region: Extract<ViewRegion, { kind: "image" }>,
): Promise<SnippetResource> {
  const url = await loadImage(region.resource);
  const comma = url.indexOf(",");
  if (comma < 0 || !url.slice(0, comma).includes(";base64")) {
    throw new Error(`resource \`${region.resource}\` has no base64 data URL`);
  }
  const base64 = url.slice(comma + 1);
  if (region.media !== "svg") return { media: region.media, base64 };
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return { media: "svg", text: new TextDecoder().decode(bytes) };
}

/**
 * Writes the selected regions as a snippet: `loadImage` reads the picture of an image region and
 * `printMath` the canonical text of a math region whose own text is empty.
 */
export async function regionsSnippet(
  regions: readonly ViewRegion[],
  printMath: (statement: unknown) => Promise<string>,
  loadImage: (resource: string) => Promise<string>,
): Promise<RegionsSnippet> {
  const ordered = [...regions].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines: string[] = [];
  const resources: [string, SnippetResource][] = [];
  let copied = 0;
  let skipped = 0;
  for (const region of ordered) {
    const head = [`- id: ${region.id}`, `  page: ${region.page}`, `  at: [${region.x}, ${region.y}]`];
    let key: string;
    let value: string;
    switch (region.kind) {
      case "math":
        key = "math";
        // The view's text is the region's own linear text; the mock stores none, so print the AST.
        value = region.text !== "" ? region.text : await printMath(region.statement);
        break;
      case "text":
        key = "text";
        value = region.text;
        break;
      case "include":
        key = "include";
        value = region.path;
        break;
      case "area":
        lines.push(...head, "  area:");
        if (region.title !== "") lines.push(`    title: ${JSON.stringify(region.title)}`);
        lines.push(`    height: ${region.height}`);
        if (region.collapsed) lines.push("    collapsed: true");
        copied++;
        continue;
      case "plot":
        lines.push(...head, `  plot: ${JSON.stringify(region.plot)}`);
        copied++;
        continue;
      case "julia": {
        const block = region.block;
        const code = block.code ?? "";
        const parts: string[] = [];
        if (block.size) parts.push(`    size: [${block.size[0]}, ${block.size[1]}]`);
        if (block.playing === false) parts.push("    playing: false");
        if (block.using.length > 0) parts.push(`    using: ${JSON.stringify(block.using)}`);
        if (block.imports.length > 0) {
          parts.push("    import:");
          for (const entry of [...block.imports].sort((a, b) => a.name.localeCompare(b.name))) {
            parts.push(`      ${JSON.stringify(entry.name)}: ${JSON.stringify(`${entry.package}.${entry.function}`)}`);
          }
        }
        if (block.defines.length > 0) parts.push(`    define: ${JSON.stringify(block.defines)}`);
        if (code !== "") parts.push(`    code: ${JSON.stringify(code)}`);
        lines.push(...head, parts.length === 0 ? "  julia: {}" : "  julia:", ...parts);
        copied++;
        continue;
      }
      case "image": {
        let resource: SnippetResource;
        try {
          resource = await snippetResource(loadImage, region);
        } catch {
          // A picture that cannot be read is left out and reported, like a Julia region.
          skipped++;
          continue;
        }
        if (!resources.some(([id]) => id === region.resource)) resources.push([region.resource, resource]);
        lines.push(
          ...head,
          "  image:",
          `    resource: ${region.resource}`,
          `    size: [${region.size[0]}, ${region.size[1]}]`,
        );
        copied++;
        continue;
      }
      default:
        skipped++;
        continue;
    }
    lines.push(...head, `  ${key}: ${JSON.stringify(value)}`);
    copied++;
  }
  // The bytes of the copied pictures travel after the list, as the file's `resources:` section
  // does; the worksheet reader is what reads them back on paste.
  if (resources.length > 0) {
    lines.push("resources:");
    for (const [id, resource] of resources) {
      lines.push(`  ${id}:`, `    media: ${resource.media}`);
      lines.push(resource.text !== undefined ? `    text: ${JSON.stringify(resource.text)}` : `    base64: ${JSON.stringify(resource.base64)}`);
    }
  }
  return { snippet: lines.length ? `${lines.join("\n")}\n` : "", copied, skipped };
}

/**
 * Whether a clipboard text is a regions snippet (it starts with the first item of the list). A paste
 * of such a text pastes the regions and ignores a picture that came with it.
 */
export function isRegionsSnippet(text: string | null | undefined): boolean {
  return !!text && /^- id: \S/.test(text.trimStart());
}
