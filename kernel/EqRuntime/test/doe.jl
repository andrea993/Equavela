# Design of experiments, Monte Carlo and windows against the reference application's saved results


_mean(v) = sum(v) / length(v)
_std(v) = sqrt(sum(abs2, v .- _mean(v)) / (length(v) - 1))

const _y4 = reshape([10.0, 14, 18, 30], :, 1)
const _y8 = reshape([45.0, 71, 48, 65, 68, 60, 80, 65], :, 1)
const _Y42 = [10.0 11; 14 15; 18 17; 30 31]
const _Y82 = [45.0 43; 71 73; 48 50; 65 63; 68 70; 60 58; 80 81; 65 64]
_body(D) = Float64.(D[2:end, :])

@testset "design matrices" begin
    D2 = eq_fullfact(2.0)
    @test D2[1, :] == ["Run", "Block", "A", "B"]
    @test _body(D2) == [1 1 -1 -1; 2 1 1 -1; 3 1 -1 1; 4 1 1 1]
    @test _body(eq_fullfact(2.0, 3.0))[:, 3:4] == [0 0; 1 0; 2 0; 0 1; 1 1; 2 1; 0 2; 1 2; 2 2]
    @test size(eq_fullfact(4.0)) == (17, 6)
    F = eq_fractfact(5.0, 2.0)
    @test F[1, :] == ["Run", "Block", "A", "B", "C", "D=AB", "E=AC"]
    @test _body(F)[1, :] == [1, 1, -1, -1, -1, 1, 1]
    @test_throws EqError eq_fractfact(4.0)           # p must be a positive integer
    @test_throws EqError eq_fractfact(4.0, 3.0)      # not a valid design
    P = eq_plackettburman(8.0)
    @test _body(P)[1, 3:end] == [1, -1, -1, 1, -1, 1, 1]
    @test _body(P)[2, 3:end] == [1, 1, -1, -1, 1, -1, 1]
    @test all(==(-1), _body(P)[end, 3:end])
    @test size(eq_plackettburman(28.0)) == (29, 29)
    @test_throws EqError eq_plackettburman(4.0)
    @test_throws EqError eq_plackettburman(10.0)
    B = eq_boxbehnken(3.0)
    @test size(B) == (16, 5) && _body(B)[end, 3:end] == [0, 0, 0]
    @test _body(eq_boxbehnken(4.0))[10, 2] == 2     # the reference application's blocks
    @test_throws EqError eq_boxbehnken(2.0)
    @test_throws EqError eq_boxbehnken(8.0)
    @test _body(eq_taguchi(4.0, 3.0))[2, 3:end] == [1, 2, 2, 2]
    @test eq_taguchi(31.0, 2.0)[1, 29] == "A1"
    @test_throws EqError eq_taguchi(5.0, 2.0)
end

@testset "randomize, foldover and doelabel" begin
    D3 = eq_fullfact(3.0)
    R = eq_randomize(D3)
    @test R[1, :] == D3[1, :] && sort(eachrow(_body(R))) == sort(eachrow(_body(D3)))
    P = eq_plackettburman(8.0)
    full = eq_foldover(P)
    @test size(full) == (17, 9) && _body(full)[9, 1:2] == [9, 2] && _body(full)[9, 3:end] == -_body(P)[1, 3:end]
    one = eq_foldover(P, "A")
    @test _body(one)[9, 3:end] == [-1, -1, -1, 1, -1, 1, 1]
    @test_throws EqError eq_foldover(P, 1.0)
    L = eq_doelabel(eq_fullfact(2.0), Any["Temp" 100.0 200.0; "Press" 1.0 2.0])
    @test L[1, 3:4] == ["Temp", "Press"] && L[2:end, 3] == [100, 200, 100, 200]
    @test eq_doelabel(eq_fullfact(2.0), Any["Catalyst" "X" "Y"; "Mixer" "slow" "fast"])[3, 3:4] == ["Y", "slow"]
    @test_throws EqError eq_doelabel(eq_fullfact(2.0), Any["Temp" 100.0; "Press" 1.0])
    @test_throws EqError eq_doelabel(eq_fullfact(2.0), Any["Temp" 100.0 200.0])
end

@testset "effects, quickscreen and anova" begin
    D2, D3 = eq_fullfact(2.0), eq_fullfact(3.0)
    E = eq_effects(D2, _y4)
    @test E[:, 1] == ["Factor", "A", "B"] && E[2, 2] == Any["Level of A" "Effect of A"; -1.0 -4.0; 1.0 4.0]
    E3 = eq_effects(D3, _Y82, 3.0)
    @test E3[5, 2][2:end, 3] ≈ [-2.375, 2.375, 2.375, -2.375]
    @test E3[end, 1] == "A.B.C" && E3[end, 2][2, 4] ≈ -0.875          # the ANOVA term (the reference application shows -9.375)
    @test eq_effects(D3, _Y82, "AB")[1, :] == ["Level of A", "Level of B", "Effect of A.B"]
    @test_throws EqError eq_effects(D3, _Y82, 0.05)
    Q = eq_quickscreen(D3, _y8, 2.0)
    @test Q[:, 1] == ["Factor", "A", "B", "C", "AB", "AC", "BC"]
    @test Float64.(Q[6, 2:4]) ≈ [71, 54.5, -16.5]
    @test_throws EqError eq_quickscreen(eq_fullfact(2.0, 3.0), reshape(1.0:9, :, 1))
    A = eq_anova(D2, _Y42)
    @test A[:, 1] == ["Source", "A", "B", "Error", "Total"]
    @test Float64.(A[2, 2:6]) ≈ [144.5, 1, 144.5, 17, 0.00914619] rtol = 1e-5
    @test Float64.(A[4, 2:4]) ≈ [42.5, 5, 8.5] && isnan(A[4, 5]) && isnan(A[5, 4])
    @test Float64.(eq_anova(D3, _Y82, 3.0)[8, 2:6]) ≈ [12.25, 1, 12.25, 7.53846, 0.0252289] rtol = 1e-5
    D23 = eq_fullfact(2.0, 3.0)
    Y92 = [1.0 2; 3 4; 5 6; 2 3; 4 5; 6 7; 3 3; 5 5; 7 8]
    @test Float64.(eq_anova(D23, Y92)[2, 2:5]) ≈ [52.1111, 2, 26.0556, 91] rtol = 1e-5
    @test_throws EqError eq_anova(D2, _y4)                # one replicate
    @test_throws EqError eq_effects(D2, reshape([1.0, 2, 3], :, 1))
end

@testset "random generators and montecarlo" begin
    @test eq_Normal(1.0) isa Float64
    @test size(eq_Normal(5.0)) == (5, 1)
    @test_throws EqError eq_Uniform(2.5)
    u = vec(eq_Uniform(20000.0))
    @test -6 <= minimum(u) && maximum(u) <= 6 && abs(_std(u) - 12 / sqrt(12)) < 0.1
    @test abs(_mean(vec(eq_Weibull(20000.0))) - 1) < 0.05
    f(x, y) = 2x + 0.5y
    M = eq_montecarlo(f, 4.0, Any["X" 7.5 1.2; "Y" 5 0.84])
    @test size(M) == (5, 3) && M[1, :] == ["X", "Y", "Output"]
    @test all(M[i, 3] ≈ 2M[i, 1] + 0.5M[i, 2] for i in 2:5)
    clipped = Float64.(eq_montecarlo(x -> x, 20000.0, Any["X" 3 2], [2.0 4.0])[2:end, 1])
    @test 2 <= minimum(clipped) && maximum(clipped) <= 4 && abs(_std(clipped) - 0.566) < 0.02   # drawn again
    same = eq_montecarlo(x -> x, 3.0, Any["X" 0 1], [NaN NaN], [n -> n])
    @test all(==(1.0), same[2:end, 1])                    # a user distribution is called with 1
    @test all(==(3.0), eq_montecarlo(x -> x, 3.0, Any["X" 3 0])[2:end, 1])
    @test_throws EqError eq_montecarlo(x -> x, 3.0, Any["X" 3 -1])
    @test_throws EqError eq_montecarlo(x -> x, 3.0, Any["X" 10 1], [11.0 12.0])
    @test_throws EqError eq_montecarlo(x -> x, 3.0, Any["X" 10 1], [5.0 9.0])
    @test_throws EqError eq_montecarlo((x, y) -> x, 3.0, Any["X" 3 1])
    @test_throws EqError eq_montecarlo(x -> x, 0.0, Any["X" 3 1])
end

@testset "windows" begin
    @test vec(eq_triangular(5.0)) == [0, 0.5, 1, 0.5, 0]
    @test vec(eq_triangular(2.0)) == [0, 0]
    @test_throws EqError eq_triangular(1.0)
    @test vec(eq_hamming(5.0)) ≈ [0.08, 0.54, 1, 0.54, 0.08]
    @test vec(eq_hanning(5.0)) ≈ [0, 0.5, 1, 0.5, 0] atol = 1e-15
    @test vec(eq_blackman(5.0)) ≈ [0, 0.34, 1, 0.34, 0] atol = 1e-15
    @test vec(eq_gaussian(5.0, 1.0)) ≈ [0.606531, 0.882497, 1, 0.882497, 0.606531] rtol = 1e-5
end
