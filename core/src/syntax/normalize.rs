//! AST normalization (math-syntax 11.5). `normalize` is idempotent.
//!
//! Applied:
//! - N1: required `Paren` nodes in non-box operand positions, including a big operator
//!   followed by more factors of its multiplicative chain;
//! - N3: empty name segments dropped, adjacent segments of the same kind merged, a leading
//!   subscript segment turned into a base;
//! - N4: a signed number text becomes `Neg(Num)` (a leading `+` is dropped);
//! - N7: an empty program body becomes a single placeholder statement;
//! - consecutive primes merged: `PrimeDeriv(PrimeDeriv(f, a), b)` → `PrimeDeriv(f, a + b)`;
//! - N8 holds by construction (only `Add`, `Sub`, `Mul`, `InlineDiv` have `split`).
//!
//! Not repairable here, and therefore left untouched (the parser rejects them): N2 (box
//! parentheses are kept, as the user typed them), N5 (matrix shape), N6 (mixed
//! `else if` / `also if`), N9 (an importer concern), N10 (ranges out of place).

use super::prec::{ends_in_big_op, fits, Pos};
use crate::ast::*;

/// Normalizes a region statement in place.
pub fn normalize_statement(s: &mut Statement) {
    match &mut s.kind {
        StatementKind::Define { target, rhs, tail } => {
            normalize_target(target);
            normalize_expr(rhs);
            match tail {
                Some(Tail::Eval { unit: Some(u) }) => normalize_expr(u),
                Some(Tail::Sym { keywords }) => normalize_keywords(keywords),
                _ => {}
            }
        }
        StatementKind::GlobalDefine { target, rhs } => {
            normalize_target(target);
            normalize_expr(rhs);
        }
        StatementKind::Evaluate { expr, unit } => {
            normalize_expr(expr);
            if let Some(u) = unit {
                normalize_expr(u);
            }
        }
        StatementKind::Symbolic { expr, keywords } => {
            normalize_expr(expr);
            normalize_keywords(keywords);
        }
        StatementKind::ExprRegion { expr } => normalize_expr(expr),
        StatementKind::Table { grid, .. } => normalize_expr(grid),
        StatementKind::Julia { .. } => {}
        StatementKind::Solve { constraints, call } => {
            for constraint in constraints {
                normalize_expr(constraint);
            }
            normalize_statement(call);
        }
    }
}

fn normalize_keywords(groups: &mut [KeywordGroup]) {
    for g in groups {
        normalize_name(&mut g.keyword.name);
        for a in &mut g.args {
            normalize_expr(a);
        }
    }
}

/// Normalizes a program body in place.
pub fn normalize_stmts(body: &mut Vec<Stmt>) {
    if body.is_empty() {
        body.push(Stmt::synth(StmtKind::ExprStmt {
            expr: Expr::synth(ExprKind::Placeholder),
        }));
    }
    for s in body {
        normalize_stmt(s);
    }
}

fn normalize_stmt(s: &mut Stmt) {
    match &mut s.kind {
        StmtKind::LocalDef { target, rhs } => {
            normalize_target(target);
            normalize_expr(rhs);
        }
        StmtKind::If {
            branches,
            else_body,
        } => {
            for b in branches {
                normalize_expr(&mut b.cond);
                normalize_stmts(&mut b.body);
            }
            if let Some(e) = else_body {
                normalize_stmts(e);
            }
        }
        StmtKind::For { var, source, body } => {
            normalize_name(&mut var.name);
            normalize_expr(source);
            normalize_stmts(body);
        }
        StmtKind::While { cond, body } => {
            normalize_expr(cond);
            normalize_stmts(body);
        }
        StmtKind::Break | StmtKind::Continue => {}
        StmtKind::Return { expr } | StmtKind::ExprStmt { expr } => normalize_expr(expr),
        StmtKind::Try { body, handler } => {
            normalize_stmts(body);
            normalize_stmts(handler);
        }
    }
}

/// Normalizes a target in place.
pub fn normalize_target(t: &mut Target) {
    match &mut t.kind {
        TargetKind::Invalid { expr } => normalize_expr(expr),
        TargetKind::Ident { name } => normalize_name(name),
        TargetKind::Index { base, indices } => {
            normalize_target(base);
            for i in indices {
                normalize_expr(i);
            }
        }
        TargetKind::Column { base, index } | TargetKind::Row { base, index } => {
            normalize_target(base);
            normalize_expr(index);
        }
        TargetKind::Paren { target } | TargetKind::Transpose { target } => normalize_target(target),
        TargetKind::Destructure { cells, .. } => {
            for c in cells {
                normalize_target(c);
            }
        }
        TargetKind::FunctionHead { name, params } => {
            normalize_name(&mut name.name);
            for p in params {
                normalize_name(&mut p.name);
            }
        }
    }
}

/// N3 for one name.
pub fn normalize_name(name: &mut Name) {
    let mut merged: Vec<Segment> = Vec::with_capacity(name.segments.len());
    for s in name.segments.drain(..) {
        if s.text.is_empty() {
            continue;
        }
        let subscript = s.subscript && !merged.is_empty();
        match merged.last_mut() {
            Some(last) if last.subscript == subscript => last.text.push_str(&s.text),
            _ => merged.push(Segment {
                text: s.text,
                subscript,
            }),
        }
    }
    name.segments = merged;
}

fn wrap(e: &mut Expr) {
    let span = e.span;
    let inner = std::mem::replace(e, Expr::new(ExprKind::Placeholder, span));
    *e = Expr::new(
        ExprKind::Paren {
            expr: Box::new(inner),
        },
        span,
    );
}

fn ensure(pos: Pos, e: &mut Expr) {
    if !fits(pos, e) {
        wrap(e);
    }
}

/// Wraps the big operator at the end of the right spine of `e` (see [`ends_in_big_op`]).
fn wrap_trailing_big_op(e: &mut Expr) {
    if e.kind.is_big_op() {
        wrap(e);
        return;
    }
    match &mut e.kind {
        ExprKind::Mul { right, .. }
        | ExprKind::InlineDiv { right, .. }
        | ExprKind::Cross { right, .. }
        | ExprKind::Conv { right, .. }
        | ExprKind::CircConv { right, .. }
        | ExprKind::Juxt { right, .. } => wrap_trailing_big_op(right),
        ExprKind::Neg { expr } => wrap_trailing_big_op(expr),
        _ => {}
    }
}

fn normalize_args(args: &mut [Arg]) {
    for a in args {
        match a {
            Arg::Expr { expr } => normalize_expr(expr),
            Arg::InlineDef { target, value, .. } => {
                normalize_target(target);
                normalize_expr(value);
            }
        }
    }
}

fn normalize_bounds(b: &mut Option<Bounds>) {
    if let Some(b) = b {
        normalize_expr(&mut b.lo);
        normalize_expr(&mut b.hi);
        ensure(Pos::AddExpr, &mut b.lo);
        ensure(Pos::AddExpr, &mut b.hi);
    }
}

/// Normalizes an expression in place (its own node and all descendants).
pub fn normalize_expr(e: &mut Expr) {
    use ExprKind as K;

    // N4: signed number text.
    if let K::Num { text } = &mut e.kind {
        if let Some(rest) = text.strip_prefix('+') {
            *text = rest.to_string();
        }
        if let Some(rest) = text.strip_prefix('-') {
            let num = Expr::new(
                K::Num {
                    text: rest.to_string(),
                },
                e.span,
            );
            e.kind = K::Neg {
                expr: Box::new(num),
            };
        }
    }

    if let Some((op, l, r)) = e.kind.as_binary_mut() {
        normalize_expr(l);
        normalize_expr(r);
        let (lp, rp) = match op {
            BinaryOp::Or | BinaryOp::Xor | BinaryOp::Gap => (Some(Pos::OrLeft), Some(Pos::OrRight)),
            BinaryOp::And => (Some(Pos::AndLeft), Some(Pos::AndRight)),
            BinaryOp::Eq
            | BinaryOp::Ne
            | BinaryOp::Lt
            | BinaryOp::Gt
            | BinaryOp::Le
            | BinaryOp::Ge
            | BinaryOp::In => (Some(Pos::CmpLeft), Some(Pos::CmpRight)),
            BinaryOp::Add | BinaryOp::Sub => (Some(Pos::AddLeft), Some(Pos::AddRight)),
            BinaryOp::Mul
            | BinaryOp::InlineDiv
            | BinaryOp::Cross
            | BinaryOp::Conv
            | BinaryOp::CircConv => (Some(Pos::MulLeft), Some(Pos::MulRight)),
            BinaryOp::Juxt => (Some(Pos::MulLeft), Some(Pos::JuxtRight)),
            BinaryOp::Polar => (Some(Pos::PolarOperand), Some(Pos::PolarOperand)),
            BinaryOp::Div => (None, None),
            BinaryOp::Pow => (Some(Pos::PowBase), None),
        };
        if let Some(p) = lp {
            ensure(p, l);
            if p == Pos::MulLeft && ends_in_big_op(l) {
                wrap_trailing_big_op(l);
            }
        }
        if let Some(p) = rp {
            ensure(p, r);
        }
        return;
    }

    if let Some((op, x)) = e.kind.as_unary_mut() {
        normalize_expr(x);
        match op {
            UnaryOp::Neg => ensure(Pos::NegOperand, x),
            UnaryOp::Not => ensure(Pos::NotOperand, x),
            UnaryOp::Factorial | UnaryOp::Transpose | UnaryOp::Percent | UnaryOp::Permille => {
                ensure(Pos::PostfixBase, x)
            }
            _ => {}
        }
        return;
    }

    match &mut e.kind {
        K::Num { .. } | K::Imag { .. } | K::Str { .. } | K::Placeholder => {}
        K::EllipsisCell { .. } => {}
        K::Ident { name } => normalize_name(name),
        K::Paren { expr } => normalize_expr(expr),
        K::InlineDef { target, value } => {
            normalize_target(target);
            normalize_expr(value);
        }
        K::Root { index, radicand } => {
            if let Some(i) = index {
                normalize_expr(i);
            }
            normalize_expr(radicand);
        }
        K::Call { callee, args } => {
            normalize_expr(callee);
            ensure(Pos::PostfixBase, callee);
            normalize_args(args);
        }
        K::JuliaCall { args, .. } => normalize_args(args),
        K::Index { base, indices } => {
            normalize_expr(base);
            ensure(Pos::PostfixBase, base);
            for i in indices {
                normalize_expr(i);
            }
        }
        K::Column { base, index } | K::Row { base, index } => {
            normalize_expr(base);
            ensure(Pos::PostfixBase, base);
            normalize_expr(index);
        }
        K::PrimeDeriv { function, order } => {
            normalize_expr(function);
            if let K::PrimeDeriv {
                function: inner,
                order: inner_order,
            } = &mut function.kind
            {
                let total = *order + *inner_order;
                let inner = std::mem::replace(inner, Box::new(Expr::synth(K::Placeholder)));
                *function = inner;
                *order = total;
            }
            ensure(Pos::PostfixBase, function);
        }
        K::Matrix { cells, .. } => {
            for c in cells {
                normalize_expr(c);
            }
        }
        K::Range {
            first,
            second,
            last,
        } => {
            normalize_expr(first);
            ensure(Pos::AddExpr, first);
            if let Some(s) = second {
                normalize_expr(s);
                ensure(Pos::AddExpr, s);
            }
            normalize_expr(last);
            ensure(Pos::AddExpr, last);
        }
        K::Sum {
            var,
            index,
            bounds,
            body,
        }
        | K::Prod {
            var,
            index,
            bounds,
            body,
        } => {
            normalize_name(&mut var.name);
            if let Some(index) = index {
                normalize_expr(index);
                ensure(Pos::NotOperand, index);
            }
            normalize_bounds(bounds);
            normalize_expr(body);
            ensure(Pos::BigBody, body);
        }
        K::Integral {
            var,
            bounds,
            algorithm,
            body,
        } => {
            normalize_name(&mut var.name);
            normalize_bounds(bounds);
            if let Some(a) = algorithm {
                normalize_name(&mut a.name);
            }
            normalize_expr(body);
            ensure(Pos::BigBody, body);
        }
        K::Gradient { vars, body } => {
            for var in vars.iter_mut() {
                normalize_name(&mut var.name);
            }
            normalize_expr(body);
            ensure(Pos::BigBody, body);
        }
        K::Deriv { var, order, body } | K::Partial { var, order, body } => {
            normalize_name(&mut var.name);
            if let Some(o) = order {
                normalize_expr(o);
            }
            normalize_expr(body);
            ensure(Pos::BigBody, body);
        }
        K::Limit {
            var, target, body, ..
        } => {
            normalize_name(&mut var.name);
            normalize_expr(target);
            ensure(Pos::AddExpr, target);
            normalize_expr(body);
            ensure(Pos::BigBody, body);
        }
        K::Program { body } => normalize_stmts(body),
        _ => {}
    }
}
