//! Equavela math syntax: the linear text form of math in worksheet files.
//! Parser, canonical printer and AST normalization.
//!
//! Round-trip contract (math-syntax section 14): for every normalized AST `a`,
//! `parse(print(a)) == a`; for every accepted text `t`, `print(parse(t))` is canonical
//! and a fixed point of `print ∘ parse`.

mod error;
mod lexer;
pub mod normalize;
mod parser;
mod prec;
mod printer;

pub use error::{line_col, ParseError};
pub use normalize::{
    normalize_expr, normalize_name, normalize_statement, normalize_stmts, normalize_target,
};
pub use parser::{parse_arguments, parse_expression, parse_program_block, parse_statement};
pub use printer::{
    print_arguments, print_expression, print_name, print_program_block, print_statement,
};
