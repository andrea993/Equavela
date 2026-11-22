# Precompile workload. It runs only while the package image is being
# built (`jl_generating_output`), and drives the real request path once, so the compiled
# code of `serve`, the handlers, the JSON3 reader/writer and the EqRuntime calls of a typical
# worksheet is stored in the package image. Without it the first request spent more than a
# second compiling `default_handler`. The kernel behaves identically with or without it, and
# a failing workload never breaks the build. This is independent of the optional sysimage
# (scripts/build-sysimage.jl), which contains this code as well.

# Evaluating into a module that is not part of the package being compiled is an error while
# the image is built, so the workload worksheet lives in a submodule of EquavelaKernel.
module PrecompileWorksheet
using EqRuntime
end

function _precompile_workload()
    WORKSHEETS["precompile"] = PrecompileWorksheet
    region(id; code=nothing, value=nothing) =
        Dict{String,Any}("id" => id, "code" => code, "value" => value)
    regions = [
        region("x"; code="x_v1 = eq_mul(3.0, eq_unit(\"m\"))"),
        region("y"; code="y_v1 = eq_pow(x_v1, 2.0)"),
        region("show"; value="y_v1"),
        region("M"; code="M_v1 = eq_matrix(2, 2, 2.0, 1.0, 1.0, 3.0)"),
        region("Mi"; value="eq_pow(M_v1, -1.0)"),
        region("det"; value="eq_det(M_v1)"),
        region("c"; value="eq_add(1.0, eq_mul(2.0, 1.0im))"),
        region("s"; value="\"text\""),
        region("bad"; value="eq_add(x_v1, eq_unit(\"s\"))"),
    ]
    request(id, method, params=nothing) = JSON3.write(
        params === nothing ?
        Dict{String,Any}("jsonrpc" => "2.0", "id" => id, "method" => method) :
        Dict{String,Any}("jsonrpc" => "2.0", "id" => id, "method" => method,
            "params" => params))
    lines = String[
        request(1, "version"),
        request(2, "ping"),
        request(3, "evaluate", Dict{String,Any}("worksheet" => "precompile",
            "origin" => 0, "tol" => 1e-3, "regions" => regions)),
        request(4, "discard", Dict{String,Any}("worksheet" => "precompile")),
        request(5, "no_such_method"),
        "not json",
        request(6, "shutdown"),
    ]
    serve(IOBuffer(join(lines, "\n") * "\n"), IOBuffer())
    return nothing
end

if ccall(:jl_generating_output, Cint, ()) == 1
    try
        _precompile_workload()
    catch exception
        @warn "EquavelaKernel precompile workload failed" exception
    finally
        # No worksheet may stay behind in the image (the submodule itself is harmless).
        empty!(WORKSHEETS)
        _MODULE_COUNTER[] = 0
    end
end

# The kernel process talks over its real stdio: `bin/kernel.jl` calls
# `serve(stdin, stdout)`, which are a pipe and an `IOContext` of a pipe (on a TTY or a file the
# types differ, and the first request then compiles as before). The workload above only
# sees `IOBuffer`s, so these signatures are requested explicitly.
const _STDIO_IN = Base.PipeEndpoint
const _STDIO_OUT = Base.IOContext{Base.PipeEndpoint}
precompile(serve, (_STDIO_IN, _STDIO_OUT))
precompile(_read_binaries, (_STDIO_IN, JSON3.Object{Base.CodeUnits{UInt8,String},Vector{UInt64}}))
precompile(_write_result, (_STDIO_OUT, Int, Dict{String,Any}))
precompile(_write_result, (_STDIO_OUT, Int, BinaryResult))
precompile(_write, (_STDIO_OUT, Dict{String,Any}))
