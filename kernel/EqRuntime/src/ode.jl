# Differential equation solvers: the initial-value solvers of the
# `rkfixed` family, the stiff solvers, `statespace`, the shooting functions `sbval` and
# `bvalfit`, the method-of-lines solver `numol` and the elliptic solvers `relax` and
# `multigrid`. the reference application does not publish its integrators, so every method here is a textbook
# implementation of the named algorithm that returns values at the requested abscissae; the
# results agree with the reference application's to the solver tolerance, not bit for bit (algorithm-dependent).

# --------------------------------------------------------------------- setup

# Internal relative tolerance: far tighter than the worksheet TOL (the reference application's solvers are
# usually much more accurate than TOL suggests), floored at 1e-12.
_ode_tolerance() = clamp(tol() * 1e-5, 1e-12, 1e-8)

function _ode_state(init, name)
    if init isa Real && !(init isa Unitful.AbstractQuantity)
        return [Float64(init)]
    end
    _real_column(init, name)
end

function _ode_rhs(D, name)
    D isa Function || eqerror("$name: D must be a function")
    function rhs(x, y)
        value = D(x, reshape(y, :, 1))
        out = value isa AbstractArray ? Float64.(real.(vec(value))) : [Float64(real(value))]
        length(out) == length(y) || eqerror("$name: D must return $(length(y)) values")
        out
    end
end

function _ode_problem(init, x1, x2, intvls, D, name)
    y0 = _ode_state(init, name)
    a, b = _real_bare(x1, name), _real_bare(x2, name)
    intervals = _smooth_integer(intvls, name, "intvls")
    a != b || eqerror("$name: x1 and x2 must differ")
    y0, a, b, intervals, _ode_rhs(D, name)
end

function _ode_table(grid, states)
    table = zeros(length(grid), length(states[1]) + 1)
    for (row, (x, y)) in enumerate(zip(grid, states))
        table[row, 1] = x
        table[row, 2:end] = y
        all(isfinite, y) || eqerror("the solution is not finite at x = $x")
    end
    table
end

# Advances the solution over every interval of the grid with `advance(rhs, x, y, h)`.
function _march(advance, y0, a, b, intervals)
    grid = collect(range(a, b; length=intervals + 1))
    states = [copy(y0)]
    y = copy(y0)
    for i in 1:intervals
        y = advance(grid[i], y, grid[i+1] - grid[i])
        push!(states, y)
    end
    grid, states
end

# ----------------------------------------------------------------- explicit

function _rk4_step(rhs, x, y, h)
    k1 = rhs(x, y)
    k2 = rhs(x + h / 2, y .+ h / 2 .* k1)
    k3 = rhs(x + h / 2, y .+ h / 2 .* k2)
    k4 = rhs(x + h, y .+ h .* k3)
    y .+ h / 6 .* (k1 .+ 2 .* k2 .+ 2 .* k3 .+ k4)
end

"`rkfixed(init, x1, x2, intvls, D)`: fourth-order Runge-Kutta with `intvls` fixed steps."
function eq_rkfixed(init, x1, x2, intvls, D)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "rkfixed")
    grid, states = _march((x, y, h) -> _rk4_step(rhs, x, y, h), y0, a, b, n)
    _ode_table(grid, states)
end

# Dormand-Prince 5(4) with adaptive steps over one interval.
const _DP_C = (0.0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1.0, 1.0)
const _DP_A = (
    (),
    (1 / 5,),
    (3 / 40, 9 / 40),
    (44 / 45, -56 / 15, 32 / 9),
    (19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729),
    (9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656),
    (35 / 384, 0.0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84),
)
const _DP_E = (71 / 57600, 0.0, -71 / 16695, 71 / 1920, -17253 / 339200, 22 / 525, -1 / 40)

function _dopri_interval(rhs, x, y, span, tolerance; max_steps=200_000)
    direction = sign(span)
    remaining = abs(span)
    h = remaining
    position = x
    f = rhs(position, y)
    steps = 0
    while remaining > 1e-14 * max(1.0, abs(x))
        steps += 1
        steps > max_steps && eqerror("the solver needs too many steps; the problem may be stiff")
        h = min(h, remaining)
        k = Vector{Vector{Float64}}(undef, 7)
        k[1] = f
        for stage in 2:7
            ys = copy(y)
            for (j, coefficient) in enumerate(_DP_A[stage])
                ys .+= direction * h * coefficient .* k[j]
            end
            k[stage] = rhs(position + direction * h * _DP_C[stage], ys)
        end
        ynew = copy(y)
        for (j, coefficient) in enumerate(_DP_A[7])
            ynew .+= direction * h * coefficient .* k[j]
        end
        error_vector = direction * h .* sum(_DP_E[j] .* k[j] for j in 1:7)
        scale = tolerance .* (1.0 .+ max.(abs.(y), abs.(ynew)))
        err = maximum(abs.(error_vector) ./ scale)
        if err <= 1
            position += direction * h
            remaining -= h
            y = ynew
            f = k[7]
        end
        factor = err == 0 ? 5.0 : clamp(0.9 * err^(-1 / 5), 0.2, 5.0)
        isfinite(err) || (factor = 0.2)
        h *= factor
    end
    y
end

"`Rkadapt(init, x1, x2, intvls, D)`: fourth/fifth-order Runge-Kutta with an adaptive step, values at `intvls + 1` points."
function eq_Rkadapt(init, x1, x2, intvls, D)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "Rkadapt")
    tolerance = _ode_tolerance()
    grid, states = _march((x, y, h) -> _dopri_interval(rhs, x, y, h, tolerance), y0, a, b, n)
    _ode_table(grid, states)
end

# Gragg-Bulirsch-Stoer extrapolation over one interval; the interval is halved when the
# extrapolation table does not converge.
function _gbs_interval(rhs, x, y, H, tolerance; depth=0)
    depth > 40 && eqerror("Bulstoer: the step size collapsed; the problem may be stiff")
    sequence = (2, 4, 6, 8, 10, 12, 14, 16)
    table = Vector{Vector{Float64}}[]
    previous = nothing
    for (j, steps) in enumerate(sequence)
        h = H / steps
        z0 = copy(y)
        z1 = y .+ h .* rhs(x, y)
        for m in 1:(steps-1)
            z0, z1 = z1, z0 .+ 2h .* rhs(x + m * h, z1)
        end
        estimate = (z1 .+ z0 .+ h .* rhs(x + H, z1)) ./ 2
        row = [estimate]
        for k in 1:(j-1)
            ratio = (steps / sequence[j-k])^2
            push!(row, row[k] .+ (row[k] .- table[j-1][k]) ./ (ratio - 1))
        end
        push!(table, row)
        if j > 1
            err = maximum(abs.(row[end] .- table[j-1][end]) ./ (tolerance .* (1.0 .+ abs.(row[end]))))
            err <= 1 && return row[end]
        end
    end
    half = _gbs_interval(rhs, x, y, H / 2, tolerance; depth=depth + 1)
    _gbs_interval(rhs, x + H / 2, half, H / 2, tolerance; depth=depth + 1)
end

"`Bulstoer(init, x1, x2, intvls, D)`: Bulirsch-Stoer extrapolation, for smooth nonstiff systems."
function eq_Bulstoer(init, x1, x2, intvls, D)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "Bulstoer")
    tolerance = _ode_tolerance()
    grid, states = _march((x, y, h) -> _gbs_interval(rhs, x, y, h, tolerance), y0, a, b, n)
    _ode_table(grid, states)
end

# Adams-Bashforth-Moulton predictor-corrector of order four with `m` steps per interval.
function _abm_run(rhs, y0, grid, m)
    states = [copy(y0)]
    y = copy(y0)
    for i in 1:(length(grid)-1)
        h = (grid[i+1] - grid[i]) / m
        history = Vector{Vector{Float64}}()   # right-hand sides at the last four nodes
        x = grid[i]
        push!(history, rhs(x, y))
        for step in 1:m
            if length(history) < 4
                y = _rk4_step(rhs, x, y, h)
                x += h
                push!(history, rhs(x, y))
            else
                f = history[end-3:end]
                predictor = y .+ h / 24 .* (55 .* f[4] .- 59 .* f[3] .+ 37 .* f[2] .- 9 .* f[1])
                x += h
                fp = rhs(x, predictor)
                y = y .+ h / 24 .* (9 .* fp .+ 19 .* f[4] .- 5 .* f[3] .+ f[2])
                push!(history, rhs(x, y))
            end
        end
        push!(states, y)
    end
    states
end

"""
`Adams(init, x1, x2, intvls, D, [tol])`: Adams-Bashforth-Moulton predictor-corrector for nonstiff
systems; the number of internal steps per interval doubles until two runs agree within `tol`.
"""
function eq_Adams(init, x1, x2, intvls, D, tol_arg=nothing)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "Adams")
    tolerance = _ode_tolerances(tol_arg, length(y0), "Adams")
    grid = collect(range(a, b; length=n + 1))
    m = 4
    previous = _abm_run(rhs, y0, grid, m)
    for _ in 1:12
        m *= 2
        current = _abm_run(rhs, y0, grid, m)
        converged = all(all(abs.(current[i] .- previous[i]) .<= tolerance .* (1.0 .+ abs.(current[i]))) for i in eachindex(current))
        previous = current
        converged && break
    end
    _ode_table(grid, previous)
end

function _ode_tolerances(value, count, name)
    value === nothing && return fill(_ode_tolerance(), count)
    values = value isa Real ? [Float64(value)] : _real_column(value, name)
    all(>(0), values) || eqerror("$name: tol must be positive")
    length(values) == 1 ? fill(values[1], count) : length(values) == count ? values : eqerror("$name: tol needs one value or one per variable")
end

# ---------------------------------------------------------------------- stiff

function _jacobian_function(J, rhs, name)
    if J === nothing || (J isa AbstractMatrix && isempty(J))
        return (x, y) -> begin
            f0 = rhs(x, y)
            M = zeros(length(y), length(y))
            for k in eachindex(y)
                step = 1e-7 * max(abs(y[k]), 1.0)
                yp = copy(y)
                yp[k] += step
                M[:, k] = (rhs(x, yp) .- f0) ./ step
            end
            M
        end
    end
    J isa Function || eqerror("$name: J must be a function")
    (x, y) -> Float64.(real.(J(x, reshape(y, :, 1))))
end

function _optional_arguments(extras, name; allowed)
    values = Dict{Symbol,Any}()
    for extra in extras
        if extra isa Function && :J in allowed && !haskey(values, :J)
            values[:J] = extra
        elseif extra isa AbstractMatrix && :M in allowed && size(extra, 1) == size(extra, 2) && size(extra, 1) > 1 && !haskey(values, :M)
            values[:M] = Float64.(real.(extra))
        elseif extra isa Real && :tol in allowed
            values[:tol] = extra
        elseif extra isa AbstractMatrix && isempty(extra)
            continue
        elseif extra isa AbstractMatrix && :tol in allowed
            values[:tol] = extra
        else
            eqerror("$name: unrecognised optional argument")
        end
    end
    values
end

# BDF2 with `m` constant steps per interval (implicit Euler as the first step), Newton iterations.
function _bdf_run(rhs, jacobian, y0, grid, m, newton_tolerance)
    n = length(y0)
    states = [copy(y0)]
    y = copy(y0)
    for i in 1:(length(grid)-1)
        h = (grid[i+1] - grid[i]) / m
        x = grid[i]
        yprev = nothing
        for step in 1:m
            xn = x + h
            if yprev === nothing
                target = (z -> z .- y .- h .* rhs(xn, z))
                coefficient = 1.0
                base = y
            else
                # (3 z - 4 y + yprev) / (2h) = f(xn, z)
                base = (4 .* y .- yprev) ./ 3
                coefficient = 2h / 3
                target = (z -> z .- base .- coefficient .* rhs(xn, z))
            end
            z = copy(y)
            for _ in 1:30
                residual = target(z)
                J = jacobian(xn, z)
                delta = (I - (yprev === nothing ? h : coefficient) .* J) \ residual
                z .-= delta
                maximum(abs.(delta) ./ (1.0 .+ abs.(z))) <= newton_tolerance && break
            end
            yprev, y, x = y, z, xn
        end
        push!(states, y)
    end
    states
end

function _refined(run, y0, grid, tolerance; start=2, doublings=10)
    m = start
    previous = run(m)
    extrapolated = previous
    for _ in 1:doublings
        m *= 2
        current = run(m)
        extrapolated = [(4 .* current[i] .- previous[i]) ./ 3 for i in eachindex(current)]
        converged = all(all(abs.(current[i] .- previous[i]) .<= 3 .* tolerance .* (1.0 .+ abs.(current[i]))) for i in eachindex(current))
        previous = current
        converged && break
    end
    extrapolated
end

"""
`BDF(init, x1, x2, intvls, D, [J], [tol])`: backward differentiation (order two) for stiff systems,
with Newton iterations; `J(x, y)` is the Jacobian (numerical when omitted). The number of internal
steps per interval doubles, with Richardson extrapolation, until two runs agree within `tol`.
"""
function eq_BDF(init, x1, x2, intvls, D, extras...)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "BDF")
    options = _optional_arguments(extras, "BDF"; allowed=(:J, :tol))
    jacobian = _jacobian_function(get(options, :J, nothing), rhs, "BDF")
    tolerance = maximum(_ode_tolerances(get(options, :tol, nothing), length(y0), "BDF"))
    grid = collect(range(a, b; length=n + 1))
    states = _refined(m -> _bdf_run(rhs, jacobian, y0, grid, m, tolerance * 1e-2), y0, grid, tolerance)
    _ode_table(grid, states)
end

# Radau IIA (order five, three stages) for M y' = f(x, y); stages solved together with Newton.
const _SQ6 = sqrt(6.0)
const _RADAU_C = [(4 - _SQ6) / 10, (4 + _SQ6) / 10, 1.0]
const _RADAU_A = [
    (88 - 7_SQ6) / 360 (296 - 169_SQ6) / 1800 (-2 + 3_SQ6) / 225
    (296 + 169_SQ6) / 1800 (88 + 7_SQ6) / 360 (-2 - 3_SQ6) / 225
    (16 - _SQ6) / 36 (16 + _SQ6) / 36 1/9
]

function _radau_step(rhs, jacobian, mass, x, y, h)
    n = length(y)
    Y = [copy(y) for _ in 1:3]
    J = jacobian(x + h, y)
    left = kron(Matrix(1.0I, 3, 3), mass) .- h .* kron(_RADAU_A, J)
    factor = lu(left)
    for _ in 1:20
        F = [rhs(x + _RADAU_C[i] * h, Y[i]) for i in 1:3]
        residual = reduce(vcat, [mass * (Y[i] .- y) .- h .* sum(_RADAU_A[i, j] .* F[j] for j in 1:3) for i in 1:3])
        delta = factor \ residual
        for i in 1:3
            Y[i] = Y[i] .- delta[(1+(i-1)*n):(i*n)]
        end
        maximum(abs.(delta) ./ (1.0 .+ abs.(reduce(vcat, Y)))) <= 1e-13 && break
    end
    Y[3]
end

# Adaptive Radau over one interval, step doubling for the error estimate.
function _radau_interval(rhs, jacobian, mass, x, y, span, tolerance; max_steps=100_000)
    remaining = span
    position = x
    h = span
    steps = 0
    while abs(remaining) > 1e-14 * max(1.0, abs(x))
        steps += 1
        steps > max_steps && eqerror("Radau: too many steps")
        h = abs(h) > abs(remaining) ? remaining : h
        full = _radau_step(rhs, jacobian, mass, position, y, h)
        half = _radau_step(rhs, jacobian, mass, position, y, h / 2)
        double = _radau_step(rhs, jacobian, mass, position + h / 2, half, h / 2)
        err = maximum(abs.(double .- full) ./ (tolerance .* (1.0 .+ abs.(double)))) / 31
        if err <= 1
            position += h
            remaining -= h
            y = double .+ (double .- full) ./ 31
        end
        h *= err == 0 ? 4.0 : clamp(0.9 * err^(-1 / 6), 0.2, 4.0)
    end
    y
end

"""
`Radau(init, x1, x2, intvls, D, [J], [M], [tol])`: Radau IIA of order five for stiff systems and
`M y' = D(x, y)` with a (possibly singular) coupling matrix `M`; adaptive internal steps.
"""
function eq_Radau(init, x1, x2, intvls, D, extras...)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "Radau")
    options = _optional_arguments(extras, "Radau"; allowed=(:J, :M, :tol))
    jacobian = _jacobian_function(get(options, :J, nothing), rhs, "Radau")
    mass = get(options, :M, Matrix(1.0I, length(y0), length(y0)))
    size(mass) == (length(y0), length(y0)) || eqerror("Radau: M must be $(length(y0)) x $(length(y0))")
    tolerance = maximum(_ode_tolerances(get(options, :tol, nothing), length(y0), "Radau"))
    grid, states = _march((x, y, h) -> _radau_interval(rhs, jacobian, mass, x, y, h, tolerance), y0, a, b, n)
    _ode_table(grid, states)
end

# Augmented Jacobian AJ(x, y) = [df/dx df/dy]; numerical when AJ is not usable.
function _augmented_jacobian(AJ, rhs, n, name)
    AJ isa Function || eqerror("$name: AJ must be a function")
    (x, y) -> begin
        M = Float64.(real.(AJ(x, reshape(y, :, 1))))
        size(M) == (n, n + 1) || eqerror("$name: AJ must return a $n x $(n + 1) matrix")
        M[:, 1], M[:, 2:end]
    end
end

# Linearly implicit Euler extrapolation (Deuflhard) over one interval.
function _stiffb_interval(rhs, augmented, x, y, H, tolerance; depth=0)
    depth > 30 && eqerror("Stiffb: the step size collapsed")
    sequence = (1, 2, 3, 4, 5, 6, 7, 8)
    n = length(y)
    table = Vector{Vector{Vector{Float64}}}()
    for (j, steps) in enumerate(sequence)
        h = H / steps
        z = copy(y)
        for m in 0:(steps-1)
            fx, J = augmented(x + m * h, z)
            f = rhs(x + m * h, z)
            z = z .+ (I - h .* J) \ (h .* (f .+ h .* fx))
        end
        row = [z]
        for k in 1:(j-1)
            ratio = steps / sequence[j-k]
            push!(row, row[k] .+ (row[k] .- table[j-1][k]) ./ (ratio - 1))
        end
        push!(table, row)
        if j > 2
            err = maximum(abs.(row[end] .- table[j-1][end]) ./ (tolerance .* (1.0 .+ abs.(row[end]))))
            err <= 1 && return row[end]
        end
    end
    half = _stiffb_interval(rhs, augmented, x, y, H / 2, tolerance; depth=depth + 1)
    _stiffb_interval(rhs, augmented, x + H / 2, half, H / 2, tolerance; depth=depth + 1)
end

"`Stiffb(init, x1, x2, intvls, D, AJ)`: linearly implicit extrapolation for stiff systems; `AJ(x, y)` is `[dD/dx  dD/dy]`."
function eq_Stiffb(init, x1, x2, intvls, D, AJ)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "Stiffb")
    augmented = _augmented_jacobian(AJ, rhs, length(y0), "Stiffb")
    tolerance = _ode_tolerance()
    grid, states = _march((x, y, h) -> _stiffb_interval(rhs, augmented, x, y, h, tolerance), y0, a, b, n)
    _ode_table(grid, states)
end

# Modified Rosenbrock pair of order 2(3) (Shampine and Reichelt), adaptive.
function _rosenbrock_interval(rhs, augmented, x, y, span, tolerance; max_steps=500_000)
    d = 1 / (2 + sqrt(2.0))
    e32 = 6 + sqrt(2.0)
    n = length(y)
    remaining = span
    position = x
    h = span
    steps = 0
    while abs(remaining) > 1e-14 * max(1.0, abs(x))
        steps += 1
        steps > max_steps && eqerror("Stiffr: too many steps")
        h = abs(h) > abs(remaining) ? remaining : h
        fx, J = augmented(position, y)
        f0 = rhs(position, y)
        W = lu(I - h * d .* J)
        T = h * d .* fx
        k1 = W \ (f0 .+ T)
        f1 = rhs(position + h / 2, y .+ h / 2 .* k1)
        k2 = W \ (f1 .- k1) .+ k1
        ynew = y .+ h .* k2
        f2 = rhs(position + h, ynew)
        k3 = W \ (f2 .- e32 .* (k2 .- f1) .- 2 .* (k1 .- f0) .+ T)
        err = maximum(abs.(h / 6 .* (k1 .- 2 .* k2 .+ k3)) ./ (tolerance .* (1.0 .+ abs.(ynew))))
        if err <= 1
            position += h
            remaining -= h
            y = ynew
        end
        h *= !isfinite(err) ? 0.2 : err == 0 ? 4.0 : clamp(0.9 * err^(-1 / 3), 0.2, 4.0)
    end
    y
end

"`Stiffr(init, x1, x2, intvls, D, AJ)`: Rosenbrock method for stiff systems; `AJ(x, y)` is `[dD/dx  dD/dy]`."
function eq_Stiffr(init, x1, x2, intvls, D, AJ)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "Stiffr")
    augmented = _augmented_jacobian(AJ, rhs, length(y0), "Stiffr")
    tolerance = _ode_tolerance() * 1e-1
    grid, states = _march((x, y, h) -> _rosenbrock_interval(rhs, augmented, x, y, h, tolerance), y0, a, b, n)
    _ode_table(grid, states)
end

"""
`AdamsBDF(init, x1, x2, intvls, D, [J], [tol])`: uses `Adams` unless the Jacobian at the start
says the problem is stiff for the output step (spectral radius times step above 1), then `BDF`.
"""
function eq_AdamsBDF(init, x1, x2, intvls, D, extras...)
    y0, a, b, n, rhs = _ode_problem(init, x1, x2, intvls, D, "AdamsBDF")
    options = _optional_arguments(extras, "AdamsBDF"; allowed=(:J, :tol))
    jacobian = _jacobian_function(get(options, :J, nothing), rhs, "AdamsBDF")
    radius = maximum(abs.(eigvals(jacobian(a, y0))))
    stiff = radius * abs(b - a) / n > 1
    stiff ? eq_BDF(init, x1, x2, intvls, D, extras...) :
            eq_Adams(init, x1, x2, intvls, D, get(options, :tol, nothing))
end

"""
`statespace(init, t1, t2, intvls, A, [B, u])`: solves `x' = A(t) x + B(t) u(t)`; `A`, `B` and `u` are
functions of `t` or constant arrays.
"""
function eq_statespace(init, t1, t2, intvls, A, B=nothing, u=nothing)
    y0 = _ode_state(init, "statespace")
    (B === nothing) == (u === nothing) || eqerror("statespace: B and u must be given together")
    evaluate(f, t) = f isa Function ? f(t) : f
    matrix(value, t) = (m = evaluate(value, t); m isa AbstractArray ? Float64.(real.(m)) : fill(Float64(real(m)), 1, 1))
    function rhs(t, x)
        a = matrix(A, t)
        size(a) == (length(x), length(x)) || eqerror("statespace: A must be $(length(x)) x $(length(x))")
        derivative = a * x
        if B !== nothing
            b = matrix(B, t)
            input = vec(matrix(u, t))
            b = size(b, 2) == length(input) ? b : reshape(b, :, length(input))
            derivative = derivative .+ vec(b * input)
        end
        derivative
    end
    a_, b_, n = _real_bare(t1, "statespace"), _real_bare(t2, "statespace"), _smooth_integer(intvls, "statespace", "intvls")
    tolerance = _ode_tolerance()
    grid, states = _march((x, y, h) -> _dopri_interval(rhs, x, y, h, tolerance), y0, a_, b_, n)
    _ode_table(grid, states)
end

# ------------------------------------------------------------------- shooting

# Integrates from `x` to `target` with adaptive Runge-Kutta; returns the final state.
_shoot(rhs, x, y, target) = x == target ? y : _dopri_interval(rhs, x, y, target - x, 1e-11)

function _call_vector(f, name, args...)
    f isa Function || eqerror("$name: expected a function")
    value = f(args...)
    value isa AbstractArray ? Float64.(real.(vec(value))) : [Float64(real(value))]
end

"""
`sbval(v1, x1, x2, D, load1, score)`: the values `v1` left unspecified at `x1` that make
`score(x2, y(x2))` vanish, found by shooting from `x1` with `load1(x1, v1)` (Levenberg-Marquardt).
"""
function eq_sbval(v1, x1, x2, D, load1, score)
    guess = _real_column(v1, "sbval")
    a, b = _real_bare(x1, "sbval"), _real_bare(x2, "sbval")
    rhs = _ode_rhs(D, "sbval")
    residual = v -> begin
        start = _call_vector(load1, "sbval", a, reshape(v, :, 1))
        _call_vector(score, "sbval", b, reshape(_shoot(rhs, a, start, b), :, 1))
    end
    length(residual(guess)) == length(guess) || eqerror("sbval: score must return one value per unknown")
    solution, r = _lm(residual, guess; tolerance=1e-14)
    norm(r, Inf) < 1e-6 * (1 + norm(solution, Inf)) || eqerror("sbval: the shooting method did not converge; try other guesses")
    reshape(solution, :, 1)
end

"""
`bvalfit(v1, v2, x1, x2, xf, D, load1, load2, score)`: shoots from `x1` and from `x2` to the match
point `xf` and returns the row of the values left unspecified at `x1` followed by those left
unspecified at `x2` for which `score(xf, y)` agrees (a `1 x (n1 + n2)` row, as the reference application returns it).
"""
function eq_bvalfit(v1, v2, x1, x2, xf, D, load1, load2, score)
    g1, g2 = _real_column(v1, "bvalfit"), _real_column(v2, "bvalfit")
    a, b, m = _real_bare(x1, "bvalfit"), _real_bare(x2, "bvalfit"), _real_bare(xf, "bvalfit")
    rhs = _ode_rhs(D, "bvalfit")
    n1 = length(g1)
    residual = v -> begin
        left = _shoot(rhs, a, _call_vector(load1, "bvalfit", a, reshape(v[1:n1], :, 1)), m)
        right = _shoot(rhs, b, _call_vector(load2, "bvalfit", b, reshape(v[(n1+1):end], :, 1)), m)
        _call_vector(score, "bvalfit", m, reshape(left, :, 1)) .- _call_vector(score, "bvalfit", m, reshape(right, :, 1))
    end
    guess = vcat(g1, g2)
    length(residual(guess)) == length(guess) || eqerror("bvalfit: score must return one value per unknown")
    solution, r = _lm(residual, guess; tolerance=1e-14)
    norm(r, Inf) < 1e-6 * (1 + norm(solution, Inf)) || eqerror("bvalfit: the shooting method did not converge; try other guesses")
    reshape(solution, 1, :)
end

# ------------------------------------------------------------ method of lines

_is_marker(value, text) = value isa AbstractString && uppercase(value) == text

function _boundary_row(bc, t, k)
    matrix = bc isa Function ? bc(t) : bc
    matrix isa AbstractMatrix && size(matrix, 2) == 3 && k <= size(matrix, 1) ||
        eqerror("numol: bc_func must be a num_pde x 3 matrix")
    left, right, kind = matrix[k, 1], matrix[k, 2], matrix[k, 3]
    kind isa AbstractString && uppercase(kind) in ("D", "N") || eqerror("numol: the boundary type must be \"D\" or \"N\"")
    (left isa Function ? left(t) : left), (right isa Function ? right(t) : right), uppercase(kind)
end

"""
The x derivative of the grid values `c` with spacing `h`: five-point fourth-order differences, centred
in the interior and one-sided at the two nodes next to each end. These are the weights the reference application's `numol`
uses.
"""
function _numol_derivative(c::AbstractVector, h::Real)
    n = length(c)
    d = similar(c, float(eltype(c)))
    d[1] = (-25c[1] + 48c[2] - 36c[3] + 16c[4] - 3c[5]) / (12h)
    d[2] = (-3c[1] - 10c[2] + 18c[3] - 6c[4] + c[5]) / (12h)
    for j in 3:(n-2)
        d[j] = (c[j-2] - 8c[j-1] + 8c[j+1] - c[j+2]) / (12h)
    end
    d[n-1] = (-c[n-4] + 6c[n-3] - 18c[n-2] + 10c[n-1] + 3c[n]) / (12h)
    d[n] = (3c[n-4] - 16c[n-3] + 36c[n-2] - 48c[n-1] + 25c[n]) / (12h)
    d
end

"""
`numol(x_endpts, xpts, t_endpts, tpts, num_pde, num_pae, pde_func, pinit, bc_func)`: method of
lines for `u_t = pde_func(x, t, u, u_x, u_xx)` (and algebraic equations `0 = pde_func(...)` for the
last `num_pae` entries) with the reference application's x scheme and Radau IIA in time. `u_x` is the five-point
fourth-order difference and `u_xx` is that difference applied to `u_x`; a Dirichlet value replaces `u`
at its end before differentiating and a Neumann value replaces `u_x` at its end before the second
difference. The result has `xpts` rows; the solution of each function takes `tpts` consecutive columns
(one per time). `bc_func` is a `num_pde x 3` matrix, or a function of `t` returning it, with rows
`[left right "D"|"N"]` (`"NA"` leaves one side free for first-order equations).
"""
function eq_numol(x_endpts, xpts, t_endpts, tpts, num_pde, num_pae, pde_func, pinit, bc_func)
    xe, te = _real_column(x_endpts, "numol"), _real_column(t_endpts, "numol")
    length(xe) == 2 && length(te) == 2 || eqerror("numol: x_endpts and t_endpts need two elements")
    nx, nt = _smooth_integer(xpts, "numol", "xpts"), _smooth_integer(tpts, "numol", "tpts"; minimum=2)
    npde, npae = _smooth_integer(num_pde, "numol", "num_pde"), _smooth_integer(num_pae, "numol", "num_pae"; minimum=0)
    (bc_func isa Function || bc_func isa AbstractMatrix) || eqerror("numol: bc_func must be a matrix or a function")
    pde_func isa Function && pinit isa Function || eqerror("numol: pde_func and pinit must be functions")
    nx >= 6 || eqerror("numol: there are too few spatial discretization points (at least 6)")
    count = npde + npae
    xs = collect(range(xe[1], xe[2]; length=nx))
    ts = collect(range(te[1], te[2]; length=nt))
    h = xs[2] - xs[1]
    index(k, j) = (k - 1) * nx + j
    initial = zeros(count * nx)
    for j in 1:nx
        values = _call_vector(pinit, "numol", xs[j])
        length(values) == count || eqerror("numol: pinit must return $count values")
        for k in 1:count
            initial[index(k, j)] = values[k]
        end
    end
    function rhs(t, U)
        out = zeros(count * nx)
        rows = [_boundary_row(bc_func, t, k) for k in 1:npde]
        # Per function: its values on the grid, its first and its second x derivative.
        grid = Matrix{eltype(U)}(undef, nx, count)
        dx = similar(grid)
        dxx = similar(grid)
        for k in 1:count
            c = [U[index(k, j)] for j in 1:nx]
            ends = k <= npde ? ((1, rows[k][1]), (nx, rows[k][2])) : ()
            kind = k <= npde ? rows[k][3] : ""
            if kind == "D"
                for (j, value) in ends
                    _is_marker(value, "NA") || (c[j] = value)
                end
            end
            d = _numol_derivative(c, h)
            if kind == "N"
                for (j, value) in ends
                    _is_marker(value, "NA") || (d[j] = value)
                end
            end
            grid[:, k], dx[:, k], dxx[:, k] = c, d, _numol_derivative(d, h)
        end
        for j in 1:nx
            u, ux, uxx = grid[j, :], dx[j, :], dxx[j, :]
            f = _call_vector(pde_func, "numol", xs[j], t, reshape(u, :, 1), reshape(ux, :, 1), reshape(uxx, :, 1))
            length(f) == count || eqerror("numol: pde_func must return $count values")
            for k in 1:count
                position = index(k, j)
                if k <= npde && (j == 1 || j == nx) && rows[k][3] == "D" && !_is_marker(j == 1 ? rows[k][1] : rows[k][2], "NA")
                    # A Dirichlet end is algebraic (0 in the mass matrix). A Neumann end follows the
                    # equation, with the condition as its u_x.
                    out[position] = U[position] - (j == 1 ? rows[k][1] : rows[k][2])
                else
                    out[position] = f[k]
                end
            end
        end
        out
    end
    # Mass matrix: 1 on differential rows, 0 on algebraic rows (algebraic equations and boundary conditions).
    mass = Matrix(1.0I, count * nx, count * nx)
    rows0 = [_boundary_row(bc_func, ts[1], k) for k in 1:npde]
    for k in 1:count, j in 1:nx
        algebraic = k > npde
        if k <= npde && (j == 1 || j == nx)
            value = j == 1 ? rows0[k][1] : rows0[k][2]
            algebraic = rows0[k][3] == "D" && !_is_marker(value, "NA")
        end
        algebraic && (mass[index(k, j), index(k, j)] = 0.0)
    end
    jacobian = _jacobian_function(nothing, rhs, "numol")
    tolerance = 1e-7
    states = [copy(initial)]
    y = copy(initial)
    for i in 1:(nt-1)
        y = _radau_interval(rhs, jacobian, mass, ts[i], y, ts[i+1] - ts[i], tolerance)
        push!(states, y)
    end
    result = zeros(nx, count * nt)
    for k in 1:count, i in 1:nt, j in 1:nx
        result[j, (k-1)*nt+i] = states[i][index(k, j)]
    end
    all(isfinite, result) || eqerror("numol: the solution is not finite")
    result
end

# ---------------------------------------------------------------- elliptic PDEs

"""
`relax(A, B, C, D, E, S, U, rjac)`: successive over-relaxation with Chebyshev acceleration for
`A u[i+1,j] + B u[i-1,j] + C u[i,j+1] + D u[i,j-1] + E u[i,j] = S[i,j]` on the interior of the
square `U`, whose edge holds the boundary values and the interior the initial guess. `rjac` is
the spectral radius of the Jacobi iteration. The sweeps and the stopping rule are those of Numerical
Recipes' `sor` (stop when the summed residual is below `1e-5` of the size of the source with the boundary moved to the right-hand side), which gives
the reference application's numbers digit for digit.
"""
function eq_relax(A, B, C, D, E, S, U, rjac)
    arrays = [A, B, C, D, E, S, U]
    all(a -> a isa AbstractMatrix && all(x -> x isa Real && !(x isa Unitful.AbstractQuantity), a), arrays) ||
        eqerror("relax needs real square matrices")
    n = size(U, 1)
    all(a -> size(a) == (n, n), arrays) && n >= 3 || eqerror("relax: the matrices must be square, of equal size and at least 3 x 3")
    rho = _real_bare(rjac, "relax")
    0 < rho < 1 || eqerror("relax: rjac must be between 0 and 1")
    a, b, c, d, e, s = (Float64.(real.(m)) for m in (A, B, C, D, E, S))
    u = Float64.(real.(U))
    # The size of the problem for the stopping rule: the source with the boundary values moved to the
    # right-hand side (the residual of the interior zeroed); for a zero boundary it is the sum of |S|.
    anormf = 0.0
    for i in 2:(n-1), j in 2:(n-1)
        anormf += abs(a[i, j] * (i + 1 == n ? u[i+1, j] : 0.0) + b[i, j] * (i == 2 ? u[i-1, j] : 0.0) +
                      c[i, j] * (j + 1 == n ? u[i, j+1] : 0.0) + d[i, j] * (j == 2 ? u[i, j-1] : 0.0) - s[i, j])
    end
    omega = 1.0
    for iteration in 1:20_000
        anorm = 0.0
        for parity in (0, 1)
            for i in 2:(n-1), j in 2:(n-1)
                (i + j) % 2 == parity || continue
                residual = a[i, j] * u[i+1, j] + b[i, j] * u[i-1, j] + c[i, j] * u[i, j+1] + d[i, j] * u[i, j-1] + e[i, j] * u[i, j] - s[i, j]
                anorm += abs(residual)
                e[i, j] == 0 && eqerror("relax: E has a zero on the interior")
                u[i, j] -= omega * residual / e[i, j]
            end
            omega = iteration == 1 && parity == 0 ? 1 / (1 - rho^2 / 2) : 1 / (1 - rho^2 * omega / 4)
        end
        (anorm < 1e-5 * anormf || anorm == 0) && return u
    end
    eqerror("relax did not converge")
end

# Multigrid for the Poisson problem laplacian(u) = f with zero boundary values on the unit square.
# Numerical Recipes' `mglin` (red-black Gauss-Seidel smoothing, full-weighting restriction, bilinear
# prolongation, one pre- and one post-smoothing sweep, an exact solve on the 3 x 3 grid), which
# reproduces the reference application's numbers digit for digit, including the dependence on `ncycle`.
function _mg_relax!(u, f)
    n = size(u, 1)
    h2 = (1 / (n - 1))^2
    for parity in (0, 1), i in 2:(n-1), j in 2:(n-1)
        (i + j) % 2 == parity || continue
        u[i, j] = (u[i+1, j] + u[i-1, j] + u[i, j+1] + u[i, j-1] - h2 * f[i, j]) / 4
    end
end

function _mg_residual(u, f)
    n = size(u, 1)
    h2 = (1 / (n - 1))^2
    r = zeros(n, n)
    for i in 2:(n-1), j in 2:(n-1)
        r[i, j] = f[i, j] - (u[i+1, j] + u[i-1, j] + u[i, j+1] + u[i, j-1] - 4u[i, j]) / h2
    end
    r
end

function _mg_restrict(r)
    n = size(r, 1)
    m = (n - 1) ÷ 2 + 1
    coarse = zeros(m, m)
    for I in 2:(m-1), J in 2:(m-1)
        i, j = 2I - 1, 2J - 1
        coarse[I, J] = r[i, j] / 2 + (r[i+1, j] + r[i-1, j] + r[i, j+1] + r[i, j-1]) / 8
    end
    coarse
end

function _mg_prolong(c)
    m = size(c, 1)
    n = 2m - 1
    fine = zeros(n, n)
    for I in 1:m, J in 1:m
        fine[2I-1, 2J-1] = c[I, J]
    end
    for I in 1:m, J in 1:(m-1)
        fine[2I-1, 2J] = (fine[2I-1, 2J+1] + fine[2I-1, 2J-1]) / 2
    end
    for I in 1:(m-1), J in 1:n
        isodd(J) || continue
        fine[2I, J] = (fine[2I+1, J] + fine[2I-1, J]) / 2
    end
    for I in 1:(m-1), J in 1:(m-1)
        fine[2I, 2J] = (fine[2I, 2J+1] + fine[2I, 2J-1] + fine[2I+1, 2J] + fine[2I-1, 2J]) / 4
    end
    fine
end

_mg_coarsest(f) = (u = zeros(3, 3); u[2, 2] = -f[2, 2] / 16; u)

"""
`multigrid(M, ncycle)`: solves `laplacian(u) = M` on the unit square for a `(2^k + 1)` square
source matrix `M`, with zero boundary values; `ncycle` V-cycles are done on every level of a full
multigrid sweep (so a small `ncycle` leaves an unconverged result, as in the reference application).
"""
function eq_multigrid(M, ncycle)
    M isa AbstractMatrix && all(x -> x isa Real && !(x isa Unitful.AbstractQuantity), M) || eqerror("multigrid needs a real matrix")
    n = size(M, 1)
    size(M, 2) == n && n >= 3 && ispow2(n - 1) || eqerror("multigrid: M must be a square matrix of size 2^k + 1")
    cycles = _smooth_integer(ncycle, "multigrid", "ncycle")
    levels = Matrix{Float64}[Float64.(real.(M))]
    while size(levels[end], 1) > 3
        push!(levels, _mg_restrict(levels[end]))
    end
    reverse!(levels)  # coarsest first
    u = _mg_coarsest(levels[1])
    for level in 2:length(levels)
        u = _mg_prolong(u)
        for _ in 1:cycles
            # One V-cycle from this level down to the 3 x 3 grid and back.
            rhs = Vector{Matrix{Float64}}(undef, level)
            grids = Vector{Matrix{Float64}}(undef, level)
            rhs[level], grids[level] = levels[level], u
            for k in level:-1:2
                _mg_relax!(grids[k], rhs[k])
                rhs[k-1] = _mg_restrict(_mg_residual(grids[k], rhs[k]))
                grids[k-1] = zeros(size(rhs[k-1]))
            end
            grids[1] = _mg_coarsest(rhs[1])
            for k in 2:level
                grids[k] += _mg_prolong(grids[k-1])
                _mg_relax!(grids[k], rhs[k])
            end
            u = grids[level]
        end
    end
    u
end

# ------------------------------------------------------------------ odesolve

# The unknown functions of an `odesolve` block, as the generated constraint lambdas see them.
# `y(t)` is the current value and `y′(t)` (`eq_derivative(y, t, 1)`) the current derivative.
struct OdeFunction <: Function
    value::Function
    derivative::Function
end
(f::OdeFunction)(x) = f.value(x)
function eq_derivative(f::OdeFunction, x, order=1.0)
    n = eqnum(order)
    (n isa Real && isinteger(n) && n >= 0) || eqerror("the order of a derivative must be a non-negative integer")
    f.derivative(eqnum(x), Int(n))
end

function _ode_number(value)
    value isa Number && !(value isa Unitful.AbstractQuantity) && imag(value) == 0 ||
        eqerror("odesolve: the equations must be real and unitless")
    Float64(real(value))
end

function _hermite(xs, ys, dys, x)
    ascending = xs[end] >= xs[1]
    low, high = ascending ? (xs[1], xs[end]) : (xs[end], xs[1])
    tolerance = 1e-9 * max(1.0, abs(low), abs(high))
    low - tolerance <= x <= high + tolerance || eqerror("odesolve: $x is outside the solution interval [$low, $high]")
    i = ascending ? clamp(searchsortedlast(xs, x), 1, length(xs) - 1) : clamp(searchsortedfirst(xs, x; rev=true) - 1, 1, length(xs) - 1)
    h = xs[i+1] - xs[i]
    s = (x - xs[i]) / h
    h00, h10, h01, h11 = 2s^3 - 3s^2 + 1, s^3 - 2s^2 + s, -2s^3 + 3s^2, s^3 - s^2
    h00 * ys[i] + h10 * h * dys[i] + h01 * ys[i+1] + h11 * h * dys[i+1]
end

"""
`odesolve(vf, b, [intvls])` in a `Given` block: `eq_odesolve(equations, conditions, n, b, intvls,
as_vector)`. The equations are lambdas `(t, y1, ..., yn) -> lhs - rhs` of the independent variable
and the unknown functions, the conditions lambdas `(y1, ..., yn) -> lhs - rhs` of constraints
such as `y(0) = 1` or `y′(a) = 2` (all at one point, or at several points for a boundary value
problem, solved by shooting from the lowest point). The equations may be implicit in the highest
derivatives (they are solved with Newton's method). The result is the solution as a function of the
independent variable (a column of functions for a vector `vf`), evaluated by cubic Hermite
interpolation between `intvls + 1` points.
"""
function eq_odesolve(equations, conditions, count, b, intvls, as_vector)
    n = Int(count)
    length(equations) == n || eqerror("odesolve: $n unknown functions need $n differential equations, found $(length(equations))")
    orders = zeros(Int, n)
    probes = [OdeFunction(x -> (orders[i] = max(orders[i], 0); 1.0), (x, k) -> (orders[i] = max(orders[i], k); 1.0)) for i in 1:n]
    for equation in equations
        equation(0.0, probes...)
    end
    all(>=(1), orders) || eqerror("odesolve: every unknown function needs a derivative in the equations")
    offsets = cumsum([0; orders[1:(end-1)]])
    total = sum(orders)
    length(conditions) == total || eqerror("odesolve: the equations need $total initial or boundary conditions, found $(length(conditions))")

    unknowns(t, s, z) = [begin
        d = vcat(s[(offsets[i]+1):(offsets[i]+orders[i])], z[i])
        OdeFunction(x -> d[1], (x, k) -> k <= orders[i] ? d[k+1] : eqerror("odesolve: the derivative of order $k exceeds the order of the equation"))
    end for i in 1:n]
    function highest(t, s)
        residual = z -> [_ode_number(equation(t, unknowns(t, s, z)...)) for equation in equations]
        z = zeros(n)
        for _ in 1:40
            r = residual(z)
            J = _numeric_jacobian(residual, z, r)
            step = try
                J \ r
            catch
                eqerror("odesolve: the equations cannot be solved for the highest derivatives")
            end
            z = z .- step
            all(isfinite, z) || eqerror("odesolve: the equations cannot be solved for the highest derivatives")
            maximum(abs.(step) ./ (1.0 .+ abs.(z))) <= 1e-13 && break
        end
        z
    end
    function rhs(t, s)
        z = highest(t, s)
        out = zeros(total)
        for i in 1:n
            for k in 1:(orders[i]-1)
                out[offsets[i]+k] = s[offsets[i]+k+1]
            end
            out[offsets[i]+orders[i]] = z[i]
        end
        out
    end

    # Points of the conditions.
    points = Float64[]
    condition_probes = [OdeFunction(x -> (push!(points, _ode_number(x)); 0.0), (x, k) -> (push!(points, _ode_number(x)); 0.0)) for _ in 1:n]
    for condition in conditions
        condition(condition_probes...)
    end
    isempty(points) && eqerror("odesolve needs initial or boundary conditions")
    start = minimum(points)
    distinct = sort(unique(points))
    tolerance = _ode_tolerance()
    conditions_at(s0) = begin
        table = Dict{Float64,Vector{Float64}}(start => s0)
        state, position = s0, start
        for p in distinct
            p == start && continue
            state = _dopri_interval(rhs, position, state, p - position, tolerance * 1e-2)
            position = p
            table[p] = state
        end
        lookup(i, k, x) = begin
            s = table[x]
            k < orders[i] ? s[offsets[i]+k+1] : highest(x, s)[i]
        end
        functions = [OdeFunction(x -> lookup(i, 0, _ode_number(x)), (x, k) -> lookup(i, k, _ode_number(x))) for i in 1:n]
        [_ode_number(condition(functions...)) for condition in conditions]
    end
    s0, residual = _lm(conditions_at, zeros(total); tolerance=1e-14)
    norm(residual, Inf) <= 1e-7 * (1 + norm(s0, Inf)) || eqerror("odesolve: the conditions cannot be satisfied")

    end_point = _real_bare(b, "odesolve")
    intervals = intvls === nothing ? 1000 : _smooth_integer(intvls, "odesolve", "intvls")
    end_point != start || eqerror("odesolve: b must differ from the starting point $start")
    grid = collect(range(start, end_point; length=intervals + 1))
    states = [s0]
    state = s0
    for i in 1:intervals
        state = _dopri_interval(rhs, grid[i], state, grid[i+1] - grid[i], tolerance)
        push!(states, state)
    end
    values = [[s[offsets[i]+1] for s in states] for i in 1:n]
    slopes = [[orders[i] >= 2 ? s[offsets[i]+2] : highest(grid[j], s)[i] for (j, s) in enumerate(states)] for i in 1:n]
    solutions = Function[x -> _hermite(grid, values[i], slopes[i], _ode_number(x)) for i in 1:n]
    n == 1 && !as_vector ? solutions[1] : reshape(Any[solutions...], :, 1)
end
