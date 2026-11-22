//! equavela-core: core library of the worksheet engine.
//!
//! - [`ast`]: the canonical AST of worksheet math;
//! - [`project`]: multi-document include expansion and cross-file analysis;
//! - [`syntax`]: the text grammar of math in worksheet files, parser and printer.

pub mod area;
pub mod ast;
pub mod codegen;
pub mod constants;
pub mod dimensions;
pub mod document_archive;
pub mod edit;
pub mod environment;
pub mod environment_copy;
pub mod environment_snapshot;
pub mod eqvz;
pub mod fasthash;
pub mod former_names;
pub mod graph;
pub mod image;
pub mod julia_code;
pub mod kernel;
pub mod kernel_interrupt;
pub mod kernel_manager;
mod kernel_terminal;
pub mod kernel_value;
pub mod layout;
pub mod mcdx;
mod moves;
pub mod plot;
pub mod project;
pub mod project_archive;
pub mod project_directory;
pub mod project_manifest;
pub mod project_reference;
mod project_transaction;
pub mod project_tree;
pub mod richtext;
pub mod session;
pub mod spell;
pub mod symbolic;
pub mod syntax;
pub mod table;
pub mod units;
pub mod worksheet_file;
pub mod worksheet_module;
pub mod worksheet_writer;

pub use syntax::{
    parse_expression, parse_program_block, parse_statement, print_expression, print_name,
    print_program_block, print_statement, ParseError,
};

/// Returns the crate version.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_cargo() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
        assert!(!version().is_empty());
    }
}
