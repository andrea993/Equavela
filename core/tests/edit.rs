//! Edit commands, undo/redo and the UI view of a document. No kernel needed:
//! nothing here is evaluated.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use equavela_core::codegen::GenOptions;
use equavela_core::edit::{EditCommand, StoredRegion};
use equavela_core::graph::Region;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::parse_statement;
use equavela_core::project::{DocumentId, DocumentRegion, Project};
use equavela_core::session::{SessionError, ViewContent, WorksheetSession};
use equavela_core::worksheet_file::parse_document;
use equavela_core::worksheet_writer::write_document;

const SHEET: &str = r#"format: equavela-worksheet/3
page:
  size: Letter
  margins: {top: 50, right: 40, bottom: 50, left: 40}
regions:
  - id: r1
    page: 1
    at: [54, 72]
    text: |
      Heading text
  - id: r2
    page: 1
    at: [54, 110]
    math: "a := 2"
  - id: r3
    page: 1
    at: [54, 140]
    math: "b := a + 1"
  - id: r4
    page: 1
    at: [200, 140]
    math: "b ="
"#;

fn root() -> DocumentId {
    DocumentId::new("/edit.eqv").unwrap()
}

fn session() -> WorksheetSession {
    session_of(SHEET)
}

fn session_of(sheet: &str) -> WorksheetSession {
    let loaded = parse_document(root(), sheet).unwrap();
    let mut project = Project::new();
    project.insert(loaded.document).unwrap();
    let texts: HashMap<_, _> = loaded
        .texts
        .into_iter()
        .map(|(id, text)| ((root(), id), text))
        .collect();
    // The kernel is never started.
    let kernel = Arc::new(KernelManager::new(KernelConfig::new(PathBuf::from(
        "kernel-not-started",
    ))));
    WorksheetSession::new(kernel, "ws", project, root(), texts, GenOptions::default()).unwrap()
}

fn ids(session: &WorksheetSession) -> Vec<String> {
    session
        .view(&root())
        .unwrap()
        .regions
        .iter()
        .map(|region| region.id.clone())
        .collect()
}

fn math_region(id: &str, text: &str, x: f64, y: f64) -> StoredRegion {
    StoredRegion {
        region: DocumentRegion::Math(Box::new(Region {
            id: id.to_owned(),
            page: 1,
            x,
            y,
            enabled: true,
            statement: std::sync::Arc::new(parse_statement(text).unwrap()),
        })),
        math_text: Some(text.to_owned()),
    }
}

#[test]
fn view_has_page_setup_text_and_math_with_ast() {
    let session = session();
    let view = session.view(&root()).unwrap();
    assert_eq!(view.page.size, "Letter");
    assert_eq!((view.page.width, view.page.height), (612.0, 792.0));
    assert_eq!(view.page.margins.left, 40.0);
    assert_eq!(view.regions.len(), 4);
    assert!(matches!(
        &view.regions[0].content,
        ViewContent::Text { text, .. } if text == "Heading text"
    ));
    let ViewContent::Math {
        text, statement, ..
    } = &view.regions[2].content
    else {
        panic!("math expected");
    };
    assert_eq!(text, "b := a + 1");
    let json = serde_json::to_value(statement).unwrap();
    assert_eq!(json["type"], "Define");
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["regions"][1]["kind"], "math");
    assert_eq!(json["regions"][0]["kind"], "text");
}

#[test]
fn move_undo_redo() {
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Move region",
            EditCommand::Move {
                region_id: "r2".into(),
                page: 2,
                x: 99.0,
                y: 12.0,
            },
        )
        .unwrap();
    let region = |s: &WorksheetSession| {
        let view = s.view(&root()).unwrap();
        let r = view.regions.iter().find(|r| r.id == "r2").unwrap().clone();
        (r.page, r.x, r.y)
    };
    assert_eq!(region(&session), (2, 99.0, 12.0));
    assert_eq!(session.undo_label(), Some("Move region"));
    let (label, _) = session.undo().unwrap().unwrap();
    assert_eq!(label, "Move region");
    assert_eq!(region(&session), (1, 54.0, 110.0));
    assert!(session.view(&root()).unwrap().can_redo);
    session.redo().unwrap().unwrap();
    assert_eq!(region(&session), (2, 99.0, 12.0));
    assert!(session.undo().unwrap().is_some());
    assert!(session.undo().unwrap().is_none());
}

fn page_setup(
    width: f64,
    height: f64,
    margins: [f64; 4],
    size: &str,
) -> equavela_core::layout::PageSetup {
    equavela_core::layout::PageSetup {
        size: size.into(),
        width,
        height,
        margins: equavela_core::layout::Margins {
            top: margins[0],
            right: margins[1],
            bottom: margins[2],
            left: margins[3],
        },
        header: page_line("", "", ""),
        footer: page_line("", "", ""),
    }
}

/// A header or footer line of the tests.
fn page_line(left: &str, center: &str, right: &str) -> equavela_core::layout::PageLine {
    equavela_core::layout::PageLine {
        left: left.into(),
        center: center.into(),
        right: right.into(),
    }
}

/// the page setup is one undo step, the regions that would sit in the new left or
/// top margin move with it, and undo brings back both the setup and the positions.
#[test]
fn page_setup_moves_the_regions_in_the_margins_and_undoes_with_them() {
    let mut session = session();
    let position = |s: &WorksheetSession, id: &str| {
        let view = s.view(&root()).unwrap();
        let region = view.regions.iter().find(|r| r.id == id).unwrap();
        (region.page, region.x, region.y)
    };
    // Letter landscape (792 x 612) with a wider left margin (80) and a lower top margin (100),
    // and a header and a footer that travel in the same edit.
    let mut letter_landscape = page_setup(792.0, 612.0, [100.0, 40.0, 50.0, 80.0], "Letter");
    letter_landscape.header = page_line("Beam", "Frame", "Page {page}");
    letter_landscape.footer = page_line("{file}", "", "2026-11-04");
    session
        .apply_edit(
            &root(),
            "Page setup",
            EditCommand::SetPageSetup {
                page: letter_landscape.clone(),
            },
        )
        .unwrap();
    let view = session.view(&root()).unwrap();
    assert_eq!((view.page.width, view.page.height), (792.0, 612.0));
    assert_eq!(view.page.size, "Letter");
    // r1 (54, 72) is in both new margins, r2 and r3 only in the left one, r4 is inside.
    assert_eq!(position(&session, "r1"), (1, 80.0, 100.0));
    assert_eq!(position(&session, "r2"), (1, 80.0, 110.0));
    assert_eq!(position(&session, "r3"), (1, 80.0, 140.0));
    assert_eq!(position(&session, "r4"), (1, 200.0, 140.0));
    // The file keeps the named size and the orientation implicit, as worksheet_writer does.
    let document = session.project().document(&root()).unwrap();
    let yaml = equavela_core::worksheet_writer::write_document(document).unwrap();
    assert!(
        yaml.contains("  size: Letter\n  orientation: landscape\n"),
        "{yaml}"
    );
    assert!(
        yaml.contains("margins: {top: 100, right: 40, bottom: 50, left: 80}"),
        "{yaml}"
    );
    // The two lines are written with the setup and are read back from it.
    assert!(
        yaml.contains("  header: {left: Beam, center: Frame, right: \"Page {page}\"}\n"),
        "{yaml}"
    );
    // A value that a plain scalar could read back differently is quoted.
    assert!(
        yaml.contains("  footer: {left: \"{file}\", right: \"2026-11-04\"}\n"),
        "{yaml}"
    );
    // One undo restores the setup and every position it moved.
    assert_eq!(session.undo_label(), Some("Page setup"));
    session.undo().unwrap().unwrap();
    let view = session.view(&root()).unwrap();
    assert_eq!((view.page.width, view.page.height), (612.0, 792.0));
    assert_eq!(
        (view.page.margins.top, view.page.margins.left),
        (50.0, 40.0)
    );
    // Undo takes the header and the footer away too.
    assert!(view.page.header.is_empty() && view.page.footer.is_empty());
    assert_eq!(position(&session, "r1"), (1, 54.0, 72.0));
    assert_eq!(position(&session, "r2"), (1, 54.0, 110.0));
    assert_eq!(position(&session, "r3"), (1, 54.0, 140.0));
    // Redo repeats both.
    session.redo().unwrap().unwrap();
    assert_eq!(position(&session, "r1"), (1, 80.0, 100.0));
    assert_eq!(session.view(&root()).unwrap().page.width, 792.0);
    assert_eq!(session.view(&root()).unwrap().page.header.center, "Frame");
}

/// an invalid setup is refused and changes nothing, and a named size whose
/// dimensions were edited is stored as a custom size.
#[test]
fn page_setup_is_validated_and_keeps_its_size_name_in_step() {
    let mut session = session();
    let before = session.view(&root()).unwrap().page;
    let error = session
        .apply_edit(
            &root(),
            "Page setup",
            EditCommand::SetPageSetup {
                page: page_setup(612.0, 792.0, [400.0, 40.0, 400.0, 40.0], "Letter"),
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("no room"), "{error}");
    let error = session
        .apply_edit(
            &root(),
            "Page setup",
            EditCommand::SetPageSetup {
                page: page_setup(612.0, 792.0, [-1.0, 40.0, 50.0, 40.0], "Letter"),
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("non-negative"), "{error}");
    assert_eq!(session.view(&root()).unwrap().page, before);
    assert_eq!(session.undo_label(), None);
    // A4 in landscape keeps the name; the same name with other dimensions becomes custom.
    session
        .apply_edit(
            &root(),
            "Page setup",
            EditCommand::SetPageSetup {
                page: page_setup(841.89, 595.28, [72.0, 54.0, 72.0, 54.0], "A4"),
            },
        )
        .unwrap();
    assert_eq!(session.view(&root()).unwrap().page.size, "A4");
    session
        .apply_edit(
            &root(),
            "Page setup",
            EditCommand::SetPageSetup {
                page: page_setup(600.0, 595.28, [72.0, 54.0, 72.0, 54.0], "A4"),
            },
        )
        .unwrap();
    assert_eq!(session.view(&root()).unwrap().page.size, "custom");
}

#[test]
fn remove_and_reinsert_keep_text_and_order() {
    let mut session = session();
    let stale = session
        .apply_edit(
            &root(),
            "Delete region",
            EditCommand::Remove {
                region_id: "r2".into(),
            },
        )
        .unwrap();
    // `a` is gone: its dependents are stale/pending.
    assert!(!stale.is_empty() || ids(&session).len() == 3);
    assert_eq!(ids(&session), ["r1", "r3", "r4"]);
    session.undo().unwrap().unwrap();
    assert_eq!(ids(&session), ["r1", "r2", "r3", "r4"]);
    assert_eq!(session.math_text(&root(), "r2"), Some("a := 2"));
    session.redo().unwrap().unwrap();
    assert_eq!(ids(&session), ["r1", "r3", "r4"]);
    assert_eq!(session.math_text(&root(), "r2"), None);
}

#[test]
fn insert_with_fresh_ids_and_batch() {
    let mut session = session();
    let a = session.new_region_id(&root());
    let b = session.new_region_id(&root());
    assert_eq!((a.as_str(), b.as_str()), ("r5", "r6"));
    session
        .apply_edit(
            &root(),
            "Add regions",
            EditCommand::Batch {
                commands: vec![
                    EditCommand::Insert {
                        region: math_region(&a, "c := 5", 54.0, 200.0),
                        index: 99,
                    },
                    EditCommand::Insert {
                        region: math_region(&b, "c =", 200.0, 200.0),
                        index: 99,
                    },
                ],
            },
        )
        .unwrap();
    assert_eq!(ids(&session).len(), 6);
    session.undo().unwrap().unwrap();
    assert_eq!(ids(&session).len(), 4);
    session.redo().unwrap().unwrap();
    assert_eq!(ids(&session).len(), 6);
}

#[test]
fn failed_batch_changes_nothing_and_is_not_recorded() {
    let mut session = session();
    let error = session
        .apply_edit(
            &root(),
            "Broken",
            EditCommand::Batch {
                commands: vec![
                    EditCommand::Move {
                        region_id: "r2".into(),
                        page: 1,
                        x: 1.0,
                        y: 1.0,
                    },
                    EditCommand::Remove {
                        region_id: "nope".into(),
                    },
                ],
            },
        )
        .unwrap_err();
    assert!(matches!(error, SessionError::NotAMathRegion { .. }));
    let view = session.view(&root()).unwrap();
    assert_eq!((view.regions[1].x, view.regions[1].y), (54.0, 110.0));
    assert!(!view.can_undo);
}

#[test]
fn duplicate_ids_and_syntax_errors_are_rejected() {
    let mut session = session();
    let error = session
        .apply_edit(
            &root(),
            "Add",
            EditCommand::Insert {
                region: math_region("r2", "z := 1", 0.0, 0.0),
                index: 0,
            },
        )
        .unwrap_err();
    assert!(matches!(error, SessionError::Edit(_)));
    assert!(matches!(
        session.edit_math(&root(), "r2", "a := := 1").unwrap_err(),
        SessionError::Parse(_)
    ));
    assert_eq!(session.math_text(&root(), "r2"), Some("a := 2"));
}

#[test]
fn editing_math_is_undoable_and_a_new_edit_clears_redo() {
    let mut session = session();
    session.edit_math(&root(), "r2", "a := 10").unwrap();
    assert_eq!(session.math_text(&root(), "r2"), Some("a := 10"));
    session.undo().unwrap().unwrap();
    assert_eq!(session.math_text(&root(), "r2"), Some("a := 2"));
    session.edit_math(&root(), "r2", "a := 7").unwrap();
    assert!(!session.view(&root()).unwrap().can_redo);
}

#[test]
fn moving_a_region_above_another_changes_evaluation_order() {
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Move region",
            EditCommand::Move {
                region_id: "r3".into(),
                page: 1,
                x: 54.0,
                y: 20.0,
            },
        )
        .unwrap();
    // `b := a + 1` is now above `a := 2`: the results list follows the new order.
    let order: Vec<String> = session
        .results()
        .snapshot()
        .iter()
        .map(|entry| entry.key.region_id.clone())
        .collect();
    let b = order.iter().position(|id| id == "r3").unwrap();
    let a = order.iter().position(|id| id == "r2").unwrap();
    assert!(b < a, "{order:?}");
}

#[test]
fn page_errors_are_reported_when_loading() {
    let error = parse_document(
        root(),
        "format: equavela-worksheet/3\npage:\n  size: Nonsense\nregions: []\n",
    )
    .unwrap_err();
    assert!(error.to_string().contains("unknown page size"), "{error}");
}

fn text_region(id: &str, text: &str) -> StoredRegion {
    StoredRegion {
        region: DocumentRegion::Text(equavela_core::layout::TextRegion {
            full_width: false,
            background: None,
            language: None,
            id: id.to_owned(),
            page: 1,
            x: 54.0,
            y: 300.0,
            enabled: true,
            width: None,
            text: equavela_core::richtext::canonical(text),
        }),
        math_text: None,
    }
}

fn text_of(session: &WorksheetSession, id: &str) -> (String, serde_json::Value) {
    let view = session.view(&root()).unwrap();
    let region = view.regions.iter().find(|r| r.id == id).unwrap();
    let ViewContent::Text {
        text, paragraphs, ..
    } = &region.content
    else {
        panic!("text expected");
    };
    (text.clone(), serde_json::to_value(paragraphs).unwrap())
}

#[test]
fn set_text_is_canonical_undoable_and_exposes_structured_runs() {
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Edit text",
            EditCommand::SetText {
                region_id: "r1".into(),
                text: "Beam of $a/b$ m, **very** stiff   \n\n\n\n".into(),
            },
        )
        .unwrap();
    let (text, runs) = text_of(&session, "r1");
    assert_eq!(text, "Beam of $a/b$ m, **very** stiff");
    // A paragraph of the view carries its two attributes and its runs;
    // the defaults are left out of the wire form.
    assert_eq!(
        runs[0]["runs"][0],
        serde_json::json!({"kind": "text", "text": "Beam of "})
    );
    assert_eq!(runs[0]["runs"][1]["kind"], "math");
    assert_eq!(runs[0]["runs"][1]["text"], "a/b");
    assert_eq!(runs[0]["runs"][1]["statement"]["type"], "ExprRegion");
    assert_eq!(runs[0]["runs"][3]["bold"], true);
    assert!(runs[0].get("style").is_none() && runs[0].get("align").is_none());
    // the old text comes back exactly, then the new one again
    session.undo().unwrap().unwrap();
    assert_eq!(text_of(&session, "r1").0, "Heading text");
    session.redo().unwrap().unwrap();
    assert_eq!(text_of(&session, "r1").0, "Beam of $a/b$ m, **very** stiff");
}

#[test]
fn set_text_preserves_disabled_inline_math_attributes_through_undo_redo() {
    let mut session = session();
    let text = "{disabled}{format.precision=4}$a := 2$";
    session
        .apply_edit(
            &root(),
            "Disable inline equation",
            EditCommand::SetText {
                region_id: "r1".into(),
                text: text.into(),
            },
        )
        .unwrap();

    let (canonical, paragraphs) = text_of(&session, "r1");
    assert_eq!(canonical, text);
    assert_eq!(paragraphs[0]["runs"][0]["kind"], "math");
    assert_eq!(paragraphs[0]["runs"][0]["text"], "a := 2");
    assert_eq!(paragraphs[0]["runs"][0]["disabled"], true);
    assert_eq!(
        paragraphs[0]["runs"][0]["format"],
        serde_json::json!({"format.precision": "4"})
    );

    session.undo().unwrap().unwrap();
    assert_eq!(text_of(&session, "r1").0, "Heading text");
    session.redo().unwrap().unwrap();
    let (redone, runs) = text_of(&session, "r1");
    assert_eq!(redone, text);
    assert_eq!(runs[0]["runs"][0]["disabled"], true);
    assert_eq!(
        runs[0]["runs"][0]["format"],
        serde_json::json!({"format.precision": "4"})
    );
}

#[test]
fn a_paragraph_style_and_alignment_survive_an_edit_and_are_written_in_the_text() {
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Edit text",
            EditCommand::SetText {
                region_id: "r1".into(),
                text: "{style=heading1}Chapter 1\n\n{align=center}Simply supported beam".into(),
            },
        )
        .unwrap();
    let (text, paragraphs) = text_of(&session, "r1");
    assert_eq!(
        text,
        "{style=heading1}Chapter 1\n\n{align=center}Simply supported beam"
    );
    assert_eq!(paragraphs[0]["style"], "heading1");
    assert_eq!(paragraphs[1]["align"], "center");
    // one step: the whole text comes back on undo
    session.undo().unwrap().unwrap();
    assert_eq!(text_of(&session, "r1").0, "Heading text");
}

#[test]
fn set_text_rejects_other_regions_and_keeps_the_document() {
    let mut session = session();
    let error = session
        .apply_edit(
            &root(),
            "Edit text",
            EditCommand::SetText {
                region_id: "r2".into(),
                text: "x".into(),
            },
        )
        .unwrap_err();
    assert!(matches!(error, SessionError::Edit(_)), "{error}");
    assert!(session
        .apply_edit(
            &root(),
            "Edit text",
            EditCommand::SetText {
                region_id: "nope".into(),
                text: "x".into(),
            },
        )
        .is_err());
    assert!(session.undo().unwrap().is_none());
}

#[test]
fn text_region_creation_and_set_text_undo_together_in_a_batch() {
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Add text",
            EditCommand::Batch {
                commands: vec![
                    EditCommand::Insert {
                        region: text_region("r9", "first"),
                        index: usize::MAX,
                    },
                    EditCommand::SetText {
                        region_id: "r9".into(),
                        text: "first ^sup^".into(),
                    },
                ],
            },
        )
        .unwrap();
    assert_eq!(text_of(&session, "r9").0, "first ^sup^");
    session.undo().unwrap().unwrap();
    assert!(!ids(&session).contains(&"r9".to_owned()));
    session.redo().unwrap().unwrap();
    assert_eq!(text_of(&session, "r9").0, "first ^sup^");
}

fn width_of(session: &WorksheetSession, id: &str) -> Option<f64> {
    let view = session.view(&root()).unwrap();
    let region = view.regions.iter().find(|r| r.id == id).unwrap();
    let ViewContent::Text { width, .. } = &region.content else {
        panic!("text expected");
    };
    *width
}

#[test]
fn set_width_is_undoable_and_only_for_regions_with_a_width() {
    let mut session = session();
    assert_eq!(width_of(&session, "r1"), None);
    session
        .apply_edit(
            &root(),
            "Resize region",
            EditCommand::SetWidth {
                region_id: "r1".into(),
                width: Some(240.0),
            },
        )
        .unwrap();
    assert_eq!(width_of(&session, "r1"), Some(240.0));
    session.undo().unwrap().unwrap();
    assert_eq!(width_of(&session, "r1"), None);
    session.redo().unwrap().unwrap();
    assert_eq!(width_of(&session, "r1"), Some(240.0));
    for (id, width) in [
        ("r2", Some(100.0)),
        ("r1", Some(-1.0)),
        ("r1", Some(f64::NAN)),
    ] {
        let result = session.apply_edit(
            &root(),
            "Resize region",
            EditCommand::SetWidth {
                region_id: id.into(),
                width,
            },
        );
        assert!(result.is_err(), "{id} {width:?}");
    }
    assert_eq!(width_of(&session, "r1"), Some(240.0));
}

fn background_of(session: &WorksheetSession, id: &str) -> Option<String> {
    let view = session.view(&root()).unwrap();
    let region = view.regions.iter().find(|r| r.id == id).unwrap();
    let ViewContent::Text { background, .. } = &region.content else {
        panic!("text expected");
    };
    background.clone()
}

#[test]
fn the_text_background_is_set_cleared_and_undone() {
    let mut session = session();
    assert_eq!(background_of(&session, "r1"), None);
    let set = |session: &mut WorksheetSession, id: &str, color: Option<&str>| {
        session.apply_edit(
            &root(),
            "Text background",
            EditCommand::SetTextBackground {
                region_id: id.into(),
                background: color.map(str::to_owned),
            },
        )
    };
    set(&mut session, "r1", Some("#FFFFE0")).unwrap();
    assert_eq!(background_of(&session, "r1").as_deref(), Some("#ffffe0"));
    session.undo().unwrap().unwrap();
    assert_eq!(background_of(&session, "r1"), None);
    session.redo().unwrap().unwrap();
    set(&mut session, "r1", None).unwrap();
    assert_eq!(background_of(&session, "r1"), None);
    // Not a colour, or not a text region: refused, nothing changes.
    assert!(set(&mut session, "r1", Some("yellow")).is_err());
    assert!(set(&mut session, "r2", Some("#ffffe0")).is_err());
    assert_eq!(background_of(&session, "r1"), None);
}

fn language_of(session: &WorksheetSession, id: &str) -> Option<String> {
    let view = session.view(&root()).unwrap();
    let region = view.regions.iter().find(|r| r.id == id).unwrap();
    let ViewContent::Text { language, .. } = &region.content else {
        panic!("text expected");
    };
    language.clone()
}

/// the language of a text region and the spelling settings of the worksheet are
/// edits with undo; a value that is not a language id or a key that is not a spelling key is refused.
#[test]
fn the_text_language_and_the_spelling_settings_are_undoable_edits() {
    let mut session = session();
    let language = |session: &mut WorksheetSession, id: &str, value: Option<&str>| {
        session.apply_edit(
            &root(),
            "Language",
            EditCommand::SetTextLanguage {
                region_id: id.into(),
                language: value.map(str::to_owned),
            },
        )
    };
    language(&mut session, "r1", Some("it_IT")).unwrap();
    assert_eq!(language_of(&session, "r1").as_deref(), Some("it_IT"));
    session.undo().unwrap().unwrap();
    assert_eq!(language_of(&session, "r1"), None);
    assert!(language(&mut session, "r1", Some("../it")).is_err());
    assert!(language(&mut session, "r2", Some("it_IT")).is_err());
    let spelling = |session: &mut WorksheetSession, key: &str, value: Option<&str>| {
        session.apply_edit(
            &root(),
            "Spelling",
            EditCommand::SetSpelling {
                values: [(key.to_owned(), value.map(str::to_owned))]
                    .into_iter()
                    .collect(),
            },
        )
    };
    spelling(&mut session, "spelling.ignore", Some("Navier")).unwrap();
    assert_eq!(
        session
            .view(&root())
            .unwrap()
            .settings
            .get("spelling.ignore")
            .map(String::as_str),
        Some("Navier")
    );
    session.undo().unwrap().unwrap();
    assert!(!session
        .view(&root())
        .unwrap()
        .settings
        .contains_key("spelling.ignore"));
    assert!(spelling(&mut session, "TOL", Some("0.1")).is_err());
}

fn format_of(
    session: &WorksheetSession,
    id: &str,
) -> Option<std::collections::BTreeMap<String, String>> {
    let view = session.view(&root()).unwrap();
    let region = view.regions.iter().find(|r| r.id == id).unwrap().clone();
    match &region.content {
        ViewContent::Math { format, .. } => format.clone(),
        _ => panic!("math expected"),
    }
}

fn format(pairs: &[(&str, &str)]) -> Option<std::collections::BTreeMap<String, String>> {
    Some(
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    )
}

#[test]
fn result_format_override_is_a_region_property_with_undo_redo() {
    let mut session = session();
    assert_eq!(format_of(&session, "r2"), None);
    let scientific = format(&[("format.type", "scientific"), ("format.precision", "5")]);
    session
        .apply_edit(
            &root(),
            "Result format",
            EditCommand::SetResultFormat {
                region_id: "r2".into(),
                format: scientific.clone(),
            },
        )
        .unwrap();
    assert_eq!(format_of(&session, "r2"), scientific);
    session.undo().unwrap().unwrap();
    assert_eq!(format_of(&session, "r2"), None);
    session.redo().unwrap().unwrap();
    assert_eq!(format_of(&session, "r2"), scientific);
    // an empty map clears it
    session
        .apply_edit(
            &root(),
            "Result format",
            EditCommand::SetResultFormat {
                region_id: "r2".into(),
                format: Some(Default::default()),
            },
        )
        .unwrap();
    assert_eq!(format_of(&session, "r2"), None);
    // text regions have none, unknown regions fail
    for id in ["r1", "nope"] {
        let result = session.apply_edit(
            &root(),
            "Result format",
            EditCommand::SetResultFormat {
                region_id: id.into(),
                format: scientific.clone(),
            },
        );
        assert!(result.is_err(), "{id}");
    }
}

#[test]
fn deleting_a_region_and_undoing_brings_its_result_format_back() {
    let mut session = session();
    let percent = format(&[("format.type", "percent")]);
    session
        .apply_edit(
            &root(),
            "Result format",
            EditCommand::SetResultFormat {
                region_id: "r2".into(),
                format: percent.clone(),
            },
        )
        .unwrap();
    session
        .apply_edit(
            &root(),
            "Delete",
            EditCommand::Remove {
                region_id: "r2".into(),
            },
        )
        .unwrap();
    session.undo().unwrap().unwrap();
    assert_eq!(format_of(&session, "r2"), percent);
    session.redo().unwrap().unwrap();
    assert!(!ids(&session).contains(&"r2".to_owned()));
    session.undo().unwrap().unwrap();
    assert_eq!(format_of(&session, "r2"), percent);
}

/// the math font of a region is part of the same display override as the
/// result format, so it survives undo/redo and comes back with the region when a removal is
/// undone. The command and the storage are the ones of : no new edit command.
#[test]
fn the_math_font_is_stored_with_the_region_display_override() {
    let mut session = session();
    let font = format(&[
        ("math-font.size", "15"),
        ("math-font.color", "#c00000"),
        ("math-font.highlight", "#ffff00"),
    ]);
    session
        .apply_edit(
            &root(),
            "Math font",
            EditCommand::SetResultFormat {
                region_id: "r2".into(),
                format: font.clone(),
            },
        )
        .unwrap();
    assert_eq!(format_of(&session, "r2"), font);
    session.undo().unwrap().unwrap();
    assert_eq!(format_of(&session, "r2"), None);
    session.redo().unwrap().unwrap();
    assert_eq!(format_of(&session, "r2"), font);
    // The display override carries the font beside the result-format keys and the table box:
    // resetting one leaves the others alone.
    let mixed = format(&[
        ("format.type", "percent"),
        ("math-font.size", "20"),
        ("result-table-size", "480,180"),
    ]);
    session
        .apply_edit(
            &root(),
            "Math font",
            EditCommand::SetResultFormat {
                region_id: "r3".into(),
                format: mixed.clone(),
            },
        )
        .unwrap();
    assert_eq!(format_of(&session, "r3"), mixed);
    session
        .apply_edit(
            &root(),
            "Delete",
            EditCommand::Remove {
                region_id: "r3".into(),
            },
        )
        .unwrap();
    session.undo().unwrap().unwrap();
    assert_eq!(format_of(&session, "r3"), mixed);
    // A text region has no font of its own, and an unknown region fails.
    for id in ["r1", "nope"] {
        let result = session.apply_edit(
            &root(),
            "Math font",
            EditCommand::SetResultFormat {
                region_id: id.into(),
                format: font.clone(),
            },
        );
        assert!(result.is_err(), "{id}");
    }
}

const SETTINGS_SHEET: &str = r#"format: equavela-worksheet/3
settings:
  TOL: 0.5
  format.precision: 3
regions:
  - id: r1
    page: 1
    at: [54, 110]
    math: "a := 2"
"#;

fn settings_of(session: &WorksheetSession) -> std::collections::BTreeMap<String, String> {
    session.view(&root()).unwrap().settings
}

#[test]
fn worksheet_result_defaults_are_one_undo_step_and_leave_other_settings_alone() {
    let mut session = session_of(SETTINGS_SHEET);
    let defaults = |pairs: &[(&str, Option<&str>)]| EditCommand::SetResultDefaults {
        values: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.map(str::to_owned)))
            .collect(),
    };
    assert_eq!(settings_of(&session)["format.precision"], "3");
    session
        .apply_edit(
            &root(),
            "Worksheet format",
            defaults(&[("format.type", Some("decimal")), ("format.precision", None)]),
        )
        .unwrap();
    // Display only: the default goes in `settings:`, no region gets an override.
    assert_eq!(format_of(&session, "r1"), None);
    let view = settings_of(&session);
    assert_eq!(view["format.type"], "decimal");
    assert!(!view.contains_key("format.precision"));
    assert_eq!(view["TOL"], "0.5");
    session.undo().unwrap().unwrap();
    let view = settings_of(&session);
    assert_eq!(view["format.precision"], "3");
    assert!(!view.contains_key("format.type"));
    session.redo().unwrap().unwrap();
    assert_eq!(settings_of(&session)["format.type"], "decimal");
    // A calculation setting has no edit path: it would change results without a recalculation.
    for key in ["TOL", "exact-boolean", "array-origin", ""] {
        let result = session.apply_edit(&root(), "Worksheet format", defaults(&[(key, Some("1"))]));
        assert!(result.is_err(), "{key}");
    }
    assert_eq!(settings_of(&session)["TOL"], "0.5");
    assert!(!settings_of(&session).contains_key("exact-boolean"));
}

#[test]
fn calculation_settings_are_one_undo_step_and_only_the_two_tolerances() {
    let mut session = session_of(SETTINGS_SHEET);
    let tolerances = |pairs: &[(&str, Option<&str>)]| EditCommand::SetCalculationSettings {
        values: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.map(str::to_owned)))
            .collect(),
    };
    // Apply keeps the display settings it does not touch and writes both tolerances.
    session
        .apply_edit(
            &root(),
            "Calculation settings",
            tolerances(&[("TOL", Some("0.25")), ("CTOL", Some("0.5"))]),
        )
        .unwrap();
    let view = settings_of(&session);
    assert_eq!(view["TOL"], "0.25");
    assert_eq!(view["CTOL"], "0.5");
    assert_eq!(view["format.precision"], "3");
    // Undo and redo are the same command with the previous values.
    session.undo().unwrap().unwrap();
    let view = settings_of(&session);
    assert_eq!(view["TOL"], "0.5");
    assert!(!view.contains_key("CTOL"));
    session.redo().unwrap().unwrap();
    assert_eq!(settings_of(&session)["TOL"], "0.25");
    // Reset removes both keys.
    session
        .apply_edit(
            &root(),
            "Calculation settings",
            tolerances(&[("TOL", None), ("CTOL", None)]),
        )
        .unwrap();
    let view = settings_of(&session);
    assert!(!view.contains_key("TOL"));
    assert!(!view.contains_key("CTOL"));
    // Nothing else has an edit path here: a display setting belongs to SetResultDefaults and
    // the settings this feature does not model are refused.
    for key in ["format.type", "exact-boolean", "array-origin", "origin", ""] {
        let result = session.apply_edit(
            &root(),
            "Calculation settings",
            tolerances(&[(key, Some("1"))]),
        );
        assert!(result.is_err(), "{key}");
    }
    let view = settings_of(&session);
    assert!(!view.contains_key("format.type"));
    assert!(!view.contains_key("exact-boolean"));
    assert!(!view.contains_key("origin"));
    // ORIGIN is a calculation setting like the tolerances.
    session
        .apply_edit(
            &root(),
            "Calculation settings",
            tolerances(&[("ORIGIN", Some("1"))]),
        )
        .unwrap();
    assert_eq!(settings_of(&session)["ORIGIN"], "1");
}

#[test]
fn applying_the_tolerances_a_worksheet_already_has_is_not_an_edit() {
    let mut session = session_of(SETTINGS_SHEET);
    let tolerances = EditCommand::SetCalculationSettings {
        values: [("TOL".to_owned(), Some("0.5".to_owned()))].into(),
    };
    // The file already stores `TOL: 0.5`: the command changes nothing, so it is no undo step
    // and it does not clear the redo stack.
    session.undo().unwrap();
    let view = session.view(&root()).unwrap();
    assert!(!view.can_undo);
    session
        .apply_edit(&root(), "Calculation settings", tolerances)
        .unwrap();
    assert!(!session.view(&root()).unwrap().can_undo);
    assert_eq!(settings_of(&session)["TOL"], "0.5");
}

#[test]
fn label_styles_are_one_undo_step_of_display_settings() {
    let mut session = session_of(SETTINGS_SHEET);
    let styles = |pairs: &[(&str, Option<&str>)]| EditCommand::SetLabelStyles {
        values: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.map(str::to_owned)))
            .collect(),
    };
    // Apply writes the keys of every style of the dialog, one undo step for all of them.
    session
        .apply_edit(
            &root(),
            "Label styles",
            styles(&[
                ("label-style.var.color", Some("#c00000")),
                ("label-style.var.italic", Some("false")),
                ("label-style.unit.bold", Some("true")),
            ]),
        )
        .unwrap();
    let view = settings_of(&session);
    assert_eq!(view["label-style.var.color"], "#c00000");
    assert_eq!(view["label-style.var.italic"], "false");
    assert_eq!(view["label-style.unit.bold"], "true");
    // Display only: the other settings are left alone and no region gets an override.
    assert_eq!(view["TOL"], "0.5");
    assert_eq!(view["format.precision"], "3");
    assert_eq!(format_of(&session, "r1"), None);
    // Undo is the same command with the previous values, which were absent; redo writes them again.
    session.undo().unwrap().unwrap();
    let view = settings_of(&session);
    assert!(!view.contains_key("label-style.var.color"));
    assert!(!view.contains_key("label-style.var.italic"));
    assert!(!view.contains_key("label-style.unit.bold"));
    session.redo().unwrap().unwrap();
    assert_eq!(settings_of(&session)["label-style.var.color"], "#c00000");
    // Reset of one style removes its own keys only.
    session
        .apply_edit(
            &root(),
            "Label styles",
            styles(&[
                ("label-style.var.color", None),
                ("label-style.var.italic", None),
            ]),
        )
        .unwrap();
    let view = settings_of(&session);
    assert!(!view.contains_key("label-style.var.color"));
    assert!(!view.contains_key("label-style.var.italic"));
    assert_eq!(view["label-style.unit.bold"], "true");
    // Nothing else has an edit path here: a result format, a calculation setting, an unknown label
    // or an unknown property is refused.
    for key in [
        "format.type",
        "TOL",
        "label-style",
        "label-style.var",
        "label-style.var.strikeout",
        "label-style.keyword.bold",
        "label-style.var.bold.extra",
        "",
    ] {
        let result = session.apply_edit(&root(), "Label styles", styles(&[(key, Some("1"))]));
        assert!(result.is_err(), "{key}");
    }
    assert_eq!(settings_of(&session)["label-style.unit.bold"], "true");
    assert!(!settings_of(&session).contains_key("format.type"));
}

#[test]
fn a_label_style_the_worksheet_already_has_is_not_an_edit() {
    let mut session = session_of(SETTINGS_SHEET);
    let styles = |pairs: &[(&str, Option<&str>)]| EditCommand::SetLabelStyles {
        values: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.map(str::to_owned)))
            .collect(),
    };
    session
        .apply_edit(
            &root(),
            "Label styles",
            styles(&[("label-style.var.color", Some("#c00000"))]),
        )
        .unwrap();
    session.undo().unwrap().unwrap();
    assert!(!session.view(&root()).unwrap().can_undo);
    // An Apply that removes nothing (every key already absent) writes nothing: no undo step.
    // The canonical choice of "a value at the built-in is not stored" is the dialog's,
    // as for `format.*`.
    session
        .apply_edit(
            &root(),
            "Label styles",
            styles(&[
                ("label-style.var.color", None),
                ("label-style.var.italic", None),
            ]),
        )
        .unwrap();
    assert!(!session.view(&root()).unwrap().can_undo);
    assert!(!settings_of(&session).contains_key("label-style.var.color"));
    // Reset of a style that carries no key writes nothing either.
    session
        .apply_edit(
            &root(),
            "Label styles",
            styles(&[
                ("label-style.unit.bold", None),
                ("label-style.unit.color", None),
            ]),
        )
        .unwrap();
    assert!(!session.view(&root()).unwrap().can_undo);
    // A command that does remove a stored value is an edit, with its inverse.
    session
        .apply_edit(
            &root(),
            "Label styles",
            styles(&[("label-style.kw.bold", Some("false"))]),
        )
        .unwrap();
    assert!(session.view(&root()).unwrap().can_undo);
    session
        .apply_edit(
            &root(),
            "Label styles",
            styles(&[("label-style.kw.bold", None)]),
        )
        .unwrap();
    assert!(!settings_of(&session).contains_key("label-style.kw.bold"));
}

#[test]
fn label_styles_survive_a_saved_file() {
    let mut document = parse_document(root(), SETTINGS_SHEET).unwrap().document;
    let mut texts = HashMap::new();
    equavela_core::edit::apply(
        &mut document,
        &mut texts,
        EditCommand::SetLabelStyles {
            values: [
                (
                    "label-style.var.color".to_owned(),
                    Some("#c00000".to_owned()),
                ),
                (
                    "label-style.var.italic".to_owned(),
                    Some("false".to_owned()),
                ),
                ("label-style.kw.bold".to_owned(), Some("false".to_owned())),
            ]
            .into_iter()
            .collect(),
        },
    )
    .unwrap();
    let text = equavela_core::worksheet_writer::write_document(&document).unwrap();
    // Settings are sorted: the flags are bare booleans and the colour is quoted.
    assert!(
        text.contains(
            "settings:\n  TOL: \"0.5\"\n  format.precision: 3\n  label-style.kw.bold: false\n  label-style.var.color: \"#c00000\"\n  label-style.var.italic: false\n"
        ),
        "{text}"
    );
    let back = parse_document(root(), &text).unwrap().document;
    assert_eq!(back.settings.values["label-style.var.color"], "#c00000");
    assert_eq!(back.settings.values["label-style.var.italic"], "false");
    assert_eq!(back.settings.values["label-style.kw.bold"], "false");
}

#[test]
fn calculation_settings_survive_a_saved_file() {
    let mut document = parse_document(root(), SETTINGS_SHEET).unwrap().document;
    let mut texts = HashMap::new();
    equavela_core::edit::apply(
        &mut document,
        &mut texts,
        EditCommand::SetCalculationSettings {
            values: [
                ("TOL".to_owned(), Some("0.25".to_owned())),
                ("CTOL".to_owned(), Some("0.5".to_owned())),
            ]
            .into_iter()
            .collect(),
        },
    )
    .unwrap();
    let text = equavela_core::worksheet_writer::write_document(&document).unwrap();
    assert!(
        text.contains("settings:\n  CTOL: \"0.5\"\n  TOL: \"0.25\"\n"),
        "{text}"
    );
    let back = parse_document(root(), &text).unwrap().document;
    assert_eq!(back.settings.values["TOL"], "0.25");
    assert_eq!(back.settings.values["CTOL"], "0.5");
}

#[test]
fn worksheet_result_defaults_survive_a_saved_file() {
    let mut document = parse_document(root(), SETTINGS_SHEET).unwrap().document;
    let mut texts = HashMap::new();
    equavela_core::edit::apply(
        &mut document,
        &mut texts,
        EditCommand::SetResultDefaults {
            values: [
                ("format.type".to_owned(), Some("engineering".to_owned())),
                ("format.precision".to_owned(), None),
            ]
            .into_iter()
            .collect(),
        },
    )
    .unwrap();
    let text = equavela_core::worksheet_writer::write_document(&document).unwrap();
    assert!(
        text.contains("settings:\n  TOL: \"0.5\"\n  format.type: engineering\n"),
        "{text}"
    );
    let back = parse_document(root(), &text).unwrap().document;
    assert_eq!(back.settings.values["format.type"], "engineering");
    assert!(!back.settings.values.contains_key("format.precision"));
    assert_eq!(back.settings.values["TOL"], "0.5");
}

#[test]
fn the_result_format_commands_carry_the_radix_trailing_zeros_and_the_thresholds() {
    // the specification, the specification : both levels take the five keys of
    // the Results group, one undo step each, and the saved file keeps them.
    let mut session = session_of(SETTINGS_SHEET);
    let defaults = |pairs: &[(&str, &str)]| EditCommand::SetResultDefaults {
        values: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Some((*value).to_owned())))
            .collect(),
    };
    let five = [
        ("format.radix", "binary"),
        ("format.trailing-zeros", "true"),
        ("format.exp-threshold", "6"),
        ("format.zero-threshold", "9"),
        ("format.complex-threshold", "4"),
    ];
    session
        .apply_edit(&root(), "Worksheet format", defaults(&five))
        .unwrap();
    let settings = settings_of(&session);
    for (key, value) in five {
        assert_eq!(settings[key], value, "{key}");
    }
    // Display only: the region carries no override of its own.
    assert_eq!(format_of(&session, "r1"), None);
    // A region override takes the same keys, and the worksheet default above stays.
    let own = format(&[
        ("format.radix", "hexadecimal"),
        ("format.exp-threshold", "6"),
    ]);
    session
        .apply_edit(
            &root(),
            "Result format",
            EditCommand::SetResultFormat {
                region_id: "r1".into(),
                format: own.clone(),
            },
        )
        .unwrap();
    assert_eq!(format_of(&session, "r1"), own);
    session.undo().unwrap().unwrap();
    assert_eq!(format_of(&session, "r1"), None);
    assert_eq!(settings_of(&session)["format.radix"], "binary");
    // Removing the five keys is reset, one undo step.
    session
        .apply_edit(
            &root(),
            "Worksheet format",
            EditCommand::SetResultDefaults {
                values: five
                    .iter()
                    .map(|(key, _)| ((*key).to_owned(), None))
                    .collect(),
            },
        )
        .unwrap();
    let settings = settings_of(&session);
    for (key, _) in five {
        assert!(!settings.contains_key(key), "{key}");
    }
    assert_eq!(settings["format.precision"], "3");
    session.undo().unwrap().unwrap();
    assert_eq!(settings_of(&session)["format.zero-threshold"], "9");
}

#[test]
fn the_radix_and_the_thresholds_survive_a_saved_file() {
    let mut document = parse_document(root(), SETTINGS_SHEET).unwrap().document;
    let mut texts = HashMap::new();
    equavela_core::edit::apply(
        &mut document,
        &mut texts,
        EditCommand::SetResultDefaults {
            values: [
                ("format.radix".to_owned(), Some("hexadecimal".to_owned())),
                ("format.trailing-zeros".to_owned(), Some("true".to_owned())),
                ("format.zero-threshold".to_owned(), Some("12".to_owned())),
            ]
            .into_iter()
            .collect(),
        },
    )
    .unwrap();
    equavela_core::edit::apply(
        &mut document,
        &mut texts,
        EditCommand::SetResultFormat {
            region_id: "r1".into(),
            format: format(&[("format.radix", "octal"), ("format.exp-threshold", "6")]),
        },
    )
    .unwrap();
    let text = equavela_core::worksheet_writer::write_document(&document).unwrap();
    // a boolean is bare, an integer is bare, a word is a plain scalar.
    assert!(text.contains("format.trailing-zeros: true\n"), "{text}");
    assert!(text.contains("format.zero-threshold: 12\n"), "{text}");
    assert!(text.contains("format.radix: hexadecimal\n"), "{text}");
    assert!(
        text.contains("    format:\n      format.exp-threshold: 6\n      format.radix: octal\n"),
        "{text}"
    );
    let back = parse_document(root(), &text).unwrap().document;
    assert_eq!(back.settings.values["format.radix"], "hexadecimal");
    assert_eq!(back.settings.values["format.trailing-zeros"], "true");
    assert_eq!(back.settings.values["format.zero-threshold"], "12");
    assert_eq!(back.settings.values["TOL"], "0.5");
    let region = back.result_formats.get("r1").unwrap();
    assert_eq!(region["format.radix"], "octal");
    assert_eq!(region["format.exp-threshold"], "6");
}

#[test]
fn worksheet_files_read_the_result_format_of_a_region() {
    let text = "format: equavela-worksheet/3\nregions:\n  - id: m\n    at: [0, 0]\n    math: \"x := 0.5\"\n    format: {format.type: percent, format.precision: 2}\n  - id: n\n    at: [0, 20]\n    math: \"y := 1\"\n";
    let loaded =
        equavela_core::worksheet_file::parse_document(DocumentId::new("/f.eqv").unwrap(), text)
            .unwrap();
    let formats = &loaded.document.result_formats;
    assert_eq!(formats.len(), 1);
    assert_eq!(formats["m"]["format.type"], "percent");
    assert_eq!(formats["m"]["format.precision"], "2");
}

#[test]
fn set_plot_is_validated_and_undone_by_its_inverse() {
    use equavela_core::edit::{apply, EditCommand, EditError, StoredRegion};
    use equavela_core::plot::{PlotRegion, PlotSpec};
    use equavela_core::project::{
        CalculationSettings, DocumentId, DocumentRegion, ProjectDocument,
    };
    let id = DocumentId::new("/p.eqv").unwrap();
    let mut document = ProjectDocument {
        id,
        content_hash: "h".into(),
        settings: CalculationSettings::default(),
        environment: None,
        page: Default::default(),
        result_formats: Default::default(),
        math_breaks: Default::default(),
        resources: Default::default(),
        assets: Default::default(),
        page_breaks: Vec::new(),
        regions: vec![],
    };
    let mut texts = std::collections::HashMap::new();
    let region = DocumentRegion::Plot(Box::new(PlotRegion::new(
        "p",
        1,
        0.0,
        0.0,
        PlotSpec::new_xy(),
    )));
    apply(
        &mut document,
        &mut texts,
        EditCommand::Insert {
            region: StoredRegion {
                region,
                math_text: None,
            },
            index: 0,
        },
    )
    .unwrap();
    let mut edited = PlotSpec::new_xy();
    edited.traces[0].x = "x".into();
    edited.traces[0].y = "f(x)".into();
    edited.size = [400.0, 300.0];
    let inverse = apply(
        &mut document,
        &mut texts,
        EditCommand::SetPlot {
            region_id: "p".into(),
            plot: Box::new(edited.clone()),
        },
    )
    .unwrap();
    let DocumentRegion::Plot(region) = document.regions[0].as_ref() else {
        panic!()
    };
    assert_eq!(region.plot, edited);
    let mut bad = edited.clone();
    bad.traces[0].y = "(".into();
    assert!(matches!(
        apply(
            &mut document,
            &mut texts,
            EditCommand::SetPlot {
                region_id: "p".into(),
                plot: Box::new(bad),
            }
        ),
        Err(EditError::BadPlot(_))
    ));
    apply(&mut document, &mut texts, inverse).unwrap();
    let DocumentRegion::Plot(region) = document.regions[0].as_ref() else {
        panic!()
    };
    assert_eq!(region.plot, PlotSpec::new_xy());
    assert!(matches!(
        apply(
            &mut document,
            &mut texts,
            EditCommand::SetPlot {
                region_id: "nope".into(),
                plot: Box::new(edited),
            }
        ),
        Err(EditError::NoSuchRegion(_))
    ));
}

fn image_commands(resource_id: &str, region_id: &str) -> EditCommand {
    use equavela_core::image::{ImageMedia, ImageRegion, ImageResource};
    EditCommand::Batch {
        commands: vec![
            EditCommand::AddResource {
                id: resource_id.to_owned(),
                resource: ImageResource {
                    media: ImageMedia::Png,
                    data: vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10],
                },
            },
            EditCommand::Insert {
                region: StoredRegion {
                    region: DocumentRegion::Image(ImageRegion {
                        id: region_id.to_owned(),
                        page: 1,
                        x: 60.0,
                        y: 200.0,
                        enabled: true,
                        resource: resource_id.to_owned(),
                        size: [100.0, 50.0],
                    }),
                    math_text: None,
                },
                index: usize::MAX,
            },
        ],
    }
}

fn resource_ids(session: &WorksheetSession) -> Vec<String> {
    session
        .project()
        .document(&root())
        .unwrap()
        .resources
        .keys()
        .cloned()
        .collect()
}

#[test]
fn image_insert_resize_move_and_remove_are_undoable() {
    let mut session = session();
    session
        .apply_edit(&root(), "Add image", image_commands("img1", "r9"))
        .unwrap();
    assert_eq!(resource_ids(&session), ["img1"]);
    let view = session.view(&root()).unwrap();
    let region = view.regions.iter().find(|r| r.id == "r9").unwrap();
    assert!(matches!(
        region.content,
        ViewContent::Image { size: [w, h], .. } if w == 100.0 && h == 50.0
    ));

    session
        .apply_edit(
            &root(),
            "Resize image",
            EditCommand::SetImageSize {
                region_id: "r9".into(),
                size: [150.004, 75.0],
            },
        )
        .unwrap();
    let size = |session: &WorksheetSession| match session
        .view(&root())
        .unwrap()
        .regions
        .iter()
        .find(|r| r.id == "r9")
        .unwrap()
        .content
    {
        ViewContent::Image { size, .. } => size,
        _ => panic!("not an image"),
    };
    assert_eq!(size(&session), [150.0, 75.0]);
    // Too small, not finite, and not an image region are refused.
    for bad in [[5.0, 75.0], [f64::NAN, 20.0]] {
        assert!(session
            .apply_edit(
                &root(),
                "x",
                EditCommand::SetImageSize {
                    region_id: "r9".into(),
                    size: bad
                }
            )
            .is_err());
    }
    assert!(session
        .apply_edit(
            &root(),
            "x",
            EditCommand::SetImageSize {
                region_id: "r2".into(),
                size: [20.0, 20.0]
            }
        )
        .is_err());

    session
        .apply_edit(
            &root(),
            "Move",
            EditCommand::Move {
                region_id: "r9".into(),
                page: 1,
                x: 90.0,
                y: 210.0,
            },
        )
        .unwrap();
    session.undo().unwrap();
    session.undo().unwrap();
    assert_eq!(size(&session), [100.0, 50.0]);

    // A resource a region uses cannot be dropped; deleting the region and undoing brings it back.
    assert!(session
        .apply_edit(
            &root(),
            "x",
            EditCommand::DropResource { id: "img1".into() }
        )
        .is_err());
    session
        .apply_edit(
            &root(),
            "Delete",
            EditCommand::Remove {
                region_id: "r9".into(),
            },
        )
        .unwrap();
    session.undo().unwrap();
    assert!(ids(&session).contains(&"r9".to_owned()));

    // Undoing the insertion removes both the region and the resource; redo restores both.
    session.undo().unwrap();
    assert!(!ids(&session).contains(&"r9".to_owned()));
    assert!(resource_ids(&session).is_empty());
    session.redo().unwrap();
    assert!(ids(&session).contains(&"r9".to_owned()));
    assert_eq!(resource_ids(&session), ["img1"]);
}

#[test]
fn an_image_resource_can_be_replaced_and_the_swap_undoes_as_one_step() {
    use equavela_core::image::{ImageMedia, ImageResource};
    let mut session = session();
    session
        .apply_edit(&root(), "Add image", image_commands("img1", "r9"))
        .unwrap();
    let resource_of = |session: &WorksheetSession| {
        let view = session.view(&root()).unwrap();
        match &view.regions.iter().find(|r| r.id == "r9").unwrap().content {
            ViewContent::Image { resource, .. } => resource.clone(),
            _ => panic!("not an image"),
        }
    };
    assert_eq!(resource_of(&session), "img1");
    // Another resource and the swap, as one batch (the shape the Replace command uses).
    session
        .apply_edit(
            &root(),
            "Replace image",
            EditCommand::Batch {
                commands: vec![
                    EditCommand::AddResource {
                        id: "img2".into(),
                        resource: ImageResource {
                            media: ImageMedia::Jpeg,
                            data: vec![0xFF, 0xD8, 0xFF],
                        },
                    },
                    EditCommand::SetImageResource {
                        region_id: "r9".into(),
                        resource: "img2".into(),
                    },
                    EditCommand::DropResource { id: "img1".into() },
                ],
            },
        )
        .unwrap();
    assert_eq!(resource_of(&session), "img2");
    assert_eq!(resource_ids(&session), ["img2"]);
    session.undo().unwrap();
    assert_eq!(resource_of(&session), "img1");
    assert_eq!(resource_ids(&session), ["img1"]);
    // A resource that is not stored, and a region that is not an image, are refused.
    assert!(session
        .apply_edit(
            &root(),
            "x",
            EditCommand::SetImageResource {
                region_id: "r9".into(),
                resource: "img9".into()
            }
        )
        .is_err());
    assert!(session
        .apply_edit(
            &root(),
            "x",
            EditCommand::SetImageResource {
                region_id: "r2".into(),
                resource: "img1".into()
            }
        )
        .is_err());
    assert_eq!(resource_of(&session), "img1");
}

#[test]
fn adding_a_resource_twice_is_idempotent_and_a_conflict_is_refused() {
    use equavela_core::image::{ImageMedia, ImageResource};
    let mut session = session();
    session
        .apply_edit(&root(), "Add image", image_commands("img1", "r9"))
        .unwrap();
    let same = ImageResource {
        media: ImageMedia::Png,
        data: vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10],
    };
    session
        .apply_edit(
            &root(),
            "x",
            EditCommand::AddResource {
                id: "img1".into(),
                resource: same,
            },
        )
        .unwrap();
    let other = ImageResource {
        media: ImageMedia::Jpeg,
        data: vec![0xFF, 0xD8, 0xFF],
    };
    assert!(session
        .apply_edit(
            &root(),
            "x",
            EditCommand::AddResource {
                id: "img1".into(),
                resource: other
            }
        )
        .is_err());
}

#[test]
fn a_new_image_fits_the_printable_width_keeping_its_aspect_ratio() {
    use equavela_core::image::initial_size_pt;
    assert_eq!(initial_size_pt(Some([100.0, 50.0]), 400.0), [100.0, 50.0]);
    assert_eq!(initial_size_pt(Some([800.0, 400.0]), 400.0), [400.0, 200.0]);
    assert_eq!(initial_size_pt(None, 400.0), [144.0, 108.0]);
    assert_eq!(initial_size_pt(Some([1000.0, 1.0]), 400.0), [400.0, 12.0]);
}

/// Whether the region with `id` takes part in the calculation, as the UI sees it.
fn enabled_of(session: &WorksheetSession, id: &str) -> bool {
    session
        .view(&root())
        .unwrap()
        .regions
        .iter()
        .find(|region| region.id == id)
        .unwrap()
        .enabled
}

/// The ids of the regions that have a result entry.
fn result_ids(session: &WorksheetSession) -> Vec<String> {
    session
        .results()
        .snapshot()
        .into_iter()
        .map(|entry| entry.key.region_id)
        .collect()
}

#[test]
fn disabling_a_region_undoes_and_leaves_its_dependents_without_a_definition() {
    let mut session = session();
    assert!(enabled_of(&session, "r2"));
    // `b := a + 1` and `b =` are the dependents of `a`.
    assert_eq!(result_ids(&session), ["r2", "r3", "r4"]);

    session
        .apply_edit(
            &root(),
            "Disable region",
            EditCommand::SetEnabled {
                region_id: "r2".into(),
                enabled: false,
            },
        )
        .unwrap();
    assert!(!enabled_of(&session, "r2"));
    // The region keeps its content and place; only its evaluation stops.
    assert_eq!(session.math_text(&root(), "r2"), Some("a := 2"));
    let view = session.view(&root()).unwrap();
    assert_eq!((view.regions[1].x, view.regions[1].y), (54.0, 110.0));
    // No result of its own, and its definitions are not visible below.
    assert_eq!(result_ids(&session), ["r3", "r4"]);
    let analysis = session.project().analyze(&root()).unwrap();
    let unresolved: Vec<&str> = analysis
        .unresolved_references()
        .iter()
        .filter_map(|reference| reference.name.as_simple())
        .collect();
    // `b := a + 1` is the only region whose name is undefined now.
    assert_eq!(unresolved, ["a"]);

    assert_eq!(session.undo_label(), Some("Disable region"));
    session.undo().unwrap().unwrap();
    assert!(enabled_of(&session, "r2"));
    assert_eq!(result_ids(&session), ["r2", "r3", "r4"]);
    assert!(session
        .project()
        .analyze(&root())
        .unwrap()
        .unresolved_references()
        .is_empty());
    session.redo().unwrap().unwrap();
    assert!(!enabled_of(&session, "r2"));
}

#[test]
fn a_disabled_region_can_be_enabled_again_and_an_unknown_id_is_refused() {
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Disable region",
            EditCommand::SetEnabled {
                region_id: "r3".into(),
                enabled: false,
            },
        )
        .unwrap();
    assert!(!enabled_of(&session, "r3"));
    // Enabling is the inverse command of disabling, so it needs no separate edit to be undoable.
    session.undo().unwrap().unwrap();
    session
        .apply_edit(
            &root(),
            "Enable region",
            EditCommand::SetEnabled {
                region_id: "r3".into(),
                enabled: true,
            },
        )
        .unwrap();
    assert!(enabled_of(&session, "r3"));
    assert!(session
        .apply_edit(
            &root(),
            "Disable region",
            EditCommand::SetEnabled {
                region_id: "nope".into(),
                enabled: false,
            },
        )
        .is_err());
}

#[test]
fn a_disabled_region_is_written_to_the_file_and_reads_back_disabled() {
    use equavela_core::worksheet_writer::write_document;
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Disable region",
            EditCommand::SetEnabled {
                region_id: "r2".into(),
                enabled: false,
            },
        )
        .unwrap();
    let document = session.project().document(&root()).unwrap().clone();
    let text = write_document(&document).unwrap();
    assert!(text.contains("enabled: false"), "{text}");
    let loaded = parse_document(root(), &text).unwrap();
    let disabled = loaded
        .document
        .regions
        .iter()
        .find(|region| region.id() == "r2")
        .unwrap();
    assert!(!disabled.enabled());
}

/// A worksheet with one Julia block: a hand-written `using` the code does not contain, an
/// explicit `define`, a stopped state, a stored box and one line of code.
const JULIA_SHEET: &str = r#"format: equavela-worksheet/3
regions:
  - id: j1
    page: 1
    at: [54, 72]
    julia:
      size: [288, 144]
      playing: false
      using: [HandWritten]
      define: [helper]
      code: |
        scale = 2
"#;

fn julia_block(session: &WorksheetSession, id: &str) -> equavela_core::ast::JuliaBlock {
    session
        .view(&root())
        .unwrap()
        .regions
        .iter()
        .find(|region| region.id == id)
        .and_then(|region| match &region.content {
            ViewContent::Julia { block } => Some(block.clone()),
            _ => None,
        })
        .expect("a julia block")
}

/// one code edit derives `using`/`import` from the lines of the code, keeps
/// the play/stop state and `define`, and is one undo step that restores the whole block.
#[test]
fn a_julia_code_edit_derives_the_fields_and_undoes_whole() {
    let mut session = session_of(JULIA_SHEET);
    session
        .apply_edit(
            &root(),
            "Edit Julia code",
            EditCommand::SetJulia {
                region_id: "j1".into(),
                code: "using Statistics\nimport Statistics: mean\nx = 1\n\n".into(),
            },
        )
        .unwrap();
    let block = julia_block(&session, "j1");
    assert_eq!(block.using, ["Statistics"]);
    assert_eq!(block.imports.len(), 1);
    assert_eq!(block.imports[0].name, "mean");
    assert_eq!(block.imports[0].package, "Statistics");
    assert_eq!(block.imports[0].function, "mean");
    // The trailing empty lines stay; `define` and the stopped state stay.
    assert_eq!(
        block.code.as_deref(),
        Some("using Statistics\nimport Statistics: mean\nx = 1\n\n")
    );
    assert_eq!(block.defines, ["helper"]);
    assert!(!block.playing);
    // The box belongs to the region, not to the code: a code edit keeps it.
    assert_eq!(block.size, Some((288.0, 144.0)));
    assert_eq!(session.undo_label(), Some("Edit Julia code"));

    // The hand-written field the code does not contain comes back with the undo.
    session.undo().unwrap().unwrap();
    let restored = julia_block(&session, "j1");
    assert_eq!(restored.using, ["HandWritten"]);
    assert_eq!(restored.code.as_deref(), Some("scale = 2"));
    session.redo().unwrap().unwrap();
    assert_eq!(julia_block(&session, "j1").using, ["Statistics"]);
}

/// a code that derives the fields it already has writes nothing and adds no undo step.
#[test]
fn an_unchanged_julia_code_adds_no_undo_step() {
    let sheet = r#"format: equavela-worksheet/3
regions:
  - id: j1
    page: 1
    at: [54, 72]
    julia:
      using: [Statistics]
      import:
        mean: Statistics.mean
      code: |
        using Statistics
        import Statistics: mean
        x = 1
"#;
    let mut session = session_of(sheet);
    let command = || EditCommand::SetJulia {
        region_id: "j1".into(),
        code: "using Statistics\nimport Statistics: mean\nx = 1".into(),
    };
    session
        .apply_edit(&root(), "Edit Julia code", command())
        .unwrap();
    // The fields are the ones the code derives: nothing changes and there is nothing to undo.
    assert!(!session.view(&root()).unwrap().can_undo);
    assert_eq!(session.undo_label(), None);
}

/// play/stop is one undo step; the same state writes nothing.
#[test]
fn playing_and_stopping_a_julia_block_is_one_undo_step() {
    let mut session = session_of(JULIA_SHEET);
    session
        .apply_edit(
            &root(),
            "Play Julia block",
            EditCommand::SetJuliaPlaying {
                region_id: "j1".into(),
                playing: true,
            },
        )
        .unwrap();
    assert!(julia_block(&session, "j1").playing);
    assert_eq!(session.undo_label(), Some("Play Julia block"));
    session.undo().unwrap().unwrap();
    assert!(!julia_block(&session, "j1").playing);
    assert_eq!(session.undo_label(), None);

    // The state it already has changes nothing and is not an undo step.
    session
        .apply_edit(
            &root(),
            "Stop Julia block",
            EditCommand::SetJuliaPlaying {
                region_id: "j1".into(),
                playing: false,
            },
        )
        .unwrap();
    assert_eq!(session.undo_label(), None);
}

/// setting the box of a Julia block is one undo step that restores the previous size, the
/// size it already has writes nothing, and a size that is not two positive finite numbers, like a
/// region that is not a block, is refused without changing anything.
#[test]
fn resizing_a_julia_block_is_one_undo_step() {
    let mut session = session_of(JULIA_SHEET);
    assert_eq!(julia_block(&session, "j1").size, Some((288.0, 144.0)));
    session
        .apply_edit(
            &root(),
            "Resize Julia block",
            EditCommand::SetJuliaSize {
                region_id: "j1".into(),
                size: Some((360.0, 216.0)),
            },
        )
        .unwrap();
    assert_eq!(julia_block(&session, "j1").size, Some((360.0, 216.0)));
    assert_eq!(session.undo_label(), Some("Resize Julia block"));
    // The stored size is the one the file carries.
    let document = session.project().document(&root()).unwrap().clone();
    let written = write_document(&document).unwrap();
    assert!(written.contains("      size: [360, 216]\n"), "{written}");
    session.undo().unwrap().unwrap();
    assert_eq!(julia_block(&session, "j1").size, Some((288.0, 144.0)));
    assert_eq!(session.undo_label(), None);
    session.redo().unwrap().unwrap();
    assert_eq!(julia_block(&session, "j1").size, Some((360.0, 216.0)));

    // The same size is no edit: it adds no undo step, so one undo still goes back to the size the
    // block had before the drag.
    session
        .apply_edit(
            &root(),
            "Resize Julia block",
            EditCommand::SetJuliaSize {
                region_id: "j1".into(),
                size: Some((360.0, 216.0)),
            },
        )
        .unwrap();
    assert_eq!(session.undo_label(), Some("Resize Julia block"));
    session.undo().unwrap().unwrap();
    assert_eq!(julia_block(&session, "j1").size, Some((288.0, 144.0)));
    assert_eq!(session.undo_label(), None);
    session.redo().unwrap().unwrap();
    assert_eq!(julia_block(&session, "j1").size, Some((360.0, 216.0)));

    // A refused size changes nothing.
    for size in [
        Some((0.0, 144.0)),
        Some((288.0, -1.0)),
        Some((f64::NAN, 144.0)),
        Some((288.0, f64::INFINITY)),
    ] {
        assert!(session
            .apply_edit(
                &root(),
                "Resize Julia block",
                EditCommand::SetJuliaSize {
                    region_id: "j1".into(),
                    size,
                },
            )
            .is_err());
    }
    assert_eq!(julia_block(&session, "j1").size, Some((360.0, 216.0)));

    // A block that is not resized yet goes back to the size it grows to (`null`).
    session
        .apply_edit(
            &root(),
            "Resize Julia block",
            EditCommand::SetJuliaSize {
                region_id: "j1".into(),
                size: None,
            },
        )
        .unwrap();
    assert_eq!(julia_block(&session, "j1").size, None);
}

/// The commands refuse a region that is not a Julia block, and change nothing when they do.
#[test]
fn julia_commands_refuse_other_regions() {
    let mut session = session();
    for command in [
        EditCommand::SetJulia {
            region_id: "r2".into(),
            code: "x = 1".into(),
        },
        EditCommand::SetJuliaPlaying {
            region_id: "r2".into(),
            playing: true,
        },
        EditCommand::SetJuliaBlock {
            region_id: "r2".into(),
            block: equavela_core::ast::JuliaBlock::default(),
        },
        EditCommand::SetJuliaSize {
            region_id: "r2".into(),
            size: Some((144.0, 108.0)),
        },
    ] {
        assert!(session
            .apply_edit(&root(), "Edit Julia code", command)
            .is_err());
    }
    assert_eq!(session.math_text(&root(), "r2"), Some("a := 2"));
    assert!(!session.view(&root()).unwrap().can_undo);
}

#[test]
fn a_line_break_is_presentation_only_and_undoable() {
    use equavela_core::layout::MathBreak;
    let mut session = session();
    let breaks = vec![
        MathBreak {
            path: vec![1],
            offset: None,
        },
        MathBreak {
            path: vec![0],
            offset: Some(2),
        },
    ];
    let stale = session
        .edit_math_with_breaks(&root(), "r2", "a := 2", breaks.clone())
        .unwrap();
    // A break changes no generated code: nothing becomes stale and no calculation is due.
    assert!(stale.is_empty());
    assert!(!session.calc_needed());
    assert_eq!(
        session.project().document(&root()).unwrap().math_breaks["r2"],
        breaks
    );
    let view = session.view(&root()).unwrap();
    let r2 = view
        .regions
        .iter()
        .find(|region| region.id == "r2")
        .unwrap();
    match &r2.content {
        ViewContent::Math { breaks: seen, .. } => assert_eq!(seen, &breaks),
        other => panic!("expected a math region, got {other:?}"),
    }
    // The writer stores them and a reload sees the same breaks.
    let sheet = write_document(session.project().document(&root()).unwrap()).unwrap();
    assert!(
        sheet.contains("    breaks:\n      - path: [1]\n      - path: [0]\n        offset: 2\n"),
        "{sheet}"
    );
    let reloaded = parse_document(root(), &sheet).unwrap();
    assert_eq!(reloaded.document.math_breaks["r2"], breaks);
    // Undo restores the previous, empty, break list; redo puts the breaks back.
    assert!(session.undo().unwrap().is_some());
    assert!(session
        .project()
        .document(&root())
        .unwrap()
        .math_breaks
        .is_empty());
    let view = session.view(&root()).unwrap();
    let r2 = view
        .regions
        .iter()
        .find(|region| region.id == "r2")
        .unwrap();
    match &r2.content {
        ViewContent::Math { breaks: seen, .. } => assert!(seen.is_empty()),
        other => panic!("expected a math region, got {other:?}"),
    }
    assert!(session.redo().unwrap().is_some());
    assert_eq!(
        session.project().document(&root()).unwrap().math_breaks["r2"],
        breaks
    );
}

/// GitHub : the path of an include region is editable, the new target is read into the
/// session when it exists, and the change is one undo step.
#[test]
fn set_include_path_rereads_the_target_and_undoes() {
    let dir = std::env::temp_dir().join(format!("equavela-include-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, math: &str| {
        std::fs::write(
            dir.join(name),
            format!("format: equavela-worksheet/3\nregions:\n  - id: r1\n    page: 1\n    at: [54, 72]\n    math: \"{math}\"\n"),
        )
        .unwrap();
    };
    write("old.eqv", "p := 1");
    write("new.eqv", "q := 2");
    let root = DocumentId::new(&format!(
        "{}/main.eqv",
        dir.display().to_string().replace('\\', "/")
    ))
    .unwrap();
    let sheet = "format: equavela-worksheet/3\nregions:\n  - id: inc\n    page: 1\n    at: [54, 72]\n    include: old.eqv\n";
    let loaded = equavela_core::worksheet_file::load_project_text(root.clone(), sheet).unwrap();
    let kernel = Arc::new(KernelManager::new(KernelConfig::new(PathBuf::from(
        "kernel-not-started",
    ))));
    let mut session = WorksheetSession::new(
        kernel,
        "ws",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    let include_path = |session: &WorksheetSession| -> String {
        match &session.view(&root).unwrap().regions[0].content {
            ViewContent::Include { path } => path.clone(),
            other => panic!("not an include: {other:?}"),
        }
    };
    let missing = |session: &WorksheetSession| {
        session
            .diagnostics()
            .iter()
            .any(|d| d.message.contains("was not found"))
    };
    assert_eq!(include_path(&session), "old.eqv");
    assert!(!missing(&session));

    // Another file that exists: it is read into the session, nothing is missing, one undo step.
    session
        .apply_edit(
            &root,
            "Edit include path",
            EditCommand::SetIncludePath {
                region_id: "inc".into(),
                path: "new.eqv".into(),
            },
        )
        .unwrap();
    assert_eq!(include_path(&session), "new.eqv");
    assert!(!missing(&session), "{:?}", session.diagnostics());
    // A name that does not exist is the missing-include diagnostic of the region, not a failed edit.
    session
        .apply_edit(
            &root,
            "Edit include path",
            EditCommand::SetIncludePath {
                region_id: "inc".into(),
                path: "gone.eqv".into(),
            },
        )
        .unwrap();
    assert!(missing(&session));
    session.undo().unwrap().unwrap();
    assert_eq!(include_path(&session), "new.eqv");
    assert!(!missing(&session));
    session.undo().unwrap().unwrap();
    assert_eq!(include_path(&session), "old.eqv");
    session.redo().unwrap().unwrap();
    assert_eq!(include_path(&session), "new.eqv");

    // An empty path is refused and changes nothing; so is a command on a region that is not an include.
    assert!(session
        .apply_edit(
            &root,
            "Edit include path",
            EditCommand::SetIncludePath {
                region_id: "inc".into(),
                path: "  ".into()
            }
        )
        .is_err());
    assert!(session
        .apply_edit(
            &root,
            "Edit include path",
            EditCommand::SetIncludePath {
                region_id: "missing".into(),
                path: "a.eqv".into()
            }
        )
        .is_err());
    assert_eq!(include_path(&session), "new.eqv");
    std::fs::remove_dir_all(&dir).ok();
}
