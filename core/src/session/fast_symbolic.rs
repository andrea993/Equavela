use super::*;
use crate::ast::{Expr, ExprKind, Name, Statement, StatementKind};
use crate::symbolic::{region_request, SymbolicKeyword, SymbolicOperation};
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastSymbolicOperation {
    Simplify,
    Expand,
    Factor,
    Collect,
    Differentiate,
    Integrate,
    PartialFractions,
    Solve,
    Float,
    Combine,
    Rectangular,
    ContinuedFraction,
    Coefficients,
    Series,
    Laplace,
    InverseLaplace,
    Fourier,
    InverseFourier,
    ZTransform,
    InverseZTransform,
}

/// The live math editor and its document position. Preparing the request never changes the session.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FastSymbolicInput {
    pub region_id: Option<String>,
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub statement: Statement,
    pub operation: FastSymbolicOperation,
    pub variable: Option<Name>,
    pub worksheet_variables: bool,
}

impl WorksheetSession {
    pub fn prepare_fast_symbolic(
        &self,
        input: &FastSymbolicInput,
    ) -> Result<SymbolicRequest, String> {
        let (expr, parameters) = match &input.statement.kind {
            StatementKind::ExprRegion { expr }
            | StatementKind::Evaluate { expr, .. }
            | StatementKind::Symbolic { expr, .. } => (expr, Vec::new()),
            StatementKind::Define { target, rhs, .. }
            | StatementKind::GlobalDefine { target, rhs } => {
                let parameters = match &target.kind {
                    crate::ast::TargetKind::FunctionHead { params, .. } => {
                        params.iter().map(|param| param.name.clone()).collect()
                    }
                    _ => Vec::new(),
                };
                (rhs, parameters)
            }
            _ => return Err("Fast Symbolic needs a math expression".into()),
        };
        let variable = || {
            input
                .variable
                .clone()
                .ok_or("Select a variable for this operation")
        };
        let keyword = |name: &str, var: Option<Name>| {
            SymbolicRequest::new(
                expr.clone(),
                vec![SymbolicKeyword {
                    keyword: name.into(),
                    args: var
                        .into_iter()
                        .map(|name| Expr::synth(ExprKind::Ident { name }))
                        .collect(),
                }],
            )
        };
        use FastSymbolicOperation as Fast;
        let mut request = match input.operation {
            Fast::Simplify => SymbolicOperation::Simplify.request(expr),
            Fast::Expand => SymbolicOperation::Expand.request(expr),
            Fast::Factor => SymbolicOperation::Factor.request(expr),
            Fast::Collect => SymbolicOperation::Collect { var: variable()? }.request(expr),
            Fast::Differentiate => {
                SymbolicOperation::Differentiate { var: variable()? }.request(expr)
            }
            Fast::Integrate => SymbolicOperation::Integrate { var: variable()? }.request(expr),
            Fast::PartialFractions => {
                SymbolicOperation::PartialFractions { var: variable()? }.request(expr)
            }
            Fast::Solve => {
                if !equation_system(expr) {
                    return Err("Solve needs an equation or a matrix of equations".into());
                }
                keyword("worksheet_solve_for", Some(variable()?))
            }
            Fast::Float => SymbolicOperation::Float { digits: None }.request(expr),
            Fast::Combine => keyword("combine", None),
            Fast::Rectangular => keyword("rectangular", None),
            Fast::ContinuedFraction => keyword("confrac", input.variable.clone()),
            Fast::Coefficients => keyword("coeffs", Some(variable()?)),
            Fast::Series => keyword("series", Some(variable()?)),
            Fast::Laplace => keyword("worksheet_laplace", Some(variable()?)),
            Fast::InverseLaplace => keyword("worksheet_invlaplace", Some(variable()?)),
            Fast::Fourier => keyword("worksheet_fourier", Some(variable()?)),
            Fast::InverseFourier => keyword("worksheet_invfourier", Some(variable()?)),
            Fast::ZTransform => keyword("worksheet_ztrans", Some(variable()?)),
            Fast::InverseZTransform => keyword("worksheet_invztrans", Some(variable()?)),
        };
        request.free = parameters;
        if let Some(var) = &input.variable {
            request.free.push(var.clone());
        }
        let document = self
            .project
            .document(&self.root)
            .ok_or("Worksheet is closed")?;
        request.origin = document
            .settings
            .values
            .get("ORIGIN")
            .and_then(|n| n.trim().parse().ok());
        let solve_system = matches!(input.operation, FastSymbolicOperation::Solve)
            && matches!(unparen(expr).kind, ExprKind::Matrix { .. });
        if !input.worksheet_variables && !solve_system {
            return Ok(request);
        }

        // Analyze the live operand at the same reading position. Includes, globals, shadowing and
        // transitive definitions come from exactly the same graph as the worksheet's symbolic arrow.
        let mut shadow = document.clone();
        let mut draft_id = String::from("__fast_symbolic");
        while shadow.regions.iter().any(|r| r.id() == draft_id) {
            draft_id.push('_');
        }
        let id = input.region_id.as_deref().unwrap_or(&draft_id);
        let mut source = match shadow
            .regions
            .iter()
            .find(|r| r.id() == id)
            .map(AsRef::as_ref)
        {
            Some(DocumentRegion::Math(region)) => region.as_ref().clone(),
            Some(_) => return Err("Fast Symbolic needs a math region".into()),
            None => crate::graph::Region {
                id: id.to_owned(),
                page: input.page,
                x: input.x,
                y: input.y,
                enabled: true,
                statement: Arc::new(input.statement.clone()),
            },
        };
        source.enabled = true;
        source.statement = Arc::new(Statement::synth(StatementKind::Symbolic {
            expr: request.expr.clone(),
            keywords: Vec::new(),
        }));
        let region = Arc::new(DocumentRegion::Math(Box::new(source)));
        if let Some(index) = shadow.regions.iter().position(|r| r.id() == id) {
            shadow.regions[index] = region;
        } else {
            shadow.regions.push(region);
        }
        let mut project = self.project.clone();
        project.replace(shadow).map_err(|e| e.to_string())?;
        let analysis = project.analyze(&self.root).map_err(|e| e.to_string())?;
        let node = analysis
            .nodes()
            .iter()
            .find(|node| node.origin.document == self.root && node.origin.region_id == id)
            .ok_or("Could not determine the symbolic scope")?;
        if let Some(scoped) =
            region_request(analysis.worksheet(), analysis.graph(), &node.id.region_id())
        {
            if input.worksheet_variables {
                request.definitions = scoped.definitions;
            } else {
                // Definitions left literal are parameters of the system, not additional unknowns.
                for definition in scoped
                    .definitions
                    .into_iter()
                    .filter(|d| d.params.is_none())
                {
                    request.keywords[0].args.push(Expr::synth(ExprKind::Ident {
                        name: definition.name,
                    }));
                }
            }
        }
        Ok(request)
    }
}

fn unparen(mut expr: &Expr) -> &Expr {
    while let ExprKind::Paren { expr: inner } = &expr.kind {
        expr = inner;
    }
    expr
}

fn equation_system(expr: &Expr) -> bool {
    match &unparen(expr).kind {
        ExprKind::Eq { .. } => true,
        ExprKind::Matrix { cells, .. } => {
            !cells.is_empty()
                && cells
                    .iter()
                    .all(|cell| matches!(unparen(cell).kind, ExprKind::Eq { .. }))
        }
        _ => false,
    }
}

pub fn fast_symbolic_result(input: &FastSymbolicInput, expr: Expr) -> Statement {
    let expr = match (input.operation, &input.variable) {
        (FastSymbolicOperation::Solve, Some(name)) => Expr::synth(ExprKind::Eq {
            left: Box::new(Expr::synth(ExprKind::Ident { name: name.clone() })),
            right: Box::new(expr),
        }),
        _ => expr,
    };
    Statement::synth(StatementKind::ExprRegion { expr })
}
