# Outlier and NaN data-set functions. See the vendor's outlier and NaN help pages.
import Distributions

function _data_matrix(data, name; real_only=false, finite=false)
    data isa AbstractMatrix && !isempty(data) || eqerror("$name needs a nonempty matrix")
    all(x -> x isa Number && !(x isa Unitful.AbstractQuantity) &&
        (!real_only || iszero(imag(x))) && (!finite || isfinite(x)), data) ||
        eqerror("$name needs $(finite ? "finite " : "")$(real_only ? "real " : "")unitless numbers")
    data
end

_data_isnan(x) = isnan(real(x)) || isnan(imag(x))
_data_index(i, j, vector) = vector ? Float64(i - 1 + origin()) :
    reshape(Float64[i - 1 + origin(), j - 1 + origin()], 2, 1)

function _data_outliers(data, threshold, classic, name)
    _data_matrix(data, name; real_only=true, finite=true)
    n = length(data)
    n >= 3 || eqerror("$name needs at least three data points")
    values = Float64.(real.(data))
    all(isfinite, values) || eqerror("$name needs representable numbers")
    average = sum(values) / n
    deviation = sqrt(sum(abs2, values .- average) / (n - 1))
    deviation > 0 && isfinite(deviation) || eqerror("$name needs a nonzero finite standard deviation")
    statistic = abs.(values .- average) ./ deviation
    positions = [(i, j) for i in axes(data, 1) for j in axes(data, 2)]
    if classic
        positions = [positions[argmax([statistic[i, j] for (i, j) in positions])]]
    else
        selected = filter(pos -> statistic[pos...] > threshold, positions)
        positions = isempty(selected) ? [positions[argmax([statistic[i, j] for (i, j) in positions])]] : selected
    end
    result = Matrix{Any}(undef, length(positions), name == "ThreeSigma" ? 2 : 3)
    for (k, (i, j)) in enumerate(positions)
        result[k, 1] = _data_index(i, j, size(data, 2) == 1)
        result[k, 2] = statistic[i, j]
        name == "ThreeSigma" || (result[k, 3] = statistic[i, j] - threshold)
    end
    narrow(result)
end

function _grubbs(data, confidence, classic)
    name = classic ? "GrubbsClassic" : "Grubbs"
    _data_matrix(data, name; real_only=true, finite=true)
    n = length(data)
    n >= 3 || eqerror("$name needs at least three data points")
    confidence isa Real && !(confidence isa Unitful.AbstractQuantity) && 0 < confidence < 1 ||
        eqerror("$name needs a probability between zero and one")
    tail = (1 - confidence) / (classic ? n : 2n)
    t = Distributions.cquantile(Distributions.TDist(n - 2), tail)
    critical = (n - 1) / sqrt(n) * sqrt(t^2 / (n - 2 + t^2))
    _data_outliers(data, critical, classic, name)
end
eq_Grubbs(data, confidence) = _grubbs(data, confidence, false)
eq_GrubbsClassic(data, confidence) = _grubbs(data, confidence, true)
eq_ThreeSigma(data) = _data_outliers(data, 3, false, "ThreeSigma")

function _data_indices(indices, name)
    indices isa AbstractMatrix && size(indices, 2) == 1 || eqerror("$name needs a column vector of indices")
    vec(indices)
end

function eq_trim(data, indices)
    _data_matrix(data, "trim")
    removed = Set{Int}()
    for index in _data_indices(indices, "trim")
        row = _julia_index(index)
        row <= size(data, 1) || eqerror("trim: index out of range")
        push!(removed, row)
    end
    data[[i for i in axes(data, 1) if !(i in removed)], :]
end

function eq_markNaN(data, indices)
    _data_matrix(data, "markNaN")
    result = Matrix{Any}(data)
    for index in _data_indices(indices, "markNaN")
        if index isa AbstractMatrix
            size(index) == (2, 1) || eqerror("markNaN needs index pairs of size 2 × 1")
            i, j = _julia_index(index[1]), _julia_index(index[2])
        else
            size(data, 2) == 1 || eqerror("markNaN needs index pairs for a matrix")
            i, j = _julia_index(index), 1
        end
        i <= size(data, 1) && j <= size(data, 2) || eqerror("markNaN: index out of range")
        result[i, j] = NaN
    end
    narrow(result)
end

function eq_matchNaN(data)
    _data_matrix(data, "matchNaN")
    positions = Any[_data_index(i, j, size(data, 2) == 1)
                    for i in axes(data, 1) for j in axes(data, 2) if _data_isnan(data[i, j])]
    narrow(reshape(positions, :, 1))
end

function eq_filterNaN(data)
    _data_matrix(data, "filterNaN")
    data[[i for i in axes(data, 1) if !any(_data_isnan, data[i, :])], :]
end

# The first four entries have the vendor-documented accessors. The final two entries
# carry residuals and continuation parameters; their internal layout is,
# but remains an ordinary nested worksheet value.
import LinearAlgebra

function _pca_integer(value, name)
    value isa Real && !(value isa Unitful.AbstractQuantity) && isfinite(value) &&
        isinteger(value) && 1 <= value < Float64(typemax(Int)) || eqerror("$name needs a positive integer")
    Int(value)
end

function _pca_result(result, name)
    result isa AbstractMatrix && size(result) == (6, 1) &&
        all(x -> x isa AbstractMatrix, result) || eqerror("$name needs a Nipals result")
    result
end
eq_scores(result) = eq_val(_pca_result(result, "scores")[1])
eq_loadings(result) = eq_val(_pca_result(result, "loadings")[2])
eq_PCAvariance(result) = eq_val(_pca_result(result, "PCAvariance")[3])
eq_PCAeigenvals(result) = eq_val(_pca_result(result, "PCAeigenvals")[4])

function _pca_extend(scores, loadings, variances, eigenvalues, residual, params, count)
    rows, cols = size(residual)
    maxiter, accuracy, total = Int(params[1]), params[2], params[3]
    size(scores, 2) + count <= min(rows - 1, cols) ||
        eqerror("Nipals: too many principal components")
    residual = copy(residual)
    scores = copy(scores); loadings = copy(loadings)
    variances = copy(variances); eigenvalues = copy(eigenvalues)
    for _ in 1:count
        column = argmax([sum(abs2, residual[:, j]) for j in 1:cols])
        t = copy(residual[:, column])
        sum(abs2, t) > eps(Float64) * total || eqerror("Nipals: data rank is insufficient")
        converged = false
        p = zeros(cols)
        for _ in 1:maxiter
            p = residual' * t / LinearAlgebra.dot(t, t)
            pn = LinearAlgebra.norm(p)
            pn > 0 && isfinite(pn) || eqerror("Nipals: data rank is insufficient")
            p ./= pn
            newt = residual * p
            if LinearAlgebra.norm(newt - t) <= accuracy * max(LinearAlgebra.norm(newt), eps())
                t = newt
                converged = true
                break
            end
            t = newt
        end
        converged || eqerror("Nipals: iteration did not converge")
        residual .-= t * p'
        scores = hcat(scores, t)
        loadings = hcat(loadings, p)
        eigenvalues = vcat(eigenvalues, sum(abs2, t))
        variances = vcat(variances, 1 - sum(abs2, residual) / total)
    end
    reshape(Any[scores, loadings, variances, eigenvalues, residual, copy(params)], 6, 1)
end

function eq_Nipals(data, numpc, maxiter, scale, accuracy)
    _data_matrix(data, "Nipals"; real_only=true, finite=true)
    rows, cols = size(data)
    rows >= 2 || eqerror("Nipals needs at least two rows")
    count = _pca_integer(numpc, "Nipals")
    iterations = _pca_integer(maxiter, "Nipals")
    scale in ("scale", "noscale") || eqerror("Nipals scale must be scale or noscale")
    accuracy isa Real && !(accuracy isa Unitful.AbstractQuantity) && isfinite(accuracy) && accuracy > 0 ||
        eqerror("Nipals accuracy must be positive and finite")
    residual = Float64.(real.(data))
    all(isfinite, residual) || eqerror("Nipals needs representable numbers")
    for j in 1:cols
        residual[:, j] .-= sum(residual[:, j]) / rows
        if scale == "scale"
            sd = sqrt(sum(abs2, residual[:, j]) / (rows - 1))
            sd > 0 || eqerror("Nipals cannot scale a constant column")
            residual[:, j] ./= sd
        end
    end
    total = sum(abs2, residual)
    total > 0 && isfinite(total) || eqerror("Nipals needs nonconstant finite data")
    _pca_extend(zeros(rows, 0), zeros(cols, 0), zeros(0, 1), zeros(0, 1),
                residual, reshape([Float64(iterations), Float64(accuracy), total], :, 1), count)
end

function eq_Nipals2(result, additional)
    _pca_result(result, "Nipals2")
    count = _pca_integer(additional, "Nipals2")
    scores, loadings, variances, eigenvalues, residual, params = result
    rows, cols = size(residual)
    components = size(scores, 2)
    valid = rows >= 2 && cols >= 1 && 1 <= components <= min(rows - 1, cols) &&
        size(scores, 1) == rows && size(loadings) == (cols, components) &&
        size(variances) == (components, 1) && size(eigenvalues) == (components, 1) &&
        size(params) == (3, 1) &&
        all(a -> all(x -> x isa Real && !(x isa Unitful.AbstractQuantity) && isfinite(x), a), result)
    valid || eqerror("Nipals2 needs a valid Nipals result")
    params[1] >= 1 && isinteger(params[1]) && params[1] < Float64(typemax(Int)) &&
        params[2] > 0 && params[3] > 0 || eqerror("Nipals2 needs valid continuation parameters")
    _pca_extend(result[1], result[2], result[3], result[4], result[5], result[6], count)
end
