# Root finder.
#
# `root(f(x), x)` and `root(f(x), x, a, b)` are special forms: the generator passes the
# expression as a Julia lambda of the unknown, `eq_root(x -> f(x), guess)` and
# `eq_root(x -> f(x), a, b)`. The unknown is bound to the guess (or to the bracket
# ends) in the unit of the guess, so the lambda receives plain numbers or quantities
# exactly like a worksheet function call.

"Default the reference application convergence tolerance (the system variable TOL)."
const DEFAULT_TOL = 0.001

"the reference application's dynamically scoped convergence tolerance `TOL`."
const TOL = ScopedValue(DEFAULT_TOL)

tol() = TOL[]

function with_tol(f, value)
    value isa Real && isfinite(value) && value > 0 || eqerror("TOL must be a positive number")
    with(f, TOL => Float64(value))
end

const _ROOT_ITERATIONS = 200
# Relative step size at which the iterations are considered converged.
const _ROOT_STEP = 1.0e-14

"The unknown as a plain number plus the unit it carries (`nothing` for none)."
function _root_start(value, name)
    value isa Number || eqerror("$name needs a number as guess or bracket")
    value = eqnum(value)
    value isa Unitful.AbstractQuantity ? (ustrip(value), unit(value)) : (value, nothing)
end

"Evaluates `f` at the number `t` (in `unit`), returns the residual in base units."
function _root_residual(f, t, unit)
    value = f(unit === nothing ? t : t * unit)
    value isa Number || eqerror("root: the expression must evaluate to a number")
    value isa Unitful.AbstractQuantity && (value = ustrip(upreferred(value)))
    residual = eqnum(value)
    if t isa Real && residual isa Complex
        iszero(imag(residual)) ||
            eqerror("root: the expression is complex; start from a complex guess")
        residual = real(residual)
    end
    (isfinite(real(residual)) && isfinite(imag(residual))) ||
        eqerror("root: the expression is not finite at $(t)")
    residual
end

_root_result(t, unit) = unit === nothing ? t : t * unit

function _root_secant(f, start, unit)
    limit = tol()
    x0 = float(start)
    f0 = _root_residual(f, x0, unit)
    iszero(f0) && return x0
    x1 = x0 + 1.0e-4 * max(1.0, abs(x0))
    f1 = f0
    for _ in 1:_ROOT_ITERATIONS
        f1 = _root_residual(f, x1, unit)
        iszero(f1) && return x1
        denominator = f1 - f0
        if iszero(denominator)
            # the iteration cannot move: fine if the residual is within TOL
            abs(f1) <= limit && return x1
            eqerror("root: the expression is flat near $(x1); try another guess value")
        end
        x2 = x1 - f1 * (x1 - x0) / denominator
        (isfinite(real(x2)) && isfinite(imag(x2))) ||
            eqerror("root did not converge; try another guess value or an interval")
        if abs(x2 - x1) <= _ROOT_STEP * max(1.0, abs(x2))
            abs(_root_residual(f, x2, unit)) <= limit && return x2
            eqerror("root did not converge; try another guess value or an interval")
        end
        x0, f0, x1 = x1, f1, x2
    end
    abs(f1) <= limit && return x1
    eqerror("root did not converge; try another guess value or an interval")
end

function _root_bisect(f, lo, hi, unit)
    f_lo = _root_residual(f, lo, unit)
    f_hi = _root_residual(f, hi, unit)
    iszero(f_lo) && return lo
    iszero(f_hi) && return hi
    sign(f_lo) == sign(f_hi) &&
        eqerror("root: the expression has the same sign at both interval ends (no sign change)")
    for _ in 1:_ROOT_ITERATIONS
        middle = lo + (hi - lo) / 2
        if middle == lo || middle == hi
            break
        end
        f_middle = _root_residual(f, middle, unit)
        iszero(f_middle) && return middle
        if sign(f_middle) == sign(f_lo)
            lo, f_lo = middle, f_middle
        else
            hi, f_hi = middle, f_middle
        end
        abs(hi - lo) <= 2 * eps(Float64) * max(abs(lo), abs(hi)) && break
    end
    lo + (hi - lo) / 2
end

"""
    eq_root(f, guess)
    eq_root(f, a, b)

the reference application `root(f(x), x[, a, b])`. With a guess the secant method starts at `guess`
(second point `guess + 1e-4 max(1, |guess|)`), complex guesses find complex roots; it
stops when the residual is exactly zero or the step falls below `1e-14` relative, and
accepts that point only if `|f| <= TOL`. With a bracket `[a, b]` (reversed bounds
allowed) bisection runs to machine precision; `f(a)` and `f(b)` must differ in sign.
Units: the result carries the unit of the guess (or of `a`); `b` must have the same
dimension. The residual is compared with TOL in base units. No convergence is an
`EqError`.
"""
function eq_root(f, guess)
    f isa Function || eqerror("root needs an expression of the unknown")
    start, unit = _root_start(guess, "root")
    result = _root_secant(f, start, unit)
    _root_result(result, unit)
end

function eq_root(f, a, b)
    f isa Function || eqerror("root needs an expression of the unknown")
    low, unit = _root_start(a, "root")
    other = eqnum(b)
    other isa Number || eqerror("root needs numbers as interval ends")
    high = if unit === nothing
        other isa Unitful.AbstractQuantity &&
            eqerror("root: the interval ends must have the same units")
        other
    else
        other isa Unitful.AbstractQuantity ||
            eqerror("root: the interval ends must have the same units")
        try
            ustrip(uconvert(unit, other))
        catch error
            error isa Unitful.DimensionError &&
                eqerror("root: the interval ends must have the same units")
            rethrow()
        end
    end
    ((low isa Complex && !iszero(imag(low))) || (high isa Complex && !iszero(imag(high)))) &&
        eqerror("root on an interval needs real ends")
    low, high = Float64(real(low)), Float64(real(high))
    low == high && eqerror("root: the interval ends must differ")
    low, high = minmax(low, high)
    _root_result(_root_bisect(f, low, high, unit), unit)
end

eq_root(args...) =
    eqerror("root takes (expression, guess) or (expression, a, b), got $(length(args)) arguments")
