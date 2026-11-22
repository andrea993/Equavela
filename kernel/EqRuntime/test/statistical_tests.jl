# Statistical tests: formulas and ordering from the vendor statistical-function help.

@testset "Ftest" begin
    result = eq_Ftest(eq_vec(1, 2, 3), eq_vec(1, 2, 4))
    @test size(result) == (2, 1)
    @test eltype(result) == Float64
    @test result[1] ≈ 3 / 7
    @test result[2] ≈ 0.6
    # the vendor compares variances in argument order and accepts different sample sizes.
    unequal = eq_Ftest(eq_vec(1, 2, 3), eq_vec(0, 0, 10, 10))
    @test unequal[1] ≈ 0.03
    @test_throws EqError eq_Ftest(eq_vec(1, 1), eq_vec(1, 2))
    @test_throws EqError eq_Ftest(eq_vec(1), eq_vec(1, 2))
    @test_throws EqError eq_Ftest(eq_vec(1, Inf), eq_vec(1, 2))
end

@testset "Spear" begin
    # the vendor's published clinic example contains many ties and reports rho = 0.0264.
    medication = eq_vec(0, 150, 300, 200, 400, 0, 350, 150, 0, 0, 500, 0, 0, 250)
    response = eq_vec(1, 0, 0, -1, 0, 1, 1, 0, 0, 0, 1, -1, 1, 0)
    result = eq_Spear(medication, response)
    @test size(result) == (5, 1)
    @test result[1] == 388.0
    @test result[4] ≈ 0.026383741769381026
    @test 0 <= result[3] <= 1
    @test 0 <= result[5] <= 1
    increasing = eq_Spear(eq_vec(1, 2, 3), eq_vec(3, 2, 1))
    @test increasing[4] == -1.0
    @test increasing[5] == 0.0
    @test_throws EqError eq_Spear(eq_vec(1, 2, 3), eq_vec(1, 2, 3, 4))
    @test_throws EqError eq_Spear(eq_vec(1, 1, 1), eq_vec(1, 2, 3))
end

@testset "kendltau" begin
    medication = eq_vec(0, 150, 300, 200, 400, 0, 350, 150, 0, 0, 500, 0, 0, 250)
    response = eq_vec(1, 0, 0, -1, 0, 1, 1, 0, 0, 0, 1, -1, 1, 0)
    result = eq_kendltau(medication, response)
    @test size(result) == (3, 1)
    @test result[1] ≈ 0.03006584112011315
    # The tie-corrected normal approximation: SciPy's kendalltau(method="asymptotic") gives p = 0.8992646134297564.
    @test result[3] ≈ 0.8992646134297564 rtol = 1e-10
    @test result[3] ≈ 2 * EqRuntime.Distributions.ccdf(EqRuntime.Distributions.Normal(), abs(result[2]))
    @test eq_kendltau(eq_vec(-0.0, 0.0, 1.0), eq_vec(-0.0, 0.0, 1.0))[1] ≈ 1
    @test eq_kendltau(eq_vec(1, 2), eq_vec(1, 2))[1] == 1.0
    @test_throws EqError eq_kendltau(eq_vec(1), eq_vec(2))
end

@testset "kendltau2" begin
    # This is the contingency table as presented in the reference application worksheet (matrix
    # values are interpreted column-major by the reference application's worksheet value layer).
    table = [0.0 2 13 4; 2 5 7 10; 3 2 1 0]
    result = eq_kendltau2(table)
    @test size(result) == (3, 1)
    @test result[1] ≈ -0.2326626443580524
    @test result[2] ≈ -2.358484155989168
    @test result[3] ≈ 0.018349743085664866
    @test eq_kendltau2([1e200 0; 0 1e200])[1] ≈ 1
    @test eq_kendltau2([1e200 0; 0 1e200])[3] == 0
    @test eq_kendltau2([1e200 0; 0 1.0])[1] ≈ 1
    @test_throws EqError eq_kendltau2([0.1 0; 0 0.1])
    @test_throws EqError eq_kendltau2([1.0 0; 0 0])
    @test_throws EqError eq_kendltau2([-1.0 2; 3 4])
end

@testset "contingtbl" begin
    result = eq_contingtbl([10.0 0; 0 10])
    @test size(result) == (5, 1)
    @test result[1] ≈ 20.0
    @test result[2] == 1.0
    @test result[3] ≈ 7.744216431044088e-6
    @test result[4] ≈ 1.0
    @test result[5] ≈ sqrt(0.5)
    @test eq_contingtbl(fill(1e200, 2, 2)) ≈ reshape([0, 1, 1, 0, 0], :, 1)
    @test eq_contingtbl([1e200 0; 0 1e200])[1] ≈ 2e200
    # Empty margins are removed before df/statistics are computed.
    reduced = eq_contingtbl([0.0 0 0; 10 0 0; 0 0 10])
    @test reduced ≈ result
    # Fractional frequencies are accepted, but a table with one non-empty row is not.
    @test eq_contingtbl([0.5 1.5; 2.0 0.5])[2] == 1.0
    @test_throws EqError eq_contingtbl([1.0 2; 3 4im])
    @test_throws EqError eq_contingtbl([1.0 2; 3 Inf])
    @test_throws EqError eq_contingtbl([1.0 2; 3 -1])
    @test_throws EqError eq_contingtbl([1.0 2 0])
end
