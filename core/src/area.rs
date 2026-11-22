//! Collapsible areas: a titled full-width band whose
//! members are the regions whose top lies inside it. Membership is derived from positions.
//!
//! The band is a range of the flow of the sheet (`layout::flow_spans`): it starts at its stored `y`
//! of its stored page, runs to the bottom margin, continues at the top margin of the next page, and
//! so on. A band that crosses a page break therefore has one part per page it reaches.

use crate::layout::{flow_of, flow_spans, FlowSpan, PageSetup};
use crate::project::{DocumentRegion, ProjectDocument};
use serde::{Deserialize, Serialize};

/// Height of the header (title and collapse indicator), points: seven grid steps.
pub const AREA_HEADER_PT: f64 = 21.0;
/// Smallest band height, points: the header plus one grid step.
pub const MIN_AREA_HEIGHT: f64 = 24.0;

/// Tolerance of the geometry comparisons, points.
const EPS: f64 = 1e-9;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AreaRegion {
    pub id: String,
    #[serde(default)]
    pub page: u32,
    /// Always the left margin of the page (the document snaps it after every edit).
    pub x: f64,
    /// The start line.
    pub y: f64,
    #[serde(default = "super::project::enabled_by_default")]
    pub enabled: bool,
    pub title: String,
    /// The whole band along the flow, from the start line to the end line, points.
    pub height: f64,
    pub collapsed: bool,
}

impl AreaRegion {
    /// The flow offset of the start line (`layout::flow_of`).
    pub fn flow_start(&self, setup: &PageSetup) -> f64 {
        flow_of(setup, self.page, self.y)
    }

    /// The flow offset of the end line: the start plus the whole height, which may lie on a later
    /// page.
    pub fn flow_end(&self, setup: &PageSetup) -> f64 {
        self.flow_start(setup) + self.height
    }

    /// The parts of the band inside the printable area of each page it reaches: the first
    /// one carries the header, the last one the end line.
    pub fn spans(&self, setup: &PageSetup) -> Vec<FlowSpan> {
        flow_spans(setup, self.page, self.y, self.height)
    }

    /// The last page the band reaches: the page its end line is on.
    pub fn last_page(&self, setup: &PageSetup) -> u32 {
        self.spans(setup)
            .last()
            .map_or(self.page.max(1), |span| span.page)
    }

    /// Whether a region at `page`/`y` is a member: its top lies in the part of the band on its
    /// own page, below the header. The part, not the flow offset, decides: a region in the bottom
    /// margin of the page a band starts on is not inside the part the band continues with.
    pub fn contains(&self, setup: &PageSetup, page: u32, y: f64) -> bool {
        self.spans(setup).iter().enumerate().any(|(index, span)| {
            let top = span.top + if index == 0 { AREA_HEADER_PT } else { 0.0 };
            span.page == page && y >= top - EPS && y < span.bottom() - EPS
        })
    }

    /// Whether two bands overlap: two areas may not share a point of a page, whichever page
    /// their bands start on and however many pages they cover.
    pub fn overlaps(&self, setup: &PageSetup, other: &AreaRegion) -> bool {
        let mine = self.spans(setup);
        let theirs = other.spans(setup);
        mine.iter().any(|a| {
            theirs
                .iter()
                .any(|b| a.page == b.page && a.top < b.bottom() - EPS && b.top < a.bottom() - EPS)
        })
    }
}

/// A height is valid when finite and at least the header plus one grid step. Any larger
/// height is valid: the band continues across pages.
pub fn valid_height(height: f64) -> bool {
    height.is_finite() && height >= MIN_AREA_HEIGHT - EPS
}

/// The ids of the members of `area` among `regions` (areas are never members).
pub fn members<'a>(
    setup: &PageSetup,
    regions: &'a [std::sync::Arc<DocumentRegion>],
    area: &AreaRegion,
) -> Vec<&'a str> {
    regions
        .iter()
        .filter(|region| {
            !matches!(region.as_ref(), DocumentRegion::Area(_))
                && area.contains(setup, region.page(), region.y())
        })
        .map(|region| region.id())
        .collect()
}

/// The grid step of the sheet, points: the end line of a band that grows lies on it.
const GRID_PT: f64 = 3.0;

/// The height the document stores for a region, points: a plot, an image and a Julia block with a
/// box. Every other region is measured by the app, so the document does not know its height.
pub fn stored_height(region: &DocumentRegion) -> Option<f64> {
    match region {
        DocumentRegion::Plot(plot) => Some(plot.plot.size[1]),
        DocumentRegion::Image(image) => Some(image.size[1]),
        DocumentRegion::Math(math) => match &math.statement.kind {
            crate::ast::StatementKind::Julia { block } => block.size.map(|(_, h)| h),
            _ => None,
        },
        _ => None,
    }
}

/// The new heights of the bands that must grow to hold the stored bottoms of `region_ids`:
/// the end line one grid step below the bottom, on the grid, never into the next area's start
/// line and never shorter than the band is.
pub fn held_heights(document: &ProjectDocument, region_ids: &[String]) -> Vec<(String, f64)> {
    let setup = &document.page;
    let areas: Vec<&AreaRegion> = document
        .regions
        .iter()
        .filter_map(|region| match region.as_ref() {
            DocumentRegion::Area(area) => Some(area),
            _ => None,
        })
        .collect();
    let mut grown: Vec<(String, f64)> = Vec::new();
    for id in region_ids {
        let Some(region) = document.regions.iter().find(|r| r.id() == id) else {
            continue;
        };
        let Some(height) = stored_height(region) else {
            continue;
        };
        let Some(area) = areas
            .iter()
            .find(|area| area.contains(setup, region.page(), region.y()))
        else {
            continue;
        };
        let start = area.flow_start(setup);
        let bottom = flow_of(setup, region.page(), region.y()) + height;
        if bottom <= area.flow_end(setup) + EPS {
            continue;
        }
        // The grid is drawn from the top of the page, so the end line is snapped in page points.
        let top = setup.content_top();
        let end = ((bottom + GRID_PT + top) / GRID_PT - EPS).ceil() * GRID_PT - top;
        let mut wanted = end - start;
        // The band stops at the start line of the next area along the flow.
        if let Some(limit) = areas
            .iter()
            .map(|other| other.flow_start(setup))
            .filter(|other| *other > start + EPS)
            .reduce(f64::min)
        {
            wanted = wanted.min(limit - start);
        }
        let current = grown
            .iter()
            .find(|(grown_id, _)| *grown_id == area.id)
            .map_or(area.height, |(_, h)| *h);
        if wanted > current + EPS {
            grown.retain(|(grown_id, _)| *grown_id != area.id);
            grown.push((area.id.clone(), wanted));
        }
    }
    grown
}
