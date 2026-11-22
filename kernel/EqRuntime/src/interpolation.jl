# Interpolation and prediction: bspline, loess evaluation through
# interp, Spline2/Binterp/DWS, Bicubic2D, predict, polyint, polyiter, rationalint, Thiele.
# the reference application does not publish the algorithms behind these results; the conventions below are
# documented in the specification and marked where the help text is silent.

# ----------------------------------------------------------------- B-splines

# B-spline basis values of degree `deg` at `x` on the knot vector `t` (Cox-de Boor), for the
# span starting at knot `span`. The caller clamps the span, so values outside the knot range
# continue the end polynomial pieces.
function _bspline_basis(t, deg, span, x)
    basis = zeros(deg + 1)
    left = zeros(deg)
    right = zeros(deg)
    basis[1] = 1.0
    for j in 1:deg
        left[j] = x - t[span+1-j]
        right[j] = t[span+j] - x
        saved = 0.0
        for r in 0:(j-1)
            temp = basis[r+1] / (right[r+1] + left[j-r])
            basis[r+1] = saved + right[r+1] * temp
            saved = left[j-r] * temp
        end
        basis[j+1] = saved
    end
    basis
end

function _bspline_span(t, deg, count, x)
    # Index (1-based) of the knot span [t_i, t_{i+1}) holding x, clamped to the valid spans.
    clamp(searchsortedlast(t, x), deg + 1, count)
end

function _bspline_value(t, c, deg, x)
    span = _bspline_span(t, deg, length(c), x)
    basis = _bspline_basis(t, deg, span, x)
    sum(basis[k+1] * c[span-deg+k] for k in 0:deg)
end

function _bspline_derivative(t, c, deg)
    deg >= 1 || return (t, zeros(length(c)), 0)
    d = [deg * (c[i+1] - c[i]) / (t[i+deg+1] - t[i+1]) for i in 1:(length(c)-1)]
    (t[2:(end-1)], d, deg - 1)
end

function _bspline_collocation(t, deg, xs)
    count = length(t) - deg - 1
    matrix = zeros(length(xs), count)
    for (row, x) in enumerate(xs)
        span = _bspline_span(t, deg, count, x)
        basis = _bspline_basis(t, deg, span, x)
        for k in 0:deg
            matrix[row, span-deg+k] = basis[k+1]
        end
    end
    matrix
end

_clamped_knots(interior, lo, hi, deg) = vcat(fill(lo, deg + 1), interior, fill(hi, deg + 1))

# bspline vector: [4; degree; coefficient count; knots...; coefficients...]
const _BSPLINE_CODE = 4.0
# loess vector: [5; d; N; span; X (column-major N x d); y]
const _LOESS_CODE = 5.0

"""
`bspline(vx, vy, u, n)`: interpolating B-spline of degree `n` through the points, for `interp`.
`u` holds the ascending knot values: `rows(vx) - n + 1` of them, with `u[0] <= vx[0]` and
`u[last] >= vx[last]`; the end knots are repeated `n` more times (clamped spline).
"""
function eq_bspline(vx, vy, u, n)
    xs, ys = _sorted_points(vx, vy, "bspline")
    degree = _smooth_integer(n, "bspline", "n")
    knots = _real_column(u, "bspline")
    count = length(xs)
    degree < count || eqerror("bspline: n must be smaller than the number of points")
    length(knots) == count - degree + 1 ||
        eqerror("bspline: u needs $(count - degree + 1) elements for $count points of degree $degree")
    issorted(knots) || eqerror("bspline: u must be ascending")
    knots[1] <= Float64(real(xs[1])) && knots[end] >= Float64(real(xs[end])) ||
        eqerror("bspline: u must cover the range of vx")
    xr, yr = Float64.(real.(xs)), Float64.(real.(ys))
    t = _clamped_knots(knots[2:(end-1)], knots[1], knots[end], degree)
    # The end knots count once in `u` and `degree` more times each: N + n + 1 knots in all.
    coefficients = try
        _bspline_collocation(t, degree, xr) \ yr
    catch
        eqerror("bspline: the knots do not allow interpolation of the points")
    end
    all(isfinite, coefficients) || eqerror("bspline: the knots do not allow interpolation of the points")
    reshape(vcat(_BSPLINE_CODE, degree, count, t, coefficients), :, 1)
end

function _bspline_parts(spline)
    degree, count = Int(spline[2]), Int(spline[3])
    length(spline) == 3 + (count + degree + 1) + count || eqerror("interp: the spline vector is malformed")
    spline[4:(3+count+degree+1)], spline[(4+count+degree+1):end], degree
end

# ---------------------------------------------------------------------- loess

function _loess_terms(d, count)
    terms = [zeros(Int, d)]
    for i in 1:d
        push!(terms, [k == i ? 1 : 0 for k in 1:d])
    end
    for i in 1:d, j in i:d
        push!(terms, [k == i ? 1 : 0 for k in 1:d] .+ [k == j ? 1 : 0 for k in 1:d])
    end
    # Fewer points than terms: drop the quadratic terms, then the linear ones.
    count >= length(terms) ? terms : count >= d + 1 ? terms[1:(d+1)] : terms[1:1]
end

function _loess_point(X, y, span, at)
    points, d = size(X)
    q = clamp(ceil(Int, span * points), min(points, d + 1), points)
    dist = [norm(X[i, :] .- at) for i in 1:points]
    order = sortperm(dist)
    h = dist[order[q]]
    span > 1 && (h *= span^(1 / d))
    h = h == 0 ? 1.0 : h
    selected = order[1:q]
    weights = [(u = dist[i] / h; u < 1 ? (1 - u^3)^3 : 0.0) for i in selected]
    terms = _loess_terms(d, sum(w -> w > 0, weights))
    design = [prod((X[i, k] - at[k])^term[k] for k in 1:d) for i in selected, term in terms]
    sw = sqrt.(weights)
    solution = (design .* sw) \ (y[selected] .* sw)
    solution[1]
end

"""
`loess(vx, vy, span)` / `loess(Mx, vy, span)`: local second-order polynomial regression with
tricube weights over the nearest `span` fraction of the points; the result is for `interp`.
"""
function eq_loess(x, y, span)
    isarr(x) && all(e -> e isa Number && !(e isa Unitful.AbstractQuantity), x) || eqerror("loess needs numeric data without units")
    all(e -> imag(e) == 0, x) || eqerror("loess needs real data")
    X = size(x, 1) == 1 || size(x, 2) == 1 ? reshape(Float64.(real.(vec(x))), :, 1) : Float64.(real.(x))
    ys = _real_column(y, "loess")
    size(X, 1) == length(ys) || eqerror("loess: vx and vy must have the same number of points")
    length(ys) >= 3 || eqerror("loess needs at least three points")
    s = _real_bare(span, "loess")
    s > 0 || eqerror("loess: span must be positive")
    reshape(vcat(_LOESS_CODE, size(X, 2), size(X, 1), s, vec(X), ys), :, 1)
end

function _loess_eval(spline, at)
    d, count, span = Int(spline[2]), Int(spline[3]), spline[4]
    length(spline) == 4 + count * d + count || eqerror("interp: the loess vector is malformed")
    X = reshape(spline[5:(4+count*d)], count, d)
    y = spline[(5+count*d):end]
    if d == 1
        return _elementwise_map(at) do point
            _loess_point(X, y, span, [_real_bare(point, "interp")])
        end
    end
    point = at isa AbstractMatrix ? Float64.(real.(at)) : eqerror("interp: the loess point must be a vector")
    if size(point, 2) == 1 || size(point, 1) == 1
        length(point) == d || eqerror("interp: the point needs $d coordinates")
        return _loess_point(X, y, span, vec(point))
    end
    size(point, 2) == d || eqerror("interp: the points need $d columns")
    reshape([_loess_point(X, y, span, point[i, :]) for i in 1:size(point, 1)], :, 1)
end

# --------------------------------------------------------------------- Spline2

# Spline2 vector: [6; degree; coefficient count; Durbin-Watson; knots...; coefficients...]

function _dw(residuals)
    denominator = sum(abs2, residuals)
    denominator == 0 ? 2.0 : sum(abs2, diff(residuals)) / denominator
end

function _spline2_fit(xs, ys, sigmas, deg, knots)
    t = _clamped_knots(knots[2:(end-1)], knots[1], knots[end], deg)
    design = _bspline_collocation(t, deg, xs)
    scaled = design ./ sigmas
    coefficients = scaled \ (ys ./ sigmas)
    coefficients, t, (ys .- design * coefficients) ./ sigmas
end

"""
`Spline2(vx, vy, n, [vw], [u], [level])`: least-squares B-spline of degree `n` (verified against saved
the reference application results). `vw` holds the STANDARD DEVIATIONS of the points (a point counts `1/vw^2`) and is told
from the knots by its length, so `Spline2(x, y, n, u)` works. `u` lists ALL the knots, the two ends
included; the ends are clipped to the range of the data and only the points inside take part in the fit.
Without `u` the knots are equally spaced over the data and one interval is added at a time until the
Durbin-Watson statistic of the residuals reaches 2; the standard deviations and `level` are then
ignored (as in the reference application). The result is the column `[n + 1; k; the k + 1 knots; the n + k
coefficients; standard error; 0; Durbin-Watson statistic; q1; q2]` for `Binterp` and `DWS`, with
`q1 = q2 = 1e30` and a negated standard error when only one degree of freedom is left. `q1` and `q2` (two
probabilities of the Durbin-Watson test) are not reproduced and are `NaN`.
"""
function eq_Spline2(vx, vy, n, vw=nothing, u=nothing, level=nothing)
    xs, ys = _sorted_points(vx, vy, "Spline2")
    xr, yr = Float64.(real.(xs)), Float64.(real.(ys))
    deg = _smooth_integer(n, "Spline2", "n")
    count = length(xr)
    blank(v) = v === nothing || (v isa AbstractMatrix && isempty(v))
    # The fourth argument is the knot vector when it does not have one element per point.
    if !blank(vw) && blank(u) && length(vw) != count
        vw, u = nothing, vw
    end
    sigmas = blank(vw) ? ones(count) : _real_column(vw, "Spline2")
    length(sigmas) == count && all(>(0), sigmas) || eqerror("Spline2: vw must hold $count positive standard deviations")
    # `level` is a probability (0 to 1) in the reference application and changed nothing in the saved results; it is only checked.
    blank(level) || 0 <= _real_bare(level, "Spline2") <= 1 || eqerror("Spline2: level must be between 0 and 1")
    target = 2.0  # between 1.873 (rejected) and 2.214 (accepted) in the saved results
    local coefficients, t, residuals, knots, used
    if !blank(u)
        knots = sort(_real_column(u, "Spline2"))
        length(knots) >= 2 || eqerror("Spline2: u needs at least two knots (its ends and the interior ones)")
        knots[1] = max(knots[1], xr[1])
        knots[end] = min(knots[end], xr[end])
        used = findall(x -> knots[1] <= x <= knots[end], xr)
        length(used) >= deg + length(knots) - 1 || eqerror("Spline2: too many knots for the points between its ends")
        coefficients, t, residuals = _spline2_fit(xr[used], yr[used], sigmas[used], deg, knots)
    else
        used = collect(1:count)
        intervals = 1
        coefficients, t, residuals = nothing, nothing, nothing
        knots = [xr[1], xr[end]]
        for k in 1:max(1, count - deg - 1)
            knots = [xr[1] + (xr[end] - xr[1]) * i / k for i in 0:k]
            coefficients, t, residuals = _spline2_fit(xr, yr, ones(count), deg, knots)
            _dw(residuals) >= target && break
        end
    end
    dof = length(used) - length(coefficients)
    dof >= 1 || eqerror("Spline2: not enough points for the knots")
    error_estimate = sqrt(sum(abs2, residuals) / dof)
    scarce = dof == 1
    reshape(vcat(deg + 1, length(knots) - 1, knots, coefficients, scarce ? -error_estimate : error_estimate, 0.0,
                 _dw(residuals), scarce ? 1e30 : NaN, scarce ? 1e30 : NaN), :, 1)
end

function _spline2_parts(b, name)
    isarr(b) && size(b, 2) == 1 && length(b) >= 12 || eqerror("$name: the argument must come from Spline2")
    degree, intervals = Int(b[1]) - 1, Int(b[2])
    length(b) == 2 + (intervals + 1) + (degree + intervals) + 5 || eqerror("$name: the argument must come from Spline2")
    knots = b[3:(3+intervals)]
    coefficients = b[(4+intervals):(3+intervals+degree+intervals)]
    clamped = _clamped_knots(knots[2:(end-1)], knots[1], knots[end], degree)
    clamped, coefficients, degree, b[end-2]
end

"`DWS(b)`: Durbin-Watson statistic of the residuals of a `Spline2` fit."
function eq_DWS(b)
    _, _, _, dw = _spline2_parts(b, "DWS")
    dw
end

"""
`Binterp(x, b)`: value of the `Spline2` spline at `x` followed by its derivatives up to the
spline degree, as a column vector; outside the knots the end polynomial piece continues.
"""
function eq_Binterp(x, b)
    t, c, degree, _ = _spline2_parts(b, "Binterp")
    point = _real_bare(x, "Binterp")
    values = Float64[]
    knots, coefficients, deg = t, c, degree
    for _ in 0:degree
        push!(values, _bspline_value(knots, coefficients, deg, point))
        deg == 0 && break
        knots, coefficients, deg = _bspline_derivative(knots, coefficients, deg)
    end
    while length(values) < degree + 1
        push!(values, 0.0)
    end
    reshape(values, :, 1)
end

# ------------------------------------------------------------------- Bicubic2D

"""
`Bicubic2D(vx, vy, Z, p, q)`: bicubic interpolation at `(p, q)`, a natural (linear-end) cubic spline
along `vy` and then along `vx` (verified against saved the reference application results; the extrapolation is the one of
`interp` of that spline); `Z[i, j]` is the value at `(vx[i], vy[j])`.
"""
function eq_Bicubic2D(vx, vy, Z, p, q)
    xs, ys = _real_column(vx, "Bicubic2D"), _real_column(vy, "Bicubic2D")
    isarr(Z) && size(Z) == (length(xs), length(ys)) ||
        eqerror("Bicubic2D: Z needs $(length(xs)) rows and $(length(ys)) columns")
    issorted(xs; lt=<=) && issorted(ys; lt=<=) || eqerror("Bicubic2D: vx and vy must be strictly ascending")
    length(xs) >= 3 && length(ys) >= 3 || eqerror("Bicubic2D needs at least three grid lines in each direction")
    grid = Float64.(real.(Z))
    xq, yq = _real_bare(p, "Bicubic2D"), _real_bare(q, "Bicubic2D")
    along_y = [eq_interp(eq_lspline(reshape(ys, :, 1), reshape(grid[i, :], :, 1)), reshape(ys, :, 1), reshape(grid[i, :], :, 1), yq) for i in eachindex(xs)]
    column = reshape(Float64.(along_y), :, 1)
    eq_interp(eq_lspline(reshape(xs, :, 1), column), reshape(xs, :, 1), column, xq)
end

# --------------------------------------------------------------------- predict

"""
`predict(v, m, n)`: `n` values past the end of `v`, from `m` linear-prediction coefficients
computed with Burg's method (maximum entropy) on all of `v`.
"""
function eq_predict(v, m, n)
    data = _real_column(v, "predict")
    order = _smooth_integer(m, "predict", "m")
    ahead = _smooth_integer(n, "predict", "n")
    count = length(data)
    order < count || eqerror("predict: m must be smaller than the number of data points")
    # Burg recursion (Numerical Recipes memcof): x_t ~ sum_j d[j] x_{t-j}.
    d = zeros(order)
    wk1 = data[1:(count-1)]
    wk2 = data[2:count]
    wkm = zeros(order)
    p = sum(abs2, data) / count
    p == 0 && return reshape(zeros(ahead), :, 1)
    for k in 1:order
        numerator = sum(wk1[j] * wk2[j] for j in 1:(count-k))
        denominator = sum(wk1[j]^2 + wk2[j]^2 for j in 1:(count-k))
        d[k] = 2numerator / denominator
        p *= 1 - d[k]^2
        for i in 1:(k-1)
            d[i] = wkm[i] - d[k] * wkm[k-i]
        end
        k == order && break
        wkm[1:k] = d[1:k]
        for j in 1:(count-k-1)
            wk1[j] -= wkm[k] * wk2[j]
            wk2[j] = wk2[j+1] - wkm[k] * wk1[j+1]
        end
    end
    history = copy(data)
    for _ in 1:ahead
        push!(history, sum(d[j] * history[end+1-j] for j in 1:order))
    end
    reshape(history[(count+1):end], :, 1)
end

# ------------------------------------------------- polynomial and rational forms

"""
Numerical Recipes' `polint` (verified against saved the reference application results): Neville's algorithm that
starts at the point nearest to `x` (the first one on a tie) and adds one correction per order,
choosing the next point on the left or on the right. Returns the `(estimate, correction)` after
each order, the first being the nearest data value with a correction of 0.
"""
function _polint_sequence(xs, ys, x)
    n = length(xs)
    c = float.(ys)
    d = float.(ys)
    nearest = 1
    distance = abs(x - xs[1])
    for i in 2:n
        if abs(x - xs[i]) < distance
            nearest, distance = i, abs(x - xs[i])
        end
    end
    estimate = float(ys[nearest])
    side = nearest - 1
    out = [(estimate, 0.0)]
    for m in 1:(n-1)
        for i in 1:(n-m)
            low, high = xs[i] - x, xs[i+m] - x
            factor = (c[i+1] - d[i]) / (low - high)
            d[i] = high * factor
            c[i] = low * factor
        end
        if 2side < n - m
            correction = c[side+1]
        else
            correction = d[side]
            side -= 1
        end
        estimate += correction
        push!(out, (estimate, correction))
    end
    out
end

function _interpolation_data(vx, vy, name)
    xs, ys = _real_column(vx, name), _real_column(vy, name)
    length(xs) == length(ys) || eqerror("$name: the vectors must have the same length")
    length(xs) >= 2 || eqerror("$name needs at least two points")
    allunique(xs) || eqerror("$name: the x values must be distinct")
    xs, ys
end

"""
`polyint(vx, vy, x)`: `[value; error estimate]` of the polynomial through all points; the error
estimate is the last correction of the algorithm, with its sign (as in the reference application).
"""
function eq_polyint(vx, vy, x)
    xs, ys = _interpolation_data(vx, vy, "polyint")
    value, correction = _polint_sequence(xs, ys, _real_bare(x, "polyint"))[end]
    reshape([value, correction], :, 1)
end

"""
`polyiter(vx, vy, x, N, e)`: polynomial interpolation raising the order up to `N` until the
correction is at most `e` times the estimate; the column `[converged (1 or 0); order reached;
value]` (verified against saved the reference application results).
"""
function eq_polyiter(vx, vy, x, N, e)
    xs, ys = _interpolation_data(vx, vy, "polyiter")
    at = _real_bare(x, "polyiter")
    maximum_order = _smooth_integer(N, "polyiter", "N"; minimum=1)
    maximum_order < length(xs) || eqerror("polyiter: N must be smaller than the number of points")
    tolerance = _real_bare(e, "polyiter")
    tolerance >= 0 || eqerror("polyiter: e must not be negative")
    steps = _polint_sequence(xs, ys, at)
    last_order = min(maximum_order, length(xs) - 1)
    for order in 1:last_order
        value, correction = steps[order+1]
        abs(correction) <= tolerance * abs(value) && return reshape([1.0, float(order), value], :, 1)
    end
    reshape([0.0, float(last_order), steps[last_order+1][1]], :, 1)
end

"`rationalint(vx, vy, x)`: `[value; error estimate]` of the Bulirsch-Stoer rational interpolant; the error estimate keeps its sign (as in the reference application)."
function eq_rationalint(vx, vy, x)
    xs, ys = _interpolation_data(vx, vy, "rationalint")
    at = _real_bare(x, "rationalint")
    tiny = 1e-25
    n = length(xs)
    c = copy(ys)
    d = ys .+ tiny
    nearest = argmin(abs.(xs .- at))
    abs(xs[nearest] - at) == 0 && return reshape([ys[nearest], 0.0], :, 1)
    y = ys[nearest]
    index = nearest - 1
    dy = 0.0
    for m in 1:(n-1)
        for i in 1:(n-m)
            w = c[i+1] - d[i]
            h = xs[i+m] - at
            t = (xs[i] - at) * d[i] / h
            dd = t - c[i+1]
            dd == 0 && eqerror("rationalint: the interpolating function has a pole at x")
            dd = w / dd
            d[i] = c[i+1] * dd
            c[i] = t * dd
        end
        dy = 2index < (n - m) ? c[index+1] : (value = d[index]; index -= 1; value)
        y += dy
    end
    reshape([y, dy], :, 1)
end

"`Thielecoeff(vx, vy)`: coefficients (inverse differences) of Thiele's continued fraction."
function eq_Thielecoeff(vx, vy)
    xs, ys = _interpolation_data(vx, vy, "Thielecoeff")
    n = length(xs)
    phi = copy(ys)
    coefficients = [phi[1]]
    for k in 2:n
        for i in k:n
            phi[i] = (xs[i] - xs[k-1]) / (phi[i] - phi[k-1])
        end
        push!(coefficients, phi[k])
    end
    all(isfinite, coefficients) || eqerror("Thielecoeff: an inverse difference is not finite; reorder the points")
    reshape(coefficients, :, 1)
end

"`Thiele(vx, coeff, x)`: value at `x` of the Thiele continued fraction `coeff` from `Thielecoeff`."
function eq_Thiele(vx, coeff, x)
    xs = _real_column(vx, "Thiele")
    a = _real_column(coeff, "Thiele")
    length(a) == length(xs) || eqerror("Thiele: vx and coeff must have the same length")
    at = _real_bare(x, "Thiele")
    length(a) == 1 && return a[1]
    t = a[end]
    for k in (length(a)-1):-1:2
        t = a[k] + (at - xs[k]) / t
    end
    a[1] + (at - xs[1]) / t
end
