//! Property tests (math-syntax R1, R2, R6): random ASTs within the grammar, normalized
//! (N1–N10), printed, parsed back: the result equals the normalized AST and printing it
//! again gives the same text.

use equavela_core::ast::*;
use equavela_core::syntax::{
    normalize_expr, normalize_statement, normalize_stmts, parse_expression, parse_program_block,
    parse_statement, print_expression, print_program_block, print_statement,
};
use proptest::prelude::*;
use proptest::sample::select;

fn seg(text: &str, subscript: bool) -> Segment {
    Segment {
        text: text.to_string(),
        subscript,
    }
}

fn fixed_names() -> Vec<Name> {
    vec![
        Name::plain("x"),
        Name::plain("π"),
        Name::plain("∞"),
        Name::plain("R∞"),
        Name::plain("e"),
        Name::plain("in"),
        Name::plain("j"),
        Name::sub("F", "max"),
        Name::sub("η", "p.max"),
        Name::sub("μ", "ψ_k"),
        Name::sub("x", "0.5"),
        Name::sub("p", "1"),
        Name::plain("indici_colonne_ingresso"),
        Name::sub("UKF_EST_λ", "step"),
        Name::sub("F", "a,b"),
        Name::plain("⊗"),
        Name::plain(".5x"),
        Name::plain("a`b\\c"),
        Name {
            segments: vec![
                seg("H", false),
                seg("2", true),
                seg("SO", false),
                seg("4", true),
            ],
            label: None,
        },
        Name {
            segments: vec![seg("A", false), seg("}{\\", true), seg("4B", false)],
            label: None,
        },
        Name::plain("m").with_label(Label::Unit),
        Name::plain("f").with_label(Label::Fn),
        Name::plain("filt").with_label(Label::Julia),
        Name::plain("if"),
        Name::plain("else"),
        Name::plain("also"),
        Name::plain("on"),
        Name::plain("break"),
        Name::plain("return"),
        Name::plain("program"),
        Name::plain("program").with_label(Label::Var),
        Name::sub("program", "x"),
    ]
}

fn name() -> BoxedStrategy<Name> {
    prop_oneof![
        3 => select(fixed_names()),
        3 => "[a-zA-Zα-ω][a-zA-Z0-9]{0,3}".prop_map(|s| Name::plain(&s)),
        2 => ("[a-zA-Zα-ω][a-z0-9]{0,2}", "[a-z0-9][a-z0-9_.]{0,3}")
            .prop_map(|(b, s)| Name::sub(&b, &s)),
    ]
    .boxed()
}

fn ident() -> BoxedStrategy<Ident> {
    name().prop_map(Ident::new).boxed()
}

fn num_text() -> BoxedStrategy<String> {
    prop_oneof![
        select(vec![
            "0", "1", "2", "3.5", "1.50", ".5", "2e3", "1.5E-3", "007", "10", "4e+2"
        ])
        .prop_map(String::from),
        "[0-9]{1,3}(\\.[0-9]{1,2})?",
    ]
    .boxed()
}

fn string_value() -> BoxedStrategy<String> {
    proptest::collection::vec(
        select(vec![
            'a', 'b', ' ', '"', '\\', 'λ', '\n', '\t', '\u{1}', '|', '`', '?', '…',
        ]),
        0..5,
    )
    .prop_map(|cs| cs.into_iter().collect())
    .boxed()
}

fn leaf() -> BoxedStrategy<Expr> {
    prop_oneof![
        4 => name().prop_map(|name| Expr::synth(ExprKind::Ident { name })),
        3 => num_text().prop_map(|text| Expr::synth(ExprKind::Num { text })),
        1 => (num_text(), select(vec![ImagUnit::I, ImagUnit::J]))
            .prop_map(|(text, symbol)| Expr::synth(ExprKind::Imag { text, symbol })),
        1 => string_value().prop_map(|text| Expr::synth(ExprKind::Str { text })),
        1 => Just(Expr::synth(ExprKind::Placeholder)),
    ]
    .boxed()
}

fn b(e: Expr) -> Box<Expr> {
    Box::new(e)
}

fn lvalue(expr: BoxedStrategy<Expr>) -> BoxedStrategy<Target> {
    let suffix = prop_oneof![
        proptest::collection::vec(expr.clone(), 1..=2).prop_map(|i| (0u8, i)),
        expr.clone().prop_map(|i| (1u8, vec![i])),
        expr.prop_map(|i| (2u8, vec![i])),
    ];
    (
        name(),
        proptest::collection::vec((suffix, any::<bool>()), 0..3),
    )
        .prop_map(|(n, suffixes)| {
            let mut t = Target::synth(TargetKind::Ident { name: n });
            for ((kind, mut idx), paren) in suffixes {
                if paren {
                    t = Target::synth(TargetKind::Paren {
                        target: Box::new(t),
                    });
                }
                let base = Box::new(t);
                t = Target::synth(match kind {
                    0 => TargetKind::Index { base, indices: idx },
                    1 => TargetKind::Column {
                        base,
                        index: b(idx.remove(0)),
                    },
                    _ => TargetKind::Row {
                        base,
                        index: b(idx.remove(0)),
                    },
                });
            }
            t
        })
        .boxed()
}

fn destructure(expr: BoxedStrategy<Expr>) -> BoxedStrategy<Target> {
    (1usize..3, 1usize..3)
        .prop_flat_map(move |(r, c)| {
            proptest::collection::vec(lvalue(expr.clone()), r * c).prop_map(move |cells| {
                Target::synth(TargetKind::Destructure {
                    rows: r,
                    cols: c,
                    cells,
                })
            })
        })
        .boxed()
}

/// A destructuring matrix whose cells may themselves be destructuring matrices:
/// one level of nesting, which is what the corpus has.
fn nested_destructure(expr: BoxedStrategy<Expr>) -> BoxedStrategy<Target> {
    (1usize..3, 1usize..3)
        .prop_flat_map(move |(r, c)| {
            let cell = prop_oneof![3 => lvalue(expr.clone()), 1 => destructure(expr.clone())];
            proptest::collection::vec(cell, r * c).prop_map(move |cells| {
                Target::synth(TargetKind::Destructure {
                    rows: r,
                    cols: c,
                    cells,
                })
            })
        })
        .boxed()
}

fn any_target(expr: BoxedStrategy<Expr>) -> BoxedStrategy<Target> {
    prop_oneof![
        3 => lvalue(expr.clone()),
        1 => destructure(expr.clone()),
        1 => nested_destructure(expr),
        2 => (ident(), proptest::collection::vec(ident(), 0..3))
            .prop_map(|(name, params)| Target::synth(TargetKind::FunctionHead { name, params })),
    ]
    .boxed()
}

fn range(expr: BoxedStrategy<Expr>) -> BoxedStrategy<Expr> {
    (expr.clone(), proptest::option::of(expr.clone()), expr)
        .prop_map(|(first, second, last)| {
            Expr::synth(ExprKind::Range {
                first: b(first),
                second: second.map(b),
                last: b(last),
            })
        })
        .boxed()
}

fn stmt(expr: BoxedStrategy<Expr>, depth: u32) -> BoxedStrategy<Stmt> {
    let simple = prop_oneof![
        // The target of `<-` may be a function head: a local function definition.
        3 => (any_target(expr.clone()), expr.clone())
            .prop_map(|(target, rhs)| Stmt::synth(StmtKind::LocalDef { target, rhs })),
        3 => expr.clone().prop_map(|e| Stmt::synth(StmtKind::ExprStmt { expr: e })),
        1 => Just(Stmt::synth(StmtKind::Break)),
        1 => Just(Stmt::synth(StmtKind::Continue)),
        1 => expr.clone().prop_map(|e| Stmt::synth(StmtKind::Return { expr: e })),
    ]
    .boxed();
    if depth == 0 {
        return simple;
    }
    let body = proptest::collection::vec(stmt(expr.clone(), depth - 1), 1..3).boxed();
    prop_oneof![
        4 => simple,
        1 => (
            proptest::collection::vec((expr.clone(), body.clone()), 1..4),
            select(vec![BranchKind::ElseIf, BranchKind::AlsoIf]),
            proptest::option::of(body.clone()),
        )
            .prop_map(|(bs, kind, else_body)| {
                let branches = bs
                    .into_iter()
                    .enumerate()
                    .map(|(k, (cond, body))| Branch {
                        kind: if k == 0 { BranchKind::If } else { kind },
                        cond,
                        body,
                        span: Span::default(),
                    })
                    .collect();
                Stmt::synth(StmtKind::If { branches, else_body })
            }),
        1 => (ident(), prop_oneof![expr.clone(), range(expr.clone())], body.clone())
            .prop_map(|(var, source, body)| Stmt::synth(StmtKind::For { var, source, body })),
        1 => (expr.clone(), body.clone())
            .prop_map(|(cond, body)| Stmt::synth(StmtKind::While { cond, body })),
        1 => (body.clone(), body)
            .prop_map(|(body, handler)| Stmt::synth(StmtKind::Try { body, handler })),
        1 => (any_target(expr.clone()), proptest::collection::vec(stmt(expr, depth - 1), 1..3))
            .prop_map(|(target, body)| Stmt::synth(StmtKind::LocalDef {
                target,
                rhs: Expr::synth(ExprKind::Program { body }),
            })),
    ]
    .boxed()
}

fn arg(expr: BoxedStrategy<Expr>) -> BoxedStrategy<Arg> {
    prop_oneof![
        3 => expr.clone().prop_map(|e| Arg::Expr { expr: e }),
        // The target of an inline argument definition may be a destructuring matrix.
        1 => (
            prop_oneof![3 => lvalue(expr.clone()), 1 => destructure(expr.clone())],
            expr,
        )
            .prop_map(|(target, value)| Arg::InlineDef {
            target,
            value,
            span: Span::default(),
        }),
    ]
    .boxed()
}

fn bounds(expr: BoxedStrategy<Expr>) -> BoxedStrategy<Option<Bounds>> {
    proptest::option::of((expr.clone(), expr).prop_map(|(lo, hi)| Bounds {
        lo: b(lo),
        hi: b(hi),
        glyph: BoundGlyph::In,
    }))
    .boxed()
}

fn expr() -> BoxedStrategy<Expr> {
    leaf()
        .prop_recursive(4, 48, 4, |inner| {
            let ops = prop_oneof![
                (select(UnaryOp::ALL.to_vec()), inner.clone())
                    .prop_map(|(op, e)| Expr::synth(ExprKind::unary(op, e))),
                (
                    select(BinaryOp::ALL.to_vec()),
                    inner.clone(),
                    inner.clone(),
                    any::<bool>()
                )
                    .prop_map(|(op, l, r, split)| Expr::synth(ExprKind::binary(op, l, r, split))),
                inner
                    .clone()
                    .prop_map(|e| Expr::synth(ExprKind::Paren { expr: b(e) })),
                (proptest::option::of(inner.clone()), inner.clone()).prop_map(|(i, r)| {
                    Expr::synth(ExprKind::Root {
                        index: i.map(b),
                        radicand: b(r),
                    })
                }),
            ]
            .boxed();
            let postfix = prop_oneof![
                (
                    inner.clone(),
                    proptest::collection::vec(arg(inner.clone()), 0..3)
                )
                    .prop_map(|(c, args)| Expr::synth(ExprKind::Call { callee: b(c), args })),
                (
                    select(vec![
                        "ControlSystems",
                        "DSP",
                        "LinearAlgebra.BLAS",
                        "My_Pkg",
                        "julia"
                    ]),
                    select(vec!["lqr", "filt!", "step_1", "nrm2"]),
                    proptest::collection::vec(arg(inner.clone()), 0..3),
                )
                    .prop_map(|(p, n, args)| Expr::synth(ExprKind::JuliaCall {
                        package: p.to_string(),
                        name: n.to_string(),
                        args,
                        bare: false,
                    })),
                (
                    inner.clone(),
                    // A range may be either subscript of an index, and it has no step form there.
                    prop_oneof![
                        3 => proptest::collection::vec(inner.clone(), 1..=2),
                        2 => (inner.clone(), inner.clone())
                            .prop_map(|(first, last)| vec![Expr::synth(ExprKind::Range {
                                first: b(first),
                                second: None,
                                last: b(last),
                            })]),
                        1 => (inner.clone(), inner.clone(), inner.clone())
                            .prop_map(|(first, last, other)| vec![
                                Expr::synth(ExprKind::Range { first: b(first), second: None, last: b(last) }),
                                other,
                            ]),
                        1 => (inner.clone(), inner.clone(), inner.clone(), inner.clone())
                            .prop_map(|(a, b1, c, d)| vec![
                                Expr::synth(ExprKind::Range { first: b(a), second: None, last: b(b1) }),
                                Expr::synth(ExprKind::Range { first: b(c), second: None, last: b(d) }),
                            ]),
                    ],
                )
                    .prop_map(|(base, indices)| Expr::synth(ExprKind::Index {
                        base: b(base),
                        indices
                    })),
                (
                    inner.clone(),
                    // The index of the column and row operators may be a range.
                    prop_oneof![3 => inner.clone(), 2 => range(inner.clone())],
                    any::<bool>(),
                )
                    .prop_map(|(base, index, col)| {
                        Expr::synth(if col {
                            ExprKind::Column {
                                base: b(base),
                                index: b(index),
                            }
                        } else {
                            ExprKind::Row {
                                base: b(base),
                                index: b(index),
                            }
                        })
                    }),
                (inner.clone(), 1u32..4).prop_map(|(f, order)| Expr::synth(ExprKind::PrimeDeriv {
                    function: b(f),
                    order
                })),
            ]
            .boxed();
            let inner_m = inner.clone();
            // A cell is an expression or one of the three display-only ellipses.
            let cell = prop_oneof![
                6 => inner_m.clone(),
                1 => select(EllipsisForm::ALL.to_vec())
                    .prop_map(|form| Expr::synth(ExprKind::EllipsisCell { form })),
            ];
            let matrix = prop_oneof![
                1 => Just(Expr::synth(ExprKind::Matrix { rows: 0, cols: 0, cells: vec![] })),
                4 => (1usize..4, 1usize..4).prop_flat_map(move |(r, c)| {
                    proptest::collection::vec(cell.clone(), r * c).prop_map(move |cells| {
                        Expr::synth(ExprKind::Matrix { rows: r, cols: c, cells })
                    })
                }),
            ]
            .boxed();
            let big = prop_oneof![
                (ident(), bounds(inner.clone()), inner.clone(), any::<bool>()).prop_map(
                    |(var, bounds, body, sum)| Expr::synth(if sum {
                        ExprKind::Sum {
                            var,
                            index: None,
                            bounds,
                            body: b(body),
                        }
                    } else {
                        ExprKind::Prod {
                            var,
                            index: None,
                            bounds,
                            body: b(body),
                        }
                    })
                ),
                (
                    ident(),
                    bounds(inner.clone()),
                    proptest::option::of(ident()),
                    inner.clone()
                )
                    .prop_map(|(var, bounds, algorithm, body)| Expr::synth(
                        ExprKind::Integral {
                            var,
                            bounds,
                            algorithm,
                            body: b(body),
                        }
                    )),
                (
                    ident(),
                    proptest::option::of(inner.clone()),
                    inner.clone(),
                    any::<bool>()
                )
                    .prop_map(|(var, order, body, d)| Expr::synth(if d {
                        ExprKind::Deriv {
                            var,
                            order: order.map(b),
                            body: b(body),
                        }
                    } else {
                        ExprKind::Partial {
                            var,
                            order: order.map(b),
                            body: b(body),
                        }
                    })),
                (
                    ident(),
                    inner.clone(),
                    select(vec![LimitSide::Both, LimitSide::Left, LimitSide::Right]),
                    inner.clone(),
                )
                    .prop_map(|(var, target, side, body)| Expr::synth(
                        ExprKind::Limit {
                            var,
                            target: b(target),
                            side,
                            body: b(body),
                        }
                    )),
            ]
            .boxed();
            let program = proptest::collection::vec(stmt(inner, 1), 1..4)
                .prop_map(|body| Expr::synth(ExprKind::Program { body }))
                .boxed();
            prop_oneof![
                6 => ops,
                3 => postfix,
                1 => matrix,
                2 => big,
                1 => program,
            ]
        })
        .boxed()
}

fn keyword_group(expr: BoxedStrategy<Expr>) -> BoxedStrategy<KeywordGroup> {
    (ident(), proptest::collection::vec(expr, 0..3))
        .prop_map(|(keyword, args)| KeywordGroup {
            keyword,
            args,
            span: Span::default(),
        })
        .boxed()
}

fn statement() -> BoxedStrategy<Statement> {
    let e = expr();
    let rhs = prop_oneof![
        5 => e.clone(),
        1 => range(e.clone()),
        2 => proptest::collection::vec(stmt(e.clone(), 2), 1..4)
            .prop_map(|body| Expr::synth(ExprKind::Program { body })),
    ]
    .boxed();
    let tail = proptest::option::of(prop_oneof![
        proptest::option::of(e.clone()).prop_map(|unit| Tail::Eval { unit }),
        proptest::collection::vec(keyword_group(e.clone()), 0..3)
            .prop_map(|keywords| Tail::Sym { keywords }),
    ])
    .boxed();
    prop_oneof![
        4 => (any_target(e.clone()), rhs.clone(), tail)
            .prop_map(|(target, rhs, tail)| Statement::synth(StatementKind::Define { target, rhs, tail })),
        1 => (any_target(e.clone()), rhs)
            .prop_map(|(target, rhs)| Statement::synth(StatementKind::GlobalDefine { target, rhs })),
        2 => (e.clone(), proptest::option::of(e.clone()))
            .prop_map(|(expr, unit)| Statement::synth(StatementKind::Evaluate { expr, unit })),
        1 => (e.clone(), proptest::collection::vec(keyword_group(e.clone()), 0..3))
            .prop_map(|(expr, keywords)| Statement::synth(StatementKind::Symbolic { expr, keywords })),
        2 => e.prop_map(|expr| Statement::synth(StatementKind::ExprRegion { expr })),
    ]
    .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 1500, ..ProptestConfig::default() })]

    #[test]
    fn statements_round_trip(mut s in statement()) {
        normalize_statement(&mut s);
        let text = print_statement(&s);
        let parsed = parse_statement(&text)
            .map_err(|e| TestCaseError::fail(format!("{e}\n--- text ---\n{text}")))?;
        prop_assert_eq!(&parsed, &s, "R1 failed for text:\n{}", text);
        prop_assert_eq!(print_statement(&parsed), text);
        // Normalization is idempotent.
        let mut again = s.clone();
        normalize_statement(&mut again);
        prop_assert_eq!(again, s);
    }

    #[test]
    fn expressions_round_trip(mut e in expr()) {
        normalize_expr(&mut e);
        let text = print_expression(&e);
        let parsed = parse_expression(&text)
            .map_err(|err| TestCaseError::fail(format!("{err}\n--- text ---\n{text}")))?;
        prop_assert_eq!(&parsed, &e, "R1 failed for text:\n{}", text);
        prop_assert_eq!(print_expression(&parsed), text);
    }

    #[test]
    fn program_blocks_round_trip(mut body in proptest::collection::vec(stmt(expr(), 2), 1..5)) {
        normalize_stmts(&mut body);
        let text = print_program_block(&body);
        let parsed = parse_program_block(&text)
            .map_err(|err| TestCaseError::fail(format!("{err}\n--- text ---\n{text}")))?;
        prop_assert_eq!(&parsed, &body, "R1 failed for text:\n{}", text);
        prop_assert_eq!(print_program_block(&parsed), text);
    }

    #[test]
    fn json_round_trip(mut s in statement()) {
        normalize_statement(&mut s);
        let json = serde_json::to_string(&s).unwrap();
        let back: Statement = serde_json::from_str(&json).unwrap();
        prop_assert_eq!(back, s);
    }
}
