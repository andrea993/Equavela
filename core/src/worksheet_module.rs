//! The Julia module name of a worksheet: the REPL of an environment reaches every
//! worksheet of its kernel by a name made from the file name, flat whatever its folder.

use std::collections::{HashMap, HashSet};

/// Julia keywords and the names the kernel's modules already use: a worksheet named like one
/// gets the suffix `_k`, as kernel locals do.
const RESERVED: &[&str] = &[
    "baremodule",
    "begin",
    "break",
    "catch",
    "const",
    "continue",
    "do",
    "else",
    "elseif",
    "end",
    "export",
    "false",
    "finally",
    "for",
    "function",
    "global",
    "if",
    "import",
    "let",
    "local",
    "macro",
    "module",
    "quote",
    "return",
    "struct",
    "true",
    "try",
    "using",
    "while",
    "abstract",
    "mutable",
    "primitive",
    "type",
    "where",
    "outer",
    "Base",
    "Core",
    "Main",
    "EqRuntime",
    "EquavelaKernel",
    "EquavelaShared",
    "Project",
    "JSON3",
    "nothing",
    "missing",
];

/// The identifier of a file name without its extension: every character a Julia name cannot
/// hold becomes `_`, runs of `_` collapse, leading and trailing `_` go; a leading digit gets a
/// `_` in front, an empty name is `sheet`, a reserved one gets `_k`.
pub fn module_identifier(stem: &str) -> String {
    let mut out = String::new();
    for c in stem.chars() {
        let plain = c == '_' || (c.is_alphanumeric() && !matches!(c, '\u{b5}' | '\u{25b}'));
        let c = if plain { c } else { '_' };
        if c == '_' && out.ends_with('_') {
            continue;
        }
        out.push(c);
    }
    let trimmed = out.trim_matches('_');
    let mut name = if trimmed.is_empty() {
        "sheet".to_owned()
    } else {
        trimmed.to_owned()
    };
    if name.chars().next().is_some_and(|c| c.is_numeric()) {
        name.insert(0, '_');
    }
    if RESERVED.contains(&name.as_str()) {
        name.push_str("_k");
    }
    name
}

/// The module names of the worksheets of one kernel. `worksheets` are `(key, file stem)` pairs;
/// the keys are sorted (relative paths, or full paths) and a name that clashes with an earlier
/// worksheet or with a `taken` name (a loaded `.jl` module, a package) gets an increasing number:
/// `beam`, `beam2`, `beam3`, …
pub fn module_names(worksheets: &[(String, String)], taken: &[String]) -> HashMap<String, String> {
    let mut sorted: Vec<&(String, String)> = worksheets.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut used: HashSet<String> = taken.iter().cloned().collect();
    let mut names = HashMap::new();
    for (key, stem) in sorted {
        let base = module_identifier(stem);
        let mut name = base.clone();
        let mut number = 2;
        while used.contains(&name) {
            name = format!("{base}{number}");
            number += 1;
        }
        used.insert(name.clone());
        names.insert(key.clone(), name);
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_become_julia_identifiers() {
        assert_eq!(module_identifier("beam"), "beam");
        assert_eq!(module_identifier("Trave 2"), "Trave_2");
        assert_eq!(module_identifier("01-carichi"), "_01_carichi");
        assert_eq!(module_identifier("σ-check"), "σ_check");
        assert_eq!(module_identifier("end"), "end_k");
        assert_eq!(module_identifier("Base"), "Base_k");
        assert_eq!(module_identifier("Project"), "Project_k");
        assert_eq!(module_identifier("--"), "sheet");
        assert_eq!(module_identifier("Untitled-1"), "Untitled_1");
        assert_eq!(module_identifier("a  b__c"), "a_b_c");
    }

    #[test]
    fn clashes_get_a_number_in_path_order() {
        let names = module_names(
            &[
                ("travi/beam.eqv".into(), "beam".into()),
                ("beam.eqv".into(), "beam".into()),
                ("Thermo.eqv".into(), "Thermo".into()),
            ],
            &["Thermo".into()],
        );
        assert_eq!(names["beam.eqv"], "beam");
        assert_eq!(names["travi/beam.eqv"], "beam2");
        assert_eq!(names["Thermo.eqv"], "Thermo2");
    }
}
