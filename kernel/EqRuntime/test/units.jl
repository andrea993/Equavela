# the reference application units: the unit table, quantities through the operators,
# dimension errors, unit overrides and the kernel encoding.

function _dimension_exponents(value)
    exponents = zeros(Int, 7)
    value isa Unitful.AbstractQuantity || return Tuple(exponents)
    for component in EqRuntime._dimension_components(dimension(upreferred(value)))
        index = EqRuntime._DIMENSION_ORDER[component["base"]]
        exponents[index] = component["power"][1]
    end
    Tuple(exponents)
end

@testset "unit table" begin
    @test eq_unit("m") == 1.0u"m"
    @test eq_unit("km") == 1000.0u"m"
    @test eq_unit("ft") ≈ 0.3048u"m"
    @test eq_unit("kW") ≈ 1000.0u"kg*m^2/s^3"
    @test eq_unit("newton") ≈ 1.0u"kg*m/s^2"
    @test eq_unit("kN") ≈ 1000.0u"N"
    @test eq_unit("min") == 60.0u"s"
    @test eq_unit("hr") == 3600.0u"s"
    @test eq_unit("mi") ≈ 1609.344u"m"
    @test eq_unit("mm") ≈ 0.001u"m"
    @test eq_unit("kWh") ≈ 3.6e6u"J"
    @test eq_unit("kg") == 1.0u"kg"
    @test eq_unit("g") ≈ 0.001u"kg"
    @test eq_unit("lbf") ≈ 4.4482216152605u"N"
    # dimensionless units are plain numbers
    @test eq_unit("deg") ≈ pi / 180
    @test eq_unit("rad") == 1.0
    @test eq_unit("deg") isa Float64
    @test eq_is_unit("K") && eq_is_unit("deg") && eq_is_unit("kmol")
    @test !eq_is_unit("x") && !eq_is_unit("foo")
    err = try
        eq_unit("foo")
    catch e
        e
    end
    @test err isa EqError && occursin("foo is undefined", err.message)

    # every name has the dimension the table promises (shared with the Rust side)
    count = 0
    for line in eachline(joinpath(@__DIR__, "..", "src", "units.tsv"))
        line = strip(line)
        (isempty(line) || startswith(line, '#') || startswith(line, "@prefix")) && continue
        fields = split(line)
        # °C and °F are offset units: checked with their own tests
        fields[1] in ("°C", "°F") && continue
        @test _dimension_exponents(eq_unit(String(fields[1]))) ==
              Tuple(parse.(Int, split(fields[2], ',')))
        count += 1
    end
    @test count > 100
    # prefixed names share the dimension of their base, and plain names beat prefixes
    @test _dimension_exponents(eq_unit("GHz")) == (0, 0, -1, 0, 0, 0, 0)
    @test _dimension_exponents(eq_unit("min")) == (0, 0, 1, 0, 0, 0, 0)
    @test _dimension_exponents(eq_unit("mi")) == (1, 0, 0, 0, 0, 0, 0)
    @test "km" in eq_unit_names() && issorted(eq_unit_names())
    # the Rust side (core/src/units.rs) reads the same table; both must list the same names
    fixture = readlines(joinpath(@__DIR__, "..", "..", "..", "core", "fixtures", "unit-names.txt"))
    @test eq_unit_names() == fixture
end

@testset "quantities through the operators" begin
    m, s, kg = eq_unit("m"), eq_unit("s"), eq_unit("kg")
    x = eq_mul(3.0, m)
    @test x == 3.0u"m"
    @test eq_pow(x, 2.0) == 9.0u"m^2"                       # phase 4 exit: y := x^2
    @test eq_mul(kg, eq_div(m, eq_pow(s, 2.0))) ≈ 1.0u"N"
    @test eq_add(eq_mul(2.0, eq_unit("km")), eq_mul(500.0, m)) ≈ 2500.0u"m"
    @test eq_add(eq_mul(1.0, m), eq_mul(1.0, eq_unit("ft"))) ≈ 1.3048u"m"
    @test eq_sub(eq_mul(1.0, m), eq_mul(1.0, m)) == 0.0u"m"
    # a dimensionless result is a plain number
    ratio = eq_div(eq_mul(5.0, eq_unit("km")), eq_mul(1.0, m))
    @test ratio === 5000.0
    @test eq_mul(90.0, eq_unit("deg")) ≈ pi / 2
    @test eq_sin(eq_mul(30.0, eq_unit("deg"))) ≈ 0.5
    @test eq_mul(2.0, eq_unit("Hz")) == 2.0u"s^-1"
    @test eq_pow(eq_mul(9.0, eq_pow(m, 2.0)), 0.5) == 3.0u"m"
    # unit errors are the reference application errors
    for failing in (
        () -> eq_add(x, eq_mul(1.0, s)),
        () -> eq_sub(x, 1.0),
        () -> eq_add(1.0, x),
        () -> eq_lt(x, eq_mul(1.0, s)),
        () -> eq_eq(x, 3.0),
        () -> eq_ne(x, eq_mul(3.0, s)),
    )
        error = try
            failing()
            nothing
        catch e
            e
        end
        @test error isa EqError
        @test occursin("units", error.message)
    end
    @test_throws EqError eq_sin(x)
    @test eq_eq(eq_mul(1000.0, m), eq_mul(1.0, eq_unit("km"))) == 1.0
    @test eq_lt(eq_mul(1.0, m), eq_mul(1.0, eq_unit("km"))) == 1.0
end

@testset "units in arrays" begin
    m, s = eq_unit("m"), eq_unit("s")
    mixed = eq_vec(eq_mul(1.0, m), eq_mul(2.0, s))
    @test mixed[1] == 1.0u"m" && mixed[2] == 2.0u"s"
    @test eq_mul(2.0, mixed)[2] == 4.0u"s"
    sum_ok = eq_add(mixed, eq_vec(eq_mul(3.0, m), eq_mul(1.0, s)))
    @test sum_ok[1] == 4.0u"m" && sum_ok[2] == 3.0u"s"
    @test_throws EqError eq_add(mixed, eq_vec(eq_mul(1.0, s), eq_mul(1.0, s)))
    lengths = eq_vec(eq_mul(1.0, m), eq_mul(2.0, eq_unit("cm")))
    @test eltype(lengths) <: Unitful.AbstractQuantity
    @test eq_div(lengths, eq_mul(1.0, s))[1] == 1.0u"m/s"
    # per-element encode (the unit system is SI)
    encoded = encode_value(mixed)
    @test encoded.value["type"] == "matrix"
    @test encoded.value["storage"]["values"][2]["dimension"][1]["base"] == "time"
end

@testset "unit override" begin
    kmh = eq_div(eq_unit("km"), eq_unit("hr"))
    speed = eq_mul(8.0, eq_div(eq_unit("m"), eq_unit("s")))
    unit = eq_display_unit(speed, kmh)
    @test ustrip(speed / unit) ≈ 28.8
    @test unit == kmh
    # the value is untouched; the divisor is the unit's SI magnitude
    @test _dimension_exponents(unit) == (1, 0, -1, 0, 0, 0, 0)
    encoded = encode_value(unit)
    @test encoded.value["type"] == "quantity"
    @test encoded.value["magnitude"]["value"] ≈ 1000 / 3600
    # dimensionless value with a dimensionless unit (angles)
    angle = eq_display_unit(0.5, eq_unit("deg"))
    @test angle ≈ pi / 180
    @test encode_value(angle).value["type"] == "real"
    # arrays: every element must match
    @test eq_display_unit(eq_vec(speed, speed), kmh) == kmh
    @test_throws EqError eq_display_unit(eq_vec(speed, eq_mul(1.0, eq_unit("s"))), kmh)
    # a mismatch names both dimensions
    error = try
        eq_display_unit(speed, eq_unit("s"))
        nothing
    catch e
        e
    end
    @test error isa EqError
    @test occursin("length/time^-1", error.message) || occursin("length", error.message)
    @test occursin("time", error.message)
    @test_throws EqError eq_display_unit("text", eq_unit("m"))
    @test_throws EqError eq_display_unit(1.0, "m")
    @test_throws EqError eq_display_unit(1.0, 0.0)
    @test_throws EqError eq_display_unit(1.0, eq_mul(0.0, eq_unit("m")))
end

@testset "quantities in the kernel encoding (kernel-values)" begin
    force = eq_mul(10895.18815, eq_unit("newton"))
    node = encode_value(force).value
    @test node["type"] == "quantity"
    @test node["magnitude"]["value"] == 10895.18815
    @test node["dimension"] == [
        Dict("base" => "length", "power" => [1, 1]),
        Dict("base" => "mass", "power" => [1, 1]),
        Dict("base" => "time", "power" => [-2, 1]),
    ]
    back = decode_value(encode_value(force))
    @test back ≈ force
    # derived units encode as SI base units
    power = encode_value(eq_mul(119.0, eq_unit("kW"))).value
    @test power["magnitude"]["value"] == 119000.0
    @test [c["base"] for c in power["dimension"]] == ["length", "mass", "time"]
    @test [c["power"][1] for c in power["dimension"]] == [2, 1, -3]
    # fractional powers
    root = eq_pow(eq_mul(4.0, eq_unit("m")), 0.5)
    @test encode_value(root).value["dimension"][1]["power"] == [1, 2]
    # complex magnitudes
    z = eq_mul(ComplexF64(1, 2), eq_unit("V"))
    @test encode_value(z).value["magnitude"]["type"] == "complex"
end

@testset "approximate equality" begin
    near = 1.0 + 1e-14
    @test exact_boolean()
    @test eq_eq(1.0, near) == 0.0                         # exact by default
    @test eq_ne(1.0, near) == 1.0
    with_exact_boolean(false) do
        @test !exact_boolean()
        @test eq_eq(1.0, near) == 1.0
        @test eq_ne(1.0, near) == 0.0
        @test eq_eq(1.0, 1.001) == 0.0                    # far outside 1e-12
        @test eq_eq(0.1 + 0.2, 0.3) == 1.0
        @test eq_eq(0.0, 1e-30) == 0.0                    # relative: zero is only zero
        @test eq_eq(Inf, 1e308) == 0.0
        @test eq_eq(Inf, Inf) == 1.0
        @test eq_eq(NaN, NaN) == 0.0
        @test eq_eq(ComplexF64(1, 1), ComplexF64(1 + 1e-14, 1)) == 1.0
        # quantities are compared in SI base units, arrays elementwise, strings exactly
        @test eq_eq(eq_mul(0.1, eq_unit("km")), eq_mul(100.0 + 1e-12, eq_unit("m"))) == 1.0
        @test eq_eq(eq_vec(1.0, 2.0), eq_vec(near, 3.0)) == reshape([1.0, 0.0], 2, 1)
        @test eq_eq("a", "a") == 1.0 && eq_eq("a", "b") == 0.0
        # ordering stays exact
        @test eq_lt(1.0, near) == 1.0
        @test eq_le(near, 1.0) == 0.0
        # membership uses the same equality
        @test eq_in(1.0, eq_vec(5.0, near)) == 1.0
    end
    @test exact_boolean()
    with_exact_boolean(true) do
        @test eq_eq(1.0, near) == 0.0
    end
end

@testset "offset temperatures" begin
    C, F, K, dC, dF = eq_unit("°C"), eq_unit("°F"), eq_unit("K"), eq_unit("Δ°C"), eq_unit("Δ°F")
    kelvin(x) = ustrip(uconvert(u"K", x))
    @test kelvin(eq_mul(20.0, C)) ≈ 293.15
    @test kelvin(eq_mul(20.0, F)) ≈ 266.483 atol = 1e-3
    @test kelvin(eq_mul(20.0, dC)) ≈ 20
    @test kelvin(eq_mul(20.0, dF)) ≈ 11.1111 atol = 1e-4
    @test kelvin(eq_add(eq_mul(20.0, C), eq_mul(5.0, dC))) ≈ 298.15
    @test kelvin(eq_add(eq_mul(20.0, C), eq_mul(5.0, C))) ≈ 571.3          # two absolute temperatures
    @test kelvin(eq_sub(eq_mul(30.0, C), eq_mul(20.0, C))) ≈ 10
    @test kelvin(eq_mul(2.0, eq_mul(20.0, C))) ≈ 586.3
    @test kelvin(eq_sub(eq_mul(100.0, C), eq_mul(50.0, F))) ≈ 90 atol = 1e-9
    @test eq_lt(eq_mul(20.0, C), eq_mul(300.0, K)) == 1.0
    @test kelvin(eq_mul(eq_neg(300.0), C)) ≈ -26.85                       # no absolute-zero check
    @test_throws EqError eq_add(eq_mul(20.0, C), 1.0)
    @test_throws EqError eq_mul(eq_vec(10, 20, 30), C)                  # the reference application: an error
    @test_throws EqError eq_div(eq_unit("W"), C)
    @test_throws EqError eq_mul(eq_mul(2.0, eq_unit("m")), C)
    @test eq_display_unit(eq_mul(20.0, C), C) === C
    @test_throws EqError eq_display_unit(eq_unit("m"), C)
end
