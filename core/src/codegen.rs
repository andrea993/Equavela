//! Julia code generation from the canonical AST.
//!
//! The generator turns worksheet math into Julia source that calls **only** EqRuntime
//! helpers for the reference application semantics (`eq_add`, `eq_index`, `eq_range`, ...). Generated code
//! never uses a Julia operator on a worksheet value; the only plain Julia constructs are
//! control flow, assignment, closures and literals. The program shape follows the contract
//! at the top of `kernel/EqRuntime/src/programs.jl`.
//!
//! # Names
//!
//! * **Worksheet names** (definitions at region level) get one identifier per definition
//!   version: `x := 1` is `x_v1`, a later `x := 2` is
//!   `x_v2`. Every reference is resolved to the version visible at that point; globals
//!   (`≡`) are installed first, like in [`crate::graph`].
//! * **Locals** (function parameters, program locals, loop variables, summation
//!   variables) get the plain mangled identifier without a version, so a local never
//!   collides with a sheet name.
//! * **Mangling** is deterministic and reversible ([`demangle_ident`]): ASCII letters and
//!   digits and non-ASCII letters pass through, every other character `c` becomes
//!   `_<hex>_`, a literal subscript segment is introduced by `_s`, a base segment after a
//!   subscript by `_t`, an identifier that would collide with a Julia keyword or a
//!   EqRuntime helper gets the suffix `_k`, and sheet identifiers end in `_v<N>`. A raw
//!   underscore never appears in a mangled name outside these markers.
//!
//! # Output
//!
//! [`Generator::region`] returns the statements of one region ([`GeneratedRegion::code`])
//! and the expression whose value the region displays ([`GeneratedRegion::value`]).
//! [`generate_worksheet`] orders the regions with the dependency graph and
//! [`GeneratedWorksheet::script`] joins everything into a runnable Julia script.
//!
//! Features that are not available yet (indefinite integrals, limits, `ORIGIN`
//! definitions, ...) generate an `eq_error("... is not supported yet")` node and a
//! [`Diagnostic`], so the rest of the worksheet still evaluates. Symbolic regions (`→`)
//! generate no Julia: the session sends them to the kernel as `symbolic` requests
//! (`crate::symbolic`); a name defined by a symbolic result is an error placeholder until
//! the session has the result, then [`symbolic_definition_code`] generates its numeric code.

use crate::ast::{
    Arg, BranchKind, Expr, ExprKind, Ident, JuliaBlock, Label, Name, Segment, Span, Statement,
    StatementKind, Stmt, StmtKind, Tail, Target, TargetKind,
};
use crate::fasthash::{HashMap, HashSet};
use crate::graph::{DependencyGraph, GraphError, Worksheet};
use crate::syntax::{print_expression, print_name};
use crate::units::is_unit;
use std::collections::BTreeSet;

// ---------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------

/// A structural problem that makes a construct impossible to generate (an empty program
/// body, an invalid assignment target).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct CodegenError {
    pub message: String,
    pub span: Span,
}

impl CodegenError {
    fn new(message: impl Into<String>, span: Span) -> CodegenError {
        CodegenError {
            message: message.into(),
            span,
        }
    }
}

/// A problem that does not stop generation: the construct generates an `eq_error` node
/// that fails when it is evaluated (undefined names, unsupported features, placeholders).
#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub span: Span,
    pub message: String,
}

/// An imported Julia function: `lqr` from `ControlSystems.lqr`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JuliaImport {
    pub package: String,
    pub function: String,
}

/// Generator settings.
#[derive(Debug, Clone, Default)]
pub struct GenOptions {
    /// Worksheet names that stand for Julia package functions (`import:` of a `julia`
    /// region), keyed by the worksheet name.
    pub julia_imports: HashMap<String, JuliaImport>,
    /// The project's references: a name under one of their aliases that does not resolve gets
    /// the reference's message.
    pub references: std::sync::Arc<crate::project_reference::References>,
}

/// Where a program statement came from: the id that `eq_locate` attaches to an error.
#[derive(Debug, Clone, PartialEq)]
pub struct StatementLocation {
    pub id: i64,
    pub region_id: String,
    pub span: Span,
}

/// The Julia for one region.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedRegion {
    pub id: String,
    /// Julia statements that define names (may be empty, may span several lines).
    pub code: String,
    /// Julia expression whose value the region displays (`e =`, `x := e =`), if any.
    pub value: Option<String>,
    /// Julia identifiers the region defines.
    pub defined: Vec<String>,
    pub diagnostics: Vec<Diagnostic>,
    /// The region runs Julia code or calls Julia functions (a `julia` region, an imported
    /// or Julia-defined name, a qualified `Pkg::f` call). Such a region needs a trusted
    /// worksheet.
    pub needs_julia: bool,
    /// Julia packages the region calls through qualified calls (`Pkg::f`) or imports.
    pub packages: Vec<String>,
    /// The unit override of an evaluation, if any. It never changes
    /// `value`: the kernel returns it next to the result and the UI formats the result.
    pub display_unit: Option<DisplayUnitCode>,
    /// The name this region defines by a symbolic result (`g(x) := e →`): the session
    /// replaces its placeholder with code generated from the result ([`symbolic_definition_code`]).
    pub symbolic_target: Option<SymbolicTarget>,
    /// A `julia` cell: its output, duration and trace are recorded.
    pub julia_cell: bool,
}

/// The name a definition by a symbolic result defines.
#[derive(Debug, Clone, PartialEq)]
pub struct SymbolicTarget {
    /// The Julia identifier of the definition.
    pub ident: String,
    /// The parameters of a function definition (`None` for a variable).
    pub params: Option<Vec<Name>>,
}

/// A unit override as generated code plus the text the UI shows after the result.
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayUnitCode {
    /// Julia expression of the unit (`eq_div(eq_unit("km"), eq_unit("hr"))`).
    pub code: String,
    /// The unit expression in the worksheet syntax (`km/hr`).
    pub text: String,
}

/// A generated worksheet: regions in evaluation order.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedWorksheet {
    pub regions: Vec<GeneratedRegion>,
    pub statements: Vec<StatementLocation>,
    /// Julia packages used by qualified calls (`Pkg::f(...)`).
    pub packages: Vec<String>,
}

impl GeneratedWorksheet {
    /// A runnable Julia script: loads EqRuntime, runs every region in order and stores the
    /// displayed values in `__results` keyed by region id. An error raised by a value
    /// expression is stored as the exception object. Unit overrides are validated like the
    /// kernel does and their units stored in `__units` (the value is untouched).
    pub fn script(&self) -> String {
        let mut text = String::from("using EqRuntime\n");
        for package in &self.packages {
            text.push_str(&format!("import {package}\n"));
        }
        text.push_str("const __results = Dict{String,Any}()\n");
        text.push_str("const __units = Dict{String,Any}()\n");
        for region in &self.regions {
            if !region.code.is_empty() {
                text.push_str(&region.code);
                text.push('\n');
            }
            if let Some(value) = &region.value {
                text.push_str(&format!(
                    "__results[{}] = try\n{}\ncatch __e\n    __e\nend\n",
                    julia_string(&region.id),
                    indent(value)
                ));
                if let Some(unit) = &region.display_unit {
                    let id = julia_string(&region.id);
                    text.push_str(&format!(
                        "__units[{id}] = try\n    __results[{id}] isa Exception ? __results[{id}] : eq_display_unit(__results[{id}], {})\ncatch __e\n    __e\nend\n",
                        unit.code
                    ));
                }
            }
        }
        text
    }
}

// ---------------------------------------------------------------------------------------
// Built-ins, constants
// ---------------------------------------------------------------------------------------

/// Worksheet function names that EqRuntime implements, with their helper. `if` and `error`
/// are special forms handled by the generator (`if` takes thunks).
///
/// `root` is a special form that is deliberately not in this table (its helper takes the
/// expression as a lambda of the unknown, see `Generator::root_call`): `root(f(x), x)` is
/// `eq_root(x -> f(x), guess)` and `root(f(x), x, a, b)` is `eq_root(x -> f(x), a, b)`. A
/// call named `root` is always the solver (the n-th root is the operator `√[n](x)`); a
/// worksheet definition named `root` takes precedence.
///
/// Extend this table when EqRuntime gains a built-in; a name that is not in the table is
/// reported as an undefined function.
pub const BUILTINS: &[(&str, &str)] = &[
    ("Jacob", "eq_jacob"),
    ("dft", "eq_dft"),
    ("idft", "eq_idft"),
    ("dftr", "eq_dftr"),
    ("idftr", "eq_idftr"),
    ("cfft", "eq_cfft"),
    ("icfft", "eq_icfft"),
    ("cpt", "eq_cpt"),
    ("Bspline", "eq_Bspline"),
    ("wave", "eq_wave"),
    ("iwave", "eq_iwave"),
    ("J0", "eq_J0"),
    ("J1", "eq_J1"),
    ("Jn", "eq_Jn"),
    ("Y0", "eq_Y0"),
    ("Y1", "eq_Y1"),
    ("Yn", "eq_Yn"),
    ("I0", "eq_I0"),
    ("I1", "eq_I1"),
    ("In", "eq_In"),
    ("K0", "eq_K0"),
    ("K1", "eq_K1"),
    ("Kn", "eq_Kn"),
    ("H1", "eq_H1"),
    ("H2", "eq_H2"),
    ("Ai", "eq_Ai"),
    ("DAi", "eq_DAi"),
    ("Bi", "eq_Bi"),
    ("DBi", "eq_DBi"),
    ("ber", "eq_ber"),
    ("bei", "eq_bei"),
    ("js", "eq_js"),
    ("ys", "eq_ys"),
    ("erf", "eq_erf"),
    ("erfc", "eq_erfc"),
    ("Γ", "eq_Γ"),
    ("lnΓ", "eq_lnΓ"),
    ("Psi", "eq_Psi"),
    ("fhyper", "eq_fhyper"),
    ("mhyper", "eq_mhyper"),
    ("ibeta", "eq_ibeta"),
    ("Jac", "eq_Jac"),
    ("READFILE", "eq_READFILE"),
    ("WRITEFILE", "eq_WRITEFILE"),
    ("READTEXT", "eq_READTEXT"),
    ("WRITETEXT", "eq_WRITETEXT"),
    ("READBIN", "eq_READBIN"),
    ("WRITEBIN", "eq_WRITEBIN"),
    ("READCSV", "eq_READCSV"),
    ("WRITECSV", "eq_WRITECSV"),
    ("READPRN", "eq_READPRN"),
    ("WRITEPRN", "eq_WRITEPRN"),
    ("APPENDPRN", "eq_APPENDPRN"),
    ("WRITEEXCEL", "eq_WRITEEXCEL"),
    ("READ_IMAGE", "eq_READ_IMAGE"),
    ("READBMP", "eq_READBMP"),
    ("WRITEBMP", "eq_WRITEBMP"),
    ("READRGB", "eq_READRGB"),
    ("WRITERGB", "eq_WRITERGB"),
    ("READ_RED", "eq_READ_RED"),
    ("READ_GREEN", "eq_READ_GREEN"),
    ("READ_BLUE", "eq_READ_BLUE"),
    ("READ_HLS", "eq_READ_HLS"),
    ("WRITE_HLS", "eq_WRITE_HLS"),
    ("READ_HSV", "eq_READ_HSV"),
    ("WRITE_HSV", "eq_WRITE_HSV"),
    ("READ_HLS_SAT", "eq_READ_HLS_SAT"),
    ("READ_HSV_SAT", "eq_READ_HSV_SAT"),
    ("READ_LIGHT", "eq_READ_LIGHT"),
    ("READ_VALUE", "eq_READ_VALUE"),
    ("READ_HUE", "eq_READ_HUE"),
    ("READWAV", "eq_READWAV"),
    ("WRITEWAV", "eq_WRITEWAV"),
    ("GETWAVINFO", "eq_GETWAVINFO"),
    ("J0.sc", "eq_J0_sc"),
    ("J1.sc", "eq_J1_sc"),
    ("Jn.sc", "eq_Jn_sc"),
    ("Y0.sc", "eq_Y0_sc"),
    ("Y1.sc", "eq_Y1_sc"),
    ("Yn.sc", "eq_Yn_sc"),
    ("I0.sc", "eq_I0_sc"),
    ("I1.sc", "eq_I1_sc"),
    ("In.sc", "eq_In_sc"),
    ("K0.sc", "eq_K0_sc"),
    ("K1.sc", "eq_K1_sc"),
    ("Kn.sc", "eq_Kn_sc"),
    ("H1.sc", "eq_H1_sc"),
    ("H2.sc", "eq_H2_sc"),
    ("Ai.sc", "eq_Ai_sc"),
    ("DAi.sc", "eq_DAi_sc"),
    ("Bi.sc", "eq_Bi_sc"),
    ("DBi.sc", "eq_DBi_sc"),
    ("Gamma", "eq_Γ"),
    ("lnGamma", "eq_lnΓ"),
    ("hist", "eq_hist"),
    ("histogram", "eq_histogram"),
    ("boxplot", "eq_boxplot"),
    ("boxplotgraph", "eq_boxplotgraph"),
    ("pareto", "eq_pareto"),
    ("fullfact", "eq_fullfact"),
    ("fractfact", "eq_fractfact"),
    ("plackettburman", "eq_plackettburman"),
    ("boxbehnken", "eq_boxbehnken"),
    ("taguchi", "eq_taguchi"),
    ("randomize", "eq_randomize"),
    ("foldover", "eq_foldover"),
    ("doelabel", "eq_doelabel"),
    ("effects", "eq_effects"),
    ("quickscreen", "eq_quickscreen"),
    ("anova", "eq_anova"),
    ("Normal", "eq_Normal"),
    ("Uniform", "eq_Uniform"),
    ("LogNormal", "eq_LogNormal"),
    ("Weibull", "eq_Weibull"),
    ("montecarlo", "eq_montecarlo"),
    ("triangular", "eq_triangular"),
    ("hamming", "eq_hamming"),
    ("hanning", "eq_hanning"),
    ("blackman", "eq_blackman"),
    ("gaussian", "eq_gaussian"),
    ("qqplot", "eq_qqplot"),
    ("Grubbs", "eq_Grubbs"),
    ("GrubbsClassic", "eq_GrubbsClassic"),
    ("ThreeSigma", "eq_ThreeSigma"),
    ("trim", "eq_trim"),
    ("markNaN", "eq_markNaN"),
    ("matchNaN", "eq_matchNaN"),
    ("filterNaN", "eq_filterNaN"),
    ("Nipals", "eq_Nipals"),
    ("Nipals2", "eq_Nipals2"),
    ("scores", "eq_scores"),
    ("loadings", "eq_loadings"),
    ("PCAeigenvals", "eq_PCAeigenvals"),
    ("PCAvariance", "eq_PCAvariance"),
    ("localmax", "eq_localmax"),
    ("localmin", "eq_localmin"),
    ("supsmooth", "eq_supsmooth"),
    ("ksmooth", "eq_ksmooth"),
    ("medsmooth", "eq_medsmooth"),
    ("VSmooth", "eq_VSmooth"),
    ("expsmooth", "eq_expsmooth"),
    ("movavg", "eq_movavg"),
    ("rkfixed", "eq_rkfixed"),
    ("Rkadapt", "eq_Rkadapt"),
    ("Bulstoer", "eq_Bulstoer"),
    ("Adams", "eq_Adams"),
    ("BDF", "eq_BDF"),
    ("Radau", "eq_Radau"),
    ("Stiffb", "eq_Stiffb"),
    ("Stiffr", "eq_Stiffr"),
    ("AdamsBDF", "eq_AdamsBDF"),
    ("statespace", "eq_statespace"),
    ("sbval", "eq_sbval"),
    ("bvalfit", "eq_bvalfit"),
    ("numol", "eq_numol"),
    ("relax", "eq_relax"),
    ("multigrid", "eq_multigrid"),
    ("bspline", "eq_bspline"),
    ("loess", "eq_loess"),
    ("Spline2", "eq_Spline2"),
    ("Binterp", "eq_Binterp"),
    ("DWS", "eq_DWS"),
    ("Bicubic2D", "eq_Bicubic2D"),
    ("predict", "eq_predict"),
    ("polyint", "eq_polyint"),
    ("polyiter", "eq_polyiter"),
    ("rationalint", "eq_rationalint"),
    ("Thielecoeff", "eq_Thielecoeff"),
    ("Thiele", "eq_Thiele"),
    ("line", "eq_line"),
    ("slope", "eq_slope"),
    ("intercept", "eq_intercept"),
    ("stderr", "eq_stderr"),
    ("medfit", "eq_medfit"),
    ("rationalfit", "eq_rationalfit"),
    ("rationalfitnp", "eq_rationalfitnp"),
    ("polyfit", "eq_polyfit"),
    ("polyfitc", "eq_polyfitc"),
    ("polyfitstat", "eq_polyfitstat"),
    ("genfit", "eq_genfit"),
    ("expfit", "eq_expfit"),
    ("lnfit", "eq_lnfit"),
    ("logfit", "eq_logfit"),
    ("lgsfit", "eq_lgsfit"),
    ("pwrfit", "eq_pwrfit"),
    ("sinfit", "eq_sinfit"),
    ("LeastSquaresFit", "eq_LeastSquaresFit"),
    ("confidence", "eq_confidence"),
    ("linfit", "eq_linfit"),
    ("multidfit", "eq_multidfit"),
    ("rows", "eq_rows"),
    ("cols", "eq_cols"),
    ("length", "eq_length"),
    ("last", "eq_last"),
    ("stack", "eq_stack"),
    ("augment", "eq_augment"),
    ("submatrix", "eq_submatrix"),
    ("identity", "eq_identity"),
    ("matrix", "eq_matrix_fn"),
    ("diag", "eq_diag"),
    ("tr", "eq_tr"),
    ("rank", "eq_rank"),
    ("eigenvals", "eq_eigenvals"),
    ("eigenvecs", "eq_eigenvecs"),
    ("match", "eq_match"),
    ("max", "eq_max"),
    ("min", "eq_min"),
    ("floor", "eq_floor"),
    ("ceil", "eq_ceil"),
    ("trunc", "eq_trunc"),
    ("round", "eq_round"),
    ("Floor", "eq_Floor"),
    ("Ceil", "eq_Ceil"),
    ("Round", "eq_Round"),
    ("Trunc", "eq_Trunc"),
    ("mod", "eq_mod"),
    ("atan2", "eq_atan2"),
    ("combin", "eq_combin"),
    ("Re", "eq_re"),
    ("Im", "eq_im"),
    ("sqrt", "eq_sqrt"),
    ("exp", "eq_exp"),
    ("ln", "eq_ln"),
    ("log", "eq_log"),
    ("sin", "eq_sin"),
    ("cos", "eq_cos"),
    ("tan", "eq_tan"),
    ("asin", "eq_asin"),
    ("acos", "eq_acos"),
    ("atan", "eq_atan"),
    ("abs", "eq_abs"),
    ("sort", "eq_sort"),
    ("reverse", "eq_reverse"),
    ("csort", "eq_csort"),
    ("rsort", "eq_rsort"),
    ("mean", "eq_mean"),
    ("median", "eq_median"),
    ("var", "eq_var"),
    ("Var", "eq_Var"),
    ("stdev", "eq_stdev"),
    ("Stdev", "eq_Stdev"),
    ("IsScalar", "eq_isscalar"),
    ("IsArray", "eq_isarray"),
    ("IsFunction", "eq_isfunction"),
    ("IsRange", "eq_isrange"),
    ("SIUnitsOf", "eq_siunitsof"),
    ("IsString", "eq_isstring"),
    ("lookup", "eq_lookup"),
    ("vlookup", "eq_vlookup"),
    ("hlookup", "eq_hlookup"),
    ("vhlookup", "eq_vhlookup"),
    ("Rank", "eq_Rank"),
    ("order", "eq_order"),
    ("norm1", "eq_norm1"),
    ("norm2", "eq_norm2"),
    ("norme", "eq_norme"),
    ("normi", "eq_normi"),
    ("cond1", "eq_cond1"),
    ("cond2", "eq_cond2"),
    ("conde", "eq_conde"),
    ("condi", "eq_condi"),
    ("qr", "eq_qr"),
    ("geninv", "eq_geninv"),
    ("lsolve", "eq_lsolve"),
    ("gmean", "eq_gmean"),
    ("hmean", "eq_hmean"),
    ("mode", "eq_mode"),
    ("percentile", "eq_percentile"),
    ("permut", "eq_permut"),
    ("gcd", "eq_gcd"),
    ("lcm", "eq_lcm"),
    ("sign", "eq_sign"),
    ("signum", "eq_signum"),
    ("csgn", "eq_csgn"),
    ("arg", "eq_arg"),
    ("angle", "eq_angle"),
    ("sinh", "eq_sinh"),
    ("cosh", "eq_cosh"),
    ("tanh", "eq_tanh"),
    ("asinh", "eq_asinh"),
    ("csch", "eq_csch"),
    ("sech", "eq_sech"),
    ("coth", "eq_coth"),
    ("csc", "eq_csc"),
    ("sec", "eq_sec"),
    ("cot", "eq_cot"),
    ("sinc", "eq_sinc"),
    ("acosh", "eq_acosh"),
    ("atanh", "eq_atanh"),
    ("acsch", "eq_acsch"),
    ("asech", "eq_asech"),
    ("acoth", "eq_acoth"),
    ("acsc", "eq_acsc"),
    ("asec", "eq_asec"),
    ("acot", "eq_acot"),
    ("ln0", "eq_ln0"),
    ("concat", "eq_concat"),
    ("strlen", "eq_strlen"),
    ("substr", "eq_substr"),
    ("search", "eq_search"),
    ("num2str", "eq_num2str"),
    ("str2num", "eq_str2num"),
    ("vec2str", "eq_vec2str"),
    ("str2vec", "eq_str2vec"),
    ("format", "eq_format"),
    ("Leg", "eq_Leg"),
    ("Tcheb", "eq_Tcheb"),
    ("Ucheb", "eq_Ucheb"),
    ("Her", "eq_Her"),
    ("Lag", "eq_Lag"),
    ("δ", "eq_δ"),
    ("Φ", "eq_Φ"),
    ("ε", "eq_ε"),
    ("IsNaN", "eq_isnan"),
    ("cholesky", "eq_cholesky"),
    ("Cholesky", "eq_Cholesky"),
    ("LU", "eq_LU"),
    ("QR", "eq_QR"),
    ("svds", "eq_svds"),
    ("svd", "eq_svd"),
    ("genvals", "eq_genvals"),
    ("genvecs", "eq_genvecs"),
    ("eigenvec", "eq_eigenvec"),
    ("kronecker", "eq_kronecker"),
    ("rref", "eq_rref"),
    ("logspace", "eq_logspace"),
    ("logpts", "eq_logpts"),
    ("polyroots", "eq_polyroots"),
    ("polycoeff", "eq_polycoeff"),
    ("linterp", "eq_linterp"),
    ("lspline", "eq_lspline"),
    ("pspline", "eq_pspline"),
    ("cspline", "eq_cspline"),
    ("interp", "eq_interp"),
    ("cvar", "eq_cvar"),
    ("covar", "eq_covar"),
    ("corr", "eq_corr"),
    ("Ftest", "eq_Ftest"),
    ("Spear", "eq_Spear"),
    ("kendltau", "eq_kendltau"),
    ("kendltau2", "eq_kendltau2"),
    ("contingtbl", "eq_contingtbl"),
    ("skew", "eq_skew"),
    ("kurt", "eq_kurt"),
    ("rnorm", "eq_rnorm"),
    ("rnd", "eq_rnd"),
    ("Seed", "eq_Seed"),
    ("dbeta", "eq_dbeta"),
    ("pbeta", "eq_pbeta"),
    ("qbeta", "eq_qbeta"),
    ("rbeta", "eq_rbeta"),
    ("dbinom", "eq_dbinom"),
    ("pbinom", "eq_pbinom"),
    ("qbinom", "eq_qbinom"),
    ("rbinom", "eq_rbinom"),
    ("dcauchy", "eq_dcauchy"),
    ("pcauchy", "eq_pcauchy"),
    ("qcauchy", "eq_qcauchy"),
    ("rcauchy", "eq_rcauchy"),
    ("dchisq", "eq_dchisq"),
    ("pchisq", "eq_pchisq"),
    ("qchisq", "eq_qchisq"),
    ("rchisq", "eq_rchisq"),
    ("dexp", "eq_dexp"),
    ("pexp", "eq_pexp"),
    ("qexp", "eq_qexp"),
    ("rexp", "eq_rexp"),
    ("dF", "eq_dF"),
    ("pF", "eq_pF"),
    ("qF", "eq_qF"),
    ("rF", "eq_rF"),
    ("dgamma", "eq_dgamma"),
    ("pgamma", "eq_pgamma"),
    ("qgamma", "eq_qgamma"),
    ("rgamma", "eq_rgamma"),
    ("dgeom", "eq_dgeom"),
    ("pgeom", "eq_pgeom"),
    ("qgeom", "eq_qgeom"),
    ("rgeom", "eq_rgeom"),
    ("dhypergeom", "eq_dhypergeom"),
    ("phypergeom", "eq_phypergeom"),
    ("qhypergeom", "eq_qhypergeom"),
    ("rhypergeom", "eq_rhypergeom"),
    ("dlnorm", "eq_dlnorm"),
    ("plnorm", "eq_plnorm"),
    ("qlnorm", "eq_qlnorm"),
    ("rlnorm", "eq_rlnorm"),
    ("dlogis", "eq_dlogis"),
    ("plogis", "eq_plogis"),
    ("qlogis", "eq_qlogis"),
    ("rlogis", "eq_rlogis"),
    ("dnbinom", "eq_dnbinom"),
    ("pnbinom", "eq_pnbinom"),
    ("qnbinom", "eq_qnbinom"),
    ("rnbinom", "eq_rnbinom"),
    ("dnorm", "eq_dnorm"),
    ("pnorm", "eq_pnorm"),
    ("qnorm", "eq_qnorm"),
    ("dpois", "eq_dpois"),
    ("ppois", "eq_ppois"),
    ("qpois", "eq_qpois"),
    ("rpois", "eq_rpois"),
    ("dt", "eq_dt"),
    ("pt", "eq_pt"),
    ("qt", "eq_qt"),
    ("rt", "eq_rt"),
    ("dunif", "eq_dunif"),
    ("punif", "eq_punif"),
    ("qunif", "eq_qunif"),
    ("runif", "eq_runif"),
    ("dweibull", "eq_dweibull"),
    ("pweibull", "eq_pweibull"),
    ("qweibull", "eq_qweibull"),
    ("rweibull", "eq_rweibull"),
    ("cnorm", "eq_cnorm"),
    ("convol", "eq_convolve"),
    ("convolve", "eq_convolve"),
    ("crosscorr", "eq_crosscorr"),
    ("deconvolve", "eq_deconvolve"),
    ("vec", "eq_vecrange"),
    ("vsum", "eq_vsum"),
    ("READODS", "eq_READODS"),
    ("WRITEODS", "eq_WRITEODS"),
    ("if", "eq_if"),
    ("error", "eq_error"),
];

/// Built-ins that Equavela deliberately does not implement, with the message a call to one
/// reports: the name still resolves to nothing, but the region says what to use instead.
/// A worksheet definition of the name wins over the
/// message, like any other resolved name.
pub const REPLACED_BUILTINS: &[(&str, &str)] = &[(
    "READEXCEL",
    "READEXCEL is not supported: Equavela reads OpenDocument spreadsheets with READODS",
)];

/// The message of a call to a built-in that was replaced (`REPLACED_BUILTINS`).
pub fn replaced_builtin(text: &str) -> Option<&'static str> {
    REPLACED_BUILTINS
        .iter()
        .find(|(worksheet_name, _)| *worksheet_name == text)
        .map(|(_, message)| *message)
}

/// Whether `text` names a built-in function or a constant: such a name cannot be
/// imported or exported by a `julia` region.
pub fn is_reserved_name(text: &str) -> bool {
    BUILTINS
        .iter()
        .any(|(worksheet_name, _)| *worksheet_name == text)
        || matches!(
            text,
            "π" | "e" | "γ" | "∞" | "NaN" | "ORIGIN" | "TOL" | "CTOL"
        )
}

/// The value of a name that is defined by a symbolic result:
/// the placeholder that stays when the symbolic evaluation fails; the session replaces it
/// with the code generated from the result.
fn symbolic_definition_error() -> String {
    format!(
        "eq_error({})",
        julia_string("defined by a symbolic result that is not available")
    )
}

fn builtin(name: &Name) -> Option<&'static str> {
    let text = simple_text(name)?;
    BUILTINS
        .iter()
        .find(|(worksheet_name, _)| *worksheet_name == text)
        .map(|(_, helper)| *helper)
}

fn simple_text(name: &Name) -> Option<&str> {
    match name.segments.as_slice() {
        [segment] if !segment.subscript => Some(&segment.text),
        _ => None,
    }
}

pub(crate) enum Intrinsic {
    Number(&'static str),
    Physical(&'static str),
    System(&'static str),
    Builtin(&'static str),
}

/// Names provided by the engine when no local or worksheet definition applies.
pub(crate) fn intrinsic(name: &Name) -> Option<Intrinsic> {
    if matches!(name.label, None | Some(Label::Const) | Some(Label::Sys)) {
        let value = match simple_text(name) {
            Some("π") => Some(Intrinsic::Number("3.141592653589793")),
            Some("e") => Some(Intrinsic::Number("2.718281828459045")),
            Some("γ") => Some(Intrinsic::Number("0.5772156649015329")),
            Some("∞") => Some(Intrinsic::Number("Inf")),
            Some("NaN") => Some(Intrinsic::Number("NaN")),
            Some("ORIGIN") => Some(Intrinsic::System("origin()")),
            Some("TOL") => Some(Intrinsic::System("tol()")),
            Some("CTOL") => Some(Intrinsic::System("ctol()")),
            _ => crate::constants::constant_name(name).map(Intrinsic::Physical),
        };
        if value.is_some() {
            return value;
        }
    }
    if matches!(name.label, None | Some(Label::Fn)) {
        return builtin(name).map(Intrinsic::Builtin);
    }
    None
}

// ---------------------------------------------------------------------------------------
// Mangling
// ---------------------------------------------------------------------------------------

const RESERVED: &[&str] = &[
    "abstract",
    "baremodule",
    "begin",
    "break",
    "catch",
    "ComplexF64",
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
    "in",
    "Inf",
    "isa",
    "let",
    "local",
    "macro",
    "missing",
    "module",
    "mutable",
    "NaN",
    "nothing",
    "ctol",
    "origin",
    "tol",
    "outer",
    "primitive",
    "quote",
    "return",
    "struct",
    "true",
    "try",
    "type",
    "using",
    "where",
    "while",
];

fn escape_text(out: &mut String, text: &str, at_start: bool) {
    for (index, c) in text.chars().enumerate() {
        let plain = if c.is_ascii() {
            c.is_ascii_alphanumeric() && !(at_start && index == 0 && c.is_ascii_digit())
        } else {
            // U+00B5 and U+025B are rewritten by Julia's identifier normalization, which
            // would merge them with U+03BC and U+03B5.
            c.is_alphabetic() && !c.is_numeric() && !matches!(c, '\u{b5}' | '\u{25b}')
        };
        if plain {
            out.push(c);
        } else {
            out.push_str(&format!("_{:x}_", c as u32));
        }
    }
}

/// The mangled form of a name's segments, without version or keyword guard.
fn mangle(name: &Name) -> String {
    let mut out = String::new();
    for (index, segment) in name.segments.iter().enumerate() {
        if index == 0 {
            escape_text(&mut out, &segment.text, true);
        } else {
            out.push_str(if segment.subscript { "_s" } else { "_t" });
            escape_text(&mut out, &segment.text, false);
        }
    }
    out
}

fn guard(mangled: String) -> String {
    if RESERVED.contains(&mangled.as_str()) || mangled.starts_with("eq_") {
        format!("{mangled}_k")
    } else {
        mangled
    }
}

/// The Julia identifier of a local (parameter, program local, loop or summation variable).
pub fn local_ident(name: &Name) -> String {
    guard(mangle(name))
}

/// The Julia identifier of version `version` (one-based) of a sheet name.
pub fn worksheet_ident(name: &Name, version: u32) -> String {
    format!("{}_v{version}", mangle(name))
}

/// Reverses [`local_ident`] and [`worksheet_ident`]: the name segments (the label is not part
/// of an identifier) and the version for a sheet identifier. `None` for a string that is
/// not a mangled identifier.
pub fn demangle_ident(ident: &str) -> Option<(Vec<Segment>, Option<u32>)> {
    let mut rest = ident;
    let mut version = None;
    if let Some(position) = rest.rfind("_v") {
        let digits = &rest[position + 2..];
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            version = Some(digits.parse().ok()?);
            rest = &rest[..position];
        }
    }
    if version.is_none() {
        if let Some(stripped) = rest.strip_suffix("_k") {
            rest = stripped;
        }
    }
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut subscript = false;
    let chars: Vec<char> = rest.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if c != '_' {
            current.push(c);
            index += 1;
            continue;
        }
        match chars.get(index + 1)? {
            's' | 't' => {
                segments.push(Segment {
                    text: std::mem::take(&mut current),
                    subscript,
                });
                subscript = chars[index + 1] == 's';
                index += 2;
            }
            _ => {
                let mut end = index + 1;
                while end < chars.len() && chars[end].is_ascii_hexdigit() {
                    end += 1;
                }
                if end == index + 1 || chars.get(end) != Some(&'_') {
                    return None;
                }
                let hex: String = chars[index + 1..end].iter().collect();
                current.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                index = end + 1;
            }
        }
    }
    segments.push(Segment {
        text: current,
        subscript,
    });
    Some((segments, version))
}

// ---------------------------------------------------------------------------------------
// Literals and text helpers
// ---------------------------------------------------------------------------------------

fn number(text: &str) -> String {
    let text = text.replace('E', "e");
    if text.contains(['.', 'e']) {
        text
    } else {
        format!("{text}.0")
    }
}

/// A Julia string literal (no interpolation, no raw line breaks).
pub fn julia_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '$' => out.push_str("\\$"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn indent(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("    {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn call(function: &str, args: &[String]) -> String {
    format!("{function}({})", args.join(", "))
}

/// Create a fresh function each time this region runs. Defining a method directly on the
/// worksheet binding would keep Julia's previous methods when the parameter count changes.
fn worksheet_function(ident: &str, definition: &str) -> String {
    format!("{ident} = let\n{}\n    {ident}\nend", indent(definition))
}

fn binary(function: &str, left: String, right: String) -> String {
    format!("{function}({left}, {right})")
}

fn valid_module_path(text: &str) -> bool {
    crate::julia_code::is_module_path(text)
}

fn valid_julia_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '!')
}

// ---------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Space {
    Var,
    Fn,
}

#[derive(Debug, Clone)]
struct WorksheetBinding {
    ident: String,
    range: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Value,
    Callee,
}

enum Resolution {
    Local {
        ident: String,
        frame: usize,
    },
    Worksheet(WorksheetBinding),
    Constant(&'static str),
    /// A physical constant (`eq_constant("c")`, `core/src/constants.rs`).
    Physical(&'static str),
    Builtin(&'static str),
    /// A reference application unit name (`eq_unit("km")`).
    Unit(String),
    Julia(JuliaImport),
    /// A name defined by the code of a `julia` region: read through `from_julia`.
    JuliaValue(String),
    Undefined(String),
}

#[derive(Debug, Default)]
struct Frame {
    /// Local identifiers with the number of open vectorize captures when they were bound.
    locals: HashMap<String, usize>,
    /// Locals that are definitely assigned at the current point.
    assigned: HashSet<String>,
    loop_depth: usize,
}

#[derive(Debug, Default)]
struct Scan {
    assigned: Vec<(String, Name)>,
    indexed: HashSet<String>,
}

/// The code generator. Holds the sheet environment (which definition version of each name
/// is visible) and the statement locations; feed it regions in evaluation order.
#[derive(Debug, Default)]
pub struct Generator {
    options: GenOptions,
    /// Generating inside an expression: an inline definition binds in the frame of the
    /// outermost expression, which is opened only once per statement expression.
    in_expression: bool,
    /// The local identifiers of the names an operand reads after their inline definition in
    /// the statement expression being generated.
    inline_read: HashSet<String>,
    versions: HashMap<String, u32>,
    visible: HashMap<(String, Space), WorksheetBinding>,
    frames: Vec<Frame>,
    captures: Vec<Vec<String>>,
    used_ranges: Vec<String>,
    diagnostics: Vec<Diagnostic>,
    statements: Vec<StatementLocation>,
    next_statement: i64,
    temp: u32,
    packages: BTreeSet<String>,
    region_id: String,
    /// Names defined by the code of `julia` regions seen so far (the Julia identifier is
    /// the name itself).
    julia_names: HashSet<String>,
    /// Whether the region being generated runs or calls Julia.
    region_julia: bool,
    /// Packages the region being generated uses.
    region_packages: BTreeSet<String>,
    /// Bindings installed by the region being generated, to undo them on a failure.
    undo: Vec<UndoEntry>,
    /// Generating the unit of a unit override: a slot that can only hold a unit, so plain names
    /// are units even when a variable or function of that name exists.
    unit_context: bool,
    /// The unit override of the region being generated.
    region_display_unit: Option<DisplayUnitCode>,
    /// The definition by a symbolic result of the region being generated.
    region_symbolic_target: Option<SymbolicTarget>,
    /// The constraint lines of the solve block being generated, if any: the solving call
    /// (`Find`, `Minerr`, `Minimize`, `Maximize`) compiles them.
    region_solve: Option<Vec<Expr>>,
    /// The local definitions (by statement address) whose `eq_val` copy a liveness analysis
    /// proved unobservable (`moves.rs`).
    elided_copies: HashSet<usize>,
    /// Inside a program, which reads `ORIGIN` once at its entry (`__o`) for every index.
    origin_hoisted: u32,
    /// Whether the program being generated used `__o` (the declaration is emitted only then).
    origin_used: bool,
}

/// The solving functions of a solve block (spelled `Find` or `find`, and so on).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SolveFunction {
    Find,
    Minerr,
    Minimize,
    Maximize,
    Odesolve,
}

impl SolveFunction {
    fn from_name(name: &str) -> Option<SolveFunction> {
        match name.to_lowercase().as_str() {
            "find" => Some(SolveFunction::Find),
            "minerr" => Some(SolveFunction::Minerr),
            "minimize" => Some(SolveFunction::Minimize),
            "maximize" => Some(SolveFunction::Maximize),
            "odesolve" => Some(SolveFunction::Odesolve),
            _ => None,
        }
    }

    fn has_objective(self) -> bool {
        matches!(self, SolveFunction::Minimize | SolveFunction::Maximize)
    }

    fn helper(self) -> &'static str {
        match self {
            SolveFunction::Find => "eq_find",
            SolveFunction::Minerr => "eq_minerr",
            SolveFunction::Minimize => "eq_minimize",
            SolveFunction::Maximize => "eq_maximize",
            SolveFunction::Odesolve => "eq_odesolve",
        }
    }

    fn display(self) -> &'static str {
        match self {
            SolveFunction::Find => "Find",
            SolveFunction::Minerr => "Minerr",
            SolveFunction::Minimize => "Minimize",
            SolveFunction::Maximize => "Maximize",
            SolveFunction::Odesolve => "odesolve",
        }
    }
}

type UndoEntry = ((String, Space), Option<WorksheetBinding>, Option<u32>);

type Defs = HashMap<(String, Space), String>;

impl Generator {
    pub fn new(options: GenOptions) -> Generator {
        Generator {
            options,
            ..Generator::default()
        }
    }

    /// Declares a sheet variable (as if an earlier region defined it) and returns its
    /// identifier. For hosts and tests that generate single expressions.
    pub fn declare_variable(&mut self, name: &str) -> String {
        self.declare(name, Space::Var, false)
    }

    /// Like [`Generator::declare_variable`] for a range variable (`i := 0..n`).
    pub fn declare_range(&mut self, name: &str) -> String {
        self.declare(name, Space::Var, true)
    }

    /// Like [`Generator::declare_variable`] for a function.
    pub fn declare_function(&mut self, name: &str) -> String {
        self.declare(name, Space::Fn, false)
    }

    fn declare(&mut self, name: &str, space: Space, range: bool) -> String {
        let name = Name::plain(name);
        let mut defs = Defs::default();
        self.bind_sheet(&name, space, &mut defs, range)
    }

    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    pub fn statements(&self) -> &[StatementLocation] {
        &self.statements
    }

    /// Julia packages used by qualified calls so far.
    pub fn packages(&self) -> Vec<String> {
        self.packages.iter().cloned().collect()
    }

    // ------------------------------------------------------------------ sheet bindings

    fn bind_sheet(&mut self, name: &Name, space: Space, defs: &mut Defs, range: bool) -> String {
        let base = mangle(name);
        let key = (base.clone(), space);
        if let Some(ident) = defs.get(&key) {
            let ident = ident.clone();
            if range {
                if let Some(binding) = self.visible.get_mut(&key) {
                    binding.range = true;
                }
            }
            return ident;
        }
        self.undo.push((
            key.clone(),
            self.visible.get(&key).cloned(),
            self.versions.get(&base).copied(),
        ));
        let version = self.versions.entry(base.clone()).or_insert(0);
        *version += 1;
        let ident = format!("{base}_v{version}");
        defs.insert(key.clone(), ident.clone());
        self.visible.insert(
            key,
            WorksheetBinding {
                ident: ident.clone(),
                range,
            },
        );
        ident
    }

    fn worksheet_lookup(&self, name: &Name, role: Role) -> Option<WorksheetBinding> {
        let base = mangle(name);
        let spaces: &[Space] = match (name.label, role) {
            // the reference application labels a function passed as an argument VARIABLE (`rkfixed(y, 0, 1, 10, dg)`);
            // where the name is also a unit the importer keeps the label, and the
            // label only says "not a unit": the function is found as an unlabelled value would be.
            (Some(Label::Var), Role::Value) => &[Space::Var, Space::Fn],
            (Some(Label::Var), Role::Callee) => &[Space::Var],
            (Some(Label::Fn), _) => &[Space::Fn],
            (Some(_), _) => return None,
            (None, Role::Value) => &[Space::Var, Space::Fn],
            (None, Role::Callee) => &[Space::Fn, Space::Var],
        };
        spaces
            .iter()
            .find_map(|space| self.visible.get(&(base.clone(), *space)).cloned())
    }

    fn lookup_local(&self, ident: &str) -> Option<usize> {
        self.frames
            .iter()
            .rposition(|frame| frame.locals.contains_key(ident))
    }

    fn resolve(&self, name: &Name, role: Role) -> Resolution {
        let explicit = name.label;
        // in a value position only the explicit unit label makes a unit; a plain name
        // that a unit context accepts is a
        // unit there because nothing else can be meant.
        let unit_name = (role == Role::Value
            && (explicit == Some(Label::Unit) || (self.unit_context && explicit.is_none())))
        .then(|| simple_text(name))
        .flatten()
        .filter(|text| is_unit(text));
        if self.unit_context {
            if let Some(text) = unit_name {
                return Resolution::Unit(text.to_string());
            }
            if explicit.is_none() && simple_text(name).is_some() {
                // A plain name in a unit context that is not a unit name: the slot can hold
                // nothing else.
                return Resolution::Undefined(format!("{} is not a unit", print_name(name)));
            }
        }
        let variable_like = matches!(explicit, None | Some(Label::Var) | Some(Label::Fn));
        if variable_like {
            let ident = local_ident(name);
            if let Some(frame) = self.lookup_local(&ident) {
                return Resolution::Local { ident, frame };
            }
            if let Some(binding) = self.worksheet_lookup(name, role) {
                return Resolution::Worksheet(binding);
            }
        }
        if let Some(intrinsic) = intrinsic(name) {
            return match intrinsic {
                Intrinsic::Number(code) | Intrinsic::System(code) => Resolution::Constant(code),
                Intrinsic::Physical(canonical) => Resolution::Physical(canonical),
                Intrinsic::Builtin(helper) => Resolution::Builtin(helper),
            };
        }
        // A Julia block exports nothing by itself: only an explicit `julia` label
        // reaches its names; the math writes `julia.name`.
        if explicit == Some(Label::Julia) {
            if let Some(text) = crate::julia_code::julia_text(name) {
                if self.julia_names.contains(&text) {
                    return Resolution::JuliaValue(text);
                }
                if let Some(import) = self.options.julia_imports.get(&text) {
                    return Resolution::Julia(import.clone());
                }
            }
        }
        // A unit is a labelled name: only `m@unit` still needs its unit here, and a
        // label on a name that is not in the unit table says so.
        if let Some(text) = unit_name {
            return Resolution::Unit(text.to_string());
        }
        if explicit == Some(Label::Unit) {
            let mut plain = name.clone();
            plain.label = None;
            return Resolution::Undefined(format!("{} is not a unit", print_name(&plain)));
        }
        if let Some(message) = self.options.references.undefined_message(name) {
            return Resolution::Undefined(message);
        }
        Resolution::Undefined(format!("{} is undefined", print_name(name)))
    }

    // ----------------------------------------------------------------------- diagnostics

    fn error_node(&mut self, span: Span, message: &str) -> String {
        self.diagnostics.push(Diagnostic {
            span,
            message: message.to_string(),
        });
        format!("eq_error({})", julia_string(message))
    }

    fn unsupported(&mut self, span: Span, what: &str) -> String {
        self.error_node(span, &format!("{what} is not supported yet"))
    }

    fn fresh_temp(&mut self) -> String {
        self.temp += 1;
        format!("__t{}", self.temp)
    }

    fn new_statement(&mut self, span: Span) -> i64 {
        self.next_statement += 1;
        self.statements.push(StatementLocation {
            id: self.next_statement,
            region_id: self.region_id.clone(),
            span,
        });
        self.next_statement
    }

    // ----------------------------------------------------------------------- binders

    fn capture(&mut self, ident: &str, epoch: usize) {
        for frame in epoch..self.captures.len() {
            if !self.captures[frame].iter().any(|known| known == ident) {
                self.captures[frame].push(ident.to_string());
            }
        }
    }

    fn with_binder<T>(
        &mut self,
        idents: &[String],
        body: impl FnOnce(&mut Generator) -> Result<T, CodegenError>,
    ) -> Result<T, CodegenError> {
        let epoch = self.captures.len();
        let mut frame = Frame::default();
        for ident in idents {
            frame.locals.insert(ident.clone(), epoch);
            frame.assigned.insert(ident.clone());
        }
        self.frames.push(frame);
        let result = body(self);
        self.frames.pop();
        result
    }

    // ----------------------------------------------------------------------- expressions

    /// Generates one expression. The outermost call of a statement expression opens the frame
    /// its inline definitions bind in; when one binds a name, the code is a `let`
    /// of those names, so the binding ends with the expression.
    pub fn expression(&mut self, expr: &Expr) -> Result<String, CodegenError> {
        if self.in_expression {
            return self.expression_kind(expr);
        }
        self.in_expression = true;
        self.inline_read = crate::graph::names_read_after_inline_definitions(expr)
            .iter()
            .map(local_ident)
            .collect();
        self.frames.push(Frame::default());
        let result = self.expression_kind(expr);
        let frame = self.frames.pop().unwrap_or_default();
        self.in_expression = false;
        let code = result?;
        if frame.locals.is_empty() {
            return Ok(code);
        }
        let mut idents: Vec<&String> = frame.locals.keys().collect();
        idents.sort();
        let idents: Vec<&str> = idents.into_iter().map(String::as_str).collect();
        Ok(format!("(let {}\n{}\nend)", idents.join(", "), code))
    }

    /// An inline definition `target ← value`: its value, and the names of a
    /// plain or destructuring target bound for the operands generated after it. An indexed,
    /// column or row target binds nothing.
    fn inline_definition(&mut self, target: &Target, value: &Expr) -> Result<String, CodegenError> {
        if target.has_placeholder() {
            return Ok(self.error_node(target.span, "an empty placeholder cannot be evaluated"));
        }
        if let TargetKind::FunctionHead { name, params } = &target.kind {
            // `g(i, j) ← e` as an argument defines the local function `g` of the program, as a
            // statement `g(i, j) ← e` does, and passes it: `matrix(m, n, f)` calls it for every
            // element. Outside a program there is no local to bind and the value alone is passed.
            let ident = local_ident(&name.name);
            let epoch = self.captures.len();
            let bound = if let Some(frame) = self.frames.last_mut() {
                frame.locals.insert(ident.clone(), epoch);
                frame.assigned.insert(ident.clone());
                true
            } else {
                false
            };
            let idents: Vec<String> = params.iter().map(|p| local_ident(&p.name)).collect();
            let list = idents.join(", ");
            let function = if let ExprKind::Program { body } = &value.kind {
                let lines = self.program_lines(body, params, value.span)?;
                format!("function ({list})\n{}\nend", indent(&lines.join("\n")))
            } else {
                let body = self.with_binder(&idents, |g| g.expression(value))?;
                format!("({list}) -> {body}")
            };
            return Ok(if bound {
                format!("begin {ident} = {function}; {ident} end")
            } else {
                format!("({function})")
            });
        }
        let code = self.expression(value)?;
        let mut names = Vec::new();
        target_roots(target, &mut names);
        let read = names
            .iter()
            .any(|(name, _)| self.inline_read.contains(&local_ident(name)));
        if !read || !binds_plain_names(target) {
            return Ok(code);
        }
        let temp = self.fresh_temp();
        let mut lines = vec![format!("{temp} = {code}")];
        self.bind_inline(target, temp.clone(), &mut lines);
        lines.push(temp);
        Ok(format!("begin {} end", lines.join("; ")))
    }

    fn bind_inline(&mut self, target: &Target, value: String, lines: &mut Vec<String>) {
        match &target.kind {
            TargetKind::Ident { name } => {
                let ident = local_ident(name);
                lines.push(format!("{ident} = {value}"));
                let epoch = self.captures.len();
                if let Some(frame) = self.frames.last_mut() {
                    frame.locals.insert(ident.clone(), epoch);
                    frame.assigned.insert(ident);
                }
            }
            TargetKind::Paren { target } => self.bind_inline(target, value, lines),
            TargetKind::Destructure { rows, cols, cells } => {
                let temps: Vec<String> = cells.iter().map(|_| self.fresh_temp()).collect();
                let lhs = if temps.len() == 1 {
                    format!("({},)", temps[0])
                } else {
                    temps.join(", ")
                };
                lines.push(format!("{lhs} = eq_unpack({value}, {rows}, {cols})"));
                for (cell, temp) in cells.iter().zip(temps) {
                    self.bind_inline(cell, temp, lines);
                }
            }
            _ => {}
        }
    }

    fn expression_kind(&mut self, expr: &Expr) -> Result<String, CodegenError> {
        use ExprKind as K;
        let span = expr.span;
        Ok(match &expr.kind {
            K::Num { text } => number(text),
            K::Imag { text, .. } => format!("ComplexF64(0.0, {})", number(text)),
            K::Str { text } => julia_string(text),
            K::Placeholder => self.error_node(span, "an empty placeholder cannot be evaluated"),
            // Display only: the matrix around it carries the message.
            K::EllipsisCell { .. } => self.error_node(
                span,
                "an ellipsis cell is displayed only and cannot be evaluated",
            ),
            K::Ident { name } => self.read_ident(name, span),
            K::Paren { expr } => self.expression(expr)?,
            // the value of the right side, and the target bound for the
            // operands after it.
            K::InlineDef { target, value } => self.inline_definition(target, value)?,
            K::Neg { expr } => match &expr.kind {
                K::Num { text } => format!("-{}", number(text)),
                // `-300 °C` is minus three hundred degrees, not minus 573.15 K: the sign
                // belongs to the number in front of an offset temperature unit.
                K::Mul { left, right, .. } | K::Juxt { left, right }
                    if self.is_offset_unit(right) =>
                {
                    format!(
                        "eq_mul(eq_neg({}), {})",
                        self.expression(left)?,
                        self.expression(right)?
                    )
                }
                _ => format!("eq_neg({})", self.expression(expr)?),
            },
            K::Not { expr } => format!("eq_not({})", self.expression(expr)?),
            K::Factorial { expr } => format!("eq_factorial({})", self.expression(expr)?),
            K::Transpose { expr } => format!("eq_transpose({})", self.expression(expr)?),
            // the reference application's percent is a runtime operation, never an inline division.
            K::Percent { expr } => format!("eq_percent({})", self.expression(expr)?),
            K::Permille { expr } => format!("eq_permille({})", self.expression(expr)?),
            K::Conj { expr } => format!("eq_conj({})", self.expression(expr)?),
            // The operators mean the built-ins Re and Im.
            K::RealPart { expr } => format!("eq_re({})", self.expression(expr)?),
            K::ImagPart { expr } => format!("eq_im({})", self.expression(expr)?),
            K::Abs { expr } => format!("eq_abs({})", self.expression(expr)?),
            K::Det { expr } => format!("eq_det({})", self.expression(expr)?),
            K::Norm { expr } => format!("eq_norm({})", self.expression(expr)?),
            K::Vectorize { expr } => self.vectorize(expr)?,
            K::Add { left, right, .. } => self.binary("eq_add", left, right)?,
            K::Sub { left, right, .. } => self.binary("eq_sub", left, right)?,
            K::Mul { left, right, .. } | K::Juxt { left, right } => {
                self.binary("eq_mul", left, right)?
            }
            K::InlineDiv { left, right, .. } | K::Div { left, right } => {
                self.binary("eq_div", left, right)?
            }
            K::Cross { left, right } => self.binary("eq_cross", left, right)?,
            // the reference application's convolution operators are convolve with its defaults.
            K::Conv { left, right } => self.binary("eq_convolve", left, right)?,
            // The polar form is a runtime operation.
            K::Polar { left, right } => self.binary("eq_polar", left, right)?,
            K::CircConv { left, right } => format!(
                "eq_convolve({}, {}, 1)",
                self.expression(left)?,
                self.expression(right)?
            ),
            K::Pow { left, right } => self.binary("eq_pow", left, right)?,
            K::Eq { .. }
            | K::Ne { .. }
            | K::Lt { .. }
            | K::Gt { .. }
            | K::Le { .. }
            | K::Ge { .. } => self.comparison(expr)?,
            K::In { left, right } => self.binary("eq_in", left, right)?,
            K::And { left, right } => self.lazy("eq_and", left, right)?,
            K::Or { left, right } => self.lazy("eq_or", left, right)?,
            K::Xor { left, right } => self.binary("eq_xor", left, right)?,
            K::Root { index, radicand } => match index {
                None => format!("eq_sqrt({})", self.expression(radicand)?),
                Some(index) => {
                    let radicand = self.expression(radicand)?;
                    let index = self.expression(index)?;
                    binary("eq_nthroot", radicand, index)
                }
            },
            K::Call { callee, args } => self.call_expression(callee, args, span)?,
            K::JuliaCall {
                package,
                name,
                args,
                bare,
            } => {
                if package == "julia" {
                    let args = if *bare {
                        None
                    } else {
                        Some(self.arguments(args)?)
                    };
                    self.block_name(name, args, span)
                } else {
                    // Legacy package calls still require registration.
                    let julia = format!("{package}.{name}");
                    self.error_node(span, &unregistered_julia_call(&julia))
                }
            }
            K::Index { base, indices } => {
                // A subscript may be a range: `self.range` hands it over as the
                // value `eq_range(…)` and an ordinary expression as it is.
                let mut parts = vec![self.expression(base)?];
                for index in indices {
                    parts.push(self.range(index)?);
                }
                match indices.len() {
                    1 | 2 if self.origin_hoisted > 0 => {
                        self.origin_used = true;
                        parts.push("__o".to_owned());
                        call("eq_index_o", &parts)
                    }
                    1 | 2 => call("eq_index", &parts),
                    _ => self.error_node(span, "an index needs one or two subscripts"),
                }
            }
            K::Column { base, index } => {
                let base = self.expression(base)?;
                binary("eq_col", base, self.range(index)?)
            }
            K::Row { base, index } => {
                let base = self.expression(base)?;
                binary("eq_row", base, self.range(index)?)
            }
            K::PrimeDeriv { .. } => self.unsupported(span, "a derivative with a prime"),
            K::Matrix { rows, cols, cells } => {
                if cells
                    .iter()
                    .any(|cell| matches!(cell.kind, K::EllipsisCell { .. }))
                {
                    self.error_node(span, "a matrix with an ellipsis cell cannot be evaluated")
                } else if *rows == 0 || *cols == 0 {
                    self.error_node(span, "an empty matrix cannot be evaluated")
                } else {
                    let mut parts = vec![rows.to_string(), cols.to_string()];
                    for cell in cells {
                        parts.push(self.expression(cell)?);
                    }
                    call("eq_matrix", &parts)
                }
            }
            K::Range { .. } => self.unsupported(
                span,
                "a range outside a definition, a for loop or a summation",
            ),
            K::Sum {
                var,
                index,
                bounds,
                body,
            } => self.big_operator("eq_sum", var, index, bounds, body, span)?,
            K::Prod {
                var,
                index,
                bounds,
                body,
            } => self.big_operator("eq_prod", var, index, bounds, body, span)?,
            K::Integral { var, .. } if var.name.segments.iter().all(|s| s.text.is_empty()) => {
                self.error_node(span, "an empty placeholder cannot be evaluated")
            }
            K::Integral {
                var,
                bounds: Some(bounds),
                body,
                ..
            } => self.big_operator("eq_integral", var, &None, &Some(bounds.clone()), body, span)?,
            K::Integral { bounds: None, .. } => {
                self.unsupported(span, "indefinite (symbolic) integration")
            }
            K::Deriv { var, .. } | K::Partial { var, .. } | K::Limit { var, .. }
                if var.name.segments.iter().all(|s| s.text.is_empty()) =>
            {
                self.error_node(span, "an empty placeholder cannot be evaluated")
            }
            K::Deriv { var, order, body } | K::Partial { var, order, body } => {
                self.derivative_form(var, order.as_deref(), body)?
            }
            K::Gradient { vars, .. }
                if vars
                    .iter()
                    .any(|var| var.name.segments.iter().all(|s| s.text.is_empty())) =>
            {
                self.error_node(span, "an empty placeholder cannot be evaluated")
            }
            // The column of the partial derivatives, one per variable.
            K::Gradient { vars, body } => {
                let mut parts = vec![vars.len().to_string(), "1".to_string()];
                for var in vars {
                    parts.push(self.derivative_form(var, None, body)?);
                }
                call("eq_matrix", &parts)
            }
            K::Limit { .. } => self.unsupported(span, "limits"),
            K::Program { body } => {
                let lines = self.program_lines(body, &[], span)?;
                format!("(() -> begin\n{}\nend)()", indent(&lines.join("\n")))
            }
        })
    }

    fn binary(
        &mut self,
        function: &str,
        left: &Expr,
        right: &Expr,
    ) -> Result<String, CodegenError> {
        let left = self.expression(left)?;
        let right = self.expression(right)?;
        Ok(binary(function, left, right))
    }

    fn lazy(&mut self, function: &str, left: &Expr, right: &Expr) -> Result<String, CodegenError> {
        let left = self.expression(left)?;
        let right = self.expression(right)?;
        Ok(format!("{function}({left}, () -> {right})"))
    }

    fn comparison(&mut self, expr: &Expr) -> Result<String, CodegenError> {
        let mut operations = Vec::new();
        let mut operands = Vec::new();
        let mut current = expr;
        while let Some((operation, left, right)) = comparison_parts(current) {
            operations.push(operation);
            operands.push(right);
            current = left;
        }
        operands.push(current);
        operations.reverse();
        operands.reverse();
        let mut parts = Vec::new();
        for operand in &operands {
            parts.push(self.expression(operand)?);
        }
        if operations.len() == 1 {
            Ok(call(operations[0], &parts))
        } else {
            parts.insert(0, format!("({})", operations.join(", ")));
            Ok(call("eq_chain", &parts))
        }
    }

    fn vectorize(&mut self, expr: &Expr) -> Result<String, CodegenError> {
        self.captures.push(Vec::new());
        let body = self.expression(expr);
        let captured = self.captures.pop().unwrap_or_default();
        let body = body?;
        let mut parts = vec![format!("({}) -> {body}", captured.join(", "))];
        parts.extend(captured);
        Ok(call("eq_vectorize", &parts))
    }

    fn big_operator(
        &mut self,
        helper: &str,
        var: &Ident,
        index: &Option<Box<Expr>>,
        bounds: &Option<crate::ast::Bounds>,
        body: &Expr,
        span: Span,
    ) -> Result<String, CodegenError> {
        // a free lower slot is displayed, never evaluated. A condition in the slot
        // (`i ≠ j`, `i ≤ j`, ...) says so; any other free slot states the form that would run.
        if let Some(index) = index {
            let what = if helper == "eq_sum" { "sum" } else { "product" };
            let message = if is_condition(index) {
                format!("the condition of the {what} cannot be evaluated")
            } else {
                format!("the lower limit of the {what} must be i = start or a range variable")
            };
            return Ok(self.error_node(span, &message));
        }
        if var.name.segments.iter().all(|s| s.text.is_empty()) {
            return Ok(self.error_node(span, "an empty placeholder cannot be evaluated"));
        }
        let local = local_ident(&var.name);
        let source: Vec<String> = match bounds {
            Some(bounds) => vec![self.expression(&bounds.lo)?, self.expression(&bounds.hi)?],
            None => {
                let binding = self.worksheet_lookup(&var.name, Role::Value);
                match binding {
                    Some(binding) if binding.range => vec![binding.ident],
                    _ => {
                        return Ok(self.error_node(
                            span,
                            &format!("{} is not a range variable", print_name(&var.name)),
                        ))
                    }
                }
            }
        };
        let body = self.with_binder(std::slice::from_ref(&local), |g| g.expression(body))?;
        let mut parts = vec![format!("{local} -> {body}")];
        parts.extend(source);
        Ok(call(helper, &parts))
    }

    /// Whether `expr` names an offset temperature unit, `°C` or `°F`.
    fn is_offset_unit(&self, expr: &Expr) -> bool {
        let ExprKind::Ident { name } = &expr.kind else {
            return false;
        };
        matches!(self.resolve(name, Role::Value), Resolution::Unit(unit) if unit == "°C" || unit == "°F")
    }

    fn read_ident(&mut self, name: &Name, span: Span) -> String {
        match self.resolve(name, Role::Value) {
            Resolution::Local { ident, frame } => {
                let epoch = self.frames[frame].locals[&ident];
                self.capture(&ident, epoch);
                if self.frames[frame].assigned.contains(&ident) {
                    ident
                } else if let Some(binding) = self.worksheet_lookup(name, Role::Value) {
                    // The local once assigned, the sheet value before.
                    format!("eq_local_or({ident}, {})", binding.ident)
                } else {
                    format!("eq_local({ident}, {})", julia_string(&print_name(name)))
                }
            }
            Resolution::Worksheet(binding) => {
                if binding.range && !self.used_ranges.contains(&binding.ident) {
                    self.used_ranges.push(binding.ident.clone());
                }
                self.capture(&binding.ident, 0);
                binding.ident
            }
            Resolution::Constant(code) => code.to_string(),
            Resolution::Physical(canonical) => format!("eq_constant({})", julia_string(canonical)),
            Resolution::Unit(unit) => format!("eq_unit({})", julia_string(&unit)),
            Resolution::Builtin("eq_if") => self.error_node(span, "if cannot be used as a value"),
            Resolution::Builtin(helper) => helper.to_string(),
            Resolution::Julia(import) => {
                self.error_node(span, &unregistered_julia_call(&import.function))
            }
            Resolution::JuliaValue(ident) => {
                self.region_julia = true;
                format!("from_julia({ident})")
            }
            Resolution::Undefined(message) => self.error_node(span, &message),
        }
    }

    fn note_julia_package(&mut self, package: &str) {
        self.region_julia = true;
        self.packages.insert(package.to_string());
        self.region_packages.insert(package.to_string());
    }

    fn arguments(&mut self, args: &[Arg]) -> Result<Vec<String>, CodegenError> {
        let mut out = Vec::new();
        for arg in args {
            out.push(match arg {
                // a range written as an argument is taken by `vec` only (`vec_arguments`);
                // for any other function it is an error of the region, under the expression.
                Arg::Expr { expr } if matches!(expr.kind, ExprKind::Range { .. }) => self.error_node(
                    expr.span,
                    "a range written in place is an argument of vec only; define a range variable to use it elsewhere",
                ),
                Arg::Expr { expr } => self.expression(expr)?,
                // its value, and the target bound for the later arguments.
                Arg::InlineDef { target, value, .. } => self.inline_definition(target, value)?,
            });
        }
        Ok(out)
    }

    fn julia_call(
        &mut self,
        package: &str,
        function: &str,
        args: Vec<String>,
        span: Span,
    ) -> String {
        if !valid_julia_identifier(package) || !valid_julia_identifier(function) {
            return self.error_node(span, "invalid Julia package or function name");
        }
        self.note_julia_package(package);
        let mut parts = vec![format!("{package}.{function}")];
        parts.extend(args);
        call("eq_julia_call", &parts)
    }

    /// `julia.name(args)` or a bare `julia.name`: a name that a
    /// playing Julia block above defines or imports. A call passes the arguments in order; a bare
    /// name is the Julia value, or a function of every argument for a name that only imports one.
    fn block_name(&mut self, name: &str, args: Option<Vec<String>>, span: Span) -> String {
        // `julia.X.f`: the Julia name `X.f` of a loaded module or package.
        if name.contains('.') {
            if !name.split('.').all(valid_julia_identifier) {
                return self.error_node(span, &format!("`julia.{name}` is not a valid Julia name"));
            }
            self.region_julia = true;
            return match args {
                Some(args) => {
                    let mut parts = vec![name.to_string()];
                    parts.extend(args);
                    call("eq_julia_call", &parts)
                }
                None => format!("from_julia({name})"),
            };
        }
        if let Some(import) = self.options.julia_imports.get(name).cloned() {
            self.note_julia_package(&import.package);
            let function = format!("{}.{}", import.package, import.function);
            return match args {
                Some(args) => {
                    let mut parts = vec![function];
                    parts.extend(args);
                    call("eq_julia_call", &parts)
                }
                None => format!("(__a...) -> eq_julia_call({function}, __a...)"),
            };
        }
        if !self.julia_names.contains(name) {
            return self.error_node(
                span,
                &format!("`julia.{name}` is not defined by a Julia block above"),
            );
        }
        self.region_julia = true;
        match args {
            Some(args) => {
                let mut parts = vec![name.to_string()];
                parts.extend(args);
                call("eq_julia_call", &parts)
            }
            None => format!("from_julia({name})"),
        }
    }

    fn call_expression(
        &mut self,
        callee: &Expr,
        args: &[Arg],
        span: Span,
    ) -> Result<String, CodegenError> {
        let ExprKind::Ident { name } = &callee.kind else {
            if let ExprKind::PrimeDeriv { function, order } = &callee.kind {
                return self.prime_derivative(function, *order, args, span);
            }
            let function = self.expression(callee)?;
            // A call of an element of an array: the element must
            // be a function, and the error of one that is not names the element as written
            // (`F[i] is not a function`), so `eq_call` gets that text next to the value.
            if matches!(callee.kind, ExprKind::Index { .. }) {
                let mut parts = vec![function, julia_string(&print_expression(callee))];
                parts.extend(self.arguments(args)?);
                return Ok(call("eq_call", &parts));
            }
            let args = self.arguments(args)?;
            return Ok(format!("({function})({})", args.join(", ")));
        };
        let resolution = self.resolve(name, Role::Callee);
        if simple_text(name) == Some("Jacob")
            && matches!(resolution, Resolution::Builtin("eq_jacob"))
        {
            return self.jacob_call(args, span);
        }
        if simple_text(name) == Some("root") && matches!(resolution, Resolution::Undefined(_)) {
            return self.root_call(args, span);
        }
        if self.region_solve.is_some() && matches!(resolution, Resolution::Undefined(_)) {
            if let Some(function) = simple_text(name).and_then(SolveFunction::from_name) {
                return self.solve_call(function, args, span);
            }
        }
        if self.region_solve.is_none() && matches!(resolution, Resolution::Undefined(_)) {
            if let Some(function) = simple_text(name).and_then(SolveFunction::from_name) {
                // the specification : never solve without a block.
                return Ok(self.error_node(
                    span,
                    &format!(
                        "{} needs a `Given` region above it (and the constraints between)",
                        function.display()
                    ),
                ));
            }
        }
        match resolution {
            Resolution::Local { ident, .. } => Ok(call(&ident, &self.arguments(args)?)),
            Resolution::Worksheet(binding) => Ok(call(&binding.ident, &self.arguments(args)?)),
            Resolution::Builtin(helper @ ("eq_isrange" | "eq_isfunction")) => {
                // Inspect a range variable itself instead of mapping over its elements.
                let mut inspected = match args {
                    [Arg::Expr { expr }] => Some(expr),
                    _ => None,
                };
                while let Some(Expr {
                    kind: ExprKind::Paren { expr },
                    ..
                }) = inspected
                {
                    inspected = Some(expr);
                }
                let direct_name = matches!(
                    inspected,
                    Some(Expr {
                        kind: ExprKind::Ident { .. },
                        ..
                    })
                );
                let outer_ranges = self.used_ranges.clone();
                let parts = self.arguments(args)?;
                if direct_name {
                    self.used_ranges = outer_ranges;
                }
                Ok(call(helper, &parts))
            }
            Resolution::Builtin("eq_if") => {
                if args.len() != 3 {
                    return Ok(self.error_node(span, "if needs three arguments"));
                }
                let parts = self.arguments(args)?;
                Ok(format!(
                    "eq_if({}, () -> {}, () -> {})",
                    parts[0], parts[1], parts[2]
                ))
            }
            // `vec(1..3)`: the range itself is the argument.
            Resolution::Builtin("eq_vecrange") if matches!(args, [Arg::Expr { expr }] if matches!(expr.kind, ExprKind::Range { .. })) =>
            {
                let [Arg::Expr { expr }] = args else {
                    unreachable!()
                };
                Ok(call("eq_vecrange", &[self.range(expr)?]))
            }
            Resolution::Builtin(helper) => Ok(call(helper, &self.arguments(args)?)),
            // Only registered Julia functions are called.
            Resolution::Julia(import) => {
                Ok(self.error_node(span, &unregistered_julia_call(&import.function)))
            }
            Resolution::JuliaValue(ident) => {
                Ok(self.error_node(span, &unregistered_julia_call(&ident)))
            }
            Resolution::Constant(_) | Resolution::Physical(_) | Resolution::Unit(_) => {
                Ok(self.error_node(span, &format!("{} is not a function", print_name(name))))
            }
            Resolution::Undefined(message) => {
                // A built-in that Equavela does not implement but whose replacement it
                // knows says which one to use.
                if let Some(hint) = simple_text(name).and_then(replaced_builtin) {
                    return Ok(self.error_node(span, hint));
                }
                Ok(self.error_node(span, &message))
            }
        }
    }

    /// Jacob binds its second argument while evaluating its first expression.
    fn jacob_call(&mut self, args: &[Arg], span: Span) -> Result<String, CodegenError> {
        let exprs: Vec<&Expr> = args
            .iter()
            .map(|arg| match arg {
                Arg::Expr { expr } | Arg::InlineDef { value: expr, .. } => expr,
            })
            .collect();
        if !(2..=3).contains(&exprs.len()) {
            return Ok(self.error_node(
                span,
                "Jacob takes an expression, a vector and optionally a variable count",
            ));
        }
        // A vector of names, `Jacob(F, [g; i])`: F is differentiated with
        // respect to each name at the point their values make.
        if let ExprKind::Matrix { rows, cols, cells } = &exprs[1].kind {
            let names: Option<Vec<&Name>> = cells
                .iter()
                .map(|cell| match &cell.kind {
                    ExprKind::Ident { name } => Some(name),
                    _ => None,
                })
                .collect();
            let Some(names) = names.filter(|_| *cols == 1 && *rows >= 1) else {
                return Ok(self.error_node(
                    span,
                    "Jacob: the second argument must be a variable name or a column vector of names",
                ));
            };
            let locals: Vec<String> = names.iter().map(|name| local_ident(name)).collect();
            let point = self.expression(exprs[1])?;
            let body = self.with_binder(&locals, |g| g.expression(exprs[0]))?;
            let unpack: Vec<String> = locals
                .iter()
                .enumerate()
                .map(|(i, local)| format!("{local} = __jacob_x[{}, 1]", i + 1))
                .collect();
            let mut parts = vec![
                format!("__jacob_x -> begin {}; {body} end", unpack.join("; ")),
                point,
            ];
            if exprs.len() == 3 {
                parts.push(self.expression(exprs[2])?);
            }
            return Ok(call("eq_jacob", &parts));
        }
        let ExprKind::Ident { name } = &exprs[1].kind else {
            return Ok(self.error_node(
                span,
                "Jacob: the second argument must be a variable name or a column vector of names",
            ));
        };
        let point = self.expression(exprs[1])?;
        let local = local_ident(name);
        let body = self.with_binder(std::slice::from_ref(&local), |g| g.expression(exprs[0]))?;
        let mut parts = vec![format!("{local} -> {body}"), point];
        if exprs.len() == 3 {
            parts.push(self.expression(exprs[2])?);
        }
        Ok(call("eq_jacob", &parts))
    }

    /// `root` (a worksheet that defines its own `root` shadows this form). A call named
    /// `root` is always the solver; the n-th root is the operator `√[n](x)`.
    ///
    /// - `root(f(x), x)`: `eq_root(x -> f, x_guess)`, the guess is the value of `x`.
    /// - `root(f(x), x, a, b)`: `eq_root(x -> f, a, b)`; the unknown need not be defined.
    ///
    /// The second argument must be a plain name; anything else is a structural error.
    fn root_call(&mut self, args: &[Arg], span: Span) -> Result<String, CodegenError> {
        let exprs: Vec<&Expr> = args
            .iter()
            .map(|arg| match arg {
                Arg::Expr { expr } | Arg::InlineDef { value: expr, .. } => expr,
            })
            .collect();
        let unknown = |expr: &Expr| match &expr.kind {
            ExprKind::Ident { name } => Some(name.clone()),
            _ => None,
        };
        match exprs.as_slice() {
            [function, second, rest @ ..] if rest.len() != 1 && rest.len() <= 2 => {
                match unknown(second) {
                    Some(unknown) => {
                        // guess form: the value of the unknown; interval form: a and b
                        let extra = if rest.is_empty() { &exprs[1..2] } else { rest };
                        self.solver_call(function, &unknown, extra)
                    }
                    None => Ok(self.error_node(
                        span,
                        "root: the second argument must be the unknown variable",
                    )),
                }
            }
            _ => Ok(self.error_node(
                span,
                &format!(
                    "root takes (expression, unknown) or (expression, unknown, a, b), got {} arguments",
                    exprs.len()
                ),
            )),
        }
    }

    /// `ⅆ[x^n] e` and `∂[x^n] e`: the numeric derivative of `e` in `x` at the value of
    /// `x` read outside, `eq_derivative(x -> e, x_value[, n])` (the same lambda pattern
    /// as `root`; an undefined `x` is the usual "x is undefined" error).
    fn derivative_form(
        &mut self,
        var: &Ident,
        order: Option<&Expr>,
        body: &Expr,
    ) -> Result<String, CodegenError> {
        let local = local_ident(&var.name);
        let value = self.read_ident(&var.name, var.span);
        // `ⅆ[u] y(u)` of a function the enclosing definition binds locally (the unknown functions
        // of an `odesolve` block, the reference application's way of writing `y′(u)`) differentiates the function
        // itself, which is what carries the order of the equation.
        let own = match &body.kind {
            ExprKind::Call { callee, args } => match (&callee.kind, args.as_slice()) {
                (
                    ExprKind::Ident { name },
                    [Arg::Expr {
                        expr:
                            Expr {
                                kind: ExprKind::Ident { name: argument },
                                ..
                            },
                    }],
                ) if *argument == var.name => match self.resolve(name, Role::Callee) {
                    Resolution::Local { ident, .. } => Some(ident),
                    _ => None,
                },
                _ => None,
            },
            _ => None,
        };
        let body = match own {
            Some(ident) => ident,
            None => {
                let body =
                    self.with_binder(std::slice::from_ref(&local), |g| g.expression(body))?;
                format!("{local} -> {body}")
            }
        };
        let mut parts = vec![body, value];
        if let Some(order) = order {
            parts.push(self.expression(order)?);
        }
        Ok(call("eq_derivative", &parts))
    }

    /// `f′(x)`, `f′′(x)`: `eq_derivative(f, x, order)` with `f` a worksheet function,
    /// a local function parameter or a built-in.
    fn prime_derivative(
        &mut self,
        function: &Expr,
        order: u32,
        args: &[Arg],
        span: Span,
    ) -> Result<String, CodegenError> {
        let ExprKind::Ident { name } = &function.kind else {
            return Ok(self.unsupported(span, "a derivative with a prime of this expression"));
        };
        if args.len() != 1 {
            return Ok(self.error_node(span, "a derivative with a prime needs one argument"));
        }
        let callable = match self.resolve(name, Role::Callee) {
            Resolution::Local { ident, .. } => ident,
            Resolution::Worksheet(binding) => binding.ident,
            Resolution::Builtin("eq_if") => {
                return Ok(self.error_node(span, "if cannot be differentiated"))
            }
            Resolution::Builtin(helper) => helper.to_owned(),
            Resolution::Undefined(message) => return Ok(self.error_node(span, &message)),
            _ => {
                return Ok(self.error_node(
                    span,
                    &format!("{} is not a function of one variable", print_name(name)),
                ))
            }
        };
        let argument = self.arguments(args)?.remove(0);
        Ok(call(
            "eq_derivative",
            &[callable, argument, format!("{order}.0")],
        ))
    }

    /// The solving call of a solve block:
    /// `eq_find([eq_constraint(:eq, (x, y) -> lhs, (x, y) -> rhs), ...], [x, y])`, and
    /// `eq_minimize((x, y) -> f, [constraints], [x, y])`. The lambda parameters are the
    /// unknowns in call order; the guesses are the current values of the unknowns.
    fn solve_call(
        &mut self,
        function: SolveFunction,
        args: &[Arg],
        span: Span,
    ) -> Result<String, CodegenError> {
        let exprs: Vec<&Expr> = args
            .iter()
            .map(|arg| match arg {
                Arg::Expr { expr } | Arg::InlineDef { value: expr, .. } => expr,
            })
            .collect();
        if function == SolveFunction::Odesolve {
            return self.odesolve_call(&exprs, span);
        }
        let (objective, unknown_exprs) = if function.has_objective() {
            match exprs.split_first() {
                Some((first, rest)) => (Some(*first), rest),
                None => {
                    return Ok(self.error_node(
                        span,
                        &format!("{} needs the function to optimize", function.display()),
                    ))
                }
            }
        } else {
            (None, exprs.as_slice())
        };
        let mut unknowns: Vec<Ident> = Vec::new();
        for expr in unknown_exprs {
            match &expr.kind {
                ExprKind::Ident { name } => unknowns.push(Ident {
                    name: name.clone(),
                    span: expr.span,
                }),
                _ => {
                    return Ok(self.error_node(
                        span,
                        &format!(
                            "{}: the unknowns must be plain variable names",
                            function.display()
                        ),
                    ))
                }
            }
        }
        if unknowns.is_empty() {
            return Ok(self.error_node(
                span,
                &format!("{} needs at least one unknown", function.display()),
            ));
        }
        let constraints = self.region_solve.clone().unwrap_or_default();
        let locals: Vec<String> = unknowns.iter().map(|u| local_ident(&u.name)).collect();
        let params = format!("({})", locals.join(", "));
        let mut lines = Vec::new();
        for constraint in &constraints {
            let (op, left, right) = match &constraint.kind {
                ExprKind::Eq { left, right } => ("eq", left, right),
                ExprKind::Ne { left, right } => ("ne", left, right),
                ExprKind::Lt { left, right } => ("lt", left, right),
                ExprKind::Gt { left, right } => ("gt", left, right),
                ExprKind::Le { left, right } => ("le", left, right),
                ExprKind::Ge { left, right } => ("ge", left, right),
                _ => {
                    return Ok(self.error_node(
                        constraint.span,
                        "a constraint compares two expressions with =, <, >, <=, >= or !=",
                    ))
                }
            };
            let left = self.with_binder(&locals, |g| g.expression(left))?;
            let right = self.with_binder(&locals, |g| g.expression(right))?;
            lines.push(format!(
                "eq_constraint(:{op}, {params} -> {left}, {params} -> {right})"
            ));
        }
        let guesses: Vec<String> = unknowns
            .iter()
            .map(|u| self.read_ident(&u.name, u.span))
            .collect();
        let constraints = format!("[{}]", lines.join(", "));
        let guesses = format!("[{}]", guesses.join(", "));
        match objective {
            None => Ok(call(function.helper(), &[constraints, guesses])),
            Some(objective) => {
                // `Minimize(f, x, y)` with `f` a function name calls `f(x, y)`.
                let body = match &objective.kind {
                    ExprKind::Ident { .. } => {
                        let invocation = Expr::synth(ExprKind::Call {
                            callee: Box::new(objective.clone()),
                            args: unknowns
                                .iter()
                                .map(|u| Arg::Expr {
                                    expr: Expr::synth(ExprKind::Ident {
                                        name: u.name.clone(),
                                    }),
                                })
                                .collect(),
                        });
                        self.with_binder(&locals, |g| g.expression(&invocation))?
                    }
                    _ => self.with_binder(&locals, |g| g.expression(objective))?,
                };
                Ok(call(
                    function.helper(),
                    &[format!("{params} -> {body}"), constraints, guesses],
                ))
            }
        }
    }

    /// `odesolve(y(t), b, [intvls])` and `odesolve([x(t); y(t)], b)` in a `Given` block:
    /// `eq_odesolve(equations, conditions, n, b, intvls, as_vector)`. A constraint that reads the
    /// variable of integration is a differential equation, one that does not (`y(0) = 1`,
    /// `y′(a) = 2`) is a condition. Equations become `(t, y, ...) -> lhs - rhs` and conditions
    /// `(y, ...) -> lhs - rhs`, with the unknown functions bound locally: `y(t)` is the current
    /// value and `y′(t)` the current derivative (the runtime's `OdeFunction`).
    fn odesolve_call(&mut self, exprs: &[&Expr], span: Span) -> Result<String, CodegenError> {
        if exprs.len() < 2 || exprs.len() > 3 {
            return Ok(self.error_node(
                span,
                "odesolve takes (functions, b) or (functions, b, intvls)",
            ));
        }
        let (calls, as_vector): (Vec<&Expr>, bool) = match &exprs[0].kind {
            ExprKind::Matrix { cells, .. } => (cells.iter().collect(), true),
            _ => (vec![exprs[0]], false),
        };
        let mut functions: Vec<Name> = Vec::new();
        let mut variable: Option<Name> = None;
        for call_expr in calls {
            let shape = match &call_expr.kind {
                ExprKind::Call { callee, args } => match (&callee.kind, args.as_slice()) {
                    (
                        ExprKind::Ident { name: function },
                        [Arg::Expr {
                            expr:
                                Expr {
                                    kind: ExprKind::Ident { name: argument },
                                    ..
                                },
                        }],
                    ) => Some((function.clone(), argument.clone())),
                    _ => None,
                },
                _ => None,
            };
            let Some((function, argument)) = shape else {
                return Ok(self.error_node(
                    span,
                    "odesolve: the first argument lists the unknown functions with their variable, as in y(t)",
                ));
            };
            if variable.as_ref().is_some_and(|known| *known != argument) {
                return Ok(self.error_node(
                    span,
                    "odesolve: every unknown function must depend on the same variable",
                ));
            }
            variable = Some(argument);
            functions.push(function);
        }
        let Some(variable) = variable else {
            return Ok(self.error_node(span, "odesolve needs at least one unknown function"));
        };
        let t_local = local_ident(&variable);
        let function_locals: Vec<String> = functions.iter().map(local_ident).collect();
        let constraints = self.region_solve.clone().unwrap_or_default();
        let mut equations = Vec::new();
        let mut conditions = Vec::new();
        for constraint in &constraints {
            let ExprKind::Eq { left, right } = &constraint.kind else {
                return Ok(self.error_node(
                    constraint.span,
                    "an odesolve constraint is an equation with the bold equal sign",
                ));
            };
            let is_equation = crate::graph::expr_mentions(constraint, &variable);
            let mut binder = Vec::new();
            if is_equation {
                binder.push(t_local.clone());
            }
            binder.extend(function_locals.iter().cloned());
            let lhs = self.with_binder(&binder, |g| g.expression(left))?;
            let rhs = self.with_binder(&binder, |g| g.expression(right))?;
            let line = format!("({}) -> eq_sub({lhs}, {rhs})", binder.join(", "));
            if is_equation {
                equations.push(line);
            } else {
                conditions.push(line);
            }
        }
        let endpoint = self.expression(exprs[1])?;
        let intervals = match exprs.get(2) {
            Some(expr) => self.expression(expr)?,
            None => "nothing".to_owned(),
        };
        Ok(call(
            "eq_odesolve",
            &[
                format!("[{}]", equations.join(", ")),
                format!("[{}]", conditions.join(", ")),
                functions.len().to_string(),
                endpoint,
                intervals,
                as_vector.to_string(),
            ],
        ))
    }

    /// `eq_root(unknown -> function, extra...)`.
    fn solver_call(
        &mut self,
        function: &Expr,
        unknown: &Name,
        extra: &[&Expr],
    ) -> Result<String, CodegenError> {
        let local = local_ident(unknown);
        let body = self.with_binder(std::slice::from_ref(&local), |g| g.expression(function))?;
        let mut parts = vec![format!("{local} -> {body}")];
        for expr in extra {
            parts.push(self.expression(expr)?);
        }
        Ok(call("eq_root", &parts))
    }

    // ----------------------------------------------------------------------- programs

    /// Lines of a program body: declarations, the value variable, the located body and
    /// the final `return`. Used for function definitions and for nested programs.
    fn program_lines(
        &mut self,
        body: &[Stmt],
        params: &[Ident],
        span: Span,
    ) -> Result<Vec<String>, CodegenError> {
        if body.is_empty() {
            return Err(CodegenError::new(
                "a program needs at least one statement",
                span,
            ));
        }
        let epoch = self.captures.len();
        let param_idents: Vec<String> = params.iter().map(|p| local_ident(&p.name)).collect();
        let mut scan = Scan::default();
        scan_statements(body, &mut scan);
        let mut declared = Vec::new();
        for (ident, _) in &scan.assigned {
            if !param_idents.contains(ident) && self.lookup_local(ident).is_none() {
                declared.push(ident.clone());
            }
        }
        let mut frame = Frame::default();
        for ident in &param_idents {
            frame.locals.insert(ident.clone(), epoch);
            frame.assigned.insert(ident.clone());
        }
        for ident in &declared {
            frame.locals.insert(ident.clone(), epoch);
        }
        self.frames.push(frame);
        let parameter_names: Vec<String> = params.iter().map(|p| print_name(&p.name)).collect();
        self.elided_copies
            .extend(crate::moves::elidable_copies(body, &parameter_names));
        self.origin_hoisted += 1;
        let outer_origin_used = std::mem::take(&mut self.origin_used);
        let statements = self.block(body, "a program", span);
        let origin_used = std::mem::replace(&mut self.origin_used, outer_origin_used);
        self.origin_hoisted -= 1;
        self.frames.pop();
        let statements = statements?;

        let mut lines = Vec::new();
        for ident in &declared {
            lines.push(format!("local {ident} = nothing"));
        }
        for ident in &param_idents {
            if scan.indexed.contains(ident) {
                lines.push(format!("{ident} = eq_val({ident})"));
            }
        }
        if origin_used {
            lines.push("local __o = origin()".to_string());
        }
        lines.push("local __v = nothing".to_string());
        lines.push("local __s = 0".to_string());
        lines.push("try".to_string());
        lines.push(indent(&statements.join("\n")));
        lines.push(indent("return eq_result(__v)"));
        lines.push("catch __e".to_string());
        lines.push(indent("throw(eq_locate(__e, __s))"));
        lines.push("end".to_string());
        Ok(lines)
    }

    fn block(
        &mut self,
        body: &[Stmt],
        what: &str,
        span: Span,
    ) -> Result<Vec<String>, CodegenError> {
        if body.is_empty() {
            return Err(CodegenError::new(format!("{what} has an empty body"), span));
        }
        let mut out = Vec::new();
        for statement in body {
            self.statement(statement, &mut out)?;
        }
        Ok(out)
    }

    fn frame(&mut self) -> &mut Frame {
        self.frames
            .last_mut()
            .expect("statements are generated inside a program frame")
    }

    fn assigned(&mut self) -> HashSet<String> {
        self.frame().assigned.clone()
    }

    fn set_assigned(&mut self, set: HashSet<String>) {
        self.frame().assigned = set;
    }

    /// Generates a nested body with the assigned set of `before` and returns its lines
    /// and the assigned set at its end.
    fn nested_block(
        &mut self,
        body: &[Stmt],
        before: &HashSet<String>,
        what: &str,
        span: Span,
    ) -> Result<(String, HashSet<String>), CodegenError> {
        self.set_assigned(before.clone());
        let lines = self.block(body, what, span)?;
        let after = self.assigned();
        Ok((indent(&lines.join("\n")), after))
    }

    fn statement(&mut self, stmt: &Stmt, out: &mut Vec<String>) -> Result<(), CodegenError> {
        let span = stmt.span;
        match &stmt.kind {
            StmtKind::Break | StmtKind::Continue => {
                let word = if matches!(stmt.kind, StmtKind::Break) {
                    "break"
                } else {
                    "continue"
                };
                if self.frame().loop_depth > 0 {
                    out.push(word.to_string());
                } else {
                    out.push(self.error_node(span, &format!("{word} outside a loop")));
                }
                return Ok(());
            }
            _ => {}
        }
        let id = self.new_statement(span);
        out.push(format!("__s = {id}"));
        match &stmt.kind {
            StmtKind::LocalDef { target, .. } if target.has_placeholder() => {
                out.push(self.error_node(span, "an empty placeholder cannot be evaluated"));
            }
            StmtKind::LocalDef { target, rhs }
                if matches!(target.kind, TargetKind::FunctionHead { .. }) =>
            {
                // `f(x) <- e` defines a function, not a value: the statement evaluates
                // nothing, so it leaves `__v` alone.
                return self.local_function(target, rhs, out);
            }
            StmtKind::LocalDef { target, rhs } => {
                let value = if matches!(rhs.kind, ExprKind::Range { .. }) {
                    self.unsupported(rhs.span, "a range in a local definition")
                } else {
                    let code = self.expression(rhs)?;
                    if may_alias(rhs)
                        && !self.elided_copies.contains(&(stmt as *const Stmt as usize))
                    {
                        format!("eq_val({code})")
                    } else {
                        code
                    }
                };
                self.assign_local(target, value, out, true)?;
            }
            StmtKind::If {
                branches,
                else_body,
            } => {
                let before = self.assigned();
                let also = branches
                    .iter()
                    .skip(1)
                    .any(|branch| branch.kind == BranchKind::AlsoIf);
                let mut outcomes = Vec::new();
                let mut lines = Vec::new();
                if also {
                    let flag = format!("__ran{}", self.fresh_temp().trim_start_matches("__t"));
                    out.push(format!("local {flag} = false"));
                    for branch in branches {
                        self.set_assigned(before.clone());
                        let cond = self.expression(&branch.cond)?;
                        let (body, after) =
                            self.nested_block(&branch.body, &before, "an if branch", branch.span)?;
                        outcomes.push(after);
                        lines.push(format!(
                            "if eq_true({cond})\n{}\n{body}\nend",
                            indent(&format!("{flag} = true"))
                        ));
                    }
                    out.extend(lines);
                    if let Some(else_body) = else_body {
                        let (body, after) = self.nested_block(else_body, &before, "else", span)?;
                        outcomes.push(after);
                        out.push(format!("if !{flag}\n{body}\nend"));
                    } else {
                        outcomes.push(before.clone());
                    }
                } else {
                    let mut text = String::new();
                    for (index, branch) in branches.iter().enumerate() {
                        self.set_assigned(before.clone());
                        let cond = self.expression(&branch.cond)?;
                        let (body, after) =
                            self.nested_block(&branch.body, &before, "an if branch", branch.span)?;
                        outcomes.push(after);
                        let keyword = if index == 0 { "if" } else { "elseif" };
                        text.push_str(&format!("{keyword} eq_true({cond})\n{body}\n"));
                    }
                    if let Some(else_body) = else_body {
                        let (body, after) = self.nested_block(else_body, &before, "else", span)?;
                        outcomes.push(after);
                        text.push_str(&format!("else\n{body}\n"));
                    } else {
                        outcomes.push(before.clone());
                    }
                    text.push_str("end");
                    out.push(text);
                }
                let mut merged = outcomes.pop().unwrap_or_default();
                for other in outcomes {
                    merged.retain(|ident| other.contains(ident));
                }
                self.set_assigned(merged);
            }
            StmtKind::For { var, source, body } => {
                if var.name.segments.iter().all(|s| s.text.is_empty()) {
                    out.push(self.error_node(span, "an empty placeholder cannot be evaluated"));
                    return Ok(());
                }
                let source_code = match &source.kind {
                    ExprKind::Range { .. } => self.range(source)?,
                    _ => self.expression(source)?,
                };
                let ident = local_ident(&var.name);
                let before = self.assigned();
                self.frame().loop_depth += 1;
                self.frame().assigned.insert(ident.clone());
                let result = self.block(body, "a for loop", span);
                self.frame().loop_depth -= 1;
                let lines = result?;
                self.set_assigned(before);
                out.push(format!(
                    "for __i in eq_for_items({source_code})\n{}\n{}\nend",
                    indent(&format!("{ident} = __i")),
                    indent(&lines.join("\n"))
                ));
            }
            StmtKind::While { cond, body } => {
                let before = self.assigned();
                let cond = self.expression(cond)?;
                self.frame().loop_depth += 1;
                let result = self.block(body, "a while loop", span);
                self.frame().loop_depth -= 1;
                let lines = result?;
                self.set_assigned(before);
                out.push(format!(
                    "while eq_true({cond})\n{}\nend",
                    indent(&lines.join("\n"))
                ));
            }
            StmtKind::Return { expr } => {
                let code = self.expression(expr)?;
                out.push(format!("return {code}"));
            }
            StmtKind::ExprStmt { expr } => {
                let code = self.expression(expr)?;
                out.push(format!("__v = {code}"));
            }
            StmtKind::Try { body, handler } => {
                if body.is_empty() {
                    return Err(CodegenError::new("try has an empty body", span));
                }
                if handler.is_empty() {
                    return Err(CodegenError::new("on error has an empty body", span));
                }
                let before = self.assigned();
                let thunk_form = body
                    .iter()
                    .chain(handler.iter())
                    .all(|s| matches!(s.kind, StmtKind::ExprStmt { .. }));
                if thunk_form {
                    let body = self.thunk(body)?;
                    let handler = self.thunk(handler)?;
                    out.push(format!("__v = eq_try({body}, {handler})"));
                } else {
                    let (body_text, body_after) = self.nested_block(body, &before, "try", span)?;
                    let (handler_text, handler_after) =
                        self.nested_block(handler, &before, "on error", span)?;
                    let mut merged = body_after;
                    merged.retain(|ident| handler_after.contains(ident));
                    self.set_assigned(merged);
                    out.push(format!(
                        "try\n{body_text}\ncatch __e\n{}\n{handler_text}\nend",
                        indent("eq_caught(__e)")
                    ));
                }
            }
            StmtKind::Break | StmtKind::Continue => {}
        }
        Ok(())
    }

    /// `() -> expr` for a body of expression statements (the `eq_try` form).
    fn thunk(&mut self, body: &[Stmt]) -> Result<String, CodegenError> {
        let mut codes = Vec::new();
        for statement in body {
            if let StmtKind::ExprStmt { expr } = &statement.kind {
                codes.push(self.expression(expr)?);
            }
        }
        if codes.len() == 1 {
            Ok(format!("() -> {}", codes[0]))
        } else {
            Ok(format!("() -> begin\n{}\nend", indent(&codes.join("\n"))))
        }
    }

    fn range(&mut self, expr: &Expr) -> Result<String, CodegenError> {
        let ExprKind::Range {
            first,
            second,
            last,
        } = &expr.kind
        else {
            return self.expression(expr);
        };
        let mut parts = vec![self.expression(first)?];
        if let Some(second) = second {
            parts.push(self.expression(second)?);
        }
        parts.push(self.expression(last)?);
        Ok(call("eq_range", &parts))
    }

    // ----------------------------------------------------- program assignment targets

    /// Reads the current value of a target path (for nested element assignment).
    fn read_local_target(&mut self, target: &Target) -> Result<String, CodegenError> {
        match &target.kind {
            TargetKind::Ident { name } => self.local_root(name, target.span),
            TargetKind::Paren { target } => self.read_local_target(target),
            TargetKind::Index { base, indices } => {
                let mut parts = vec![self.read_local_target(base)?];
                for index in indices {
                    parts.push(self.expression(index)?);
                }
                Ok(call("eq_index", &parts))
            }
            TargetKind::Column { base, index } => {
                let base = self.read_local_target(base)?;
                Ok(binary("eq_col", base, self.expression(index)?))
            }
            TargetKind::Row { base, index } => {
                let base = self.read_local_target(base)?;
                Ok(binary("eq_row", base, self.expression(index)?))
            }
            _ => Err(CodegenError::new("invalid assignment target", target.span)),
        }
    }

    /// The identifier of the root of a local element, column or row assignment (not wrapped
    /// in `eq_local`: `nothing` creates the array). A local that shadows a sheet name starts
    /// empty, not from the sheet array; only a read of the name before its first
    /// assignment initialises it from the sheet.
    fn local_root(&mut self, name: &Name, span: Span) -> Result<String, CodegenError> {
        let ident = local_ident(name);
        if self.lookup_local(&ident).is_none() {
            return Err(CodegenError::new(
                format!("{} is not a local of this program", print_name(name)),
                span,
            ));
        }
        Ok(ident)
    }

    fn mark_assigned(&mut self, name: &Name) {
        let ident = local_ident(name);
        if let Some(frame) = self.lookup_local(&ident) {
            self.frames[frame].assigned.insert(ident);
        }
    }

    fn emit_assignment(&self, statement: String, last: bool, out: &mut Vec<String>) {
        if last {
            out.push(format!("__v = ({statement})"));
        } else {
            out.push(statement);
        }
    }

    /// `target <- value` inside a program. `value` is Julia code that is cheap to repeat.
    fn assign_local(
        &mut self,
        target: &Target,
        value: String,
        out: &mut Vec<String>,
        last: bool,
    ) -> Result<(), CodegenError> {
        match &target.kind {
            TargetKind::Transpose { target } => {
                self.assign_local(target, format!("eq_transpose({value})"), out, last)
            }
            TargetKind::Ident { name } => {
                let ident = local_ident(name);
                if self.lookup_local(&ident).is_none() {
                    return Err(CodegenError::new(
                        format!("{} is not a local of this program", print_name(name)),
                        target.span,
                    ));
                }
                self.emit_assignment(format!("{ident} = {value}"), last, out);
                self.mark_assigned(name);
                Ok(())
            }
            TargetKind::Paren { target } => self.assign_local(target, value, out, last),
            TargetKind::Index { base, indices } => {
                let mut index_codes = Vec::new();
                for index in indices {
                    index_codes.push(self.expression(index)?);
                }
                let mut args = vec![String::new(), value];
                args.extend(index_codes);
                if self.origin_hoisted > 0 {
                    self.origin_used = true;
                    args.push("__o".to_owned());
                    self.assign_into(base, "eq_setindex_o!", args, out, last)
                } else {
                    self.assign_into(base, "eq_setindex!", args, out, last)
                }
            }
            TargetKind::Column { base, index } => {
                let index = self.expression(index)?;
                self.assign_into(
                    base,
                    "eq_setcol!",
                    vec![String::new(), value, index],
                    out,
                    last,
                )
            }
            TargetKind::Row { base, index } => {
                let index = self.expression(index)?;
                self.assign_into(
                    base,
                    "eq_setrow!",
                    vec![String::new(), value, index],
                    out,
                    last,
                )
            }
            TargetKind::Destructure { rows, cols, cells } => {
                let temps: Vec<String> = cells.iter().map(|_| self.fresh_temp()).collect();
                let lhs = if temps.len() == 1 {
                    format!("({},)", temps[0])
                } else {
                    temps.join(", ")
                };
                out.push(format!("{lhs} = eq_unpack({value}, {rows}, {cols})"));
                for (index, (cell, temp)) in cells.iter().zip(temps).enumerate() {
                    self.assign_local(cell, temp, out, last && index + 1 == cells.len())?;
                }
                Ok(())
            }
            // A function head never reaches `assign_local`: `statement` generates it with
            // `local_function`, and no other target form can hold one.
            TargetKind::FunctionHead { .. } => Err(CodegenError::new(
                "a function definition is not allowed inside a target",
                target.span,
            )),
        }
    }

    /// `f(x, y) <- e` inside a program: a local function. The name is a
    /// local of the program, declared at its top, and the body becomes a Julia closure
    /// assigned to it, so the body runs only when the function is called and sees the locals
    /// of the program. The name is marked assigned before the body is generated, so a call in
    /// the body is a call of this local and not an undefined name.
    fn local_function(
        &mut self,
        target: &Target,
        rhs: &Expr,
        out: &mut Vec<String>,
    ) -> Result<(), CodegenError> {
        let TargetKind::FunctionHead { name, params } = &target.kind else {
            return Err(CodegenError::new(
                "a local function needs a function head",
                target.span,
            ));
        };
        let ident = local_ident(&name.name);
        if self.lookup_local(&ident).is_none() {
            return Err(CodegenError::new(
                format!("{} is not a local of this program", print_name(&name.name)),
                target.span,
            ));
        }
        self.mark_assigned(&name.name);
        let idents: Vec<String> = params.iter().map(|p| local_ident(&p.name)).collect();
        let list = idents.join(", ");
        let code = if let ExprKind::Program { body } = &rhs.kind {
            // `f(x) <- program`: the body is the program, the parameters are the locals the
            // program starts with, exactly as for a worksheet `f(x) := program`.
            let lines = self.program_lines(body, params, rhs.span)?;
            format!(
                "{ident} = function ({list})\n{}\nend",
                indent(&lines.join("\n"))
            )
        } else {
            let body = self.with_binder(&idents, |g| g.expression(rhs))?;
            format!("{ident} = ({list}) -> {body}")
        };
        out.push(code);
        Ok(())
    }

    /// Assigns an element, column or row into `base`: `args[0]` is replaced by the base
    /// value; the setter is `setter(base, args[1..])`.
    fn assign_into(
        &mut self,
        base: &Target,
        setter: &str,
        mut args: Vec<String>,
        out: &mut Vec<String>,
        last: bool,
    ) -> Result<(), CodegenError> {
        match &base.kind {
            TargetKind::Paren { target } => self.assign_into(target, setter, args, out, last),
            TargetKind::Ident { name } => {
                args[0] = self.local_root(name, base.span)?;
                let new_base = call(setter, &args);
                self.assign_local(base, new_base, out, last)
            }
            _ => {
                // (x[i])[j] <- e: copy the inner element, assign into it, store it back.
                let current = self.read_local_target(base)?;
                let temp = self.fresh_temp();
                out.push(format!("{temp} = eq_val({current})"));
                args[0] = temp.clone();
                out.push(format!("{temp} = {}", call(setter, &args)));
                self.assign_local(base, temp, out, last)
            }
        }
    }

    // ----------------------------------------------------------------------- regions

    /// Generates one region. A structural error becomes an `eq_error` region (the defined
    /// names exist and fail when used), with the problem in the diagnostics.
    pub fn region(&mut self, id: &str, statement: &Statement) -> GeneratedRegion {
        self.region_id = id.to_string();
        self.region_julia = false;
        self.region_packages.clear();
        self.region_display_unit = None;
        self.region_symbolic_target = None;
        self.unit_context = false;
        self.used_ranges.clear();
        self.frames.clear();
        self.captures.clear();
        let first_diagnostic = self.diagnostics.len();
        self.undo.clear();
        let outcome = self.region_inner(statement);
        let (code, value, defined) = match outcome {
            Ok(parts) => parts,
            Err(error) => {
                self.frames.clear();
                self.captures.clear();
                while let Some((key, binding, version)) = self.undo.pop() {
                    match binding {
                        Some(binding) => self.visible.insert(key.clone(), binding),
                        None => self.visible.remove(&key),
                    };
                    match version {
                        Some(version) => self.versions.insert(key.0, version),
                        None => self.versions.remove(&key.0),
                    };
                }
                self.diagnostics.push(Diagnostic {
                    span: error.span,
                    message: error.message.clone(),
                });
                let message = julia_string(&error.message);
                let mut roots = Vec::new();
                match &statement.kind {
                    StatementKind::Define { target, .. }
                    | StatementKind::GlobalDefine { target, .. } => {
                        target_roots(target, &mut roots)
                    }
                    _ => {}
                }
                let mut defs = Defs::default();
                let mut lines = Vec::new();
                let mut defined = Vec::new();
                for (name, space) in roots {
                    let ident = self.bind_sheet(&name, space, &mut defs, false);
                    lines.push(format!("{ident} = eq_error({message})"));
                    defined.push(ident);
                }
                let value = match &statement.kind {
                    StatementKind::Evaluate { .. } | StatementKind::Symbolic { .. } => {
                        Some(format!("eq_error({message})"))
                    }
                    _ => None,
                };
                (lines.join("\n"), value, defined)
            }
        };
        GeneratedRegion {
            id: id.to_string(),
            code,
            value,
            defined,
            diagnostics: self.diagnostics[first_diagnostic..].to_vec(),
            needs_julia: self.region_julia,
            packages: self.region_packages.iter().cloned().collect(),
            display_unit: self.region_display_unit.take(),
            symbolic_target: self.region_symbolic_target.take(),
            julia_cell: matches!(statement.kind, StatementKind::Julia { .. }),
        }
    }

    fn region_inner(
        &mut self,
        statement: &Statement,
    ) -> Result<(String, Option<String>, Vec<String>), CodegenError> {
        match &statement.kind {
            StatementKind::Define { target, rhs, tail } => {
                self.define(target, rhs, tail.as_ref(), statement.span)
            }
            StatementKind::GlobalDefine { target, rhs } => {
                self.define(target, rhs, None, statement.span)
            }
            StatementKind::Evaluate { expr, unit } => {
                let value = self.evaluation(expr)?;
                if let Some(unit) = unit {
                    self.display_unit(unit)?;
                }
                Ok((String::new(), Some(value), Vec::new()))
            }
            // Symbolic regions are evaluated by the `symbolic` kernel request,
            // not by generated Julia: there is nothing to run here.
            StatementKind::Symbolic { .. } => Ok((String::new(), None, Vec::new())),
            StatementKind::ExprRegion { .. } => Ok((String::new(), None, Vec::new())),
            // A table defines through the column definitions it expands to.
            StatementKind::Table { .. } => Ok((String::new(), None, Vec::new())),
            StatementKind::Julia { block } => Ok(self.julia_region(block, statement.span)),
            StatementKind::Solve { call, .. } if crate::graph::is_given_statement(call) => {
                // A repeated `Given`.
                let message = self.error_node(
                    statement.span,
                    "a Given is already open above: close it with Find, Minerr, Minimize or Maximize before opening another",
                );
                Ok((String::new(), Some(message), Vec::new()))
            }
            StatementKind::Solve { constraints, call } => {
                let outer = self.region_solve.replace(constraints.clone());
                let result = self.region_inner(call);
                self.region_solve = outer;
                result
            }
        }
    }

    /// A `julia` region: load the packages, bind the worksheet variables the
    /// code mentions (converted with `to_julia`), run the code, and make imported and
    /// defined names callable from math. A problem in the declaration (invalid or
    /// clashing names) turns the region into an `eq_error` and exports nothing.
    fn julia_region(
        &mut self,
        block: &JuliaBlock,
        span: Span,
    ) -> (String, Option<String>, Vec<String>) {
        // A stopped block is never evaluated: it emits no
        // code, exports no name, loads no package and does not need a trusted session.
        if !block.playing {
            return (String::new(), None, Vec::new());
        }
        self.region_julia = true;
        let mut problems: Vec<String> = Vec::new();
        for package in &block.using {
            if !valid_module_path(package) {
                problems.push(format!("`{package}` is not a valid Julia package name"));
            } else {
                self.region_packages.insert(package.clone());
            }
        }
        let mut seen = HashSet::default();
        for import in &block.imports {
            if !valid_julia_identifier(&import.name) {
                problems.push(format!("`{}` is not a valid Julia name", import.name));
            }
            if !seen.insert(import.name.clone()) {
                problems.push(format!("`{}` is imported twice", import.name));
            }
            if !valid_julia_identifier(&import.package) || !valid_julia_identifier(&import.function)
            {
                problems.push(format!(
                    "`{}: {}.{}` is not a valid Julia function path",
                    import.name, import.package, import.function
                ));
            } else {
                self.region_packages.insert(import.package.clone());
            }
        }
        if !problems.is_empty() {
            for message in &problems {
                self.diagnostics.push(Diagnostic {
                    span,
                    message: message.clone(),
                });
            }
            let code = format!("eq_error({})", julia_string(&problems.join("; ")));
            return (code, None, Vec::new());
        }

        let mut lines = Vec::new();
        for package in &block.using {
            lines.push(format!("using {package}"));
        }
        let mut imported_packages = BTreeSet::new();
        for import in &block.imports {
            if imported_packages.insert(import.package.clone()) {
                lines.push(format!("import {}", import.package));
            }
        }
        let mut bound = HashSet::default();
        for token in block.mentions() {
            if RESERVED.contains(&token.as_str()) || !bound.insert(token.clone()) {
                continue;
            }
            let key = (mangle(&crate::julia_code::math_name(&token)), Space::Var);
            if let Some(binding) = self.visible.get(&key) {
                let ident = binding.ident.clone();
                self.capture(&ident, 0);
                lines.push(format!("{token} = to_julia({ident})"));
            }
        }
        if let Some(code) = &block.code {
            if !code.trim().is_empty() {
                lines.push(code.trim_end().to_string());
            }
        }

        let exports = block.exports();
        let import_names: HashSet<&str> = block
            .imports
            .iter()
            .map(|import| import.name.as_str())
            .collect();
        // The names are reached through `julia.` only: a worksheet name of the same
        // spelling stays visible.
        for name in &exports {
            if import_names.contains(name.as_str()) {
                self.julia_names.remove(name);
            } else {
                self.julia_names.insert(name.clone());
                self.options.julia_imports.remove(name);
            }
        }
        for import in &block.imports {
            self.options.julia_imports.insert(
                import.name.clone(),
                JuliaImport {
                    package: import.package.clone(),
                    function: import.function.clone(),
                },
            );
        }
        (lines.join("\n"), None, exports)
    }

    /// The displayed value of `e =`: a range variable shows its values, an
    /// expression of a range variable is evaluated for each value.
    fn evaluation(&mut self, expr: &Expr) -> Result<String, CodegenError> {
        self.used_ranges.clear();
        let code = self.expression(expr)?;
        if let ExprKind::Ident { name } = &expr.kind {
            if let Some(binding) = self.worksheet_lookup(name, Role::Value) {
                if binding.range && self.lookup_local(&local_ident(name)).is_none() {
                    return Ok(format!("eq_collect({})", binding.ident));
                }
            }
        }
        let ranges = std::mem::take(&mut self.used_ranges);
        // An index whose range variables are all whole subscripts selects their values at once
        //: `v[i]`, `M[i, j]`, `M[1, j]` are a sub-vector or a sub-matrix, as the same
        // ranges written in place, not one value per step.
        if !ranges.is_empty() && self.selects_with_ranges(expr, &ranges) {
            return Ok(code);
        }
        match ranges.as_slice() {
            [] => Ok(code),
            [range] => Ok(format!("eq_map_range({range} -> {code}, {range})")),
            _ => Ok(self.unsupported(expr.span, "an expression of several range variables")),
        }
    }

    /// Whether `expr` is an index whose subscripts include every range variable of `ranges`, each
    /// written as a whole subscript, or a `vec` call whose argument is the range variable.
    /// The generated code then hands the range values over at once (`eq_index`, `eq_vecrange`).
    fn selects_with_ranges(&self, expr: &Expr, ranges: &[String]) -> bool {
        // `vec(r)` turns the range variable itself into a vector: its argument is
        // taken whole, like a subscript.
        let whole: Vec<&Expr> = match &expr.kind {
            ExprKind::Index { indices, .. } => indices.iter().collect(),
            ExprKind::Call { callee, args } => match &callee.kind {
                ExprKind::Ident { name }
                    if matches!(
                        self.resolve(name, Role::Callee),
                        Resolution::Builtin("eq_vecrange")
                    ) =>
                {
                    args.iter()
                        .filter_map(|arg| match arg {
                            Arg::Expr { expr } => Some(expr),
                            _ => None,
                        })
                        .collect()
                }
                _ => return false,
            },
            _ => return false,
        };
        let subscripts: Vec<String> = whole
            .into_iter()
            .filter_map(|index| match &index.kind {
                ExprKind::Ident { name } => self
                    .worksheet_lookup(name, Role::Value)
                    .filter(|binding| {
                        binding.range && self.lookup_local(&local_ident(name)).is_none()
                    })
                    .map(|binding| binding.ident),
                _ => None,
            })
            .collect();
        ranges.iter().all(|range| subscripts.contains(range))
    }

    /// The unit of a unit override: generated like any expression, but a plain name is a unit.
    /// The result is stored for the region (the value is not
    /// touched).
    fn display_unit(&mut self, unit: &Expr) -> Result<(), CodegenError> {
        self.unit_context = true;
        let code = self.expression(unit);
        self.unit_context = false;
        self.used_ranges.clear();
        self.region_display_unit = Some(DisplayUnitCode {
            code: code?,
            text: print_expression(unit),
        });
        Ok(())
    }

    fn definition_value(&mut self, rhs: &Expr) -> Result<(String, bool), CodegenError> {
        match &rhs.kind {
            ExprKind::Range { .. } => Ok((self.range(rhs)?, true)),
            _ => {
                let code = self.expression(rhs)?;
                if may_alias(rhs) {
                    Ok((format!("eq_val({code})"), false))
                } else {
                    Ok((code, false))
                }
            }
        }
    }

    fn define(
        &mut self,
        target: &Target,
        rhs: &Expr,
        tail: Option<&Tail>,
        span: Span,
    ) -> Result<(String, Option<String>, Vec<String>), CodegenError> {
        if target.has_placeholder() {
            return Ok((
                self.error_node(span, "an empty placeholder cannot be evaluated"),
                None,
                Vec::new(),
            ));
        }
        let mut defs = Defs::default();
        let symbolic = matches!(tail, Some(Tail::Sym { .. }));
        let shows_value = matches!(tail, Some(Tail::Eval { .. }));

        if let TargetKind::FunctionHead { name, params } = &target.kind {
            let ident = self.bind_sheet(&name.name, Space::Fn, &mut defs, false);
            let idents: Vec<String> = params.iter().map(|p| local_ident(&p.name)).collect();
            let list = idents.join(", ");
            let code = if symbolic {
                self.region_symbolic_target = Some(SymbolicTarget {
                    ident: ident.clone(),
                    params: Some(params.iter().map(|p| p.name.clone()).collect()),
                });
                let error = symbolic_definition_error();
                format!("{ident}({list}) = {error}")
            } else if let ExprKind::JuliaCall {
                package,
                name: julia,
                bare: true,
                ..
            } = &rhs.kind
            {
                // `F(X, y) := julia.f` registers the Julia function under the worksheet name:
                // a call passes the parameters in order.
                let body = if package == "julia" {
                    self.block_name(julia, Some(idents.clone()), rhs.span)
                } else {
                    self.julia_call(package, julia, idents.clone(), rhs.span)
                };
                format!("{ident}({list}) = {body}")
            } else if let ExprKind::Program { body } = &rhs.kind {
                let lines = self.program_lines(body, params, rhs.span)?;
                format!(
                    "function {ident}({list})\n{}\nend",
                    indent(&lines.join("\n"))
                )
            } else {
                let body = self.with_binder(&idents, |g| g.expression(rhs))?;
                format!("{ident}({list}) = {body}")
            };
            return Ok((worksheet_function(&ident, &code), None, vec![ident]));
        }

        let mut roots = Vec::new();
        target_roots(target, &mut roots);
        if roots
            .iter()
            .any(|(name, _)| simple_text(name) == Some("ORIGIN"))
        {
            // ORIGIN is a worksheet setting, not a definition.
            let error = self.error_node(span, "ORIGIN is set in Calculate > Calculation Settings");
            return Ok((error, None, Vec::new()));
        }

        let mut out = Vec::new();
        let mut defined = Vec::new();
        let mut range_value = false;
        let mut shown = None;
        if symbolic {
            // Not an `eq_error` value: assigning one is itself an evaluation error, and the
            // session needs the region to succeed before it asks for the symbolic result.
            self.sheet_assign(
                target,
                "nothing".to_string(),
                &mut defs,
                &mut out,
                &mut defined,
                false,
            )?;
            if let (TargetKind::Ident { .. }, [ident]) = (&target.kind, defined.as_slice()) {
                self.region_symbolic_target = Some(SymbolicTarget {
                    ident: ident.clone(),
                    params: None,
                });
            }
        } else if let Some(iterated) = self.iterated(target) {
            // x[i] := e with a range variable i: one assignment per value of i.
            let (root, root_ident_old, index_ident, column) = iterated;
            let new = self.bind_sheet(&root, Space::Var, &mut defs, false);
            let (body, _) = self.definition_value(rhs)?;
            let helper = if column {
                "eq_iter_setcol"
            } else {
                "eq_iter_setindex"
            };
            out.push(format!(
                "{new} = {helper}(eq_val({root_ident_old}), {index_ident}, ({new}, {index_ident}) -> {body})"
            ));
            defined.push(new);
        } else {
            let (mut value, is_range) = self.definition_value(rhs)?;
            range_value = is_range;
            // `[a; b] := e =` shows the value of `e`, as `e =` would, not only its first part.
            if shows_value && !symbolic && is_destructure(target) {
                let whole = self.fresh_temp();
                out.push(format!("{whole} = {value}"));
                value = whole.clone();
                shown = Some(whole);
            }
            self.sheet_assign(target, value, &mut defs, &mut out, &mut defined, is_range)?;
        }
        if let Some(Tail::Eval { unit: Some(unit) }) = tail {
            if !symbolic {
                self.display_unit(unit)?;
            }
        }
        let value = if shown.is_some() {
            shown
        } else if shows_value && !symbolic {
            defined.first().map(|ident| {
                if range_value {
                    format!("eq_collect({ident})")
                } else {
                    ident.clone()
                }
            })
        } else {
            None
        };
        Ok((out.join("\n"), value, defined))
    }

    /// `x[i]` or `x<i>` with `i` a sheet range variable: root name, current identifier of
    /// the root (or `nothing`), the range identifier and whether it is a column.
    fn iterated(&self, target: &Target) -> Option<(Name, String, String, bool)> {
        let (base, index, column) = match &target.kind {
            TargetKind::Index { base, indices } if indices.len() == 1 => (base, &indices[0], false),
            TargetKind::Column { base, index } => (base, &**index, true),
            _ => return None,
        };
        let TargetKind::Ident { name } = &base.kind else {
            return None;
        };
        let ExprKind::Ident { name: index_name } = &index.kind else {
            return None;
        };
        let binding = self.worksheet_lookup(index_name, Role::Value)?;
        if !binding.range || self.lookup_local(&local_ident(index_name)).is_some() {
            return None;
        }
        let old = self
            .worksheet_lookup(name, Role::Value)
            .map(|b| b.ident)
            .unwrap_or_else(|| "nothing".to_string());
        Some((name.clone(), old, binding.ident, column))
    }

    // ----------------------------------------------------------- worksheet-level assignment

    fn sheet_read_target(&mut self, target: &Target, defs: &Defs) -> Result<String, CodegenError> {
        match &target.kind {
            TargetKind::Ident { name } => Ok(self.sheet_current(name, defs).0),
            TargetKind::Paren { target } => self.sheet_read_target(target, defs),
            TargetKind::Index { base, indices } => {
                let mut parts = vec![self.sheet_read_target(base, defs)?];
                for index in indices {
                    parts.push(self.expression(index)?);
                }
                Ok(call("eq_index", &parts))
            }
            TargetKind::Column { base, index } => {
                let base = self.sheet_read_target(base, defs)?;
                Ok(binary("eq_col", base, self.expression(index)?))
            }
            TargetKind::Row { base, index } => {
                let base = self.sheet_read_target(base, defs)?;
                Ok(binary("eq_row", base, self.expression(index)?))
            }
            _ => Err(CodegenError::new("invalid assignment target", target.span)),
        }
    }

    /// The identifier a name has now and whether it comes from an earlier region (so an
    /// element assignment must copy it first).
    fn sheet_current(&self, name: &Name, defs: &Defs) -> (String, bool) {
        let key = (mangle(name), Space::Var);
        if let Some(ident) = defs.get(&key) {
            return (ident.clone(), false);
        }
        match self.worksheet_lookup(name, Role::Value) {
            Some(binding) => (binding.ident, true),
            None => ("nothing".to_string(), false),
        }
    }

    fn sheet_assign(
        &mut self,
        target: &Target,
        value: String,
        defs: &mut Defs,
        out: &mut Vec<String>,
        defined: &mut Vec<String>,
        range: bool,
    ) -> Result<(), CodegenError> {
        match &target.kind {
            TargetKind::Transpose { target } => self.sheet_assign(
                target,
                format!("eq_transpose({value})"),
                defs,
                out,
                defined,
                false,
            ),
            TargetKind::Ident { name } => {
                let ident = self.bind_sheet(name, Space::Var, defs, range);
                out.push(format!("{ident} = {value}"));
                if !defined.contains(&ident) {
                    defined.push(ident);
                }
                Ok(())
            }
            TargetKind::Paren { target } => {
                self.sheet_assign(target, value, defs, out, defined, range)
            }
            TargetKind::Index { base, indices } => {
                let mut args = vec![String::new(), value];
                for index in indices {
                    args.push(self.expression(index)?);
                }
                self.sheet_assign_into(
                    base,
                    "eq_sheet_setindex!",
                    "eq_setindex!",
                    args,
                    defs,
                    out,
                    defined,
                )
            }
            TargetKind::Column { base, index } => {
                let index = self.expression(index)?;
                self.sheet_assign_into(
                    base,
                    "eq_setcol!",
                    "eq_setcol!",
                    vec![String::new(), value, index],
                    defs,
                    out,
                    defined,
                )
            }
            TargetKind::Row { base, index } => {
                let index = self.expression(index)?;
                self.sheet_assign_into(
                    base,
                    "eq_setrow!",
                    "eq_setrow!",
                    vec![String::new(), value, index],
                    defs,
                    out,
                    defined,
                )
            }
            TargetKind::Destructure { rows, cols, cells } => {
                let temps: Vec<String> = cells.iter().map(|_| self.fresh_temp()).collect();
                let lhs = if temps.len() == 1 {
                    format!("({},)", temps[0])
                } else {
                    temps.join(", ")
                };
                out.push(format!("{lhs} = eq_unpack({value}, {rows}, {cols})"));
                for (cell, temp) in cells.iter().zip(temps) {
                    self.sheet_assign(cell, temp, defs, out, defined, false)?;
                }
                Ok(())
            }
            TargetKind::FunctionHead { .. } => Err(CodegenError::new(
                "a function head is only allowed as the whole target",
                target.span,
            )),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn sheet_assign_into(
        &mut self,
        base: &Target,
        setter: &str,
        nested_setter: &str,
        mut args: Vec<String>,
        defs: &mut Defs,
        out: &mut Vec<String>,
        defined: &mut Vec<String>,
    ) -> Result<(), CodegenError> {
        match &base.kind {
            TargetKind::Paren { target } => {
                self.sheet_assign_into(target, setter, nested_setter, args, defs, out, defined)
            }
            TargetKind::Ident { name } => {
                let (current, copy) = self.sheet_current(name, defs);
                args[0] = if copy {
                    format!("eq_val({current})")
                } else {
                    current
                };
                let new_base = call(setter, &args);
                self.sheet_assign(base, new_base, defs, out, defined, false)
            }
            _ => {
                let current = self.sheet_read_target(base, defs)?;
                let temp = self.fresh_temp();
                out.push(format!("{temp} = eq_val({current})"));
                args[0] = temp.clone();
                let setter = if setter == "eq_sheet_setindex!" {
                    nested_setter
                } else {
                    setter
                };
                out.push(format!("{temp} = {}", call(setter, &args)));
                self.sheet_assign(base, temp, defs, out, defined, false)
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------------------

fn comparison_parts(expr: &Expr) -> Option<(&'static str, &Expr, &Expr)> {
    use ExprKind as K;
    Some(match &expr.kind {
        K::Eq { left, right } => ("eq_eq", left, right),
        K::Ne { left, right } => ("eq_ne", left, right),
        K::Lt { left, right } => ("eq_lt", left, right),
        K::Gt { left, right } => ("eq_gt", left, right),
        K::Le { left, right } => ("eq_le", left, right),
        K::Ge { left, right } => ("eq_ge", left, right),
        _ => return None,
    })
}

/// A condition in the lower slot of a sum or product: a comparison at the top level of the slot.
/// Such a slot is kept for display and is an evaluation error.
fn is_condition(expr: &Expr) -> bool {
    use ExprKind as K;
    matches!(
        &expr.kind,
        K::Eq { .. }
            | K::Ne { .. }
            | K::Lt { .. }
            | K::Gt { .. }
            | K::Le { .. }
            | K::Ge { .. }
            | K::In { .. }
    )
}

/// True when the value of `expr` can be (part of) an array that is also stored elsewhere:
/// a bare name, an element, a parenthesised such value or an `if` returning one. Call and
/// operator results are fresh (program contract, "x <- e").
fn may_alias(expr: &Expr) -> bool {
    match &expr.kind {
        ExprKind::Ident { .. } | ExprKind::Index { .. } => true,
        ExprKind::Paren { expr } => may_alias(expr),
        // A parenthesised local definition hands its right side through unchanged.
        ExprKind::InlineDef { value, .. } => may_alias(value),
        ExprKind::Call { callee, args } => {
            let is_if =
                matches!(&callee.kind, ExprKind::Ident { name } if simple_text(name) == Some("if"));
            is_if
                && args.iter().skip(1).any(|arg| match arg {
                    Arg::Expr { expr } => may_alias(expr),
                    Arg::InlineDef { .. } => false,
                })
        }
        _ => false,
    }
}

fn target_roots(target: &Target, out: &mut Vec<(Name, Space)>) {
    if target.has_placeholder() {
        return;
    }
    match &target.kind {
        TargetKind::Ident { name } => out.push((name.clone(), Space::Var)),
        TargetKind::FunctionHead { name, .. } => out.push((name.name.clone(), Space::Fn)),
        TargetKind::Index { base, .. }
        | TargetKind::Column { base, .. }
        | TargetKind::Row { base, .. } => target_roots(base, out),
        TargetKind::Paren { target } | TargetKind::Transpose { target } => {
            target_roots(target, out)
        }
        TargetKind::Destructure { cells, .. } => {
            for cell in cells {
                target_roots(cell, out);
            }
        }
    }
}

/// Whether `target` splits a matrix into names (`[a; b]`, also in parentheses).
fn is_destructure(target: &Target) -> bool {
    match &target.kind {
        TargetKind::Paren { target } => is_destructure(target),
        TargetKind::Destructure { .. } => true,
        _ => false,
    }
}

/// Whether every name an inline definition writes is a plain name, possibly inside a
/// destructuring matrix: only then does it bind.
fn binds_plain_names(target: &Target) -> bool {
    match &target.kind {
        TargetKind::Ident { .. } => true,
        TargetKind::Paren { target } | TargetKind::Transpose { target } => {
            binds_plain_names(target)
        }
        TargetKind::Destructure { cells, .. } => cells.iter().all(binds_plain_names),
        _ => false,
    }
}

fn scan_target(target: &Target, indexed: bool, scan: &mut Scan) {
    if target.has_placeholder() {
        return;
    }
    match &target.kind {
        TargetKind::Ident { name } => {
            let ident = local_ident(name);
            if indexed {
                scan.indexed.insert(ident.clone());
            }
            if !scan.assigned.iter().any(|(known, _)| *known == ident) {
                scan.assigned.push((ident, name.clone()));
            }
        }
        TargetKind::Index { base, .. }
        | TargetKind::Column { base, .. }
        | TargetKind::Row { base, .. } => scan_target(base, true, scan),
        TargetKind::Paren { target } | TargetKind::Transpose { target } => {
            scan_target(target, indexed, scan)
        }
        TargetKind::Destructure { cells, .. } => {
            for cell in cells {
                scan_target(cell, false, scan);
            }
        }
        TargetKind::FunctionHead { name, .. } => {
            // A local function name is a local like any other, so the program
            // declares it at the top and the closure is assigned to it.
            let ident = local_ident(&name.name);
            if !scan.assigned.iter().any(|(known, _)| *known == ident) {
                scan.assigned.push((ident, name.name.clone()));
            }
        }
    }
}

/// Names a program assigns (declared `local` at its top) and the ones it assigns into by
/// index, column or row.
fn scan_statements(body: &[Stmt], scan: &mut Scan) {
    for statement in body {
        match &statement.kind {
            StmtKind::LocalDef { target, .. } => scan_target(target, false, scan),
            StmtKind::If {
                branches,
                else_body,
            } => {
                for branch in branches {
                    scan_statements(&branch.body, scan);
                }
                if let Some(else_body) = else_body {
                    scan_statements(else_body, scan);
                }
            }
            StmtKind::For { var, body, .. } => {
                let target = Target::synth(TargetKind::Ident {
                    name: var.name.clone(),
                });
                scan_target(&target, false, scan);
                scan_statements(body, scan);
            }
            StmtKind::While { body, .. } => scan_statements(body, scan),
            StmtKind::Try { body, handler } => {
                scan_statements(body, scan);
                scan_statements(handler, scan);
            }
            StmtKind::Break
            | StmtKind::Continue
            | StmtKind::Return { .. }
            | StmtKind::ExprStmt { .. } => {}
        }
    }
}

// ---------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------

/// The Julia that defines a name by the result of its symbolic evaluation:
/// the result AST is generated like any numeric
/// expression, in a scope that holds only the function's parameters, so a name that is
/// still free in the result is an undefined name when the code runs. A result that cannot
/// be generated keeps the name an evaluation error with the reason.
pub fn symbolic_definition_code(target: &SymbolicTarget, result: &Expr) -> String {
    let mut generator = Generator::default();
    let ident = &target.ident;
    let generated = match &target.params {
        Some(params) => {
            let idents: Vec<String> = params.iter().map(local_ident).collect();
            let list = idents.join(", ");
            generator
                .with_binder(&idents, |g| g.expression(result))
                .map(|body| format!("{ident}({list}) = {body}"))
        }
        None => generator
            .definition_value(result)
            .map(|(code, _)| format!("{ident} = {code}")),
    };
    let code = generated.unwrap_or_else(|error| {
        let message = julia_string(&format!(
            "the symbolic result cannot be evaluated numerically: {}",
            error.message
        ));
        match &target.params {
            Some(params) => {
                let list = params
                    .iter()
                    .map(local_ident)
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{ident}({list}) = eq_error({message})")
            }
            None => format!("{ident} = eq_error({message})"),
        }
    });
    if target.params.is_some() {
        worksheet_function(ident, &code)
    } else {
        code
    }
}

/// Generates one expression with no worksheet names in scope (every name is a built-in,
/// a constant or undefined).
pub fn generate_expression(expr: &Expr) -> Result<String, CodegenError> {
    Generator::default().expression(expr)
}

/// Generates a unit expression in a unit context, where every plain name is a unit,
/// as for a unit override.
pub fn generate_unit(unit: &Expr) -> Result<String, CodegenError> {
    let mut generator = Generator {
        unit_context: true,
        ..Default::default()
    };
    generator.expression(unit)
}

/// Generates a worksheet: regions are ordered by the dependency graph
///  and redefinitions get new versions in that order.
pub fn generate_worksheet(
    worksheet: &Worksheet,
    options: GenOptions,
) -> Result<GeneratedWorksheet, GraphError> {
    let graph = DependencyGraph::build(worksheet)?;
    generate_worksheet_with(worksheet, &graph, options)
}

/// [`generate_worksheet`] with the dependency graph of `worksheet` already built by the caller.
pub fn generate_worksheet_with(
    worksheet: &Worksheet,
    graph: &DependencyGraph,
    options: GenOptions,
) -> Result<GeneratedWorksheet, GraphError> {
    let by_id: HashMap<&str, &crate::graph::Region> = worksheet
        .regions
        .iter()
        .map(|region| (region.id.as_str(), region))
        .collect();
    let mut generator = Generator::new(options);
    let mut regions = Vec::new();
    for id in graph.evaluation_order() {
        if let Some(region) = by_id.get(id.as_str()) {
            regions.push(generator.region(&id, &region.statement));
        }
    }
    Ok(GeneratedWorksheet {
        regions,
        statements: generator.statements.clone(),
        packages: generator.packages(),
    })
}

/// The error of a call to a Julia function that the worksheet has not registered.
fn unregistered_julia_call(name: &str) -> String {
    let short = name.rsplit('.').next().unwrap_or(name);
    format!(
        "the Julia function `{name}` is not registered on the worksheet: register it with `F(x) := julia.{short}` and call `F`"
    )
}
