# the reference application built-in functions (batch 2). Specs: the specification and
# compatibility . Every function returns the reference application values (Float64,
# ComplexF64, Unitful quantities, strings, 2-D matrices) and signals user-visible
# failures with EqError.

_need_array(value, name) =
    isarr(value) || eqerror("$name needs an array")

"A unitless number: dimensionless quantities (angles, ratios) are converted."
function _plain(value, name)
    value isa Number || eqerror("$name needs a number")
    value isa Unitful.AbstractQuantity || return eqnum(value)
    dimension(value) == NoDims || eqerror("$name needs a unitless value")
    eqnum(uconvert(NoUnits, value))
end

"Apply a scalar function to every element; nested arrays recurse."
_elementwise_map(f, value) =
    isarr(value) ? narrow(map(element -> _elementwise_map(f, element), value)) : f(value)

"""
A function of a square matrix: a scalar function applied to a square matrix of plain
numbers with more than one element is the matrix function, as in Julia (`exp(M)` is the matrix
exponential, `sqrt(M)` a square root of the matrix, `sin(M)` the matrix sine). A vector, a
non-square matrix and a 1 x 1 matrix stay elementwise, and so does every argument of `\\vec(...)`,
which hands the function one element at a time.
"""
function _function_of(matrix_function, scalar_function, value)
    if value isa AbstractMatrix && size(value, 1) == size(value, 2) && size(value, 1) > 1 &&
       all(element -> element isa Number && !(element isa Unitful.AbstractQuantity), value)
        result = try
            matrix_function(Matrix(float.(value)))
        catch error
            error isa LinearAlgebra.SingularException &&
                eqerror("this matrix is singular")
            error isa DomainError && eqerror("the function is not defined for this matrix")
            error isa LinearAlgebra.LAPACKException &&
                eqerror("the matrix function did not converge")
            rethrow()
        end
        all(isfinite, result) || eqerror(
            "Found a number with a magnitude greater than 10^307 while trying to evaluate this expression.",
        )
        return narrow(_real_if_possible(result))
    end
    _elementwise_map(scalar_function, value)
end

# ---------------------------------------------------------------- dimensions

eq_rows(value) = isarr(value) ? Float64(size(value, 1)) : 0.0
eq_cols(value) = isarr(value) ? Float64(size(value, 2)) : 0.0

function eq_length(vector)
    _need_array(vector, "length")
    size(vector, 2) == 1 || eqerror("length needs a vector")
    Float64(size(vector, 1))
end

"`last(v)`: index of the last element, so it depends on ORIGIN."
eq_last(vector) = eq_length(vector) + origin() - 1

# ------------------------------------------------------- joining and slicing

_block(value::AbstractMatrix) = convert(Matrix{Any}, value)
_block(value) = fill!(Matrix{Any}(undef, 1, 1), value)

"`stack(A, B, ...)`: place arrays top to bottom; a scalar is a 1x1 block."
function eq_stack(arguments...)
    isempty(arguments) && eqerror("stack needs at least one argument")
    blocks = map(_block, arguments)
    all(block -> size(block, 2) == size(first(blocks), 2), blocks) ||
        eqerror("stack: the arrays must have the same number of columns")
    narrow(reduce(vcat, blocks))
end

"`augment(A, B, ...)`: place arrays side by side; a scalar is a 1x1 block."
function eq_augment(arguments...)
    isempty(arguments) && eqerror("augment needs at least one argument")
    blocks = map(_block, arguments)
    all(block -> size(block, 1) == size(first(blocks), 1), blocks) ||
        eqerror("augment: the arrays must have the same number of rows")
    narrow(reduce(hcat, blocks))
end

"""
`submatrix(A, ir, jr, ic, jc)`: rows `ir..jr`, columns `ic..jc` (ORIGIN-aware,
inclusive). Reversed bounds reverse the order. The result is always an array,
also 1x1.
"""
function eq_submatrix(matrix, first_row, last_row, first_col, last_col)
    _need_array(matrix, "submatrix")
    r1, r2 = _julia_index(first_row), _julia_index(last_row)
    c1, c2 = _julia_index(first_col), _julia_index(last_col)
    max(r1, r2) <= size(matrix, 1) && max(c1, c2) <= size(matrix, 2) ||
        eqerror("submatrix: index out of range")
    matrix[(r1 <= r2 ? (r1:r2) : (r1:-1:r2)), (c1 <= c2 ? (c1:c2) : (c1:-1:c2))]
end

# ------------------------------------------------------------ linear algebra

function _numeric_square(matrix, name)
    _need_array(matrix, name)
    size(matrix, 1) == size(matrix, 2) || eqerror("$name needs a square matrix")
    numeric = narrow(matrix)
    eltype(numeric) === Any && eqerror("$name needs a numeric matrix without units")
    numeric
end

function eq_tr(matrix)
    _need_array(matrix, "tr")
    size(matrix, 1) == size(matrix, 2) || eqerror("tr needs a square matrix")
    isempty(matrix) && return 0.0
    accumulator = matrix[1, 1]
    for index in 2:size(matrix, 1)
        accumulator = _scalar_add(accumulator, matrix[index, index])
    end
    accumulator
end

"""
`vsum(v)`: the sum of the elements of an array, in reading order (a matrix row by row) and with
`+` semantics - the reference application's vector sum operator `Σv`
. No index is computed, so the result never depends on `ORIGIN`; the units of the terms ride
through the addition and an empty array sums to 0.
"""
function eq_vsum(value)
    _need_array(value, "vsum")
    total = nothing
    for row in axes(value, 1), column in axes(value, 2)
        element = value[row, column]
        total = total === nothing ? element : _scalar_add(total, element)
    end
    total === nothing ? 0.0 : total
end

"`rank(A)` with LAPACK's SVD and Julia's default tolerance."
function eq_rank(matrix)
    _need_array(matrix, "rank")
    numeric = narrow(matrix)
    eltype(numeric) === Any && eqerror("rank needs a numeric matrix without units")
    isempty(numeric) ? 0.0 : Float64(rank(numeric))
end

"Eigen decomposition as Julia gives it: a Hermitian matrix has real ascending eigenvalues."
function _eigen(matrix, name)
    numeric = _numeric_square(matrix, name)
    isempty(numeric) && eqerror("$name needs a non-empty matrix")
    try
        ishermitian(numeric) ? eigen(Hermitian(numeric)) : eigen(numeric)
    catch error
        error isa LinearAlgebra.LAPACKException && eqerror("$name did not converge")
        rethrow()
    end
end

_real_if_possible(values) =
    all(value -> imag(value) == 0, values) ? real.(values) : values

"""
`eigenvals(M)`: eigenvalues as a column vector in Julia's order: ascending for a symmetric or
Hermitian matrix, otherwise by real part and then imaginary part
.
"""
function eq_eigenvals(matrix)
    decomposition = _eigen(matrix, "eigenvals")
    reshape(collect(_real_if_possible(decomposition.values)), :, 1)
end

"""
`eigenvecs(M [, "L"])`: normalized eigenvectors as columns in `eigenvals` order, with LAPACK's
signs; `"L"` gives left eigenvectors.
"""
function eq_eigenvecs(matrix, side::AbstractString="R")
    side in ("R", "L") || eqerror("eigenvecs: the second argument must be \"L\"")
    right = _eigen(matrix, "eigenvecs")
    side == "R" && return Matrix(_real_if_possible(right.vectors))
    # left vectors u satisfy A^H u = conj(lambda) u; pair them with `right.values`
    adjoint_eigen = _eigen(Matrix(narrow(matrix)'), "eigenvecs")
    available = collect(eachindex(adjoint_eigen.values))
    result = similar(adjoint_eigen.vectors)
    for (column, value) in enumerate(right.values)
        best = argmin(map(index -> abs(conj(adjoint_eigen.values[index]) - value), available))
        result[:, column] = adjoint_eigen.vectors[:, available[best]]
        deleteat!(available, best)
    end
    Matrix(_real_if_possible(result))
end

# ------------------------------------------------------------------- lookup

function _same_value(left, right)
    left_string, right_string = left isa AbstractString, right isa AbstractString
    left_string == right_string || return false
    left_string && return left == right
    if left isa AbstractMatrix || right isa AbstractMatrix
        return left isa AbstractMatrix && right isa AbstractMatrix && left == right
    end
    try
        left == right
    catch error
        error isa Unitful.DimensionError ? false : rethrow()
    end
end

# ------------------------------------------------------------- min and max

function _flatten_arguments(arguments, name)
    isempty(arguments) && eqerror("$name needs at least one argument")
    values = Any[]
    collect_values(value) =
        isarr(value) ? foreach(collect_values, value) : push!(values, value)
    foreach(collect_values, arguments)
    isempty(values) && eqerror("$name needs at least one element")
    values
end

function _extreme(arguments, name, better)
    values = _flatten_arguments(arguments, name)
    if all(value -> value isa AbstractString, values)
        return reduce((a, b) -> better(b, a) ? b : a, values)
    end
    all(value -> value isa Number, values) ||
        eqerror("$name needs numbers or strings, not a mix")
    if any(value -> value isa Complex && imag(value) != 0, values)
        any(value -> value isa Unitful.AbstractQuantity, values) &&
            eqerror("$name does not support complex values with units")
        picked(part) = reduce((a, b) -> better(b, a) ? b : a, part.(values))
        return complex(picked(real), picked(imag))
    end
    try
        reduce((a, b) -> better(real(b), real(a)) ? b : a, values)
    catch error
        error isa Unitful.DimensionError &&
            eqerror("$name: the units of the arguments do not match")
        rethrow()
    end
end

"`max(A, B, ...)`: largest value; complex gives largest real + i largest imaginary part."
eq_max(arguments...) = _extreme(arguments, "max", >)
eq_min(arguments...) = _extreme(arguments, "min", <)

# --------------------------------------------- rounding

function _round_parts(f, value, name)
    number = _plain(value, name)
    number isa Complex ? complex(f(real(number)), f(imag(number))) : f(number)
end

eq_floor(value) = _elementwise_map(x -> _round_parts(floor, x, "floor"), value)
eq_ceil(value) = _elementwise_map(x -> _round_parts(ceil, x, "ceil"), value)
eq_trunc(value) = _elementwise_map(x -> _round_parts(trunc, x, "trunc"), value)

"`round(z [, n])`: n decimals (default 0); halves round away from zero."
function eq_round(value, digits=0.0)
    digits isa Number && !(digits isa Unitful.AbstractQuantity) &&
        imag(digits) == 0 && isinteger(real(digits)) ||
        eqerror("round: the number of decimals must be an integer")
    places = Int(real(digits))
    _elementwise_map(
        x -> _round_parts(y -> round(y, RoundNearestTiesAway; digits=places), x, "round"),
        value,
    )
end

# --------------------------------- scalar math functions

_check_number(x, name) = x isa Number || eqerror("$name needs a number")
eq_re(value) = _elementwise_map(x -> (_check_number(x, "Re"); real(x)), value)
eq_im(value) = _elementwise_map(x -> (_check_number(x, "Im"); imag(x)), value)

function _sqrt_scalar(value)
    value isa Number || eqerror("sqrt needs a number")
    value isa Real && !(value isa Unitful.AbstractQuantity) && value < 0 &&
        return sqrt(complex(Float64(value)))
    _unitsafe(sqrt, value)
end
eq_sqrt(value) = _function_of(sqrt, _sqrt_scalar, value)

function _finite_result(result)
    isfinite(result) || eqerror(
        "Found a number with a magnitude greater than 10^307 while trying to evaluate this expression.",
    )
    result
end
_exp_scalar(value) = _finite_result(exp(_plain(value, "exp")))
eq_exp(value) = _function_of(exp, _exp_scalar, value)

function _ln_scalar(value)
    number = _plain(value, "ln")
    iszero(number) && eqerror("can't take the logarithm of zero")
    number isa Real && number < 0 ? log(complex(Float64(number))) : log(number)
end
eq_ln(value) = _function_of(log, _ln_scalar, value)

eq_log(value) =
    _function_of(matrix -> log(matrix) / log(10.0), x -> _ln_scalar(x) / log(10.0), value)
function eq_log(value, base)
    base isa Number || eqerror("log needs a numeric base")
    eq_div(eq_ln(value), eq_ln(base))
end

eq_sin(value) = _function_of(sin, x -> sin(_plain(x, "sin")), value)
eq_cos(value) = _function_of(cos, x -> cos(_plain(x, "cos")), value)
eq_tan(value) = _function_of(tan, x -> tan(_plain(x, "tan")), value)

# Outside [-1, 1] the value is Julia's complex one (decision 2026-11-10: `acos(2) = -1.317i`,
# where the reference application takes the other side of the cut).
_across_cut(x::Real) = complex(Float64(x))

function _inverse_trig(f, name)
    function (value)
        number = _plain(value, name)
        number isa Real && abs(number) > 1 ? f(_across_cut(number)) : f(number)
    end
end
const _asin_scalar = _inverse_trig(asin, "asin")
const _acos_scalar = _inverse_trig(acos, "acos")
eq_asin(value) = _function_of(asin, _asin_scalar, value)
eq_acos(value) = _function_of(acos, _acos_scalar, value)
eq_atan(value) = _function_of(atan, x -> atan(_plain(x, "atan")), value)

# --------------------------------------------------------------- type predicates

"`IsScalar(x)`: 1 for a real or complex scalar (a quantity with units counts)."
eq_isscalar(value) = _boolean(value isa Number)

"`IsArray(x)`: 1 for a vector or matrix."
eq_isarray(value) = _boolean(isarr(value))

"`IsString(x)`: 1 for a string."
eq_isstring(value) = _boolean(value isa AbstractString)
