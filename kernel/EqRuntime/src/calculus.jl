# Numeric calculus: the definite integral `∫[x ∈ a..b] f(x)` and the derivatives
# `ⅆ[x^n] f(x)`, `∂[x] f(x)` and `f′(x)`.
#
# Like `root`, the generator passes the expression as a lambda of the variable.
# `eq_integral(x -> f, a, b)`, `eq_derivative(x -> f, x0)` and
# `eq_derivative(x -> f, x0, n)`; `f′(x)` is `eq_derivative(f, x, 1)`.
#
# Choices where the spec is silent ().
# - Integral: adaptive Gauss-Kronrod (7, 15) with global bisection of the interval of
#   largest error estimate; the relative accuracy target is `max(TOL * 1e-6, 1e-14)`
#   (1e-9 for the default TOL = 0.001), with an absolute floor of `50 eps` times the
#   integral of |f|. Infinite limits (`∞`, `-∞`) use the variable transforms
#   x = a + t/(1-t), x = b - t/(1-t) and x = t/(1-t^2); reversed limits negate. The
#   integrand may be a real or complex scalar, a matrix (integrated elementwise) or a
#   quantity.
# - Derivative: central differences of order n with Ridders' extrapolation (a Neville
#   tableau in the step size), any non-negative integer order, real or complex scalars
#   and matrices as values.

const _GK_NODES = (
    0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
    0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
    0.586087235467691130294144838258730, 0.405845151377397166906606412076961,
    0.207784955007898467600689403773245, 0.0)
const _GK_WEIGHTS = (
    0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
    0.104790010322250183839876322541518, 0.140653259715525918745189590510238,
    0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
    0.204432940075298892414161999234649, 0.209482141084727828012999174891714)
# Gauss weights of the 7-point rule at the nodes 2, 4, 6 and 8 above.
const _G_WEIGHTS = (
    0.129484966168869693270611432679082, 0.279705391489276667901467771423780,
    0.381830050505118944950369775488975, 0.417959183673469387755102040816327)

const _QUAD_MAX_INTERVALS = 600

"Relative accuracy target derived from TOL."
_calculus_rtol() = max(tol() * 1.0e-6, 1.0e-14)

"""
Wraps the user lambda: the variable is passed as a plain number times `xunit`, the result
is returned as a plain number or matrix in the unit of the first value; `yunit[]` holds
that unit (`nothing` for none, `missing` before the first call).
"""
function _calculus_eval(f, xunit, what)
    yunit = Ref{Any}(missing)
    function evaluate(t)
        value = eqnum(f(xunit === nothing ? t : t * xunit))
        if value isa AbstractMatrix
            all(element -> element isa Number && !(element isa Unitful.AbstractQuantity), value) ||
                eqerror("$what: arrays with units or non-numbers are not supported")
            value = float.(map(eqnum, value))
            plain_unit = nothing
        elseif value isa Unitful.AbstractQuantity
            plain_unit = unit(value)
        elseif value isa Number
            plain_unit = nothing
        else
            eqerror("$what: the expression must evaluate to a number or a matrix")
        end
        if yunit[] === missing
            yunit[] = plain_unit
        end
        if plain_unit === nothing
            yunit[] === nothing || eqerror("$what: the expression has inconsistent units")
        else
            yunit[] === nothing && eqerror("$what: the expression has inconsistent units")
            value = try
                ustrip(uconvert(yunit[], value))
            catch error
                error isa Unitful.DimensionError &&
                    eqerror("$what: the expression has inconsistent units")
                rethrow()
            end
        end
        value isa Number && (value = float(value))
        all(isfinite, value) || eqerror("$what: the expression is not finite at $(t)")
        value
    end
    evaluate, yunit
end

_with_unit(value, unit) = unit === nothing ? value : value * unit

# ----------------------------------------------------------------------------- integral

"One Gauss-Kronrod interval: (K15 estimate, error estimate, integral of |g|)."
function _gk15(g, a, b)
    center = (a + b) / 2
    half = (b - a) / 2
    fc = g(center)
    kronrod = _GK_WEIGHTS[8] * fc
    gauss = _G_WEIGHTS[4] * fc
    resabs = _GK_WEIGHTS[8] * norm(fc)
    for index in 1:7
        offset = half * _GK_NODES[index]
        f1 = g(center - offset)
        f2 = g(center + offset)
        pair = f1 + f2
        kronrod = kronrod + _GK_WEIGHTS[index] * pair
        iseven(index) && (gauss = gauss + _G_WEIGHTS[index ÷ 2] * pair)
        resabs += _GK_WEIGHTS[index] * (norm(f1) + norm(f2))
    end
    kronrod = kronrod * half
    (kronrod, norm(kronrod - gauss * half), resabs * abs(half))
end

function _adaptive_integral(g, a, b)
    rtol = _calculus_rtol()
    value, error, resabs = _gk15(g, a, b)
    # (lo, hi, value, error estimate, integral of |g|)
    intervals = [(a, b, value, error, resabs)]
    total, total_error, total_abs = value, error, resabs
    while total_error > max(rtol * norm(total), 50 * eps(Float64) * total_abs)
        length(intervals) >= _QUAD_MAX_INTERVALS &&
            eqerror("integral did not converge; the integrand may be singular or oscillate too fast")
        worst = argmax([interval[4] for interval in intervals])
        lo, hi = intervals[worst][1], intervals[worst][2]
        middle = (lo + hi) / 2
        (middle == lo || middle == hi) &&
            eqerror("integral did not converge; the integrand may be singular")
        left = _gk15(g, lo, middle)
        right = _gk15(g, middle, hi)
        intervals[worst] = (lo, middle, left[1], left[2], left[3])
        push!(intervals, (middle, hi, right[1], right[2], right[3]))
        total = sum(interval -> interval[3], intervals)
        total_error = sum(interval -> interval[4], intervals)
        total_abs = sum(interval -> interval[5], intervals)
    end
    total
end

"""
    eq_integral(f, a, b)

the reference application's definite integral `∫[x ∈ a..b] f(x)`: adaptive Gauss-Kronrod quadrature
to a relative accuracy derived from `TOL`. Reversed limits negate the result, equal
limits give zero. `∞` (`Inf`) is allowed as either limit. Units: the variable carries
the unit of the limits, the result has the unit of `f` times that unit.
"""
function eq_integral(f, a, b)
    f isa Function || eqerror("integral needs an expression of the variable")
    a, b = eqnum(a), eqnum(b)
    (a isa Number && b isa Number) || eqerror("integral needs numbers as limits")
    quantity(x) = x isa Unitful.AbstractQuantity
    xunit = nothing
    for bound in (a, b)
        if quantity(bound) && isfinite(ustrip(bound))
            xunit = unit(bound)
            break
        end
    end
    function plain(x)
        if quantity(x)
            xunit === nothing && return float(ustrip(x))   # an infinite quantity
            try
                return float(ustrip(uconvert(xunit, x)))
            catch error
                error isa Unitful.DimensionError &&
                    eqerror("integral: the limits must have the same units")
                rethrow()
            end
        end
        xunit === nothing || isinf(x) ||
            eqerror("integral: the limits must have the same units")
        x
    end
    lo, hi = plain(a), plain(b)
    for bound in (lo, hi)
        bound isa Complex && !iszero(imag(bound)) && eqerror("integral needs real limits")
        isnan(real(bound)) && eqerror("integral: a limit is NaN")
    end
    lo, hi = Float64(real(lo)), Float64(real(hi))
    evaluate, yunit = _calculus_eval(f, xunit, "integral")
    function finish(value)
        unit_y = yunit[] === missing ? nothing : yunit[]
        _with_unit(_with_unit(value, unit_y), xunit)
    end
    if lo == hi
        isinf(lo) && eqerror("integral: both limits are infinite")
        return finish(0.0 * evaluate(lo))
    end
    orient = 1.0
    if lo > hi
        lo, hi = hi, lo
        orient = -1.0
    end
    if isfinite(lo) && isfinite(hi)
        return finish(orient * _adaptive_integral(evaluate, lo, hi))
    elseif isfinite(lo)    # [lo, ∞): x = lo + t/(1-t), t in [0, 1)
        g = t -> evaluate(lo + t / (1 - t)) * (1 / (1 - t)^2)
        return finish(orient * _adaptive_integral(g, 0.0, 1.0))
    elseif isfinite(hi)    # (-∞, hi]: x = hi - t/(1-t)
        g = t -> evaluate(hi - t / (1 - t)) * (1 / (1 - t)^2)
        return finish(orient * _adaptive_integral(g, 0.0, 1.0))
    else                   # (-∞, ∞): x = t/(1-t^2), t in (-1, 1)
        g = t -> evaluate(t / (1 - t^2)) * ((1 + t^2) / (1 - t^2)^2)
        return finish(orient * _adaptive_integral(g, -1.0, 1.0))
    end
end

eq_integral(args...) =
    eqerror("integral takes an expression and two limits, got $(length(args)) arguments")

# --------------------------------------------------------------------------- derivative

const _DERIV_CON = 1.4
const _DERIV_NTAB = 12
const _DERIV_SAFE = 2.0

"""
    eq_derivative(f, x)
    eq_derivative(f, x, n)

Numeric `n`-th derivative (default 1, `n` a non-negative integer) of `f` at `x`: central
differences of order `n` extrapolated in the step size (Ridders' method). `f` is a
function of one argument (a lambda of the variable, or a worksheet function for
`f′(x)`). The result has the unit of `f` divided by the unit of `x` to the power `n`.
"""
function eq_derivative(f, x, order=1.0)
    f isa Function || eqerror("derivative needs a function of the variable")
    n = eqnum(order)
    (n isa Real && isinteger(n) && n >= 0) ||
        eqerror("the order of a derivative must be a non-negative integer")
    n = Int(n)
    x = eqnum(x)
    x isa Number || eqerror("derivative needs a number as the value of the variable")
    xunit = x isa Unitful.AbstractQuantity ? unit(x) : nothing
    x0 = xunit === nothing ? float(x) : float(ustrip(x))
    evaluate, yunit = _calculus_eval(f, xunit, "derivative")
    function finish(value)
        unit_y = yunit[] === missing ? nothing : yunit[]
        unit_total = if xunit === nothing || n == 0
            unit_y
        elseif unit_y === nothing
            inv(xunit^n)
        else
            unit_y / xunit^n
        end
        _with_unit(value, unit_total)
    end
    n == 0 && return finish(evaluate(x0))
    scale = iszero(x0) ? 1.0 : abs(x0)
    h = 0.2 * scale / n
    function difference(step)
        total = nothing
        for k in 0:n
            term = ((-1)^k * binomial(n, k)) * evaluate(x0 + (n / 2 - k) * step)
            total = total === nothing ? term : total + term
        end
        total / step^n
    end
    rtol = _calculus_rtol()
    table = Matrix{Any}(undef, _DERIV_NTAB, _DERIV_NTAB)
    table[1, 1] = difference(h)
    best, best_error = table[1, 1], Inf
    for i in 2:_DERIV_NTAB
        h /= _DERIV_CON
        table[1, i] = difference(h)
        factor = _DERIV_CON^2
        for j in 2:i
            table[j, i] = (table[j-1, i] * factor - table[j-1, i-1]) / (factor - 1)
            factor *= _DERIV_CON^2
            candidate = max(norm(table[j, i] - table[j-1, i]),
                norm(table[j, i] - table[j-1, i-1]))
            if candidate <= best_error
                best_error = candidate
                best = table[j, i]
            end
        end
        best_error <= rtol * norm(best) && break
        norm(table[i, i] - table[i-1, i-1]) >= _DERIV_SAFE * best_error && break
    end
    finish(best)
end

eq_derivative(args...) =
    eqerror("derivative takes a function, a point and optionally an order, got $(length(args)) arguments")

"""`Jacob(F(x), x, [k])`: partial derivatives of a column-vector expression."""
function eq_jacob(f, x, k=nothing)
    f isa Function || eqerror("Jacob needs a vector function")
    x isa AbstractMatrix && size(x, 2) == 1 && !isempty(x) ||
        eqerror("Jacob: x must be a non-empty column vector")
    all(v -> v isa Number && isfinite(v), x) || eqerror("Jacob: x must contain finite numbers")
    count = k === nothing ? length(x) : eqnum(k)
    count isa Real && isinteger(count) && 1 <= count <= length(x) ||
        eqerror("Jacob: k must be an integer between 1 and the length of x")
    result = f(x)
    result isa AbstractMatrix && size(result, 2) == 1 && !isempty(result) ||
        eqerror("Jacob: the expression must be a non-empty column vector")
    rows = length(result)
    derivatives = [eq_derivative(t -> begin
        point = Matrix{Any}(x)
        point[j, 1] = t
        value = f(point)
        value isa AbstractMatrix && size(value) == (rows, 1) ||
            eqerror("Jacob: the expression must remain a column vector of the same size")
        value[i, 1]
    end, x[j, 1]) for i in 1:rows, j in 1:Int(count)]
    return derivatives
end
eq_jacob(args...) = eqerror("Jacob takes an expression, a vector and optionally a variable count")
