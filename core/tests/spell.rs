//! The spell checker against word lists: the bundled
//! English dictionary always, Italian when a downloaded dictionary is found in
//! `EQUAVELA_SPELL_DICTIONARIES` (`<dir>/it_IT/it_IT.aff` and `.dic`).

use equavela_core::spell::{is_language_id, Speller};
use std::path::PathBuf;

fn bundled(language: &str) -> Speller {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../app/src-tauri/dictionaries")
        .join(language);
    let aff = std::fs::read_to_string(dir.join(format!("{language}.aff"))).unwrap();
    let dic = std::fs::read_to_string(dir.join(format!("{language}.dic"))).unwrap();
    Speller::new(&aff, &dic).unwrap()
}

#[test]
fn english_words_and_misspellings() {
    let speller = bundled("en_US");
    for word in [
        "the",
        "matrix",
        "eigenvalue",
        "calculations",
        "doesn't",
        "well-known",
        "engineer's",
        "x",
        "2nd",
        "3.5",
        "doesn\u{2019}t",
        "Beam",
        "SUPPORTED",
        "co-operate",
    ] {
        assert!(speller.check(word), "{word} should be correct");
    }
    for word in ["teh", "recieve", "matrxi", "calcualtion", "wellknwn-word"] {
        assert!(!speller.check(word), "{word} should be wrong");
    }
    let suggestions = speller.suggest("recieve");
    assert!(
        suggestions.iter().any(|s| s == "receive"),
        "{suggestions:?}"
    );
    assert!(suggestions.len() <= 6);
}

#[test]
fn the_user_dictionary_accepts_a_word() {
    let mut speller = bundled("en_US");
    assert!(!speller.check("Equavela"));
    speller.add_word("Equavela");
    assert!(speller.check("Equavela"));
}

#[test]
fn language_ids() {
    for id in ["en_US", "it_IT", "de", "ca_ES_valencia", "sr_Latn_RS"] {
        assert!(is_language_id(id), "{id}");
    }
    for id in ["", "EN_us", "e", "en-US", "en_", "../x", "en_US.dic"] {
        assert!(!is_language_id(id), "{id}");
    }
}

#[test]
fn italian_words_when_the_dictionary_is_installed() {
    let Ok(root) = std::env::var("EQUAVELA_SPELL_DICTIONARIES") else {
        eprintln!("skipping: EQUAVELA_SPELL_DICTIONARIES is not set");
        return;
    };
    let dir = PathBuf::from(root).join("it_IT");
    let aff = std::fs::read_to_string(dir.join("it_IT.aff")).unwrap();
    let dic = std::fs::read_to_string(dir.join("it_IT.dic")).unwrap();
    let speller = Speller::new(&aff, &dic).unwrap();
    for word in [
        "calcolo",
        "perché",
        "città",
        "l'altro",
        "dell'acqua",
        "un'equazione",
        "all'interno",
        "matrice",
        "autovalori",
        "più",
        "sarà",
        "nell\u{2019}esempio",
        "trave",
    ] {
        assert!(speller.check(word), "{word} should be correct");
    }
    for word in ["perche", "citta", "calcollo", "matrce", "l'altrro"] {
        assert!(!speller.check(word), "{word} should be wrong");
    }
    // A word the user added takes the elisions the dictionary writes as prefixes.
    let mut speller = speller;
    assert!(!speller.check("dell'inverter"));
    speller.add_word("inverter");
    for word in [
        "inverter",
        "dell'inverter",
        "nell\u{2019}inverter",
        "Dell'inverter",
        "l'inverter",
        "un'inverter",
    ] {
        assert!(speller.check(word), "{word} should be correct");
    }
    assert!(!speller.check("dell'invertr"));
}
