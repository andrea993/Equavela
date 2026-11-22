# Julia package interop: the conversion layer between EqRuntime
# values and plain Julia values. Generated code calls `eq_julia_call` only;
# conversion never happens in generated code.
#
#   to Julia n x 1 matrix -> Vector, other matrix -> Matrix, nested arrays
#               recurse, `EqRange` is collected, handles become their objects;
#               numbers, strings, quantities and functions pass unchanged.
#   from Julia Bool -> 1.0/0.0, integers/rationals/Float32 -> Float64,
#               Vector -> n x 1, Matrix -> matrix, tuples and named tuples ->
#               nested column arrays, Symbol -> string, `nothing`/`missing`
#               -> error, anything else -> opaque handle.
#   Indices returned by Julia functions stay 1-based; ORIGIN does not apply.

const _HANDLE_LOCK = ReentrantLock()
const _HANDLE_OBJECTS = Dict{String,Any}()
const _HANDLE_IDS = IdDict{Any,String}()
const _HANDLE_COUNTER = Ref(0)

"Forget all opaque handles issued so far (a handle id is only valid for the process that issued it)."
function clear_handles!()
    lock(_HANDLE_LOCK) do
        empty!(_HANDLE_OBJECTS)
        empty!(_HANDLE_IDS)
    end
    nothing
end

function _make_handle(object)
    lock(_HANDLE_LOCK) do
        id = get(_HANDLE_IDS, object, nothing)
        if id === nothing
            _HANDLE_COUNTER[] += 1
            id = "h" * string(_HANDLE_COUNTER[])
            _HANDLE_OBJECTS[id] = object
            _HANDLE_IDS[object] = id
        end
        OpaqueHandle(id, _qualified_type_name(object), _summary(object))
    end
end

function _qualified_type_name(object)
    type = typeof(object)
    name = string(nameof(type))
    parent = parentmodule(type)
    parent === Main ? "Main." * name : string(parent) * "." * name
end

function _summary(object)
    text = try
        sprint(show, object; context=:limit => true)
    catch
        string(typeof(object))
    end
    text = first(split(text, '\n'))
    length(text) > 80 ? first(text, 77) * "..." : text
end

"The Julia object behind an opaque handle."
function handle_value(handle::OpaqueHandle)
    lock(_HANDLE_LOCK) do
        haskey(_HANDLE_OBJECTS, handle.id) ||
            eqerror("unknown or released Julia handle $(handle.id) ($(handle.julia_type))")
        _HANDLE_OBJECTS[handle.id]
    end
end

"Convert a worksheet value to the plain Julia value a package function expects."
to_julia(handle::OpaqueHandle) = handle_value(handle)
to_julia(range::EqRange) = to_julia(eq_collect(range))
function to_julia(matrix::AbstractMatrix)
    converted = map(to_julia, matrix)
    size(converted, 2) == 1 ? vec(converted) : converted
end
to_julia(value) = value

"Convert the result of a Julia call to a worksheet value."
from_julia(::Nothing) = eqerror("the Julia function returned no value")
from_julia(::Missing) = eqerror("the Julia function returned missing")
from_julia(value::Bool) = value ? 1.0 : 0.0
from_julia(value::OpaqueHandle) = value
from_julia(value::Unitful.AbstractQuantity) = _clean(value)
from_julia(value::AbstractString) = String(value)
from_julia(value::Symbol) = String(value)
from_julia(value::Char) = string(value)
from_julia(value::Real) = Float64(value)
from_julia(value::Complex{<:Real}) = ComplexF64(value)
from_julia(value::Union{Tuple,NamedTuple}) =
    narrow(reshape(Any[from_julia(element) for element in value], :, 1))
function from_julia(array::AbstractArray)
    ndims(array) <= 2 ||
        eqerror("arrays with $(ndims(array)) dimensions are not worksheet values")
    matrix = ndims(array) == 1 ? reshape(collect(array), :, 1) : array
    narrow(map(from_julia, matrix))
end
from_julia(value) = _make_handle(value)

function _julia_failure(f, error)
    text = replace(strip(sprint(showerror, error)), r"\s*\n\s*" => " ")
    length(text) > 300 && (text = first(text, 297) * "...")
    EqError("Julia call $(f) failed: $(nameof(typeof(error))): $text")
end

"""
`eq_julia_call(f, args...)`: call the Julia function `f` with converted
arguments and convert the result back. Julia exceptions become `EqError` with
the exception type and message; `EqError` and `InterruptException` pass through.
"""
function eq_julia_call(f, args...)
    result = try
        f(map(to_julia, args)...)
    catch error
        error isa EqError && rethrow()
        error isa InterruptException && rethrow()
        throw(_julia_failure(f, error))
    end
    from_julia(result)
end
