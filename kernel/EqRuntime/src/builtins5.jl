# the reference application built-in functions (batch 7): factorizations, singular values,
# generalized eigenvalues, polynomials and interpolation, array generators and
# covariance statistics. Specs: the specification sections 1, 2, 3, 5, 9, 11.

# ------------------------------------------------------------ factorizations

"`cholesky(M)`: the lower triangular `L` with `M = L L^H` for a positive definite `M`."
function eq_cholesky(matrix)
    numeric = _numeric_square(matrix, "cholesky")
    isempty(numeric) && eqerror("cholesky needs a non-empty matrix")
    _eltype_plain(numeric, "cholesky")
    try
        Matrix(cholesky(Hermitian(float(numeric))).L)
    catch error
        error isa PosDefException && eqerror("cholesky: the matrix is not positive definite")
        rethrow()
    end
end

function _eltype_plain(numeric, name)
    _isplain(eltype(numeric)) || eqerror("$name needs a numeric matrix without units")
end

_nested(parts...) = narrow(reshape(Any[parts...], :, 1))

function _flag(value, name)
    _is_integer_value(value) || eqerror("$name: the option must be an integer")
    !iszero(value)
end

"""
`a test worksheet(M [, p [, u]])`: nested `[P; L]`. `p = 0` turns pivoting off (then `P`
is the identity); `u` nonzero returns the upper factor `L^H` instead. With
pivoting `P M P^T = L L^H`.
"""
function eq_Cholesky(matrix, pivot=1.0, upper=0.0)
    numeric = _numeric_square(matrix, "Cholesky")
    isempty(numeric) && eqerror("a test worksheet needs a non-empty matrix")
    _eltype_plain(numeric, "Cholesky")
    pivoting, want_upper = _flag(pivot, "Cholesky"), _flag(upper, "Cholesky")
    hermitian = Hermitian(float(numeric))
    factor_p, factor_l = try
        if pivoting
            decomposition = cholesky(hermitian, RowMaximum(); check=true)
            Matrix{Float64}(I, size(numeric)...)[decomposition.p, :], Matrix(decomposition.L)
        else
            Matrix{Float64}(I, size(numeric)...), Matrix(cholesky(hermitian).L)
        end
    catch error
        (error isa PosDefException || error isa RankDeficientException) &&
            eqerror("a test worksheet: the matrix is not positive definite")
        rethrow()
    end
    _nested(factor_p, want_upper ? Matrix(factor_l') : factor_l)
end

"`LU(M)`: nested `[P; L; U]` with `P M = L U` (partial pivoting)."
function eq_LU(matrix)
    numeric = _numeric_matrix(matrix, "LU")
    decomposition = lu(float(numeric); check=false)
    permutation = Matrix{Float64}(I, size(numeric, 1), size(numeric, 1))[decomposition.p, :]
    _nested(permutation, Matrix(decomposition.L), Matrix(decomposition.U))
end

"""
The QR factors shared by `qr` and `QR`: Julia's Householder QR (LAPACK) with the full `Q`, m x m,
and `R` m x n.
"""
function _full_qr(numeric)
    rows, cols = size(numeric)
    element_type = float(eltype(numeric))
    decomposition = qr(Matrix{element_type}(numeric))
    basis = decomposition.Q * Matrix{element_type}(I, rows, rows)
    triangle = zeros(element_type, rows, cols)
    triangle[1:min(rows, cols), :] = decomposition.R
    Matrix(basis), triangle
end

"""
`QR(M [, p])`: nested `[P; Q; R]` with `M P = Q R` (columns pivoted by
decreasing norm), or `[Q; R]` with `M = Q R` when `p = 0`, from Julia's Householder QR.
"""
function eq_QR(matrix, pivot=1.0)
    numeric = _numeric_matrix(matrix, "QR")
    pivoting = _flag(pivot, "QR")
    if !pivoting
        basis, triangle = _full_qr(numeric)
        return _nested(basis, triangle)
    end
    permutation = qr(float(numeric), ColumnNorm()).p
    selector = Matrix{Float64}(I, size(numeric, 2), size(numeric, 2))[:, permutation]
    basis, triangle = _full_qr(numeric[:, permutation])
    _nested(selector, basis, triangle)
end

# ------------------------------------------------ singular and generalized values

"`svds(A)`: the singular values in descending order, as a column vector."
function eq_svds(matrix)
    numeric = _numeric_matrix(matrix, "svds")
    reshape(svdvals(float(numeric)), :, 1)
end

"`svd(A)`: nested `[s; U; V^H]` (thin factors) with `A = U diag(s) V^H`; signs are LAPACK's."
function eq_svd(matrix)
    numeric = _numeric_matrix(matrix, "svd")
    decomposition = svd(float(numeric))
    _nested(reshape(decomposition.S, :, 1), Matrix(decomposition.U), Matrix(decomposition.Vt))
end

function _pair(first, second, name)
    left = _numeric_square(first, name)
    right = _numeric_square(second, name)
    size(left) == size(right) || eqerror("$name: the matrices must have the same size")
    isempty(left) && eqerror("$name needs non-empty matrices")
    _eltype_plain(left, name)
    _eltype_plain(right, name)
    float(left), float(right)
end

function _generalized(first, second, name)
    left, right = _pair(first, second, name)
    try
        eigen(left, right)
    catch error
        error isa LinearAlgebra.LAPACKException && eqerror("$name did not converge")
        rethrow()
    end
end

# Descending by real part, then imaginary part; equal values keep their order.
"`genvals(M, N)`: generalized eigenvalues of `M x = v N x` in Julia's order (real part, then imaginary part)."
function eq_genvals(first, second)
    decomposition = _generalized(first, second, "genvals")
    reshape(collect(_real_if_possible(decomposition.values)), :, 1)
end

"`genvecs(M, N [, \"L\"])`: the generalized eigenvectors as unit columns in `genvals` order (signs not unique)."
function eq_genvecs(first, second, side::AbstractString="R")
    side in ("R", "L") || eqerror("genvecs: the third argument must be \"L\"")
    decomposition = _generalized(first, second, "genvecs")
    vectors = decomposition.vectors
    if side == "L"
        # left vectors u^H M = v u^H N: the right vectors of (M^H, N^H), paired by eigenvalue
        adjoint_pair = _generalized(Matrix(narrow(first)'), Matrix(narrow(second)'), "genvecs")
        available = collect(eachindex(adjoint_pair.values))
        left = similar(adjoint_pair.vectors)
        for (column, value) in enumerate(decomposition.values)
            best = argmin(map(i -> abs(conj(adjoint_pair.values[i]) - value), available))
            left[:, column] = adjoint_pair.vectors[:, available[best]]
            deleteat!(available, best)
        end
        vectors = left
    end
    Matrix(_real_if_possible(vectors ./ map(norm, eachcol(vectors))'))
end

"`eigenvec(M, z)`: a unit eigenvector for the eigenvalue `z`, by inverse iteration."
function eq_eigenvec(matrix, value)
    numeric = float(_numeric_square(matrix, "eigenvec"))
    isempty(numeric) && eqerror("eigenvec needs a non-empty matrix")
    value isa Number && !(value isa Unitful.AbstractQuantity) ||
        eqerror("eigenvec needs a unitless eigenvalue")
    scale = max(opnorm(numeric, 1), 1.0)
    shifted = numeric - (value + scale * 1e-10) * I
    vector = fill(1.0 + 0im, size(numeric, 1))
    for _ in 1:5
        vector = try
            shifted \ vector
        catch error
            error isa SingularException || rethrow()
            eqerror("eigenvec: the matrix is singular at this eigenvalue")
        end
        vector ./= norm(vector)
    end
    reshape(_real_if_possible(vector), :, 1)
end

"`kronecker(M, N)`: Kronecker product."
function eq_kronecker(first, second)
    left, right = _numeric_matrix(first, "kronecker"), _numeric_matrix(second, "kronecker")
    kron(left, right)
end

"""
`rref(A)`: reduced row echelon form by Gauss-Jordan elimination with partial
pivoting; entries below `eps * max(size) * max|A|` count as zero.
"""
function eq_rref(matrix)
    work = Matrix(float(_numeric_matrix(matrix, "rref")))
    rows, cols = size(work)
    tolerance = eps() * max(rows, cols) * maximum(abs, work)
    pivot_row = 1
    for column in 1:cols
        pivot_row > rows && break
        best = argmax(abs.(work[pivot_row:rows, column])) + pivot_row - 1
        if abs(work[best, column]) <= tolerance
            work[pivot_row:rows, column] .= 0
            continue
        end
        work[[pivot_row, best], :] = work[[best, pivot_row], :]
        work[pivot_row, :] ./= work[pivot_row, column]
        for row in 1:rows
            row == pivot_row && continue
            work[row, :] .-= work[row, column] .* work[pivot_row, :]
            work[row, column] = 0
        end
        pivot_row += 1
    end
    work
end

# ------------------------------------------------------------ array generators

"""
`vec(x, y, z)`: from `x` to `z` in steps of `y - x`; `vec(x, z)`: step 1 (or -1
when `z < x`); `vec(r)`: a range variable as a vector.
Exposed to the generator as `eq_vecrange` because `eq_vec` builds literals.
"""
eq_vecrange(range::EqRange) = eq_collect(range)
eq_vecrange(value) = eqerror("vec needs a range variable, or a first and a last value")
eq_vecrange(first, last) = eq_collect(eq_range(first, last))
eq_vecrange(first, second, last) = eq_collect(eq_range(first, second, last))

"`logspace(min, max, npts)`: `npts` logarithmically spaced points from `min` to `max` (positive, same units)."
function eq_logspace(lower, upper, count)
    _is_integer_value(count) && real(count) >= 1 ||
        eqerror("logspace: the number of points must be a positive integer")
    lower_bare, upper_bare = _real_bare(lower, "logspace"), _real_bare(upper, "logspace")
    (lower isa Unitful.AbstractQuantity) == (upper isa Unitful.AbstractQuantity) ||
        eqerror("logspace: the units of the arguments do not match")
    (lower_bare > 0 && upper_bare > 0) || eqerror("logspace needs positive limits")
    ratio = _plain(eq_div(upper, lower), "logspace")
    points = Int(real(count))
    points == 1 && return eq_vec(lower)
    narrow(reshape(Any[eq_mul(lower, ratio^((index - 1) / (points - 1))) for index in 1:points], :, 1))
end

"`logpts(minexp, dec, dnpts)`: `dec * dnpts` points `10^(minexp + k / dnpts)`."
function eq_logpts(minexp, decades, per_decade)
    for value in (minexp, decades, per_decade)
        _is_integer_value(value) || eqerror("logpts needs unitless integers")
    end
    real(decades) >= 0 && real(per_decade) >= 1 ||
        eqerror("logpts: dec must be nonnegative and dnpts positive")
    count = Int(real(decades) * real(per_decade))
    reshape([10.0^(real(minexp) + k / real(per_decade)) for k in 0:(count-1)], :, 1)
end

# ------------------------------------------- polynomials and interpolation

function _real_column(vector, name)
    _real_vector(vector, name)
    any(element -> element isa Unitful.AbstractQuantity, vector) &&
        eqerror("$name needs a vector without units")
    Float64.(real.(vec(vector)))
end

"""
`polyroots(v)`: roots of `v_0 + v_1 x + ... + v_n x^n` (constant term first,
2 to 99 coefficients, nonzero leading coefficient) from the companion matrix.
The order of the roots is LAPACK's.
"""
function eq_polyroots(vector)
    isarr(vector) && (size(vector, 1) == 1 || size(vector, 2) == 1) ||
        eqerror("polyroots needs a vector")
    2 <= length(vector) <= 99 || eqerror("polyroots needs between 2 and 99 coefficients")
    all(element -> element isa Number && !(element isa Unitful.AbstractQuantity), vector) ||
        eqerror("polyroots needs unitless numbers")
    coefficients = ComplexF64.(vec(vector))
    iszero(last(coefficients)) && eqerror("polyroots: the leading coefficient is zero")
    degree = length(coefficients) - 1
    all(isreal, coefficients) && (coefficients = real.(coefficients))
    companion = zeros(eltype(coefficients), degree, degree)
    for index in 1:(degree-1)
        companion[index+1, index] = 1
    end
    companion[:, degree] = -coefficients[1:degree] ./ coefficients[end]
    reshape(collect(_real_if_possible(eigvals(companion))), :, 1)
end

"`polycoeff(vx, vy)`: coefficients (constant term first) of the polynomial through the points."
function eq_polycoeff(x, y)
    xs, ys = _real_column(x, "polycoeff"), _real_column(y, "polycoeff")
    length(xs) == length(ys) || eqerror("polycoeff: the vectors must have the same length")
    allunique(xs) || eqerror("polycoeff: the x values must be distinct")
    reshape(vandermonde(xs) \ ys, :, 1)
end

vandermonde(xs) = [x^power for x in xs, power in 0:(length(xs)-1)]

function _sorted_points(x, y, name)
    isarr(x) && isarr(y) || eqerror("$name needs vectors")
    (size(x, 2) == 1 || size(x, 1) == 1) && (size(y, 2) == 1 || size(y, 1) == 1) ||
        eqerror("$name needs vectors")
    length(x) == length(y) || eqerror("$name: the vectors must have the same length")
    length(x) >= 2 || eqerror("$name needs at least two points")
    all(element -> element isa Number, x) && all(element -> element isa Number, y) ||
        eqerror("$name needs numbers")
    order = sortperm(map(_order_key, vec(x)))
    xs, ys = vec(x)[order], vec(y)[order]
    issorted(map(_order_key, xs); lt=<=) ||
        eqerror("$name: the x values must be distinct")
    xs, ys
end

"""
`linterp(vx, vy, x)`: piecewise linear interpolation through the points,
extended linearly beyond the ends; elementwise in `x`. The points are sorted by
`x`; `y` may carry units.
"""
function eq_linterp(x, y, at)
    xs, ys = _sorted_points(x, y, "linterp")
    _elementwise_map(at) do point
        point isa Number || eqerror("linterp needs numbers")
        keys = map(_order_key, xs)
        segment = clamp(searchsortedlast(keys, _order_key(point)), 1, length(xs) - 1)
        fraction = eq_div(eq_sub(point, xs[segment]), eq_sub(xs[segment+1], xs[segment]))
        eq_add(ys[segment], eq_mul(eq_sub(ys[segment+1], ys[segment]), fraction))
    end
end

# A spline object is the reference application's column vector [0; 3; end condition; M_1..M_n]: the type, the degree, the end
# condition (0 linear, 1 parabolic, 2 cubic) and the second derivatives at the knots (verified against saved
# the reference application results). The data themselves travel as the `vx` and `vy` arguments of `interp`.
const _SPLINE_CODES = Dict("lspline" => 0.0, "pspline" => 1.0, "cspline" => 2.0)

function _spline(x, y, name)
    xs, ys = _sorted_points(x, y, name)
    (any(element -> element isa Unitful.AbstractQuantity, xs) ||
     any(element -> element isa Unitful.AbstractQuantity, ys)) &&
        eqerror("$name needs vectors without units")
    all(element -> imag(element) == 0, xs) && all(element -> imag(element) == 0, ys) ||
        eqerror("$name needs real values")
    xs, ys = Float64.(real.(xs)), Float64.(real.(ys))
    points = length(xs)
    (name == "lspline" ? points >= 2 : points >= 3) ||
        eqerror("$name needs at least $(name == "lspline" ? 2 : 3) points")
    steps = diff(xs)
    system = zeros(points, points)
    rhs = zeros(points)
    for index in 2:(points-1)
        system[index, index-1] = steps[index-1]
        system[index, index] = 2 * (steps[index-1] + steps[index])
        system[index, index+1] = steps[index]
        rhs[index] = 6 * ((ys[index+1] - ys[index]) / steps[index] -
                          (ys[index] - ys[index-1]) / steps[index-1])
    end
    if name == "lspline"
        system[1, 1] = 1
        system[points, points] = 1
    elseif name == "pspline"
        system[1, 1], system[1, 2] = 1, -1
        system[points, points], system[points, points-1] = 1, -1
    else
        # Cubic ends: the second derivative is linear in x over the first two and the last two intervals.
        system[1, 1], system[1, 2], system[1, 3] = -steps[2], steps[1] + steps[2], -steps[1]
        system[points, points], system[points, points-1], system[points, points-2] =
            -steps[end-1], steps[end] + steps[end-1], -steps[end]
    end
    if name == "cspline" && points == 3
        # Both cubic end conditions are the same equation: the reference application leaves the last second derivative at 0.
        second = zeros(3)
        second[2] = rhs[2] * steps[2] / ((steps[1] + steps[2]) * (steps[1] + 2 * steps[2]))
        second[1] = second[2] * (steps[1] + steps[2]) / steps[2]
    else
        second = system \ rhs
    end
    reshape(vcat(0.0, 3.0, _SPLINE_CODES[name], second), :, 1)
end

"`lspline(vx, vy)`: cubic spline with linear (zero second derivative) ends, for `interp`."
eq_lspline(x, y) = _spline(x, y, "lspline")
"`pspline(vx, vy)`: cubic spline with parabolic ends, for `interp`."
eq_pspline(x, y) = _spline(x, y, "pspline")
"`cspline(vx, vy)`: cubic spline with cubic ends, for `interp`."
eq_cspline(x, y) = _spline(x, y, "cspline")

"""
`interp(vs, vx, vy, x)`: evaluates the spline `vs` made by `lspline`,
`pspline` or `cspline` at `x` (elementwise); outside the data the end cubic
continues. `vx` and `vy` must be the data given to the spline function.
"""
function eq_interp(spline, x, y, at)
    if isarr(spline) && size(spline, 2) == 1 && length(spline) >= 4 && spline[1] == _BSPLINE_CODE
        t, c, degree = _bspline_parts(spline)
        return _elementwise_map(point -> _bspline_value(t, c, degree, _real_bare(point, "interp")), at)
    elseif isarr(spline) && size(spline, 2) == 1 && length(spline) >= 4 && spline[1] == _LOESS_CODE
        return _loess_eval(spline, at)
    end
    isarr(spline) && size(spline, 2) == 1 && length(spline) >= 5 &&
        all(element -> element isa Real, spline) && spline[1] == 0 && spline[2] == 3 && spline[3] in values(_SPLINE_CODES) ||
        eqerror("interp: the first argument must come from lspline, pspline, cspline, bspline or loess")
    xs, ys = _sorted_points(x, y, "interp")
    points = length(xs)
    length(spline) == 3 + points || eqerror("interp: vx and vy must be the data given to the spline function")
    xs, ys = Float64.(real.(xs)), Float64.(real.(ys))
    second = spline[4:end]
    _elementwise_map(at) do point
        value = _real_bare(point, "interp")
        segment = clamp(searchsortedlast(xs, value), 1, points - 1)
        h = xs[segment+1] - xs[segment]
        a = (xs[segment+1] - value) / h
        b = (value - xs[segment]) / h
        a * ys[segment] + b * ys[segment+1] +
        ((a^3 - a) * second[segment] + (b^3 - b) * second[segment+1]) * h^2 / 6
    end
end

# ------------------------------------------------ covariance statistics

function _paired(first, second, name)
    xs = _numbers((first,), name)
    ys = _numbers((second,), name)
    length(xs) == length(ys) ||
        eqerror("$name: the arguments must have the same number of elements")
    all(v -> !(v isa Unitful.AbstractQuantity), xs) && all(v -> !(v isa Unitful.AbstractQuantity), ys) ||
        eqerror("$name needs numbers without units")
    xs, ys
end

function _covariance(first, second, name)
    xs, ys = _paired(first, second, name)
    sum((xs .- sum(xs) / length(xs)) .* conj.(ys .- sum(ys) / length(ys))) / length(xs)
end

"`cvar(A, B)`: covariance `sum((a - mean a) conj(b - mean b)) / N` over all elements (equal counts)."
eq_cvar(first, second) = eqnum(_covariance(first, second, "cvar"))
"`covar(vx, vy)`: covariance of two vectors (same formula as `cvar`)."
eq_covar(first, second) = eqnum(_covariance(first, second, "covar"))

"`corr(A, B)`: the correlation coefficient `cvar(A, B) / (stdev(A) stdev(B))`."
function eq_corr(first, second)
    xs, ys = _paired(first, second, "corr")
    denominator = sqrt(_variance((first,), "corr", false) * _variance((second,), "corr", false))
    iszero(denominator) && eqerror("corr: a standard deviation is zero")
    eqnum(real(_covariance(first, second, "corr")) / denominator)
end

function _standardized(arguments, name, minimum_count)
    values = _numbers(arguments, name)
    all(v -> !(v isa Unitful.AbstractQuantity) && imag(v) == 0, values) ||
        eqerror("$name needs real numbers without units")
    count = length(values)
    count >= minimum_count || eqerror("$name needs at least $minimum_count elements")
    center = sum(values) / count
    spread = sqrt(sum(abs2, values .- center) / (count - 1))
    iszero(spread) && eqerror("$name: all values are equal")
    count, real.((values .- center) ./ spread)
end

"`skew(A, B, ...)`: sample skewness `n / () sum(z^3)`."
function eq_skew(arguments...)
    count, z = _standardized(arguments, "skew", 3)
    count / ((count - 1) * (count - 2)) * sum(z .^ 3)
end

"`kurt(A, B, ...)`: excess sample kurtosis."
function eq_kurt(arguments...)
    count, z = _standardized(arguments, "kurt", 4)
    count * (count + 1) / ((count - 1) * (count - 2) * (count - 3)) * sum(z .^ 4) -
    3 * (count - 1)^2 / ((count - 2) * (count - 3))
end
