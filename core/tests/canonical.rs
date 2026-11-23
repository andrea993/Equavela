//! Round-trip invariants R1–R4 on fixed inputs: accepted input → canonical text
//! (ASCII → Unicode, spacing, grouping, quoting, program form), and what is never
//! normalized.

mod common;
use common::*;
use equavela_core::ast::*;
use equavela_core::syntax::*;

/// R3: `print(parse(input)) == canonical`, and the canonical text is a fixed point (R2).
fn normalizes(input: &str, canonical: &str) {
    assert_eq!(canon(input), canonical, "canonical form of {input:?}");
    assert_fixed_point(canonical);
    // The two texts denote the same AST.
    assert_eq!(
        parse_statement(input).unwrap(),
        parse_statement(canonical).unwrap()
    );
}

#[test]
fn r3_ascii_spellings_become_unicode() {
    normalizes("x === a*b", "x ≡ a·b");
    normalizes("f(x) ->", "f(x) →");
    normalizes("y := a <> b", "y := a ≠ b");
    normalizes("y := a != b", "y := a ≠ b");
    normalizes("y := a <= b \\and c >= d", "y := a ≤ b ∧ c ≥ d");
    normalizes("y := \\not a \\or b \\xor c", "y := ¬a ∨ b ⊕ c");
    normalizes("y := x \\in v", "y := x ∈ v");
    normalizes("y := a \\times b", "y := a × b");
    normalizes("y := a \\div b", "y := a÷b");
    normalizes("y := M\\T", "y := Mᵀ");
    normalizes("y := M<<j>> + M<<<i>>>", "y := M⟨j⟩ + M⟪i⟫");
    normalizes("y := \\abs(x) + \\norm(v)", "y := |x| + ‖v‖");
    normalizes("y := \\sqrt(x) + \\sqrt[3](a + b)", "y := √x + √[3](a + b)");
    normalizes("y := (f)'(x) + (g)''(x)", "y := (f)′(x) + (g)′′(x)");
    normalizes(
        "y := \\sum[k \\in 0..n] \\prod[i] \\int[t \\in 0..1] x",
        "y := ∑[k ∈ 0..n] ∏[i] ∫[t ∈ 0..1] x",
    );
    normalizes("y := \\d[x] f + \\partial[x^2] f", "y := ⅆ[x] f + ∂[x^2] f");
    normalizes("y := [?, ?; ?, ?]", "y := [□, □; □, □]");
    normalizes("v = ... m/s", "v = … m/s");
    normalizes("y := a − b", "y := a - b");
}

#[test]
fn r3_spacing_quoting_labels_grouping() {
    normalizes("x:=a+b*c", "x := a + b·c");
    normalizes("x  :=   f( a ,b )", "x := f(a, b)");
    normalizes("x := (a)/b", "x := a/b");
    normalizes("x := a^(2)", "x := a^2");
    normalizes("x := √(x)", "x := √x");
    normalizes("x := 2x + 3in", "x := 2 x + 3 in");
    normalizes("x := 2e", "x := 2 e");
    normalizes("`x` := `F`_`max`", "x := F_max");
    normalizes("m@variable := f@function(1)", "m@var := f@fn(1)");
    normalizes(
        "y := m@unit + k@constant + ORIGIN@system",
        "y := m@unit + k@const + ORIGIN@sys",
    );
    normalizes("y := `F_{a}` + F_{max}", "y := `F_{a}` + F_max");
    normalizes("y := \"a\\u{41}\\t\"", "y := \"aA\\t\"");
    normalizes("e →[ solve , k ] [simplify]", "e →[solve, k][simplify]");
}

#[test]
fn label_on_number_is_rejected() {
    // A label belongs to a name; `@` after a number is an error.
    assert!(parse_statement("x := 1@fn").is_err());
}

#[test]
fn r3_program_form_follows_position() {
    // An inline program as the whole right side becomes a block program …
    normalizes(
        "f(n) := program { s ← 0; for i ∈ 1..n { s ← s + i }; s }",
        "f(n) := program\n  s ← 0\n  for i ∈ 1..n\n    s ← s + i\n  s",
    );
    // … a block indented by 4 is re-indented by 2 …
    normalizes(
        "f(n) := program\n    if n > 0\n        1\n    else\n        0",
        "f(n) := program\n  if n > 0\n    1\n  else\n    0",
    );
    // … and with a tail, or inside an operand, the program is inline.
    normalizes("x := program\n  a\n  b", "x := program\n  a\n  b");
    normalizes("x := 2·program { a }", "x := 2·program { a }");
    normalizes("x := program { a } =", "x := program { a } =");
    // Blank lines and trailing line breaks are ignored.
    normalizes("x := program\n\n  a\n\n  b\n\n", "x := program\n  a\n  b");
    // Program lines copied from an editor travel as a program of their own.
    normalizes(
        "program { if a { 1 } else if b { 2 } else { 3 } }",
        "program { if a { 1 } else if b { 2 } else { 3 } }",
    );
    normalizes(
        "program { for i ∈ 1..n { s ← s + i } }",
        "program { for i ∈ 1..n { s ← s + i } }",
    );
}

#[test]
fn a_local_definition_may_define_a_function() {
    // the target of `←` may be a function head, written as on the left of `:=`.
    let src = "Z(A, Q, T) := program\n  g(x) ← x^2 + Q\n  g(A)";
    assert_eq!(canon(src), src);
    assert_fixed_point(src);
    assert_eq!(
        sx_block("g(x) ← x^2\nh() ← 1\nk ← g(2)"),
        "(← (fn g x) (^ x 2)) (← (fn h) 1) (← k (call g 2))"
    );
    // The inline form, and a body that is itself a program.
    normalizes(
        "x := program { f(y) ← y + 1; f(2) }",
        "x := program\n  f(y) ← y + 1\n  f(2)",
    );
    assert_eq!(
        canon("f(x) := program\n  g(n) ← program { n·2 }\n  g(x)"),
        "f(x) := program\n  g(n) ← program\n    n·2\n  g(x)"
    );
    // A head whose parameters are not names is not a local definition target.
    assert!(parse_statement("f := program\n  g(A[0]) ← 1").is_err());
    assert!(parse_statement("f := program\n  g(x + 1) ← 1").is_err());
}

///  (GitHub ): a cell of a destructuring matrix is a target, a
/// destructuring matrix included, so a nested array is taken apart level by level.
#[test]
fn a_destructuring_matrix_cell_may_be_a_matrix() {
    let src = "[A11, A12; [A211; A212], A22] := f(x)";
    assert_eq!(canon(src), src);
    assert_fixed_point(src);
    assert_eq!(
        sx(src),
        "(:= (destructure 2×2 A11 A12 (destructure 2×1 A211 A212) A22) (call f x))"
    );
    // To any depth, and in the program's local definition.
    normalizes("[a, [b, [c, d]]] := e", "[a, [b, [c, d]]] := e");
    normalizes("[[a, b]; [c, d]] := M", "[[a, b]; [c, d]] := M");
    normalizes(
        "S(M) := program\n  [a, [b, c]] ← M\n  a",
        "S(M) := program\n  [a, [b, c]] ← M\n  a",
    );
    // A cell is a cell: the separators around a nested matrix are the outer matrix's.
    assert_eq!(
        sx("[[a, b], [c, d]] := M"),
        "(:= (destructure 1×2 (destructure 1×2 a b) (destructure 1×2 c d)) M)"
    );
    // The cells of an inner matrix are names, indexed names, columns and rows; a function head
    // is not a cell, and a matrix cell is never an expression.
    assert!(parse_statement("[[f(x)]] := v").is_err());
    assert!(parse_statement("[[1, 2]] := v").is_err());
}

///  (GitHub ): the target of an inline argument definition is a target
/// of 7.3, so a destructuring matrix is written there too.
#[test]
fn an_inline_argument_definition_may_destructure() {
    let src = "f(a, [x, y] ← [1, 2])";
    assert_eq!(canon(src), src);
    assert_fixed_point(src);
    assert_eq!(
        sx(src),
        "(call f a (← (destructure 1×2 x y) (matrix 1×2 1 2)))"
    );
    // Nested, and with the subscripted names of the corpus (`x.i`, `y.o`).
    normalizes(
        "Inside(\"a\", [A, B; C, [D, E]] ← M)",
        "Inside(\"a\", [A, B; C, [D, E]] ← M)",
    );
    assert_eq!(
        sx("f([x.i, y.o] ← [1, 2])"),
        "(call f (← (destructure 1×2 x.i y.o) (matrix 1×2 1 2)))"
    );
}

#[test]
fn r3_equation_breaks() {
    normalizes("y := a +\n        b·\n  c", "y := a +\n    b·\n    c");
    let s = parse_statement("y := a +\n    b").unwrap();
    let StatementKind::Define { rhs, .. } = s.kind else {
        panic!()
    };
    assert!(matches!(rhs.kind, ExprKind::Add { split: true, .. }));
}

#[test]
fn r4_never_normalized() {
    // Visible parentheses, number text, `·` vs juxtaposition, `/` vs `÷`, `|x|` vs `\det`,
    // tree shape, explicit labels.
    for t in [
        "x := (a)",
        "x := 1.50",
        "x := 007",
        "x := a·b",
        "x := a b",
        "x := a/b",
        "x := a÷b",
        "x := |M|",
        "x := \\det(M)",
        "x := a + b + c",
        "x := a + (b + c)",
        "x := m@unit",
        "x := m",
        "x := ((a + b))/c",
    ] {
        assert_fixed_point(t);
    }
    assert_ne!(
        parse_statement("x := a·b").unwrap(),
        parse_statement("x := a b").unwrap()
    );
    assert_ne!(
        parse_statement("x := |M|").unwrap(),
        parse_statement("x := \\det(M)").unwrap()
    );
    assert_ne!(
        parse_statement("x := a + b + c").unwrap(),
        parse_statement("x := a + (b + c)").unwrap()
    );
}

#[test]
fn keywords_are_quoted_where_they_would_be_read_as_keywords() {
    // A statement-initial name spelled like a keyword is quoted; elsewhere it is plain.
    normalizes(
        "f := program\n  `if` ← 1\n  `else`\n  if(c, a, b)\n  `break`\n  x ← if",
        "f := program\n  `if` ← 1\n  `else`\n  if(c, a, b)\n  `break`\n  x ← if",
    );
    assert_eq!(
        canon("x := program { `return`; `on` x }"),
        "x := program\n  `return`\n  `on` x"
    );
    // `program` is always quoted when it is a bare name.
    normalizes("x := `program` + 1", "x := `program` + 1");
    normalizes("program@var := 1", "program@var := 1");
    // Region level has no statement keywords.
    normalizes("if x", "if x");
}

#[test]
fn abs_inside_abs_after_juxtaposition() {
    // The printer writes `\abs(…)` where `|` would close the open bars.
    let b = |k| Box::new(Expr::synth(k));
    let id = |s: &str| ExprKind::Ident {
        name: Name::plain(s),
    };
    let inner = ExprKind::Abs { expr: b(id("b")) };
    let e = Expr::synth(ExprKind::Abs {
        expr: b(ExprKind::Juxt {
            left: b(id("a")),
            right: b(inner),
        }),
    });
    let text = print_expression(&e);
    assert_eq!(text, "|a \\abs(b)|");
    assert_eq!(parse_expression(&text).unwrap(), e);
    assert_eq!(
        sx_expr(&parse_expression("|a| |b|").unwrap()),
        "(juxt (abs a) (abs b))"
    );
    assert_eq!(
        sx_expr(&parse_expression("||a| b|").unwrap()),
        "(abs (juxt (abs a) b))"
    );
    assert_eq!(
        sx_expr(&parse_expression("|a·|b||").unwrap()),
        "(abs (· a (abs b)))"
    );
    assert_eq!(
        sx_expr(&parse_expression("|f(a |b|)|").unwrap()),
        "(abs (call f (juxt a (abs b))))"
    );
    assert_eq!(
        sx_expr(&parse_expression("‖a |b|‖").unwrap()),
        "(norm (juxt a (abs b)))"
    );
}

#[test]
fn radicand_matrix_and_root_index() {
    let e = parse_expression("√([1, 2])").unwrap();
    assert_eq!(sx_expr(&e), "(√ (matrix 1×2 1 2))");
    assert_eq!(print_expression(&e), "√([1, 2])");
    let e = parse_expression("√[3]([1, 2]ᵀ)").unwrap();
    assert_eq!(print_expression(&e), "√[3]([1, 2]ᵀ)");
    assert_eq!(canon("x := √[n](x)"), "x := √[n]x");
}

#[test]
fn numbers_strings_ranges() {
    assert_eq!(
        sx_expr(&parse_expression("1.5e-3·2E+4").unwrap()),
        "(· 1.5e-3 2E+4)"
    );
    assert!(parse_expression("1..n").is_err());
    assert_fixed_point("x := 1...5");
    assert_eq!(sx("x := 1...5"), "(:= x (range 1 .5))");
    assert_fixed_point("x := \"tab\\t \\\"q\\\" back\\\\ \\u{1}\"");
    assert_fixed_point("x := 1j·2.5i·1e3j");
    assert_eq!(sx("x := 2in"), "(:= x (juxt 2 in))");
    assert_eq!(sx("x := 2i"), "(:= x 2i)");
}

#[test]
fn program_block_entry_points() {
    let src = "s ← 0\nfor i ∈ 1..n\n  s ← s + i\ns";
    assert_eq!(canon_block(src), src);
    assert_eq!(canon_block("    a\n    b"), "a\nb");
    let body = parse_program_block(src).unwrap();
    assert_eq!(body.len(), 3);
    assert_eq!(print_program_block(&body), src);
}

#[test]
fn spans_point_into_the_source() {
    let src = "y := a + bb·c";
    let s = parse_statement(src).unwrap();
    assert_eq!(s.span.range(), 0..src.len());
    let StatementKind::Define { target, rhs, .. } = &s.kind else {
        panic!()
    };
    assert_eq!(&src[target.span.range()], "y");
    assert_eq!(&src[rhs.span.range()], "a + bb·c");
    let ExprKind::Add { right, .. } = &rhs.kind else {
        panic!()
    };
    assert_eq!(&src[right.span.range()], "bb·c");
}

/// the clipboard form of a run of call arguments is `a, b`, and it parses back to the same
/// arguments (the round trip the editor's copy and paste rely on).
#[test]
fn argument_lists_round_trip() {
    let args = parse_arguments("a, b + c, [x, y] ← [3, 4]").unwrap();
    assert_eq!(args.len(), 3);
    let text = print_arguments(&args);
    assert_eq!(text, "a, b + c, [x, y] ← [3, 4]");
    assert_eq!(parse_arguments(&text).unwrap(), args);
    // One argument is the plain expression the editor already copies.
    let one = parse_arguments("(x + y)·z").unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(print_arguments(&one), "(x + y)·z");
    // The same argument inside a call prints the same way, so a run of one is the plain expression.
    let StatementKind::ExprRegion { expr } = parse_statement("f((x + y)·z)").unwrap().kind else {
        panic!()
    };
    let ExprKind::Call { args, .. } = &expr.kind else {
        panic!()
    };
    assert_eq!(print_arguments(args), "(x + y)·z");
    // The list is not a region statement: a definition is no argument of a call.
    assert!(parse_arguments("a := 3").is_err());
    assert!(parse_arguments("a,").is_err());
    assert!(parse_arguments("").is_err());
}

#[test]
fn json_shape() {
    let s = parse_statement("L := 3.5 m").unwrap();
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v["type"], "Define");
    assert_eq!(v["target"]["type"], "Ident");
    assert_eq!(v["target"]["name"]["segments"][0]["text"], "L");
    assert_eq!(v["rhs"]["type"], "Juxt");
    assert_eq!(v["rhs"]["left"]["type"], "Num");
    assert_eq!(v["rhs"]["left"]["text"], "3.5");
    assert_eq!(v["rhs"]["span"]["start"], 5);
    assert_eq!(v["tail"], serde_json::Value::Null);
    let back: Statement = serde_json::from_value(v).unwrap();
    assert_eq!(back, s);
    // Spans are optional on input.
    let e: Expr =
        serde_json::from_str(r#"{"type":"Neg","expr":{"type":"Num","text":"1"}}"#).unwrap();
    assert_eq!(print_expression(&e), "-1");
}

#[test]
fn an_apostrophe_after_the_first_character_belongs_to_the_name() {
    for text in ["x' := 1", "x'' := x' + 1", "v_0' := 2", "f'(t) := t^2"] {
        assert_fixed_point(text);
    }
    let StatementKind::Define { target, .. } = parse_statement("x'' := 1").unwrap().kind else {
        panic!("not a definition");
    };
    let TargetKind::Ident { name } = target.kind else {
        panic!("not a variable target");
    };
    assert_eq!(name.segments[0].text, "x''");
    // The prime derivative is a different glyph: `f′(t)` derives `f`, `f'(t)` calls `f'`.
    assert_ne!(parse_statement("y := f′(t)").unwrap(), parse_statement("y := f'(t)").unwrap());
}
