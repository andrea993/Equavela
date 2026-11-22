//! the specification : ORIGIN is a worksheet setting. A `.eqv` file that stores it
//! loads it as it is, with no note.

use equavela_core::project::DocumentId;
use equavela_core::worksheet_file::parse_document;

fn load(settings: &str) -> equavela_core::worksheet_file::LoadedDocument {
    let text = format!(
        "format: equavela-worksheet/3
settings:
{settings}regions:
  - id: r1
    at: [0, 0]
    math: 'v[1] ='
"
    );
    parse_document(DocumentId::new("/t/sheet.eqv").unwrap(), &text).unwrap()
}

#[test]
fn a_stored_origin_is_loaded_as_a_setting() {
    let loaded = load(
        "  ORIGIN: 1
  TOL: \"0.5\"
",
    );
    assert_eq!(loaded.document.settings.values["ORIGIN"], "1");
    assert_eq!(loaded.document.settings.values["TOL"], "0.5");
    assert!(loaded.notes.is_empty());
    let negative = load(
        "  ORIGIN: -2
",
    );
    assert_eq!(negative.document.settings.values["ORIGIN"], "-2");
}
