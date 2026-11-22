# The Float64 fast paths (fastpaths.jl) must agree with the general methods on every input.
using Random

general(f, args...) = invoke(f, Tuple{(Any for _ in args)...}, args...)
same(a, b) = (a === b) || (a isa Number && b isa Number && isnan(a) && isnan(b))

@testset "Float64 fast paths agree with the general methods" begin
    values = [0.0, -0.0, 1.0, -1.0, 2.5, 1e-13, 1e300, -1e300, NaN, Inf, -Inf, 3.0, 3.0 + 1e-13]
    append!(values, randn(MersenneTwister(1), 12))
    for a in values, b in values
        for f in (EqRuntime.eq_add, EqRuntime.eq_sub, EqRuntime.eq_mul, EqRuntime.eq_lt, EqRuntime.eq_gt,
                  EqRuntime.eq_le, EqRuntime.eq_ge, EqRuntime.eq_eq, EqRuntime.eq_ne)
            @test same(f(a, b), general(f, a, b))
        end
        @test same(EqRuntime.eq_min(a, b), invoke(EqRuntime.eq_min, Tuple{Vararg{Any}}, a, b))
        @test same(EqRuntime.eq_max(a, b), invoke(EqRuntime.eq_max, Tuple{Vararg{Any}}, a, b))
        if b == 0
            @test_throws EqError EqRuntime.eq_div(a, b)
        else
            @test same(EqRuntime.eq_div(a, b), general(EqRuntime.eq_div, a, b))
        end
    end
    for a in values
        @test EqRuntime.eq_true(a) == invoke(EqRuntime.eq_true, Tuple{Number}, a)
    end
    EqRuntime.with_exact_boolean(true) do
        @test EqRuntime.eq_eq(3.0, 3.0 + 1e-13) == 0.0 == general(EqRuntime.eq_eq, 3.0, 3.0 + 1e-13)
        @test EqRuntime.eq_ne(3.0, 3.0 + 1e-13) == 1.0 == general(EqRuntime.eq_ne, 3.0, 3.0 + 1e-13)
    end
    EqRuntime.with_exact_boolean(false) do
        @test EqRuntime.eq_eq(3.0, 3.0 + 1e-13) == 1.0 == general(EqRuntime.eq_eq, 3.0, 3.0 + 1e-13)
    end
    # Other element types keep the general behaviour.
    @test EqRuntime.eq_lt(1.0, 2.0 + 0im) == 1.0
    @test_throws EqError EqRuntime.eq_add("a", 1.0)
end

@testset "Float64 index fast paths" begin
    v = reshape([10.0, 20.0, 30.0], :, 1)
    for index in (0.0, 1.0, 2.0, -0.0), origin in (0, 1)
        EqRuntime.with(EqRuntime.ORIGIN => origin) do
            ok = 1 <= Int(index) - origin + 1 <= 3
            if ok
                @test EqRuntime.eq_index(v, index) == invoke(EqRuntime.eq_index, Tuple{AbstractMatrix,Any}, v, index)
            else
                @test_throws EqError EqRuntime.eq_index(v, index)
            end
        end
    end
    @test_throws EqError EqRuntime.eq_index(v, 3.0)
    @test_throws EqError EqRuntime.eq_index(v, 0.5)
    @test_throws EqError EqRuntime.eq_index(v, NaN)
    @test_throws EqError EqRuntime.eq_index(v, Inf)
    @test_throws EqError EqRuntime.eq_index(v, 1e30)
    @test_throws EqError EqRuntime.eq_index(reshape([1.0, 2.0, 3.0, 4.0], 2, 2), 1.0)
    matrix = [1.0 2.0; 3.0 4.0]
    @test EqRuntime.eq_index(matrix, 1.0, 0.0) == 3.0
    @test_throws EqError EqRuntime.eq_index(matrix, 2.0, 0.0)
    # In-range writes are in place; a write past the end grows the array and keeps Float64.
    w = reshape([1.0, 2.0, 3.0], :, 1)
    @test EqRuntime.eq_setindex!(w, 9.0, 1.0) === w
    @test w[2, 1] == 9.0
    grown = EqRuntime.eq_setindex!(w, 7.0, 5.0)
    @test grown isa Matrix{Float64}
    @test size(grown) == (6, 1) && grown[6, 1] == 7.0 && grown[4, 1] == 0.0
    @test_throws EqError EqRuntime.eq_setindex!(w, 1.0, -1.0)
    @test_throws EqError EqRuntime.eq_setindex!(w, 1.0, 0.5)
    other = EqRuntime.eq_setindex!(reshape([1.0, 2.0], :, 1), 1.0 + 2.0im, 0.0)
    @test other[1, 1] == 1.0 + 2.0im
    @test EqRuntime.eq_setindex!(matrix, 5.0, 0.0, 1.0) === matrix
    @test matrix[1, 2] == 5.0
    @test EqRuntime.eq_val(w) == w && EqRuntime.eq_val(w) !== w
end

@testset "Float64 ranges" begin
    ascending = EqRuntime.eq_range(1.0, 4.0)
    @test collect(ascending) == [1.0, 2.0, 3.0, 4.0]
    @test collect(EqRuntime.eq_range(3.0, 1.0)) == [3.0, 2.0, 1.0]
    @test collect(EqRuntime.eq_range(2.0, 2.0)) == [2.0]
    @test collect(EqRuntime.eq_range(1.0, 2.5)) == [1.0, 2.0]
    @test_throws EqError EqRuntime.eq_range(1.0, Inf)
end

@testset "Index operations with a hoisted ORIGIN" begin
    for origin in (0, 1, 2)
        EqRuntime.with_origin(origin) do
            o = EqRuntime.origin()
            v = reshape([10.0, 20.0, 30.0], :, 1)
            for index in Float64.(origin .+ (-1:3))
                if 0 <= index - origin < 3
                    @test EqRuntime.eq_index_o(v, index, o) == EqRuntime.eq_index(v, index)
                else
                    @test_throws EqError EqRuntime.eq_index_o(v, index, o)
                end
            end
            w = copy(v)
            @test EqRuntime.eq_setindex_o!(w, 5.0, Float64(origin), o) === w
            @test w[1, 1] == 5.0
            grown = EqRuntime.eq_setindex_o!(w, 7.0, Float64(origin + 4), o)
            @test size(grown) == (5, 1) && grown[5, 1] == 7.0
            m = [1.0 2.0; 3.0 4.0]
            @test EqRuntime.eq_index_o(m, Float64(origin + 1), Float64(origin), o) == 3.0
            @test EqRuntime.eq_setindex_o!(m, 9.0, Float64(origin), Float64(origin + 1), o) === m
            @test m[1, 2] == 9.0
            # Other value types go through the general methods.
            @test EqRuntime.eq_index_o(Any["a", "b"][:, :], Float64(origin), o) == EqRuntime.eq_index(Any["a", "b"][:, :], Float64(origin))
            @test EqRuntime.eq_setindex_o!(copy(v), "x", Float64(origin), o)[1, 1] == "x"
        end
    end
end
