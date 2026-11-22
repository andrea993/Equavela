# Ranges, iterated sums and products, iterated assignment.
# Sources: compatibility (answered), section 18 correction 1.

@testset "range variables" begin
    @test vec(eq_collect(eq_range(0, 4))) == [0.0, 1, 2, 3, 4]
    @test vec(eq_collect(eq_range(3, 0))) == [3.0, 2, 1, 0]          #  descending
    @test vec(eq_collect(eq_range(0, -1))) == [0.0, -1]              # n = 0
    @test vec(eq_collect(eq_range(2, 2))) == [2.0]
    @test vec(eq_collect(eq_range(0, 2, 9))) == [0.0, 2, 4, 6, 8]
    @test vec(eq_collect(eq_range(10, 8, 0))) == [10.0, 8, 6, 4, 2, 0]
    @test length(eq_range(0, 4)) == 5
    @test collect(eq_range(1, 3)) == [1.0, 2.0, 3.0]
    @test size(eq_collect(eq_range(0, 4))) == (5, 1)                 # a column

    # values a + k*step, the end value is exact
    tenth = eq_range(0, 0.1, 1)
    @test length(tenth) == 11
    values = collect(tenth)
    @test values[end] === 1.0
    @test values[4] == 0 + 3 * 0.1
    @test length(eq_range(0, 0.1, 0.35)) == 4                        # does not pass b
    @test collect(eq_range(0, 0.1, 0.3))[end] === 0.3                # snapped
    @test length(eq_range(1, 1.001, 2)) == 1001
    @test length(eq_range(0, 1 / 3, 1)) == 4
    @test collect(eq_range(0, 1 / 3, 1))[end] === 1.0

    # a step against the end value gives an empty range
    @test length(eq_range(0, 1, -5)) == 0
    @test size(eq_collect(eq_range(0, 1, -5))) == (0, 1)
    @test_throws EqError eq_range(1, 1, 5)                           # zero step
    @test_throws EqError eq_range(1.0im, 5)
    @test_throws EqError eq_range("a", 5)

    # units
    metres = eq_range(0.0u"m", 1.0u"m", 3.0u"m")
    @test length(metres) == 4
    @test collect(metres)[end] == 3.0u"m"
    @test collect(eq_range(0.0u"m", 50.0u"cm", 1.0u"m")) == [0.0u"m", 0.5u"m", 1.0u"m"]
    @test_throws EqError eq_range(0.0u"m", 1.0u"s", 3.0u"m")
    @test_throws EqError eq_range(0.0u"m", 1.0u"m", 3.0)

    # f(i) = shows a column; an index of a range
    @test eq_map_range(i -> eq_mul(i, i), eq_range(1, 3)) == eq_vec(1, 4, 9)
    @test eq_map_range(i -> eq_vec(i, i), eq_range(1, 2))[2] == eq_vec(2, 2)
end

@testset "iterated assignment" begin
    y = eq_setindex!(nothing, 1.0, 0)
    y = eq_iter_setindex(y, eq_range(1, 4), (y, i) -> eq_mul(eq_index(y, eq_sub(i, 1)), 2.0))
    @test vec(y) == [1.0, 2, 4, 8, 16]
    with_origin(1) do
        x = eq_iter_setindex(nothing, eq_range(1, 4), (x, i) -> eq_pow(i, 2))
        @test vec(x) == [1.0, 4, 9, 16]
    end
    x0 = eq_iter_setindex(nothing, eq_range(1, 4), (x, i) -> eq_pow(i, 2))
    @test vec(x0) == [0.0, 1, 4, 9, 16]                              # x[0] stays 0
    # column assignment X<k> := f(X, k)
    matrix = eq_iter_setcol(nothing, eq_range(0, 2), (X, k) -> eq_vec(k, eq_add(k, 10)))
    @test matrix == [0.0 1 2; 10 11 12]
    # an empty range leaves the target as it is
    @test eq_iter_setindex(eq_vec(5), eq_range(0, 1, -5), (x, i) -> 0.0) == eq_vec(5)
end

@testset "sums and products" begin
    @test eq_sum(k -> k, 1, 4) === 10.0
    @test eq_sum(k -> eq_mul(k, k), 0, 3) === 14.0
    @test eq_sum(k -> 5.0, 2, 2) === 5.0                              # one term
    @test eq_sum(k -> eq_vec(k, 1), 1, 3) == eq_vec(6, 3)              # arrays are summed
    @test eq_sum(k -> eq_mul(k, 1.0u"m"), 1, 3) == 6.0u"m"
    # section 18 correction 1 / : descending when the upper bound is lower
    visited = Float64[]
    @test eq_sum(k -> (push!(visited, k); k), 3, 1) === 6.0
    @test visited == [3.0, 2.0, 1.0]
    @test eq_sum(k -> k, 0, -1) === -1.0                              # k = 0, -1
    #  / : non-integer bounds step by 1 from the lower bound
    visited = Float64[]
    eq_sum(k -> (push!(visited, k); k), 0.5, 3)
    @test visited == [0.5, 1.5, 2.5]
    # a range variable as the source
    @test eq_sum(k -> k, eq_range(1, 4)) === 10.0
    @test eq_sum(k -> k, eq_range(0, 0.5, 2)) === 5.0
    @test eq_sum(k -> k, eq_range(0, 1, -5)) === 0.0                  # empty: 0
    # the lazy guard of a test worksheet
    guarded(i) = eq_if(eq_eq(i, 0), () -> 0.0, () -> eq_sum(k -> eq_index(eq_vec(1, 2, 3), k), 0, eq_sub(i, 1)))
    @test guarded(0) === 0.0
    @test guarded(2) === 3.0

    @test eq_prod(k -> k, 1, 5) === 120.0
    visited = Float64[]
    @test eq_prod(k -> (push!(visited, k); k), 3, 1) === 6.0          #  descending
    @test visited == [3.0, 2.0, 1.0]
    @test eq_prod(k -> k, eq_range(1, 3)) === 6.0
    @test eq_prod(k -> k, eq_range(0, 1, -5)) === 1.0                 # empty: 1
    @test_throws EqError eq_sum(k -> k, 1.0im, 3)
    @test_throws EqError eq_sum(k -> "a", 1, 2)
end

@testset "a range selects rows, columns and elements" begin
    M = eq_matrix(3, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9)
    # the run of rows or columns with all their columns or rows, in the order of the range
    @test eq_row(M, eq_range(0, 1)) == [1.0 2.0 3.0; 4.0 5.0 6.0]
    @test eq_row(M, eq_range(2, 1)) == [7.0 8.0 9.0; 4.0 5.0 6.0]     # descending reverses
    @test eq_col(M, eq_range(1, 2)) == reshape([2.0, 5.0, 8.0, 3.0, 6.0, 9.0], 3, 2)
    @test eq_col(M, eq_range(2, 1)) == reshape([3.0, 6.0, 9.0, 2.0, 5.0, 8.0], 3, 2)
    # the step form takes every step-th one
    @test eq_row(M, eq_range(0, 2, 2)) == [1.0 2.0 3.0; 7.0 8.0 9.0]
    @test eq_col(M, eq_range(0, 2, 2)) == reshape([1.0, 4.0, 7.0, 3.0, 6.0, 9.0], 3, 2)
    # one value keeps the shape of the operator
    @test eq_row(M, eq_range(1, 1)) == [4.0 5.0 6.0]
    @test eq_col(M, eq_range(1, 1)) == eq_vec(2, 5, 8)

    v = eq_vec(10, 20, 30, 40)
    @test eq_index(v, eq_range(1, 3)) == eq_vec(20, 30, 40)           # a column vector
    @test eq_index(v, eq_range(3, 1)) == eq_vec(40, 30, 20)
    @test size(eq_index(v, eq_range(1, 1))) == (1, 1)

    # Ranges in both subscripts, or in one of them: the rows and the
    # columns together; a range and an index give a column or a row.
    N = eq_matrix(4, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)
    @test eq_index(N, eq_range(0, 2), eq_range(0, 1)) == [1.0 2.0; 4.0 5.0; 7.0 8.0]
    @test eq_index(N, eq_range(0, 2, 3), eq_range(2, 0)) == [3.0 2.0 1.0; 9.0 8.0 7.0]
    @test eq_index(N, eq_range(1, 3), 1) == eq_vec(5, 8, 11)
    @test eq_index(N, 2, eq_range(0, 2)) == [7.0 8.0 9.0]
    @test size(eq_index(N, eq_range(1, 1), eq_range(2, 2))) == (1, 1)
    @test_throws EqError eq_index(N, eq_range(0, 4), eq_range(0, 1))
    @test_throws EqError eq_index(N, eq_range(0, 1), eq_range(0, 3))
    # vec(r) of a range variable; one number is a clear error, not a Julia MethodError
    @test eq_vecrange(eq_range(0, 2, 6)) == eq_vec(0, 2, 4, 6)
    @test_throws EqError eq_vecrange(3.0)
    @test size(eq_index(v, eq_range(2, 2))) == (1, 1)

    # every value is an index of : one bad value is the error of
    # the operator, never a shorter selection
    @test_throws EqError eq_row(M, eq_range(0, 3))
    @test_throws EqError eq_col(M, eq_range(0, 3))
    @test_throws EqError eq_index(v, eq_range(0, 4))
    @test_throws EqError eq_index(v, eq_range(0.5, 2))
    @test_throws EqError eq_row(5, eq_range(0, 1))
    @test_throws EqError eq_col(5, eq_range(0, 1))
    @test_throws EqError eq_index(M, eq_range(0, 1))
    @test_throws EqError eq_row(M, eq_range(0.0u"m", 1))

    # ORIGIN counts
    with_origin(1) do
        @test eq_row(M, eq_range(1, 2)) == [1.0 2.0 3.0; 4.0 5.0 6.0]
        @test eq_col(M, eq_range(2, 3)) == reshape([2.0, 5.0, 8.0, 3.0, 6.0, 9.0], 3, 2)
        @test eq_index(v, eq_range(2, 3)) == eq_vec(20, 30)
        @test_throws EqError eq_row(M, eq_range(0, 1))
    end

    # a range with no values selects nothing
    @test size(eq_row(M, eq_range(0, 1, -5))) == (0, 3)
    @test size(eq_col(M, eq_range(0, 1, -5))) == (3, 0)
    @test size(eq_index(v, eq_range(0, 1, -5))) == (0, 1)

    # the array is copied, as every value boundary is
    selected = eq_row(M, eq_range(0, 1))
    selected[1, 1] = 99.0
    @test M[1, 1] == 1.0
end

@testset "factorial" begin
    @test eq_factorial(0) === 1.0
    @test eq_factorial(5.0) === 120.0
    @test eq_factorial(20.0) === 2.43290200817664e18
    @test_throws EqError eq_factorial(171.0)                          # overflows Float64
    @test_throws EqError eq_factorial(-1.0)
    @test_throws EqError eq_factorial(2.5)
    @test_throws EqError eq_factorial("a")
end
