# Built-in functions (batch 6): sign/angle, hyperbolic, strings, polynomials.

@testset "sign, signum, csgn, arg, angle" begin
    @test eq_sign(-3.5) === -1.0
    @test eq_sign(0.0) === 0.0
    @test eq_sign(eq_vec(2, -2, 0)) == eq_vec(1, -1, 0)
    @test eq_sign(5.0u"m") === 1.0
    @test_throws EqError eq_sign(1.0im)
    @test_throws EqError eq_sign("a")
    @test eq_signum(-4.0) === -1.0
    @test eq_signum(0.0) === 1.0
    @test eq_signum(0.0, 0.0) === 0.0
    @test eq_signum(3.0 + 4.0im) ≈ 0.6 + 0.8im
    @test eq_signum(eq_vec(0, -2, 5), 7.0) == eq_vec(7, -1, 1)
    @test eq_csgn(0.0) === 0.0
    @test eq_csgn(2.0 - 5.0im) === 1.0
    @test eq_csgn(-2.0 + 5.0im) === -1.0
    @test eq_csgn(3.0im) === 1.0
    @test eq_csgn(-3.0im) === -1.0
    @test eq_csgn(-1.0) === -1.0
    @test eq_arg(1.0im) ≈ π / 2
    @test eq_arg(-1.0) ≈ π
    @test eq_arg(-1.0 - 0.0im) ≈ -π
    @test eq_arg(0.0) === 0.0
    @test eq_arg(eq_vec(1, -1im)) ≈ eq_vec(0, -π / 2)
    @test eq_arg(1.0 + 1.0im) ≈ π / 4
    @test_throws EqError eq_arg("x")
    @test eq_angle(1.0, 0.0) === 0.0
    @test eq_angle(0.0, 1.0) ≈ π / 2
    @test eq_angle(-1.0, 0.0) ≈ π
    @test eq_angle(0.0, -1.0) ≈ 3π / 2
    @test eq_angle(1.0, -1.0) ≈ 7π / 4
    @test eq_angle(eq_vec(1, -1), 0.0) ≈ eq_vec(0, π)
    @test_throws EqError eq_angle(0.0, 0.0)
end

@testset "hyperbolic and extra trigonometric functions" begin
    @test eq_sinh(1.0) ≈ sinh(1.0)
    @test eq_cosh(eq_vec(0, 1)) ≈ eq_vec(1, cosh(1.0))
    @test eq_tanh(0.5) ≈ tanh(0.5)
    @test eq_asinh(2.0) ≈ asinh(2.0)
    @test eq_acosh(2.0) ≈ acosh(2.0)
    @test eq_acosh(0.5) ≈ acosh(complex(0.5))
    @test eq_atanh(0.5) ≈ atanh(0.5)
    @test eq_atanh(2.0) ≈ atanh(complex(2.0))
    @test eq_csch(1.0) ≈ 1 / sinh(1.0)
    @test eq_sech(1.0) ≈ 1 / cosh(1.0)
    @test eq_coth(1.0) ≈ 1 / tanh(1.0)
    @test eq_acsch(2.0) ≈ asinh(0.5)
    @test eq_asech(0.5) ≈ acosh(2.0)
    @test eq_acoth(2.0) ≈ atanh(0.5)
    @test eq_csc(1.0) ≈ 1 / sin(1.0)
    @test eq_sec(1.0) ≈ 1 / cos(1.0)
    @test eq_cot(1.0) ≈ 1 / tan(1.0)
    @test eq_acsc(2.0) ≈ asin(0.5)
    @test eq_asec(2.0) ≈ acos(0.5)
    @test eq_acot(2.0) ≈ atan(0.5)
    @test eq_acot(0.0) ≈ π / 2
    @test eq_sinc(0.0) === 1.0
    @test eq_sinc(2.0) ≈ sin(2.0) / 2
    @test_throws EqError eq_csc(0.0)
    @test_throws EqError eq_coth(0.0)
    @test_throws EqError eq_acsc(0.0)
    @test_throws EqError eq_sinh(1.0u"m")
    @test eq_sinh(1.0u"rad") ≈ sinh(1.0)
    @test eq_ln0(0.0) == -1e307
    @test eq_ln0(1.0) == 0.0
    @test eq_ln0(eq_vec(0, ℯ)) ≈ eq_vec(-1e307, 1)
    @test eq_isnan(NaN) === 1.0
    @test eq_isnan(1.0) === 0.0
    @test eq_isnan(eq_vec(1, NaN)) == eq_vec(0, 1)
    @test eq_isnan(complex(1.0, NaN)) === 1.0
    @test eq_isnan("a") === 0.0
end

@testset "strings" begin
    @test eq_concat("ab", "cd", "e") == "abcde"
    @test_throws EqError eq_concat("a", 1.0)
    @test_throws EqError eq_concat()
    @test eq_strlen("héllo") === 5.0
    @test_throws EqError eq_strlen(3.0)
    @test eq_substr("abcdef", 1.0, 3.0) == "bcd"
    @test eq_substr("abcdef", 4.0, 10.0) == "ef"
    @test eq_substr("abc", 3.0, 1.0) == ""
    # String positions count from ORIGIN, as array indices.
    with_origin(1) do
        @test eq_substr("abcdef", 1.0, 3.0) == "abc"
        @test eq_search("abcabc", "bc", 2.0) === 2.0
        @test eq_search("abcabc", "bc", 3.0) === 5.0
    end
    @test_throws EqError eq_substr("abc", 4.0, 1.0)
    @test_throws EqError eq_substr("abc", -1.0, 1.0)
    @test_throws EqError eq_substr("abc", 0.0, -1.0)
    @test eq_search("abcabc", "bc", 0.0) === 1.0
    @test eq_search("abcabc", "bc", 2.0) === 4.0
    @test eq_search("abc", "zz", 0.0) === -1.0
    @test eq_search("abc", "", 0.0) === 0.0
    @test_throws EqError eq_search("abc", "a", 9.0)
    @test eq_num2str(5.0) == "5"
    @test eq_num2str(-2.5) == "-2.5"
    @test eq_num2str(1 / 3) == "0.333"
    @test eq_num2str(3.14159) == "3.142"
    @test eq_num2str(0.0) == "0"
    @test eq_num2str(1.0 + 2.0im) == "1+2i"
    @test eq_num2str(1.5 - 0.25im) == "1.5-0.25i"
    @test eq_num2str(2.0im) == "0+2i"
    @test eq_num2str(1e-5) == "1.0e-5" || eq_num2str(1e-5) == "1e-5"
    @test eq_num2str(NaN) == "NaN"
    @test eq_num2str(Inf) == "∞"
    @test_throws EqError eq_num2str("a")
    @test eq_str2num("12.5") === 12.5
    @test eq_str2num(" -2e3 ") === -2000.0
    @test eq_str2num("1+2i") === 1.0 + 2.0im
    @test eq_str2num("3j") === 0.0 + 3.0im
    @test eq_str2num("1 - i") === 1.0 - 1.0im
    @test_throws EqError eq_str2num("abc")
    @test_throws EqError eq_str2num("")
    @test eq_vec2str(eq_vec(72, 105)) == "Hi"
    @test eq_vec2str(eq_rowvec(72, 105)) == "Hi"
    @test_throws EqError eq_vec2str(eq_vec(5))
    @test_throws EqError eq_vec2str(eq_vec(72.5))
    @test eq_str2vec("Hi") == eq_vec(72, 105)
    @test_throws EqError eq_str2vec("")
    @test eq_format("a={0}, b={1}, a again {0}", 1.5, "x") == "a=1.5, b=x, a again 1.5"
    @test_throws EqError eq_format("{2}", 1.0)
    @test eq_num2str(eq_str2num(eq_num2str(0.25))) == "0.25"
end

@testset "orthogonal polynomials and small special functions" begin
    @test eq_Leg(0.0, 0.3) === 1.0
    @test eq_Leg(1.0, 0.3) ≈ 0.3
    @test eq_Leg(2.0, 0.3) ≈ (3 * 0.09 - 1) / 2
    @test eq_Leg(3.0, 0.5) ≈ (5 * 0.125 - 3 * 0.5) / 2
    @test eq_Tcheb(3.0, 0.3) ≈ cos(3acos(0.3))
    @test eq_Tcheb(0.0, 0.3) === 1.0
    @test eq_Ucheb(2.0, 0.3) ≈ 4 * 0.09 - 1
    @test eq_Ucheb(1.0, 0.3) ≈ 0.6
    @test eq_Her(2.0, 0.5) ≈ 4 * 0.25 - 2
    @test eq_Her(3.0, 0.5) ≈ 8 * 0.125 - 12 * 0.5
    @test eq_Lag(2.0, 1.0) ≈ (1 - 4 + 2) / 2
    @test eq_Lag(1.0, 0.25) ≈ 0.75
    @test eq_Leg(2.0, eq_vec(0, 1)) ≈ eq_vec(-0.5, 1)
    @test_throws EqError eq_Leg(-1.0, 0.0)
    @test_throws EqError eq_Tcheb(1.5, 0.0)
    @test_throws EqError eq_Her(1.0, 1.0u"m")
    @test eq_δ(2.0, 2.0) === 1.0
    @test eq_δ(2.0, 3.0) === 0.0
    @test_throws EqError eq_δ(2.5, 2.5)
    @test eq_Φ(-1.0) === 0.0
    @test eq_Φ(2.0) === 1.0
    @test eq_Φ(0.0) === 0.5
    @test eq_Φ(eq_vec(-1, 0, 3)) == eq_vec(0, 0.5, 1)
    @test eq_ε(0.0, 1.0, 2.0) === 1.0
    @test eq_ε(1.0, 0.0, 2.0) === -1.0
    @test eq_ε(2.0, 0.0, 1.0) === 1.0
    @test eq_ε(0.0, 0.0, 1.0) === 0.0
    @test eq_ε(0.0, 1.0, 3.0) === 0.0
    with_origin(1) do
        @test eq_ε(1.0, 2.0, 3.0) === 1.0
    end
end
