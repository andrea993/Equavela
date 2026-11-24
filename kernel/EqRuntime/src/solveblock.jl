# Solve blocks: Given ... Find / Minerr / Minimize / Maximize.
#
# The generator compiles each constraint line to `eq_constraint(op, lhs, rhs)`, where `lhs`
# and `rhs` are Julia lambdas of the unknowns, in the order of the solving function's
# argument list. The solvers take the constraints, the guess values (the unknowns' values
# above the block) and, for Minimize/Maximize, the objective as a lambda of the unknowns.
# Unknowns are real scalars or real vectors/matrices, with or without a unit; the lambdas
# receive them in the unit of the guess, so worksheet functions see ordinary quantities.
# The algorithm and the stopping rules come as keyword arguments (`SolverOptions`); residuals
# and objectives stay generic over `Real`, so derivatives are taken by automatic
# differentiation (`differentiation.jl`).

"Default the reference application constraint tolerance (the system variable CTOL)."
const DEFAULT_CTOL = 0.001

"the reference application's dynamically scoped constraint tolerance `CTOL`."
const CTOL = ScopedValue(DEFAULT_CTOL)

ctol() = CTOL[]

function with_ctol(f, value)
    value isa Real && isfinite(value) && value >= 0 || eqerror("CTOL must be a non-negative number")
    with(f, CTOL => Float64(value))
end

"One constraint line: `lhs op rhs` with `op` one of `:eq :lt :gt :le :ge :ne`."
struct EqConstraint
    op::Symbol
    lhs::Function
    rhs::Function
end

function eq_constraint(op, lhs, rhs)
    op in (:eq, :lt, :gt, :le, :ge, :ne) || eqerror("solve block: unknown constraint operator $op")
    (lhs isa Function && rhs isa Function) || eqerror("solve block: a constraint needs two expressions")
    EqConstraint(op, lhs, rhs)
end

eq_constraint(args...) = eqerror("solve block: a constraint takes an operator and two expressions")

# ---- unknowns -------------------------------------------------------------------------------

"An unknown: its shape, its unit (`nothing` for none) and its offset in the flat vector."
struct _Unknown
    rows::Int
    cols::Int
    scalar::Bool
    unit::Any
    offset::Int
end

function _pack(guesses, name)
    unknowns = _Unknown[]
    start = Float64[]
    for g in guesses
        g = eqnum_or_array(g, name)
        if g isa AbstractArray
            isempty(g) && eqerror("$name: a guess value must not be empty")
            u = nothing
            vals = Float64[]
            for e in g
                (e isa Number) || eqerror("$name needs numbers as guess values")
                e = eqnum(e)
                if e isa Unitful.AbstractQuantity
                    u === nothing && (u = unit(e))
                    e = ustrip(uconvert(u, e))
                elseif u !== nothing
                    eqerror("$name: all elements of a guess value need the same unit")
                end
                (e isa Real || iszero(imag(e))) || eqerror("$name solves for real values; use real guesses")
                push!(vals, Float64(real(e)))
            end
            push!(unknowns, _Unknown(size(g, 1), size(g, 2), false, u, length(start)))
            append!(start, vals)
        else
            g isa Number || eqerror("$name needs numbers as guess values")
            g = eqnum(g)
            u = g isa Unitful.AbstractQuantity ? unit(g) : nothing
            v = u === nothing ? g : ustrip(g)
            (v isa Real || iszero(imag(v))) || eqerror("$name solves for real values; use real guesses")
            push!(unknowns, _Unknown(1, 1, true, u, length(start)))
            push!(start, Float64(real(v)))
        end
    end
    isempty(unknowns) && eqerror("$name needs at least one unknown")
    unknowns, start
end

eqnum_or_array(g, name) = g isa AbstractArray ? g : (g isa Number ? g : eqerror("$name needs numbers as guess values"))

"The values of the unknowns for the flat vector `z`, as the lambdas see them."
function _values(unknowns, z)
    map(unknowns) do k
        if k.scalar
            k.unit === nothing ? z[k.offset+1] : z[k.offset+1] * k.unit
        else
            m = reshape(z[k.offset+1:k.offset+k.rows*k.cols], k.rows, k.cols)
            k.unit === nothing ? m : m .* k.unit
        end
    end
end

"A number or array in base units as a flat real vector (units dropped)."
function _flat(value, what)
    parts = value isa AbstractArray ? collect(value) : [value]
    out = Any[]
    for e in parts
        e isa Number || eqerror("solve block: $what must be a number or a matrix of numbers")
        e = eqnum(e)
        e isa Unitful.AbstractQuantity && (e = ustrip(upreferred(e)))
        (e isa Real || iszero(imag(e))) || eqerror("solve block: $what is complex")
        # `float` keeps the dual numbers of automatic differentiation.
        push!(out, float(real(e)))
    end
    isempty(out) ? Float64[] : map(identity, out)
end

"The dimensions of the elements of a number or array (`NoDims` for plain numbers)."
_dims(value) = [Unitful.dimension(eqnum(e)) for e in (value isa AbstractArray ? collect(value) : [value])]

function _sides(c::EqConstraint, vals)
    lv, rv = c.lhs(vals...), c.rhs(vals...)
    l = _flat(lv, "the left side of a constraint")
    r = _flat(rv, "the right side of a constraint")
    ld, rd = _dims(lv), _dims(rv)
    if length(l) != length(r)
        length(r) == 1 && (r = fill(r[1], length(l)); rd = fill(rd[1], length(l)))
        length(l) == 1 && (l = fill(l[1], length(r)); ld = fill(ld[1], length(r)))
        length(l) == length(r) || eqerror("solve block: the sides of a constraint have different sizes")
    end
    ld == rd || eqerror("solve block: the sides of a constraint have different units")
    l, r
end

"""
Violations of all constraints at `z`: one entry per equation element (the difference, so
that its absolute value is the violation) and per inequality element (0 when satisfied,
else the amount by which it is violated). `:ne` is satisfied when the sides differ by more
than `CTOL`.
"""
function _violations(constraints, unknowns, z)
    vals = _values(unknowns, z)
    out = Any[]
    limit = ctol()
    for c in constraints
        l, r = _sides(c, vals)
        for (a, b) in zip(l, r)
            d = a - b
            v = c.op === :eq ? d :
                c.op in (:lt, :le) ? max(d, 0.0) :
                c.op in (:gt, :ge) ? max(-d, 0.0) :
                (abs(d) > limit ? 0.0 : limit - abs(d) + limit)
            (isfinite(v)) || eqerror("solve block: a constraint is not finite at the current values")
            push!(out, v)
        end
    end
    isempty(out) ? Float64[] : map(identity, out)
end


# ---- algorithms and options -----------------------------------------------------------------

const FIND_ALGORITHMS = ("auto", "levenberg-marquardt", "trust-region", "newton")
const OPTIMIZE_ALGORITHMS = ("auto", "slsqp", "mma", "ccsaq", "lbfgs", "cobyla", "nelder-mead", "penalty")

"The algorithm and the stopping rules of one solve (the region's `numeric` choices)."
struct SolverOptions
    algorithm::String
    derivatives::Symbol
    max_evaluations::Int
    max_time::Float64
    x_tolerance::Float64
    f_tolerance::Float64
end

function _positive(value, what; integer=false)
    v = eqnum(value)
    v isa Real && isfinite(v) && v > 0 && (!integer || isinteger(v)) ||
        eqerror("solve block: $what must be a positive $(integer ? "integer" : "number")")
    integer ? Int(v) : Float64(v)
end

function solver_options(name, algorithms; algorithm=nothing, derivatives=nothing, max_evaluations=nothing,
        max_time=nothing, x_tolerance=nothing, f_tolerance=nothing)
    chosen = algorithm === nothing ? "auto" : String(algorithm)
    chosen in algorithms || eqerror("$name: unknown algorithm `$chosen`; use one of $(join(algorithms, ", "))")
    SolverOptions(chosen, derivative_method(derivatives),
        max_evaluations === nothing ? 10_000 : _positive(max_evaluations, "the maximum number of evaluations"; integer=true),
        max_time === nothing ? Inf : _positive(max_time, "the maximum time"),
        x_tolerance === nothing ? 1.0e-10 : _positive(x_tolerance, "the x tolerance"),
        f_tolerance === nothing ? 1.0e-12 : _positive(f_tolerance, "the f tolerance"))
end

"Counts the evaluations of a solve and stops it at the limits of its options."
mutable struct _Budget
    used::Int
    limit::Int
    deadline::Float64
end
_Budget(options::SolverOptions) = _Budget(0, options.max_evaluations, time() + options.max_time)
_spent(b::_Budget) = b.used >= b.limit || time() > b.deadline
_stop_reason(b::_Budget) = b.used >= b.limit ? "the maximum number of evaluations ($(b.limit))" : "the maximum time"

# ---- Find and Minerr ------------------------------------------------------------------------

"Minimises `‖f(z)‖²` from `z` by Levenberg-Marquardt; returns the final point."
function _levenberg_marquardt(f, z, options::SolverOptions, budget::_Budget)
    r = f(z)
    budget.used += 1
    isempty(r) && return z
    cost = sum(abs2, r)
    λ = 1.0e-3
    while !_spent(budget)
        cost == 0 && break
        J = solver_jacobian(f, z, r, options.derivatives)
        budget.used += 1
        A = J' * J
        g = J' * r
        improved = false
        for _ in 1:30
            _spent(budget) && break
            step = -((A + λ * Diagonal(max.(diag(A), 1.0e-12))) \ g)
            trial = z .+ step
            rt = try f(trial) catch; nothing end
            budget.used += 1
            if rt !== nothing
                ct = sum(abs2, rt)
                if ct < cost
                    small = norm(step) <= options.x_tolerance * (1 + norm(z)) || cost - ct <= 1.0e-18 * cost
                    z, r, cost = trial, rt, ct
                    λ = max(λ / 10, 1.0e-12)
                    improved = true
                    small && return z
                    break
                end
            end
            λ *= 10
        end
        improved || break
    end
    z
end

_square_equations(constraints, unknowns, z) =
    all(c -> c.op === :eq, constraints) && length(_violations(constraints, unknowns, z)) == length(z)

"`trust-region` or `newton` of NLsolve on a square system of equations."
function _nlsolve(f, z, method, options::SolverOptions)
    result = NLsolve.nlsolve(
        (F, x) -> (F .= f(x)),
        (J, x) -> (J .= solver_jacobian(f, x, f(x), options.derivatives)),
        z; method, xtol=options.x_tolerance, ftol=1.0e-14, iterations=options.max_evaluations)
    result.zero
end

function _find_point(constraints, unknowns, z0, options::SolverOptions, name)
    f = z -> _violations(constraints, unknowns, z)
    algorithm = options.algorithm
    if algorithm in ("trust-region", "newton")
        _square_equations(constraints, unknowns, z0) || eqerror(
            "$name: $algorithm solves square systems of equations only (as many equations as unknowns, no inequalities); use levenberg-marquardt")
        return _nlsolve(f, z0, algorithm == "newton" ? :newton : :trust_region, options), nothing
    end
    budget = _Budget(options)
    z = _levenberg_marquardt(f, z0, options, budget)
    stopped = _spent(budget) ? _stop_reason(budget) : nothing
    if algorithm == "auto" && !all(v -> abs(v) <= ctol(), f(z)) && _square_equations(constraints, unknowns, z0)
        candidate = try
            _nlsolve(f, z0, :trust_region, options)
        catch error
            error isa EqError && rethrow()
            nothing
        end
        if candidate !== nothing && all(isfinite, candidate) && sum(abs2, f(candidate)) < sum(abs2, f(z))
            z = candidate
        end
    end
    z, stopped
end

_check_constraints(constraints, name) =
    (constraints isa AbstractVector && all(c -> c isa EqConstraint, constraints)) ||
    eqerror("$name: the constraints must come from a Given block")

function _result(unknowns, z)
    vals = _values(unknowns, z)
    length(vals) == 1 ? vals[1] : eq_stack_values(vals)
end

# A solve block with several unknowns returns a column vector of them (the reference application: a vector of
# the scalar solutions); matrix-valued unknowns are not combined.
function eq_stack_values(vals)
    all(v -> !(v isa AbstractArray), vals) ||
        eqerror("solve block: several unknowns must all be scalars to be returned as a vector")
    reshape(collect(vals), :, 1)
end

"""
    eq_find(constraints, guesses; algorithm, derivatives, max_evaluations, max_time, x_tolerance)

the reference application `Find(x, y, ...)` for a Given block. Solves the constraints from the
guess values with the chosen algorithm (`auto` by default: Levenberg-Marquardt, then the trust
region method on a square system of equations); succeeds when every violation is within `CTOL`
(base units). One unknown returns its value, several return a column vector. Failure is an
`EqError` ("try other guess values").
"""
function eq_find(constraints, guesses; options...)
    _check_constraints(constraints, "Find")
    settings = solver_options("Find", FIND_ALGORITHMS; options...)
    unknowns, z0 = _pack(guesses, "Find")
    isempty(constraints) && eqerror("Find needs at least one constraint after Given")
    z, stopped = _find_point(constraints, unknowns, z0, settings, "Find")
    if !all(v -> abs(v) <= ctol(), _violations(constraints, unknowns, z))
        stopped === nothing || eqerror("Find stopped at $stopped before reaching a solution; raise it or try other guess values")
        eqerror("Find did not converge to a solution; try other guess values, another algorithm or use Minerr")
    end
    _result(unknowns, z)
end

"""
    eq_minerr(constraints, guesses; options...)

the reference application `Minerr(x, ...)`: the same iteration as `eq_find`, but the best approximation is
returned even when the constraints are not met (the user must check the result).
"""
function eq_minerr(constraints, guesses; options...)
    _check_constraints(constraints, "Minerr")
    settings = solver_options("Minerr", FIND_ALGORITHMS; options...)
    unknowns, z0 = _pack(guesses, "Minerr")
    isempty(constraints) && eqerror("Minerr needs at least one constraint after Given")
    z, _ = _find_point(constraints, unknowns, z0, settings, "Minerr")
    _result(unknowns, z)
end

# ---- Minimize and Maximize ------------------------------------------------------------------

function _objective(objective, unknowns, z)
    v = objective(_values(unknowns, z)...)
    f = _flat(v, "the objective")
    length(f) == 1 || eqerror("Minimize/Maximize: the objective must be a scalar")
    f[1]
end

"""
The constraints as NLopt takes them: the equation differences (zero when met) and the
inequality excesses (at most zero when met), one entry per element.
"""
function _nlopt_sides(constraints, unknowns, z)
    vals = _values(unknowns, z)
    eqs, ineqs = Any[], Any[]
    for c in constraints
        l, r = _sides(c, vals)
        for (a, b) in zip(l, r)
            c.op === :eq ? push!(eqs, a - b) :
            c.op in (:lt, :le) ? push!(ineqs, a - b) :
            push!(ineqs, b - a)
        end
    end
    (isempty(eqs) ? Float64[] : map(identity, eqs)), (isempty(ineqs) ? Float64[] : map(identity, ineqs))
end

const _NLOPT = Dict("slsqp" => :LD_SLSQP, "mma" => :LD_MMA, "ccsaq" => :LD_CCSAQ, "lbfgs" => :LD_LBFGS,
    "cobyla" => :LN_COBYLA, "nelder-mead" => :LN_NELDERMEAD)
const _TAKES_EQUATIONS = ("slsqp", "cobyla", "penalty")
const _TAKES_INEQUALITIES = ("slsqp", "mma", "ccsaq", "cobyla", "penalty")

function _nlopt(objective, constraints, unknowns, z0, sign, algorithm, options::SolverOptions)
    n = length(z0)
    F = z -> sign * _objective(objective, unknowns, z)
    eq0, in0 = _nlopt_sides(constraints, unknowns, z0)
    opt = NLopt.Opt(_NLOPT[algorithm], n)
    NLopt.maxeval!(opt, options.max_evaluations)
    isfinite(options.max_time) && NLopt.maxtime!(opt, options.max_time)
    NLopt.xtol_rel!(opt, options.x_tolerance)
    NLopt.ftol_rel!(opt, options.f_tolerance)
    method = options.derivatives
    NLopt.min_objective!(opt, (z, grad) -> begin
        length(grad) > 0 && (grad .= solver_gradient(F, z, method))
        Float64(F(z))
    end)
    tolerance = ctol() / 10
    if !isempty(eq0)
        ceq = z -> _nlopt_sides(constraints, unknowns, z)[1]
        NLopt.equality_constraint!(opt, (res, z, grad) -> begin
            r = ceq(z)
            res .= r
            length(grad) > 0 && (grad .= transpose(solver_jacobian(ceq, z, r, method)))
        end, fill(tolerance, length(eq0)))
    end
    if !isempty(in0)
        cin = z -> _nlopt_sides(constraints, unknowns, z)[2]
        NLopt.inequality_constraint!(opt, (res, z, grad) -> begin
            r = cin(z)
            res .= r
            length(grad) > 0 && (grad .= transpose(solver_jacobian(cin, z, r, method)))
        end, fill(tolerance, length(in0)))
    end
    _, z, reason = NLopt.optimize(opt, copy(z0))
    z, reason
end

function _bfgs(f, z, options::SolverOptions)
    n = length(z)
    grad(z) = solver_gradient(f, z, options.derivatives)
    H = Matrix{Float64}(I, n, n)
    g = grad(z)
    fz = f(z)
    for _ in 1:400
        norm(g) <= 1.0e-10 && break
        d = -(H * g)
        dot(d, g) >= 0 && (H = Matrix{Float64}(I, n, n); d = -g)
        t = 1.0
        accepted = false
        for _ in 1:60
            zt = z .+ t .* d
            ft = f(zt)
            if isfinite(ft) && ft <= fz + 1.0e-4 * t * dot(g, d)
                accepted = true
                break
            end
            t /= 2
        end
        accepted || break
        zn = z .+ t .* d
        gn = grad(zn)
        s, y = zn .- z, gn .- g
        sy = dot(s, y)
        if sy > 1.0e-12
            ρ = 1 / sy
            V = I - ρ * s * y'
            H = V * H * V' + ρ * s * s'
        end
        done = abs(fz - f(zn)) <= options.f_tolerance * max(1.0, abs(fz)) && norm(s) <= options.x_tolerance * (1 + norm(z))
        z, g, fz = zn, gn, f(zn)
        done && break
    end
    z
end

"The quadratic penalty method: growing weights, each stage minimised by BFGS."
function _penalty(objective, constraints, unknowns, z, sign, options::SolverOptions)
    for μ in (1.0e1, 1.0e3, 1.0e5, 1.0e7)
        penalized = w -> begin
            v = _violations(constraints, unknowns, w)
            sign * _objective(objective, unknowns, w) + μ * sum(abs2, v)
        end
        z = _bfgs(penalized, z, options)
    end
    z
end

function _algorithms_for(has_equations, has_inequalities, has_ne)
    has_ne && return ["penalty"]
    filter(a -> a != "auto" && (!has_equations || a in _TAKES_EQUATIONS) &&
        (!has_inequalities || a in _TAKES_INEQUALITIES), collect(OPTIMIZE_ALGORITHMS))
end

function _optimize(objective, constraints, guesses, sign, name; options...)
    objective isa Function || eqerror("$name needs the function to optimize")
    _check_constraints(constraints, name)
    settings = solver_options(name, OPTIMIZE_ALGORITHMS; options...)
    unknowns, z0 = _pack(guesses, name)
    has_ne = any(c -> c.op === :ne, constraints)
    has_eq = any(c -> c.op === :eq, constraints)
    has_in = any(c -> c.op in (:lt, :le, :gt, :ge), constraints)
    met(z) = all(v -> abs(v) <= ctol(), _violations(constraints, unknowns, z))
    algorithm = settings.algorithm
    if algorithm != "auto"
        allowed = _algorithms_for(has_eq, has_in, has_ne)
        algorithm in allowed || eqerror(
            "$name: $algorithm cannot take the constraints of this block; use $(join(allowed, ", "))")
    end
    candidates = algorithm != "auto" ? [algorithm] : has_ne ? ["penalty"] : ["slsqp", "cobyla"]
    stopped = nothing
    for candidate in candidates
        z, reason = if candidate == "penalty"
            _penalty(objective, constraints, unknowns, copy(z0), sign, settings), :SUCCESS
        else
            try
                _nlopt(objective, constraints, unknowns, z0, sign, candidate, settings)
            catch error
                (error isa EqError || length(candidates) == 1) && rethrow()
                continue
            end
        end
        reason in (:MAXEVAL_REACHED, :MAXTIME_REACHED) &&
            (stopped = reason === :MAXEVAL_REACHED ? "the maximum number of evaluations ($(settings.max_evaluations))" : "the maximum time")
        all(isfinite, z) && met(z) && return _result(unknowns, z)
    end
    stopped === nothing || eqerror("$name stopped at $stopped before the constraints were met; raise it or try other guess values")
    eqerror("$name: the constraints cannot be satisfied; try other guess values or another algorithm")
end

"""
    eq_minimize(objective, constraints, guesses; algorithm, derivatives, max_evaluations, max_time, x_tolerance, f_tolerance)
    eq_maximize(objective, constraints, guesses; ...)

the reference application `Minimize(f, x, ...)` / `Maximize(f, x, ...)`. `objective` is a lambda of
the unknowns. The chosen algorithm (`auto` by default: NLopt's SLSQP, then COBYLA, and the
penalty method when a constraint is `≠`) minimises it under the constraints (possibly none);
the result is accepted when all violations are within `CTOL`.
"""
eq_minimize(objective, constraints, guesses; options...) = _optimize(objective, constraints, guesses, 1.0, "Minimize"; options...)
eq_maximize(objective, constraints, guesses; options...) = _optimize(objective, constraints, guesses, -1.0, "Maximize"; options...)
