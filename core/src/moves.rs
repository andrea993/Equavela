//! Copy elision for the local assignments of a program.
//!
//! the reference application assigns by value, so the generator copies an array on `x ← y` (`eq_val`). A program
//! that swaps buffers (`t ← a`, `a ← b`, `b ← t`) then copies the whole array three times per
//! pass. The copy is not observable when the source `y` is never read again before it is
//! assigned anew: the two names then never hold the same array at the same time. This module
//! finds those assignments with a liveness analysis over the statements of one program.
//!
//! The analysis is deliberately narrow, so that dropping the copy cannot change a result:
//!
//! - only `x ← y` with both plain local names, `y` not a parameter and not the variable of a
//!   `for`, and every assignment to `y` itself a plain `y ← name` copy (so `y` always owns its
//!   array and no other name shares it);
//! - `y` occurs only as the base of an index (`y[i]`, `y[i] ← e`), as the whole right side of such
//!   a copy or as a bare final value, never as an argument, an operand or inside a closure, so no
//!   function result can alias it;
//! - programs with a `try`, a local function or a destructuring definition are not analysed.

use std::collections::{HashMap, HashSet};

use crate::ast::{Arg, Expr, ExprKind, Stmt, StmtKind, Target, TargetKind};
use crate::syntax::print_name;

/// The addresses of the `LocalDef` statements of `body` whose copy can be dropped.
pub(crate) fn elidable_copies(body: &[Stmt], params: &[String]) -> HashSet<usize> {
    let mut analysis = Analysis::default();
    if !analysis.collect(body) || analysis.unsupported {
        return HashSet::new();
    }
    let owned = analysis.owned(params);
    if owned.is_empty() {
        return HashSet::new();
    }
    let mut moves = HashSet::new();
    let mut live = HashSet::new();
    block_live(body, &mut live, &Loops::default(), &owned, Some(&mut moves));
    moves
}

#[derive(Default)]
struct Analysis {
    unsupported: bool,
    /// Assignments of each plain local: `Some(source)` for `x ← source`, `None` for anything else.
    assignments: HashMap<String, Vec<Option<String>>>,
    /// Occurrences of each name, and those that are safe (index bases, copies, final values).
    occurrences: HashMap<String, usize>,
    safe: HashMap<String, usize>,
    loop_vars: HashSet<String>,
}

fn name_of(expr: &Expr) -> Option<String> {
    match &expr.kind {
        ExprKind::Ident { name } => Some(print_name(name)),
        _ => None,
    }
}

fn target_name(target: &Target) -> Option<String> {
    match &target.kind {
        TargetKind::Ident { name } => Some(print_name(name)),
        _ => None,
    }
}

/// The root name of an index target `b[k][j]`.
fn indexed_root(target: &Target) -> Option<String> {
    match &target.kind {
        TargetKind::Index { base, .. } => match &base.kind {
            TargetKind::Ident { name } => Some(print_name(name)),
            _ => indexed_root(base),
        },
        _ => None,
    }
}

fn indices_of(target: &Target, out: &mut Vec<Expr>) {
    if let TargetKind::Index { base, indices } = &target.kind {
        out.extend(indices.iter().cloned());
        indices_of(base, out);
    }
}

impl Analysis {
    /// Returns false when a statement is outside what the analysis understands.
    fn collect(&mut self, body: &[Stmt]) -> bool {
        for statement in body {
            match &statement.kind {
                StmtKind::LocalDef { target, rhs } => match &target.kind {
                    TargetKind::Ident { .. } => {
                        let name = target_name(target).unwrap_or_default();
                        let source = name_of(rhs);
                        self.assignments
                            .entry(name)
                            .or_default()
                            .push(source.clone());
                        match source {
                            // The whole right side of a copy is a safe occurrence.
                            Some(source) => {
                                *self.occurrences.entry(source.clone()).or_default() += 1;
                                *self.safe.entry(source).or_default() += 1;
                            }
                            None => self.count(rhs),
                        }
                    }
                    TargetKind::Index { .. } => {
                        let Some(root) = indexed_root(target) else {
                            return false;
                        };
                        // `b[k] ← e` reads and writes `b` in place: a safe occurrence.
                        *self.occurrences.entry(root.clone()).or_default() += 1;
                        *self.safe.entry(root).or_default() += 1;
                        let mut indices = Vec::new();
                        indices_of(target, &mut indices);
                        for index in &indices {
                            self.count(index);
                        }
                        self.count(rhs);
                    }
                    _ => return false,
                },
                StmtKind::If {
                    branches,
                    else_body,
                } => {
                    for branch in branches {
                        self.count(&branch.cond);
                        if !self.collect(&branch.body) {
                            return false;
                        }
                    }
                    if let Some(else_body) = else_body {
                        if !self.collect(else_body) {
                            return false;
                        }
                    }
                }
                StmtKind::For { var, source, body } => {
                    self.loop_vars.insert(print_name(&var.name));
                    self.count(source);
                    if !self.collect(body) {
                        return false;
                    }
                }
                StmtKind::While { cond, body } => {
                    self.count(cond);
                    if !self.collect(body) {
                        return false;
                    }
                }
                StmtKind::Return { expr } | StmtKind::ExprStmt { expr } => {
                    match name_of(expr) {
                        // A bare final value hands the array out of the program.
                        Some(name) => {
                            *self.occurrences.entry(name.clone()).or_default() += 1;
                            *self.safe.entry(name).or_default() += 1;
                        }
                        None => self.count(expr),
                    }
                }
                StmtKind::Break | StmtKind::Continue => {}
                StmtKind::Try { .. } => return false,
            }
        }
        true
    }

    /// Counts every occurrence of a name in `expr`, and the index bases among them.
    fn count(&mut self, expr: &Expr) {
        for name in crate::graph::expr_name_occurrences(expr) {
            *self.occurrences.entry(print_name(&name)).or_default() += 1;
        }
        self.count_bases(expr);
    }

    fn count_bases(&mut self, expr: &Expr) {
        match &expr.kind {
            ExprKind::Index { base, indices } => {
                if let Some(name) = name_of(base) {
                    *self.safe.entry(name).or_default() += 1;
                } else {
                    self.count_bases(base);
                }
                for index in indices {
                    self.count_bases(index);
                }
            }
            ExprKind::Call { args, .. } => {
                for arg in args {
                    if let Arg::Expr { expr } = arg {
                        self.count_bases(expr);
                    }
                }
            }
            ExprKind::Matrix { cells, .. } => {
                for cell in cells {
                    self.count_bases(cell);
                }
            }
            other => {
                for child in crate::units::children(other) {
                    self.count_bases(child);
                }
            }
        }
    }

    /// The locals that own their array: assigned only by plain copies, never a parameter or loop
    /// variable, and used only in the safe positions.
    fn owned(&self, params: &[String]) -> HashSet<String> {
        self.assignments
            .iter()
            .filter(|(name, sources)| {
                !params.contains(name)
                    && !self.loop_vars.contains(*name)
                    && sources.iter().all(Option::is_some)
                    && self.occurrences.get(*name).copied().unwrap_or(0)
                        == self.safe.get(*name).copied().unwrap_or(0)
            })
            .map(|(name, _)| name.clone())
            .collect()
    }
}

/// Where a `break` and a `continue` go: the names live after the loop and at its head.
#[derive(Default, Clone)]
struct Loops {
    on_break: HashSet<String>,
    on_continue: HashSet<String>,
}

fn reads(expr: &Expr, live: &mut HashSet<String>) {
    for name in crate::graph::expr_name_occurrences(expr) {
        live.insert(print_name(&name));
    }
}

/// Backward liveness of a block: `live` holds the names live after it on entry and the names
/// live before it on return. With `moves`, records the copies whose source is dead.
fn block_live(
    body: &[Stmt],
    live: &mut HashSet<String>,
    loops: &Loops,
    owned: &HashSet<String>,
    mut moves: Option<&mut HashSet<usize>>,
) {
    for statement in body.iter().rev() {
        match &statement.kind {
            StmtKind::LocalDef { target, rhs } => match &target.kind {
                TargetKind::Ident { .. } => {
                    let name = target_name(target).unwrap_or_default();
                    if let (Some(moves), Some(source)) = (moves.as_deref_mut(), name_of(rhs)) {
                        if source != name && owned.contains(&source) && !live.contains(&source) {
                            moves.insert(statement as *const Stmt as usize);
                        }
                    }
                    live.remove(&name);
                    reads(rhs, live);
                }
                _ => {
                    // `b[k] ← e`: the array is read and written; nothing is killed.
                    if let Some(root) = indexed_root(target) {
                        live.insert(root);
                    }
                    let mut indices = Vec::new();
                    indices_of(target, &mut indices);
                    for index in &indices {
                        reads(index, live);
                    }
                    reads(rhs, live);
                }
            },
            StmtKind::If {
                branches,
                else_body,
            } => {
                let after = live.clone();
                let mut result: HashSet<String> = if else_body.is_none() {
                    after.clone()
                } else {
                    HashSet::new()
                };
                for branch in branches {
                    let mut inner = after.clone();
                    block_live(&branch.body, &mut inner, loops, owned, moves.as_deref_mut());
                    result.extend(inner);
                    reads(&branch.cond, &mut result);
                }
                if let Some(else_body) = else_body {
                    let mut inner = after;
                    block_live(else_body, &mut inner, loops, owned, moves.as_deref_mut());
                    result.extend(inner);
                }
                *live = result;
            }
            StmtKind::While { cond, body } => {
                let after = live.clone();
                let head = loop_head(&after, body, Some(cond), None, owned);
                let inner_loops = Loops {
                    on_break: after,
                    on_continue: head.clone(),
                };
                let mut inner = head.clone();
                block_live(body, &mut inner, &inner_loops, owned, moves.as_deref_mut());
                *live = head;
            }
            StmtKind::For { var, source, body } => {
                let after = live.clone();
                let variable = print_name(&var.name);
                let mut head = loop_head(&after, body, None, Some(&variable), owned);
                let inner_loops = Loops {
                    on_break: after,
                    on_continue: head.clone(),
                };
                let mut inner = head.clone();
                block_live(body, &mut inner, &inner_loops, owned, moves.as_deref_mut());
                reads(source, &mut head);
                *live = head;
            }
            StmtKind::Break => *live = loops.on_break.clone(),
            StmtKind::Continue => *live = loops.on_continue.clone(),
            StmtKind::Return { expr } => {
                live.clear();
                reads(expr, live);
            }
            StmtKind::ExprStmt { expr } => reads(expr, live),
            StmtKind::Try { .. } => {}
        }
    }
}

/// The names live at the head of a loop: the fixed point of "after the loop, or what the body
/// (and the condition) reads", with the loop variable assigned at each pass.
fn loop_head(
    after: &HashSet<String>,
    body: &[Stmt],
    cond: Option<&Expr>,
    variable: Option<&str>,
    owned: &HashSet<String>,
) -> HashSet<String> {
    let mut head = after.clone();
    if let Some(cond) = cond {
        reads(cond, &mut head);
    }
    loop {
        let loops = Loops {
            on_break: after.clone(),
            on_continue: head.clone(),
        };
        let mut inner = head.clone();
        block_live(body, &mut inner, &loops, owned, None);
        let mut next = after.clone();
        next.extend(inner);
        if let Some(cond) = cond {
            reads(cond, &mut next);
        }
        if let Some(variable) = variable {
            next.remove(variable);
        }
        if next == head {
            return head;
        }
        head = next;
    }
}
