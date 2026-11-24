# Derivatives for the numeric derivative operators and the solvers: automatic differentiation
# with ForwardDiff through the worksheet's own functions, and finite differences when an
# expression does not accept dual numbers (code that needs a `Float64`, a call into a C library,
# a Julia region written for floats) or when the region asks for them.

"How derivatives are computed: `:auto` (ForwardDiff, then finite differences) or `:finite`."
function derivative_method(value)
    value === nothing && return :auto
    text = value isa Symbol ? String(value) : value isa AbstractString ? String(value) :
        eqerror("the derivative method must be auto or finite-differences")
    text == "auto" && return :auto
    text in ("finite", "finite-differences") && return :finite
    eqerror("unknown derivative method `$text`: use auto or finite-differences")
end

# Whether an exception raised under automatic differentiation means "no dual numbers here"
# rather than a result. An interrupt is never one.
_ad_failure(error) = !(error isa InterruptException)

"""
The `n`-th derivative of `g` at the real point `x` by nested ForwardDiff derivatives, or
`nothing` when `g` does not accept dual numbers or the result is not finite.
"""
function ad_derivative(g, x, n::Integer)
    x isa Real || return nothing
    d = g
    for _ in 1:n
        inner = d
        d = t -> ForwardDiff.derivative(inner, t)
    end
    value = try
        d(float(x))
    catch error
        _ad_failure(error) || rethrow()
        return nothing
    end
    all(isfinite, value) ? value : nothing
end

"The gradient of the scalar function `f` at `z`, by ForwardDiff or central differences."
function solver_gradient(f, z, method)
    if method === :auto
        g = try
            ForwardDiff.gradient(f, z)
        catch error
            _ad_failure(error) || rethrow()
            nothing
        end
        g !== nothing && all(isfinite, g) && return g
    end
    n = length(z)
    map(1:n) do j
        h = 1.0e-6 * max(1.0, abs(z[j]))
        zp = copy(z); zp[j] += h
        zm = copy(z); zm[j] -= h
        (f(zp) - f(zm)) / (2h)
    end
end

"The Jacobian of the vector function `f` at `z` (`r = f(z)`), by ForwardDiff or forward differences."
function solver_jacobian(f, z, r, method)
    if method === :auto
        J = try
            ForwardDiff.jacobian(f, z)
        catch error
            _ad_failure(error) || rethrow()
            nothing
        end
        J !== nothing && all(isfinite, J) && return J
    end
    n, m = length(z), length(r)
    J = zeros(m, n)
    for j in 1:n
        h = 1.0e-7 * max(1.0, abs(z[j]))
        zp = copy(z); zp[j] += h
        J[:, j] = (f(zp) .- r) ./ h
    end
    J
end
