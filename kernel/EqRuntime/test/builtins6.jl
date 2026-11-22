# Built-in functions (batch 8): convolution, cross-correlation and deconvolution.
# Golden values are the ones the reference application saved for the probe worksheets


@testset "convolve: the 1-D default is the product of the coefficient vectors" begin
    # S = [1, 2, 3] and K = [4, 5] give the coefficients of the product.
    product = eq_convolve(eq_vec(1, 2, 3), eq_vec(4, 5))
    @test vec(product) == [4.0, 13, 22, 15]
    @test size(product) == (4, 1)
    # A row vector is a matrix of one row: the result has the size of the signal (the reference application).
    @test eq_convolve(eq_rowvec(1, 2, 3, 4), eq_rowvec(1, 2, 3)) == [4.0 10 16 17]
    # A row signal with a column kernel is the signal (the reference application).
    @test eq_convolve(eq_rowvec(1, 2, 3, 4), eq_vec(1, 2, 3)) == [1.0 2 3 4]
    # Complex elements.
    @test vec(eq_convolve(eq_vec(1 + im, 2), eq_vec(1, -im))) ≈ [1+im, 3-im, -2im]
    # A one-element kernel scales, and a kernel longer than the signal is allowed.
    @test vec(eq_convolve(eq_vec(1, 2, 3), eq_vec(2))) == [2.0, 4, 6]
    @test vec(eq_convolve(eq_vec(2), eq_vec(1, 2, 3))) == [2.0, 4, 6]
    @test vec(eq_convolve(eq_vec(1, 2, 3, 4), eq_vec(1, 2))) == [1.0, 4, 7, 10, 8]
end

@testset "crosscorr: the kernel is not reversed, 1-D" begin
    signal, kernel = eq_vec(1, 2, 3, 4), eq_vec(1, 2, 3)
    # the reference application: the positive lags first, then the negative ones.
    @test vec(eq_crosscorr(signal, kernel)) == [14.0, 20, 11, 4, 3, 8]
    @test size(eq_crosscorr(eq_vec(1, 2, 3), eq_vec(4, 5))) == (4, 1)
    @test vec(eq_crosscorr(signal, kernel, 0.0, 2.0)) == [8.0, 14, 20, 11, 4, 3]
    @test vec(eq_crosscorr(signal, kernel, 0.0, 3.0)) == [3.0, 8, 14, 20, 11, 4]
    # With BC 1 to 3 the result has the size of the signal and is the convolution with the
    # kernel reversed, at the same overlap.
    @test vec(eq_crosscorr(signal, kernel, 1.0)) == [14.0, 12, 14, 20]
    @test vec(eq_crosscorr(signal, kernel, 3.0)) == [6.0, 9, 14, 20]
    @test vec(eq_crosscorr(signal, kernel, 2.0, 2.0)) == [9.0, 14, 20, 23]
    @test vec(eq_crosscorr(signal, kernel, 1.0)) == vec(eq_convolve(signal, eq_vec(3, 2, 1), 1.0))
end

@testset "convolve: the boundary conditions and the overlap" begin
    signal, kernel = eq_vec(1, 2, 3, 4), eq_vec(1, 2, 3)
    # BC 0, the default, and an overlap of 1: the full convolution; the overlap rotates it.
    @test vec(eq_convolve(signal, kernel)) == [1.0, 4, 10, 16, 17, 12]
    @test eq_convolve(signal, kernel, 0.0) == eq_convolve(signal, kernel)
    @test eq_convolve(signal, kernel) == eq_convolve(signal, kernel, 0.0, 1.0)
    @test vec(eq_convolve(signal, kernel, 0.0, 2.0)) == [12.0, 1, 4, 10, 16, 17]
    @test vec(eq_convolve(signal, kernel, 0.0, 3.0)) == [17.0, 12, 1, 4, 10, 16]
    # BC 1 (circular), 2 (reflect, the edge sample is repeated) and 3 (continue): the result
    # has the n elements of the signal, and the overlap moves the window.
    @test vec(eq_convolve(signal, kernel, 1.0)) == [18.0, 16, 10, 16]
    @test vec(eq_convolve(signal, kernel, 1.0, 2.0)) == [16.0, 10, 16, 18]
    @test vec(eq_convolve(signal, kernel, 1.0, 3.0)) == [10.0, 16, 18, 16]
    @test vec(eq_convolve(signal, kernel, 2.0)) == [9.0, 7, 10, 16]
    @test vec(eq_convolve(signal, kernel, 2.0, 2.0)) == [7.0, 10, 16, 21]
    @test vec(eq_convolve(signal, kernel, 2.0, 3.0)) == [10.0, 16, 21, 23]
    @test vec(eq_convolve(signal, kernel, 3.0)) == [6.0, 7, 10, 16]
    @test vec(eq_convolve(signal, kernel, 3.0, 2.0)) == [7.0, 10, 16, 21]
    @test vec(eq_convolve(signal, kernel, 3.0, 3.0)) == [10.0, 16, 21, 24]
    @test vec(eq_convolve(signal, eq_vec(1, 2), 1.0)) == [9.0, 4, 7, 10]
    # The kernel sample OV - 1 is the one over the first sample of the signal.
    spike, weights = eq_vec(1, 0, 0), eq_vec(10, 20, 30)
    @test eq_convolve(spike, weights, 1.0, 1.0)[1] == 10.0
    @test eq_convolve(spike, weights, 1.0, 2.0)[1] == 20.0
    @test eq_convolve(spike, weights, 1.0, 3.0)[1] == 30.0
end

@testset "convolve and crosscorr: 2-D with the centred kernel" begin
    signal = eq_matrix(3, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9)
    square = eq_matrix(3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1)
    # The result has the size of the signal and is the 3 x 3 neighbourhood sum.
    result = eq_convolve(signal, square)
    @test size(result) == (3, 3)
    @test result == [12.0 21 16; 27 45 33; 24 39 28]
    # A symmetric kernel gives the same convolution and correlation, as the help's example says.
    @test eq_crosscorr(signal, square) == result
    # A delta in the centre of the kernel is the identity: the 2-D default is zero phase.
    centre = eq_matrix(3, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0)
    @test eq_convolve(signal, centre) == signal
    @test eq_crosscorr(signal, centre) == signal
    # The 2-D default overlap is kernel extent - extent/2 on each axis.
    @test eq_convolve(signal, square) == eq_convolve(signal, square, 0.0, eq_vec(2, 2))
    # crosscorr is the convolution with the kernel rotated by 180 degrees, at the same overlap.
    asymmetric = eq_matrix(3, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9)
    rotated = eq_matrix(3, 3, 9, 8, 7, 6, 5, 4, 3, 2, 1)
    @test eq_convolve(signal, rotated) == eq_crosscorr(signal, asymmetric)
    @test eq_convolve(signal, asymmetric) != eq_crosscorr(signal, asymmetric)
    # A rectangular kernel keeps the size of the signal; so does a kernel larger than it.
    @test size(eq_convolve(signal, eq_matrix(2, 3, 1, 0, 0, 1, 0, 0))) == (3, 3)
    @test eq_convolve(eq_matrix(2, 2, 1, 2, 3, 4), square) == fill(10.0, 2, 2)
end

@testset "convolve and crosscorr: the reference application's 4 x 4 worksheet" begin
    signal = eq_matrix(4, 4, 1:16...)
    diagonal = eq_matrix(3, 3, 1, 0, 0, 0, 2, 0, 0, 0, 3)
    @test eq_convolve(signal, diagonal) == [8.0 11 14 8; 20 26 32 25; 32 50 56 45; 26 55 60 65]
    @test eq_convolve(signal, diagonal, 1.0) == [56.0 50 56 58; 32 26 32 34; 56 50 56 58; 64 58 64 66]
    @test eq_convolve(signal, diagonal, 3.0) == [11.0 14 20 25; 23 26 32 37; 47 50 56 61; 67 70 76 81]
    # A single number is both the row and the column overlap.
    @test eq_convolve(signal, diagonal, 0.0, 1.0) == [1.0 2 3 4; 5 8 11 14; 9 20 26 32; 13 32 50 56]
    @test eq_convolve(signal, diagonal, 0.0, 3.0) == [26.0 32 25 12; 50 56 45 24; 55 60 65 36; 39 42 45 48]
    # An even kernel: the default overlap is 1.
    even = eq_matrix(2, 2, 1, 2, 3, 4)
    @test eq_convolve(signal, even) == [1.0 4 7 10; 8 26 36 46; 24 66 76 86; 40 106 116 126]
    @test eq_crosscorr(signal, even) == [4.0 11 18 25; 22 44 54 64; 46 84 94 104; 70 124 134 144]
end

@testset "convolve and crosscorr: an explicit 2-D overlap" begin
    signal = eq_matrix(2, 2, 1, 2, 3, 4)
    # A delta at the first sample of the kernel, so the phase shows in the result.
    delta = eq_matrix(2, 2, 1, 0, 0, 0)
    # The default of a 2 x 2 kernel is extent - extent/2 = 1: the delta stays over the signal.
    @test eq_convolve(signal, delta) == signal
    @test eq_crosscorr(signal, delta) == eq_convolve(signal, reverse(delta))
    @test eq_convolve(signal, delta, 0.0, eq_vec(1, 1)) == signal
    # An overlap of 2 moves the kernel sample 1 to the first sample of the signal.
    @test eq_convolve(signal, delta, 0.0, eq_vec(2, 2)) == [4.0 0; 0 0]
    @test eq_convolve(signal, delta, 0.0, 2.0) == [4.0 0; 0 0]
    @test eq_convolve(signal, delta, 0.0, eq_vec(1, 2)) == [2.0 0; 4 0]
end

@testset "deconvolve is the circular deconvolution, first n - m + 1 elements" begin
    kernel = eq_vec(4, 5)
    product = eq_convolve(eq_vec(1, 2, 3), kernel)
    @test vec(eq_deconvolve(product, kernel)) ≈ [1.0, 2, 3]
    @test size(eq_deconvolve(product, kernel)) == (3, 1)
    @test vec(eq_deconvolve(eq_vec(1, 3, 3, 1), eq_vec(1, 1))) ≈ [1.0, 2, 1]
    @test vec(eq_deconvolve(eq_vec(6, 5, 1), eq_vec(3, 1))) ≈ [2.0, 1]
    # Inexact divisions, as the reference application returns them.
    @test vec(eq_deconvolve(eq_vec(1, 3, 3, 1, 5), eq_vec(1, 1))) ≈ [-1.5, 4.5, -1.5, 2.5]
    @test vec(eq_deconvolve(eq_vec(1, 3, 3, 1), eq_vec(1, 1, 1))) ≈ [5 / 3, 5 / 3]
    # A divisor that starts with zero is a shift.
    @test vec(eq_deconvolve(eq_vec(1, 3, 3, 1), eq_vec(0, 1))) ≈ [3.0, 3, 1]
    # Complex elements and the orientation of the dividend.
    @test eq_deconvolve(eq_rowvec(4, 13, 10), eq_rowvec(4, 5)) ≈ [1.0 2]
    @test vec(eq_deconvolve(eq_vec(1 + im, 1 - im), eq_vec(1))) ≈ [1+im, 1-im]
end

@testset "convolve: one overlap number must fit both kernel axes (saved the reference application results)" begin
    signal = eq_matrix(4, 4, 1:16...)
    kernel = eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)
    @test eq_convolve(signal, kernel, 0.0, 2.0) == [29.0 62 83 75; 77 146 167 139; 125 230 251 203; 121 208 223 170]
    @test_throws EqError eq_convolve(signal, kernel, 0.0, 3.0)
    # An overlap given as a column [rows; columns].
    diagonal = eq_matrix(3, 3, 1, 0, 0, 0, 2, 0, 0, 0, 3)
    @test eq_convolve(signal, diagonal, 0.0, eq_vec(1, 3)) == [3.0 4 0 0; 11 14 8 0; 26 32 25 12; 50 56 45 24]
    @test eq_convolve(signal, diagonal, 0.0, eq_vec(3, 1)) == [9.0 20 26 32; 13 32 50 56; 0 26 55 60; 0 0 39 42]
    # Kernels longer than the signal and a kernel of two elements (saved the reference application results).
    @test vec(eq_convolve(eq_vec(1, 2, 3, 4), eq_vec(1, 2, 3, 4, 5, 6), 1.0)) == [55.0, 44, 53, 58]
    @test vec(eq_convolve(eq_vec(1, 2, 3, 4), eq_vec(1, 2, 3, 4, 5, 6), 0.0, 4.0)) == [43.0, 38, 24, 1, 4, 10, 20, 30, 40]
    @test vec(eq_deconvolve(eq_vec(1, 3, 3, 1, 0, 0), eq_vec(1, 1))) ≈ [1.0, 2, 1, 0, 0] atol = 1e-12
    @test vec(eq_deconvolve(eq_vec(1, 3, 3, 1), eq_vec(0, 0))) == [0.0, 0, 0]
end

@testset "convolve, crosscorr and deconvolve: errors" begin
    signal, kernel = eq_vec(1, 2, 3), eq_vec(1, 1)
    matrix = eq_matrix(2, 2, 1, 2, 3, 4)
    @test_throws EqError eq_convolve(1.0, kernel)
    @test_throws EqError eq_convolve(eq_vec(), kernel)
    @test_throws EqError eq_convolve(eq_vec(1.0u"m", 2.0u"m"), kernel)
    @test_throws EqError eq_convolve(signal, kernel, 4.0)
    @test_throws EqError eq_convolve(signal, kernel, 1.5)
    @test_throws EqError eq_convolve(signal, kernel, -1.0)
    @test_throws EqError eq_convolve(signal, kernel, 0.0, 0.0)
    @test_throws EqError eq_convolve(signal, kernel, 0.0, 3.0)
    @test_throws EqError eq_convolve(signal, kernel, 0.0, 1.5)
    @test_throws EqError eq_convolve(signal, kernel, 0.0, eq_vec(1, 1))
    @test_throws EqError eq_crosscorr(signal, kernel, 0.0, 3.0)
    @test_throws EqError eq_convolve(matrix, matrix, 0.0, eq_vec(3, 3))
    @test_throws EqError eq_convolve(matrix, matrix, 0.0, eq_vec(0, 1))
    @test_throws EqError eq_convolve(matrix, matrix, 0.0, eq_rowvec(1, 2, 3))
    @test_throws EqError eq_deconvolve(eq_vec(1, 2), eq_vec(1, 2, 3))
    @test_throws EqError eq_deconvolve(matrix, eq_vec(1, 2))
end
