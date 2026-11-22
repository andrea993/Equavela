# Physical constants: CODATA values, SI dimensions, the table shared with Rust.

@testset "physical constants" begin
    @test eq_constant("c") == 299792458.0u"m/s"
    @test eq_constant("h") == 6.62607015e-34u"kg*m^2/s"
    @test eq_constant("e.c") == 1.602176634e-19u"A*s"
    @test eq_constant("k") == 1.380649e-23u"kg*m^2/s^2/K"
    @test eq_constant("N.A") == 6.02214076e23u"1/mol"
    @test eq_constant("α") isa Float64
    @test eq_constant("α") ≈ 7.2973525643e-3
    # the exact consequences of the SI redefinition agree with the table digits
    h, c, e, k, NA = 6.62607015e-34, 299792458.0, 1.602176634e-19, 1.380649e-23, 6.02214076e23
    @test ustrip(eq_constant("ħ")) ≈ h / (2π) rtol = 1e-15
    @test ustrip(eq_constant("R")) ≈ NA * k rtol = 1e-15
    @test ustrip(eq_constant("σ")) ≈ 2π^5 * k^4 / (15 * h^3 * c^2) rtol = 1e-14
    @test ustrip(eq_constant("Φ_0")) ≈ h / (2e) rtol = 1e-15
    # c^2 ε0 μ0 = 1 up to the measurement uncertainty, with the dimensions cancelling
    @test eq_constant("c")^2 * eq_constant("ε_0") * eq_constant("μ_0") ≈ 1.0 rtol = 1e-9
    # both spellings of a subscripted constant
    @test eq_constant("ε0") == eq_constant("ε_0")
    @test eq_constant("μ0") == eq_constant("μ_0")
    @test eq_constant("Φ0") == eq_constant("Φ_0")
    # the unit of every constant is the one the table promises (shared with the Rust side)
    count = 0
    for line in eachline(joinpath(@__DIR__, "..", "src", "constants.tsv"))
        line = strip(line)
        (isempty(line) || startswith(line, '#') || startswith(line, "@alias")) && continue
        fields = split(line)
        @test _dimension_exponents(eq_constant(String(fields[1]))) ==
              Tuple(parse.(Int, split(fields[2], ',')))
        count += 1
    end
    @test count == 14
    @test issorted(eq_constant_names()) && "R∞" in eq_constant_names()
    err = try
        eq_constant("mu")
    catch e
        e
    end
    @test err isa EqError && occursin("mu is undefined", err.message)
    fixture = readlines(joinpath(@__DIR__, "..", "..", "..", "core", "fixtures", "constant-names.txt"))
    @test eq_constant_names() == fixture
end
