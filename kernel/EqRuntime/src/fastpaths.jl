# Fast paths for the scalar and vector code that worksheet programs generate.
#
# Every method below only takes arguments of exactly the types `Float64` and
# `Matrix{Float64}` and gives the same result as the general method for them; anything else
# (units, complex numbers, strings, nested arrays, growth into another element type) still
# reaches the general code. Concrete argument types let Julia infer the types of a program's
# locals, which removes the boxing and the dynamic dispatch of the general path.

# ---------------------------------------------------------------- arithmetic

@inline eq_add(left::Float64, right::Float64) = left + right
@inline eq_sub(left::Float64, right::Float64) = left - right
@inline eq_mul(left::Float64, right::Float64) = left * right
@inline function eq_div(left::Float64, right::Float64)
    iszero(right) && eqerror("can't divide by zero")
    left / right
end

# NaN compares false, as in the general path.
@inline eq_min(left::Float64, right::Float64) = right < left ? right : left
@inline eq_max(left::Float64, right::Float64) = right > left ? right : left

# ---------------------------------------------------------------- comparisons

@inline eq_lt(left::Float64, right::Float64) = _boolean(left < right)
@inline eq_gt(left::Float64, right::Float64) = _boolean(left > right)
@inline eq_le(left::Float64, right::Float64) = _boolean(left <= right)
@inline eq_ge(left::Float64, right::Float64) = _boolean(left >= right)
@inline eq_eq(left::Float64, right::Float64) =
    _boolean(exact_boolean() ? left == right : _approx_equal(left, right))
@inline eq_ne(left::Float64, right::Float64) =
    _boolean(exact_boolean() ? left != right : !_approx_equal(left, right))

@inline eq_true(value::Float64) = !iszero(value)

# ---------------------------------------------------------------- ranges

# `a..b` of two real numbers: no unit or complex checks to make.
eq_range(first::Float64, last::Float64) = _make_range(first, last >= first ? 1.0 : -1.0, last)

# ---------------------------------------------------------------- indices

# The Julia index of a Float64 index value, or 0 when it is not an integer from ORIGIN on
# (the general method then reports the error).
@inline function _fast_index(index::Float64)
    whole = unsafe_trunc(Int, index)
    whole == index ? whole - origin() + 1 : 0
end

@inline eq_val(value::Matrix{Float64}) = copy(value)

@inline function eq_index(vector::Matrix{Float64}, index::Float64)::Float64
    row = _fast_index(index)
    if size(vector, 2) == 1 && 1 <= row <= size(vector, 1)
        return @inbounds vector[row, 1]
    end
    invoke(eq_index, Tuple{AbstractMatrix,Any}, vector, index)::Float64
end

@inline function eq_index(matrix::Matrix{Float64}, row_index::Float64, col_index::Float64)::Float64
    row, col = _fast_index(row_index), _fast_index(col_index)
    if 1 <= row <= size(matrix, 1) && 1 <= col <= size(matrix, 2)
        return @inbounds matrix[row, col]
    end
    invoke(eq_index, Tuple{AbstractMatrix,Any,Any}, matrix, row_index, col_index)::Float64
end

# Writing a Float64 into a Float64 array stays a Float64 array, also when it grows.
@inline function eq_setindex!(target::Matrix{Float64}, value::Float64, index::Float64)::Matrix{Float64}
    row = _fast_index(index)
    if size(target, 2) == 1 && 1 <= row <= size(target, 1)
        @inbounds target[row, 1] = value
        return target
    end
    invoke(eq_setindex!, Tuple{Any,Any,Any}, target, value, index)::Matrix{Float64}
end

@inline function eq_setindex!(target::Matrix{Float64}, value::Float64, row_index::Float64, col_index::Float64)::Matrix{Float64}
    row, col = _fast_index(row_index), _fast_index(col_index)
    if 1 <= row <= size(target, 1) && 1 <= col <= size(target, 2)
        @inbounds target[row, col] = value
        return target
    end
    invoke(eq_setindex!, Tuple{Any,Any,Any,Any}, target, value, row_index, col_index)::Matrix{Float64}
end

# ---------------------------------------------------------------- hoisted ORIGIN
#
# A program reads ORIGIN once, at its entry, and passes it to every index operation. ORIGIN is
# a scoped value, and a read inside a dynamic scope (the kernel binds TOL, CTOL and ORIGIN
# around each evaluation) is several times slower than a read outside one. ORIGIN cannot change
# while a program runs (it is a worksheet setting). The general methods ignore the argument.

@inline function _fast_index(index::Float64, origin::Int)
    whole = unsafe_trunc(Int, index)
    whole == index ? whole - origin + 1 : 0
end

eq_index_o(vector, index, origin::Int) = eq_index(vector, index)
eq_index_o(matrix, row, col, origin::Int) = eq_index(matrix, row, col)
eq_setindex_o!(target, value, index, origin::Int) = eq_setindex!(target, value, index)
eq_setindex_o!(target, value, row, col, origin::Int) = eq_setindex!(target, value, row, col)

@inline function eq_index_o(vector::Matrix{Float64}, index::Float64, origin::Int)::Float64
    row = _fast_index(index, origin)
    if size(vector, 2) == 1 && 1 <= row <= size(vector, 1)
        return @inbounds vector[row, 1]
    end
    eq_index(vector, index)::Float64
end

@inline function eq_index_o(matrix::Matrix{Float64}, row_index::Float64, col_index::Float64, origin::Int)::Float64
    row, col = _fast_index(row_index, origin), _fast_index(col_index, origin)
    if 1 <= row <= size(matrix, 1) && 1 <= col <= size(matrix, 2)
        return @inbounds matrix[row, col]
    end
    eq_index(matrix, row_index, col_index)::Float64
end

@inline function eq_setindex_o!(target::Matrix{Float64}, value::Float64, index::Float64, origin::Int)::Matrix{Float64}
    row = _fast_index(index, origin)
    if size(target, 2) == 1 && 1 <= row <= size(target, 1)
        @inbounds target[row, 1] = value
        return target
    end
    eq_setindex!(target, value, index)::Matrix{Float64}
end

@inline function eq_setindex_o!(target::Matrix{Float64}, value::Float64, row_index::Float64, col_index::Float64, origin::Int)::Matrix{Float64}
    row, col = _fast_index(row_index, origin), _fast_index(col_index, origin)
    if 1 <= row <= size(target, 1) && 1 <= col <= size(target, 2)
        @inbounds target[row, col] = value
        return target
    end
    eq_setindex!(target, value, row_index, col_index)::Matrix{Float64}
end
