
@testset "value model and ORIGIN indexing" begin
    @test eq_matrix(2, 2, 1, 2, 3, 4) == [1.0 2.0; 3.0 4.0]
    @test eq_vec(1, 2, 3) == reshape([1.0, 2.0, 3.0], 3, 1)
    @test eq_rowvec(1, 2, 3) == [1.0 2.0 3.0]
    @test eltype(eq_vec(1, 2.0, 3 + 0im)) === ComplexF64

    matrix = eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)
    @test eq_index(matrix, 0, 0) == 1.0
    @test eq_index(matrix, 1, 2) == 6.0
    @test eq_index(eq_vec(4, 5), 1) == 5.0
    @test eq_col(matrix, 1) == reshape([2.0, 5.0], 2, 1)
    @test eq_row(matrix, 1) == [4.0 5.0 6.0]
    @test_throws EqError eq_index(matrix, 0)
    @test_throws EqError eq_index(eq_vec(1), 2)
    @test_throws EqError eq_index(eq_vec(1), 0.5)
    @test_throws EqError eq_index(eq_vec(1), 1u"m")

    with_origin(1) do
        @test origin() == 1
        @test eq_index(matrix, 1, 1) == 1.0
        @test eq_index(matrix, 2, 3) == 6.0
        @test_throws EqError eq_index(matrix, 0, 1)
    end
    @test origin() == DEFAULT_ORIGIN
end

@testset "percent" begin
    # `x%` is x/100 with the division semantics of `/`, and it adds no unit of its own.
    @test eq_percent(3.4) === 0.034
    @test eq_percent(0) === 0.0
    @test eq_percent(100) === 1.0
    @test eq_percent(-3.4) === -0.034
    @test eq_percent(5.0u"m") == 0.05u"m"
    # an array is divided elementwise
    @test eq_percent(eq_vec(10, 20)) == eq_vec(0.1, 0.2)
    @test eq_percent(eq_matrix(2, 2, 100, 200, 300, 400)) ==
          eq_matrix(2, 2, 1.0, 2.0, 3.0, 4.0)
    # a string is an error, as it is for `/`
    @test_throws EqError eq_percent("3.4")
end

@testset "per mille" begin
    # `x‰` is x/1000 with the division semantics of `/`, and it adds no unit of its own.
    @test eq_permille(2.5) === 0.0025
    @test eq_permille(1000) === 1.0
    @test eq_permille(5.0u"m") == 0.005u"m"
    @test eq_permille(eq_vec(1000, 2000)) == eq_vec(1.0, 2.0)
    @test_throws EqError eq_permille("2.5")
end

@testset "polar" begin
    @test eq_polar(2, 0) ≈ 2
    @test eq_polar(2, π / 2) ≈ 2im atol = 1e-12
    @test eq_polar(1, π) ≈ -1 atol = 1e-12
    # the magnitude keeps its unit
    @test eq_polar(5.0u"m", 0) ≈ 5.0u"m"
end

@testset "calling an element of an array" begin
    add1(x) = eq_add(x, 1)
    double(x) = eq_mul(2, x)
    # A vector and a two-index matrix may hold function values and an element is called
    # with the arguments as written.
    column = eq_matrix(2, 1, add1, double)
    @test eq_call(eq_index(column, 0), "F[0]", 3) == 4.0
    @test eq_call(eq_index(column, 1), "F[1]", 3) == 6.0
    square = eq_matrix(2, 2, add1, double, double, add1)
    @test eq_call(eq_index(square, 1, 0), "M[1, 0]", 4) == 8.0
    # The arguments go through unchanged, whatever their number.
    add2(x, y) = eq_add(x, y)
    @test eq_call(eq_index(eq_matrix(1, 1, add2), 0, 0), "H[0, 0]", 2, 3) == 5.0
    # An element that is not a function is the error of, naming the element as
    # written; nothing is called and no Julia MethodError reaches the worksheet.
    numbers = eq_vec(1, 2)
    error_message(f) = try
        f()
        ""
    catch error
        error isa EqError ? error.message : rethrow()
    end
    @test error_message(() -> eq_call(eq_index(numbers, 0), "V[0]", 1)) ==
          "V[0] is not a function"
    grid = eq_matrix(2, 2, 1, 2, 3, 4)
    @test error_message(() -> eq_call(eq_index(grid, 1, 1), "M[1, 1]", 1)) ==
          "M[1, 1] is not a function"
    # An index error stays the index's own error.
    @test_throws EqError eq_call(eq_index(numbers, 5), "V[5]", 1)
end

@testset "indexed assignment and growth" begin
    vector = eq_setindex!(nothing, 1.0, 3)
    @test vector == reshape([0.0, 0.0, 0.0, 1.0], 4, 1)
    vector = eq_setindex!(eq_vec(5, 6), 9.0, 4)
    @test vector == reshape([5.0, 6.0, 0.0, 0.0, 9.0], 5, 1)

    matrix = eq_setindex!(nothing, 1.0, 1, 2)
    @test matrix == [0.0 0.0 0.0; 0.0 0.0 1.0]
    matrix = eq_setindex!(matrix, 2.0, 2, 0)
    @test matrix == [0.0 0.0 0.0; 0.0 0.0 1.0; 2.0 0.0 0.0]

    nested = eq_setindex!(nothing, eq_rowvec(1, 2), 1, 1)
    @test eltype(nested) === Any
    @test nested[1, 1] === 0.0
    @test nested[2, 2] == [1.0 2.0]

    quantities = eq_setindex!(eq_vec(2u"m"), 3u"m", 2)
    @test quantities[1] == 2u"m"
    @test quantities[2] === 0.0
    @test quantities[3] == 3u"m"

    columns = eq_setcol!(0.0, eq_vec(10, 10), 0)
    columns = eq_setcol!(columns, eq_vec(20, 20), 1)
    @test columns == [10.0 20.0; 10.0 20.0]
    @test eq_setrow!(nothing, eq_rowvec(1, 2), 1) == [0.0 0.0; 1.0 2.0]

    original = eq_vec(1, 2)
    changed = eq_setindex!(eq_val(original), 9.0, 0)
    @test original == eq_vec(1, 2)
    @test changed == eq_vec(9, 2)
end

@testset "core the reference application operators" begin
    u = eq_vec(1, 2, 3)
    v = eq_vec(4, 5, 6)
    @test eq_add(u, 10) == eq_vec(11, 12, 13)
    @test eq_sub(u, v) == eq_vec(-3, -3, -3)
    @test eq_neg(u) == eq_vec(-1, -2, -3)
    @test eq_mul(u, v) == 32.0
    @test eq_mul(u, eq_transpose(v)) == [4.0 5.0 6.0; 8.0 10.0 12.0; 12.0 15.0 18.0]

    complex_u = eq_vec(1 + 1im, 2)
    complex_v = eq_vec(3 + 4im, 5)
    @test eq_dot(complex_u, complex_v) == 17 - 1im

    matrix = eq_matrix(2, 2, 2, 1, 1, 3)
    @test eq_pow(matrix, -1) ≈ inv([2.0 1.0; 1.0 3.0])
    @test eq_pow(matrix, 0) == Matrix{Float64}(I, 2, 2)
    @test eq_pow(matrix, 2) == [5.0 5.0; 5.0 10.0]
    @test eq_pow(eq_vec(2, 3), 2) == eq_vec(4, 9)
    @test eq_div(2.0, [2.0 0.0; 0.0 4.0]) == [1.0 0.0; 0.0 0.5]
    @test eq_div(eq_vec(1, 2), eq_vec(2, 4)) == eq_vec(0.5, 0.5)
    @test_throws EqError eq_div(1, 0)
    @test eq_pow(-8.0, 1 / 3) isa Complex

    @test eq_abs(eq_vec(3, 4)) == 5.0
    @test eq_abs(eq_matrix(2, 2, 1, 2, 3, 4)) ≈ -2.0
    @test eq_det(eq_matrix(1, 1, -3)) == -3.0
    @test eq_transpose(eq_rowvec(eq_rowvec(1, 2), 3))[1] == [1.0 2.0]
    @test eq_vectorize(eq_mul, eq_vec(1, 2), eq_vec(3, 4)) == eq_vec(3, 8)

    @test eq_lt(eq_vec(1, 3), 2) == eq_vec(1, 0)
    @test eq_eq(eq_vec(1, 2), eq_vec(1, 3)) == eq_vec(1, 0)
    @test eq_and(1, 2) == 1.0
    @test eq_not(1) == 0.0

    @test eq_mul(eq_rowvec(1u"m", 2u"m/s"), eq_vec(1.0, 1u"s")) == 3u"m"
    @test_throws EqError eq_add(eq_vec(1u"m"), eq_vec(1u"s"))
end

@testset "arithmetic operator details" begin
    u = eq_vec(1, 2, 3)
    @test eq_sub(10, u) == eq_vec(9, 8, 7)
    @test eq_sub(u, 1) == eq_vec(0, 1, 2)
    @test_throws EqError eq_add(u, eq_vec(1, 2))
    @test_throws EqError eq_sub(u, eq_rowvec(1, 2, 3))
    @test_throws EqError eq_add("a", 1)
    @test_throws EqError eq_neg("a")
    @test eq_neg(3) === -3.0
    @test eq_add(1, 2) === 3.0
    @test eq_add(1u"m", 2u"m") == 3u"m"
    @test_throws EqError eq_add(1u"m", 2u"s")
    # a dimensionless quantity becomes a plain number
    @test eq_div(1u"m", 2u"m") === 0.5

    # multiplication
    @test eq_mul(2, u) == eq_vec(2, 4, 6)
    @test eq_mul(u, 2) == eq_vec(2, 4, 6)
    @test eq_mul(eq_matrix(2, 2, 1, 2, 3, 4), eq_vec(1, 1)) == eq_vec(3, 7)
    @test_throws EqError eq_mul(eq_matrix(2, 2, 1, 2, 3, 4), u)
    # a 1x1 product is a scalar; column times row is an outer product
    @test eq_mul(eq_rowvec(1, 2, 3), eq_vec(1, 1, 1)) === 6.0
    @test eq_mul(eq_matrix(1, 1, 3), eq_matrix(1, 1, 4)) === 12.0
    @test size(eq_mul(eq_vec(1, 2), eq_rowvec(1, 2))) == (2, 2)
    @test_throws EqError eq_mul(u, eq_vec(1, 2))

    #  and section 18 item 3: only the second vector is conjugated
    a = eq_vec(1im, 2)
    b = eq_vec(1, 1)
    @test eq_dot(a, b) == 2 + 1im
    @test eq_dot(b, a) == 2 - 1im
    @test eq_dot(eq_vec(1im, 1), eq_vec(1im, 1)) == 2.0
    @test eq_mul(a, b) == eq_dot(a, b)
    @test eq_dot(eq_vec(1, 2), eq_vec(3, 4)) === 11.0
    @test_throws EqError eq_dot(eq_vec(1, 2), eq_vec(1, 2, 3))
    @test_throws EqError eq_dot(eq_rowvec(1, 2), eq_rowvec(1, 2))

    # division
    M = eq_matrix(2, 2, 2, 1, 1, 3)
    @test eq_div(M, 2) == eq_matrix(2, 2, 1, 0.5, 0.5, 1.5)
    @test eq_div(2, M) ≈ 2 * inv([2.0 1.0; 1.0 3.0])
    @test eq_div(1, eq_vec(2, 4)) == eq_vec(0.5, 0.25)
    @test eq_div(-1, eq_vec(2, 4)) == eq_vec(-0.5, -0.25)
    A = eq_matrix(2, 2, 1, 2, 3, 4)
    @test eq_div(A, M) ≈ [1.0 2.0; 3.0 4.0] * inv([2.0 1.0; 1.0 3.0])
    @test eq_div(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6), eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)) ==
          ones(2, 3)
    @test eq_div(eq_matrix(1, 2, 2, 4), eq_matrix(2, 2, 1, 0, 0, 2)) == [2.0 2.0]
    @test_throws EqError eq_div(eq_vec(1, 2), eq_vec(1, 2, 3))
    @test_throws EqError eq_div(eq_vec(1, 2), eq_vec(1, 0))
    @test_throws EqError eq_div(M, eq_matrix(2, 2, 1, 2, 2, 4))
    @test_throws EqError eq_div(2, eq_matrix(2, 2, 1, 2, 2, 4))
    # a 1x1 matrix stays a matrix when used as divisor
    @test eq_div(1, eq_matrix(1, 1, 4)) == eq_matrix(1, 1, 0.25)

    # power
    @test eq_pow(M, 3) ≈ [2.0 1.0; 1.0 3.0]^3
    @test eq_pow(M, -2) ≈ inv([2.0 1.0; 1.0 3.0])^2
    @test eq_pow(M, 0.5) ≈ [2.0 1.0; 1.0 3.0]^0.5          # Julia's matrix power
    @test_throws EqError eq_pow(M, M)
    @test_throws EqError eq_pow(eq_matrix(2, 2, 1, 2, 2, 4), -1)
    @test eq_pow(eq_matrix(1, 1, 3), 2) == eq_matrix(1, 1, 9)
    @test eq_pow(eq_rowvec(1, 2, 3), 2) == eq_rowvec(1, 4, 9)
    @test eq_pow(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6), 2) ==
          eq_matrix(2, 3, 1, 4, 9, 16, 25, 36)
    @test eq_pow(2, 10) === 1024.0
    @test eq_pow(2, -1) === 0.5
    @test eq_pow(0, 0) === 1.0
    @test_throws EqError eq_pow(0, -1)
    @test eq_pow(-8.0, 1 / 3) ≈ 1 + sqrt(3) * im
    @test eq_pow(2u"m", 2) == 4u"m^2"
    @test eq_inv(eq_matrix(2, 2, 4, 0, 0, 2)) == [0.25 0.0; 0.0 0.5]
    @test_throws EqError eq_inv(eq_matrix(2, 2, 1, 2, 2, 4))
    @test_throws EqError eq_inv(eq_vec(1, 2))
end

@testset "abs, norm, determinant, structure operators" begin
    @test eq_abs(-3) === 3.0
    @test eq_abs(3 + 4im) === 5.0
    @test eq_abs(eq_vec(3, 4)) === 5.0
    @test eq_abs(eq_rowvec(3, 4)) === 5.0
    @test eq_abs(eq_vec(3 + 4im, 0)) === 5.0
    @test eq_abs(eq_matrix(1, 1, -7)) === 7.0
    @test eq_abs(eq_matrix(2, 2, 1, 2, 3, 4)) ≈ -2.0
    @test_throws EqError eq_abs(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6))
    @test_throws EqError eq_abs("a")
    @test eq_abs(eq_vec(3u"m", 4u"m")) == 5u"m"
    # elementwise under vectorize, also for a non-square matrix
    U = eq_matrix(3, 2, 1, -2, -3, 4, 5, -6)
    @test eq_vectorize(eq_abs, U) == eq_matrix(3, 2, 1, 2, 3, 4, 5, 6)
    @test eq_vectorize(eq_abs, eq_matrix(2, 2, 1, -2, -3, 4)) == eq_matrix(2, 2, 1, 2, 3, 4)
    @test_throws EqError eq_det(eq_vec(1, 2))
    @test eq_det(eq_matrix(2, 2, 1, 2, 3, 4)) ≈ -2.0

    # cross product
    @test eq_cross(eq_vec(1, 0, 0), eq_vec(0, 1, 0)) == eq_vec(0, 0, 1)
    @test eq_cross(eq_vec(1, 2, 3), eq_vec(4, 5, 6)) == eq_vec(-3, 6, -3)
    @test_throws EqError eq_cross(eq_vec(1, 2), eq_vec(3, 4))
    @test_throws EqError eq_cross(eq_rowvec(1, 2, 3), eq_rowvec(1, 2, 3))
    @test_throws EqError eq_cross(1, 2)

    # transpose: not recursive, scalar unchanged, complex not conjugated
    inner = eq_rowvec(1, 2)
    nested = eq_rowvec(inner, 3)
    t = eq_transpose(nested)
    @test size(t) == (2, 1)
    @test t[1] == inner
    @test size(t[1]) == (1, 2)
    @test eq_transpose(5) === 5
    @test eq_transpose(eq_vec(1im, 2)) == eq_rowvec(1im, 2)
    @test eq_transpose(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)) == eq_matrix(3, 2, 1, 4, 2, 5, 3, 6)

    # conj and unary minus apply elementwise
    @test eq_conj(eq_vec(1 + 1im, 2)) == eq_vec(1 - 1im, 2)
    @test eq_conj(2.0) === 2.0
    @test eq_neg(eq_vec(1 + 1im, -2)) == eq_vec(-1 - 1im, 2)

    # column and row operators, ORIGIN aware
    M = eq_matrix(2, 3, 1, 2, 3, 4, 5, 6)
    with_origin(1) do
        @test eq_col(M, 1) == eq_vec(1, 4)
        @test eq_row(M, 2) == eq_rowvec(4, 5, 6)
        @test_throws EqError eq_col(M, 0)
        @test_throws EqError eq_col(M, 4)
    end
    @test_throws EqError eq_col(M, 3)
    @test_throws EqError eq_row(M, 2)
    @test_throws EqError eq_col(5, 0)
    @test_throws EqError eq_row(5, 0)
    copy_of = eq_col(M, 0)
    copy_of[1] = 99.0
    @test M[1, 1] == 1.0

    # vectorize
    @test eq_vectorize(eq_mul, eq_matrix(2, 2, 1, 2, 3, 4), eq_matrix(2, 2, 1, 2, 3, 4)) ==
          eq_matrix(2, 2, 1, 4, 9, 16)
    @test eq_vectorize(eq_pow, eq_vec(1, 2, 3), 2) == eq_vec(1, 4, 9)
    @test eq_vectorize(eq_add, 1, 2) === 3.0
    @test_throws EqError eq_vectorize(eq_add, eq_vec(1, 2), eq_vec(1, 2, 3))
    whole = eq_vectorize(eq_add, eq_rowvec(eq_vec(1, 2), eq_vec(3, 4)), 1)
    @test whole[1] == eq_vec(2, 3)          # nested elements pass whole
    @test eq_vectorize(x -> eq_mul(x, 2), eq_vec(1, 2)) == eq_vec(2, 4)
end

@testset "comparisons, chains and short-circuit" begin
    @test eq_lt(1, 2) === 1.0
    @test eq_ge(1, 2) === 0.0
    @test eq_eq("a", "a") === 1.0
    @test eq_ne("a", "b") === 1.0
    @test eq_eq(1u"m", 100u"cm") === 1.0
    @test_throws EqError eq_lt(1u"m", 1u"s")
    @test_throws EqError eq_lt(1 + 1im, 2)
    @test_throws EqError eq_lt("a", 1)           # same type
    @test_throws EqError eq_eq("a", 1)
    @test eq_eq(1 + 1im, 1 + 1im) === 1.0
    #  and section 18 item 2: elementwise on arrays
    @test eq_lt(eq_vec(1, 3), 2) == eq_vec(1, 0)
    @test eq_gt(2, eq_vec(1, 3)) == eq_vec(1, 0)
    @test eq_eq(eq_matrix(2, 2, 1, 2, 3, 4), eq_matrix(2, 2, 1, 0, 3, 0)) ==
          eq_matrix(2, 2, 1, 0, 1, 0)
    @test eq_ne(eq_vec(1, 2), eq_vec(1, 3)) == eq_vec(0, 1)
    @test_throws EqError eq_lt(eq_vec(1, 2), eq_vec(1, 2, 3))

    # a < b < c is a < b and b < c
    @test eq_chain((eq_lt, eq_lt), 1, 2, 3) === 1.0
    @test eq_chain((eq_lt, eq_lt), 1, 5, 3) === 0.0
    @test eq_chain((eq_lt, eq_le, eq_lt), 1, 2, 2, 3) === 1.0
    @test eq_chain((eq_lt, eq_lt), 1, eq_vec(0, 2, 5), 4) == eq_vec(0, 1, 0)
    @test eq_chain((eq_eq,), 2, 2) === 1.0
    @test_throws EqError eq_chain((eq_lt, eq_lt), 1, 2)

    # nonzero is true, scalar needed, short-circuit
    @test eq_true(2.5) && !eq_true(0.0)
    @test_throws EqError eq_true(eq_vec(1, 2))
    @test_throws EqError eq_true("a")
    @test_throws EqError eq_and(eq_vec(1, 2), 1)
    @test eq_and(1, 0) === 0.0
    @test eq_or(0, 3) === 1.0
    @test eq_xor(1, 1) === 0.0
    @test eq_xor(1, 0) === 1.0
    @test eq_and(0, () -> error("must not be evaluated")) === 0.0
    @test eq_or(1, () -> error("must not be evaluated")) === 1.0
    @test eq_and(1, () -> 2) === 1.0
    @test eq_or(0, () -> 0) === 0.0
    @test_throws EqError eq_and(1, () -> eq_vec(1, 2))
    @test_throws ErrorException eq_and(1, () -> error("evaluated"))

    # section 18 item 5: only the selected branch is evaluated
    @test eq_if(1, () -> 10.0, () -> error("else evaluated")) === 10.0
    @test eq_if(0, () -> error("then evaluated"), () -> 7.0) === 7.0
    @test_throws EqError eq_if(eq_vec(1, 2), () -> 1.0, () -> 2.0)

    # element of
    @test eq_in(2, eq_vec(1, 2, 3)) === 1.0
    @test eq_in(5, eq_vec(1, 2, 3)) === 0.0
    @test_throws EqError eq_in(1, 2)
end

