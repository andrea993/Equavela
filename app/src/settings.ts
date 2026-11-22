/**
 * Application settings: per user, stored by the backend in the app config directory
 * (`settings.json`), never in the worksheet.
 */

/** Autosave limits in seconds. */
export const AUTOSAVE_MIN_SECONDS = 5;
export const AUTOSAVE_MAX_SECONDS = 3600;
export const AUTOSAVE_DEFAULT_SECONDS = 30;

export type AppSettings = {
  autosave: {
    /** the switch; off means no recovery file is written. */
    enabled: boolean;
    /** Seconds between two recovery writes of a modified worksheet. */
    intervalSeconds: number;
  };
  /** The spell checker of the text regions. */
  spelling: { enabled: boolean };
};

export const DEFAULT_SETTINGS: AppSettings = {
  autosave: { enabled: true, intervalSeconds: AUTOSAVE_DEFAULT_SECONDS },
  spelling: { enabled: true },
};

/** Clamps an interval to the allowed range; a non-number gives the default. */
export function clampInterval(value: unknown): number {
  const n = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(n)) return AUTOSAVE_DEFAULT_SECONDS;
  return Math.min(AUTOSAVE_MAX_SECONDS, Math.max(AUTOSAVE_MIN_SECONDS, n));
}

/** A complete, valid settings object from anything (missing or wrong fields take the defaults). */
export function sanitizeSettings(value: unknown): AppSettings {
  const autosave = (value as { autosave?: { enabled?: unknown; intervalSeconds?: unknown } } | null)?.autosave;
  return {
    autosave: {
      enabled: typeof autosave?.enabled === "boolean" ? autosave.enabled : DEFAULT_SETTINGS.autosave.enabled,
      intervalSeconds: clampInterval(autosave?.intervalSeconds),
    },
    spelling: {
      enabled: typeof (value as { spelling?: { enabled?: unknown } } | null)?.spelling?.enabled === "boolean"
        ? Boolean((value as { spelling: { enabled: boolean } }).spelling.enabled)
        : true,
    },
  };
}
