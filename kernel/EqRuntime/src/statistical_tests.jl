# Statistical tests and association measures (the vendor built-ins).

import Distributions

function _statistical_vector(vector, name, minimum_count)
    _real_vector(vector, name)
    values = vec(vector)
    all(value -> !(value isa Unitful.AbstractQuantity) && isfinite(value), values) ||
        eqerror("$name needs finite real numbers without units")
    length(values) >= minimum_count || eqerror("$name needs at least $minimum_count elements")
    result = Float64.(real.(values))
    all(isfinite, result) || eqerror("$name needs representable finite values")
    result
end

function _statistical_pairs(first, second, name, minimum_count)
    xs = _statistical_vector(first, name, minimum_count)
    ys = _statistical_vector(second, name, minimum_count)
    length(xs) == length(ys) ||
        eqerror("$name: the arguments must have the same number of elements")
    xs, ys
end

_two_sided_normal(z) = Distributions.ccdf(Distributions.Normal(), abs(z)) * 2

"""`Ftest(v1,v2)`: ordered sample-variance ratio and two-sided F probability."""
function eq_Ftest(first, second)
    xs = _statistical_vector(first, "Ftest", 2)
    ys = _statistical_vector(second, "Ftest", 2)
    sx2 = sum(abs2, xs .- sum(xs) / length(xs)) / (length(xs) - 1)
    sy2 = sum(abs2, ys .- sum(ys) / length(ys)) / (length(ys) - 1)
    (iszero(sx2) || iszero(sy2)) && eqerror("Ftest: sample variance is zero")
    isfinite(sx2) && isfinite(sy2) || eqerror("Ftest: sample variance is not finite")
    statistic = sx2 / sy2
    distribution = Distributions.FDist(length(xs) - 1, length(ys) - 1)
    probability = min(1.0, 2 * min(Distributions.cdf(distribution, statistic),
                                     Distributions.ccdf(distribution, statistic)))
    narrow(reshape(Float64[statistic, probability], :, 1))
end

"""`Spear(v1,v2)`: D, its signed normal score and two-sided probability, rho, and its t probability.

Average ranks handle ties. The D score uses the exact permutation mean and variance
for the two fixed midrank vectors; the rho probability uses the usual t approximation.
"""
function eq_Spear(first, second)
    xs, ys = _statistical_pairs(first, second, "Spear", 3)
    rx = vec(eq_Rank(reshape(xs, :, 1)))
    ry = vec(eq_Rank(reshape(ys, :, 1)))
    dx = rx .- sum(rx) / length(rx)
    dy = ry .- sum(ry) / length(ry)
    ax, ay = sum(abs2, dx), sum(abs2, dy)
    (iszero(ax) || iszero(ay)) && eqerror("Spear: all values in an argument are equal")
    differences = rx .- ry
    d = sum(abs2, differences)
    expected_d = ax + ay
    standard_deviation_d = sqrt(4 * ax * ay / (length(xs) - 1))
    z_d = (d - expected_d) / standard_deviation_d
    probability_d = _two_sided_normal(z_d)
    rho = sum(dx .* dy) / sqrt(ax * ay)
    rho = clamp(rho, -1.0, 1.0)
    t_statistic = abs(rho) == 1 ? copysign(Inf, rho) :
        rho * sqrt((length(xs) - 2) / (1 - rho^2))
    probability_rho = abs(rho) == 1 ? 0.0 :
        Distributions.ccdf(Distributions.TDist(length(xs) - 2), abs(t_statistic)) * 2
    narrow(reshape(Float64[d, z_d, probability_d, rho, probability_rho], :, 1))
end

function _tie_pair_count(samples)
    counts = Dict{Float64,Int}()
    for value in samples
        key = iszero(value) ? 0.0 : value
        counts[key] = get(counts, key, 0) + 1
    end
    sum(Float64(count) * (count - 1) / 2 for count in values(counts))
end

# kendltau2 keeps the approximation of the vendor/NR, without a tie correction in the variance.
_kendall_score_untied(tau, count) = tau * sqrt(count - 1) * (3 / sqrt(4 + 10 / count))

# The sizes of the groups of equal values.
function _tie_groups(samples)
    counts = Dict{Float64,Int}()
    for value in samples
        key = iszero(value) ? 0.0 : value
        counts[key] = get(counts, key, 0) + 1
    end
    collect(values(counts))
end

# The normal approximation of S = C - D with the tie correction of its variance.
function _kendall_score(score, xs, ys)
    n = length(xs)
    tx, ty = _tie_groups(xs), _tie_groups(ys)
    term(groups, f) = sum(f(Float64(t)) for t in groups; init=0.0)
    v0 = n * (n - 1) * (2n + 5.0)
    variance = (v0 - term(tx, t -> t * (t - 1) * (2t + 5)) - term(ty, t -> t * (t - 1) * (2t + 5))) / 18 +
               term(tx, t -> t * (t - 1)) * term(ty, t -> t * (t - 1)) / (2n * (n - 1)) +
               (n > 2 ? term(tx, t -> t * (t - 1) * (t - 2)) * term(ty, t -> t * (t - 1) * (t - 2)) /
                        (9n * (n - 1) * (n - 2)) : 0.0)
    variance > 0 || eqerror("kendltau: the variance is zero (every value is tied)")
    score / sqrt(variance)
end

"""`kendltau(v1,v2)`: Kendall tau-b, asymptotic z, and two-sided normal probability."""
function eq_kendltau(first, second)
    xs, ys = _statistical_pairs(first, second, "kendltau", 2)
    n = length(xs)
    concordant = 0.0
    discordant = 0.0
    for i in 1:n-1, j in i+1:n
        product = sign(xs[j] - xs[i]) * sign(ys[j] - ys[i])
        product > 0 && (concordant += 1)
        product < 0 && (discordant += 1)
    end
    ties_x = _tie_pair_count(xs)
    ties_y = _tie_pair_count(ys)
    pairs = Float64(n) * (n - 1) / 2
    denominator = sqrt(pairs - ties_x) * sqrt(pairs - ties_y)
    iszero(denominator) && eqerror("kendltau: tau is undefined for tied values")
    tau = (concordant - discordant) / denominator
    z = _kendall_score(concordant - discordant, xs, ys)
    narrow(reshape(Float64[tau, z, _two_sided_normal(z)], :, 1))
end

function _contingency_values(matrix, name)
    _need_array(matrix, name)
    ndims(matrix) == 2 || eqerror("$name needs a matrix")
    all(value -> value isa Number && !(value isa Unitful.AbstractQuantity) &&
                 !(value isa Complex && imag(value) != 0), matrix) ||
        eqerror("$name needs real numbers without units")
    values = Float64.(real.(matrix))
    all(isfinite, values) || eqerror("$name needs finite values")
    all(value -> value >= 0, values) || eqerror("$name needs nonnegative frequencies")
    values
end

function _effective_contingency(matrix, name)
    values = _contingency_values(matrix, name)
    size(values, 1) >= 2 && size(values, 2) >= 2 ||
        eqerror("$name needs at least two rows and two columns")
    keep_rows = vec(sum(values, dims=2) .> 0)
    keep_columns = vec(sum(values, dims=1) .> 0)
    effective = values[keep_rows, keep_columns]
    size(effective, 1) >= 2 && size(effective, 2) >= 2 ||
        eqerror("$name needs at least two non-empty rows and columns")
    total = sum(effective)
    isfinite(total) && total > 0 || eqerror("$name needs finite positive total frequency")
    effective, total
end

"""`kendltau2(M)`: tau-b from a contingency table, using weighted cell pairs (no expansion)."""
function eq_kendltau2(matrix)
    table, total = _effective_contingency(matrix, "kendltau2")
    total > 1 || eqerror("kendltau2: total frequency must exceed one")
    table = table ./ total
    rows, columns = size(table)
    concordant = 0.0
    discordant = 0.0
    for i in 1:rows-1, j in 1:columns
        for k in i+1:rows, l in 1:columns
            l > j && (concordant += table[i, j] * table[k, l])
            l < j && (discordant += table[i, j] * table[k, l])
        end
    end
    row_totals = vec(sum(table, dims=2))
    column_totals = vec(sum(table, dims=1))
    row_pairs = sum(row_totals[2:end] .* cumsum(row_totals)[1:end-1])
    column_pairs = sum(column_totals[2:end] .* cumsum(column_totals)[1:end-1])
    denominator = sqrt(row_pairs) * sqrt(column_pairs)
    iszero(denominator) && eqerror("kendltau2: tau is undefined for these frequencies")
    tau = clamp((concordant - discordant) / denominator, -1.0, 1.0)
    z = _kendall_score_untied(tau, total)
    narrow(reshape(Float64[tau, z, _two_sided_normal(z)], :, 1))
end

"""`contingtbl(M)`: Pearson chi-square, df, upper-tail probability, Cramer's V, and C."""
function eq_contingtbl(matrix)
    table, total = _effective_contingency(matrix, "contingtbl")
    rows, columns = size(table)
    expected = sum(table, dims=2) * (sum(table, dims=1) / total)
    chi_squared = sum(abs2, (table .- expected) ./ sqrt.(expected))
    isfinite(chi_squared) || eqerror("contingtbl: chi-square statistic is not finite")
    degrees = (rows - 1) * (columns - 1)
    probability = Distributions.ccdf(Distributions.Chisq(degrees), chi_squared)
    cramers_v = sqrt((chi_squared / total) / min(rows - 1, columns - 1))
    ratio = chi_squared / total
    contingency_coefficient = ratio > 1 ? inv(sqrt(1 + inv(ratio))) :
        sqrt(ratio / (1 + ratio))
    narrow(reshape(Float64[chi_squared, degrees, probability, cramers_v,
                           contingency_coefficient], :, 1))
end
