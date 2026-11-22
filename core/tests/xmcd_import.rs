//! `.xmcd` import: golden tests on synthetic worksheets. The
//! corpus measurement is `xmcd_corpus.rs`.
//!
//! A fixture is `fixtures/xmcd/<name>.xmcd`; the golden worksheet is `<name>.expected.eqv` and the
//! golden report `<name>.report.expected.txt`. `EQUAVELA_UPDATE_GOLDEN=1` rewrites them.

use equavela_core::mcdx::{import_xmcd_bytes, ImportError, Imported};
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/xmcd")
}

fn import(name: &str) -> Imported {
    let bytes = std::fs::read(fixtures().join(format!("{name}.xmcd"))).unwrap();
    import_xmcd_bytes(&bytes, &format!("{name}.xmcd")).expect("the fixture imports")
}

fn check_golden(path: PathBuf, actual: &str) {
    if std::env::var("EQUAVELA_UPDATE_GOLDEN").is_ok() || !path.exists() {
        std::fs::write(&path, actual).unwrap();
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(actual, expected, "golden {}", path.display());
}

fn report_text(imported: &Imported) -> String {
    let r = &imported.report;
    let mut out = format!(
        "regions {} of {}, page breaks {}\n",
        r.regions_imported, r.regions_total, r.page_breaks
    );
    for issue in &r.issues {
        out.push_str(&format!(
            "issue {} {} {}\n",
            issue.code,
            issue.region.as_deref().unwrap_or("-"),
            issue.message
        ));
    }
    for note in &r.notes {
        out.push_str(&format!(
            "note {} {} {}\n",
            note.code,
            note.region.as_deref().unwrap_or("-"),
            note.message
        ));
    }
    out
}

///  on one worksheet: page, header and footer, settings, text, math with the `.xmcd`
/// forms, implicit units, pictures, a page break, an area, and the reported kinds.
#[test]
fn basic_worksheet_matches_the_golden_worksheet() {
    let imported = import("basic");
    check_golden(fixtures().join("basic.expected.eqv"), &imported.text);
    check_golden(
        fixtures().join("basic.report.expected.txt"),
        &report_text(&imported),
    );
    let id = equavela_core::project::DocumentId::new("/t.eqv").unwrap();
    equavela_core::worksheet_file::parse_document(id, &imported.text)
        .expect("the imported worksheet reads back");
}

/// a file that is not an `.xmcd` worksheet is refused with the reason.
#[test]
fn other_xml_is_refused() {
    let error = import_xmcd_bytes(b"<html/>", "page.xmcd").unwrap_err();
    assert!(matches!(error, ImportError::NotXmcd { .. }), "{error}");
    let error = import_xmcd_bytes(b"<worksheet", "broken.xmcd").unwrap_err();
    assert!(matches!(error, ImportError::Xml { .. }), "{error}");
}

/// plots made for the purpose with the reference application, one setting changed per
/// plot (limits, traces, pairing, log scale, grid, crossed axes, line style, colour, points,
/// bars, stems, symbol, labels and title, legend label and visibility, column, call, root).
#[test]
fn plots_match_the_golden_worksheet() {
    let imported = import("plots");
    check_golden(fixtures().join("plots.expected.eqv"), &imported.text);
    check_golden(
        fixtures().join("plots.report.expected.txt"),
        &report_text(&imported),
    );
    let id = equavela_core::project::DocumentId::new("/t.eqv").unwrap();
    equavela_core::worksheet_file::parse_document(id, &imported.text)
        .expect("the imported worksheet reads back");
}

/// definitions indexed by range variables become loops (a recurrence, two indices, a
/// column with an offset); the plain `v[i] := e` stays as written.
#[test]
fn range_definitions_match_the_golden_worksheet() {
    let imported = import("range_loops");
    check_golden(fixtures().join("range_loops.expected.eqv"), &imported.text);
    check_golden(
        fixtures().join("range_loops.report.expected.txt"),
        &report_text(&imported),
    );
    let id = equavela_core::project::DocumentId::new("/t.eqv").unwrap();
    equavela_core::worksheet_file::parse_document(id, &imported.text)
        .expect("the imported worksheet reads back");
}

/// an `.xmcdz` is the same worksheet compressed with gzip.
#[test]
fn a_compressed_worksheet_imports_alike() {
    use std::io::Write;
    let bytes = std::fs::read(fixtures().join("basic.xmcd")).unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&bytes).unwrap();
    let packed = gz.finish().unwrap();
    let plain = import_xmcd_bytes(&bytes, "basic.xmcd").unwrap();
    let unpacked = import_xmcd_bytes(&packed, "basic.xmcdz").unwrap();
    assert_eq!(plain.text, unpacked.text);
}

/// an include whose absolute path is from another machine is found from the folder of the
/// importing file, by the longest end of its path, then by its name, then by the newest version.
#[test]
fn includes_are_found_from_the_importing_file() {
    let dir = tempfile::tempdir().unwrap();
    let sheets = dir.path().join("Matematica").join("Esempi");
    let libraries = dir.path().join("Matematica").join("Librerie");
    let moved = dir.path().join("Matematica").join("Nuove");
    for folder in [&sheets, &libraries, &moved] {
        std::fs::create_dir_all(folder).unwrap();
    }
    let library = r#"<worksheet xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions><region region-id="1" left="0" top="0"><math><ml:define><ml:id>k</ml:id><ml:real>2</ml:real></ml:define></math></region></regions></worksheet>"#;
    std::fs::write(libraries.join("Lib.xmcd"), library).unwrap();
    std::fs::write(moved.join("Moved.xmcd"), library).unwrap();
    std::fs::write(moved.join("Versioned08.xmcd"), library).unwrap();
    let reference = |href: &str, id: u32, top: u32| {
        format!(
            r#"<region region-id="{id}" left="0" top="{top}"><reference><originRef href="{href}"/></reference></region>"#
        )
    };
    let sheet = format!(
        r#"<worksheet xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>{}{}{}{}</regions></worksheet>"#,
        reference(
            r"C:\Users\x\Desktop\Work\Matematica\Librerie\Lib.xmcd",
            1,
            0
        ),
        reference(
            r"C:\Users\x\Desktop\Work\Matematica\Librerie\Moved.xmcd",
            2,
            20
        ),
        reference(
            r"C:\Users\x\Desktop\Work\Matematica\Librerie\Versioned07.xmcd",
            3,
            40
        ),
        reference(
            r"C:\Users\x\Desktop\Work\Matematica\Librerie\Missing.xmcd",
            4,
            60
        ),
    );
    let path = sheets.join("Sheet.xmcd");
    std::fs::write(&path, sheet).unwrap();
    let imported = equavela_core::mcdx::import_xmcd(&path).unwrap();
    let includes: Vec<&str> = imported
        .report
        .includes
        .iter()
        .map(|(p, _)| p.as_str())
        .collect();
    assert_eq!(
        includes,
        [
            "../Librerie/Lib.eqv",
            "../Nuove/Moved.eqv",
            "../Nuove/Versioned08.eqv"
        ]
    );
    let codes: Vec<&str> = imported
        .report
        .issues
        .iter()
        .map(|i| i.code.as_str())
        .collect();
    assert_eq!(codes, ["include-version-substituted", "include-not-found"]);
    assert!(imported.text.contains("include: Missing.eqv"));
}
