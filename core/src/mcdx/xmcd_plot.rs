//! The plot of an `.xmcd`: a binary item, the serialized object of the reference application's
//! own plot region.
//!
//! The item holds a tree of the plot's expressions (`tree`), the plot format (`graphData`), one
//! record per axis (`axisFormat`) and one per trace style (`trace2D`). The expressions are written
//! as `ml:`-shaped XML and go through the same translator as every other math, so a plot
//! expression and a math region read alike.

use super::{attr_f64, math, plot_math_text, round2, ImportReport, Placement, Source};
use crate::layout::PageSetup;
use crate::plot::{
    AxisKind, AxisLimit, AxisScale, PlotAxes, PlotAxis, PlotAxisPosition, PlotKind,
    PlotReferenceLine, PlotSpec, PlotTrace, TraceKind, TraceLinePattern, TraceLineStyle,
    TraceMarkerShape, TraceMarkerStyle, TracePresentation, TraceYAxis,
};
use crate::project::DocumentRegion;
use std::collections::HashMap;

/// Relation bits of a tree node: the node is the right child of its parent (else the
/// left), and the value was computed by the application rather than typed.
const RIGHT: u8 = 0x80;
const COMPUTED: u8 = 0x02;
/// The type of a leaf that is a name; any other leaf is a number.
const NAME_LEAF: u8 = 0x24;

const KIND_ROOT: u16 = 0xc119;
const KIND_PAIR: u16 = 0xc19f;
const KIND_LEAF: u16 = 0x0f02;
const KIND_EMPTY: u16 = 0x0f00;
const KIND_SEQUENCE: u16 = 0xc30a;
const KIND_PARENS: u16 = 0x708e;
const KIND_CALL: u16 = 0xce12;

#[derive(Debug)]
struct TreeNode {
    kind: u16,
    rel: u8,
    text: Option<String>,
    left: Option<usize>,
    right: Option<usize>,
}

#[derive(Debug)]
struct Tree {
    nodes: Vec<TreeNode>,
    root: usize,
}

impl Tree {
    fn node(&self, index: usize) -> &TreeNode {
        &self.nodes[index]
    }

    fn left(&self, index: usize) -> Option<usize> {
        self.nodes[index].left
    }

    fn right(&self, index: usize) -> Option<usize> {
        self.nodes[index].right
    }

    fn is_empty(&self, index: Option<usize>) -> bool {
        index.is_none_or(|i| self.nodes[i].kind == KIND_EMPTY)
    }
}

fn utf16(raw: &[u8]) -> String {
    let units: Vec<u16> = raw
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    String::from_utf16_lossy(&units)
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// an id or a parent reference. Values from 0x40 are escaped, because 0x40 is also the
/// record marker of older files: `40 v` for one byte, `41 lo hi` for two.
fn varint(t: &[u8], i: usize) -> Option<(usize, usize)> {
    match *t.get(i)? {
        0x40 => Some((*t.get(i + 1)? as usize, i + 2)),
        0x41 => Some((
            u16::from_le_bytes([*t.get(i + 1)?, *t.get(i + 2)?]) as usize,
            i + 3,
        )),
        v => Some((v as usize, i + 1)),
    }
}

fn encode_varint(v: usize) -> Vec<u8> {
    match v {
        0..=0x3f => vec![v as u8],
        0x40..=0xff => vec![0x40, v as u8],
        _ => {
            let [lo, hi] = (v as u16).to_le_bytes();
            vec![0x41, lo, hi]
        }
    }
}

/// the node records of the `tree` part. A record is `id, marker, kind (u16), 0, 0, relation,
/// parent id`, then the string of a leaf; ids count up by one, which finds the next record.
fn parse_tree(item: &[u8]) -> Result<(Tree, bool), String> {
    let start = find(item, b"tree", 0).ok_or("the plot has no expression tree")?;
    let end = find(item, b"d2_graph_format", start).unwrap_or(item.len());
    let t = &item[start..end];
    // Files saved by the newest versions mark a record with one byte and write UTF-16 strings;
    // older ones mark it with two and write 8-bit strings.
    let (marker, wide): (&[u8], bool) = if find(t, &[0x32, 0x19, 0xc1], 0).is_some() {
        (&[0x32], true)
    } else {
        (&[0x40, 0x40], false)
    };
    let first = [marker, &[0x19, 0xc1]].concat();
    let mut i = find(t, &first, 0)
        .and_then(|p| p.checked_sub(1))
        .ok_or("the expression tree has no root")?;
    let mut ids: Vec<usize> = Vec::new();
    let mut parents: Vec<usize> = Vec::new();
    let mut nodes: Vec<TreeNode> = Vec::new();
    while let Some((id, after_id)) = varint(t, i) {
        if t.get(after_id..after_id + marker.len()) != Some(marker) {
            break;
        }
        let k = after_id + marker.len();
        let (Some(lo), Some(hi), Some(rel)) = (t.get(k), t.get(k + 1), t.get(k + 4)) else {
            break;
        };
        let kind = u16::from_le_bytes([*lo, *hi]);
        let rel = *rel;
        let (parent, mut j) = varint(t, k + 5).ok_or("a truncated tree record")?;
        let mut text = None;
        if kind == KIND_LEAF {
            // A name is usually `n + 1, n, chars`; a number, and some names, `n + 1, 1, n, chars`.
            j += 2;
            let first = *t.get(j).ok_or("a truncated leaf")?;
            let second = *t.get(j + 1).ok_or("a truncated leaf")?;
            let n = if rel & 0x3f == NAME_LEAF && second.wrapping_add(1) == first {
                j += 2;
                second
            } else {
                let n = *t.get(j + 2).ok_or("a truncated number")?;
                j += 3;
                n
            } as usize;
            let len = if wide { 2 * n } else { n };
            let raw = t.get(j..j + len).ok_or("a truncated string")?;
            text = Some(if wide {
                utf16(raw)
            } else {
                raw.iter().map(|b| *b as char).collect()
            });
            j += len;
        }
        ids.push(id);
        parents.push(parent);
        nodes.push(TreeNode {
            kind,
            rel,
            text,
            left: None,
            right: None,
        });
        let next = [&encode_varint(id + 1)[..], marker].concat();
        match find(t, &next, j) {
            Some(k) => i = k,
            None => break,
        }
    }
    // Ids may be reused by a large tree: the parent is the latest earlier record with that id.
    for index in 0..nodes.len() {
        if let Some(parent) = ids[..index].iter().rposition(|id| *id == parents[index]) {
            if nodes[index].rel & RIGHT != 0 {
                nodes[parent].right = Some(index);
            } else {
                nodes[parent].left = Some(index);
            }
        }
    }
    let root = nodes
        .iter()
        .position(|n| n.kind == KIND_ROOT)
        .ok_or("the expression tree has no root")?;
    Ok((Tree { nodes, root }, wide))
}

// ---- expressions -------------------------------------------------------------------------

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The operands of a left-nested comma sequence, in order.
fn sequence(tree: &Tree, index: usize, out: &mut Vec<usize>) {
    if tree.node(index).kind == KIND_SEQUENCE {
        if let Some(l) = tree.left(index) {
            sequence(tree, l, out);
        }
        if let Some(r) = tree.right(index) {
            sequence(tree, r, out);
        }
    } else {
        out.push(index);
    }
}

/// one node as `ml:`-shaped XML, read by the math translator.
fn xml(tree: &Tree, index: Option<usize>) -> Result<String, String> {
    let Some(index) = index else {
        return Err("an operator has a missing operand".into());
    };
    let node = tree.node(index);
    let both = |op: &str| -> Result<String, String> {
        Ok(format!(
            "<apply><{op}/>{}{}</apply>",
            xml(tree, node.left)?,
            xml(tree, node.right)?
        ))
    };
    let left_only = |op: &str| -> Result<String, String> {
        Ok(format!("<apply><{op}/>{}</apply>", xml(tree, node.left)?))
    };
    let right_only = |op: &str| -> Result<String, String> {
        Ok(format!("<apply><{op}/>{}</apply>", xml(tree, node.right)?))
    };
    match node.kind {
        KIND_LEAF => {
            let text = node.text.as_deref().unwrap_or("").trim();
            if node.rel & 0x3f == NAME_LEAF {
                // A literal subscript is written after a dot (`y.a`), as it is typed.
                Ok(match text.split_once('.') {
                    Some((base, sub)) if !base.is_empty() && !sub.is_empty() => {
                        format!("<id subscript=\"{}\">{}</id>", escape(sub), escape(base))
                    }
                    _ => format!("<id>{}</id>", escape(text)),
                })
            } else if let Some(digits) = text.strip_suffix(['i', 'j']) {
                let symbol = if text.ends_with('j') { "j" } else { "i" };
                let digits = if digits.is_empty() { "1" } else { digits };
                Ok(format!(
                    "<imag symbol=\"{symbol}\">{}</imag>",
                    escape(digits)
                ))
            } else {
                Ok(format!("<real>{}</real>", escape(text)))
            }
        }
        KIND_EMPTY => Ok("<placeholder/>".into()),
        KIND_PARENS => Ok(format!("<parens>{}</parens>", xml(tree, node.right)?)),
        KIND_CALL => {
            let head = xml(tree, node.left)?;
            let mut args = Vec::new();
            if let Some(parens) = node.right {
                let inner = if tree.node(parens).kind == KIND_PARENS {
                    tree.right(parens)
                } else {
                    Some(parens)
                };
                if let Some(inner) = inner {
                    sequence(tree, inner, &mut args);
                }
            }
            let args: Vec<String> = args
                .into_iter()
                .map(|a| xml(tree, Some(a)))
                .collect::<Result<_, _>>()?;
            Ok(if args.len() == 1 {
                format!("<apply>{head}{}</apply>", args[0])
            } else {
                format!(
                    "<apply>{head}<sequence>{}</sequence></apply>",
                    args.join("")
                )
            })
        }
        0x4b95 => right_only("neg"),
        0xc789 => both("plus"),
        0xc788 => both("minus"),
        0xca06 => both("mult"),
        0xfb07 | 0xcb07 => both("div"),
        0xca5f => Ok(format!(
            "<apply><div inline=\"true\"/>{}{}</apply>",
            xml(tree, node.left)?,
            xml(tree, node.right)?
        )),
        // `cc05` is the power of ten of a number shown in scientific form.
        0xfc05 | 0xcc05 => both("pow"),
        0xca32 => both("crossProduct"),
        0xc529 => both("lessThan"),
        0xc528 => both("greaterThan"),
        0xc52e => both("lessOrEqual"),
        0xc52d => both("greaterOrEqual"),
        0xc538 => both("notEqual"),
        0xc52c => both("equal"),
        0xc4e0 => both("and"),
        0xc217 => Ok(format!(
            "<range>{}{}</range>",
            xml(tree, node.left)?,
            xml(tree, node.right)?
        )),
        0xfd04 => {
            let mut indices = Vec::new();
            if let Some(r) = node.right {
                sequence(tree, r, &mut indices);
            }
            let indices: Vec<String> = indices
                .into_iter()
                .map(|i| xml(tree, Some(i)))
                .collect::<Result<_, _>>()?;
            let index = if indices.len() == 1 {
                indices[0].clone()
            } else {
                format!("<sequence>{}</sequence>", indices.join(""))
            };
            Ok(format!(
                "<apply><indexer/>{}{index}</apply>",
                xml(tree, node.left)?
            ))
        }
        0xfd34 => both("matcol"),
        0x8cb1 => left_only("vectorize"),
        0x8cb3 => left_only("transpose"),
        0x8caa => left_only("conjugate"),
        0x8c9e => left_only("factorial"),
        0x7b9a => right_only("sqrt"),
        0x7b9d => right_only("absval"),
        0x4bb7 => right_only("vectorSum"),
        0xfed0 => both("nthRoot"),
        0xf924 => Ok(format!(
            "<apply><derivative/><lambda><boundVars>{}</boundVars>{}</lambda></apply>",
            xml(tree, node.left)?,
            xml(tree, node.right)?
        )),
        other => Err(format!("the plot operator `{other:04x}` is not known")),
    }
}

/// The canonical text of one expression node; `None` for an empty slot.
fn expression_text(
    tree: &Tree,
    index: usize,
    units: &std::rc::Rc<HashMap<String, &'static str>>,
) -> Result<Option<String>, (String, String)> {
    if tree.node(index).kind == KIND_EMPTY {
        return Ok(None);
    }
    let body = xml(tree, Some(index)).map_err(|m| ("plot-not-imported".to_owned(), m))?;
    let wrapped = format!("<e>{body}</e>");
    let doc = roxmltree::Document::parse(&wrapped)
        .map_err(|e| ("plot-not-imported".to_owned(), e.to_string()))?;
    let content = doc.root_element().first_element_child().ok_or((
        "plot-not-imported".to_owned(),
        "an empty expression".to_owned(),
    ))?;
    math::with_implicit_labels(units.clone(), || plot_math_text(content))
}

// ---- format ------------------------------------------------------------------------------

/// One `axisFormat` record.
#[derive(Debug, Default, Clone)]
struct AxisFormat {
    flags: u8,
    label: String,
}

impl AxisFormat {
    fn log(&self) -> bool {
        self.flags & 0x01 != 0
    }
    fn grid(&self) -> bool {
        self.flags & 0x02 != 0
    }
    fn markers(&self) -> bool {
        self.flags & 0x10 != 0
    }
}

/// One `trace2D` record.
#[derive(Debug, Default, Clone)]
struct TraceFormat {
    line: u8,
    color: [u8; 3],
    symbol: u8,
    kind: u8,
    line_weight: Option<u8>,
    label: String,
}

#[derive(Debug, Default)]
struct Format {
    axes: Option<[AxisFormat; 3]>,
    title: String,
    hide_legend: bool,
    axis_style: u8,
    traces: Vec<TraceFormat>,
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
    wide: bool,
}

impl Reader<'_> {
    fn byte(&mut self) -> Option<u8> {
        let v = *self.b.get(self.p)?;
        self.p += 1;
        Some(v)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        (self.p + n <= self.b.len()).then(|| self.p += n)
    }
    fn string(&mut self) -> Option<String> {
        let n = self.byte()? as usize;
        let len = if self.wide { 2 * n } else { n };
        let raw = self.b.get(self.p..self.p + len)?;
        self.p += len;
        Some(if self.wide {
            utf16(raw)
        } else {
            raw.iter().map(|b| *b as char).collect()
        })
    }
}

/// three axis records (x, y, second y) and the plot title after them; `None` when the
/// part does not end where the trace styles begin.
fn parse_axes(item: &[u8], wide: bool) -> Option<([AxisFormat; 3], String)> {
    let start = find(item, b"axisFormat", 0)? + "axisFormat".len();
    let mut r = Reader {
        b: item,
        p: start + 10,
        wide,
    };
    let mut axes: [AxisFormat; 3] = Default::default();
    for (k, axis) in axes.iter_mut().enumerate() {
        if k > 0 {
            r.skip(1)?;
        }
        axis.flags = r.byte()?;
        r.skip(8 + 4)?;
        axis.label = r.string()?;
        r.skip(7)?;
    }
    let title = r.string()?;
    (item.get(r.p..r.p + 14)? == b"\x01\x00\x01\x00\x00\x00\x07trace2D").then_some((axes, title))
}

/// the trace style records. Each has a line group (a mask, then the line style and the
/// colour) and a group of optional fields chosen by the bits a second mask leaves clear.
fn parse_traces(item: &[u8], wide: bool) -> Option<Vec<TraceFormat>> {
    let start = find(item, b"trace2D", 0)? + "trace2D".len();
    let version = *item.get(start)?;
    let mut r = Reader {
        b: item,
        p: start + 6 + 8,
        wide,
    };
    // The optional fields of a style group, then the frequency, the next two bytes and, in the
    // header, the number of records.
    fn group(r: &mut Reader, t: &mut TraceFormat) -> Option<()> {
        let mask = r.byte()?;
        if mask & 0x01 == 0 {
            t.symbol = r.byte()?;
        }
        if mask & 0x02 == 0 {
            t.kind = r.byte()?;
        }
        if mask & 0x04 == 0 {
            t.line_weight = Some(r.byte()?);
        }
        if mask & 0x08 == 0 {
            r.byte()?;
        }
        if mask & 0x10 == 0 {
            t.label = r.string()?;
        }
        r.byte()?;
        Some(())
    }
    let mut header = TraceFormat::default();
    group(&mut r, &mut header)?;
    let count = u16::from_le_bytes([r.byte()?, r.byte()?]) as usize;
    let mut more = r.byte()?;
    let mut traces = Vec::new();
    while more != 0 && traces.len() < count.max(1) {
        let mut t = TraceFormat::default();
        let mask = r.byte()?;
        if version < 3 {
            if mask != 0x29 {
                return None;
            }
            t.line = r.byte()?;
            t.color = [r.byte()?, r.byte()?, r.byte()?];
        } else {
            let mut fields = [0u8; 8];
            for (bit, field) in fields.iter_mut().enumerate() {
                if mask & (1 << bit) == 0 {
                    *field = r.byte()?;
                }
            }
            t.line = fields[2];
            t.color = [fields[5], fields[6], fields[7]];
        }
        group(&mut r, &mut t)?;
        r.byte()?;
        more = r.byte()?;
        traces.push(t);
    }
    Some(traces)
}

fn parse_format(item: &[u8], wide: bool, report: &mut ImportReport, id: &str) -> Format {
    let mut format = Format::default();
    if let Some(g) = find(item, b"graphData", 0).map(|p| p + "graphData".len()) {
        let flags = item.get(g + 14).copied().unwrap_or(0);
        format.hide_legend = flags & 0x02 != 0;
        format.axis_style = item.get(g + 23).copied().unwrap_or(1);
    }
    match parse_axes(item, wide) {
        Some((axes, title)) => {
            format.axes = Some(axes);
            format.title = title;
        }
        None => report.note(
            "plot-format-dropped",
            Some(id),
            "the axis settings of the plot could not be read; the axes are imported with their defaults",
        ),
    }
    match parse_traces(item, wide) {
        Some(traces) => format.traces = traces,
        None => report.note(
            "plot-format-dropped",
            Some(id),
            "the trace styles of the plot could not be read; the traces are imported with their defaults",
        ),
    }
    format
}

// ---- the region --------------------------------------------------------------------------

/// One axis of the tree: its expressions, the limits the author typed and the markers.
struct TreeAxis {
    expressions: Vec<usize>,
    max: Option<usize>,
    min: Option<usize>,
    markers: Vec<usize>,
}

fn tree_axis(tree: &Tree, index: Option<usize>) -> TreeAxis {
    let mut axis = TreeAxis {
        expressions: Vec::new(),
        max: None,
        min: None,
        markers: Vec::new(),
    };
    let Some(index) = index else {
        return axis;
    };
    if let Some(expr) = tree.right(index) {
        if !tree.is_empty(Some(expr)) {
            sequence(tree, expr, &mut axis.expressions);
        }
    }
    let settings = tree.left(index);
    let limits = settings.and_then(|s| tree.left(s));
    let markers = settings.and_then(|s| tree.right(s));
    // A limit the application computed (autoscale) carries the computed bit: only typed limits are
    // the author's.
    let typed = |i: Option<usize>| {
        i.filter(|i| !tree.is_empty(Some(*i)) && tree.node(*i).rel & COMPUTED == 0)
    };
    if let Some(l) = limits {
        axis.max = typed(tree.left(l));
        axis.min = typed(tree.right(l));
    }
    if let Some(m) = markers {
        for i in [tree.left(m), tree.right(m)].into_iter().flatten() {
            if !tree.is_empty(Some(i)) {
                axis.markers.push(i);
            }
        }
    }
    axis
}

fn limit(
    tree: &Tree,
    index: Option<usize>,
    units: &std::rc::Rc<HashMap<String, &'static str>>,
    report: &mut ImportReport,
    id: &str,
) -> Option<AxisLimit> {
    match expression_text(tree, index?, units) {
        Ok(Some(text)) => Some(match text.parse::<f64>() {
            Ok(v) if v.is_finite() => AxisLimit::Value(v),
            _ => AxisLimit::Expression(text),
        }),
        Ok(None) => None,
        Err((_, message)) => {
            report.note(
                "plot-limits-dropped",
                Some(id),
                format!("an axis limit or marker is not imported: {message}"),
            );
            None
        }
    }
}

fn marker_shape(symbol: u8) -> Option<TraceMarkerShape> {
    Some(match symbol {
        1 => TraceMarkerShape::X,
        2 => TraceMarkerShape::Cross,
        3 | 7 => TraceMarkerShape::Square,
        4 | 8 => TraceMarkerShape::Diamond,
        5 | 9 => TraceMarkerShape::Circle,
        6 | 10 => TraceMarkerShape::TriangleUp,
        _ => return None,
    })
}

fn line_pattern(line: u8) -> TraceLinePattern {
    match line {
        2 => TraceLinePattern::Dot,
        3 => TraceLinePattern::Dash,
        4 => TraceLinePattern::DashDot,
        _ => TraceLinePattern::Solid,
    }
}

fn plot_trace(
    i: usize,
    x: &str,
    y: &str,
    y_axis: TraceYAxis,
    style: &TraceFormat,
    show_in_legend: bool,
    dropped: &mut Vec<String>,
) -> PlotTrace {
    let kind = match style.kind {
        3 | 7 => TraceKind::Bars,
        4 => TraceKind::Steps,
        6 => TraceKind::Stems,
        0 | 1 => TraceKind::Lines,
        other => {
            dropped.push(format!(
                "trace {} has the trace type {}, imported as a line",
                i + 1,
                match other {
                    2 => "error",
                    5 => "draw",
                    _ => "unknown",
                }
            ));
            TraceKind::Lines
        }
    };
    let points = style.kind == 1;
    let shape = marker_shape(style.symbol);
    if matches!(style.symbol, 7..=10) {
        dropped.push(format!(
            "trace {} has a filled symbol, imported as an outline",
            i + 1
        ));
    }
    let line_on = style.line != 0 && !points;
    let marker_on = shape.is_some() || points;
    let color = Some(format!(
        "#{:02x}{:02x}{:02x}",
        style.color[0], style.color[1], style.color[2]
    ));
    PlotTrace {
        id: format!("trace-{}", i + 1),
        x: x.to_owned(),
        y: y.to_owned(),
        z: String::new(),
        y_axis,
        presentation: match (line_on, marker_on) {
            (true, true) => TracePresentation::LineMarkers,
            (false, true) => TracePresentation::Markers,
            _ => TracePresentation::Line,
        },
        kind,
        line: TraceLineStyle {
            style: line_pattern(style.line),
            width: style
                .line_weight
                .filter(|w| (1..=9).contains(w))
                .map(|w| (w as f64).clamp(0.5, 6.0))
                .unwrap_or(TraceLineStyle::default().width),
            color: color.clone(),
        },
        marker: TraceMarkerStyle {
            shape: shape.unwrap_or(TraceMarkerShape::Circle),
            size: TraceMarkerStyle::default().size,
            color: if marker_on { color } else { None },
        },
        show_in_legend,
        legend_label: style.label.replace(['\r', '\n'], " "),
    }
}

/// a `plot` region whose item is the binary plot.
#[allow(clippy::too_many_arguments)]
pub(super) fn plot_region(
    source: &Source,
    at: Placement,
    id: &str,
    page: &PageSetup,
    item: Option<Vec<u8>>,
    units: &std::rc::Rc<HashMap<String, &'static str>>,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    let fail = |report: &mut ImportReport, message: String| {
        report.issue("plot-not-imported", Some(&source.id), message);
        None
    };
    let Some(item) = item else {
        return fail(report, "the plot data is missing or unreadable".into());
    };
    if find(&item, b"d2_graph_format", 0).is_none() {
        return fail(
            report,
            "only X-Y plots are imported (this one is a polar, 3D or other plot)".into(),
        );
    }
    let (tree, wide) = match parse_tree(&item) {
        Ok(t) => t,
        Err(message) => return fail(report, message),
    };
    let root = tree.root;
    let y_side = tree.left(root);
    // plots with a second y axis hold `(y, y2)` on the left of the root; older ones hold the
    // y axis itself. Its limits sit three levels down in the first form and two in the second.
    let is_pair = |i: Option<usize>| i.is_some_and(|i| tree.node(i).kind == KIND_PAIR);
    let split = is_pair(
        y_side
            .and_then(|y| tree.left(y))
            .and_then(|y| tree.left(y))
            .and_then(|y| tree.left(y)),
    );
    let (y1, y2) = if split {
        (
            y_side.and_then(|y| tree.left(y)),
            y_side.and_then(|y| tree.right(y)),
        )
    } else {
        (y_side, None)
    };
    let axes = [
        tree_axis(&tree, tree.right(root)),
        tree_axis(&tree, y1),
        tree_axis(&tree, y2),
    ];
    let mut texts: [Vec<String>; 3] = Default::default();
    for (slot, axis) in axes.iter().enumerate() {
        for e in &axis.expressions {
            match expression_text(&tree, *e, units) {
                Ok(Some(text)) => texts[slot].push(text),
                Ok(None) => {}
                Err((code, message)) => {
                    report.issue(&code, Some(&source.id), message);
                    return None;
                }
            }
        }
    }
    let [xs, y1, y2] = texts;
    if xs.is_empty() || (y1.is_empty() && y2.is_empty()) {
        return fail(report, "an axis of the plot has no expression".into());
    }
    let ys: Vec<(String, TraceYAxis)> = y1
        .into_iter()
        .map(|y| (y, TraceYAxis::Left))
        .chain(y2.into_iter().map(|y| (y, TraceYAxis::Right)))
        .collect();
    // trace i is drawn against x expression i; the reference application draws the y
    // expressions beyond the last x against that last one.
    if xs.len() > ys.len() {
        report.note(
            "plot-style-dropped",
            Some(&source.id),
            format!(
                "the plot has {} x expressions for {} y expressions; the extra x expressions are not imported",
                xs.len(),
                ys.len()
            ),
        );
    }
    let format = parse_format(&item, wide, report, &source.id);
    let mut dropped = Vec::new();
    let traces: Vec<PlotTrace> = ys
        .iter()
        .enumerate()
        .map(|(i, (y, axis))| {
            let style = format.traces.get(i).cloned().unwrap_or_default();
            let x = &xs[i.min(xs.len() - 1)];
            plot_trace(i, x, y, *axis, &style, !format.hide_legend, &mut dropped)
        })
        .collect();
    let axis_formats = format.axes.clone().unwrap_or_default();
    let position = match format.axis_style {
        2 => PlotAxisPosition::Origin,
        0 => {
            dropped.push("the axes are hidden in the plot; they are imported boxed".into());
            PlotAxisPosition::Boundary
        }
        _ => PlotAxisPosition::Boundary,
    };
    let mut reference_lines = Vec::new();
    let mut plot_axis = |slot: usize, kind: AxisKind, report: &mut ImportReport| {
        let f = &axis_formats[slot];
        let axis = &axes[slot];
        let mut min = limit(&tree, axis.min, units, report, &source.id);
        let mut max = limit(&tree, axis.max, units, report, &source.id);
        let number = |l: &Option<AxisLimit>| l.as_ref().and_then(AxisLimit::value);
        if number(&min).zip(number(&max)).is_some_and(|(a, b)| a >= b)
            || (f.log()
                && (number(&min).is_some_and(|v| v <= 0.0)
                    || number(&max).is_some_and(|v| v <= 0.0)))
        {
            min = None;
            max = None;
            report.note(
                "plot-limits-dropped",
                Some(&source.id),
                format!(
                    "the {} axis limits are not usable (unordered or not positive on a log axis)",
                    kind.as_str()
                ),
            );
        }
        if f.markers() && kind == AxisKind::Y2 && !axis.markers.is_empty() {
            report.note(
                "plot-style-dropped",
                Some(&source.id),
                "the markers of the second y axis are not imported",
            );
        } else if f.markers() {
            for m in &axis.markers {
                if let Some(value) = limit(&tree, Some(*m), units, report, &source.id) {
                    reference_lines.push(PlotReferenceLine {
                        id: format!("marker-{}", reference_lines.len() + 1),
                        axis: kind,
                        value,
                        line: TraceLineStyle {
                            style: TraceLinePattern::Dash,
                            ..TraceLineStyle::default()
                        },
                        show_in_legend: false,
                        legend_label: String::new(),
                    });
                }
            }
        }
        PlotAxis {
            scale: if f.log() {
                AxisScale::Log10
            } else {
                AxisScale::Linear
            },
            position,
            unit: None,
            min,
            max,
            title: f.label.replace(['\r', '\n'], " "),
            show_grid: f.grid(),
        }
    };
    let plot_axes = PlotAxes {
        x: plot_axis(0, AxisKind::X, report),
        y: plot_axis(1, AxisKind::Y, report),
        y2: Box::new(plot_axis(2, AxisKind::Y2, report)),
    };
    let size = match (
        attr_f64(source.region, "width"),
        attr_f64(source.region, "height"),
    ) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => [
            round2(w.clamp(crate::plot::MIN_PLOT_WIDTH, page.content_width())),
            round2(h.max(crate::plot::MIN_PLOT_HEIGHT)),
        ],
        _ => [
            crate::plot::DEFAULT_PLOT_WIDTH,
            crate::plot::DEFAULT_PLOT_HEIGHT,
        ],
    };
    let spec = PlotSpec {
        version: crate::plot::PLOT_VERSION,
        kind: PlotKind::Xy,
        title: format.title.replace(['\r', '\n'], " "),
        size,
        axes: plot_axes,
        grid_spacing: None,
        legend_position: crate::plot::LegendPosition::default(),
        legend_font_size: None,
        traces,
        reference_lines,
    };
    if let Err(message) = spec.validate() {
        return fail(report, message);
    }
    for message in dropped {
        report.note("plot-style-dropped", Some(&source.id), message);
    }
    report.note(
        "plot-style-dropped",
        None,
        "number formats, tick and grid counts, grid and marker colours, equal scales, hidden arguments, \
         the title position, symbol weights and symbol frequencies of plots are not imported",
    );
    Some(DocumentRegion::Plot(Box::new(crate::plot::PlotRegion {
        id: id.to_owned(),
        page: at.page,
        x: at.x,
        y: at.y,
        enabled: true,
        plot: spec,
        view: None,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a tree record list of `t` on x and `sin(t)` on y (the bytes of a saved plot).
    #[test]
    fn a_tree_reads_back_as_expressions() {
        let hex = "74 72 65 65 1b 00 00 00 00 00 32 00 00 00 0d 70 00 00 00 00 00 04 32 19 c1 00 00 80 03 05 32 9f c1 00 00 40 04 06 32 9f c1 00 00 40 05 07 32 9f c1 00 00 40 06 08 32 9f c1 00 00 40 07 09 32 02 0f 00 00 76 08 00 00 02 01 01 31 00 00 0a 32 95 4b 00 00 82 08 00 0b 32 02 0f 00 00 b4 0a 00 00 02 01 01 31 00 00 00 00 0c 32 9f c1 00 00 80 07 0d 32 00 0f 00 00 42 0c 00 00 00 0e 32 00 0f 00 00 82 0c 00 00 00 00 00 0f 32 12 ce 00 00 80 06 10 32 02 0f 00 00 64 0f 00 00 04 03 73 00 69 00 6e 00 00 11 32 8e 70 00 00 80 0f 00 12 32 02 0f 00 00 a4 11 00 00 02 01 74 00 00 00 00 00 13 32 9f c1 00 00 80 05 14 32 9f c1 00 00 40 13 15 32 9f c1 00 00 40 14 16 32 02 0f 00 00 76 15 00 00 02 01 01 30 00 00 17 32 02 0f 00 00 b6 15 00 00 02 01 01 30 00 00 00 18 32 9f c1 00 00 80 14 19 32 00 0f 00 00 42 18 00 00 00 1a 32 00 0f 00 00 82 18 00 00 00 00 00 1b 32 00 0f 00 00 82 13 00 00 00 00 00 1c 32 9f c1 00 00 80 04 1d 32 9f c1 00 00 40 1c 1e 32 9f c1 00 00 40 1d 1f 32 02 0f 00 00 76 1e 00 00 03 01 02 31 00 30 00 00 20 32 95 4b 00 00 82 1e 00 21 32 02 0f 00 00 b4 20 00 00 03 01 02 31 00 30 00 00 00 00 22 32 9f c1 00 00 80 1d 23 32 00 0f 00 00 42 22 00 00 00 24 32 00 0f 00 00 82 22 00 00 00 00 00 25 32 02 0f 00 00 a4 1c 00 00 02 01 74 00 00 00 26 00 02 00 00 00 0f 64 32 5f 67 72 61 70 68 5f 66 6f 72 6d 61 74";
        let bytes: Vec<u8> = hex
            .split(' ')
            .map(|h| u8::from_str_radix(h, 16).unwrap())
            .collect();
        let (tree, wide) = parse_tree(&bytes).unwrap();
        assert!(wide);
        let units = std::rc::Rc::new(HashMap::new());
        let x = tree_axis(&tree, tree.right(tree.root));
        let y = tree_axis(&tree, tree.left(tree.root).and_then(|s| tree.left(s)));
        let text = |i: usize| expression_text(&tree, i, &units).unwrap().unwrap();
        assert_eq!(
            x.expressions.iter().map(|i| text(*i)).collect::<Vec<_>>(),
            ["t"]
        );
        assert_eq!(
            y.expressions.iter().map(|i| text(*i)).collect::<Vec<_>>(),
            ["sin(t)"]
        );
        // The limits shown (±1, ±10) were computed by autoscale, so none is the author's.
        assert!(x.min.is_none() && x.max.is_none() && y.min.is_none() && y.max.is_none());
    }
}
