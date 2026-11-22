# Invariants of the interpolation and regression built-ins.
col(v) = reshape(Float64.(collect(v)), :, 1)

@testset "Interpolation: B-splines, loess, Spline2" begin
    xs, ys = col(0:5), col([1, 4, 2, 5, 3, 6])
    spline = EqRuntime.eq_bspline(xs, ys, col([0, 2, 4, 5]), 3)
    @test [EqRuntime.eq_interp(spline, xs, ys, k) for k in 0:5] ≈ vec(ys)
    @test_throws EqError EqRuntime.eq_bspline(xs, ys, col([0, 2, 4]), 3)
    @test_throws EqError EqRuntime.eq_bspline(xs, ys, col([1, 2, 4, 5]), 3)
    line = col(2 .* (0:9) .+ 1)
    loess = EqRuntime.eq_loess(col(0:9), line, 0.6)
    @test EqRuntime.eq_interp(loess, col(0:9), line, 3.5) ≈ 8
    @test EqRuntime.eq_interp(loess, col(0:9), line, col([1, 2])) ≈ col([3, 5])
    grid = [Float64(i + 2j) for i in 0:4, j in 0:4]
    plane = EqRuntime.eq_loess(hcat(repeat(col(0:4), 5), repeat(col(0:4), inner=(5, 1))), col(vec([i + 2j for i in 0:4, j in 0:4])), 1.0)
    @test EqRuntime.eq_interp(plane, xs, ys, col([1.5, 2.5])) ≈ 6.5
    x = col(0:0.5:10)
    y = col(0.2 .* (0:0.5:10) .^ 2 .+ 0.01 .* sin.(7 .* (0:0.5:10)))
    fit = EqRuntime.eq_Spline2(x, y, 3)
    @test 0 <= EqRuntime.eq_DWS(fit) <= 4
    values = EqRuntime.eq_Binterp(4.0, fit)
    @test length(values) == 4
    @test values[1] ≈ 3.2 atol = 0.05
    @test values[2] ≈ 1.6 atol = 0.1
    @test_throws EqError EqRuntime.eq_Binterp(1.0, col(1:10))
    @test EqRuntime.eq_DWS(EqRuntime.eq_Spline2(x, y, 2, nothing, col([2.5, 5, 7.5]))) isa Float64
    # Saved the reference application results (12 noisy points): the knots are all the knots, the ends included.
    sx = col(0:11)
    sy = col([1.0, 1.6, 2.7, 3.1, 3.2, 4.4, 5.9, 6.0, 6.3, 7.8, 9.1, 9.0])
    auto = vec(EqRuntime.eq_Spline2(sx, sy, 3))
    @test length(auto) == 13
    @test auto[1:4] == [4, 1, 0, 11]
    @test auto[5:8] ≈ [1.08022, 3.14465, 6.42257, 9.31099] atol = 1e-5
    @test auto[9] ≈ 0.454668 atol = 1e-6
    @test auto[10] == 0
    @test auto[11] ≈ 2.21437 atol = 1e-5
    @test EqRuntime.eq_DWS(col(auto)) ≈ 2.21437 atol = 1e-5
    given = vec(EqRuntime.eq_Spline2(sx, sy, 3, col([3, 6, 9])))
    @test given[1:5] == [4, 2, 3, 6, 9]
    @test given[6:10] ≈ [3.11325, 2.00588, 8.01694, 5.13445, 7.80611] atol = 1e-5
    @test given[11] ≈ 0.125609 atol = 1e-6
    @test given[13] ≈ 3.74156 atol = 1e-5
    @test isequal(vec(EqRuntime.eq_Spline2(sx, sy, 3, nothing, col([3, 6, 9]))), given)
    @test vec(EqRuntime.eq_Spline2(sx, sy, 3, col(ones(12)), col([3, 6, 9]), 0.5))[6:10] ≈ given[6:10]
    # Knots outside the data are clipped to its range; one degree of freedom left negates the error.
    @test vec(EqRuntime.eq_Spline2(sx, sy, 3, col([-1, 6, 12])))[1:5] == [4, 2, 0, 6, 11]
    scarce = vec(EqRuntime.eq_Spline2(sx, sy, 3, col([4, 8])))
    @test scarce[5:8] ≈ [3.15286, 5.31635, 6.52746, 6.25286] atol = 1e-5
    @test scarce[9] ≈ -0.394425 atol = 1e-5
    @test scarce[12] == 1e30 && scarce[13] == 1e30
    # Standard deviations as weights (a point counts 1/sd^2).
    weights = col([1, 1, 1, 1, 4, 4, 4, 4, 1, 1, 1, 1])
    @test vec(EqRuntime.eq_Spline2(sx, sy, 3, weights, col([4, 8])))[5:8] ≈ [3.15222, 5.33633, 6.48274, 6.29701] atol = 1e-5
    @test vec(EqRuntime.eq_Spline2(sx, sy, 3, weights))[5:8] ≈ auto[5:8]
    # 20 points: the Durbin-Watson target is 2, so the knots stop at 4 intervals (3 give 1.87).
    wx = col(0:19)
    wy = col([round(sin(0.4 * k) * 2 + 0.05 * ((k * 7) % 5), digits=4) for k in 0:19])
    twenty = vec(EqRuntime.eq_Spline2(wx, wy, 3, nothing))
    @test twenty[1:7] == [4, 4, 0, 4.75, 9.5, 14.25, 19]
    @test twenty[8:14] ≈ [0.0152037, 1.50047, 3.42122, -2.04323, -2.08625, 1.9596, 2.03938] atol = 1e-4
    @test vec(EqRuntime.eq_Binterp(4.0, col(scarce))) ≈ [3.15286, 1.62262, -0.357143, -0.05] atol = 1e-5
    @test_throws EqError EqRuntime.eq_Spline2(sx, sy, 3, col([4]))
    @test_throws EqError EqRuntime.eq_Spline2(sx, sy, 3, col(ones(12)), col([3, 6, 9]), 1.5)
end

@testset "Interpolation: grids, prediction, polynomial and rational forms" begin
    # the reference application's Bicubic2D on a 4 x 3 grid (natural spline along both axes).
    z = [0 1 4; 2 3 9; 5 4 6; 9 8 7.0]
    bx, by = col(0:3), col(0:2)
    @test EqRuntime.eq_Bicubic2D(bx, by, z, 1.5, 0.5) ≈ 2.93281 atol = 1e-5
    @test EqRuntime.eq_Bicubic2D(bx, by, z, 1, 1) ≈ 3
    @test EqRuntime.eq_Bicubic2D(bx, by, z, 2.5, 1.5) ≈ 5.64922 atol = 1e-5
    @test EqRuntime.eq_Bicubic2D(bx, by, z, 4, 0.5) ≈ 12.7812 atol = 1e-4
    @test_throws EqError EqRuntime.eq_Bicubic2D(bx, by, permutedims(z), 1.5, 0.5)
    series = col(sin.(0.3 .* (1:60)))
    @test vec(EqRuntime.eq_predict(series, 4, 3)) ≈ sin.(0.3 .* (61:63)) atol = 0.02
    @test_throws EqError EqRuntime.eq_predict(col(1:3), 5, 2)
    xs = col(0:6)
    cubic = col(vec(xs) .^ 3 .- 2 .* vec(xs))
    result = EqRuntime.eq_polyint(xs, cubic, 2.5)
    @test result[1] ≈ 2.5^3 - 5
    @test abs(result[2]) < 1e-9
    # polyiter: [converged; order reached; value] (saved the reference application results).
    @test vec(EqRuntime.eq_polyiter(xs, cubic, 2.5, 5, 1e-9)) ≈ [1, 4, 2.5^3 - 5]
    coarse = EqRuntime.eq_polyiter(xs, cubic, 2.5, 1, 1e-9)
    @test coarse[1] == 0 && coarse[2] == 1 && abs(coarse[3] - (2.5^3 - 5)) > 0.1
    # the reference application's own numbers for 1 / (1 + x^2) at 0 to 4.
    xr, yr = col(0:4), col([1, 0.5, 0.2, 0.1, 0.0588235])
    @test vec(EqRuntime.eq_polyint(xr, yr, 2.5)) ≈ [0.13051470703125, 0.005514707031249998]
    @test vec(EqRuntime.eq_polyint(xr, yr, 1.5)) ≈ [0.32169117578124995, -0.003308824218749999]
    @test vec(EqRuntime.eq_polyint(xr, yr, 5)) ≈ [-0.20588249999999983, -0.14117649999999987]
    @test vec(EqRuntime.eq_polyiter(xr, yr, 2.5, 2, 1e-6)) ≈ [0, 2, 0.125]
    @test vec(EqRuntime.eq_polyiter(xr, yr, 2.5, 4, 1e-6)) ≈ [1, 3, 0.125]
    @test vec(EqRuntime.eq_polyiter(xr, yr, 2.5, 4, 0.1)) ≈ [1, 3, 0.125]
    @test vec(EqRuntime.eq_polyiter(xr, yr, 2.5, 4, 1)) ≈ [1, 2, 0.125]
    # the reference application's rounding noise keeps 1e-12 from converging; an exact zero tolerance does here.
    @test vec(EqRuntime.eq_polyiter(xr, yr, 2.5, 4, 0)) ≈ [0, 4, 0.13051470703125]
    @test vec(EqRuntime.eq_polyiter(xr, yr, 0.5, 4, 1e-6)) ≈ [1, 3, 0.725]
    @test vec(EqRuntime.eq_polyiter(xr, yr, 3.2, 4, 1e-6)) ≈ [1, 3, 0.104]
    @test_throws EqError EqRuntime.eq_polyiter(xr, yr, 2.5, 0, 1e-6)
    @test_throws EqError EqRuntime.eq_polyiter(xr, yr, 2.5, 10, 1e-6)
    @test vec(EqRuntime.eq_rationalint(xr, yr, 2.5)) ≈ [0.3076922888313443 * 0 + 0.13793103448275862, 6.31689e-9] rtol = 1e-3
    @test EqRuntime.eq_rationalint(xr, yr, 1.5)[2] < 0
    nodes = col(1:6)
    rational = col(1 ./ (1 .+ vec(nodes)))
    @test EqRuntime.eq_rationalint(nodes, rational, 2.5)[1] ≈ 1 / 3.5
    @test EqRuntime.eq_rationalint(nodes, rational, 3)[1] ≈ 0.25
    thiele = EqRuntime.eq_Thielecoeff(col(1:5), col(1 ./ (1 .+ (1:5) .^ 2)))
    @test EqRuntime.eq_Thiele(col(1:5), thiele, 2.5) ≈ 1 / (1 + 2.5^2)
    @test EqRuntime.eq_Thiele(col(1:5), thiele, 3) ≈ 0.1
end

@testset "Regression: lines and polynomial surfaces" begin
    x = col(0:7)
    y = col([1, 3, 2, 5, 4, 6, 8, 7])
    a, b = EqRuntime.eq_line(x, y)
    @test EqRuntime.eq_intercept(x, y) ≈ a
    @test EqRuntime.eq_slope(x, y) ≈ b
    @test EqRuntime.eq_stderr(x, y) ≈ sqrt(sum((vec(y) .- a .- b .* vec(x)) .^ 2) / 6)
    @test EqRuntime.eq_line(x, col(3 .* (0:7) .+ 2)) ≈ col([2, 3])
    @test EqRuntime.eq_medfit(col(0:8), col(2 .* (0:8) .+ 1)) ≈ col([1, 2])
    @test EqRuntime.eq_medfit(col(0:8), col([2 .* (0:7) .+ 1; 100])) ≈ col([1, 2]) atol = 3.5
    @test_throws EqError EqRuntime.eq_line(col([1, 1, 1]), col([1, 2, 3]))
    quadratic = col(3 .+ 2 .* (0:7) .- 0.5 .* (0:7) .^ 2)
    fit = EqRuntime.eq_polyfit(x, quadratic, 2)
    @test fit(3.0) ≈ 3 + 6 - 4.5
    @test fit(col([3])) ≈ 3 + 6 - 4.5
    @test_throws EqError fit(col([0, 1]))
    @test_throws EqError fit(1.0, 2.0)
    # the reference application's tables for the test data of the probe worksheet (x8, y8, degree 2).
    data = col([1, 3, 2, 5, 4, 6, 8, 7])
    table = EqRuntime.eq_polyfitc(x, data, 2)
    @test size(table) == (4, 8)
    @test vec(table[1, :]) == ["Term", "Coefficient", "Std Error", "95% CI Low", "95% CI High", "VIF", "T", "P"]
    @test table[2:4, 1] == ["Intercept", "A", "AA"]
    @test Float64.(table[2:4, 2]) ≈ [1.16667, 1.0119, -0.0119048] atol = 1e-5
    @test Float64.(table[2:4, 3]) ≈ [0.903477, 0.60295, 0.0828216] atol = 1e-5
    @test Float64.(table[2:4, 4]) ≈ [-1.15579, -0.538028, -0.224804] atol = 1e-4
    @test isnan(table[2, 6])
    @test Float64.(table[3:4, 6]) ≈ [13.25, 13.25] atol = 1e-4
    @test Float64.(table[2:4, 7]) ≈ [1.29131, 1.67826, -0.14374] atol = 1e-4
    @test Float64.(table[2:4, 8]) ≈ [0.126535, 0.0770688, 0.44566] atol = 1e-5
    @test EqRuntime.eq_polyfitc(x, data, 2, 0.9)[1, 4] == "90% CI Low"
    @test isequal(EqRuntime.eq_polyfitc(x, data, "A,AA"), table)
    @test isequal(EqRuntime.eq_polyfitc(x, data, "A AA"), table)
    @test EqRuntime.eq_polyfitc(x, data, "A")[:, 1] == ["Term", "Intercept", "A"]
    @test_throws EqError EqRuntime.eq_polyfitc(x, data, "A+AA")
    @test_throws EqError EqRuntime.eq_polyfitc(x, data, "B")
    stats = EqRuntime.eq_polyfitstat(x, data, 2)
    @test size(stats) == (10, 2)
    @test stats[:, 1] == ["Regression Analysis", "Standard Deviation", "R2", "Adjusted R2", "Predicted R2", "PRESS", "Durbin-Watson", "Coefficients", "ANOVA", "Diagnostics"]
    @test Float64.(stats[2:7, 2]) ≈ [1.07349, 0.862812, 0.807937, 0.632277, 15.4443, 3.24862] atol = 1e-4
    @test isequal(stats[8, 2], table)
    anova = stats[9, 2]
    @test size(anova) == (8, 6)
    @test anova[:, 1] == ["Source", "Regression", "A", "AA", "Residual", "Lack of Fit", "Pure Error", "Total"]
    @test Float64.(anova[2:4, 2]) ≈ [36.2381, 3.24573, 0.0238] atol = 1e-3
    @test Float64.(anova[2:8, 3]) == [2, 1, 1, 5, 5, 0, 7]
    @test Float64.(anova[2:4, 5]) ≈ [15.7231, 2.81654, 0.02066] atol = 1e-4
    @test Float64.(anova[2:4, 6]) ≈ [0.00697, 0.15413, 0.89131] atol = 1e-4
    @test anova[8, 2] ≈ 42
    diagnostics = stats[10, 2]
    @test size(diagnostics) == (9, 9)
    @test Float64.(diagnostics[2:9, 1]) == collect(0.0:7)
    @test Float64.(diagnostics[2:9, 5]) ≈ [0.70833, 0.27976, 0.23214, 0.27976, 0.27976, 0.23214, 0.27976, 0.70833] atol = 1e-5
    @test Float64.(diagnostics[2:9, 7]) ≈ [-0.25928, 0.89659, -1.2944, 0.99141, -1.16264, 0.06796, 1.4403, -1.19925] atol = 1e-4
    @test Float64.(diagnostics[2:9, 8]) ≈ [0.0669, 0.10833, 0.14875, 0.1277, 0.16351, 0.00058, 0.22109, 1.07044] atol = 1e-4
    @test Float64.(diagnostics[2:9, 9]) ≈ [-0.40406, 0.55879, -0.71172, 0.61789, -0.72461, 0.03737, 0.89766, -1.8689] atol = 1e-4
    # Two variables: the reference application's order of the terms of degree 2 is AB, AA, BB.
    two = EqRuntime.eq_polyfitc([0.0 1; 1 0; 2 2; 3 1; 4 3; 5 0; 6 2; 7 3], data, 2)
    @test two[2:7, 1] == ["Intercept", "A", "B", "AB", "AA", "BB"]
    @test Float64.(two[2:7, 2]) ≈ [1.62714, 1.44107, -0.242606, 0.344171, -0.110597, -0.602469] atol = 1e-4
    points = [0.0 0; 1 0; 0 1; 1 1; 2 1; 1 2; 2 2; 3 1]
    plane = col([2 + 3p[1] - p[2] for p in eachrow(points)])
    surface = EqRuntime.eq_polyfit(points, plane, 1)
    @test surface(col([2, 1])) ≈ 7
    @test_throws EqError surface(2.0, 1.0)
    @test_throws EqError surface(2.0)
    explicit = EqRuntime.eq_polyfit(points, plane, [0 0; 1 0; 0 1])
    @test explicit(col([3, 2])) ≈ 9
    @test_throws EqError EqRuntime.eq_polyfit(col(0:1), col(0:1), 3)
    @test_throws EqError EqRuntime.eq_polyfitc(x, data, 0)
    # As many observations as terms: the statistics are NaN (saved the reference application result, 10 points, 10 terms).
    X3 = [0.0 1 2; 1 0 1; 2 2 0; 3 1 3; 4 3 1; 5 0 2; 6 2 4; 7 3 0; 8 1 1; 9 4 3]
    exact = EqRuntime.eq_polyfitc(X3, col([1, 3, 2, 5, 4, 6, 8, 7, 9, 12]), 2)
    @test exact[2:end, 1] == ["Intercept", "A", "B", "C", "AB", "AC", "BC", "AA", "BB", "CC"]
    @test Float64(exact[2, 2]) ≈ 1.0046 atol = 1e-4
    @test all(isnan, Float64.(exact[2:end, 3]))
    # Degree 3 with two variables: Intercept, A, B, AB, AA, BB, AAB, ABB, AAA, BBB (saved the reference application result).
    X2 = [0.0 1; 1 0; 2 2; 3 1; 4 3; 5 0; 6 2; 7 3; 8 1; 9 4]
    cubic = EqRuntime.eq_polyfitc(X2, col([1, 3, 2, 5, 4, 6, 8, 7, 9, 12]), 3)
    @test cubic[2:end, 1] == ["Intercept", "A", "B", "AB", "AA", "BB", "AAB", "ABB", "AAA", "BBB"]
end

@testset "Regression: named models and nonlinear fits" begin
    x = col(0:9)
    @test EqRuntime.eq_expfit(x, col(2 .* exp.(0.3 .* (0:9)) .+ 1)) ≈ col([2, 0.3, 1]) atol = 1e-6
    t = col(1:10)
    @test EqRuntime.eq_logfit(t, col(2 .* log.((1:10) .+ 0.5) .+ 1)) ≈ col([2, 0.5, 1]) atol = 1e-5
    @test EqRuntime.eq_pwrfit(t, col(2 .* (1:10) .^ 1.5 .+ 1)) ≈ col([2, 1.5, 1]) atol = 1e-6
    @test EqRuntime.eq_lnfit(t, col(2 .* log.(1:10) .+ 1)) ≈ col([2, 1])
    s = col(0:0.5:8)
    @test EqRuntime.eq_lgsfit(s, col(5 ./ (1 .+ 3 .* exp.(-1.2 .* (0:0.5:8))))) ≈ col([5, 3, 1.2]) atol = 1e-5
    w = col(0:0.3:6)
    @test EqRuntime.eq_sinfit(w, col(2 .* sin.((0:0.3:6) .+ 0.5) .+ 1)) ≈ col([2, 0.5, 1]) atol = 1e-6
    @test EqRuntime.eq_expfit(x, col(2 .* exp.(0.3 .* (0:9)) .+ 1), col([1, 0.1, 0])) ≈ col([2, 0.3, 1]) atol = 1e-6
    decay(x, u) = [u[1] * exp(-u[2] * x); exp(-u[2] * x); -u[1] * x * exp(-u[2] * x)]
    xs = col(0:0.5:5)
    ys = col(3 .* exp.(-0.7 .* (0:0.5:5)))
    @test EqRuntime.eq_genfit(xs, ys, col([1, 1]), decay) ≈ col([3, 0.7]) atol = 1e-6
    @test EqRuntime.eq_genfit(xs, ys, col([1, 1]), (x, u) -> u[1] * exp(-u[2] * x)) ≈ col([3, 0.7]) atol = 1e-6
    @test_throws EqError EqRuntime.eq_genfit(xs, ys, col([1, 1]), 5)
    noisy = ys .+ 0.01 .* col(sin.(1:11))
    model(x, u) = u[1] * exp(-u[2] * x)
    report = EqRuntime.eq_LeastSquaresFit(xs, noisy, model, col([1, 1]), 0.95)
    @test size(report) == (2, 3)
    @test all(report[:, 2] .< report[:, 1] .< report[:, 3])
    @test report[1, 1] ≈ 3 atol = 0.05
    bounded = EqRuntime.eq_LeastSquaresFit(xs, noisy, model, col([1, 1]), 0.95, [0.0 2.5; 0 2])
    @test bounded[1, 1] <= 2.5 + 1e-9
    # confidence: the half-width of each interval and the Student t value (saved the reference application results).
    half = EqRuntime.eq_confidence(xs, noisy, model, reshape(report[:, 1], :, 1), 0.95)
    @test size(half) == (2, 2)
    @test half[:, 1] ≈ (report[:, 3] .- report[:, 2]) ./ 2 atol = 1e-6
    @test half[1, 2] ≈ EqRuntime.Distributions.quantile(EqRuntime.Distributions.TDist(9), 0.975)
    @test half[2, 2] == 0
    wide = EqRuntime.eq_confidence(xs, noisy, model, reshape(report[:, 1], :, 1), 0.99)
    @test all(wide[:, 1] .> half[:, 1])
    line = EqRuntime.eq_confidence(col(0:7), col([1, 3, 2, 5, 4, 6, 8, 7]), (x, u) -> u[1] + u[2] * x, col([1.25, 0.928571]), 0.95)
    @test line ≈ [1.55101 2.44691; 0.370763 0] atol = 1e-4
    @test EqRuntime.eq_linfit(col(0:7), col(2 .+ 3 .* (0:7)), t -> [1.0, t]) ≈ col([2, 3])
    @test EqRuntime.eq_linfit(col(0:7), col(1 .+ (0:7) .^ 2), t -> [1.0, t^2]) ≈ col([1, 1])
    planar(p, u) = u[1] + u[2] * p[1] + u[3] * p[2]
    X = [0.0 0; 1 0; 0 1; 1 1; 2 1; 1 2]
    @test EqRuntime.eq_multidfit(X, col([1, 3, 4, 6, 8, 9]), col([0, 0, 0]), planar) ≈ col([1, 2, 3]) atol = 1e-6
    rx = col(0:0.2:3)
    ry = col((1 .+ 2 .* (0:0.2:3)) ./ (1 .+ 0.5 .* (0:0.2:3)))
    rational = EqRuntime.eq_rationalfit(rx, ry, 0.95, 1, 1)
    @test rational[:, 1] ≈ [1, 2, 0.5] atol = 1e-5
    @test EqRuntime.eq_rationalfitnp(rx, ry, 0.95, 1, 1)[:, 1] ≈ [1, 2, 0.5] atol = 1e-4
    @test_throws EqError EqRuntime.eq_rationalfit(col(0:2), col(0:2), 0.95, 2, 2)
end
