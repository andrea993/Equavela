const FIXTURE_PATH = joinpath(
    @__DIR__, "..", "..", "..", "core", "fixtures", "kernel-values-v1.json"
)

plain_json(value) = JSON3.read(JSON3.write(value), Dict{String,Any})

@testset "typed kernel values" begin
    fixture = JSON3.read(read(FIXTURE_PATH, String))
    @test fixture.schema_version == 1

    nested = reshape(Any[1.0 + 2.0im, NaN], 1, 2)
    inputs = Dict{String,Any}(
        "finite-real" => 1.25,
        "non-finite-real" => -Inf,
        "complex" => 2.5 - 3.0im,
        "unicode-string" => "velocità α",
        "acceleration" => 9.81u"m/s^2",
        "inline-column-major-matrix" => reshape([1.0, 2.0, 3.0, 4.0], 2, 2),
        "nested-and-mixed-matrix" => reshape(Any["label", 0.5u"s", nested], 3, 1),
        "opaque-handle" => OpaqueHandle(
            "h-17", "Example.Model", "Example.Model(3 parameters)"
        ),
    )

    for case in fixture.cases
        encoded = encode_value(inputs[String(case.name)]; binary_threshold=256)
        @test plain_json(encoded.value) == plain_json(case.value)
        @test isempty(encoded.descriptors)
        @test isempty(encoded.payloads)
        decoded = decode_value(encoded)
        @test encode_value(decoded; binary_threshold=256).value == encoded.value
    end
end

@testset "binary matrix values" begin
    inline = encode_value(reshape(fill(1.5, 255), 1, 255); binary_threshold=256)
    @test inline.value["storage"]["type"] == "inline"
    @test isempty(inline.descriptors)

    source = reshape([Float64(i) + 0.25 for i in 0:255], 16, 16)
    encoded = encode_value(source; binary_threshold=256)
    @test encoded.value == Dict(
        "type" => "matrix",
        "rows" => 16,
        "cols" => 16,
        "storage" => Dict("type" => "binary", "index" => 0, "dtype" => "f64le"),
    )
    @test encoded.descriptors == [Dict(
        "bytes" => 2048,
        "dtype" => "f64le",
        "shape" => [16, 16],
        "order" => "column-major",
    )]
    @test length(only(encoded.payloads)) == 2048
    @test decode_value(encoded) == source

    complex_source = reshape(
        [ComplexF64(i, -i - 0.5) for i in 0:255], 256, 1
    )
    complex_encoded = encode_value(complex_source; binary_threshold=256)
    @test complex_encoded.descriptors[1]["dtype"] == "c128le"
    @test length(complex_encoded.payloads[1]) == 4096
    @test decode_value(complex_encoded) == complex_source
end

@testset "interop edge values" begin
    @test encode_value(true).value == Dict("type" => "real", "value" => 1.0)
    @test encode_value(false).value == Dict("type" => "real", "value" => 0.0)
    @test_throws ArgumentError encode_value(nothing)

    fractional = encode_value(3.0u"m^(1//2)")
    @test fractional.value["dimension"] == [
        Dict("base" => "length", "power" => [1, 2])
    ]
    @test decode_value(fractional) == 3.0u"m^(1//2)"
end
