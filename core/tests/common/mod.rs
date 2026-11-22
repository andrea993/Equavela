//! Test helpers: S-expression rendering in the notation of math-syntax section 15.
#![allow(dead_code)]

use equavela_core::ast::*;
use equavela_core::syntax::{
    parse_program_block, parse_statement, print_expression, print_name, print_program_block,
    print_statement,
};

pub fn sx_statement(s: &Statement) -> String {
    match &s.kind {
        StatementKind::Define { target, rhs, tail } => {
            let mut out = format!("(:= {} {}", sx_target(target), sx_expr(rhs));
            match tail {
                None => {}
                Some(Tail::Eval { unit: None }) => out.push_str(" (=)"),
                Some(Tail::Eval { unit: Some(u) }) => out.push_str(&format!(" (= {})", sx_expr(u))),
                Some(Tail::Sym { keywords }) => {
                    out.push_str(" (→");
                    for g in keywords {
                        out.push(' ');
                        out.push_str(&sx_keyword(g));
                    }
                    out.push(')');
                }
            }
            out.push(')');
            out
        }
        StatementKind::GlobalDefine { target, rhs } => {
            format!("(≡ {} {})", sx_target(target), sx_expr(rhs))
        }
        StatementKind::Table { units, grid } => {
            format!(
                "(table{} {})",
                if *units { " units" } else { "" },
                sx_expr(grid)
            )
        }
        StatementKind::Evaluate { expr, unit } => match unit {
            None => format!("(= {})", sx_expr(expr)),
            Some(u) => format!("(= {} {})", sx_expr(expr), sx_expr(u)),
        },
        StatementKind::Symbolic { expr, keywords } => {
            let mut out = format!("(→ {}", sx_expr(expr));
            for g in keywords {
                out.push(' ');
                out.push_str(&sx_keyword(g));
            }
            out.push(')');
            out
        }
        StatementKind::ExprRegion { expr } => sx_expr(expr),
        StatementKind::Julia { .. } => "(julia)".to_string(),
        StatementKind::Solve { constraints, call } => {
            let mut parts = vec!["solve".to_string()];
            parts.extend(constraints.iter().map(sx_expr));
            parts.push(sx_statement(call));
            format!("({})", parts.join(" "))
        }
    }
}

fn sx_keyword(g: &KeywordGroup) -> String {
    let mut parts = vec![print_name(&g.keyword.name)];
    parts.extend(g.args.iter().map(sx_expr));
    format!("({})", parts.join(" "))
}

pub fn sx_target(t: &Target) -> String {
    match &t.kind {
        TargetKind::Ident { name } => print_name(name),
        TargetKind::Index { base, indices } => {
            let mut parts = vec!["index".to_string(), sx_target(base)];
            parts.extend(indices.iter().map(sx_expr));
            format!("({})", parts.join(" "))
        }
        TargetKind::Column { base, index } => {
            format!("(col {} {})", sx_target(base), sx_expr(index))
        }
        TargetKind::Row { base, index } => format!("(row {} {})", sx_target(base), sx_expr(index)),
        TargetKind::Paren { target } => format!("(paren {})", sx_target(target)),
        TargetKind::Destructure { rows, cols, cells } => {
            let mut parts = vec!["destructure".to_string(), format!("{rows}×{cols}")];
            parts.extend(cells.iter().map(sx_target));
            format!("({})", parts.join(" "))
        }
        TargetKind::FunctionHead { name, params } => {
            let mut parts = vec!["fn".to_string(), print_name(&name.name)];
            parts.extend(params.iter().map(|p| print_name(&p.name)));
            format!("({})", parts.join(" "))
        }
    }
}

fn list(head: &str, items: Vec<String>) -> String {
    let mut parts = vec![head.to_string()];
    parts.extend(items);
    format!("({})", parts.join(" "))
}

fn sx_args(args: &[Arg]) -> Vec<String> {
    args.iter()
        .map(|a| match a {
            Arg::Expr { expr } => sx_expr(expr),
            Arg::InlineDef { target, value, .. } => {
                format!("(← {} {})", sx_target(target), sx_expr(value))
            }
        })
        .collect()
}

pub fn sx_expr(e: &Expr) -> String {
    use ExprKind as K;
    if let Some((op, x)) = e.kind.as_unary() {
        let head = match op {
            UnaryOp::Neg => "neg",
            UnaryOp::Not => "¬",
            UnaryOp::Factorial => "!",
            UnaryOp::Transpose => "ᵀ",
            UnaryOp::Conj => "conj",
            UnaryOp::RealPart => "Re",
            UnaryOp::ImagPart => "Im",
            UnaryOp::Abs => "abs",
            UnaryOp::Det => "det",
            UnaryOp::Norm => "norm",
            UnaryOp::Vectorize => "vec",
            UnaryOp::Percent => "%",
            UnaryOp::Permille => "‰",
        };
        return format!("({head} {})", sx_expr(x));
    }
    if let Some((op, l, r, split)) = e.kind.as_binary() {
        let head = match op {
            BinaryOp::Add => "+",
            BinaryOp::Sub => "-",
            BinaryOp::Mul => "·",
            BinaryOp::InlineDiv => "÷",
            BinaryOp::Juxt => "juxt",
            BinaryOp::Cross => "×",
            BinaryOp::Conv => "∗",
            BinaryOp::CircConv => "⊛",
            BinaryOp::Polar => "∠",
            BinaryOp::Div => "/",
            BinaryOp::Pow => "^",
            BinaryOp::Eq => "==",
            BinaryOp::Ne => "≠",
            BinaryOp::Lt => "<",
            BinaryOp::Gt => ">",
            BinaryOp::Le => "≤",
            BinaryOp::Ge => "≥",
            BinaryOp::In => "∈",
            BinaryOp::And => "∧",
            BinaryOp::Or => "∨",
            BinaryOp::Xor => "⊕",
        };
        let head = if split {
            format!("{head}↵")
        } else {
            head.to_string()
        };
        return format!("({head} {} {})", sx_expr(l), sx_expr(r));
    }
    match &e.kind {
        K::Num { .. } | K::Imag { .. } | K::Str { .. } | K::Placeholder | K::Ident { .. } => {
            print_expression(e)
        }
        K::Paren { expr } => format!("(paren {})", sx_expr(expr)),
        K::InlineDef { target, value } => format!("(← {} {})", sx_target(target), sx_expr(value)),
        K::Root { index, radicand } => match index {
            None => format!("(√ {})", sx_expr(radicand)),
            Some(i) => format!("(√ {} {})", sx_expr(i), sx_expr(radicand)),
        },
        K::Call { callee, args } => {
            let mut items = vec![sx_expr(callee)];
            items.extend(sx_args(args));
            list("call", items)
        }
        K::JuliaCall {
            package,
            name,
            args,
            bare,
        } => {
            if *bare {
                return format!("{package}::{name}");
            }
            let mut items = vec![format!("{package}::{name}")];
            items.extend(sx_args(args));
            list("julia", items)
        }
        K::Index { base, indices } => {
            let mut items = vec![sx_expr(base)];
            items.extend(indices.iter().map(sx_expr));
            list("index", items)
        }
        K::Column { base, index } => format!("(col {} {})", sx_expr(base), sx_expr(index)),
        K::Row { base, index } => format!("(row {} {})", sx_expr(base), sx_expr(index)),
        K::PrimeDeriv { function, order } => format!("(′ {} {order})", sx_expr(function)),
        K::Matrix { rows, cols, cells } => {
            let mut items = vec![format!("{rows}×{cols}")];
            items.extend(cells.iter().map(sx_expr));
            list("matrix", items)
        }
        K::Range {
            first,
            second,
            last,
        } => {
            let mut items = vec![sx_expr(first)];
            if let Some(s) = second {
                items.push(sx_expr(s));
            }
            items.push(sx_expr(last));
            list("range", items)
        }
        K::Sum {
            var, bounds, body, ..
        }
        | K::Prod {
            var, bounds, body, ..
        } => {
            let head = if matches!(e.kind, K::Sum { .. }) {
                "∑"
            } else {
                "∏"
            };
            let mut items = vec![print_name(&var.name)];
            if let Some(b) = bounds {
                items.push(sx_expr(&b.lo));
                items.push(sx_expr(&b.hi));
            }
            items.push(sx_expr(body));
            list(head, items)
        }
        K::Integral {
            var,
            bounds,
            algorithm,
            body,
        } => {
            let mut items = vec![print_name(&var.name)];
            if let Some(b) = bounds {
                items.push(sx_expr(&b.lo));
                items.push(sx_expr(&b.hi));
            }
            if let Some(a) = algorithm {
                items.push(format!("[{}]", print_name(&a.name)));
            }
            items.push(sx_expr(body));
            list("∫", items)
        }
        K::Gradient { vars, body } => {
            let names: Vec<String> = vars.iter().map(|v| print_name(&v.name)).collect();
            format!("(∇ [{}] {})", names.join(" "), sx_expr(body))
        }
        K::Deriv { var, order, body } | K::Partial { var, order, body } => {
            let head = if matches!(e.kind, K::Deriv { .. }) {
                "ⅆ"
            } else {
                "∂"
            };
            let mut items = vec![print_name(&var.name)];
            if let Some(o) = order {
                items.push(sx_expr(o));
            }
            items.push(sx_expr(body));
            list(head, items)
        }
        K::Limit {
            var,
            target,
            side,
            body,
        } => {
            let mut items = vec![print_name(&var.name), sx_expr(target)];
            match side {
                LimitSide::Both => {}
                LimitSide::Left => items.push("-".into()),
                LimitSide::Right => items.push("+".into()),
            }
            items.push(sx_expr(body));
            list("lim", items)
        }
        K::Program { body } => list("program", body.iter().map(sx_stmt).collect()),
        _ => unreachable!(),
    }
}

fn sx_body(body: &[Stmt]) -> Vec<String> {
    body.iter().map(sx_stmt).collect()
}

pub fn sx_stmt(s: &Stmt) -> String {
    match &s.kind {
        StmtKind::LocalDef { target, rhs } => format!("(← {} {})", sx_target(target), sx_expr(rhs)),
        StmtKind::If {
            branches,
            else_body,
        } => {
            let mut items = Vec::new();
            for b in branches {
                let mut parts = Vec::new();
                match b.kind {
                    BranchKind::If => {}
                    BranchKind::ElseIf => parts.push("elseif".to_string()),
                    BranchKind::AlsoIf => parts.push("alsoif".to_string()),
                }
                parts.push(sx_expr(&b.cond));
                parts.extend(sx_body(&b.body));
                items.push(format!("({})", parts.join(" ")));
            }
            if let Some(e) = else_body {
                items.push(list("else", sx_body(e)));
            }
            list("if", items)
        }
        StmtKind::For { var, source, body } => {
            let mut items = vec![print_name(&var.name), sx_expr(source)];
            items.extend(sx_body(body));
            list("for", items)
        }
        StmtKind::While { cond, body } => {
            let mut items = vec![sx_expr(cond)];
            items.extend(sx_body(body));
            list("while", items)
        }
        StmtKind::Break => "(break)".into(),
        StmtKind::Continue => "(continue)".into(),
        StmtKind::Return { expr } => format!("(return {})", sx_expr(expr)),
        StmtKind::Try { body, handler } => format!(
            "(try ({}) ({}))",
            sx_body(body).join(" "),
            sx_body(handler).join(" ")
        ),
        StmtKind::ExprStmt { expr } => sx_expr(expr),
    }
}

/// Parses a region and returns its S-expression; panics with the parse error.
pub fn sx(src: &str) -> String {
    match parse_statement(src) {
        Ok(s) => sx_statement(&s),
        Err(e) => panic!("parse error in {src:?}: {e}"),
    }
}

/// Parses program lines and returns the S-expressions of the statements.
pub fn sx_block(src: &str) -> String {
    match parse_program_block(src) {
        Ok(b) => sx_body(&b).join(" "),
        Err(e) => panic!("parse error in {src:?}: {e}"),
    }
}

/// `print(parse(src))`.
pub fn canon(src: &str) -> String {
    match parse_statement(src) {
        Ok(s) => print_statement(&s),
        Err(e) => panic!("parse error in {src:?}: {e}"),
    }
}

pub fn canon_block(src: &str) -> String {
    match parse_program_block(src) {
        Ok(b) => print_program_block(&b),
        Err(e) => panic!("parse error in {src:?}: {e}"),
    }
}

/// Asserts R1 and R2 for a canonical region text.
pub fn assert_fixed_point(src: &str) {
    let ast = parse_statement(src).unwrap_or_else(|e| panic!("parse error in {src:?}: {e}"));
    let printed = print_statement(&ast);
    assert_eq!(printed, src, "print(parse(t)) != t");
    let again = parse_statement(&printed).unwrap_or_else(|e| panic!("reparse of {printed:?}: {e}"));
    assert_eq!(again, ast, "parse(print(ast)) != ast for {src:?}");
}

/// Matches `actual` against `expected`, where `…` in `expected` stands for any text.
pub fn matches_elided(expected: &str, actual: &str) -> bool {
    let mut rest = actual;
    let parts: Vec<&str> = expected.split('…').collect();
    for (k, part) in parts.iter().enumerate() {
        if k == 0 {
            match rest.strip_prefix(part) {
                Some(r) => rest = r,
                None => return false,
            }
        } else if k == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            match rest.find(part) {
                Some(i) => rest = &rest[i + part.len()..],
                None => return false,
            }
        }
    }
    rest.is_empty()
}
