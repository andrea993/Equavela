@testset "Data smoothing and local extrema" begin
    @test EqRuntime.eq_movavg([1.0, 2, 3, 4], 3) ≈ [1, 1.5, 2, 3]
    @test EqRuntime.eq_movavg([1.0, 2, 3], 5) ≈ [1, 1.5, 2]
    @test EqRuntime.eq_expsmooth([1.0, 0, 0], 0.5) ≈ [1, 0.5, 0.25]
    @test EqRuntime.eq_expsmooth([1.0, 2, 3], 1) ≈ [1, 2, 3]
    @test EqRuntime.eq_medsmooth([0.0, 100, 1, 2, 3], 3) ≈ [50, 1, 2, 2, 2.5]
    @test EqRuntime.eq_VSmooth([0.0, 0, 10, 0, 0], [3]) isa Vector
    @test EqRuntime.eq_ksmooth([0.0, 1, 2], [7.0, 7, 7], 0.5) ≈ [7, 7, 7]

    peaks = EqRuntime.eq_localmax([0.0 1; 1 3; 2 1; 3 4; 4 2])
    @test peaks == [1.0 3; 3 4]
    valleys = EqRuntime.eq_localmin([0.0 4; 1 1; 2 3; 3 0; 4 2])
    @test valleys == [1.0 1; 3 0]
    @test EqRuntime.eq_localmax([0.0,1,2], [0.0,1,2], [0.0 1 0; 1 5 1; 0 1 0]) == [1.0 1 5]

    x = collect(1.0:20.0)
    y = 2 .* x .+ 3
    smoothed = EqRuntime.eq_supsmooth(x, y)
    @test length(smoothed) == length(y)
    @test all(isfinite, smoothed)
    @test smoothed ≈ y atol=1e-8

    @test_throws EqError EqRuntime.eq_movavg([1, 2], 0)
    @test_throws EqError EqRuntime.eq_expsmooth([1, 2], 1.1)
    @test_throws EqError EqRuntime.eq_medsmooth([1, 2, 3], 2)
    @test_throws EqError EqRuntime.eq_VSmooth([1, 2, 3], [3])
    # Twelve noisy points, bandwidths 1, 2 and 4.
    kx = collect(0.0:11)
    ky = [1.0, 1.6, 2.7, 3.1, 3.2, 4.4, 5.9, 6.0, 6.3, 7.8, 9.1, 9.0]
    # The kernel SD is the bandwidth.
    reference(b) = [sum(exp.(-0.5 .* ((xi .- kx) ./ b) .^ 2) .* ky) / sum(exp.(-0.5 .* ((xi .- kx) ./ b) .^ 2)) for xi in kx]
    for b in (1, 2, 4)
        @test vec(EqRuntime.eq_ksmooth(kx, ky, b)) ≈ reference(b)
    end
    @test_throws EqError EqRuntime.eq_ksmooth([0, 1], [1, 2], 0)
    @test_throws EqError EqRuntime.eq_supsmooth([0, 1, 1], [1, 2, 3])
end

@testset "Smoothing worksheet arrays and cross-validation" begin
    data = [1 10; 2 20; 3 30]
    @test EqRuntime.eq_movavg(data, 2) ≈ [1 10; 1.5 15; 2.5 25]
    @test EqRuntime.eq_expsmooth(data, 0.5) ≈ [1 10; 1.5 15; 2.25 22.5]
    @test EqRuntime.eq_movavg(reshape([1,2,3], :, 1), 2) ≈ reshape([1,1.5,2.5], :, 1)
    @test EqRuntime.eq_movavg([1 2 3], 2) ≈ [1 1.5 2.5]
    @test EqRuntime.eq_medsmooth([1 2; 3 100], 3, 3) == fill(2.5, 2, 2)
    @test EqRuntime.eq_medsmooth([1 2 3; 4 100 6; 7 8 9], 3, 1)[2,2] == 8
    @test EqRuntime.eq_medsmooth([0, 100, 1], 3) == [50, 1, 50.5]
    @test EqRuntime.eq_VSmooth([0, 0, 10, 0, 0], [3]) == zeros(5)
    @test EqRuntime.eq_VSmooth([0, 2, 1, 0, 0], [0]) == [0, 2, 1, 0, 0]
    alternating = [0, 10, 0, 10, 0, 10, 0]
    loose = EqRuntime.with_tol(() -> EqRuntime.eq_VSmooth(alternating, [3]), 0.9)
    tight = EqRuntime.with_tol(() -> EqRuntime.eq_VSmooth(alternating, [3]), 1e-8)
    @test maximum(tight) - minimum(tight) < 1e-7
    @test maximum(loose) - minimum(loose) > 0.1
    @test EqRuntime.eq_localmax(reshape([0,1,2], :, 1), reshape([0,1,2], :, 1), [0 1 0; 1 5 1; 0 1 0]) == [1 1 5]
    @test size(EqRuntime.eq_ksmooth(reshape([0,1,2], :, 1), reshape([1,2,3], :, 1), 1)) == (3,1)
    # Compare the leverage formula to independent least-squares fits after removing
    # each point from the same fixed window, including high-leverage endpoints.
    x = collect(1.0:9.0)
    y = [1., 4, 1, 2, 8, 2, 4, 3, 0]
    fit, residual = EqRuntime._running_line(x, y, 5; cv=true)
    for i in eachindex(x)
        lo = clamp(i-2, 1, length(x)-4)
        inds = filter(!=(i), collect(lo:lo+4))
        design = hcat(ones(4), x[inds])
        coefficients = design \ y[inds]
        @test residual[i] ≈ abs(y[i] - (coefficients[1] + coefficients[2]*x[i])) atol=1e-11
    end
    @test maximum(abs.(residual .- abs.(y .- fit))) > 0.5
    @test size(EqRuntime.eq_supsmooth(reshape(x, :, 1), reshape(y, :, 1))) == (9,1)
end

@testset "Smoothing integer bounds" begin
    @test_throws EqError EqRuntime.eq_movavg(eq_vec(1, 2), Float64(typemax(Int)))
    @test size(EqRuntime.eq_localmax([0.0 1; 1 2], typemax(Int))) == (0, 2)
end
