//! Conservative static dimensional analysis.
//!
//! This pass proves simple unit relationships before evaluation. Unknown values remain
//! unknown: a warning is emitted only when two exact dimensions are incompatible, and
//! warnings never prevent dependency analysis or numeric evaluation.

use crate::ast::{
    Arg, Expr, ExprKind, Label, Name, Segment, Span, StatementKind, Stmt, StmtKind, Tail, Target,
    TargetKind,
};
use crate::fasthash::{HashMap, HashSet};
use crate::graph::{Definition, DependencyGraph, GraphError, Region, Worksheet};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const BASE_DIMENSIONS: usize = 7;

/// SI base dimensions, in the stable order used by [`Dimension`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BaseDimension {
    Length,
    Mass,
    Time,
    Current,
    Temperature,
    Amount,
    LuminousIntensity,
}

impl BaseDimension {
    fn index(self) -> usize {
        match self {
            BaseDimension::Length => 0,
            BaseDimension::Mass => 1,
            BaseDimension::Time => 2,
            BaseDimension::Current => 3,
            BaseDimension::Temperature => 4,
            BaseDimension::Amount => 5,
            BaseDimension::LuminousIntensity => 6,
        }
    }
}

/// A reduced rational exponent such as `1/2` or `-2`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RationalExponent {
    pub numerator: i32,
    pub denominator: u32,
}

impl RationalExponent {
    const ZERO: RationalExponent = RationalExponent {
        numerator: 0,
        denominator: 1,
    };

    fn new(numerator: i32, denominator: i32) -> RationalExponent {
        debug_assert_ne!(denominator, 0);
        let (numerator, denominator) = if denominator < 0 {
            (-numerator, -denominator)
        } else {
            (numerator, denominator)
        };
        let divisor = gcd(numerator.unsigned_abs(), denominator as u32).max(1);
        RationalExponent {
            numerator: numerator / divisor as i32,
            denominator: denominator as u32 / divisor,
        }
    }

    fn add(self, other: RationalExponent) -> RationalExponent {
        RationalExponent::new(
            self.numerator * other.denominator as i32 + other.numerator * self.denominator as i32,
            (self.denominator * other.denominator) as i32,
        )
    }

    fn subtract(self, other: RationalExponent) -> RationalExponent {
        self.add(RationalExponent::new(
            -other.numerator,
            other.denominator as i32,
        ))
    }

    fn multiply(self, numerator: i32, denominator: i32) -> RationalExponent {
        RationalExponent::new(
            self.numerator * numerator,
            self.denominator as i32 * denominator,
        )
    }
}

fn gcd(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

/// An exact physical dimension represented by rational SI-base exponents.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Dimension {
    pub exponents: [RationalExponent; BASE_DIMENSIONS],
}

impl Dimension {
    pub fn dimensionless() -> Dimension {
        Dimension {
            exponents: [RationalExponent::ZERO; BASE_DIMENSIONS],
        }
    }

    pub fn base(base: BaseDimension) -> Dimension {
        let mut dimension = Dimension::dimensionless();
        dimension.exponents[base.index()] = RationalExponent::new(1, 1);
        dimension
    }

    pub fn length() -> Dimension {
        Dimension::base(BaseDimension::Length)
    }

    pub fn mass() -> Dimension {
        Dimension::base(BaseDimension::Mass)
    }

    pub fn time() -> Dimension {
        Dimension::base(BaseDimension::Time)
    }

    /// A readable form for messages: `length/time^2`, `mass`, `no units`.
    pub fn describe(&self) -> String {
        const NAMES: [&str; BASE_DIMENSIONS] = [
            "length",
            "mass",
            "time",
            "current",
            "temperature",
            "amount",
            "luminous intensity",
        ];
        let part = |name: &str, exponent: RationalExponent| {
            let magnitude = exponent.numerator.unsigned_abs();
            match (magnitude, exponent.denominator) {
                (1, 1) => name.to_owned(),
                (_, 1) => format!("{name}^{magnitude}"),
                (_, denominator) => format!("{name}^({magnitude}/{denominator})"),
            }
        };
        let mut above = Vec::new();
        let mut below = Vec::new();
        for (name, exponent) in NAMES.iter().zip(self.exponents) {
            match exponent.numerator.signum() {
                1 => above.push(part(name, exponent)),
                -1 => below.push(part(name, exponent)),
                _ => {}
            }
        }
        match (above.is_empty(), below.is_empty()) {
            (true, true) => "no units".to_owned(),
            (false, true) => above.join("·"),
            (true, false) => format!("1/{}", below.join("·")),
            (false, false) => format!("{}/{}", above.join("·"), below.join("·")),
        }
    }

    pub fn is_dimensionless(&self) -> bool {
        self.exponents
            .iter()
            .all(|exponent| *exponent == RationalExponent::ZERO)
    }

    pub fn multiplied_by(&self, other: &Dimension) -> Dimension {
        let mut result = Dimension::dimensionless();
        for (index, exponent) in result.exponents.iter_mut().enumerate() {
            *exponent = self.exponents[index].add(other.exponents[index]);
        }
        result
    }

    pub fn divided_by(&self, other: &Dimension) -> Dimension {
        let mut result = Dimension::dimensionless();
        for (index, exponent) in result.exponents.iter_mut().enumerate() {
            *exponent = self.exponents[index].subtract(other.exponents[index]);
        }
        result
    }

    pub fn powered(&self, numerator: i32, denominator: i32) -> Dimension {
        Dimension {
            exponents: self
                .exponents
                .map(|exponent| exponent.multiply(numerator, denominator)),
        }
    }
}

/// Dimension information proven for an expression or region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DimensionFact {
    Unknown,
    Scalar(Dimension),
    Matrix {
        rows: usize,
        cols: usize,
        /// `None` means that cell's dimension is not statically known.
        cells: Vec<Option<Dimension>>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DimensionOperation {
    Add,
    Subtract,
    Compare,
    Range,
    FunctionArgument,
    UnitOverride,
    Boolean,
    Factorial,
    Index,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DimensionWarningKind {
    Mismatch {
        operation: DimensionOperation,
        left: Dimension,
        right: Dimension,
    },
    ExpectedDimensionless {
        operation: DimensionOperation,
        actual: Dimension,
    },
}

impl DimensionOperation {
    fn label(self) -> &'static str {
        match self {
            DimensionOperation::Add => "addition",
            DimensionOperation::Subtract => "subtraction",
            DimensionOperation::Compare => "comparison",
            DimensionOperation::Range => "range",
            DimensionOperation::FunctionArgument => "function argument",
            DimensionOperation::UnitOverride => "unit override",
            DimensionOperation::Boolean => "Boolean operation",
            DimensionOperation::Factorial => "factorial",
            DimensionOperation::Index => "index",
        }
    }
}

impl DimensionWarningKind {
    /// The warning as a one-line message.
    pub fn message(&self) -> String {
        match self {
            DimensionWarningKind::Mismatch {
                operation,
                left,
                right,
            } => format!(
                "units do not match in {}: {} and {}",
                operation.label(),
                left.describe(),
                right.describe()
            ),
            DimensionWarningKind::ExpectedDimensionless { operation, actual } => format!(
                "{} needs a value without units, but it has {}",
                operation.label(),
                actual.describe()
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DimensionWarning {
    pub region_id: String,
    pub span: Span,
    pub kind: DimensionWarningKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DimensionalAnalysis {
    dimensions: BTreeMap<String, DimensionFact>,
    warnings: Vec<DimensionWarning>,
}

impl DimensionalAnalysis {
    pub fn dimension_of(&self, region_id: &str) -> Option<&DimensionFact> {
        self.dimensions.get(region_id)
    }

    pub fn warnings(&self) -> &[DimensionWarning] {
        &self.warnings
    }
}

/// Analyze every enabled region in dependency-graph evaluation order.
pub fn analyze_dimensions(worksheet: &Worksheet) -> Result<DimensionalAnalysis, GraphError> {
    let graph = DependencyGraph::build(worksheet)?;
    Ok(analyze_dimensions_with(worksheet, &graph))
}

/// [`analyze_dimensions`] with the dependency graph of `worksheet` already built by the caller.
pub fn analyze_dimensions_with(
    worksheet: &Worksheet,
    graph: &DependencyGraph,
) -> DimensionalAnalysis {
    Analyzer::new(worksheet, graph).analyze()
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DefinitionKey {
    region_id: String,
    segments: Vec<Segment>,
    label: Label,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ReferenceKey {
    region_id: String,
    start: usize,
    end: usize,
    name: Name,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LocalKey {
    segments: Vec<Segment>,
    label: Label,
}

impl LocalKey {
    fn variable(name: &Name) -> LocalKey {
        LocalKey {
            segments: name.segments.clone(),
            label: name.label.unwrap_or(Label::Var),
        }
    }
}

#[derive(Debug, Clone)]
struct FunctionDefinition {
    region_id: String,
    params: Vec<Name>,
    body: Expr,
}

struct Analyzer<'a> {
    graph: &'a DependencyGraph,
    regions: HashMap<&'a str, &'a Region>,
    /// The graph's definitions grouped by region, in graph order: looking them up per region in the
    /// whole list made the analysis quadratic.
    definitions_by_region: HashMap<&'a str, Vec<&'a Definition>>,
    references: HashMap<ReferenceKey, DefinitionKey>,
    definition_facts: HashMap<DefinitionKey, DimensionFact>,
    functions: HashMap<DefinitionKey, FunctionDefinition>,
    dimensions: BTreeMap<String, DimensionFact>,
    warnings: Vec<DimensionWarning>,
    /// Inferring the unit of a unit override: a slot that can only hold a unit, so a plain name is
    /// a unit there.
    unit_context: bool,
}

impl<'a> Analyzer<'a> {
    fn new(worksheet: &'a Worksheet, graph: &'a DependencyGraph) -> Analyzer<'a> {
        let regions = worksheet
            .regions
            .iter()
            .map(|region| (region.id.as_str(), region))
            .collect();
        let references = graph
            .resolved_references()
            .iter()
            .map(|reference| {
                (
                    ReferenceKey {
                        region_id: reference.region_id.clone(),
                        start: reference.span.start,
                        end: reference.span.end,
                        name: reference.name.clone(),
                    },
                    DefinitionKey {
                        region_id: reference.definition_region_id.clone(),
                        segments: reference.definition_name.segments.clone(),
                        label: reference.definition_label,
                    },
                )
            })
            .collect();
        let mut definitions_by_region: HashMap<&str, Vec<&Definition>> = HashMap::default();
        for definition in graph.definitions() {
            definitions_by_region
                .entry(definition.region_id.as_str())
                .or_default()
                .push(definition);
        }
        Analyzer {
            graph,
            regions,
            definitions_by_region,
            references,
            definition_facts: HashMap::default(),
            functions: HashMap::default(),
            dimensions: BTreeMap::new(),
            warnings: Vec::new(),
            unit_context: false,
        }
    }

    fn analyze(mut self) -> DimensionalAnalysis {
        for region_id in self.graph.evaluation_order() {
            let region = self.regions[region_id.as_str()];
            let fact = self.infer_statement(region);
            self.dimensions.insert(region_id, fact);
        }
        DimensionalAnalysis {
            dimensions: self.dimensions,
            warnings: self.warnings,
        }
    }

    fn infer_statement(&mut self, region: &Region) -> DimensionFact {
        let locals = HashMap::default();
        let mut call_stack = HashSet::default();
        match &region.statement.kind {
            StatementKind::Define { target, rhs, tail } => {
                if let TargetKind::FunctionHead { params, .. } = &target.kind {
                    let keys = self.definition_keys_for_region(&region.id, Label::Fn);
                    for key in keys {
                        self.functions.insert(
                            key,
                            FunctionDefinition {
                                region_id: region.id.clone(),
                                params: params.iter().map(|param| param.name.clone()).collect(),
                                body: rhs.clone(),
                            },
                        );
                    }
                    return DimensionFact::Unknown;
                }
                let fact = self.infer_expr(&region.id, rhs, &locals, &mut call_stack);
                self.check_tail(&region.id, &fact, tail.as_ref(), &locals, &mut call_stack);
                self.store_target(&region.id, target, &fact);
                fact
            }
            StatementKind::GlobalDefine { target, rhs } => {
                if let TargetKind::FunctionHead { params, .. } = &target.kind {
                    let keys = self.definition_keys_for_region(&region.id, Label::Fn);
                    for key in keys {
                        self.functions.insert(
                            key,
                            FunctionDefinition {
                                region_id: region.id.clone(),
                                params: params.iter().map(|param| param.name.clone()).collect(),
                                body: rhs.clone(),
                            },
                        );
                    }
                    DimensionFact::Unknown
                } else {
                    let fact = self.infer_expr(&region.id, rhs, &locals, &mut call_stack);
                    self.store_target(&region.id, target, &fact);
                    fact
                }
            }
            StatementKind::Evaluate { expr, unit } => {
                let fact = self.infer_expr(&region.id, expr, &locals, &mut call_stack);
                if let Some(unit) = unit {
                    let override_fact = self.infer_unit(&region.id, unit, &locals, &mut call_stack);
                    self.check_compatible(
                        &region.id,
                        unit.span,
                        DimensionOperation::UnitOverride,
                        &fact,
                        &override_fact,
                    );
                }
                fact
            }
            // Symbolic unit handling is deferred to phase 5, and an expression
            // region is descriptive rather than evaluated.
            StatementKind::Symbolic { .. }
            | StatementKind::ExprRegion { .. }
            | StatementKind::Table { .. }
            | StatementKind::Julia { .. }
            | StatementKind::Solve { .. } => DimensionFact::Unknown,
        }
    }

    fn check_tail(
        &mut self,
        region_id: &str,
        value: &DimensionFact,
        tail: Option<&Tail>,
        locals: &HashMap<LocalKey, DimensionFact>,
        call_stack: &mut HashSet<DefinitionKey>,
    ) {
        if let Some(Tail::Eval { unit: Some(unit) }) = tail {
            let override_fact = self.infer_unit(region_id, unit, locals, call_stack);
            self.check_compatible(
                region_id,
                unit.span,
                DimensionOperation::UnitOverride,
                value,
                &override_fact,
            );
        }
    }

    /// The unit of a unit override: a unit context, so a plain name is a unit there.
    /// The flag is restored whatever the recursion does.
    fn infer_unit(
        &mut self,
        region_id: &str,
        unit: &Expr,
        locals: &HashMap<LocalKey, DimensionFact>,
        call_stack: &mut HashSet<DefinitionKey>,
    ) -> DimensionFact {
        let outer = std::mem::replace(&mut self.unit_context, true);
        let fact = self.infer_expr(region_id, unit, locals, call_stack);
        self.unit_context = outer;
        fact
    }

    fn definitions_of(&self, region_id: &str) -> &[&'a Definition] {
        self.definitions_by_region
            .get(region_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    fn definition_keys_for_region(&self, region_id: &str, label: Label) -> Vec<DefinitionKey> {
        self.definitions_of(region_id)
            .iter()
            .filter(|definition| {
                definition.region_id == region_id && definition.resolved_label == label
            })
            .map(|definition| DefinitionKey {
                region_id: region_id.to_owned(),
                segments: definition.name.segments.clone(),
                label,
            })
            .collect()
    }

    fn store_target(&mut self, region_id: &str, target: &Target, fact: &DimensionFact) {
        let assignments = target_facts(target, fact);
        for (name, target_fact) in assignments {
            if let Some(definition) = self.definitions_of(region_id).iter().find(|definition| {
                definition.region_id == region_id
                    && definition.name.segments == name.segments
                    && definition.resolved_label == name.label.unwrap_or(Label::Var)
            }) {
                self.definition_facts.insert(
                    DefinitionKey {
                        region_id: region_id.to_owned(),
                        segments: definition.name.segments.clone(),
                        label: definition.resolved_label,
                    },
                    target_fact,
                );
            }
        }
    }

    fn infer_expr(
        &mut self,
        region_id: &str,
        expr: &Expr,
        locals: &HashMap<LocalKey, DimensionFact>,
        call_stack: &mut HashSet<DefinitionKey>,
    ) -> DimensionFact {
        use ExprKind as K;
        match &expr.kind {
            K::Num { .. } | K::Imag { .. } => scalar_dimensionless(),
            K::Str { .. } | K::Placeholder | K::EllipsisCell { .. } => DimensionFact::Unknown,
            K::Ident { name } => self.infer_name(region_id, expr.span, name, locals),
            K::Paren { expr } => self.infer_expr(region_id, expr, locals, call_stack),
            // The units of a parenthesised local definition are those of its right side.
            K::InlineDef { value, .. } => self.infer_expr(region_id, value, locals, call_stack),
            K::Neg { expr }
            | K::Conj { expr }
            | K::RealPart { expr }
            | K::ImagPart { expr }
            | K::Abs { expr }
            | K::Transpose { expr }
            // A percent divides by 100 and adds no unit of its own.
            | K::Percent { expr }
            | K::Permille { expr }
            | K::Vectorize { expr } => self.infer_expr(region_id, expr, locals, call_stack),
            K::Not { expr } => {
                let fact = self.infer_expr(region_id, expr, locals, call_stack);
                self.expect_dimensionless(region_id, expr.span, DimensionOperation::Boolean, &fact);
                scalar_dimensionless()
            }
            K::Factorial { expr } => {
                let fact = self.infer_expr(region_id, expr, locals, call_stack);
                self.expect_dimensionless(
                    region_id,
                    expr.span,
                    DimensionOperation::Factorial,
                    &fact,
                );
                scalar_dimensionless()
            }
            K::Det { expr } => {
                let fact = self.infer_expr(region_id, expr, locals, call_stack);
                determinant_dimension(fact)
            }
            K::Norm { expr } => {
                let fact = self.infer_expr(region_id, expr, locals, call_stack);
                uniform_dimension(&fact)
                    .map(DimensionFact::Scalar)
                    .unwrap_or(DimensionFact::Unknown)
            }
            K::Add { left, right, .. } => self.infer_compatible_binary(
                region_id,
                expr.span,
                DimensionOperation::Add,
                (left, right),
                locals,
                call_stack,
            ),
            K::Sub { left, right, .. } => self.infer_compatible_binary(
                region_id,
                expr.span,
                DimensionOperation::Subtract,
                (left, right),
                locals,
                call_stack,
            ),
            K::Eq { left, right }
            | K::Ne { left, right }
            | K::Lt { left, right }
            | K::Gt { left, right }
            | K::Le { left, right }
            | K::Ge { left, right } => {
                let left_fact = self.infer_expr(region_id, left, locals, call_stack);
                let right_fact = self.infer_expr(region_id, right, locals, call_stack);
                self.check_compatible(
                    region_id,
                    expr.span,
                    DimensionOperation::Compare,
                    &left_fact,
                    &right_fact,
                );
                scalar_dimensionless()
            }
            K::Mul { left, right, .. }
            | K::Juxt { left, right }
            | K::Cross { left, right }
            | K::Conv { left, right }
            | K::CircConv { left, right }
            // The angle of a polar form is dimensionless, so its units are the magnitude's.
            | K::Polar { left, right } => {
                let left = self.infer_expr(region_id, left, locals, call_stack);
                let right = self.infer_expr(region_id, right, locals, call_stack);
                multiply_facts(left, right)
            }
            K::InlineDiv { left, right, .. } | K::Div { left, right } => {
                let left = self.infer_expr(region_id, left, locals, call_stack);
                let right = self.infer_expr(region_id, right, locals, call_stack);
                divide_facts(left, right)
            }
            K::Pow { left, right } => {
                let base = self.infer_expr(region_id, left, locals, call_stack);
                let exponent = self.infer_expr(region_id, right, locals, call_stack);
                self.expect_dimensionless(
                    region_id,
                    right.span,
                    DimensionOperation::FunctionArgument,
                    &exponent,
                );
                if let Some((numerator, denominator)) = literal_rational(right) {
                    power_fact(base, numerator, denominator)
                } else if uniform_dimension(&base).is_some_and(|value| value.is_dimensionless()) {
                    scalar_dimensionless()
                } else {
                    DimensionFact::Unknown
                }
            }
            K::In { left, right } => {
                let left = self.infer_expr(region_id, left, locals, call_stack);
                let right = self.infer_expr(region_id, right, locals, call_stack);
                self.check_compatible(
                    region_id,
                    expr.span,
                    DimensionOperation::Compare,
                    &left,
                    &right,
                );
                scalar_dimensionless()
            }
            K::And { left, right } | K::Or { left, right } | K::Xor { left, right } | K::Gap { left, right } => {
                for operand in [left.as_ref(), right.as_ref()] {
                    let fact = self.infer_expr(region_id, operand, locals, call_stack);
                    self.expect_dimensionless(
                        region_id,
                        operand.span,
                        DimensionOperation::Boolean,
                        &fact,
                    );
                }
                scalar_dimensionless()
            }
            K::Root { index, radicand } => {
                let radicand = self.infer_expr(region_id, radicand, locals, call_stack);
                let degree = if let Some(index) = index {
                    let index_fact = self.infer_expr(region_id, index, locals, call_stack);
                    self.expect_dimensionless(
                        region_id,
                        index.span,
                        DimensionOperation::FunctionArgument,
                        &index_fact,
                    );
                    literal_rational(index)
                } else {
                    Some((2, 1))
                };
                match degree {
                    Some((0, _)) | None => DimensionFact::Unknown,
                    Some((numerator, denominator)) => power_fact(radicand, denominator, numerator),
                }
            }
            K::Call { callee, args } => {
                self.infer_call(region_id, callee, args, locals, call_stack)
            }
            K::JuliaCall { args, .. } => {
                for arg in args {
                    self.infer_arg(region_id, arg, locals, call_stack);
                }
                DimensionFact::Unknown
            }
            K::Index { base, indices } => {
                let base = self.infer_expr(region_id, base, locals, call_stack);
                for index in indices {
                    let fact = self.infer_expr(region_id, index, locals, call_stack);
                    self.expect_dimensionless(
                        region_id,
                        index.span,
                        DimensionOperation::Index,
                        &fact,
                    );
                }
                uniform_dimension(&base)
                    .map(DimensionFact::Scalar)
                    .unwrap_or(DimensionFact::Unknown)
            }
            K::Column { base, index } | K::Row { base, index } => {
                let base = self.infer_expr(region_id, base, locals, call_stack);
                let index_fact = self.infer_expr(region_id, index, locals, call_stack);
                self.expect_dimensionless(
                    region_id,
                    index.span,
                    DimensionOperation::Index,
                    &index_fact,
                );
                uniform_dimension(&base)
                    .map(DimensionFact::Scalar)
                    .unwrap_or(DimensionFact::Unknown)
            }
            K::PrimeDeriv { .. } => DimensionFact::Unknown,
            K::Matrix { rows, cols, cells } => DimensionFact::Matrix {
                rows: *rows,
                cols: *cols,
                cells: cells
                    .iter()
                    .map(
                        |cell| match self.infer_expr(region_id, cell, locals, call_stack) {
                            DimensionFact::Scalar(dimension) => Some(dimension),
                            DimensionFact::Unknown | DimensionFact::Matrix { .. } => None,
                        },
                    )
                    .collect(),
            },
            K::Range {
                first,
                second,
                last,
            } => {
                let first_fact = self.infer_expr(region_id, first, locals, call_stack);
                if let Some(second) = second {
                    let second_fact = self.infer_expr(region_id, second, locals, call_stack);
                    self.check_compatible(
                        region_id,
                        second.span,
                        DimensionOperation::Range,
                        &first_fact,
                        &second_fact,
                    );
                }
                let last_fact = self.infer_expr(region_id, last, locals, call_stack);
                self.check_compatible(
                    region_id,
                    last.span,
                    DimensionOperation::Range,
                    &first_fact,
                    &last_fact,
                );
                first_fact
            }
            K::Sum {
                var, bounds, body, ..
            } => {
                let nested = self.locals_with_bound(
                    region_id,
                    locals,
                    &var.name,
                    bounds.as_ref().map(|bounds| bounds.lo.as_ref()),
                    call_stack,
                );
                self.infer_expr(region_id, body, &nested, call_stack)
            }
            K::Prod { .. } => DimensionFact::Unknown,
            K::Integral {
                var,
                bounds,
                domain,
                body,
                ..
            } => {
                if domain.is_some() {
                    let _ = self.infer_expr(region_id, body, locals, call_stack);
                    return DimensionFact::Unknown;
                }
                let variable = bounds.as_ref().and_then(|bounds| {
                    scalar_of(&self.infer_expr(region_id, &bounds.lo, locals, call_stack))
                });
                let nested = self.locals_with_fact(locals, &var.name, variable.clone());
                let body = self.infer_expr(region_id, body, &nested, call_stack);
                match (body, variable) {
                    (DimensionFact::Scalar(body), Some(variable)) => {
                        DimensionFact::Scalar(body.multiplied_by(&variable))
                    }
                    _ => DimensionFact::Unknown,
                }
            }
            // A column of derivatives whose units may differ per row.
            K::Gradient { body, .. } => {
                self.infer_expr(region_id, body, locals, call_stack);
                DimensionFact::Unknown
            }
            K::Deriv {
                var,
                var_expr,
                order,
                body,
            }
            | K::Partial {
                var,
                var_expr,
                order,
                body,
            } => {
                let body = self.infer_expr(region_id, body, locals, call_stack);
                if var_expr.is_some() {
                    return DimensionFact::Unknown;
                }
                let variable = locals.get(&LocalKey::variable(&var.name)).cloned();
                let order = order
                    .as_deref()
                    .and_then(literal_rational)
                    .unwrap_or((1, 1));
                match (body, variable.and_then(|fact| scalar_of(&fact))) {
                    (DimensionFact::Scalar(body), Some(variable)) if order.1 == 1 => {
                        DimensionFact::Scalar(body.divided_by(&variable.powered(order.0, 1)))
                    }
                    _ => DimensionFact::Unknown,
                }
            }
            K::Limit {
                var, target, body, ..
            } => {
                let target = self.infer_expr(region_id, target, locals, call_stack);
                let nested = self.locals_with_fact(locals, &var.name, scalar_of(&target));
                self.infer_expr(region_id, body, &nested, call_stack)
            }
            K::Program { body } => self.infer_program(region_id, body, locals, call_stack),
        }
    }

    fn infer_compatible_binary(
        &mut self,
        region_id: &str,
        span: Span,
        operation: DimensionOperation,
        operands: (&Expr, &Expr),
        locals: &HashMap<LocalKey, DimensionFact>,
        call_stack: &mut HashSet<DefinitionKey>,
    ) -> DimensionFact {
        let left = self.infer_expr(region_id, operands.0, locals, call_stack);
        let right = self.infer_expr(region_id, operands.1, locals, call_stack);
        self.check_compatible(region_id, span, operation, &left, &right);
        merge_compatible(left, right)
    }

    fn infer_name(
        &self,
        region_id: &str,
        span: Span,
        name: &Name,
        locals: &HashMap<LocalKey, DimensionFact>,
    ) -> DimensionFact {
        if let Some(fact) = locals.get(&LocalKey::variable(name)) {
            return fact.clone();
        }
        let reference = ReferenceKey {
            region_id: region_id.to_owned(),
            start: span.start,
            end: span.end,
            name: name.clone(),
        };
        if let Some(definition) = self.references.get(&reference) {
            return self
                .definition_facts
                .get(definition)
                .cloned()
                .unwrap_or(DimensionFact::Unknown);
        }
        // only an explicit unit label makes a unit in a value position; a plain name is
        // a unit only in a unit context (the unit override of an evaluation).
        if name.label == Some(Label::Unit) || (name.label.is_none() && self.unit_context) {
            if let Some(text) = simple_name_text(name) {
                if let Some(dimension) = unit_dimension(text) {
                    return DimensionFact::Scalar(dimension);
                }
            }
        }
        if matches!(name.label, None | Some(Label::Const)) {
            if let Some(exponents) =
                crate::constants::constant_name(name).and_then(crate::constants::constant_exponents)
            {
                return DimensionFact::Scalar(dimension_of(exponents));
            }
        }
        if matches!(name.label, Some(Label::Const | Label::Sys))
            || simple_name_text(name).is_some_and(is_dimensionless_constant)
        {
            return scalar_dimensionless();
        }
        DimensionFact::Unknown
    }

    fn infer_call(
        &mut self,
        region_id: &str,
        callee: &Expr,
        args: &[Arg],
        locals: &HashMap<LocalKey, DimensionFact>,
        call_stack: &mut HashSet<DefinitionKey>,
    ) -> DimensionFact {
        let facts: Vec<_> = args
            .iter()
            .map(|arg| self.infer_arg(region_id, arg, locals, call_stack))
            .collect();
        if let ExprKind::Ident { name } = &callee.kind {
            let reference = ReferenceKey {
                region_id: region_id.to_owned(),
                start: callee.span.start,
                end: callee.span.end,
                name: name.clone(),
            };
            if let Some(key) = self.references.get(&reference).cloned() {
                if let Some(function) = self.functions.get(&key).cloned() {
                    if !call_stack.insert(key.clone()) {
                        return DimensionFact::Unknown;
                    }
                    let mut function_locals = HashMap::default();
                    for (parameter, fact) in function.params.iter().zip(facts) {
                        function_locals.insert(LocalKey::variable(parameter), fact);
                    }
                    let result = self.infer_expr(
                        &function.region_id,
                        &function.body,
                        &function_locals,
                        call_stack,
                    );
                    call_stack.remove(&key);
                    return result;
                }
            }
            if let Some(name) = simple_name_text(name) {
                return self.infer_builtin(region_id, callee.span, name, &facts);
            }
        }
        DimensionFact::Unknown
    }

    fn infer_arg(
        &mut self,
        region_id: &str,
        arg: &Arg,
        locals: &HashMap<LocalKey, DimensionFact>,
        call_stack: &mut HashSet<DefinitionKey>,
    ) -> DimensionFact {
        match arg {
            Arg::Expr { expr } => self.infer_expr(region_id, expr, locals, call_stack),
            Arg::InlineDef { value, .. } => self.infer_expr(region_id, value, locals, call_stack),
        }
    }

    fn infer_builtin(
        &mut self,
        region_id: &str,
        span: Span,
        name: &str,
        facts: &[DimensionFact],
    ) -> DimensionFact {
        match name {
            "sin" | "cos" | "tan" | "asin" | "acos" | "atan" | "atan2" | "sinh" | "cosh"
            | "tanh" | "exp" | "ln" | "log" | "log10" => {
                for fact in facts {
                    self.expect_dimensionless(
                        region_id,
                        span,
                        DimensionOperation::FunctionArgument,
                        fact,
                    );
                }
                scalar_dimensionless()
            }
            "rows" | "cols" | "length" | "last" | "rank" | "IsScalar" | "IsArray" | "IsString" => {
                scalar_dimensionless()
            }
            "max" | "min" | "mean" | "median" | "mode" | "stdev" | "Stdev" => {
                if let Some(first) = facts.first() {
                    for other in &facts[1..] {
                        self.check_compatible(
                            region_id,
                            span,
                            DimensionOperation::FunctionArgument,
                            first,
                            other,
                        );
                    }
                    first.clone()
                } else {
                    DimensionFact::Unknown
                }
            }
            "var" | "Var" => facts
                .first()
                .cloned()
                .map(|fact| power_fact(fact, 2, 1))
                .unwrap_or(DimensionFact::Unknown),
            _ => DimensionFact::Unknown,
        }
    }

    fn check_compatible(
        &mut self,
        region_id: &str,
        span: Span,
        operation: DimensionOperation,
        left: &DimensionFact,
        right: &DimensionFact,
    ) {
        if let Some((left, right)) = first_mismatch(left, right) {
            self.warnings.push(DimensionWarning {
                region_id: region_id.to_owned(),
                span,
                kind: DimensionWarningKind::Mismatch {
                    operation,
                    left,
                    right,
                },
            });
        }
    }

    fn expect_dimensionless(
        &mut self,
        region_id: &str,
        span: Span,
        operation: DimensionOperation,
        fact: &DimensionFact,
    ) {
        if let Some(actual) = uniform_dimension(fact) {
            if !actual.is_dimensionless() {
                self.warnings.push(DimensionWarning {
                    region_id: region_id.to_owned(),
                    span,
                    kind: DimensionWarningKind::ExpectedDimensionless { operation, actual },
                });
            }
        }
    }

    fn locals_with_bound(
        &mut self,
        region_id: &str,
        locals: &HashMap<LocalKey, DimensionFact>,
        name: &Name,
        bound: Option<&Expr>,
        call_stack: &mut HashSet<DefinitionKey>,
    ) -> HashMap<LocalKey, DimensionFact> {
        let fact = bound
            .map(|bound| self.infer_expr(region_id, bound, locals, call_stack))
            .and_then(|fact| scalar_of(&fact));
        self.locals_with_fact(locals, name, fact)
    }

    fn locals_with_fact(
        &self,
        locals: &HashMap<LocalKey, DimensionFact>,
        name: &Name,
        fact: Option<Dimension>,
    ) -> HashMap<LocalKey, DimensionFact> {
        let mut nested = locals.clone();
        nested.insert(
            LocalKey::variable(name),
            fact.map(DimensionFact::Scalar)
                .unwrap_or(DimensionFact::Unknown),
        );
        nested
    }

    fn infer_program(
        &mut self,
        region_id: &str,
        statements: &[Stmt],
        outer: &HashMap<LocalKey, DimensionFact>,
        call_stack: &mut HashSet<DefinitionKey>,
    ) -> DimensionFact {
        let mut locals = outer.clone();
        let mut result = DimensionFact::Unknown;
        for statement in statements {
            match &statement.kind {
                StmtKind::LocalDef { target, rhs } => {
                    let fact = self.infer_expr(region_id, rhs, &locals, call_stack);
                    for (name, target_fact) in target_facts(target, &fact) {
                        locals.insert(LocalKey::variable(&name), target_fact);
                    }
                    result = fact;
                }
                StmtKind::ExprStmt { expr } | StmtKind::Return { expr } => {
                    result = self.infer_expr(region_id, expr, &locals, call_stack);
                }
                StmtKind::While { cond, body } => {
                    let condition = self.infer_expr(region_id, cond, &locals, call_stack);
                    self.expect_dimensionless(
                        region_id,
                        cond.span,
                        DimensionOperation::Boolean,
                        &condition,
                    );
                    result = self.infer_program(region_id, body, &locals, call_stack);
                }
                StmtKind::For { var, source, body } => {
                    let source = self.infer_expr(region_id, source, &locals, call_stack);
                    let nested = self.locals_with_fact(&locals, &var.name, scalar_of(&source));
                    result = self.infer_program(region_id, body, &nested, call_stack);
                }
                StmtKind::If {
                    branches,
                    else_body,
                } => {
                    let mut branch_results = Vec::new();
                    for branch in branches {
                        let condition =
                            self.infer_expr(region_id, &branch.cond, &locals, call_stack);
                        self.expect_dimensionless(
                            region_id,
                            branch.cond.span,
                            DimensionOperation::Boolean,
                            &condition,
                        );
                        branch_results.push(self.infer_program(
                            region_id,
                            &branch.body,
                            &locals,
                            call_stack,
                        ));
                    }
                    if let Some(body) = else_body {
                        branch_results
                            .push(self.infer_program(region_id, body, &locals, call_stack));
                    }
                    result = merge_branches(branch_results);
                }
                StmtKind::Try { body, handler } => {
                    result = merge_branches(vec![
                        self.infer_program(region_id, body, &locals, call_stack),
                        self.infer_program(region_id, handler, &locals, call_stack),
                    ]);
                }
                StmtKind::Break | StmtKind::Continue => {}
            }
        }
        result
    }
}

fn scalar_dimensionless() -> DimensionFact {
    DimensionFact::Scalar(Dimension::dimensionless())
}

fn scalar_of(fact: &DimensionFact) -> Option<Dimension> {
    match fact {
        DimensionFact::Scalar(dimension) => Some(dimension.clone()),
        DimensionFact::Unknown | DimensionFact::Matrix { .. } => None,
    }
}

fn uniform_dimension(fact: &DimensionFact) -> Option<Dimension> {
    match fact {
        DimensionFact::Scalar(dimension) => Some(dimension.clone()),
        DimensionFact::Matrix { cells, .. } => {
            let first = cells.first()?.as_ref()?;
            cells
                .iter()
                .all(|cell| cell.as_ref() == Some(first))
                .then(|| first.clone())
        }
        DimensionFact::Unknown => None,
    }
}

fn first_mismatch(left: &DimensionFact, right: &DimensionFact) -> Option<(Dimension, Dimension)> {
    match (left, right) {
        (DimensionFact::Scalar(left), DimensionFact::Scalar(right)) if left != right => {
            Some((left.clone(), right.clone()))
        }
        (
            DimensionFact::Matrix {
                rows: left_rows,
                cols: left_cols,
                cells: left,
            },
            DimensionFact::Matrix {
                rows: right_rows,
                cols: right_cols,
                cells: right,
            },
        ) if left_rows == right_rows && left_cols == right_cols => {
            left.iter()
                .zip(right)
                .find_map(|(left, right)| match (left, right) {
                    (Some(left), Some(right)) if left != right => {
                        Some((left.clone(), right.clone()))
                    }
                    _ => None,
                })
        }
        _ => None,
    }
}

fn merge_compatible(left: DimensionFact, right: DimensionFact) -> DimensionFact {
    match (left, right) {
        (DimensionFact::Scalar(left), DimensionFact::Scalar(right)) if left == right => {
            DimensionFact::Scalar(left)
        }
        (
            DimensionFact::Matrix {
                rows: left_rows,
                cols: left_cols,
                cells: left,
            },
            DimensionFact::Matrix {
                rows: right_rows,
                cols: right_cols,
                cells: right,
            },
        ) if left_rows == right_rows && left_cols == right_cols => DimensionFact::Matrix {
            rows: left_rows,
            cols: left_cols,
            cells: left
                .into_iter()
                .zip(right)
                .map(|(left, right)| (left == right).then_some(left).flatten())
                .collect(),
        },
        _ => DimensionFact::Unknown,
    }
}

fn multiply_facts(left: DimensionFact, right: DimensionFact) -> DimensionFact {
    map_binary_dimensions(left, right, Dimension::multiplied_by, false)
}

fn divide_facts(left: DimensionFact, right: DimensionFact) -> DimensionFact {
    map_binary_dimensions(left, right, Dimension::divided_by, true)
}

fn map_binary_dimensions(
    left: DimensionFact,
    right: DimensionFact,
    operation: fn(&Dimension, &Dimension) -> Dimension,
    elementwise: bool,
) -> DimensionFact {
    match (left, right) {
        (DimensionFact::Scalar(left), DimensionFact::Scalar(right)) => {
            DimensionFact::Scalar(operation(&left, &right))
        }
        (DimensionFact::Scalar(scalar), DimensionFact::Matrix { rows, cols, cells }) => {
            DimensionFact::Matrix {
                rows,
                cols,
                cells: cells
                    .into_iter()
                    .map(|cell| cell.map(|cell| operation(&scalar, &cell)))
                    .collect(),
            }
        }
        (DimensionFact::Matrix { rows, cols, cells }, DimensionFact::Scalar(scalar)) => {
            DimensionFact::Matrix {
                rows,
                cols,
                cells: cells
                    .into_iter()
                    .map(|cell| cell.map(|cell| operation(&cell, &scalar)))
                    .collect(),
            }
        }
        (
            DimensionFact::Matrix {
                rows: left_rows,
                cols: left_cols,
                cells: left_cells,
            },
            DimensionFact::Matrix {
                rows: right_rows,
                cols: right_cols,
                cells: right_cells,
            },
        ) if elementwise && left_rows == right_rows && left_cols == right_cols => {
            DimensionFact::Matrix {
                rows: left_rows,
                cols: left_cols,
                cells: left_cells
                    .into_iter()
                    .zip(right_cells)
                    .map(|(left, right)| match (left, right) {
                        (Some(left), Some(right)) => Some(operation(&left, &right)),
                        _ => None,
                    })
                    .collect(),
            }
        }
        (left @ DimensionFact::Matrix { .. }, right @ DimensionFact::Matrix { .. }) => {
            match (
                uniform_dimension(&left),
                uniform_dimension(&right),
                left,
                right,
            ) {
                (
                    Some(left_dimension),
                    Some(right_dimension),
                    DimensionFact::Matrix {
                        rows,
                        cols: left_cols,
                        ..
                    },
                    DimensionFact::Matrix {
                        rows: right_rows,
                        cols,
                        ..
                    },
                ) if left_cols == right_rows => DimensionFact::Matrix {
                    rows,
                    cols,
                    cells: vec![Some(operation(&left_dimension, &right_dimension)); rows * cols],
                },
                _ => DimensionFact::Unknown,
            }
        }
        _ => DimensionFact::Unknown,
    }
}

fn power_fact(fact: DimensionFact, numerator: i32, denominator: i32) -> DimensionFact {
    match fact {
        DimensionFact::Scalar(dimension) => {
            DimensionFact::Scalar(dimension.powered(numerator, denominator))
        }
        DimensionFact::Matrix { rows, cols, cells } => DimensionFact::Matrix {
            rows,
            cols,
            cells: cells
                .into_iter()
                .map(|cell| cell.map(|dimension| dimension.powered(numerator, denominator)))
                .collect(),
        },
        DimensionFact::Unknown => DimensionFact::Unknown,
    }
}

fn determinant_dimension(fact: DimensionFact) -> DimensionFact {
    match fact {
        DimensionFact::Scalar(dimension) => DimensionFact::Scalar(dimension),
        matrix @ DimensionFact::Matrix { rows, cols, .. } if rows == cols => {
            uniform_dimension(&matrix)
                .map(|dimension| DimensionFact::Scalar(dimension.powered(rows as i32, 1)))
                .unwrap_or(DimensionFact::Unknown)
        }
        DimensionFact::Unknown | DimensionFact::Matrix { .. } => DimensionFact::Unknown,
    }
}

fn target_facts(target: &Target, fact: &DimensionFact) -> Vec<(Name, DimensionFact)> {
    match &target.kind {
        TargetKind::Invalid { .. } => Vec::new(),
        TargetKind::Ident { name } => vec![(name.clone(), fact.clone())],
        TargetKind::Paren { target } => target_facts(target, fact),
        // The transpose of the value: its shape is not followed.
        TargetKind::Transpose { target } => target_facts(target, &DimensionFact::Unknown),
        TargetKind::Destructure { cells, .. } => {
            let dimensions = match fact {
                DimensionFact::Matrix { cells, .. } => cells.clone(),
                _ => vec![None; cells.len()],
            };
            cells
                .iter()
                .zip(dimensions.into_iter().chain(std::iter::repeat(None)))
                .flat_map(|(target, dimension)| {
                    target_facts(
                        target,
                        &dimension
                            .map(DimensionFact::Scalar)
                            .unwrap_or(DimensionFact::Unknown),
                    )
                })
                .collect()
        }
        TargetKind::Index { base, .. }
        | TargetKind::Column { base, .. }
        | TargetKind::Row { base, .. } => target_facts(base, &DimensionFact::Unknown),
        TargetKind::FunctionHead { .. } => Vec::new(),
    }
}

fn merge_branches(facts: Vec<DimensionFact>) -> DimensionFact {
    let mut facts = facts.into_iter();
    let Some(first) = facts.next() else {
        return DimensionFact::Unknown;
    };
    if facts.all(|fact| fact == first) {
        first
    } else {
        DimensionFact::Unknown
    }
}

fn simple_name_text(name: &Name) -> Option<&str> {
    match name.segments.as_slice() {
        [segment] if !segment.subscript => Some(&segment.text),
        _ => None,
    }
}

fn is_dimensionless_constant(name: &str) -> bool {
    matches!(
        name,
        "π" | "pi" | "e" | "∞" | "NaN" | "ORIGIN" | "TOL" | "CTOL"
    )
}

fn unit_dimension(name: &str) -> Option<Dimension> {
    crate::units::unit_exponents(name).map(dimension_of)
}

fn dimension_of(exponents: crate::units::UnitExponents) -> Dimension {
    let mut dimension = Dimension::dimensionless();
    for (slot, exponent) in dimension.exponents.iter_mut().zip(exponents) {
        *slot = RationalExponent::new(i32::from(exponent), 1);
    }
    dimension
}

fn literal_rational(expr: &Expr) -> Option<(i32, i32)> {
    match &expr.kind {
        ExprKind::Num { text } => decimal_rational(text),
        ExprKind::Neg { expr } => decimal_rational(match &expr.kind {
            ExprKind::Num { text } => text,
            _ => return None,
        })
        .map(|(numerator, denominator)| (-numerator, denominator)),
        ExprKind::Paren { expr } => literal_rational(expr),
        ExprKind::Div { left, right } | ExprKind::InlineDiv { left, right, .. } => {
            let (left_numerator, left_denominator) = literal_rational(left)?;
            let (right_numerator, right_denominator) = literal_rational(right)?;
            (right_numerator != 0).then(|| {
                let reduced = RationalExponent::new(
                    left_numerator * right_denominator,
                    left_denominator * right_numerator,
                );
                (reduced.numerator, reduced.denominator as i32)
            })
        }
        _ => None,
    }
}

fn decimal_rational(text: &str) -> Option<(i32, i32)> {
    let (mantissa, exponent) = if let Some((mantissa, exponent)) = text.split_once(['e', 'E']) {
        (mantissa, exponent.parse::<i32>().ok()?)
    } else {
        (text, 0_i32)
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{whole}{fraction}");
    let mut numerator = digits.parse::<i32>().ok()?;
    let mut denominator = 10_i32.checked_pow(fraction.len() as u32)?;
    if exponent >= 0 {
        numerator = numerator.checked_mul(10_i32.checked_pow(exponent as u32)?)?;
    } else {
        denominator = denominator.checked_mul(10_i32.checked_pow((-exponent) as u32)?)?;
    }
    let reduced = RationalExponent::new(numerator, denominator);
    Some((reduced.numerator, reduced.denominator as i32))
}
