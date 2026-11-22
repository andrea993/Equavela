# Solve blocks: Given ... Find / Minerr / Minimize / Maximize.
#
# The generator compiles each constraint line to `eq_constraint(op, lhs, rhs)`, where `lhs`
# and `rhs` are Julia lambdas of the unknowns, in the order of the solving function's
# argument list. The solvers take the constraints, the guess values (the unknowns' values
# above the block) and, for Minimize/Maximize, the objective as a lambda of the unknowns.
# Unknowns are real scalars or real vectors/matrices, with or without a unit; the lambdas
# receive them in the unit of the guess, so worksheet functions see ordinary quantities.

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
    out = Float64[]
    for e in parts
        e isa Number || eqerror("solve block: $what must be a number or a matrix of numbers")
        e = eqnum(e)
        e isa Unitful.AbstractQuantity && (e = ustrip(upreferred(e)))
        (e isa Real || iszero(imag(e))) || eqerror("solve block: $what is complex")
        push!(out, Float64(real(e)))
    end
    out
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
    out = Float64[]
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
    out
end

# ---- Find and Minerr: Levenberg-Marquardt ---------------------------------------------------

const _LM_ITERATIONS = 400

function _jacobian(f, z, r)
    n, m = length(z), length(r)
    J = zeros(m, n)
    for j in 1:n
        h = 1.0e-7 * max(1.0, abs(z[j]))
        zp = copy(z); zp[j] += h
        J[:, j] = (f(zp) .- r) ./ h
    end
    J
end

"Minimises `‖f(z)‖²` from `z`; returns the final point."
function _levenberg_marquardt(f, z)
    r = f(z)
    isempty(r) && return z
    cost = sum(abs2, r)
    λ = 1.0e-3
    for _ in 1:_LM_ITERATIONS
        cost == 0 && break
        J = _jacobian(f, z, r)
        A = J' * J
        g = J' * r
        improved = false
        for _ in 1:30
            step = -((A + λ * Diagonal(max.(diag(A), 1.0e-12))) \ g)
            trial = z .+ step
            rt = try f(trial) catch; nothing end
            if rt !== nothing
                ct = sum(abs2, rt)
                if ct < cost
                    small = norm(step) <= 1.0e-14 * (1 + norm(z)) || cost - ct <= 1.0e-18 * cost
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
    eq_find(constraints, guesses)

the reference application `Find(x, y, ...)` for a Given block. Solves the constraints from the guess values
by Levenberg-Marquardt on the equation residuals and the inequality violations; succeeds
when every violation is within `CTOL` (base units). One unknown returns its value, several
return a column vector. Failure is an `EqError` ("try other guess values").
"""
function eq_find(constraints, guesses)
    _check_constraints(constraints, "Find")
    unknowns, z0 = _pack(guesses, "Find")
    isempty(constraints) && eqerror("Find needs at least one constraint after Given")
    f = z -> _violations(constraints, unknowns, z)
    z = _levenberg_marquardt(f, z0)
    all(v -> abs(v) <= ctol(), f(z)) ||
        eqerror("Find did not converge to a solution; try other guess values or use Minerr")
    _result(unknowns, z)
end

"""
    eq_minerr(constraints, guesses)

the reference application `Minerr(x, ...)`: the same iteration as `eq_find`, but the best approximation is
returned even when the constraints are not met (the user must check the result).
"""
function eq_minerr(constraints, guesses)
    _check_constraints(constraints, "Minerr")
    unknowns, z0 = _pack(guesses, "Minerr")
    isempty(constraints) && eqerror("Minerr needs at least one constraint after Given")
    f = z -> _violations(constraints, unknowns, z)
    _result(unknowns, _levenberg_marquardt(f, z0))
end

# ---- Minimize and Maximize: penalty method with BFGS ----------------------------------------

function _objective(objective, unknowns, z)
    v = objective(_values(unknowns, z)...)
    f = _flat(v, "the objective")
    length(f) == 1 || eqerror("Minimize/Maximize: the objective must be a scalar")
    f[1]
end

function _bfgs(f, z)
    n = length(z)
    grad(z) = map(1:n) do j
        h = 1.0e-6 * max(1.0, abs(z[j]))
        zp = copy(z); zp[j] += h
        zm = copy(z); zm[j] -= h
        (f(zp) - f(zm)) / (2h)
    end
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
        done = abs(fz - f(zn)) <= 1.0e-14 * max(1.0, abs(fz)) && norm(s) <= 1.0e-10 * (1 + norm(z))
        z, g, fz = zn, gn, f(zn)
        done && break
    end
    z
end

function _optimize(objective, constraints, guesses, sign, name)
    objective isa Function || eqerror("$name needs the function to optimize")
    _check_constraints(constraints, name)
    unknowns, z = _pack(guesses, name)
    for μ in (1.0e1, 1.0e3, 1.0e5, 1.0e7)
        penalized = w -> begin
            v = _violations(constraints, unknowns, w)
            sign * _objective(objective, unknowns, w) + μ * sum(abs2, v)
        end
        z = _bfgs(penalized, z)
    end
    viol = _violations(constraints, unknowns, z)
    all(v -> abs(v) <= ctol(), viol) ||
        eqerror("$name: the constraints cannot be satisfied; try other guess values")
    _result(unknowns, z)
end

"""
    eq_minimize(objective, constraints, guesses)
    eq_maximize(objective, constraints, guesses)

the reference application `Minimize(f, x, ...)` / `Maximize(f, x, ...)`. `objective` is a lambda of the
unknowns. Constraints (possibly none) are enforced by a quadratic penalty with growing
weight, each stage minimised by BFGS with finite-difference gradients; the result is
accepted when all violations are within `CTOL`.
"""
eq_minimize(objective, constraints, guesses) = _optimize(objective, constraints, guesses, 1.0, "Minimize")
eq_maximize(objective, constraints, guesses) = _optimize(objective, constraints, guesses, -1.0, "Maximize")
