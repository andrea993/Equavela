//! The reference application physical constants the engine defines.
//!
//! The table is `kernel/EqRuntime/src/constants.tsv`, the file EqRuntime reads to build the SI
//! quantities, so the generator, the static dimensional analysis and the kernel agree on the
//! names and dimensions. A constant used in worksheet math is generated as
//! `eq_constant("c")`; the value lives in EqRuntime. `π e γ ∞ NaN ORIGIN TOL CTOL` are not
//! in this table (they are plain numbers or settings, see `codegen::intrinsic`).

use crate::ast::Name;
use crate::units::UnitExponents;
use std::collections::HashMap;
use std::sync::OnceLock;

const TABLE: &str = include_str!("../../kernel/EqRuntime/src/constants.tsv");

struct ConstantTable {
    /// Canonical name -> dimension exponents.
    canonical: HashMap<String, UnitExponents>,
    /// Every accepted spelling -> canonical name.
    spellings: HashMap<String, String>,
}

fn table() -> &'static ConstantTable {
    static CELL: OnceLock<ConstantTable> = OnceLock::new();
    CELL.get_or_init(|| parse(TABLE))
}

fn parse(text: &str) -> ConstantTable {
    let mut canonical = HashMap::new();
    let mut spellings = HashMap::new();
    let mut aliases = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields[0] == "@alias" {
            aliases.push((fields[1].to_owned(), fields[2].to_owned()));
            continue;
        }
        assert!(fields.len() == 3, "constants.tsv: bad line `{line}`");
        let parsed: Vec<i8> = fields[1]
            .split(',')
            .map(|part| part.parse().expect("constants.tsv: bad exponent"))
            .collect();
        let exponents: UnitExponents = parsed.try_into().expect("constants.tsv: 7 exponents");
        canonical.insert(fields[0].to_owned(), exponents);
        spellings.insert(fields[0].to_owned(), fields[0].to_owned());
    }
    for (alias, target) in aliases {
        assert!(
            canonical.contains_key(&target),
            "constants.tsv: alias of unknown `{target}`"
        );
        spellings.insert(alias, target);
    }
    ConstantTable {
        canonical,
        spellings,
    }
}

/// The spelling of a name as the table writes it: `c`, `e.c`, or `ε_0` for a name with one
/// literal subscript segment. `None` for names with other shapes.
fn key(name: &Name) -> Option<String> {
    let (first, rest) = name.segments.split_first()?;
    if first.subscript {
        return None;
    }
    let mut text = first.text.clone();
    for segment in rest {
        if !segment.subscript {
            return None;
        }
        text.push('_');
        text.push_str(&segment.text);
    }
    Some(text)
}

/// The canonical constant name `name` stands for (`ε0` and `ε_0` are both `ε_0`), if any.
pub fn constant_name(name: &Name) -> Option<&'static str> {
    let table = table();
    let canonical = table.spellings.get(&key(name)?)?;
    table
        .canonical
        .get_key_value(canonical)
        .map(|(name, _)| name.as_str())
}

/// The dimension exponents of a canonical constant name.
pub fn constant_exponents(canonical: &str) -> Option<UnitExponents> {
    table().canonical.get(canonical).copied()
}

/// All canonical constant names, sorted (EqRuntime's `eq_constant_names()` returns the same list).
pub fn constant_names() -> Vec<String> {
    let mut names: Vec<String> = table().canonical.keys().cloned().collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::Segment;

    fn name(parts: &[(&str, bool)]) -> Name {
        Name {
            segments: parts
                .iter()
                .map(|(text, subscript)| Segment {
                    text: (*text).to_owned(),
                    subscript: *subscript,
                })
                .collect(),
            label: None,
        }
    }

    #[test]
    fn spellings_resolve_to_canonical_names() {
        assert_eq!(constant_name(&name(&[("c", false)])), Some("c"));
        assert_eq!(constant_name(&name(&[("e.c", false)])), Some("e.c"));
        assert_eq!(
            constant_name(&name(&[("ε", false), ("0", true)])),
            Some("ε_0")
        );
        assert_eq!(constant_name(&name(&[("ε0", false)])), Some("ε_0"));
        assert_eq!(constant_name(&name(&[("mu", false)])), None);
        assert_eq!(constant_name(&name(&[("c", false), ("x", true)])), None);
        assert_eq!(constant_name(&name(&[("c", true)])), None);
    }

    #[test]
    fn dimensions_are_the_si_ones() {
        assert_eq!(constant_exponents("c"), Some([1, 0, -1, 0, 0, 0, 0]));
        assert_eq!(constant_exponents("α"), Some([0; 7]));
        assert_eq!(constant_exponents("R"), Some([2, 1, -2, 0, -1, -1, 0]));
        assert_eq!(constant_names().len(), 14);
    }

    /// The fixture is written by EqRuntime (`eq_constant_names()`); the Julia test compares
    /// the same file. Regenerate with: `julia --project=kernel/EqRuntime -e 'using EqRuntime;
    /// write("the specification", join(eq_constant_names(), "\n") * "\n")'`.
    #[test]
    fn the_name_list_matches_eqruntime() {
        let fixture = include_str!("../fixtures/constant-names.txt");
        let expected: Vec<&str> = fixture.lines().collect();
        assert_eq!(
            constant_names()
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            expected
        );
    }
}
