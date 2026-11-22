"""
    EqRuntime

Runtime support for code generated from .mcdx worksheets.
"""
module EqRuntime

using LinearAlgebra
using Unitful
using Base.ScopedValues

export DEFAULT_ORIGIN,
    EncodedValue,
    EqError,
    ORIGIN,
    OpaqueHandle,
    decode_value,
    encode_value,
    eq_abs,
    eq_unit,
    eq_is_unit,
    eq_unit_names,
    eq_constant,
    eq_constant_names,
    eq_display_unit,
    eq_norm,
    eq_nthroot,
    eq_julia_call,
    to_julia,
    from_julia,
    handle_value,
    clear_handles!,
    eq_isscalar,
    eq_isarray,
    eq_isfunction,
    eq_isrange,
    eq_siunitsof,
    eq_isstring,
    eq_Floor,
    eq_Ceil,
    eq_Round,
    eq_Trunc,
    eq_mod,
    eq_atan2,
    eq_combin,
    eq_sort,
    eq_reverse,
    eq_csort,
    eq_rsort,
    eq_mean,
    eq_median,
    eq_var,
    eq_Var,
    eq_stdev,
    eq_Stdev,
    eq_lookup,
    eq_vlookup,
    eq_hlookup,
    eq_vhlookup,
    eq_Rank,
    eq_order,
    eq_norm1,
    eq_norm2,
    eq_norme,
    eq_normi,
    eq_cond1,
    eq_cond2,
    eq_conde,
    eq_condi,
    eq_qr,
    eq_geninv,
    eq_lsolve,
    eq_gmean,
    eq_hmean,
    eq_mode,
    eq_percentile,
    eq_permut,
    eq_gcd,
    eq_lcm,
    eq_sign,
    eq_signum,
    eq_csgn,
    eq_arg,
    eq_angle,
    eq_sinh,
    eq_cosh,
    eq_tanh,
    eq_asinh,
    eq_csch,
    eq_sech,
    eq_coth,
    eq_csc,
    eq_sec,
    eq_cot,
    eq_sinc,
    eq_acosh,
    eq_atanh,
    eq_acsch,
    eq_asech,
    eq_acoth,
    eq_acsc,
    eq_asec,
    eq_acot,
    eq_ln0,
    eq_isnan,
    eq_concat,
    eq_strlen,
    eq_substr,
    eq_search,
    eq_num2str,
    eq_str2num,
    eq_vec2str,
    eq_READODS,
    eq_WRITEODS,
    eq_str2vec,
    eq_format,
    eq_Leg,
    eq_Tcheb,
    eq_Ucheb,
    eq_Her,
    eq_Lag,
    eq_δ,
    eq_Φ,
    eq_ε,
    eq_cholesky,
    eq_Cholesky,
    eq_LU,
    eq_QR,
    eq_svds,
    eq_svd,
    eq_genvals,
    eq_genvecs,
    eq_eigenvec,
    eq_kronecker,
    eq_rref,
    eq_vecrange,
    eq_logspace,
    eq_logpts,
    eq_polyroots,
    eq_polycoeff,
    eq_root,
    eq_constraint,
    eq_find,
    eq_minerr,
    eq_minimize,
    eq_maximize,
    TOL,
    CTOL,
    eq_linterp,
    eq_lspline,
    eq_pspline,
    eq_cspline,
    eq_interp,
    eq_cvar,
    eq_covar,
    eq_corr,
    eq_Ftest,
    eq_Spear,
    eq_kendltau,
    eq_kendltau2,
    eq_contingtbl,
    eq_skew,
    eq_kurt,
    eq_rnorm,
    eq_rnd,
    eq_Seed,
    eq_dbeta,
    eq_pbeta,
    eq_qbeta,
    eq_rbeta,
    eq_dbinom,
    eq_pbinom,
    eq_qbinom,
    eq_rbinom,
    eq_dcauchy,
    eq_pcauchy,
    eq_qcauchy,
    eq_rcauchy,
    eq_dchisq,
    eq_pchisq,
    eq_qchisq,
    eq_rchisq,
    eq_dexp,
    eq_pexp,
    eq_qexp,
    eq_rexp,
    eq_dF,
    eq_pF,
    eq_qF,
    eq_rF,
    eq_dgamma,
    eq_pgamma,
    eq_qgamma,
    eq_rgamma,
    eq_dgeom,
    eq_pgeom,
    eq_qgeom,
    eq_rgeom,
    eq_dhypergeom,
    eq_phypergeom,
    eq_qhypergeom,
    eq_rhypergeom,
    eq_dlnorm,
    eq_plnorm,
    eq_qlnorm,
    eq_rlnorm,
    eq_dlogis,
    eq_plogis,
    eq_qlogis,
    eq_rlogis,
    eq_dnbinom,
    eq_pnbinom,
    eq_qnbinom,
    eq_rnbinom,
    eq_dnorm,
    eq_pnorm,
    eq_qnorm,
    eq_dpois,
    eq_ppois,
    eq_qpois,
    eq_rpois,
    eq_dt,
    eq_pt,
    eq_qt,
    eq_rt,
    eq_dunif,
    eq_punif,
    eq_qunif,
    eq_runif,
    eq_dweibull,
    eq_pweibull,
    eq_qweibull,
    eq_rweibull,
    eq_cnorm,
    eq_convolve,
    eq_crosscorr,
    eq_deconvolve,
    eq_result,
    eq_for_items,
    eq_try,
    eq_caught,
    eq_error,
    eq_local,
    eq_local_or,
    eq_locate,
    eq_sheet_setindex!,
    eq_range,
    eq_collect,
    eq_map_range,
    eq_iter_setindex,
    eq_iter_setcol,
    eq_sum,
    eq_prod,
    eq_factorial,
    EqRange,
    eq_rows,
    eq_cols,
    eq_length,
    eq_last,
    eq_stack,
    eq_augment,
    eq_submatrix,
    eq_tr,
    eq_vsum,
    eq_rank,
    eq_eigenvals,
    eq_eigenvecs,
    eq_match,
    eq_max,
    eq_min,
    eq_floor,
    eq_ceil,
    eq_trunc,
    eq_round,
    eq_re,
    eq_im,
    eq_sqrt,
    eq_exp,
    eq_ln,
    eq_log,
    eq_sin,
    eq_cos,
    eq_tan,
    eq_asin,
    eq_acos,
    eq_atan,
    eq_add,
    eq_and,
    eq_col,
    eq_chain,
    eq_conj,
    eq_cross,
    eq_det,
    eq_diag,
    eq_div,
    eq_dot,
    eq_eq,
    eq_ge,
    eq_gt,
    eq_identity,
    eq_matrix_fn,
    eq_if,
    eq_in,
    eq_index,
    eq_call,
    eq_inv,
    eq_le,
    eq_lt,
    eq_matrix,
    eq_mul,
    eq_ne,
    eq_neg,
    eq_percent,
    eq_permille,
    eq_polar,
    eq_not,
    eq_or,
    eq_pow,
    eq_row,
    eq_rowvec,
    eq_setcol!,
    eq_setindex!,
    eq_setrow!,
    eq_sub,
    eq_transpose,
    eq_xor,
    eq_true,
    eq_unpack,
    eq_val,
    eq_vec,
    eq_vectorize,
    narrow,
    eq_derivative,
    eq_jacob,
    eq_dft,
    eq_idft,
    eq_dftr,
    eq_idftr,
    eq_cfft,
    eq_icfft,
    eq_cpt,
    eq_Bspline,
    eq_wave,
    eq_iwave,
    eq_J0,
    eq_J1,
    eq_Jn,
    eq_Y0,
    eq_Y1,
    eq_Yn,
    eq_I0,
    eq_I1,
    eq_In,
    eq_K0,
    eq_K1,
    eq_Kn,
    eq_H1,
    eq_H2,
    eq_Ai,
    eq_DAi,
    eq_Bi,
    eq_DBi,
    eq_ber,
    eq_bei,
    eq_js,
    eq_ys,
    eq_erf,
    eq_erfc,
    eq_Γ,
    eq_lnΓ,
    eq_Psi,
    eq_fhyper,
    eq_mhyper,
    eq_ibeta,
    eq_Jac,
    eq_READFILE,
    eq_WRITEFILE,
    eq_READTEXT,
    eq_WRITETEXT,
    eq_READBIN,
    eq_WRITEBIN,
    eq_READCSV,
    eq_WRITECSV,
    eq_READPRN,
    eq_WRITEPRN,
    eq_APPENDPRN,
    eq_WRITEEXCEL,
    eq_READ_IMAGE,
    eq_READBMP,
    eq_WRITEBMP,
    eq_READRGB,
    eq_WRITERGB,
    eq_READ_RED,
    eq_READ_GREEN,
    eq_READ_BLUE,
    eq_READ_HLS,
    eq_WRITE_HLS,
    eq_READ_HSV,
    eq_WRITE_HSV,
    eq_READ_HLS_SAT,
    eq_READ_HSV_SAT,
    eq_READ_LIGHT,
    eq_READ_VALUE,
    eq_READ_HUE,
    eq_READWAV,
    eq_WRITEWAV,
    eq_GETWAVINFO,
    eq_J0_sc,
    eq_J1_sc,
    eq_Jn_sc,
    eq_Y0_sc,
    eq_Y1_sc,
    eq_Yn_sc,
    eq_I0_sc,
    eq_I1_sc,
    eq_In_sc,
    eq_K0_sc,
    eq_K1_sc,
    eq_Kn_sc,
    eq_H1_sc,
    eq_H2_sc,
    eq_Ai_sc,
    eq_DAi_sc,
    eq_Bi_sc,
    eq_DBi_sc,
    eq_hist,
    eq_histogram,
    eq_boxplot,
    eq_boxplotgraph,
    eq_pareto,
    eq_fullfact,
    eq_fractfact,
    eq_plackettburman,
    eq_boxbehnken,
    eq_taguchi,
    eq_randomize,
    eq_foldover,
    eq_doelabel,
    eq_effects,
    eq_quickscreen,
    eq_anova,
    eq_Normal,
    eq_Uniform,
    eq_LogNormal,
    eq_Weibull,
    eq_montecarlo,
    eq_triangular,
    eq_hamming,
    eq_hanning,
    eq_blackman,
    eq_gaussian,
    eq_qqplot,
    eq_Grubbs,
    eq_GrubbsClassic,
    eq_ThreeSigma,
    eq_trim,
    eq_markNaN,
    eq_matchNaN,
    eq_filterNaN,
    eq_Nipals,
    eq_Nipals2,
    eq_scores,
    eq_loadings,
    eq_PCAeigenvals,
    eq_PCAvariance,
    eq_localmax,
    eq_localmin,
    eq_supsmooth,
    eq_ksmooth,
    eq_medsmooth,
    eq_VSmooth,
    eq_expsmooth,
    eq_movavg,
    eq_rkfixed,
    eq_Rkadapt,
    eq_Bulstoer,
    eq_Adams,
    eq_BDF,
    eq_Radau,
    eq_Stiffb,
    eq_Stiffr,
    eq_AdamsBDF,
    eq_statespace,
    eq_sbval,
    eq_bvalfit,
    eq_numol,
    eq_relax,
    eq_multigrid,
    eq_index_o,
    eq_setindex_o!,
    eq_odesolve,
    eq_bspline,
    eq_loess,
    eq_Spline2,
    eq_Binterp,
    eq_DWS,
    eq_Bicubic2D,
    eq_predict,
    eq_polyint,
    eq_polyiter,
    eq_rationalint,
    eq_Thielecoeff,
    eq_Thiele,
    eq_line,
    eq_slope,
    eq_intercept,
    eq_stderr,
    eq_medfit,
    eq_rationalfit,
    eq_rationalfitnp,
    eq_polyfit,
    eq_polyfitc,
    eq_polyfitstat,
    eq_genfit,
    eq_expfit,
    eq_lnfit,
    eq_logfit,
    eq_lgsfit,
    eq_pwrfit,
    eq_sinfit,
    eq_LeastSquaresFit,
    eq_confidence,
    eq_linfit,
    eq_multidfit,
    eq_integral,
    origin,
    ctol,
    tol,
    exact_boolean,
    with_ctol,
    with_exact_boolean,
    with_origin,
    with_base_dir,
    with_tol

"Default the reference application array origin (ORIGIN)."
const DEFAULT_ORIGIN = 0

"""
    eq_index(origin::Integer, i::Integer)

Convert a reference application index `i` (given `origin`) to a Julia 1-based index.
"""
eq_index(origin::Integer, i::Integer) = i - origin + 1

"A session-local reference to a Julia value that has no worksheet representation."
struct OpaqueHandle
    id::String
    julia_type::String
    summary::String
end

"A typed value and the binary frame entries referenced by its JSON-compatible node."
struct EncodedValue
    value::Dict{String,Any}
    descriptors::Vector{Dict{String,Any}}
    payloads::Vector{Vector{UInt8}}
end

const BINARY_MATRIX_ELEMENT_THRESHOLD = 256

const _DIMENSION_NAMES = Dict(
    :Length => "length",
    :Mass => "mass",
    :Time => "time",
    :Current => "current",
    :Temperature => "temperature",
    :Amount => "amount",
    :Luminosity => "luminosity",
)

const _DIMENSION_ORDER = Dict(
    "length" => 1,
    "mass" => 2,
    "time" => 3,
    "current" => 4,
    "temperature" => 5,
    "amount" => 6,
    "luminosity" => 7,
)

const _BASE_UNITS = Dict(
    "length" => u"m",
    "mass" => u"kg",
    "time" => u"s",
    "current" => u"A",
    "temperature" => u"K",
    "amount" => u"mol",
    "luminosity" => u"cd",
)

"""
    encode_value(value; binary_threshold=256)

Convert a Julia value to the typed kernel-value schema. Matrix iteration is
column-major. Uniform `Float64` and `ComplexF64` matrices at or above the
threshold are emitted as little-endian binary frame entries.
"""
function encode_value(value; binary_threshold::Integer=BINARY_MATRIX_ELEMENT_THRESHOLD)
    binary_threshold > 0 || throw(ArgumentError("binary_threshold must be positive"))
    descriptors = Dict{String,Any}[]
    payloads = Vector{UInt8}[]
    node = _encode_value(value, descriptors, payloads, Int(binary_threshold))
    EncodedValue(node, descriptors, payloads)
end

_wire_float(value::Real) = if isnan(value)
    "nan"
elseif value == Inf
    "infinity"
elseif value == -Inf
    "-infinity"
else
    Float64(value)
end

function _encode_value(value, descriptors, payloads, threshold)
    if value isa Bool
        return Dict{String,Any}("type" => "real", "value" => (value ? 1.0 : 0.0))
    elseif value isa Unitful.AbstractQuantity
        return _encode_quantity(value, descriptors, payloads, threshold)
    elseif value isa Real
        return Dict{String,Any}("type" => "real", "value" => _wire_float(value))
    elseif value isa Complex
        return Dict{String,Any}(
            "type" => "complex",
            "real" => _wire_float(real(value)),
            "imag" => _wire_float(imag(value)),
        )
    elseif value isa AbstractString
        return Dict{String,Any}("type" => "string", "value" => String(value))
    elseif value isa AbstractVector
        return _encode_value(reshape(collect(value), :, 1), descriptors, payloads, threshold)
    elseif value isa AbstractMatrix
        return _encode_matrix(value, descriptors, payloads, threshold)
    elseif value isa OpaqueHandle
        isempty(value.id) && throw(ArgumentError("opaque handle id cannot be empty"))
        isempty(value.julia_type) &&
            throw(ArgumentError("opaque handle Julia type cannot be empty"))
        return Dict{String,Any}(
            "type" => "handle",
            "id" => value.id,
            "julia_type" => value.julia_type,
            "summary" => value.summary,
        )
    elseif value === nothing
        throw(ArgumentError("nothing has no worksheet value representation"))
    end
    throw(ArgumentError("unsupported Julia value type $(typeof(value))"))
end

function _encode_quantity(value, descriptors, payloads, threshold)
    preferred = upreferred(value)
    components = _dimension_components(dimension(preferred))
    magnitude = ustrip(preferred)
    isempty(components) &&
        return _encode_value(magnitude, descriptors, payloads, threshold)
    magnitude_node = if magnitude isa Real
        Dict{String,Any}("type" => "real", "value" => _wire_float(magnitude))
    elseif magnitude isa Complex
        Dict{String,Any}(
            "type" => "complex",
            "real" => _wire_float(real(magnitude)),
            "imag" => _wire_float(imag(magnitude)),
        )
    else
        throw(ArgumentError("quantity magnitude must be real or complex"))
    end
    Dict{String,Any}(
        "type" => "quantity", "magnitude" => magnitude_node, "dimension" => components
    )
end

function _dimension_components(dimensions)
    result = Dict{String,Any}[]
    for component in typeof(dimensions).parameters[1]
        symbol = typeof(component).parameters[1]
        name = get(_DIMENSION_NAMES, symbol, nothing)
        name === nothing && throw(ArgumentError("unsupported Unitful dimension $symbol"))
        power = component.power
        push!(
            result,
            Dict{String,Any}(
                "base" => name,
                "power" => [Int(numerator(power)), Int(denominator(power))],
            ),
        )
    end
    sort!(result; by=component -> _DIMENSION_ORDER[component["base"]])
end

function _encode_matrix(value, descriptors, payloads, threshold)
    rows, cols = size(value)
    if !isempty(value) && length(value) >= threshold && eltype(value) === Float64
        return _encode_binary_matrix(value, rows, cols, "f64le", descriptors, payloads)
    elseif !isempty(value) && length(value) >= threshold && eltype(value) === ComplexF64
        return _encode_binary_matrix(value, rows, cols, "c128le", descriptors, payloads)
    end
    values = Dict{String,Any}[
        _encode_value(element, descriptors, payloads, threshold) for element in vec(value)
    ]
    Dict{String,Any}(
        "type" => "matrix",
        "rows" => rows,
        "cols" => cols,
        "storage" => Dict{String,Any}("type" => "inline", "values" => values),
    )
end

function _encode_binary_matrix(value, rows, cols, dtype, descriptors, payloads)
    payload = UInt8[]
    sizehint!(payload, length(value) * (dtype == "f64le" ? 8 : 16))
    for element in value
        _append_f64le!(payload, real(element))
        dtype == "c128le" && _append_f64le!(payload, imag(element))
    end
    index = length(descriptors)
    push!(
        descriptors,
        Dict{String,Any}(
            "bytes" => length(payload),
            "dtype" => dtype,
            "shape" => [rows, cols],
            "order" => "column-major",
        ),
    )
    push!(payloads, payload)
    Dict{String,Any}(
        "type" => "matrix",
        "rows" => rows,
        "cols" => cols,
        "storage" => Dict{String,Any}(
            "type" => "binary", "index" => index, "dtype" => dtype
        ),
    )
end

function _append_f64le!(payload, value)
    bits = reinterpret(UInt64, Float64(value))
    for shift in 0:8:56
        push!(payload, UInt8((bits >> shift) & 0xff))
    end
    payload
end

"Decode an `EncodedValue` back to the corresponding Julia value."
decode_value(encoded::EncodedValue) =
    _decode_value(encoded.value, encoded.descriptors, encoded.payloads)

function _decode_value(node, descriptors, payloads)
    value_type = String(node["type"])
    if value_type == "real"
        return _decode_float(node["value"])
    elseif value_type == "complex"
        return complex(_decode_float(node["real"]), _decode_float(node["imag"]))
    elseif value_type == "string"
        return String(node["value"])
    elseif value_type == "quantity"
        magnitude = _decode_value(node["magnitude"], descriptors, payloads)
        units = Unitful.NoUnits
        for component in node["dimension"]
            name = String(component["base"])
            haskey(_BASE_UNITS, name) ||
                throw(ArgumentError("unsupported kernel dimension $name"))
            numerator_value = Int(component["power"][1])
            denominator_value = Int(component["power"][2])
            denominator_value > 0 || throw(ArgumentError("invalid dimension denominator"))
            units *= _BASE_UNITS[name]^(numerator_value // denominator_value)
        end
        return magnitude * units
    elseif value_type == "matrix"
        return _decode_matrix(node, descriptors, payloads)
    elseif value_type == "handle"
        return OpaqueHandle(
            String(node["id"]), String(node["julia_type"]), String(node["summary"])
        )
    end
    throw(ArgumentError("unknown kernel value type $value_type"))
end

function _decode_float(value)
    value isa Number && return Float64(value)
    value == "nan" && return NaN
    value == "infinity" && return Inf
    value == "-infinity" && return -Inf
    throw(ArgumentError("invalid wire float $value"))
end

function _decode_matrix(node, descriptors, payloads)
    rows = Int(node["rows"])
    cols = Int(node["cols"])
    storage = node["storage"]
    values = if String(storage["type"]) == "inline"
        Any[
            _decode_value(value, descriptors, payloads) for value in vec(storage["values"])
        ]
    elseif String(storage["type"]) == "binary"
        _decode_binary_matrix(node, storage, descriptors, payloads)
    else
        throw(ArgumentError("unknown matrix storage type $(storage["type"])"))
    end
    length(values) == rows * cols || throw(ArgumentError("matrix element count mismatch"))
    reshape(_narrow_values(values), rows, cols)
end

function _decode_binary_matrix(node, storage, descriptors, payloads)
    index = Int(storage["index"]) + 1
    1 <= index <= length(descriptors) || throw(ArgumentError("binary index is out of range"))
    index <= length(payloads) || throw(ArgumentError("binary payload is missing"))
    descriptor = descriptors[index]
    dtype = String(storage["dtype"])
    String(descriptor["dtype"]) == dtype || throw(ArgumentError("binary dtype mismatch"))
    Int.(descriptor["shape"]) == [Int(node["rows"]), Int(node["cols"])] ||
        throw(ArgumentError("binary shape mismatch"))
    String(descriptor["order"]) == "column-major" ||
        throw(ArgumentError("binary matrix is not column-major"))
    payload = payloads[index]
    Int(descriptor["bytes"]) == length(payload) ||
        throw(ArgumentError("binary byte count mismatch"))
    width = dtype == "f64le" ? 8 : dtype == "c128le" ? 16 : 0
    width > 0 || throw(ArgumentError("unsupported matrix dtype $dtype"))
    length(payload) % width == 0 || throw(ArgumentError("truncated binary matrix"))
    if dtype == "f64le"
        return Float64[_read_f64le(payload, offset) for offset in 1:8:length(payload)]
    end
    ComplexF64[
        complex(_read_f64le(payload, offset), _read_f64le(payload, offset + 8)) for
        offset in 1:16:length(payload)
    ]
end

function _read_f64le(payload, offset)
    bits = zero(UInt64)
    for byte_index in 0:7
        bits |= UInt64(payload[offset + byte_index]) << (8 * byte_index)
    end
    reinterpret(Float64, bits)
end

_narrow_values(values::Vector) = values

function _narrow_values(values::Vector{Any})
    isempty(values) && return values
    target = typeof(first(values))
    all(value -> typeof(value) === target, values) || return values
    try
        return target[value for value in values]
    catch
        return values
    end
end

include("semantics.jl")
include("units.jl")
include("constants.jl")
include("builtins.jl")
include("builtins2.jl")
include("builtins3.jl")
include("builtins4.jl")
include("special_functions.jl")
include("fourier.jl")
include("ranges.jl")
include("type_functions.jl")
include("builtins5.jl")
include("builtins6.jl")
include("random.jl")
include("doe.jl")
include("distributions.jl")
include("statistical_tests.jl")
include("graphical_statistics.jl")
include("data_analysis.jl")
include("smoothing.jl")
include("interpolation.jl")
include("regression.jl")
include("ode.jl")
include("ods.jl")
include("file_access.jl")
include("ods_write.jl")
include("solve.jl")
include("solveblock.jl")
include("calculus.jl")
include("programs.jl")
include("fastpaths.jl")
include("interop.jl")
include("precompile.jl")

end # module
