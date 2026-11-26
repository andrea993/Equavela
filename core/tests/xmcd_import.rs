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

#[test]
fn xmcd_gravity_g_becomes_constant_unless_defined() {
    let undefined = r#"<worksheet xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>
      <region region-id="1" left="0" top="0"><math><ml:define><ml:id>w</ml:id><ml:apply><ml:mult/><ml:real>2</ml:real><ml:id>g</ml:id></ml:apply></ml:define></math></region>
    </regions></worksheet>"#;
    let imported = import_xmcd_bytes(undefined.as_bytes(), "grav.xmcd").unwrap();
    assert!(
        imported.text.contains("w := 2·g@const"),
        "{}",
        imported.text
    );

    let defined = r#"<worksheet xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>
      <region region-id="1" left="0" top="0"><math><ml:define><ml:id>g</ml:id><ml:real>10</ml:real></ml:define></math></region>
      <region region-id="2" left="0" top="20"><math><ml:define><ml:id>w</ml:id><ml:apply><ml:mult/><ml:real>2</ml:real><ml:id>g</ml:id></ml:apply></ml:define></math></region>
    </regions></worksheet>"#;
    let imported = import_xmcd_bytes(defined.as_bytes(), "defined_g.xmcd").unwrap();
    assert!(imported.text.contains("w := 2·g\""), "{}", imported.text);
    assert!(!imported.text.contains("g@const"), "{}", imported.text);
}

/// An OLE compound file with one small stream, `Contents`, as a File Input component stores it.
fn compound_file(contents: &[u8]) -> Vec<u8> {
    let mut file = vec![0u8; 512 * 5];
    file[..8].copy_from_slice(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    file[30..32].copy_from_slice(&9u16.to_le_bytes());
    file[32..34].copy_from_slice(&6u16.to_le_bytes());
    file[44..48].copy_from_slice(&1u32.to_le_bytes());
    file[48..52].copy_from_slice(&1u32.to_le_bytes());
    file[56..60].copy_from_slice(&4096u32.to_le_bytes());
    file[60..64].copy_from_slice(&2u32.to_le_bytes());
    for (n, value) in [
        (0, 0xFFFF_FFFDu32),
        (1, 0xFFFF_FFFE),
        (2, 0xFFFF_FFFE),
        (3, 0xFFFF_FFFE),
    ] {
        file[512 + 4 * n..512 + 4 * n + 4].copy_from_slice(&value.to_le_bytes());
    }
    let mut entry = |at: usize, name: &str, first: u32, size: u32| {
        let units: Vec<u8> = name
            .encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect();
        file[at..at + units.len()].copy_from_slice(&units);
        file[at + 64..at + 66].copy_from_slice(&(units.len() as u16).to_le_bytes());
        file[at + 116..at + 120].copy_from_slice(&first.to_le_bytes());
        file[at + 120..at + 124].copy_from_slice(&size.to_le_bytes());
    };
    let mini_sectors = contents.len().div_ceil(64);
    entry(1024, "Root Entry", 3, (64 * mini_sectors) as u32);
    entry(1024 + 128, "Contents", 0, contents.len() as u32);
    for n in 0..mini_sectors {
        let next = if n + 1 == mini_sectors {
            0xFFFF_FFFEu32
        } else {
            n as u32 + 1
        };
        file[1536 + 4 * n..1536 + 4 * n + 4].copy_from_slice(&next.to_le_bytes());
    }
    file[2048..2048 + contents.len()].copy_from_slice(contents);
    file
}

/// The `Contents` stream of a File Input component.
fn file_input_contents(
    rows: (u32, u32),
    cols: (u32, u32),
    flags: u32,
    format: u32,
    path: &str,
) -> Vec<u8> {
    let mfc = |text: &str| {
        let mut out = vec![0xFF, 0xFE, 0xFF, text.encode_utf16().count() as u8];
        out.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        out
    };
    let mut out = vec![0u8; 42];
    for value in [rows.0, rows.1, cols.0, cols.1, flags, format] {
        out.extend(value.to_le_bytes());
    }
    for text in [path, "", "", "A1"] {
        out.extend(mfc(text));
    }
    out
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = chunk
            .iter()
            .enumerate()
            .fold(0u32, |v, (i, b)| v | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                ALPHABET[(value >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// A worksheet of File Input components: (output, disabled, `Contents`) each.
fn file_input_sheet(components: &[(&str, bool, Vec<u8>)]) -> String {
    use std::io::Write;
    let mut regions = String::new();
    let mut items = String::new();
    for (k, (output, disabled, contents)) in components.iter().enumerate() {
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&compound_file(contents)).unwrap();
        let item = base64(&gzip.finish().unwrap());
        regions.push_str(&format!(
            r#"<region region-id="{id}" left="0" top="{top}"><component clsid-buddy="01350083-1122-11DB-9380-000D56C6051A" item-idref="{id}" disable-calc="{disabled}"><inputs/><outputs><ml:id xml:space="preserve">{output}</ml:id></outputs></component></region>"#,
            id = k + 1,
            top = 40 * k,
        ));
        items.push_str(&format!(
            r#"<item item-id="{}" content-encoding="gzip">{item}</item>"#,
            k + 1
        ));
    }
    format!(
        r#"<worksheet xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>{regions}</regions><binaryContent>{items}</binaryContent></worksheet>"#
    )
}

#[test]
fn a_file_input_component_reads_its_file() {
    const END: u32 = u32::MAX;
    let dir = tempfile::tempdir().unwrap();
    let sheets = dir.path().join("sheets");
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    std::fs::create_dir_all(&sheets).unwrap();
    std::fs::write(dir.path().join("data").join("count.txt"), "1 2\n3 4\n").unwrap();
    let sheet = file_input_sheet(&[
        // Text, relative path, from row 2 and column 1 to the end of the data.
        (
            "Ref",
            false,
            file_input_contents((2, END), (1, END), 4, 1, r"..\data\count.txt"),
        ),
        // Excel, absolute path, a closed range, comma decimals, disabled.
        (
            "B",
            true,
            file_input_contents((1, 121), (2, 12), 2, 3, r"C:\data\book.xls"),
        ),
        // Every row and column of a text file.
        (
            "C",
            false,
            file_input_contents((1, END), (1, END), 4, 1, r"..\data\count.txt"),
        ),
        // MATLAB: no reader.
        (
            "D",
            false,
            file_input_contents((1, END), (1, END), 0, 2, r"C:\data\model.mat"),
        ),
    ]);
    let path = sheets.join("Sheet.xmcd");
    std::fs::write(&path, sheet).unwrap();
    let imported = equavela_core::mcdx::import_xmcd(&path).unwrap();
    let report = report_text(&imported);
    assert!(
        imported
            .text
            .contains(r#"Ref := READFILE("../data/count.txt", "delimited", 2, 1)"#),
        "{}",
        imported.text
    );
    assert!(
        imported
            .text
            .contains(r#"B := READFILE("C:/data/book.xls", "Excel", [1; 121], [2; 12], NaN, ",")"#),
        "{}",
        imported.text
    );
    assert!(
        imported
            .text
            .contains(r#"C := READFILE("../data/count.txt", "delimited")"#),
        "{}",
        imported.text
    );
    assert_eq!(imported.report.regions_imported, 3, "{report}");
    assert!(report.contains("issue component-file-missing 2 the File Input data file `C:/data/book.xls` does not exist"), "{report}");
    assert!(report.contains("issue component-not-imported 4 the File Input component is not imported: MATLAB files have no reader"), "{report}");
    assert!(report.contains("note disabled-region 2"), "{report}");
    assert!(!report.contains("count.txt"), "{report}");
}
