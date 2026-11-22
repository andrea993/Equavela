//! Manual page breaks (GitHub ): the edit commands, their inverses, the undo step they
//! make with the moves of the content below the caret line, the file text and the view the UI
//! draws. No kernel needed: nothing here
//! is evaluated.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use equavela_core::codegen::GenOptions;
use equavela_core::edit::{self, EditCommand, EditError, StoredRegion};
use equavela_core::graph::Region;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::layout::PageBreak;
use equavela_core::parse_statement;
use equavela_core::project::{DocumentId, DocumentRegion, Project, ProjectDocument};
use equavela_core::session::WorksheetSession;
use equavela_core::worksheet_file::{parse_document, LoadError};
use equavela_core::worksheet_writer::write_document;

// Letter with 50 pt margins: the printable area of a page is 692 pt high, from y = 50 to 742.
const SHEET: &str = r#"format: equavela-worksheet/3
page:
  size: Letter
  margins: {top: 50, right: 40, bottom: 50, left: 40}
regions:
  - id: above
    page: 1
    at: [54, 100]
    math: "a := 2"
  - id: below
    page: 1
    at: [54, 300]
    math: "b := a + 1"
  - id: later
    page: 2
    at: [54, 50]
    math: "c := b + 1"
"#;

fn root() -> DocumentId {
    DocumentId::new("/breaks.eqv").unwrap()
}

fn loaded(sheet: &str) -> (ProjectDocument, HashMap<String, String>) {
    let loaded = parse_document(root(), sheet).unwrap();
    (loaded.document, loaded.texts)
}

fn session_of(sheet: &str) -> WorksheetSession {
    let (document, texts) = loaded(sheet);
    let mut project = Project::new();
    project.insert(document).unwrap();
    let texts = texts
        .into_iter()
        .map(|(id, text)| ((root(), id), text))
        .collect();
    let kernel = Arc::new(KernelManager::new(KernelConfig::new(PathBuf::from(
        "kernel-not-started",
    ))));
    WorksheetSession::new(kernel, "ws", project, root(), texts, GenOptions::default()).unwrap()
}

fn place(document: &ProjectDocument, region_id: &str) -> (u32, f64) {
    let region = document
        .regions
        .iter()
        .find(|region| region.id() == region_id)
        .expect("the region exists");
    (region.page(), region.y())
}

/// What `Add Page Break` sends: the break of the page plus the moves of the content below the
/// caret line, in one batch (one undo step). `y` 300 with a printable bottom of 742 shifts the
/// content down by 442 pt.
fn add_break(shift: f64) -> EditCommand {
    EditCommand::Batch {
        commands: vec![
            EditCommand::Move {
                region_id: "below".into(),
                page: 2,
                x: 54.0,
                y: 300.0 + shift,
            },
            EditCommand::Move {
                region_id: "later".into(),
                page: 2,
                x: 54.0,
                y: 50.0 + shift,
            },
            EditCommand::AddPageBreak { page: 1, y: 300.0 },
        ],
    }
}

#[test]
fn a_break_is_stored_and_its_content_moves_in_one_undo_step() {
    let mut session = session_of(SHEET);
    session
        .apply_edit(&root(), "Add page break", add_break(442.0))
        .unwrap();
    let view = session.view(&root()).unwrap();
    assert_eq!(view.page_breaks, vec![PageBreak { page: 1, y: 300.0 }]);
    let document = session.project().document(&root()).unwrap();
    // The region above the caret line stays, the ones below it continue on the page after.
    assert_eq!(place(document, "above"), (1, 100.0));
    assert_eq!(place(document, "below"), (2, 742.0));
    assert_eq!(place(document, "later"), (2, 492.0));
    assert_eq!(session.undo_label(), Some("Add page break"));
}

#[test]
fn undo_takes_the_break_and_the_moves_back_together() {
    let mut session = session_of(SHEET);
    let before = session.view(&root()).unwrap();
    session
        .apply_edit(&root(), "Add page break", add_break(442.0))
        .unwrap();
    let label = session.undo().unwrap().expect("an edit to undo").0;
    assert_eq!(label, "Add page break");
    let view = session.view(&root()).unwrap();
    assert!(view.page_breaks.is_empty());
    assert_eq!(view.regions, before.regions);
    // Redo brings both back: one step, not two.
    session.redo().unwrap().expect("an edit to redo");
    let view = session.view(&root()).unwrap();
    assert_eq!(view.page_breaks, vec![PageBreak { page: 1, y: 300.0 }]);
    let document = session.project().document(&root()).unwrap();
    assert_eq!(place(document, "below"), (2, 742.0));
}

#[test]
fn a_page_ends_once() {
    let mut session = session_of(SHEET);
    session
        .apply_edit(
            &root(),
            "Add page break",
            EditCommand::AddPageBreak { page: 1, y: 300.0 },
        )
        .unwrap();
    let error = session
        .apply_edit(
            &root(),
            "Add page break",
            EditCommand::AddPageBreak { page: 1, y: 500.0 },
        )
        .unwrap_err();
    assert!(matches!(
        error,
        equavela_core::session::SessionError::Edit(EditError::PageBreakExists(1))
    ));
    // Nothing changed and nothing was recorded.
    let view = session.view(&root()).unwrap();
    assert_eq!(view.page_breaks, vec![PageBreak { page: 1, y: 300.0 }]);
    assert_eq!(session.undo_label(), Some("Add page break"));
}

#[test]
fn an_invalid_break_is_refused() {
    let mut document = loaded(SHEET).0;
    let mut texts = HashMap::new();
    for (page, y) in [(0, 300.0), (1, f64::NAN), (1, -1.0), (1, 800.0)] {
        let error = edit::apply(
            &mut document,
            &mut texts,
            EditCommand::AddPageBreak { page, y },
        )
        .unwrap_err();
        assert!(matches!(error, EditError::BadPageBreak), "{page} {y}");
    }
    assert!(document.page_breaks.is_empty());
}

#[test]
fn removing_a_break_hands_back_what_it_takes_to_undo_it() {
    let mut document = loaded(
        r#"format: equavela-worksheet/3
page:
  size: Letter
regions: []
page-breaks:
  - {page: 3, y: 120.5}
  - {page: 1, y: 300}
"#,
    )
    .0;
    // The reader sorts the list by page.
    assert_eq!(
        document.page_breaks,
        vec![
            PageBreak { page: 1, y: 300.0 },
            PageBreak { page: 3, y: 120.5 }
        ]
    );
    let mut texts = HashMap::new();
    let inverse = edit::apply(
        &mut document,
        &mut texts,
        EditCommand::RemovePageBreak { page: 1 },
    )
    .unwrap();
    assert_eq!(inverse, EditCommand::AddPageBreak { page: 1, y: 300.0 });
    assert_eq!(document.page_breaks.len(), 1);
    // The inverse puts it back where it was.
    edit::apply(&mut document, &mut texts, inverse).unwrap();
    assert_eq!(
        document.page_breaks,
        vec![
            PageBreak { page: 1, y: 300.0 },
            PageBreak { page: 3, y: 120.5 }
        ]
    );
    let error = edit::apply(
        &mut document,
        &mut texts,
        EditCommand::RemovePageBreak { page: 2 },
    )
    .unwrap_err();
    assert!(matches!(error, EditError::NoSuchPageBreak(2)));
}

#[test]
fn the_file_holds_the_breaks_between_the_page_and_the_settings() {
    let mut document = loaded(SHEET).0;
    document.page_breaks = vec![
        PageBreak { page: 1, y: 300.0 },
        PageBreak { page: 2, y: 642.75 },
    ];
    let text = write_document(&document).unwrap();
    let expected = "format: equavela-worksheet/3\npage:\n  size: Letter\n  margins: {top: 50, right: 40, bottom: 50, left: 40}\npage-breaks:\n  - {page: 1, y: 300}\n  - {page: 2, y: 642.75}\nregions:\n";
    assert!(text.starts_with(expected), "{text}");
    // Read then write is byte for byte stable and gives the same breaks back.
    let reloaded = parse_document(root(), &text).unwrap();
    assert_eq!(reloaded.document.page_breaks, document.page_breaks);
    assert_eq!(write_document(&reloaded.document).unwrap(), text);
    // A document without breaks writes no key at all.
    document.page_breaks.clear();
    assert!(!write_document(&document).unwrap().contains("page-breaks"));
}

#[test]
fn a_hand_written_break_outside_the_page_is_a_load_error() {
    let sheet = |breaks: &str| {
        format!("format: equavela-worksheet/3\npage:\n  size: Letter\n{breaks}regions: []\n")
    };
    let error =
        parse_document(root(), &sheet("page-breaks:\n  - {page: 1, y: 900}\n")).unwrap_err();
    assert!(matches!(error, LoadError::PageBreak { .. }), "{error}");
    let error = parse_document(
        root(),
        &sheet("page-breaks:\n  - {page: 1, y: 100}\n  - {page: 1, y: 200}\n"),
    )
    .unwrap_err();
    assert!(matches!(error, LoadError::PageBreak { .. }), "{error}");
}

#[test]
fn a_region_can_still_be_added_and_removed_with_breaks_stored() {
    // The commands of a removed region keep working: the break list is a document property, so it
    // is untouched by a region edit and still there after the region comes back (its inverse).
    let mut session = session_of(SHEET);
    session
        .apply_edit(
            &root(),
            "Add page break",
            EditCommand::AddPageBreak { page: 1, y: 300.0 },
        )
        .unwrap();
    session
        .apply_edit(
            &root(),
            "Delete region",
            EditCommand::Remove {
                region_id: "below".into(),
            },
        )
        .unwrap();
    assert_eq!(
        session.view(&root()).unwrap().page_breaks,
        vec![PageBreak { page: 1, y: 300.0 }]
    );
    session.undo().unwrap();
    assert_eq!(
        session.view(&root()).unwrap().page_breaks,
        vec![PageBreak { page: 1, y: 300.0 }]
    );
    assert!(session
        .project()
        .document(&root())
        .unwrap()
        .regions
        .iter()
        .any(|region| region.id() == "below"));
}

/// A region that a math edit adds is unaffected by the break list (a smoke test that the shared
/// document still clones the breaks through an edit of the model).
#[test]
fn an_added_region_keeps_the_breaks() {
    let region = DocumentRegion::Math(Box::new(Region {
        id: "new".into(),
        page: 2,
        x: 54.0,
        y: 200.0,
        enabled: true,
        statement: Arc::new(parse_statement("d := 4").unwrap()),
    }));
    let mut session = session_of(SHEET);
    session
        .apply_edit(
            &root(),
            "Add page break",
            EditCommand::AddPageBreak { page: 1, y: 300.0 },
        )
        .unwrap();
    session
        .apply_edit(
            &root(),
            "Add math region",
            EditCommand::Insert {
                region: StoredRegion {
                    region,
                    math_text: Some("d := 4".into()),
                },
                index: usize::MAX,
            },
        )
        .unwrap();
    let view = session.view(&root()).unwrap();
    assert_eq!(view.page_breaks, vec![PageBreak { page: 1, y: 300.0 }]);
}
