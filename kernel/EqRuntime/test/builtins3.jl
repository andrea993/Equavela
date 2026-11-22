# Built-in functions (batch 5): match modifiers, lookup family, Rank/order,
# norms, condition numbers, qr, geninv, lsolve, statistics, number theory.

@testset "match modifiers" begin
    v = eq_vec(1, 5, 3, 5, 9)
    @test eq_match(5.0, v, "eq") == eq_vec(1, 3)
    @test eq_match(5.0, v, "not") == eq_vec(0, 2, 4)
    @test eq_match(4.0, v, "gt") == eq_vec(1, 3, 4)
    @test eq_match(5.0, v, "geq") == eq_vec(1, 3, 4)
    @test eq_match(3.0, v, "lt") == eq_vec(0)
    @test eq_match(3.0, v, "leq") == eq_vec(0, 2)
    @test eq_match(4.2, v, "near") == eq_vec(1, 3)
    @test eq_match(8.0, v, "near") == eq_vec(4)
    @test eq_match(4.0, eq_vec(1, 3, 5, 7), "range") == eq_vec(1)
    @test eq_match(7.0, eq_vec(1, 3, 5, 7), "range") == eq_vec(3)
    @test_throws EqError eq_match(0.0, eq_vec(1, 3, 5, 7), "range")
    @test_throws EqError eq_match(9.0, eq_vec(1, 3, 5, 7), "range")
    @test_throws EqError eq_match(1.0, eq_vec(3, 1), "range")
    @test_throws EqError eq_match(100.0, v, "gt")
    @test_throws EqError eq_match(1.0, v, "bogus")
    @test_throws EqError eq_match(1.0, v, 3.0)
    @test_throws EqError eq_match(1.0, v, "eq", "eq")
    # a user function f(element, z) selects elements
    @test eq_match(2.0, v, (element, z) -> eq_gt(element, z)) == eq_vec(1, 2, 3, 4)
    with_origin(1) do
        @test eq_match(5.0, v, "eq") == eq_vec(2, 4)
    end
    lengths = eq_stack(1.0u"m", 250.0u"cm", 3.0u"m")
    @test eq_match(2.0u"m", lengths, "gt") == eq_vec(1, 2)
    @test eq_match(2.4u"m", lengths, "near") == eq_vec(1)
    M = eq_matrix(2, 2, 1, 2, 3, 4)
    @test eq_match(2.0, M, "geq")[1] == eq_vec(1, 0)
    @test length(eq_match(2.0, M, "geq")) == 3
end

@testset "lookup, vlookup, hlookup, vhlookup" begin
    a = eq_vec(1, 0, 1, 0)
    b = eq_vec(10, 20, 30, 40)
    @test eq_lookup(1.0, a, b) == eq_vec(10, 30)
    @test eq_lookup(1.0, a, b, "eq") == eq_vec(10, 30)
    @test eq_lookup(0.5, a, b, "gt") == eq_vec(10, 30)
    @test eq_lookup(2.5, eq_vec(1, 2, 3, 4), b, "near") == eq_vec(20, 30)
    @test eq_lookup(2.5, eq_vec(1, 2, 3, 4), b, "range") == eq_vec(20)
    @test_throws EqError eq_lookup(7.0, eq_vec(1, 2, 3, 4), b)
    @test_throws EqError eq_lookup(1.0, a, eq_vec(1, 2))
    @test_throws EqError eq_lookup(1.0, 1.0, 2.0)
    # a single hit is still a column vector (like match)
    @test eq_lookup(0.0, eq_vec(0, 1), eq_vec(7, 8)) == eq_vec(7)
    @test eq_lookup("b", eq_stack("a", "b"), eq_stack("x", "y")) == eq_stack("y")
    A = eq_matrix(2, 2, 1, 2, 2, 1)
    B = eq_matrix(2, 2, 10, 20, 30, 40)
    @test eq_lookup(2.0, A, B) == eq_vec(30, 20)
    @test eq_lookup(2.0, eq_vec(1, 2, 3), eq_vec(7, 8, 9), (x, z) -> eq_gt(x, z)) == eq_vec(9)

    T = eq_matrix(3, 3, 1, 10, 100, 2, 20, 200, 2, 30, 300)
    @test eq_vlookup(2.0, T, 1.0) == eq_vec(20, 30)
    @test eq_vlookup(1.0, T, 2.0) == eq_vec(100)
    @test_throws EqError eq_vlookup(5.0, T, 1.0)
    @test_throws EqError eq_vlookup(1.0, T, 3.0)
    with_origin(1) do
        @test eq_vlookup(2.0, T, 2.0) == eq_vec(20, 30)
    end
    @test eq_hlookup(2.0, eq_matrix(2, 3, 1, 2, 2, 5, 6, 7), 1.0) == eq_vec(6, 7)
    @test_throws EqError eq_hlookup(2.0, eq_matrix(2, 3, 1, 2, 2, 5, 6, 7), 2.0)
    H = eq_matrix(3, 3, 0, 1, 2, 10, 11, 12, 20, 21, 22)
    @test eq_vhlookup(20.0, 2.0, H) == 22.0
    @test eq_vhlookup(10.0, 1.0, H) == 11.0
    @test_throws EqError eq_vhlookup(30.0, 1.0, H)
    S = eq_matrix(2, 2, "gain", 3.0, "pole", 4.0)
    @test eq_vlookup("pole", S, 1.0)[1] == 4.0
end

@testset "Rank and order" begin
    v = eq_vec(30, 10, 20, 10)
    @test eq_Rank(v) == eq_vec(4, 1.5, 3, 1.5)
    @test eq_Rank(eq_rowvec(3, 1, 2)) == eq_rowvec(3, 1, 2)
    @test eq_order(v) == eq_vec(1, 3, 2, 0)
    with_origin(1) do
        @test eq_order(v) == eq_vec(2, 4, 3, 1)
    end
    @test eq_order(eq_rowvec(3, 1, 2)) == eq_rowvec(1, 2, 0)
    @test eq_Rank(eq_stack(1.0u"m", 50.0u"cm")) == eq_vec(2, 1)
    @test_throws EqError eq_Rank(eq_matrix(2, 2, 1, 2, 3, 4))
    @test_throws EqError eq_order(eq_vec(1.0im, 2))
    @test_throws EqError eq_order(5.0)
end

@testset "matrix norms and condition numbers" begin
    M = eq_matrix(2, 2, 1, -2, 3, 4)
    @test eq_norm1(M) == 6.0
    @test eq_normi(M) == 7.0
    @test eq_norme(M) ≈ sqrt(30)
    @test eq_norm2(M) ≈ opnorm([1.0 -2.0; 3.0 4.0])
    @test eq_norm2(eq_matrix(2, 2, 3, 0, 0, 4)) ≈ 4.0
    @test eq_norm1(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)) == 9.0
    @test eq_norme(eq_vec(3, 4)) ≈ 5.0
    @test eq_norm1(eq_matrix(2, 2, 1.0im, 1, 0, 1)) ≈ 2.0
    @test_throws EqError eq_norm1(5.0)
    @test_throws EqError eq_norm2(eq_stack(1.0u"m", 2.0u"m"))
    @test_throws EqError eq_norme(Matrix{Float64}(undef, 0, 0))

    D = eq_matrix(2, 2, 2, 0, 0, 4)
    @test eq_cond1(D) ≈ 2.0
    @test eq_cond2(D) ≈ 2.0
    @test eq_conde(D) ≈ sqrt(20) * sqrt(0.25 + 0.0625)
    @test eq_condi(D) ≈ 2.0
    @test eq_cond1(eq_identity(3.0)) == 1.0
    @test eq_cond2(eq_matrix(2, 2, 1, 2, 2, 4)) == Inf
    @test eq_cond1(eq_matrix(2, 2, 1, 2, 2, 4)) == Inf
    @test eq_cond2(M) ≈ cond([1.0 -2.0; 3.0 4.0])
    @test_throws EqError eq_cond1(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6))
end

@testset "qr (Julia's Householder QR)" begin

    A = eq_matrix(4, 3, 1, 2, 1, 5, 4, 3, 6, 7, 8, 7, 8, 9)
    result = eq_qr(A)
    @test size(result) == (4, 7)
    Q, R = result[:, 1:4], result[:, 5:7]
    @test Q' * Q ≈ I(4) atol = 1e-12
    @test Q * R ≈ A
    @test all(abs(R[i, j]) < 1e-12 for j in 1:3 for i in (j+1):4)
    Z = eq_matrix(3, 2, 1, 2im, 3, 1 + 1im, 0, 5)
    zr = eq_qr(Z)
    Qz, Rz = zr[:, 1:3], zr[:, 4:5]
    @test Qz' * Qz ≈ I(3) atol = 1e-12
    @test Qz * Rz ≈ Z
    W = eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)
    wr = eq_qr(W)
    @test wr[:, 1:2] * wr[:, 3:5] ≈ W
    @test abs.(eq_qr(eq_matrix(1, 1, 5))) == [1.0 5.0]
    @test_throws EqError eq_qr(5.0)
end

@testset "geninv and lsolve" begin
    A = eq_matrix(3, 2, 1, 0, 0, 1, 1, 1)
    G = eq_geninv(A)
    @test size(G) == (2, 3)
    @test G * A ≈ I(2) atol = 1e-12
    @test eq_geninv(eq_matrix(2, 2, 1, 2, 3, 4)) ≈ inv([1.0 2.0; 3.0 4.0])
    @test_throws EqError eq_geninv("x")

    M = eq_matrix(2, 2, 2, 1, 1, 3)
    @test eq_lsolve(M, eq_vec(3, 5)) ≈ [0.8, 1.4]
    @test eq_lsolve(M, eq_matrix(2, 2, 3, 2, 5, 1)) ≈ M \ [3.0 2.0; 5.0 1.0]
    @test eq_lsolve(A, eq_vec(1, 2, 3)) ≈ pinv([1.0 0.0; 0.0 1.0; 1.0 1.0]) * [1.0, 2.0, 3.0]
    @test_throws EqError eq_lsolve(eq_matrix(2, 2, 1, 2, 2, 4), eq_vec(1, 2))
    @test_throws EqError eq_lsolve(M, eq_vec(1, 2, 3))
    @test_throws EqError eq_lsolve(M, 3.0)
end

@testset "gmean, hmean, mode, percentile" begin
    @test eq_gmean(2.0, 8.0) ≈ 4.0
    @test eq_gmean(eq_vec(1, 3, 9)) ≈ 3.0
    @test eq_gmean(eq_vec(1e200, 1e200)) ≈ 1e200
    @test_throws EqError eq_gmean(eq_vec(1, -3))
    @test_throws EqError eq_gmean(0.0, 1.0)
    @test eq_hmean(1.0, 4.0, 4.0) ≈ 2.0
    @test eq_hmean(eq_vec(2, 2)) ≈ 2.0
    @test eq_hmean(1.0u"m", 4.0u"m", 4.0u"m") ≈ 2.0u"m"
    @test_throws EqError eq_hmean(1.0u"m", 4.0u"s")
    @test_throws EqError eq_hmean(0.0)

    @test eq_mode(eq_vec(1, 2, 2, 3, 3, 3, 4)) == 3.0
    @test eq_mode(eq_vec(1, 2, 2, 3, 3)) == 2.0
    @test eq_mode(eq_vec(5, 4)) == 4.0
    @test eq_mode(eq_vec(1, 1), eq_vec(2, 2, 2)) == 2.0
    @test eq_mode(eq_stack(1.0u"m", 100.0u"cm", 3.0u"m")) == 1.0u"m"
    @test_throws EqError eq_mode(eq_vec(1.0im, 2))

    v = eq_vec(1, 2, 3, 4, 5)
    @test eq_percentile(v, 0.5) ≈ 3.0
    @test eq_percentile(v, 0.0) == 1.0
    @test eq_percentile(v, 1.0) == 5.0
    @test eq_percentile(v, 0.25) ≈ 2.0
    @test eq_percentile(eq_vec(1, 2, 3, 4), 0.5) ≈ 2.5
    @test eq_percentile(eq_vec(10, 20), 0.1) ≈ 11.0
    @test_throws EqError eq_percentile(v, 1.5)
    @test_throws EqError eq_percentile(v, -0.1)
    @test_throws EqError eq_percentile(v, 0.5u"m")
end

@testset "permut, gcd, lcm" begin
    @test eq_permut(5.0, 2.0) == 20.0
    @test eq_permut(5.0, 0.0) == 1.0
    @test eq_permut(5.0, 5.0) == 120.0
    @test_throws EqError eq_permut(2.0, 3.0)
    @test_throws EqError eq_permut(2.5, 1.0)
    @test_throws EqError eq_permut(5.0, -1.0)
    @test eq_gcd(12.0, 18.0) == 6.0
    @test eq_gcd(12.0, 18.0, 8.0) == 2.0
    @test eq_gcd(eq_vec(12, 18, 30)) == 6.0
    @test eq_gcd(-12.0, 18.0) == 6.0
    @test eq_gcd(0.0, 5.0) == 5.0
    @test eq_gcd(7.0) == 7.0
    @test eq_lcm(4.0, 6.0) == 12.0
    @test eq_lcm(eq_vec(2, 3, 4)) == 12.0
    @test eq_lcm(0.0, 5.0) == 0.0
    @test eq_lcm(-4.0, 6.0) == 12.0
    @test_throws EqError eq_gcd(1.5, 3.0)
    @test_throws EqError eq_gcd(2.0u"m", 4.0u"m")
    @test_throws EqError eq_lcm("a", 2.0)
end
