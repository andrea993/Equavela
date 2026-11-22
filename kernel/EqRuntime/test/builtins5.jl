# Built-in functions (batch 7): factorizations, singular values, generalized
# eigenvalues, polynomials, interpolation, generators, covariance statistics.

@testset "cholesky, worksheet case, LU, QR" begin
    A = eq_matrix(3, 3, 4, 12, -16, 12, 37, -43, -16, -43, 98)
    L = eq_cholesky(A)
    @test L ≈ [2.0 0 0; 6 1 0; -8 5 3]
    @test L * L' ≈ A
    @test_throws EqError eq_cholesky(eq_matrix(2, 2, 1, 2, 2, 1))
    @test_throws EqError eq_cholesky(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6))
    @test_throws EqError eq_cholesky(5.0)

    result = eq_Cholesky(A)
    P, Lp = result[1], result[2]
    @test size(result) == (2, 1)
    @test P * A * P' ≈ Lp * Lp'
    unpivoted = eq_Cholesky(A, 0.0)
    @test unpivoted[1] == Matrix(I, 3, 3)
    @test unpivoted[2] ≈ L
    @test eq_Cholesky(A, 0.0, 1.0)[2] ≈ L'
    @test_throws EqError eq_Cholesky(eq_matrix(2, 2, 1, 2, 2, 1))

    M = eq_matrix(3, 3, 1, 2, 3, 4, 5, 6, 7, 8, 10)
    lu_result = eq_LU(M)
    @test size(lu_result) == (3, 1)
    @test lu_result[1] * M ≈ lu_result[2] * lu_result[3]
    @test istril(lu_result[2]) && istriu(lu_result[3])
    W = eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)
    wide = eq_LU(W)
    @test wide[1] * W ≈ wide[2] * wide[3]

    qr_result = eq_QR(M, 0.0)
    @test size(qr_result) == (2, 1)
    @test qr_result[1] * qr_result[2] ≈ M
    @test qr_result[1]' * qr_result[1] ≈ I(3) atol = 1e-12
    pivoted = eq_QR(M)
    @test size(pivoted) == (3, 1)
    @test M * pivoted[1] ≈ pivoted[2] * pivoted[3]
    norms = [abs(pivoted[3][1, 1]), abs(pivoted[3][2, 2])]
    @test norms[1] >= norms[2]
    @test eq_QR(eq_matrix(4, 2, 1, 2, 3, 4, 5, 6, 7, 9), 0.0)[2][1:2, :] |> istriu
end

@testset "svds, svd, genvals, genvecs, eigenvec" begin
    A = eq_matrix(3, 2, 3, 0, 0, 4, 0, 0)
    @test eq_svds(A) ≈ eq_vec(4, 3)
    @test eq_svds(eq_matrix(1, 1, -5)) ≈ eq_vec(5)
    B = eq_matrix(4, 3, 1, 2, 1, 5, 4, 3, 6, 7, 8, 7, 8, 9)
    decomposition = eq_svd(B)
    s, U, VH = decomposition[1], decomposition[2], decomposition[3]
    @test size(decomposition) == (3, 1)
    @test U * diagm(vec(s)) * VH ≈ B
    @test issorted(vec(s); rev=true)
    @test eq_svds(B) ≈ s
    @test_throws EqError eq_svds(5.0)
    @test_throws EqError eq_svd(eq_stack(1.0u"m", 2.0u"m"))

    M = eq_matrix(2, 2, 2, 0, 0, 1)
    N = eq_matrix(2, 2, 1, 0, 0, 2)
    @test eq_genvals(M, N) ≈ eq_vec(0.5, 2)                 # Julia's order
    vectors = eq_genvecs(M, N)
    @test M * vectors ≈ N * vectors * diagm([0.5, 2.0])
    @test all(norm(vectors[:, k]) ≈ 1 for k in 1:2)
    @test_throws EqError eq_genvals(M, eq_identity(3.0))
    @test size(eq_genvecs(M, N, "L")) == size(M)

    S = eq_matrix(2, 2, 2, 1, 1, 2)
    v = eq_eigenvec(S, 3.0)
    @test abs(v[1]) ≈ 1 / sqrt(2) && abs(v[2]) ≈ 1 / sqrt(2) && v[1] * v[2] > 0
    w = eq_eigenvec(S, 1.0)
    @test w[1] * w[2] < 0
    @test eq_eigenvec(eq_matrix(2, 2, 0, -1, 1, 0), 1.0im) isa Matrix{ComplexF64}
end

@testset "kronecker, rref, vec, logspace, logpts" begin
    @test eq_kronecker(eq_matrix(1, 2, 1, 2), eq_matrix(2, 1, 1, 10)) == [1.0 2.0; 10.0 20.0]
    @test eq_kronecker(eq_identity(2.0), eq_matrix(1, 2, 1, 2)) ==
          [1.0 2.0 0.0 0.0; 0.0 0.0 1.0 2.0]
    @test eq_rref(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)) ≈ [1.0 0 -1; 0 1 2]
    @test eq_rref(eq_matrix(2, 2, 1, 2, 2, 4)) ≈ [1.0 2.0; 0 0]
    @test eq_rref(eq_identity(3.0)) == Matrix(I, 3, 3)
    @test_throws EqError eq_rref(2.0)

    @test eq_vecrange(1.0, 4.0) == eq_vec(1, 2, 3, 4)
    @test eq_vecrange(0.0, 0.5, 2.0) == eq_vec(0, 0.5, 1, 1.5, 2)
    @test eq_vecrange(5.0, 3.0) == eq_vec(5, 4, 3)
    @test eq_vecrange(eq_range(1.0, 3.0)) == eq_vec(1, 2, 3)

    @test eq_logspace(1.0, 100.0, 3.0) ≈ eq_vec(1, 10, 100)
    @test eq_logspace(2.0, 2.0, 1.0) == eq_vec(2)
    @test eq_logspace(1.0u"m", 100.0u"m", 3.0) ≈ eq_stack(1.0u"m", 10.0u"m", 100.0u"m")
    @test_throws EqError eq_logspace(0.0, 10.0, 3.0)
    @test_throws EqError eq_logspace(1.0, 10.0, 0.0)
    @test_throws EqError eq_logspace(1.0u"m", 10.0, 3.0)
    @test eq_logpts(0.0, 2.0, 2.0) ≈ eq_vec(1, sqrt(10), 10, 10 * sqrt(10))
    @test_throws EqError eq_logpts(0.0, 1.0, 0.0)
end

@testset "polyroots, polycoeff" begin
    roots = eq_polyroots(eq_vec(-6, 11, -6, 1))
    @test sort(real.(vec(roots))) ≈ [1.0, 2.0, 3.0]
    @test roots isa Matrix{Float64}
    complex_roots = eq_polyroots(eq_vec(1, 0, 1))        # x^2 + 1
    @test sort(imag.(vec(complex_roots))) ≈ [-1.0, 1.0]
    @test eq_polyroots(eq_vec(-4, 2)) ≈ eq_vec(2)
    @test eq_polyroots(eq_vec(2, 0, 1im)) isa Matrix{ComplexF64}
    @test_throws EqError eq_polyroots(eq_vec(1))
    @test_throws EqError eq_polyroots(eq_vec(1, 0))
    @test_throws EqError eq_polyroots(eq_matrix(2, 2, 1, 2, 3, 4))
    @test_throws EqError eq_polyroots(eq_stack(1.0u"m", 2.0u"m"))
    @test eq_polycoeff(eq_vec(0, 1, 2), eq_vec(1, 2, 5)) ≈ eq_vec(1, 0, 1)
    @test_throws EqError eq_polycoeff(eq_vec(1, 1), eq_vec(1, 2))
    @test_throws EqError eq_polycoeff(eq_vec(1, 2), eq_vec(1))
end

@testset "linterp and splines" begin
    x = eq_vec(0, 1, 3)
    y = eq_vec(0, 2, 6)
    @test eq_linterp(x, y, 0.5) ≈ 1.0
    @test eq_linterp(x, y, 2.0) ≈ 4.0
    @test eq_linterp(x, y, eq_vec(0.5, 2)) ≈ eq_vec(1, 4)
    @test eq_linterp(x, y, 4.0) ≈ 8.0                       # linear extrapolation
    @test eq_linterp(x, y, -1.0) ≈ -2.0
    @test eq_linterp(eq_vec(3, 0, 1), eq_vec(6, 0, 2), 2.0) ≈ 4.0   # sorted by x
    @test eq_linterp(x, eq_stack(0.0u"m", 2.0u"m", 6.0u"m"), 2.0) ≈ 4.0u"m"
    @test eq_linterp(eq_stack(0.0u"s", 1.0u"s", 3.0u"s"), y, 0.5u"s") ≈ 1.0
    @test_throws EqError eq_linterp(eq_vec(1, 1), eq_vec(1, 2), 1.0)
    @test_throws EqError eq_linterp(eq_vec(1), eq_vec(1), 1.0)
    @test_throws EqError eq_linterp(x, eq_vec(1, 2), 1.0)

    xs = eq_vec(0, 1, 2, 3, 4)
    ys = map(v -> v^3 - 2v, xs)
    for builder in (eq_cspline, eq_lspline, eq_pspline)
        spline = builder(xs, ys)
        @test eq_interp(spline, xs, ys, xs) ≈ ys atol = 1e-12     # passes through the knots
        @test eq_interp(spline, xs, ys, 1.5) isa Float64
    end
    # a cubic spline with cubic ends reproduces a cubic exactly
    spline = eq_cspline(xs, ys)
    @test eq_interp(spline, xs, ys, 2.5) ≈ 2.5^3 - 5 atol = 1e-10
    @test eq_interp(spline, xs, ys, 5.0) ≈ 125 - 10 atol = 1e-8   # extrapolates
    # linear ends: zero second derivative at both ends
    line = eq_lspline(eq_vec(0, 1, 2), eq_vec(0, 1, 2))
    @test eq_interp(line, eq_vec(0, 1, 2), eq_vec(0, 1, 2), 1.5) ≈ 1.5
    @test eq_interp(eq_lspline(eq_vec(0, 2), eq_vec(1, 5)), eq_vec(0, 2), eq_vec(1, 5), 1.0) ≈ 3.0
    @test_throws EqError eq_cspline(eq_vec(0, 1), eq_vec(0, 1))
    @test_throws EqError eq_interp(eq_vec(1, 2, 3, 4), xs, ys, 1.0)
    @test_throws EqError eq_interp(spline, eq_vec(0, 1, 2), eq_vec(0, 1, 2), 1.0)   # not the data of the spline
    # the reference application's layout: [0; 3; end condition; second derivatives] (saved results, 3 to 5 points).
    @test vec(eq_cspline(eq_vec(0, 1, 2), eq_vec(2, 1, 4))) == [0.0, 3, 2, 8, 4, 0]
    @test vec(eq_lspline(eq_vec(0, 1, 2), eq_vec(2, 1, 4))) == [0.0, 3, 0, 0, 6, 0]
    @test vec(eq_pspline(eq_vec(0, 1, 2), eq_vec(2, 1, 4))) ≈ [0.0, 3, 1, 4, 4, 4]
    @test vec(eq_cspline(eq_vec(0, 1, 2, 3), eq_vec(2, 1, 4, 3))) ≈ [0.0, 3, 2, 12, 4, -4, -12]
    @test vec(eq_pspline(eq_vec(0, 1, 2, 3, 4), eq_vec(2, 1, 4, 3, 6))) ≈ [0.0, 3, 1, 6.66667, 6.66667, -9.33333, 6.66667, 6.66667] atol = 1e-5
    @test vec(eq_cspline(eq_vec(0, 0.5, 1.5, 2, 3.5), eq_vec(1, 2, 0, 3, 1)))[4:end] ≈ [-24.6933, -10.1733, 18.8667, 3.14667, -44.0133] atol = 1e-4
    @test_throws EqError eq_cspline(eq_stack(0.0u"m", 1.0u"m", 2.0u"m"), eq_vec(1, 2, 3))
end

@testset "cvar, covar, corr, skew, kurt" begin
    x = eq_vec(1, 2, 3, 4, 5)
    y = eq_vec(2, 4, 6, 8, 10)
    @test eq_cvar(x, y) ≈ 4.0
    @test eq_covar(x, y) ≈ 4.0
    @test eq_cvar(x, x) ≈ eq_var(x)
    @test eq_corr(x, y) ≈ 1.0
    @test eq_corr(x, eq_vec(5, 4, 3, 2, 1)) ≈ -1.0
    @test eq_cvar(eq_matrix(2, 2, 1, 2, 3, 4), eq_matrix(2, 2, 4, 3, 2, 1)) ≈ -1.25
    @test_throws EqError eq_cvar(x, eq_vec(1, 2))
    @test_throws EqError eq_corr(x, eq_vec(1, 1, 1, 1, 1))
    @test_throws EqError eq_cvar(eq_stack(1.0u"m", 2.0u"m"), eq_vec(1, 2))
    @test eq_skew(eq_vec(1, 2, 3, 4, 5)) ≈ 0.0 atol = 1e-12
    @test eq_skew(eq_vec(1, 2, 10)) ≈ 1.6523167403329904
    @test eq_kurt(eq_vec(1, 2, 3, 4, 5)) ≈ -1.2
    @test_throws EqError eq_skew(eq_vec(1, 2))
    @test_throws EqError eq_kurt(eq_vec(1, 2, 3))
    @test_throws EqError eq_skew(eq_vec(2, 2, 2))
end

@testset "matrix(m, n, f)" begin
    # Element (i, j) = f(i, j), indices from 0.
    M = eq_matrix_fn(2.0, 3.0, (i, j) -> 10 * i + j)
    @test M == [0.0 1.0 2.0; 10.0 11.0 12.0]
    @test size(eq_matrix_fn(0.0, 3.0, (i, j) -> i)) == (0, 3)
    Q = eq_matrix_fn(1.0, 2.0, (i, j) -> (j + 1) * 1.0u"m")
    @test Q[1, 2] == 2.0u"m"
    @test_throws EqError eq_matrix_fn(2.5, 2.0, (i, j) -> 0.0)
    @test_throws EqError eq_matrix_fn(-1.0, 2.0, (i, j) -> 0.0)
    @test_throws EqError eq_matrix_fn(2.0, 2.0, 5.0)
    @test_throws EqError eq_matrix_fn(2.0, 2.0, (i, j) -> eq_vec(1, 2))
end
