using Test
using EqRuntime
using LinearAlgebra

@testset "Data analysis" begin
    m = EqRuntime
    data = reshape([0., 0., 0., 0., 0., 0., 0., 0., 0., 0., 100.], :, 1)
    @test m.eq_ThreeSigma(data)[1, 1] == 10
    @test m.eq_Grubbs(data, 0.95)[1, 1] == 10
    @test m.eq_GrubbsClassic(data, 0.975)[1, 1] == 10
    @test m.eq_ThreeSigma(reshape([1., 2., 4.], :, 1))[1, 1] == 2
    matrix = [1. 2.; 3. 4.; 5. 6.]
    indices = reshape(Any[reshape([0., 1.], 2, 1), reshape([2., 0.], 2, 1)], :, 1)
    marked = m.eq_markNaN(matrix, indices)
    @test m.eq_matchNaN(marked) == indices
    @test m.eq_filterNaN(marked) == [3. 4.]
    @test m.eq_trim(matrix, reshape([0., 2.], :, 1)) == [3. 4.]
    @test matrix == [1. 2.; 3. 4.; 5. 6.]
    m.with_origin(1) do
        @test m.eq_ThreeSigma(data)[1, 1] == 11
        @test m.eq_trim(matrix, reshape([1., 3.], :, 1)) == [3. 4.]
        @test m.eq_matchNaN(m.eq_markNaN(matrix, reshape(Any[reshape([2., 2.], 2, 1)], :, 1)))[1] == reshape([2., 2.], 2, 1)
    end
    @test_throws m.EqError m.eq_Grubbs(data, 1)
    @test_throws m.EqError m.eq_trim(matrix, reshape([3.], :, 1))
end

@testset "Principal components" begin
    m = EqRuntime
    data = [1. 3.; 2. 1.; 4. 2.; 5. 6.; 8. 4.]
    firstpc = m.eq_Nipals(data, 1, 1000, "noscale", 1e-11)
    complete = m.eq_Nipals2(firstpc, 1)
    scores = m.eq_scores(complete)
    loadings = m.eq_loadings(complete)
    centered = data .- sum(data; dims=1) ./ size(data, 1)
    @test scores * loadings' ≈ centered atol=1e-8
    @test loadings' * loadings ≈ [1. 0.; 0. 1.] atol=1e-8
    @test m.eq_PCAvariance(complete)[end] ≈ 1 atol=1e-9
    @test vec(m.eq_PCAeigenvals(complete)) ≈ reverse(eigvals(Symmetric(centered' * centered))) atol=1e-8
    @test size(m.eq_Nipals(data, 1, 1000, "scale", 1e-11)[1]) == (5, 1)
    @test_throws m.EqError m.eq_Nipals(data, 3, 100, "noscale", 1e-8)
    @test_throws m.EqError m.eq_Nipals(data, 1, 100, "bad", 1e-8)
    @test_throws m.EqError m.eq_Nipals(data, Float64(typemax(Int)), 100, "noscale", 1e-8)
    broken = deepcopy(firstpc)
    broken[2] = zeros(1, 1)
    @test_throws m.EqError m.eq_Nipals2(broken, 1)
    broken = deepcopy(firstpc)
    broken[6][1] = Float64(typemax(Int))
    @test_throws m.EqError m.eq_Nipals2(broken, 1)
    broken = deepcopy(firstpc)
    broken[5][1] = NaN
    @test_throws m.EqError m.eq_Nipals2(broken, 1)
    scaled = m.eq_Nipals(data, 2, 1000, "scale", 1e-11)
    scaleddata = centered ./ sqrt.(sum(abs2, centered; dims=1) ./ 4)
    @test m.eq_scores(scaled) * m.eq_loadings(scaled)' ≈ scaleddata atol=1e-8
    @test vec(m.eq_PCAeigenvals(scaled)) ≈ reverse(eigvals(Symmetric(scaleddata' * scaleddata))) atol=1e-8
    @test m.eq_PCAvariance(scaled)[end] ≈ 1 atol=1e-9
end

# the vendor Example: Principal Component Analysis 1, displayed to three decimals.
@testset "the vendor PCA example" begin
    data = reshape([
        3.616, 3.746, 3.018, 3.758, 3.572, 3.044, 3.53, 3.81, 3.981, 4.069,
        3.548, 3.526, 4.007, 3.308, 3.543, 3.487, 3.6, 3.36, 3.224, 3.364,
        4.225, 3.642, 3.488, 3.829, 3.685, 4.06, 3.388, 3.656, 4.068, 3.429,
        3.878, 3.344, 3.616, 3.885, 3.369, 3.762, 4.142, 3.721, 3.359, 3.686,
        3.86, 3.392, 4.466, 3.53, 3.618, 3.906, 3.03, 3.864, 3.706, 3.73,
        3.518, 3.575, 3.975, 3.345, 3.835, 3.581, 3.669, 4.069, 3.567, 3.973,
        3.263, 3.778, 3.726, 3.791, 3.535, 3.56, 3.419, 3.347, 3.674, 3.112,
        3.709, 3.858, 4.064, 3.946, 3.579, 3.419, 4.063, 2.787, 3.269, 3.27,
        3.771, 3.51, 3.256, 4.163, 4.261, 3.485, 3.757, 3.537, 3.836, 3.773,
        3.6, 3.809, 3.162, 3.402, 3.174, 3.773, 3.86, 3.574, 3.703, 3.631,
        3.498, 4.509, 2.612, 3.861, 3.592, 2.976, 3.752, 3.956, 4.244, 4.573,
        3.82, 4.015, 4.402, 2.827, 4.256, 3.365, 3.843, 3.466, 2.9, 3.229,
        4.363, 3.933, 3.598, 3.939, 3.758, 3.843, 3.306, 4.097, 4.364, 3.393,
        4.219, 3.192, 3.899, 4.312, 3.976, 3.389, 4.458, 3.999, 4.036, 4.348,
        4.016, 3.704, 4.902, 3.05, 3.678, 3.804, 3.001, 3.877, 4.299, 3.864,
        3.921, 3.646, 4.158, 3.296, 4.266, 3.319, 3.642, 4.798, 3.698, 4.281,
        3.378, 4.17, 3.853, 3.976, 3.732, 3.341, 3.535, 3.38, 3.422, 3.258,
        3.742, 4.031, 3.947, 4.072, 3.654, 3.146, 4.441, 2.415, 3.306, 3.499,
        4.188, 3.385, 3.135, 4.462, 4.602, 3.348, 4.189, 3.45, 3.524, 4.208,
        3.186, 4.025, 3.371, 2.782, 2.704, 3.822, 4.14, 3.29, 3.937, 4.115,
        3.347, 3.923, 2.612, 3.611, 3.425, 2.885, 3.497, 3.666, 3.899, 4.094,
        3.503, 3.646, 3.992, 2.868, 3.73, 3.202, 3.491, 3.222, 2.88, 3.118,
        4.028, 3.605, 3.348, 3.675, 3.484, 3.688, 3.157, 3.697, 3.983, 3.198,
        3.815, 3.074, 3.549, 3.894, 3.547, 3.363, 4.069, 3.615, 3.557, 3.867,
        3.764, 3.4, 4.417, 3.024, 3.452, 3.64, 2.865, 3.635, 3.809, 3.584,
        3.567, 3.426, 3.896, 3.075, 3.861, 3.185, 3.425, 4.222, 3.485, 3.891,
        3.155, 3.792, 3.621, 3.666, 3.467, 3.275, 3.311, 3.17, 3.318, 3.008,
        3.528, 3.746, 3.755, 3.819, 3.429, 3.04, 4.016, 2.443, 3.134, 3.267,
        3.801, 3.206, 3.015, 4.097, 4.204, 3.19, 3.792, 3.29, 3.471, 3.806,
        3.156, 3.729, 3.137, 2.85, 2.735, 3.598, 3.785, 3.261, 3.626, 3.674,
    ], 100, 3)
    pca = EqRuntime.eq_Nipals(data, 3, 1000, "noscale", 1e-12)
    @test vec(EqRuntime.eq_PCAvariance(pca)) ≈ [0.955, 0.999, 1.0] atol=0.0006
    @test vec(EqRuntime.eq_PCAeigenvals(pca)) ≈ [45.353, 2.079, 0.038] atol=0.0006
end
