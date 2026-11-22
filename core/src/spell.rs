//! Spell checking of the prose of a worksheet:
//! a Hunspell dictionary read by `spellbook`, the user's own words and the rules for the words a
//! dictionary alone does not settle (elisions, hyphenated compounds, numbers, abbreviations).

use spellbook::Dictionary;
use std::collections::HashSet;

/// Whether `value` is a dictionary language id: a language code of two or three lower-case letters,
/// then optional parts of letters joined by `_` (`en_US`, `it_IT`, `ca_ES_valencia`).
pub fn is_language_id(value: &str) -> bool {
    let mut parts = value.split('_');
    let Some(language) = parts.next() else {
        return false;
    };
    (2..=3).contains(&language.len())
        && language.bytes().all(|b| b.is_ascii_lowercase())
        && parts.all(|part| {
            !part.is_empty() && part.len() <= 12 && part.bytes().all(|b| b.is_ascii_alphabetic())
        })
}

/// One loaded dictionary and the words the user added to it.
pub struct Speller {
    dictionary: Dictionary,
    /// The elided articles and prepositions the dictionary writes as prefixes (`dell'`, `nell'`),
    /// lower case: a word the user added takes them too.
    elisions: HashSet<String>,
}

/// The longest list of suggestions offered for one word.
pub const MAX_SUGGESTIONS: usize = 6;

impl Speller {
    /// Reads a dictionary from the text of its `.aff` and `.dic` files.
    pub fn new(aff: &str, dic: &str) -> Result<Self, String> {
        Dictionary::new(aff, dic)
            .map(|dictionary| Self {
                dictionary,
                elisions: elisions(aff),
            })
            .map_err(|error| error.to_string())
    }

    /// Accepts `word` from now on.
    pub fn add_word(&mut self, word: &str) {
        let word = normalize(word);
        if !word.is_empty() {
            // A word with a character that reads as an affix flag is added without flags.
            let _ = self.dictionary.add(&word);
        }
    }

    /// Whether `word` is spelled correctly. A word with a digit, a single letter and an
    /// empty word are always correct; an elision (`l'altro`, `dell'acqua`) and a compound with
    /// hyphens (`well-known`) are correct when every part is.
    pub fn check(&self, word: &str) -> bool {
        let word = normalize(word);
        if word.chars().count() <= 1 || word.chars().any(|c| c.is_ascii_digit()) {
            return true;
        }
        if self.dictionary.check(&word) {
            return true;
        }
        if let Some((head, tail)) = word.split_once('\'') {
            // An elision: the article or preposition with its apostrophe, then the word.
            let head = format!("{head}'");
            return (self.dictionary.check(&head)
                || self.elisions.contains(&head.to_lowercase())
                || head.chars().count() <= 3)
                && (tail.is_empty() || self.check(tail));
        }
        if word.contains('-') {
            return word
                .split('-')
                .all(|part| part.is_empty() || self.check(part));
        }
        false
    }

    /// Up to [`MAX_SUGGESTIONS`] corrections of `word`, the most likely first.
    pub fn suggest(&self, word: &str) -> Vec<String> {
        let mut out = Vec::new();
        self.dictionary.suggest(&normalize(word), &mut out);
        out.truncate(MAX_SUGGESTIONS);
        out
    }
}

/// The prefixes of an `.aff` file that end in an apostrophe: `PFX T 0 dell' [aeiouh]` gives `dell'`.
fn elisions(aff: &str) -> HashSet<String> {
    aff.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next() == Some("PFX")).then_some(())?;
            let add = fields.nth(2)?.split('/').next()?;
            add.ends_with('\'').then(|| normalize(add).to_lowercase())
        })
        .collect()
}

/// The typographic apostrophe reads as the plain one, as the dictionaries write it.
fn normalize(word: &str) -> String {
    word.trim().replace(['\u{2019}', '\u{02bc}'], "'")
}
