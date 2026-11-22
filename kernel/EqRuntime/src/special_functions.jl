# the reference application special functions. Numerical kernels come from SpecialFunctions.jl and
# HypergeometricFunctions.jl; the reference application argument conventions are handled here.
import SpecialFunctions
import HypergeometricFunctions

function _special_call(f, name, args...)
    result = try
        eqnum(f(args...))
    catch err
        err isa EqError && rethrow()
        err isa InterruptException && rethrow()
        eqerror("$name: $(sprint(showerror, err))")
    end
    # A pole or an overflow is an error, as in the reference application, not Julia's Inf or NaN: Γ(0), Γ(172).
    all(isfinite, result) || eqerror("$name is undefined at this point or its value is too large")
    result
end

function _special_real(x, name)
    z = _plain(x, name)
    iszero(imag(z)) || eqerror("$name needs real arguments")
    real(z)
end

# AMOS accepts complex arguments on the negative real axis, where the real
# methods can throw even though the principal complex continuation exists.
_special_z(z) = z isa Real && z < 0 ? complex(z) : z
function _special_bessel(f, name; nonzero=false)
    (m, z) -> _binary_elementwise(m, z, name) do order, argument
        ν = _special_real(order, name)
        w = _plain(argument, name)
        nonzero && iszero(w) && eqerror("$name: argument must be nonzero")
        _special_call(f, name, ν, _special_z(w))
    end
end

for (prefix, fn, scaled, nonzero) in ((:J, :besselj, :besseljx, false),
                                      (:Y, :bessely, :besselyx, true),
                                      (:I, :besseli, :besselix, false),
                                      (:K, :besselk, :besselkx, true))
    n = Symbol("eq_", prefix, "n")
    nsc = Symbol("eq_", prefix, "n_sc")
    @eval const $n = _special_bessel(SpecialFunctions.$fn, $(string(prefix, "n")); nonzero=$nonzero)
    @eval const $nsc = _special_bessel(SpecialFunctions.$scaled, $(string(prefix, "n.sc")); nonzero=$nonzero)
    for order in 0:1
        fixed = Symbol("eq_", prefix, order)
        fixedsc = Symbol("eq_", prefix, order, "_sc")
        @eval $fixed(z) = $n($order, z)
        @eval $fixedsc(z) = $nsc($order, z)
    end
end
const eq_H1 = _special_bessel(SpecialFunctions.hankelh1, "H1"; nonzero=true)
const eq_H2 = _special_bessel(SpecialFunctions.hankelh2, "H2"; nonzero=true)
const eq_H1_sc = _special_bessel(SpecialFunctions.hankelh1x, "H1.sc"; nonzero=true)
const eq_H2_sc = _special_bessel(SpecialFunctions.hankelh2x, "H2.sc"; nonzero=true)

function _special_unary(f, name)
    z -> _elementwise_map(v -> _special_call(f, name, name in ("Ai_sc", "DAi_sc") ? _special_z(_plain(v, name)) : _plain(v, name)), z)
end
for (name, fn) in ((:Ai, :airyai), (:DAi, :airyaiprime), (:Bi, :airybi),
                   (:DBi, :airybiprime), (:Ai_sc, :airyaix),
                   (:DAi_sc, :airyaiprimex), (:Bi_sc, :airybix),
                   (:DBi_sc, :airybiprimex), (:erf, :erf), (:erfc, :erfc))
    @eval const $(Symbol("eq_", name)) = _special_unary(SpecialFunctions.$fn, $(string(name)))
end
eq_Γ(z) = _elementwise_map(v -> _special_call(SpecialFunctions.gamma, "Γ", _plain(v, "Γ")), z)
# lnΓ uses the principal complex logarithm when Γ is negative.
eq_lnΓ(z) = _elementwise_map(z) do value
    x = _plain(value, "lnΓ")
    _special_call(SpecialFunctions.loggamma, "lnΓ", _special_z(x))
end
eq_Psi(z) = _elementwise_map(v -> _special_call(SpecialFunctions.digamma, "Psi", _plain(v, "Psi")), z)
"`Psi(n, y)`: the polygamma function, the n-th derivative of `Psi(y)`; n a non-negative integer."
function eq_Psi(n, z)
    _binary_elementwise(n, z, "Psi") do order, argument
        m = _special_real(order, "Psi")
        isinteger(m) && m >= 0 || eqerror("Psi: the order n must be a nonnegative integer")
        _special_call(SpecialFunctions.polygamma, "Psi", Int(m), _plain(argument, "Psi"))
    end
end

function eq_Γ(a, x)
    α, t = _special_real(a, "Γ"), _special_real(x, "Γ")
    α > 0 && t >= 0 || eqerror("Γ: a must be positive and x nonnegative")
    _special_call((s, z) -> Float64(SpecialFunctions.gamma(BigFloat(s), BigFloat(z))), "Γ", α, t)
end
function eq_ibeta(a, x, y)
    t, α, β = _special_real(a, "ibeta"), _special_real(x, "ibeta"), _special_real(y, "ibeta")
    0 <= t <= 1 && α > 0 && β > 0 || eqerror("ibeta: a must be between 0 and 1 and x and y positive")
    _special_call((s, p, q) -> SpecialFunctions.beta_inc(p, q, s)[1], "ibeta", t, α, β)
end
function eq_fhyper(a, b, c, x)
    α, β, γ, t = map(v -> _special_real(v, "fhyper"), (a, b, c, x))
    -1 < t < 1 || eqerror("fhyper: x must be between -1 and 1")
    (iszero(α) || iszero(β) || iszero(t)) && return 1.0
    _special_call(HypergeometricFunctions._₂F₁, "fhyper", α, β, γ, t)
end
function eq_mhyper(a, b, x)
    α, β, t = map(v -> _special_real(v, "mhyper"), (a, b, x))
    (iszero(α) || iszero(t)) && return 1.0
    _special_call(HypergeometricFunctions._₁F₁, "mhyper", α, β, t)
end
function _kelvin(part, name, m, x)
    _binary_elementwise(m, x, name) do order, argument
        n = _special_real(order, name)
        isinteger(n) && n >= 0 || eqerror("$name: order must be a nonnegative integer")
        t = _special_real(argument, name)
        part(_special_call(SpecialFunctions.besselj, name, n, t * cis(3π/4)))
    end
end
eq_ber(m, x) = _kelvin(real, "ber", m, x)
eq_bei(m, x) = _kelvin(imag, "bei", m, x)
function _spherical(f, name, m, z)
    _binary_elementwise(m, z, name) do order, argument
        n = _special_real(order, name)
        w = _plain(argument, name)
        if iszero(w)
            # js(0, 0) = 1 and js(m, 0) = 0 for m > 0 (the limits, as SpecialFunctions.sphericalbesselj); ys has a pole.
            f === SpecialFunctions.besselj && isinteger(n) && n >= 0 && return n == 0 ? 1.0 : 0.0
            eqerror("$name: argument must be nonzero")
        end
        value = _special_call((ν, t) -> sqrt(π / (2t)) * f(ν + 0.5, t), name, n, _special_z(w))
        # An integer order gives a real function of a real argument: drop the rounding residue the complex
        # continuation leaves on the negative axis.
        isinteger(n) && w isa Real ? real(value) : value
    end
end
eq_js(m, z) = _spherical(SpecialFunctions.besselj, "js", m, z)
eq_ys(m, z) = _spherical(SpecialFunctions.bessely, "ys", m, z)
function eq_Jac(n, a, b, x)
    _is_integer_value(n) && 0 <= real(n) < 2.0^(8sizeof(Int) - 1) ||
        eqerror("Jac: degree must be a representable nonnegative integer")
    α, β = _special_real(a, "Jac"), _special_real(b, "Jac")
    α > -1 && β > -1 || eqerror("Jac: a and b must be greater than -1")
    degree = Int(real(n))
    _elementwise_map(x) do value
        t = _plain(value, "Jac")
        degree == 0 && return 1.0
        prev, cur = 1.0, (α - β + (α + β + 2) * t) / 2
        for k in 2:degree
            s = 2k + α + β
            next = ((s - 1) * ((s * (s - 2) * t + α^2 - β^2) * cur) -
                    2 * (k + α - 1) * (k + β - 1) * s * prev) /
                   (2k * (k + α + β) * (s - 2))
            prev, cur = cur, next
        end
        cur
    end
end
