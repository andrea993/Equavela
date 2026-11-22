# Regression and curve fitting: straight-line statistics, polynomial
# regression, linear and nonlinear least squares (Levenberg-Marquardt), the named model fits
# and rational fits. the reference application does not publish its optimizer, so results of the nonlinear fits
# agree with the reference application's up to the fit tolerance, not bit for bit (algorithm-dependent).

# ------------------------------------------------------------------- helpers

function _fit_pair(vx, vy, name; minimum=2)
    xs, ys = _real_column(vx, name), _real_column(vy, name)
    length(xs) == length(ys) || eqerror("$name: vx and vy must have the same length")
    length(xs) >= minimum || eqerror("$name needs at least $minimum points")
    all(isfinite, xs) && all(isfinite, ys) || eqerror("$name needs finite values")
    xs, ys
end

function _line_coefficients(xs, ys, name)
    xm, ym = sum(xs) / length(xs), sum(ys) / length(ys)
    sxx = sum((xs .- xm) .^ 2)
    sxx > 0 || eqerror("$name: the x values must not all be equal")
    slope = sum((xs .- xm) .* (ys .- ym)) / sxx
    ym - slope * xm, slope
end

"`line(vx, vy)`: `[intercept; slope]` of the least-squares line."
function eq_line(vx, vy)
    xs, ys = _fit_pair(vx, vy, "line")
    intercept, slope = _line_coefficients(xs, ys, "line")
    reshape([intercept, slope], :, 1)
end

"`slope(vx, vy)`: slope of the least-squares line."
eq_slope(vx, vy) = (xs_ys = _fit_pair(vx, vy, "slope"); _line_coefficients(xs_ys..., "slope")[2])

"`intercept(vx, vy)`: intercept of the least-squares line."
eq_intercept(vx, vy) = (xs_ys = _fit_pair(vx, vy, "intercept"); _line_coefficients(xs_ys..., "intercept")[1])

"`stderr(vx, vy)`: standard error of the least-squares line, `sqrt(sum(resid^2) / (n - 2))`."
function eq_stderr(vx, vy)
    xs, ys = _fit_pair(vx, vy, "stderr"; minimum=3)
    a, b = _line_coefficients(xs, ys, "stderr")
    sqrt(sum((ys .- a .- b .* xs) .^ 2) / (length(xs) - 2))
end

"""
`medfit(vx, vy)`: `[intercept; slope]` of the median-median (Tukey resistant) line: the points
sorted by x split in three groups (the outer groups take the remainder), slope from the outer
group medians and intercept averaged over the three groups.
"""
function eq_medfit(vx, vy)
    xs, ys = _fit_pair(vx, vy, "medfit"; minimum=3)
    order = sortperm(xs)
    xs, ys = xs[order], ys[order]
    n = length(xs)
    base, extra = divrem(n, 3)
    sizes = extra == 0 ? [base, base, base] : extra == 1 ? [base, base + 1, base] : [base + 1, base, base + 1]
    stops = cumsum(sizes)
    groups = [(stops[i] - sizes[i] + 1):stops[i] for i in 1:3]
    mx = [_smooth_median(xs[g]) for g in groups]
    my = [_smooth_median(ys[g]) for g in groups]
    mx[3] == mx[1] && eqerror("medfit: the outer groups have the same median x")
    slope = (my[3] - my[1]) / (mx[3] - mx[1])
    intercept = sum(my .- slope .* mx) / 3
    reshape([intercept, slope], :, 1)
end

# ------------------------------------------------- Levenberg-Marquardt engine

function _numeric_jacobian(residual, p, r0)
    J = zeros(length(r0), length(p))
    for k in eachindex(p)
        step = 1e-7 * max(abs(p[k]), 1e-3)
        up, down = copy(p), copy(p)
        up[k] += step
        down[k] -= step
        J[:, k] = (residual(up) .- residual(down)) ./ (2step)
    end
    J
end

# Minimises sum(residual(p)^2); `jacobian(p)` defaults to central differences. `bounds` are
# enforced by projection.
function _lm(raw_residual, p0; jacobian=nothing, bounds=nothing, maxiter=400, tolerance=1e-12)
    expected = length(raw_residual(Float64.(p0)))
    # A step outside the domain of the model (log of a negative number ...) is a bad step.
    residual(p) = try
        raw_residual(p)
    catch err
        err isa Union{DomainError,OverflowError} ? fill(Inf, expected) : rethrow()
    end
    project(p) = bounds === nothing ? p : clamp.(p, bounds[:, 1], bounds[:, 2])
    p = project(Float64.(p0))
    r = residual(p)
    all(isfinite, r) || eqerror("the fit function is not finite at the initial guess")
    cost = sum(abs2, r)
    lambda = 1e-3
    for _ in 1:maxiter
        J = jacobian === nothing ? _numeric_jacobian(residual, p, r) : jacobian(p)
        gradient = J' * r
        norm(gradient, Inf) <= tolerance * max(1.0, cost) && break
        improved = false
        for _ in 1:30
            step = try
                -(J' * J + lambda * Diagonal(max.(diag(J' * J), 1e-12))) \ gradient
            catch
                lambda *= 10
                continue
            end
            candidate = project(p .+ step)
            rc = residual(candidate)
            costc = all(isfinite, rc) ? sum(abs2, rc) : Inf
            if costc < cost
                converged = cost - costc <= tolerance * max(cost, 1e-300) || norm(candidate .- p) <= tolerance * (norm(p) + tolerance)
                p, r, cost = candidate, rc, costc
                lambda = max(lambda / 5, 1e-12)
                improved = true
                converged && return p, r
                break
            end
            lambda *= 5
        end
        improved || break
    end
    p, r
end

function _call_model(F, x, p)
    result = F(x, reshape(p, :, 1))
    result isa AbstractArray ? Float64.(real.(vec(result))) : [Float64(real(result))]
end

function _model_residual(F, xs, ys, weights)
    p -> [(_call_model(F, xs[i], p)[1] - ys[i]) / weights[i] for i in eachindex(xs)]
end

# Confidence limits of the fitted parameters from the linearised covariance.
function _confidence_limits(residual, p, conf, name)
    r = residual(p)
    J = _numeric_jacobian(residual, p, r)
    dof = length(r) - length(p)
    dof >= 1 || eqerror("$name needs more points than parameters")
    variance = sum(abs2, r) / dof
    covariance = try
        variance * inv(J' * J)
    catch
        eqerror("$name: the parameters are not identifiable from the data")
    end
    0 < conf < 1 || eqerror("$name: conf must be between 0 and 1")
    t = Distributions.quantile(Distributions.TDist(dof), (1 + conf) / 2)
    half = t .* sqrt.(max.(diag(covariance), 0.0))
    [p .- half p .+ half]
end

function _fit_arguments(extras, count, observations, name)
    weights, bounds, accuracy, scale = ones(observations), nothing, 1e-12, true
    for extra in extras
        if extra isa AbstractString
            extra == "noscale" || eqerror("$name: unknown option $extra")
            scale = false
        elseif extra isa AbstractMatrix && isempty(extra)
            continue
        elseif extra isa AbstractMatrix && (size(extra, 1) == 1 || size(extra, 2) == 1) && length(extra) == observations
            weights = _real_column(extra, name)
            all(>(0), weights) || eqerror("$name: Stdy must be positive")
        elseif extra isa AbstractMatrix && size(extra) == (count, 2)
            bounds = Float64.(real.(extra))
            all(bounds[:, 1] .<= bounds[:, 2]) || eqerror("$name: LBUB lower bounds exceed the upper bounds")
        elseif extra isa Real
            accuracy = _real_bare(extra, name)
        else
            eqerror("$name: unrecognised optional argument")
        end
    end
    weights, bounds, accuracy, scale
end

function _nonlinear_fit(F, xs, ys, guess, conf, extras, name)
    F isa Function || eqerror("$name: F must be a function")
    p0 = _real_column(guess, name)
    weights, bounds, accuracy, _ = _fit_arguments(extras, length(p0), length(xs), name)
    residual = _model_residual(F, xs, ys, weights)
    p, _ = _lm(residual, p0; bounds, tolerance=accuracy)
    limits = _confidence_limits(residual, p, _real_bare(conf, name), name)
    [p limits]
end

"""
`LeastSquaresFit(vx, vy, F, guess, conf, [Stdy], [LBUB], [Acc])`: fits `F(x, u)` (a scalar
function of `x` and the parameter column `u`); the result has one row per parameter with the
estimate and its `conf` confidence limits `[value lower upper]`. `Stdy` are the standard
deviations of `vy`, `LBUB` the `[lower upper]` bounds, `Acc` the tolerance.
"""
function eq_LeastSquaresFit(vx, vy, F, guess, conf, extras...)
    xs, ys = _fit_pair(vx, vy, "LeastSquaresFit")
    _nonlinear_fit(F, xs, ys, guess, conf, extras, "LeastSquaresFit")
end

"""
`confidence(vx, vy, F, b, conf)`: the confidence interval of the parameters `b` of `F` as the reference application
returns it (verified with saved results), a `p x 2` table: the first column holds the half-width of
the `conf` interval of each parameter, the second the Student t value used in its first row
(`t * standard error = half-width`) and 0 below it.
"""
function eq_confidence(vx, vy, F, b, conf)
    xs, ys = _fit_pair(vx, vy, "confidence")
    F isa Function || eqerror("confidence: F must be a function")
    p = _real_column(b, "confidence")
    level = _real_bare(conf, "confidence")
    limits = _confidence_limits(_model_residual(F, xs, ys, ones(length(xs))), p, level, "confidence")
    dof = length(xs) - length(p)
    t = Distributions.quantile(Distributions.TDist(dof), (1 + level) / 2)
    table = zeros(length(p), 2)
    table[:, 1] = (limits[:, 2] .- limits[:, 1]) ./ 2
    table[1, 2] = t
    table
end

# `F(x, u)` of genfit returns the value followed by the partial derivatives with respect to u.
function _genfit(F, xs, ys, guess, name)
    F isa Function || eqerror("$name: F must be a function")
    p0 = _real_column(guess, name)
    weights = ones(length(xs))
    residual = _model_residual(F, xs, ys, weights)
    analytic = length(_call_model(F, xs[1], p0)) == length(p0) + 1
    jacobian = analytic ? p -> reduce(vcat, [_call_model(F, xs[i], p)[2:end]' for i in eachindex(xs)]) : nothing
    p, _ = _lm(residual, p0; jacobian)
    reshape(p, :, 1)
end

"""
`genfit(vx, vy, vg, F)`: Levenberg-Marquardt fit of `F(x, u)`, which returns a column with the
function value followed by its partial derivatives with respect to the parameters `u` (a
function returning only the value is also accepted); `vg` is the initial guess.
"""
function eq_genfit(vx, vy, vg, F)
    xs, ys = _fit_pair(vx, vy, "genfit")
    _genfit(F, xs, ys, vg, "genfit")
end

"""
`multidfit(X, Y, G, F)`: like `genfit` for several independent variables: row `i` of `X` is the
column vector passed as `x` to `F(x, u)`; `G` is the initial guess.
"""
function eq_multidfit(X, Y, G, F)
    isarr(X) && all(e -> e isa Real && !(e isa Unitful.AbstractQuantity), X) || eqerror("multidfit needs real data")
    ys = _real_column(Y, "multidfit")
    data = size(X, 1) == 1 && length(ys) == size(X, 2) ? reshape(Float64.(X), :, 1) : Float64.(X)
    size(data, 1) == length(ys) || eqerror("multidfit: X needs one row per element of Y")
    rows = [reshape(data[i, :], :, 1) for i in axes(data, 1)]
    _genfit(F, rows, ys, G, "multidfit")
end

# ---------------------------------------------------------- linear least squares

"""
`linfit(vx, vy, F)`: coefficients `c` minimising `sum((vy - sum_k c_k F(x)_k)^2)`, where
`F(x)` returns the column of basis functions.
"""
function eq_linfit(vx, vy, F)
    xs, ys = _fit_pair(vx, vy, "linfit")
    F isa Function || eqerror("linfit: F must be a function")
    design = reduce(vcat, [Float64.(real.(vec(F(x))))' for x in xs])
    size(design, 2) <= length(xs) || eqerror("linfit needs at least as many points as basis functions")
    reshape(design \ ys, :, 1)
end

# ---------------------------------------------------------- polynomial regression

# The letters the reference application names the variables with: A, B, ... and a power is the letter repeated.
_variable_letter(k) = Char('A' + k - 1)

"The name of a term: `Intercept`, `A`, `AB`, `AA`, ..."
function _term_name(term)
    all(iszero, term) && return "Intercept"
    join(repeat(string(_variable_letter(k)), e) for (k, e) in enumerate(term))
end

function _polynomial_terms(d, spec, name)
    if spec isa Real && !(spec isa Unitful.AbstractQuantity)
        n = _smooth_integer(spec, name, "order"; minimum=1)
        terms = Vector{Int}[]
        for degree in 0:n
            for exponents in Iterators.product(ntuple(_ -> 0:degree, d)...)
                sum(exponents) == degree && push!(terms, collect(exponents))
            end
        end
        # Degree by degree, the terms of the least power first.
        return sort(terms; by=term -> (sum(term), maximum(term), [-e for e in term]))
    elseif spec isa AbstractString
        # A list of term names separated by spaces or commas ("A,AA"); the intercept is always there.
        names = filter(!isempty, split(spec, r"[\s,]+"))
        terms = [zeros(Int, d)]
        for word in names
            all(c -> 'A' <= c <= _variable_letter(d), word) ||
                eqerror("$name: one or more terms are not valid")
            term = zeros(Int, d)
            for c in word
                term[c-'A'+1] += 1
            end
            term in terms || push!(terms, term)
        end
        return terms
    elseif spec isa AbstractMatrix && size(spec, 2) == d && !isempty(spec) &&
           all(e -> e isa Real && e >= 0 && isinteger(e), spec)
        return [Int.(spec[i, :]) for i in axes(spec, 1)]
    end
    eqerror("$name: the third argument must be a polynomial order, a list of terms or a matrix of exponents with one column per variable")
end

function _polynomial_problem(X, Y, spec, name)
    ys = _real_column(Y, name)
    isarr(X) && all(e -> e isa Real && !(e isa Unitful.AbstractQuantity), X) || eqerror("$name needs real data")
    data = size(X, 2) == 1 || size(X, 1) == 1 && length(ys) == size(X, 2) ? reshape(Float64.(vec(X)), :, 1) : Float64.(X)
    size(data, 1) == length(ys) || eqerror("$name: X and Y must have the same number of observations")
    terms = _polynomial_terms(size(data, 2), spec, name)
    length(ys) >= length(terms) || eqerror("$name needs at least $(length(terms)) observations")
    design = [prod(data[i, k]^term[k] for k in axes(data, 2)) for i in axes(data, 1), term in terms]
    data, ys, terms, design
end

function _polynomial_value(coefficients, terms, point)
    sum(coefficients[k] * prod(point[i]^terms[k][i] for i in eachindex(point)) for k in eachindex(terms))
end

"""
`polyfit(X, Y, n)` / `polyfit(X, Y, M)`: the least-squares polynomial surface as a function.
`X` is a vector (one variable) or a matrix with one column per variable; `n` selects all terms
of total degree up to `n`, a string lists the terms (`"A,AA"`) and the exponent matrix `M` (one
row per term) selects explicit terms. As in the reference application the function takes ONE argument: a number for
one variable, a vector of the variables otherwise.
"""
function eq_polyfit(X, Y, spec)
    data, ys, terms, design = _polynomial_problem(X, Y, spec, "polyfit")
    coefficients = design \ ys
    d = size(data, 2)
    function surface(args...)
        length(args) == 1 || eqerror("polyfit: the function takes one argument")
        point = args[1] isa AbstractMatrix ? Float64.(real.(vec(args[1]))) : [_real_bare(args[1], "polyfit")]
        length(point) == d || eqerror("polyfit: the function takes $d variables as a vector")
        _polynomial_value(coefficients, terms, point)
    end
    surface
end

function _coefficient_statistics(design, ys, conf, name)
    n, p = size(design)
    coefficients = design \ ys
    dof = n - p
    dof >= 0 || eqerror("$name needs at least as many observations as terms")
    r = ys .- design * coefficients
    0 < conf < 1 || eqerror("$name: conf must be between 0 and 1")
    inverse = inv(design' * design)
    if dof == 0
        # As many observations as terms: the fit is exact and the reference application returns NaN for the statistics.
        return coefficients, fill(NaN, p), NaN, r, dof, inverse
    end
    variance = sum(abs2, r) / dof
    t = Distributions.quantile(Distributions.TDist(dof), (1 + conf) / 2)
    errors = sqrt.(max.(diag(variance * inverse), 0.0))
    coefficients, errors, t, r, dof, inverse
end

"The variance inflation factors: the diagonal of the inverse correlation matrix of the regressors."
function _variance_inflation(design, terms)
    varying = [k for k in eachindex(terms) if !all(iszero, terms[k])]
    out = fill(NaN, length(terms))
    isempty(varying) && return out
    if length(varying) == 1
        out[varying[1]] = 1.0
        return out
    end
    columns = design[:, varying]
    centred = columns .- sum(columns; dims=1) ./ size(columns, 1)
    norms = sqrt.(sum(abs2, centred; dims=1))
    all(>(0), norms) || return out
    correlation = (centred ./ norms)' * (centred ./ norms)
    all(isfinite, correlation) || return out
    inverse = try
        inv(correlation)
    catch
        return out
    end
    out[varying] = diag(inverse)
    out
end

_percent_label(conf) = string(round(100 * conf; digits=6) |> x -> isinteger(x) ? Int(x) : x, "% CI ")

"""
The table of `polyfitc`: a header row and one row per term with the columns Term, Coefficient,
Std Error, CI Low, CI High, VIF, T and P (the one-sided p-value of T), as the reference application saves it.
"""
function _coefficient_table(terms, design, ys, conf, name)
    coefficients, errors, t, r, dof, inverse = _coefficient_statistics(design, ys, conf, name)
    vif = _variance_inflation(design, terms)
    tvalues = coefficients ./ errors
    pvalues = dof == 0 ? fill(NaN, length(terms)) : [Distributions.ccdf(Distributions.TDist(dof), abs(v)) for v in tvalues]
    header = ["Term", "Coefficient", "Std Error", _percent_label(conf) * "Low", _percent_label(conf) * "High", "VIF", "T", "P"]
    table = Matrix{Any}(undef, length(terms) + 1, 8)
    for (j, label) in enumerate(header)
        table[1, j] = label
    end
    for k in eachindex(terms)
        row = (_term_name(terms[k]), coefficients[k], errors[k], coefficients[k] - t * errors[k],
               coefficients[k] + t * errors[k], vif[k], tvalues[k], pvalues[k])
        for (j, value) in enumerate(row)
            table[k+1, j] = value
        end
    end
    table, coefficients, errors, r, dof, inverse
end

"""
`polyfitc(X, Y, spec, [conf])`: the coefficient table of the polynomial regression, a header
row and one row per term (Term, Coefficient, Std Error, CI Low, CI High, VIF, T, P); `conf`
defaults to 0.95.
"""
function eq_polyfitc(X, Y, spec, conf=0.95)
    _, ys, terms, design = _polynomial_problem(X, Y, spec, "polyfitc")
    _coefficient_table(terms, design, ys, _real_bare(conf, "polyfitc"), "polyfitc")[1]
end

"The ANOVA table of `polyfitstat`: Source, SSE, DF, MSE, F and P for the regression, each term, the residual, the lack of fit, the pure error and the total."
function _anova_table(terms, design, ys, coefficients, errors, r, dof)
    n, p = size(design)
    constant = any(all(iszero, term) for term in terms)
    sse = sum(abs2, r)
    total = constant ? sum((ys .- sum(ys) / n) .^ 2) : sum(abs2, ys)
    regression = total - sse
    model_dof = constant ? p - 1 : p
    mse = sse / dof
    pvalue(f, d1, d2) = d1 > 0 && d2 > 0 && isfinite(f) ? Distributions.ccdf(Distributions.FDist(d1, d2), f) : NaN
    rows = Any[]
    f_model = model_dof > 0 && mse > 0 ? regression / model_dof / mse : NaN
    push!(rows, ("Regression", regression, model_dof, model_dof > 0 ? regression / model_dof : NaN, f_model, pvalue(f_model, model_dof, dof)))
    for k in eachindex(terms)
        all(iszero, terms[k]) && continue
        f = (coefficients[k] / errors[k])^2
        push!(rows, (_term_name(terms[k]), f * mse, 1, f * mse, f, pvalue(f, 1, dof)))
    end
    push!(rows, ("Residual", sse, dof, mse, NaN, NaN))
    # Pure error: the spread of the observations that share one row of the design.
    groups = Dict{Vector{Float64},Vector{Int}}()
    for i in axes(design, 1)
        push!(get!(groups, Vector(design[i, :]), Int[]), i)
    end
    pure_sse = sum((sum(abs2, ys[g] .- sum(ys[g]) / length(g)) for g in values(groups) if length(g) > 1); init=0.0)
    pure_dof = n - length(groups)
    lack_sse = sse - pure_sse
    lack_dof = dof - pure_dof
    lack_mse = lack_dof > 0 ? lack_sse / lack_dof : NaN
    pure_mse = pure_dof > 0 ? pure_sse / pure_dof : 0.0
    f_lack = lack_dof > 0 && pure_dof > 0 && pure_mse > 0 ? lack_mse / pure_mse : NaN
    push!(rows, ("Lack of Fit", lack_sse, lack_dof, lack_dof > 0 ? lack_mse : 0.0, f_lack, pvalue(f_lack, lack_dof, pure_dof)))
    push!(rows, ("Pure Error", pure_sse, pure_dof, pure_mse, NaN, NaN))
    push!(rows, ("Total", total, n - 1, NaN, NaN, NaN))
    table = Matrix{Any}(undef, length(rows) + 1, 6)
    for (j, label) in enumerate(("Source", "SSE", "DF", "MSE", "F", "P"))
        table[1, j] = label
    end
    for (i, row) in enumerate(rows), (j, value) in enumerate(row)
        table[i+1, j] = value
    end
    table
end

"The diagnostics table of `polyfitstat`: Run, Observed, Predicted, Residual, Leverage, Studentized R., R-Student, Cook's Dis. and DFFITS per observation."
function _diagnostics_table(design, ys, r, dof, inverse)
    n, p = size(design)
    leverage = [design[i, :]' * inverse * design[i, :] for i in 1:n]
    sse = sum(abs2, r)
    s = sqrt(sse / dof)
    studentized = r ./ (s .* sqrt.(1 .- leverage))
    deleted = [sqrt(max((sse - r[i]^2 / (1 - leverage[i])) / (dof - 1), 0.0)) for i in 1:n]
    external = dof > 1 ? r ./ (deleted .* sqrt.(1 .- leverage)) : fill(NaN, n)
    cook = studentized .^ 2 .* leverage ./ (p .* (1 .- leverage))
    dffits = external .* sqrt.(leverage ./ (1 .- leverage))
    columns = [("Run", [float(origin() + i - 1) for i in 1:n]), ("Observed", ys), ("Predicted", ys .- r),
               ("Residual", r), ("Leverage", leverage), ("Studentized R.", studentized),
               ("R-Student", external), ("Cook's Dis.", cook), ("DFFITS", dffits)]
    table = Matrix{Any}(undef, n + 1, length(columns))
    for (j, (label, values)) in enumerate(columns)
        table[1, j] = label
        for i in 1:n
            table[i+1, j] = values[i]
        end
    end
    table
end

"""
`polyfitstat(X, Y, spec, [conf])`: the statistics of the polynomial regression as the reference application returns
them, a 10 x 2 table: Standard Deviation, R2, Adjusted R2, Predicted R2, PRESS and Durbin-Watson
as numbers, then the coefficient table (as `polyfitc`), the ANOVA table and the table of
diagnostics per observation.
"""
function eq_polyfitstat(X, Y, spec, conf=0.95)
    _, ys, terms, design = _polynomial_problem(X, Y, spec, "polyfitstat")
    table, coefficients, errors, r, dof, inverse = _coefficient_table(terms, design, ys, _real_bare(conf, "polyfitstat"), "polyfitstat")
    n, p = size(design)
    constant = any(all(iszero, term) for term in terms)
    sse = sum(abs2, r)
    total = constant ? sum((ys .- sum(ys) / n) .^ 2) : sum(abs2, ys)
    r2 = total == 0 ? 1.0 : 1 - sse / total
    adjusted = 1 - (1 - r2) * (constant ? n - 1 : n) / dof
    leverage = [design[i, :]' * inverse * design[i, :] for i in 1:n]
    press = sum((r ./ (1 .- leverage)) .^ 2)
    predicted = total == 0 ? 1.0 : 1 - press / total
    durbin_watson = sum(abs2, diff(r)) / sse
    out = Matrix{Any}(undef, 10, 2)
    labels = ("Regression Analysis", "Standard Deviation", "R2", "Adjusted R2", "Predicted R2", "PRESS", "Durbin-Watson", "Coefficients", "ANOVA", "Diagnostics")
    values = ("Value", sqrt(sse / dof), r2, adjusted, predicted, press, durbin_watson, table,
              _anova_table(terms, design, ys, coefficients, errors, r, dof),
              _diagnostics_table(design, ys, r, dof, inverse))
    for i in 1:10
        out[i, 1] = labels[i]
        out[i, 2] = values[i]
    end
    out
end

# ---------------------------------------------------------- named model fits

"`lnfit(vx, vy)`: `[a; b]` of `a*ln(x) + b` by linear regression on `ln(x)`."
function eq_lnfit(vx, vy)
    xs, ys = _fit_pair(vx, vy, "lnfit")
    all(>(0), xs) || eqerror("lnfit needs positive x values")
    b, a = _line_coefficients(log.(xs), ys, "lnfit")
    reshape([a, b], :, 1)
end

function _scan_fit(model, starts, xs, ys, guess, name)
    residual = p -> model.(xs, p[1], p[2], p[3]) .- ys
    candidates = guess === nothing ? starts : [_real_column(guess, name)]
    guess !== nothing && length(candidates[1]) == 3 || guess === nothing || eqerror("$name: vg needs three elements")
    best, best_cost = nothing, Inf
    for start in candidates
        all(isfinite, residual(start)) || continue
        p, r = _lm(residual, start)
        cost = sum(abs2, r)
        cost < best_cost && ((best, best_cost) = (p, cost))
    end
    best === nothing && eqerror("$name: no valid starting point; give an initial guess vg")
    reshape(best, :, 1)
end

# Linear parameters (a, c) of `a*f(x) + c` for a given nonlinear value.
function _affine(f, ys)
    basis = hcat(f, ones(length(f)))
    all(isfinite, basis) || return nothing
    try
        basis \ ys
    catch
        nothing
    end
end

function _scan_starts(shape, values, xs, ys)
    starts = Vector{Float64}[]
    for value in values
        coefficients = _affine(shape(xs, value), ys)
        coefficients === nothing || push!(starts, [coefficients[1], value, coefficients[2]])
    end
    starts
end

"`expfit(vx, vy, [vg])`: `[A; b; C]` of `A*exp(b*x) + C`; `vg` is an optional initial guess."
function eq_expfit(vx, vy, vg=nothing)
    xs, ys = _fit_pair(vx, vy, "expfit"; minimum=3)
    span = max(maximum(xs) - minimum(xs), eps())
    starts = _scan_starts((x, b) -> exp.(b .* (x .- xs[1])), [s * 10.0^k / span for s in (-1, 1) for k in -1:2], xs, ys)
    starts = [[s[1] * exp(-s[2] * xs[1]) * 1.0, s[2], s[3]] for s in starts]
    _scan_fit((x, a, b, c) -> a * exp(b * x) + c, starts, xs, ys, vg, "expfit")
end

"`logfit(vx, vy, [vg])`: `[a; b; c]` of `a*ln(x + b) + c`."
function eq_logfit(vx, vy, vg=nothing)
    xs, ys = _fit_pair(vx, vy, "logfit"; minimum=3)
    span = max(maximum(xs) - minimum(xs), eps())
    shifts = [-minimum(xs) + span * s for s in (1e-3, 1e-2, 0.1, 0.5, 1.0, 10.0)]
    starts = _scan_starts((x, b) -> log.(x .+ b), shifts, xs, ys)
    _scan_fit((x, a, b, c) -> a * log(x + b) + c, starts, xs, ys, vg, "logfit")
end

"`pwrfit(vx, vy, [vg])`: `[a; b; c]` of `a*x^b + c`."
function eq_pwrfit(vx, vy, vg=nothing)
    xs, ys = _fit_pair(vx, vy, "pwrfit"; minimum=3)
    all(>(0), xs) || vg !== nothing || eqerror("pwrfit needs positive x values or an initial guess vg")
    starts = _scan_starts((x, b) -> x .^ b, [-3.0, -2, -1, -0.5, 0.25, 0.5, 1, 1.5, 2, 3, 4], xs, ys)
    _scan_fit((x, a, b, c) -> a * x^b + c, starts, xs, ys, vg, "pwrfit")
end

"`lgsfit(vx, vy, [vg])`: `[a; b; c]` of the logistic `a / (1 + b*exp(-c*x))`."
function eq_lgsfit(vx, vy, vg=nothing)
    xs, ys = _fit_pair(vx, vy, "lgsfit"; minimum=3)
    span = max(maximum(xs) - minimum(xs), eps())
    mid = (maximum(xs) + minimum(xs)) / 2
    top = maximum(abs, ys) * 1.1
    starts = Vector{Float64}[]
    for sign in (1.0, -1.0), rate in (1.0, 4.0, 10.0)
        c = sign * rate / span
        push!(starts, [top, exp(c * mid), c])
    end
    _scan_fit((x, a, b, c) -> a / (1 + b * exp(-c * x)), starts, xs, ys, vg, "lgsfit")
end

"`sinfit(vx, vy, [vg])`: `[a; b; c]` of `a*sin(x + b) + c`."
function eq_sinfit(vx, vy, vg=nothing)
    xs, ys = _fit_pair(vx, vy, "sinfit"; minimum=3)
    starts = [[(maximum(ys) - minimum(ys)) / 2, phase, sum(ys) / length(ys)] for phase in range(0, 2pi; length=9)[1:8]]
    _scan_fit((x, a, b, c) -> a * sin(x + b) + c, starts, xs, ys, vg, "sinfit")
end

# ---------------------------------------------------------------- rational fits

function _rational_value(x, p, m, n)
    numerator = sum(p[i+1] * x^i for i in 0:m)
    denominator = 1 + sum(p[m+1+j] * x^j for j in 1:n; init=0.0)
    numerator / denominator
end

function _rational_fit(vx, vy, conf, m, n, extras, avoid_poles, name)
    xs, ys = _fit_pair(vx, vy, name)
    numerator_degree = _smooth_integer(m, name, "m"; minimum=0)
    denominator_degree = _smooth_integer(n, name, "n"; minimum=0)
    count = numerator_degree + denominator_degree + 1
    length(xs) >= count || eqerror("$name needs at least $count points")
    weights, bounds, accuracy, _ = _fit_arguments(extras, count, length(xs), name)
    # Linearised start: y*(1 + sum b x^j) = sum a x^i.
    linear = hcat([xs .^ i for i in 0:numerator_degree]..., [-(ys .* xs .^ j) for j in 1:denominator_degree]...)
    start = linear \ ys
    grid = range(minimum(xs), maximum(xs); length=60)
    residual = function (p)
        fit = [_rational_value(x, p, numerator_degree, denominator_degree) for x in xs]
        r = (fit .- ys) ./ weights
        if avoid_poles && denominator_degree > 0
            margin = 1e-2
            penalty = [1e3 * max(0.0, margin - (1 + sum(p[numerator_degree+1+j] * x^j for j in 1:denominator_degree))) for x in grid]
            r = vcat(r, penalty)
        end
        r
    end
    p, _ = _lm(residual, start; bounds, tolerance=accuracy)
    plain = q -> [(_rational_value(xs[i], q, numerator_degree, denominator_degree) - ys[i]) / weights[i] for i in eachindex(xs)]
    limits = _confidence_limits(plain, p, _real_bare(conf, name), name)
    [p limits]
end

"""
`rationalfit(vx, vy, conf, m, n, [Stdy], [LBUB], [Acc], ["noscale"])`: fits
`(a0 + a1 x + ... + am x^m) / (1 + b1 x + ... + bn x^n)`. The rows are `a0..am, b1..bn` and the
columns `[value lower upper]` with the `conf` confidence limits. The optional arguments are
recognised by their shape (a vector of `rows(vx)` is `Stdy`, a matrix with two columns `LBUB`,
a scalar `Acc`); the scaling option is accepted and has no effect.
"""
eq_rationalfit(vx, vy, conf, m, n, extras...) = _rational_fit(vx, vy, conf, m, n, extras, false, "rationalfit")

"`rationalfitnp(...)`: like `rationalfit`, penalising denominators that vanish inside the data range."
eq_rationalfitnp(vx, vy, conf, m, n, extras...) = _rational_fit(vx, vy, conf, m, n, extras, true, "rationalfitnp")
