//! The corpus measurement of the `.xmcd` import: imports every `.xmcd`
//! under `$XMCD_CORPUS` and prints the import rate and the issues by code and by message. Ignored by
//! default, because the corpus is the and is not in the repository:
//!
//! `XMCD_CORPUS=~/folder cargo test -p equavela-core --release --test xmcd_corpus -- --ignored --nocapture`

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
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

#[test]
#[ignore]
fn import_the_corpus() {
    let Ok(root) = std::env::var("XMCD_CORPUS") else {
        eprintln!("XMCD_CORPUS is not set");
        return;
    };
    let mut paths = Vec::new();
    files(Path::new(&root), &mut paths);
    paths.sort();
    let (mut total, mut imported, mut failed, mut unreadable) = (0usize, 0usize, 0usize, 0usize);
    let mut by_code: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_kind: BTreeMap<String, usize> = BTreeMap::new();
    let mut notes: BTreeMap<String, usize> = BTreeMap::new();
    for path in &paths {
        match equavela_core::mcdx::import_xmcd(path) {
            Ok(result) => {
                let id = equavela_core::project::DocumentId::new("/t.eqv").unwrap();
                if let Err(error) = equavela_core::worksheet_file::parse_document(id, &result.text)
                {
                    unreadable += 1;
                    println!("UNREADABLE {}: {error}", path.display());
                }
                total += result.report.regions_total;
                imported += result.report.regions_imported;
                for issue in &result.report.issues {
                    *by_code.entry(issue.code.clone()).or_default() += 1;
                    // The message up to its first quoted text names the kind of failure.
                    let kind: String = match issue.code.as_str() {
                        "math-unsupported" => issue.message.clone(),
                        "math-unparsable" => issue
                            .message
                            .rsplit(": ")
                            .next()
                            .unwrap_or("")
                            .chars()
                            .take(60)
                            .collect(),
                        _ => issue.message.chars().take(70).collect(),
                    };
                    *by_kind
                        .entry(format!("{}: {kind}", issue.code))
                        .or_default() += 1;
                }
                for note in &result.report.notes {
                    *notes.entry(note.code.clone()).or_default() += 1;
                }
            }
            Err(error) => {
                failed += 1;
                println!("FAILED {}: {error}", path.display());
            }
        }
    }
    println!(
        "{} files, {failed} failed, {unreadable} unreadable after import; regions {imported} of {total} imported ({:.1} %)",
        paths.len(),
        100.0 * imported as f64 / total.max(1) as f64
    );
    println!("issues by code: {by_code:#?}");
    println!("notes by code: {notes:#?}");
    let mut kinds: Vec<_> = by_kind.into_iter().collect();
    kinds.sort_by_key(|k| std::cmp::Reverse(k.1));
    for (kind, count) in kinds.iter().take(60) {
        println!("{count:7} {kind}");
    }
}

#[test]
#[ignore]
fn show_issues() {
    let (Ok(root), Ok(pattern)) = (std::env::var("XMCD_CORPUS"), std::env::var("XMCD_ISSUE"))
    else {
        return;
    };
    let mut paths = Vec::new();
    files(Path::new(&root), &mut paths);
    paths.sort();
    let mut shown = 0;
    for path in &paths {
        let Ok(result) = equavela_core::mcdx::import_xmcd(path) else {
            continue;
        };
        for issue in result
            .report
            .issues
            .iter()
            .filter(|i| i.message.contains(&pattern))
        {
            println!("{} [{:?}] {}", path.display(), issue.region, issue.message);
            shown += 1;
            if shown >= 8 {
                return;
            }
        }
    }
}
