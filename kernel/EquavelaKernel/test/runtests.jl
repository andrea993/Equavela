using Test

# No SymPy warm-up in the protocol tests, even when one asks for it (symbolic.jl tests it).
ENV["EQUAVELA_SYMBOLIC_WARMUP"] = "off"
using JSON3
using EqRuntime
using EquavelaKernel

function run_serve(input::String; handler=EquavelaKernel.default_handler)
    out = IOBuffer()
    EquavelaKernel.serve(IOBuffer(input), out; handler)
    return [JSON3.read(line) for line in split(strip(String(take!(out))), '\n') if !isempty(line)]
end

function protocol_handler(method, params, context, binaries)
    if method == "work"
        EquavelaKernel.progress!(context; fraction=0.25, message="Compiling")
        EquavelaKernel.progress!(context; fraction=1.0, message="Done")
        return Dict("answer" => params.answer, "binary_lengths" => length.(binaries))
    elseif method == "interrupt"
        throw(InterruptException())
    elseif method == "failure"
        throw(EquavelaKernel.KernelFailure(-32000, "Evaluation failed",
            Dict("category" => "evaluation", "retryable" => false,
                "details" => Dict("region" => "r7"))))
    end
    return EquavelaKernel.default_handler(method, params, context, binaries)
end

@testset "EquavelaKernel protocol" begin
    @testset "ping, version and shutdown" begin
        responses = run_serve(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n" *
            "{\"jsonrpc\":\"2.0\",\"id\":\"v\",\"method\":\"version\"}\n" *
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"shutdown\"}\n" *
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"ping\"}\n")
        @test length(responses) == 3
        @test responses[1].result == "pong"
        @test responses[2].id == "v"
        @test responses[2].result.package == "0.1.0"
        @test responses[2].result.protocol == 1
        @test responses[3].result === nothing
    end

    @testset "slow work is announced as kernel/activity" begin
        out = IOBuffer()
        context = EquavelaKernel.RequestContext(9, out, 0)
        EquavelaKernel.activity!(context, "compiling"; message="Plots")
        EquavelaKernel.activity!(EquavelaKernel.RequestContext(nothing, out, 0), "packages")
        EquavelaKernel.activity!(nothing, "symbolic")
        lines = [JSON3.read(line) for line in split(strip(String(take!(out))), '\n') if !isempty(line)]
        @test length(lines) == 1
        @test lines[1].method == "kernel/activity"
        @test lines[1].params.request_id == 9
        @test lines[1].params.kind == "compiling"
        @test lines[1].params.message == "Plots"
        # An invalid package request is refused before any work: nothing is announced.
        responses = run_serve("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"remove_packages\",\"params\":{}}\n")
        @test length(responses) == 1 && responses[1].id == 2 && haskey(responses[1], :error)
    end

    @testset "notifications have no response" begin
        responses = run_serve(
            "{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}\n" *
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n")
        @test length(responses) == 1
        @test responses[1].id == 2
    end

    @testset "progress is an ordered JSON-RPC notification" begin
        responses = run_serve(
            "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"work\"," *
            "\"params\":{\"answer\":42}}\n"; handler=protocol_handler)
        @test length(responses) == 3
        @test responses[1].method == "kernel/progress"
        @test responses[1].params.request_id == 9
        @test responses[1].params.sequence == 1
        @test responses[1].params.fraction == 0.25
        @test responses[2].params.sequence == 2
        @test responses[3].result.answer == 42
    end

    @testset "interrupt and evaluation errors are structured" begin
        interrupted = run_serve(
            "{\"jsonrpc\":\"2.0\",\"id\":\"job-4\",\"method\":\"interrupt\"}\n";
            handler=protocol_handler)[1]
        @test interrupted.error.code == -32800
        @test interrupted.error.message == "Interrupted"
        @test interrupted.error.data.category == "interrupted"
        @test interrupted.error.data.request_id == "job-4"
        @test interrupted.error.data.retryable

        failure = run_serve(
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"failure\"}\n";
            handler=protocol_handler)[1]
        @test failure.error.code == -32000
        @test failure.error.data.category == "evaluation"
        @test failure.error.data.details.region == "r7"
    end

    @testset "invalid messages use standard JSON-RPC errors" begin
        @test run_serve("{not json\n")[1].error.code == -32700
        @test run_serve("[]\n")[1].error.code == -32600
        @test run_serve("{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"ping\"}\n")[1].error.code == -32600
        @test run_serve("{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}\n")[1].error.code == -32600
        unknown = run_serve("{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"nope\"}\n")[1]
        @test unknown.error.code == -32601
        @test unknown.id == 3
        invalid_operation = run_serve("{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"manage_environment\",\"params\":{\"environment\":\".\",\"operation\":\"unknown\"}}\n")[1]
        @test invalid_operation.error.code == -32602
        @test invalid_operation.id == 4
    end

    @testset "binary request payloads are consumed exactly" begin
        header = "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"work\"," *
            "\"params\":{\"answer\":7},\"binary\":[" *
            "{\"bytes\":8,\"dtype\":\"f64le\",\"shape\":[1]," *
            "\"order\":\"column-major\"}]}\n"
        input = header * String(UInt8[1, 2, 3, 4, 5, 6, 7, 8]) *
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"ping\"}\n"
        responses = run_serve(input; handler=protocol_handler)
        @test responses[3].result.binary_lengths == [8]
        @test responses[4].id == 7
    end

    @testset "binary responses write header then exact raw bytes" begin
        function binary_handler(method, params, context, binaries)
            descriptor = Dict("bytes" => 8, "dtype" => "f64le", "shape" => [1],
                "order" => "column-major")
            return EquavelaKernel.BinaryResult(Dict("kind" => "scalar"), [descriptor],
                [UInt8[1, 2, 3, 4, 5, 6, 7, 8]])
        end
        out = IOBuffer()
        EquavelaKernel.serve(
            IOBuffer("{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"binary\"}\n"),
            out; handler=binary_handler)
        bytes = take!(out)
        newline = findfirst(==(UInt8('\n')), bytes)
        header = JSON3.read(String(bytes[1:newline-1]))
        @test header.binary[1].bytes == 8
        @test bytes[newline+1:end] == UInt8[1, 2, 3, 4, 5, 6, 7, 8]
    end

    @testset "EqRuntime typed values are framed automatically" begin
        function typed_handler(method, params, context, binaries)
            if method == "complex"
                return EqRuntime.encode_value(1.5 - 2.0im)
            end
            return EqRuntime.encode_value(reshape(collect(0.0:255.0), 16, 16))
        end

        scalar = run_serve(
            "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"complex\"}\n";
            handler=typed_handler)[1]
        @test scalar.result.type == "complex"
        @test scalar.result.real == 1.5
        @test scalar.result.imag == -2.0

        out = IOBuffer()
        EquavelaKernel.serve(
            IOBuffer("{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"matrix\"}\n"),
            out; handler=typed_handler)
        bytes = take!(out)
        newline = findfirst(==(UInt8('\n')), bytes)
        header = JSON3.read(String(bytes[1:newline-1]))
        @test header.result.storage.type == "binary"
        @test header.result.storage.index == 0
        @test header.binary[1].dtype == "f64le"
        @test header.binary[1].shape == [16, 16]
        @test length(bytes[newline+1:end]) == 256 * 8
        @test bytes[newline+1:newline+8] == reinterpret(UInt8, [0.0])
    end
end
include("evaluate.jl")
include("environment.jl")
include("python_env.jl")
include("symbolic.jl")
include("xls_bridge.jl")
include("julia_version.jl")
