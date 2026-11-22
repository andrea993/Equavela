# Built-in functions (batch 2). Sources: the specification, compatibility .

@testset "array dimensions" begin
    M = eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)
    @test eq_rows(M) === 2.0
    @test eq_cols(M) === 3.0
    @test eq_rows(5.0) === 0.0          # neither vector nor matrix
    @test eq_cols("text") === 0.0
    @test eq_length(eq_vec(1, 2, 3)) === 3.0
    @test eq_length(eq_matrix(1, 1, 7)) === 1.0
    @test_throws EqError eq_length(M)
    @test_throws EqError eq_length(2.0)
    @test eq_last(eq_vec(1, 2, 3)) === 2.0              # ORIGIN = 0
    with_origin(1) do
        @test eq_last(eq_vec(1, 2, 3)) === 3.0
    end
    with_origin(-2) do
        @test eq_last(eq_vec(1, 2, 3)) === 0.0
    end
    @test_throws EqError eq_last(M)
end

@testset "stack and augment" begin
    @test eq_stack(eq_vec(1, 2), 3.0) == eq_vec(1, 2, 3)
    @test eq_stack(1.0, 2.0) == eq_vec(1, 2)
    A = eq_matrix(1, 2, 1, 2)
    B = eq_matrix(2, 2, 3, 4, 5, 6)
    @test eq_stack(A, B) == [1.0 2.0; 3.0 4.0; 5.0 6.0]
    @test eq_stack(A, B) isa Matrix{Float64}
    @test_throws EqError eq_stack(A, eq_vec(1, 2, 3))
    @test eq_augment(1.0, eq_rowvec(2, 3)) == [1.0 2.0 3.0]
    @test eq_augment(B, eq_vec(7, 8)) == [3.0 4.0 7.0; 5.0 6.0 8.0]
    @test_throws EqError eq_augment(B, eq_vec(1, 2, 3))
    # mixed element types promote or fall back to Any
    @test eq_stack(1.0, 2.0im) == eq_vec(1, 2im)
    mixed = eq_stack(1.0, 2.0u"m")
    @test mixed[2] == 2.0u"m" && eltype(mixed) === Any
    @test_throws EqError eq_stack()
    @test_throws EqError eq_augment("a", eq_vec(1, 2))
end

@testset "submatrix" begin
    M = eq_matrix(3, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9)
    @test eq_submatrix(M, 0, 1, 1, 2) == [2.0 3.0; 5.0 6.0]
    @test size(eq_submatrix(M, 1, 1, 1, 1)) == (1, 1)     # stays an array
    @test eq_submatrix(M, 0, 2, 0, 0) == eq_vec(1, 4, 7)
    @test eq_submatrix(M, 1, 0, 0, 1) == [4.0 5.0; 1.0 2.0] # reversed bounds
    @test_throws EqError eq_submatrix(M, 0, 3, 0, 0)
    @test_throws EqError eq_submatrix(M, -1, 0, 0, 0)
    @test_throws EqError eq_submatrix(2.0, 0, 0, 0, 0)
    with_origin(1) do
        @test eq_submatrix(M, 1, 2, 2, 3) == [2.0 3.0; 5.0 6.0]
        @test_throws EqError eq_submatrix(M, 0, 1, 1, 1)
    end
end

@testset "vsum" begin
    @test eq_vsum(eq_vec(1, 2, 3)) === 6.0
    @test eq_vsum(eq_matrix(1, 1, 7)) === 7.0
    @test eq_vsum(eq_rowvec(1, 2, 3)) === 6.0              # a row vector sums too
    @test eq_vsum(eq_matrix(2, 2, 1, 2, 3, 4)) === 10.0    # every element, not the diagonal
    @test eq_vsum(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)) === 21.0
    @test eq_vsum(eq_vec(1.0im, 2)) == 2.0 + 1.0im
    @test eq_vsum(eq_vec(3.5u"m", 1.5u"m")) == 5.0u"m"     # the unit rides through
    @test eq_vsum(reshape(Any[], 0, 0)) === 0.0            # the identity of +
    # No index is computed, so ORIGIN cannot change the result.
    with_origin(1) do
        @test eq_vsum(eq_vec(1, 2, 3)) === 6.0
    end
    with_origin(-3) do
        @test eq_vsum(eq_matrix(2, 2, 1, 2, 3, 4)) === 10.0
    end
    # A scalar is not an array; a unit mismatch is the ordinary error.
    @test_throws EqError eq_vsum(3.0)
    @test_throws EqError eq_vsum("text")
    @test_throws EqError eq_vsum(eq_vec(1.0u"m", 1.0u"s"))
    @test_throws EqError eq_vsum(eq_matrix(2, 2, 1, 2, 3, 4.0u"m"))
end

@testset "tr, rank, eigenvalues" begin
    @test eq_tr(eq_matrix(2, 2, 1, 2, 3, 4)) === 5.0
    @test eq_tr(eq_matrix(2, 2, 1.0, 2, 3, 4.0im)) == 1.0 + 4.0im
    @test_throws EqError eq_tr(eq_matrix(1, 2, 1, 2))
    @test eq_rank(eq_matrix(3, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9)) === 2.0
    @test eq_rank(eq_identity(4)) === 4.0
    @test eq_rank(eq_matrix(2, 3, 0, 0, 0, 0, 0, 0)) === 0.0
    @test_throws EqError eq_rank(3.0)

    V = eq_matrix(3, 3, -1, 2, 0, 2, -1, 0, 0, 0, 1)
    @test eq_eigenvals(V) ≈ eq_vec(-3, 1, 1)               # Julia: symmetric ascending
    A = eq_matrix(2, 2, 0, 1, -1, 0)
    @test eq_eigenvals(A) ≈ eq_vec(-1im, 1im)               # Julia: by real, then imaginary part
    @test eq_eigenvals(eq_matrix(2, 2, 1, 2, 3, 4)) ≈ eq_vec(-0.3722813232690143, 5.372281323269014)
    # eigenvecs follow that order; genvecs are unit columns
    @test eq_eigenvecs(eq_matrix(2, 2, 2, 1, 1, 2))[:, 2] ≈ [0.7071067811865475, 0.7071067811865475] ||
          eq_eigenvecs(eq_matrix(2, 2, 2, 1, 1, 2))[:, 2] ≈ -[0.7071067811865475, 0.7071067811865475]
    @test all(norm(c) ≈ 1 for c in eachcol(eq_genvecs(eq_matrix(2, 2, 2, 1, 1, 2), eq_matrix(2, 2, 1, 0, 0, 2))))
    @test eq_eigenvals(eq_matrix(1, 1, 4)) ≈ eq_vec(4)
    @test_throws EqError eq_eigenvals(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6))
    @test_throws EqError eq_eigenvals(2.0)
end

@testset "eigenvectors" begin
    for A in (eq_matrix(2, 2, 2, 1, 1, 2),
        eq_matrix(2, 2, -0.5, -0.05, 0.08, -0.2),
        eq_matrix(3, 3, -1, 2, 0, 2, -1, 0, 0, 0, 1))
        values = eq_eigenvals(A)
        vectors = eq_eigenvecs(A)
        @test size(vectors) == size(A)
        for column in 1:size(A, 1)
            v = vectors[:, column]
            @test A * v ≈ values[column] * v
            @test norm(v) ≈ 1
        end
    end
    # left eigenvectors: u^H A = lambda u^H
    A = eq_matrix(2, 2, 1, 2, 3, 4)
    values = eq_eigenvals(A)
    left = eq_eigenvecs(A, "L")
    for column in 1:2
        u = left[:, column]
        @test u' * A ≈ values[column] * u'
        @test norm(u) ≈ 1
    end
    @test_throws EqError eq_eigenvecs(A, "X")
    @test_throws EqError eq_eigenvecs(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6))
end

@testset "match" begin
    v = eq_vec(4, 5, 5, 7)
    @test eq_match(5.0, v) == eq_vec(1, 2)
    @test eq_match(7.0, v) == eq_vec(3)
    @test_throws EqError eq_match(9.0, v)                  # not found is an error
    with_origin(1) do
        @test eq_match(5.0, v) == eq_vec(2, 3)
    end
    M = eq_matrix(2, 3, 1, 2, 3, 4, 2, 6)
    found = eq_match(2.0, M)
    @test size(found) == (2, 1)
    @test found[1] == eq_vec(0, 1) && found[2] == eq_vec(1, 1)   # column-wise scan
    with_origin(1) do
        @test eq_match(6.0, M)[1] == eq_vec(2, 3)
    end
    # strings match strings only; no type error for mixed arrays
    S = eq_vec("a", 1.0, "b")
    @test eq_match("b", S) == eq_vec(2)
    @test eq_match(1.0, S) == eq_vec(1)
    @test eq_match(2.0u"m", eq_vec(1.0u"m", 200.0u"cm")) == eq_vec(1)
    @test_throws EqError eq_match(1.0, 2.0)
end

@testset "min and max" begin
    @test eq_max(1.0, 3.0, 2.0) === 3.0
    @test eq_min(1.0, 3.0, 2.0) === 1.0
    @test eq_max(eq_matrix(2, 2, 1, 9, 3, 4)) === 9.0
    @test eq_min(eq_matrix(2, 2, 1, 9, 3, 4), -2.0) === -2.0
    @test eq_max(eq_vec(1, 2), eq_vec(5, 0)) === 5.0
    @test eq_max(1.0 + 5.0im, 3.0 + 2.0im) == 3.0 + 5.0im  # largest re + i largest im
    @test eq_min(1.0 + 5.0im, 3.0 + 2.0im) == 1.0 + 2.0im
    @test eq_max(2.0) === 2.0
    @test eq_max("apple", "pear") == "pear"
    @test eq_min(eq_vec("b", "a")) == "a"
    @test eq_max(1.0u"m", 50.0u"cm") == 1.0u"m"
    @test eq_min(1.0u"m", 50.0u"cm") == 50.0u"cm"
    @test_throws EqError eq_max(1.0u"m", 1.0u"s")
    @test_throws EqError eq_max("a", 1.0)
    @test_throws EqError eq_max()
    @test_throws EqError eq_max(Matrix{Float64}(undef, 0, 0))
end

@testset "rounding functions" begin
    @test eq_floor(2.7) === 2.0
    @test eq_floor(-2.1) === -3.0
    @test eq_ceil(2.1) === 3.0
    @test eq_ceil(-2.7) === -2.0
    @test eq_round(2.5) === 3.0                            # halves away from zero
    @test eq_round(-2.5) === -3.0
    @test eq_round(0.5) === 1.0
    @test eq_round(3.14159, 2) === 3.14
    @test eq_round(1234.0, -2) === 1200.0
    @test eq_trunc(-2.7) === -2.0
    @test eq_floor(2.5 - 1.5im) == 2.0 - 2.0im              # real and imaginary parts
    @test eq_round(1.5 + 2.5im) == 2.0 + 3.0im
    @test eq_floor(eq_vec(1.5, -1.5)) == eq_vec(1, -2)      # elementwise
    @test eq_ceil(eq_matrix(1, 2, 0.1, 1.0)) == [1.0 1.0]
    @test eq_round(eq_vec(0.25, 0.35), 1) == eq_vec(0.3, 0.4)
    @test eq_floor(1.5u"m" / 1.0u"cm") === 150.0            # dimensionless quantity
    @test_throws EqError eq_floor(2.7u"m")
    @test_throws EqError eq_floor("a")
    @test_throws EqError eq_round(1.5, 0.5)
    @test_throws EqError eq_round(1.5, eq_vec(1, 2))
end

@testset "scalar math functions are elementwise" begin
    @test eq_sqrt(4.0) === 2.0
    @test eq_sqrt(-4.0) == 2.0im
    @test eq_sqrt(eq_vec(4, 9)) == eq_vec(2, 3)
    @test eq_sqrt(4.0u"m^2") == 2.0u"m"
    @test eq_exp(0.0) === 1.0
    @test eq_exp(eq_vec(0, 1)) ≈ eq_vec(1, ℯ)
    @test eq_ln(ℯ) ≈ 1.0
    @test eq_ln(-1.0) ≈ π * im
    @test eq_ln(eq_vec(1, ℯ)) ≈ eq_vec(0, 1)
    @test_throws EqError eq_ln(0.0)
    @test eq_log(1000.0) ≈ 3.0
    @test eq_log(8.0, 2.0) ≈ 3.0
    @test eq_log(eq_vec(10, 100)) ≈ eq_vec(1, 2)
    @test eq_sin(0.0) === 0.0
    @test eq_cos(eq_vec(0, π)) ≈ eq_vec(1, -1)
    @test eq_tan(eq_matrix(1, 1, 0.0)) == eq_matrix(1, 1, 0.0)
    @test eq_sin(30.0u"°") ≈ 0.5                             # angle units convert
    @test_throws EqError eq_sin(1.0u"m")
    @test eq_asin(2.0) ≈ asin(complex(2.0))                     # Julia's side of the cut
    @test eq_asin(-2.0) ≈ asin(complex(-2.0))
    @test_throws EqError eq_exp(1000.0)                          # the reference application: overflow is an error
    @test_throws EqError eq_pow(2.0, 1024.0)
    @test eq_acos(2.0) ≈ acos(complex(2.0))
    @test eq_atanh(2.0) ≈ atanh(complex(2.0))
    @test eq_pow(-2.0, 0.5) ≈ complex(0.0, sqrt(2.0))           # the principal value
    @test eq_pow(-2.0, 1.5) ≈ complex(0.0, -2 * sqrt(2.0))
    @test eq_sqrt(-4.0) ≈ 2im
    @test eq_acos(eq_vec(1, 0)) ≈ eq_vec(0, π / 2)
    @test eq_atan(1.0) ≈ π / 4
    @test eq_re(eq_vec(1 + 2im, 3)) == eq_vec(1, 3)
    @test eq_im(eq_vec(1 + 2im, 3)) == eq_vec(2, 0)
    @test eq_re(2.0 + 1.0im) === 2.0
    @test eq_im(2.0) === 0.0
    @test_throws EqError eq_sqrt("x")
    @test_throws EqError eq_sin(eq_vec("a"))
end

@testset "IsScalar, IsArray, IsString" begin
    @test eq_isscalar(1.0) == 1.0
    @test eq_isscalar(1.0 + 2.0im) == 1.0
    @test eq_isscalar(eq_vec(1)) == 0.0
    @test eq_isscalar("a") == 0.0
    @test eq_isarray(eq_vec(1, 2)) == 1.0
    @test eq_isarray(2.0) == 0.0
    @test eq_isstring("a") == 1.0
    @test eq_isstring(2.0) == 0.0
end


@testset "functions of a square matrix" begin
    M = eq_matrix(2, 2, 1, 2, 3, 4)
    @test eq_exp(M) ≈ exp([1.0 2.0; 3.0 4.0])
    @test eq_sin(M) ≈ sin([1.0 2.0; 3.0 4.0])
    @test eq_sqrt(M) * eq_sqrt(M) ≈ M                      # complex here: M has a negative eigenvalue
    @test eq_exp(eq_ln(M)) ≈ M
    @test eq_exp(eq_matrix(2, 2, 0, 0, 0, 0)) ≈ eq_identity(2)
    @test eq_cosh(M) ≈ cosh([1.0 2.0; 3.0 4.0])
    # a vector, a non-square matrix and a 1 x 1 matrix stay elementwise
    @test eq_exp(eq_vec(0, 1)) ≈ eq_vec(1, exp(1))
    @test eq_sin(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)) ≈ sin.([1.0 2.0 3.0; 4.0 5.0 6.0])
    @test eq_exp(eq_matrix(1, 1, 2)) ≈ [exp(2.0);;]
    @test eq_sin(2.0) ≈ sin(2.0)
    # \vec hands the function one element at a time
    @test eq_vectorize(x -> eq_exp(x), M) ≈ exp.([1.0 2.0; 3.0 4.0])
    @test_throws EqError eq_ln(eq_matrix(2, 2, 1, 2, 2, 4))      # singular: no logarithm
end

@testset "non-integer matrix powers and a scalar to a matrix power" begin
    M = eq_matrix(2, 2, 1, 2, 3, 4)
    @test eq_pow(M, 0.5) ≈ [1.0 2.0; 3.0 4.0]^0.5
    @test eq_pow(M, 0.5) ≈ eq_sqrt(M)
    @test eq_pow(eq_matrix(2, 2, 2, 1, 1, 2), 0.5) ≈ [1.3660254037844382 0.3660254037844385; 0.3660254037844385 1.3660254037844382]
    @test eq_pow(M, 1.5) ≈ [1.0 2.0; 3.0 4.0]^1.5
    @test eq_pow(M, 2.0) ≈ eq_matrix(2, 2, 7, 10, 15, 22)       # an integer exponent is unchanged
    @test eq_pow(2.0, M) ≈ exp([1.0 2.0; 3.0 4.0] * log(2.0))
    @test eq_pow(eq_matrix(2, 2, 2, 1, 1, 2), -0.5) ≈ [2.0 1.0; 1.0 2.0]^-0.5
    @test_throws EqError eq_pow(eq_matrix(2, 2, 0, 0, 1, 0), 0.5)  # no square root: Julia answers zeros
    @test_throws EqError eq_pow(eq_matrix(2, 2, 1, 2, 2, 4), -0.5)  # singular
    @test_throws EqError eq_pow(2.0, eq_matrix(2, 3, 1, 2, 3, 4, 5, 6))
    @test eq_pow(eq_matrix(2, 3, 1, 4, 9, 16, 25, 36), 0.5) ≈ [1.0 2.0 3.0; 4.0 5.0 6.0]  # non-square: elementwise
end

@testset "match and lookup compare exactly" begin
    v = eq_vec(1.0004, 3.0)
    @test_throws EqError eq_match(1.0, v)
    @test eq_match(1.0004, v) ≈ eq_vec(0)
    @test eq_lookup(3.0, v, eq_vec(7, 8)) ≈ eq_vec(8)
end

@testset "eigenvec by inverse iteration" begin
    M = eq_matrix(2, 2, 1, 2, 3, 4)
    v = vec(eq_eigenvec(M, 5.37))
    @test norm(v) ≈ 1 && abs(abs(v[1]) - 0.415974) < 1e-3 && abs(abs(v[2]) - 0.909377) < 1e-3
end

@testset "genvecs left vectors" begin
    A = eq_matrix(3, 3, 2, 1, 0, 1, 3, 1, 0, 1, 4)
    B = eq_matrix(3, 3, 1, 0, 0, 0, 2, 0, 0, 0, 3)
    @test abs.(eq_genvecs(A, B, "L")) ≈ abs.(eq_genvecs(A, B)) atol=1e-9   # symmetric pair: left = right
    P = eq_matrix(2, 2, 1, 2, 3, 4)
    Q = eq_matrix(2, 2, 2, 0, 0, 1)
    values = eq_genvals(P, Q)
    left = eq_genvecs(P, Q, "L")
    for column in 1:2
        u = left[:, column]
        @test u' * P ≈ values[column] * (u' * Q) atol=1e-9
    end
    @test_throws EqError eq_genvecs(P, Q, "X")
end
