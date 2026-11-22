# Graphical statistics. the vendor does not specify ownership of histogram boundaries;
# use left-closed bins, with the last bin closed at both ends. Q-Q plotting
# positions use (i - 0.5)/n; unequal samples are interpolated at those positions.
# Constant data with an integer bin count is placed in the last bin.

function _graph_vector(data, name; complex=false)
    data isa AbstractMatrix && (size(data, 1) == 1 || size(data, 2) == 1) && !isempty(data) ||
        eqerror("$name needs a nonempty vector")
    values = Any[]
    for value in data
        value isa Number || eqerror("$name needs numeric values")
        raw = ustrip(value)
        (complex || iszero(imag(raw))) && isfinite(real(raw)) || eqerror("$name needs finite real values")
        push!(values, real(value))
    end
    values
end

function _histogram_data(intervals, data, name)
    values = _graph_vector(data, name)
    _units_checked(name) do
        if intervals isa Number
            _is_integer_value(intervals) && real(intervals) > 0 || eqerror("$name: interval count must be a positive integer")
            n = try Int(real(intervals)) catch; eqerror("$name: interval count is too large") end
            lo, hi = extrema(values)
            edges = [lo + (hi - lo) * (i / n) for i in 0:n]
        else
            edges = _graph_vector(intervals, name)
            length(edges) >= 2 || eqerror("$name needs at least two interval endpoints")
            all(edges[i] < edges[i+1] for i in 1:length(edges)-1) ||
                eqerror("$name: interval endpoints must be strictly increasing")
            n = length(edges) - 1
        end
        counts = zeros(Float64, n)
        for value in values
            for i in 1:n
                if edges[i] <= value && (value < edges[i+1] || (i == n && value <= edges[i+1]))
                    counts[i] += 1
                    break
                end
            end
        end
        mids = [(edges[i] + (edges[i+1] - edges[i]) / 2) for i in 1:n]
        mids, counts
    end
end

eq_hist(intervals, data) = reshape(last(_histogram_data(intervals, data, "hist")), :, 1)
function eq_histogram(intervals, data)
    mids, counts = _histogram_data(intervals, data, "histogram")
    narrow(hcat(mids, counts))
end

function _box_columns(data, name)
    data isa AbstractMatrix && !isempty(data) || eqerror("$name needs a nonempty vector or matrix")
    # Row vectors, like other vectors in EqRuntime, denote a single data set.
    source = size(data, 1) == 1 ? reshape(collect(data), :, 1) : data
    columns = Vector{Vector{Any}}()
    for col in axes(source, 2)
        values = Any[]
        padding = false
        for value in source[:, col]
            value isa Number || eqerror("$name needs real values")
            raw = ustrip(value)
            iszero(imag(raw)) || eqerror("$name needs real values")
            if isnan(real(raw))
                padding = true
                continue
            end
            !padding && isfinite(raw) || eqerror("$name: NaN padding must be at the bottom")
            push!(values, real(value))
        end
        isempty(values) && eqerror("$name needs a value in each column")
        push!(columns, values)
    end
    columns
end

function eq_boxplot(data)
    columns = _box_columns(data, "boxplot")
    results = map(columns) do values
        _units_checked("boxplot") do
            sorted = sort(values)
            q1, med, q3 = (eq_percentile(reshape(values, :, 1), p) for p in (0.25, 0.5, 0.75))
            iqr = q3 - q1
            lower, upper = q1 - 1.5 * iqr, q3 + 1.5 * iqr
            inside = filter(x -> lower <= x <= upper, sorted)
            outliers = filter(x -> x < lower || x > upper, sorted)
            Any[q1, med, q3, first(inside), last(inside), outliers...]
        end
    end
    output = fill!(Matrix{Any}(undef, maximum(length, results), length(results)), NaN)
    for (j, result) in enumerate(results)
        output[1:length(result), j] = result
    end
    narrow(output)
end

function eq_boxplotgraph(data)
    stats = eq_boxplot(data)
    x = Float64[]
    y = Any[]
    for j in axes(stats, 2)
        q1, med, q3, lo, hi = stats[1:5, j]
        # NaN gaps carry the column's units, so the plot axis retains its dimension.
        gap = q1 isa Unitful.AbstractQuantity ? NaN * unit(q1) : NaN
        function segment(xs, ys)
            append!(x, xs)
            append!(y, ys)
            push!(x, NaN)
            push!(y, gap)
        end
        segment([j-0.25, j+0.25, j+0.25, j-0.25, j-0.25],
                [q1, q1, q3, q3, q1])
        segment([j-0.25, j+0.25], [med, med])
        segment([j, j], [lo, q1])
        segment([j, j], [q3, hi])
        segment([j-0.15, j+0.15], [lo, lo])
        segment([j-0.15, j+0.15], [hi, hi])
        for k in 6:size(stats, 1)
            value = stats[k, j]
            isnan(ustrip(value)) && continue
            segment([j-0.07, j+0.07], [value, value])
        end
    end
    eq_vec(reshape(x, :, 1), narrow(reshape(y, :, 1)))
end

function eq_pareto(data)
    data isa AbstractMatrix && size(data, 2) == 2 && size(data, 1) > 0 ||
        eqerror("pareto needs a nonempty two-column matrix")
    labels, values = data[:,1], data[:,2]
    all(x -> x isa AbstractString || (x isa Number && !(x isa Unitful.AbstractQuantity) && isreal(x) && isfinite(x)), labels) || eqerror("pareto: invalid label")
    all(x -> x isa Number && !(x isa Unitful.AbstractQuantity) && isreal(x) && isfinite(x) && real(x) > 0, values) || eqerror("pareto needs positive real values")
    order = sortperm(real.(values); rev=true, alg=Base.Sort.MergeSort)
    sorted = Float64.(real.(values[order]))
    total = sum(sorted)
    isfinite(total) || eqerror("pareto: total is not finite")
    narrow(hcat(labels[order], sorted, 100 .* cumsum(sorted) ./ total))
end

function eq_qqplot(first, second="normal")
    xs = sort(_graph_vector(first, "qqplot"; complex=true))
    n = length(xs)
    probabilities = [(i - 0.5) / n for i in 1:n]
    if second isa AbstractString
        second in ("normal", "weibull") || eqerror("qqplot: unknown distribution")
        all(x -> !(x isa Unitful.AbstractQuantity), xs) || eqerror("qqplot needs unitless values for a distribution")
        if second == "normal"
            ys = [Distributions.quantile(Distributions.Normal(), p) for p in probabilities]
        else
            all(>(0), xs) || eqerror("qqplot: Weibull data must be positive")
            xs = log.(xs)
            ys = [log(-log1p(-p)) for p in probabilities]
        end
    else
        other = sort(_graph_vector(second, "qqplot"; complex=true))
        # Interpolate between the sample's own midpoint plotting positions.
        ys = _units_checked("qqplot") do
            map(probabilities) do p
                position = clamp(p * length(other) + 0.5, 1, length(other))
                below = floor(Int, position)
                above = min(below + 1, length(other))
                other[below] + (position - below) * (other[above] - other[below])
            end
        end
    end
    narrow(hcat(xs, ys))
end
