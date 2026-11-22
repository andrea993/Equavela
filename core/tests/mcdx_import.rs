//! `.mcdx` import: golden tests on synthetic packages and the
//! optional corpus test (`EQUAVELA_MCDX_CORPUS`).
//!
//! A fixture is a directory of package parts under `fixtures/mcdx/<name>/`; a directory whose
//! name ends in `.XamlPackage` is zipped into a nested package (the text parts of a `.mcdx`).
//! The golden text is `fixtures/mcdx/<name>.expected.eqv`; `EQUAVELA_UPDATE_GOLDEN=1` rewrites it.

use equavela_core::mcdx::{import_mcdx_bytes, Imported};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcdx")
}

fn add_dir(
    writer: &mut zip::ZipWriter<Cursor<Vec<u8>>>,
    root: &Path,
    dir: &Path,
) -> std::io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        if path.is_dir() {
            if name.ends_with(".XamlPackage") {
                let mut inner = zip::ZipWriter::new(Cursor::new(Vec::new()));
                add_dir(&mut inner, &path, &path)?;
                let bytes = inner.finish().unwrap().into_inner();
                writer
                    .start_file(name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(&bytes)?;
            } else {
                add_dir(writer, root, &path)?;
            }
        } else {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(&std::fs::read(&path)?)?;
        }
    }
    Ok(())
}

/// The package bytes of fixture `name`.
fn package(name: &str) -> Vec<u8> {
    let root = fixtures().join(name);
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    add_dir(&mut writer, &root, &root).unwrap();
    writer.finish().unwrap().into_inner()
}

fn import(name: &str) -> Imported {
    import_mcdx_bytes(&package(name), &format!("{name}.mcdx")).expect("the fixture imports")
}

fn check_golden(name: &str, imported: &Imported) {
    let path = fixtures().join(format!("{name}.expected.eqv"));
    if std::env::var("EQUAVELA_UPDATE_GOLDEN").is_ok() || !path.exists() {
        std::fs::write(&path, &imported.text).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(imported.text, expected, "golden {name}");
}

#[test]
fn basic_package_matches_the_golden_worksheet() {
    let imported = import("basic");
    check_golden("basic", &imported);
    println!("{:#?}", imported.report);
}

/// a symbolic command may store its keyword and arguments in one `ml:sequence`.
#[test]
fn symbolic_command_sequence_arguments_import_in_order() {
    let imported = import("symcommand");
    check_golden("symcommand", &imported);
    check_report_golden("symcommand", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    assert!(
        imported.text.contains("math: \"x + y →[simplify, x, y]\""),
        "{}",
        imported.text
    );
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported symbolic command");
}

/// the reference application saves a keyword with two or more arguments as left-nested sequences; they import as
/// one keyword group.
#[test]
fn nested_symbolic_command_sequences_import_as_one_group() {
    let imported = import("symnested");
    check_golden("symnested", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    assert!(
        imported.text.contains("math: \"e^x →[series, x, 4]\""),
        "{}",
        imported.text
    );
    assert!(
        imported.text.contains("math: \"x - y →[solve, x, y, z]\""),
        "{}",
        imported.text
    );
}

///  / : a named function definition can be an inline argument to a call.
#[test]
fn a_function_definition_as_a_call_argument_imports() {
    let imported = import("functionarg");
    check_golden("functionarg", &imported);
    check_report_golden("functionarg", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    assert!(
        imported
            .text
            .contains("math: \"matrix(2, 2, g(i, j) ← i + j) =\""),
        "{}",
        imported.text
    );
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported local function argument");
}

#[test]
fn the_imported_text_is_a_readable_worksheet() {
    let imported = import("basic");
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported text");
    assert!(!loaded
        .project
        .documents()
        .next()
        .unwrap()
        .regions
        .is_empty());
}

/// One line per issue or note: `kind code region message`.
fn report_lines(imported: &Imported) -> String {
    let r = &imported.report;
    let mut out = format!(
        "total {} imported {} page-breaks {}
",
        r.regions_total, r.regions_imported, r.page_breaks
    );
    for (kind, items) in [("issue", &r.issues), ("note", &r.notes)] {
        for i in items {
            out.push_str(&format!(
                "{kind} {} {} {}
",
                i.code,
                i.region.as_deref().unwrap_or("-"),
                i.message
            ));
        }
    }
    out
}

fn check_report_golden(name: &str, imported: &Imported) {
    let lines = report_lines(imported);
    let path = fixtures().join(format!("{name}.report.expected.txt"));
    if std::env::var("EQUAVELA_UPDATE_GOLDEN").is_ok() || !path.exists() {
        std::fs::write(&path, &lines).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(lines, expected, "issue report of the `{name}` fixture");
}

#[test]
fn unsupported_content_is_reported_never_dropped_silently() {
    let imported = import("issues");
    check_golden("issues", &imported);
    check_report_golden("issues", &imported);
}

///  and the smaller math gaps of slice 2: every imported program passed `parse_statement`
/// (the importer validates), and the golden shows the canonical block form.
#[test]
fn programs_and_math_gaps_match_the_golden_worksheet() {
    let imported = import("programs");
    check_golden("programs", &imported);
    check_report_golden("programs", &imported);
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported programs");
}

///  (GitHub ): a program's local definition may define a function, and in
/// `.mcdx` its target is an `ml:function` (`ml:id` plus `ml:boundVars`), as on the left side of a
/// worksheet `define`. Every region of the fixture imports with no issue.
#[test]
fn a_program_local_function_is_imported() {
    let imported = import("programsfn");
    check_golden("programsfn", &imported);
    check_report_golden("programsfn", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    // The target keeps its parameters and reaches the canonical block form (math-syntax 8.4).
    assert!(
        imported.text.contains("    g(x) ← x·Q + T\n"),
        "{}",
        imported.text
    );
    assert!(
        imported.text.contains("    fact(k) ← program\n"),
        "{}",
        imported.text
    );
    // A function head with no parameters is a local definition of a function of none.
    assert!(
        imported.text.contains("    g() ← n + 1\n"),
        "{}",
        imported.text
    );
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported local functions");
}

///  (GitHub ): a destructuring definition whose cells are matrices,
/// a call with a destructuring inline argument, and a nested destructuring in a program all
/// import, and every region passes `parse_statement` (the importer validates).
#[test]
fn a_nested_destructuring_target_is_imported() {
    let imported = import("destructure");
    check_golden("destructure", &imported);
    check_report_golden("destructure", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    // The `ml:matrix` of the left side keeps its nested cell, column-major in the file.
    assert!(
        imported
            .text
            .contains("math: \"[A11, A12; [A211; A212], A22] := f(x)\""),
        "{}",
        imported.text
    );
    // The target of the inline argument definition is a matrix.
    assert!(
        imported.text.contains("math: \"f(a, [x, y] ← [1, 2])\""),
        "{}",
        imported.text
    );
    // A program's local definition unpacks a nested array too, in the canonical block form.
    assert!(
        imported.text.contains("    [a, [b; c]] ← M\n"),
        "{}",
        imported.text
    );
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported nested destructuring");
}

///  to 5 (GitHub ): an `ml:apply` whose head is itself the `indexer`
/// apply is a call of an element of an array — `F[i](x)`, `F[i, j](x)` — and it is imported with
/// no issue.
#[test]
fn a_call_of_an_element_of_an_array_is_imported() {
    let imported = import("indexcall");
    check_golden("indexcall", &imported);
    check_report_golden("indexcall", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    for text in ["F[0](3) =", "F[i](x) =", "M[i, j](2) ="] {
        assert!(
            imported.text.contains(&format!("math: \"{text}\"")),
            "{}",
            imported.text
        );
    }
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported element call");
}

///  (GitHub ): a `localDefine` in an operand position — alone, or under
/// an `ml:parens` that then adds no second pair — is the parenthesised local definition of
/// the specification, and it is imported with no issue.
#[test]
fn a_parenthesised_local_definition_is_imported() {
    let imported = import("parendef");
    check_golden("parendef", &imported);
    check_report_golden("parendef", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    for text in [
        "v := ([a, b, c] ← [1, 2, 3])ᵀ",
        // `ml:parens` around the definition and the bare definition give the same text.
        "y := g(x)/(z ← 3)",
        "w := g(x)/(z ← 3)",
        "u := (z ← 3) + 1",
    ] {
        assert!(
            imported.text.contains(&format!("math: \"{text}\"")),
            "{}",
            imported.text
        );
    }
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported parenthesised definition");
}

#[test]
fn a_file_that_is_not_a_worksheet_is_refused_with_a_clear_error() {
    let error = import_mcdx_bytes(b"this is not a zip", "x.mcdx").unwrap_err();
    assert!(
        error.to_string().contains("not an .mcdx worksheet"),
        "{error}"
    );
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("other/readme.txt", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"hi").unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let error = import_mcdx_bytes(&bytes, "y.mcdx").unwrap_err();
    assert!(
        error.to_string().contains("the worksheet part is missing"),
        "{error}"
    );
}

#[test]
fn import_never_modifies_the_source_or_writes_next_to_it() {
    let dir = std::env::temp_dir().join(format!("equavela-mcdx-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("source.mcdx");
    std::fs::write(&file, package("basic")).unwrap();
    let before_bytes = std::fs::read(&file).unwrap();
    let before_time = std::fs::metadata(&file).unwrap().modified().unwrap();
    let listing = |d: &Path| {
        let mut names: Vec<_> = std::fs::read_dir(d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    };
    let before_listing = listing(&dir);
    let imported = equavela_core::mcdx::import_mcdx(&file).expect("imports from a path");
    assert!(imported.text.starts_with(
        "format: equavela-worksheet/3
"
    ));
    assert_eq!(std::fs::read(&file).unwrap(), before_bytes);
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        before_time
    );
    assert_eq!(listing(&dir), before_listing);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_missing_file_is_an_io_error_naming_the_path() {
    let error = equavela_core::mcdx::import_mcdx(Path::new("no/such/file.mcdx")).unwrap_err();
    assert!(error.to_string().contains("no/such/file.mcdx"), "{error}");
}

fn collect_mcdx(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_mcdx(&path, out);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("mcdx"))
        {
            out.push(path);
        }
    }
}

/// Top-level `region` elements of the package, counted without the importer.
fn top_level_regions(bytes: &[u8]) -> usize {
    let mut package = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xml = String::new();
    std::io::Read::read_to_string(
        &mut package.by_name("mathcad/worksheet.xml").unwrap(),
        &mut xml,
    )
    .unwrap();
    let doc = roxmltree::Document::parse(xml.trim_start_matches('\u{feff}')).unwrap();
    let list = doc
        .root_element()
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "regions");
    // The regions nested in an Area count too: they are imported as regions of their own.
    list.map(|l| {
        let top = l
            .children()
            .filter(|n| n.is_element() && n.tag_name().name() == "region")
            .count();
        let nested = l
            .descendants()
            .filter(|n| n.is_element() && n.tag_name().name() == "Area")
            .flat_map(|area| area.descendants())
            .filter(|n| n.is_element() && n.tag_name().name() == "region")
            .count();
        top + nested
    })
    .unwrap_or(0)
}

/// the real worksheets, from `EQUAVELA_MCDX_CORPUS`; skipped when the variable is not
/// set. The files are read-only inputs and are never copied.
#[test]
fn corpus_imports_without_error() {
    let Ok(corpus) = std::env::var("EQUAVELA_MCDX_CORPUS") else {
        eprintln!("EQUAVELA_MCDX_CORPUS is not set: corpus test skipped");
        return;
    };
    let mut files = Vec::new();
    collect_mcdx(Path::new(&corpus), &mut files);
    assert!(!files.is_empty(), "no .mcdx file below {corpus}");
    let mut totals = std::collections::BTreeMap::<String, usize>::new();
    let (mut total, mut imported_regions) = (0, 0);
    for file in &files {
        let bytes = std::fs::read(file).unwrap();
        let imported = import_mcdx_bytes(&bytes, &file.display().to_string())
            .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
        equavela_core::worksheet_file::load_project_text(id, &imported.text)
            .unwrap_or_else(|e| panic!("{}: reader rejects the import: {e}", file.display()));
        let r = &imported.report;
        assert_eq!(
            r.regions_total + r.page_breaks,
            top_level_regions(&bytes),
            "{}: region count",
            file.display()
        );
        total += r.regions_total;
        imported_regions += r.regions_imported;
        if std::env::var("EQUAVELA_MCDX_VERBOSE").is_ok() {
            for i in &r.issues {
                if i.code == "math-unparsable" || i.code == "math-unsupported" {
                    eprintln!(
                        "    {} {}: {}",
                        i.code,
                        i.region.as_deref().unwrap_or("-"),
                        i.message
                    );
                }
            }
        }
        for (code, n) in r.counts() {
            *totals.entry(code).or_default() += n;
        }
        eprintln!(
            "{:40} regions {:5} imported {:5} issues {:4}",
            file.file_name().unwrap().to_string_lossy(),
            r.regions_total,
            r.regions_imported,
            r.issues.len()
        );
    }
    eprintln!(
        "TOTAL files {} regions {total} imported {imported_regions}",
        files.len()
    );
    for (code, n) in totals {
        eprintln!("  {code}: {n}");
    }
}

/// a slot written with `style` / `xml:lang` attributes counts when the attribute-less
/// space runs are fewer than the nested regions; typed spaces that carry `style` stay text when
/// the attribute-less runs already match. The math keeps its evaluation tail.
#[test]
fn formatted_placeholders_hold_inline_math() {
    let imported = import("inlinemath");
    check_golden("inlinemath", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    assert_eq!(imported.text.matches('$').count(), 2 * 5);
    assert!(imported.text.contains("$b := 2·a =$"));
    // the highlight of a math region is its math font highlight, so it is no longer a note.
    assert_eq!(
        imported
            .report
            .notes
            .iter()
            .filter(|n| n.code == "math-style-dropped")
            .count(),
        0
    );
    assert!(
        imported.text.contains("math-font.highlight: \"#fff200\""),
        "{}",
        imported.text
    );
}

///  and the specification : an axis limit that is an expression is imported as the
/// expression itself, canonical, so it keeps following its definition; the value the reference application saved
/// for it is not used and the plot carries no note. A typed number stays a number.
#[test]
fn plot_limits_given_by_expressions_keep_the_expression() {
    let imported = import("plotlimits");
    check_golden("plotlimits", &imported);
    assert!(
        // `L` is defined nowhere and carries no label: the reference application draws it as a name, so it stays one.
        imported.text.contains(r#"x: {min: "-L/2", max: "L/2"}"#),
        "{}",
        imported.text
    );
    assert!(
        !imported
            .report
            .notes
            .iter()
            .any(|n| n.code == "plot-limits-frozen"),
        "{:?}",
        imported.report.notes
    );
    // The y start is an expression too and is kept as written; the typed y end stays a number.
    assert!(
        imported
            .text
            .contains(r#"y: {min: "undefinedname", max: 5}"#),
        "{}",
        imported.text
    );
    // The worksheet the importer wrote reads back as the same plot limits.
    use equavela_core::plot::AxisLimit;
    let id = equavela_core::project::DocumentId::new("plotlimits.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported plot");
    let document = loaded.project.documents().next().unwrap();
    let equavela_core::project::DocumentRegion::Plot(plot) = document.regions[0].as_ref() else {
        panic!("the first region is a plot");
    };
    assert_eq!(
        plot.plot.axes.x.min,
        Some(AxisLimit::Expression("-L/2".into()))
    );
    assert_eq!(
        plot.plot.axes.y.max,
        Some(AxisLimit::Value(5.0)),
        "a typed number stays a number"
    );
}

///  / : `array-origin` other than 0 becomes the worksheet's `ORIGIN` setting, with
/// no note.
#[test]
fn a_nonzero_array_origin_becomes_the_origin_setting() {
    // The `basic` fixture stores `array-origin="1"`.
    let imported = import("basic");
    assert!(imported.text.contains("ORIGIN: 1"), "{}", imported.text);
    assert!(!imported
        .report
        .notes
        .iter()
        .any(|n| n.code == "origin-nonzero-ignored"));
}

///  / : the two tolerances of `calculation.xml` become the worksheet settings
/// `TOL` and `CTOL`, and a value equal to the built-in default is not stored.
#[test]
fn the_tolerances_of_the_calculation_settings_are_imported() {
    // The `basic` fixture stores `convergence-tolerance="0.0001"` and
    // `constraint-tolerance="0.005"`.
    let imported = import("basic");
    assert!(
        imported.text.contains("  CTOL: \"0.005\"\n"),
        "{}",
        imported.text
    );
    assert!(
        imported.text.contains("  TOL: \"0.0001\"\n"),
        "{}",
        imported.text
    );
    // A file at the defaults carries no tolerance key at all: this one has no
    // `constraint-tolerance` other than the default.
    let plain = import("plots");
    assert!(!plain.text.contains("  CTOL:"), "{}", plain.text);
}

///  step 5 (GitHub ): a reference application `pageBreak` becomes a `page-breaks:` entry for the
/// page it ends, at most one per page and in the frame of the regions of that page. The regions
/// after a break continue on the next page; a page that starts because the content reached the
/// bottom margin is not a manual break and gets no entry; a break below the bottom margin is
/// clamped to the printable bottom, where it frees no space, with a note.
#[test]
fn an_mcdx_page_break_becomes_a_page_break_entry() {
    use equavela_core::layout::PageBreak;
    let imported = import("pagebreaks");
    check_golden("pagebreaks", &imported);
    check_report_golden("pagebreaks", &imported);
    assert_eq!(imported.report.page_breaks, 3);
    assert!(
        imported
            .report
            .notes
            .iter()
            .any(|note| note.code == "page-break-clamped"),
        "{:?}",
        imported.report.notes
    );
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported page breaks");
    let document = loaded.project.document(&loaded.root).unwrap();
    // Page 1 ends at its break, page 3 by an explicit break after an overflow page, page 4 at the
    // printable bottom because the reference application's break lies in the bottom margin.
    assert_eq!(
        document.page_breaks,
        vec![
            PageBreak { page: 1, y: 297.0 },
            PageBreak { page: 3, y: 147.0 },
            PageBreak { page: 4, y: 769.89 },
        ]
    );
    // The five math regions of the fixture land one per page (page 2 starts by overflow, not by a
    // break of the author's, so no entry ends page 2).
    let pages: Vec<u32> = document
        .regions
        .iter()
        .map(|region| region.page())
        .collect();
    assert_eq!(pages, vec![1, 2, 3, 4, 5]);
    // reading the imported text and writing it again gives the same file.
    let written = equavela_core::worksheet_writer::write_document(document)
        .expect("the imported breaks are valid");
    assert_eq!(written, imported.text);
}

///  step 5: a `pageBreak` nested in a container is a region of that container, not of the page
/// flow: it ends no page and stores no entry, but the report counts it and notes it.
#[test]
fn a_page_break_nested_in_a_container_ends_no_page() {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("mathcad/worksheet.xml", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(
            br#"<worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>
<region region-id="0" width="300" height="120" top="18.9" left="0"><Area Title="A"><regions>
<region region-id="1" height="8" width="300" top="0" left="0"><pageBreak /></region>
<region region-id="2" actualWidth="47.7" actualHeight="25.6" top="40" left="0"><math><ml:define><ml:id>a</ml:id><ml:real>1</ml:real></ml:define></math></region>
</regions></Area></region>
</regions></worksheet>"#,
        )
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let imported = import_mcdx_bytes(&bytes, "nested.mcdx").expect("the fixture imports");
    assert_eq!(imported.report.page_breaks, 1);
    assert!(
        imported
            .report
            .notes
            .iter()
            .any(|note| note.code == "page-break-nested" && note.region.as_deref() == Some("1")),
        "{:?}",
        imported.report.notes
    );
    assert!(!imported.text.contains("page-breaks:"), "{}", imported.text);
}

///  (GitHub ): the regions of `header.xml` and `footer.xml` become the page lines.
/// A region lands in the slot its centre falls in, in thirds of the printable width; a text region
/// gives its plain text, with one space between paragraphs; `pageNumber`, `fileName` and
/// `dateSaved` give the tokens `{page}`, `{file}` and `{date}`; an unknown field keeps the text it
/// displays and is noted; a `math` region, which a page line cannot hold, is reported.
#[test]
fn mcdx_header_and_footer_regions_become_the_page_lines() {
    let imported = import("headerfooter");
    check_golden("headerfooter", &imported);
    check_report_golden("headerfooter", &imported);
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported page lines");
    let document = loaded.project.document(&loaded.root).unwrap();
    let page = &document.page;
    // The two regions of the left third are joined in x order, and the two paragraphs of the
    // footer text are one space apart, so each slot stays one line.
    assert_eq!(page.header.left, "Frame Rev. B");
    assert_eq!(page.header.center, "{file}");
    assert_eq!(page.header.right, "Sheet 1");
    assert_eq!(
        page.footer.left,
        "Issued by A. Drius Uncontrolled when printed"
    );
    assert_eq!(page.footer.center, "{page}");
    // The unknown field keeps the text the reference application saved, in x order before the date field.
    assert_eq!(page.footer.right, "C {date}");
    // The tokens are stored unexpanded, so reading the imported text and writing it again gives
    // the same file.
    let written = equavela_core::worksheet_writer::write_document(document)
        .expect("the imported page lines are valid");
    assert_eq!(written, imported.text);
    // The header and footer regions are not regions of the sheet, and their issues name
    // them in the namespace of their part.
    assert_eq!(imported.report.regions_total, 1);
    assert_eq!(imported.report.regions_imported, 1);
    assert!(
        imported
            .report
            .issues
            .iter()
            .any(|issue| issue.code == "page-line-not-imported"
                && issue.region.as_deref() == Some("header:656")),
        "{:?}",
        imported.report.issues
    );
    assert!(
        imported
            .report
            .notes
            .iter()
            .any(|note| note.code == "page-line-field-unknown"
                && note.region.as_deref() == Some("footer:659")),
        "{:?}",
        imported.report.notes
    );
    assert!(
        imported
            .report
            .notes
            .iter()
            .any(|note| note.code == "page-line-format-dropped"
                && note.region.as_deref() == Some("footer:660")),
        "{:?}",
        imported.report.notes
    );
    assert!(
        imported
            .report
            .notes
            .iter()
            .any(|note| note.code == "page-line-style-dropped" && note.region.is_none()),
        "{:?}",
        imported.report.notes
    );
}

/// an empty `<header><regions /></header>` is what the reference application writes for no header, so the
/// imported page setup carries neither `header:` nor `footer:`.
#[test]
fn an_empty_mcdx_header_and_footer_write_no_page_line() {
    let imported = import("headerempty");
    check_golden("headerempty", &imported);
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported worksheet");
    let document = loaded.project.document(&loaded.root).unwrap();
    assert!(document.page.header.is_empty() && document.page.footer.is_empty());
    assert!(!imported.text.contains("header:"), "{}", imported.text);
    assert!(!imported.text.contains("footer:"), "{}", imported.text);
    assert!(
        imported.report.notes.is_empty(),
        "{:?}",
        imported.report.notes
    );
}

///  / : a sum or product whose bound variable is an expression is imported as a
/// free slot as written; the classic bounded sum still imports as before.
#[test]
fn a_decorated_sum_index_is_imported_as_a_free_slot() {
    let imported = import("sumslot");
    check_golden("sumslot", &imported);
    assert!(
        imported.report.issues.is_empty(),
        "{:?}",
        imported.report.issues
    );
    assert!(imported.text.contains("∑[j! = k..□]"), "{}", imported.text);
    assert!(imported.text.contains("∏[j ≠ k] j"));
    assert!(imported.text.contains("∑[i ∈ 1..4] i ="));
}

///  / : the reference application's vector sum, a summation whose bound variable is a
/// placeholder, is imported as the built-in function `vsum(v)` - the sum of the elements of the
/// array - whatever expression the array is. A real bound beside a placeholder variable is not a
/// vector sum and a product has no vector form, so both stay reported.
#[test]
fn a_vector_sum_is_imported_as_vsum() {
    let imported = import("vectorsum");
    check_golden("vectorsum", &imported);
    check_report_golden("vectorsum", &imported);
    assert!(imported.text.contains("V := vsum(v)"), "{}", imported.text);
    assert!(imported.text.contains("vsum(v) ="), "{}", imported.text);
    assert!(
        imported.text.contains("vsum((v + w)) ="),
        "{}",
        imported.text
    );
    assert!(
        imported.text.contains("2·vsum(M⟨0⟩) ="),
        "{}",
        imported.text
    );
    assert!(
        imported.text.contains("vsum(rows(X)) ="),
        "{}",
        imported.text
    );
    // The five vector sums are regions; only the two defective forms are reported.
    assert_eq!(imported.report.regions_imported, 5);
    let messages: Vec<&str> = imported
        .report
        .issues
        .iter()
        .map(|issue| issue.message.as_str())
        .collect();
    assert_eq!(
        messages,
        vec![
            "`summation (vector sum with bounds)` is not imported",
            "`product (vector sum)` is not imported",
        ]
    );
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported vector sums");
}

/// pictures become image regions; identical bytes share one resource; an SVG is
/// sanitized (with a note); a missing part is reported.
#[test]
fn pictures_become_image_regions() {
    let imported = import("pictures");
    check_golden("pictures", &imported);
    check_report_golden("pictures", &imported);
    assert_eq!(imported.report.regions_imported, 3);
    assert_eq!(imported.text.matches("media: png").count(), 1);
    assert!(!imported.text.contains("script"));
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported images");
}

/// the specification : XY plots become plot regions (shared x, log axes, presentation from the
/// trace style); every style field the model holds (line style, width, colour, marker shape and
/// colour) is imported, and 3D plots, unpairable expressions and empty expressions are reported.
///
/// The corpus is not available to the tests, so the values the model cannot place are synthetic:
/// the `star` symbol, the `LongDash` line style, the 9 pt weight and `num-of-points="1234"` in the
/// fixture stand for whatever a real file carries beyond the names lists.
#[test]
fn plots_become_plot_regions() {
    use equavela_core::plot::{TraceLinePattern, TraceMarkerShape, TracePresentation};

    let imported = import("plots");
    check_golden("plots", &imported);
    check_report_golden("plots", &imported);
    assert_eq!(imported.report.regions_imported, 3);
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported plots");
    let document = loaded.project.document(&loaded.root).unwrap();
    let equavela_core::project::DocumentRegion::Plot(plot) = document.regions[0].as_ref() else {
        panic!("first imported region should be a plot");
    };
    let traces = &plot.plot.traces;
    assert_eq!(traces.len(), 6, "one trace per y expression");
    // `line-weight` is the width in points and the reference application's ARGB colour becomes its opaque RGB.
    assert_eq!(traces[0].presentation, TracePresentation::Line);
    assert_eq!(traces[0].line.style, TraceLinePattern::Solid);
    assert_eq!(traces[0].line.width, 2.0);
    assert_eq!(traces[0].line.color.as_deref(), Some("#FF0000"));
    assert_eq!(traces[0].marker.color, None, "a trace without markers");
    // A marker-only trace keeps the trace colour as its marker colour.
    assert_eq!(traces[1].presentation, TracePresentation::Markers);
    assert_eq!(traces[1].marker.shape, TraceMarkerShape::Circle);
    assert_eq!(traces[1].marker.color.as_deref(), Some("#00FF00"));
    // Line style and marker symbol map to the model's patterns and shapes.
    assert_eq!(traces[2].presentation, TracePresentation::LineMarkers);
    assert_eq!(traces[2].line.style, TraceLinePattern::Dash);
    assert_eq!(traces[2].marker.shape, TraceMarkerShape::X);
    assert_eq!(traces[3].line.style, TraceLinePattern::DashDot);
    assert_eq!(traces[3].line.width, 3.0);
    assert_eq!(traces[3].line.color.as_deref(), Some("#0000FF"));
    assert_eq!(traces[3].marker.shape, TraceMarkerShape::Diamond);
    assert_eq!(traces[3].marker.color.as_deref(), Some("#0000FF"));
    // A value the model cannot place falls back to its default and the note names the field; the
    // marker size is never read (no known field) and keeps the model default.
    assert_eq!(traces[4].line.style, TraceLinePattern::Solid);
    assert_eq!(traces[4].line.width, 1.5);
    assert_eq!(traces[4].line.color.as_deref(), Some("#123456"));
    assert_eq!(traces[4].marker.shape, TraceMarkerShape::Circle);
    assert_eq!(traces[4].marker.size, 5.0);
    // A trace with neither a line nor a symbol becomes a line: the model has no hidden trace.
    assert_eq!(traces[5].presentation, TracePresentation::Line);
    assert_eq!(traces[5].line.color.as_deref(), Some("#ABCDEF"));
    let note = imported
        .report
        .notes
        .iter()
        .find(|note| note.code == "plot-style-dropped")
        .expect("the dropped style note");
    assert!(
        note.message.contains("number of points"),
        "{}",
        note.message
    );
    assert!(note.message.contains("marker size"), "{}", note.message);
}

/// the specification (GitHub ): the `axisLine position` of an axis is imported.
/// `origin` is the axis position `origin`, in any case; every other value and an axis without an
/// `axisLine` keep the model's default `boundary`. The plot's own `origin-positioning` attribute
/// is the reference application's summary of the same thing and is not consulted.
///
/// The fixture is synthetic (the reviewer's example of the shape, GitHub ): no reference application file
/// with origin positioning is committed and the corpus is not available to the tests.
#[test]
fn a_plot_keeps_the_saved_axis_position() {
    use equavela_core::plot::PlotAxisPosition;

    let imported = import("plotorigin");
    check_golden("plotorigin", &imported);
    // The position is part of the model, so it is imported and not listed among the dropped style.
    assert!(
        imported.text.contains("x: {position: origin}"),
        "{}",
        imported.text
    );
    assert_eq!(imported.text.matches("position: origin").count(), 2);
    let id = equavela_core::project::DocumentId::new("plotorigin.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported plot");
    let document = loaded.project.documents().next().unwrap();
    let plots: Vec<_> = document
        .regions
        .iter()
        .filter_map(|region| match region.as_ref() {
            equavela_core::project::DocumentRegion::Plot(plot) => Some(plot),
            _ => None,
        })
        .collect();
    assert_eq!(plots.len(), 2);
    // `position="origin"` on the x axis, `position="boundary"` on the y axis.
    assert_eq!(plots[0].plot.axes.x.position, PlotAxisPosition::Origin);
    assert_eq!(plots[0].plot.axes.y.position, PlotAxisPosition::Boundary);
    // A value in another case is the same position; an axis without an `axisLine` is the boundary.
    assert_eq!(plots[1].plot.axes.x.position, PlotAxisPosition::Origin);
    assert_eq!(plots[1].plot.axes.y.position, PlotAxisPosition::Boundary);
}

/// the specification : the text of `traceStyle` is the trace type; the mapping is
/// case-insensitive, `bar` and `bars`/`step` and `steps` are the same type, and a text the model
/// does not draw keeps a line trace and is named per trace. The fixture is synthetic: it carries
/// the type names of the example worksheet (`stems`, with a symbol and with a solid line)
/// and the near misses a real file could carry.
#[test]
fn plot_trace_types_come_from_the_trace_style_text() {
    use equavela_core::plot::{TraceKind, TraceLinePattern, TraceMarkerShape, TracePresentation};

    let imported = import("plotkinds");
    check_golden("plotkinds", &imported);
    check_report_golden("plotkinds", &imported);
    assert_eq!(imported.report.regions_imported, 1);
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported trace types");
    let document = loaded.project.document(&loaded.root).unwrap();
    let equavela_core::project::DocumentRegion::Plot(plot) = document.regions[0].as_ref() else {
        panic!("the imported region should be a plot");
    };
    let traces = &plot.plot.traces;
    assert_eq!(traces.len(), 7);
    // the spectrum trace: `stems` with `line-style="None"` and a symbol is a marker-only
    // stem trace, so it draws only the markers at the tops of the stems.
    assert_eq!(traces[0].kind, TraceKind::Stems);
    assert_eq!(traces[0].presentation, TracePresentation::Markers);
    assert_eq!(traces[0].marker.shape, TraceMarkerShape::Circle);
    assert_eq!(traces[0].line.color.as_deref(), Some("#00008B"));
    // `stems` with a solid line draws the segments and the markers.
    assert_eq!(traces[1].kind, TraceKind::Stems);
    assert_eq!(traces[1].presentation, TracePresentation::LineMarkers);
    assert_eq!(traces[1].line.style, TraceLinePattern::Solid);
    assert_eq!(traces[1].line.color.as_deref(), Some("#31ADC2"));
    // `bars` and `bar` are one type; so are `steps` and `Step`, matched case-insensitively.
    assert_eq!(traces[2].kind, TraceKind::Bars);
    assert_eq!(traces[2].presentation, TracePresentation::Line);
    assert_eq!(traces[3].kind, TraceKind::Bars);
    assert_eq!(traces[4].kind, TraceKind::Steps);
    assert_eq!(traces[5].kind, TraceKind::Steps);
    // A text the model does not draw keeps a line trace and says so.
    assert_eq!(traces[6].kind, TraceKind::Lines);
    assert_eq!(traces[6].line.color.as_deref(), Some("#9A7400"));
    let note = imported
        .report
        .notes
        .iter()
        .find(|note| note.code == "plot-trace-type-dropped")
        .expect("the unknown trace type note");
    assert_eq!(note.region.as_deref(), Some("0"));
    assert!(note.message.contains('7'), "{}", note.message);
    assert!(note.message.contains("error"), "{}", note.message);
    assert_eq!(
        imported
            .report
            .notes
            .iter()
            .filter(|note| note.code == "plot-trace-type-dropped")
            .count(),
        1,
        "only the one trace with an unknown type is named"
    );
}

/// an `Area` becomes an area region with its nested regions below the header; a
/// collapsed area takes its expanded band in the flow (what lies below moves down); a nested area is
/// reported.
#[test]
fn areas_become_collapsible_areas_with_their_members() {
    let imported = import("areas");
    check_golden("areas", &imported);
    check_report_golden("areas", &imported);
    // a, the collapsed area, b, c, d, the titled area and e (its nested area is not imported).
    assert_eq!(imported.report.regions_imported, 7);
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported areas");
    let document = loaded.project.document(&loaded.root).unwrap();
    let areas: Vec<_> = document
        .regions
        .iter()
        .filter_map(|r| match r.as_ref() {
            equavela_core::project::DocumentRegion::Area(a) => Some(a),
            _ => None,
        })
        .collect();
    assert_eq!(areas.len(), 2);
    assert!(areas[0].collapsed && areas[0].title == "Area");
    assert!(!areas[1].collapsed && areas[1].title == "Results");
    let members = equavela_core::area::members(&document.page, &document.regions, areas[0]);
    assert_eq!(
        members.len(),
        2,
        "b and c are the members of the first area"
    );
}

/// solve-block spec section 9: a `solveblock` becomes flat regions of a version 15 of the reference application style
/// block (`Given`, the constraints, the call), nested regions read in top order. The fixture is
/// synthetic (modelled on the extractor's view of the container, no reference application file with a solve
/// block is committed).
#[test]
fn a_solve_block_becomes_flat_given_regions() {
    let imported = import("solveblocks");
    check_golden("solveblocks", &imported);
    check_report_golden("solveblocks", &imported);
    // the reference application region counts once, whatever number of regions it becomes
    assert_eq!(imported.report.regions_total, 4);
    assert_eq!(imported.report.regions_imported, 4);
    assert!(!imported.text.contains("solve:"), "{}", imported.text);
    assert!(
        imported.text.contains("    math: \"Given\"\n"),
        "{}",
        imported.text
    );
    // the constraints are in top order, not file order
    let a = imported
        .text
        .find("x^2 + y^2 == 25")
        .expect("first constraint");
    let b = imported.text.find("y == x").expect("second constraint");
    assert!(a < b, "{}", imported.text);
    assert!(
        imported.text.contains("s := Find(x, y)"),
        "{}",
        imported.text
    );
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let loaded = equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the reader accepts the imported solve block");
    // the imported lines form a block for the analysis: three constraints reach the call
    let analysis = loaded.project.analyze(&loaded.root).unwrap();
    let blocks = analysis
        .worksheet()
        .regions
        .iter()
        .filter(|region| {
            matches!(
                &region.statement.kind,
                equavela_core::ast::StatementKind::Solve { constraints, .. } if constraints.len() == 3
            )
        })
        .count();
    assert_eq!(blocks, 1);
}

/// A solve block without a solving call is imported as its lines and noted; a missing `Given`
/// is added; a definition between the lines stays a definition (not a constraint).
#[test]
fn an_odd_solve_block_is_imported_as_its_lines_and_noted() {
    let imported = import("solveblocks_refused");
    check_golden("solveblocks_refused", &imported);
    check_report_golden("solveblocks_refused", &imported);
    assert!(!imported.text.contains("solve:"), "{}", imported.text);
    let report = report_lines(&imported);
    assert!(report.contains("solve-block-no-call"), "{report}");
    assert_eq!(imported.text.matches("math: \"Given\"").count(), 2);
}

/// the display settings of `presentation.xml` become `settings:` keys, each
/// only where it differs from its default. A label style is imported only where it differs from
/// the reference application's own default style of the label, so an untouched the reference application worksheet keeps our look; the
/// options of the Engineering format and the defaults (complex threshold 10, no expanded arrays)
/// add nothing.
#[test]
fn display_settings_become_worksheet_settings() {
    let imported = import("displaysettings");
    check_golden("displaysettings", &imported);
    for line in [
        "format.precision: 6",
        "format.trailing-zeros: true",
        "format.radix: hexadecimal",
        "format.zero-threshold: 12",
        "format.exp-threshold: 5",
        "format.imaginary: j",
        "format.matrix-size: \"20,8\"",
        "format.show-indices: true",
        "label-style.var.bold: true",
        "label-style.const.italic: false",
        "label-style.const.color: \"#aa0000\"",
    ] {
        assert!(imported.text.contains(line), "{line}\n{}", imported.text);
    }
    for absent in [
        "format.complex-threshold",
        "format.expand-nested",
        "label-style.unit",
        "label-style.fn",
        "label-style.sys",
        "label-style.kw",
        "label-style.var.italic",
        "label-style.var.color",
        "label-style.const.bold",
    ] {
        assert!(
            !imported.text.contains(absent),
            "{absent}\n{}",
            imported.text
        );
    }
}

/// a worksheet at the reference application's defaults (the `basic` fixture has no display settings, and a
/// default `presentation.xml` behaves the same) carries no display key at all.
#[test]
fn default_display_settings_add_no_keys() {
    let imported = import("basic");
    assert!(!imported.text.contains("format."), "{}", imported.text);
    assert!(!imported.text.contains("label-style."), "{}", imported.text);
}

/// the reference application's row operator is `M⟪i⟫`, its convolution
/// operator is the built-in `convolve(a, b)` with its defaults and its partial
/// derivative is `∂[x] e`, and element-of is `x ∈ v` (`In`).
#[test]
fn rows_and_convolutions_are_imported() {
    let imported = import("rowconv");
    check_golden("rowconv", &imported);
    assert!(imported.text.contains("r := M⟪1⟫"), "{}", imported.text);
    // `A` is defined nowhere and carries no label: the reference application draws it as a name, so it stays one.
    assert!(imported.text.contains("(A + B)⟪0⟫ᵀ ="), "{}", imported.text);
    assert!(
        imported.text.contains("c := convolve(u, h(t))"),
        "{}",
        imported.text
    );
    assert!(
        imported.text.contains("∂[x] f(x, y) ="),
        "{}",
        imported.text
    );
    assert!(
        imported.text.contains("∂[y^2] x·y^3 ="),
        "{}",
        imported.text
    );
    assert!(imported.text.contains("2 ∈ v ="), "{}", imported.text);
    assert_eq!(
        imported.report.regions_imported, 6,
        "{:#?}",
        imported.report
    );
}

/// a range in an `ml:matrow`, `ml:matcol` or `ml:indexer` is a run of rows,
/// columns or elements, so the region
/// imports instead of failing with the row operator's `found ..`. A range may also be one of two
/// subscripts: `M[0..1, 2]` imports as it is.
#[test]
fn a_range_in_the_index_of_an_operator_is_imported() {
    let imported = import("rangeindex");
    check_golden("rangeindex", &imported);
    check_report_golden("rangeindex", &imported);
    for text in [
        // the corpus shape: the row operator over a range of expressions
        "w := T_L\u{27ea}0..n - p - 1\u{27eb}",
        "M\u{27e8}1..3\u{27e9} =",
        "v[2..5] =",
        // the step form stays a step range
        "M\u{27ea}0, 2..n\u{27eb} =",
        // a range of expressions as the bounds
        "M\u{27e8}i + 1..j\u{27e9} =",
    ] {
        assert!(
            imported.text.contains(&format!("math: \"{text}\"")),
            "{text} in {}",
            imported.text
        );
    }
    // A range in one of two subscripts imports too: nothing is left out.
    assert!(
        imported.text.contains("math: \"M[0..1, 2] =\""),
        "{}",
        imported.text
    );
    assert!(imported.report.issues.is_empty(), "{:#?}", imported.report);
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported range selection");
}

/// the reference application's percent is `ml:percent` applied to one operand and becomes the
/// postfix `x%` of the specification to 3 — with the unit
/// override placeholder of `<ml:unitOverride>` that shows `3.4% =` and no unit.
#[test]
fn percent_is_imported() {
    let imported = import("percent");
    check_golden("percent", &imported);
    check_report_golden("percent", &imported);
    for text in ["x := 3.4%", "3.4% =", "y := k·p%"] {
        assert!(
            imported.text.contains(&format!("math: \"{text}\"")),
            "{text} in {}",
            imported.text
        );
    }
    // The operand is fitted like any other postfix operand, so a sum keeps its parentheses.
    assert!(
        imported.text.contains("math: \"(a + b)% =\""),
        "{}",
        imported.text
    );
    // A percent takes one operand; the two-operand shape is not imported.
    assert_eq!(imported.report.issues.len(), 1, "{:#?}", imported.report);
    assert_eq!(imported.report.issues[0].code, "math-unsupported");
    assert_eq!(imported.report.issues[0].region.as_deref(), Some("4"));
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    equavela_core::worksheet_file::load_project_text(id, &imported.text)
        .expect("the worksheet reader accepts the imported percent");
}

/// a display-only ellipsis cell is the reference application's
/// range-shaped placeholder — an `ml:range` whose bounds carry no value — and is imported as a
/// cell of the matrix, so the region parses and prints instead of failing with `found ..`.
/// A range cell with real bounds is not a matrix cell and stays unparsable.
#[test]
fn ellipsis_cells_are_imported() {
    let imported = import("ellipsis");
    check_golden("ellipsis", &imported);
    // Every stored shape of the cell (two placeholders, two empty literals, two names `.`) becomes
    // `⋯`.
    assert!(
        imported.text.contains("M := [a, ⋯; ⋯, d]"),
        "{}",
        imported.text
    );
    // A bare matrix with an ellipsis cell is displayed, not evaluated.
    assert!(imported.text.contains("[1, ⋯]"), "{}", imported.text);
    // The shape the corpus stores: a range between two names `.`.
    assert!(imported.text.contains("N := [⋯; b]"), "{}", imported.text);
    assert_eq!(
        imported.report.regions_imported, 3,
        "{:#?}",
        imported.report
    );
    assert_eq!(imported.report.issues.len(), 1, "{:#?}", imported.report);
    assert_eq!(imported.report.issues[0].code, "math-unparsable");
    assert_eq!(imported.report.issues[0].region.as_deref(), Some("2"));
}

/// the reference application stores an `if` chain as one `ml:if` with a `then`, any number of `ml:elseif` and an optional
/// `else`. Every branch is imported, in order: dropping the `elseif` ones silently emptied the matrices the
/// a `a test worksheet` builds, so `lsolve` found them singular.
#[test]
fn every_elseif_branch_of_an_if_is_imported() {
    let imported = import("elseif");
    check_golden("elseif", &imported);
    let text = &imported.text;
    for branch in ["if x < 0", "else if x == 0", "else if x < 10", "else"] {
        assert!(text.contains(branch), "{branch} is missing: {text}");
    }
    // The branches keep their order.
    let positions: Vec<usize> = ["x < 0", "x == 0", "x < 10"]
        .iter()
        .map(|b| text.find(b).unwrap())
        .collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "{text}");
    assert_eq!(imported.report.counts().get("math-unparsable"), None);
}
