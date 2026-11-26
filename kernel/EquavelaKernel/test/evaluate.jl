using Test
using JSON3
using EqRuntime
using EquavelaKernel

# Sends an `evaluate` request through the handler and returns
# (parsed JSON result, descriptors, payloads, progress notifications).
function evaluate(params::AbstractDict; id=1)
    out = IOBuffer()
    context = EquavelaKernel.RequestContext(id, out, 0)
    params = JSON3.read(JSON3.write(params))
    result = EquavelaKernel.default_handler("evaluate", params, context, Vector{UInt8}[])
    notifications = [JSON3.read(line) for line in split(strip(String(take!(out))), '\n') if !isempty(line)]
    return result, notifications
end

region(id; code=nothing, value=nothing) = Dict{String,Any}(
    "id" => id, "code" => code, "value" => value)

ok_value(result, i) = JSON3.read(JSON3.write(result.result["regions"][i]["value"]))

@testset "EquavelaKernel evaluate" begin
    @testset "values, definitions and ordering" begin
        result, _ = evaluate(Dict(
            "worksheet" => "w1",
            "regions" => [
                region("r1"; code="x_v1 = 2.0"),
                region("r2"; code="y_v1 = eq_add(x_v1, 3.0)", value="y_v1"),
                region("r3"; value="eq_vec(x_v1, y_v1)"),
                region("r4"; value="\"text\""),
                region("r5"; value="1.0 + 2.0im"),
            ]))
        regions = result.result["regions"]
        @test [r["id"] for r in regions] == ["r1", "r2", "r3", "r4", "r5"]
        @test all(r -> r["status"] == "ok", regions)
        @test regions[1]["value"] === nothing
        @test regions[2]["value"]["type"] == "real" && regions[2]["value"]["value"] == 5.0
        value = decode_value(EncodedValue(regions[3]["value"], Dict{String,Any}[], Vector{UInt8}[]))
        @test value == [2.0; 5.0;;]
        @test regions[4]["value"]["value"] == "text"
        @test regions[5]["value"]["type"] == "complex"
        @test result.descriptors == []
    end

    @testset "worksheets are isolated and persistent" begin
        evaluate(Dict("worksheet" => "iso-a", "regions" => [region("r"; code="a_v1 = 1.0")]))
        again, _ = evaluate(Dict("worksheet" => "iso-a", "regions" => [region("r"; value="a_v1")]))
        @test again.result["regions"][1]["status"] == "ok"
        other, _ = evaluate(Dict("worksheet" => "iso-b", "regions" => [region("r"; value="a_v1")]))
        @test other.result["regions"][1]["status"] == "error"
        @test occursin("a_v1", other.result["regions"][1]["error"]["message"])
        # reset discards the old state
        reset, _ = evaluate(Dict("worksheet" => "iso-a", "reset" => true,
            "regions" => [region("r"; value="a_v1")]))
        @test reset.result["regions"][1]["status"] == "error"
        # discard drops the module
        evaluate(Dict("worksheet" => "iso-c", "regions" => [region("r"; code="c_v1 = 1.0")]))
        @test haskey(EquavelaKernel.WORKSHEETS, "iso-c")
        @test EquavelaKernel.default_handler("discard", JSON3.read("{\"worksheet\":\"iso-c\"}"),
            EquavelaKernel.RequestContext(1, IOBuffer(), 0), []) === nothing
        @test !haskey(EquavelaKernel.WORKSHEETS, "iso-c")
        # worksheet modules do not leak names into each other or into Main
        @test !isdefined(Main, :a_v1)
    end

    @testset "errors are per region and located" begin
        program = """
        f_v1 = (x) -> begin
            local __v
            local __s
            try
                __s = 1
                __v = eq_add(x, 1.0)
                __s = 2
                __v = eq_error("boom")
                __s = 3
                __v = x
            catch __e
                throw(eq_locate(__e, __s))
            end
            __v
        end
        """
        result, _ = evaluate(Dict(
            "worksheet" => "err",
            "regions" => [
                region("def"; code=program),
                region("bad"; value="f_v1(1.0)"),
                region("after"; value="eq_add(1.0, 1.0)"),
                region("julia"; value="1 + \"a\""),
                region("syntax"; value="eq_add(1.0,"),
                region("nothing"; value="nothing"),
                region("codeerr"; code="z_v1 = eq_error(\"bad definition\")"),
                region("undef"; value="z_v1"),
                region("fn"; value="sin"),
                region("arity"; value="eq_sin(1.0, 2.0)"),
                region("fewer"; value="eq_mod(5.0)"),
            ]))
        regions = result.result["regions"]
        @test regions[1]["status"] == "ok"
        @test regions[2]["status"] == "error"
        @test regions[2]["error"]["message"] == "boom"
        @test regions[2]["error"]["statement"] == 2
        @test regions[2]["error"]["category"] == "evaluation"
        @test !haskey(regions[2]["error"], "julia_type")
        @test regions[3]["status"] == "ok"          # later regions still run
        @test regions[3]["value"]["value"] == 2.0
        @test regions[4]["status"] == "error"
        @test regions[4]["error"]["julia_type"] == "MethodError"
        @test regions[4]["error"]["statement"] === nothing
        @test regions[5]["status"] == "error"
        @test regions[5]["error"]["julia_type"] == "ParseError"
        @test regions[6]["status"] == "error"
        @test occursin("no value", regions[6]["error"]["message"])
        @test regions[7]["error"]["message"] == "bad definition"
        @test regions[8]["status"] == "error"
        @test occursin("z_v1", regions[8]["error"]["message"])
        # a wrong argument count reads as the reference application says it, not as a Julia MethodError
        @test regions[10]["error"]["message"] == "sin needs 1 argument but is applied to 2"
        @test regions[11]["error"]["message"] == "mod needs 2 arguments but is applied to 1"
        @test regions[9]["status"] == "error"
        @test occursin("cannot display", regions[9]["error"]["message"])
    end

    @testset "calling a non-function value reports a clean error" begin
        result, _ = evaluate(Dict(
            "worksheet" => "not_fn",
            "regions" => [
                region("r1"; code="M_v1 = [1.0, 2.0]"),
                region("r2"; value="M_v1(1.0)"),
            ],
        ))
        err = result.result["regions"][2]["error"]
        @test err["message"] == "cannot call a value that is not a function"
        @test !haskey(err, "julia_type")
    end

    @testset "interrupts abort the request" begin
        @test_throws InterruptException evaluate(Dict(
            "worksheet" => "int",
            "regions" => [region("r"; code="throw(InterruptException())")]))
    end

    @testset "binary values are merged into one frame" begin
        result, _ = evaluate(Dict(
            "worksheet" => "bin",
            "regions" => [
                region("small"; value="eq_vec(1.0, 2.0)"),
                region("big"; value="reshape(collect(0.0:255.0), 16, 16)"),
                region("nested"; value="eq_vec(reshape(collect(0.0:299.0), 10, 30), 3.0)"),
                region("big2"; value="reshape(collect(1.0:256.0) .* im, 16, 16)"),
            ]))
        @test length(result.descriptors) == 3
        regions = result.result["regions"]
        @test regions[2]["value"]["storage"]["type"] == "binary"
        @test regions[2]["value"]["storage"]["index"] == 0
        nested = regions[3]["value"]["storage"]["values"][1]
        @test nested["storage"]["index"] == 1
        @test regions[4]["value"]["storage"]["index"] == 2
        @test regions[4]["value"]["storage"]["dtype"] == "c128le"
        @test length(result.payloads) == 3
        @test result.descriptors[2]["shape"] == [10, 30]
        # each index decodes to the right data
        encoded = EncodedValue(regions[3]["value"],
            Dict{String,Any}[d for d in result.descriptors],
            result.payloads)
        decoded = decode_value(encoded)
        @test decoded[1] == reshape(collect(0.0:299.0), 10, 30)
        @test decoded[2] == 3.0
    end

    @testset "origin, packages and progress" begin
        result, notes = evaluate(Dict(
            "worksheet" => "org", "origin" => 1,
            "packages" => ["JSON3", "NoSuchPackageXyz"],
            "regions" => [
                region("o"; value="origin()"),
                region("la"; value="JSON3.write([3.0, 4.0])"),
            ]); id="req-9")
        @test result.result["regions"][1]["value"]["value"] == 1.0
        @test result.result["regions"][2]["value"]["value"] == "[3.0,4.0]"
        packages = result.result["packages"]
        @test packages[1]["error"] === nothing
        @test packages[2]["error"] !== nothing
        @test !isempty(notes) && notes[end]["params"]["fraction"] == 1.0
        @test notes[1]["params"]["request_id"] == "req-9"
        default, _ = evaluate(Dict("worksheet" => "org2", "regions" => [region("o"; value="origin()")]))
        @test default.result["regions"][1]["value"]["value"] == 0.0
    end

    @testset "tol" begin
        result, _ = evaluate(Dict(
            "worksheet" => "tol1", "tol" => 0.5, "origin" => 1,
            "regions" => [
                region("t"; value="tol()"),
                region("o"; value="origin()"),
            ]))
        @test result.result["regions"][1]["value"]["value"] == 0.5
        @test result.result["regions"][2]["value"]["value"] == 1.0
        default, _ = evaluate(Dict("worksheet" => "tol2", "regions" => [region("t"; value="tol()")]))
        @test default.result["regions"][1]["value"]["value"] == 0.001
        # the scope ends with the request
        again, _ = evaluate(Dict("worksheet" => "tol1", "regions" => [region("t2"; value="tol()")]))
        @test again.result["regions"][1]["value"]["value"] == 0.001
        for bad in ("x", 0, -1.0, true)
            error = try
                evaluate(Dict("worksheet" => "w", "regions" => [], "tol" => bad))
            catch exception
                exception
            end
            @test error isa EquavelaKernel.KernelFailure && error.code == -32602
        end
    end

    @testset "ctol" begin
        # CTOL: the solve-block constraint tolerance of the request.
        result, _ = evaluate(Dict(
            "worksheet" => "ctol1", "ctol" => 0.5, "tol" => 0.25,
            "regions" => [
                region("c"; value="ctol()"),
                region("t"; value="tol()"),
            ]))
        @test result.result["regions"][1]["value"]["value"] == 0.5
        @test result.result["regions"][2]["value"]["value"] == 0.25
        default, _ = evaluate(Dict("worksheet" => "ctol2", "regions" => [region("c"; value="ctol()")]))
        @test default.result["regions"][1]["value"]["value"] == 0.001
        # zero is allowed for CTOL (unlike TOL): "as exact as the algorithm can be"
        zero, _ = evaluate(Dict("worksheet" => "ctol3", "ctol" => 0,
            "regions" => [region("c"; value="ctol()")]))
        @test zero.result["regions"][1]["value"]["value"] == 0.0
        # the scope ends with the request
        again, _ = evaluate(Dict("worksheet" => "ctol1", "regions" => [region("c2"; value="ctol()")]))
        @test again.result["regions"][1]["value"]["value"] == 0.001
        # a solve block reads the CTOL of the request: with the default the contradictory
        # constraints are refused, with a loose one they are accepted
        contradictory = [
            region("dom"; code="c_dom = [eq_constraint(:eq, x -> x, x -> 0.0), eq_constraint(:eq, x -> x, x -> 1.0)]"),
            region("find"; value="eq_find(c_dom, [0.3])"),
        ]
        strict, _ = evaluate(Dict("worksheet" => "ctol4", "regions" => contradictory))
        @test strict.result["regions"][2]["status"] == "error"
        loose, _ = evaluate(Dict("worksheet" => "ctol4", "ctol" => 1.0, "regions" => contradictory))
        @test loose.result["regions"][2]["status"] == "ok"
        @test loose.result["regions"][2]["value"]["value"] ≈ 0.5 atol = 1e-6
        for bad in ("x", -1.0, true)
            error = try
                evaluate(Dict("worksheet" => "w", "regions" => [], "ctol" => bad))
            catch exception
                exception
            end
            @test error isa EquavelaKernel.KernelFailure && error.code == -32602
        end
    end

    @testset "base_dir" begin
        # The directory of the worksheet, which READODS resolves a relative path against.
        # The scope ends with the request.
        directory = mktempdir()
        resolved, _ = evaluate(Dict("worksheet" => "ods1", "base_dir" => directory,
            "regions" => [region("r"; value="eq_READODS(\"missing.ods\")")]))
        @test resolved.result["regions"][1]["status"] == "error"
        @test occursin(joinpath(directory, "missing.ods"),
            resolved.result["regions"][1]["error"]["message"])
        again, _ = evaluate(Dict("worksheet" => "ods1",
            "regions" => [region("r2"; value="eq_READODS(\"missing.ods\")")]))
        @test occursin("save the worksheet first",
            again.result["regions"][1]["error"]["message"])
        for bad in ("", 3, true)
            error = try
                evaluate(Dict("worksheet" => "w", "regions" => [], "base_dir" => bad))
            catch exception
                exception
            end
            @test error isa EquavelaKernel.KernelFailure && error.code == -32602
        end
        # The scopes of a request nest: every optional field at once still runs the regions
        # (a captured variable once made two scopes call themselves).
        nested, _ = evaluate(Dict("worksheet" => "ods2", "base_dir" => directory,
            "tol" => 0.5, "ctol" => 0.25, "exact_boolean" => false, "origin" => 1,
            "regions" => [region("r"; value="eq_add(tol(), ctol())")]))
        @test nested.result["regions"][1]["status"] == "ok"
        @test nested.result["regions"][1]["value"]["value"] == 0.75
    end

    @testset "invalid parameters" begin
        function failure(params)
            try
                evaluate(params)
            catch exception
                return exception
            end
        end
        @test failure(Dict("regions" => [])) isa EquavelaKernel.KernelFailure
        @test failure(Dict("worksheet" => "", "regions" => [])).code == -32602
        @test failure(Dict("worksheet" => "w", "regions" => 3)).code == -32602
        @test failure(Dict("worksheet" => "w", "regions" => [Dict("code" => "1")])).code == -32602
        @test failure(Dict("worksheet" => "w", "regions" => [Dict("id" => "a", "code" => 3)])).code == -32602
        @test failure(Dict("worksheet" => "w", "regions" => [], "origin" => "x")).code == -32602
        @test failure(Dict("worksheet" => "w", "regions" => [], "packages" => [1])).code == -32602
    end

    @testset "full round trip through serve" begin
        request = JSON3.write(Dict("jsonrpc" => "2.0", "id" => 77, "method" => "evaluate",
            "params" => Dict("worksheet" => "serve", "regions" => [
                region("a"; code="a_v1 = eq_matrix(2, 2, 1.0, 2.0, 3.0, 4.0)", value="eq_mul(a_v1, a_v1)")]))) * "\n"
        out = IOBuffer()
        EquavelaKernel.serve(IOBuffer(request), out)
        lines = [JSON3.read(line) for line in split(strip(String(take!(out))), '\n')]
        response = lines[end]
        @test response.id == 77
        @test response.result.regions[1].status == "ok"
        @test response.result.regions[1].value.type == "matrix"
    end
end
