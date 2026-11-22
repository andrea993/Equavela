using Test
using Unitful

@testset "graphical statistics" begin
    h = EqRuntime.eq_histogram(eq_vec(0, 1, 2), eq_vec(0, 1, 2, 3))
    @test h == [0.5 1; 1.5 2]
    @test EqRuntime.eq_hist(2, eq_vec(0, 1, 2)) == reshape([1.0, 2.0], :, 1)
    hu = EqRuntime.eq_histogram(eq_vec(0u"m", 1u"m", 2u"m"), eq_vec(50u"cm", 150u"cm"))
    @test hu[:, 1] == [0.5u"m", 1.5u"m"]
    @test hu[:, 2] == [1, 1]
    @test_throws EqError EqRuntime.eq_hist(eq_vec(0, 0), eq_vec(1))
    @test EqRuntime.eq_hist(3, eq_vec(2, 2)) == reshape([0, 0, 2], :, 1)
    b = EqRuntime.eq_boxplot(eq_vec(1, 2, 3, 4, 100))
    @test vec(b) == [2, 3, 4, 1, 4, 100]
    b2 = EqRuntime.eq_boxplot([1 1; 2 2; 3 3; 4 4; 100 NaN])
    @test b2[6,1] == 100 && isnan(b2[6,2])
    g = EqRuntime.eq_boxplotgraph(eq_vec(1, 2, 3, 4, 100))
    @test size(g) == (2, 1)
    @test size(g[1]) == size(g[2])
    @test 100 in g[2]
    gu = EqRuntime.eq_boxplotgraph([1u"m" 2u"m"; 2u"m" 3u"m"; 3u"m" 4u"m"])
    @test size(gu[1], 2) == size(gu[2], 2) == 1
    @test size(gu[1]) == size(gu[2])
    @test 0.75 in gu[1] && 1.75 in gu[1]
    @test any(v -> isnan(ustrip(v)), gu[2])
    @test all(v -> v isa Unitful.AbstractQuantity && Unitful.dimension(v) == Unitful.dimension(1u"m"), gu[2])
    p = EqRuntime.eq_pareto(Any["a" 1; "b" 3; "c" 2])
    @test p[:,1] == ["b", "c", "a"]
    @test p[:,2] == [3, 2, 1]
    @test p[:,3] ≈ [50, 250/3, 100]
    @test_throws EqError EqRuntime.eq_pareto(Any["a" 0])
    q = EqRuntime.eq_qqplot(eq_vec(3+1im, 1+2im, 2-1im))
    @test q[:,1] == [1, 2, 3]
    @test EqRuntime.eq_qqplot(eq_vec(Complex(3, Inf), Complex(1, NaN)))[:,1] == [1, 3]
    @test q[2,2] ≈ 0 atol=1e-14
    @test EqRuntime.eq_qqplot(eq_vec(2, 1), "weibull")[:,1] ≈ [0, log(2)]
    same = EqRuntime.eq_qqplot(eq_vec(3, 1, 2), eq_vec(3, 1, 2))
    @test same[:,1] == same[:,2] == [1, 2, 3]
    unequal = EqRuntime.eq_qqplot(eq_vec(1,2,3), eq_vec(10,20))
    @test unequal[:,2] ≈ [10, 15, 20]
    @test_throws EqError EqRuntime.eq_qqplot(eq_vec(0, 1), "weibull")
end
