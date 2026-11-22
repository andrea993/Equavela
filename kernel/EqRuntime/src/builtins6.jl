# the reference application built-in functions (batch 8): convolution, cross-correlation and
# deconvolution. Specs: the specification section 4.1 and
# compatibility .

# ------------------------------------------------------- argument handling

_is_vector(value) = isarr(value) && (size(value, 1) == 1 || size(value, 2) == 1)
# A 1 x 1 array is a column: only an array with more than one column is a row vector.
_is_row_vector(value) = size(value, 1) == 1 && size(value, 2) > 1

"A non-empty numeric array without units, as floats."
function _convolution_array(value, name)
    isarr(value) && !isempty(value) || eqerror("$name needs a non-empty array")
    numeric = narrow(value)
    _isplain(eltype(numeric)) || eqerror("$name needs numbers without units")
    float(numeric)
end

_element_type(signal, kernel) = float(promote_type(eltype(signal), eltype(kernel)))

"`BC` of : 0 zero padding (default), 1 circular, 2 reflect, 3 continue."
function _boundary_condition(value, name)
    _is_integer_value(value) && 0 <= real(value) <= 3 ||
        eqerror("$name: BC must be 0, 1, 2 or 3")
    Int(real(value))
end

"One overlap of : an integer from 1 to the extent of the kernel on that axis."
function _overlap(value, extent, name)
    _is_integer_value(value) || eqerror("$name: the overlap must be an integer")
    overlap = Int(real(value))
    1 <= overlap <= extent || eqerror("$name: the overlap must be from 1 to the kernel size")
    overlap
end

# The overlap of that puts the kernel's origin in its centre.
_centred_overlap(extent) = extent - extent ÷ 2

"""
The row and column overlaps of, from `OV`. The 1-D default is 1, the 2-D default
the centred kernel (at most the extent of the signal). A single number sets the row and the
column overlap alike and must not exceed the kernel on either axis (verified with saved
the reference application results); a vector of two integers gives them separately.
"""
function _overlaps(overlap, signal_size, kernel_rows, kernel_cols, one_dim, name)
    one_dim && overlap === nothing && return 1, 1
    default_rows = min(_centred_overlap(kernel_rows), signal_size[1])
    default_cols = min(_centred_overlap(kernel_cols), signal_size[2])
    overlap === nothing && return default_rows, default_cols
    if one_dim
        overlap isa Number || eqerror("$name: OV must be one integer in 1-D")
        return _overlap(overlap, kernel_rows * kernel_cols, name), 1
    end
    if overlap isa Number
        # One number is both overlaps and must fit the kernel on both axes (the reference application: the initial overlap
        # must not exceed the kernel dimensions).
        return _overlap(overlap, kernel_rows, name), _overlap(overlap, kernel_cols, name)
    end
    isarr(overlap) && length(overlap) == 2 ||
        eqerror("$name: OV must be an integer or a vector of two integers")
    return _overlap(overlap[1], kernel_rows, name), _overlap(overlap[2], kernel_cols, name)
end

# --------------------------------------------------------------- the samples

"""
The 1-based index of the sample at the 0-based position `index` of an axis with
`extent` samples, extended by BC; `nothing` when BC is 0 and the position is
outside the axis.
"""
function _extended_index(index::Int, extent::Int, boundary::Int)
    boundary == 0 && return 1 <= index + 1 <= extent ? index + 1 : nothing
    boundary == 3 && return clamp(index + 1, 1, extent)
    boundary == 1 && return mod1(index + 1, extent)
    # 2, reflect: a mirror at each edge, so the edge sample is repeated outside it.
    period = mod(index, 2 * extent)
    return period < extent ? period + 1 : 2 * extent - period
end

"The sample of a vector at the 0-based position `index`, extended by BC."
function _sample(values, index::Int, boundary::Int, zero_value)
    position = _extended_index(index, length(values), boundary)
    position === nothing ? zero_value : values[position]
end

"The sample of a matrix at the 0-based position `(row, col)`, extended by BC."
function _sample(values, row::Int, col::Int, boundary::Int, zero_value)
    row_index = _extended_index(row, size(values, 1), boundary)
    row_index === nothing && return zero_value
    col_index = _extended_index(col, size(values, 2), boundary)
    col_index === nothing ? zero_value : values[row_index, col_index]
end

# --------------------------------------------------------------- the cores

"""
 on two column vectors (verified with saved the reference application results). With BC 0 the result has
`n + m - 1` elements: the full convolution rotated right by `OV - 1` places. With BC 1, 2
or 3 it has the `n` elements `y[p] = Σ_k K[k] S[p - k + OV - 1]` of the extended signal.
The correlation is the convolution with the kernel reversed (BC 1 to 3, same OV); with BC 0
it is the same full result rotated left by `m - 1` and then right by `OV - 1` places.
"""
function _correlate(signal::AbstractVector, kernel::AbstractVector, boundary, phase,
                    convolution)
    taps = convolution ? kernel : reverse(kernel)
    n, m = length(signal), length(taps)
    element = _element_type(signal, kernel)
    zero_value = zero(element)
    if boundary == 0
        length_full = n + m - 1
        full = zeros(element, length_full)
        for position in 0:(length_full-1), tap in 0:(m-1)
            full[position+1] += taps[tap+1] * _sample(signal, position - tap, 0, zero_value)
        end
        shift = convolution ? -(phase - 1) : m - phase
        return [full[mod(position + shift, length_full)+1] for position in 0:(length_full-1)]
    end
    result = zeros(element, n)
    for position in 0:(n-1), tap in 0:(m-1)
        result[position+1] += taps[tap+1] *
                              _sample(signal, position - tap + (phase - 1), boundary, zero_value)
    end
    result
end

"""
 on two matrices, with the row and column overlaps; the result has the size of the
signal. The correlation is the convolution with the kernel rotated by 180 degrees at the
same overlap (verified with saved the reference application results).
"""
function _correlate(signal::AbstractMatrix, kernel::AbstractMatrix, boundary, row_phase,
                    col_phase, convolution)
    taps = convolution ? kernel : reverse(kernel)
    result = zeros(_element_type(signal, kernel), size(signal))
    zero_value = zero(eltype(result))
    for row in 0:(size(signal, 1)-1), col in 0:(size(signal, 2)-1)
        total = zero_value
        for kernel_row in 0:(size(taps, 1)-1), kernel_col in 0:(size(taps, 2)-1)
            total += taps[kernel_row+1, kernel_col+1] *
                     _sample(signal, row - kernel_row + (row_phase - 1),
                             col - kernel_col + (col_phase - 1), boundary, zero_value)
        end
        result[row+1, col+1] = total
    end
    result
end

function _convolution(name, signal, kernel, boundary, overlap, convolution::Bool)
    s = _convolution_array(signal, name)
    k = _convolution_array(kernel, name)
    bc = _boundary_condition(boundary, name)
    # Two column vectors are the 1-D case; every other pair is a pair of matrices, a row
    # vector being a matrix of one row (the reference application: a 1 x n signal comes back as 1 x n).
    if size(s, 2) == 1 && size(k, 2) == 1
        row_phase, _ = _overlaps(overlap, size(s), size(k, 1), size(k, 2), true, name)
        return reshape(_correlate(vec(s), vec(k), bc, row_phase, convolution), :, 1)
    end
    row_phase, col_phase = _overlaps(overlap, size(s), size(k, 1), size(k, 2), false, name)
    _correlate(s, k, bc, row_phase, col_phase, convolution)
end

"""
`convolve(S, K, [BC], [OV])`: convolution of an array with a kernel, with an
arbitrary phase. BC is the boundary condition (0
zero padding, the default; 1 circular; 2 reflect; 3 continue) and OV the initial
row and column overlap of K with S, 1 in 1-D and the centred kernel in 2-D when
absent. A 1-D result has `n + m - 1` elements, a 2-D result the size of S.
"""
eq_convolve(signal, kernel, boundary=0.0, overlap=nothing) =
    _convolution("convolve", signal, kernel, boundary, overlap, true)

"""
`crosscorr(S, K, [BC], [OV])`: the boundary condition and overlap options of
`convolve`, with the kernel not reversed.
"""
eq_crosscorr(signal, kernel, boundary=0.0, overlap=nothing) =
    _convolution("crosscorr", signal, kernel, boundary, overlap, false)

# ------------------------------------------------------------ deconvolution

"""
`deconvolve(vz, vx)`: the first `n - m + 1` elements of the circular deconvolution of `vz` (`n`
elements) by `vx` (`m` elements, padded with zeros to `n`), the way the reference application computes it
: an exact quotient comes back as
polynomial division gives it, an inexact one as the circular solution (the minimum norm one
when the circular system is singular). A first element of zero is allowed. A `vz` shorter
than `vx` is an error; a zero divisor gives zeros (as in the reference application).
"""
function eq_deconvolve(dividend, divisor)
    z = _convolution_array(dividend, "deconvolve")
    x = _convolution_array(divisor, "deconvolve")
    _is_vector(z) && _is_vector(x) || eqerror("deconvolve needs two vectors")
    values, coefficients = vec(z), vec(x)
    n, m = length(values), length(coefficients)
    m <= n || eqerror("deconvolve: the first vector must not be shorter than the second")
    padded = vcat(coefficients, zeros(eltype(coefficients), n - m))
    spectrum = FFTW.fft(padded)
    scale = maximum(abs, spectrum)
    # A zero in the spectrum (an even length and a divisor such as [1, 1]) makes the circular
    # system singular: the minimum norm solution leaves that component out, which is what
    # the reference application returns (a consistent dividend still comes back exactly).
    inverse = [abs(s) > 1e-12 * scale ? inv(s) : zero(s) for s in spectrum]
    circular = FFTW.ifft(FFTW.fft(values) .* inverse)
    quotient = circular[1:(n-m+1)]
    if all(isreal, values) && all(isreal, coefficients)
        quotient = real.(quotient)
    end
    _is_row_vector(z) ? reshape(quotient, 1, :) : reshape(quotient, :, 1)
end
