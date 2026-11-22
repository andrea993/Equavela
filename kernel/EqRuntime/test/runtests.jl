using Test
using EqRuntime
using JSON3
using LinearAlgebra
using Unitful

@testset "EqRuntime" begin
    @test DEFAULT_ORIGIN == 0
    @test eq_index(0, 0) == 1
    @test eq_index(0, 4) == 5
    @test eq_index(1, 1) == 1
    @test eq_index(1, 3) == 3
    @test eq_index(DEFAULT_ORIGIN, 2) == 3
    @test eq_index(Int32(0), Int8(2)) == 3
end

include("values.jl")
include("type_functions.jl")
include("golden_programs.jl")
include("semantics.jl")
include("builtins.jl")
include("builtins2.jl")
include("builtins3.jl")
include("builtins4.jl")
include("special_functions.jl")
include("fourier.jl")
include("builtins5.jl")
include("builtins6.jl")
include("random.jl")
include("doe.jl")
include("distributions.jl")
include("statistical_tests.jl")
include("graphical_statistics.jl")
include("data_analysis.jl")
include("smoothing.jl")
include("interpolation_regression.jl")
include("ode.jl")
include("fastpaths.jl")
include("ods.jl")
include("file_access.jl")
include("ods_write.jl")
include("solve.jl")
include("solveblock.jl")
include("calculus.jl")
include("ranges.jl")
include("programs.jl")
include("interop.jl")
include("units.jl")
include("constants.jl")
