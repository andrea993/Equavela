# the reference application built-in functions (batch 6): sign and angle functions, hyperbolic
# and extra trigonometric functions, IsNaN, strings, orthogonal polynomials and
# small special functions. Specs: the specification sections 14, 15, 16,
# 17, 19, 20, 21.

# ------------------------------------------------------ sign and angle

"A scalar without its units (angles and signs ignore them)."
function _bare(value, name)
    value isa Number || eqerror("$name needs a number")
    value isa Unitful.AbstractQuantity ? ustrip(value) : value
end

function _real_bare(value, name)
    bare = _bare(value, name)
    imag(bare) == 0 || eqerror("$name needs a real number")
    Float64(real(bare))
end

"`sign(x)`: -1, 0 or 1 for a real number (units are ignored); elementwise."
eq_sign(value) = _elementwise_map(x -> Float64(sign(_real_bare(x, "sign"))), value)

"""
`signum(z [, x])`: `z / |z|` (for real `z`: -1 or 1); `x` (default 1) at
`z = 0`. Elementwise on `z`.
"""
function eq_signum(value, at_zero=1.0)
    fill = _real_bare(at_zero, "signum")
    _elementwise_map(value) do z
        bare = _bare(z, "signum")
        iszero(bare) && return fill
        bare isa Real ? Float64(sign(bare)) : ComplexF64(bare / abs(bare))
    end
end

"`csgn(z)`: 1 in the right half-plane (and on the positive imaginary axis), -1 in the left, 0 at 0."
eq_csgn(value) = _elementwise_map(value) do z
    bare = _bare(z, "csgn")
    iszero(bare) && return 0.0
    re, im = real(bare), imag(bare)
    re > 0 || (re == 0 && im > 0) ? 1.0 : -1.0
end

"`arg(z)`: principal argument in `(-pi, pi]`; `arg(0)` is 0; units are ignored."
eq_arg(value) = _elementwise_map(value) do z
    bare = _bare(z, "arg")
    Float64(atan(imag(bare), real(bare)))
end

"`angle(x, y)`: polar angle of the point `(x, y)` in `[0, 2 pi)`; undefined at `(0, 0)`."
eq_angle(x, y) = _binary_elementwise(x, y, "angle") do a, b
    _real_scalar(a, "angle")
    _real_scalar(b, "angle")
    iszero(a) && iszero(b) && eqerror("angle is undefined at (0, 0)")
    first, second = _atan2_values(a, b)
    result = Float64(atan(second, first))
    result < 0 ? result + 2π : result
end

# -------------------------------------- hyperbolic and extra trigonometric

function _reciprocal(value, name)
    iszero(value) && eqerror("$name: can't divide by zero")
    1 / value
end

function _plain_function(f, name, matrix_function=nothing)
    scalar(x) = _finite_result(f(_plain(x, name)))
    matrix_function === nothing && return value -> _elementwise_map(scalar, value)
    value -> _function_of(matrix_function, scalar, value)
end

const eq_sinh = _plain_function(sinh, "sinh", sinh)
const eq_cosh = _plain_function(cosh, "cosh", cosh)
const eq_tanh = _plain_function(tanh, "tanh", tanh)
const eq_asinh = _plain_function(asinh, "asinh", asinh)
const eq_csch = _plain_function(x -> _reciprocal(sinh(x), "csch"), "csch", csch)
const eq_sech = _plain_function(x -> _reciprocal(cosh(x), "sech"), "sech", sech)
const eq_coth = _plain_function(x -> _reciprocal(tanh(x), "coth"), "coth", coth)
const eq_csc = _plain_function(x -> _reciprocal(sin(x), "csc"), "csc", csc)
const eq_sec = _plain_function(x -> _reciprocal(cos(x), "sec"), "sec", sec)
const eq_cot = _plain_function(x -> _reciprocal(tan(x), "cot"), "cot", cot)
"`sinc(z)`: `sin(z) / z`, 1 at 0 (not normalized by pi)."
const eq_sinc = _plain_function(x -> iszero(x) ? 1.0 : sin(x) / x, "sinc")

_complexify(x::Real) = complex(Float64(x))
_complexify(x) = x

_acosh_value(x) = acosh(x isa Real && x < 1 ? complex(Float64(x)) : x)
_atanh_value(x) = atanh(x isa Real && abs(x) > 1 ? _complexify(x) : x)
_asin_value(x) = asin(x isa Real && abs(x) > 1 ? _complexify(x) : x)
_acos_value(x) = acos(x isa Real && abs(x) > 1 ? _complexify(x) : x)

const eq_acosh = _plain_function(_acosh_value, "acosh", acosh)
const eq_atanh = _plain_function(_atanh_value, "atanh", atanh)
const eq_acsch = _plain_function(x -> asinh(_reciprocal(x, "acsch")), "acsch", acsch)
const eq_asech = _plain_function(x -> _acosh_value(_reciprocal(x, "asech")), "asech", asech)
const eq_acoth = _plain_function(x -> _atanh_value(_reciprocal(x, "acoth")), "acoth", acoth)
const eq_acsc = _plain_function(x -> _asin_value(_reciprocal(x, "acsc")), "acsc", acsc)
const eq_asec = _plain_function(x -> _acos_value(_reciprocal(x, "asec")), "asec", asec)
"`acot(x)`: `atan(1 / x)`, `pi / 2` at 0."
const eq_acot = _plain_function(x -> iszero(x) ? π / 2 : atan(1 / x), "acot", acot)

"`ln0(z)`: like `ln`, but -1e307 at 0."
eq_ln0(value) = _elementwise_map(x -> iszero(_plain(x, "ln0")) ? -1e307 : _ln_scalar(x), value)

"`IsNaN(x)`: 1 when `x` (or a part of it) is NaN, elementwise; 0 for non-numbers."
eq_isnan(value) = _elementwise_map(value) do x
    x isa Number || return 0.0
    bare = x isa Unitful.AbstractQuantity ? ustrip(x) : x
    _boolean(isnan(real(bare)) || isnan(imag(bare)))
end

# ----------------------------------------------------------------- strings

function _need_string(value, name)
    value isa AbstractString || eqerror("$name needs a string")
    String(value)
end

"`concat(S1, S2, ...)`: joins strings."
function eq_concat(strings...)
    isempty(strings) && eqerror("concat needs at least one string")
    join(String[_need_string(s, "concat") for s in strings])
end

"`strlen(S)`: number of characters."
eq_strlen(string) = Float64(length(_need_string(string, "strlen")))

# String positions count from ORIGIN, as array indices do.
# The position returned is 0-based inside, shifted by ORIGIN at the boundary.
function _char_position(value, name)
    _is_integer_value(value) || eqerror("$name: the position must be an integer")
    Int(real(value)) - origin()
end

"`substr(S, m, n)`: `n` characters from position `m`; a short string is cut at its end."
function eq_substr(string, start, count)
    text = _need_string(string, "substr")
    first_index = _char_position(start, "substr")
    _is_integer_value(count) && real(count) >= 0 ||
        eqerror("substr: the length must be a nonnegative integer")
    0 <= first_index <= length(text) || eqerror("substr: position out of range")
    characters = collect(text)
    String(characters[(first_index+1):min(first_index + Int(real(count)), length(text))])
end

"`search(S, T, m)`: position of the first `T` in `S` at or after `m`; -1 when absent."
function eq_search(string, needle, start)
    text, sub = _need_string(string, "search"), _need_string(needle, "search")
    first_index = _char_position(start, "search")
    0 <= first_index <= length(text) || eqerror("search: position out of range")
    characters, wanted = collect(text), collect(sub)
    for index in (first_index+1):(length(characters)-length(wanted)+1)
        view(characters, index:(index+length(wanted)-1)) == wanted &&
            return Float64(index - 1 + origin())
    end
    -1.0
end

function _real_text(x::Real)
    isnan(x) && return "NaN"
    isinf(x) && return x > 0 ? "∞" : "-∞"
    iszero(x) && return "0"
    if abs(x) >= 1e15 || abs(x) < 1e-3
        return replace(string(round(x; sigdigits=3)), ".0e" => "e")
    end
    text = string(round(x; digits=3))
    endswith(text, ".0") ? text[1:(end-2)] : text
end

function _number_text(z)
    z isa Unitful.AbstractQuantity && return _number_text(ustrip(z)) * " " * string(unit(z))
    imag(z) == 0 && return _real_text(real(z))
    sign_text = imag(z) < 0 ? "-" : "+"
    _real_text(real(z)) * sign_text * _real_text(abs(imag(z))) * "i"
end

"""
`num2str(z)`: a number as text with at most three decimals
.
"""
function eq_num2str(value)
    value isa Number || eqerror("num2str needs a number")
    _number_text(value)
end

"""
`str2num(S)`: a real or complex constant from text (`1.5`, `-2e3`, `1+2i`,
`3j`); anything else is an error.
"""
function eq_str2num(string)
    text = replace(strip(_need_string(string, "str2num")), " " => "")
    isempty(text) && eqerror("str2num: the string is empty")
    real_value = tryparse(Float64, text)
    real_value === nothing || return real_value
    pure = match(r"^([+-]?(?:[0-9.]+(?:[eE][+-]?[0-9]+)?)?)[ij]$", text)
    if pure !== nothing
        imag_only = pure[1] in ("", "+", "-") ? pure[1] * "1" : pure[1]
        imag_value = tryparse(Float64, imag_only)
        imag_value === nothing || return ComplexF64(0.0, imag_value)
    end
    pattern = r"^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)?([+-]?[0-9.]*(?:[eE][+-]?[0-9]+)?)[ij]$"
    matched = match(pattern, text)
    matched === nothing && eqerror("str2num: \"$string\" is not a number")
    real_part = matched[1] === nothing ? 0.0 : tryparse(Float64, matched[1])
    imag_text = matched[2] in ("", "+", "-") ? matched[2] * "1" : matched[2]
    imag_part = tryparse(Float64, imag_text)
    (real_part === nothing || imag_part === nothing) &&
        eqerror("str2num: \"$string\" is not a number")
    ComplexF64(real_part, imag_part)
end

_valid_code(code) = code in (9, 10, 13) || 32 <= code <= 255

"`vec2str(v)`: a string from a vector of character codes (9, 10, 13, 32 to 255)."
function eq_vec2str(vector)
    isarr(vector) && (size(vector, 1) == 1 || size(vector, 2) == 1) ||
        eqerror("vec2str needs a vector")
    codes = map(vec(vector)) do code
        _is_integer_value(code) && _valid_code(Int(real(code))) ||
            eqerror("vec2str: invalid character code")
        Int(real(code))
    end
    String(Char.(codes))
end

"`str2vec(S)`: a column vector of the character codes of `S`."
function eq_str2vec(string)
    text = _need_string(string, "str2vec")
    isempty(text) && eqerror("str2vec: the string is empty")
    reshape(Float64.(codepoint.(collect(text))), :, 1)
end

"`format(T, x0, x1, ...)`: replaces `{0}`, `{1}`, ... in `T` with the arguments (numbers as `num2str`)."
function eq_format(template, arguments...)
    text = _need_string(template, "format")
    pieces = map(arguments) do argument
        argument isa AbstractString ? String(argument) : eq_num2str(argument)
    end
    replace(text, r"\{(\d+)\}" => function (placeholder)
        index = parse(Int, match(r"\d+", placeholder).match) + 1
        index <= length(pieces) || eqerror("format: no argument for $placeholder")
        pieces[index]
    end)
end

# ----------------------------------------- polynomials and small functions

# `step(k, x, p_k, p_)` gives `p_(k+1)`; for k = 0 it gives `p_1`.
function _polynomial(step, name)
    function (n, x)
        _is_integer_value(n) && real(n) >= 0 ||
            eqerror("$name: the degree must be a nonnegative integer")
        degree = Int(real(n))
        _elementwise_map(x) do value
            argument = _plain(value, name)
            degree == 0 && return 1.0
            previous, current = 1.0, step(0, argument, 1.0, 0.0)
            for k in 1:(degree-1)
                previous, current = current, step(k, argument, current, previous)
            end
            current
        end
    end
end

"`Leg(n, x)`: Legendre polynomial."
const eq_Leg = _polynomial(
    (k, x, p, q) -> k == 0 ? x : ((2k + 1) * x * p - k * q) / (k + 1), "Leg")
"`Tcheb(n, x)`: Chebyshev polynomial of the first kind."
const eq_Tcheb = _polynomial((k, x, p, q) -> k == 0 ? x : 2x * p - q, "Tcheb")
"`Ucheb(n, x)`: Chebyshev polynomial of the second kind."
const eq_Ucheb = _polynomial((k, x, p, q) -> k == 0 ? 2x : 2x * p - q, "Ucheb")
"`Her(n, x)`: Hermite polynomial (physicists')."
const eq_Her = _polynomial((k, x, p, q) -> k == 0 ? 2x : 2x * p - 2k * q, "Her")
"`Lag(n, x)`: Laguerre polynomial."
const eq_Lag = _polynomial(
    (k, x, p, q) -> k == 0 ? 1 - x : ((2k + 1 - x) * p - k * q) / (k + 1), "Lag")

"`δ(m, n)`: Kronecker delta, 1 when the two integers are equal."
function eq_δ(m, n)
    (_is_integer_value(m) && _is_integer_value(n)) ||
        eqerror("δ needs unitless integers")
    _boolean(real(m) == real(n))
end

"`Φ(x)`: Heaviside step, 0 for `x < 0`, 1 for `x > 0`, 0.5 at 0; elementwise."
eq_Φ(value) = _elementwise_map(value) do x
    number = _real_bare(x, "Φ")
    number < 0 ? 0.0 : number > 0 ? 1.0 : 0.5
end

"`ε(i, j, k)`: antisymmetric tensor of rank 3: the sign of the permutation of the indices `ORIGIN..ORIGIN+2`, else 0."
function eq_ε(i, j, k)
    indices = map((i, j, k)) do index
        _is_integer_value(index) || eqerror("ε needs unitless integers")
        Int(real(index)) - origin()
    end
    (all(index -> 0 <= index <= 2, indices) && allunique(indices)) || return 0.0
    inversions = count(pair -> indices[pair[1]] > indices[pair[2]], ((1, 2), (1, 3), (2, 3)))
    iseven(inversions) ? 1.0 : -1.0
end
