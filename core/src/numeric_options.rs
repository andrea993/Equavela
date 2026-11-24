//! The numeric choices of a math region: the algorithm and the stopping rules of a solving call,
//! and the derivative method of the numeric derivatives written in the region. They are stored as
//! the region's `numeric` mapping (only the keys that differ from the defaults) and passed to the
//! runtime as keyword arguments at the call they apply to.

use std::collections::BTreeMap;

/// The algorithms of `find` and `minerr`.
pub const FIND_ALGORITHMS: &[&str] = &["auto", "levenberg-marquardt", "trust-region", "newton"];
/// The algorithms of `minimize` and `maximize`.
pub const OPTIMIZE_ALGORITHMS: &[&str] = &[
    "auto",
    "slsqp",
    "mma",
    "ccsaq",
    "lbfgs",
    "cobyla",
    "nelder-mead",
    "penalty",
];
/// The derivative methods.
pub const DERIVATIVE_METHODS: &[&str] = &["auto", "finite-differences"];

/// The keys of the mapping and the runtime keyword each one becomes.
const KEYS: &[(&str, &str)] = &[
    ("algorithm", "algorithm"),
    ("derivatives", "derivatives"),
    ("derivative-tolerance", "tolerance"),
    ("max-evaluations", "max_evaluations"),
    ("max-time", "max_time"),
    ("x-tolerance", "x_tolerance"),
    ("f-tolerance", "f_tolerance"),
];

/// Checks a region's mapping: every key known, every value of its kind. The message names the
/// first problem.
pub fn validate(options: &BTreeMap<String, String>) -> Result<(), String> {
    for (key, value) in options {
        match key.as_str() {
            "algorithm" => {
                if !FIND_ALGORITHMS.contains(&value.as_str())
                    && !OPTIMIZE_ALGORITHMS.contains(&value.as_str())
                {
                    return Err(format!("unknown algorithm `{value}`"));
                }
            }
            "derivatives" => {
                if !DERIVATIVE_METHODS.contains(&value.as_str()) {
                    return Err(format!(
                        "unknown derivative method `{value}` (auto or finite-differences)"
                    ));
                }
            }
            "max-evaluations" => {
                if !value.parse::<u64>().is_ok_and(|n| n > 0) {
                    return Err(format!(
                        "`max-evaluations` must be a positive integer, not `{value}`"
                    ));
                }
            }
            "max-time" | "x-tolerance" | "f-tolerance" | "derivative-tolerance" => {
                if !value.parse::<f64>().is_ok_and(|x| x.is_finite() && x > 0.0) {
                    return Err(format!("`{key}` must be a positive number, not `{value}`"));
                }
            }
            other => return Err(format!("unknown key `{other}`")),
        }
    }
    Ok(())
}

/// The Julia keyword arguments of a solving call (`; algorithm="slsqp", max_evaluations=500`), or
/// an empty string when every choice is the default.
pub fn solver_keywords(options: &BTreeMap<String, String>) -> String {
    keywords(options, |key| key != "derivative-tolerance")
}

/// The Julia keyword arguments of a numeric derivative (`; derivatives="finite-differences"`).
pub fn derivative_keywords(options: &BTreeMap<String, String>) -> String {
    keywords(options, |key| {
        matches!(key, "derivatives" | "derivative-tolerance")
    })
}

fn keywords(options: &BTreeMap<String, String>, wanted: impl Fn(&str) -> bool) -> String {
    let parts: Vec<String> = KEYS
        .iter()
        .filter(|(key, _)| wanted(key))
        .filter_map(|(key, keyword)| {
            let value = options.get(*key)?;
            let rendered = match *key {
                "algorithm" | "derivatives" => format!("{value:?}"),
                "max-evaluations" => value.parse::<u64>().ok()?.to_string(),
                _ => format!("{:?}", value.parse::<f64>().ok()?),
            };
            Some(format!("{keyword}={rendered}"))
        })
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!("; {}", parts.join(", "))
    }
}
