//! The spelling service of the app: the English dictionary
//! is part of the program, every other LibreOffice dictionary is downloaded on request into the
//! app data folder, and the user's own words live in a plain text list there. Checking runs on the
//! command threads, never on the UI thread.

use equavela_core::spell::{is_language_id, Speller};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

/// The dictionary that is part of the program: SCOWL's en_US, BSD-style licence.
pub const BUNDLED: &str = "en_US";
const BUNDLED_AFF: &str = include_str!("../dictionaries/en_US/en_US.aff");
const BUNDLED_DIC: &str = include_str!("../dictionaries/en_US/en_US.dic");
const BUNDLED_LICENSE: &str = include_str!("../dictionaries/en_US/README_en_US.txt");
/// The dictionaries LibreOffice publishes, read from its `dictionaries.xcu` files.
const CATALOG: &str = include_str!("../dictionaries/catalog.json");
/// Where a dictionary is downloaded from.
pub const SOURCE: &str = "https://raw.githubusercontent.com/LibreOffice/dictionaries/master";

#[derive(Debug, Clone, Deserialize)]
struct CatalogEntry {
    id: String,
    locales: Vec<String>,
    folder: String,
    aff: String,
    dic: String,
    license: Option<String>,
}

/// One language of the catalogue as the frontend lists it.
#[derive(Debug, Clone, Serialize)]
pub struct Language {
    pub id: String,
    pub locales: Vec<String>,
    /// Part of the program or downloaded: it can be used now.
    pub installed: bool,
    pub bundled: bool,
}

/// The result of a check: whether the language can be used, and one flag per word.
#[derive(Debug, Clone, Serialize)]
pub struct SpellCheck {
    pub available: bool,
    pub correct: Vec<bool>,
}

pub struct SpellService {
    dir: Mutex<Option<PathBuf>>,
    spellers: Mutex<HashMap<String, Arc<RwLock<Speller>>>>,
    user_words: Mutex<Vec<String>>,
    catalog: Vec<CatalogEntry>,
}

impl Default for SpellService {
    fn default() -> Self {
        let catalog: Vec<CatalogEntry> = serde_json::from_str(CATALOG).unwrap_or_default();
        Self {
            dir: Mutex::new(None),
            spellers: Mutex::new(HashMap::new()),
            user_words: Mutex::new(Vec::new()),
            catalog: catalog
                .into_iter()
                .filter(|entry| is_language_id(&entry.id))
                .collect(),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl SpellService {
    /// The folder of the downloaded dictionaries and of the user's words (`<app data>/spelling`).
    pub fn set_dir(&self, dir: PathBuf) {
        let words = std::fs::read_to_string(dir.join("user-words.txt"))
            .map(|text| {
                text.lines()
                    .map(str::trim)
                    .filter(|w| !w.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        *lock(&self.user_words) = words;
        *lock(&self.dir) = Some(dir);
        lock(&self.spellers).clear();
    }

    fn installed_dir(&self, id: &str) -> Option<PathBuf> {
        lock(&self.dir)
            .as_ref()
            .map(|dir| dir.join("dictionaries").join(id))
    }

    fn is_installed(&self, id: &str) -> bool {
        id == BUNDLED
            || self.installed_dir(id).is_some_and(|dir| {
                dir.join(format!("{id}.aff")).is_file() && dir.join(format!("{id}.dic")).is_file()
            })
    }

    /// Every language of the catalogue, the installed ones first.
    pub fn languages(&self) -> Vec<Language> {
        let mut list: Vec<Language> = self
            .catalog
            .iter()
            .map(|entry| Language {
                id: entry.id.clone(),
                locales: entry.locales.clone(),
                installed: self.is_installed(&entry.id),
                bundled: entry.id == BUNDLED,
            })
            .collect();
        list.sort_by(|a, b| b.installed.cmp(&a.installed).then_with(|| a.id.cmp(&b.id)));
        list
    }

    /// The catalogue id of a language or locale (`it_CH` is checked with `it_IT`).
    fn resolve(&self, language: &str) -> Option<String> {
        self.catalog
            .iter()
            .find(|entry| entry.id == language)
            .or_else(|| {
                self.catalog
                    .iter()
                    .find(|entry| entry.locales.iter().any(|l| l == language))
            })
            .map(|entry| entry.id.clone())
    }

    fn speller(&self, language: &str) -> Result<Option<Arc<RwLock<Speller>>>, String> {
        let Some(id) = self.resolve(language) else {
            return Ok(None);
        };
        if let Some(speller) = lock(&self.spellers).get(&id) {
            return Ok(Some(speller.clone()));
        }
        let mut speller = if id == BUNDLED {
            Speller::new(BUNDLED_AFF, BUNDLED_DIC)?
        } else {
            let Some(dir) = self.installed_dir(&id).filter(|_| self.is_installed(&id)) else {
                return Ok(None);
            };
            let read = |name: String| {
                std::fs::read_to_string(dir.join(&name))
                    .map_err(|error| format!("cannot read {name}: {error}"))
            };
            Speller::new(&read(format!("{id}.aff"))?, &read(format!("{id}.dic"))?)?
        };
        for word in lock(&self.user_words).iter() {
            speller.add_word(word);
        }
        let speller = Arc::new(RwLock::new(speller));
        lock(&self.spellers).insert(id, speller.clone());
        Ok(Some(speller))
    }

    /// One flag per word; a language that is not installed is `available: false`.
    pub fn check(&self, language: &str, words: &[String]) -> Result<SpellCheck, String> {
        let Some(speller) = self.speller(language)? else {
            return Ok(SpellCheck {
                available: false,
                correct: vec![true; words.len()],
            });
        };
        let speller = speller
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(SpellCheck {
            available: true,
            correct: words.iter().map(|word| speller.check(word)).collect(),
        })
    }

    /// The corrections of a word.
    pub fn suggest(&self, language: &str, word: &str) -> Result<Vec<String>, String> {
        Ok(match self.speller(language)? {
            Some(speller) => speller
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .suggest(word),
            None => Vec::new(),
        })
    }

    /// Adds a word to the user's list: every language accepts it from now on.
    pub fn add_word(&self, word: &str) -> Result<(), String> {
        let word = word.trim();
        if word.is_empty() || word.chars().any(char::is_whitespace) {
            return Err("a dictionary word is one word without spaces".into());
        }
        let mut words = lock(&self.user_words);
        if !words.iter().any(|w| w == word) {
            words.push(word.to_owned());
            if let Some(dir) = lock(&self.dir).clone() {
                std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
                let text = words.join("\n") + "\n";
                equavela_core::worksheet_writer::write_file_atomic(
                    &dir.join("user-words.txt"),
                    &text,
                )
                .map_err(|error| error.to_string())?;
            }
        }
        for speller in lock(&self.spellers).values() {
            speller
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .add_word(word);
        }
        Ok(())
    }

    /// The licence text of a dictionary: the bundled one, or the one downloaded with it.
    pub fn license(&self, language: &str) -> Option<String> {
        let id = self.resolve(language)?;
        if id == BUNDLED {
            return Some(BUNDLED_LICENSE.to_owned());
        }
        let entry = self.catalog.iter().find(|entry| entry.id == id)?;
        let name = entry.license.as_ref()?;
        std::fs::read_to_string(self.installed_dir(&id)?.join(name)).ok()
    }

    /// Downloads a dictionary and its licence from LibreOffice into the app data folder.
    /// The frontend calls it only after the user agreed in the download dialog.
    pub fn install(&self, language: &str) -> Result<(), String> {
        let id = self
            .resolve(language)
            .ok_or_else(|| format!("{language} is not in the catalogue"))?;
        if self.is_installed(&id) {
            return Ok(());
        }
        let entry = self
            .catalog
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
            .ok_or("unknown dictionary")?;
        let dir = self
            .installed_dir(&id)
            .ok_or("the app data folder is not known")?;
        let staging = dir.with_extension("download");
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
        let mut files = vec![
            (entry.aff.clone(), format!("{id}.aff")),
            (entry.dic.clone(), format!("{id}.dic")),
        ];
        if let Some(license) = &entry.license {
            files.push((license.clone(), license.clone()));
        }
        for (remote, local) in files {
            let url = format!("{SOURCE}/{}/{}", entry.folder, remote);
            let bytes = download(&url)?;
            std::fs::write(staging.join(&local), bytes).map_err(|error| error.to_string())?;
        }
        // The dictionary must load before it replaces anything.
        let read = |name: String| {
            std::fs::read_to_string(staging.join(name)).map_err(|error| error.to_string())
        };
        Speller::new(&read(format!("{id}.aff"))?, &read(format!("{id}.dic"))?)
            .map_err(|error| format!("the downloaded dictionary does not load: {error}"))?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&staging, &dir).map_err(|error| error.to_string())?;
        lock(&self.spellers).remove(&id);
        Ok(())
    }

    /// Removes a downloaded dictionary (the bundled one cannot be removed).
    pub fn uninstall(&self, language: &str) -> Result<(), String> {
        let id = self.resolve(language).ok_or("unknown dictionary")?;
        if id == BUNDLED {
            return Err("the English dictionary is part of the program".into());
        }
        if let Some(dir) = self.installed_dir(&id) {
            remove_if_present(&dir)?;
        }
        lock(&self.spellers).remove(&id);
        Ok(())
    }
}

fn remove_if_present(dir: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let mut response = ureq::get(url)
        .call()
        .map_err(|error| format!("cannot download {url}: {error}"))?;
    response
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_vec()
        .map_err(|error| format!("cannot download {url}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_english_checks_and_suggests_without_a_folder() {
        let service = SpellService::default();
        let check = service
            .check("en_US", &["matrix".into(), "matrxi".into()])
            .unwrap();
        assert!(check.available);
        assert_eq!(check.correct, vec![true, false]);
        assert!(service
            .suggest("en_US", "recieve")
            .unwrap()
            .contains(&"receive".to_owned()));
        assert!(service.license("en_US").unwrap().contains("Kevin Atkinson"));
    }

    #[test]
    fn a_language_that_is_not_installed_checks_nothing() {
        let service = SpellService::default();
        let check = service.check("it_IT", &["calcollo".into()]).unwrap();
        assert!(!check.available);
        assert_eq!(check.correct, vec![true]);
        let languages = service.languages();
        assert!(languages[0].installed && languages[0].id == "en_US");
        assert!(languages.iter().any(|l| l.id == "it_IT" && !l.installed));
    }

    #[test]
    fn user_words_are_stored_and_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let service = SpellService::default();
        service.set_dir(dir.path().to_path_buf());
        assert_eq!(
            service.check("en_US", &["Navier".into()]).unwrap().correct,
            vec![false]
        );
        service.add_word("Navier").unwrap();
        assert_eq!(
            service.check("en_US", &["Navier".into()]).unwrap().correct,
            vec![true]
        );
        let again = SpellService::default();
        again.set_dir(dir.path().to_path_buf());
        assert_eq!(
            again.check("en_US", &["Navier".into()]).unwrap().correct,
            vec![true]
        );
        assert!(service.add_word("two words").is_err());
    }

    #[test]
    fn an_installed_dictionary_is_found_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("dictionaries").join("it_IT");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("it_IT.aff"), "SET UTF-8\n").unwrap();
        std::fs::write(target.join("it_IT.dic"), "2\ncalcolo\nmatrice\n").unwrap();
        let service = SpellService::default();
        service.set_dir(dir.path().to_path_buf());
        let check = service
            .check("it_CH", &["calcolo".into(), "calcollo".into()])
            .unwrap();
        assert!(check.available);
        assert_eq!(check.correct, vec![true, false]);
        service.uninstall("it_IT").unwrap();
        assert!(
            !service
                .check("it_IT", &["calcolo".into()])
                .unwrap()
                .available
        );
        assert!(service.uninstall("en_US").is_err());
    }

    /// Downloads Italian from LibreOffice (network): `cargo test -p equavela-app -- --ignored`.
    #[test]
    #[ignore]
    fn italian_is_downloaded_and_checks() {
        let dir = tempfile::tempdir().unwrap();
        let service = SpellService::default();
        service.set_dir(dir.path().to_path_buf());
        service.install("it_IT").unwrap();
        let check = service
            .check(
                "it_IT",
                &["perché".into(), "l'altro".into(), "perche".into()],
            )
            .unwrap();
        assert_eq!(check.correct, vec![true, true, false]);
        assert!(service.license("it_IT").is_some());
    }
}
