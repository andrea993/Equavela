//! Deterministic writer of the worksheet YAML text format: the inverse of
//! [`crate::worksheet_file::parse_document`].
//!
//! The output is a function of the document model only: fixed key order, 2-space block
//! indentation, LF line endings, no comments, no anchors, no tags, defaults omitted. Math is
//! written as canonical linear text ([`crate::print_statement`]). The writer has its own small
//! YAML emitter so the bytes never depend on a library's formatting choices.

use crate::ast::{JuliaBlock, StatementKind};
use crate::graph::Region;
use crate::layout::{PageSetup, TextRegion};
use crate::plot::{AxisScale, PlotAxis, PlotRegion, PlotSpec, TraceKind, TracePresentation};
use crate::print_statement;
use crate::project::{DocumentRegion, IncludeRegion, ProjectDocument};
use crate::worksheet_file::FORMAT_ID;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("region `{region_id}` has a number that is not finite ({what})")]
    NotFinite { region_id: String, what: String },
    #[error("plot region `{region_id}` is invalid: {message}")]
    Plot { region_id: String, message: String },
    #[error("image region `{region_id}` is invalid: {message}")]
    Image { region_id: String, message: String },
    #[error("julia region `{region_id}` is invalid: {message}")]
    Julia { region_id: String, message: String },
    #[error("area region `{region_id}` is invalid: {message}")]
    Area { region_id: String, message: String },
    #[error("table region `{region_id}` is invalid: {message}")]
    Table { region_id: String, message: String },
    #[error("the page setup has a number that is not finite")]
    Page,
    #[error("the page break on page {page} is invalid: {message}")]
    PageBreak { page: u32, message: String },
    #[error("the page {what} is not one line of text: {message}")]
    PageLine { what: String, message: String },
    #[error("cannot write `{path}`: {message}")]
    Io { path: String, message: String },
}

/// Serializes a document to its canonical YAML text (always ends with one LF).
pub fn write_document(document: &ProjectDocument) -> Result<String, WriteError> {
    let mut out = String::new();
    //  / : the identifying key is byte zero.
    let _ = writeln!(out, "format: {FORMAT_ID}");
    write_page(&mut out, &document.page)?;
    write_page_breaks(&mut out, document)?;
    write_settings(&mut out, document);
    if let Some(environment) = &document.environment {
        let _ = writeln!(
            out,
            "environment: {}",
            scalar(environment, Style::Plain, false)
        );
    }
    if document.regions.is_empty() {
        out.push_str("regions: []\n");
        return Ok(out);
    }
    out.push_str("regions:\n");
    for region in &document.regions {
        let mut body = String::new();
        match region.as_ref() {
            DocumentRegion::Math(region) => write_math(&mut body, document, region)?,
            DocumentRegion::Include(region) => write_include(&mut body, region)?,
            DocumentRegion::Text(region) => {
                write_text(&mut body, region, document.page.margins.left)?
            }
            DocumentRegion::Plot(region) => write_plot(&mut body, region)?,
            DocumentRegion::Image(region) => write_image(&mut body, document, region)?,
            DocumentRegion::Area(region) => write_area(&mut body, region)?,
        }
        // The body is written at indentation 4; the first line carries the list dash.
        out.push_str("  - ");
        out.push_str(&body[4..]);
    }
    write_resources(&mut out, document);
    Ok(out)
}

fn write_area(out: &mut String, region: &crate::area::AreaRegion) -> Result<(), WriteError> {
    write_head(
        out,
        &region.id,
        region.page,
        region.x,
        region.y,
        region.enabled,
    )?;
    if !crate::area::valid_height(region.height) {
        return Err(WriteError::Area {
            region_id: region.id.clone(),
            message: "height must be a finite number of at least 24 pt".into(),
        });
    }
    out.push_str(
        "    area:
",
    );
    if !region.title.is_empty() {
        entry(out, 6, "title", &region.title, Style::Plain);
    }
    let _ = writeln!(out, "      height: {}", num(region.height));
    if region.collapsed {
        out.push_str(
            "      collapsed: true
",
        );
    }
    Ok(())
}

fn write_image(
    out: &mut String,
    document: &ProjectDocument,
    region: &crate::image::ImageRegion,
) -> Result<(), WriteError> {
    write_head(
        out,
        &region.id,
        region.page,
        region.x,
        region.y,
        region.enabled,
    )?;
    if !document.has_resource(&region.resource) {
        return Err(WriteError::Image {
            region_id: region.id.clone(),
            message: format!("resource `{}` does not exist", region.resource),
        });
    }
    if region.size.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return Err(WriteError::Image {
            region_id: region.id.clone(),
            message: "size must be two positive finite numbers".into(),
        });
    }
    out.push_str("    image:\n");
    let _ = writeln!(
        out,
        "      resource: {}",
        scalar(&region.resource, Style::Plain, false)
    );
    let _ = writeln!(
        out,
        "      size: [{}, {}]",
        num(region.size[0]),
        num(region.size[1])
    );
    Ok(())
}

/// The `resources` section: only the resources an image region uses, in id order.
fn write_resources(out: &mut String, document: &ProjectDocument) {
    let used: std::collections::BTreeSet<&str> = document
        .regions
        .iter()
        .filter_map(|r| match r.as_ref() {
            DocumentRegion::Image(image) => Some(image.resource.as_str()),
            _ => None,
        })
        .collect();
    if used.is_empty() {
        return;
    }
    out.push_str("resources:\n");
    // Embedded resources and project assets share one id space and one id order.
    let mut ids: Vec<&String> = document
        .resources
        .keys()
        .chain(document.assets.keys())
        .collect();
    ids.sort();
    for id in ids {
        if !used.contains(id.as_str()) {
            continue;
        }
        let _ = writeln!(out, "  {}:", scalar(id, Style::Plain, false));
        if let Some(asset) = document.assets.get(id) {
            let _ = writeln!(out, "    media: {}", asset.media.name());
            let _ = writeln!(
                out,
                "    asset: {}",
                scalar(&asset.path, Style::Plain, false)
            );
            continue;
        }
        let resource = &document.resources[id];
        let _ = writeln!(out, "    media: {}", resource.media.name());
        if resource.media == crate::image::ImageMedia::Svg {
            let text = String::from_utf8_lossy(&resource.data);
            entry(out, 4, "text", text.trim(), Style::Code);
        } else {
            let encoded = crate::image::base64_encode(&resource.data);
            let lines: Vec<&str> = encoded
                .as_bytes()
                .chunks(76)
                .map(|c| std::str::from_utf8(c).unwrap_or(""))
                .collect();
            entry(out, 4, "base64", &lines.join("\n"), Style::Code);
        }
    }
}

/// Writes `content` to `path` atomically: a temporary file in the same directory is written
/// and flushed, then renamed over the target, so a crash never leaves a half-written file.
pub fn write_file_atomic(path: &Path, content: &str) -> Result<(), WriteError> {
    write_bytes_atomic(path, content.as_bytes())
}

/// As [`write_file_atomic`], for bytes.
pub fn write_bytes_atomic(path: &Path, content: &[u8]) -> Result<(), WriteError> {
    let fail = |message: String| WriteError::Io {
        path: path.display().to_string(),
        message,
    };
    let directory = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => std::path::PathBuf::from("."),
    };
    let name = path
        .file_name()
        .ok_or_else(|| fail("the path has no file name".into()))?
        .to_string_lossy()
        .into_owned();
    let mut temporary = tempfile::Builder::new()
        .prefix(&format!(".{name}."))
        .suffix(".tmp")
        .tempfile_in(&directory)
        .map_err(|error| fail(error.to_string()))?;
    temporary
        .write_all(content)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| fail(error.to_string()))?;
    temporary
        .persist(path)
        .map_err(|error| fail(error.error.to_string()))?;
    Ok(())
}

// ---- sections --------------------------------------------------------------------------------

/// the manual page breaks, one flow mapping per line, sorted by page (the model keeps them
/// sorted) and omitted when there is none.
fn write_page_breaks(out: &mut String, document: &ProjectDocument) -> Result<(), WriteError> {
    if document.page_breaks.is_empty() {
        return Ok(());
    }
    crate::layout::validate_page_breaks(&document.page_breaks, &document.page).map_err(
        |message| WriteError::PageBreak {
            page: document.page_breaks.first().map_or(0, |entry| entry.page),
            message,
        },
    )?;
    out.push_str("page-breaks:\n");
    for entry in &document.page_breaks {
        let _ = writeln!(out, "  - {{page: {}, y: {}}}", entry.page, num(entry.y));
    }
    Ok(())
}

fn write_page(out: &mut String, page: &PageSetup) -> Result<(), WriteError> {
    let m = page.margins;
    let finite = [page.width, page.height, m.top, m.right, m.bottom, m.left]
        .iter()
        .all(|v| v.is_finite());
    if !finite {
        return Err(WriteError::Page);
    }
    out.push_str("page:\n");
    // A named size is written by name (plus `orientation: landscape`) when the stored
    // dimensions are exactly those of the name; anything else is a custom `[width, height]`.
    let named = PageSetup::named(&page.size, false)
        .filter(|_| page.size != "custom")
        .and_then(|portrait| {
            if (page.width, page.height) == (portrait.width, portrait.height) {
                Some(false)
            } else if (page.width, page.height) == (portrait.height, portrait.width) {
                Some(true)
            } else {
                None
            }
        });
    match named {
        Some(landscape) => {
            let _ = writeln!(out, "  size: {}", page.size);
            if landscape {
                out.push_str("  orientation: landscape\n");
            }
        }
        None => {
            let _ = writeln!(out, "  size: [{}, {}]", num(page.width), num(page.height));
        }
    }
    let _ = writeln!(
        out,
        "  margins: {{top: {}, right: {}, bottom: {}, left: {}}}",
        num(m.top),
        num(m.right),
        num(m.bottom),
        num(m.left)
    );
    // the header and the footer, each only when a slot holds something, with the slots in
    // the order left, center, right and each value quoted when it is not a plain scalar.
    for (what, line) in [("header", &page.header), ("footer", &page.footer)] {
        if line.is_empty() {
            continue;
        }
        line.validate().map_err(|message| WriteError::PageLine {
            what: what.to_owned(),
            message,
        })?;
        let mut fields = Vec::new();
        for (slot, value) in ["left", "center", "right"].iter().zip(line.slots()) {
            if !value.is_empty() {
                fields.push(format!("{slot}: {}", scalar(value, Style::Plain, true)));
            }
        }
        let _ = writeln!(out, "  {what}: {{{}}}", fields.join(", "));
    }
    Ok(())
}

fn write_settings(out: &mut String, document: &ProjectDocument) {
    if document.settings.values.is_empty() {
        return;
    }
    out.push_str("settings:\n");
    for (key, value) in &document.settings.values {
        let rendered = if is_plain_integer(value) || value == "true" || value == "false" {
            value.clone()
        } else {
            scalar(value, Style::Plain, false)
        };
        let _ = writeln!(out, "  {}: {rendered}", key_text(key));
    }
}

/// The common head of every region: `id`, `page`, `at`, `enabled` (only when false).
fn write_head(
    out: &mut String,
    id: &str,
    page: u32,
    x: f64,
    y: f64,
    enabled: bool,
) -> Result<(), WriteError> {
    if !x.is_finite() || !y.is_finite() {
        return Err(WriteError::NotFinite {
            region_id: id.to_owned(),
            what: "position".into(),
        });
    }
    entry(out, 4, "id", id, Style::Plain);
    let _ = writeln!(out, "    page: {page}");
    let _ = writeln!(out, "    at: [{}, {}]", num(x), num(y));
    if !enabled {
        out.push_str("    enabled: false\n");
    }
    Ok(())
}

fn write_math(
    out: &mut String,
    document: &ProjectDocument,
    region: &Region,
) -> Result<(), WriteError> {
    write_head(
        out,
        &region.id,
        region.page,
        region.x,
        region.y,
        region.enabled,
    )?;
    if let StatementKind::Julia { block } = &region.statement.kind {
        return write_julia(out, &region.id, block);
    }
    entry(
        out,
        4,
        "math",
        &print_statement(&region.statement),
        Style::Math,
    );
    if let Some(breaks) = document.math_breaks.get(&region.id) {
        if !breaks.is_empty() {
            out.push_str("    breaks:\n");
            for line_break in breaks {
                out.push_str("      - path: [");
                for (index, step) in line_break.path.iter().enumerate() {
                    if index > 0 {
                        out.push_str(", ");
                    }
                    let _ = write!(out, "{step}");
                }
                out.push_str("]\n");
                if let Some(offset) = line_break.offset {
                    let _ = writeln!(out, "        offset: {offset}");
                }
            }
        }
    }
    if let Some(format) = document.result_formats.get(&region.id) {
        if !format.is_empty() {
            out.push_str("    format:\n");
            for (key, value) in format {
                let rendered = if is_plain_integer(value) {
                    value.clone()
                } else {
                    scalar(value, Style::Plain, false)
                };
                let _ = writeln!(out, "      {}: {rendered}", key_text(key));
            }
        }
    }
    if let Some(numeric) = document.numeric_options.get(&region.id) {
        if !numeric.is_empty() {
            out.push_str("    numeric:\n");
            for (key, value) in numeric {
                let rendered = if is_plain_integer(value) {
                    value.clone()
                } else {
                    scalar(value, Style::Plain, false)
                };
                let _ = writeln!(out, "      {}: {rendered}", key_text(key));
            }
        }
    }
    Ok(())
}

fn write_julia(out: &mut String, region_id: &str, block: &JuliaBlock) -> Result<(), WriteError> {
    if let Some((width, height)) = block.size {
        if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
            return Err(WriteError::Julia {
                region_id: region_id.to_owned(),
                message: "size must be two positive finite numbers".into(),
            });
        }
    }
    let code = block.code.as_deref().filter(|code| !code.is_empty());
    if block.playing
        && block.size.is_none()
        && block.using.is_empty()
        && block.imports.is_empty()
        && block.defines.is_empty()
        && code.is_none()
    {
        out.push_str("    julia: {}\n");
        return Ok(());
    }
    out.push_str("    julia:\n");
    // The box comes first; a block without a stored size carries no key at all.
    if let Some((width, height)) = block.size {
        let _ = writeln!(out, "      size: [{}, {}]", num(width), num(height));
    }
    // A playing block carries no key: a file written before the field existed plays its blocks.
    if !block.playing {
        out.push_str("      playing: false\n");
    }
    if !block.using.is_empty() {
        let _ = writeln!(out, "      using: {}", flow_list(&block.using));
    }
    if !block.imports.is_empty() {
        out.push_str("      import:\n");
        // The reader collects imports in a map, so they come back sorted by name.
        let mut imports: Vec<_> = block.imports.iter().collect();
        imports.sort_by(|a, b| a.name.cmp(&b.name));
        for import in imports {
            let path = format!("{}.{}", import.package, import.function);
            let _ = writeln!(
                out,
                "        {}: {}",
                key_text(&import.name),
                scalar(&path, Style::Plain, false)
            );
        }
    }
    if !block.defines.is_empty() {
        let _ = writeln!(out, "      define: {}", flow_list(&block.defines));
    }
    if let Some(code) = code {
        entry(out, 6, "code", code, Style::Code);
    }
    Ok(())
}

fn write_include(out: &mut String, region: &IncludeRegion) -> Result<(), WriteError> {
    write_head(
        out,
        &region.id,
        region.page,
        region.x,
        region.y,
        region.enabled,
    )?;
    let _ = writeln!(
        out,
        "    include: {}",
        scalar(&region.path, Style::Plain, false)
    );
    Ok(())
}

/// A text block is written at the left margin whatever x the model holds.
fn write_text(out: &mut String, region: &TextRegion, left_margin: f64) -> Result<(), WriteError> {
    let x = if region.full_width {
        left_margin
    } else {
        region.x
    };
    write_head(out, &region.id, region.page, x, region.y, region.enabled)?;
    let width = if region.full_width {
        Some("full".to_owned())
    } else {
        match region.width {
            Some(width) if width.is_finite() => Some(num(width)),
            Some(_) => {
                return Err(WriteError::NotFinite {
                    region_id: region.id.clone(),
                    what: "width".into(),
                });
            }
            None => None,
        }
    };
    // The background is a stored colour or nothing; a value that is not `#rrggbb` is never written.
    let background = region
        .background
        .as_deref()
        .and_then(crate::richtext::normalize_color);
    let language = region
        .language
        .as_deref()
        .filter(|value| crate::spell::is_language_id(value));
    match (width, background, language) {
        // Plain form: the text alone.
        (None, None, None) => entry(out, 4, "text", &region.text, Style::Plain),
        // Mapping form: width, background, language, then the text.
        (width, background, language) => {
            out.push_str("    text:\n");
            if let Some(width) = width {
                let _ = writeln!(out, "      width: {width}");
            }
            if let Some(background) = background {
                // Quoted: a value that starts with `#` is not a plain scalar.
                let _ = writeln!(out, "      background: \"{background}\"");
            }
            if let Some(language) = language {
                let _ = writeln!(out, "      language: {language}");
            }
            entry(out, 6, "text", &region.text, Style::Plain);
        }
    }
    Ok(())
}

fn write_plot(out: &mut String, region: &PlotRegion) -> Result<(), WriteError> {
    write_head(
        out,
        &region.id,
        region.page,
        region.x,
        region.y,
        region.enabled,
    )?;
    let plot: &PlotSpec = &region.plot;
    plot.validate().map_err(|message| WriteError::Plot {
        region_id: region.id.clone(),
        message,
    })?;
    out.push_str("    plot:\n");
    let _ = writeln!(out, "      version: {}", plot.version);
    let plot_type = match plot.kind {
        crate::plot::PlotKind::Xy => "xy",
        crate::plot::PlotKind::Polar => "polar",
        crate::plot::PlotKind::Contour => "contour",
    };
    let _ = writeln!(out, "      type: {plot_type}");
    if !plot.title.is_empty() {
        // the plot title is a single-line string, quoted like any other.
        let _ = writeln!(
            out,
            "      title: {}",
            scalar(&plot.title, Style::Plain, true)
        );
    }
    let _ = writeln!(
        out,
        "      size: [{}, {}]",
        num(plot.size[0]),
        num(plot.size[1])
    );
    if let Some(step) = plot.grid_spacing {
        let _ = writeln!(out, "      grid_spacing: {}", num(step));
    }
    let axes = [
        ("x", &plot.axes.x),
        ("y", &plot.axes.y),
        ("y2", plot.axes.y2.as_ref()),
    ];
    if axes.iter().any(|(_, axis)| *axis != &PlotAxis::default()) {
        out.push_str("      axes:\n");
        for (name, axis) in axes {
            if axis != &PlotAxis::default() {
                let _ = writeln!(out, "        {name}: {}", axis_text(axis));
            }
        }
    }
    out.push_str("      traces:\n");
    for trace in &plot.traces {
        let mut line = format!(
            "        - {{id: {}, x: {}, y: {}",
            scalar(&trace.id, Style::Plain, true),
            scalar(&trace.x, Style::Math, true),
            scalar(&trace.y, Style::Math, true),
        );
        if !trace.z.is_empty() {
            line.push_str(&format!(", z: {}", scalar(&trace.z, Style::Math, true)));
        }
        if trace.y_axis == crate::plot::TraceYAxis::Right {
            line.push_str(", y_axis: right");
        }
        match trace.presentation {
            TracePresentation::Line => {}
            TracePresentation::Markers => line.push_str(", presentation: markers"),
            TracePresentation::LineMarkers => line.push_str(", presentation: line+markers"),
        }
        // a trace type is written only when it is not the default, so an older worksheet
        // keeps its bytes and reads back as line traces.
        match trace.kind {
            TraceKind::Lines => {}
            TraceKind::Stems => line.push_str(", type: stems"),
            TraceKind::Bars => line.push_str(", type: bars"),
            TraceKind::Steps => line.push_str(", type: steps"),
        }
        if trace.line != crate::plot::TraceLineStyle::default() {
            let mut fields = Vec::new();
            if trace.line.style != crate::plot::TraceLinePattern::Solid {
                fields.push(format!(
                    "style: {}",
                    match trace.line.style {
                        crate::plot::TraceLinePattern::Solid => "solid",
                        crate::plot::TraceLinePattern::Dash => "dash",
                        crate::plot::TraceLinePattern::Dot => "dot",
                        crate::plot::TraceLinePattern::DashDot => "dashdot",
                    }
                ));
            }
            if trace.line.width != 1.5 {
                fields.push(format!("width: {}", num(trace.line.width)));
            }
            if let Some(color) = &trace.line.color {
                fields.push(format!("color: {}", scalar(color, Style::Plain, true)));
            }
            line.push_str(&format!(", line: {{{}}}", fields.join(", ")));
        }
        if trace.marker != crate::plot::TraceMarkerStyle::default() {
            let mut fields = Vec::new();
            if trace.marker.shape != crate::plot::TraceMarkerShape::Circle {
                fields.push(format!(
                    "shape: {}",
                    match trace.marker.shape {
                        crate::plot::TraceMarkerShape::Circle => "circle",
                        crate::plot::TraceMarkerShape::Square => "square",
                        crate::plot::TraceMarkerShape::Diamond => "diamond",
                        crate::plot::TraceMarkerShape::Cross => "cross",
                        crate::plot::TraceMarkerShape::X => "x",
                        crate::plot::TraceMarkerShape::TriangleUp => "triangle-up",
                        crate::plot::TraceMarkerShape::TriangleDown => "triangle-down",
                    }
                ));
            }
            if trace.marker.size != 5.0 {
                fields.push(format!("size: {}", num(trace.marker.size)));
            }
            if let Some(color) = &trace.marker.color {
                fields.push(format!("color: {}", scalar(color, Style::Plain, true)));
            }
            line.push_str(&format!(", marker: {{{}}}", fields.join(", ")));
        }
        if !trace.show_in_legend {
            line.push_str(", show_in_legend: false");
        }
        if !trace.legend_label.is_empty() {
            line.push_str(&format!(
                ", legend_label: {}",
                scalar(&trace.legend_label, Style::Plain, true)
            ));
        }
        line.push_str("}\n");
        out.push_str(&line);
    }
    if !plot.reference_lines.is_empty() {
        out.push_str("      reference_lines:\n");
        for reference in &plot.reference_lines {
            let axis = match reference.axis {
                crate::plot::AxisKind::X => "x",
                crate::plot::AxisKind::Y => "y",
                crate::plot::AxisKind::Y2 => "y2",
            };
            let value = match &reference.value {
                crate::plot::AxisLimit::Value(value) => num(*value),
                crate::plot::AxisLimit::Expression(text) => scalar(text, Style::Math, true),
            };
            let mut line = format!(
                "        - {{id: {}, axis: {}, value: {value}",
                scalar(&reference.id, Style::Plain, true),
                scalar(axis, Style::Plain, true)
            );
            if reference.line != crate::plot::TraceLineStyle::default() {
                let mut fields = Vec::new();
                if reference.line.style != crate::plot::TraceLinePattern::Solid {
                    fields.push(format!(
                        "style: {}",
                        match reference.line.style {
                            crate::plot::TraceLinePattern::Solid => "solid",
                            crate::plot::TraceLinePattern::Dash => "dash",
                            crate::plot::TraceLinePattern::Dot => "dot",
                            crate::plot::TraceLinePattern::DashDot => "dashdot",
                        }
                    ));
                }
                if reference.line.width != 1.5 {
                    fields.push(format!("width: {}", num(reference.line.width)));
                }
                if let Some(color) = &reference.line.color {
                    fields.push(format!("color: {}", scalar(color, Style::Plain, true)));
                }
                line.push_str(&format!(", line: {{{}}}", fields.join(", ")));
            }
            if reference.show_in_legend {
                line.push_str(", show_in_legend: true");
            }
            if !reference.legend_label.is_empty() {
                line.push_str(&format!(
                    ", legend_label: {}",
                    scalar(&reference.legend_label, Style::Plain, true)
                ));
            }
            line.push_str("}\n");
            out.push_str(&line);
        }
    }
    Ok(())
}

/// One axis as a flow mapping holding only its non-default fields.
fn axis_text(axis: &PlotAxis) -> String {
    let mut fields = Vec::new();
    if axis.scale == AxisScale::Log10 {
        fields.push("scale: log10".to_owned());
    }
    // an axis on the boundary is the default and carries no key.
    if axis.position == crate::plot::PlotAxisPosition::Origin {
        fields.push("position: origin".to_owned());
    }
    if let Some(unit) = &axis.unit {
        fields.push(format!("unit: {}", scalar(unit, Style::Math, true)));
    }
    // a number limit is a bare number, an expression limit a quoted math string.
    for (key, limit) in [("min", &axis.min), ("max", &axis.max)] {
        match limit {
            None => {}
            Some(crate::plot::AxisLimit::Value(value)) => {
                fields.push(format!("{key}: {}", num(*value)));
            }
            Some(crate::plot::AxisLimit::Expression(text)) => {
                fields.push(format!("{key}: {}", scalar(text, Style::Math, true)));
            }
        }
    }
    if !axis.show_grid {
        fields.push("show_grid: false".to_owned());
    }
    if !axis.title.is_empty() {
        fields.push(format!(
            "title: {}",
            scalar(&axis.title, Style::Plain, true)
        ));
    }
    format!("{{{}}}", fields.join(", "))
}

// ---- scalars ---------------------------------------------------------------------------------

/// How a string is spelled when it is a single line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
    /// Plain when that reads back as the same string, else quoted.
    Plain,
    /// Source code: a literal block scalar whenever it can be one, even for a single line.
    Code,
    /// Math and expressions: always quoted (single quotes when only a backslash or a double
    /// quote would need escaping, so `\det(A) =` stays readable).
    Math,
}

/// `key: value` at `indent`; a multi-line value becomes a literal block scalar.
fn entry(out: &mut String, indent: usize, key: &str, value: &str, style: Style) {
    let pad = " ".repeat(indent);
    // Code that ends with empty lines keeps them: a keeping
    // block scalar holds the code, every line with its break, so the reader, which drops the
    // scalar's one final break, gets the code back; a quoted fallback carries that break too.
    let body = value.trim_end_matches('\n');
    if style == Style::Code && body.len() < value.len() {
        if block_scalar_fits(body) {
            let _ = writeln!(out, "{pad}{key}: |+");
            for line in value.split('\n') {
                if line.is_empty() {
                    out.push('\n');
                } else {
                    let _ = writeln!(out, "{pad}  {line}");
                }
            }
        } else {
            let _ = writeln!(
                out,
                "{pad}{key}: {}",
                scalar(&format!("{value}\n"), style, false)
            );
        }
        return;
    }
    if (value.contains('\n') || style == Style::Code) && block_scalar_fits(value) {
        let _ = writeln!(out, "{pad}{key}: |");
        for line in value.split('\n') {
            if line.is_empty() {
                out.push('\n');
            } else {
                let _ = writeln!(out, "{pad}  {line}");
            }
        }
    } else {
        let _ = writeln!(out, "{pad}{key}: {}", scalar(value, style, false));
    }
}

/// Whether a multi-line string can be a literal block scalar and read back unchanged (up to
/// the reader's trailing-whitespace trim): no control characters, no space at the start of
/// the first line, no blank first line, no trailing whitespace anywhere.
fn block_scalar_fits(value: &str) -> bool {
    let mut lines = value.split('\n');
    let first = lines.next().unwrap_or("");
    if first.is_empty() || first.starts_with([' ', '\t']) {
        return false;
    }
    if value.ends_with(char::is_whitespace) {
        return false;
    }
    if value
        .lines()
        .any(|line| line.ends_with([' ', '\t']) && !line.trim().is_empty())
        || value.lines().any(|line| {
            !line.is_empty() && line.trim().is_empty() // whitespace-only lines
        })
    {
        return false;
    }
    !value
        .chars()
        .any(|c| (c.is_control() && c != '\n' && c != '\t') || c == '\u{2028}' || c == '\u{2029}')
}

/// A single-line (or fallback) scalar. `flow` is true inside `{}`/`[]`, where `,` and
/// brackets end a plain scalar.
fn scalar(value: &str, style: Style, flow: bool) -> String {
    if style != Style::Math && is_plain_safe(value, flow) {
        return value.to_owned();
    }
    let single_ok = !value.is_empty()
        && !value.contains('\'')
        && !value
            .chars()
            .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}' || c == '\u{85}');
    if single_ok && (value.contains('\\') || value.contains('"')) {
        return format!("'{value}'");
    }
    double_quoted(value)
}

fn double_quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() || c == '\u{2028}' || c == '\u{2029}' => {
                let _ = write!(out, "\\u{:04X}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A plain scalar that every YAML 1.2 reader reads back as exactly this string: it starts
/// with a letter or `_`, holds only letters, digits and a few punctuation marks, does not end
/// with a space, and is not a word that some readers resolve to a boolean, null or number.
fn is_plain_safe(value: &str, flow: bool) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' || c == '/' => {}
        // `../dir/file` and `./file` are plain; `.5`, `.inf` and `...` are not.
        Some('.') if chars.next().is_some_and(|c| c == '.' || c == '/') => {}
        _ => return false,
    }
    if value.ends_with(' ') {
        return false;
    }
    let allowed = |c: char| {
        c.is_alphanumeric()
            || matches!(c, ' ' | '_' | '-' | '.' | '/' | '(' | ')' | '+')
            || (!flow && c == ',')
    };
    if !value.chars().all(allowed) || value.contains("  ") {
        return false;
    }
    !is_reserved_word(value)
}

/// Words that some YAML readers resolve to a boolean, null or number.
fn is_reserved_word(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "y" | "n"
            | "yes"
            | "no"
            | "on"
            | "off"
            | "true"
            | "false"
            | "null"
            | "nan"
            | "inf"
            | "infinity"
    )
}

fn key_text(key: &str) -> String {
    let simple = key
        .chars()
        .next()
        .is_some_and(|c| c.is_alphabetic() || c == '_')
        && key
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if simple && !is_reserved_word(key) {
        key.to_owned()
    } else {
        double_quoted(key)
    }
}

fn flow_list(items: &[String]) -> String {
    let rendered: Vec<String> = items
        .iter()
        .map(|item| scalar(item, Style::Plain, true))
        .collect();
    format!("[{}]", rendered.join(", "))
}

/// A canonical decimal integer small enough to survive a round trip through any reader.
fn is_plain_integer(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty()
        && digits.len() <= 15
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" && value == "0" || !digits.starts_with('0'))
}

/// The shortest decimal text that reads back as the same `f64` (no exponent, `-0` as `0`).
fn num(value: f64) -> String {
    if value == 0.0 {
        "0".to_owned()
    } else {
        format!("{value}")
    }
}
