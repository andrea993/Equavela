# The kernel entry point refuses a Julia older than the supported one before it loads a package.

include(joinpath(@__DIR__, "..", "bin", "julia_version.jl"))

@testset "Julia version check of the entry point" begin
    @test julia_version_error(v"1.13.0") === nothing
    @test julia_version_error(v"1.13.4") === nothing
    @test julia_version_error(v"1.13.0-rc1") === nothing
    @test julia_version_error(v"1.14.0") === nothing
    @test julia_version_error(v"2.0.0") === nothing
    message = julia_version_error(v"1.12.4")
    @test message isa String
    @test occursin("Julia 1.13 or later", message)
    @test occursin("1.12.4", message)
    @test occursin("juliaup update", message)
    @test julia_version_error(v"1.11.7") isa String
    # The running Julia is a supported one: the suite itself needs it.
    @test julia_version_error() === nothing
end
