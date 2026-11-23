//! Worksheet dependency analysis and incremental recalculation.
//!
//! Regions are ordered by page, top edge, left edge and id.
//! Each definition creates a distinct version of a name, so a use is
//! connected to the definition that was visible at that exact point. This is
//! the dependency half of the SSA transformation required by ; code generation
//! can use [`Definition::version`] for the eventual renamed symbol.
//!
//! Names that do not resolve to worksheet definitions are reported as
//! [`UnresolvedReference`] values rather than build errors. A later semantic pass must
//! classify those names as built-ins, constants, units, imported Julia functions or
//! genuine undefined-name errors.

use crate::ast::{
    Arg, Bounds, Expr, ExprKind, Label, Name, Segment, Span, Statement, StatementKind, Stmt,
    StmtKind, Tail, Target, TargetKind,
};
use crate::fasthash::{HashMap, HashSet};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;

/// A worksheet document at the phase-3 analysis boundary.
///
/// The YAML persistence model is deliberately deferred to phase 8. This serde form is
/// sufficient for the phase-3 JSON acceptance test and for the editor/core boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Worksheet {
    pub regions: Vec<Region>,
}

/// A positioned math region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub id: String,
    #[serde(default)]
    pub page: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// The statement, shared with the document region it came from: an edit that leaves this
    /// region alone copies no AST into the worksheet. Serializes as the `Statement`.
    pub statement: Arc<Statement>,
}

fn enabled_by_default() -> bool {
    true
}

impl Worksheet {
    /// Gathers the Given/Find blocks of the worksheet.
    ///
    /// The enabled regions are walked in reading order. A `Given` region opens a block (a
    /// second `Given` is an error on its own region), every bare-expression region after it is a
    /// constraint, and the first region that calls `Find`, `Minerr`, `Minimize` or `Maximize`
    /// closes it: its statement is wrapped into the assembled
    /// [`StatementKind::Solve`] together with the constraints. Nothing else changes, so the
    /// document keeps its flat regions and only the analysis sees the assembled form.
    /// Idempotent.
    pub fn assemble_solve_blocks(&mut self) {
        let mut order: Vec<usize> = (0..self.regions.len())
            .filter(|&index| self.regions[index].enabled)
            .collect();
        order.sort_by(|&a, &b| compare_regions(&self.regions[a], &self.regions[b]));
        let mut open: Option<Vec<Expr>> = None;
        for index in order {
            let statement = &self.regions[index].statement;
            if let StatementKind::Solve { call, .. } = &statement.kind {
                // An already assembled repeated `Given` leaves the open block alone.
                if !is_given_statement(call) {
                    open = None;
                }
                continue;
            }
            if is_given_statement(statement) {
                if open.is_some() {
                    // a `Given` while a block is open is an error on that region; the
                    // open block stays the first one.
                    let region = &mut self.regions[index];
                    let given = region.statement.clone();
                    region.statement = Arc::new(Statement {
                        span: given.span,
                        kind: StatementKind::Solve {
                            constraints: Vec::new(),
                            call: Box::new(Statement::clone(&given)),
                        },
                    });
                } else {
                    open = Some(Vec::new());
                }
                continue;
            }
            let Some(constraints) = open.as_mut() else {
                continue;
            };
            if calls_solving_function(statement) {
                let constraints = std::mem::take(constraints);
                open = None;
                let region = &mut self.regions[index];
                let call = std::mem::replace(
                    &mut region.statement,
                    Arc::new(Statement::synth(StatementKind::ExprRegion {
                        expr: Expr::synth(ExprKind::Placeholder),
                    })),
                );
                region.statement = Arc::new(Statement {
                    span: call.span,
                    kind: StatementKind::Solve {
                        constraints,
                        call: Box::new(Statement::clone(&call)),
                    },
                });
            } else if let StatementKind::ExprRegion { expr } = &statement.kind {
                constraints.push(expr.clone());
            }
        }
    }
}

/// Whether a statement is the `Given` keyword region: the bare name `Given`, in any case.
pub fn is_given_statement(statement: &Statement) -> bool {
    let StatementKind::ExprRegion { expr } = &statement.kind else {
        return false;
    };
    matches!(
        &expr.kind,
        ExprKind::Ident { name }
            if name.label.is_none()
                && crate::syntax::print_name(name).eq_ignore_ascii_case("given")
    )
}

/// Whether a statement contains a call of `Find`, `Minerr`, `Minimize` or `Maximize`.
pub fn calls_solving_function(statement: &Statement) -> bool {
    let mut occurrences = Vec::new();
    collect_statement_references(statement, &mut occurrences);
    occurrences
        .iter()
        .any(|occurrence| is_solving_function(&occurrence.name))
}

/// Whether a definition has worksheet-wide or ordinary forward visibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefinitionKind {
    Global,
    Ordinary,
}

/// One versioned name definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Definition {
    pub name: Name,
    /// The contextual label resolved by analysis.
    pub resolved_label: Label,
    pub region_id: String,
    /// One-based version number among definitions with the same canonical name.
    pub version: u32,
    pub kind: DefinitionKind,
}

/// A name occurrence that did not resolve to a worksheet definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnresolvedReference {
    pub region_id: String,
    pub name: Name,
    pub span: Span,
}

/// A name occurrence and the exact versioned worksheet definition it resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedReference {
    pub region_id: String,
    pub name: Name,
    pub span: Span,
    pub definition_region_id: String,
    pub definition_name: Name,
    pub definition_label: Label,
    pub definition_version: u32,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum GraphError {
    #[error("duplicate region id `{0}`")]
    DuplicateRegionId(String),
    #[error("region `{region_id}` has a non-finite {coordinate} coordinate")]
    NonFiniteCoordinate {
        region_id: String,
        coordinate: &'static str,
    },
    #[error("unknown region id `{0}`")]
    UnknownRegion(String),
}

#[derive(Debug, Clone, Copy)]
struct Binding {
    region: usize,
    definition: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct NameKey {
    segments: Vec<Segment>,
    label: Label,
}

impl NameKey {
    fn new(name: &Name, contextual_label: Label) -> NameKey {
        NameKey {
            segments: name.segments.clone(),
            label: name.label.unwrap_or(contextual_label),
        }
    }
}

/// An immutable dependency snapshot for one worksheet.
///
/// Rebuild the snapshot after an edit that changes region positions, definition targets,
/// enabled state or reference structure. Value-only changes can reuse it and call
/// [`DependencyGraph::affected_by`].
#[derive(Debug, Clone)]
pub struct DependencyGraph {
    region_ids: Vec<String>,
    by_id: HashMap<String, usize>,
    enabled: Vec<bool>,
    schedule: Vec<usize>,
    schedule_rank: Vec<Option<usize>>,
    dependencies: Vec<Vec<usize>>,
    dependents: Vec<Vec<usize>>,
    definitions: Vec<Definition>,
    resolved: Vec<ResolvedReference>,
    unresolved: Vec<UnresolvedReference>,
}

impl DependencyGraph {
    /// Analyses a worksheet and creates its stable evaluation schedule and edges.
    pub fn build(worksheet: &Worksheet) -> Result<Self, GraphError> {
        let count = worksheet.regions.len();
        let mut by_id = HashMap::with_capacity_and_hasher(count, Default::default());
        for (index, region) in worksheet.regions.iter().enumerate() {
            if !region.x.is_finite() {
                return Err(GraphError::NonFiniteCoordinate {
                    region_id: region.id.clone(),
                    coordinate: "x",
                });
            }
            if !region.y.is_finite() {
                return Err(GraphError::NonFiniteCoordinate {
                    region_id: region.id.clone(),
                    coordinate: "y",
                });
            }
            if by_id.insert(region.id.clone(), index).is_some() {
                return Err(GraphError::DuplicateRegionId(region.id.clone()));
            }
        }

        let mut visual_order: Vec<usize> = (0..count).collect();
        visual_order
            .sort_by(|&a, &b| compare_regions(&worksheet.regions[a], &worksheet.regions[b]));

        // Global definitions are evaluated before the ordinary top-down pass so that
        // they are visible above their displayed position. Within that pass they
        // retain visual order, which also constrains references between globals.
        let mut global_order = Vec::new();
        let mut ordinary_order = Vec::new();
        for &index in &visual_order {
            let region = &worksheet.regions[index];
            if !region.enabled {
                continue;
            }
            if matches!(region.statement.kind, StatementKind::GlobalDefine { .. }) {
                global_order.push(index);
            } else {
                ordinary_order.push(index);
            }
        }
        let schedule: Vec<usize> = global_order
            .iter()
            .chain(ordinary_order.iter())
            .copied()
            .collect();
        let mut schedule_rank = vec![None; count];
        for (rank, &index) in schedule.iter().enumerate() {
            schedule_rank[index] = Some(rank);
        }

        let mut dependency_sets = vec![HashSet::default(); count];
        let mut definitions = Vec::new();
        let mut resolved = Vec::new();
        let mut unresolved = Vec::new();
        let mut versions: HashMap<NameKey, u32> = HashMap::default();
        let mut globals: HashMap<NameKey, Binding> = HashMap::default();

        for &index in &global_order {
            let region = &worksheet.regions[index];
            analyse_region(
                region,
                index,
                &globals,
                &definitions,
                &mut dependency_sets[index],
                &mut resolved,
                &mut unresolved,
            );
            install_definitions(
                region,
                index,
                DefinitionKind::Global,
                &mut globals,
                &mut versions,
                &mut definitions,
            );
        }

        // Owner answer : globals form the initial environment and later ordinary
        // definitions replace them from their own position onward.
        let mut visible = globals;
        for &index in &ordinary_order {
            let region = &worksheet.regions[index];
            analyse_region(
                region,
                index,
                &visible,
                &definitions,
                &mut dependency_sets[index],
                &mut resolved,
                &mut unresolved,
            );
            install_definitions(
                region,
                index,
                DefinitionKind::Ordinary,
                &mut visible,
                &mut versions,
                &mut definitions,
            );
        }

        let mut dependencies = vec![Vec::new(); count];
        for index in 0..count {
            let mut edges: Vec<usize> = dependency_sets[index].drain().collect();
            edges.sort_by_key(|&dependency| schedule_rank[dependency].unwrap_or(usize::MAX));
            dependencies[index] = edges;
        }
        let mut dependents = vec![Vec::new(); count];
        for (consumer, producers) in dependencies.iter().enumerate() {
            for &producer in producers {
                dependents[producer].push(consumer);
            }
        }
        for edges in &mut dependents {
            edges.sort_by_key(|&dependent| schedule_rank[dependent].unwrap_or(usize::MAX));
        }

        Ok(DependencyGraph {
            region_ids: worksheet
                .regions
                .iter()
                .map(|region| region.id.clone())
                .collect(),
            by_id,
            enabled: worksheet
                .regions
                .iter()
                .map(|region| region.enabled)
                .collect(),
            schedule,
            schedule_rank,
            dependencies,
            dependents,
            definitions,
            resolved,
            unresolved,
        })
    }

    /// Enabled regions in the order in which they must be evaluated.
    pub fn evaluation_order(&self) -> Vec<String> {
        self.schedule
            .iter()
            .map(|&index| self.region_ids[index].clone())
            .collect()
    }

    /// Direct producer regions used by `region_id`, in evaluation order.
    pub fn dependencies_of(&self, region_id: &str) -> Option<Vec<String>> {
        let &index = self.by_id.get(region_id)?;
        Some(
            self.dependencies[index]
                .iter()
                .map(|&dependency| self.region_ids[dependency].clone())
                .collect(),
        )
    }

    /// Direct consumer regions of `region_id`, in evaluation order.
    pub fn dependents_of(&self, region_id: &str) -> Option<Vec<String>> {
        let &index = self.by_id.get(region_id)?;
        Some(
            self.dependents[index]
                .iter()
                .map(|&dependent| self.region_ids[dependent].clone())
                .collect(),
        )
    }

    /// Regions to recalculate after the supplied regions changed.
    ///
    /// The returned set includes each enabled changed region and all of its transitive
    /// consumers, sorted in evaluation order. Disabled regions produce no work.
    pub fn affected_by<I, S>(&self, region_ids: I) -> Result<Vec<String>, GraphError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut affected = vec![false; self.region_ids.len()];
        let mut queue = VecDeque::new();
        for region_id in region_ids {
            let region_id = region_id.as_ref();
            let Some(&index) = self.by_id.get(region_id) else {
                return Err(GraphError::UnknownRegion(region_id.to_owned()));
            };
            if self.enabled[index] && !affected[index] {
                affected[index] = true;
                queue.push_back(index);
            }
        }
        while let Some(index) = queue.pop_front() {
            for &dependent in &self.dependents[index] {
                if !affected[dependent] {
                    affected[dependent] = true;
                    queue.push_back(dependent);
                }
            }
        }
        Ok(self
            .schedule
            .iter()
            .copied()
            .filter(|&index| affected[index])
            .map(|index| self.region_ids[index].clone())
            .collect())
    }

    pub fn definitions(&self) -> &[Definition] {
        &self.definitions
    }

    pub fn unresolved_references(&self) -> &[UnresolvedReference] {
        &self.unresolved
    }

    pub fn resolved_references(&self) -> &[ResolvedReference] {
        &self.resolved
    }

    /// Evaluation rank of an enabled region; disabled regions have no rank.
    pub fn evaluation_rank(&self, region_id: &str) -> Option<usize> {
        let &index = self.by_id.get(region_id)?;
        self.schedule_rank[index]
    }
}

/// Host-side failure propagation.
///
/// The kernel leaves the names of a failed region undefined, so its dependents would
/// only report confusing undefined-name errors. A tracker records the failed regions of
/// one evaluation pass; [`FailureTracker::mark_blocked`] tells whether a region must not
/// be evaluated because a region it depends on failed. A blocked region is itself
/// recorded as failed, so the failure propagates transitively along the evaluation order.
#[derive(Debug, Clone)]
pub struct FailureTracker<'g> {
    graph: &'g DependencyGraph,
    failed: HashSet<usize>,
}

impl<'g> FailureTracker<'g> {
    pub fn new(graph: &'g DependencyGraph) -> Self {
        FailureTracker {
            graph,
            failed: HashSet::default(),
        }
    }

    /// Records that `region_id` failed (or was blocked). Unknown ids are an error.
    pub fn mark_failed(&mut self, region_id: &str) -> Result<(), GraphError> {
        let &index = self
            .graph
            .by_id
            .get(region_id)
            .ok_or_else(|| GraphError::UnknownRegion(region_id.to_owned()))?;
        self.failed.insert(index);
        Ok(())
    }

    pub fn is_failed(&self, region_id: &str) -> bool {
        self.graph
            .by_id
            .get(region_id)
            .is_some_and(|index| self.failed.contains(index))
    }

    /// The first (in evaluation order) failed direct producer of `region_id`, if any.
    /// Transitive failures are visible here because blocked regions are recorded as
    /// failed too.
    pub fn blocker(&self, region_id: &str) -> Option<&'g str> {
        let &index = self.graph.by_id.get(region_id)?;
        self.graph.dependencies[index]
            .iter()
            .find(|dependency| self.failed.contains(dependency))
            .map(|&dependency| self.graph.region_ids[dependency].as_str())
    }

    /// Checks `region_id` against the failures recorded so far. When a producer failed,
    /// records the region as failed and returns the message to report for it.
    pub fn mark_blocked(&mut self, region_id: &str) -> Option<String> {
        let blocker = self.blocker(region_id)?;
        let message = blocked_message(blocker);
        let index = self.graph.by_id[region_id];
        self.failed.insert(index);
        Some(message)
    }
}

/// The error text of a region that was not evaluated because `blocker` failed.
pub fn blocked_message(blocker: &str) -> String {
    format!("depends on failed region {blocker}")
}

fn compare_regions(a: &Region, b: &Region) -> std::cmp::Ordering {
    a.page
        .cmp(&b.page)
        .then_with(|| a.y.total_cmp(&b.y))
        .then_with(|| a.x.total_cmp(&b.x))
        .then_with(|| a.id.cmp(&b.id))
}

/// `Find`, `Minerr`, `Minimize` and `Maximize` (any case) as a callee name.
fn is_solving_function(name: &Name) -> bool {
    matches!(
        crate::syntax::print_name(name).to_lowercase().as_str(),
        "find" | "minerr" | "minimize" | "maximize" | "odesolve"
    )
}

/// The names an `odesolve` call declares for its block: the unknown functions and the variable
/// of integration (`odesolve(y(t), 10)`, `odesolve([x(t); y(t)], 10)`). They are local to the
/// block, so they are not worksheet references (the call may even define `y` itself).
pub(crate) fn odesolve_names(statement: &Statement) -> Vec<Name> {
    let expr = match &statement.kind {
        StatementKind::Define { rhs, .. } => rhs,
        StatementKind::Evaluate { expr, .. } | StatementKind::ExprRegion { expr } => expr,
        _ => return Vec::new(),
    };
    let ExprKind::Call { callee, args } = &expr.kind else {
        return Vec::new();
    };
    let is_odesolve = matches!(&callee.kind, ExprKind::Ident { name }
        if crate::syntax::print_name(name).eq_ignore_ascii_case("odesolve"));
    let Some(Arg::Expr { expr: functions }) = args.first() else {
        return Vec::new();
    };
    if !is_odesolve {
        return Vec::new();
    }
    let calls: Vec<&Expr> = match &functions.kind {
        ExprKind::Matrix { cells, .. } => cells.iter().collect(),
        _ => vec![functions],
    };
    let mut names = Vec::new();
    for call in calls {
        let ExprKind::Call { callee, args } = &call.kind else {
            continue;
        };
        if let ExprKind::Ident { name } = &callee.kind {
            names.push(name.clone());
        }
        if let Some(Arg::Expr { expr }) = args.first() {
            if let ExprKind::Ident { name } = &expr.kind {
                names.push(name.clone());
            }
        }
    }
    names
}

/// Every occurrence of a name read by `expr`, with repeats, in no particular order.
pub(crate) fn expr_name_occurrences(expr: &Expr) -> Vec<Name> {
    let mut occurrences = Vec::new();
    collect_expr(expr, &HashSet::default(), &mut occurrences);
    occurrences
        .into_iter()
        .map(|occurrence| occurrence.name)
        .collect()
}

/// Whether `expr` reads the name `name` (a plain reference, any label).
pub(crate) fn expr_mentions(expr: &Expr, name: &Name) -> bool {
    let mut occurrences = Vec::new();
    collect_expr(expr, &HashSet::default(), &mut occurrences);
    let wanted = crate::syntax::print_name(name);
    occurrences
        .iter()
        .any(|occurrence| crate::syntax::print_name(&occurrence.name) == wanted)
}

/// The statement that defines or evaluates: the call statement of a solve block, else the
/// statement itself.
fn solving_statement(statement: &Statement) -> &Statement {
    match &statement.kind {
        StatementKind::Solve { call, .. } => solving_statement(call),
        _ => statement,
    }
}

fn install_definitions(
    region: &Region,
    region_index: usize,
    kind: DefinitionKind,
    bindings: &mut HashMap<NameKey, Binding>,
    versions: &mut HashMap<NameKey, u32>,
    definitions: &mut Vec<Definition>,
) {
    let mut names = Vec::new();
    match &solving_statement(&region.statement).kind {
        StatementKind::Define { target, .. } | StatementKind::GlobalDefine { target, .. } => {
            target_defined_names(target, &mut names);
        }
        StatementKind::Julia { block } => {
            // A stopped block is never evaluated and exports no name:
            // a name only it defines is undefined below.
            if !block.playing {
                return;
            }
            // A name defined or imported by Julia is reached by `julia.`
            //  under the `julia` label; it hides no worksheet name.
            for text in block.exports() {
                let name = crate::julia_code::math_name(&text);
                names.push(DefinedName {
                    name,
                    contextual_label: Label::Julia,
                });
            }
        }
        _ => return,
    }
    let mut seen = HashSet::default();
    for defined in names {
        let key = NameKey::new(&defined.name, defined.contextual_label);
        if !seen.insert(key.clone()) {
            continue;
        }
        let version = versions.entry(key.clone()).or_default();
        *version += 1;
        let definition = definitions.len();
        definitions.push(Definition {
            name: defined.name,
            resolved_label: key.label,
            region_id: region.id.clone(),
            version: *version,
            kind,
        });
        bindings.insert(
            key,
            Binding {
                region: region_index,
                definition,
            },
        );
    }
}

fn analyse_region(
    region: &Region,
    region_index: usize,
    bindings: &HashMap<NameKey, Binding>,
    definitions: &[Definition],
    dependencies: &mut HashSet<usize>,
    resolved: &mut Vec<ResolvedReference>,
    unresolved: &mut Vec<UnresolvedReference>,
) {
    let mut occurrences = Vec::new();
    collect_statement_references(&region.statement, &mut occurrences);
    for occurrence in occurrences {
        if let Some(binding) = occurrence.keys.iter().find_map(|key| bindings.get(key)) {
            if binding.region != region_index {
                dependencies.insert(binding.region);
            }
            let definition = &definitions[binding.definition];
            resolved.push(ResolvedReference {
                region_id: region.id.clone(),
                name: occurrence.name,
                span: occurrence.span,
                definition_region_id: definition.region_id.clone(),
                definition_name: definition.name.clone(),
                definition_label: definition.resolved_label,
                definition_version: definition.version,
            });
        } else if !occurrence.optional {
            unresolved.push(UnresolvedReference {
                region_id: region.id.clone(),
                name: occurrence.name,
                span: occurrence.span,
            });
        }
    }
}

#[derive(Debug)]
struct Occurrence {
    name: Name,
    keys: Vec<NameKey>,
    span: Span,
    /// An indexed/row/column assignment may grow an undefined array, so the old base
    /// is a dependency when present but is not an undefined-name diagnostic when absent.
    optional: bool,
    /// Not a reference: an inline definition binds this name here, so the later references
    /// of the same statement read the definition and not the worksheet.
    binds: bool,
}

/// The references of a statement, in written order. A name an inline definition binds is not a
/// reference where it is read after that definition: the binding markers are
/// dropped and so are the later occurrences of the names they bind.
fn collect_statement_references(statement: &Statement, out: &mut Vec<Occurrence>) {
    let mut raw = Vec::new();
    collect_statement_occurrences(statement, &mut raw);
    let mut bound: HashSet<NameKey> = HashSet::default();
    for occurrence in raw {
        if occurrence.binds {
            bound.extend(occurrence.keys);
        } else if !occurrence.keys.iter().any(|key| bound.contains(key)) {
            out.push(occurrence);
        }
    }
}

/// The names an inline definition of `expr` binds that an operand after it reads: only
/// such a definition is bound by the generated code; any other is just its value.
pub(crate) fn names_read_after_inline_definitions(expr: &Expr) -> Vec<Name> {
    let mut raw = Vec::new();
    collect_expr(expr, &HashSet::default(), &mut raw);
    let mut bound: HashSet<NameKey> = HashSet::default();
    let mut read = Vec::new();
    for occurrence in raw {
        if occurrence.binds {
            bound.extend(occurrence.keys);
        } else if occurrence.keys.iter().any(|key| bound.contains(key)) {
            read.push(occurrence.name);
        }
    }
    read
}

fn collect_statement_occurrences(statement: &Statement, out: &mut Vec<Occurrence>) {
    let mut locals = HashSet::default();
    match &statement.kind {
        StatementKind::Define { target, rhs, tail } => {
            collect_target_reads(target, &locals, out);
            if let TargetKind::FunctionHead { name, params } = &target.kind {
                if name.name.segments.iter().any(|s| !s.text.is_empty()) {
                    locals.insert(NameKey::new(&name.name, Label::Fn));
                } // recursion
                locals.extend(
                    params
                        .iter()
                        .filter(|param| param.name.segments.iter().any(|s| !s.text.is_empty()))
                        .map(|param| NameKey::new(&param.name, Label::Var)),
                );
            }
            collect_expr(rhs, &locals, out);
            collect_tail(tail.as_ref(), &locals, out);
        }
        StatementKind::GlobalDefine { target, rhs } => {
            collect_target_reads(target, &locals, out);
            if let TargetKind::FunctionHead { name, params } = &target.kind {
                if name.name.segments.iter().any(|s| !s.text.is_empty()) {
                    locals.insert(NameKey::new(&name.name, Label::Fn));
                }
                locals.extend(
                    params
                        .iter()
                        .filter(|param| param.name.segments.iter().any(|s| !s.text.is_empty()))
                        .map(|param| NameKey::new(&param.name, Label::Var)),
                );
            }
            collect_expr(rhs, &locals, out);
        }
        StatementKind::Evaluate { expr, unit } => {
            collect_expr(expr, &locals, out);
            if let Some(unit) = unit {
                collect_expr(unit, &locals, out);
            }
        }
        StatementKind::Symbolic { expr, keywords } => {
            collect_expr(expr, &locals, out);
            for group in keywords {
                for arg in &group.args {
                    collect_expr(arg, &locals, out);
                }
            }
        }
        // The `Given` keyword is not a name.
        StatementKind::ExprRegion { .. } if is_given_statement(statement) => {}
        StatementKind::ExprRegion { expr } => collect_expr(expr, &locals, out),
        // Its column definitions read the cells; the table itself reads nothing.
        StatementKind::Table { .. } => {}
        StatementKind::Solve { constraints, call } => {
            // The block is one unit: constraint lines read names like any expression, and
            // the solving call (`Find(x, y)`, optionally defined or evaluated) follows.
            // The unknown functions and the variable of an `odesolve` block are local to it.
            let mut declared = odesolve_names(call);
            if let Some(args) = crate::symbolic::symbolic_find_args(call) {
                declared.extend(args.iter().filter_map(|arg| match arg {
                    Arg::Expr {
                        expr:
                            Expr {
                                kind: ExprKind::Ident { name },
                                ..
                            },
                    } => Some(name.clone()),
                    _ => None,
                }));
            }
            let mut block_locals = locals.clone();
            for name in &declared {
                for label in [Label::Var, Label::Fn] {
                    block_locals.insert(NameKey::new(name, label));
                }
            }
            for constraint in constraints {
                collect_expr(constraint, &block_locals, out);
            }
            // The solving function itself is not a worksheet name.
            let mut inner = Vec::new();
            collect_statement_references(call, &mut inner);
            inner.retain(|occurrence| {
                !is_solving_function(&occurrence.name)
                    && (occurrence.binds
                        || !declared.iter().any(|name| {
                            crate::syntax::print_name(name)
                                == crate::syntax::print_name(&occurrence.name)
                        }))
            });
            out.extend(inner);
        }
        StatementKind::Julia { block } => {
            // A stopped block runs no code, so it reads no worksheet variable either.
            if !block.playing {
                return;
            }
            // Identifiers the Julia code mentions may be worksheet variables or functions
            // of earlier julia regions (the generated code binds them before the code
            // runs). Mentions are optional references: most identifiers are Julia's own.
            for text in block.mentions() {
                let name = crate::julia_code::math_name(&text);
                out.push(Occurrence {
                    keys: vec![
                        NameKey::new(&name, Label::Var),
                        NameKey::new(&name, Label::Julia),
                    ],
                    name,
                    span: statement.span,
                    optional: true,
                    binds: false,
                });
            }
        }
    }
}

fn collect_tail(tail: Option<&Tail>, locals: &HashSet<NameKey>, out: &mut Vec<Occurrence>) {
    match tail {
        Some(Tail::Eval { unit: Some(unit) }) => collect_expr(unit, locals, out),
        Some(Tail::Sym { keywords }) => {
            for group in keywords {
                for arg in &group.args {
                    collect_expr(arg, locals, out);
                }
            }
        }
        _ => {}
    }
}

fn collect_expr(expr: &Expr, locals: &HashSet<NameKey>, out: &mut Vec<Occurrence>) {
    use ExprKind as K;
    match &expr.kind {
        K::Num { .. } | K::Imag { .. } | K::Str { .. } | K::Placeholder => {}
        K::EllipsisCell { .. } => {}
        K::Ident { name } => {
            record_reference(name, expr.span, false, ReferenceRole::Value, locals, out)
        }
        K::Paren { expr }
        | K::Percent { expr }
        | K::Permille { expr }
        | K::Neg { expr }
        | K::Not { expr }
        | K::Factorial { expr }
        | K::Transpose { expr }
        | K::Conj { expr }
        | K::RealPart { expr }
        | K::ImagPart { expr }
        | K::Abs { expr }
        | K::Det { expr }
        | K::Norm { expr }
        | K::Vectorize { expr } => collect_expr(expr, locals, out),
        K::Add { left, right, .. }
        | K::Sub { left, right, .. }
        | K::Mul { left, right, .. }
        | K::InlineDiv { left, right, .. }
        | K::Juxt { left, right }
        | K::Cross { left, right }
        | K::Conv { left, right }
        | K::CircConv { left, right }
        | K::Polar { left, right }
        | K::Div { left, right }
        | K::Pow { left, right }
        | K::Eq { left, right }
        | K::Ne { left, right }
        | K::Lt { left, right }
        | K::Gt { left, right }
        | K::Le { left, right }
        | K::Ge { left, right }
        | K::In { left, right }
        | K::And { left, right }
        | K::Or { left, right }
        | K::Xor { left, right } => {
            collect_expr(left, locals, out);
            collect_expr(right, locals, out);
        }
        K::Root { index, radicand } => {
            if let Some(index) = index {
                collect_expr(index, locals, out);
            }
            collect_expr(radicand, locals, out);
        }
        K::Call { callee, args } => {
            if let K::Ident { name } = &callee.kind {
                record_reference(name, callee.span, false, ReferenceRole::Callee, locals, out);
            } else {
                collect_expr(callee, locals, out);
            }
            if let Some(unknown) = interval_root_unknown(callee, args) {
                // `root(f(x), x, a, b)`: the unknown is bound inside the expression and
                // is not read (it need not be defined).
                if let [Arg::Expr { expr }, _, rest @ ..] = args.as_slice() {
                    let mut body_locals = locals.clone();
                    body_locals.insert(NameKey::new(unknown, Label::Var));
                    collect_expr(expr, &body_locals, out);
                    collect_args(rest, locals, out);
                }
            } else {
                collect_args(args, locals, out);
            }
        }
        K::JuliaCall {
            package,
            name,
            args,
            ..
        } => {
            // `julia.name` reads the Julia block that defines the name; a qualified
            // `julia.X.f` reads a module and depends on no block.
            if package == "julia" && !name.contains('.') {
                let name = crate::julia_code::math_name(name);
                out.push(Occurrence {
                    keys: vec![NameKey::new(&name, Label::Julia)],
                    name,
                    span: expr.span,
                    optional: false,
                    binds: false,
                });
            }
            collect_args(args, locals, out);
        }
        K::Index { base, indices } => {
            collect_expr(base, locals, out);
            for index in indices {
                collect_expr(index, locals, out);
            }
        }
        K::Column { base, index } | K::Row { base, index } => {
            collect_expr(base, locals, out);
            collect_expr(index, locals, out);
        }
        K::PrimeDeriv { function, .. } => collect_expr(function, locals, out),
        K::Matrix { cells, .. } => {
            for cell in cells {
                collect_expr(cell, locals, out);
            }
        }
        K::Range {
            first,
            second,
            last,
        } => {
            collect_expr(first, locals, out);
            if let Some(second) = second {
                collect_expr(second, locals, out);
            }
            collect_expr(last, locals, out);
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
            // A free slot is display only: its names are not references.
            collect_bounds(bounds.as_ref(), locals, out);
            if bounds.is_none() && index.is_none() {
                record_reference(
                    &var.name,
                    var.span,
                    false,
                    ReferenceRole::Value,
                    locals,
                    out,
                );
            }
            let mut body_locals = locals.clone();
            body_locals.insert(NameKey::new(&var.name, Label::Var));
            collect_expr(body, &body_locals, out);
        }
        K::Integral {
            var, bounds, body, ..
        } => {
            collect_bounds(bounds.as_ref(), locals, out);
            let mut body_locals = locals.clone();
            body_locals.insert(NameKey::new(&var.name, Label::Var));
            collect_expr(body, &body_locals, out);
        }
        // Numeric derivatives are evaluated at the worksheet value of the variable, so
        // the variable remains an ordinary reference in the body.
        // The gradient's variables, like ∂'s, stay ordinary references.
        K::Gradient { body, .. } => collect_expr(body, locals, out),
        K::Deriv { order, body, .. } | K::Partial { order, body, .. } => {
            if let Some(order) = order {
                collect_expr(order, locals, out);
            }
            collect_expr(body, locals, out);
        }
        K::Limit {
            var, target, body, ..
        } => {
            collect_expr(target, locals, out);
            let mut body_locals = locals.clone();
            body_locals.insert(NameKey::new(&var.name, Label::Var));
            collect_expr(body, &body_locals, out);
        }
        K::Program { body } => {
            let mut program_locals = locals.clone();
            collect_program(body, &mut program_locals, out);
        }
        // A parenthesised local definition reads what its target writes into (the indices of an
        // indexed target) and what its value reads; its cells are not defined anywhere.
        K::InlineDef { target, value } => {
            collect_target_reads(target, locals, out);
            collect_expr(value, locals, out);
            record_inline_binding(target, out);
        }
    }
}

fn collect_args(args: &[Arg], locals: &HashSet<NameKey>, out: &mut Vec<Occurrence>) {
    for arg in args {
        match arg {
            Arg::Expr { expr } => collect_expr(expr, locals, out),
            Arg::InlineDef { target, value, .. } => {
                collect_target_reads(target, locals, out);
                collect_expr(value, locals, out);
                record_inline_binding(target, out);
            }
        }
    }
}

fn collect_bounds(bounds: Option<&Bounds>, locals: &HashSet<NameKey>, out: &mut Vec<Occurrence>) {
    if let Some(bounds) = bounds {
        collect_expr(&bounds.lo, locals, out);
        collect_expr(&bounds.hi, locals, out);
    }
}

fn collect_program(stmts: &[Stmt], locals: &mut HashSet<NameKey>, out: &mut Vec<Occurrence>) {
    for stmt in stmts {
        match &stmt.kind {
            StmtKind::LocalDef { target, rhs } => {
                collect_target_reads(target, locals, out);
                collect_expr(rhs, locals, out);
                target_defined_names_into_set(target, locals);
            }
            StmtKind::If {
                branches,
                else_body,
            } => {
                let before = locals.clone();
                let mut outcomes = Vec::new();
                for branch in branches {
                    collect_expr(&branch.cond, &before, out);
                    let mut branch_locals = before.clone();
                    collect_program(&branch.body, &mut branch_locals, out);
                    outcomes.push(branch_locals);
                }
                if let Some(else_body) = else_body {
                    let mut else_locals = before.clone();
                    collect_program(else_body, &mut else_locals, out);
                    outcomes.push(else_locals);
                } else {
                    outcomes.push(before);
                }
                *locals = intersection(outcomes);
            }
            StmtKind::For { var, source, body } => {
                collect_expr(source, locals, out);
                let mut body_locals = locals.clone();
                let named = var.name.segments.iter().any(|s| !s.text.is_empty());
                if named {
                    body_locals.insert(NameKey::new(&var.name, Label::Var));
                }
                collect_program(body, &mut body_locals, out);
                // A loop may execute zero times, so only its binder is known local after
                // it executes; body assignments are not definitely initialized.
                if named {
                    locals.insert(NameKey::new(&var.name, Label::Var));
                }
            }
            StmtKind::While { cond, body } => {
                collect_expr(cond, locals, out);
                let mut body_locals = locals.clone();
                collect_program(body, &mut body_locals, out);
            }
            StmtKind::Try { body, handler } => {
                let before = locals.clone();
                let mut body_locals = before.clone();
                collect_program(body, &mut body_locals, out);
                let mut handler_locals = before;
                collect_program(handler, &mut handler_locals, out);
                *locals = intersection([body_locals, handler_locals]);
            }
            StmtKind::Return { expr } | StmtKind::ExprStmt { expr } => {
                collect_expr(expr, locals, out)
            }
            StmtKind::Break | StmtKind::Continue => {}
        }
    }
}

fn intersection<I>(sets: I) -> HashSet<NameKey>
where
    I: IntoIterator<Item = HashSet<NameKey>>,
{
    let mut sets = sets.into_iter();
    let Some(mut result) = sets.next() else {
        return HashSet::default();
    };
    for set in sets {
        result.retain(|name| set.contains(name));
    }
    result
}

fn collect_target_reads(target: &Target, locals: &HashSet<NameKey>, out: &mut Vec<Occurrence>) {
    match &target.kind {
        TargetKind::Ident { .. } | TargetKind::FunctionHead { .. } => {}
        TargetKind::Index { base, indices } => {
            record_target_base(base, locals, out);
            for index in indices {
                collect_expr(index, locals, out);
            }
        }
        TargetKind::Column { base, index } | TargetKind::Row { base, index } => {
            record_target_base(base, locals, out);
            collect_expr(index, locals, out);
        }
        TargetKind::Paren { target } | TargetKind::Transpose { target } => {
            collect_target_reads(target, locals, out)
        }
        TargetKind::Destructure { cells, .. } => {
            for cell in cells {
                collect_target_reads(cell, locals, out);
            }
        }
    }
}

/// The names an inline definition binds for the operands after it: a plain name and
/// the plain names of a destructuring matrix. An indexed, column or row target binds nothing
///.
fn record_inline_binding(target: &Target, out: &mut Vec<Occurrence>) {
    if target.has_placeholder() {
        return;
    }
    match &target.kind {
        TargetKind::Ident { name } => out.push(Occurrence {
            name: name.clone(),
            keys: reference_keys(name, ReferenceRole::Value),
            span: target.span,
            optional: false,
            binds: true,
        }),
        TargetKind::Paren { target } | TargetKind::Transpose { target } => {
            record_inline_binding(target, out)
        }
        TargetKind::Destructure { cells, .. } => {
            for cell in cells {
                record_inline_binding(cell, out);
            }
        }
        _ => {}
    }
}

fn record_target_base(target: &Target, locals: &HashSet<NameKey>, out: &mut Vec<Occurrence>) {
    if let Some(name) = target_root_name(target) {
        record_reference(name, target.span, true, ReferenceRole::Value, locals, out);
    }
    // Nested suffixes have their own index expressions.
    collect_nested_target_indices(target, locals, out);
}

fn collect_nested_target_indices(
    target: &Target,
    locals: &HashSet<NameKey>,
    out: &mut Vec<Occurrence>,
) {
    match &target.kind {
        TargetKind::Index { base, indices } => {
            collect_nested_target_indices(base, locals, out);
            for index in indices {
                collect_expr(index, locals, out);
            }
        }
        TargetKind::Column { base, index } | TargetKind::Row { base, index } => {
            collect_nested_target_indices(base, locals, out);
            collect_expr(index, locals, out);
        }
        TargetKind::Paren { target } | TargetKind::Transpose { target } => {
            collect_nested_target_indices(target, locals, out)
        }
        _ => {}
    }
}

fn record_reference(
    name: &Name,
    span: Span,
    optional: bool,
    role: ReferenceRole,
    locals: &HashSet<NameKey>,
    out: &mut Vec<Occurrence>,
) {
    let keys = reference_keys(name, role);
    if !keys.iter().any(|key| locals.contains(key)) {
        out.push(Occurrence {
            name: name.clone(),
            keys,
            span,
            optional,
            binds: false,
        });
    }
}

#[derive(Debug, Clone, Copy)]
enum ReferenceRole {
    Value,
    Callee,
}

/// The candidate definitions of an unlabelled name, in resolution order. A plain name never
/// reaches a unit: a unit is a labelled name, so a plain `L`
/// is a variable reference and a later `L := 3` is a dependency of it.
fn reference_keys(name: &Name, role: ReferenceRole) -> Vec<NameKey> {
    if let Some(label) = name.label {
        return vec![NameKey::new(name, label)];
    }
    let labels: &[Label] = match role {
        ReferenceRole::Value => &[Label::Var, Label::Fn, Label::Sys, Label::Const],
        // A Julia name is reached through `julia.` only, never by a plain name.
        ReferenceRole::Callee => &[Label::Fn, Label::Var, Label::Sys, Label::Const],
    };
    labels
        .iter()
        .map(|&label| NameKey::new(name, label))
        .collect()
}

struct DefinedName {
    name: Name,
    contextual_label: Label,
}

fn target_defined_names(target: &Target, out: &mut Vec<DefinedName>) {
    if target.has_placeholder() {
        return;
    }
    match &target.kind {
        TargetKind::Ident { name } => out.push(DefinedName {
            name: name.clone(),
            contextual_label: Label::Var,
        }),
        TargetKind::FunctionHead { name, .. } => out.push(DefinedName {
            name: name.name.clone(),
            contextual_label: Label::Fn,
        }),
        TargetKind::Index { base, .. }
        | TargetKind::Column { base, .. }
        | TargetKind::Row { base, .. } => target_defined_names(base, out),
        TargetKind::Paren { target } | TargetKind::Transpose { target } => {
            target_defined_names(target, out)
        }
        TargetKind::Destructure { cells, .. } => {
            for cell in cells {
                target_defined_names(cell, out);
            }
        }
    }
}

fn target_defined_names_into_set(target: &Target, names: &mut HashSet<NameKey>) {
    let mut collected = Vec::new();
    target_defined_names(target, &mut collected);
    names.extend(
        collected
            .into_iter()
            .map(|defined| NameKey::new(&defined.name, defined.contextual_label)),
    );
}

fn target_root_name(target: &Target) -> Option<&Name> {
    match &target.kind {
        TargetKind::Ident { name } if !target.has_placeholder() => Some(name),
        TargetKind::Ident { .. } => None,
        TargetKind::Index { base, .. }
        | TargetKind::Column { base, .. }
        | TargetKind::Row { base, .. } => target_root_name(base),
        TargetKind::Paren { target } | TargetKind::Transpose { target } => target_root_name(target),
        TargetKind::FunctionHead { name, .. } if !target.has_placeholder() => Some(&name.name),
        TargetKind::FunctionHead { .. } => None,
        TargetKind::Destructure { .. } => None,
    }
}

/// The unknown of the interval form `root(f(x), x, a, b)` of the solver (a call named
/// `root` with four arguments whose second argument is a plain name).
pub(crate) fn interval_root_unknown<'a>(callee: &Expr, args: &'a [Arg]) -> Option<&'a Name> {
    let ExprKind::Ident { name } = &callee.kind else {
        return None;
    };
    let [Arg::Expr { .. }, Arg::Expr { expr }, Arg::Expr { .. }, Arg::Expr { .. }] = args else {
        return None;
    };
    match (&expr.kind, name.segments.as_slice()) {
        (ExprKind::Ident { name: unknown }, [segment])
            if !segment.subscript && segment.text == "root" =>
        {
            Some(unknown)
        }
        _ => None,
    }
}
