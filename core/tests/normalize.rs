//! Normalization invariants N1–N10 (math-syntax 11.5) on hand-built ASTs.

use equavela_core::ast::*;
use equavela_core::syntax::*;

fn e(kind: ExprKind) -> Expr {
    Expr::synth(kind)
}
fn id(s: &str) -> Expr {
    e(ExprKind::Ident {
        name: Name::plain(s),
    })
}
fn num(s: &str) -> Expr {
    e(ExprKind::Num { text: s.into() })
}
fn bin(op: BinaryOp, l: Expr, r: Expr) -> Expr {
    e(ExprKind::binary(op, l, r, false))
}
fn un(op: UnaryOp, x: Expr) -> Expr {
    e(ExprKind::unary(op, x))
}
fn sum(var: &str, body: Expr) -> Expr {
    e(ExprKind::Sum {
        var: Ident::new(Name::plain(var)),
        index: None,
        bounds: None,
        body: Box::new(body),
    })
}

/// Normalizes, prints, and checks R1 and idempotence.
fn normalized_text(mut x: Expr) -> String {
    normalize_expr(&mut x);
    let text = print_expression(&x);
    assert_eq!(parse_expression(&text).unwrap(), x, "R1 for {text:?}");
    let mut again = x.clone();
    normalize_expr(&mut again);
    assert_eq!(again, x, "normalize is idempotent");
    text
}

#[test]
fn n1_required_parentheses() {
    use BinaryOp::*;
    let (a, b, c) = (id("a"), id("b"), id("c"));
    assert_eq!(
        normalized_text(bin(Sub, a.clone(), bin(Sub, b.clone(), c.clone()))),
        "a - (b - c)"
    );
    assert_eq!(
        normalized_text(bin(Sub, bin(Sub, a.clone(), b.clone()), c.clone())),
        "a - b - c"
    );
    assert_eq!(
        normalized_text(bin(Mul, bin(Add, a.clone(), b.clone()), c.clone())),
        "(a + b)·c"
    );
    assert_eq!(
        normalized_text(bin(Pow, bin(Div, a.clone(), b.clone()), num("2"))),
        "(a/b)^2"
    );
    assert_eq!(
        normalized_text(bin(Pow, un(UnaryOp::Neg, num("1")), id("m"))),
        "(-1)^m"
    );
    assert_eq!(
        normalized_text(bin(Juxt, a.clone(), un(UnaryOp::Neg, b.clone()))),
        "a (-b)"
    );
    assert_eq!(
        normalized_text(un(UnaryOp::Neg, bin(Mul, a.clone(), b.clone()))),
        "-(a·b)"
    );
    assert_eq!(
        normalized_text(un(UnaryOp::Transpose, bin(Pow, a.clone(), num("2")))),
        "(a^2)ᵀ"
    );
    assert_eq!(
        normalized_text(e(ExprKind::Index {
            base: Box::new(e(ExprKind::Root {
                index: None,
                radicand: Box::new(a.clone())
            })),
            indices: vec![id("i")],
        })),
        "(√a)[i]"
    );
    assert_eq!(
        normalized_text(un(UnaryOp::Not, bin(And, a.clone(), b.clone()))),
        "¬(a ∧ b)"
    );
    assert_eq!(
        normalized_text(bin(Lt, a.clone(), bin(Lt, b.clone(), c.clone()))),
        "a < (b < c)"
    );
    // A big operator followed by more factors of its chain.
    assert_eq!(
        normalized_text(bin(Mul, sum("k", a.clone()), b.clone())),
        "(∑[k] a)·b"
    );
    assert_eq!(
        normalized_text(bin(
            Mul,
            bin(Mul, c.clone(), sum("k", a.clone())),
            b.clone()
        )),
        "c·(∑[k] a)·b"
    );
    assert_eq!(
        normalized_text(bin(Juxt, un(UnaryOp::Neg, sum("k", a.clone())), b.clone())),
        "-(∑[k] a) b"
    );
    assert_eq!(
        normalized_text(bin(Mul, c.clone(), sum("k", a.clone()))),
        "c·∑[k] a"
    );
    assert_eq!(
        normalized_text(sum("k", bin(Add, a.clone(), b.clone()))),
        "∑[k] (a + b)"
    );
}

#[test]
fn n2_boxes_get_grouping_not_nodes() {
    use BinaryOp::*;
    let x = bin(Div, bin(Add, id("a"), id("b")), bin(Add, id("c"), id("d")));
    let mut n = x.clone();
    normalize_expr(&mut n);
    assert_eq!(n, x, "no Paren node is added in a box");
    assert_eq!(print_expression(&n), "(a + b)/(c + d)");
    let typed = bin(
        Div,
        e(ExprKind::Paren {
            expr: Box::new(id("a")),
        }),
        id("b"),
    );
    assert_eq!(normalized_text(typed), "((a))/b");
}

#[test]
fn n3_names() {
    let mut name = Name {
        segments: vec![
            Segment {
                text: "".into(),
                subscript: false,
            },
            Segment {
                text: "F".into(),
                subscript: true,
            },
            Segment {
                text: "m".into(),
                subscript: true,
            },
            Segment {
                text: "ax".into(),
                subscript: true,
            },
            Segment {
                text: "".into(),
                subscript: false,
            },
        ],
        label: None,
    };
    normalize_name(&mut name);
    assert_eq!(name, Name::sub("F", "max"));
}

#[test]
fn n4_signed_numbers() {
    assert_eq!(normalized_text(num("-1.50")), "-1.50");
    let mut x = num("-2");
    normalize_expr(&mut x);
    assert!(matches!(x.kind, ExprKind::Neg { .. }));
    assert_eq!(normalized_text(num("+3")), "3");
    assert_eq!(
        normalized_text(bin(BinaryOp::Pow, id("x"), num("-1"))),
        "x^-1"
    );
    assert_eq!(
        normalized_text(bin(BinaryOp::Pow, num("-2"), id("x"))),
        "(-2)^x"
    );
}

#[test]
fn n7_empty_bodies_and_prime_merge() {
    let mut p = e(ExprKind::Program { body: vec![] });
    normalize_expr(&mut p);
    assert_eq!(print_expression(&p), "program { □ }");
    let f = e(ExprKind::PrimeDeriv {
        function: Box::new(e(ExprKind::PrimeDeriv {
            function: Box::new(id("f")),
            order: 1,
        })),
        order: 2,
    });
    assert_eq!(normalized_text(f), "f′′′");
}

#[test]
fn n8_split_only_on_breakable_operators() {
    let x = Expr::synth(ExprKind::binary(BinaryOp::Juxt, id("a"), id("b"), true));
    assert_eq!(print_expression(&x), "a b");
    let mut s = Statement::synth(StatementKind::ExprRegion {
        expr: Expr::synth(ExprKind::binary(BinaryOp::Add, id("a"), id("b"), true)),
    });
    normalize_statement(&mut s);
    assert_eq!(print_statement(&s), "a +\n    b");
    assert_eq!(parse_statement("a +\n    b").unwrap(), s);
}

#[test]
fn statements_normalize_targets_and_tails() {
    use BinaryOp::*;
    let mut s = Statement::synth(StatementKind::Define {
        target: Target::synth(TargetKind::FunctionHead {
            name: Ident::new(Name::plain("f")),
            params: vec![Ident::new(Name::plain("x"))],
        }),
        rhs: bin(Mul, bin(Add, id("x"), num("1")), id("x")),
        tail: Some(Tail::Eval {
            unit: Some(bin(Div, id("m"), id("s"))),
        }),
    });
    normalize_statement(&mut s);
    assert_eq!(print_statement(&s), "f(x) := (x + 1)·x = … m/s");
}
