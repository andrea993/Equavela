//! Collapsible areas: file round trip, edit commands with undo,
//! derived membership and calculation order. No kernel is needed.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use equavela_core::area::{members, AreaRegion};
use equavela_core::codegen::GenOptions;
use equavela_core::edit::EditCommand;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::project::{DocumentId, DocumentRegion, Project};
use equavela_core::session::{ViewContent, WorksheetSession};
use equavela_core::worksheet_file::{parse_document, LoadError};
use equavela_core::worksheet_writer::write_document;

/// A4 with 72 pt top and bottom margins: printable height 697.89 pt. Area `a1` (title with a colon,
/// collapsed) covers y 100 to 220 and holds `b` and `c`; area `a2` is expanded and empty; `d` is below.
const SHEET: &str = r#"format: equavela-worksheet/3
page:
  size: A4
  margins: {top: 72, right: 54, bottom: 72, left: 54}
regions:
  - id: a
    page: 1
    at: [54, 72]
    math: "a := 1"
  - id: a1
    page: 1
    at: [54, 100]
    area:
      title: "Inputs: loads"
      height: 120
      collapsed: true
  - id: b
    page: 1
    at: [54, 130]
    math: "b := a + 1"
  - id: c
    page: 1
    at: [54, 160]
    math: "c := b + 1"
  - id: d
    page: 1
    at: [54, 240]
    math: "d := c + 1"
  - id: a2
    page: 1
    at: [54, 300]
    area:
      height: 60
  - id: e
    page: 2
    at: [54, 130]
    math: "e := 5"
"#;

fn root() -> DocumentId {
    DocumentId::new("/areas.eqv").unwrap()
}

fn session() -> WorksheetSession {
    let loaded = parse_document(root(), SHEET).unwrap();
    let mut project = Project::new();
    project.insert(loaded.document).unwrap();
    let texts: HashMap<_, _> = loaded
        .texts
        .into_iter()
        .map(|(id, text)| ((root(), id), text))
        .collect();
    let kernel = Arc::new(KernelManager::new(KernelConfig::new(PathBuf::from(
        "kernel-not-started",
    ))));
    WorksheetSession::new(kernel, "ws", project, root(), texts, GenOptions::default()).unwrap()
}

fn area(id: &str, y: f64, height: f64) -> DocumentRegion {
    DocumentRegion::Area(AreaRegion {
        id: id.into(),
        page: 1,
        x: 54.0,
        y,
        enabled: true,
        title: "Area".into(),
        height,
        collapsed: false,
    })
}

fn insert(region: DocumentRegion) -> EditCommand {
    EditCommand::Insert {
        region: equavela_core::edit::StoredRegion {
            region,
            math_text: None,
        },
        index: usize::MAX,
    }
}

fn area_of(session: &WorksheetSession, id: &str) -> (String, f64, bool) {
    match &session
        .view(&root())
        .unwrap()
        .regions
        .iter()
        .find(|r| r.id == id)
        .unwrap()
        .content
    {
        ViewContent::Area {
            title,
            height,
            collapsed,
        } => (title.clone(), *height, *collapsed),
        _ => panic!("not an area"),
    }
}

#[test]
fn areas_round_trip_through_the_file_in_canonical_form() {
    let loaded = parse_document(root(), SHEET).unwrap();
    let text = write_document(&loaded.document).unwrap();
    assert!(
        text.contains(
            "    area:\n      title: 'Inputs: loads'\n      height: 120\n      collapsed: true\n"
        ) || text.contains(
            "    area:\n      title: \"Inputs: loads\"\n      height: 120\n      collapsed: true\n"
        ),
        "{text}"
    );
    // An empty title and an expanded area write only the height.
    assert!(
        text.contains("    area:\n      height: 60\n  - id: e"),
        "{text}"
    );
    let again = parse_document(root(), &text).unwrap();
    assert_eq!(again.document.regions, loaded.document.regions);
    assert_eq!(write_document(&again.document).unwrap(), text);
}

#[test]
fn a_bad_height_is_a_load_error() {
    for height in ["10", "0", ".nan"] {
        let sheet = format!(
            "format: equavela-worksheet/3\nregions:\n  - id: x\n    at: [0, 0]\n    area:\n      height: {height}\n"
        );
        assert!(
            matches!(parse_document(root(), &sheet), Err(LoadError::Area { .. })),
            "{height}"
        );
    }
}

#[test]
fn members_are_the_regions_whose_top_is_below_the_header_and_above_the_end_line() {
    let loaded = parse_document(root(), SHEET).unwrap();
    let page = &loaded.document.page;
    let regions = &loaded.document.regions;
    let DocumentRegion::Area(a1) = regions[1].as_ref() else {
        panic!()
    };
    assert_eq!(members(page, regions, a1), ["b", "c"]);
    // The header (21 pt) is not content: a region at y 100..121 would not be a member; the end
    // line is exclusive; another page never is.
    assert!(!a1.contains(page, 1, 100.0) && !a1.contains(page, 1, 120.0));
    assert!(a1.contains(page, 1, 121.0) && a1.contains(page, 1, 219.0));
    assert!(!a1.contains(page, 1, 220.0));
    assert!(!a1.contains(page, 2, 130.0));
}

#[test]
fn set_area_is_one_undo_step_and_areas_may_not_overlap_or_have_a_bad_height() {
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Expand area",
            EditCommand::SetArea {
                region_id: "a1".into(),
                title: "Renamed".into(),
                height: 140.0,
                collapsed: false,
            },
        )
        .unwrap();
    assert_eq!(
        area_of(&session, "a1"),
        ("Renamed".to_owned(), 140.0, false)
    );
    session.undo().unwrap();
    assert_eq!(
        area_of(&session, "a1"),
        ("Inputs: loads".to_owned(), 120.0, true)
    );
    session.redo().unwrap();
    assert_eq!(area_of(&session, "a1").1, 140.0);

    let refused = |session: &mut WorksheetSession, command: EditCommand| {
        session.apply_edit(&root(), "x", command).is_err()
    };
    // a1 (100 to 240 now) growing into a2 (300 to 360), a new area over a1, a move onto a2, a height out of range.
    assert!(refused(
        &mut session,
        EditCommand::SetArea {
            region_id: "a1".into(),
            title: String::new(),
            height: 250.0,
            collapsed: false
        }
    ));
    assert!(refused(&mut session, insert(area("n", 200.0, 50.0))));
    assert!(refused(
        &mut session,
        EditCommand::Move {
            region_id: "a1".into(),
            page: 1,
            x: 54.0,
            y: 250.0
        }
    ));
    for height in [10.0, -1.0, f64::NAN] {
        assert!(refused(
            &mut session,
            EditCommand::SetArea {
                region_id: "a2".into(),
                title: String::new(),
                height,
                collapsed: false
            }
        ));
    }
    assert!(refused(
        &mut session,
        EditCommand::SetArea {
            region_id: "b".into(),
            title: String::new(),
            height: 50.0,
            collapsed: false
        }
    ));
    // Another page is free, and a new area fits between the two.
    session
        .apply_edit(&root(), "Add", insert(area("n2", 250.0, 40.0)))
        .unwrap();
    session
        .apply_edit(
            &root(),
            "Move",
            EditCommand::Move {
                region_id: "n2".into(),
                page: 2,
                x: 54.0,
                y: 100.0,
            },
        )
        .unwrap();
}

#[test]
fn an_area_defines_nothing_and_members_calculate_in_reading_order_when_collapsed() {
    let session = session();
    let inspection = session.inspect();
    // `a1` is collapsed with `b` and `c` inside: they still define names and have ranks in
    // reading order; the areas have none.
    let names: Vec<&str> = inspection
        .definitions
        .iter()
        .map(|d| d.name.as_str())
        .collect();
    assert_eq!(names, ["a", "b", "c", "d", "e"]);
    let rank = |id: &str| {
        inspection
            .ranks
            .iter()
            .find(|(key, _)| key.region_id == id)
            .map(|(_, rank)| *rank)
    };
    assert!(rank("a") < rank("b") && rank("b") < rank("c") && rank("c") < rank("d"));
    assert_eq!(rank("a1"), None);
    assert_eq!(rank("a2"), None);
    // `d := c + 1` refers to `c` inside the collapsed area.
    let c = inspection
        .definitions
        .iter()
        .find(|d| d.name == "c")
        .unwrap();
    assert!(inspection
        .references
        .iter()
        .any(|r| r.name == "c" && r.definition.as_ref() == Some(&c.key)));
}

#[test]
fn an_area_always_starts_at_the_left_margin() {
    let mut session = session();
    session
        .apply_edit(
            &root(),
            "Move",
            EditCommand::Move {
                region_id: "a2".into(),
                page: 1,
                x: 200.0,
                y: 400.0,
            },
        )
        .unwrap();
    let view = session.view(&root()).unwrap();
    let a2 = view.regions.iter().find(|r| r.id == "a2").unwrap();
    assert_eq!((a2.x, a2.y), (54.0, 400.0));
}

/// A4 with the default 1 in top and bottom margins: the printable area of every page runs from
/// y 72 to 769.89, so a band of 400 pt starting at y 600 of page 1 covers 600..769.89 there and
/// 72..302.11 on page 2.
const CROSSING: &str = r#"format: equavela-worksheet/3
page:
  size: A4
regions:
  - id: band
    page: 1
    at: [54, 600]
    area:
      title: "Across"
      height: 400
  - id: header
    page: 1
    at: [54, 605]
    math: "h := 1"
  - id: first
    page: 1
    at: [54, 650]
    math: "f := 2"
  - id: top
    page: 2
    at: [54, 72]
    math: "t := 3"
  - id: second
    page: 2
    at: [54, 200]
    math: "s := 4"
  - id: below
    page: 2
    at: [54, 400]
    math: "b := 5"
"#;

#[test]
fn a_band_that_crosses_a_page_break_holds_the_regions_of_the_next_page() {
    let loaded = parse_document(root(), CROSSING).unwrap();
    let page = &loaded.document.page;
    let regions = &loaded.document.regions;
    let DocumentRegion::Area(band) = regions[0].as_ref() else {
        panic!()
    };
    // One part per page: 600 to the bottom margin, then the top margin to 302.11.
    let spans = band.spans(page);
    assert_eq!(spans.len(), 2);
    assert_eq!((spans[0].page, spans[0].top), (1, 600.0));
    assert!((spans[0].height - 169.89).abs() < 1e-6);
    assert_eq!((spans[1].page, spans[1].top), (2, 72.0));
    assert!((spans[1].height - 230.11).abs() < 1e-6);
    assert_eq!(band.last_page(page), 2);
    // A region in the header of the band and a region below its end line are not members, and
    // neither is anything on a page the band does not reach.
    assert_eq!(members(page, regions, band), ["first", "top", "second"]);
}

#[test]
fn a_band_can_cross_two_page_breaks_and_the_file_keeps_its_height() {
    let sheet = CROSSING
        .replace("height: 400", "height: 1_400")
        .replace("1_400", "1400");
    let loaded = parse_document(root(), &sheet).unwrap();
    let page = &loaded.document.page;
    let DocumentRegion::Area(band) = loaded.document.regions[0].as_ref() else {
        panic!()
    };
    let spans = band.spans(page);
    assert_eq!(
        spans.iter().map(|s| s.page).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    // 169.89 pt on page 1, the whole printable page, and the rest (532.22 pt) on page 3.
    assert!((spans[1].height - 697.89).abs() < 1e-6);
    assert!((spans[2].height - 532.22).abs() < 1e-6);
    assert_eq!(band.last_page(page), 3);
    // No field was added for the crossing: the file stores the same extent.
    let text = write_document(&loaded.document).unwrap();
    assert!(text.contains("      height: 1400\n"), "{text}");
    let again = parse_document(root(), &text).unwrap();
    assert_eq!(again.document.regions, loaded.document.regions);
}

#[test]
fn growing_a_band_past_the_bottom_margin_is_one_undo_step_and_reserves_the_next_page() {
    let mut session = session();
    // a2 is 300..360. At 700 pt it reaches y 302.11 of page 2, where `e` (y 130) becomes a member.
    session
        .apply_edit(
            &root(),
            "Resize area",
            EditCommand::SetArea {
                region_id: "a2".into(),
                title: String::new(),
                height: 700.0,
                collapsed: false,
            },
        )
        .unwrap();
    assert_eq!(area_of(&session, "a2").1, 700.0);
    // The band keeps its stored place: the continuation is derived, not stored.
    let view = session.view(&root()).unwrap();
    let a2 = view.regions.iter().find(|r| r.id == "a2").unwrap();
    assert_eq!((a2.page, a2.y), (1, 300.0));
    // An area on page 2 inside the part the band covers there would overlap it.
    let clash = insert(area_on(2, "n", 100.0, 48.0));
    assert!(session
        .apply_edit(&root(), "Add area", clash.clone())
        .is_err());
    // One undo step brings the band back, and then the page is free.
    session.undo().unwrap();
    assert_eq!(area_of(&session, "a2").1, 60.0);
    session.apply_edit(&root(), "Add area", clash).unwrap();
}

fn area_on(page: u32, id: &str, y: f64, height: f64) -> DocumentRegion {
    DocumentRegion::Area(AreaRegion {
        id: id.into(),
        page,
        x: 54.0,
        y,
        enabled: true,
        title: "Area".into(),
        height,
        collapsed: false,
    })
}

/// Area `band` covers y 100 to 160 and holds the Julia block `j` (a box 288 x 30 at y 130); area
/// `next` starts at 400. The plot `p` lies outside both bands.
const HOLD_SHEET: &str = r#"format: equavela-worksheet/3
page:
  size: A4
  margins: {top: 72, right: 54, bottom: 72, left: 54}
regions:
  - id: band
    page: 1
    at: [54, 100]
    area:
      height: 60
  - id: j
    page: 1
    at: [54, 130]
    julia:
      size: [288, 30]
      code: |
        x = 1
  - id: next
    page: 1
    at: [54, 400]
    area:
      height: 60
  - id: p
    page: 1
    at: [54, 500]
    plot:
      type: xy
      traces: [{id: t1, x: "x", y: "x"}]
"#;

fn hold_session() -> WorksheetSession {
    let loaded = parse_document(root(), HOLD_SHEET).unwrap();
    let mut project = Project::new();
    project.insert(loaded.document).unwrap();
    let kernel = Arc::new(KernelManager::new(KernelConfig::new(PathBuf::from(
        "kernel-not-started",
    ))));
    WorksheetSession::new(
        kernel,
        "ws",
        project,
        root(),
        HashMap::new(),
        GenOptions::default(),
    )
    .unwrap()
}

fn hold(ids: &[&str]) -> EditCommand {
    EditCommand::HoldMembers {
        region_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
    }
}

#[test]
fn a_band_grows_to_hold_a_member_resized_past_its_end_line_in_one_undo_step() {
    let mut session = hold_session();
    let resize = EditCommand::SetJuliaSize {
        region_id: "j".into(),
        size: Some((288.0, 100.0)),
    };
    session
        .apply_edit(
            &root(),
            "Resize Julia block",
            EditCommand::Batch {
                commands: vec![resize, hold(&["j"])],
            },
        )
        .unwrap();
    // The block ends at 230: the end line goes one grid step below it, on the grid.
    assert_eq!(area_of(&session, "band").1, 134.0);
    session.undo().unwrap();
    assert_eq!(area_of(&session, "band").1, 60.0);
    session.redo().unwrap();
    assert_eq!(area_of(&session, "band").1, 134.0);
}

#[test]
fn a_band_never_shrinks_and_never_grows_into_the_next_area() {
    let mut session = hold_session();
    // A smaller box leaves the band as it is.
    session.apply_edit(&root(), "x", hold(&["j"])).unwrap();
    assert_eq!(area_of(&session, "band").1, 60.0);
    // A box reaching past the next area's start line stops the band there.
    session
        .apply_edit(
            &root(),
            "x",
            EditCommand::Batch {
                commands: vec![
                    EditCommand::SetJuliaSize {
                        region_id: "j".into(),
                        size: Some((288.0, 500.0)),
                    },
                    hold(&["j"]),
                ],
            },
        )
        .unwrap();
    assert_eq!(area_of(&session, "band").1, 300.0);
}

#[test]
fn a_region_dropped_into_a_band_grows_it_and_one_outside_changes_nothing() {
    let mut session = hold_session();
    // The plot (300 x 200 pt by default) lands at y 430, inside `next`, and passes its end line.
    session
        .apply_edit(
            &root(),
            "Move region",
            EditCommand::Batch {
                commands: vec![
                    EditCommand::Move {
                        region_id: "p".into(),
                        page: 1,
                        x: 54.0,
                        y: 430.0,
                    },
                    hold(&["p"]),
                ],
            },
        )
        .unwrap();
    let plot_height = match session
        .project()
        .document(&root())
        .unwrap()
        .regions
        .iter()
        .find(|r| r.id() == "p")
        .unwrap()
        .as_ref()
    {
        DocumentRegion::Plot(plot) => plot.plot.size[1],
        _ => unreachable!(),
    };
    let end = ((430.0 + plot_height + 3.0) / 3.0_f64).ceil() * 3.0;
    assert_eq!(area_of(&session, "next").1, end - 400.0);
    // A region outside every band grows nothing.
    session
        .apply_edit(
            &root(),
            "x",
            EditCommand::Batch {
                commands: vec![
                    EditCommand::Move {
                        region_id: "p".into(),
                        page: 2,
                        x: 54.0,
                        y: 300.0,
                    },
                    hold(&["p"]),
                ],
            },
        )
        .unwrap();
    assert_eq!(area_of(&session, "band").1, 60.0);
}
