# Test fixtures standing in for Julia package functions.
module InteropFixture
struct Plant
    gain::Float64
end
make_plant(g) = Plant(g)
gain(p::Plant) = p.gain
scale(p::Plant, x) = p.gain .* x
vec_sum(v::AbstractVector) = sum(v)
mat_kind(m) = m isa Matrix ? "matrix" : (m isa Vector ? "vector" : string(typeof(m)))
vec_kind(v) = v isa Vector ? "vector" : string(typeof(v))
elt(v) = string(eltype(v))
flag(x) = x > 0
nothing_fn(x) = nothing
pair(x) = (x, 2x)
named(x) = (a = x, b = [x, x + 1])
ints() = [1, 2, 3]
int_matrix() = [1 2; 3 4]
range_fn() = 1:3
boom(x) = throw(DomainError(x, "bad input"))
interrupt_fn(x) = throw(InterruptException())
fn_arg(f, x) = f(x)
three() = Float32(3)
str() = "text"
sym() = :abc
end

@testset "Julia interop" begin
    @testset "arguments to Julia" begin
        @test eq_julia_call(InteropFixture.vec_kind, eq_vec(1, 2, 3)) == "vector"
        @test eq_julia_call(InteropFixture.mat_kind, eq_matrix(2, 2, 1, 2, 3, 4)) == "matrix"
        # a 1xn row vector is a matrix, not a Vector
        @test eq_julia_call(InteropFixture.mat_kind, eq_rowvec(1, 2, 3)) == "matrix"
        @test eq_julia_call(InteropFixture.vec_sum, eq_vec(1, 2, 3)) == 6.0
        @test eq_julia_call(InteropFixture.elt, eq_vec(1, 2, 3)) == "Float64"
        @test eq_julia_call(InteropFixture.elt, eq_vec(1, 2im)) == "ComplexF64"
        @test eq_julia_call(identity, 2.5) === 2.5
        @test eq_julia_call(identity, 1 + 2im) === 1.0 + 2.0im
        @test eq_julia_call(identity, "s") == "s"
        @test eq_julia_call(identity, 3.0u"m") == 3.0u"m"
        # ranges are collected
        @test eq_julia_call(InteropFixture.vec_sum, eq_range(1, 4)) == 10.0
        # the callee cannot mutate the worksheet value
        v = eq_vec(1, 2, 3)
        eq_julia_call(w -> (w[1] = 99.0; 0.0), v)
        @test v == eq_vec(1, 2, 3)
        # no arguments
        @test eq_julia_call(InteropFixture.three) == 3.0
    end

    @testset "results from Julia" begin
        @test eq_julia_call(InteropFixture.flag, 1.0) === 1.0
        @test eq_julia_call(InteropFixture.flag, -1.0) === 0.0
        @test eq_julia_call(InteropFixture.ints) == eq_vec(1, 2, 3)
        @test eltype(eq_julia_call(InteropFixture.ints)) === Float64
        @test eq_julia_call(InteropFixture.int_matrix) == eq_matrix(2, 2, 1, 2, 3, 4)
        @test eq_julia_call(InteropFixture.range_fn) == eq_vec(1, 2, 3)
        @test eq_julia_call(InteropFixture.three) === 3.0
        @test eq_julia_call(InteropFixture.str) == "text"
        @test eq_julia_call(InteropFixture.sym) == "abc"
        @test eq_julia_call(identity, Rational(1, 2)) === 0.5
        @test eq_julia_call(identity, ComplexF32(1, 2)) === 1.0 + 2.0im
        # tuples and named tuples become nested column arrays
        pair = eq_julia_call(InteropFixture.pair, 3.0)
        @test pair == eq_vec(3, 6)
        named = eq_julia_call(InteropFixture.named, 1.0)
        @test size(named) == (2, 1)
        @test named[1] == 1.0
        @test named[2] == eq_vec(1, 2)
        # nothing is an error
        @test_throws EqError eq_julia_call(InteropFixture.nothing_fn, 1.0)
        # a result is always encodable
        @test encode_value(eq_julia_call(InteropFixture.pair, 1.0)).value["type"] == "matrix"
        # 3-D arrays are not worksheet values
        @test_throws EqError eq_julia_call(() -> zeros(2, 2, 2))
        # empty vector keeps its shape
        @test size(eq_julia_call(() -> Float64[])) == (0, 1)
    end

    @testset "opaque handles" begin
        clear_handles!()
        plant = eq_julia_call(InteropFixture.make_plant, 2.0)
        @test plant isa OpaqueHandle
        @test endswith(plant.julia_type, "InteropFixture.Plant")
        @test !isempty(plant.id)
        @test !isempty(plant.summary)
        @test handle_value(plant).gain == 2.0
        # the handle goes back to Julia as the object
        @test eq_julia_call(InteropFixture.gain, plant) == 2.0
        @test eq_julia_call(InteropFixture.scale, plant, eq_vec(1, 2)) == eq_vec(2, 4)
        # the same object keeps its handle
        again = eq_julia_call(() -> handle_value(plant))
        @test again isa OpaqueHandle && again.id == plant.id
        # handles encode and decode on the wire
        node = encode_value(plant).value
        @test node["type"] == "handle" && node["id"] == plant.id
        @test decode_value(encode_value(plant)) == plant
        # handles inside arrays survive both directions
        arr = eq_julia_call(() -> [InteropFixture.Plant(1.0), InteropFixture.Plant(2.0)])
        @test size(arr) == (2, 1) && arr[1] isa OpaqueHandle
        @test eq_julia_call(v -> sum(p.gain for p in v), arr) == 3.0
        # handles do not take part in arithmetic
        @test_throws EqError eq_add(plant, 1.0)
        # unknown handle ids are errors, and handles can be released
        @test_throws EqError eq_julia_call(InteropFixture.gain, OpaqueHandle("nope", "T", "s"))
        clear_handles!()
        @test_throws EqError eq_julia_call(InteropFixture.gain, plant)
        # per-worksheet handle ownership releases only handles exclusive to that worksheet
        h_a = with_handle_owner("sheet_a") do
            eq_julia_call(() -> InteropFixture.Plant(3.0))
        end
        h_b = with_handle_owner("sheet_b") do
            eq_julia_call(() -> InteropFixture.Plant(4.0))
        end
        @test eq_julia_call(InteropFixture.gain, h_a) == 3.0
        @test eq_julia_call(InteropFixture.gain, h_b) == 4.0
        release_handles!("sheet_a")
        @test_throws EqError eq_julia_call(InteropFixture.gain, h_a)
        @test eq_julia_call(InteropFixture.gain, h_b) == 4.0
        release_handles!("sheet_b")
        @test_throws EqError eq_julia_call(InteropFixture.gain, h_b)
    end

    @testset "functions and errors" begin
        # a worksheet function can be passed to Julia code
        @test eq_julia_call(InteropFixture.fn_arg, x -> eq_mul(x, 2.0), 4.0) == 8.0
        # Julia exceptions become EqError with type and message
        err = try
            eq_julia_call(InteropFixture.boom, 1.0)
        catch e
            e
        end
        @test err isa EqError
        @test occursin("DomainError", err.message)
        @test occursin("bad input", err.message)
        @test occursin("boom", err.message)
        # on error can catch them
        @test eq_try(() -> eq_julia_call(InteropFixture.boom, 1.0), () -> 7.0) == 7.0
        # EqError passes through unchanged, interrupts are never converted
        @test_throws EqError eq_julia_call(() -> eq_error("inner"))
        @test_throws InterruptException eq_julia_call(InteropFixture.interrupt_fn, 1.0)
        # a wrong call is an error, not a crash
        @test_throws EqError eq_julia_call(InteropFixture.gain, 1.0)
    end

    @testset "to_julia and from_julia" begin
        @test to_julia(eq_vec(1, 2)) isa Vector{Float64}
        @test to_julia(eq_matrix(2, 2, 1, 2, 3, 4)) isa Matrix{Float64}
        nested = to_julia(eq_vec(eq_vec(1, 2), eq_vec(3, 4)))
        @test nested isa Vector && nested[2] == [3.0, 4.0]
        @test from_julia(nested) == eq_vec(eq_vec(1, 2), eq_vec(3, 4))
        @test from_julia(true) === 1.0
        @test from_julia(7) === 7.0
        @test from_julia(Float32(0.5)) === 0.5
        @test from_julia(2.0u"m") == 2.0u"m"
        @test from_julia([1.5, 2.5]) == eq_vec(1.5, 2.5)
        @test_throws EqError from_julia(nothing)
        @test_throws EqError from_julia(missing)
    end
end

@testset "eq_norm" begin
    @test eq_norm(eq_vec(3, 4)) === 5.0
    @test eq_norm(eq_rowvec(3, 4)) === 5.0
    @test eq_norm(eq_vec(3 + 4im, 0)) === 5.0
    @test eq_norm(eq_vec(1, 2, 2)) === 3.0
    @test eq_norm(eq_vec(3u"m", 4u"m")) == 5u"m"
    @test eq_norm(-3.0) === 3.0
    @test eq_norm(3 + 4im) === 5.0
    @test eq_norm(eq_matrix(1, 1, -7)) === 7.0
    # error for matrices and non-numbers (not the determinant)
    @test_throws EqError eq_norm(eq_matrix(2, 2, 1, 2, 3, 4))
    @test_throws EqError eq_norm(eq_matrix(2, 3, 1, 2, 3, 4, 5, 6))
    @test_throws EqError eq_norm("a")
    @test_throws EqError eq_norm(Matrix{Float64}(undef, 0, 1))
end

@testset "eq_nthroot" begin
    @test eq_nthroot(8.0, 3.0) ≈ 2.0
    @test eq_nthroot(-8.0, 3.0) ≈ -2.0                   # real root, odd n
    @test eq_nthroot(-8.0, 3.0) isa Float64
    @test eq_nthroot(-32.0, 5.0) ≈ -2.0
    @test eq_nthroot(27.0, 3.0) == 3.0
    @test eq_nthroot(16.0, 4.0) ≈ 2.0
    @test eq_nthroot(9.0, 2.0) === 3.0
    @test eq_nthroot(0.0, 3.0) === 0.0
    @test eq_nthroot(-16.0, 4.0) ≈ complex(-16.0)^(1 / 4)   # even n: principal value
    @test eq_nthroot(-4.0, 2.0) ≈ 2.0im
    @test eq_nthroot(2.0, 2.5) ≈ 2.0^(1 / 2.5)
    @test eq_nthroot(-2.0, 2.5) ≈ complex(-2.0)^(1 / 2.5)  # non-integer n: principal value
    @test eq_nthroot(8.0, -3.0) ≈ 0.5
    @test eq_nthroot(-8.0, -3.0) ≈ -0.5
    @test eq_nthroot(1.0im, 2.0) ≈ sqrt(1.0im)
    @test eq_nthroot(8.0 + 0im, 3.0) ≈ 2.0                # complex type, real value
    @test eq_nthroot(eq_vec(8, -27), 3.0) ≈ eq_vec(2, -3)   # elementwise
    @test eq_nthroot(27.0u"m^3", 3.0) ≈ 3.0u"m"
    @test eq_nthroot(-27.0u"m^3", 3.0) ≈ -3.0u"m"
    @test eq_nthroot(8, 3) isa Float64
    @test_throws EqError eq_nthroot(8.0, 0.0)
    @test_throws EqError eq_nthroot(8.0, 3.0u"m")
    @test_throws EqError eq_nthroot(8.0, 1.0im)
    @test_throws EqError eq_nthroot(8.0, eq_vec(2, 3))
    @test_throws EqError eq_nthroot("a", 3.0)
end
