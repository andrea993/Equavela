import type { SessionDiagnostic } from "../equavelaApi";

/** Broken image diagnostics of one loaded worksheet, without counting include or math errors. */
export function unavailableImageCount(
  root: string,
  regions: readonly { id: string; kind: string }[],
  diagnostics: readonly SessionDiagnostic[],
): number {
  const normalize = (path: string) => {
    const value = path.replace(/\\/g, "/");
    return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
  };
  const document = normalize(root);
  const images = new Set(regions.filter(region => region.kind === "image").map(region => region.id));
  return new Set(diagnostics.filter(item => normalize(item.document) === document && images.has(item.region_id)).map(item => item.region_id)).size;
}
