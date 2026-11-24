//! A range inside the row operator, the column operator and the index.
//!
//! The text round-trips (R1, R2, R3), the tree is the ordinary `Range` node in the index
//! position, the codegen hands the range to the operator as `eq_range`, and the positions
//! that are not part of the rule are refused with their own messages.

mod common;
use common::*;
use equavela_core::syntax::*;

fn normalizes(input: &str, canonical: &str) {
    assert_eq!(canon(input), canonical, "canonical form of {input:?}");
    assert_fixed_point(canonical);
}

// ---------------------------------------------------------------- the three forms

#[test]
fn a_range_is_the_index_of_the_row_column_and_index_operators() {
    // The three shapes the corpus stores as an `ml:range` in `ml:matrow`, `ml:matcol` and
    // `ml:indexer`.
    normalizes("T_L⟪0..n - p - 1⟫", "T_L⟪0..n - p - 1⟫");
    normalizes("M⟨1..3⟩", "M⟨1..3⟩");
    normalizes("v[2..5]", "v[2..5]");
    // A range keeps the rest of the expression it sits in.
    normalizes("(A + B)⟪0..1⟫ᵀ", "(A + B)⟪0..1⟫ᵀ");
    normalizes("y := v[1..3] + w[1..3]", "y := v[1..3] + w[1..3]");
    // A single index and a range are told apart, and both keep their brackets.
    normalizes("M⟪i⟫ + M⟪0..i⟫", "M⟪i⟫ + M⟪0..i⟫");
    normalizes("M⟨j⟩ + M⟨0..j⟩", "M⟨j⟩ + M⟨0..j⟩");
    normalizes("v[i] + v[0..i]", "v[i] + v[0..i]");
}

#[test]
fn the_tree_is_the_ordinary_range_node_in_the_index_position() {
    assert_eq!(sx("M⟪0..1⟫"), "(row M (range 0 1))");
    assert_eq!(sx("M⟨1..3⟩"), "(col M (range 1 3))");
    assert_eq!(sx("v[2..5]"), "(index v (range 2 5))");
    // The step form is allowed in the two operators.
    assert_eq!(sx("M⟪0, 2..n - 1⟫"), "(row M (range 0 2 (- n 1)))");
    assert_eq!(sx("M⟨1, 3..5⟩"), "(col M (range 1 3 5))");
    // The bounds are arithmetic expressions, and a comparison bound needs parentheses.
    assert_eq!(sx("v[(1 < 2)..5]"), "(index v (range (paren (< 1 2)) 5))");
}

#[test]
fn a_range_inside_a_bigger_index_chain_round_trips() {
    normalizes("x[V[i]][1..3]", "x[V[i]][1..3]");
    normalizes("M⟪0..1⟫⟨0⟩", "M⟪0..1⟫⟨0⟩");
    normalizes("M[0..1][2..3]", "M[0..1][2..3]");
}

// ---------------------------------------------------------------- the positions that are not part of the rule

#[test]
fn a_range_may_be_either_or_both_subscripts_of_a_matrix_index() {
    //  (GitHub ): the rows, the columns, or both.
    normalizes("M[0..3, 0..2]", "M[0..3, 0..2]");
    normalizes("M[0..1, 2]", "M[0..1, 2]");
    normalizes("M[2, 0..1]", "M[2, 0..1]");
    assert_eq!(sx("M[0..3, 0..2]"), "(index M (range 0 3) (range 0 2))");
    assert_eq!(sx("M[0..1, 2]"), "(index M (range 0 1) 2)");
    assert_eq!(sx("M[2, 0..1]"), "(index M 2 (range 0 1))");
    // Inside an index the comma separates the subscripts: `v[0, 2..4]` is two of them, not a step
    // range.
    assert_eq!(sx("v[0, 2..4]"), "(index v 0 (range 2 4))");
}

#[test]
fn a_range_may_be_a_function_argument() {
    //  (GitHub ): a two-bound range in an argument list.
    normalizes("vec(1..3)", "vec(1..3)");
    normalizes("vec(a..b + 1) =", "vec(a..b + 1) =");
    assert_eq!(sx("vec(1..3)"), "(call vec (range 1 3))");
    // The comma separates arguments, so the step form is two of them.
    assert_eq!(sx("f(0, 2..6)"), "(call f 0 (range 2 6))");
    assert_eq!(code("vec(2..5)"), "eq_vecrange(eq_range(2.0, 5.0))");
    // Any other function: an evaluation error of the region, not a parse error.
    assert!(code("sin(1..3)")
        .contains("eq_error(\"a range written in place is an argument of vec only"));
}

#[test]
fn a_range_in_an_assignment_target_is_an_invalid_left_side() {
    // The region is kept as written; its calculation names the range (codegen tests).
    for src in [
        "v[0..3] := [1; 2; 3; 4]",
        "M⟪0..1⟫ := [1, 2]",
        "M⟨0..1⟩ := [1; 2]",
    ] {
        let statement = parse_statement(src).unwrap_or_else(|e| panic!("{src}: {e}"));
        assert!(sx_statement(&statement).contains("invalid"), "{src}: {}", sx_statement(&statement));
    }
}

#[test]
fn a_range_bound_must_be_an_arithmetic_expression() {
    let error = parse_expression("v[a < b..c]").unwrap_err();
    assert!(
        error
            .to_string()
            .contains("a range bound must be an arithmetic expression"),
        "{error}"
    );
    // With the parentheses it is a bound like any other, as in a definition.
    normalizes("v[(a < b)..c]", "v[(a < b)..c]");
}

// ---------------------------------------------------------------- codegen

fn code(src: &str) -> String {
    let parsed = parse_expression(src).unwrap_or_else(|e| panic!("parse `{src}`: {e}"));
    let mut generator = equavela_core::codegen::Generator::default();
    for name in ["M", "v", "n"] {
        generator.declare_variable(name);
    }
    generator
        .expression(&parsed)
        .unwrap_or_else(|e| panic!("generate `{src}`: {e}"))
}

#[test]
fn the_codegen_hands_the_range_to_the_operator() {
    // The range is a value of its own (`eq_range`, codegen `range`), never an inline loop.
    assert_eq!(code("v[2..5]"), "eq_index(v_v1, eq_range(2.0, 5.0))");
    assert_eq!(code("M⟨1..3⟩"), "eq_col(M_v1, eq_range(1.0, 3.0))");
    assert_eq!(code("M⟪0..1⟫"), "eq_row(M_v1, eq_range(0.0, 1.0))");
    assert_eq!(
        code("M⟪0, 2..n - 1⟫"),
        "eq_row(M_v1, eq_range(0.0, 2.0, eq_sub(n_v1, 1.0)))"
    );
    // A single index keeps its own call.
    assert_eq!(code("v[2]"), "eq_index(v_v1, 2.0)");
    // Ranges in the two subscripts of a matrix index.
    assert_eq!(
        code("M[0..1, 2..3]"),
        "eq_index(M_v1, eq_range(0.0, 1.0), eq_range(2.0, 3.0))"
    );
    assert_eq!(
        code("M[0..1, 2]"),
        "eq_index(M_v1, eq_range(0.0, 1.0), 2.0)"
    );
}

// ---------------------------------------------------------------- the whole worksheet

/// 2 and 6 through the kernel (GitHub ). Needs `julia`.
#[test]
fn ranges_and_range_variables_select_sub_vectors_and_sub_matrices() {
    use equavela_core::codegen::GenOptions;
    use equavela_core::kernel_manager::{KernelConfig, KernelManager};
    use equavela_core::kernel_value::KernelValue;
    use equavela_core::project::DocumentId;
    use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};
    use equavela_core::worksheet_file::load_project_text;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    if std::process::Command::new("julia")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let lines = [
        ("v", "v := [10; 11; 12; 13; 14; 15; 16; 17; 18; 19; 20]"),
        ("i", "i := 0, 2..10"),
        ("vi", "v[i] ="),
        ("v03", "v[0..3] ="),
        ("M", "M := [1, 2, 3; 4, 5, 6; 7, 8, 9; 10, 11, 12]"),
        ("rows", "r := 0..2"),
        ("cols", "c := 0..1"),
        ("both", "M[0..2, 0..1] ="),
        ("column", "M[1..3, 2] ="),
        ("row", "M[3, 0..2] ="),
        ("vars", "M[r, c] ="),
        ("W", "W := M[r, c]"),
        ("Wshow", "W ="),
        ("rowvar", "M[1, c] ="),
        ("squares", "v[r]^2 ="),
        ("step", "s := 0, 2..6"),
        ("vecvar", "vec(s) ="),
        ("vecplace", "vec(1..3) ="),
        ("sinplace", "sin(1..3) ="),
    ];
    let mut sheet = String::from("format: equavela-worksheet/3\nregions:\n");
    for (k, (id, math)) in lines.iter().enumerate() {
        sheet.push_str(&format!(
            "  - id: {id}\n    at: [0, {}]\n    math: '{math}'\n",
            k * 20
        ));
    }
    let root_path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let id = DocumentId::new("/ranges.eqv").unwrap();
    let mut config = KernelConfig::new(root_path.join("kernel/EquavelaKernel"));
    config.startup_timeout = Duration::from_secs(300);
    let loaded = load_project_text(id.clone(), &sheet).unwrap();
    let mut session = WorksheetSession::new(
        Arc::new(KernelManager::new(config)),
        "range-index-test",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    // The value of a region as (rows, cols, values in reading order).
    let matrix = |region: &str| -> (usize, usize, Vec<f64>) {
        match session.results().get(&RegionKey {
            document: id.clone(),
            region_id: region.into(),
            instance: 0,
        }) {
            Some(RegionState::Value {
                value:
                    Some(KernelValue::Matrix {
                        rows,
                        cols,
                        storage,
                    }),
                ..
            }) => {
                let equavela_core::kernel_value::MatrixStorage::Inline { values } = storage else {
                    panic!("`{region}`: binary storage");
                };
                let real = |k: usize| match &values[k] {
                    KernelValue::Real { value } => value.as_f64(),
                    other => panic!("`{region}`: {other:?}"),
                };
                // Stored column by column; read row by row.
                let mut out = Vec::new();
                for r in 0..rows {
                    for c in 0..cols {
                        out.push(real(c * rows + r));
                    }
                }
                (rows, cols, out)
            }
            other => panic!("`{region}` did not evaluate to a matrix: {other:?}"),
        }
    };
    assert_eq!(
        matrix("vi"),
        (6, 1, vec![10.0, 12.0, 14.0, 16.0, 18.0, 20.0])
    );
    assert_eq!(matrix("v03"), (4, 1, vec![10.0, 11.0, 12.0, 13.0]));
    assert_eq!(matrix("both"), (3, 2, vec![1.0, 2.0, 4.0, 5.0, 7.0, 8.0]));
    assert_eq!(matrix("column"), (3, 1, vec![6.0, 9.0, 12.0]));
    assert_eq!(matrix("row"), (1, 3, vec![10.0, 11.0, 12.0]));
    assert_eq!(matrix("vars"), (3, 2, vec![1.0, 2.0, 4.0, 5.0, 7.0, 8.0]));
    assert_eq!(matrix("Wshow"), (3, 2, vec![1.0, 2.0, 4.0, 5.0, 7.0, 8.0]));
    assert_eq!(matrix("rowvar"), (1, 2, vec![4.0, 5.0]));
    // Inside a larger expression a single range variable still iterates.
    assert_eq!(matrix("squares"), (3, 1, vec![100.0, 121.0, 144.0]));
    // `vec(r)` takes the range variable whole.
    assert_eq!(matrix("vecvar"), (4, 1, vec![0.0, 2.0, 4.0, 6.0]));
    // A range written as the argument of vec; elsewhere an error under the expression.
    assert_eq!(matrix("vecplace"), (3, 1, vec![1.0, 2.0, 3.0]));
    match session.results().get(&RegionKey {
        document: id.clone(),
        region_id: "sinplace".into(),
        instance: 0,
    }) {
        Some(RegionState::Error { failure }) => {
            assert!(
                failure.message.contains("argument of vec only"),
                "{}",
                failure.message
            )
        }
        other => panic!("sin(1..3) = should be an error: {other:?}"),
    }
}
