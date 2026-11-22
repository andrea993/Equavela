//! Value check of the `.mcdx` import: imports a real worksheet, evaluates it in
//! the Julia kernel and compares every real or real-matrix result with the value the reference application saved in
//! the file (`mathcad/result.xml`). Needs `julia` and `EQUAVELA_MCDX_VALUES=<one .mcdx file>`;
//! skipped otherwise. The file is only read. `EQUAVELA_MCDX_VALUES_VERBOSE=1` lists every mismatch and
//! `EQUAVELA_MCDX_VALUES_DUMP=1` prints our value of every region.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::{KernelValue, MatrixStorage};
use equavela_core::project::{DocumentId, DocumentRegion, Project};
use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};
use equavela_core::worksheet_file::parse_document;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn read_part(bytes: &[u8], name: &str) -> Option<String> {
    let mut package = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut text = String::new();
    package.by_name(name).ok()?.read_to_string(&mut text).ok()?;
    Some(text.trim_start_matches('\u{feff}').to_owned())
}

/// Saved results by result id: a real scalar, or a real matrix (row-major).
#[derive(Debug, Clone, PartialEq)]
enum Saved {
    Scalar(f64),
    Matrix(usize, usize, Vec<f64>),
}

fn saved_results(xml: &str) -> HashMap<String, Saved> {
    let doc = roxmltree::Document::parse(xml).unwrap();
    let mut out = HashMap::new();
    for data in doc.descendants().filter(|n| n.has_tag_name("resultData")) {
        let Some(result) = data.children().find(|n| n.has_tag_name("result")) else {
            continue;
        };
        let Some(first) = result.children().find(|n| n.is_element()) else {
            continue;
        };
        let id = data.attribute("result-id").unwrap_or("").to_owned();
        match first.tag_name().name() {
            "real" => {
                if let Some(v) = first.text().and_then(|t| t.trim().parse().ok()) {
                    out.insert(id, Saved::Scalar(v));
                }
            }
            "matrix" => {
                let rows: usize = first
                    .attribute("rows")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let cols: usize = first
                    .attribute("cols")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let cells: Option<Vec<f64>> = first
                    .children()
                    .filter(|n| n.is_element())
                    .map(|n| {
                        (n.tag_name().name() == "real")
                            .then(|| n.text().and_then(|t| t.trim().parse().ok()))
                            .flatten()
                    })
                    .collect();
                if let Some(cells) = cells.filter(|c| c.len() == rows * cols && rows * cols > 0) {
                    // Evidence: the matrices of `result.xml` are stored row-major, unlike
                    // the `ml:matrix` of an expression.
                    let row_major = cells;
                    out.insert(id, Saved::Matrix(rows, cols, row_major));
                }
            }
            _ => {}
        }
    }
    out
}

fn real_of(value: &KernelValue) -> Option<f64> {
    match value {
        // A quantity is compared by its SI magnitude, as `result.xml` stores it.
        KernelValue::Real { .. } | KernelValue::Quantity { .. } => value.unit_divisor(),
        _ => None,
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1e-300) || (a - b).abs() < 1e-12
}

#[test]
fn imported_worksheet_values_match_saved_results() {
    let Ok(path) = std::env::var("EQUAVELA_MCDX_VALUES") else {
        eprintln!("EQUAVELA_MCDX_VALUES is not set: value check skipped");
        return;
    };
    if !std::process::Command::new("julia")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        eprintln!("skipping: julia is not on PATH");
        return;
    }
    let verbose = std::env::var("EQUAVELA_MCDX_VALUES_VERBOSE").is_ok();
    let dump = std::env::var("EQUAVELA_MCDX_VALUES_DUMP").is_ok();
    let bytes = std::fs::read(&path).unwrap();
    let imported = equavela_core::mcdx::import_mcdx_bytes(&bytes, &path).unwrap();
    let ws_xml = read_part(&bytes, "mathcad/worksheet.xml").unwrap();
    let saved = saved_results(&read_part(&bytes, "mathcad/result.xml").unwrap_or_default());

    // Top-level math regions that were imported, in order, with their result reference.
    let ws = roxmltree::Document::parse(&ws_xml).unwrap();
    let failed: std::collections::HashSet<String> = imported
        .report
        .issues
        .iter()
        .filter_map(|i| i.region.clone())
        .collect();
    let top = ws
        .root_element()
        .children()
        .find(|n| n.has_tag_name("regions"))
        .unwrap();
    let mut refs: Vec<(String, Option<String>)> = Vec::new();
    for region in top.children().filter(|n| n.has_tag_name("region")) {
        // A solve block imports as a `Given` region followed by its constraints and the solver:
        // the keyword has no result, the nested regions keep theirs.
        if let Some(block) = region.children().find(|c| c.has_tag_name("solveblock")) {
            refs.push((
                format!("given-{}", region.attribute("region-id").unwrap_or("")),
                None,
            ));
            let nested = block.children().find(|c| c.has_tag_name("regions"));
            for inner in nested
                .into_iter()
                .flat_map(|n| n.children())
                .filter(|n| n.has_tag_name("region"))
            {
                let Some(math) = inner.children().find(|c| c.has_tag_name("math")) else {
                    continue;
                };
                let Some(id) = inner.attribute("region-id") else {
                    continue;
                };
                if !failed.contains(id) {
                    refs.push((
                        id.to_owned(),
                        math.attribute("resultRef").map(str::to_owned),
                    ));
                }
            }
            continue;
        }
        let Some(math) = region.children().find(|c| c.has_tag_name("math")) else {
            continue;
        };
        let Some(id) = region.attribute("region-id") else {
            continue;
        };
        if !failed.contains(id) {
            refs.push((
                id.to_owned(),
                math.attribute("resultRef").map(str::to_owned),
            ));
        }
    }

    let root = DocumentId::new("/imported.eqv").unwrap();
    let loaded = parse_document(root.clone(), &imported.text).unwrap();
    let loaded_regions = loaded.document.regions.clone();
    let math_ids: Vec<String> = loaded_regions
        .iter()
        .filter_map(|r| match r.as_ref() {
            DocumentRegion::Math(m) => Some(m.id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(math_ids.len(), refs.len(), "math regions line up");

    // Inline math: the nested math regions of the text regions whose math was placed,
    // paired in order with the math runs of the imported text regions that have any.
    let not_placed: std::collections::HashSet<String> = imported
        .report
        .issues
        .iter()
        .filter(|i| i.code == "inline-math-not-placed")
        .filter_map(|i| i.region.clone())
        .collect();
    let region_list = ws
        .root_element()
        .children()
        .find(|n| n.has_tag_name("regions"))
        .unwrap();
    // Per text region: the nested regions that were translated, as (mcdx id, result ref).
    let mut xml_texts: Vec<Vec<(String, Option<String>)>> = Vec::new();
    for region in region_list.children().filter(|n| n.has_tag_name("region")) {
        let Some(text) = region.children().find(|c| c.has_tag_name("text")) else {
            continue;
        };
        let Some(list) = text.children().find(|c| c.has_tag_name("regions")) else {
            continue;
        };
        let id = region.attribute("region-id").unwrap_or("").to_owned();
        if not_placed.contains(&id) {
            continue;
        }
        let skipped: std::collections::HashSet<usize> = imported
            .report
            .issues
            .iter()
            .filter(|i| i.region.as_deref() == Some(id.as_str()))
            .filter_map(|i| {
                i.message
                    .strip_prefix("inline math ")?
                    .split(' ')
                    .next()?
                    .parse::<usize>()
                    .ok()
            })
            .collect();
        let nested: Vec<(String, Option<String>)> = list
            .children()
            .filter(|n| n.has_tag_name("region"))
            .enumerate()
            .filter(|(index, _)| !skipped.contains(&(index + 1)))
            .filter_map(|(_, r)| {
                let math = r.children().find(|c| c.has_tag_name("math"))?;
                Some((
                    r.attribute("region-id")?.to_owned(),
                    math.attribute("resultRef").map(str::to_owned),
                ))
            })
            .collect();
        if !nested.is_empty() {
            xml_texts.push(nested);
        }
    }
    let imported_texts: Vec<(String, usize)> = loaded_regions
        .iter()
        .filter_map(|r| match r.as_ref() {
            DocumentRegion::Text(t) => {
                let runs = equavela_core::richtext::RichText::parse(&t.text)
                    .0
                    .iter()
                    .flat_map(|paragraph| &paragraph.runs)
                    .filter(|run| matches!(run, equavela_core::richtext::Run::Math(_)))
                    .count();
                (runs > 0).then(|| (t.id.clone(), runs))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        xml_texts.len(),
        imported_texts.len(),
        "text regions with inline math line up"
    );
    let mut items: Vec<(String, String, Option<String>)> = math_ids
        .iter()
        .zip(&refs)
        .map(|(id, (mcdx_id, result_ref))| (id.clone(), mcdx_id.clone(), result_ref.clone()))
        .collect();
    for (nested, (text_id, runs)) in xml_texts.iter().zip(&imported_texts) {
        assert_eq!(nested.len(), *runs, "inline math of {text_id} lines up");
        for (index, (mcdx_id, result_ref)) in nested.iter().enumerate() {
            items.push((
                equavela_core::richtext::inline_region_id(text_id, index),
                mcdx_id.clone(),
                result_ref.clone(),
            ));
        }
    }
    let mut project = Project::new();
    project.insert(loaded.document).unwrap();

    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    config
        .env
        .push(("EQUAVELA_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(300);
    let kernel = Arc::new(KernelManager::new(config));
    let mut session = WorksheetSession::new(
        kernel,
        "values",
        project,
        root.clone(),
        HashMap::new(),
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();

    let (mut compared, mut matched, mut mismatched, mut errors, mut other) = (0, 0, 0, 0, 0);
    for (id, mcdx_id, result_ref) in &items {
        let key = RegionKey {
            document: root.clone(),
            region_id: id.clone(),
            instance: 0,
        };
        let state = session.results().get(&key);
        if dump {
            let shown = match &state {
                Some(RegionState::Value { value: Some(v), .. }) => format!("{v:?}"),
                Some(RegionState::Error { failure }) => format!("ERROR {}", failure.message),
                other => format!("{other:?}"),
            };
            eprintln!(
                "OURS {mcdx_id} {}",
                shown.chars().take(300).collect::<String>()
            );
        }
        let Some(expected) = result_ref.as_ref().and_then(|r| saved.get(r)) else {
            if let (true, Some(RegionState::Error { failure })) = (verbose, &state) {
                eprintln!(
                    "ERROR  mcdx {mcdx_id} ({id}), no saved value: {}",
                    failure.message
                );
            }
            continue;
        };
        // A unit override: the reference application saves the value in the display unit, `(SI - offset) / divisor`.
        let shown = |x: f64| match &state {
            Some(RegionState::Value {
                display_unit: Some(unit),
                ..
            }) => (x - unit.offset) / unit.divisor,
            _ => x,
        };
        let value = match &state {
            Some(RegionState::Value { value: Some(v), .. }) => v.clone(),
            Some(RegionState::Error { failure }) => {
                errors += 1;
                if verbose {
                    eprintln!("ERROR  mcdx {mcdx_id} ({id}): {}", failure.message);
                }
                continue;
            }
            _ => {
                other += 1;
                continue;
            }
        };
        let ours: Option<Saved> = match (&value, expected) {
            (KernelValue::Real { .. } | KernelValue::Quantity { .. }, Saved::Scalar(_)) => {
                real_of(&value).map(|x| Saved::Scalar(shown(x)))
            }
            (
                KernelValue::Matrix {
                    rows,
                    cols,
                    storage: MatrixStorage::Inline { values },
                },
                Saved::Matrix(..),
            ) => values
                .iter()
                .map(|v| real_of(v).map(shown))
                .collect::<Option<Vec<f64>>>()
                .map(|v| Saved::Matrix(*rows, *cols, v)),
            _ => None,
        };
        let Some(ours) = ours else {
            other += 1;
            continue;
        };
        compared += 1;
        let same = match (&ours, expected) {
            (Saved::Scalar(a), Saved::Scalar(b)) => close(*a, *b),
            (Saved::Matrix(r1, c1, a), Saved::Matrix(r2, c2, b)) => {
                r1 == r2 && c1 == c2 && a.iter().zip(b).all(|(x, y)| close(*x, *y))
            }
            _ => false,
        };
        if same {
            matched += 1;
        } else {
            mismatched += 1;
            if verbose {
                eprintln!("MISMATCH mcdx {mcdx_id} ({id}): ours {ours:?} saved {expected:?}");
            }
        }
    }
    eprintln!(
        "VALUES {path}: compared {compared}, matched {matched}, mismatched {mismatched}, our errors {errors}, not comparable {other}"
    );
}
