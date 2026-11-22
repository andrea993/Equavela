"""
    EquavelaKernel

Julia numeric kernel: newline-delimited JSON-RPC 2.0 server over stdio.
"""
module EquavelaKernel

using JSON3
using EqRuntime

export serve
export BinaryResult, KernelFailure, progress!, worksheet_module

const PKG_VERSION = "0.1.0"
const PROTOCOL_VERSION = 1
const INTERRUPTED = -32800

struct KernelFailure <: Exception
    code::Int
    message::String
    data::Any
end

KernelFailure(code::Integer, message::AbstractString) =
    KernelFailure(Int(code), String(message), nothing)

struct BinaryResult
    result::Any
    descriptors::Vector{Any}
    payloads::Vector{Vector{UInt8}}
end

BinaryResult(result, descriptors::AbstractVector, payloads::AbstractVector) =
    BinaryResult(result, Any[descriptor for descriptor in descriptors],
        Vector{UInt8}[Vector{UInt8}(payload) for payload in payloads])

struct Shutdown end

mutable struct RequestContext
    id::Any
    io::IO
    sequence::Int
end

function _response(id, result)
    return Dict{String,Any}("jsonrpc" => "2.0", "id" => id, "result" => result)
end

function _error(id, code::Integer, message::AbstractString, data=nothing)
    error = Dict{String,Any}("code" => code, "message" => message)
    data === nothing || (error["data"] = data)
    return Dict{String,Any}("jsonrpc" => "2.0", "id" => id, "error" => error)
end

function _write(io, obj)
    JSON3.write(io, obj)
    write(io, '\n')
    flush(io)
end

function progress!(context::RequestContext; fraction=nothing, message=nothing)
    context.id === nothing && return nothing
    if fraction !== nothing && (!(fraction isa Real) || !isfinite(fraction) || !(0 <= fraction <= 1))
        throw(KernelFailure(-32602, "Progress fraction must be between 0 and 1"))
    end
    if message !== nothing && !(message isa AbstractString)
        throw(KernelFailure(-32602, "Progress message must be a string"))
    end
    context.sequence += 1
    params = Dict{String,Any}(
        "request_id" => context.id,
        "sequence" => context.sequence,
    )
    fraction === nothing || (params["fraction"] = Float64(fraction))
    message === nothing || (params["message"] = String(message))
    _write(context.io, Dict{String,Any}(
        "jsonrpc" => "2.0",
        "method" => "kernel/progress",
        "params" => params,
    ))
    return nothing
end

include("evaluate.jl")
include("symbolic.jl")
include("xls_bridge.jl")

function __init__()
    EqRuntime.register_xls_backend!(_xls_read, _xls_write)
end

function default_handler(method, params, context, binaries)
    if method == "ping"
        return "pong"
    elseif method == "version"
        return Dict{String,Any}(
            "julia" => string(VERSION),
            "package" => PKG_VERSION,
            "protocol" => PROTOCOL_VERSION,
        )
    elseif method == "evaluate"
        return evaluate_request(params, context)
    elseif method == "discard"
        return discard_request(params)
    elseif method == "install_packages"
        return install_packages_request(params, context)
    elseif method == "remove_packages"
        return remove_packages_request(params, context)
    elseif method == "develop_packages"
        return develop_packages_request(params, context)
    elseif method == "terminal_prepare"
        return terminal_prepare_request(params, context)
    elseif method == "complete"
        return complete_request(params, context)
    elseif method == "repl"
        return repl_request(params, context)
    elseif method == "manage_environment"
        return manage_environment_request(params, context)
    elseif method == "set_compatibility"
        return set_compatibility_request(params, context)
    elseif method == "symbolic"
        return symbolic_request(params, context)
    elseif method == "symbolic_warmup"
        start_symbolic_warmup!()
        return symbolic_status_request()
    elseif method == "symbolic_status"
        return symbolic_status_request()
    elseif method == "shutdown"
        return Shutdown()
    end
    throw(KernelFailure(-32601, "Method not found: $method"))
end

function _valid_id(id)
    return (id isa Integer && id >= 0) || id isa AbstractString
end

function _descriptor_bytes(descriptor)
    (descriptor isa JSON3.Object || descriptor isa AbstractDict) ||
        throw(KernelFailure(-32602, "Invalid binary descriptor"))
    field(key) = descriptor isa JSON3.Object ? get(descriptor, key, nothing) :
        get(descriptor, String(key), get(descriptor, key, nothing))
    bytes = field(:bytes)
    dtype = field(:dtype)
    shape = field(:shape)
    order = field(:order)
    bytes isa Integer && bytes >= 0 || throw(KernelFailure(-32602, "Invalid binary byte count"))
    shape isa AbstractVector || throw(KernelFailure(-32602, "Invalid binary shape"))
    all(length -> length isa Integer && length >= 0, shape) ||
        throw(KernelFailure(-32602, "Invalid binary shape"))
    order == "column-major" || throw(KernelFailure(-32602, "Unsupported binary order"))
    element_bytes = if dtype == "f64le" || dtype == "i64le"
        8
    elseif dtype == "c128le"
        16
    elseif dtype == "u8"
        1
    else
        throw(KernelFailure(-32602, "Unsupported binary dtype"))
    end
    expected = try
        elements = 1
        for length in shape
            elements = Base.Checked.checked_mul(elements, Int(length))
        end
        Base.Checked.checked_mul(elements, element_bytes)
    catch
        throw(KernelFailure(-32602, "Binary shape is too large"))
    end
    bytes == expected || throw(KernelFailure(-32602,
        "Binary descriptor declares $bytes bytes but requires $expected"))
    return Int(bytes)
end

function _read_binaries(io::IO, req)
    descriptors = get(req, :binary, nothing)
    descriptors === nothing && return Vector{Vector{UInt8}}()
    descriptors isa JSON3.Array || throw(KernelFailure(-32602, "`binary` must be an array"))
    payloads = Vector{Vector{UInt8}}()
    for descriptor in descriptors
        count = _descriptor_bytes(descriptor)
        payload = read(io, count)
        length(payload) == count || throw(KernelFailure(-32602, "Truncated binary payload"))
        push!(payloads, payload)
    end
    return payloads
end

function _write_result(io::IO, id, result)
    if result isa EncodedValue
        result = BinaryResult(result.value, result.descriptors, result.payloads)
    end
    if result isa BinaryResult
        length(result.descriptors) == length(result.payloads) ||
            throw(ArgumentError("binary descriptor/payload count mismatch"))
        for (descriptor, payload) in zip(result.descriptors, result.payloads)
            expected = _descriptor_bytes(descriptor)
            length(payload) == expected || throw(ArgumentError(
                "binary payload has $(length(payload)) bytes, expected $expected"))
        end
        response = _response(id, result.result)
        response["binary"] = result.descriptors
        _write(io, response)
        for payload in result.payloads
            write(io, payload)
        end
        flush(io)
    else
        _write(io, _response(id, result))
    end
end

"""
    serve(io_in=stdin, io_out=stdout)

Read one JSON-RPC request per line from `io_in` and write one response per
line to `io_out`, flushing after each. Returns after a `shutdown` request or
at end of input.
"""
function serve(io_in::IO=stdin, io_out::IO=stdout; handler=default_handler)
    while !eof(io_in)
        line = readline(io_in)
        isempty(strip(line)) && continue
        req = try
            JSON3.read(line)
        catch
            _write(io_out, _error(nothing, -32700, "Parse error"))
            continue
        end
        if !(req isa JSON3.Object) || get(req, :jsonrpc, nothing) != "2.0"
            _write(io_out, _error(nothing, -32600, "Invalid Request"))
            continue
        end
        has_id = haskey(req, :id)
        id = has_id ? req.id : nothing
        method = get(req, :method, nothing)
        if !(method isa AbstractString) || (has_id && !_valid_id(id))
            _write(io_out, _error(has_id && _valid_id(id) ? id : nothing, -32600,
                "Invalid Request"))
            continue
        end
        params = get(req, :params, JSON3.read("{}"))
        context = RequestContext(id, io_out, 0)
        try
            binaries = _read_binaries(io_in, req)
            result = handler(String(method), params, context, binaries)
            if result isa Shutdown
                has_id && _write_result(io_out, id, nothing)
                return nothing
            end
            has_id && _write_result(io_out, id, result)
        catch exception
            has_id || continue
            if exception isa InterruptException
                data = Dict{String,Any}(
                    "category" => "interrupted",
                    "request_id" => id,
                    "retryable" => true,
                )
                _write(io_out, _error(id, INTERRUPTED, "Interrupted", data))
            elseif exception isa KernelFailure
                _write(io_out, _error(id, exception.code, exception.message, exception.data))
            else
                data = Dict{String,Any}(
                    "category" => "internal",
                    "request_id" => id,
                    "retryable" => false,
                )
                # The exception is named in the message and logged (stderr is the kernel log), so
                # an internal error is never opaque (GitHub ).
                detail = first(replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " "), 500)
                @error "internal error in request $(repr(method))" exception=(exception, catch_backtrace())
                _write(io_out, _error(id, -32603, "Internal error: $detail", data))
            end
        end
    end
    return nothing
end

include("precompile.jl")

end # module
