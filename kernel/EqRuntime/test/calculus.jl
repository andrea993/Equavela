# Numeric integral and derivatives (src/calculus.jl).

@testset "integral: finite limits" begin
    @test eq_integral(x -> eq_pow(x, 2.0), 0.0, 3.0) ≈ 9.0 atol = 1e-12
    @test eq_integral(x -> eq_sin(x), 0.0, pi) ≈ 2.0 atol = 1e-12
    @test eq_integral(x -> eq_pow(x, 2.0), 3.0, 0.0) ≈ -9.0 atol = 1e-12   # reversed
    @test eq_integral(x -> x, 2.0, 2.0) == 0.0                              # equal limits
    @test eq_integral(x -> eq_pow(x, 3.0), -1, 1) ≈ 0.0 atol = 1e-14        # odd, integer limits
    @test eq_integral(x -> eq_ln(x), 0.0, 1.0) ≈ -1.0 atol = 1e-8           # integrable singularity
    @test eq_integral(x -> eq_div(1.0, eq_add(1.0, eq_mul(25.0, eq_pow(x, 2.0)))), -1.0, 1.0) ≈
          2 * atan(5.0) / 5 atol = 1e-12
    @test eq_integral(x -> eq_sin(eq_mul(50.0, x)), 0.0, 10.0) ≈ (1 - cos(500.0)) / 50 atol = 1e-9
    # complex values and complex integrands
    @test eq_integral(x -> eq_exp(eq_mul(1.0im, x)), 0.0, pi) ≈ 2.0im atol = 1e-12
end


@testset "integral: infinite limits" begin
    @test eq_integral(x -> eq_exp(eq_neg(x)), 0.0, Inf) ≈ 1.0 atol = 1e-9
    # a test worksheet: ∫[t ∈ 0..∞] e^-(t/τ) = τ
    tau = 2.5
    @test eq_integral(t -> eq_exp(eq_neg(eq_div(t, tau))), 0.0, Inf) ≈ tau atol = 1e-8
    @test eq_integral(x -> eq_exp(eq_neg(eq_pow(x, 2.0))), -Inf, Inf) ≈ sqrt(pi) atol = 1e-8
    @test eq_integral(x -> eq_exp(x), -Inf, 0.0) ≈ 1.0 atol = 1e-9
    @test eq_integral(x -> eq_exp(eq_neg(x)), Inf, 0.0) ≈ -1.0 atol = 1e-9
    @test eq_integral(x -> eq_div(1.0, eq_pow(x, 2.0)), 1.0, Inf) ≈ 1.0 atol = 1e-8
    @test_throws EqError eq_integral(x -> x, Inf, Inf)
    @test_throws EqError eq_integral(x -> x, 0.0, Inf)       # diverges
end

@testset "integral: matrices (Lyapunov X = ∫ e^(At) Q e^(A^T t))" begin
    # scalar case: A = -1, Q = 2: X = 1
    a, q = [-1.0;;], [2.0;;]
    x = eq_integral(t -> eq_mul(eq_mul(eq_exp(eq_mul(-1.0, t)), q), eq_exp(eq_mul(-1.0, t))), 0.0, Inf)
    @test x ≈ [1.0;;] atol = 1e-8
    m = eq_integral(t -> [1.0 t; 0.0 eq_mul(2.0, t)], 0.0, 1.0)
    @test m ≈ [1.0 0.5; 0.0 1.0] atol = 1e-12
end

@testset "integral: units and errors" begin
    meter, second = u"m", u"s"
    @test eq_integral(t -> eq_mul(2.0, t), 0.0 * second, 3.0 * second) ≈ 9.0 * second^2 atol = 1e-12 * second^2
    v = eq_integral(t -> 2.0 * meter / second, 0.0 * second, 3.0 * second)
    @test unit(v) == meter
    @test ustrip(v) ≈ 6.0
    @test ustrip(eq_integral(t -> t, 0.0 * u"km", 1000.0 * u"m")) ≈ 0.5 atol = 1e-9
    @test_throws EqError eq_integral(t -> t, 0.0 * second, 1.0 * meter)
    @test_throws EqError eq_integral(t -> t, 0.0 * second, 1.0)
    @test_throws EqError eq_integral(t -> "a", 0.0, 1.0)
    @test_throws EqError eq_integral(t -> t, 0.0 + 1.0im, 2.0)
    @test_throws EqError eq_integral(3.0, 0.0, 1.0)
    @test_throws EqError eq_integral(t -> t, 0.0)
    @test_throws EqError eq_integral(t -> eq_div(1.0, t), 0.0, 1.0)  # not integrable
end

@testset "integral: TOL scales the accuracy" begin
    f = x -> eq_exp(eq_neg(eq_pow(x, 2.0)))
    exact = 0.7468241328124270
    fine = eq_integral(f, 0.0, 1.0)
    loose = with_tol(() -> eq_integral(f, 0.0, 1.0), 0.5)
    @test abs(fine - exact) <= abs(loose - exact) + 1e-15
    @test with_tol(() -> eq_integral(f, 0.0, 1.0), 1e-9) ≈ exact atol = 1e-13
end

@testset "derivative" begin
    @test eq_derivative(x -> eq_pow(x, 3.0), 2.0) ≈ 12.0 atol = 1e-8
    @test eq_derivative(x -> eq_sin(x), 0.0) ≈ 1.0 atol = 1e-9
    @test eq_derivative(x -> eq_exp(x), 1.0) ≈ exp(1.0) atol = 1e-8
    @test eq_derivative(x -> eq_ln(x), 0.01) ≈ 100.0 rtol = 1e-7     # small x, near the singularity
    @test eq_derivative(x -> eq_abs(x), 2.0) ≈ 1.0 atol = 1e-8
    @test eq_derivative(x -> 5.0, 3.0) ≈ 0.0 atol = 1e-8
    @test eq_derivative(x -> eq_pow(x, 5.0), 1.5, 5) ≈ 120.0 rtol = 1e-4
    @test eq_derivative(x -> eq_pow(x, 4.0), 2.0, 3) ≈ 48.0 rtol = 1e-5
    @test eq_derivative(x -> eq_exp(x), 0.0, 4) ≈ 1.0 rtol = 1e-4
    @test eq_derivative(x -> eq_sin(x), 1.0, 0) ≈ sin(1.0)
    # complex values, complex point, matrices
    @test eq_derivative(x -> eq_exp(eq_mul(1.0im, x)), 0.0) ≈ 1.0im atol = 1e-8
    @test eq_derivative(x -> eq_pow(x, 2.0), 1.0 + 1.0im) ≈ 2.0 + 2.0im atol = 1e-7
    @test eq_derivative(x -> [x eq_pow(x, 2.0)], 3.0) ≈ [1.0 6.0] atol = 1e-7
    # f′(x) with a function value
    @test eq_derivative(eq_cos, 0.5) ≈ -sin(0.5) atol = 1e-8
end

@testset "derivative: units and errors" begin
    meter, second = u"m", u"s"
    v = eq_derivative(t -> 3.0 * meter * eq_pow(t, 2.0) / second^2, 2.0 * second)
    @test unit(v) == meter / second
    @test ustrip(v) ≈ 12.0 atol = 1e-7
    w = eq_derivative(t -> eq_pow(t, 3.0), 1.0 * second, 2)
    @test unit(w) == second
    @test ustrip(w) ≈ 6.0 atol = 1e-6
    @test_throws EqError eq_derivative(x -> x, 1.0, 1.5)
    @test_throws EqError eq_derivative(x -> x, 1.0, -1)
    @test_throws EqError eq_derivative(x -> "a", 1.0)
    @test_throws EqError eq_derivative(3.0, 1.0)
    @test_throws EqError eq_derivative(x -> x)
    @test_throws EqError eq_derivative(x -> NaN, 1.0)
end

@testset "Jacobian" begin
    f = x -> [x[1]^2*x[2] + x[2]^2*x[3]; sin(x[1]*x[2]);;]
    x = [2.0; 3.0; 5.0;;]
    expected = [12.0 34.0 9.0; 3cos(6.0) 2cos(6.0) 0.0]
    @test eq_jacob(f, x) ≈ expected atol=1e-7
    @test eq_jacob(f, x, 2) ≈ expected[:, 1:2] atol=1e-7
    @test with_origin(() -> eq_jacob(v -> [eq_index(v, 1)^2 + eq_index(v, 2);;], x), 1) ≈ [4.0 1.0 0.0] atol=1e-7
    @test eq_jacob(x -> [im*x[1]^2;;], [2.0;;]) ≈ [4im;;] atol=1e-7
    @test_throws EqError eq_jacob(f, x, 4)
    @test_throws EqError eq_jacob(f, x, 1.5)
    @test_throws EqError eq_jacob(f, [1.0 2.0])
    @test_throws EqError eq_jacob(x -> 1.0, x)
end
