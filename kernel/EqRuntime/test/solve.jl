# Root finder `root(f(x), x[, a, b])`.

@testset "root with a guess (secant)" begin
    square = x -> eq_sub(eq_pow(x, 2.0), 2.0)
    @test eq_root(square, 1.0) ≈ sqrt(2.0) atol = 1e-12
    @test eq_root(square, -1.0) ≈ -sqrt(2.0) atol = 1e-12
    @test eq_root(square, 5) ≈ sqrt(2.0) atol = 1e-12          # integer guess
    @test eq_root(x -> eq_sub(eq_cos(x), x), 0.0) ≈ 0.7390851332151607 atol = 1e-12
    @test eq_root(x -> eq_sub(x, 3.0), 3.0) == 3.0              # the guess is a root
    @test eq_root(x -> eq_mul(x, 2.0), 0.0) == 0.0
    @test eq_root(x -> eq_sub(eq_exp(x), 10.0), 0.0) ≈ log(10.0) atol = 1e-12
    # a root far from the guess
    @test eq_root(x -> eq_sub(eq_mul(x, x), 1.0e6), 1.0) ≈ 1000.0 atol = 1e-9
    @test eq_root(x -> eq_sub(x, 1), 0.0) ≈ 1.0
    # a double root converges slowly but reaches the step criterion
    @test eq_root(x -> eq_pow(eq_sub(x, 1.0), 2.0), 3.0) ≈ 1.0 atol = 1e-7
end

@testset "root on a bracket" begin
    cubic = x -> eq_sub(eq_sub(eq_pow(x, 3.0), x), 2.0)
    @test eq_root(cubic, 1.0, 2.0) ≈ 1.5213797068045676 atol = 1e-12
    @test eq_root(cubic, 2.0, 1.0) ≈ 1.5213797068045676 atol = 1e-12   # reversed bounds
    @test eq_root(x -> x, -1.0, 1.0) == 0.0
    @test eq_root(x -> eq_sub(x, 1.0), 1.0, 2.0) == 1.0               # root at an end
    @test eq_root(x -> eq_sub(x, 2.0), 1.0, 2.0) == 2.0
    # a bracket finds the root a guess could miss
    @test eq_root(x -> eq_sub(eq_mul(x, eq_sub(x, 1.0)), 2.0), -5.0, 0.0) ≈ -1.0 atol = 1e-12
    @test_throws EqError eq_root(x -> eq_add(eq_pow(x, 2.0), 1.0), -1.0, 1.0)  # no sign change
    @test_throws EqError eq_root(x -> x, 1.0, 1.0)
    @test_throws EqError eq_root(x -> x, 0.0 + 1.0im, 2.0)
end

@testset "root errors" begin
    @test_throws EqError eq_root(x -> eq_add(eq_pow(x, 2.0), 1.0), 1.0)    # no real root
    @test_throws EqError eq_root(x -> 1.0, 0.0)                          # constant function
    @test_throws EqError eq_root(x -> eq_stack(x, x), 1.0)               # array result
    @test_throws EqError eq_root(x -> "a", 1.0)
    @test_throws EqError eq_root(x -> x, "a")
    @test_throws EqError eq_root(x -> x, eq_matrix(1, 2, 1, 2))
    @test_throws EqError eq_root(x -> x)
    @test_throws EqError eq_root(x -> x, 1.0, 2.0, 3.0)
    @test_throws EqError eq_root(5.0, 1.0)                               # not a function
    @test_throws EqError eq_root(x -> NaN, 1.0)
    error = try eq_root(x -> eq_add(eq_pow(x, 2.0), 1.0), 1.0) catch e e end
    @test occursin("root", error.message) && occursin("converge", error.message)
    error = try eq_root(x -> eq_add(x, 1.0), 1.0, 2.0) catch e e end
    @test occursin("sign", error.message)
end

@testset "root with complex values" begin
    f = x -> eq_add(eq_pow(x, 2.0), 1.0)
    z = eq_root(f, 0.5 + 0.5im)
    @test abs(z - 1.0im) < 1e-9
    @test abs(eq_root(f, 0.5 - 0.5im) + 1.0im) < 1e-9
    # a complex-valued function with a real guess has no real root
    @test_throws EqError eq_root(x -> eq_mul(x, 1.0im), 1.0)
    @test eq_root(x -> eq_sub(x, 2.0), 0.0) isa Float64
end

@testset "root with units" begin
    f = x -> eq_sub(x, 3.0u"m")
    root = eq_root(f, 1.0u"m")
    @test root isa Unitful.Quantity
    @test unit(root) == u"m"
    @test ustrip(u"m", root) ≈ 3.0 atol = 1e-12
    bracket = eq_root(f, 0.0u"m", 10.0u"m")
    @test ustrip(u"m", bracket) ≈ 3.0 atol = 1e-12
    # the guess unit is kept, the function may use other units
    other = eq_root(x -> eq_sub(x, 30.0u"cm"), 1.0u"m")
    @test ustrip(u"m", other) ≈ 0.3 atol = 1e-12
    fall = t -> eq_sub(eq_div(eq_mul(9.80665u"m/s^2", eq_pow(t, 2.0)), 2.0), 10.0u"m")
    @test ustrip(u"s", eq_root(fall, 1.0u"s")) ≈ sqrt(2 * 10 / 9.80665) atol = 1e-12
    # mismatched bracket units and a residual of the wrong dimension
    @test_throws EqError eq_root(f, 0.0u"m", 10.0u"s")
    @test_throws EqError eq_root(f, 0.0u"m", 10.0)
    @test_throws EqError eq_root(x -> eq_sub(x, 3.0u"s"), 1.0u"m")
end

@testset "TOL" begin
    @test EqRuntime.tol() == 0.001
    EqRuntime.with_tol(1.0e-9) do
        @test EqRuntime.tol() == 1.0e-9
    end
    @test EqRuntime.tol() == 0.001
    @test_throws EqError EqRuntime.with_tol(() -> nothing, 0.0)
    @test_throws EqError EqRuntime.with_tol(() -> nothing, -1.0)
    # the result is refined far below TOL, a loose TOL does not loosen the answer
    EqRuntime.with_tol(0.5) do
        @test eq_root(x -> eq_sub(eq_pow(x, 2.0), 2.0), 1.0) ≈ sqrt(2.0) atol = 1e-9
    end
end

@testset "root through a worksheet-style call" begin
    f_v1(x) = eq_sub(eq_pow(x, 2.0), eq_mul(4.0, x))
    @test eq_root(x -> f_v1(x), 3.0) ≈ 4.0 atol = 1e-12
    @test eq_root(x -> f_v1(x), 1.0) ≈ 0.0 atol = 1e-9
    @test eq_root(x -> f_v1(x), 3.0, 5.0) ≈ 4.0 atol = 1e-12
end
