# the vendor discrete transform conventions
import FFTW

function _fourier_data(data, name)
    (data isa AbstractVector || data isa AbstractMatrix) && !isempty(data) ||
        eqerror("$name needs a nonempty vector or matrix")
    all(x -> x isa Number, data) || eqerror("$name needs numeric data")
    units = unit(first(data))
    values = try
        map(x -> ComplexF64(ustrip(units, x)), data)
    catch error
        (error isa Unitful.DimensionError || error isa MethodError || error isa InexactError) &&
            eqerror("$name needs numbers with compatible units")
        rethrow()
    end
    all(isfinite, values) || eqerror("$name needs finite numbers")
    values, units
end

_fourier_restore(values, units) = units == Unitful.NoUnits ? values : values .* units
_fourier_vector(data) = data isa AbstractVector || size(data, 2) == 1

function _fourier(data, name, operation)
    values, units = _fourier_data(data, name)
    result = operation(values)
    _fourier_restore(result, units)
end
eq_dft(data) = _fourier(data, "dft", FFTW.fft)
eq_idft(data) = _fourier(data, "idft", FFTW.ifft)
eq_cfft(data) = _fourier(data, "cfft", a -> FFTW.ifft(a) .* sqrt(length(a)))
eq_icfft(data) = _fourier(data, "icfft", a -> FFTW.fft(a) ./ sqrt(length(a)))

function eq_dftr(data)
    values, units = _fourier_data(data, "dftr")
    vector = _fourier_vector(data)
    n = vector ? length(data) : size(data, 2)
    iseven(n) || eqerror("dftr needs an even vector length or number of columns")
    full = FFTW.fft(real.(values))
    result = vector ? full[1:(n ÷ 2 + 1)] : full[:, 1:(n ÷ 2 + 1)]
    vector && data isa AbstractMatrix && (result = reshape(result, :, 1))
    _fourier_restore(result, units)
end

function eq_idftr(data)
    values, units = _fourier_data(data, "idftr")
    vector = _fourier_vector(data)
    half = vector ? length(data) : size(data, 2)
    half >= 2 || eqerror("idftr needs at least two frequency values")
    n = 2(half - 1)
    if vector
        halfdata = vec(values)
        full = vcat(halfdata, conj.(reverse(halfdata[2:end-1])))
        result = real.(FFTW.ifft(full))
        data isa AbstractMatrix && (result = reshape(result, :, 1))
    else
        rows = size(values, 1)
        full = Matrix{ComplexF64}(undef, rows, n)
        full[:, 1:half] = values
        for col in half+1:n, row in 1:rows
            full[row, col] = conj(values[mod1(2-row, rows), n-col+2])
        end
        result = real.(FFTW.ifft(full))
    end
    _fourier_restore(result, units)
end

# Biorthogonal spline filter coefficients from PyWavelets.
# https://github.com/PyWavelets/pywt/blob/main/pywt/_extensions/c/wavelets_coeffs.template.h
# Copyright (c) 2006-2012 Filip Wasilewski; Copyright (c) 2012- The PyWavelets Developers.
# Permission is hereby granted, free of charge, to any person obtaining a copy of
# this software and associated documentation files (the "Software"), to deal in
# the Software without restriction, including without limitation the rights to
# use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
# of the Software, and to permit persons to whom the Software is furnished to do
# so, subject to the following conditions.
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# the vendor does not specify padding, phase, or normalization.
const _spline_analysis = Dict(
    (1, 1) => [0.7071067811865476, 0.7071067811865476],
    (1, 3) => [-0.08838834764831845, 0.08838834764831845, 0.7071067811865476, 0.7071067811865476, 0.08838834764831845, -0.08838834764831845],
    (1, 5) => [0.016572815184059706, -0.016572815184059706, -0.12153397801643785, 0.12153397801643785, 0.7071067811865476, 0.7071067811865476, 0.12153397801643785, -0.12153397801643785, -0.016572815184059706, 0.016572815184059706],
    (2, 2) => [-0.1767766952966369, 0.3535533905932738, 1.0606601717798212, 0.3535533905932738, -0.1767766952966369, 0.0],
    (2, 4) => [0.03314563036811941, -0.06629126073623882, -0.1767766952966369, 0.4198446513295126, 0.9943689110435825, 0.4198446513295126, -0.1767766952966369, -0.06629126073623882, 0.03314563036811941, 0.0],
    (2, 6) => [-0.006905339660024878, 0.013810679320049757, 0.04695630968816917, -0.1077232986963881, -0.16987135563661201, 0.4474660099696121, 0.966747552403483, 0.4474660099696121, -0.16987135563661201, -0.1077232986963881, 0.04695630968816917, 0.013810679320049757, -0.006905339660024878, 0.0],
    (2, 8) => [0.0015105430506304422, -0.0030210861012608843, -0.012947511862546647, 0.02891610982635418, 0.05299848189069094, -0.13491307360773605, -0.16382918343409023, 0.46257144047591653, 0.9516421218971786, 0.46257144047591653, -0.16382918343409023, -0.13491307360773605, 0.05299848189069094, 0.02891610982635418, -0.012947511862546647, -0.0030210861012608843, 0.0015105430506304422, 0.0],
    (3, 1) => [-0.3535533905932738, 1.0606601717798212, 1.0606601717798212, -0.3535533905932738],
    (3, 3) => [0.06629126073623882, -0.1988737822087165, -0.15467960838455727, 0.9943689110435825, 0.9943689110435825, -0.15467960838455727, -0.1988737822087165, 0.06629126073623882],
    (3, 5) => [-0.013810679320049757, 0.04143203796014927, 0.052480581416189075, -0.26792717880896527, -0.07181553246425873, 0.966747552403483, 0.966747552403483, -0.07181553246425873, -0.26792717880896527, 0.052480581416189075, 0.04143203796014927, -0.013810679320049757],
    (3, 7) => [0.0030210861012608843, -0.009063258303782653, -0.01683176542131064, 0.074663985074019, 0.03133297870736289, -0.301159125922835, -0.02649924094534547, 0.9516421218971786, 0.9516421218971786, -0.02649924094534547, -0.301159125922835, 0.03133297870736289, 0.074663985074019, -0.01683176542131064, -0.009063258303782653, 0.0030210861012608843],
    (3, 9) => [-0.0006797443727836989, 0.002039233118351097, 0.005060319219611981, -0.020618912641105536, -0.014112787930175844, 0.09913478249423216, 0.012300136269419315, -0.32019196836077857, 0.0020500227115698858, 0.9421257006782068, 0.9421257006782068, 0.0020500227115698858, -0.32019196836077857, 0.012300136269419315, 0.09913478249423216, -0.014112787930175844, -0.020618912641105536, 0.005060319219611981, 0.002039233118351097, -0.0006797443727836989],
)

function eq_Bspline(m, n)
    m = _smooth_integer(m, "Bspline", "m")
    n = _smooth_integer(n, "Bspline", "n")
    haskey(_spline_analysis, (m, n)) || eqerror("Bspline: unsupported filter orders")
    analysis = reverse(_spline_analysis[(m, n)])
    # The table pads even-order filters with one trailing zero; the reference application returns the
    # filter without it, so the matrix has exactly as many rows as the analysis filter.
    m == 2 && (analysis = analysis[2:end])
    # Reconstruction scaling filter is the m-th binomial spline mask, left-aligned
    # and zero-padded to the length of the analysis filter (the reference application, saved fixture).
    synthesis = zeros(length(analysis))
    for k in 0:m
        synthesis[1 + k] = binomial(m, k) / (2.0^m) * sqrt(2.0)
    end
    hcat(analysis, synthesis)
end

# Daubechies four-coefficient transform as the reference application evaluates it (saved the reference application results).
# the periodic Numerical-Recipes pyramid on the first nn entries while nn >= 4, with
# the detail half of every level rotated one place towards the end of its block.
const _DAUB4 = let s3 = sqrt(3.0), k = 4 * sqrt(2.0)
    [(1 + s3) / k, (3 + s3) / k, (3 - s3) / k, (1 - s3) / k]
end
const _DAUB4_DETAIL = [_DAUB4[4], -_DAUB4[3], _DAUB4[2], -_DAUB4[1]]

function _daub4_forward(x::Vector{Float64})
    out = copy(x)
    nn = length(out)
    while nn >= 4
        half = nn ÷ 2
        s = zeros(half)
        d = zeros(half)
        for i in 1:half, k in 1:4
            v = out[mod1(2i - 2 + k, nn)]
            s[i] += _DAUB4[k] * v
            d[i] += _DAUB4_DETAIL[k] * v
        end
        out[1:half] = s
        out[half+1:nn] = circshift(d, 1)
        nn ÷= 2
    end
    out
end

function _daub4_inverse(u::Vector{Float64})
    out = copy(u)
    nn = 4
    while nn <= length(out)
        half = nn ÷ 2
        s = out[1:half]
        d = circshift(out[half+1:nn], -1)
        x = zeros(nn)
        for i in 1:half, k in 1:4
            x[mod1(2i - 2 + k, nn)] += _DAUB4[k] * s[i] + _DAUB4_DETAIL[k] * d[i]
        end
        out[1:nn] = x
        nn *= 2
    end
    out
end

function _wavelet_transform(data, inverse)
    name = inverse ? "iwave" : "wave"
    (data isa AbstractVector || (data isa AbstractMatrix && size(data, 2) == 1)) ||
        eqerror("$name needs a column vector")
    values, units = _fourier_data(data, name)
    n = length(values)
    n >= 2 && ispow2(n) || eqerror("$name needs a power-of-two vector length")
    all(isreal, values) || eqerror("$name needs real data")
    x = Float64.(real.(vec(values)))
    result = inverse ? _daub4_inverse(x) : _daub4_forward(x)
    data isa AbstractMatrix && (result = reshape(result, :, 1))
    _fourier_restore(result, units)
end
eq_wave(data) = _wavelet_transform(data, false)
eq_iwave(data) = _wavelet_transform(data, true)

# Local cosine packets (verified against saved the reference application results for every probe: the transform below reproduces
# them to 1e-13). `cpt(a, n)` returns the levels 0 to `n`; level `l` cuts the (periodic) signal into `2^l` blocks,
# folds the signal at every block boundary with the bell `r(t) = sin(pi/4 (1 + sin(pi t/2)))` over `eta` samples
# on each side, with `eta` half of the FINEST block (`length / 2^n / 2`, so every level depends on `n`), and
# applies an orthonormal DCT-IV to each block. Folding a pair `u = x[b + j]`, `v = x[b - 1 - j]` at the boundary
# `b` gives `r(t) u + r(-t) v` and `r(t) v - r(-t) u` with `t = (j + 1/2) / eta`.
function _cosine_level(signal, level, eta)
    n = length(signal)
    count = 1 << level
    width = n ÷ count
    folded = copy(signal)
    for block in 0:count-1, j in 0:eta-1
        t = (j + 0.5) / eta
        s = sin(pi * t / 2)
        rising, falling = sin(pi / 4 * (1 + s)), sin(pi / 4 * (1 - s))
        u_index, v_index = mod(block * width + j, n) + 1, mod(block * width - 1 - j, n) + 1
        u, v = signal[u_index], signal[v_index]
        folded[u_index] = rising * u + falling * v
        folded[v_index] = rising * v - falling * u
    end
    output = similar(signal)
    for block in 0:count-1
        range = (block*width+1):((block+1)*width)
        output[range] = FFTW.r2r(folded[range], FFTW.REDFT11) ./ sqrt(2width)
    end
    output
end

function eq_cpt(data, rawlevel)
    values, units = _fourier_data(data, "cpt")
    all(isreal, values) || eqerror("cpt needs real data")
    level = _smooth_integer(rawlevel, "cpt", "level"; minimum=0)
    level < 8sizeof(Int)-2 || eqerror("cpt: level is too large")
    divisor = 1 << (level + 1)
    vector = _fourier_vector(data)
    dims = vector ? (length(data),) : size(data)
    all(n -> n % divisor == 0, dims) || eqerror("cpt: dimensions must be divisible by 2^(level+1)")
    input = real.(values)
    levels = Matrix{Any}(undef, level + 1, 1)
    for d in 0:level
        if vector
            transformed = _cosine_level(vec(input), d, length(data) ÷ divisor)
            data isa AbstractMatrix && (transformed = reshape(transformed, :, 1))
        else
            rows, cols = size(input)
            temp = similar(input)
            transformed = similar(input)
            for j in 1:cols
                temp[:,j] = _cosine_level(input[:,j], d, rows ÷ divisor)
            end
            for i in 1:rows
                transformed[i,:] = _cosine_level(temp[i,:], d, cols ÷ divisor)
            end
        end
        levels[d+1,1] = _fourier_restore(transformed, units)
    end
    levels
end
