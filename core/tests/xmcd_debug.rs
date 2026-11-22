//! Debug helper for: prints the imported text of the regions paired with the given `.xmcd`
//! region ids. `XMCD_DEBUG=<file> XMCD_DEBUG_IDS=a,b cargo test --test xmcd_debug -- --ignored --nocapture`
#[test]
#[ignore]
fn show_regions() {
    let (Ok(path), Ok(ids)) = (std::env::var("XMCD_DEBUG"), std::env::var("XMCD_DEBUG_IDS")) else {
        return;
    };
    let imported = equavela_core::mcdx::import_xmcd(std::path::Path::new(&path)).unwrap();
    let want: Vec<&str> = ids.split(',').collect();
    for (ours, source) in &imported.report.source_regions {
        if want.contains(&source.as_str()) {
            let start = imported.text.find(&format!("- id: {ours}\n")).unwrap_or(0);
            let block: String = imported.text[start..]
                .lines()
                .take(6)
                .collect::<Vec<_>>()
                .join(" | ");
            println!("{source} -> {block}");
        }
    }
}

/// Prints the whole imported worksheet text: `XMCD_DUMP=<file>`.
#[test]
#[ignore]
fn dump_text() {
    let Ok(path) = std::env::var("XMCD_DUMP") else {
        return;
    };
    let imported = equavela_core::mcdx::import_xmcd(std::path::Path::new(&path)).unwrap();
    println!("{}", imported.text);
}

/// Prints the includes found for `XMCD_DUMP=<file>`.
#[test]
#[ignore]
fn show_includes() {
    let Ok(path) = std::env::var("XMCD_DUMP") else {
        return;
    };
    let imported = equavela_core::mcdx::import_xmcd(std::path::Path::new(&path)).unwrap();
    for (p, f) in &imported.report.includes {
        println!("INCLUDE {p} <- {}", f.display());
    }
    for n in imported.report.notes.iter().chain(&imported.report.issues) {
        if n.code.starts_with("include") {
            println!("{} {}", n.code, n.message);
        }
    }
}
