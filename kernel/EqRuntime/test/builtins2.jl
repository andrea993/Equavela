@testset "Floor, Ceil, Round, Trunc with a multiple" begin
    @test eq_Floor(7.3, 2.0) == 6.0
    @test eq_Floor(-7.3, 2.0) == -8.0
    @test eq_Ceil(7.3, 2.0) == 8.0
    @test eq_Ceil(-7.3, 2.0) == -6.0
    @test eq_Round(7.0, 2.0) == 8.0          # halves away from zero
    @test eq_Round(-7.0, 2.0) == -8.0
    @test eq_Round(7.4, 0.5) == 7.5
    @test eq_Trunc(-7.9, 2.0) == -6.0
    @test eq_Trunc(7.9, 2.0) == 6.0
    @test eq_Floor(5.0, 0.25) == 5.0
    @test eq_Floor(eq_vec(1.2, 3.7), 0.5) == eq_vec(1.0, 3.5)
    @test eq_Round(2.5 + 3.4im, 1.0) == 3.0 + 3.0im
    # units: the multiple carries the unit
    @test eq_Floor(7.3u"m", 2.0u"m") == 6.0u"m"
    @test eq_Floor(730.0u"cm", 2.0u"m") == 6.0u"m"
    @test_throws EqError eq_Floor(7.3u"m", 2.0u"s")
    @test_throws EqError eq_Floor(7.3, 0.0)
    @test_throws EqError eq_Floor(7.3, 1.0im)
    @test_throws EqError eq_Floor("a", 1.0)
end

@testset "mod, atan2, combin" begin
    @test eq_mod(7.0, 3.0) == 1.0
    @test eq_mod(-7.0, 3.0) == -1.0           # sign of x
    @test eq_mod(7.0, -3.0) == 1.0
    @test eq_mod(7.5, 2.0) == 1.5
    @test eq_mod(eq_vec(5, 6, 7), 3.0) == eq_vec(2, 0, 1)
    @test eq_mod(eq_vec(5, 6), eq_vec(2, 4)) == eq_vec(1, 2)
    @test eq_mod(7.0u"m", 3.0u"m") == 1.0u"m"
    @test_throws EqError eq_mod(7.0, 0.0)
    @test_throws EqError eq_mod(7.0, 1.0im)
    @test_throws EqError eq_mod(eq_vec(1, 2), eq_vec(1, 2, 3))
    @test_throws EqError eq_mod(7.0u"m", 3.0u"s")

    # x first
    @test eq_atan2(1.0, 0.0) == 0.0
    @test eq_atan2(0.0, 1.0) ≈ π / 2
    @test eq_atan2(-1.0, 0.0) ≈ π
    @test eq_atan2(-1.0, -1.0) ≈ -3π / 4
    @test eq_atan2(1.0u"m", 1.0u"m") ≈ π / 4
    @test eq_atan2(1.0u"m", 100.0u"cm") ≈ π / 4
    @test eq_atan2(eq_vec(1, -1), 1.0) ≈ eq_vec(π / 4, 3π / 4)
    @test_throws EqError eq_atan2(0.0, 0.0)
    @test_throws EqError eq_atan2(1.0u"m", 1.0)
    @test_throws EqError eq_atan2(1.0u"m", 1.0u"s")
    @test_throws EqError eq_atan2(1.0im, 1.0)

    @test eq_combin(5.0, 2.0) == 10.0
    @test eq_combin(5.0, 0.0) == 1.0
    @test eq_combin(5.0, 5.0) == 1.0
    @test eq_combin(52.0, 5.0) == 2598960.0
    @test_throws EqError eq_combin(2.0, 3.0)
    @test_throws EqError eq_combin(5.0, -1.0)
    @test_throws EqError eq_combin(5.5, 2.0)
    @test_throws EqError eq_combin("a", 2.0)
end

@testset "sort, reverse, csort, rsort" begin
    @test eq_sort(eq_vec(3, 1, 2)) == eq_vec(1, 2, 3)
    @test eq_sort(eq_rowvec(3, 1, 2)) == eq_rowvec(1, 2, 3)
    @test eq_sort(eq_vec(2, -1, 0.5)) == eq_vec(-1, 0.5, 2)
    # the imaginary part is ignored when ordering
    @test eq_sort(eq_vec(2 + 5im, 1 - 3im)) == eq_vec(1 - 3im, 2 + 5im)
    @test_throws EqError eq_sort(eq_matrix(2, 2, 1, 2, 3, 4))
    @test_throws EqError eq_sort(eq_vec("b", "a"))
    @test_throws EqError eq_sort(3.0)

    @test eq_reverse(eq_vec(1, 2, 3)) == eq_vec(3, 2, 1)
    @test eq_reverse(eq_matrix(3, 2, 1, 2, 3, 4, 5, 6)) == [5.0 6.0; 3.0 4.0; 1.0 2.0]
    @test eq_reverse(eq_rowvec(1, 2, 3)) == eq_rowvec(1, 2, 3)
    @test eq_reverse(eq_vec(eq_vec(1), 2.0)) == eq_vec(2.0, eq_vec(1))
    @test_throws EqError eq_reverse(1.0)

    M = eq_matrix(3, 2, 3, 10, 1, 30, 2, 20)
    @test eq_csort(M, 0.0) == [1.0 30.0; 2.0 20.0; 3.0 10.0]
    @test eq_csort(M, 1.0) == [3.0 10.0; 2.0 20.0; 1.0 30.0]
    @test eq_csort(eq_matrix(3, 2, 1, 9, 1, 8, 0, 7), 0.0) == [0.0 7.0; 1.0 9.0; 1.0 8.0]   # stable
    @test_throws EqError eq_csort(M, 2.0)
    @test_throws EqError eq_csort(M, 0.5)
    N = eq_matrix(2, 3, 3, 1, 2, 10, 30, 20)
    @test eq_rsort(N, 0.0) == [1.0 2.0 3.0; 30.0 20.0 10.0]
    @test eq_rsort(N, 1.0) == [3.0 2.0 1.0; 10.0 20.0 30.0]
    @test_throws EqError eq_rsort(N, 2.0)
    with_origin(1) do
        @test eq_csort(M, 1.0) == [1.0 30.0; 2.0 20.0; 3.0 10.0]
        @test_throws EqError eq_csort(M, 0.0)
    end
end

@testset "mean, median, var, stdev" begin
    @test eq_mean(eq_vec(1, 2, 3, 4)) == 2.5
    @test eq_mean(eq_vec(1, 2), eq_vec(3, 4), 10.0) == 4.0
    @test eq_mean(eq_matrix(2, 2, 1, 2, 3, 4)) == 2.5
    @test eq_mean(eq_vec(1 + 1im, 3 + 3im)) == 2.0 + 2.0im
    @test eq_mean(eq_vec(2u"m", 4u"m")) == 3.0u"m"
    @test_throws EqError eq_mean()
    @test_throws EqError eq_mean(eq_vec("a", "b"))
    @test_throws EqError eq_mean(eq_vec(1u"m", 2u"s"))

    @test eq_median(eq_vec(3, 1, 2)) == 2.0
    @test eq_median(eq_vec(4, 1, 3, 2)) == 2.5
    @test eq_median(5.0) == 5.0
    @test eq_median(eq_vec(3u"m", 1u"m", 2u"m")) == 2.0u"m"
    @test_throws EqError eq_median(eq_vec(1 + 1im, 2))

    values = eq_vec(2, 4, 4, 4, 5, 5, 7, 9)
    @test eq_var(values) ≈ 4.0                      # population: divides by N
    @test eq_stdev(values) ≈ 2.0
    @test eq_Var(values) ≈ 32 / 7
    @test eq_Stdev(values) ≈ sqrt(32 / 7)
    @test eq_var(eq_vec(1, 3), eq_vec(5)) ≈ 8 / 3   # several arguments
    @test eq_var(5.0) == 0.0
    @test eq_var(eq_vec(1im, -1im)) ≈ 1.0           # |x - mean|^2
    @test eq_stdev(eq_vec(2u"m", 4u"m")) ≈ 1.0u"m"
    @test_throws EqError eq_Var(5.0)
    @test_throws EqError eq_Stdev(eq_vec(1))
    @test_throws EqError eq_stdev(eq_vec("a", "b"))
end
