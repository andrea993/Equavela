import { LABEL_KINDS } from "../math/labels";
import { UNIT_NAMES } from "../math/units";

/** The labels a name can carry in the unit field: a unit context accepts them and means the same. */
const LABEL_SUFFIX = new RegExp(`@(?:${LABEL_KINDS.join("|")})$`);

/**
 * Unit products, quotients and integer powers, using the shared built-in catalog. The field is a unit
 * context, so a plain name is a unit there; an explicit label
 *  is accepted and means the same.
 */
export function validTableUnit(source: string): boolean {
  const text = source.trim();
  if (!text) return true;
  const tokens = text.match(/[\p{L}_µΩ°][\p{L}\p{N}_µΩ°]*(?:@[a-z]+)?|\d+|[*/^()\-]/gu);
  if (!tokens || tokens.join("") !== text.replace(/\s+/g, "")) return false;
  let i = 0;
  function atom(): boolean {
    if (tokens![i] === "(") {
      i++;
      if (!product() || tokens![i++] !== ")") return false;
      return true;
    }
    const token = tokens![i++] ?? "";
    const name = token.replace(LABEL_SUFFIX, "");
    // A suffix that is not a label of the model (`m@foo`) is not a unit.
    if (name.includes("@")) return false;
    return UNIT_NAMES.has(name);
  }
  function power(): boolean {
    if (!atom()) return false;
    if (tokens![i] === "^") {
      i++;
      const parens = tokens![i] === "(";
      if (parens) i++;
      if (tokens![i] === "-") i++;
      if (!/^\d+$/.test(tokens![i++] ?? "")) return false;
      if (parens && tokens![i++] !== ")") return false;
    }
    return true;
  }
  function product(): boolean {
    if (!power()) return false;
    while (i < tokens!.length && tokens![i] !== ")") {
      if (tokens![i] === "*" || tokens![i] === "/") i++;
      if (!power()) return false;
    }
    return true;
  }
  return product() && i === tokens.length;
}
