//! What the UI shows besides the page: the names a worksheet defines and uses (Variables panel,
//! hover information, Ctrl+click navigation), the include tree and the unit warnings
//! (Problems panel). It is derived from the same analysis the evaluation uses
//! ([`ProjectAnalysis`](crate::project::ProjectAnalysis) and the dependency graph), so the
//! reference a hover shows is exactly the definition the kernel evaluates.
//!
//! Values are not part of [`Inspection`]: they cost a kernel round trip.
//! [`WorksheetSession::definition_values`] reads the current value of chosen definitions from
//! the kernel module (a peek, no re-evaluation) and returns only the size of a matrix too large
//! to show.

use super::{Derived, DisplayUnit, RegionKey, RegionState, WorksheetSession};
use crate::ast::{ExprKind, Label, Statement, StatementKind, TargetKind};
use crate::codegen::{generate_unit, intrinsic, worksheet_ident, Intrinsic};
use crate::graph::DefinitionKind;
use crate::kernel_manager::{EvaluateRequest, KernelError, RegionInput, RegionOutcome};
use crate::kernel_value::{KernelValue, WireFloat};
use crate::project::{DocumentId, NodeKind};
use crate::syntax::{print_expression, print_name, print_statement};
use crate::units::literal_quantity_unit;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Largest matrix (elements) whose value a peek returns; larger ones come back as a size only.
pub const PEEK_MAX_ELEMENTS: usize = 400;

/// A name definition of the expanded project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DefinitionInfo {
    /// The name as written (`M_max`).
    pub name: String,
    /// `var`, `fn`, `const`, `unit`, `sys`, `kw` or `julia`: the label resolved by analysis.
    pub label: String,
    /// The defining region.
    pub key: RegionKey,
    /// One-based version among definitions of the same name (a name defined twice has two).
    pub version: u32,
    /// `≡`: visible in the whole worksheet.
    pub global: bool,
    /// The left side as written (`f(x, y)`, `M_max`).
    pub signature: String,
    /// The Julia name of this definition in the worksheet's module (`M_smax_v1`): with the
    /// worksheet's module name it is the name the REPL reads it by.
    pub kernel_name: String,
    /// Evaluation order of the defining region (smaller is earlier).
    pub rank: usize,
}

/// A use of a name and the definition it resolves to (`definition` is `None` for a unit, a
/// constant, a built-in or an undefined name).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReferenceInfo {
    pub key: RegionKey,
    /// Byte range of the name in the region's math text (equals the `span` of the AST node).
    pub start: usize,
    pub end: usize,
    pub name: String,
    pub definition: Option<RegionKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_name: Option<String>,
    pub version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intrinsic: Option<IntrinsicInfo>,
}

/// The engine's fallback name resolution after worksheet dependencies are considered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IntrinsicInfo {
    Constant {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<WireFloat>,
    },
    System,
    Builtin,
}

/// A unit warning (dimension mismatch) of one region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WarningInfo {
    pub key: RegionKey,
    pub start: usize,
    pub end: usize,
    pub message: String,
}

/// One include of the project tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IncludeInfo {
    /// The included document (an id such as `/dir/lib.eqv`).
    pub document: DocumentId,
    /// The document that contains the include region.
    pub parent: DocumentId,
    /// The include region in `parent`.
    pub region_id: String,
    /// The names the document defines, in evaluation order.
    pub exports: Vec<DefinitionInfo>,
    /// Whether the file is part of the project (a missing include is also a diagnostic).
    pub found: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Inspection {
    pub root: DocumentId,
    pub definitions: Vec<DefinitionInfo>,
    pub references: Vec<ReferenceInfo>,
    pub warnings: Vec<WarningInfo>,
    pub includes: Vec<IncludeInfo>,
    /// Evaluation order of every math region instance (to find "the definitions above").
    pub ranks: Vec<(RegionKey, usize)>,
}

/// The value of one definition, or its size when it is too large to show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DefinitionValue {
    pub name: String,
    pub version: u32,
    pub value: Option<KernelValue>,
    /// Set for a matrix that is not returned (`rows`, `cols`).
    pub size: Option<(usize, usize)>,
    /// Why there is no value: not calculated yet, an error, or a kernel problem.
    pub error: Option<String>,
    /// The unit the worksheet shows the value in; none is base SI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_unit: Option<DisplayUnit>,
}

impl WorksheetSession {
    /// The names, references, include tree and unit warnings of the project (no kernel).
    pub fn inspect(&self) -> Inspection {
        let derived = &self.derived;
        let worksheet = derived.analysis.worksheet();
        let rank_of = |gid: &str| derived.graph().evaluation_rank(gid).unwrap_or(usize::MAX);
        // The statement of each region by id, once: finding it among all regions per definition made
        // the inspection quadratic.
        let statements: HashMap<&str, &Statement> = worksheet
            .regions
            .iter()
            .map(|region| (region.id.as_str(), region.statement.as_ref()))
            .collect();
        let definitions: Vec<DefinitionInfo> = derived
            .graph()
            .definitions()
            .iter()
            .filter_map(|definition| {
                let key = derived.keys.get(&definition.region_id)?.clone();
                let signature = statements
                    .get(definition.region_id.as_str())
                    .map(|statement| left_side(&print_statement(statement)))
                    .unwrap_or_else(|| print_name(&definition.name));
                Some(DefinitionInfo {
                    name: print_name(&definition.name),
                    label: label_text(definition.resolved_label).to_owned(),
                    key,
                    version: definition.version,
                    global: definition.kind == DefinitionKind::Global,
                    signature,
                    kernel_name: crate::codegen::worksheet_ident(
                        &definition.name,
                        definition.version,
                    ),
                    rank: rank_of(&definition.region_id),
                })
            })
            .collect();
        let resolved = derived
            .graph()
            .resolved_references()
            .iter()
            .filter_map(|r| {
                Some(ReferenceInfo {
                    key: derived.keys.get(&r.region_id)?.clone(),
                    start: r.span.start,
                    end: r.span.end,
                    name: print_name(&r.name),
                    definition: derived.keys.get(&r.definition_region_id).cloned(),
                    definition_name: Some(print_name(&r.definition_name)),
                    version: Some(r.definition_version),
                    intrinsic: None,
                })
            });
        let unresolved = derived
            .graph()
            .unresolved_references()
            .iter()
            .filter_map(|r| {
                Some(ReferenceInfo {
                    key: derived.keys.get(&r.region_id)?.clone(),
                    start: r.span.start,
                    end: r.span.end,
                    name: print_name(&r.name),
                    definition: None,
                    definition_name: None,
                    version: None,
                    intrinsic: intrinsic(&r.name).map(|source| match source {
                        Intrinsic::Number(code) => IntrinsicInfo::Constant {
                            value: code.parse::<f64>().ok().map(WireFloat::from),
                        },
                        Intrinsic::Physical(_) => IntrinsicInfo::Constant { value: None },
                        Intrinsic::System(_) => IntrinsicInfo::System,
                        Intrinsic::Builtin(_) => IntrinsicInfo::Builtin,
                    }),
                })
            });
        let references = resolved.chain(unresolved).collect();
        let warnings = self.warnings();
        let mut by_document: BTreeMap<&DocumentId, Vec<&DefinitionInfo>> = BTreeMap::new();
        for definition in &definitions {
            by_document
                .entry(&definition.key.document)
                .or_default()
                .push(definition);
        }
        let mut seen = BTreeSet::new();
        let includes = derived
            .analysis
            .nodes()
            .iter()
            .filter_map(|node| {
                let NodeKind::Include { target } = &node.kind else {
                    return None;
                };
                if !seen.insert((node.origin.document.clone(), node.origin.region_id.clone())) {
                    return None;
                }
                let mut exports: Vec<DefinitionInfo> = by_document
                    .get(target)
                    .map(|list| list.iter().map(|d| (*d).clone()).collect())
                    .unwrap_or_default();
                exports.sort_by_key(|definition| definition.rank);
                Some(IncludeInfo {
                    document: target.clone(),
                    parent: node.origin.document.clone(),
                    region_id: node.origin.region_id.clone(),
                    exports,
                    found: self.project.document(target).is_some(),
                })
            })
            .collect();
        let ranks = derived
            .order
            .iter()
            .enumerate()
            .filter_map(|(rank, gid)| Some((derived.keys.get(gid)?.clone(), rank)))
            .collect();
        Inspection {
            root: self.root.clone(),
            definitions,
            references,
            warnings,
            includes,
            ranks,
        }
    }

    /// The unit warnings (dimension mismatches) of the project: what the sheet underlines and what
    /// the Problems count lists. The UI asks for this after every edit, while the rest of
    /// [`Inspection`](Self::inspect) is only wanted while something shows names.
    pub fn inspect_warnings(&self) -> Vec<WarningInfo> {
        self.warnings()
    }

    /// The unit warnings of the project, shared by [`Self::inspect`] and [`Self::inspect_warnings`]
    /// so the two can never disagree.
    fn warnings(&self) -> Vec<WarningInfo> {
        let derived = &self.derived;
        derived
            .analysis
            .dimension_warnings()
            .iter()
            .filter_map(|warning| {
                Some(WarningInfo {
                    key: derived
                        .keys
                        .get(&warning.evaluation_id.region_id())?
                        .clone(),
                    start: warning.span.start,
                    end: warning.span.end,
                    message: warning.kind.message(),
                })
            })
            .collect()
    }

    /// The current kernel value of the given definitions `(name as written, version)`: a read of
    /// the worksheet module, no re-evaluation. A definition whose region has not produced a value
    /// (not calculated, failed, blocked) or that is not a variable reports why.
    pub fn definition_values(&self, wanted: &[(String, u32)]) -> Vec<DefinitionValue> {
        let derived = &self.derived;
        let mut requests: Vec<(usize, RegionInput)> = Vec::new();
        let mut written_units: HashMap<usize, String> = HashMap::new();
        let mut out: Vec<DefinitionValue> = wanted
            .iter()
            .map(|(name, version)| DefinitionValue {
                name: name.clone(),
                version: *version,
                value: None,
                size: None,
                error: Some("not calculated yet".into()),
                display_unit: None,
            })
            .collect();
        for (index, (name, version)) in wanted.iter().enumerate() {
            let Some(definition) = derived
                .graph()
                .definitions()
                .iter()
                .find(|d| print_name(&d.name) == *name && d.version == *version)
            else {
                out[index].error = Some("not defined".into());
                continue;
            };
            let state = derived
                .keys
                .get(&definition.region_id)
                .and_then(|key| self.results.get(key));
            match state {
                Some(RegionState::Value { .. }) | Some(RegionState::Stale { .. }) => {}
                Some(RegionState::Error { failure }) => {
                    out[index].error = Some(failure.message.clone());
                    continue;
                }
                _ => continue,
            }
            if definition.resolved_label != Label::Var {
                out[index].error = Some("not a variable".into());
                continue;
            }
            let id = format!("__peek{index}");
            let mut unit_code = None;
            match self.shown_unit(derived, definition) {
                Some(ShownUnit::Known(unit)) => out[index].display_unit = Some(unit),
                Some(ShownUnit::Written { code, text }) => unit_code = Some((code, text)),
                None => {}
            }
            requests.push((
                index,
                RegionInput {
                    id,
                    code: None,
                    value: Some(worksheet_ident(&definition.name, definition.version)),
                    display_unit: unit_code.as_ref().map(|(code, _)| code.clone()),
                    capture: false,
                },
            ));
            if let Some((_, text)) = unit_code {
                written_units.insert(index, text);
            }
        }
        if requests.is_empty() {
            return out;
        }
        let request = EvaluateRequest {
            worksheet: self.worksheet_id.clone(),
            reset: false,
            origin: None,
            tol: None,
            ctol: None,
            exact_boolean: None,
            packages: Vec::new(),
            modules: Vec::new(),
            environment: None,
            base_dir: self.kernel_base_dir(),
            module_name: None,
            regions: requests.iter().map(|(_, input)| input.clone()).collect(),
        };
        match self.kernel.evaluate(&request) {
            Ok(response) => {
                for (index, input) in &requests {
                    if let (Some(text), Some(result)) =
                        (written_units.get(index), response.region(&input.id))
                    {
                        if let Some(divisor) =
                            result.display_unit.as_ref().and_then(|u| u.unit_divisor())
                        {
                            out[*index].display_unit = Some(DisplayUnit {
                                text: text.clone(),
                                divisor,
                                offset: result.display_offset,
                            });
                        }
                    }
                    match response.region(&input.id).map(|r| r.outcome.clone()) {
                        Some(RegionOutcome::Value(Some(value))) => {
                            if let KernelValue::Matrix { rows, cols, .. } = &value {
                                if rows * cols > PEEK_MAX_ELEMENTS {
                                    out[*index].size = Some((*rows, *cols));
                                    out[*index].error = None;
                                    continue;
                                }
                            }
                            out[*index].value = Some(value);
                            out[*index].error = None;
                        }
                        Some(RegionOutcome::Error(error)) => {
                            out[*index].error = Some(error.message);
                        }
                        _ => {}
                    }
                }
            }
            Err(KernelError::Interrupted) | Err(KernelError::Timeout) => {
                for (index, _) in &requests {
                    out[*index].error = Some("interrupted".into());
                }
            }
            Err(error) => {
                for (index, _) in &requests {
                    out[*index].error = Some(error.to_string());
                }
            }
        }
        out
    }
}

/// The unit a definition's value is shown in: one the session already converted to, or one
/// written in the definition that the kernel still has to measure.
enum ShownUnit {
    Known(DisplayUnit),
    Written { code: String, text: String },
}

impl WorksheetSession {
    /// The unit the worksheet shows a definition's value in: the unit
    /// override of the defining region, otherwise that of the latest evaluation of exactly this
    /// definition, otherwise the unit written in a literal quantity (`q := 12 kN/m`).
    fn shown_unit(
        &self,
        derived: &Derived,
        definition: &crate::graph::Definition,
    ) -> Option<ShownUnit> {
        let shown = |gid: &str| match derived.keys.get(gid).and_then(|key| self.results.get(key)) {
            Some(RegionState::Value { display_unit, .. })
            | Some(RegionState::Stale { display_unit, .. }) => display_unit.clone(),
            _ => None,
        };
        if let Some(unit) = shown(&definition.region_id) {
            return Some(ShownUnit::Known(unit));
        }
        let statement = |gid: &str| {
            derived
                .analysis
                .worksheet()
                .regions
                .iter()
                .find(|region| region.id == gid)
                .map(|region| &region.statement)
        };
        let position = |gid: &str| derived.order.iter().position(|id| id == gid);
        let evaluation = derived
            .graph()
            .resolved_references()
            .iter()
            .filter(|reference| {
                reference.definition_region_id == definition.region_id
                    && reference.definition_version == definition.version
                    && reference.definition_name == definition.name
            })
            .filter(|reference| {
                matches!(
                    statement(&reference.region_id).map(|s| &s.kind),
                    Some(StatementKind::Evaluate { expr, unit: Some(_) })
                        if matches!(&expr.kind, ExprKind::Ident { name } if *name == reference.name)
                )
            })
            .filter_map(|reference| {
                Some((
                    position(&reference.region_id)?,
                    shown(&reference.region_id)?,
                ))
            })
            .max_by_key(|(at, _)| *at);
        if let Some((_, unit)) = evaluation {
            return Some(ShownUnit::Known(unit));
        }
        let StatementKind::Define { target, rhs, .. } = &statement(&definition.region_id)?.kind
        else {
            return None;
        };
        if !matches!(&target.kind, TargetKind::Ident { .. }) {
            return None;
        }
        let unit = literal_quantity_unit(rhs)?;
        Some(ShownUnit::Written {
            code: generate_unit(&unit).ok()?,
            text: print_expression(&unit),
        })
    }
}

fn label_text(label: Label) -> &'static str {
    match label {
        Label::Var => "var",
        Label::Fn => "fn",
        Label::Unit => "unit",
        Label::Const => "const",
        Label::Sys => "sys",
        Label::Kw => "kw",
        Label::Julia => "julia",
    }
}

/// The text before the definition operator (`f(x) := x^2` gives `f(x)`).
fn left_side(statement: &str) -> String {
    for operator in [":=", "≡", "←"] {
        if let Some(position) = statement.find(operator) {
            return statement[..position].trim().to_owned();
        }
    }
    statement.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegen::GenOptions;
    use crate::graph::Region;
    use crate::kernel_manager::{KernelConfig, KernelManager};
    use crate::project::{
        CalculationSettings, DocumentId, DocumentRegion, Project, ProjectDocument,
    };
    use crate::syntax::parse_statement;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Arc;

    #[test]
    fn left_side_cuts_at_the_definition_operator() {
        assert_eq!(left_side("f(x, y) := x + y"), "f(x, y)");
        assert_eq!(left_side("a_max ≡ 3"), "a_max");
        assert_eq!(left_side("x"), "x");
    }

    /// A session over `math` regions; its kernel is never started (an inspection needs no kernel).
    fn session(math: &[(&str, &str)]) -> WorksheetSession {
        let root = DocumentId::new("/warnings.eqv").unwrap();
        let regions = math
            .iter()
            .enumerate()
            .map(|(index, (id, text))| {
                DocumentRegion::Math(Box::new(Region {
                    id: (*id).to_owned(),
                    page: 1,
                    x: 0.0,
                    y: index as f64,
                    enabled: true,
                    statement: std::sync::Arc::new(parse_statement(text).unwrap()),
                }))
            })
            .map(std::sync::Arc::new)
            .collect();
        let document = ProjectDocument {
            id: root.clone(),
            content_hash: "h".into(),
            settings: CalculationSettings::default(),
            environment: None,
            page: Default::default(),
            result_formats: Default::default(),
            numeric_options: Default::default(),
            math_breaks: Default::default(),
            resources: Default::default(),
            assets: Default::default(),
            page_breaks: Vec::new(),
            regions,
        };
        let mut project = Project::new();
        project.insert(document).unwrap();
        let texts: HashMap<_, _> = math
            .iter()
            .map(|(id, text)| ((root.clone(), (*id).to_owned()), (*text).to_owned()))
            .collect();
        let kernel = Arc::new(KernelManager::new(KernelConfig::new(PathBuf::from(
            "no-such-julia",
        ))));
        WorksheetSession::new(kernel, "ws", project, root, texts, GenOptions::default()).unwrap()
    }

    #[test]
    fn inspect_warnings_is_the_warning_list_of_the_inspection() {
        let session = session(&[
            ("length", "l := 2 m@unit"),
            ("sum", "t := l + 1 s@unit"),
            ("fine", "u := 1 s@unit + 2 s@unit"),
        ]);
        let inspection = session.inspect();
        assert_eq!(inspection.warnings.len(), 1, "{:?}", inspection.warnings);
        assert_eq!(session.inspect_warnings(), inspection.warnings);
    }
}
