# the reference application value and operator semantics. Generated worksheet code calls these
# functions instead of Julia operators directly.

"An evaluation error that can be caught by a reference application `on error` branch."
struct EqError <: Exception
    message::String
    "Index of the program statement that raised the error, set by `eq_locate`."
    statement::Union{Nothing,Int}
end

EqError(message::AbstractString) = EqError(String(message), nothing)

function Base.showerror(io::IO, error::EqError)
    print(io, "EqError: ", error.message)
    error.statement === nothing || print(io, " (statement ", error.statement, ")")
end
eqerror(message::AbstractString) = throw(EqError(String(message)))

"the reference application's dynamically scoped array origin."
const ORIGIN = ScopedValue(DEFAULT_ORIGIN)

origin() = ORIGIN[]
with_origin(f, value::Integer) = with(f, ORIGIN => Int(value))

"Relative tolerance of approximate equality."
const APPROX_EQUAL_RTOL = 1e-12

"""
The worksheet setting `exact-boolean`: `true` compares `=` and `!=` exactly
, `false` compares with a relative tolerance.
"""
const EXACT_BOOLEAN = ScopedValue(true)

exact_boolean() = EXACT_BOOLEAN[]
with_exact_boolean(f, value::Bool) = with(f, EXACT_BOOLEAN => value)

isarr(value) = value isa AbstractMatrix
isnum(value) = value isa Number

eqnum(value::Union{Integer,Rational}) = Float64(value)
eqnum(value::Complex{<:Integer}) = ComplexF64(value)
eqnum(value) = value

_isplain(type) = type <: Union{Real,Complex} && !(type <: Bool)

function _join(left::Type, right::Type)
    left === right && return left
    _isplain(left) && _isplain(right) && return promote_type(left, right)
    Any
end

"Return a dense matrix with the narrowest safe element type."
function narrow(matrix::AbstractMatrix)
    isempty(matrix) && return Matrix{Float64}(undef, size(matrix)...)
    target = mapreduce(typeof, _join, matrix)
    target === eltype(matrix) && matrix isa Matrix && return matrix
    convert(Matrix{target}, matrix)
end
narrow(value) = value

"Construct a matrix from elements written in visual row-major order."
function eq_matrix(rows::Integer, cols::Integer, elements...)
    rows >= 0 && cols >= 0 || eqerror("matrix dimensions cannot be negative")
    expected = Base.Checked.checked_mul(Int(rows), Int(cols))
    length(elements) == expected ||
        eqerror("matrix literal needs $expected elements, got $(length(elements))")
    matrix = Matrix{Any}(undef, rows, cols)
    index = 0
    for row in 1:rows, col in 1:cols
        index += 1
        matrix[row, col] = eqnum(elements[index])
    end
    narrow(matrix)
end

eq_vec(elements...) = eq_matrix(length(elements), 1, elements...)
eq_rowvec(elements...) = eq_matrix(1, length(elements), elements...)

"""
Copy arrays at the reference application value-semantics boundaries. Arrays that may hold other
arrays (`Matrix{Any}`) are copied deeply, so nested element assignment on the
copy never reaches the original.
"""
eq_val(value::AbstractMatrix) = isbitstype(eltype(value)) ? copy(value) : deepcopy(value)
eq_val(value) = value

function _julia_index(index)
    index isa Number || eqerror("an index must be a number")
    index isa Unitful.AbstractQuantity && eqerror("an index must be unitless")
    index isa Complex && imag(index) != 0 && eqerror("an index must be real")
    real_index = real(index)
    isinteger(real_index) || eqerror("an index must be an integer")
    converted = try
        Int(real_index) - origin() + 1
    catch error
        error isa InexactError && eqerror("index is outside the supported integer range")
        rethrow()
    end
    converted >= 1 || eqerror("index $(Int(real_index)) is below ORIGIN = $(origin())")
    converted
end

function eq_index(vector::AbstractMatrix, index)
    size(vector, 2) == 1 || eqerror("one index needs a vector; use two indices for a matrix")
    row = _julia_index(index)
    row <= size(vector, 1) || eqerror("index out of range")
    vector[row, 1]
end

function eq_index(matrix::AbstractMatrix, row_index, col_index)
    row = _julia_index(row_index)
    col = _julia_index(col_index)
    row <= size(matrix, 1) && col <= size(matrix, 2) || eqerror("index out of range")
    matrix[row, col]
end

"""
    eq_call(element, name, args...)

Call a function that an array holds:
`F[i](x)` and `F[i, j](x)` call the element the index selects. `name` is the element as
written in the worksheet, used only by the error of an element that is not a function —
without the check Julia would answer "objects of type Float64 are not callable", which
does not say which element failed.
"""
function eq_call(element, name, args...)
    element isa Function || eqerror("$name is not a function")
    element(args...)
end

_as_array(::Nothing) = Matrix{Float64}(undef, 0, 0)
_as_array(value::AbstractMatrix) = value
function _as_array(value)
    matrix = Matrix{typeof(value)}(undef, 1, 1)
    matrix[1, 1] = value
    matrix
end

function _grow_set!(matrix::AbstractMatrix, value, row::Int, col::Int)
    rows = max(size(matrix, 1), row)
    cols = max(size(matrix, 2), col)
    grows = (rows, cols) != size(matrix)
    if grows || !(value isa eltype(matrix))
        target = _join(eltype(matrix), typeof(value))
        grows && (target = _join(target, Float64))
        replacement = Matrix{target}(undef, rows, cols)
        grows && fill!(replacement, 0.0)
        replacement[1:size(matrix, 1), 1:size(matrix, 2)] .= matrix
        matrix = replacement
    end
    matrix[row, col] = value
    matrix
end

function eq_setindex!(target, value, index)
    matrix = _as_array(target)
    size(matrix, 2) <= 1 ||
        eqerror("one index needs a vector; use two indices for a matrix")
    _grow_set!(matrix, eqnum(value), _julia_index(index), 1)
end

eq_setindex!(target, value, row, col) =
    _grow_set!(_as_array(target), eqnum(value), _julia_index(row), _julia_index(col))

function eq_col(matrix, index)
    isarr(matrix) || eqerror("the column operator needs a matrix")
    col = _julia_index(index)
    col <= size(matrix, 2) || eqerror("column index out of range")
    matrix[:, col:col]
end

function eq_row(matrix, index)
    isarr(matrix) || eqerror("the row operator needs a matrix")
    row = _julia_index(index)
    row <= size(matrix, 1) || eqerror("row index out of range")
    matrix[row:row, :]
end

function eq_setcol!(target, value, index)
    vector = _as_array(value)
    size(vector, 2) == 1 || eqerror("a column must be a vector")
    matrix = _as_array(target)
    col = _julia_index(index)
    rows = size(vector, 1)
    size(matrix, 1) > rows && size(matrix, 2) > 0 &&
        eqerror("column length does not match the matrix")
    for row in rows:-1:1
        matrix = _grow_set!(matrix, vector[row, 1], row, col)
    end
    matrix
end

function eq_setrow!(target, value, index)
    vector = _as_array(value)
    size(vector, 1) == 1 || eqerror("a row must be a row vector")
    matrix = _as_array(target)
    row = _julia_index(index)
    cols = size(vector, 2)
    size(matrix, 2) > cols && size(matrix, 1) > 0 &&
        eqerror("row length does not match the matrix")
    for col in cols:-1:1
        matrix = _grow_set!(matrix, vector[1, col], row, col)
    end
    matrix
end

function eq_unpack(matrix, rows::Integer, cols::Integer)
    isarr(matrix) || eqerror("the right side of a multiple assignment must be an array")
    size(matrix) == (rows, cols) || eqerror(
        "multiple assignment: expected a $(rows)x$(cols) array, got " *
        "$(size(matrix, 1))x$(size(matrix, 2))",
    )
    Tuple(matrix[row, col] for row in 1:rows for col in 1:cols)
end

"Remove dimensionless Unitful wrappers and normalize integer results."
_clean(value::Unitful.AbstractQuantity) =
    dimension(value) == NoDims ? eqnum(uconvert(NoUnits, value)) : value
_clean(value::Integer) = Float64(value)
_clean(value) = value

function _unitsafe(operation, arguments...)
    try
        _clean(operation(arguments...))
    catch error
        error isa Unitful.DimensionError &&
            eqerror("the units in this expression do not match")
        rethrow()
    end
end

_scalar_add(left::Number, right::Number) = _unitsafe(+, left, right)
_scalar_sub(left::Number, right::Number) = _unitsafe(-, left, right)
_scalar_mul(left::Number, right::Number) = _unitsafe(*, left, right)
function _scalar_div(left::Number, right::Number)
    iszero(right) && eqerror("can't divide by zero")
    _unitsafe(/, left, right)
end
_nonnumeric(left, right) = isarr(left) || isarr(right) || eqerror("this operation needs numbers")
_scalar_add(left, right) = (_nonnumeric(left, right); eq_add(left, right))
_scalar_sub(left, right) = (_nonnumeric(left, right); eq_sub(left, right))
_scalar_mul(left, right) = (_nonnumeric(left, right); eq_mul(left, right))
_scalar_div(left, right) = (_nonnumeric(left, right); eq_div(left, right))

function _check_strings(left, right)
    (left isa AbstractString || right isa AbstractString) &&
        eqerror("this operation needs numbers, not strings")
end

function _elementwise(operation, left, right)
    if isarr(left) && isarr(right)
        size(left) == size(right) || eqerror("the array dimensions do not match")
        narrow(map(operation, left, right))
    elseif isarr(left)
        narrow(map(value -> operation(value, right), left))
    elseif isarr(right)
        narrow(map(value -> operation(left, value), right))
    else
        operation(left, right)
    end
end

eq_add(left, right) = (_check_strings(left, right); _elementwise(_scalar_add, left, right))
eq_sub(left, right) = (_check_strings(left, right); _elementwise(_scalar_sub, left, right))
"""
    eq_percent(value)

the reference application's postfix percent, `x%`: the value
divided by 100, with the division semantics of `/` (`eq_div`). It adds no unit of its own, so
`3.4%` is `0.034` and a value that carries units keeps them (`(5·m)%` is `0.05 m`); an array is
divided elementwise. ``: what the reference application shows as the value of
a percent is not confirmed by a readable saved result.
"""
eq_percent(value) = eq_div(value, 100)

"""
    eq_permille(value)

The per mille `x‰`, an Equavela operator
built like the percent: the value divided by 1000 with the division semantics of `/`.
"""
eq_permille(value) = eq_div(value, 1000)

"""
    eq_polar(magnitude, angle)

the reference application's polar operator `r∠θ`: the complex
number of magnitude `r` and angle `θ`, `r·e^(i·θ)`, with the semantics of `·` and `exp`.
"""
eq_polar(magnitude, angle) = eq_mul(magnitude, eq_exp(eq_mul(im, angle)))

eq_neg(value::Number) = _clean(-value)
eq_neg(value::AbstractMatrix) = narrow(map(eq_neg, value))
eq_neg(value) = eqerror("this operation needs a number")

function eq_mul(left, right)
    _check_strings(left, right)
    isnum(left) && isnum(right) && return _scalar_mul(left, right)
    (isnum(left) || isnum(right)) && return _elementwise(_scalar_mul, left, right)
    isarr(left) && isarr(right) || eqerror("multiplication needs numbers or arrays")
    if size(left, 2) == 1 && size(right, 2) == 1 && size(left, 1) == size(right, 1)
        return eq_dot(left, right)
    end
    size(left, 2) == size(right, 1) ||
        eqerror("the matrix dimensions do not match for multiplication")
    result = _matrix_multiply(left, right)
    size(result) == (1, 1) ? result[1, 1] : result
end

function _matrix_multiply(left::AbstractMatrix, right::AbstractMatrix)
    if _isplain(eltype(left)) && _isplain(eltype(right))
        return left * right
    end
    size(left, 2) > 0 || eqerror("cannot multiply empty matrices")
    result = Matrix{Any}(undef, size(left, 1), size(right, 2))
    for row in axes(left, 1), col in axes(right, 2)
        accumulator = _scalar_mul(left[row, 1], right[1, col])
        for index in 2:size(left, 2)
            accumulator =
                _scalar_add(accumulator, _scalar_mul(left[row, index], right[index, col]))
        end
        result[row, col] = accumulator
    end
    narrow(result)
end

"Dot product; the reference application conjugates the second vector for complex values."
function eq_dot(left::AbstractMatrix, right::AbstractMatrix)
    size(left, 2) == 1 && size(right, 2) == 1 && size(left, 1) == size(right, 1) ||
        eqerror("the dot product needs two vectors of the same length")
    !isempty(left) || eqerror("the dot product needs non-empty vectors")
    accumulator = _scalar_mul(left[1, 1], conj(right[1, 1]))
    for index in 2:size(left, 1)
        accumulator =
            _scalar_add(accumulator, _scalar_mul(left[index, 1], conj(right[index, 1])))
    end
    accumulator
end

function eq_cross(left, right)
    isarr(left) && isarr(right) && size(left) == (3, 1) && size(right) == (3, 1) ||
        eqerror("the cross product needs two 3-element vectors")
    eq_vec(
        eq_sub(eq_mul(left[2], right[3]), eq_mul(left[3], right[2])),
        eq_sub(eq_mul(left[3], right[1]), eq_mul(left[1], right[3])),
        eq_sub(eq_mul(left[1], right[2]), eq_mul(left[2], right[1])),
    )
end

"""
Division: scalar / square matrix is `s·M⁻¹`; matrix / square matrix is
`A·B⁻¹`; every other array case is elementwise.
"""
function eq_div(left, right)
    _check_strings(left, right)
    if isarr(right) && size(right, 1) == size(right, 2)
        if isnum(left)
            return eq_mul(left, eq_inv(right))
        elseif isarr(left) && size(left, 2) == size(right, 1)
            return _matrix_multiply(left, eq_inv(right))
        end
    end
    _elementwise(_scalar_div, left, right)
end

# A square matrix of plain numbers (no units, no nested arrays), as Julia takes it.
_plain_square(value) =
    value isa AbstractMatrix && size(value, 1) == size(value, 2) && !isempty(value) &&
    all(element -> element isa Number && !(element isa Unitful.AbstractQuantity), value)

"""
`M^p` for a non-integer `p` and `s^M` for a scalar `s`: the matrix power
`exp(p log M)` and the matrix exponential `exp(M log s)`, as in Julia and MATLAB. A matrix
that has no such power (`[0 1; 0 0]^0.5`, where Julia answers with zeros) is an error.
"""
function _julia_matrix_power(base, exponent, root_of=nothing)
    result = try
        base^exponent
    catch error
        error isa LinearAlgebra.SingularException &&
            eqerror("this matrix is singular")
        error isa LinearAlgebra.LAPACKException &&
            eqerror("the matrix power did not converge")
        error isa DomainError && eqerror("the matrix has no such power")
        rethrow()
    end
    all(isfinite, result) || eqerror("the matrix has no such power")
    if root_of !== nothing   # exponent 1/n: the n-th power of the result must give the matrix back
        check = result^root_of
        isapprox(check, base; rtol=1e-8, atol=1e-8 * norm(base)) ||
            eqerror("the matrix has no such power")
    end
    narrow(_real_if_possible(result))
end

function eq_pow(value, exponent)
    _check_strings(value, exponent)
    if isarr(exponent)
        isnum(value) && !(value isa Unitful.AbstractQuantity) && _plain_square(exponent) &&
            return _julia_matrix_power(value, Matrix(float.(exponent)))
        eqerror("the exponent must be a scalar")
    end
    isnum(value) && return _scalar_pow(value, exponent)
    isarr(value) || eqerror("power needs a number or array")
    if size(value, 1) == size(value, 2)
        real_exponent = real(exponent)
        if !(imag(exponent) == 0 && isinteger(real_exponent))
            _plain_square(value) && !(exponent isa Unitful.AbstractQuantity) ||
                eqerror("a matrix power needs an integer exponent")
            inverse = imag(exponent) == 0 ? 1 / real_exponent : nothing
            root = inverse !== nothing && isinteger(inverse) && abs(inverse) >= 2 ?
                   Int(inverse) : nothing
            return _julia_matrix_power(Matrix(float.(value)), exponent, root)
        end
        integer_exponent = Int(real_exponent)
        integer_exponent == 0 && return eq_identity(size(value, 1))
        base = integer_exponent < 0 ? eq_inv(value) : value
        result = base
        for _ in 2:abs(integer_exponent)
            result = _matrix_multiply(result, base)
        end
        return result
    end
    narrow(map(element -> _scalar_pow(element, exponent), value))
end

function _scalar_pow(value::Number, exponent::Number)
    if value isa Unitful.AbstractQuantity
        isinteger(exponent) && return _unitsafe(^, value, Int(exponent))
        return _unitsafe(^, value, rationalize(Float64(exponent)))
    end
    iszero(value) && real(exponent) < 0 && eqerror("can't divide by zero")
    if value isa Real && exponent isa Real
        value < 0 && !isinteger(exponent) &&
            return _clean(complex(float(value))^exponent)
        # `float` keeps a dual number of automatic differentiation; an exponent that is one is
        # never rounded to an integer, so its derivative is kept.
        result = isinteger(exponent) && abs(exponent) < 2^31 && exponent isa Union{Integer,AbstractFloat} ?
                 float(value)^Int(exponent) : float(value)^float(exponent)
        isfinite(result) || !isfinite(value) || !isfinite(exponent) || eqerror(
            "Found a number with a magnitude greater than 10^307 while trying to evaluate this expression.",
        )
        return result
    end
    _clean(value^exponent)
end

eq_transpose(value::AbstractMatrix) = permutedims(value)
eq_transpose(value) = value

function eq_inv(matrix::AbstractMatrix)
    size(matrix, 1) == size(matrix, 2) || eqerror("the inverse needs a square matrix")
    narrowed = narrow(matrix)
    eltype(narrowed) === Any &&
        eqerror("cannot invert a matrix with mixed units or nested elements")
    try
        inv(narrowed)
    catch error
        error isa SingularException && eqerror("this matrix is singular")
        rethrow()
    end
end
eq_inv(value::Number) = _scalar_div(1.0, value)

eq_abs(value::Number) = _clean(abs(value))
function eq_abs(matrix::AbstractMatrix)
    if size(matrix, 2) == 1 || size(matrix, 1) == 1
        !isempty(matrix) || eqerror("the vector cannot be empty")
        accumulator = _scalar_mul(abs(matrix[1]), abs(matrix[1]))
        for index in 2:length(matrix)
            accumulator =
                _scalar_add(accumulator, _scalar_mul(abs(matrix[index]), abs(matrix[index])))
        end
        return _clean(sqrt(accumulator))
    elseif size(matrix, 1) == size(matrix, 2)
        return eq_det(matrix)
    end
    eqerror("|x| needs a number, a vector or a square matrix")
end
eq_abs(value) = eqerror("|x| needs a number, a vector or a square matrix")

function eq_det(matrix::AbstractMatrix)
    size(matrix, 1) == size(matrix, 2) ||
        eqerror("the determinant needs a square matrix")
    narrowed = narrow(matrix)
    eltype(narrowed) === Any &&
        eqerror("cannot take the determinant of a matrix with mixed units")
    _clean(det(narrowed))
end

eq_conj(value::Number) = conj(value)
eq_conj(matrix::AbstractMatrix) = narrow(map(eq_conj, matrix))

function eq_vectorize(function_value, arguments...)
    arrays = [argument for argument in arguments if isarr(argument)]
    isempty(arrays) && return function_value(arguments...)
    shape = size(first(arrays))
    all(array -> size(array) == shape, arrays) ||
        eqerror("vectorize: the arrays must have the same size")
    result = Matrix{Any}(undef, shape...)
    for index in CartesianIndices(shape)
        result[index] = function_value(
            (isarr(argument) ? argument[index] : argument for argument in arguments)...,
        )
    end
    narrow(result)
end

_boolean(value::Bool) = value ? 1.0 : 0.0

const _ORDERING = Set{Function}([<, >, <=, >=])

function _compare_scalars(operation, left, right)
    left_string = left isa AbstractString
    right_string = right isa AbstractString
    left_string == right_string ||
        eqerror("a comparison needs two values of the same type")
    if !left_string && (left isa AbstractMatrix || right isa AbstractMatrix)
        operation in _ORDERING && eqerror("nested arrays cannot be ordered")
        return _boolean(operation(left, right))
    end
    if operation in _ORDERING && !left_string
        for value in (left, right)
            value isa Complex && imag(value) != 0 &&
                eqerror("complex numbers cannot be ordered")
        end
        left, right = real(left), real(right)
    end
    if left isa Number && right isa Number
        # quantities of different dimensions cannot be compared (also for `=`).
        _same_dimension(left, right) ||
            eqerror("the units in this comparison do not match")
        if !exact_boolean() && (operation === (==) || operation === (!=))
            equal = _approx_equal(left, right)
            return _boolean(operation === (==) ? equal : !equal)
        end
    end
    try
        _boolean(operation(left, right))
    catch error
        error isa Unitful.DimensionError &&
            eqerror("the units in this comparison do not match")
        rethrow()
    end
end

"""
Approximate equality: equal when the difference is at most
`APPROX_EQUAL_RTOL` times the larger magnitude. Quantities are compared in SI base units.
"""
function _approx_equal(left::Number, right::Number)
    a = left isa Unitful.AbstractQuantity ? ustrip(upreferred(left)) : left
    b = right isa Unitful.AbstractQuantity ? ustrip(upreferred(right)) : right
    a == b || isfinite(a) && isfinite(b) &&
        abs(a - b) <= APPROX_EQUAL_RTOL * max(abs(a), abs(b))
end

"Comparison, elementwise on arrays; the result is 1 or 0."
_compare(operation, left, right) =
    _elementwise((l, r) -> _compare_scalars(operation, l, r), left, right)

eq_eq(left, right) = _compare(==, left, right)
eq_ne(left, right) = _compare(!=, left, right)
eq_lt(left, right) = _compare(<, left, right)
eq_gt(left, right) = _compare(>, left, right)
eq_le(left, right) = _compare(<=, left, right)
eq_ge(left, right) = _compare(>=, left, right)

"""
Chained comparison `a < b < c` means `a < b ∧ b < c`. `operations`
holds the comparison functions (`eq_lt`, ...); each operand is evaluated once
by the caller. Arrays combine elementwise.
"""
function eq_chain(operations, operands...)
    length(operands) == length(operations) + 1 && !isempty(operations) ||
        eqerror("a comparison chain needs one more operand than comparisons")
    result = operations[1](operands[1], operands[2])
    for index in 2:length(operations)
        step = operations[index](operands[index], operands[index+1])
        result = _elementwise((x, y) -> _boolean(x != 0 && y != 0), result, step)
    end
    result
end

eq_true(value::Number) = !iszero(value)
eq_true(value) = eqerror("a condition must be a scalar")

"""
Boolean operators treat nonzero as true and need scalars. A function
as the right operand is a thunk that is evaluated only when needed, which
gives the short-circuit behaviour of .
"""
eq_and(left, right) = _boolean(eq_true(left) & eq_true(right))
eq_and(left, right::Function) = eq_true(left) ? _boolean(eq_true(right())) : 0.0
eq_or(left, right) = _boolean(eq_true(left) | eq_true(right))
eq_or(left, right::Function) = eq_true(left) ? 1.0 : _boolean(eq_true(right()))
eq_xor(left, right) = _boolean(eq_true(left) != eq_true(right))
eq_not(value) = _boolean(!eq_true(value))

"`if(c, a, b)` evaluates only the selected branch."
eq_if(condition, then_branch::Function, else_branch::Function) =
    eq_true(condition) ? then_branch() : else_branch()

"`x ∈ v`: 1 if `x` equals an element of the array `v`."
function eq_in(value, collection)
    isarr(collection) || eqerror("the right side of ∈ must be an array")
    _boolean(any(element -> eq_true(_compare_scalars(==, value, element)), collection))
end

function eq_identity(size_value)
    size_value isa Number && !(size_value isa Unitful.AbstractQuantity) &&
        isinteger(real(size_value)) && imag(size_value) == 0 ||
        eqerror("identity size must be a unitless integer")
    size_int = Int(real(size_value))
    size_int >= 0 || eqerror("identity size cannot be negative")
    Matrix{Float64}(I, size_int, size_int)
end

"""
`matrix(m, n, f)`: the `m x n` matrix whose element `(i, j)` is `f(i, j)` for `i = 0..m-1` and
`j = 0..n-1` (the reference application help text) whatever ORIGIN is
. `f` is a worksheet function.
"""
function eq_matrix_fn(rows_value, cols_value, f)
    function count(value, what)
        value isa Number && !(value isa Unitful.AbstractQuantity) &&
            isinteger(real(value)) && imag(value) == 0 ||
            eqerror("matrix: the number of $what must be a unitless integer")
        n = Int(real(value))
        n >= 0 || eqerror("matrix: the number of $what cannot be negative")
        n
    end
    f isa Function || eqerror("matrix: the third argument must be a function")
    m = count(rows_value, "rows")
    n = count(cols_value, "columns")
    result = Matrix{Any}(undef, m, n)
    for j in 1:n, i in 1:m
        result[i, j] = f(Float64(i - 1), Float64(j - 1))
        result[i, j] isa Union{Number,Unitful.AbstractQuantity} ||
            eqerror("matrix: the function must return a scalar")
    end
    narrow(result)
end

function eq_diag(value)
    isarr(value) || eqerror("diag needs an array")
    if size(value, 2) == 1
        result = Matrix{Any}(undef, size(value, 1), size(value, 1))
        fill!(result, 0.0)
        for index in axes(value, 1)
            result[index, index] = value[index, 1]
        end
        return narrow(result)
    elseif size(value, 1) == size(value, 2)
        return narrow(reshape(Any[value[index, index] for index in axes(value, 1)], :, 1))
    end
    eqerror("diag needs a vector or a square matrix")
end
