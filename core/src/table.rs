//! Editable the reference application input tables.
use serde::{Deserialize, Serialize};

/// Check a unit expression against the same built-in unit catalog used by the kernel.
pub fn valid_unit(source: &str) -> bool {
    use crate::ast::{Expr, ExprKind};
    fn exponent(expr: &Expr) -> bool {
        match &expr.kind {
            ExprKind::Num { text } => text.parse::<i32>().is_ok(),
            ExprKind::Neg { expr } | ExprKind::Paren { expr } => exponent(expr),
            _ => false,
        }
    }
    fn unit(expr: &Expr) -> bool {
        match &expr.kind {
            // The column unit is a unit context: a plain name is a unit there,
            // and a labelled one means the same.
            ExprKind::Ident { name } => match name.segments.as_slice() {
                [segment] if !segment.subscript => crate::units::is_unit(&segment.text),
                _ => false,
            },
            ExprKind::Paren { expr } => unit(expr),
            ExprKind::Mul { left, right, .. }
            | ExprKind::InlineDiv { left, right, .. }
            | ExprKind::Juxt { left, right }
            | ExprKind::Div { left, right } => unit(left) && unit(right),
            ExprKind::Pow { left, right } => unit(left) && exponent(right),
            _ => false,
        }
    }
    crate::parse_expression(source).is_ok_and(|expr| unit(&expr))
}

/// Private result key separator for column definitions generated from a table.
pub fn column_region_id(table_id: &str, column: usize) -> String {
    format!("{table_id}\u{1e}table{column}")
}
pub fn is_column_region_id(region_id: &str) -> bool {
    region_id.contains("\u{1e}table")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableColumn {
    pub name: String,
    #[serde(default)]
    pub unit: Option<String>,
    pub cells: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableSpec {
    pub columns: Vec<TableColumn>,
}
impl Default for TableSpec {
    fn default() -> Self {
        Self {
            columns: vec![
                TableColumn {
                    name: String::new(),
                    unit: None,
                    cells: vec![String::new(), String::new()],
                },
                TableColumn {
                    name: String::new(),
                    unit: None,
                    cells: vec![String::new(), String::new()],
                },
            ],
        }
    }
}
impl TableSpec {
    /// The linear text of the table statement this old table converts to:
    /// names, units when any column has one, then the values; text that is not math, or not a
    /// name in the header, becomes a placeholder.
    pub fn statement_text(&self) -> String {
        let cell = |text: &str| {
            let text = text.trim();
            if text.is_empty() || crate::parse_expression(text).is_err() {
                "□".to_owned()
            } else {
                format!("({text})")
            }
        };
        let name = |text: &str| {
            let text = text.trim();
            match crate::parse_expression(text) {
                Ok(expr) if matches!(expr.kind, crate::ast::ExprKind::Ident { .. }) => {
                    text.to_owned()
                }
                _ => "□".to_owned(),
            }
        };
        let unit = |text: Option<&str>| match text.map(str::trim) {
            Some(text) if !text.is_empty() && valid_unit(text) => text.to_owned(),
            _ => "□".to_owned(),
        };
        let units = self
            .columns
            .iter()
            .any(|c| c.unit.as_deref().is_some_and(|u| !u.trim().is_empty()));
        let mut rows = vec![self
            .columns
            .iter()
            .map(|c| name(&c.name))
            .collect::<Vec<_>>()
            .join(", ")];
        if units {
            rows.push(
                self.columns
                    .iter()
                    .map(|c| unit(c.unit.as_deref()))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }
        let count = self.columns.first().map_or(0, |c| c.cells.len());
        for row in 0..count {
            rows.push(
                self.columns
                    .iter()
                    .map(|c| cell(&c.cells[row]))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }
        format!(
            "table{}:[{}]",
            if units { " units" } else { "" },
            rows.join("; ")
        )
    }

    pub fn valid(&self) -> bool {
        let Some(first) = self.columns.first() else {
            return false;
        };
        !first.cells.is_empty()
            && self
                .columns
                .iter()
                .all(|c| c.cells.len() == first.cells.len())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableRegion {
    pub id: String,
    #[serde(default)]
    pub page: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default = "crate::project::enabled_by_default")]
    pub enabled: bool,
    pub table: TableSpec,
}

impl TableRegion {
    pub fn valid(&self) -> bool {
        self.table.valid()
    }
}

/// A column's index and the definition it makes.
pub type ColumnDefinition = (usize, crate::ast::Statement);
/// A column's index and why it defines nothing.
pub type ColumnProblem = (usize, String);

/// The column definitions of a table statement: for each
/// column whose header is a name and whose values are all typed, `name := [v₁; …; vᵣ]`, times the
/// column's unit when the units row is shown and its unit is filled. The other columns define
/// nothing; a header that is not a name, a repeated name or an unknown unit is reported with the
/// column's index. A column with an empty header or an empty value is simply incomplete.
pub fn column_definitions(
    statement: &crate::ast::Statement,
) -> (Vec<ColumnDefinition>, Vec<ColumnProblem>) {
    use crate::ast::{Expr, ExprKind, Statement, StatementKind, Target, TargetKind};
    let mut definitions = Vec::new();
    let mut problems = Vec::new();
    let StatementKind::Table { units, grid } = &statement.kind else {
        return (definitions, problems);
    };
    let ExprKind::Matrix { rows, cols, cells } = &grid.kind else {
        return (definitions, problems);
    };
    let (rows, cols) = (*rows, *cols);
    let first_value = if *units { 2 } else { 1 };
    let mut seen = std::collections::HashSet::new();
    for column in 0..cols {
        let header = &cells[column];
        let name = match &header.kind {
            ExprKind::Placeholder => continue,
            ExprKind::Ident { name }
                if name.label.is_none() || name.label == Some(crate::ast::Label::Var) =>
            {
                name.clone()
            }
            _ => {
                problems.push((column, "the header must be a name".to_owned()));
                continue;
            }
        };
        if !seen.insert(crate::syntax::print_name(&name)) {
            problems.push((
                column,
                format!(
                    "`{}` names another column too",
                    crate::syntax::print_name(&name)
                ),
            ));
            continue;
        }
        let values: Vec<Expr> = (first_value..rows)
            .map(|row| cells[row * cols + column].clone())
            .collect();
        if values
            .iter()
            .any(|value| matches!(value.kind, ExprKind::Placeholder))
        {
            continue;
        }
        let span = grid.span;
        let vector = Expr::new(
            ExprKind::Matrix {
                rows: values.len(),
                cols: 1,
                cells: values,
            },
            span,
        );
        let rhs = match units.then(|| &cells[cols + column]) {
            Some(unit) if !matches!(unit.kind, ExprKind::Placeholder) => {
                let text = crate::syntax::print_expression(unit);
                if !valid_unit(&text) {
                    problems.push((column, format!("`{text}` is not a known unit")));
                    continue;
                }
                let unit = crate::units::labelled_unit_text(&text)
                    .and_then(|labelled| crate::parse_expression(&labelled).ok())
                    .unwrap_or_else(|| unit.clone());
                Expr::new(
                    ExprKind::Mul {
                        left: Box::new(vector),
                        right: Box::new(unit),
                        split: false,
                    },
                    span,
                )
            }
            _ => vector,
        };
        let target = Target::new(TargetKind::Ident { name }, header.span);
        definitions.push((
            column,
            Statement::new(
                StatementKind::Define {
                    target,
                    rhs,
                    tail: None,
                },
                statement.span,
            ),
        ));
    }
    (definitions, problems)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_known_and_compound_units() {
        for unit in ["m", "kg", "m/s^2", "kg*m/s^2"] {
            assert!(valid_unit(unit), "{unit}");
        }
        for unit in ["invalid_unit", "m + s", "3", "m^x", "m/"] {
            assert!(!valid_unit(unit), "{unit}");
        }
    }
    #[test]
    fn accepts_rectangular_columns_and_empty_cells() {
        let table = TableRegion {
            id: "t".into(),
            page: 1,
            x: 0.0,
            y: 0.0,
            enabled: true,
            table: TableSpec {
                columns: vec![TableColumn {
                    name: "x".into(),
                    unit: None,
                    cells: vec!["1".into(), "".into()],
                }],
            },
        };
        assert!(table.valid());
    }
    #[test]
    fn rejects_empty_or_ragged_columns() {
        let mut table = TableRegion {
            id: "t".into(),
            page: 1,
            x: 0.0,
            y: 0.0,
            enabled: true,
            table: TableSpec { columns: vec![] },
        };
        assert!(!table.valid());
        table.table.columns.push(TableColumn {
            name: "x".into(),
            unit: None,
            cells: vec!["1".into()],
        });
        table.table.columns.push(TableColumn {
            name: "y".into(),
            unit: None,
            cells: vec![],
        });
        assert!(!table.valid());
    }
}
