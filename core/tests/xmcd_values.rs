//! Value check of the `.xmcd` import (GitHub ): imports worksheets, recalculates them in
//! the Julia kernel and compares every real, complex or matrix result with the value the reference
//! application saved in the evaluation region. Ignored by default; needs `julia` and
//!
//! `XMCD_VALUES=<folder or .xmcd> cargo test -p equavela-core --release --test xmcd_values -- --ignored --nocapture`
//!
//! `XMCD_VALUES_OUT=<file>` writes every mismatch and error there (one line each); the summary goes
//! to standard error. `XMCD_VALUES` may also be a `.txt` list of worksheet paths, one per line. The
//! files are only read.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::{KernelValue, MatrixStorage};
use equavela_core::project::{DocumentId, Project};
use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};
use equavela_core::worksheet_file::parse_document;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    if dir.is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files(&path, out);
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("xmcd") || e.eq_ignore_ascii_case("xmcdz"))
        {
            out.push(path);
        }
    }
}

/// A saved value: complex numbers throughout (a real has a zero imaginary part), matrices
/// column-major.
#[derive(Debug, Clone, PartialEq)]
enum Saved {
    Scalar(f64, f64),
    Matrix(usize, usize, Vec<(f64, f64)>),
}

/// SI factors of the unit names a saved `unitedValue` uses.
fn unit_factor(name: &str) -> Option<f64> {
    Some(match name {
        "meter" | "second" | "kilogram" | "newton" | "watt" | "pascal" | "kelvin" | "joule"
        | "radian" | "mole" | "ampere" | "volt" | "ohm" | "coulomb" | "farad" | "henry"
        | "tesla" | "weber" | "hertz" | "siemens" | "candela" | "steradian" => 1.0,
        "degree" => std::f64::consts::PI / 180.0,
        "foot" => 0.3048,
        "inch" => 0.0254,
        "minute" => 60.0,
        "hour" => 3600.0,
        "day" => 86400.0,
        "millimeter" => 1e-3,
        "centimeter" => 1e-2,
        "kilometer" => 1e3,
        "micrometer" => 1e-6,
        "nanometer" => 1e-9,
        "gram" => 1e-3,
        "milligram" => 1e-6,
        "liter" => 1e-3,
        "kilonewton" => 1e3,
        "kilopascal" => 1e3,
        "megapascal" => 1e6,
        "kilowatt" => 1e3,
        "millisecond" => 1e-3,
        "microsecond" => 1e-6,
        "kilohertz" => 1e3,
        "megahertz" => 1e6,
        "gigahertz" => 1e9,
        "bar" => 1e5,
        "pound_force" | "poundforce" | "lbf" => 4.4482216152605,
        "pound" | "pound_mass" => 0.45359237,
        "mile" => 1609.344,
        _ => return None,
    })
}

fn number(node: roxmltree::Node) -> Option<(f64, f64)> {
    match node.tag_name().name() {
        "real" => Some((node.text()?.trim().parse().ok()?, 0.0)),
        "imag" => Some((0.0, node.text()?.trim().parse().ok()?)),
        "complex" => {
            let mut parts = node.children().filter(|n| n.is_element());
            let re = parts.next()?;
            let im = parts.next()?;
            Some((
                re.text()?.trim().parse().ok()?,
                im.text()?.trim().parse().ok()?,
            ))
        }
        "unitedValue" => {
            let value = node.children().find(|n| n.has_tag_name_local("real"))?;
            let mut factor = 1.0;
            for unit in node
                .descendants()
                .filter(|n| n.is_element() && n.tag_name().name() == "unitReference")
            {
                let power: i32 = unit
                    .attribute("power-numerator")
                    .and_then(|p| p.parse().ok())
                    .unwrap_or(1);
                factor *= unit_factor(unit.attribute("unit")?)?.powi(power);
            }
            Some((value.text()?.trim().parse::<f64>().ok()? * factor, 0.0))
        }
        _ => None,
    }
}

trait LocalName {
    fn has_tag_name_local(&self, name: &str) -> bool;
}

impl LocalName for roxmltree::Node<'_, '_> {
    fn has_tag_name_local(&self, name: &str) -> bool {
        self.is_element() && self.tag_name().name() == name
    }
}

/// The saved results of a worksheet by `region-id` (top-level and inline regions alike).
fn saved_results(doc: &roxmltree::Document) -> HashMap<String, (Saved, bool)> {
    let mut out = HashMap::new();
    for region in doc.descendants().filter(|n| n.has_tag_name_local("region")) {
        let Some(math) = region.children().find(|n| n.has_tag_name_local("math")) else {
            continue;
        };
        let Some(result) = math.descendants().find(|n| n.has_tag_name_local("result")) else {
            continue;
        };
        // A unit override: the saved number is in the display unit.
        // A display override with no name in it (`… 10^3`, `… √2`) is a scale: the saved number
        // is the one shown. With a unit (`… mm`) the saved number is SI.
        let overridden = math.descendants().any(|n| {
            n.has_tag_name_local("unitOverride")
                && n.children()
                    .any(|c| c.is_element() && !c.has_tag_name_local("placeholder"))
                && !n.descendants().any(|d| d.has_tag_name_local("id"))
        });
        let Some(first) = result.children().find(|n| n.is_element()) else {
            continue;
        };
        let saved = if first.tag_name().name() == "matrix" {
            let rows: usize = first
                .attribute("rows")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let cols: usize = first
                .attribute("cols")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let cells: Option<Vec<(f64, f64)>> = first
                .children()
                .filter(|n| n.is_element())
                .map(number)
                .collect();
            let Some(cells) = cells.filter(|c| c.len() == rows * cols && rows * cols > 0) else {
                continue;
            };
            // Column-major in the file, like the `ml:matrix` of an expression and like the
            // kernel's inline matrices.
            Saved::Matrix(rows, cols, cells)
        } else {
            let Some((re, im)) = number(first) else {
                continue;
            };
            Saved::Scalar(re, im)
        };
        if let Some(id) = region.attribute("region-id") {
            out.insert(id.to_owned(), (saved, overridden));
        }
    }
    out
}

fn complex_of(value: &KernelValue) -> Option<(f64, f64)> {
    match value {
        KernelValue::Complex { real, imag } => Some((real.as_f64(), imag.as_f64())),
        // A quantity is compared by its SI magnitude.
        KernelValue::Real { .. } | KernelValue::Quantity { .. } => {
            value.unit_divisor().map(|x| (x, 0.0))
        }
        _ => None,
    }
}

/// Saved results carry 15 to 17 significant digits; numeric methods differ in the last ones.
fn close(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    let scale = a.abs().max(b.abs());
    (a - b).abs() <= 1e-7 * scale || (a - b).abs() < 1e-12
}

fn close_c(a: (f64, f64), b: (f64, f64)) -> bool {
    let scale = a.0.hypot(a.1).max(b.0.hypot(b.1));
    (close(a.0, b.0) && close(a.1, b.1)) || (a.0 - b.0).hypot(a.1 - b.1) <= 1e-7 * scale
}

#[derive(Default)]
struct Tally {
    compared: usize,
    matched: usize,
    near: usize,
    mismatched: usize,
    errors: usize,
    other: usize,
}

#[test]
#[ignore]
fn recalculated_values_match_saved_results() {
    let Ok(root) = std::env::var("XMCD_VALUES") else {
        eprintln!("XMCD_VALUES is not set");
        return;
    };
    let mut paths = Vec::new();
    if root.ends_with(".txt") {
        let list = std::fs::read_to_string(&root).unwrap();
        paths.extend(
            list.lines()
                .filter(|l| !l.trim().is_empty())
                .map(PathBuf::from),
        );
    } else {
        files(Path::new(&root), &mut paths);
    }
    paths.sort();
    // `XMCD_VALUES_SHARD=i/n` checks every n-th worksheet from the i-th, so several processes can
    // share the corpus, each with its own kernel.
    if let Some((i, n)) = std::env::var("XMCD_VALUES_SHARD").ok().and_then(|s| {
        let (i, n) = s.split_once('/')?;
        Some((i.parse::<usize>().ok()?, n.parse::<usize>().ok()?))
    }) {
        paths = paths.into_iter().skip(i).step_by(n.max(1)).collect();
    }
    let mut log: Box<dyn Write> = match std::env::var("XMCD_VALUES_OUT") {
        Ok(out) => Box::new(std::fs::File::create(out).unwrap()),
        Err(_) => Box::new(std::io::stderr()),
    };
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    config
        .env
        .push(("EQUAVELA_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(300);
    let kernel = Arc::new(KernelManager::new(config));
    let mut total = Tally::default();
    for (n, path) in paths.iter().enumerate() {
        let started = Instant::now();
        let Ok(imported) = equavela_core::mcdx::import_xmcd(path) else {
            writeln!(log, "IMPORT-FAILED\t{}", path.display()).unwrap();
            continue;
        };
        let mut bytes = std::fs::read(path).unwrap();
        // An `.xmcdz` is the worksheet compressed with gzip.
        if bytes.starts_with(&[0x1f, 0x8b]) {
            let mut plain = Vec::new();
            std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&bytes[..]), &mut plain)
                .unwrap();
            bytes = plain;
        }
        let text = String::from_utf8_lossy(&bytes);
        let Ok(doc) = roxmltree::Document::parse(text.trim_start_matches('\u{feff}')) else {
            continue;
        };
        let saved = saved_results(&doc);
        // The worksheet keeps its own place, so its includes resolve against it.
        let id = DocumentId::new(&path.with_extension("eqv").to_string_lossy()).unwrap();
        let Ok(loaded) = parse_document(id.clone(), &imported.text) else {
            writeln!(log, "UNREADABLE\t{}", path.display()).unwrap();
            continue;
        };
        let mut project = Project::new();
        project.insert(loaded.document).unwrap();
        // The included worksheets, imported too, depth first.
        let mut pending: Vec<(DocumentId, Vec<(String, PathBuf)>)> =
            vec![(id.clone(), imported.report.includes.clone())];
        while let Some((owner, includes)) = pending.pop() {
            for (include_path, file) in includes {
                let Ok(target) = owner.resolve(&include_path) else {
                    continue;
                };
                if project.document(&target).is_some() {
                    continue;
                }
                let Ok(library) = equavela_core::mcdx::import_xmcd(&file) else {
                    writeln!(
                        log,
                        "INCLUDE-FAILED\t{}\t{}",
                        path.display(),
                        file.display()
                    )
                    .unwrap();
                    continue;
                };
                let Ok(loaded) = parse_document(target.clone(), &library.text) else {
                    continue;
                };
                if project.insert(loaded.document).is_ok() {
                    pending.push((target, library.report.includes.clone()));
                }
            }
        }
        let session = WorksheetSession::new(
            kernel.clone(),
            format!("values{n}"),
            project,
            id.clone(),
            HashMap::new(),
            GenOptions::default(),
        );
        let Ok(mut session) = session else {
            writeln!(log, "SESSION-FAILED\t{}", path.display()).unwrap();
            continue;
        };
        if let Err(error) = session.recalculate(RecalcMode::Changed, &mut |_| {}) {
            writeln!(log, "RECALC-FAILED\t{}\t{error}", path.display()).unwrap();
            continue;
        }
        let mut tally = Tally::default();
        for (ours_id, source_id) in &imported.report.source_regions {
            let key = RegionKey {
                document: id.clone(),
                region_id: ours_id.clone(),
                instance: 0,
            };
            let state = session.results().get(&key);
            let Some((expected, overridden)) = saved.get(source_id) else {
                // A region with no saved value (a definition): its own errors are the causes of
                // the dependent ones, so they are logged too.
                if let Some(RegionState::Error { failure }) = &state {
                    if !failure.message.starts_with("depends on failed region") {
                        writeln!(
                            log,
                            "ROOT-ERROR\t{}\t{source_id}\t{}",
                            path.display(),
                            failure.message.replace(['\n', '\t'], " ")
                        )
                        .unwrap();
                    }
                }
                continue;
            };
            let shown = |x: (f64, f64)| match &state {
                Some(RegionState::Value {
                    display_unit: Some(unit),
                    ..
                }) if *overridden => ((x.0 - unit.offset) / unit.divisor, x.1 / unit.divisor),
                _ => x,
            };
            let value = match &state {
                Some(RegionState::Value { value: Some(v), .. }) => v.clone(),
                Some(RegionState::Error { failure }) => {
                    tally.errors += 1;
                    writeln!(
                        log,
                        "ERROR\t{}\t{source_id}\t{}",
                        path.display(),
                        failure.message.replace(['\n', '\t'], " ")
                    )
                    .unwrap();
                    continue;
                }
                _ => {
                    tally.other += 1;
                    continue;
                }
            };
            let ours = match (&value, expected) {
                (_, Saved::Scalar(..)) => complex_of(&value).map(|x| {
                    let (re, im) = shown(x);
                    Saved::Scalar(re, im)
                }),
                (
                    KernelValue::Matrix {
                        rows,
                        cols,
                        storage: MatrixStorage::Inline { values },
                    },
                    Saved::Matrix(..),
                ) => values
                    .iter()
                    .map(|v| complex_of(v).map(shown))
                    .collect::<Option<Vec<_>>>()
                    .map(|v| Saved::Matrix(*rows, *cols, v)),
                _ => None,
            };
            let Some(ours) = ours else {
                tally.other += 1;
                continue;
            };
            tally.compared += 1;
            let same = match (&ours, expected) {
                (Saved::Scalar(a, b), Saved::Scalar(c, d)) => close_c((*a, *b), (*c, *d)),
                (Saved::Matrix(r1, c1, a), Saved::Matrix(r2, c2, b)) => {
                    r1 == r2 && c1 == c2 && a.iter().zip(b).all(|(x, y)| close_c(*x, *y))
                }
                _ => false,
            };
            // The same values in another order (the roots or eigenvalues of a numeric method).
            let reordered = !same
                && match (&ours, expected) {
                    (Saved::Matrix(r1, c1, a), Saved::Matrix(r2, c2, b))
                        if r1 == r2 && c1 == c2 && (*r1 == 1 || *c1 == 1) =>
                    {
                        let mut left: Vec<(f64, f64)> = a.clone();
                        let mut right: Vec<(f64, f64)> = b.clone();
                        let order = |x: &(f64, f64), y: &(f64, f64)| {
                            x.0.partial_cmp(&y.0)
                                .unwrap_or(std::cmp::Ordering::Equal)
                                .then(x.1.partial_cmp(&y.1).unwrap_or(std::cmp::Ordering::Equal))
                        };
                        left.sort_by(order);
                        right.sort_by(order);
                        left.iter().zip(&right).all(|(x, y)| close_c(*x, *y))
                    }
                    _ => false,
                };
            // Within 1e-4: the tolerance of a solver or an integrator, not a different result.
            let near = |a: (f64, f64), b: (f64, f64)| {
                let scale = a.0.hypot(a.1).max(b.0.hypot(b.1));
                (a.0 - b.0).hypot(a.1 - b.1) <= 1e-4 * scale.max(1e-12)
            };
            let close_enough = !same
                && match (&ours, expected) {
                    (Saved::Scalar(a, b), Saved::Scalar(c, d)) => near((*a, *b), (*c, *d)),
                    (Saved::Matrix(r1, c1, a), Saved::Matrix(r2, c2, b)) => {
                        r1 == r2 && c1 == c2 && a.iter().zip(b).all(|(x, y)| near(*x, *y))
                    }
                    _ => false,
                };
            if same {
                tally.matched += 1;
            } else if close_enough {
                tally.near += 1;
                writeln!(log, "NEAR\t{}\t{source_id}", path.display()).unwrap();
            } else if reordered {
                tally.matched += 1;
                writeln!(log, "REORDERED\t{}\t{source_id}", path.display()).unwrap();
            } else {
                tally.mismatched += 1;
                let brief = |s: &Saved| {
                    let t = format!("{s:?}");
                    t.chars().take(160).collect::<String>()
                };
                writeln!(
                    log,
                    "MISMATCH\t{}\t{source_id}\tours {}\tsaved {}",
                    path.display(),
                    brief(&ours),
                    brief(expected)
                )
                .unwrap();
            }
        }
        eprintln!(
            "[{}/{}] {:.0}s {}: compared {} matched {} near {} mismatched {} errors {} other {}",
            n + 1,
            paths.len(),
            started.elapsed().as_secs_f64(),
            path.display(),
            tally.compared,
            tally.matched,
            tally.near,
            tally.mismatched,
            tally.errors,
            tally.other
        );
        total.compared += tally.compared;
        total.matched += tally.matched;
        total.near += tally.near;
        total.mismatched += tally.mismatched;
        total.errors += tally.errors;
        total.other += tally.other;
    }
    eprintln!(
        "TOTAL files {}: compared {} matched {} ({:.1} %) near {} mismatched {} our errors {} not comparable {}",
        paths.len(),
        total.compared,
        total.matched,
        100.0 * total.matched as f64 / total.compared.max(1) as f64,
        total.near,
        total.mismatched,
        total.errors,
        total.other
    );
}
