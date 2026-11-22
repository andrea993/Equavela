# the reference application built-in functions (batch 4): multiples, mod, atan2, combin, sorting
# and descriptive statistics. Specs: the specification sections 3, 4, 5, 7.

# ------------------------------------------ multiples (Floor, Ceil, Round, Trunc)

"The quotient `z / y` as a plain number: the units of `z` and `y` must agree."
function _ratio(z, y, name)
    z isa Number || eqerror("$name needs a number")
    y isa Number && !(y isa Complex && imag(y) != 0) ||
        eqerror("$name: the multiple must be a real number")
    iszero(y) && eqerror("$name: the multiple must not be zero")
    ratio = try
        z / y
    catch error
        error isa Unitful.DimensionError &&
            eqerror("$name: the units of the arguments do not match")
        rethrow()
    end
    ratio isa Unitful.AbstractQuantity ? _plain(ratio, name) : eqnum(ratio)
end

function _multiple(f, name)
    (value, multiple) -> _elementwise_map(value) do z
        ratio = _ratio(z, multiple, name)
        step = multiple isa Complex ? real(multiple) : multiple
        ratio isa Complex ? complex(f(real(ratio)), f(imag(ratio))) * step : f(ratio) * step
    end
end

"`Floor(z, y)`: greatest multiple of `y` not above `z` (complex `z`: each part)."
const eq_Floor = _multiple(floor, "Floor")
"`Ceil(z, y)`: smallest multiple of `y` not below `z`."
const eq_Ceil = _multiple(ceil, "Ceil")
"`Round(z, y)`: nearest multiple of `y`, halves away from zero."
const eq_Round = _multiple(x -> round(x, RoundNearestTiesAway), "Round")
"`Trunc(z, y)`: `trunc(z / y) * y`."
const eq_Trunc = _multiple(trunc, "Trunc")

# ------------------------------------------------------- mod, atan2, combin

function _binary_elementwise(f, x, y, name)
    if isarr(x) && isarr(y)
        size(x) == size(y) || eqerror("$name: the arrays must have the same size")
        return narrow(map((a, b) -> _binary_elementwise(f, a, b, name), x, y))
    elseif isarr(x)
        return narrow(map(a -> _binary_elementwise(f, a, y, name), x))
    elseif isarr(y)
        return narrow(map(b -> _binary_elementwise(f, x, b, name), y))
    end
    f(x, y)
end

function _real_scalar(value, name)
    value isa Number && !(value isa Complex) || eqerror("$name needs real numbers")
    value
end

"""
`mod(x, y)`: remainder of `x / y` with the sign of `x` (truncated division).
Elementwise on arrays; `y` must not be zero; units must agree.
"""
eq_mod(x, y) = _binary_elementwise(x, y, "mod") do a, b
    _real_scalar(a, "mod")
    _real_scalar(b, "mod")
    iszero(b) && eqerror("mod: the divisor must not be zero")
    try
        rem(eqnum(a), eqnum(b))
    catch error
        error isa Unitful.DimensionError &&
            eqerror("mod: the units of the arguments do not match")
        rethrow()
    end
end

"""
`atan2(x, y)`: angle of the point `(x, y)` in `(-pi, pi]`, **x first**.
Undefined at `(0, 0)`. Both arguments need the same units (or none).
"""
function _atan2_values(a, b)
    if a isa Unitful.AbstractQuantity && b isa Unitful.AbstractQuantity
        try
            return ustrip(a), ustrip(unit(a), b)
        catch error
            error isa Unitful.DimensionError &&
                eqerror("atan2: the units of the arguments do not match")
            rethrow()
        end
    end
    (a isa Unitful.AbstractQuantity || b isa Unitful.AbstractQuantity) &&
        eqerror("atan2: the units of the arguments do not match")
    a, b
end

eq_atan2(x, y) = _binary_elementwise(x, y, "atan2") do a, b
    _real_scalar(a, "atan2")
    _real_scalar(b, "atan2")
    iszero(a) && iszero(b) && eqerror("atan2 is undefined at (0, 0)")
    first, second = _atan2_values(a, b)
    Float64(atan(second, first))
end

"`combin(n, k)`: number of combinations, integers with `n >= k >= 0`."
function eq_combin(n, k)
    for (value, name) in ((n, "n"), (k, "k"))
        value isa Number && !(value isa Unitful.AbstractQuantity) && imag(value) == 0 &&
            isinteger(real(value)) || eqerror("combin: $name must be an integer")
    end
    n_int, k_int = Int(real(n)), Int(real(k))
    0 <= k_int <= n_int || eqerror("combin needs n >= k >= 0")
    Float64(binomial(big(n_int), big(k_int)))
end

# ------------------------------------------------------ sorting and reordering

function _need_numbers(array, name)
    _need_array(array, name)
    all(x -> x isa Number, array) || eqerror("$name needs numeric elements")
end

# Sorting looks at the real part only.
_sort_key(matrix) = map(real, matrix)

"""
`sort(v)`: elements in ascending order of their real part. A vector keeps its
orientation; a matrix is an error.
"""
function eq_sort(vector)
    _need_numbers(vector, "sort")
    (size(vector, 1) == 1 || size(vector, 2) == 1) || eqerror("sort needs a vector")
    order = sortperm(vec(_sort_key(vector)))
    narrow(reshape(vec(vector)[order], size(vector)))
end

"""
`reverse(A)`: reverses the elements of a vector, or the order of the rows of a
matrix. A row vector counts as a matrix with one row, so it is unchanged
.
"""
function eq_reverse(array)
    _need_array(array, "reverse")
    narrow(array[end:-1:1, :])
end

function _sort_index(n, limit, name)
    n isa Number && !(n isa Unitful.AbstractQuantity) && imag(n) == 0 &&
        isinteger(real(n)) || eqerror("$name: the index must be an integer")
    position = Int(real(n)) - origin() + 1
    1 <= position <= limit || eqerror("$name: index out of range")
    position
end

"`csort(A, n)`: rows rearranged so that column `n` (ORIGIN-aware) ascends; stable."
function eq_csort(matrix, n)
    _need_numbers(matrix, "csort")
    column = _sort_index(n, size(matrix, 2), "csort")
    narrow(matrix[sortperm(vec(_sort_key(matrix[:, column]))), :])
end

"`rsort(A, n)`: columns rearranged so that row `n` (ORIGIN-aware) ascends; stable."
function eq_rsort(matrix, n)
    _need_numbers(matrix, "rsort")
    row = _sort_index(n, size(matrix, 1), "rsort")
    narrow(matrix[:, sortperm(vec(_sort_key(matrix[row, :])))])
end

# ------------------------------------------------------ descriptive statistics

function _numbers(arguments, name)
    values = _flatten_arguments(arguments, name)
    all(value -> value isa Number, values) || eqerror("$name needs numbers")
    values
end

function _units_checked(f, name)
    try
        f()
    catch error
        error isa Unitful.DimensionError &&
            eqerror("$name: the units of the arguments do not match")
        rethrow()
    end
end

"`mean(A, B, ...)`: arithmetic mean over all elements of all arguments."
function eq_mean(arguments...)
    values = _numbers(arguments, "mean")
    eqnum(_units_checked(() -> sum(values) / length(values), "mean"))
end

"`median(A, B, ...)`: middle of the sorted real values (mean of the two middle ones for an even count)."
function eq_median(arguments...)
    values = _numbers(arguments, "median")
    any(value -> value isa Complex && imag(value) != 0, values) &&
        eqerror("median needs real values")
    sorted = _units_checked(() -> sort(real.(values)), "median")
    count = length(sorted)
    isodd(count) ? eqnum(sorted[(count+1)÷2]) :
    eqnum((sorted[count÷2] + sorted[count÷2+1]) / 2)
end

function _variance(arguments, name, sample)
    values = _numbers(arguments, name)
    count = length(values)
    sample && count < 2 && eqerror("$name needs at least two elements")
    _units_checked(name) do
        center = sum(values) / count
        sum(abs2(value - center) for value in values) / (sample ? count - 1 : count)
    end
end

"`var(A, B, ...)`: population variance (divides by N); complex values use `|x - mean|^2`."
eq_var(arguments...) = eqnum(_variance(arguments, "var", false))
"`Var(A, B, ...)`: sample variance (divides by N - 1)."
eq_Var(arguments...) = eqnum(_variance(arguments, "Var", true))
"`stdev(A, B, ...)`: population standard deviation (divides by N, not N - 1)."
eq_stdev(arguments...) = eqnum(sqrt(_variance(arguments, "stdev", false)))
"`Stdev(A, B, ...)`: sample standard deviation."
eq_Stdev(arguments...) = eqnum(sqrt(_variance(arguments, "Stdev", true)))

# ----------------------------------------------------- norm and n-th root

"""
`‖x‖`: the Euclidean norm of a vector (a row or a column; complex
elements use their moduli, units are kept). A scalar gives its absolute value.
Matrices with more than one row and column are an error, not the determinant
that `|x|` returns.
"""
function eq_norm(value)
    value isa Number && return eq_abs(value)
    if isarr(value) && (size(value, 1) == 1 || size(value, 2) == 1)
        isempty(value) && eqerror("the norm of an empty vector is undefined")
        return eq_abs(value)
    end
    eqerror("‖x‖ needs a number or a vector")
end

function _nthroot_real(x::Real, n::Float64)
    n == 2 && return x < 0 ? sqrt(complex(Float64(x))) : sqrt(Float64(x))
    odd = isinteger(n) && isodd(Int(n))
    if odd
        # the real root of a negative number for odd n
        n == 3 && return cbrt(Float64(x))
        n == -3 && return 1 / cbrt(Float64(x))
        root = abs(Float64(x))^(1 / n)
        return x < 0 ? -root : root
    end
    x < 0 ? complex(Float64(x))^(1 / n) : Float64(x)^(1 / n)
end

function _nthroot_scalar(x, n::Float64)
    x isa Number || eqerror("the root needs a number")
    if x isa Unitful.AbstractQuantity
        isinteger(n) || eqerror("the root of a quantity with units needs an integer index")
        magnitude = ustrip(x)
        magnitude isa Real || eqerror("the root of a complex quantity with units is not supported")
        return _clean(_nthroot_real(magnitude, n) * unit(x)^(1 // Int(n)))
    elseif x isa Real
        return _nthroot_real(x, n)
    end
    n == 2 ? sqrt(ComplexF64(x)) : ComplexF64(x)^(1 / n)
end

"""
`√[n](x)`: the n-th root, elementwise on `x`. For a negative real `x` and an
odd integer `n` the result is the real root; otherwise the principal value
(complex for negative `x`). `n` must be a nonzero real unitless scalar.
"""
function eq_nthroot(x, n)
    index = _plain(n, "n-th root")
    index isa Real || imag(index) == 0 || eqerror("the root index must be real")
    index = Float64(real(index))
    index == 0 && eqerror("the root index cannot be zero")
    isfinite(index) || eqerror("the root index must be finite")
    _elementwise_map(element -> _nthroot_scalar(element, index), x)
end
