# Design of experiments, Monte Carlo sampling and window functions.
# The behaviour and the tables follow the reference application's saved results
#  and the reference application's help text of montecarlo.

import Distributions
import Random

include("doe_tables.jl")

# ------------------------------------------------------------------ design matrices

"The name of factor `i` (1-based): A to Z, then A1 to Z1, A2, ... as the reference application writes them."
_factor_name(i) = i <= 26 ? string(Char('A' + i - 1)) : string(Char('A' + (i - 1) % 26), (i - 1) ÷ 26)

"A design matrix: the header row, then run number, block and the factor values of each run."
function _design(names, blocks, levels::AbstractMatrix)
    runs = size(levels, 1)
    result = Matrix{Any}(undef, runs + 1, length(names) + 2)
    result[1, 1] = "Run"
    result[1, 2] = "Block"
    for (column, name) in enumerate(names)
        result[1, column + 2] = name
    end
    for run in 1:runs
        result[run + 1, 1] = Float64(run)
        result[run + 1, 2] = Float64(blocks[run])
        for column in axes(levels, 2)
            result[run + 1, column + 2] = levels[run, column]
        end
    end
    result
end

function _positive_count(value, name)
    _is_integer_value(value) && real(value) > 0 ||
        eqerror("$name: This value must be a positive integer.")
    Int(real(value))
end

_design_char(c) = c == '-' ? -1.0 : c == '+' ? 1.0 : Float64(c - '0')

"A design stored as strings: the block, a space, one character per factor."
function _stored_design(rows::Vector{String})
    blocks = [parse(Int, split(row, ' ')[1]) for row in rows]
    codes = [split(row, ' ')[2] for row in rows]
    factors = length(first(codes))
    levels = [_design_char(codes[run][column]) for run in eachindex(codes), column in 1:factors]
    _design([_factor_name(i) for i in 1:factors], blocks, levels)
end

"The full factorial levels in Yates order (the first factor changes fastest)."
function _yates(factors, count_levels, values)
    runs = count_levels^factors
    [values[(run - 1) ÷ count_levels^(column - 1) % count_levels + 1] for run in 1:runs, column in 1:factors]
end

"`fullfact(k [, levels])`: the full factorial of k factors, ±1 for 2 levels, 0, 1, ... otherwise."
function eq_fullfact(factors, levels=2.0)
    k = _positive_count(factors, "fullfact")
    n = _positive_count(levels, "fullfact")
    values = n == 2 ? [-1.0, 1.0] : Float64.(0:(n - 1))
    _design([_factor_name(i) for i in 1:k], ones(Int, n^k), _yates(k, n, values))
end

"`fractfact(k, p)`: the 2^(k-p) fractional factorial with the reference application's generators."
function eq_fractfact(factors, fraction=0.0)
    k = _positive_count(factors, "fractfact")
    p = _positive_count(fraction, "fractfact")
    generators = get(_FRACTFACT_GENERATORS, (k, p), nothing)
    generators === nothing && eqerror("fractfact: The design parameters are not valid.")
    base = k - p
    levels = _yates(base, 2, [-1.0, 1.0])
    columns = [levels]
    for generator in generators
        word = split(generator, '=')[2]
        push!(columns, reshape([prod(levels[run, letter - 'A' + 1] for letter in word) for run in axes(levels, 1)], :, 1))
    end
    names = vcat([_factor_name(i) for i in 1:base], generators)
    _design(names, ones(Int, size(levels, 1)), hcat(columns...))
end

"`plackettburman(n)`: n runs for n - 1 factors, 8 <= n <= 48 and a multiple of 4."
function eq_plackettburman(runs)
    n = _positive_count(runs, "plackettburman")
    n % 4 == 0 || eqerror("plackettburman: The number of runs must be a multiple of 4.")
    8 <= n <= 48 ||
        eqerror("plackettburman: The number of runs must be greater than 7 and less than 49.")
    rows = if n == 28
        _PLACKETT_BURMAN_28
    else
        first = _PLACKETT_BURMAN_FIRST[n]
        m = n - 1
        # each row is the previous one shifted right by one place; the last row is all minus
        vcat([String([first[mod1(column - shift, m)] for column in 1:m]) for shift in 0:(m - 1)], ["-"^m])
    end
    _stored_design(["1 " * row for row in rows])
end

"`boxbehnken(k)`: the reference application's Box-Behnken design of 3 to 7 factors."
function eq_boxbehnken(factors)
    k = _positive_count(factors, "boxbehnken")
    k > 7 && eqerror("boxbehnken: The maximum number of factors is 7.")
    haskey(_BOX_BEHNKEN, k) || eqerror("boxbehnken: This design is not available.")
    _stored_design(_BOX_BEHNKEN[k])
end

"`taguchi(k, levels)`: the reference application's orthogonal array for k factors."
function eq_taguchi(factors, levels)
    key = (_positive_count(factors, "taguchi"), _positive_count(levels, "taguchi"))
    haskey(_TAGUCHI, key) || eqerror("taguchi: This design is not available.")
    _stored_design(_TAGUCHI[key])
end

"The checked parts of a design matrix: header names, the run rows and the factor columns."
function _design_parts(design, name)
    design isa AbstractMatrix && size(design, 1) >= 2 && size(design, 2) >= 3 &&
        design[1, 1] == "Run" && design[1, 2] == "Block" &&
        all(x -> x isa AbstractString, design[1, 3:end]) ||
        eqerror("$name: This matrix must match the DOE design matrix format.")
    String.(design[1, 3:end]), design[2:end, :]
end

"`randomize(D)`: the runs of D in a random order."
function eq_randomize(design)
    isarr(design) || eqerror("randomize: This operation can only be performed on an array.")
    _design_parts(design, "randomize")
    order = lock(_RANDOM_LOCK) do
        Random.randperm(_RANDOM[], size(design, 1) - 1)
    end
    vcat(design[1:1, :], design[1 .+ order, :])
end

"`foldover(D [, factor])`: D followed by a second block with every sign, or one factor, reversed."
function eq_foldover(design, factor...)
    isarr(design) || eqerror("foldover: This operation can only be performed on an array.")
    names, rows = _design_parts(design, "foldover")
    length(factor) <= 1 || eqerror("foldover takes at most 2 arguments")
    reversed = 1:length(names)
    if !isempty(factor)
        only(factor) isa AbstractString || eqerror("foldover: This value must be a string.")
        index = findfirst(==(only(factor)), names)
        index === nothing && eqerror("foldover: the design has no factor \"$(only(factor))\"")
        reversed = index:index
    end
    folded = copy(rows)
    runs = size(rows, 1)
    for run in 1:runs
        folded[run, 1] = Float64(runs + run)
        folded[run, 2] = rows[run, 2] + 1
        for column in reversed
            folded[run, column + 2] = -rows[run, column + 2]
        end
    end
    vcat(design[1:1, :], rows, folded)
end

"The distinct values of a column, numbers ascending, strings in order of appearance."
_levels_of(values) = all(x -> x isa Number, values) ? sort(unique(values)) : unique(values)

"`doelabel(D, L)`: names and level values for the factors of D, one row of L per factor."
function eq_doelabel(design, labels)
    isarr(design) && isarr(labels) || eqerror("doelabel: This operation can only be performed on an array.")
    names, rows = _design_parts(design, "doelabel")
    size(labels, 1) >= length(names) || eqerror("doelabel: The size of this matrix is invalid.")
    result = Matrix{Any}(copy(design))
    for (factor, _) in enumerate(names)
        column = rows[:, factor + 2]
        levels = _levels_of(column)
        size(labels, 2) - 1 >= length(levels) ||
            eqerror("doelabel: One or more level values are missing.")
        result[1, factor + 2] = labels[factor, 1] isa AbstractString ? labels[factor, 1] : string(labels[factor, 1])
        for run in axes(rows, 1)
            result[run + 1, factor + 2] = labels[factor, 1 + findfirst(==(column[run]), levels)]
        end
    end
    result
end

# ---------------------------------------------------------------------- analysis

"The responses: one value per run, the mean of the replicate columns, and the replicate count."
function _responses(responses, runs, name)
    isarr(responses) && size(responses, 1) == runs ||
        eqerror("$name: The size of this matrix is invalid.")
    values = Float64.(real.(_plain.(responses, name)))
    values, size(values, 2)
end

"The terms an analysis reports: every interaction up to `order`, or the one term named by a string."
function _terms(factors, selector, name)
    if selector isa AbstractString
        isempty(selector) && eqerror("$name: the term is empty")
        term = [letter - 'A' + 1 for letter in selector]
        all(i -> 1 <= i <= factors, term) && allunique(term) ||
            eqerror("$name: \"$selector\" is not a term of this design")
        return [term]
    end
    order = _positive_count(selector, name)
    vcat([[collect(c) for c in _combinations(factors, size)] for size in 1:min(order, factors)]...)
end

function _combinations(n, size)
    size == 0 && return [Int[]]
    result = Vector{Vector{Int}}()
    for first in 1:n, rest in _combinations(n, size - 1)
        (isempty(rest) || first < rest[1]) && push!(result, vcat(first, rest))
    end
    result
end

"""
The effect of a term at each combination of its levels: inclusion-exclusion of the cell means of
every sub-term, so a main effect is its level mean minus the grand mean and an interaction is what
the lower terms leave (the ANOVA decomposition, balanced designs). `effects` and `anova` share it
.
"""
function _term_effect(rows, values, term, levels)
    function cell_mean(subset, key)
        selected = [run for run in axes(rows, 1) if Tuple(rows[run, factor + 2] for factor in subset) == key]
        sum(values[selected, :]) / length(values[selected, :])
    end
    combos = vec(collect(Iterators.product((levels[factor] for factor in term)...)))
    combos = sort(combos; by=key -> Tuple(findfirst(==(key[i]), levels[term[i]]) for i in eachindex(key)))
    effects = map(combos) do key
        total = 0.0
        for size in 0:length(term), subset in _combinations(length(term), size)
            part = term[subset]
            total += (-1)^(length(term) - size) * cell_mean(part, Tuple(key[subset]))
        end
        total
    end
    combos, effects
end

_term_name(names, term, separator) = join(names[term], separator)

function _analysis_setup(design, responses, selector, name)
    names, rows = _design_parts(design, name)
    values, replicates = _responses(responses, size(rows, 1), name)
    levels = [_levels_of(rows[:, factor + 2]) for factor in eachindex(names)]
    names, rows, values, replicates, levels, _terms(length(names), selector, name)
end

function _effect_table(names, term, combos, effects)
    table = Matrix{Any}(undef, length(combos) + 1, length(term) + 1)
    for (column, factor) in enumerate(term)
        table[1, column] = "Level of " * names[factor]
    end
    table[1, end] = "Effect of " * _term_name(names, term, ".")
    for (row, key) in enumerate(combos)
        for column in eachindex(term)
            table[row + 1, column] = key[column]
        end
        table[row + 1, end] = effects[row]
    end
    table
end

"`effects(D, Y [, k | term])`: the effect of each factor and interaction at each level."
function eq_effects(design, responses, selector=1.0)
    names, rows, values, _, levels, terms = _analysis_setup(design, responses, selector, "effects")
    tables = map(terms) do term
        combos, effects = _term_effect(rows, values, term, levels)
        _effect_table(names, term, combos, effects)
    end
    selector isa AbstractString && return only(tables)
    result = Matrix{Any}(undef, length(terms) + 1, 2)
    result[1, 1] = "Factor"
    result[1, 2] = "Effects"
    for (row, term) in enumerate(terms)
        result[row + 1, 1] = _term_name(names, term, ".")
        result[row + 1, 2] = tables[row]
    end
    result
end

"`quickscreen(D, Y [, k | term])`: the mean response at the - and + sign of each term."
function eq_quickscreen(design, responses, selector=1.0)
    names, rows, values, _, _, terms = _analysis_setup(design, responses, selector, "quickscreen")
    all(x -> x isa Real && (x == -1 || x == 1), rows[:, 3:end]) ||
        eqerror("quickscreen: This matrix must be a 2-level coded design matrix.")
    result = Matrix{Any}(undef, length(terms) + 1, 4)
    result[1, :] = ["Factor", "(-) Avg", "(+) Avg", "(+) - (-)"]
    for (row, term) in enumerate(terms)
        sign = [prod(rows[run, factor + 2] for factor in term) for run in axes(rows, 1)]
        minus = sum(values[sign .< 0, :]) / length(values[sign .< 0, :])
        plus = sum(values[sign .> 0, :]) / length(values[sign .> 0, :])
        result[row + 1, :] = [_term_name(names, term, ""), minus, plus, plus - minus]
    end
    result
end

"`anova(D, Y [, k | term])`: the analysis of variance of a replicated design."
function eq_anova(design, responses, selector=1.0)
    names, rows, values, replicates, levels, terms = _analysis_setup(design, responses, selector, "anova")
    replicates >= 2 || eqerror("anova: At least two replicas are required to compute Anova.")
    observations = length(values)
    grand = sum(values) / observations
    total = sum(abs2, values .- grand)
    result = Matrix{Any}(undef, length(terms) + 3, 6)
    result[1, :] = ["Source", "SSE", "DF", "MSE", "F", "P"]
    sums, freedoms = Float64[], Int[]
    for term in terms
        combos, effects = _term_effect(rows, values, term, levels)
        effect_of = Dict(zip(combos, effects))
        push!(sums, replicates * sum(abs2(effect_of[Tuple(rows[run, factor + 2] for factor in term)]) for run in axes(rows, 1)))
        push!(freedoms, prod(length(levels[factor]) - 1 for factor in term))
    end
    error_sum = total - sum(sums)
    error_freedom = observations - 1 - sum(freedoms)
    error_freedom > 0 || eqerror("anova: no degrees of freedom are left for the error")
    error_mean = error_sum / error_freedom
    for (row, term) in enumerate(terms)
        mean_square = sums[row] / freedoms[row]
        F = mean_square / error_mean
        P = Distributions.ccdf(Distributions.FDist(freedoms[row], error_freedom), F)
        result[row + 1, :] = [_term_name(names, term, ""), sums[row], Float64(freedoms[row]), mean_square, F, P]
    end
    result[end - 1, :] = ["Error", error_sum, Float64(error_freedom), error_mean, NaN, NaN]
    result[end, :] = ["Total", total, Float64(observations - 1), NaN, NaN, NaN]
    result
end

# ----------------------------------------------------------------- random generators

"n draws of a standard distribution; one draw is a scalar, as in the reference application."
function _standard_draws(count, distribution, name, scale=1.0, shift=0.0)
    n = _positive_count(count, name)
    draws = lock(_RANDOM_LOCK) do
        rand(_RANDOM[], distribution, n)
    end
    values = shift .+ scale .* draws
    n == 1 ? only(values) : reshape(values, :, 1)
end

"`Normal(n)`: n draws of the standard normal distribution."
eq_Normal(count) = _standard_draws(count, Distributions.Normal(), "Normal")
"`Uniform(n)`: n draws uniform on [-6, 6], the reference application's range."
eq_Uniform(count) = _standard_draws(count, Distributions.Uniform(-6.0, 6.0), "Uniform")
"`LogNormal(n)`: n draws of the lognormal distribution with parameters 0 and 1."
eq_LogNormal(count) = _standard_draws(count, Distributions.LogNormal(0.0, 1.0), "LogNormal")
"`Weibull(n)`: n draws of the Weibull distribution of shape 1 and scale 1."
eq_Weibull(count) = _standard_draws(count, Distributions.Weibull(1.0, 1.0), "Weibull")

# -------------------------------------------------------------------------- montecarlo

_missing_limit(value) = value isa Real && isnan(value)

"""
`montecarlo(F, n, Rvals [, Limits] [, dist])`: n samples of F at random arguments, each
`mean + σ·r` with r from the variable's distribution (default `Normal`), drawn again while it is
outside its limits. The result starts with a header row: the variable names and "Output".
"""
function eq_montecarlo(F, count, rvals, optional...)
    F isa Function || eqerror("montecarlo: This value must be a function.")
    n = _positive_count(count, "montecarlo")
    isarr(rvals) || eqerror("montecarlo: This operation can only be performed on an array.")
    size(rvals, 2) == 3 || eqerror("montecarlo: This array must have 3 columns.")
    length(optional) <= 2 || eqerror("montecarlo accepts at most 5 arguments")
    variables = size(rvals, 1)
    limits = length(optional) >= 1 ? optional[1] : fill(NaN, variables, 2)
    isarr(limits) && size(limits) == (variables, 2) ||
        eqerror("montecarlo: The dimensions of these arguments do not match.")
    dists = length(optional) == 2 ? vec(optional[2]) : fill(eq_Normal, variables)
    length(dists) == variables ||
        eqerror("montecarlo: The dimensions of these arguments do not match.")
    all(d -> d isa Function, dists) || eqerror("montecarlo: This value must be a function.")
    for variable in 1:variables
        eq_lt(rvals[variable, 3], 0.0 * rvals[variable, 3]) == 1.0 &&
            eqerror("montecarlo: The standard deviation values must be non-negative.")
        lower, upper = limits[variable, 1], limits[variable, 2]
        _missing_limit(lower) || eq_lt(lower, rvals[variable, 2]) == 1.0 ||
            eqerror("montecarlo: The lower limit must be smaller than the mean value.")
        _missing_limit(upper) || eq_gt(upper, rvals[variable, 2]) == 1.0 ||
            eqerror("montecarlo: The upper limit must be greater than the mean value.")
    end
    applicable(F, rvals[:, 2]...) ||
        eqerror("montecarlo: The number of arguments is not correct.")
    function draw(variable)
        lower, upper = limits[variable, 1], limits[variable, 2]
        for _ in 1:100_000
            r = dists[variable](1.0)
            r isa AbstractMatrix && (r = first(r))
            x = eq_add(rvals[variable, 2], eq_mul(rvals[variable, 3], r))
            (_missing_limit(lower) || eq_ge(x, lower) == 1.0) &&
                (_missing_limit(upper) || eq_le(x, upper) == 1.0) && return x
        end
        eqerror("montecarlo: no value inside the limits was drawn")
    end
    result = Matrix{Any}(undef, n + 1, variables + 1)
    result[1, 1:variables] = rvals[:, 1]
    result[1, end] = "Output"
    for sample in 1:n
        arguments = [draw(variable) for variable in 1:variables]
        output = try
            F(arguments...)
        catch error
            error isa EqError || rethrow()
            eqerror("montecarlo: Failed to evaluate this function.")
        end
        result[sample + 1, 1:variables] = arguments
        result[sample + 1, end] = output
    end
    result
end

# ----------------------------------------------------------------------- windows

function _window(count, name, f)
    n = _positive_count(count, name)
    n >= 2 || eqerror("$name: the number of points must be at least 2")
    reshape([f((k - 1) / (n - 1)) for k in 1:n], :, 1)
end

"`triangular(n)`: the triangular window of n points, 0 at both ends and 1 in the middle."
eq_triangular(count) = _window(count, "triangular", t -> 1 - abs(2t - 1))
"`hamming(n)`: the symmetric Hamming window of n points."
eq_hamming(count) = _window(count, "hamming", t -> 0.54 - 0.46 * cospi(2t))
"`hanning(n)`: the symmetric Hann window of n points."
eq_hanning(count) = _window(count, "hanning", t -> 0.5 - 0.5 * cospi(2t))
"`blackman(n)`: the symmetric Blackman window of n points."
eq_blackman(count) = _window(count, "blackman", t -> 0.42 - 0.5 * cospi(2t) + 0.08 * cospi(4t))
"`gaussian(n, a)`: the Gaussian window exp(-(a·u)²/2), u from -1 to 1 over n points."
function eq_gaussian(count, width)
    a = _unitless_real(width, "gaussian")
    _window(count, "gaussian", t -> exp(-0.5 * (a * (2t - 1))^2))
end
