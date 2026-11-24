//! The reference application unit names the engine knows.
//!
//! The table is `kernel/EqRuntime/src/units.tsv`, the same file EqRuntime reads to build
//! its Unitful quantities, so the generator, the static dimensional analysis and the
//! kernel always agree on which names are units and on their dimensions. A unit name in
//! worksheet math is generated as `eq_unit("km")`; the value lives in EqRuntime.
//!
//! A unit is a **labelled** name: the table says which spellings
//! are available as units, and [`is_unit`] answers only that question. The bottom of this file labels
//! the unit names a version 2 worksheet resolved by context, for the format migration of
//! the specification, and [`labelled_unit_text`] labels a unit expression that becomes
//! generated math (a table column unit).

use crate::ast::{
    Arg, Expr, ExprKind, Ident, Label, Name, Statement, StatementKind, Stmt, StmtKind, Tail,
    Target, TargetKind,
};
use crate::fasthash::HashSet;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Exponents of length, mass, time, current, temperature, amount and luminous intensity.
pub type UnitExponents = [i8; 7];

const TABLE: &str = include_str!("../../kernel/EqRuntime/src/units.tsv");

struct UnitTable {
    /// Every accepted name with its dimension (plain names win over prefix readings).
    names: HashMap<String, UnitExponents>,
}

fn table() -> &'static UnitTable {
    static TABLE_CELL: OnceLock<UnitTable> = OnceLock::new();
    TABLE_CELL.get_or_init(|| parse(TABLE))
}

fn parse(text: &str) -> UnitTable {
    let mut prefixes: Vec<String> = Vec::new();
    let mut entries: Vec<(String, UnitExponents, bool)> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields[0] == "@prefix" {
            prefixes.push(fields[1].to_string());
            continue;
        }
        assert!(fields.len() == 4, "units.tsv: bad line `{line}`");
        let parsed: Vec<i8> = fields[1]
            .split(',')
            .map(|part| part.parse().expect("units.tsv: bad exponent"))
            .collect();
        let exponents: UnitExponents = parsed.try_into().expect("units.tsv: 7 exponents");
        entries.push((fields[0].to_string(), exponents, fields[2] == "p"));
    }
    let mut names: HashMap<String, UnitExponents> = HashMap::new();
    for (name, exponents, _) in &entries {
        names.insert(name.clone(), *exponents);
    }
    for (name, exponents, prefixable) in &entries {
        if !prefixable {
            continue;
        }
        for prefix in &prefixes {
            names.entry(format!("{prefix}{name}")).or_insert(*exponents);
        }
    }
    UnitTable { names }
}

/// The dimension exponents of a unit name, or `None` when `name` is not a unit.
pub fn unit_exponents(name: &str) -> Option<UnitExponents> {
    table().names.get(name).copied()
}

/// Whether `name` is a reference application unit name.
pub fn is_unit(name: &str) -> bool {
    table().names.contains_key(name)
}

/// The unit written in a literal quantity (`12 kN/m`, `-3.5 m`, `2·10^3 N·m`): the expression with
/// its numbers taken out. `None` when `expr` holds anything but numbers and labelled unit names, or
/// no unit at all. The unit is for a unit context: its names are plain (`kN/m`, not `kN@unit`).
/// The side panel shows a definition's value in this unit.
pub fn literal_quantity_unit(expr: &Expr) -> Option<Expr> {
    enum Part {
        Number,
        Unit(Expr),
    }
    fn join(kind: fn(Box<Expr>, Box<Expr>) -> ExprKind, left: Expr, right: Expr) -> Expr {
        let span = left.span;
        Expr::new(kind(Box::new(left), Box::new(right)), span)
    }
    fn mul(left: Box<Expr>, right: Box<Expr>) -> ExprKind {
        ExprKind::Mul {
            left,
            right,
            split: false,
        }
    }
    fn div(left: Box<Expr>, right: Box<Expr>) -> ExprKind {
        ExprKind::Div { left, right }
    }
    fn part(expr: &Expr) -> Option<Part> {
        match &expr.kind {
            ExprKind::Num { .. } => Some(Part::Number),
            ExprKind::Ident { name } if name.label == Some(Label::Unit) => {
                let name = Name {
                    label: None,
                    ..name.clone()
                };
                Some(Part::Unit(Expr::new(ExprKind::Ident { name }, expr.span)))
            }
            ExprKind::Paren { expr: inner } => match part(inner)? {
                Part::Unit(unit) => Some(Part::Unit(Expr::new(
                    ExprKind::Paren {
                        expr: Box::new(unit),
                    },
                    expr.span,
                ))),
                Part::Number => Some(Part::Number),
            },
            ExprKind::Neg { expr } => part(expr),
            // A table column (`[1; 2]·m`) or a vector of numbers.
            ExprKind::Matrix { cells, .. } => cells
                .iter()
                .all(|cell| matches!(part(cell), Some(Part::Number)))
                .then_some(Part::Number),
            ExprKind::Mul { left, right, .. } | ExprKind::Juxt { left, right } => {
                Some(match (part(left)?, part(right)?) {
                    (Part::Number, other) | (other, Part::Number) => other,
                    (Part::Unit(left), Part::Unit(right)) => Part::Unit(join(mul, left, right)),
                })
            }
            ExprKind::Div { left, right } | ExprKind::InlineDiv { left, right, .. } => {
                Some(match (part(left)?, part(right)?) {
                    (left, Part::Number) => left,
                    (Part::Number, Part::Unit(right)) => {
                        let one = Expr::new(ExprKind::Num { text: "1".into() }, right.span);
                        Part::Unit(join(div, one, right))
                    }
                    (Part::Unit(left), Part::Unit(right)) => Part::Unit(join(div, left, right)),
                })
            }
            ExprKind::Pow { left, right } => match (part(left)?, part(right)?) {
                (Part::Number, Part::Number) => Some(Part::Number),
                (Part::Unit(unit), Part::Number) => Some(Part::Unit(Expr::new(
                    ExprKind::Pow {
                        left: Box::new(unit),
                        right: right.clone(),
                    },
                    expr.span,
                ))),
                _ => None,
            },
            _ => None,
        }
    }
    match part(expr)? {
        Part::Unit(unit) => Some(unit),
        Part::Number => None,
    }
}

/// The text of a unit expression with every plain name labelled `@unit`.
/// A unit context that the model turns into generated math — a table
/// column's unit, which multiplies the column vector — is a value position, so its names need the
/// label to keep the unit they mean. `None` when `text` is not one expression of the grammar.
pub fn labelled_unit_text(text: &str) -> Option<String> {
    fn label(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                if object.get("type").and_then(serde_json::Value::as_str) == Some("Ident") {
                    if let Some(serde_json::Value::Object(name)) = object.get_mut("name") {
                        let plain = name.get("label").is_none_or(serde_json::Value::is_null);
                        if plain {
                            name.insert(
                                "label".to_owned(),
                                serde_json::Value::String("unit".to_owned()),
                            );
                        }
                    }
                }
                for value in object.values_mut() {
                    label(value);
                }
            }
            serde_json::Value::Array(values) => values.iter_mut().for_each(label),
            _ => {}
        }
    }
    let expr = crate::parse_expression(text).ok()?;
    let mut value = serde_json::to_value(&expr).ok()?;
    label(&mut value);
    let expr: crate::ast::Expr = serde_json::from_value(value).ok()?;
    Some(crate::syntax::print_expression(&expr))
}

/// All unit names, sorted (EqRuntime's `eq_unit_names()` returns the same list).
pub fn unit_names() -> Vec<String> {
    let mut names: Vec<String> = table().names.keys().cloned().collect();
    names.sort();
    names
}

// ---------------------------------------------------------------------------------------
// The format migration of
// ---------------------------------------------------------------------------------------

/// Labels every unit name of `statement` that stands in a **value position**, unless the name is
/// `defined` or a local binding of `statement`.
///
/// Version 2 read a plain name of the unit table as a unit in a value position unless a definition of
/// the same spelling was visible. The step makes the old meaning explicit,
/// so it labels exactly the names version 2 resolved to a unit: a name that any definition of the file
/// can capture — a definition target, a function name, a parameter or local binding of the statement, a
/// range/`for`/sum binder — keeps its plain text and reads as that definition in version 3 too. Unit
/// contexts (the unit override of an evaluation) are left untouched: a plain name is a unit there.
pub fn label_value_units(statement: &mut Statement, defined: &HashSet<String>) {
    let mut bound = HashSet::default();
    collect_bound_names(statement, &mut bound);
    label_statement(
        statement,
        &LabelCtx {
            defined,
            bound: &bound,
            rebind: None,
        },
    );
}

/// What a relabelling walk needs: the names a definition can capture, the names the statement binds, and,
/// in the importer's variable mode, the spellings the file defines as explicit variables.
struct LabelCtx<'a> {
    defined: &'a HashSet<String>,
    bound: &'a HashSet<String>,
    /// `Some`: do not label any name as a unit; a plain unit-table name in this set is the explicit
    /// variable of that spelling.
    rebind: Option<&'a HashSet<String>>,
}

/// Importer, the specification : a plain name of the unit table in a value position is not a unit (the reference application
/// draws it as a name unless it carries the unit label), but when the worksheet defines the same spelling
/// as an explicit variable (`L@var`) it is that variable, as the reference application resolves a name by its spelling. Unit
/// contexts are untouched.
pub fn rebind_plain_names_to_variables(statement: &mut Statement, variables: &HashSet<String>) {
    let mut bound = HashSet::default();
    collect_bound_names(statement, &mut bound);
    let defined = HashSet::default();
    label_statement(
        statement,
        &LabelCtx {
            defined: &defined,
            bound: &bound,
            rebind: Some(variables),
        },
    );
}

/// A name is a unit only as a single unlabelled segment (`m`, `kN`): a subscripted name, a dotted
/// name or a name that already carries a label is never touched by the migration.
fn plain_unlabelled(name: &Name) -> Option<&str> {
    match name.segments.as_slice() {
        [segment] if !segment.subscript && name.label.is_none() => Some(&segment.text),
        _ => None,
    }
}

fn label_name(name: &mut Name, ctx: &LabelCtx) {
    let Some(text) = plain_unlabelled(name).map(str::to_owned) else {
        return;
    };
    if !is_unit(&text) || ctx.bound.contains(&text) {
        return;
    }
    match ctx.rebind {
        Some(variables) => {
            if variables.contains(&text) {
                name.label = Some(Label::Var);
            }
        }
        None => {
            if !ctx.defined.contains(&text) {
                name.label = Some(Label::Unit);
            }
        }
    }
}

/// The names a statement defines or binds: definition targets, function names, parameters, program
/// locals and loop variables, and the variable of every binder: a plain name
/// that one of them can capture is not the unit of that spelling.
pub fn definition_names(statement: &Statement, out: &mut HashSet<String>) {
    collect_bound_names(statement, out)
}

/// The names the statement binds: definition targets, function names, parameters, program locals and
/// loop variables, and the variable of every binder. Collected once, for the whole statement.
fn collect_bound_names(statement: &Statement, out: &mut HashSet<String>) {
    let mut exprs: Vec<&Expr> = Vec::new();
    let mut targets: Vec<&Target> = Vec::new();
    let mut statements: Vec<&Statement> = vec![statement];
    while let Some(statement) = statements.pop() {
        match &statement.kind {
            StatementKind::Define { target, rhs, .. }
            | StatementKind::GlobalDefine { target, rhs } => {
                targets.push(target);
                exprs.push(rhs);
            }
            StatementKind::Evaluate { expr, .. }
            | StatementKind::Symbolic { expr, .. }
            | StatementKind::ExprRegion { expr } => exprs.push(expr),
            StatementKind::Table { .. } => {}
            StatementKind::Solve { constraints, call } => {
                exprs.extend(constraints.iter());
                statements.push(call);
            }
            StatementKind::Julia { .. } => {}
        }
    }
    while let Some(target) = targets.pop() {
        collect_target_names(target, out);
    }
    while let Some(expr) = exprs.pop() {
        collect_expr_names(expr, out);
    }
}

fn collect_target_names(target: &Target, out: &mut HashSet<String>) {
    match &target.kind {
        TargetKind::Invalid { .. } => {}
        TargetKind::Ident { name } => {
            if let Some(text) = plain_unlabelled(name) {
                out.insert(text.to_owned());
            }
        }
        TargetKind::FunctionHead { name, params } => {
            if let Some(text) = plain_unlabelled(&name.name) {
                out.insert(text.to_owned());
            }
            for param in params {
                if let Some(text) = plain_unlabelled(&param.name) {
                    out.insert(text.to_owned());
                }
            }
        }
        TargetKind::Destructure { cells, .. } => {
            for cell in cells {
                collect_target_names(cell, out);
            }
        }
        TargetKind::Index { base, .. }
        | TargetKind::Column { base, .. }
        | TargetKind::Row { base, .. }
        | TargetKind::Paren { target: base }
        | TargetKind::Transpose { target: base } => collect_target_names(base, out),
    }
}

/// The names a statement or an expression binds anywhere inside it.
fn collect_expr_names(expr: &Expr, out: &mut HashSet<String>) {
    let mut stack: Vec<&Expr> = vec![expr];
    while let Some(expr) = stack.pop() {
        let binder = |ident: &Ident, out: &mut HashSet<String>| {
            if let Some(text) = plain_unlabelled(&ident.name) {
                out.insert(text.to_owned());
            }
        };
        match &expr.kind {
            ExprKind::Ident { .. }
            | ExprKind::Num { .. }
            | ExprKind::Imag { .. }
            | ExprKind::Str { .. }
            | ExprKind::Placeholder
            | ExprKind::EllipsisCell { .. } => {}
            ExprKind::Sum {
                var,
                index,
                bounds,
                body,
            }
            | ExprKind::Prod {
                var,
                index,
                bounds,
                body,
            } => {
                binder(var, out);
                stack.push(body);
                if let Some(index) = index {
                    stack.push(index);
                }
                if let Some(bounds) = bounds {
                    stack.push(&bounds.lo);
                    stack.push(&bounds.hi);
                }
            }
            ExprKind::Integral {
                var, bounds, body, ..
            } => {
                binder(var, out);
                stack.push(body);
                if let Some(bounds) = bounds {
                    stack.push(&bounds.lo);
                    stack.push(&bounds.hi);
                }
            }
            ExprKind::Gradient { vars, body } => {
                for var in vars {
                    binder(var, out);
                }
                stack.push(body);
            }
            ExprKind::Deriv { var, order, body } | ExprKind::Partial { var, order, body } => {
                binder(var, out);
                stack.push(body);
                if let Some(order) = order {
                    stack.push(order);
                }
            }
            ExprKind::Limit {
                var, target, body, ..
            } => {
                binder(var, out);
                stack.push(target);
                stack.push(body);
            }
            ExprKind::Program { body } => collect_program_names(body, out),
            ExprKind::Matrix { cells, .. } => stack.extend(cells.iter()),
            ExprKind::JuliaCall { args, .. } => {
                for arg in args {
                    match arg {
                        Arg::Expr { expr } => stack.push(expr),
                        Arg::InlineDef { target, value, .. } => {
                            collect_target_names(target, out);
                            stack.push(value);
                        }
                    }
                }
            }
            ExprKind::Call { callee, args } => {
                stack.push(callee);
                for arg in args {
                    match arg {
                        Arg::Expr { expr } => stack.push(expr),
                        Arg::InlineDef { target, value, .. } => {
                            collect_target_names(target, out);
                            stack.push(value);
                        }
                    }
                }
            }
            ExprKind::InlineDef { target, value } => {
                collect_target_names(target, out);
                stack.push(value);
            }
            ExprKind::Index { base, indices } => {
                stack.push(base);
                stack.extend(indices.iter());
            }
            ExprKind::Range {
                first,
                second,
                last,
            } => {
                stack.push(first);
                stack.push(last);
                if let Some(second) = second {
                    stack.push(second);
                }
            }
            other => stack.extend(children(other)),
        }
    }
}

fn collect_program_names(body: &[Stmt], out: &mut HashSet<String>) {
    let mut statements: Vec<&Stmt> = body.iter().collect();
    let mut exprs: Vec<&Expr> = Vec::new();
    while let Some(statement) = statements.pop() {
        match &statement.kind {
            StmtKind::LocalDef { target, rhs } => {
                collect_target_names(target, out);
                exprs.push(rhs);
            }
            StmtKind::If {
                branches,
                else_body,
            } => {
                for branch in branches {
                    exprs.push(&branch.cond);
                    statements.extend(branch.body.iter());
                }
                if let Some(else_body) = else_body {
                    statements.extend(else_body.iter());
                }
            }
            StmtKind::For { var, source, body } => {
                if let Some(text) = plain_unlabelled(&var.name) {
                    out.insert(text.to_owned());
                }
                exprs.push(source);
                statements.extend(body.iter());
            }
            StmtKind::While { cond, body } => {
                exprs.push(cond);
                statements.extend(body.iter());
            }
            StmtKind::Return { expr } | StmtKind::ExprStmt { expr } => exprs.push(expr),
            StmtKind::Break | StmtKind::Continue => {}
            StmtKind::Try { body, handler } => {
                statements.extend(body.iter());
                statements.extend(handler.iter());
            }
        }
    }
    while let Some(expr) = exprs.pop() {
        collect_expr_names(expr, out);
    }
}

/// The sub-expressions of a node whose children are all value positions.
pub(crate) fn children(expr: &ExprKind) -> Vec<&Expr> {
    let mut out: Vec<&Expr> = Vec::new();
    match expr {
        ExprKind::Paren { expr }
        | ExprKind::Neg { expr }
        | ExprKind::Not { expr }
        | ExprKind::Factorial { expr }
        | ExprKind::Percent { expr }
        | ExprKind::Permille { expr }
        | ExprKind::Transpose { expr }
        | ExprKind::Conj { expr }
        | ExprKind::RealPart { expr }
        | ExprKind::ImagPart { expr }
        | ExprKind::Abs { expr }
        | ExprKind::Det { expr }
        | ExprKind::Norm { expr }
        | ExprKind::Vectorize { expr }
        | ExprKind::PrimeDeriv { function: expr, .. } => out.push(expr),
        ExprKind::Add { left, right, .. }
        | ExprKind::Sub { left, right, .. }
        | ExprKind::Mul { left, right, .. }
        | ExprKind::InlineDiv { left, right, .. }
        | ExprKind::Juxt { left, right }
        | ExprKind::Cross { left, right }
        | ExprKind::Conv { left, right }
        | ExprKind::CircConv { left, right }
        | ExprKind::Polar { left, right }
        | ExprKind::Div { left, right }
        | ExprKind::Pow { left, right }
        | ExprKind::Eq { left, right }
        | ExprKind::Ne { left, right }
        | ExprKind::Lt { left, right }
        | ExprKind::Gt { left, right }
        | ExprKind::Le { left, right }
        | ExprKind::Ge { left, right }
        | ExprKind::In { left, right }
        | ExprKind::And { left, right }
        | ExprKind::Or { left, right }
        | ExprKind::Xor { left, right }
        | ExprKind::Gap { left, right }
        | ExprKind::Column {
            base: left,
            index: right,
        }
        | ExprKind::Row {
            base: left,
            index: right,
        } => {
            out.push(left);
            out.push(right);
        }
        ExprKind::Root { index, radicand } => {
            if let Some(index) = index {
                out.push(index);
            }
            out.push(radicand);
        }
        _ => {}
    }
    out
}

fn label_statement(statement: &mut Statement, ctx: &LabelCtx) {
    match &mut statement.kind {
        StatementKind::Define { target, rhs, tail } => {
            label_target_indices(target, ctx);
            label_expr(rhs, ctx);
            if let Some(Tail::Sym { keywords }) = tail {
                for group in keywords {
                    for arg in &mut group.args {
                        label_expr(arg, ctx);
                    }
                }
            }
            // `Tail::Eval { unit }` is a unit context: a plain name is a unit there already.
        }
        StatementKind::GlobalDefine { target, rhs } => {
            label_target_indices(target, ctx);
            label_expr(rhs, ctx);
        }
        StatementKind::Evaluate { expr, .. } => label_expr(expr, ctx),
        StatementKind::Symbolic { expr, keywords } => {
            label_expr(expr, ctx);
            for group in keywords {
                for arg in &mut group.args {
                    label_expr(arg, ctx);
                }
            }
        }
        StatementKind::ExprRegion { expr } => label_expr(expr, ctx),
        // The values are value positions; the names are names and the units a unit context
        //, labelled where the columns are defined.
        StatementKind::Table { units, grid } => {
            if let ExprKind::Matrix { cols, cells, .. } = &mut grid.kind {
                let skip = *cols * if *units { 2 } else { 1 };
                for cell in cells.iter_mut().skip(skip) {
                    label_expr(cell, ctx);
                }
            }
        }
        StatementKind::Solve { constraints, call } => {
            for constraint in constraints {
                label_expr(constraint, ctx);
            }
            label_statement(call, ctx);
        }
        StatementKind::Julia { .. } => {}
    }
}

/// The index expressions of a target are value positions; the names of the target are not.
fn label_target_indices(target: &mut Target, ctx: &LabelCtx) {
    match &mut target.kind {
        TargetKind::Ident { .. } | TargetKind::FunctionHead { .. } | TargetKind::Invalid { .. } => {
        }
        TargetKind::Destructure { cells, .. } => {
            for cell in cells {
                label_target_indices(cell, ctx);
            }
        }
        TargetKind::Index { base, indices } => {
            label_target_indices(base, ctx);
            for index in indices {
                label_expr(index, ctx);
            }
        }
        TargetKind::Column { base, index } | TargetKind::Row { base, index } => {
            label_target_indices(base, ctx);
            label_expr(index, ctx);
        }
        TargetKind::Paren { target } | TargetKind::Transpose { target } => {
            label_target_indices(target, ctx)
        }
    }
}

fn label_expr(expr: &mut Expr, ctx: &LabelCtx) {
    match &mut expr.kind {
        ExprKind::Ident { name } => label_name(name, ctx),
        ExprKind::Sum {
            var,
            index,
            bounds,
            body,
        }
        | ExprKind::Prod {
            var,
            index,
            bounds,
            body,
        } => {
            if let Some(index) = index {
                label_expr(index, ctx);
            }
            if let Some(bounds) = bounds {
                label_expr(&mut bounds.lo, ctx);
                label_expr(&mut bounds.hi, ctx);
            }
            label_expr(body, ctx);
            let _ = var;
        }
        ExprKind::Integral { bounds, body, .. } => {
            if let Some(bounds) = bounds {
                label_expr(&mut bounds.lo, ctx);
                label_expr(&mut bounds.hi, ctx);
            }
            label_expr(body, ctx);
        }
        ExprKind::Gradient { body, .. } => label_expr(body, ctx),
        ExprKind::Deriv { order, body, .. } | ExprKind::Partial { order, body, .. } => {
            if let Some(order) = order {
                label_expr(order, ctx);
            }
            label_expr(body, ctx);
        }
        ExprKind::Limit { target, body, .. } => {
            label_expr(target, ctx);
            label_expr(body, ctx);
        }
        ExprKind::Program { body } => label_program(body, ctx),
        ExprKind::Matrix { cells, .. } => {
            for cell in cells {
                label_expr(cell, ctx);
            }
        }
        ExprKind::Call { callee, args } => {
            // A callee is a function, never a unit (version 2 resolved a called name as a function
            // first): `g(x)` keeps a plain `g`; only a callee that is itself an expression (an
            // element `F[i](x)`) is walked.
            if !matches!(callee.kind, ExprKind::Ident { .. }) {
                label_expr(callee, ctx);
            }
            for arg in args {
                match arg {
                    Arg::Expr { expr } => label_expr(expr, ctx),
                    Arg::InlineDef { target, value, .. } => {
                        label_target_indices(target, ctx);
                        label_expr(value, ctx);
                    }
                }
            }
        }
        ExprKind::InlineDef { target, value } => {
            label_target_indices(target, ctx);
            label_expr(value, ctx);
        }
        ExprKind::Index { base, indices } => {
            label_expr(base, ctx);
            for index in indices {
                label_expr(index, ctx);
            }
        }
        ExprKind::JuliaCall { args, .. } => {
            for arg in args {
                match arg {
                    Arg::Expr { expr } => label_expr(expr, ctx),
                    Arg::InlineDef { target, value, .. } => {
                        label_target_indices(target, ctx);
                        label_expr(value, ctx);
                    }
                }
            }
        }
        ExprKind::Range {
            first,
            second,
            last,
        } => {
            label_expr(first, ctx);
            if let Some(second) = second {
                label_expr(second, ctx);
            }
            label_expr(last, ctx);
        }
        other => {
            let mut pairs: Vec<(&mut Expr, &mut Expr)> = Vec::new();
            let mut singles: Vec<&mut Expr> = Vec::new();
            match other {
                ExprKind::Paren { expr }
                | ExprKind::Neg { expr }
                | ExprKind::Not { expr }
                | ExprKind::Factorial { expr }
                | ExprKind::Percent { expr }
                | ExprKind::Permille { expr }
                | ExprKind::Transpose { expr }
                | ExprKind::Conj { expr }
                | ExprKind::RealPart { expr }
                | ExprKind::ImagPart { expr }
                | ExprKind::Abs { expr }
                | ExprKind::Det { expr }
                | ExprKind::Norm { expr }
                | ExprKind::Vectorize { expr }
                | ExprKind::PrimeDeriv { function: expr, .. } => singles.push(expr),
                ExprKind::Root { index, radicand } => {
                    if let Some(index) = index {
                        singles.push(index);
                    }
                    singles.push(radicand);
                }
                ExprKind::Add { left, right, .. }
                | ExprKind::Sub { left, right, .. }
                | ExprKind::Mul { left, right, .. }
                | ExprKind::InlineDiv { left, right, .. }
                | ExprKind::Juxt { left, right }
                | ExprKind::Cross { left, right }
                | ExprKind::Conv { left, right }
                | ExprKind::CircConv { left, right }
                | ExprKind::Polar { left, right }
                | ExprKind::Div { left, right }
                | ExprKind::Pow { left, right }
                | ExprKind::Eq { left, right }
                | ExprKind::Ne { left, right }
                | ExprKind::Lt { left, right }
                | ExprKind::Gt { left, right }
                | ExprKind::Le { left, right }
                | ExprKind::Ge { left, right }
                | ExprKind::In { left, right }
                | ExprKind::And { left, right }
                | ExprKind::Or { left, right }
                | ExprKind::Xor { left, right }
                | ExprKind::Gap { left, right }
                | ExprKind::Column {
                    base: left,
                    index: right,
                }
                | ExprKind::Row {
                    base: left,
                    index: right,
                } => pairs.push((left, right)),
                _ => {}
            }
            for (left, right) in pairs {
                label_expr(left, ctx);
                label_expr(right, ctx);
            }
            for single in singles {
                label_expr(single, ctx);
            }
        }
    }
}

fn label_program(body: &mut [Stmt], ctx: &LabelCtx) {
    for statement in body.iter_mut() {
        match &mut statement.kind {
            StmtKind::LocalDef { target, rhs } => {
                label_target_indices(target, ctx);
                label_expr(rhs, ctx);
            }
            StmtKind::If {
                branches,
                else_body,
            } => {
                for branch in branches.iter_mut() {
                    label_expr(&mut branch.cond, ctx);
                    label_program(&mut branch.body, ctx);
                }
                if let Some(else_body) = else_body {
                    label_program(else_body, ctx);
                }
            }
            StmtKind::For { source, body, .. } => {
                label_expr(source, ctx);
                label_program(body, ctx);
            }
            StmtKind::While { cond, body } => {
                label_expr(cond, ctx);
                label_program(body, ctx);
            }
            StmtKind::Return { expr } | StmtKind::ExprStmt { expr } => label_expr(expr, ctx),
            StmtKind::Break | StmtKind::Continue => {}
            StmtKind::Try { body, handler } => {
                label_program(body, ctx);
                label_program(handler, ctx);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corpus_units_are_known() {
        for name in [
            "m", "s", "kg", "kW", "K", "J", "ft", "deg", "km", "hr", "newton",
        ] {
            assert!(is_unit(name), "{name}");
        }
        assert_eq!(unit_exponents("km"), Some([1, 0, 0, 0, 0, 0, 0]));
        assert_eq!(unit_exponents("newton"), Some([1, 1, -2, 0, 0, 0, 0]));
        assert_eq!(unit_exponents("kWh"), Some([2, 1, -2, 0, 0, 0, 0]));
        assert_eq!(unit_exponents("deg"), Some([0; 7]));
    }

    #[test]
    fn plain_names_beat_prefix_readings_and_variables_are_not_units() {
        assert_eq!(unit_exponents("min"), Some([0, 0, 1, 0, 0, 0, 0]));
        assert_eq!(unit_exponents("mi"), Some([1, 0, 0, 0, 0, 0, 0]));
        // constants and ordinary variable names are not units
        for name in ["x", "h", "e", "c", "R", "foo", "kx"] {
            assert!(!is_unit(name), "{name}");
        }
    }

    /// The migration of labels a unit of a value position, and leaves every name a definition
    /// can capture — and every unit context — as it is.
    #[test]
    fn the_migration_labels_value_units_only() {
        fn migrated(text: &str, defined: &[&str]) -> String {
            let mut set = HashSet::default();
            for name in defined {
                set.insert((*name).to_owned());
            }
            let mut statement = crate::parse_statement(text).unwrap();
            label_value_units(&mut statement, &set);
            crate::syntax::print_statement(&statement)
        }
        // a value position is labelled, a labelled name stays as it is
        assert_eq!(migrated("x := 3.5 m", &[]), "x := 3.5 m@unit");
        assert_eq!(
            migrated("f := 2 kN·m/s^2", &[]),
            "f := 2 kN@unit·m@unit/s@unit^2"
        );
        assert_eq!(migrated("y := 2 L@unit", &[]), "y := 2 L@unit");
        // the unit override of an evaluation is a unit context
        assert_eq!(migrated("x = … m/s", &[]), "x = … m/s");
        // a definition of the file, a parameter, a program local and a binder capture their name
        assert_eq!(migrated("y := 2 m", &["m"]), "y := 2 m");
        assert_eq!(migrated("f(m) := 2·m", &[]), "f(m) := 2·m");
        assert_eq!(
            migrated("g(m) := program { m ← 3; 2·m }", &[]),
            "g(m) := program\n  m ← 3\n  2·m"
        );
        assert_eq!(migrated("∑[s ∈ 1..3] 2 s", &[]), "∑[s ∈ 1..3] 2 s");
        // a definition target is a name, its index is a value position, and so is an argument
        assert_eq!(migrated("v[2 s] := 3 m", &[]), "v[2 s@unit] := 3 m@unit");
        assert_eq!(migrated("h((s ← 3), 2 s)", &[]), "h((s ← 3), 2 s)");
        // an operand after the definition reads the local, so the name is left plain
        assert_eq!(migrated("k := 2 s + (s ← 3)", &[]), "k := 2 s + (s ← 3)");
        // a compiler-chosen name cannot stand for a unit: only the table decides that
        assert_eq!(migrated("x := 2 foo", &[]), "x := 2 foo");
    }

    /// The fixture is written by EqRuntime (`eq_unit_names()`); the Julia test compares
    /// the same file, so a change to `units.tsv` that one side reads differently fails.
    /// Regenerate with: `julia --project=kernel/EqRuntime -e 'using EqRuntime;
    /// write("the specification", join(eq_unit_names(), "\n") * "\n")'`.
    #[test]
    fn the_name_list_matches_eqruntime() {
        let fixture = include_str!("../fixtures/unit-names.txt");
        let expected: Vec<&str> = fixture.lines().collect();
        let names = unit_names();
        assert!(names.len() > 300);
        assert_eq!(
            names.iter().map(String::as_str).collect::<Vec<_>>(),
            expected
        );
    }
}
