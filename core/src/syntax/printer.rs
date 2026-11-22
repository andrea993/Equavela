//! Canonical printer (math-syntax section 13).
//!
//! The printer is a function of the AST only. It prints exactly the `Paren` nodes of the
//! AST plus grouping parentheses in box positions, so the input must be normalized
//! (see [`super::normalize`]) for `parse(print(ast)) == ast` to hold.

use super::lexer::{is_plain_part, is_plain_sub, STATEMENT_KEYWORDS};
use super::prec::{box_needs_group, BoxPos};
use crate::ast::*;

/// Prints a region statement in canonical text.
pub fn print_statement(s: &Statement) -> String {
    let mut p = Printer::default();
    p.statement(s);
    p.out
}

/// Prints a program body in block form at indentation 0 (inverse of
/// [`super::parse_program_block`]).
pub fn print_program_block(body: &[Stmt]) -> String {
    let mut p = Printer::default();
    for (k, s) in body.iter().enumerate() {
        if k > 0 {
            p.out.push('\n');
        }
        p.block_stmt(s, 0);
    }
    p.out
}

/// Prints an expression in canonical text.
pub fn print_expression(e: &Expr) -> String {
    let mut p = Printer::default();
    p.expr(e, Ctx::default());
    p.out
}

/// Prints a list of call arguments separated by `, ` in canonical text, without parentheses: the
/// clipboard form of a run of arguments.
pub fn print_arguments(args: &[Arg]) -> String {
    let mut p = Printer::default();
    for (k, a) in args.iter().enumerate() {
        if k > 0 {
            p.out.push_str(", ");
        }
        p.arg(a);
    }
    p.out
}

/// Prints a name (with quoting, subscripts and label) in canonical text.
pub fn print_name(name: &Name) -> String {
    let mut out = String::new();
    write_name(&mut out, name);
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Bar {
    Single,
    Double,
}

/// Printing context for the `|` / `‖` disambiguation (math-syntax 5, rule 5 of 12).
#[derive(Debug, Clone, Copy, Default)]
struct Ctx {
    /// Innermost open `|…|` or `‖…‖` not hidden by brackets.
    closer: Option<Bar>,
    /// The next printed token must not be this bar (it would close the open one).
    no_lead: Option<Bar>,
}

impl Ctx {
    fn inner(self) -> Ctx {
        Ctx {
            closer: self.closer,
            no_lead: None,
        }
    }
}

#[derive(Default)]
struct Printer {
    out: String,
    /// Indentation of the first line of the statement being printed.
    indent: usize,
}

impl Printer {
    fn newline(&mut self, indent: usize) {
        self.out.push('\n');
        for _ in 0..indent {
            self.out.push(' ');
        }
    }

    // ----------------------------------------------------------------- statements

    fn statement(&mut self, s: &Statement) {
        self.indent = 0;
        match &s.kind {
            StatementKind::Define { target, rhs, tail } => {
                self.target(target);
                self.out.push_str(" := ");
                self.rhs(rhs, tail.is_none());
                match tail {
                    None => {}
                    Some(Tail::Eval { unit }) => self.eval_tail(unit.as_ref()),
                    Some(Tail::Sym { keywords }) => self.sym_tail(keywords),
                }
            }
            StatementKind::GlobalDefine { target, rhs } => {
                self.target(target);
                self.out.push_str(" ≡ ");
                self.rhs(rhs, true);
            }
            StatementKind::Evaluate { expr, unit } => {
                self.expr(expr, Ctx::default());
                self.eval_tail(unit.as_ref());
            }
            StatementKind::Symbolic { expr, keywords } => {
                self.expr(expr, Ctx::default());
                self.sym_tail(keywords);
            }
            StatementKind::ExprRegion { expr } => self.expr(expr, Ctx::default()),
            // the specification .
            StatementKind::Table { units, grid } => {
                self.out
                    .push_str(if *units { "table units:" } else { "table:" });
                self.expr(grid, Ctx::default());
            }
            // A julia region has no math text; this is a label for diagnostics only.
            StatementKind::Julia { .. } => self.out.push_str("julia"),
            // The assembled form of a Given/Find block has no math
            // text and is never written; this form is for diagnostics only.
            StatementKind::Solve { constraints, call } => {
                self.out.push_str("Given");
                for constraint in constraints {
                    self.out.push('\n');
                    self.expr(constraint, Ctx::default());
                }
                self.out.push('\n');
                self.statement(call);
            }
        }
    }

    /// Right side of `:=`, `≡` or `←` (block program allowed when `block_ok`).
    fn rhs(&mut self, rhs: &Expr, block_ok: bool) {
        match &rhs.kind {
            ExprKind::Program { body } if block_ok => {
                self.out.push_str("program");
                let ind = self.indent;
                self.block(body, ind + 2);
                self.indent = ind;
            }
            _ => self.range_or_expr(rhs),
        }
    }

    fn range_or_expr(&mut self, e: &Expr) {
        if let ExprKind::Range {
            first,
            second,
            last,
        } = &e.kind
        {
            self.expr(first, Ctx::default());
            if let Some(second) = second {
                self.out.push_str(", ");
                self.expr(second, Ctx::default());
            }
            self.out.push_str("..");
            self.expr(last, Ctx::default());
        } else {
            self.expr(e, Ctx::default());
        }
    }

    fn eval_tail(&mut self, unit: Option<&Expr>) {
        self.out.push_str(" =");
        if let Some(u) = unit {
            self.out.push_str(" … ");
            self.expr(u, Ctx::default());
        }
    }

    fn sym_tail(&mut self, keywords: &[KeywordGroup]) {
        self.out.push_str(" →");
        for g in keywords {
            self.out.push('[');
            write_binder(&mut self.out, &g.keyword.name);
            for a in &g.args {
                self.out.push_str(", ");
                self.expr(a, Ctx::default());
            }
            self.out.push(']');
        }
    }

    fn target(&mut self, t: &Target) {
        match &t.kind {
            TargetKind::Ident { name } => write_binder(&mut self.out, name),
            TargetKind::Index { base, indices } => {
                self.target(base);
                self.out.push('[');
                self.list(indices);
                self.out.push(']');
            }
            TargetKind::Column { base, index } => {
                self.target(base);
                self.out.push('⟨');
                self.expr(index, Ctx::default());
                self.out.push('⟩');
            }
            TargetKind::Row { base, index } => {
                self.target(base);
                self.out.push('⟪');
                self.expr(index, Ctx::default());
                self.out.push('⟫');
            }
            TargetKind::Paren { target } => {
                self.out.push('(');
                self.target(target);
                self.out.push(')');
            }
            TargetKind::Destructure { cols, cells, .. } => {
                self.out.push('[');
                for (k, c) in cells.iter().enumerate() {
                    if k > 0 {
                        self.out.push_str(if *cols > 0 && k % cols == 0 {
                            "; "
                        } else {
                            ", "
                        });
                    }
                    self.target(c);
                }
                self.out.push(']');
            }
            TargetKind::FunctionHead { name, params } => {
                write_binder(&mut self.out, &name.name);
                self.out.push('(');
                for (k, p) in params.iter().enumerate() {
                    if k > 0 {
                        self.out.push_str(", ");
                    }
                    write_binder(&mut self.out, &p.name);
                }
                self.out.push(')');
            }
        }
    }

    fn list(&mut self, items: &[Expr]) {
        for (k, e) in items.iter().enumerate() {
            if k > 0 {
                self.out.push_str(", ");
            }
            self.expr(e, Ctx::default());
        }
    }

    // ----------------------------------------------------------------- programs

    fn block(&mut self, body: &[Stmt], indent: usize) {
        for s in body {
            self.newline(indent);
            self.block_stmt(s, indent);
        }
    }

    fn block_stmt(&mut self, s: &Stmt, ind: usize) {
        self.indent = ind;
        match &s.kind {
            StmtKind::LocalDef { target, rhs } => {
                let start = self.out.len();
                self.target(target);
                self.out.push_str(" ← ");
                self.rhs(rhs, true);
                self.quote_leading_keyword(start);
            }
            StmtKind::If {
                branches,
                else_body,
            } => {
                for (k, b) in branches.iter().enumerate() {
                    if k > 0 {
                        self.newline(ind);
                    }
                    self.out.push_str(match b.kind {
                        BranchKind::If => "if ",
                        BranchKind::ElseIf => "else if ",
                        BranchKind::AlsoIf => "also if ",
                    });
                    self.indent = ind;
                    self.expr(&b.cond, Ctx::default());
                    self.block(&b.body, ind + 2);
                }
                if let Some(e) = else_body {
                    self.newline(ind);
                    self.out.push_str("else");
                    self.block(e, ind + 2);
                }
            }
            StmtKind::For { var, source, body } => {
                self.out.push_str("for ");
                write_binder(&mut self.out, &var.name);
                self.out.push_str(" ∈ ");
                self.range_or_expr(source);
                self.block(body, ind + 2);
            }
            StmtKind::While { cond, body } => {
                self.out.push_str("while ");
                self.expr(cond, Ctx::default());
                self.block(body, ind + 2);
            }
            StmtKind::Break => self.out.push_str("break"),
            StmtKind::Continue => self.out.push_str("continue"),
            StmtKind::Return { expr } => {
                self.out.push_str("return ");
                self.expr(expr, Ctx::default());
            }
            StmtKind::Try { body, handler } => {
                self.out.push_str("try");
                self.block(body, ind + 2);
                self.newline(ind);
                self.out.push_str("on error");
                self.block(handler, ind + 2);
            }
            StmtKind::ExprStmt { expr } => {
                let start = self.out.len();
                self.expr(expr, Ctx::default());
                self.quote_leading_keyword(start);
            }
        }
        self.indent = ind;
    }

    fn inline_body(&mut self, body: &[Stmt]) {
        self.out.push_str("{ ");
        for (k, s) in body.iter().enumerate() {
            if k > 0 {
                self.out.push_str("; ");
            }
            self.inline_stmt(s);
        }
        self.out.push_str(" }");
    }

    fn inline_stmt(&mut self, s: &Stmt) {
        match &s.kind {
            StmtKind::LocalDef { target, rhs } => {
                let start = self.out.len();
                self.target(target);
                self.out.push_str(" ← ");
                self.expr(rhs, Ctx::default());
                self.quote_leading_keyword(start);
            }
            StmtKind::If {
                branches,
                else_body,
            } => {
                for (k, b) in branches.iter().enumerate() {
                    if k > 0 {
                        self.out.push(' ');
                    }
                    self.out.push_str(match b.kind {
                        BranchKind::If => "if ",
                        BranchKind::ElseIf => "else if ",
                        BranchKind::AlsoIf => "also if ",
                    });
                    self.expr(&b.cond, Ctx::default());
                    self.out.push(' ');
                    self.inline_body(&b.body);
                }
                if let Some(e) = else_body {
                    self.out.push_str(" else ");
                    self.inline_body(e);
                }
            }
            StmtKind::For { var, source, body } => {
                self.out.push_str("for ");
                write_binder(&mut self.out, &var.name);
                self.out.push_str(" ∈ ");
                self.range_or_expr(source);
                self.out.push(' ');
                self.inline_body(body);
            }
            StmtKind::While { cond, body } => {
                self.out.push_str("while ");
                self.expr(cond, Ctx::default());
                self.out.push(' ');
                self.inline_body(body);
            }
            StmtKind::Break => self.out.push_str("break"),
            StmtKind::Continue => self.out.push_str("continue"),
            StmtKind::Return { expr } => {
                self.out.push_str("return ");
                self.expr(expr, Ctx::default());
            }
            StmtKind::Try { body, handler } => {
                self.out.push_str("try ");
                self.inline_body(body);
                self.out.push_str(" on error ");
                self.inline_body(handler);
            }
            StmtKind::ExprStmt { expr } => {
                let start = self.out.len();
                self.expr(expr, Ctx::default());
                self.quote_leading_keyword(start);
            }
        }
    }

    /// A statement that starts with a name spelled like a statement keyword and followed
    /// by a delimiter would be read as that keyword: quote the name (math-syntax 3.2).
    fn quote_leading_keyword(&mut self, start: usize) {
        let text = &self.out[start..];
        for kw in STATEMENT_KEYWORDS {
            if let Some(rest) = text.strip_prefix(kw) {
                if matches!(rest.chars().next(), None | Some(' ' | '\n' | ';' | '}')) {
                    self.out.insert(start + kw.len(), '`');
                    self.out.insert(start, '`');
                    return;
                }
            }
        }
    }

    // ----------------------------------------------------------------- expressions

    fn expr(&mut self, e: &Expr, ctx: Ctx) {
        use ExprKind as K;
        match &e.kind {
            K::Num { text } => self.out.push_str(text),
            K::Imag { text, symbol } => {
                self.out.push_str(text);
                self.out.push(symbol.as_char());
            }
            K::Str { text } => write_string(&mut self.out, text),
            K::Placeholder => self.out.push('□'),
            K::EllipsisCell { form } => self.out.push_str(form.glyph()),
            K::Ident { name } => write_name(&mut self.out, name),
            K::Paren { expr } => {
                self.out.push('(');
                self.expr(expr, Ctx::default());
                self.out.push(')');
            }
            K::InlineDef { target, value } => {
                self.target(target);
                self.out.push_str(" ← ");
                self.expr(value, Ctx::default());
            }
            K::Neg { expr } => {
                self.out.push('-');
                self.expr(expr, ctx.inner());
            }
            K::Not { expr } => {
                self.out.push('¬');
                self.expr(expr, ctx.inner());
            }
            K::Factorial { expr } => {
                self.expr(expr, ctx);
                self.out.push('!');
            }
            // the reference application's percent: written directly after its operand.
            K::Percent { expr } => {
                self.expr(expr, ctx);
                self.out.push('%');
            }
            K::Permille { expr } => {
                self.expr(expr, ctx);
                self.out.push('‰');
            }
            K::Transpose { expr } => {
                self.expr(expr, ctx);
                self.out.push('ᵀ');
            }
            K::Conj { expr } => self.word_call("\\conj", expr),
            K::RealPart { expr } => self.word_call("\\Re", expr),
            K::ImagPart { expr } => self.word_call("\\Im", expr),
            K::Det { expr } => self.word_call("\\det", expr),
            K::Vectorize { expr } => self.word_call("\\vec", expr),
            K::Abs { expr } => {
                if ctx.no_lead == Some(Bar::Single) {
                    self.word_call("\\abs", expr);
                } else {
                    self.out.push('|');
                    self.expr(
                        expr,
                        Ctx {
                            closer: Some(Bar::Single),
                            no_lead: None,
                        },
                    );
                    self.out.push('|');
                }
            }
            K::Norm { expr } => {
                if ctx.no_lead == Some(Bar::Double) {
                    self.word_call("\\norm", expr);
                } else {
                    self.out.push('‖');
                    self.expr(
                        expr,
                        Ctx {
                            closer: Some(Bar::Double),
                            no_lead: None,
                        },
                    );
                    self.out.push('‖');
                }
            }
            K::Div { left, right } => {
                self.boxed(BoxPos::Numerator, left, ctx);
                self.out.push('/');
                self.boxed(BoxPos::Denominator, right, ctx.inner());
            }
            K::Pow { left, right } => {
                self.expr(left, ctx);
                self.out.push('^');
                self.boxed(BoxPos::Exponent, right, ctx.inner());
            }
            k if k.as_binary().is_some() => {
                let (op, left, right, split) = k.as_binary().expect("binary node");
                self.expr(left, ctx);
                let glyph = match op {
                    BinaryOp::Add => " +",
                    BinaryOp::Sub => " -",
                    BinaryOp::Mul => "·",
                    BinaryOp::InlineDiv => "÷",
                    BinaryOp::Juxt => "",
                    BinaryOp::Cross => " ×",
                    BinaryOp::Conv => " ∗",
                    BinaryOp::CircConv => " ⊛",
                    BinaryOp::Polar => "∠",
                    BinaryOp::Eq => " ==",
                    BinaryOp::Ne => " ≠",
                    BinaryOp::Lt => " <",
                    BinaryOp::Gt => " >",
                    BinaryOp::Le => " ≤",
                    BinaryOp::Ge => " ≥",
                    BinaryOp::In => " ∈",
                    BinaryOp::And => " ∧",
                    BinaryOp::Or => " ∨",
                    BinaryOp::Xor => " ⊕",
                    BinaryOp::Div | BinaryOp::Pow => unreachable!("handled above"),
                };
                self.out.push_str(glyph);
                let spaced = !matches!(op, BinaryOp::Mul | BinaryOp::InlineDiv | BinaryOp::Polar);
                if split && op.splittable() {
                    let ind = self.indent + 4;
                    self.newline(ind);
                } else if spaced {
                    self.out.push(' ');
                }
                let right_ctx = Ctx {
                    closer: ctx.closer,
                    no_lead: if op == BinaryOp::Juxt {
                        ctx.closer
                    } else {
                        None
                    },
                };
                self.expr(right, right_ctx);
            }
            K::Root { index, radicand } => {
                self.out.push('√');
                if let Some(i) = index {
                    self.out.push('[');
                    self.expr(i, Ctx::default());
                    self.out.push(']');
                }
                self.boxed(BoxPos::Radicand, radicand, ctx.inner());
            }
            K::Call { callee, args } => {
                self.expr(callee, ctx);
                self.args(args);
            }
            K::JuliaCall {
                package,
                name,
                args,
                bare,
            } => {
                self.out.push_str(package);
                // `julia.name`; a package call keeps `Package::name`.
                self.out
                    .push_str(if package == "julia" { "." } else { "::" });
                self.out.push_str(name);
                if !bare {
                    self.args(args);
                }
            }
            K::Index { base, indices } => {
                self.expr(base, ctx);
                self.out.push('[');
                self.list(indices);
                self.out.push(']');
            }
            K::Column { base, index } => {
                self.expr(base, ctx);
                self.out.push('⟨');
                self.expr(index, Ctx::default());
                self.out.push('⟩');
            }
            K::Row { base, index } => {
                self.expr(base, ctx);
                self.out.push('⟪');
                self.expr(index, Ctx::default());
                self.out.push('⟫');
            }
            K::PrimeDeriv { function, order } => {
                self.expr(function, ctx);
                for _ in 0..*order {
                    self.out.push('′');
                }
            }
            K::Matrix { cols, cells, .. } => {
                self.out.push('[');
                for (k, c) in cells.iter().enumerate() {
                    if k > 0 {
                        self.out.push_str(if *cols > 0 && k % cols == 0 {
                            "; "
                        } else {
                            ", "
                        });
                    }
                    self.expr(c, Ctx::default());
                }
                self.out.push(']');
            }
            K::Range { .. } => self.range_or_expr(e),
            K::Sum {
                var,
                index,
                bounds,
                body,
            } => self.big("∑", var, index.as_deref(), bounds.as_ref(), None, body, ctx),
            K::Prod {
                var,
                index,
                bounds,
                body,
            } => self.big("∏", var, index.as_deref(), bounds.as_ref(), None, body, ctx),
            K::Integral {
                var,
                bounds,
                algorithm,
                body,
            } => self.big(
                "∫",
                var,
                None,
                bounds.as_ref(),
                algorithm.as_ref(),
                body,
                ctx,
            ),
            K::Deriv { var, order, body } => self.deriv("ⅆ", var, order.as_deref(), body, ctx),
            K::Partial { var, order, body } => self.deriv("∂", var, order.as_deref(), body, ctx),
            K::Gradient { vars, body } => {
                self.out.push_str("∇[");
                for (index, var) in vars.iter().enumerate() {
                    if index > 0 {
                        self.out.push_str(", ");
                    }
                    write_binder(&mut self.out, &var.name);
                }
                self.out.push_str("] ");
                self.expr(body, ctx.inner());
            }
            K::Limit {
                var,
                target,
                side,
                body,
            } => {
                self.out.push_str("\\lim[");
                write_binder(&mut self.out, &var.name);
                self.out.push_str(", ");
                self.expr(target, Ctx::default());
                match side {
                    LimitSide::Both => {}
                    LimitSide::Left => self.out.push_str(", -"),
                    LimitSide::Right => self.out.push_str(", +"),
                }
                self.out.push_str("] ");
                self.expr(body, ctx.inner());
            }
            K::Program { body } => {
                self.out.push_str("program ");
                self.inline_body(body);
            }
            // All binary kinds are covered by the guard arm above.
            K::Add { .. }
            | K::Sub { .. }
            | K::Mul { .. }
            | K::InlineDiv { .. }
            | K::Juxt { .. }
            | K::Cross { .. }
            | K::Conv { .. }
            | K::CircConv { .. }
            | K::Polar { .. }
            | K::Eq { .. }
            | K::Ne { .. }
            | K::Lt { .. }
            | K::Gt { .. }
            | K::Le { .. }
            | K::Ge { .. }
            | K::In { .. }
            | K::And { .. }
            | K::Or { .. }
            | K::Xor { .. } => unreachable!("binary nodes are printed by the guard arm"),
        }
    }

    fn word_call(&mut self, word: &str, e: &Expr) {
        self.out.push_str(word);
        self.out.push('(');
        self.expr(e, Ctx::default());
        self.out.push(')');
    }

    fn boxed(&mut self, pos: BoxPos, e: &Expr, ctx: Ctx) {
        if box_needs_group(pos, e) {
            self.out.push('(');
            self.expr(e, Ctx::default());
            self.out.push(')');
        } else {
            self.expr(e, ctx);
        }
    }

    fn args(&mut self, args: &[Arg]) {
        self.out.push('(');
        for (k, a) in args.iter().enumerate() {
            if k > 0 {
                self.out.push_str(", ");
            }
            self.arg(a);
        }
        self.out.push(')');
    }

    /// One call argument: an expression, or an inline definition `A ← e`.
    fn arg(&mut self, a: &Arg) {
        match a {
            Arg::Expr { expr } => self.expr(expr, Ctx::default()),
            Arg::InlineDef { target, value, .. } => {
                self.target(target);
                self.out.push_str(" ← ");
                self.expr(value, Ctx::default());
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn big(
        &mut self,
        glyph: &str,
        var: &Ident,
        index: Option<&Expr>,
        bounds: Option<&Bounds>,
        algorithm: Option<&Ident>,
        body: &Expr,
        ctx: Ctx,
    ) {
        self.out.push_str(glyph);
        self.out.push('[');
        match index {
            Some(index) => self.expr(index, Ctx::default()),
            None => write_binder(&mut self.out, &var.name),
        }
        if let Some(b) = bounds {
            self.out.push_str(match b.glyph {
                BoundGlyph::In => " ∈ ",
                BoundGlyph::Equals => " = ",
                BoundGlyph::Define => " := ",
            });
            self.expr(&b.lo, Ctx::default());
            self.out.push_str("..");
            self.expr(&b.hi, Ctx::default());
        }
        if let Some(a) = algorithm {
            self.out.push_str("; ");
            write_name(&mut self.out, &a.name);
        }
        self.out.push_str("] ");
        self.expr(body, ctx.inner());
    }

    fn deriv(&mut self, glyph: &str, var: &Ident, order: Option<&Expr>, body: &Expr, ctx: Ctx) {
        self.out.push_str(glyph);
        self.out.push('[');
        write_binder(&mut self.out, &var.name);
        if let Some(n) = order {
            self.out.push('^');
            self.boxed(BoxPos::Exponent, n, Ctx::default());
        }
        self.out.push_str("] ");
        self.expr(body, ctx.inner());
    }
}

// ----------------------------------------------------------------- leaves

fn write_binder(out: &mut String, name: &Name) {
    if name.segments.iter().all(|s| s.text.is_empty()) {
        out.push('□');
    } else {
        write_name(out, name);
    }
}

fn write_name(out: &mut String, name: &Name) {
    let segs = &name.segments;
    let simple_tail = segs.len() == 2 && !segs[0].subscript && segs[1].subscript;
    for (k, s) in segs.iter().enumerate() {
        if !s.subscript {
            let keyword = segs.len() == 1 && name.label.is_none() && s.text == "program";
            if is_plain_part(&s.text) && !keyword {
                out.push_str(&s.text);
            } else {
                write_quoted(out, &s.text);
            }
        } else if simple_tail && k == 1 {
            out.push('_');
            if is_plain_sub(&s.text) {
                out.push_str(&s.text);
            } else {
                write_quoted(out, &s.text);
            }
        } else {
            out.push_str("_{");
            for c in s.text.chars() {
                if c == '}' || c == '\\' {
                    out.push('\\');
                }
                out.push(c);
            }
            out.push('}');
        }
    }
    if let Some(l) = name.label {
        out.push('@');
        out.push_str(l.as_str());
    }
}

fn write_quoted(out: &mut String, text: &str) {
    out.push('`');
    for c in text.chars() {
        if c == '`' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('`');
}

fn write_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{{{:X}}}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}
