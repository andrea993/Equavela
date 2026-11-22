# Range variables, iterated sums/products and iterated assignment
# (compatibility section 7).

"""
    EqRange

A reference application range variable `a..b` (step +1, or -1 when `b < a`) or `a, next..b`
(step `next - a`). Values are `start + k*step` and the last value is snapped to
the end value when it lies within rounding distance of it
. Works with Unitful
quantities.
"""
struct EqRange{T,S}
    start::T
    step::S
    stop::T
    count::Int
    snapped::Bool
end

const _RANGE_TOLERANCE = 1e-9

function _range_number(value, what)
    value isa Number && !(value isa Complex && imag(value) != 0) ||
        eqerror("a range $what must be a real number")
    value isa Complex ? real(value) : eqnum(value)
end

function _make_range(start, step, stop)
    iszero(step) && eqerror("the range step must not be zero")
    quotient = try
        ratio = (stop - start) / step
        Float64(ratio isa Unitful.AbstractQuantity ? uconvert(NoUnits, ratio) : ratio)
    catch error
        error isa Unitful.DimensionError &&
            eqerror("the units of the range bounds and step do not match")
        rethrow()
    end
    isfinite(quotient) || eqerror("the range is too large")
    tolerance = _RANGE_TOLERANCE * max(1.0, abs(quotient))
    quotient < -tolerance && return EqRange(start, step, stop, 0, false)
    nearest = round(quotient)
    snapped = abs(quotient - nearest) <= tolerance
    count = snapped ? nearest : floor(quotient)
    count < 2^40 || eqerror("the range is too large")
    EqRange(start, step, stop, Int(count) + 1, snapped)
end

"`a..b`: step 1, or -1 when `b < a`."
function eq_range(first, last)
    a, b = _range_number(first, "bound"), _range_number(last, "bound")
    ascending = try
        b >= a
    catch error
        error isa Unitful.DimensionError &&
            eqerror("the units of the range bounds do not match")
        rethrow()
    end
    _make_range(a, ascending ? oneunit(a) : -oneunit(a), b)
end

"`a, next..b`: step `next - a`."
function eq_range(first, next, last)
    a = _range_number(first, "bound")
    n = _range_number(next, "second value")
    b = _range_number(last, "bound")
    step = try
        n - a
    catch error
        error isa Unitful.DimensionError &&
            eqerror("the units of the range values do not match")
        rethrow()
    end
    _make_range(a, step, b)
end

Base.length(range::EqRange) = range.count
Base.eltype(::Type{EqRange{T,S}}) where {T,S} = T

function Base.iterate(range::EqRange, index::Int=0)
    index >= range.count && return nothing
    value = range.snapped && index == range.count - 1 ? range.stop :
            range.start + index * range.step
    value, index + 1
end

"Evaluating a range (`i =`) shows its values as a column vector."
eq_collect(range::EqRange) = narrow(reshape(Any[value for value in range], :, 1))

"`f(i) =` with `i` a range variable: one result per value, as a column."
eq_map_range(f, range::EqRange) =
    narrow(reshape(Any[f(value) for value in range], :, 1))

# ------------------------------------------------- rows, columns and elements of a range
# the specification, the specification to 5: a range in the row operator, the
# column operator and the index selects a run of rows, a run of columns or a run of
# elements, in the order the range gives them.

"""
    _range_indices(range, limit, what)

The Julia indices of the values of `range`, in the order of the range. Every value is an
index of, so a value that is not a real unitless integer from `ORIGIN` is the
error of `_julia_index` and a value past `limit` is the operator's "out of range": a
selection is never shortened.
"""
function _range_indices(range::EqRange, limit::Int, what::AbstractString)
    indices = Vector{Int}(undef, length(range))
    for (position, value) in enumerate(range)
        index = _julia_index(value)
        index <= limit || eqerror("$what index out of range")
        indices[position] = index
    end
    indices
end

"`M⟪a..b⟫`: the matrix of the rows `a..b`, in the order of the range."
function eq_row(matrix, index::EqRange)
    isarr(matrix) || eqerror("the row operator needs a matrix")
    matrix[_range_indices(index, size(matrix, 1), "row"), :]
end

"`M⟨a..b⟩`: the matrix of the columns `a..b`, in the order of the range."
function eq_col(matrix, index::EqRange)
    isarr(matrix) || eqerror("the column operator needs a matrix")
    matrix[:, _range_indices(index, size(matrix, 2), "column")]
end

"""
`v[a..b]`: the column vector of the elements `a..b` of a vector, in the order of the range
. A range with no values selects nothing: the result
is the empty array of .
"""
function eq_index(vector::AbstractMatrix, indices::EqRange)
    size(vector, 2) == 1 || eqerror("one index needs a vector; use two indices for a matrix")
    vector[_range_indices(indices, size(vector, 1), "row"), 1:1]
end

"""
`M[r, c]` with a range in one or both subscripts: the rows `r` and the
columns `c` together, in the order of the ranges. A range and an index give a column (`M[r, k]`) or a
row (`M[k, c]`), never a vector of another shape.
"""
function eq_index(matrix::AbstractMatrix, rows::EqRange, cols::EqRange)
    matrix[_range_indices(rows, size(matrix, 1), "row"), _range_indices(cols, size(matrix, 2), "column")]
end
function eq_index(matrix::AbstractMatrix, rows::EqRange, col)
    c = _julia_index(col)
    c <= size(matrix, 2) || eqerror("column index out of range")
    matrix[_range_indices(rows, size(matrix, 1), "row"), c:c]
end
function eq_index(matrix::AbstractMatrix, row, cols::EqRange)
    r = _julia_index(row)
    r <= size(matrix, 1) || eqerror("row index out of range")
    matrix[r:r, _range_indices(cols, size(matrix, 2), "column")]
end

"""
Iterated assignment `x[i] := f(i)` with `i` a range variable. `f(x, i)`
receives the current array, so recurrences work; the
array grows as needed.
"""
function eq_iter_setindex(target, range::EqRange, f)
    for value in range
        target = eq_setindex!(target, f(target, value), value)
    end
    target
end

"Iterated column assignment `X<k> := f(X, k)`."
function eq_iter_setcol(target, range::EqRange, f)
    for value in range
        target = eq_setcol!(target, f(target, value), value)
    end
    target
end

# ------------------------------------------------------------- sums, products

function _accumulate(f, range::EqRange, combine, empty)
    accumulator = nothing
    for value in range
        term = f(value)
        accumulator = accumulator === nothing ? term : combine(accumulator, term)
    end
    accumulator === nothing ? empty : accumulator
end

"""
`∑[k ∈ a..b] f(k)`: terms are added in order with `+` semantics (arrays can be
summed); descending when `b < a`. Non-integer
bounds step by 1 from `a` while not passing `b`.
"""
eq_sum(f, lower, upper) = eq_sum(f, eq_range(lower, upper))
eq_sum(f, range::EqRange) = _accumulate(f, range, eq_add, 0.0)

"`∏[k ∈ a..b] f(k)`: same order rules as `eq_sum`."
eq_prod(f, lower, upper) = eq_prod(f, eq_range(lower, upper))
eq_prod(f, range::EqRange) = _accumulate(f, range, eq_mul, 1.0)

"`n!` for non-negative integers; a Float64 overflow is an error."
function eq_factorial(n)
    n isa Real && !(n isa Unitful.AbstractQuantity) && isinteger(n) && n >= 0 ||
        eqerror("factorial needs a non-negative integer")
    n <= 170 || eqerror("numeric overflow in factorial")
    Float64(factorial(big(Int(n))))
end
