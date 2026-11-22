//! Imports a reference application `.mcdx` and prints the `.eqv` text and the report.
//!
//!     cargo run -q -p equavela-core --example import_mcdx -- <file.mcdx> [<out.eqv>]

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(input) = args.next() else {
        eprintln!("usage: import_mcdx <file.mcdx> [<out.eqv>]");
        std::process::exit(2);
    };
    let imported = match equavela_core::mcdx::import_mcdx(std::path::Path::new(&input)) {
        Ok(imported) => imported,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    };
    match args.next() {
        Some(output) => std::fs::write(&output, &imported.text).expect("writes the .eqv"),
        None => print!("{}", imported.text),
    }
    eprintln!("{:#?}", imported.report.counts());
    if std::env::var("EQUAVELA_IMPORT_NOTES").is_ok() {
        for note in imported.report.issues.iter().chain(&imported.report.notes) {
            eprintln!("{note:?}");
        }
    }
}
