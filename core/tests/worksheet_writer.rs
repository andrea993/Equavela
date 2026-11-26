//! Round trips of the worksheet writer against the reader:
//! read, write, read gives an equal model, and canonical text is reproduced byte
//! for byte.

use equavela_core::layout::TextRegion;
use equavela_core::project::{DocumentId, DocumentRegion, ProjectDocument};
use equavela_core::worksheet_file::{parse_document, LoadedDocument};
use equavela_core::worksheet_writer::{write_document, write_file_atomic, WriteError};
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Every worksheet fixture of the repository.
fn fixtures() -> Vec<PathBuf> {
    let root = repo_root();
    let mut files = vec![root.join("app/src/mock/demo.eqv")];
    let smoke = root.join("app/scripts/fixtures/real-smoke");
    let mut smoke_files: Vec<PathBuf> = std::fs::read_dir(smoke)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|e| e == "eqv"))
        .collect();
    smoke_files.sort();
    files.extend(smoke_files);
    assert!(files.len() >= 5, "fixtures not found: {files:?}");
    files
}

fn read_as(name: &str, text: &str) -> LoadedDocument {
    parse_document(DocumentId::new(name).unwrap(), text)
        .unwrap_or_else(|error| panic!("{name}: {error}\n{text}"))
}

fn read(text: &str) -> LoadedDocument {
    read_as("/t/sheet.eqv", text)
}

/// The model without the hash of the file text it was read from, and the math texts sorted.
fn model(mut loaded: LoadedDocument) -> (ProjectDocument, Vec<(String, String)>) {
    loaded.document.content_hash = String::new();
    let mut texts: Vec<_> = loaded.texts.into_iter().collect();
    texts.sort();
    (loaded.document, texts)
}

fn written(text: &str) -> String {
    write_document(&read(text).document).unwrap()
}

/// Text a canonical writer produces for its own input, covering every region kind.
const CANONICAL: &str = r#"format: equavela-worksheet/3
page:
  size: Letter
  orientation: landscape
  margins: {top: 36, right: 36.5, bottom: 36, left: 36}
  header: {center: Beam analysis, right: "Page {page}"}
  footer: {left: "{file}", right: "2026-11-04"}
settings:
  format.precision: 3
  format.type: scientific
  tolerance: "0.10"
environment: envs/main
regions:
  - id: t1
    page: 1
    at: [36.5, 36]
    text: Heading of the sheet
  - id: t2
    page: 1
    at: [36, 60]
    text:
      width: 300.5
      text: |
        First line of a paragraph, with a comma.
          An indented second line.

        A blank line above: it stays.
  - id: t3
    page: 1
    at: [36, 120]
    text:
      width: full
      text: "yes"
  - id: t4
    page: 1
    at: [36, 150]
    enabled: false
    text: "Needs quotes: a colon # and a hash"
  - id: m1
    page: 1
    at: [36, 200]
    math: "L := 3.5 m"
  - id: m2
    page: 1
    at: [200, 200]
    math: '\det(A) ='
    format:
      precision: 5
      type: scientific
  - id: m3
    page: 2
    at: [36, 72]
    math: |
      S(n) := program
        s ← 0
        for i ∈ 1..n
          s ← s + i
        s
  - id: m4
    page: 2
    at: [36, 200]
    enabled: false
    math: "M_max = … kN·m"
  - id: m5
    page: 2
    at: [36, 220]
    math: "[a_11, ⋯, a_1n; ⋮, ⋱, ⋮; a_m1, ⋯, a_mn]"
  - id: inc1
    page: 2
    at: [36, 240]
    include: libs/helpers.eqv
  - id: inc2
    page: 2
    at: [36, 270]
    include: "C:/work/other.eqv"
  - id: j1
    page: 2
    at: [36, 300]
    julia:
      size: [288, 144]
      using: [LinearAlgebra, Statistics]
      import:
        mymean: Statistics.mean
      define: [spectral]
      code: |
        spectral(M) = maximum(abs.(eigvals(M)))
        helper(x) = 2x
  - id: j2
    page: 2
    at: [36, 360]
    julia: {}
  - id: j3
    page: 2
    at: [36, 380]
    julia:
      size: [300, 150.5]
      playing: false
      using: [Statistics]
      import:
        meandev: Statistics.median
      define: [late]
      code: |
        late(x) = x + 1
  - id: j4
    page: 2
    at: [36, 420]
    julia:
      playing: false
  - id: p1
    page: 2
    at: [36, 400]
    plot:
      version: 1
      type: xy
      size: [360, 220]
      axes:
        x: {min: 0, max: 4.5, title: Time t}
        y: {scale: log10, unit: "m", min: 0.5, max: 100}
      traces:
        - {id: trace-1, x: "x", y: "x^2"}
        - {id: trace-2, x: "x", y: "", presentation: line+markers}
        - {id: trace-3, x: "", y: "x", presentation: markers}
"#;

/// the play/stop state of a Julia block travels in the file as `playing: false` for
/// a stopped block and as no key at all for a playing one, so a file written before the field
/// existed keeps evaluating its blocks. Reading, writing and reading back gives the same block.
#[test]
fn julia_playing_state_round_trips_and_a_playing_block_carries_no_key() {
    let text = r#"format: equavela-worksheet/3
regions:
  - id: old
    at: [0, 0]
    julia:
      using: [LinearAlgebra]
      code: |
        scale = 2
  - id: stopped
    at: [0, 20]
    julia:
      playing: false
      using: [Statistics]
      code: |
        scale = 3
"#;
    let first = read(text);
    let blocks: Vec<_> = first
        .document
        .regions
        .iter()
        .map(|region| match region.as_ref() {
            DocumentRegion::Math(region) => match &region.statement.kind {
                equavela_core::ast::StatementKind::Julia { block } => block.clone(),
                other => panic!("expected a julia block, found {other:?}"),
            },
            other => panic!("expected a math-kind region, found {other:?}"),
        })
        .collect();
    // A file written before the field exists plays its blocks.
    assert!(blocks[0].playing);
    assert!(!blocks[1].playing);

    let once = write_document(&first.document).unwrap();
    assert_eq!(once.matches("playing: false").count(), 1, "{once}");
    assert!(
        once.contains("  - id: old\n    page: 1\n    at: [0, 0]\n    julia:\n      using:"),
        "{once}"
    );
    let second = read(&once);
    assert_eq!(model(first), model(second.clone()));
    assert_eq!(write_document(&second.document).unwrap(), once);
}

/// The box of a Julia block: the size is written as the first key
/// of the mapping, before `playing`, it reads back as the same model, and a block without one
/// carries no key at all (a file written before the field existed is unchanged).
#[test]
fn julia_box_size_round_trips_and_a_block_without_one_carries_no_key() {
    let text = r#"format: equavela-worksheet/3
regions:
  - id: sized
    at: [0, 0]
    julia:
      size: [288, 144]
      using: [LinearAlgebra]
      code: |
        scale = 2
  - id: stopped
    at: [0, 200]
    julia:
      size: [300, 150.5]
      playing: false
  - id: open
    at: [0, 400]
    julia:
      code: |
        scale = 3
"#;
    let first = read(text);
    let sizes: Vec<_> = first
        .document
        .regions
        .iter()
        .map(|region| match region.as_ref() {
            DocumentRegion::Math(region) => match &region.statement.kind {
                equavela_core::ast::StatementKind::Julia { block } => block.size,
                other => panic!("expected a julia block, found {other:?}"),
            },
            other => panic!("expected a math-kind region, found {other:?}"),
        })
        .collect();
    assert_eq!(sizes, [Some((288.0, 144.0)), Some((300.0, 150.5)), None]);

    let once = write_document(&first.document).unwrap();
    // The size comes first, before `playing` and the rest.
    assert!(
        once.contains("  - id: sized\n    page: 1\n    at: [0, 0]\n    julia:\n      size: [288, 144]\n      using:"),
        "{once}"
    );
    assert!(
        once.contains("  - id: stopped\n    page: 1\n    at: [0, 200]\n    julia:\n      size: [300, 150.5]\n      playing: false"),
        "{once}"
    );
    // A block without a stored box keeps the text it always had.
    assert!(once.contains("julia:\n      code: |"), "{once}");
    assert_eq!(once.matches("size: [").count(), 2, "{once}");

    let second = read(&once);
    assert_eq!(model(first), model(second.clone()));
    assert_eq!(write_document(&second.document).unwrap(), once);
}

/// The writer refuses a box that is not two positive finite numbers, as it refuses an invalid image
/// size: the file would otherwise carry a box no reader accepts.
#[test]
fn the_writer_refuses_a_julia_box_that_is_not_a_size() {
    let mut loaded = read(
        "format: equavela-worksheet/3\nregions:\n  - id: j1\n    at: [0, 0]\n    julia:\n      size: [288, 144]\n",
    );
    let DocumentRegion::Math(math) = std::sync::Arc::make_mut(&mut loaded.document.regions[0])
    else {
        panic!("expected a math-kind region");
    };
    let statement = std::sync::Arc::make_mut(&mut math.statement);
    let equavela_core::ast::StatementKind::Julia { block } = &mut statement.kind else {
        panic!("expected a julia block");
    };
    block.size = Some((0.0, 144.0));
    let error = write_document(&loaded.document).unwrap_err().to_string();
    assert!(error.contains("j1") && error.contains("size"), "{error}");
}

/// A size that is not two positive finite numbers is a load error naming the region, and
/// a `size` key that is not a pair of numbers at all is refused like any other malformed field.
#[test]
fn a_julia_box_size_must_be_two_positive_finite_numbers() {
    for size in ["[0, 100]", "[-3, 4]", "[288, 0]", "[.inf, 144]"] {
        let text = format!(
            "format: equavela-worksheet/3\nregions:\n  - id: j1\n    at: [0, 0]\n    julia:\n      size: {size}\n"
        );
        let error = parse_document(DocumentId::new("/t/sheet.eqv").unwrap(), &text)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("j1") && error.contains("size"),
            "{size}: {error}"
        );
    }
    for size in ["[288]", "[288, 144, 1]", "[a, b]"] {
        let text = format!(
            "format: equavela-worksheet/3\nregions:\n  - id: j1\n    at: [0, 0]\n    julia:\n      size: {size}\n"
        );
        assert!(
            parse_document(DocumentId::new("/t/sheet.eqv").unwrap(), &text).is_err(),
            "{size}"
        );
    }
}

/// the header and the footer are written after the margins, with only the slots
/// that hold something, and read back as the same two lines.
#[test]
fn header_and_footer_round_trip_and_refuse_a_second_line() {
    let text = r#"format: equavela-worksheet/3
page:
  size: A4
  margins: {top: 72, right: 54, bottom: 72, left: 54}
  header: {left: Beam, center: "", right: "Page {page}"}
  footer: {center: "Report {date}"}
regions: []
"#;
    let loaded = read(text);
    assert_eq!(loaded.document.page.header.left, "Beam");
    assert_eq!(loaded.document.page.header.right, "Page {page}");
    assert!(loaded.document.page.header.center.is_empty());
    assert_eq!(loaded.document.page.footer.center, "Report {date}");
    // Empty slots are not written, and an empty line is not written at all.
    let once = write_document(&loaded.document).unwrap();
    assert!(
        once.contains(r#"  header: {left: Beam, right: "Page {page}"}"#),
        "{once}"
    );
    assert!(
        once.contains(r#"  footer: {center: "Report {date}"}"#),
        "{once}"
    );
    // The tokens travel as text: reading the written file gives the same lines, byte for byte.
    let again = read(&once);
    assert_eq!(again.document.page, loaded.document.page);
    assert_eq!(write_document(&again.document).unwrap(), once);
    // A worksheet without a header or a footer carries neither key.
    let bare = written("format: equavela-worksheet/3\nregions: []\n");
    assert!(
        !bare.contains("header:") && !bare.contains("footer:"),
        "{bare}"
    );
    // A slot that holds a line break is a load error and a write error.
    let broken = parse_document(
        DocumentId::new("/t/sheet.eqv").unwrap(),
        r#"format: equavela-worksheet/3
page:
  header: {center: "one\ntwo"}
regions: []
"#,
    )
    .unwrap_err()
    .to_string();
    assert!(broken.contains("one line"), "{broken}");
    let mut document = loaded.document;
    document.page.footer.left = "two\nlines".into();
    assert!(matches!(
        write_document(&document),
        Err(WriteError::PageLine { .. })
    ));
}

#[test]
fn plot_second_y_axis_round_trips_and_legacy_traces_default_left() {
    let text = r##"format: equavela-worksheet/3
regions:
  - id: p
    at: [0, 0]
    plot:
      type: xy
      grid_spacing: 2
      axes:
        y2: {scale: log10, min: 0.1, max: 100}
      traces:
        - {id: t1, x: "x", y: "a", y_axis: right, line: {style: dash, width: 2, color: "#123ABC"}, marker: {shape: square, size: 8, color: "#ABCDEF"}}
        - {id: t2, x: "x", y: "b"}
"##;
    let first = read(text);
    let DocumentRegion::Plot(plot) = first.document.regions[0].as_ref() else {
        panic!("plot")
    };
    assert_eq!(
        plot.plot.axes.y2.scale,
        equavela_core::plot::AxisScale::Log10
    );
    assert_eq!(plot.plot.grid_spacing, Some(2.0));
    assert_eq!(
        plot.plot.traces[0].y_axis,
        equavela_core::plot::TraceYAxis::Right
    );
    assert_eq!(plot.plot.traces[0].line.width, 2.0);
    assert_eq!(plot.plot.traces[0].line.color.as_deref(), Some("#123ABC"));
    assert_eq!(plot.plot.traces[0].marker.size, 8.0);
    assert_eq!(plot.plot.traces[0].marker.color.as_deref(), Some("#ABCDEF"));
    assert_eq!(
        plot.plot.traces[1].y_axis,
        equavela_core::plot::TraceYAxis::Left
    );
    assert_eq!(
        plot.plot.traces[1].line,
        equavela_core::plot::TraceLineStyle::default()
    );
    assert_eq!(
        plot.plot.traces[1].marker,
        equavela_core::plot::TraceMarkerStyle::default()
    );
    let once = write_document(&first.document).unwrap();
    assert!(once.contains("grid_spacing: 2"));
    assert!(once.contains("y2: {scale: log10, min: 0.1, max: 100}"));
    assert!(once.contains("y_axis: right"));
    assert!(once.contains("line: {style: dash, width: 2, color: \"#123ABC\"}"));
    assert!(once.contains("marker: {shape: square, size: 8, color: \"#ABCDEF\"}"));
    let second = read(&once);
    assert_eq!(model(first), model(second));
}

///  and the specification : the four line patterns are written and read under the names the spec
/// and the UI use. A dash-dot trace therefore survives save and reload (: the import of a
/// the reference application `DashDot` trace found that the reader only accepted `dash_dot`).
#[test]
fn plot_dash_dot_line_style_round_trips_with_the_name_the_spec_uses() {
    let text = r##"format: equavela-worksheet/3
regions:
  - id: p
    at: [0, 0]
    plot:
      type: xy
      traces:
        - {id: t1, x: "x", y: "a", line: {style: dashdot, width: 2}}
"##;
    let first = read(text);
    let DocumentRegion::Plot(plot) = first.document.regions[0].as_ref() else {
        panic!("plot")
    };
    assert_eq!(
        plot.plot.traces[0].line.style,
        equavela_core::plot::TraceLinePattern::DashDot
    );
    let once = write_document(&first.document).unwrap();
    assert!(once.contains("line: {style: dashdot, width: 2}"), "{once}");
    assert_eq!(model(first), model(read(&once)));
}

///  and the specification : an axis limit is a bare number or a quoted math string, and both
/// read back as the same limit. A worksheet written before expression limits (numbers only) is
/// reproduced byte for byte.
#[test]
fn plot_axis_limits_are_numbers_or_math_expressions() {
    use equavela_core::plot::AxisLimit;
    let text = r#"format: equavela-worksheet/3
regions:
  - id: p
    at: [0, 0]
    plot:
      type: xy
      axes:
        x: {min: "-π/ω_0", max: "π/ω_0"}
        y: {min: 0, max: 5}
      traces:
        - {id: t1, x: "x", y: "sin(x)"}
"#;
    let first = read(text);
    let DocumentRegion::Plot(plot) = first.document.regions[0].as_ref() else {
        panic!("plot")
    };
    assert_eq!(
        plot.plot.axes.x.min,
        Some(AxisLimit::Expression("-π/ω_0".into()))
    );
    assert_eq!(
        plot.plot.axes.x.max,
        Some(AxisLimit::Expression("π/ω_0".into()))
    );
    assert_eq!(plot.plot.axes.y.min, Some(AxisLimit::Value(0.0)));
    assert_eq!(plot.plot.axes.y.max, Some(AxisLimit::Value(5.0)));
    // The canonical text is the golden: a number stays bare, an expression stays quoted math.
    let once = write_document(&first.document).unwrap();
    assert!(
        once.contains(r#"        x: {min: "-π/ω_0", max: "π/ω_0"}"#),
        "{once}"
    );
    assert!(once.contains("        y: {min: 0, max: 5}"), "{once}");
    let second = read(&once);
    assert_eq!(write_document(&second.document).unwrap(), once);
    assert_eq!(model(first), model(second));

    // A file written before expression limits carries numbers only and is unchanged.
    let numeric = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      axes:\n        x: {min: -0.25, max: 0.25}\n      traces:\n        - {id: t1, x: \"x\", y: \"x^2\"}\n";
    assert!(written(numeric).contains("x: {min: -0.25, max: 0.25}"));

    // A limit that does not parse, and an empty expression, are load errors naming the axis.
    let broken = parse_document(
        DocumentId::new("/t/sheet.eqv").unwrap(),
        "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      axes:\n        y: {min: \"+\"}\n      traces:\n        - {id: t1, x: \"x\", y: \"x^2\"}\n",
    )
    .unwrap_err()
    .to_string();
    assert!(broken.contains("y-axis minimum"), "{broken}");
    let empty = parse_document(
        DocumentId::new("/t/sheet.eqv").unwrap(),
        "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      axes:\n        x: {max: \"  \"}\n      traces:\n        - {id: t1, x: \"x\", y: \"x^2\"}\n",
    )
    .unwrap_err()
    .to_string();
    assert!(empty.contains("x-axis maximum"), "{empty}");
}

#[test]
fn polar_plot_type_round_trips_in_worksheet() {
    let first = read(
        r#"format: equavela-worksheet/3
regions:
  - id: p
    at: [0, 0]
    plot:
      type: polar
      traces:
        - {id: t1, x: "theta", y: "radius"}
"#,
    );
    let text = write_document(&first.document).unwrap();
    assert!(text.contains("type: polar"));
    let second = read(&text);
    assert_eq!(model(first), model(second));
}

#[test]
fn canonical_text_is_reproduced_byte_for_byte() {
    assert_eq!(written(CANONICAL), CANONICAL);
}

#[test]
fn canonical_text_reads_back_to_the_same_model() {
    let first = read(CANONICAL);
    let second = read(&write_document(&first.document).unwrap());
    assert_eq!(model(first), model(second));
}

/// Every fixture: the model survives a write, and a second write changes nothing.
#[test]
fn fixtures_round_trip_to_an_equal_model_and_a_stable_text() {
    for path in fixtures() {
        let name = path.display().to_string();
        let text = std::fs::read_to_string(&path).unwrap();
        let first = read_as("/t/x.eqv", &text);
        let once = write_document(&first.document).unwrap();
        let second = read_as("/t/x.eqv", &once);
        assert_eq!(model(first), model(second.clone()), "{name}");
        let twice = write_document(&second.document).unwrap();
        assert_eq!(once, twice, "{name}: writing is not idempotent");
    }
}

/// Writing an unchanged fixture gives the file back byte for byte. The one normalisation: a
/// `width:` written next to `text:` is not a field of the format (the reader ignores it), so
/// the writer drops it; the mapping form `text: {width, text}` is the way to say it.
#[test]
fn fixtures_are_reproduced_byte_for_byte() {
    for path in fixtures() {
        let name = path.display().to_string();
        let text = std::fs::read_to_string(&path).unwrap();
        let expected = text.replace("    width: 480\n", "");
        let out = written(&text);
        if let Some((n, (a, b))) = out
            .lines()
            .zip(expected.lines())
            .enumerate()
            .find(|(_, (a, b))| a != b)
        {
            panic!("{name} line {}: wrote `{a}`, file has `{b}`", n + 1);
        }
        assert_eq!(out, expected, "{name}");
    }
}

/// the writer emits the identity line; a file without it, or with the spelling
/// before (`sheet/1`), is not a worksheet.
#[test]
fn files_without_the_identity_line_are_rejected_and_the_writer_emits_it() {
    let regions = "regions:\n  - id: a\n    page: 1\n    at: [54, 72]\n    math: \"a := 1\"\n  - id: b\n    text: a note\n";
    let id = || DocumentId::new("/t/old.eqv").unwrap();
    for header in ["", "format: sheet/1\n"] {
        let error = parse_document(id(), &format!("{header}{regions}")).unwrap_err();
        assert!(error.to_string().contains("is not a worksheet"), "{error}");
    }
    let first = parse_document(id(), &format!("format: equavela-worksheet/3\n{regions}")).unwrap();
    let out = write_document(&first.document).unwrap();
    assert!(
        out.starts_with("format: equavela-worksheet/3\npage:\n"),
        "{out}"
    );
    let second = parse_document(id(), &out).unwrap();
    assert_eq!(model(first), model(second));
}

/// A file in the shape of the example (uniform margins, key order of the
/// first prototypes, flow-free traces, a `resources` section the reader ignores).
#[test]
fn a_full_adr_0015_example_round_trips() {
    let legacy = r#"format: equavela-worksheet/3
page:
  size: A4
  margins: 54
settings:
  origin: 0
regions:
  - id: r1
    page: 1
    at: [54, 72]
    text: |
      Simply supported beam, uniform load
  - id: r4
    page: 1
    at: [54, 170]
    math: "M.max := q·L^2/8"
  - id: p1
    page: 1
    at: [54, 320]
    plot:
      type: xy
      size: [360, 220]
      traces:
        - x: "x"
          y: "S(x)"
          id: t
resources: {}
"#;
    let id = || DocumentId::new("/t/beam.eqv").unwrap();
    let first = parse_document(id(), legacy).unwrap();
    let out = write_document(&first.document).unwrap();
    let second = parse_document(id(), &out).unwrap();
    assert_eq!(model(first), model(second));
    assert!(out.contains("margins: {top: 54, right: 54, bottom: 54, left: 54}"));
    assert!(out.contains("settings:\n  origin: 0\n"), "{out}");
}

#[test]
fn the_identity_line_is_byte_zero_with_lf_endings_and_no_bom() {
    let with_bom = format!("\u{feff}{CANONICAL}").replace('\n', "\r\n");
    let out = written(&with_bom);
    assert!(out.starts_with("format: equavela-worksheet/3\n"));
    assert!(!out.contains('\r'));
    assert!(!out.starts_with('\u{feff}'));
    assert!(out.ends_with('\n') && !out.ends_with("\n\n"));
    assert_eq!(out, CANONICAL);
}

#[test]
fn an_empty_document_is_written_and_read_back() {
    let empty = "format: equavela-worksheet/3\nregions: []\n";
    let out = written(empty);
    assert_eq!(
        out,
        "format: equavela-worksheet/3\npage:\n  size: A4\n  margins: {top: 72, right: 54, bottom: 72, left: 54}\nregions: []\n"
    );
    assert_eq!(model(read(&out)), model(read(empty)));
}

#[test]
fn page_setups_keep_their_size_orientation_and_custom_dimensions() {
    for page in [
        "size: A3\n  orientation: landscape\n  margins: {top: 10, right: 10, bottom: 10, left: 10}",
        "size: [300.5, 400]\n  margins: {top: 1, right: 2, bottom: 3, left: 4}",
        "size: Legal\n  margins: {top: 72, right: 54, bottom: 72, left: 54}",
    ] {
        let text = format!("format: equavela-worksheet/3\npage:\n  {page}\nregions: []\n");
        assert_eq!(written(&text), text);
    }
}

/// a label style is a worksheet `settings:` block per label — written sorted, the
/// flags bare, the colour quoted — read back as the same strings and reproduced byte for byte,
/// and a value the drawing cannot use is kept instead of failing the load.
#[test]
fn label_styles_round_trip_as_worksheet_settings() {
    let text = r##"format: equavela-worksheet/3
settings:
  label-style.kw.bold: false
  label-style.unit.color: "#c00000"
  label-style.var.italic: false
  label-style.var.strikeout: true
  label-style.var.underline: maybe
regions: []
"##;
    let first = read(text);
    assert_eq!(
        first.document.settings.values["label-style.var.italic"],
        "false"
    );
    assert_eq!(
        first.document.settings.values["label-style.unit.color"],
        "#c00000"
    );
    let out = write_document(&first.document).unwrap();
    // Key order (settings are sorted), the flags bare, the colour quoted.
    assert!(
        out.contains(
            "settings:\n  label-style.kw.bold: false\n  label-style.unit.color: \"#c00000\"\n  label-style.var.italic: false\n  label-style.var.strikeout: true\n  label-style.var.underline: maybe\n"
        ),
        "{out}"
    );
    let second = read(&out);
    assert_eq!(model(first), model(second.clone()));
    assert_eq!(write_document(&second.document).unwrap(), out);
}

/// Strings that need care: every one must read back exactly, as a text region, a settings
/// value and the environment, and no output may contain a carriage return.
#[test]
fn awkward_strings_round_trip() {
    let samples = [
        "plain words",
        "../up/one.eqv",
        "./here.eqv",
        "/abs/path.eqv",
        "..",
        "...",
        ".5",
        "yes",
        "No",
        "null",
        "~",
        "true",
        "12",
        "1e3",
        "0.10",
        "-5",
        ".inf",
        "0x1F",
        " leading space",
        "two  spaces",
        "colon: here",
        "hash # here",
        "- dash first",
        "? question",
        "[bracket]",
        "{brace}",
        "a, b",
        "quote ' inside",
        "double \" inside",
        "back\\slash",
        "both ' and \" and \\",
        "tab\tinside",
        "unicode: α ≤ β · γ → δ ∑ 日本語",
        "multi\nline",
        "multi\n  indented\n\nblank above",
        "trailing newline\n",
        "carriage\rreturn",
        "line with trailing space \nnext",
        "control \u{1} char",
        "line sep \u{2028} here",
        "&anchor",
        "*alias",
        "!tag",
        "%directive",
        "@at",
        "`tick",
        "|pipe",
        ">fold",
    ];
    for sample in samples {
        // The reader trims trailing whitespace of text, so compare to the trimmed value.
        let expected = sample.trim_end();
        let mut document = read("format: equavela-worksheet/3\nregions: []\n").document;
        document
            .regions
            .push(std::sync::Arc::new(DocumentRegion::Text(TextRegion {
                id: "t".into(),
                page: 1,
                x: 54.0,
                y: 72.0,
                enabled: true,
                width: Some(200.0),
                full_width: false,
                background: None,
                language: None,
                text: sample.to_owned(),
            })));
        document
            .settings
            .values
            .insert("key".into(), sample.to_owned());
        document.environment = Some(sample.to_owned());
        let out = write_document(&document).unwrap();
        assert!(!out.contains('\r'), "{sample:?}");
        let back = read(&out).document;
        match back.regions[0].as_ref() {
            DocumentRegion::Text(text) => {
                assert_eq!(text.text, expected, "text {sample:?}\n{out}")
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            back.settings.values["key"], sample,
            "setting {sample:?}\n{out}"
        );
        assert_eq!(
            back.environment.as_deref(),
            Some(sample),
            "environment {sample:?}"
        );
        // A second write is identical.
        if sample == expected {
            assert_eq!(write_document(&back).unwrap(), out, "{sample:?}");
        }
    }
}

#[test]
fn input_tables_round_trip_with_units_and_empty_cells() {
    let text = "format: equavela-worksheet/3\npage:\n  size: A4\nregions:\n  - id: t1\n    at: [54, 72]\n    table:\n      - name: x\n        cells:\n          - '1'\n          - ''\n      - name: m\n        unit: kg\n        cells:\n          - '2'\n          - '3'\n";
    let first = read_as(
        "table.eqv",
        &text.replace("      - name: x", "      columns:\n      - name: x"),
    );
    let out = write_document(&first.document).unwrap();
    // an old table is written back as a math region holding the table; an empty
    // cell is a placeholder.
    assert!(
        out.contains("table units:[x, m; □, kg; (1), (2); □, (3)]"),
        "{out}"
    );
    assert!(!out.contains("columns:"), "{out}");
    let again = read_as("table-again.eqv", &out);
    assert_eq!(first.document.regions.len(), again.document.regions.len());
    assert_eq!(write_document(&again.document).unwrap(), out);
}

#[test]
fn a_number_that_is_not_finite_is_refused() {
    let mut document =
        read("format: equavela-worksheet/3\nregions:\n  - id: a\n    math: \"a := 1\"\n").document;
    if let DocumentRegion::Math(region) = std::sync::Arc::make_mut(&mut document.regions[0]) {
        region.x = f64::NAN;
    }
    assert!(matches!(
        write_document(&document),
        Err(WriteError::NotFinite { .. })
    ));
}

#[test]
fn files_are_written_atomically_over_an_existing_file() {
    let dir = std::env::temp_dir().join(format!("equavela-writer-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("a.eqv");
    std::fs::write(&path, "old").unwrap();
    write_file_atomic(&path, CANONICAL).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), CANONICAL);
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(leftovers, vec!["a.eqv".to_owned()]);
    // A target in a directory that does not exist is an error and leaves nothing behind.
    let missing = dir.join("no-such-dir").join("b.eqv");
    assert!(matches!(
        write_file_atomic(&missing, "x"),
        Err(WriteError::Io { .. })
    ));
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A text block ignores a stored x on load and is written at the left margin; a margin change
/// followed by `snap_text_blocks` keeps it there.
#[test]
fn a_text_block_starts_at_the_left_margin() {
    let text = "format: equavela-worksheet/3\npage:\n  size: A4\n  margins: {top: 72, right: 54, bottom: 72, left: 40}\nregions:\n  - id: b\n    page: 1\n    at: [300, 100]\n    text:\n      width: full\n      text: A block\n  - id: t\n    page: 1\n    at: [300, 150]\n    text: A region\n";
    let mut document = read(text).document;
    let x_of = |document: &ProjectDocument, index: usize| match document.regions[index].as_ref() {
        DocumentRegion::Text(text) => text.x,
        other => panic!("{other:?}"),
    };
    assert_eq!(x_of(&document, 0), 40.0);
    assert_eq!(x_of(&document, 1), 300.0);
    let out = write_document(&document).unwrap();
    assert!(out.contains("    at: [40, 100]\n"), "{out}");
    document.page.margins.left = 72.0;
    document.snap_text_blocks();
    assert_eq!(x_of(&document, 0), 72.0);
    assert_eq!(x_of(&document, 1), 300.0);
    assert!(write_document(&document)
        .unwrap()
        .contains("    at: [72, 100]\n"));
}

/// The paragraph styles and alignments of a text region survive the file: the
/// stored linear text is the canonical one, and reading it back gives the same value.
#[test]
fn paragraph_styles_and_alignment_round_trip_through_the_file() {
    let linear = "{style=heading1}Chapter 1\n\n{align=center}The ratio $a/b$ is important.\n\n{style=subtitle}{align=right}Right";
    let mut document = read("format: equavela-worksheet/3\nregions: []\n").document;
    document
        .regions
        .push(std::sync::Arc::new(DocumentRegion::Text(TextRegion {
            id: "t".into(),
            page: 1,
            x: 54.0,
            y: 72.0,
            enabled: true,
            width: Some(300.0),
            full_width: false,
            background: None,
            language: None,
            text: equavela_core::richtext::canonical(linear),
        })));
    let out = write_document(&document).unwrap();
    assert!(out.contains("{style=heading1}Chapter 1"), "{out}");
    assert!(out.contains("{align=center}The ratio"), "{out}");
    let back = read(&out).document;
    let DocumentRegion::Text(text) = back.regions[0].as_ref() else {
        panic!("text region expected");
    };
    assert_eq!(text.text, linear);
    let value = equavela_core::richtext::RichText::parse(&text.text);
    assert_eq!(
        value
            .0
            .iter()
            .map(|p| (p.style, p.align))
            .collect::<Vec<_>>(),
        vec![
            (
                equavela_core::richtext::ParagraphStyle::Heading1,
                equavela_core::richtext::ParagraphAlign::Left
            ),
            (
                equavela_core::richtext::ParagraphStyle::Normal,
                equavela_core::richtext::ParagraphAlign::Center
            ),
            (
                equavela_core::richtext::ParagraphStyle::Subtitle,
                equavela_core::richtext::ParagraphAlign::Right
            ),
        ]
    );
    // A paragraph written before this rule reads back unchanged, and is Normal and left.
    let plain = equavela_core::richtext::RichText::parse("Simply supported beam");
    assert_eq!(plain.print(), "Simply supported beam");
    assert_eq!(
        plain.0[0].style,
        equavela_core::richtext::ParagraphStyle::Normal
    );
    assert_eq!(
        plain.0[0].align,
        equavela_core::richtext::ParagraphAlign::Left
    );
}

/// Insertion at the crosshair's x and a move keep a text block at the left margin (the model
/// itself, not only the view); an ordinary text region moves freely.
#[test]
fn edits_keep_a_text_block_at_the_left_margin() {
    use equavela_core::edit::{apply, EditCommand, StoredRegion};
    let mut document = read("format: equavela-worksheet/3\nregions: []\n").document;
    let mut texts = std::collections::HashMap::new();
    let text = |id: &str, full_width: bool| {
        DocumentRegion::Text(TextRegion {
            id: id.into(),
            page: 1,
            x: 300.0,
            y: 100.0,
            enabled: true,
            width: None,
            full_width,
            background: None,
            language: None,
            text: "T".into(),
        })
    };
    for (id, full) in [("block", true), ("plain", false)] {
        let region = StoredRegion {
            region: text(id, full),
            math_text: None,
        };
        apply(
            &mut document,
            &mut texts,
            EditCommand::Insert { region, index: 9 },
        )
        .unwrap();
    }
    let x_of = |document: &ProjectDocument, i: usize| match document.regions[i].as_ref() {
        DocumentRegion::Text(text) => (text.x, text.y),
        other => panic!("{other:?}"),
    };
    assert_eq!(x_of(&document, 0), (54.0, 100.0));
    assert_eq!(x_of(&document, 1), (300.0, 100.0));
    for id in ["block", "plain"] {
        apply(
            &mut document,
            &mut texts,
            EditCommand::Move {
                region_id: id.into(),
                page: 1,
                x: 400.0,
                y: 250.0,
            },
        )
        .unwrap();
    }
    assert_eq!(x_of(&document, 0), (54.0, 250.0));
    assert_eq!(x_of(&document, 1), (400.0, 250.0));
}

/// A recovery file is loaded under the name of the worksheet it belongs to (a file that need not
/// exist, or a bare `Untitled-N.eqv`), not under its own name.
#[test]
fn a_root_text_is_loaded_under_the_given_name() {
    let text = "format: equavela-worksheet/3\nregions:\n  - id: a\n    at: [54, 72]\n    math: \"a := 1\"\n";
    let bare = DocumentId::new("Untitled-3.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(bare.clone(), text).unwrap();
    assert_eq!(loaded.root, bare);
    assert_eq!(loaded.project.document(&bare).unwrap().regions.len(), 1);
    assert!(loaded.missing.is_empty());
    // An unreadable text is an error naming that document.
    let error =
        equavela_core::worksheet_file::load_project_text(bare, "not a worksheet\n").unwrap_err();
    assert!(error.to_string().contains("Untitled-3.eqv"), "{error}");
}

/// the box of a result table is the `result-table-size` key of the region's
/// display override, `"width,height"` in points. It is written with the region, read back as
/// the same string (so a resized table survives save and reopen) and a value the reader cannot
/// use is stored as it is instead of failing the load.
#[test]
fn the_result_table_box_round_trips_as_a_region_display_setting() {
    let text = r#"format: equavela-worksheet/3
regions:
  - id: a
    page: 1
    at: [54, 72]
    math: "B ="
    format:
      result-table-size: "480,180"
  - id: b
    page: 1
    at: [54, 300]
    math: "C ="
    format:
      result-table-size: not-a-size
"#;
    let first = read(text);
    // The key is stored as a plain string in the region's display override.
    let stored = |document: &ProjectDocument, id: &str| {
        document
            .result_formats
            .get(id)
            .and_then(|format| format.get("result-table-size"))
            .cloned()
    };
    assert_eq!(stored(&first.document, "a").as_deref(), Some("480,180"));
    // The writer quotes a value that does not start with a letter: it reads back unchanged.
    let out = write_document(&first.document).unwrap();
    assert!(
        out.contains("      result-table-size: \"480,180\"\n"),
        "{out}"
    );
    let second = read(&out);
    assert_eq!(model(first), model(second.clone()));
    assert_eq!(write_document(&second.document).unwrap(), out);
    // `not-a-size` is a plain scalar (it starts with a letter), so it is kept as written: the
    // reader stores it and the display ignores it, nothing fails.
    assert!(
        out.contains("      result-table-size: not-a-size\n"),
        "{out}"
    );
}

/// the math font of a region is three keys of the same region display override
/// as the result format: read back as the same strings, written in key order with the colours
/// quoted and the size bare, reproduced byte for byte, and a value the display cannot use is
/// kept instead of failing the load.
#[test]
fn the_math_font_round_trips_as_a_region_display_setting() {
    let text = r##"format: equavela-worksheet/3
regions:
  - id: a
    page: 1
    at: [54, 72]
    math: "x := 1"
    format:
      math-font.color: "#c00000"
      math-font.highlight: "#ffff00"
      math-font.size: 15
  - id: b
    page: 1
    at: [54, 300]
    math: "y := 2"
    format:
      math-font.color: not-a-colour
      math-font.size: 13
"##;
    let first = read(text);
    let stored = |document: &ProjectDocument, id: &str, key: &str| {
        document
            .result_formats
            .get(id)
            .and_then(|format| format.get(key))
            .cloned()
    };
    assert_eq!(
        stored(&first.document, "a", "math-font.size").as_deref(),
        Some("15")
    );
    assert_eq!(
        stored(&first.document, "a", "math-font.color").as_deref(),
        Some("#c00000")
    );
    assert_eq!(
        stored(&first.document, "a", "math-font.highlight").as_deref(),
        Some("#ffff00")
    );
    let out = write_document(&first.document).unwrap();
    // Key order, a canonical integer bare and the two colours quoted.
    assert!(
        out.contains(
            "    format:\n      math-font.color: \"#c00000\"\n      math-font.highlight: \"#ffff00\"\n      math-font.size: 15\n"
        ),
        "{out}"
    );
    let second = read(&out);
    assert_eq!(model(first), model(second.clone()));
    assert_eq!(write_document(&second.document).unwrap(), out);
    // A value the display cannot use is stored as written, as for the table box: nothing fails.
    assert!(
        out.contains("      math-font.color: not-a-colour\n      math-font.size: 13\n"),
        "{out}"
    );
}

/// the display choice of a matrix result is the `format.matrix-display`
/// key of the region's display override, `table` or `matrix`. It is written with the region in key
/// order before the table box, read back as the same string (so the choice survives save and
/// reopen), reproduced byte for byte, and a value that is neither is kept as written instead of
/// failing the load.
#[test]
fn the_matrix_display_round_trips_as_a_region_display_setting() {
    let text = r#"format: equavela-worksheet/3
regions:
  - id: a
    page: 1
    at: [54, 72]
    math: "B ="
    format:
      format.matrix-display: matrix
      result-table-size: "480,180"
  - id: b
    page: 1
    at: [54, 300]
    math: "C ="
    format:
      format.matrix-display: sideways
"#;
    let first = read(text);
    // The key is stored as a plain string in the region's display override.
    let stored = |document: &ProjectDocument, id: &str| {
        document
            .result_formats
            .get(id)
            .and_then(|format| format.get("format.matrix-display"))
            .cloned()
    };
    assert_eq!(stored(&first.document, "a").as_deref(), Some("matrix"));
    // A value the display cannot use is stored as written: nothing fails.
    assert_eq!(stored(&first.document, "b").as_deref(), Some("sideways"));
    let out = write_document(&first.document).unwrap();
    // Key order, the display choice a plain scalar and the box quoted.
    assert!(
        out.contains(
            "    format:\n      format.matrix-display: matrix\n      result-table-size: \"480,180\"\n"
        ),
        "{out}"
    );
    let second = read(&out);
    assert_eq!(model(first), model(second.clone()));
    assert_eq!(write_document(&second.document).unwrap(), out);
    assert!(
        out.contains("      format.matrix-display: sideways\n"),
        "{out}"
    );
}

/// the spelling language of a text region is written in the mapping form after the
/// background, an id that is not a language is dropped, and the worksheet spelling keys are settings.
#[test]
fn a_text_language_and_the_spelling_settings_round_trip() {
    let source = "format: equavela-worksheet/3\nsettings:\n  spelling.ignore: Navier Stokes\n  spelling.language: it_IT\nregions:\n  - id: r1\n    page: 1\n    at: [54, 72]\n    text:\n      language: en_US\n      text: Beam\n  - id: r2\n    page: 1\n    at: [54, 200]\n    text:\n      language: ../en\n      text: Plain\n";
    let loaded = read(source);
    let languages: Vec<Option<String>> = loaded
        .document
        .regions
        .iter()
        .map(|region| match region.as_ref() {
            DocumentRegion::Text(text) => text.language.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(languages, vec![Some("en_US".to_owned()), None]);
    let written = write_document(&loaded.document).unwrap();
    assert!(
        written.contains("    text:\n      language: en_US\n      text: Beam"),
        "{written}"
    );
    assert!(written.contains("    text: Plain"), "{written}");
    assert!(written.contains("spelling.language: it_IT"), "{written}");
    assert!(
        written.contains("spelling.ignore: Navier Stokes"),
        "{written}"
    );
    assert_eq!(write_document(&read(&written).document).unwrap(), written);
}

/// the fill of a text region is written in the mapping form, quoted, after the width; a
/// stored value that is not `#rrggbb` is no fill.
#[test]
fn a_text_background_round_trips_and_a_bad_one_is_none() {
    let source = "format: equavela-worksheet/3\nregions:\n  - id: r1\n    page: 1\n    at: [54, 72]\n    text:\n      width: 200\n      background: \"#fdfdd5\"\n      text: Beam\n  - id: r2\n    page: 1\n    at: [54, 200]\n    text:\n      background: \"yellow\"\n      text: Plain\n";
    let loaded = read(source);
    let fills: Vec<Option<String>> = loaded
        .document
        .regions
        .iter()
        .map(|region| match region.as_ref() {
            DocumentRegion::Text(text) => text.background.clone(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(fills, vec![Some("#fdfdd5".to_owned()), None]);
    let written = write_document(&loaded.document).unwrap();
    assert!(
        written.contains("      width: 200\n      background: \"#fdfdd5\"\n      text: Beam"),
        "{written}"
    );
    // The second region has no fill any more, so it is written in the plain form.
    assert!(written.contains("    text: Plain"), "{written}");
    assert_eq!(write_document(&read(&written).document).unwrap(), written);
}

/// The code of the first Julia block of a worksheet text.
fn julia_code(text: &str) -> Option<String> {
    read(text)
        .document
        .regions
        .iter()
        .find_map(|region| match region.as_ref() {
            DocumentRegion::Math(region) => match &region.statement.kind {
                equavela_core::ast::StatementKind::Julia { block } => Some(block.code.clone()),
                _ => None,
            },
            _ => None,
        })?
}

#[test]
fn julia_code_keeps_its_trailing_empty_lines() {
    // the specification, `code`: the box can show or hide them.
    let text = "format: equavela-worksheet/3\nregions:\n  - id: j\n    at: [72, 72]\n    julia:\n      size: [300, 120]\n      code: |+\n        x = 1\n\n\n";
    assert_eq!(julia_code(text).as_deref(), Some("x = 1\n\n"));
    let again = written(text);
    assert!(
        again.contains("      code: |+\n        x = 1\n\n\n"),
        "{again}"
    );
    assert_eq!(julia_code(&again).as_deref(), Some("x = 1\n\n"));
    // Code without trailing lines keeps the plain block scalar, as before.
    let plain = "format: equavela-worksheet/3\nregions:\n  - id: j\n    at: [72, 72]\n    julia:\n      code: |\n        x = 1\n";
    assert_eq!(julia_code(plain).as_deref(), Some("x = 1"));
    assert!(written(plain).contains("      code: |\n        x = 1\n"));
}

#[test]
fn write_bytes_atomic_handles_concurrent_same_process_writes() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("beam.eqv");
    let handles: Vec<_> = (0..8)
        .map(|worker| {
            let path = target.clone();
            std::thread::spawn(move || {
                for step in 0..20 {
                    let payload = format!("worker-{worker}-step-{step}\n");
                    equavela_core::worksheet_writer::write_bytes_atomic(&path, payload.as_bytes())
                        .unwrap();
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let final_text = std::fs::read_to_string(&target).unwrap();
    assert!(
        final_text.starts_with("worker-") && final_text.ends_with('\n'),
        "{final_text:?}"
    );
    // No leftover temp files in the directory.
    let entries: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(entries.len(), 1, "{entries:?}");
}
