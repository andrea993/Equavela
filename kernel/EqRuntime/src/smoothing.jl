# Data analysis smoothing and local extrema (the vendor the reference application built-ins).

function _smooth_vector(v, name; real_only=false)
    (v isa AbstractVector || (v isa AbstractMatrix && (size(v,1)==1 || size(v,2)==1))) ||
        eqerror("$name needs a vector")
    all(element -> element isa Number, v) || eqerror("$name needs numbers")
    values = vec(v)
    isempty(values) && eqerror("$name needs at least one element")
    all(x -> x isa Unitful.AbstractQuantity ? isfinite(ustrip(x)) : isfinite(x), values) ||
        eqerror("$name needs finite values")
    real_only && any(x -> x isa Complex && !iszero(imag(x)), values) &&
        eqerror("$name needs real values")
    values
end

function _smooth_integer(x, name, label; minimum=1)
    x isa Real && !(x isa Unitful.AbstractQuantity) && isfinite(x) && isinteger(x) && x >= minimum ||
        eqerror("$name: $label must be an integer >= $minimum")
    x < 2.0^(8sizeof(Int) - 1) || eqerror("$name: $label is too large")
    Int(x)
end

function _smooth_median(values)
    ordered = sort(collect(values)); n=length(ordered)
    isodd(n) ? ordered[(n+1)÷2] : (ordered[n÷2]+ordered[n÷2+1])/2
end

# Matrices are filtered independently down each column, the worksheet time axis.
function _smooth_columns(v, name)
    (v isa AbstractVector || v isa AbstractMatrix) && !isempty(v) || eqerror("$name needs a nonempty array")
    all(x -> x isa Number && isfinite(ustrip(x)), v) || eqerror("$name needs finite numbers")
    v isa AbstractVector || size(v, 1) == 1 ? reshape(v, :, 1) : v
end

"`movavg(v,n)`: trailing moving average, with a growing prefix at the start."
function eq_movavg(v, n)
    a = _smooth_columns(v, "movavg")
    width = _smooth_integer(n, "movavg", "window width")
    out = Matrix{Any}(undef, size(a))
    for j in axes(a, 2)
        acc = zero(a[1,j])
        for i in axes(a, 1)
            acc += a[i,j]
            i > width && (acc -= a[i-width,j])
            out[i,j] = acc / min(i, width)
        end
    end
    result = narrow(out)
    v isa AbstractVector ? vec(result) : reshape(result, size(v))
end

"`expsmooth(v,a)`: recursive exponential average, initialized at the first observation."
function eq_expsmooth(v, alpha)
    a = _smooth_columns(v, "expsmooth")
    alpha isa Real && !(alpha isa Unitful.AbstractQuantity) && isfinite(alpha) && 0 <= alpha <= 1 ||
        eqerror("expsmooth: a must be between 0 and 1")
    out = Matrix{Any}(undef, size(a))
    for j in axes(a, 2)
        out[1,j] = a[1,j]
        for i in 2:size(a, 1)
            out[i,j] = alpha * a[i,j] + (1-alpha) * out[i-1,j]
        end
    end
    result = narrow(out)
    v isa AbstractVector ? vec(result) : reshape(result, size(v))
end

"`medsmooth(v[,n[,m]])`: centered median filter; vector edge windows contract."
function eq_medsmooth(v, n=3, m=nothing)
    (v isa AbstractVector || v isa AbstractMatrix) || eqerror("medsmooth: v must be an array")
    all(element -> element isa Number && !(element isa Complex && !iszero(imag(element))) &&
        (element isa Unitful.AbstractQuantity ? isfinite(ustrip(element)) : isfinite(element)), v) ||
        eqerror("medsmooth needs finite real values")
    isempty(v) && eqerror("medsmooth needs a nonempty array")
    width = _smooth_integer(n, "medsmooth", "n")
    isodd(width) || eqerror("medsmooth: n must be odd")
    if v isa AbstractVector || min(size(v)...) == 1
        m === nothing || eqerror("medsmooth: m is not applicable to a vector")
        a = vec(v); half = width ÷ 2; out = Vector{Any}(undef, length(a))
        for i in eachindex(a)
            lo, hi = max(firstindex(a), i-half), min(lastindex(a), i+half)
            out[i] = _smooth_median(view(a, lo:hi))
        end
        return v isa AbstractVector ? out : narrow(reshape(out, size(v)))
    end
    other = m === nothing ? width : _smooth_integer(m, "medsmooth", "m")
    isodd(other) || eqerror("medsmooth: m must be odd")
    hr,hc=width÷2,other÷2; out=Matrix{Any}(undef, size(v))
    for j in axes(v,2), i in axes(v,1)
        rows=max(first(axes(v,1)),i-hr):min(last(axes(v,1)),i+hr)
        cols=max(first(axes(v,2)),j-hc):min(last(axes(v,2)),j+hc)
        out[i,j]=_smooth_median((v[r,c] for r in rows for c in cols))
    end
    narrow(out)
end

"`VSmooth(v,w)`: repeated median smoother, converged to TOL."
function eq_VSmooth(v, windows)
    a = _smooth_vector(v, "VSmooth"; real_only=true)
    ws = _smooth_vector(windows, "VSmooth"; real_only=true)
    current = collect(a)
    for raw in ws
        w = _smooth_integer(raw, "VSmooth", "window width"; minimum=0)
        (w == 0 || isodd(w)) || eqerror("VSmooth: window widths must be odd or zero")
        w < length(current) || eqerror("VSmooth: window widths must be smaller than the vector length")
        w == 0 && continue
        half = w ÷ 2
        converged = false
        for _ in 1:10000
            next = Vector{Any}(undef, length(current))
            for i in eachindex(current)
                lo, hi = max(1, i-half), min(length(current), i+half)
                next[i] = _smooth_median(view(current, lo:hi))
            end
            err = maximum(abs.(next .- current))
            scale = maximum(abs, current)
            iszero(scale) && (scale = oneunit(scale))
            current = next
            if err <= tol() * scale
                converged = true
                break
            end
        end
        converged || eqerror("VSmooth: smoothing did not converge")
    end
    v isa AbstractVector ? current : narrow(reshape(current, size(v)))
end

function _local_extrema(values, window, ismax)
    inds = Int[]
    window >= length(values) && return inds
    for i in window+1:length(values)-window
        center = values[i]
        all(j -> i == j || (ismax ? center > values[j] : center < values[j]), (i-window):(i+window)) && push!(inds, i)
    end
    inds
end

"`localmax/min(M,w)` and `localmax/min(x,y,Z,w)` return extrema coordinates and values."
function _eq_local_extrema(name, args, ismax)
    length(args) in (1,2,3,4) || eqerror("$name expects one, two, three, or four arguments")
    w = length(args) in (2,4) ? _smooth_integer(args[end], name, "w") : 1
    if length(args) in (1,2)
        data = args[1]
        data isa AbstractMatrix && size(data,2) == 2 && size(data,1) >= 1 || eqerror("$name: M1 must be a real n by 2 matrix")
        all(x -> x isa Real && isfinite(x), data) || eqerror("$name needs finite real data")
        vals = data[:,2]; inds = _local_extrema(vals,w,ismax)
        return narrow(hcat(data[inds,1], data[inds,2]))
    end
    x, y, z = args[1:3]
    _smooth_vector(x,name; real_only=true); _smooth_vector(y,name; real_only=true)
    all(isfinite, x) && all(isfinite,y) || eqerror("$name needs finite real data")
    z isa AbstractMatrix && size(z) == (length(x), length(y)) || eqerror("$name: M2 dimensions must match x and y")
    all(a -> a isa Real && isfinite(a), z) || eqerror("$name needs finite real data")
    rows = Tuple{Int,Int}[]
    w >= min(size(z)...) && return Matrix{Float64}(undef, 0, 3)
    for i in w+1:size(z,1)-w, j in w+1:size(z,2)-w
        center = z[i,j]
        all(pair -> begin
                ii,jj=pair
                ismax ? center > z[ii,jj] : center < z[ii,jj]
            end, ((ii,jj) for ii in i-w:i+w for jj in j-w:j+w if ii != i || jj != j)) && push!(rows,(i,j))
    end
    output = Matrix{Float64}(undef, length(rows), 3)
    for (k, (i,j)) in enumerate(rows)
        output[k,:] .= (x[i], y[j], z[i,j])
    end
    narrow(output)
end
eq_localmax(args...) = _eq_local_extrema("localmax", args, true)
eq_localmin(args...) = _eq_local_extrema("localmin", args, false)

function _xy_smoothing(vx,vy,name)
    x = _smooth_vector(vx,name; real_only=true); y = _smooth_vector(vy,name; real_only=true)
    length(x) == length(y) || eqerror("$name: vx and vy must have the same length")
    length(x) >= 2 || eqerror("$name needs at least two data points")
    all(diff(Float64.(x)) .> 0) || eqerror("$name: vx must be strictly ascending")
    Float64.(x), Float64.(y)
end

"`ksmooth(vx,vy,b)`: normalized Gaussian kernel smoother whose kernel SD is the bandwidth b."
function eq_ksmooth(vx,vy,b)
    x,y = _xy_smoothing(vx,vy,"ksmooth")
    b isa Real && !(b isa Unitful.AbstractQuantity) && isfinite(b) && b > 0 || eqerror("ksmooth: b must be positive")
    bw=Float64(b); out=similar(y)
    for i in eachindex(y)
        weights = exp.(-0.5 .* ((x[i] .- x)./bw).^2)
        out[i] = sum(weights .* y) / sum(weights)
    end
    reshape(out,size(vy))
end

# Friedman (1984), as described in https://fmwww.bc.edu/RePEc/bocode/s/supsmooth_doc.pdf.
# three symmetric running-line fits, leverage-corrected leave-one-out residuals,
# smoothed local error and span, linear interpolation, and a final running line.
# A minimum five-point window avoids undefined leave-one-out regressions.
function _running_line(x, y, k; cv=false)
    n = length(x)
    k = clamp(k, 5, n)
    fit = zeros(n)
    residual = zeros(n)
    for i in 1:n
        lo = clamp(i - k ÷ 2, 1, n-k+1)
        inds = lo:lo+k-1
        dx = x[inds] .- x[i]
        mx = sum(dx) / k
        my = sum(y[inds]) / k
        centered = dx .- mx
        variance = sum(abs2, centered)
        covariance = sum(centered .* (y[inds] .- my))
        fit[i] = my - mx * covariance / variance
        if cv
            leverage = 1/k + mx^2 / variance
            leverage < 1 || eqerror("supsmooth: degenerate cross-validation window")
            residual[i] = abs(y[i] - fit[i]) / (1 - leverage)
        end
    end
    cv ? (fit, residual) : fit
end

"`supsmooth(vx,vy)`: Friedman variable-span cross-validated running-line smoother."
function eq_supsmooth(vx, vy)
    x, y = _xy_smoothing(vx, vy, "supsmooth")
    n = length(x)
    n >= 5 || eqerror("supsmooth needs at least five data points")
    fractions = [0.05, 0.2, 0.5]
    windows = [clamp(2 * floor(Int, fraction*n/2) + 1, 5, n) for fraction in fractions]
    fits = Vector{Vector{Float64}}()
    errors = Vector{Vector{Float64}}()
    for k in windows
        fit, residual = _running_line(x, y, k; cv=true)
        push!(fits, fit)
        push!(errors, _running_line(x, residual, windows[2]))
    end
    selected = [fractions[argmin([errors[j][i] for j in 1:3])] for i in 1:n]
    spans = _running_line(x, selected, windows[2])
    intermediate = zeros(n)
    for i in 1:n
        span = clamp(spans[i], fractions[1], fractions[end])
        lower = span <= fractions[2] ? 1 : 2
        weight = (span - fractions[lower]) / (fractions[lower+1] - fractions[lower])
        intermediate[i] = (1-weight)*fits[lower][i] + weight*fits[lower+1][i]
    end
    reshape(_running_line(x, intermediate, windows[1]), size(vy))
end
