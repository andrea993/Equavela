# Solve blocks: Find, Minerr, Minimize, Maximize.

eq(l, r) = eq_constraint(:eq, l, r)

@testset "Find: one equation, one unknown" begin
    r = eq_find([eq(x -> eq_pow(x, 2.0), x -> 2.0)], [1.0])
    @test r ≈ sqrt(2.0) atol = 1e-6
    r = eq_find([eq(x -> eq_pow(x, 2.0), x -> 2.0)], [-1.0])
    @test r ≈ -sqrt(2.0) atol = 1e-6
end

@testset "Find: two equations, a column vector result" begin
    cs = [eq((x, y) -> eq_add(x, y), (x, y) -> 3.0), eq((x, y) -> eq_sub(x, y), (x, y) -> 1.0)]
    r = eq_find(cs, [0.0, 0.0])
    @test size(r) == (2, 1)
    @test r[1] ≈ 2.0 atol = 1e-6
    @test r[2] ≈ 1.0 atol = 1e-6
    # nonlinear: circle and line
    cs = [eq((x, y) -> eq_add(eq_pow(x, 2.0), eq_pow(y, 2.0)), (x, y) -> 25.0), eq((x, y) -> y, (x, y) -> x)]
    r = eq_find(cs, [1.0, 1.0])
    @test r[1] ≈ 5 / sqrt(2) atol = 1e-5
end

@testset "Find: inequalities pick a solution" begin
    cs = [eq(x -> eq_pow(x, 2.0), x -> 4.0), eq_constraint(:lt, x -> x, x -> 0.0)]
    @test eq_find(cs, [-1.0]) ≈ -2.0 atol = 1e-5
    cs = [eq(x -> eq_pow(x, 2.0), x -> 4.0), eq_constraint(:gt, x -> x, x -> 0.0)]
    @test eq_find(cs, [1.0]) ≈ 2.0 atol = 1e-5
    # the guess decides: from the wrong side the iteration stops on the root that breaks the inequality
    @test_throws EqError eq_find(cs, [-1.0])
end

@testset "Find: units" begin
    cs = [eq(x -> eq_mul(x, eq_unit("s")), x -> eq_mul(10.0, eq_unit("m")))]
    r = eq_find(cs, [1.0 * u"m/s"])           # m/s * s = m: consistent, x = 10 m/s
    @test ustrip(r) ≈ 10.0 atol = 1e-5
    cs = [eq(x -> eq_mul(x, eq_unit("s")), x -> eq_mul(10.0, eq_unit("kg")))]
    @test_throws EqError eq_find(cs, [1.0 * u"m/s"])   # length against mass
    cs = [eq(x -> eq_mul(x, eq_unit("s")), x -> eq_mul(10.0, eq_unit("s")))]
    @test eq_find(cs, [1.0]) ≈ 10.0 atol = 1e-5
    # the unknown keeps the unit of its guess
    cs = [eq(d -> eq_div(d, eq_unit("s")), d -> eq_div(eq_mul(5.0, eq_unit("m")), eq_unit("s")))]
    r = eq_find(cs, [1.0 * u"m"])
    @test unit(r) == u"m"
    @test ustrip(r) ≈ 5.0 atol = 1e-5
end

@testset "Find: failure and errors" begin
    @test_throws EqError eq_find([eq(x -> eq_add(eq_pow(x, 2.0), 1.0), x -> 0.0)], [1.0])
    @test_throws EqError eq_find([eq(x -> x, x -> 1.0)], Any[])
    @test_throws EqError eq_find([], [1.0])
    @test_throws EqError eq_find([eq(x -> x, x -> 1.0)], ["a"])
    @test_throws EqError eq_find(5, [1.0])
    @test_throws EqError eq_constraint(:bogus, x -> x, x -> x)
    @test_throws EqError eq_find([eq(x -> x, x -> 1.0)], [1.0 + 2.0im])
end

@testset "Find: a vector unknown" begin
    cs = [eq(v -> eq_sub(v, eq_matrix(2, 1, 1.0, 2.0)), v -> eq_matrix(2, 1, 0.0, 0.0))]
    r = eq_find(cs, [eq_matrix(2, 1, 0.0, 0.0)])
    @test vec(r) ≈ [1.0, 2.0] atol = 1e-6
end

@testset "Minerr returns the best approximation" begin
    cs = [eq(x -> x, x -> 1.0), eq(x -> x, x -> 3.0)]
    @test_throws EqError eq_find(cs, [0.0])
    @test eq_minerr(cs, [0.0]) ≈ 2.0 atol = 1e-4
    @test eq_minerr([eq(x -> eq_pow(x, 2.0), x -> 2.0)], [1.0]) ≈ sqrt(2.0) atol = 1e-6
end

@testset "Minimize and Maximize" begin
    f = (x, y) -> eq_add(eq_pow(eq_sub(x, 1.0), 2.0), eq_pow(eq_sub(y, 2.0), 2.0))
    r = eq_minimize(f, [], [0.0, 0.0])
    @test r[1] ≈ 1.0 atol = 1e-4
    @test r[2] ≈ 2.0 atol = 1e-4
    g = x -> eq_sub(5.0, eq_pow(eq_sub(x, 3.0), 2.0))
    @test eq_maximize(g, [], [0.0]) ≈ 3.0 atol = 1e-4
    # constrained: minimise x^2 subject to x >= 2
    c = [eq_constraint(:ge, x -> x, x -> 2.0)]
    @test eq_minimize(x -> eq_pow(x, 2.0), c, [5.0]) ≈ 2.0 atol = 1e-3
    # constrained by an equation: minimise x^2 + y^2 on x + y = 2
    c = [eq((x, y) -> eq_add(x, y), (x, y) -> 2.0)]
    r = eq_minimize((x, y) -> eq_add(eq_pow(x, 2.0), eq_pow(y, 2.0)), c, [0.0, 0.0])
    @test r[1] ≈ 1.0 atol = 1e-3
    @test r[2] ≈ 1.0 atol = 1e-3
    @test_throws EqError eq_minimize(5.0, [], [0.0])
    @test_throws EqError eq_minimize(x -> eq_stack(x, x), [], [0.0])
end

@testset "CTOL" begin
    @test EqRuntime.DEFAULT_CTOL == 0.001
    @test CTOL[] == 0.001
    @test ctol() == 0.001
    EqRuntime.with_ctol(1.0e-9) do
        @test CTOL[] == 1.0e-9
        @test ctol() == 1.0e-9
    end
    # the scope ends with the block: the previous value comes back
    @test ctol() == 0.001
    # nested scopes: the innermost value is the one the solve block reads
    EqRuntime.with_ctol(0.5) do
        EqRuntime.with_ctol(0.25) do
            @test ctol() == 0.25
        end
        @test ctol() == 0.5
    end
    # zero is allowed (unlike TOL): "as exact as the algorithm can be"
    EqRuntime.with_ctol(0.0) do
        @test ctol() == 0.0
    end
    # an invalid value is refused before anything runs
    @test_throws EqError EqRuntime.with_ctol(-1.0) do; end
    @test_throws EqError EqRuntime.with_ctol(Inf) do; end
    @test_throws EqError EqRuntime.with_ctol("0.1") do; end
    # CTOL is the acceptance limit of a solve block: constraints that cannot
    # all hold are refused with the default tolerance and accepted by a loose one.
    contradictory = [eq(x -> x, x -> 0.0), eq(x -> x, x -> 1.0)]
    @test_throws EqError eq_find(contradictory, [0.3])
    EqRuntime.with_ctol(1.0) do
        @test eq_find(contradictory, [0.3]) ≈ 0.5 atol = 1e-6
    end
end
