//! Symbolic evaluation on the host side.
//!
//! The kernel does the mathematics (SymPy). The host
//!
//! - builds the `symbolic` request of a region ([`region_request`]): the expression, the
//!   keyword groups and the worksheet definitions the expression depends on, all as
//!   canonical AST;
//! - turns the kernel's answer into a [`KernelValue::Symbolic`]: the AST is normalized
//!   (the required parentheses are inserted) and printed with the canonical printer, so
//!   the text is exactly what the parser accepts;
//! - offers the in-place operations of ([`SymbolicOperation`], [`apply_operation`]).

use crate::ast::{
    Arg, Expr, ExprKind, Ident, KeywordGroup, Name, Statement, StatementKind, Tail, TargetKind,
};
use crate::graph::{DependencyGraph, Worksheet};
use crate::kernel_manager::{KernelError, KernelManager};
use crate::kernel_value::KernelValue;
use crate::syntax::{normalize_expr, print_expression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, VecDeque};

/// One keyword group of the request: the keyword text and its argument expressions.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SymbolicKeyword {
    pub keyword: String,
    pub args: Vec<Expr>,
}

/// A worksheet definition in scope (`params` is `None` for a variable).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SymbolicDefinition {
    pub name: Name,
    pub params: Option<Vec<Name>>,
    pub body: Expr,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<SymbolicKeyword>,
}

/// The `symbolic` request (kernel protocol section 9).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SymbolicRequest {
    pub expr: Expr,
    pub keywords: Vec<SymbolicKeyword>,
    pub definitions: Vec<SymbolicDefinition>,
    /// Names that must never be substituted (parameters of the function head being defined).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub free: Vec<Name>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<i64>,
}

impl SymbolicRequest {
    /// A request with no definitions: a plain expression and keyword groups.
    pub fn new(expr: Expr, keywords: Vec<SymbolicKeyword>) -> Self {
        SymbolicRequest {
            expr,
            keywords,
            definitions: Vec::new(),
            free: Vec::new(),
            origin: None,
        }
    }
}

/// Why a symbolic evaluation produced no value (kernel protocol section 9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolicError {
    /// `unsupported`, `unknown_keyword`, `invalid`, `symbolic` or `unavailable`.
    pub category: String,
    pub message: String,
}

impl std::fmt::Display for SymbolicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SymbolicError {}

/// The answer of a `symbolic` request.
#[derive(Debug, Clone, PartialEq)]
pub enum SymbolicOutcome {
    /// Always a [`KernelValue::Symbolic`].
    Value(KernelValue),
    Error(SymbolicError),
}

impl SymbolicOutcome {
    /// The result expression of a successful evaluation.
    pub fn expr(&self) -> Option<&Expr> {
        match self {
            SymbolicOutcome::Value(KernelValue::Symbolic { expr, .. }) => Some(expr),
            _ => None,
        }
    }
}

/// The answer of `symbolic_status` (kernel protocol section 9).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SymbolicStatus {
    /// `idle`, `warming`, `ready` or `failed`.
    pub state: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub sympy: Option<String>,
    #[serde(default)]
    pub python: Option<String>,
    #[serde(default)]
    pub seconds: Option<f64>,
}

// ---------------------------------------------------------------------------------------
// Kernel calls
// ---------------------------------------------------------------------------------------

impl KernelManager {
    /// Runs a symbolic evaluation (`symbolic`, protocol section 9). Blocks until SymPy is
    /// ready; a failing evaluation is `Ok(SymbolicOutcome::Error(..))`.
    pub fn symbolic(&self, request: &SymbolicRequest) -> Result<SymbolicOutcome, KernelError> {
        let params = serde_json::to_value(request)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))?;
        let response = self.request("symbolic", Some(params))?;
        parse_symbolic_result(&response.result).map_err(KernelError::InvalidResponse)
    }

    /// Starts the SymPy warm-up in the background unless it has started (`symbolic_warmup`, protocol
    /// section 10): loading SymPy costs about 300 MB, so only a worksheet with symbolics asks.
    pub fn symbolic_warmup(&self) -> Result<SymbolicStatus, KernelError> {
        let response = self.request("symbolic_warmup", None)?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }

    /// The state of the SymPy warm-up (`symbolic_status`).
    pub fn symbolic_status(&self) -> Result<SymbolicStatus, KernelError> {
        let response = self.request("symbolic_status", None)?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }
}

/// Parses the result of a `symbolic` request: normalizes the AST and prints it.
pub fn parse_symbolic_result(result: &Value) -> Result<SymbolicOutcome, String> {
    match result.get("status").and_then(Value::as_str) {
        Some("ok") => {
            let value = result
                .get("value")
                .ok_or("a successful symbolic result has no value")?;
            let expr = value
                .get("expr")
                .ok_or("a symbolic value has no expression")?;
            let mut expr: Expr = serde_json::from_value(expr.clone())
                .map_err(|error| format!("invalid symbolic expression: {error}"))?;
            normalize_expr(&mut expr);
            let text = print_expression(&expr);
            Ok(SymbolicOutcome::Value(KernelValue::Symbolic {
                expr: Box::new(expr),
                text,
            }))
        }
        Some("error") => {
            let error = result
                .get("error")
                .ok_or("a failed symbolic result has no error")?;
            let error: SymbolicError = serde_json::from_value(error.clone())
                .map_err(|error| format!("invalid symbolic error: {error}"))?;
            Ok(SymbolicOutcome::Error(error))
        }
        other => Err(format!("unknown symbolic status {other:?}")),
    }
}

// ---------------------------------------------------------------------------------------
// Requests from the worksheet
// ---------------------------------------------------------------------------------------

/// The plain text of a keyword identifier (`solve`).
fn keyword_text(ident: &Ident) -> String {
    ident
        .name
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect()
}

fn keywords_of(groups: &[KeywordGroup]) -> Vec<SymbolicKeyword> {
    groups
        .iter()
        .map(|group| SymbolicKeyword {
            keyword: keyword_text(&group.keyword),
            args: group.args.clone(),
        })
        .collect()
}

/// A direct Find call with a symbolic tail, as the closing statement of a Given block.
pub(crate) fn symbolic_find_args(statement: &Statement) -> Option<&[Arg]> {
    symbolic_solving_call(statement, "find")
}

/// An `odesolve(y(t), b)` call with a symbolic tail closing a block: the unknown functions,
/// solved in closed form (the end point only matters to the numeric solver).
pub(crate) fn symbolic_odesolve_functions(statement: &Statement) -> Option<&Expr> {
    match symbolic_solving_call(statement, "odesolve")?.first()? {
        Arg::Expr { expr } => Some(expr),
        _ => None,
    }
}

/// The variable of the unknown functions of a symbolic `odesolve` (`t` of `y(t)`).
fn odesolve_variable(functions: &Expr) -> Option<Name> {
    let first = match &functions.kind {
        ExprKind::Matrix { cells, .. } => cells.first()?,
        _ => functions,
    };
    let ExprKind::Call { args, .. } = &first.kind else {
        return None;
    };
    match args.first()? {
        Arg::Expr { expr } => match &expr.kind {
            ExprKind::Ident { name } => Some(name.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn symbolic_solving_call<'a>(statement: &'a Statement, function: &str) -> Option<&'a [Arg]> {
    let expr = match &statement.kind {
        StatementKind::Symbolic { expr, .. } => expr,
        StatementKind::Define {
            rhs,
            tail: Some(Tail::Sym { .. }),
            ..
        } => rhs,
        _ => return None,
    };
    let ExprKind::Call { callee, args } = &expr.kind else {
        return None;
    };
    let ExprKind::Ident { name } = &callee.kind else {
        return None;
    };
    crate::syntax::print_name(name)
        .eq_ignore_ascii_case(function)
        .then_some(args)
}

/// The symbolic evaluation of a statement: expression, keywords and the names that are
/// free in it. `None` for a statement without a symbolic tail.
fn statement_symbolic(statement: &Statement) -> Option<(Expr, Vec<SymbolicKeyword>, Vec<Name>)> {
    match &statement.kind {
        StatementKind::Symbolic { expr, keywords } => {
            Some((expr.clone(), keywords_of(keywords), Vec::new()))
        }
        StatementKind::Define {
            target,
            rhs,
            tail: Some(Tail::Sym { keywords }),
        } => {
            let free = match &target.kind {
                TargetKind::FunctionHead { params, .. } => {
                    params.iter().map(|param| param.name.clone()).collect()
                }
                _ => Vec::new(),
            };
            Some((rhs.clone(), keywords_of(keywords), free))
        }
        StatementKind::Solve { constraints, call } if symbolic_odesolve_functions(call).is_some() => {
            let functions = symbolic_odesolve_functions(call)?.clone();
            let (_, mut keywords, free) = statement_symbolic(call)?;
            keywords.insert(
                0,
                SymbolicKeyword {
                    keyword: "dsolve".into(),
                    args: vec![functions],
                },
            );
            let system = Expr::synth(ExprKind::Matrix {
                rows: constraints.len(),
                cols: 1,
                cells: constraints.clone(),
            });
            Some((system, keywords, free))
        }
        StatementKind::Solve { constraints, call } => {
            let args = symbolic_find_args(call)?;
            let (_, mut keywords, free) = statement_symbolic(call)?;
            let mut unknowns = args
                .iter()
                .map(|arg| match arg {
                    Arg::Expr { expr } if matches!(expr.kind, ExprKind::Ident { .. }) => {
                        expr.clone()
                    }
                    _ => Expr::synth(ExprKind::Placeholder),
                })
                .collect::<Vec<_>>();
            if unknowns.is_empty() {
                unknowns.push(Expr::synth(ExprKind::Placeholder));
            }
            // A vector keeps Find arguments in the variable role even when a name is also
            // a solve modifier (for example, a worksheet variable named real).
            keywords.insert(
                0,
                SymbolicKeyword {
                    keyword: "solve".into(),
                    args: vec![Expr::synth(ExprKind::Matrix {
                        rows: unknowns.len(),
                        cols: 1,
                        cells: unknowns,
                    })],
                },
            );
            let system = Expr::synth(ExprKind::Matrix {
                rows: constraints.len(),
                cols: 1,
                cells: constraints.clone(),
            });
            Some((system, keywords, free))
        }
        _ => None,
    }
}

/// A definition the kernel can bind: `x := e`, `x ≡ e`, `f(x) := e`, with the symbolic
/// tail of `S := e →[solve, k]` when there is one.
fn statement_definition(statement: &Statement) -> Option<SymbolicDefinition> {
    let (target, rhs, keywords) = match &statement.kind {
        StatementKind::Define { target, rhs, tail } => {
            let keywords = match tail {
                Some(Tail::Sym { keywords }) => keywords_of(keywords),
                _ => Vec::new(),
            };
            (target, rhs, keywords)
        }
        StatementKind::Solve { call, .. } => {
            let mut definition = statement_definition(call)?;
            let (body, keywords, _) = statement_symbolic(statement)?;
            definition.body = body;
            definition.keywords = keywords;
            // `y := odesolve(y(t), b) →` defines the solution as a function of the variable.
            if definition.params.is_none() {
                if let Some(variable) = symbolic_odesolve_functions(call).and_then(odesolve_variable) {
                    definition.params = Some(vec![variable]);
                }
            }
            return Some(definition);
        }
        StatementKind::GlobalDefine { target, rhs } => (target, rhs, Vec::new()),
        _ => return None,
    };
    let (name, params) = match &target.kind {
        TargetKind::Ident { name } => (name.clone(), None),
        TargetKind::FunctionHead { name, params } => (
            name.name.clone(),
            Some(params.iter().map(|param| param.name.clone()).collect()),
        ),
        _ => return None,
    };
    Some(SymbolicDefinition {
        name,
        params,
        body: rhs.clone(),
        keywords,
    })
}

/// The `symbolic` request of the region `region_id`, or `None` when the region has no
/// symbolic evaluation. The definitions are the regions the expression depends on,
/// transitively (dependency graph), in evaluation order.
pub fn region_request(
    worksheet: &Worksheet,
    graph: &DependencyGraph,
    region_id: &str,
) -> Option<SymbolicRequest> {
    region_request_in(&statements_by_id(worksheet), graph, region_id)
}

/// The statements of a worksheet by region id, built once for many [`region_request_in`] calls.
pub fn statements_by_id(worksheet: &Worksheet) -> HashMap<&str, &Statement> {
    worksheet
        .regions
        .iter()
        .map(|region| (region.id.as_str(), region.statement.as_ref()))
        .collect()
}

/// [`region_request`] with the statement index built by the caller: asking for every region of a
/// worksheet must not rebuild the index per region.
pub fn region_request_in(
    by_id: &HashMap<&str, &Statement>,
    graph: &DependencyGraph,
    region_id: &str,
) -> Option<SymbolicRequest> {
    let (expr, keywords, free) = statement_symbolic(by_id.get(region_id)?)?;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(region_id.to_string());
    while let Some(current) = queue.pop_front() {
        for dependency in graph.dependencies_of(&current).unwrap_or_default() {
            if seen.insert(dependency.clone()) {
                queue.push_back(dependency);
            }
        }
    }
    let mut ordered: Vec<String> = seen.into_iter().collect();
    ordered.sort_by_key(|id| graph.evaluation_rank(id).unwrap_or(usize::MAX));
    let definitions = ordered
        .iter()
        .filter_map(|id| by_id.get(id.as_str()).and_then(|s| statement_definition(s)))
        .collect();
    Some(SymbolicRequest {
        expr,
        keywords,
        definitions,
        free,
        origin: None,
    })
}

// ---------------------------------------------------------------------------------------
// In-place operations
// ---------------------------------------------------------------------------------------

/// An in-place symbolic operation: the engine API behind the
/// Symbolics menu. The same request path as the live `→`.
#[derive(Debug, Clone, PartialEq)]
pub enum SymbolicOperation {
    Simplify,
    Expand,
    Factor,
    Collect { var: Name },
    Float { digits: Option<u32> },
    SolveFor { var: Name },
    Substitute { var: Name, value: Expr },
    Differentiate { var: Name },
    Integrate { var: Name },
    Series { var: Name, order: u32 },
    PartialFractions { var: Name },
}

fn ident_expr(name: &Name) -> Expr {
    Expr::synth(ExprKind::Ident { name: name.clone() })
}

fn keyword(name: &str, args: Vec<Expr>) -> SymbolicKeyword {
    SymbolicKeyword {
        keyword: name.to_string(),
        args,
    }
}

fn number(value: u32) -> Expr {
    Expr::synth(ExprKind::Num {
        text: value.to_string(),
    })
}

impl SymbolicOperation {
    /// The request that performs the operation on `expr`.
    pub fn request(&self, expr: &Expr) -> SymbolicRequest {
        let mut expr = expr.clone();
        let keywords = match self {
            SymbolicOperation::Simplify => vec![keyword("simplify", vec![])],
            SymbolicOperation::Expand => vec![keyword("expand", vec![])],
            SymbolicOperation::Factor => vec![keyword("factor", vec![])],
            SymbolicOperation::Collect { var } => vec![keyword("collect", vec![ident_expr(var)])],
            SymbolicOperation::Float { digits } => vec![keyword(
                "float",
                digits.map(number).into_iter().collect::<Vec<_>>(),
            )],
            SymbolicOperation::SolveFor { var } => vec![keyword("solve", vec![ident_expr(var)])],
            SymbolicOperation::Substitute { var, value } => vec![keyword(
                "substitute",
                vec![Expr::synth(ExprKind::Eq {
                    left: Box::new(ident_expr(var)),
                    right: Box::new(value.clone()),
                })],
            )],
            SymbolicOperation::Differentiate { var } => {
                expr = Expr::synth(ExprKind::Deriv {
                    var: Ident::new(var.clone()),
                    order: None,
                    body: Box::new(expr),
                });
                Vec::new()
            }
            SymbolicOperation::Integrate { var } => {
                expr = Expr::synth(ExprKind::Integral {
                    var: Ident::new(var.clone()),
                    bounds: None,
                    algorithm: None,
                    body: Box::new(expr),
                });
                Vec::new()
            }
            SymbolicOperation::Series { var, order } => {
                vec![keyword("series", vec![ident_expr(var), number(*order)])]
            }
            SymbolicOperation::PartialFractions { var } => {
                vec![keyword("parfrac", vec![ident_expr(var)])]
            }
        };
        SymbolicRequest::new(expr, keywords)
    }
}

/// Applies an in-place operation: operation + AST (+ the worksheet
/// definitions in scope) to the result AST. A failed operation is the error; nothing
/// else changes.
pub fn apply_operation(
    kernel: &KernelManager,
    operation: &SymbolicOperation,
    expr: &Expr,
    definitions: Vec<SymbolicDefinition>,
) -> Result<Expr, SymbolicError> {
    let mut request = operation.request(expr);
    request.definitions = definitions;
    match kernel.symbolic(&request) {
        Ok(SymbolicOutcome::Value(KernelValue::Symbolic { expr, .. })) => Ok(*expr),
        Ok(SymbolicOutcome::Value(_)) => Err(SymbolicError {
            category: "symbolic".into(),
            message: "the kernel returned a value that is not symbolic".into(),
        }),
        Ok(SymbolicOutcome::Error(error)) => Err(error),
        Err(error) => Err(SymbolicError {
            category: "unavailable".into(),
            message: error.to_string(),
        }),
    }
}

/// The JSON of a request, as sent to the kernel (also the session's change fingerprint).
pub fn request_json(request: &SymbolicRequest) -> Value {
    serde_json::to_value(request).unwrap_or(Value::Null)
}
