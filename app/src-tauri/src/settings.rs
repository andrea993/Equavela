//! Application settings: a small JSON file in the app config directory.
//!
//! Reading is lenient (a missing, unreadable or damaged file, or a wrong field, gives the
//! defaults); writing is atomic and always writes a complete, validated object.

use equavela_core::worksheet_writer::write_file_atomic;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const AUTOSAVE_MIN_SECONDS: u32 = 5;
pub const AUTOSAVE_MAX_SECONDS: u32 = 3600;
pub const AUTOSAVE_DEFAULT_SECONDS: u32 = 30;

/// File name inside the app config directory.
pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutosaveSettings {
    pub enabled: bool,
    pub interval_seconds: u32,
}

/// The spell checker of the text regions: on by default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpellingSettings {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSettings {
    pub autosave: AutosaveSettings,
    pub spelling: SpellingSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            autosave: AutosaveSettings {
                enabled: true,
                interval_seconds: AUTOSAVE_DEFAULT_SECONDS,
            },
            spelling: SpellingSettings { enabled: true },
        }
    }
}

impl AppSettings {
    /// A valid object from any JSON: missing or wrong fields take the defaults, the interval is
    /// clamped to `AUTOSAVE_MIN_SECONDS..=AUTOSAVE_MAX_SECONDS`.
    pub fn sanitized(value: &serde_json::Value) -> AppSettings {
        let autosave = value.get("autosave");
        let enabled = autosave
            .and_then(|a| a.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let interval_seconds = autosave
            .and_then(|a| a.get("intervalSeconds"))
            .and_then(|v| v.as_f64())
            .filter(|n| n.is_finite())
            .map_or(AUTOSAVE_DEFAULT_SECONDS, |n| {
                (n.round() as i64).clamp(AUTOSAVE_MIN_SECONDS as i64, AUTOSAVE_MAX_SECONDS as i64)
                    as u32
            });
        let spelling = value
            .get("spelling")
            .and_then(|s| s.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        AppSettings {
            autosave: AutosaveSettings {
                enabled,
                interval_seconds,
            },
            spelling: SpellingSettings { enabled: spelling },
        }
    }
}

/// Reads `<dir>/settings.json`; the defaults when it cannot be used.
pub fn load(dir: &Path) -> AppSettings {
    std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .map_or_else(AppSettings::default, |value| AppSettings::sanitized(&value))
}

/// Validates and stores the settings; returns what was stored.
pub fn store(dir: &Path, settings: &serde_json::Value) -> Result<AppSettings, String> {
    let settings = AppSettings::sanitized(settings);
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create `{}`: {e}", dir.display()))?;
    let mut text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    text.push('\n');
    write_file_atomic(&dir.join(SETTINGS_FILE), &text).map_err(|e| e.to_string())?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("equavela-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn defaults_are_on_every_30_seconds() {
        let d = AppSettings::default();
        assert!(d.autosave.enabled);
        assert_eq!(d.autosave.interval_seconds, 30);
        assert_eq!(load(&scratch("missing")), d);
    }

    #[test]
    fn store_then_load_round_trips_and_uses_camel_case() {
        let dir = scratch("roundtrip");
        let stored = store(
            &dir,
            &json!({"autosave": {"enabled": false, "intervalSeconds": 120}}),
        )
        .unwrap();
        assert!(!stored.autosave.enabled);
        assert_eq!(load(&dir), stored);
        let text = std::fs::read_to_string(dir.join(SETTINGS_FILE)).unwrap();
        assert!(text.contains("\"intervalSeconds\": 120"), "{text}");
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "no temporary file stays");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn intervals_are_clamped_and_wrong_fields_take_defaults() {
        let s = |v| AppSettings::sanitized(&v);
        assert_eq!(
            s(json!({"autosave": {"intervalSeconds": 1}}))
                .autosave
                .interval_seconds,
            5
        );
        assert_eq!(
            s(json!({"autosave": {"intervalSeconds": 1e9}}))
                .autosave
                .interval_seconds,
            3600
        );
        assert_eq!(
            s(json!({"autosave": {"intervalSeconds": "x"}}))
                .autosave
                .interval_seconds,
            30
        );
        assert!(s(json!({"autosave": {"enabled": "no"}})).autosave.enabled);
        assert_eq!(s(json!(null)), AppSettings::default());
    }

    #[test]
    fn a_damaged_file_gives_the_defaults() {
        let dir = scratch("damaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SETTINGS_FILE), "{ not json").unwrap();
        assert_eq!(load(&dir), AppSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
