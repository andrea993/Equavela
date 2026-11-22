//! Prints the Julia script the kernel runs for a `.eqv` worksheet (the generated code only, no
//! kernel involved), for running or timing it in a plain Julia process. Includes are resolved
//! like the application does.
//!
//!     cargo run -q -p equavela-core --example gen_julia -- <file.eqv>

use equavela_core::codegen::{generate_worksheet_with, GenOptions};
use equavela_core::project::DocumentId;
use equavela_core::worksheet_file::load_project_text;

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: gen_julia <file.eqv>");
        std::process::exit(2);
    };
    let path = std::fs::canonicalize(path).expect("worksheet exists");
    let text = std::fs::read_to_string(&path).expect("reads the worksheet");
    let loaded = load_project_text(DocumentId::new(path.to_str().unwrap()).unwrap(), &text)
        .expect("loads the worksheet");
    let analysis = loaded
        .project
        .analyze(&loaded.root)
        .expect("analyses the project");
    let generated = generate_worksheet_with(
        analysis.worksheet(),
        analysis.graph(),
        GenOptions::default(),
    )
    .expect("generates the code");
    print!("{}", generated.script());
}
