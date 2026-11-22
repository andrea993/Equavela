# Random-number built-ins. The sequence is not
# the reference application's, so the tests check the shape, the distribution, the advance/reset behaviour and the
# argument errors, never fixed values.

@testset "rnorm: shape and result" begin
    EqRuntime._reset_random!(1)
    values = eq_rnorm(5, 0, 1)
    @test values isa Matrix{Float64}
    @test size(values) == (5, 1)
    @test all(isfinite, values)
    @test size(eq_rnorm(1, 10, 2)) == (1, 1)
end

@testset "rnorm: the distribution" begin
    EqRuntime._reset_random!(7)
    values = vec(eq_rnorm(100_000, 10, 2))
    average = sum(values) / length(values)
    spread = sqrt(sum(abs2, values .- average) / length(values))
    @test average ≈ 10 atol = 0.05
    @test spread ≈ 2 atol = 0.02
end

@testset "rnorm: each call advances the generator, a reset repeats it" begin
    EqRuntime._reset_random!(42)
    first = eq_rnorm(1000, 0, 1)
    second = eq_rnorm(1000, 0, 1)
    @test first != second
    EqRuntime._reset_random!(42)
    @test eq_rnorm(1000, 0, 1) == first
end

@testset "kernel initialization seeds from the timestamp" begin
    EqRuntime._reset_random!(1)
    fixed = eq_rnorm(10, 0, 1)
    EqRuntime.__init__()
    first = eq_rnorm(10, 0, 1)
    @test first != fixed
    sleep(0.002) # Separate initializations beyond the timestamp's microsecond resolution.
    EqRuntime.__init__()
    @test eq_rnorm(10, 0, 1) != first
end

@testset "rnorm: argument errors" begin
    @test_throws EqError eq_rnorm(0, 0, 1)
    @test_throws EqError eq_rnorm(-1, 0, 1)
    @test_throws EqError eq_rnorm(2.5, 0, 1)
    @test_throws EqError eq_rnorm(eq_mul(2, eq_unit("m")), 0, 1)
    @test_throws EqError eq_rnorm(3, eq_mul(1, eq_unit("m")), 1)
    @test_throws EqError eq_rnorm(3, 0, eq_mul(1, eq_unit("m")))
    @test_throws EqError eq_rnorm(3, 0, 0)
    @test_throws EqError eq_rnorm(3, 0, -1)
    @test_throws EqError eq_rnorm(3, 1im, 1)
    @test_throws EqError eq_rnorm(3, 0, 1im)
    @test_throws EqError eq_rnorm(3, "a", 1)
    # A dimensionless quantity is unitless.
    @test size(eq_rnorm(2, eq_mul(30, eq_unit("deg")), 1)) == (2, 1)
end

@testset "rnd: scalar bounds, distribution and shared state" begin
    EqRuntime._reset_random!(23)
    values = [eq_rnd(4) for _ in 1:100_000]
    @test all(x -> x isa Float64 && 0 <= x < 4, values)
    @test sum(values) / length(values) ≈ 2 atol = 0.02
    @test sum(abs2, values .- 2) / length(values) ≈ 4 / 3 atol = 0.02
    @test eq_rnd(0) === 0.0
    @test -4 < eq_rnd(-4) <= 0
    EqRuntime._reset_random!(23)
    @test eq_rnd(4) == first(values)
    first_normal = eq_rnorm(5, 0, 1)
    EqRuntime._reset_random!(23)
    eq_rnd(4)
    @test eq_rnorm(5, 0, 1) == first_normal
    @test eq_rnd(eq_mul(30, eq_unit("deg"))) isa Float64
end

@testset "rnd: invalid arguments do not advance the RNG" begin
    for bound in (Inf, -Inf, NaN, 1im, "a", [1, 2], eq_unit("m"))
        EqRuntime._reset_random!(19)
        @test_throws EqError eq_rnd(bound)
        after_error = eq_rnd(1)
        EqRuntime._reset_random!(19)
        @test eq_rnd(1) == after_error
    end
end

@testset "rnd: representable endpoints" begin
    tiny = nextfloat(0.0)
    @test all(_ -> eq_rnd(tiny) == 0, 1:100)
    @test all(_ -> eq_rnd(-tiny) == 0, 1:100)
    @test 0 <= eq_rnd(2 + 0im) < 2
end

@testset "Seed: validation, previous seed and shared-stream replay" begin
    EqRuntime._reset_random!(123)
    @test eq_Seed(42) == 123
    expected = (eq_rnd(1), eq_rnorm(3, 0, 1), eq_rbeta(3, 2, 3))
    @test eq_Seed(42) == 42
    @test (eq_rnd(1), eq_rnorm(3, 0, 1), eq_rbeta(3, 2, 3)) == expected
    eq_Seed(42)
    for invalid in (0, -1, 2147483648, 1.5, Inf, NaN, 1 + im,
                    reshape([1, 2], :, 1), eq_unit("m"))
        @test_throws EqError eq_Seed(invalid)
    end
    @test (eq_rnd(1), eq_rnorm(3, 0, 1), eq_rbeta(3, 2, 3)) == expected
    @test eq_Seed(2147483647) == 42
    @test eq_Seed(eq_div(eq_unit("m"), eq_unit("m"))) == 2147483647
    before = floor(Int, time() * 1_000_000)
    EqRuntime.__init__()
    after = floor(Int, time() * 1_000_000)
    @test before <= eq_Seed(1) <= after
end
