//! Library-independent plot document model.
//!
//! Calculated arrays and renderer state are deliberately absent: a worksheet stores only
//! expressions, axes, presentation and its physical size.

use crate::ast::{Expr, ExprKind, Name, Statement, StatementKind};
use crate::fasthash::HashSet;
use crate::graph::Region;
use crate::kernel_value::{DimensionComponent, KernelValue, MatrixStorage, QuantityMagnitude};
use crate::{parse_expression, parse_statement};
use serde::{Deserialize, Serialize};

pub const PLOT_VERSION: u32 = 1;
pub const DEFAULT_PLOT_WIDTH: f64 = 360.0;
pub const DEFAULT_PLOT_HEIGHT: f64 = 220.0;
pub const MIN_PLOT_WIDTH: f64 = 144.0;
pub const MIN_PLOT_HEIGHT: f64 = 108.0;
/// Above this many points a trace is reduced for display.
pub const DOWNSAMPLE_THRESHOLD: usize = 1_000_000;
/// Buckets of the reduction: at most twice this many points remain.
pub const DOWNSAMPLE_BUCKETS: usize = 100_000;
/// Default x-axis interval for traces with an undefined x expression.
pub const IMPLICIT_X_DEFAULT_MIN: f64 = -10.0;
pub const IMPLICIT_X_DEFAULT_MAX: f64 = 10.0;
pub const IMPLICIT_X_POINTS: usize = 501;
/// The default interval of an undefined polar angle variable: one full turn.
pub const IMPLICIT_ANGLE_MAX: f64 = std::f64::consts::TAU;

fn plot_version() -> u32 {
    PLOT_VERSION
}

fn default_plot_size() -> [f64; 2] {
    [DEFAULT_PLOT_WIDTH, DEFAULT_PLOT_HEIGHT]
}

fn default_show_grid() -> bool {
    true
}

fn default_show_in_legend() -> bool {
    true
}

fn default_hide_reference_legend() -> bool {
    false
}

fn is_false(value: &bool) -> bool {
    !value
}

fn is_true(value: &bool) -> bool {
    *value
}

fn default_axis_box() -> Box<PlotAxis> {
    Box::new(PlotAxis::default())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlotKind {
    Xy,
    Polar,
    Contour,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AxisScale {
    #[default]
    Linear,
    Log10,
}

/// One end of a numeric axis: a number, or a math expression the session calculates at the
/// plot's place in reading order.
///
/// A limit typed as a plain number is stored as a number, so a worksheet written before
/// expression limits existed reads unchanged. An expression is the canonical linear math text
/// of the limit, which is what the worksheet file keeps and what the math
/// editor shows.
#[derive(Debug, Clone, PartialEq)]
pub enum AxisLimit {
    Value(f64),
    Expression(String),
}

impl AxisLimit {
    /// The stored number, for a numeric limit.
    pub fn value(&self) -> Option<f64> {
        match self {
            AxisLimit::Value(value) => Some(*value),
            AxisLimit::Expression(_) => None,
        }
    }

    /// The stored math text, for an expression limit.
    pub fn expression(&self) -> Option<&str> {
        match self {
            AxisLimit::Value(_) => None,
            AxisLimit::Expression(text) => Some(text),
        }
    }
}

impl Serialize for AxisLimit {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            AxisLimit::Value(value) => serializer.serialize_f64(*value),
            AxisLimit::Expression(text) => serializer.serialize_str(text),
        }
    }
}

impl<'de> Deserialize<'de> for AxisLimit {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct LimitVisitor;

        impl serde::de::Visitor<'_> for LimitVisitor {
            type Value = AxisLimit;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a number or a math expression in a string")
            }

            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<AxisLimit, E> {
                Ok(AxisLimit::Value(value))
            }

            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<AxisLimit, E> {
                Ok(AxisLimit::Value(value as f64))
            }

            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<AxisLimit, E> {
                Ok(AxisLimit::Value(value as f64))
            }

            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<AxisLimit, E> {
                Ok(AxisLimit::Expression(value.to_owned()))
            }
        }

        deserializer.deserialize_any(LimitVisitor)
    }
}

/// Where a numeric axis is drawn: on the edge of the plot area, or
/// through the zero of the axis it crosses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlotAxisPosition {
    /// The edge of the plot area: how every axis was drawn before this field existed.
    #[default]
    Boundary,
    /// Through the zero of the axis it crosses, clamped to the plot area when zero is outside it.
    Origin,
}

/// Whether an axis is drawn on the boundary, the value the worksheet file omits.
fn is_boundary_position(position: &PlotAxisPosition) -> bool {
    *position == PlotAxisPosition::Boundary
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotAxis {
    #[serde(default)]
    pub scale: AxisScale,
    /// Where the axis line is drawn. Omitted from the file while it is `boundary`, so a
    /// worksheet written before the field existed reads and writes unchanged.
    #[serde(default, skip_serializing_if = "is_boundary_position")]
    pub position: PlotAxisPosition,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub min: Option<AxisLimit>,
    #[serde(default)]
    pub max: Option<AxisLimit>,
    #[serde(default)]
    pub title: String,
    #[serde(default = "default_show_grid")]
    pub show_grid: bool,
}

impl Default for PlotAxis {
    fn default() -> Self {
        PlotAxis {
            scale: AxisScale::Linear,
            position: PlotAxisPosition::Boundary,
            unit: None,
            min: None,
            max: None,
            title: String::new(),
            show_grid: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotAxes {
    #[serde(default)]
    pub x: PlotAxis,
    #[serde(default)]
    pub y: PlotAxis,
    #[serde(default = "default_axis_box")]
    pub y2: Box<PlotAxis>,
}

impl Default for PlotAxes {
    fn default() -> Self {
        Self {
            x: PlotAxis::default(),
            y: PlotAxis::default(),
            y2: default_axis_box(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TracePresentation {
    #[default]
    Line,
    Markers,
    #[serde(rename = "line+markers")]
    LineMarkers,
}

/// What a trace draws at each of its points. Independent of the presentation
/// ([`TracePresentation`]), which says which parts of the trace — the line, the markers or both —
/// are drawn: a marker-only stem trace draws the markers at the tops of the stems and no segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TraceKind {
    /// Adjacent points joined by a line: what every worksheet written before trace types draws.
    #[default]
    Lines,
    /// A segment from the trace's base to each point, with the markers of the presentation.
    Stems,
    /// A filled bar from the trace's base to each point, with the markers of the presentation.
    Bars,
    /// A horizontal-then-vertical step line through the points.
    Steps,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TraceYAxis {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TraceLinePattern {
    #[default]
    Solid,
    Dash,
    Dot,
    /// `dashdot`, not the `dash_dot` that `snake_case` would give: the name the spec,
    /// the worksheet writer and the frontend use.
    #[serde(rename = "dashdot")]
    DashDot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TraceLineStyle {
    pub style: TraceLinePattern,
    pub width: f64,
    pub color: Option<String>,
}

impl Default for TraceLineStyle {
    fn default() -> Self {
        Self {
            style: TraceLinePattern::Solid,
            width: 1.5,
            color: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TraceMarkerShape {
    #[default]
    Circle,
    Square,
    Diamond,
    Cross,
    X,
    TriangleUp,
    TriangleDown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TraceMarkerStyle {
    pub shape: TraceMarkerShape,
    pub size: f64,
    pub color: Option<String>,
}

impl Default for TraceMarkerStyle {
    fn default() -> Self {
        Self {
            shape: TraceMarkerShape::Circle,
            size: 5.0,
            color: None,
        }
    }
}

/// Which numeric axis of a plot a limit belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AxisKind {
    X,
    Y,
    Y2,
}

impl AxisKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AxisKind::X => "x",
            AxisKind::Y => "y",
            AxisKind::Y2 => "y2",
        }
    }

    /// The three axes, in the order a plot reports them.
    pub const ALL: [AxisKind; 3] = [AxisKind::X, AxisKind::Y, AxisKind::Y2];
}

/// Which end of an axis a limit is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitBound {
    Min,
    Max,
}

impl LimitBound {
    pub fn as_str(self) -> &'static str {
        match self {
            LimitBound::Min => "min",
            LimitBound::Max => "max",
        }
    }
}

impl PlotAxes {
    /// The axis `kind` names.
    pub fn get(&self, kind: AxisKind) -> &PlotAxis {
        match kind {
            AxisKind::X => &self.x,
            AxisKind::Y => &self.y,
            AxisKind::Y2 => &self.y2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotTrace {
    pub id: String,
    pub x: String,
    pub y: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub z: String,
    #[serde(default)]
    pub y_axis: TraceYAxis,
    #[serde(default)]
    pub presentation: TracePresentation,
    /// What the trace draws at each point; omitted from the file while it is `lines`, so
    /// a worksheet written before trace types existed stays byte-identical. The file key is
    /// `type`, the name `the specification` and `the specification` use.
    #[serde(
        rename = "type",
        default,
        skip_serializing_if = "is_default_trace_kind"
    )]
    pub kind: TraceKind,
    #[serde(default, skip_serializing_if = "is_default_line_style")]
    pub line: TraceLineStyle,
    #[serde(default, skip_serializing_if = "is_default_marker_style")]
    pub marker: TraceMarkerStyle,
    #[serde(default = "default_show_in_legend", skip_serializing_if = "is_true")]
    pub show_in_legend: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub legend_label: String,
}

/// A fixed XY reference line stored in the plot specification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotReferenceLine {
    pub id: String,
    pub axis: AxisKind,
    pub value: AxisLimit,
    #[serde(default, skip_serializing_if = "is_default_line_style")]
    pub line: TraceLineStyle,
    #[serde(
        default = "default_hide_reference_legend",
        skip_serializing_if = "is_false"
    )]
    pub show_in_legend: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub legend_label: String,
}

fn is_default_trace_kind(value: &TraceKind) -> bool {
    *value == TraceKind::Lines
}
fn is_default_line_style(value: &TraceLineStyle) -> bool {
    value == &TraceLineStyle::default()
}
fn is_default_marker_style(value: &TraceMarkerStyle) -> bool {
    value == &TraceMarkerStyle::default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegendPosition {
    #[default]
    TopRight,
    TopLeft,
    BottomRight,
    BottomLeft,
}

fn is_default_legend_position(value: &LegendPosition) -> bool {
    *value == LegendPosition::default()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotSpec {
    #[serde(default = "plot_version")]
    pub version: u32,
    #[serde(rename = "type")]
    pub kind: PlotKind,
    /// The plot title: literal text drawn above the plot area.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default = "default_plot_size")]
    pub size: [f64; 2],
    #[serde(default)]
    pub axes: PlotAxes,
    /// Shared explicit linear tick spacing; `None` uses Plotly's automatic spacing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid_spacing: Option<f64>,
    #[serde(default, skip_serializing_if = "is_default_legend_position")]
    pub legend_position: LegendPosition,
    /// Legend font size in points; `None` uses the default (12 pt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legend_font_size: Option<f64>,
    pub traces: Vec<PlotTrace>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reference_lines: Vec<PlotReferenceLine>,
}

impl PlotSpec {
    /// A new plot: one trace with two empty placeholders, default axes and size.
    pub fn new_xy() -> PlotSpec {
        PlotSpec {
            version: PLOT_VERSION,
            kind: PlotKind::Xy,
            title: String::new(),
            size: default_plot_size(),
            axes: PlotAxes::default(),
            grid_spacing: None,
            legend_position: LegendPosition::default(),
            legend_font_size: None,
            traces: vec![PlotTrace {
                id: "trace-1".into(),
                x: String::new(),
                y: String::new(),
                z: String::new(),
                y_axis: TraceYAxis::Left,
                presentation: TracePresentation::Line,
                kind: TraceKind::Lines,
                line: TraceLineStyle::default(),
                marker: TraceMarkerStyle::default(),
                // A new trace is hidden from the legend.
                show_in_legend: false,
                legend_label: String::new(),
            }],
            reference_lines: Vec::new(),
        }
    }

    /// The axis-limit expressions of this plot, in evaluation order: x, then y, then y2,
    /// minimum before maximum. These are the hidden limit regions of
    /// [`PlotRegion::expression_regions`], and [`PlotSpec::assemble`] reads their results first.
    pub fn limit_expressions(&self) -> Vec<(AxisKind, LimitBound)> {
        let mut list = Vec::new();
        for kind in AxisKind::ALL {
            let axis = self.axes.get(kind);
            for (bound, limit) in [(LimitBound::Min, &axis.min), (LimitBound::Max, &axis.max)] {
                // `validate` already refused an expression that does not parse, so this filter
                // never drops a stored limit; it keeps the list of regions the analysis builds
                // and the list of results the plot reads the same one, whatever the model holds.
                let readable = limit
                    .as_ref()
                    .and_then(AxisLimit::expression)
                    .is_some_and(|text| {
                        !text.trim().is_empty() && expression_statement(text).is_ok()
                    });
                if readable {
                    list.push((kind, bound));
                }
            }
        }
        list
    }

    /// The axes whose display unit is evaluated as a hidden region of this plot, in evaluation
    /// order: x, then y, then y2 when a trace is drawn against it. These are the hidden
    /// unit regions of [`PlotRegion::expression_regions`], and [`PlotSpec::assemble`] reads their
    /// results before the trace expressions. The list holds an axis only when its unit is stored
    /// and parses: `validate` already refused a unit that does not parse, so this filter keeps the
    /// regions the analysis builds and the results the plot reads the same one, whatever the model
    /// holds.
    pub fn unit_expressions(&self) -> Vec<AxisKind> {
        AxisKind::ALL
            .into_iter()
            .filter(|kind| *kind != AxisKind::Y2 || self.uses_right_axis())
            .filter(|kind| {
                self.axes
                    .get(*kind)
                    .unit
                    .as_deref()
                    .is_some_and(|text| unit_statement(text).is_ok())
            })
            .collect()
    }

    /// The reference-line expressions evaluated by the plot, in stored order.
    /// Numeric values have no hidden region. Lines remain stored but inactive outside XY plots.
    pub fn reference_line_expressions(&self) -> Vec<&PlotReferenceLine> {
        if self.kind != PlotKind::Xy {
            return Vec::new();
        }
        self.reference_lines
            .iter()
            .filter(|line| {
                matches!(line.axis, AxisKind::X | AxisKind::Y)
                    && line.value.expression().is_some_and(|text| {
                        !text.trim().is_empty() && expression_statement(text).is_ok()
                    })
            })
            .collect()
    }

    /// Whether any trace is drawn against the right y axis.
    pub fn uses_right_axis(&self) -> bool {
        self.traces
            .iter()
            .any(|trace| trace.y_axis == TraceYAxis::Right)
    }

    /// Validates the persisted, renderer-independent part of a plot.
    /// Expression ASTs are derived and are not stored in the worksheet.
    pub fn validate(&self) -> Result<(), String> {
        validate_title("plot", &self.title)?;
        if self.version != PLOT_VERSION {
            return Err(format!(
                "unsupported plot version `{}` (this version reads `{PLOT_VERSION}`)",
                self.version
            ));
        }
        for (name, value, minimum) in [
            ("width", self.size[0], MIN_PLOT_WIDTH),
            ("height", self.size[1], MIN_PLOT_HEIGHT),
        ] {
            if !value.is_finite() || value < minimum {
                return Err(format!(
                    "plot {name} must be a finite number at least {minimum} pt"
                ));
            }
        }
        validate_axis("x", &self.axes.x)?;
        validate_axis("y", &self.axes.y)?;
        if self
            .grid_spacing
            .is_some_and(|step| !step.is_finite() || step <= 0.0)
        {
            return Err("plot grid spacing must be a finite positive number".into());
        }
        if self
            .legend_font_size
            .is_some_and(|pt| !pt.is_finite() || !(6.0..=36.0).contains(&pt))
        {
            return Err("plot legend font size must be between 6 and 36 pt".into());
        }
        validate_axis("y2", &self.axes.y2)?;
        if self.traces.is_empty() {
            return Err("a plot needs at least one trace".into());
        }
        let mut ids = HashSet::default();
        for trace in &self.traces {
            if trace.id.trim().is_empty() {
                return Err("a plot trace id cannot be empty".into());
            }
            if !ids.insert(trace.id.as_str()) {
                return Err(format!("duplicate plot trace id `{}`", trace.id));
            }
            validate_trace_style(trace)?;
            for (axis, source) in [("x", &trace.x), ("y", &trace.y), ("z", &trace.z)] {
                // An empty expression is an unfilled placeholder (a new plot has two).
                if source.trim().is_empty() {
                    continue;
                }
                // Plot axes admit a top-level range although ordinary expression entry
                // points do not (math-syntax section 16). A synthetic sheet definition
                // selects that parser context without changing or storing the expression.
                parse_statement(&format!("plot_axis := {source}"))
                    .map_err(|error| format!("trace `{}` {axis} expression: {error}", trace.id))?;
            }
        }
        let mut reference_ids = HashSet::default();
        for line in &self.reference_lines {
            if line.id.trim().is_empty() {
                return Err("a reference line id cannot be empty".into());
            }
            if !reference_ids.insert(line.id.as_str()) {
                return Err(format!("duplicate reference line id `{}`", line.id));
            }
            if !matches!(line.axis, AxisKind::X | AxisKind::Y) {
                return Err(format!("reference line `{}` axis must be x or y", line.id));
            }
            match &line.value {
                AxisLimit::Value(value) if !value.is_finite() => {
                    return Err(format!("reference line `{}` value must be finite", line.id));
                }
                AxisLimit::Value(_) => {}
                AxisLimit::Expression(text) => {
                    if text.trim().is_empty() {
                        return Err(format!("reference line `{}` value is empty", line.id));
                    }
                    expression_statement(text).map_err(|error| {
                        format!("reference line `{}` value `{text}`: {error}", line.id)
                    })?;
                }
            }
            validate_reference_line(line)?;
        }
        Ok(())
    }
}

fn validate_reference_line(line: &PlotReferenceLine) -> Result<(), String> {
    let color = line.line.color.as_deref();
    if color.is_some_and(|value| {
        value.len() != 7
            || !value.starts_with('#')
            || !value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(format!(
            "reference line `{}` color must be #RRGGBB",
            line.id
        ));
    }
    if !line.line.width.is_finite() || !(0.5..=6.0).contains(&line.line.width) {
        return Err(format!(
            "reference line `{}` width must be from 0.5 to 6 pt",
            line.id
        ));
    }
    validate_title(
        &format!("reference line `{}` legend label", line.id),
        &line.legend_label,
    )
}

fn validate_trace_style(trace: &PlotTrace) -> Result<(), String> {
    let valid_color = |color: &str| {
        color.len() == 7
            && color.starts_with('#')
            && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    if !trace.line.width.is_finite() || !(0.5..=6.0).contains(&trace.line.width) {
        return Err(format!(
            "trace `{}` line width must be from 0.5 to 6 pt",
            trace.id
        ));
    }
    if trace
        .line
        .color
        .as_deref()
        .is_some_and(|color| !valid_color(color))
    {
        return Err(format!("trace `{}` line color must be #RRGGBB", trace.id));
    }
    if !trace.marker.size.is_finite() || !(2.0..=20.0).contains(&trace.marker.size) {
        return Err(format!(
            "trace `{}` marker size must be from 2 to 20 px",
            trace.id
        ));
    }
    if trace
        .marker
        .color
        .as_deref()
        .is_some_and(|color| !valid_color(color))
    {
        return Err(format!("trace `{}` marker color must be #RRGGBB", trace.id));
    }
    Ok(())
}

/// A title is one line of literal text: it is drawn on one line of its band, so a line
/// break could not be drawn and is refused rather than silently flattened.
fn validate_title(owner: &str, title: &str) -> Result<(), String> {
    if title.contains('\n') || title.contains('\r') {
        return Err(format!("{owner} title must be a single line of text"));
    }
    Ok(())
}

fn validate_axis(name: &str, axis: &PlotAxis) -> Result<(), String> {
    validate_title(&format!("plot {name}-axis"), &axis.title)?;
    for (bound, limit) in [("minimum", &axis.min), ("maximum", &axis.max)] {
        match limit {
            None => {}
            Some(AxisLimit::Value(value)) => {
                if !value.is_finite() {
                    return Err(format!("plot {name}-axis {bound} must be finite"));
                }
            }
            // A limit expression parses like a trace expression. Its value, its
            // dimension and its ordering are checked by the calculation.
            Some(AxisLimit::Expression(text)) => {
                if text.trim().is_empty() {
                    return Err(format!("plot {name}-axis {bound} expression is empty"));
                }
                expression_statement(text).map_err(|error| {
                    format!("plot {name}-axis {bound} expression `{text}`: {error}")
                })?;
            }
        }
    }
    let typed = |limit: &Option<AxisLimit>| limit.as_ref().and_then(AxisLimit::value);
    if typed(&axis.min)
        .zip(typed(&axis.max))
        .is_some_and(|(min, max)| min >= max)
    {
        return Err(format!(
            "plot {name}-axis minimum must be less than its maximum"
        ));
    }
    if let Some(unit) = &axis.unit {
        parse_expression(unit)
            .map_err(|error| format!("plot {name}-axis unit expression: {error}"))?;
    }
    Ok(())
}

/// A positioned plot region. Width and height live in [`PlotSpec::size`] so the file shape
/// remains the one established by .
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotRegion {
    pub id: String,
    #[serde(default)]
    pub page: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default = "super::project::enabled_by_default")]
    pub enabled: bool,
    pub plot: PlotSpec,
    /// The transient x range this plot is showing on screen: screen-only state, so a
    /// worksheet never stores it and changing it is never an undo step.
    #[serde(skip)]
    pub view: Option<ViewRange>,
}

/// The on-screen x range of an XY plot: the sample interval of every implicit x trace once the
/// user has navigated the plot. Not part of the stored specification.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewRange {
    pub min: f64,
    pub max: f64,
}

impl ViewRange {
    /// The range as a sample interval, or `None` for something that is not one (not finite, not
    /// increasing, or absent): a screen-only value that cannot be used leaves the default interval.
    pub fn sample(min: f64, max: f64) -> Option<ViewRange> {
        (min.is_finite() && max.is_finite() && min < max).then_some(ViewRange { min, max })
    }
}

impl PlotRegion {
    /// A plot region nobody has navigated yet: no on-screen view, so 's default interval.
    pub fn new(id: impl Into<String>, page: u32, x: f64, y: f64, plot: PlotSpec) -> PlotRegion {
        PlotRegion {
            id: id.into(),
            page,
            x,
            y,
            enabled: true,
            plot,
            view: None,
        }
    }
}

// ---------------------------------------------------------------------------------------
// Evaluation: trace expressions are calculated as hidden evaluation regions
// ---------------------------------------------------------------------------------------

/// Which coordinate of a trace an expression produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceAxis {
    X,
    Y,
    Z,
}

impl TraceAxis {
    pub fn as_str(self) -> &'static str {
        match self {
            TraceAxis::X => "x",
            TraceAxis::Y => "y",
            TraceAxis::Z => "z",
        }
    }
}

/// Separates the parts of the id of a hidden trace-expression region. A control character
/// cannot clash with a region id typed by a user.
const EXPRESSION_SEPARATOR: char = '\u{1f}';

/// The id of the hidden evaluation region of one trace expression. The session evaluates
/// it like an ordinary `expr =` region at the plot's position in reading order, so
/// dependency invalidation needs no plot-specific code. It defines no name.
pub fn expression_region_id(plot_id: &str, trace_id: &str, axis: TraceAxis) -> String {
    format!(
        "{plot_id}{EXPRESSION_SEPARATOR}{trace_id}{EXPRESSION_SEPARATOR}{}",
        axis.as_str()
    )
}

/// Whether a region id (of a result key) names a hidden trace expression.
pub fn is_expression_region_id(region_id: &str) -> bool {
    region_id.contains(EXPRESSION_SEPARATOR)
}

/// The id of the hidden evaluation region of one axis-limit expression. It carries the
/// same separator as a trace expression, so [`is_expression_region_id`] and
/// [`expression_plot_id`] treat it the same way and the session needs no plot-specific code.
pub fn limit_region_id(plot_id: &str, axis: AxisKind, bound: LimitBound) -> String {
    format!(
        "{plot_id}{EXPRESSION_SEPARATOR}axis-limit{EXPRESSION_SEPARATOR}{}{EXPRESSION_SEPARATOR}{}",
        axis.as_str(),
        bound.as_str()
    )
}

/// The id of the hidden evaluation region of one axis display unit. It carries the same
/// separator as a trace expression, so [`is_expression_region_id`] and [`expression_plot_id`]
/// treat it the same way and the session needs no plot-specific code.
pub fn unit_region_id(plot_id: &str, axis: AxisKind) -> String {
    format!(
        "{plot_id}{EXPRESSION_SEPARATOR}axis-unit{EXPRESSION_SEPARATOR}{}",
        axis.as_str()
    )
}

/// The hidden evaluation region of one fixed reference-line expression.
pub fn reference_line_region_id(plot_id: &str, line_id: &str) -> String {
    format!("{plot_id}{EXPRESSION_SEPARATOR}reference-line{EXPRESSION_SEPARATOR}{line_id}")
}

/// The plot a hidden trace-expression region id belongs to.
pub fn expression_plot_id(region_id: &str) -> Option<&str> {
    region_id
        .contains(EXPRESSION_SEPARATOR)
        .then(|| region_id.split(EXPRESSION_SEPARATOR).next().unwrap_or(""))
}

/// The id of the hidden region that samples the x-axis for a trace with an undefined x.
pub fn sampling_region_id(plot_id: &str, trace_id: &str) -> String {
    format!("{plot_id}{EXPRESSION_SEPARATOR}{trace_id}{EXPRESSION_SEPARATOR}implicit-x")
}

/// A worksheet identifier that cannot clash with a user identifier in practice.
fn implicit_x_name(plot_id: &str, trace_id: &str) -> String {
    let clean = |value: &str| {
        value
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { 'X' })
            .collect::<String>()
    };
    format!("xSheetPlot{}{}", clean(plot_id), clean(trace_id))
}

/// The sample bounds of an undefined x-axis: a typed numeric limit or the
/// calculated value of an expression limit (`evaluated`, SI magnitudes), otherwise the on-screen
/// view range, otherwise -10..10.
pub fn implicit_x_bounds(
    kind: PlotKind,
    axis: &PlotAxis,
    view: Option<ViewRange>,
    evaluated: [Option<f64>; 2],
) -> (f64, f64) {
    if kind == PlotKind::Polar {
        // A polar angle variable samples one turn (radians); it has no x axis to navigate.
        return (0.0, IMPLICIT_ANGLE_MAX);
    }
    // A limit, numeric or calculated, stays authoritative over the view; a
    // logarithmic axis samples by its numeric limits only.
    let linear = axis.scale != AxisScale::Log10;
    let typed = |limit: &Option<AxisLimit>| limit.as_ref().and_then(AxisLimit::value);
    let calculated = |value: Option<f64>| value.filter(|value| linear && value.is_finite());
    let mut min = typed(&axis.min)
        .or(calculated(evaluated[0]))
        .or(view.map(|view| view.min))
        .unwrap_or(IMPLICIT_X_DEFAULT_MIN);
    let mut max = typed(&axis.max)
        .or(calculated(evaluated[1]))
        .or(view.map(|view| view.max))
        .unwrap_or(IMPLICIT_X_DEFAULT_MAX);
    if axis.scale == AxisScale::Log10 {
        if min <= 0.0 {
            min = 1.0;
        }
        if max <= min {
            max = min * 10.0;
        }
    } else if min >= max || !min.is_finite() || !max.is_finite() {
        min = IMPLICIT_X_DEFAULT_MIN;
        max = IMPLICIT_X_DEFAULT_MAX;
    }
    (min, max)
}

/// The x vector of an undefined x-axis, in the SI magnitudes of its limits.
fn implicit_x_vector(
    kind: PlotKind,
    axis: &PlotAxis,
    view: Option<ViewRange>,
    evaluated: [Option<f64>; 2],
) -> Vector {
    let (min, max) = implicit_x_bounds(kind, axis, view, evaluated);
    let step = (max - min) / (IMPLICIT_X_POINTS.saturating_sub(1) as f64);
    let values = (0..IMPLICIT_X_POINTS)
        .map(|index| min + step * index as f64)
        .collect();
    (values, Vec::new())
}

/// The hidden definition that samples the implicit x interval of a trace.
fn implicit_x_statement(
    plot_id: &str,
    trace_id: &str,
    kind: PlotKind,
    axis: &PlotAxis,
    view: Option<ViewRange>,
) -> Result<(String, Statement), String> {
    let name = implicit_x_name(plot_id, trace_id);
    let expression = |limit: &Option<AxisLimit>| {
        limit
            .as_ref()
            .and_then(AxisLimit::expression)
            .map(str::to_owned)
    };
    let (low, high) = (expression(&axis.min), expression(&axis.max));
    let source = if kind == PlotKind::Xy
        && axis.scale != AxisScale::Log10
        && (low.is_some() || high.is_some())
    {
        // an expression limit drives the sample, so the definition is written with the
        // limit expressions themselves; an end without one is the number the sample would use.
        let (min, max) = implicit_x_bounds(kind, axis, view, [None, None]);
        let low = low.map_or_else(|| min.to_string(), |text| format!("({text})"));
        let high = high.map_or_else(|| max.to_string(), |text| format!("({text})"));
        let steps = IMPLICIT_X_POINTS.saturating_sub(1);
        format!("{low}, {low} + ({high} - {low})/{steps}..{high}")
    } else {
        let (min, max) = implicit_x_bounds(kind, axis, view, [None, None]);
        let step = (max - min) / (IMPLICIT_X_POINTS.saturating_sub(1) as f64);
        let second = min + step;
        format!("{min}, {second}..{max}")
    };
    let statement =
        parse_statement(&format!("{name} := {source}")).map_err(|error| error.to_string())?;
    Ok((name, statement))
}

/// What the worksheet provides to a plot's trace expressions at the plot's position.
///
/// Only the set of defined variable names matters: it decides whether the x slot of a trace
/// names a worksheet value or a variable the plot samples itself.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlotScope {
    /// The plain worksheet names defined as variables (or exported from a Julia region)
    /// anywhere in the project. Functions do not count. See `Project::defined_plain_names`.
    pub defined: HashSet<Name>,
}

impl PlotScope {
    /// A scope in which exactly `names` (simple names) are defined.
    pub fn defining<'a>(names: impl IntoIterator<Item = &'a str>) -> PlotScope {
        PlotScope {
            defined: names.into_iter().map(Name::plain).collect(),
        }
    }

    /// Whether the worksheet gives `name` a value (or the name is a constant or a worksheet
    /// setting, which are never sampled). A unit name is not provided: a plain name is never a unit,
    /// so an x slot naming a spelling of the unit table and
    /// nothing else is the plot's own sampled variable, like any other undefined name.
    pub fn provides(&self, name: &Name) -> bool {
        if self.defined.contains(name) {
            return true;
        }
        if crate::constants::constant_name(name).is_some() {
            return true;
        }
        match name.as_simple() {
            Some(text) => matches!(
                text,
                "π" | "e" | "γ" | "∞" | "NaN" | "ORIGIN" | "TOL" | "CTOL"
            ),
            None => false,
        }
    }
}

/// How one trace produces the x coordinate of its points.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceXKind {
    /// The plot's own sampled variable: a plain identifier (any name, including Greek and
    /// literal-subscript names) that nothing in the worksheet defines. The y expression is
    /// evaluated over the sampled vector.
    Implicit,
    /// The x slot is a worksheet expression, evaluated like any other region expression. An
    /// empty x slot is an unfilled placeholder and is not evaluated at all.
    Expression,
}

/// The identifier a trace's x slot is, when the slot is exactly one plain name.
fn x_slot_name(source: &str) -> Option<Name> {
    match parse_expression(source) {
        Ok(Expr {
            kind: ExprKind::Ident { name },
            ..
        }) if name.label.is_none() => Some(name),
        _ => None,
    }
}

/// The variable a trace samples itself, if its x slot is not a worksheet expression.
///
/// Only a plain identifier that nothing defines is the variable. An empty x slot is an
/// unfilled placeholder: it names no variable and samples nothing, whatever the y expression
/// reads, so typing a y expression first never draws against an axis the user has
/// not chosen.
pub fn sample_variable(trace: &PlotTrace, scope: &PlotScope) -> Option<Name> {
    if trace.x.trim().is_empty() {
        return None;
    }
    x_slot_name(&trace.x).filter(|name| !scope.provides(name))
}

/// Whether the x slot of a trace is the plot's own sampled variable.
pub fn trace_x(trace: &PlotTrace, scope: &PlotScope) -> TraceXKind {
    if sample_variable(trace, scope).is_some() {
        TraceXKind::Implicit
    } else {
        TraceXKind::Expression
    }
}

/// The trace expressions whose results [`PlotSpec::assemble`] reads, in evaluation order: the
/// x expression when the trace has one, then the y expression. A trace whose x is the plot's
/// own sampled variable contributes only its y expression, because its x is generated. A
/// trace with an empty x slot contributes nothing: it is an unfilled placeholder.
pub fn trace_axes(trace: &PlotTrace, scope: &PlotScope) -> Vec<TraceAxis> {
    if trace.x.trim().is_empty() {
        return Vec::new();
    }
    let mut axes = Vec::new();
    if trace_x(trace, scope) == TraceXKind::Expression {
        axes.push(TraceAxis::X);
    }
    if !trace.y.trim().is_empty() {
        axes.push(TraceAxis::Y);
    }
    axes
}

/// Contours evaluate three explicit expressions; no implicit range sampling.
pub fn plot_trace_axes(kind: PlotKind, trace: &PlotTrace, scope: &PlotScope) -> Vec<TraceAxis> {
    if kind != PlotKind::Contour {
        return trace_axes(trace, scope);
    }
    if [&trace.x, &trace.y, &trace.z]
        .iter()
        .any(|s| s.trim().is_empty())
    {
        return vec![];
    }
    vec![TraceAxis::X, TraceAxis::Y, TraceAxis::Z]
}

/// Replaces every identifier `variable` in `expr` with `replacement` (the sampled name).
fn rewrite_variable(expr: Expr, variable: &Name, replacement: &str) -> Result<Expr, String> {
    fn walk(value: serde_json::Value, variable: &Name, replacement: &str) -> serde_json::Value {
        match value {
            serde_json::Value::Object(mut object) => {
                let is_variable = object.get("type").and_then(serde_json::Value::as_str)
                    == Some("Ident")
                    && object
                        .get("name")
                        .and_then(|name| serde_json::from_value::<Name>(name.clone()).ok())
                        .is_some_and(|name| &name == variable);
                if is_variable {
                    object.insert(
                        "name".to_owned(),
                        serde_json::to_value(Name::plain(replacement)).expect("name serializes"),
                    );
                } else {
                    for value in object.values_mut() {
                        let old = std::mem::replace(value, serde_json::Value::Null);
                        *value = walk(old, variable, replacement);
                    }
                }
                serde_json::Value::Object(object)
            }
            serde_json::Value::Array(values) => serde_json::Value::Array(
                values
                    .into_iter()
                    .map(|value| walk(value, variable, replacement))
                    .collect(),
            ),
            other => other,
        }
    }
    let value = serde_json::to_value(&expr).expect("expression serializes");
    serde_json::from_value(walk(value, variable, replacement)).map_err(|error| error.to_string())
}

/// The evaluation statement of a trace expression, optionally with the sampled variable
/// `variable` rewritten to the hidden sampled name `x_name`.
pub fn expression_statement_rewriting(
    source: &str,
    variable: &Name,
    x_name: Option<&str>,
) -> Result<Statement, String> {
    let mut statement =
        parse_statement(&format!("plot_axis := {source}")).map_err(|error| error.to_string())?;
    let StatementKind::Define { rhs, .. } = statement.kind else {
        return Err("a trace expression must be a single expression".into());
    };
    let rhs = match x_name {
        Some(name) => rewrite_variable(rhs, variable, name)?,
        None => rhs,
    };
    statement.kind = StatementKind::Evaluate {
        expr: rhs,
        unit: None,
    };
    Ok(statement)
}

/// [`expression_statement_rewriting`] for a trace expression whose sampled variable is `x`.
///
/// `x` is a name like any other: this helper only saves the caller from naming it,
/// and it produces exactly what [`expression_statement_rewriting`] produces for that name.
pub fn expression_statement_with_x(
    source: &str,
    x_name: Option<&str>,
) -> Result<Statement, String> {
    expression_statement_rewriting(source, &Name::plain("x"), x_name)
}

/// The evaluation statement of a trace expression. Plot axes admit a top-level range
/// although ordinary entry points do not, so the expression is parsed as the right-hand
/// side of a definition and re-wrapped as an evaluation.
pub fn expression_statement(source: &str) -> Result<Statement, String> {
    let mut statement =
        parse_statement(&format!("plot_axis := {source}")).map_err(|error| error.to_string())?;
    let StatementKind::Define { rhs, .. } = statement.kind else {
        return Err("a trace expression must be a single expression".into());
    };
    statement.kind = StatementKind::Evaluate {
        expr: rhs,
        unit: None,
    };
    Ok(statement)
}

/// Every name of a unit expression carries the explicit unit label, so the generator reads it as
/// a unit name even when the worksheet defines a variable of the same spelling.
fn force_unit_labels(expr: Expr) -> Result<Expr, String> {
    fn walk(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(mut object) => {
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
                    let old = std::mem::replace(value, serde_json::Value::Null);
                    *value = walk(old);
                }
                serde_json::Value::Object(object)
            }
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(walk).collect())
            }
            other => other,
        }
    }
    let value = serde_json::to_value(&expr).expect("expression serializes");
    serde_json::from_value(walk(value)).map_err(|error| error.to_string())
}

/// The evaluation statement of an axis display unit: the unit expression, with every
/// plain name read as a unit name. A name that is not a unit makes the generated code fail, which
/// the plot reports as an unusable unit instead of guessing a value.
pub fn unit_statement(source: &str) -> Result<Statement, String> {
    let mut statement = expression_statement(source)?;
    if let StatementKind::Evaluate { expr, unit } = statement.kind {
        statement.kind = StatementKind::Evaluate {
            expr: force_unit_labels(expr)?,
            unit,
        };
    }
    Ok(statement)
}

impl PlotRegion {
    /// The hidden regions that evaluate this plot's trace expressions, in trace order.
    ///
    /// A trace whose x slot is the plot's own sampled variable (`trace_x`) also gets the
    /// hidden sampling definition, and its y expression is rewritten to read that sample
    /// vector instead of the sampled name — whatever that name is.
    /// The scope comes from the worksheet
    /// (`Project::defined_plain_names`), so a name the worksheet defines keeps the explicit
    /// form. A trace with an empty x slot contributes no region at all: nothing of it is
    /// evaluated until the x axis is filled.
    pub fn expression_regions(&self, scope: &PlotScope) -> Vec<Region> {
        let mut regions = Vec::new();
        let mut push = |id: String, statement: Statement| {
            regions.push(Region {
                id,
                page: self.page,
                x: self.x,
                y: self.y,
                enabled: true,
                statement: std::sync::Arc::new(statement),
            });
        };
        // The limit expressions come first, in `limit_expressions` order: they are
        // calculated before the traces, whose sampled x they drive.
        for (axis, bound) in self.plot.limit_expressions() {
            let limit = self.plot.axes.get(axis);
            let source = match bound {
                LimitBound::Min => &limit.min,
                LimitBound::Max => &limit.max,
            };
            let Some(text) = source.as_ref().and_then(AxisLimit::expression) else {
                continue;
            };
            let Ok(statement) = expression_statement(text) else {
                continue;
            };
            push(limit_region_id(&self.id, axis, bound), statement);
        }
        // The axis display units come next: they depend on nothing and the plot reads
        // their values before the traces, exactly as the analysis evaluated them.
        for axis in self.plot.unit_expressions() {
            let Some(text) = self.plot.axes.get(axis).unit.as_deref() else {
                continue;
            };
            let Ok(statement) = unit_statement(text) else {
                continue;
            };
            push(unit_region_id(&self.id, axis), statement);
        }
        for line in self.plot.reference_line_expressions() {
            let Some(text) = line.value.expression() else {
                continue;
            };
            let Ok(statement) = expression_statement(text) else {
                continue;
            };
            push(reference_line_region_id(&self.id, &line.id), statement);
        }
        for trace in &self.plot.traces {
            let kind = self.plot.kind;
            match if kind == PlotKind::Contour {
                None
            } else {
                sample_variable(trace, scope)
            } {
                Some(variable) => {
                    if trace.y.trim().is_empty() {
                        // Both slots are placeholders (or only x is filled): nothing to draw.
                        continue;
                    }
                    let Ok((x_name, statement)) = implicit_x_statement(
                        &self.id,
                        &trace.id,
                        kind,
                        &self.plot.axes.x,
                        self.view,
                    ) else {
                        continue;
                    };
                    push(sampling_region_id(&self.id, &trace.id), statement);
                    let Ok(statement) =
                        expression_statement_rewriting(&trace.y, &variable, Some(&x_name))
                    else {
                        continue;
                    };
                    push(
                        expression_region_id(&self.id, &trace.id, TraceAxis::Y),
                        statement,
                    );
                }
                None => {
                    for axis in plot_trace_axes(kind, trace, scope) {
                        let source = match axis {
                            TraceAxis::X => &trace.x,
                            TraceAxis::Y => &trace.y,
                            TraceAxis::Z => &trace.z,
                        };
                        let Ok(statement) = expression_statement(source) else {
                            continue;
                        };
                        push(expression_region_id(&self.id, &trace.id, axis), statement);
                    }
                }
            }
        }
        regions
    }
}

// ---------------------------------------------------------------------------------------
// Calculated plot data
// ---------------------------------------------------------------------------------------

/// How current the data of a plot is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlotDataState {
    /// Some expression was never calculated; there is nothing to draw yet.
    Pending,
    /// Every trace has complete data, but a dependency changed since it was calculated.
    Stale,
    Ready,
    /// A trace failed: no trace data is published.
    Error,
}

/// The first failure of a plot, with the trace and expression identified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlotDataError {
    pub trace: String,
    pub axis: TraceAxis,
    pub expression: String,
    pub message: String,
}

/// A real contour grid in the kernel conversion layer's column-major order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContourGrid {
    pub rows: usize,
    pub cols: usize,
    pub values: Vec<f64>,
    pub dimension: Vec<DimensionComponent>,
}

/// Validated scatter coordinates or an explicit contour grid; non-finite values are gaps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceData {
    pub id: String,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z: Option<ContourGrid>,
    /// SI dimension of each axis; empty for a dimensionless axis.
    pub x_dimension: Vec<DimensionComponent>,
    pub y_dimension: Vec<DimensionComponent>,
    /// The worksheet length when this trace was reduced for display.
    pub downsampled_from: Option<usize>,
}

impl TraceData {
    /// Reduces a trace longer than `threshold` to at most `2 * buckets` points: for each
    /// bucket of consecutive indexes the points with the smallest and largest finite y, in
    /// their original order. Gaps (NaN) are kept at bucket boundaries so a
    /// line never bridges them. The worksheet value is unchanged; this is display data.
    pub fn reduce_for_display(&mut self, threshold: usize, buckets: usize) {
        let length = self.x.len();
        if self.z.is_some() || length <= threshold || buckets == 0 {
            return;
        }
        let size = length.div_ceil(buckets);
        let mut x = Vec::with_capacity(buckets * 2);
        let mut y = Vec::with_capacity(buckets * 2);
        for start in (0..length).step_by(size) {
            let end = (start + size).min(length);
            let mut low: Option<usize> = None;
            let mut high: Option<usize> = None;
            let mut gap = false;
            for index in start..end {
                if !(self.x[index].is_finite() && self.y[index].is_finite()) {
                    gap = true;
                    continue;
                }
                if low.is_none_or(|l| self.y[index] < self.y[l]) {
                    low = Some(index);
                }
                if high.is_none_or(|h| self.y[index] > self.y[h]) {
                    high = Some(index);
                }
            }
            let mut picked: Vec<usize> = low.into_iter().chain(high).collect();
            picked.sort_unstable();
            picked.dedup();
            for index in picked {
                x.push(self.x[index]);
                y.push(self.y[index]);
            }
            if gap {
                x.push(f64::NAN);
                y.push(f64::NAN);
            }
        }
        self.x = x;
        self.y = y;
        self.downsampled_from = Some(length);
    }

    pub fn len(&self) -> usize {
        self.x.len()
    }

    pub fn is_empty(&self) -> bool {
        self.x.is_empty()
    }

    /// Points with both coordinates finite.
    pub fn finite_points(&self) -> usize {
        self.x
            .iter()
            .zip(&self.y)
            .filter(|(x, y)| x.is_finite() && y.is_finite())
            .count()
    }
}

/// The limits one axis of a plot uses: the number stored in the worksheet or the value
/// of an evaluated expression limit, `None` when that end is automatic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotAxisLimits {
    pub axis: AxisKind,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

/// A limit expression that could not be used: the calculation reports it on the plot and
/// that end (or the whole axis) stays automatic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlotLimitError {
    pub axis: AxisKind,
    pub bound: LimitBound,
    pub expression: String,
    pub message: String,
}

/// The display unit one axis was converted to: the SI magnitude its values and limits
/// were divided by. The axis text itself is the stored unit expression, which the frontend has.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotAxisUnit {
    pub axis: AxisKind,
    pub divisor: f64,
}

/// A unit expression that could not be used: the calculation reports it on the plot and
/// that axis keeps the SI base display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlotUnitError {
    pub axis: AxisKind,
    pub expression: String,
    pub message: String,
}

/// One evaluated reference line expressed in its axis display unit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotReferenceLineData {
    pub id: String,
    pub axis: AxisKind,
    pub value: f64,
}

/// A reference line omitted because its value could not be used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlotReferenceLineError {
    pub id: String,
    pub axis: AxisKind,
    pub expression: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotData {
    pub region_id: String,
    pub state: PlotDataState,
    pub error: Option<PlotDataError>,
    pub traces: Vec<TraceData>,
    /// The limits each axis draws with, x, y and y2, in that order.
    pub limits: Vec<PlotAxisLimits>,
    /// The limit expressions that kept an axis automatic.
    #[serde(default)]
    pub limit_errors: Vec<PlotLimitError>,
    /// The display units the axes were converted to, in `AxisKind::ALL` order.
    #[serde(default)]
    pub units: Vec<PlotAxisUnit>,
    /// The unit expressions that could not be used, so their axis keeps the SI base display.
    #[serde(default)]
    pub unit_errors: Vec<PlotUnitError>,
    /// Fixed reference lines resolved for this XY plot.
    #[serde(default)]
    pub reference_lines: Vec<PlotReferenceLineData>,
    /// Reference lines omitted while their traces remain visible.
    #[serde(default)]
    pub reference_line_errors: Vec<PlotReferenceLineError>,
    /// Whether the plot has a trace whose x the plot samples itself, so the on-screen view range
    /// is its sample interval. Screen-only: it drives no stored state.
    #[serde(default)]
    pub implicit_x: bool,
}

/// The state of one calculated trace expression, as the session holds it.
#[derive(Debug, Clone, PartialEq)]
pub enum ExpressionResult {
    /// Never calculated.
    Pending,
    /// A value that a dependency has since invalidated.
    Stale(KernelValue),
    Value(KernelValue),
    Failed(String),
}

fn describe_shape(value: &KernelValue) -> String {
    match value {
        KernelValue::Matrix { rows, cols, .. } => format!("a {rows}x{cols} matrix"),
        KernelValue::Real { .. } | KernelValue::Quantity { .. } => "a scalar".into(),
        KernelValue::Complex { .. } => "a complex scalar".into(),
        KernelValue::String { .. } => "a string".into(),
        KernelValue::Handle { .. } => "an opaque Julia value".into(),
        KernelValue::Symbolic { .. } => "a symbolic expression".into(),
    }
}

type Vector = (Vec<f64>, Vec<DimensionComponent>);

/// A real vector (or a one-row/one-column real matrix) with its dimension.
fn vector(value: &KernelValue) -> Result<Vector, String> {
    let not_a_vector = || format!("expected a real vector, got {}", describe_shape(value));
    let KernelValue::Matrix {
        rows,
        cols,
        storage: MatrixStorage::Inline { values },
    } = value
    else {
        return Err(not_a_vector());
    };
    if *rows != 1 && *cols != 1 {
        return Err(not_a_vector());
    }
    let mut dimension: Option<Vec<DimensionComponent>> = None;
    let mut numbers = Vec::with_capacity(values.len());
    for element in values {
        let (number, element_dimension): (f64, &[DimensionComponent]) = match element {
            KernelValue::Real { value } => (value.as_f64(), &[]),
            KernelValue::Quantity {
                magnitude: QuantityMagnitude::Real { value },
                dimension,
            } => (value.as_f64(), dimension),
            _ => {
                return Err(format!(
                    "expected real values, found {}",
                    describe_shape(element)
                ));
            }
        };
        match &dimension {
            None => dimension = Some(element_dimension.to_vec()),
            Some(known) if known.as_slice() != element_dimension => {
                return Err("the values of one axis must have the same dimension".into());
            }
            Some(_) => {}
        }
        numbers.push(if number.is_finite() { number } else { f64::NAN });
    }
    Ok((numbers, dimension.unwrap_or_default()))
}

/// The outcome of reading the result of one limit expression.
#[derive(Debug, Clone, PartialEq)]
enum LimitOutcome {
    /// Never calculated: the end stays automatic and nothing is reported.
    Pending,
    /// A real value in SI units with its dimension.
    Value(f64, Vec<DimensionComponent>),
    Failed(String),
}

/// One axis-limit expression with the outcome of its hidden evaluation region.
#[derive(Debug, Clone, PartialEq)]
struct LimitResult {
    axis: AxisKind,
    bound: LimitBound,
    expression: String,
    outcome: LimitOutcome,
}

/// One axis display unit with the outcome of its hidden evaluation region.
#[derive(Debug, Clone, PartialEq)]
struct UnitResult {
    axis: AxisKind,
    expression: String,
    outcome: LimitOutcome,
}

/// Divides every value of one axis by the SI magnitude of its display unit. `NaN`, the
/// gap marker, stays a gap.
fn divide(values: &mut [f64], divisor: f64) {
    if divisor == 1.0 {
        return;
    }
    for value in values.iter_mut() {
        *value /= divisor;
    }
}

/// A real scalar (a plain number or a number with a unit) with its dimension.
fn scalar(value: &KernelValue) -> Result<(f64, Vec<DimensionComponent>), String> {
    match value {
        KernelValue::Real { value } => Ok((value.as_f64(), Vec::new())),
        KernelValue::Quantity {
            magnitude: QuantityMagnitude::Real { value },
            dimension,
        } => Ok((value.as_f64(), dimension.clone())),
        other => Err(format!(
            "expected a real number, found {}",
            describe_shape(other)
        )),
    }
}

/// Consumes the next expression result as a limit value, reporting whether it is stale
/// like [`take_vector`] does for a trace.
fn take_limit(results: &[ExpressionResult], cursor: &mut usize) -> (LimitOutcome, bool) {
    match results.get(*cursor) {
        None | Some(ExpressionResult::Pending) => {
            *cursor += 1;
            (LimitOutcome::Pending, false)
        }
        Some(ExpressionResult::Failed(message)) => {
            *cursor += 1;
            (LimitOutcome::Failed(message.clone()), false)
        }
        Some(ExpressionResult::Stale(value)) => {
            *cursor += 1;
            (limit_value(value), true)
        }
        Some(ExpressionResult::Value(value)) => {
            *cursor += 1;
            (limit_value(value), false)
        }
    }
}

/// The limit a kernel value gives, or why it is not a limit (a real scalar only).
fn limit_value(value: &KernelValue) -> LimitOutcome {
    match scalar(value) {
        Ok((number, dimension)) => LimitOutcome::Value(number, dimension),
        Err(message) => LimitOutcome::Failed(message),
    }
}

/// Consumes the next expression result as a vector, reporting whether it was missing/stale.
fn take_vector(
    results: &[ExpressionResult],
    cursor: &mut usize,
) -> (bool, bool, Option<Result<Vector, String>>) {
    match results.get(*cursor) {
        None => (true, false, None),
        Some(ExpressionResult::Pending) => {
            *cursor += 1;
            (true, false, None)
        }
        Some(ExpressionResult::Failed(message)) => {
            *cursor += 1;
            (false, false, Some(Err(message.clone())))
        }
        Some(ExpressionResult::Stale(value)) => {
            *cursor += 1;
            (false, true, Some(vector(value)))
        }
        Some(ExpressionResult::Value(value)) => {
            *cursor += 1;
            (false, false, Some(vector(value)))
        }
    }
}

impl PlotSpec {
    /// Builds the data of this plot from the state of its expressions, in the order of
    /// [`trace_axes`] (a trace with a generated x supplies only its y). The first failing
    /// expression wins; a trace is published only if both of its vectors are valid and
    /// of equal length. `scope` decides, as in [`PlotRegion::expression_regions`],
    /// whether an `x` slot names the plot's own variable or the worksheet one.
    pub fn assemble(
        &self,
        region_id: &str,
        results: &[ExpressionResult],
        scope: &PlotScope,
    ) -> PlotData {
        self.assemble_in_view(region_id, results, scope, None)
    }

    /// [`assemble`](Self::assemble) with the on-screen x range of the plot: the sample
    /// interval of every implicit x trace is the view range when the user navigated the plot.
    pub fn assemble_in_view(
        &self,
        region_id: &str,
        results: &[ExpressionResult],
        scope: &PlotScope,
        view: Option<ViewRange>,
    ) -> PlotData {
        let mut data = PlotData {
            region_id: region_id.to_owned(),
            state: PlotDataState::Ready,
            error: None,
            traces: Vec::new(),
            limits: Vec::new(),
            limit_errors: Vec::new(),
            units: Vec::new(),
            unit_errors: Vec::new(),
            reference_lines: Vec::new(),
            reference_line_errors: Vec::new(),
            // whether navigating the plot has samples to move.
            implicit_x: self.kind == PlotKind::Xy
                && self
                    .traces
                    .iter()
                    .any(|trace| trace_x(trace, scope) == TraceXKind::Implicit),
        };
        let fail = |trace: &PlotTrace, axis: TraceAxis, message: String| PlotDataError {
            trace: trace.id.clone(),
            axis,
            expression: match axis {
                TraceAxis::X => trace.x.clone(),
                TraceAxis::Y => trace.y.clone(),
                TraceAxis::Z => trace.z.clone(),
            },
            message,
        };
        let mut pending = false;
        let mut stale = false;
        let mut cursor = 0usize;
        // the limit expressions are the first hidden regions the analysis evaluated.
        let mut limits = Vec::new();
        for (axis, bound) in self.limit_expressions() {
            let limit = self.axes.get(axis);
            let expression = match bound {
                LimitBound::Min => &limit.min,
                LimitBound::Max => &limit.max,
            }
            .as_ref()
            .and_then(AxisLimit::expression)
            .unwrap_or_default()
            .to_owned();
            let (outcome, was_stale) = take_limit(results, &mut cursor);
            stale |= was_stale;
            limits.push(LimitResult {
                axis,
                bound,
                expression,
                outcome,
            });
        }
        // the calculated x limits drive the sample of an implicit x.
        let mut evaluated_x = [None, None];
        for limit in limits.iter().filter(|limit| limit.axis == AxisKind::X) {
            if let LimitOutcome::Value(value, _) = limit.outcome {
                let slot = match limit.bound {
                    LimitBound::Min => 0,
                    LimitBound::Max => 1,
                };
                evaluated_x[slot] = Some(value);
            }
        }
        // the axis units are the hidden regions after the limits. Their outcomes are
        // resolved below, once the data of the traces says what dimension each axis carries.
        let mut units = Vec::new();
        for axis in self.unit_expressions() {
            let expression = self.axes.get(axis).unit.clone().unwrap_or_default();
            let (outcome, was_stale) = take_limit(results, &mut cursor);
            stale |= was_stale;
            units.push(UnitResult {
                axis,
                expression,
                outcome,
            });
        }
        let mut reference_lines = Vec::new();
        if self.kind == PlotKind::Xy {
            for line in &self.reference_lines {
                let expression = match &line.value {
                    AxisLimit::Value(value) => value.to_string(),
                    AxisLimit::Expression(text) => text.clone(),
                };
                let (outcome, was_stale) = match &line.value {
                    AxisLimit::Value(value) => (LimitOutcome::Value(*value, Vec::new()), false),
                    AxisLimit::Expression(_) => take_limit(results, &mut cursor),
                };
                stale |= was_stale;
                reference_lines.push((line, expression, outcome));
            }
        }
        for trace in &self.traces {
            if self.kind == PlotKind::Contour {
                let axes = plot_trace_axes(self.kind, trace, scope);
                if axes.is_empty() {
                    pending = true;
                    continue;
                }
                let mut parts = Vec::new();
                for axis in axes {
                    let result = results.get(cursor);
                    cursor += 1;
                    let value = match result {
                        Some(ExpressionResult::Value(v)) => Some(v),
                        Some(ExpressionResult::Stale(v)) => {
                            stale = true;
                            Some(v)
                        }
                        Some(ExpressionResult::Failed(message)) => {
                            data.error = Some(fail(trace, axis, message.clone()));
                            break;
                        }
                        _ => {
                            pending = true;
                            None
                        }
                    };
                    if let Some(v) = value {
                        parts.push((axis, v));
                    }
                }
                if data.error.is_some() {
                    break;
                }
                if parts.len() != 3 {
                    continue;
                }
                let converted = (|| -> Result<TraceData, (TraceAxis, String)> {
                    let (x, x_dimension) = vector(parts[0].1).map_err(|e| (TraceAxis::X, e))?;
                    let (y, y_dimension) = vector(parts[1].1).map_err(|e| (TraceAxis::Y, e))?;
                    for (axis, v) in [(TraceAxis::X, &x), (TraceAxis::Y, &y)] {
                        if v.len() < 2
                            || v.iter().any(|n| !n.is_finite())
                            || v.windows(2).any(|w| w[0] >= w[1])
                        {
                            return Err((axis, "contour coordinates must contain at least two finite, strictly increasing values".into()));
                        }
                    }
                    let KernelValue::Matrix {
                        rows,
                        cols,
                        storage: MatrixStorage::Inline { values },
                    } = parts[2].1
                    else {
                        return Err((TraceAxis::Z, "expected a real contour matrix".into()));
                    };
                    if *rows != y.len()
                        || *cols != x.len()
                        || rows.checked_mul(*cols) != Some(values.len())
                    {
                        return Err((
                            TraceAxis::Z,
                            format!(
                                "z is {rows}x{cols}; expected {}x{} for y and x",
                                y.len(),
                                x.len()
                            ),
                        ));
                    }
                    // Reuse real/dimension validation without changing column-major order.
                    let flat = KernelValue::Matrix {
                        rows: values.len(),
                        cols: 1,
                        storage: MatrixStorage::Inline {
                            values: values.clone(),
                        },
                    };
                    let (values, dimension) = vector(&flat).map_err(|e| (TraceAxis::Z, e))?;
                    Ok(TraceData {
                        id: trace.id.clone(),
                        x,
                        y,
                        x_dimension,
                        y_dimension,
                        z: Some(ContourGrid {
                            rows: *rows,
                            cols: *cols,
                            values,
                            dimension,
                        }),
                        downsampled_from: None,
                    })
                })();
                match converted {
                    Ok(trace) => data.traces.push(trace),
                    Err((axis, message)) => {
                        data.error = Some(fail(trace, axis, message));
                        break;
                    }
                }
                continue;
            }
            let has_y = !trace.y.trim().is_empty();
            if trace.x.trim().is_empty() && has_y {
                // An empty x slot is an unfilled placeholder, never a sampled axis.
                data.error = Some(fail(
                    trace,
                    TraceAxis::X,
                    "the x expression is empty; enter the x-axis variable or expression".into(),
                ));
                break;
            }
            // The x axis of a trace with a generated x: the sampled interval, dimensionless.
            let implicit_x = trace_x(trace, scope) == TraceXKind::Implicit;
            let mut x_parts: Option<Vector> = (implicit_x && has_y)
                .then(|| implicit_x_vector(self.kind, &self.axes.x, view, evaluated_x));
            let mut y_parts: Option<Vector> = None;

            let axes = trace_axes(trace, scope);
            for axis in axes {
                let (was_pending, was_stale, parts) = take_vector(results, &mut cursor);
                pending |= was_pending;
                stale |= was_stale;
                match parts {
                    Some(Ok(parts)) => match axis {
                        TraceAxis::X => x_parts = Some(parts),
                        TraceAxis::Y => y_parts = Some(parts),
                        TraceAxis::Z => unreachable!(),
                    },
                    Some(Err(message)) => {
                        data.error = Some(fail(trace, axis, message));
                        break;
                    }
                    None => {}
                }
            }
            if data.error.is_some() {
                break;
            }
            match (x_parts.as_mut(), y_parts.as_mut()) {
                (Some((x, x_dimension)), Some((y, y_dimension))) => {
                    if x.len() != y.len() {
                        data.error = Some(fail(
                            trace,
                            TraceAxis::Y,
                            format!(
                                "x has {} values and y has {}; they must have equal length",
                                x.len(),
                                y.len()
                            ),
                        ));
                        break;
                    }
                    data.traces.push(TraceData {
                        id: trace.id.clone(),
                        x: std::mem::take(x),
                        y: std::mem::take(y),
                        z: None,
                        x_dimension: std::mem::take(x_dimension),
                        y_dimension: std::mem::take(y_dimension),
                        downsampled_from: None,
                    });
                    if let Some(last) = data.traces.last_mut() {
                        last.reduce_for_display(DOWNSAMPLE_THRESHOLD, DOWNSAMPLE_BUCKETS);
                    }
                }
                _ => pending = true,
            }
        }
        if data.error.is_some() {
            data.state = PlotDataState::Error;
            data.traces.clear();
        } else if pending {
            data.state = PlotDataState::Pending;
            data.traces.clear();
        } else if stale {
            data.state = PlotDataState::Stale;
        }
        for axis in AxisKind::ALL {
            let dimension = self.axis_dimension(axis, &data.traces);
            let mut errors = Vec::new();
            let resolved = self.resolve_limits(axis, &limits, dimension.as_deref(), &mut errors);
            data.limits.push(resolved);
            data.limit_errors.extend(errors);
        }
        // a unit converts its axis. Nothing is converted while the plot has no data: with
        // no trace the dimension of an axis is unknown, so a unit is not reported either.
        let mut divisors = Vec::new();
        if !data.traces.is_empty() {
            for unit in &units {
                let data_dimension = self
                    .axis_dimension(unit.axis, &data.traces)
                    .unwrap_or_default();
                let message = match &unit.outcome {
                    // A unit that is not calculated yet leaves its axis in SI, like a limit.
                    LimitOutcome::Pending => continue,
                    LimitOutcome::Failed(message) => Some(message.clone()),
                    LimitOutcome::Value(value, _) if !value.is_finite() || *value <= 0.0 => {
                        Some("a unit must be a positive finite number".to_owned())
                    }
                    LimitOutcome::Value(_, dimension) if *dimension != data_dimension => Some(
                        "the unit does not match the dimension of the values of this axis"
                            .to_owned(),
                    ),
                    LimitOutcome::Value(value, _) => {
                        divisors.push(PlotAxisUnit {
                            axis: unit.axis,
                            divisor: *value,
                        });
                        None
                    }
                };
                if let Some(message) = message {
                    data.unit_errors.push(PlotUnitError {
                        axis: unit.axis,
                        expression: unit.expression.clone(),
                        message,
                    });
                }
            }
        }
        let divisor = |axis: AxisKind| {
            divisors
                .iter()
                .find(|unit| unit.axis == axis)
                .map(|unit| unit.divisor)
        };
        for (line, expression, outcome) in reference_lines {
            let failure = match outcome {
                LimitOutcome::Pending => continue,
                LimitOutcome::Failed(message) => Some(message),
                LimitOutcome::Value(value, _) if !value.is_finite() => {
                    Some("a reference-line value must be finite".to_owned())
                }
                LimitOutcome::Value(value, dimension) => {
                    let axis_dimension = self
                        .axis_dimension(line.axis, &data.traces)
                        .unwrap_or_default();
                    let dimension_mismatch = !dimension.is_empty() && dimension != axis_dimension;
                    let scale = match line.axis {
                        AxisKind::X => self.axes.x.scale,
                        AxisKind::Y => self.axes.y.scale,
                        AxisKind::Y2 => unreachable!("reference lines use x or y only"),
                    };
                    if dimension_mismatch {
                        Some("the value unit does not match the dimension of this axis".into())
                    } else if scale == AxisScale::Log10 && value <= 0.0 {
                        Some("a reference-line value on a logarithmic axis must be positive".into())
                    } else {
                        data.reference_lines.push(PlotReferenceLineData {
                            id: line.id.clone(),
                            axis: line.axis,
                            value: value / divisor(line.axis).unwrap_or(1.0),
                        });
                        None
                    }
                }
            };
            if let Some(message) = failure {
                data.reference_line_errors.push(PlotReferenceLineError {
                    id: line.id.clone(),
                    axis: line.axis,
                    expression,
                    message,
                });
            }
        }
        if let Some(divisor) = divisor(AxisKind::X) {
            for trace in &mut data.traces {
                divide(&mut trace.x, divisor);
            }
        }
        for limit in &mut data.limits {
            if let Some(divisor) = divisor(limit.axis) {
                limit.min = limit.min.map(|value| value / divisor);
                limit.max = limit.max.map(|value| value / divisor);
            }
        }
        // A trace's y values belong to the axis its trace selected.
        for trace in &mut data.traces {
            let axis = self
                .traces
                .iter()
                .find(|item| item.id == trace.id)
                .map(|item| item.y_axis)
                .unwrap_or_default();
            let axis = match axis {
                TraceYAxis::Left => AxisKind::Y,
                TraceYAxis::Right => AxisKind::Y2,
            };
            if let Some(divisor) = divisor(axis) {
                divide(&mut trace.y, divisor);
            }
        }
        data.units = divisors;
        data
    }

    /// The dimension of the data drawn on one axis, if any trace has one.
    fn axis_dimension(
        &self,
        kind: AxisKind,
        traces: &[TraceData],
    ) -> Option<Vec<DimensionComponent>> {
        let right = |trace: &TraceData| {
            self.traces
                .iter()
                .find(|item| item.id == trace.id)
                .is_some_and(|item| item.y_axis == TraceYAxis::Right)
        };
        traces
            .iter()
            .find(|trace| match kind {
                AxisKind::X => true,
                AxisKind::Y => !right(trace),
                AxisKind::Y2 => right(trace),
            })
            .map(|trace| match kind {
                AxisKind::X => &trace.x_dimension,
                _ => &trace.y_dimension,
            })
            .filter(|dimension| !dimension.is_empty())
            .cloned()
    }

    /// The limits one axis uses, after evaluating its expression limits. A limit
    /// that cannot be used keeps its end automatic; a pair that is not ordered, a contradiction of
    /// units or a non-positive limit on a logarithmic axis drops both ends, because neither can be
    /// trusted.
    fn resolve_limits(
        &self,
        kind: AxisKind,
        limits: &[LimitResult],
        data_dimension: Option<&[DimensionComponent]>,
        errors: &mut Vec<PlotLimitError>,
    ) -> PlotAxisLimits {
        let axis = self.axes.get(kind);
        let mut ends = [
            axis.min.as_ref().and_then(AxisLimit::value),
            axis.max.as_ref().and_then(AxisLimit::value),
        ];
        let mut dimensions: [Option<Vec<DimensionComponent>>; 2] = [None, None];
        for limit in limits.iter().filter(|limit| limit.axis == kind) {
            let slot = match limit.bound {
                LimitBound::Min => 0,
                LimitBound::Max => 1,
            };
            let message = match &limit.outcome {
                LimitOutcome::Pending => continue,
                LimitOutcome::Failed(message) => message.clone(),
                LimitOutcome::Value(value, dimension) if value.is_finite() => {
                    ends[slot] = Some(*value);
                    dimensions[slot] = Some(dimension.clone());
                    continue;
                }
                LimitOutcome::Value(..) => "a limit must be a finite number".to_owned(),
            };
            errors.push(PlotLimitError {
                axis: kind,
                bound: limit.bound,
                expression: limit.expression.clone(),
                message,
            });
        }
        // a limit without a unit is usable on any axis; a limit with one must agree with
        // the other dimensioned values of its axis (its data and its other end).
        let mut dimension: Option<Vec<DimensionComponent>> = data_dimension
            .filter(|value| !value.is_empty())
            .map(<[_]>::to_vec);
        let mut mismatch = false;
        for found in dimensions
            .iter()
            .flatten()
            .filter(|value| !value.is_empty())
        {
            match &dimension {
                None => dimension = Some(found.clone()),
                Some(known) if known != found => mismatch = true,
                Some(_) => {}
            }
        }
        let ordered = ends[0].zip(ends[1]).is_none_or(|(min, max)| min < max);
        let positive =
            axis.scale != AxisScale::Log10 || ends.iter().flatten().all(|value| *value > 0.0);
        let problem = if mismatch {
            Some("its unit does not match the other values of this axis")
        } else if !ordered {
            Some("the minimum must be less than the maximum")
        } else if !positive {
            Some("a limit on a logarithmic axis must be positive")
        } else {
            None
        };
        let Some(problem) = problem else {
            return PlotAxisLimits {
                axis: kind,
                min: ends[0],
                max: ends[1],
            };
        };
        for limit in limits.iter().filter(|limit| limit.axis == kind) {
            errors.push(PlotLimitError {
                axis: kind,
                bound: limit.bound,
                expression: limit.expression.clone(),
                message: problem.to_owned(),
            });
        }
        PlotAxisLimits {
            axis: kind,
            min: None,
            max: None,
        }
    }
}

// ---------------------------------------------------------------------------------------
// Binary frame to the frontend
// ---------------------------------------------------------------------------------------

/// Describes one Float64 buffer of a plot frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlotBuffer {
    /// Byte offset from the start of the payload area (after the header).
    pub offset: usize,
    /// Number of little-endian `f64` values.
    pub length: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContourGridHeader {
    pub rows: usize,
    pub cols: usize,
    pub values: PlotBuffer,
    pub dimension: Vec<DimensionComponent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotTraceHeader {
    pub id: String,
    pub x: PlotBuffer,
    pub y: PlotBuffer,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z: Option<ContourGridHeader>,
    pub x_dimension: Vec<DimensionComponent>,
    pub y_dimension: Vec<DimensionComponent>,
    /// Points with both coordinates finite; the others are gaps.
    pub finite: usize,
    #[serde(default)]
    pub downsampled_from: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlotFrameHeader {
    pub region_id: String,
    pub state: PlotDataState,
    pub error: Option<PlotDataError>,
    pub traces: Vec<PlotTraceHeader>,
    /// The limits each axis draws with; a frame written before them has none.
    #[serde(default)]
    pub limits: Vec<PlotAxisLimits>,
    #[serde(default)]
    pub limit_errors: Vec<PlotLimitError>,
    /// The display units the values were divided by; a frame written before them has none.
    #[serde(default)]
    pub units: Vec<PlotAxisUnit>,
    #[serde(default)]
    pub unit_errors: Vec<PlotUnitError>,
    #[serde(default)]
    pub reference_lines: Vec<PlotReferenceLineData>,
    #[serde(default)]
    pub reference_line_errors: Vec<PlotReferenceLineError>,
    /// Whether a trace's x is sampled by the plot itself.
    #[serde(default)]
    pub implicit_x: bool,
}

impl PlotData {
    /// Encodes the plot as one byte frame: a little-endian `u32` header length, the JSON
    /// [`PlotFrameHeader`], then the little-endian `f64` payloads. Arrays never become
    /// JSON numbers.
    pub fn encode_frame(&self) -> Vec<u8> {
        let mut payload: Vec<u8> = Vec::new();
        let mut push = |values: &[f64]| {
            let buffer = PlotBuffer {
                offset: payload.len(),
                length: values.len(),
            };
            for value in values {
                payload.extend_from_slice(&value.to_le_bytes());
            }
            buffer
        };
        let traces = self
            .traces
            .iter()
            .map(|trace| PlotTraceHeader {
                id: trace.id.clone(),
                x: push(&trace.x),
                y: push(&trace.y),
                z: trace.z.as_ref().map(|z| ContourGridHeader {
                    rows: z.rows,
                    cols: z.cols,
                    values: push(&z.values),
                    dimension: z.dimension.clone(),
                }),
                x_dimension: trace.x_dimension.clone(),
                y_dimension: trace.y_dimension.clone(),
                finite: trace.finite_points(),
                downsampled_from: trace.downsampled_from,
            })
            .collect();
        let header = PlotFrameHeader {
            region_id: self.region_id.clone(),
            state: self.state,
            error: self.error.clone(),
            traces,
            limits: self.limits.clone(),
            limit_errors: self.limit_errors.clone(),
            units: self.units.clone(),
            unit_errors: self.unit_errors.clone(),
            reference_lines: self.reference_lines.clone(),
            reference_line_errors: self.reference_line_errors.clone(),
            implicit_x: self.implicit_x,
        };
        let header = serde_json::to_vec(&header).expect("plot header serializes");
        let mut frame = Vec::with_capacity(4 + header.len() + payload.len());
        frame.extend_from_slice(&(header.len() as u32).to_le_bytes());
        frame.extend_from_slice(&header);
        frame.extend_from_slice(&payload);
        frame
    }

    /// Decodes and validates a frame produced by [`encode_frame`](Self::encode_frame):
    /// header length, buffer bounds and equal trace lengths are checked.
    pub fn decode_frame(frame: &[u8]) -> Result<PlotData, String> {
        let prefix: [u8; 4] = frame
            .get(..4)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or("plot frame is shorter than its length prefix")?;
        let header_len = u32::from_le_bytes(prefix) as usize;
        let header_end = 4usize
            .checked_add(header_len)
            .filter(|end| *end <= frame.len())
            .ok_or("plot frame header exceeds the frame")?;
        let header: PlotFrameHeader =
            serde_json::from_slice(&frame[4..header_end]).map_err(|error| error.to_string())?;
        let payload = &frame[header_end..];
        let read = |buffer: &PlotBuffer| -> Result<Vec<f64>, String> {
            let end = buffer
                .length
                .checked_mul(8)
                .and_then(|bytes| bytes.checked_add(buffer.offset))
                .filter(|end| *end <= payload.len())
                .ok_or("plot buffer exceeds the frame payload")?;
            Ok(payload[buffer.offset..end]
                .as_chunks::<8>()
                .0
                .iter()
                .map(|bytes| f64::from_le_bytes(*bytes))
                .collect())
        };
        let mut traces = Vec::new();
        for trace in &header.traces {
            let x = read(&trace.x)?;
            let y = read(&trace.y)?;
            let z = trace
                .z
                .as_ref()
                .map(|z| -> Result<ContourGrid, String> {
                    let values = read(&z.values)?;
                    if z.rows < 2
                        || z.cols < 2
                        || z.rows != y.len()
                        || z.cols != x.len()
                        || z.rows.checked_mul(z.cols) != Some(values.len())
                    {
                        return Err("contour grid shape does not match its buffers".into());
                    }
                    Ok(ContourGrid {
                        rows: z.rows,
                        cols: z.cols,
                        values,
                        dimension: z.dimension.clone(),
                    })
                })
                .transpose()?;
            if z.is_none() && x.len() != y.len() {
                return Err(format!("trace `{}` has unequal x and y lengths", trace.id));
            }
            traces.push(TraceData {
                id: trace.id.clone(),
                x,
                y,
                z,
                x_dimension: trace.x_dimension.clone(),
                y_dimension: trace.y_dimension.clone(),
                downsampled_from: trace.downsampled_from,
            });
        }
        Ok(PlotData {
            region_id: header.region_id,
            state: header.state,
            error: header.error,
            traces,
            limits: header.limits,
            limit_errors: header.limit_errors,
            units: header.units,
            unit_errors: header.unit_errors,
            reference_lines: header.reference_lines,
            reference_line_errors: header.reference_line_errors,
            implicit_x: header.implicit_x,
        })
    }
}
