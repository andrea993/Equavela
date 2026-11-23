import type { EnvironmentSummary } from "../equavelaApi";

/**
 * The project whose REPL the panel shows, or null for the generic one. The REPL follows the
 * worksheet in front: a worksheet in the open project's environment uses the project's REPL, any
 * other (a standalone or untitled one) the generic one. With no worksheet in front (none open, or a
 * project file in front), the open project's REPL. Each environment keeps its own REPL session.
 */
export function replProjectOf(projectRoot: string | null, active: { environment?: EnvironmentSummary | null } | null): string | null {
  if (projectRoot === null) return null;
  return !active || active.environment?.kind === "project" ? projectRoot : null;
}
