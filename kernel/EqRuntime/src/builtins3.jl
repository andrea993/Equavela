# the reference application built-in functions (batch 5): match/lookup family, ranking, matrix
# norms and condition numbers, qr, lsolve, geninv, more statistics and number
# theory. Specs: the specification sections 2, 3, 4, 5, 7.

# ------------------------------------------------- match and lookup family

_is_integer_value(value) =
    value isa Number && !(value isa Unitful.AbstractQuantity) && imag(value) == 0 &&
    isinteger(real(value))

"A key that orders scalars: quantities are compared in their SI base units."
_order_key(value::Unitful.AbstractQuantity) = real(ustrip(upreferred(value)))
_order_key(value) = real(value)

"""
Positions (1-based, in scan order) of the elements of `elements` selected by
`modifier`: none or `"eq"` (equal), `"not"`, `"gt"`, `"lt"`, `"geq"`, `"leq"`,
`"near"` (all elements at the smallest distance from `z`), `"range"` (the
position `i` with `elements[i] <= z < elements[i+1]`, the last element only
when equal; the elements must ascend), or a function `f(element, z)` whose
nonzero result selects the element.
"""
function _positions(z, elements::AbstractVector, modifier, name)
    length(modifier) <= 1 || eqerror("$name takes at most one modifier")
    isempty(modifier) && return findall(element -> _same_value(z, element), elements)
    chosen = only(modifier)
    if chosen isa Function
        return findall(element -> eq_true(chosen(element, z)), elements)
    end
    chosen isa AbstractString ||
        eqerror("$name: the modifier must be a string or a function")
    ordered(operation) =
        findall(element -> eq_true(_compare_scalars(operation, element, z)), elements)
    chosen == "eq" && return findall(element -> _same_value(z, element), elements)
    chosen == "not" && return findall(element -> !_same_value(z, element), elements)
    chosen == "gt" && return ordered(>)
    chosen == "lt" && return ordered(<)
    chosen == "geq" && return ordered(>=)
    chosen == "leq" && return ordered(<=)
    if chosen == "near"
        isempty(elements) && return Int[]
        distances = map(elements) do element
            (element isa Number && z isa Number) ||
                eqerror("$name: \"near\" needs numbers")
            _order_key(eq_abs(eq_sub(element, z)))
        end
        return findall(==(minimum(distances)), distances)
    elseif chosen == "range"
        keys = map(elements) do element
            element isa Number || eqerror("$name: \"range\" needs numbers")
            _order_key(element)
        end
        z isa Number || eqerror("$name: \"range\" needs a number")
        issorted(keys) || eqerror("$name: \"range\" needs ascending values")
        target = _order_key(z)
        isempty(keys) && return Int[]
        target == last(keys) && return [length(keys)]
        index = findlast(<=(target), keys)
        return index === nothing || index == length(keys) ? Int[] : [index]
    end
    eqerror("$name: unknown modifier \"$chosen\"")
end

"""
`match(z, A [, modifier])`: indices (ORIGIN-aware) of the elements selected by
the modifier (default equal, see `_positions`). A vector gives a vector of
indices; a matrix gives a vector of `[row; col]` vectors in column-wise scan
order. No match is an error so that `on error` can catch it.
"""
function eq_match(value, array, modifier...)
    _need_array(array, "match")
    base = origin() - 1
    found = _positions(value, vec(array), modifier, "match")
    isempty(found) && eqerror("match: value not found")
    if size(array, 2) == 1
        return narrow(reshape(Any[Float64(position + base) for position in found], :, 1))
    end
    rows = size(array, 1)
    narrow(
        reshape(
            Any[
                eq_vec(mod1(position, rows) + base, cld(position, rows) + base) for
                position in found
            ],
            :,
            1,
        ),
    )
end

_column_of(values) = narrow(reshape(Any[values...], :, 1))

"""
`lookup(z, A, B [, modifier])`: the elements of `B` at the positions where `A`
matches `z`, as a column vector in column-wise order. `A` and `B` must have the
same size; no match is an error.
"""
function eq_lookup(value, searched, results, modifier...)
    _need_array(searched, "lookup")
    _need_array(results, "lookup")
    size(searched) == size(results) ||
        eqerror("lookup: the arrays must have the same size")
    found = _positions(value, vec(searched), modifier, "lookup")
    isempty(found) && eqerror("lookup: value not found")
    _column_of(vec(results)[found])
end

"`vlookup(z, A, c [, modifier])`: column `c` (ORIGIN-aware) of the rows whose first entry matches `z`."
function eq_vlookup(value, matrix, column, modifier...)
    _need_array(matrix, "vlookup")
    col = _julia_index(column)
    col <= size(matrix, 2) || eqerror("vlookup: column out of range")
    found = _positions(value, matrix[:, 1], modifier, "vlookup")
    isempty(found) && eqerror("vlookup: value not found")
    _column_of(matrix[found, col])
end

"`hlookup(z, A, r [, modifier])`: row `r` (ORIGIN-aware) of the columns whose first entry matches `z`, as a column vector."
function eq_hlookup(value, matrix, row, modifier...)
    _need_array(matrix, "hlookup")
    r = _julia_index(row)
    r <= size(matrix, 1) || eqerror("hlookup: row out of range")
    found = _positions(value, vec(matrix[1, :]), modifier, "hlookup")
    isempty(found) && eqerror("hlookup: value not found")
    _column_of(matrix[r, found])
end

"`vhlookup(z1, z2, A [, modifier])`: the element at the first row matching `z1` (first column) and the first column matching `z2` (first row)."
function eq_vhlookup(row_value, col_value, matrix, modifier...)
    _need_array(matrix, "vhlookup")
    rows = _positions(row_value, matrix[:, 1], modifier, "vhlookup")
    cols = _positions(col_value, vec(matrix[1, :]), modifier, "vhlookup")
    (isempty(rows) || isempty(cols)) && eqerror("vhlookup: value not found")
    matrix[first(rows), first(cols)]
end

# ------------------------------------------------------------ rank and order

function _real_vector(vector, name)
    isarr(vector) && (size(vector, 1) == 1 || size(vector, 2) == 1) ||
        eqerror("$name needs a vector")
    all(element -> element isa Number, vector) || eqerror("$name needs numbers")
    any(element -> element isa Complex && imag(element) != 0, vector) &&
        eqerror("$name needs real values")
    vector
end

"`Rank(v)`: the rank of each element (1 = smallest); equal elements get the mean of their ranks."
function eq_Rank(vector)
    _real_vector(vector, "Rank")
    keys = map(_order_key, vec(vector))
    order = sortperm(keys)
    ranks = zeros(Float64, length(keys))
    start = 1
    while start <= length(order)
        stop = start
        while stop < length(order) && keys[order[stop+1]] == keys[order[start]]
            stop += 1
        end
        ranks[order[start:stop]] .= (start + stop) / 2
        start = stop + 1
    end
    reshape(ranks, size(vector))
end

"`order(v)`: indices (ORIGIN-aware) that put `v` in ascending order; stable."
function eq_order(vector)
    _real_vector(vector, "order")
    permutation = sortperm(map(_order_key, vec(vector)))
    reshape(Float64.(permutation .+ (origin() - 1)), size(vector))
end

# ------------------------------------------------- norms and condition numbers

function _numeric_matrix(matrix, name)
    _need_array(matrix, name)
    numeric = narrow(matrix)
    _isplain(eltype(numeric)) || eqerror("$name needs a numeric matrix without units")
    isempty(numeric) && eqerror("$name needs a non-empty matrix")
    numeric
end

"`norm1(M)`: the largest absolute column sum."
eq_norm1(matrix) = Float64(opnorm(_numeric_matrix(matrix, "norm1"), 1))
"`norm2(M)`: the largest singular value."
eq_norm2(matrix) = Float64(opnorm(_numeric_matrix(matrix, "norm2"), 2))
"`norme(M)`: the Euclidean (Frobenius) norm."
eq_norme(matrix) = Float64(norm(_numeric_matrix(matrix, "norme")))
"`normi(M)`: the largest absolute row sum."
eq_normi(matrix) = Float64(opnorm(_numeric_matrix(matrix, "normi"), Inf))

function _condition(matrix, name, measure)
    numeric = _numeric_matrix(matrix, name)
    size(numeric, 1) == size(numeric, 2) || eqerror("$name needs a square matrix")
    inverse = try
        inv(float(numeric))
    catch error
        (error isa SingularException || error isa LAPACKException) && return Inf
        rethrow()
    end
    all(isfinite, inverse) || return Inf
    Float64(measure(numeric) * measure(inverse))
end

"`cond1(M)`: condition number from the L1 norm; `Inf` for a singular matrix."
eq_cond1(matrix) = _condition(matrix, "cond1", m -> opnorm(m, 1))
"`cond2(M)`: condition number from the L2 norm (ratio of extreme singular values)."
eq_cond2(matrix) = _condition(matrix, "cond2", m -> opnorm(m, 2))
"`conde(M)`: condition number from the Euclidean norm."
eq_conde(matrix) = _condition(matrix, "conde", norm)
"`condi(M)`: condition number from the infinity norm."
eq_condi(matrix) = _condition(matrix, "condi", m -> opnorm(m, Inf))

# ------------------------------------------------ qr, geninv, lsolve

"""
`qr(M)`: `augment(Q, R)` with `Q` m x m orthogonal and `R` m x n upper
triangular, Julia's Householder QR (the basis and signs are LAPACK's, not the reference application's).
"""
function eq_qr(matrix)
    basis, triangle = _full_qr(_numeric_matrix(matrix, "qr"))
    hcat(basis, triangle)
end

"`geninv(M)`: the Moore-Penrose generalized inverse (the left inverse for full column rank)."
function eq_geninv(matrix)
    numeric = _numeric_matrix(matrix, "geninv")
    Matrix(pinv(float(numeric)))
end

"""
`lsolve(M, v)`: solves `M x = v`. A square non-singular `M` uses LU; a singular
or non-square `M` gives the least-squares solution `geninv(M) * v` when `v` is
consistent in size. `v` may have several columns.
"""
function eq_lsolve(matrix, right)
    numeric = _numeric_matrix(matrix, "lsolve")
    isarr(right) || eqerror("lsolve needs an array on the right")
    target = narrow(right)
    eltype(target) === Any && eqerror("lsolve needs a numeric right side without units")
    size(target, 1) == size(numeric, 1) ||
        eqerror("lsolve: the right side needs as many rows as the matrix")
    if size(numeric, 1) == size(numeric, 2)
        try
            return numeric \ target
        catch error
            error isa SingularException || error isa LAPACKException || rethrow()
            eqerror("lsolve: the matrix is singular")
        end
    end
    pinv(float(numeric)) * target
end

# --------------------------------------------- statistics and number theory

function _positive_numbers(arguments, name)
    values = _numbers(arguments, name)
    all(value -> imag(ustrip(value)) == 0 && real(ustrip(value)) > 0, values) ||
        eqerror("$name needs positive real numbers")
    values
end

"`gmean(A, B, ...)`: geometric mean of positive real numbers."
function eq_gmean(arguments...)
    values = _positive_numbers(arguments, "gmean")
    any(value -> value isa Unitful.AbstractQuantity, values) &&
        eqerror("gmean needs unitless values")
    product = prod(Float64.(values))
    isfinite(product) && product > 0 && return product^(1 / length(values))
    exp(sum(log, values) / length(values))
end

"`hmean(A, B, ...)`: harmonic mean of positive real numbers (units must agree)."
function eq_hmean(arguments...)
    values = _positive_numbers(arguments, "hmean")
    eqnum(_units_checked(() -> length(values) / sum(1 ./ values), "hmean"))
end

"`mode(A, B, ...)`: the most frequent value; the smallest of several candidates."
function eq_mode(arguments...)
    values = _numbers(arguments, "mode")
    any(value -> value isa Complex && imag(value) != 0, values) &&
        eqerror("mode needs real values")
    sorted = _units_checked(() -> sort(real.(values)), "mode")
    best, best_count, run_start = first(sorted), 0, 1
    for index in 1:length(sorted)
        if index == length(sorted) || sorted[index+1] != sorted[index]
            if index - run_start + 1 > best_count
                best, best_count = sorted[index], index - run_start + 1
            end
            run_start = index + 1
        end
    end
    eqnum(best)
end

"""
`percentile(v, p)`: value below which the fraction `p` (0 to 1) of `v` lies,
with linear interpolation between order statistics at position `p (n - 1)`
.
"""
function eq_percentile(vector, fraction)
    values = _numbers((vector,), "percentile")
    any(value -> value isa Complex && imag(value) != 0, values) &&
        eqerror("percentile needs real values")
    fraction isa Number && !(fraction isa Unitful.AbstractQuantity) &&
        imag(fraction) == 0 && 0 <= real(fraction) <= 1 ||
        eqerror("percentile: p must be a real number between 0 and 1")
    sorted = _units_checked(() -> sort(real.(values)), "percentile")
    position = real(fraction) * (length(sorted) - 1) + 1
    below = floor(Int, position)
    above = min(below + 1, length(sorted))
    eqnum(sorted[below] + (position - below) * (sorted[above] - sorted[below]))
end

function _count_pair(n, k, name)
    (_is_integer_value(n) && _is_integer_value(k)) ||
        eqerror("$name: n and k must be integers")
    n_int, k_int = BigInt(real(n)), BigInt(real(k))
    0 <= k_int <= n_int || eqerror("$name needs n >= k >= 0")
    n_int, k_int
end

"`permut(n, k)`: number of permutations `n! / (n - k)!`, integers with `n >= k >= 0`."
function eq_permut(n, k)
    n_int, k_int = _count_pair(n, k, "permut")
    Float64(prod((n_int-k_int+1):n_int; init=big(1)))
end

function _integer_values(arguments, name)
    values = _flatten_arguments(arguments, name)
    all(_is_integer_value, values) || eqerror("$name needs unitless integers")
    BigInt.(real.(values))
end

"`gcd(A, B, ...)`: greatest common divisor of unitless integers (signs ignored)."
eq_gcd(arguments...) = Float64(abs(reduce(gcd, _integer_values(arguments, "gcd"))))

"`lcm(A, B, ...)`: least common multiple of unitless integers (signs ignored)."
eq_lcm(arguments...) = Float64(abs(reduce(lcm, _integer_values(arguments, "lcm"))))
