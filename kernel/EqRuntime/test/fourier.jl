@testset "Fourier transforms" begin
    v = reshape([1.0, 2, 3, 4], :, 1)
    expected = reshape(ComplexF64[10, -2+2im, -2, -2-2im], :, 1)
    @test EqRuntime.eq_dft(v) ≈ expected
    @test EqRuntime.eq_idft(expected) ≈ v
    @test EqRuntime.eq_cfft(v) ≈ conj.(expected) ./ 2
    @test EqRuntime.eq_icfft(EqRuntime.eq_cfft(v)) ≈ v
    @test EqRuntime.eq_dftr(v) ≈ expected[1:3, :]
    @test EqRuntime.eq_idftr(expected[1:3, :]) ≈ v
    @test EqRuntime.eq_dftr(v .+ 2im) ≈ EqRuntime.eq_dftr(v)
    A = [1.0 2 3 4; 5 6 7 8; 9 10 11 12]
    Z = EqRuntime.eq_dft(A)
    @test EqRuntime.eq_idft(Z) ≈ A
    @test EqRuntime.eq_dftr(A) ≈ Z[:, 1:3]
    @test EqRuntime.eq_idftr(EqRuntime.eq_dftr(A)) ≈ A
    @test size(EqRuntime.eq_dft(reshape([1.0, 2, 3], 1, 3))) == (1, 3)
    @test_throws EqError EqRuntime.eq_dftr(reshape([1, 2, 3], :, 1))
    @test_throws EqError EqRuntime.eq_idftr(reshape([1], :, 1))
    @test_throws EqError EqRuntime.eq_dft(zeros(0, 1))
end

@testset "Wavelet transforms and spline filters" begin
    x = reshape(collect(1.0:8.0), :, 1)
    @test EqRuntime.eq_iwave(EqRuntime.eq_wave(x)) ≈ x
    @test sum(abs2, EqRuntime.eq_wave(x)) ≈ sum(abs2, x)
    @test_throws EqError EqRuntime.eq_wave(reshape([1., 2, 3], :, 1))
    @test_throws EqError EqRuntime.eq_wave(reshape([1., 2, 3, 4] .+ im, :, 1))
    for (m, ns) in ((1, (1,3,5)), (2, (2,4,6,8)), (3, (1,3,5,7,9)))
        for n in ns
            a = EqRuntime.eq_Bspline(m, n)
            @test size(a, 2) == 2
            @test sum(a[:,1]) ≈ sqrt(2)
            @test sum(a[:,2]) ≈ sqrt(2)
            @test !iszero(a[end, 1])
        end
    end
    @test EqRuntime.eq_Bspline(1,1) ≈ fill(inv(sqrt(2)), 2, 2)
    # Saved the vendor the reference application results: no padding row for even orders, and the
    # synthesis column starts at the first row.
    @test EqRuntime.eq_Bspline(2,2) ≈ [-0.1767766952966369 0.3535533905932738; 0.3535533905932738 0.7071067811865476;
        1.0606601717798214 0.3535533905932738; 0.3535533905932738 0; -0.1767766952966369 0]
    @test size(EqRuntime.eq_Bspline(2,4)) == (9, 2)
    @test EqRuntime.eq_Bspline(3,3)[:, 2] ≈ [0.1767766952966369, 0.5303300858899107, 0.5303300858899107, 0.1767766952966369, 0, 0, 0, 0]
    @test EqRuntime.eq_Bspline(1,3)[:, 2] ≈ [0.7071067811865476, 0.7071067811865476, 0, 0, 0, 0]
    @test_throws EqError EqRuntime.eq_Bspline(2,3)
end

@testset "Wavelet transform matches saved the reference application results" begin
    col(v) = reshape(Float64.(v), :, 1)
    @test EqRuntime.eq_wave(col(1:8)) ≈ col([5.901923788646683, 12.098076211353314, -3.8301270189221923, 0.3660254037844384, -2.8284271247461894, 0, 0, 0]) atol = 1e-13
    @test EqRuntime.eq_wave(col([1, 0, 0, 0, 0, 0, 0, 0])) ≈ col([0.20424682452694515, 0.2957531754730548, 0.35376587736527404, -0.17075317547305477, 0.8365163037378077, -0.1294095225512603, 0, 0]) atol = 1e-13
    @test EqRuntime.eq_iwave(col([1, 0, 0, 0, 0, 0, 0, 0])) ≈ col([0.20424682452694515, 0.4207531754730547, 0.5122595264191644, 0.6372595264191642, 0.2957531754730548, 0.07924682452694524, -0.012259526419164439, -0.13725952641916436]) atol = 1e-13
    @test EqRuntime.eq_wave(col(1:4)) ≈ col([2.310789034541149, 4.760278777324325, -1.414213562373095, 0]) atol = 1e-13
    @test EqRuntime.eq_wave(col(1:2)) == col(1:2)
    w16 = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3]
    @test EqRuntime.eq_wave(col(w16))[1:3] ≈ [12.106880831396936, 16.17739041606496, -5.026066211694922] atol = 1e-12
    @test EqRuntime.eq_iwave(EqRuntime.eq_wave(col(w16))) ≈ col(w16)
end

@testset "Local cosine packets" begin
    x = reshape(collect(1.0:8), :, 1)
    packets = EqRuntime.eq_cpt(x, 2)
    @test size(packets) == (3, 1)
    @test all(size(p) == size(x) for p in packets)
    @test all(isapprox(sum(abs2, p), sum(abs2, x)) for p in packets)
    image = reshape(collect(1.0:64), 8, 8)
    two = EqRuntime.eq_cpt(image, 2)
    @test all(size(p) == size(image) for p in two)
    @test all(isapprox(sum(abs2, p), sum(abs2, image)) for p in two)
    @test_throws EqError EqRuntime.eq_cpt(x, 3)
    # Saved the reference application results: the impulse at 0 of 16 points, level 0 with n = 0 and level 0 with n = 3.
    impulse = reshape([1.0; zeros(15)], :, 1)
    @test vec(EqRuntime.eq_cpt(impulse, 0)[1])[1:4] ≈ [0.256876, 0.299333, 0.204547, 0.330287] atol = 1e-6
    deep = EqRuntime.eq_cpt(impulse, 3)
    @test length(deep) == 4
    @test vec(deep[1])[1:3] ≈ [0.33987, 0.352343, 0.314336] atol = 1e-5
    @test vec(deep[2])[1:3] ≈ [0.484485, 0.465866, 0.429345] atol = 1e-5
    # The ramp 1..16 at level 0 (n = 0) and a shifted impulse at level 1.
    @test vec(EqRuntime.eq_cpt(reshape(collect(1.0:16), :, 1), 0)[1])[1:4] ≈ [32.1318, -13.2973, 12.6766, -4.27038] atol = 1e-4
    shifted = reshape([zeros(5); 1.0; zeros(10)], :, 1)
    @test vec(EqRuntime.eq_cpt(shifted, 1)[1])[1:3] ≈ [0.303253, -0.017348, -0.319608] atol = 1e-6
    # Four points: the level 0 vector depends on n (the folds follow the finest block).
    four = reshape([1.0, 0, 0, 0], :, 1)
    @test vec(EqRuntime.eq_cpt(four, 0)[1]) ≈ [0.549298, 0.703271, 0.0735538, 0.445277] atol = 1e-6
    @test vec(EqRuntime.eq_cpt(four, 1)[1]) ≈ [0.643797, 0.662025, 0.248441, 0.292448] atol = 1e-6
    # A row vector, a length that is not a multiple of 2^(n + 1) and a level that is too deep are errors.
    @test_throws EqError EqRuntime.eq_cpt(reshape(collect(1.0:16), 1, :), 1)
    @test_throws EqError EqRuntime.eq_cpt(four, 2)
    @test_throws EqError EqRuntime.eq_cpt(reshape(collect(1.0:32), :, 1), 5)
end

@testset "Fourier unit and layout behavior" begin
    x = reshape([1.0u"m", 200.0u"cm", 3.0u"m", 4.0u"m"], :, 1)
    @test EqRuntime.eq_idft(EqRuntime.eq_dft(x)) ≈ [1.0u"m", 2u"m", 3u"m", 4u"m"][:, :]
    @test EqRuntime.eq_idftr(EqRuntime.eq_dftr(x)) ≈ [1.0u"m", 2u"m", 3u"m", 4u"m"][:, :]
    @test EqRuntime.eq_iwave(EqRuntime.eq_wave(x)) ≈ [1.0u"m", 2u"m", 3u"m", 4u"m"][:, :]
    @test_throws EqError EqRuntime.eq_dft(reshape(Any[1u"m", 2u"s"], :, 1))
    @test_throws EqError EqRuntime.eq_dft(reshape(Any[1u"m", "bad"], :, 1))
    @test size(EqRuntime.eq_dftr([1.0 2 3 4])) == (1,3)
    @test size(EqRuntime.eq_idftr(EqRuntime.eq_dftr([1.0 2 3 4]))) == (1,4)
end

@testset "Shortest wavelet vector" begin
    data = eq_vec(1.0, 2.0)
    @test EqRuntime.eq_iwave(EqRuntime.eq_wave(data)) ≈ data
end
