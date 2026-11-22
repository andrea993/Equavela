# the reference application units.
#
# Generated code never names a Unitful unit: a worksheet unit name `km` becomes
# `eq_unit("km")`. The table is read from `units.tsv` (also read by the Rust static
# analysis, so both sides agree on names and dimensions). Every unit is stored as a
# **quantity in SI base units** whose magnitude is the unit's SI value (`km` is
# `1000.0 m`), so results always carry base units, mixed-unit arithmetic never has
# to promote between units, and a display unit (`= ... km/hr`) is just such a quantity
# (its magnitude is the divisor of the SI value). Dimensionless units (`deg`, `rad`) are
# plain numbers: `deg` is pi/180.

const _UNITS_FILE = joinpath(@__DIR__, "units.tsv")
Base.include_dependency(_UNITS_FILE)

# A definition is numbers, Unitful unit names, `*`, `/` and `^`. Unitful's `uparse` evaluates
# into the Unitful module, which precompilation forbids, so the expression is walked here.
function _eval_unit_expr(expression)
    if expression isa Number
        return Float64(expression)
    elseif expression isa Symbol
        isdefined(Unitful, expression) || error("units.tsv: unknown Unitful unit $expression")
        return getfield(Unitful, expression)
    elseif expression isa Expr && expression.head === :call && length(expression.args) == 3
        operator, left, right = expression.args
        a, b = _eval_unit_expr(left), _eval_unit_expr(right)
        operator === :* && return a * b
        operator === :/ && return a / b
        operator === :^ && return a^b
    end
    error("units.tsv: unsupported definition $expression")
end

function _si_unit_value(definition::AbstractString)
    parsed = _eval_unit_expr(Meta.parse(definition))
    quantity = parsed isa Unitful.Units ? 1.0 * parsed : parsed
    if dimension(quantity) == NoDims
        return Float64(real(uconvert(NoUnits, quantity)))
    end
    preferred = upreferred(quantity)
    Float64(ustrip(preferred)) * unit(preferred)
end

"""
Parse `units.tsv`: the prefix list `(name, power of ten)`, and the unit entries
`(name, dimension exponents, prefixable, SI value)`.
"""
function _read_unit_table(text::AbstractString)
    prefixes = Tuple{String,Int}[]
    entries = Tuple{String,NTuple{7,Int},Bool,Any}[]
    for line in eachline(IOBuffer(text))
        line = strip(line)
        (isempty(line) || startswith(line, '#')) && continue
        fields = split(line)
        if fields[1] == "@prefix"
            push!(prefixes, (String(fields[2]), parse(Int, fields[3])))
        else
            length(fields) == 4 || error("units.tsv: bad line `$line`")
            dims = Tuple(parse.(Int, split(fields[2], ',')))
            length(dims) == 7 || error("units.tsv: bad dimension in `$line`")
            push!(
                entries,
                (String(fields[1]), dims, fields[3] == "p", _si_unit_value(fields[4])),
            )
        end
    end
    prefixes, entries
end

const _UNIT_PREFIXES, _UNIT_ENTRIES = _read_unit_table(read(_UNITS_FILE, String))

"Every accepted unit name (plain names first, so a plain name beats a prefix reading)."
const _UNIT_TABLE = let table = Dict{String,Any}(), dimensions = Dict{String,NTuple{7,Int}}()
    for (name, dims, _, value) in _UNIT_ENTRIES
        table[name] = value
        dimensions[name] = dims
    end
    for (name, dims, prefixable, value) in _UNIT_ENTRIES
        prefixable || continue
        for (prefix, power) in _UNIT_PREFIXES
            full = prefix * name
            haskey(table, full) && continue
            table[full] = parse(Float64, "1e$power") * value
            dimensions[full] = dims
        end
    end
    table
end

"""
An offset temperature unit, `°C` or `°F`
: a number in front of it becomes the absolute temperature in kelvin at
once, `scale·v + offset`, and from then on it is an ordinary kelvin value (so `20 °C + 5 °C` is
571.3 K, as in the reference application). Shown with the unit override `°C` or `°F`, the offset is taken off again.
"""
struct OffsetUnit
    name::String
    "Kelvin per degree."
    scale::Float64
    "Kelvin at zero degrees."
    offset::Float64
end

const _OFFSET_UNITS = Dict(
    "°C" => OffsetUnit("°C", 1.0, 273.15),
    "°F" => OffsetUnit("°F", 5 / 9, 459.67 * 5 / 9),
)

_kelvin() = _UNIT_TABLE["K"]

function _offset_temperature(number, unit::OffsetUnit)
    number isa Number && !(number isa Unitful.AbstractQuantity) && imag(number) == 0 ||
        eqerror("$(unit.name) needs a plain real number in front of it")
    (unit.scale * real(number) + unit.offset) * _kelvin()
end

_offset_misuse(unit::OffsetUnit) = eqerror(
    "$(unit.name) is an offset temperature: it only follows one number (20 $(unit.name)); " *
    "use K or Δ$(unit.name) in other expressions",
)

eq_mul(number::Number, unit::OffsetUnit) = _offset_temperature(number, unit)
eq_mul(unit::OffsetUnit, number::Number) = _offset_temperature(number, unit)
eq_mul(::AbstractArray, unit::OffsetUnit) = _offset_misuse(unit)
eq_mul(unit::OffsetUnit, ::AbstractArray) = _offset_misuse(unit)
eq_mul(unit::OffsetUnit, ::OffsetUnit) = _offset_misuse(unit)
for operation in (:eq_add, :eq_sub, :eq_div, :eq_pow)
    @eval $operation(unit::OffsetUnit, _) = _offset_misuse(unit)
    @eval $operation(_, unit::OffsetUnit) = _offset_misuse(unit)
    @eval $operation(unit::OffsetUnit, ::OffsetUnit) = _offset_misuse(unit)
end
eq_neg(unit::OffsetUnit) = _offset_misuse(unit)

"Whether `name` is a reference application unit name known to EqRuntime."
eq_is_unit(name::AbstractString) = haskey(_UNIT_TABLE, name)

"All unit names, sorted (tests compare them with the Rust table)."
eq_unit_names() = sort!(collect(keys(_UNIT_TABLE)))

"""
`eq_unit("km")`: the unit as a quantity in SI base units (`1000.0 m`), or a plain number
for a dimensionless unit (`deg` is pi/180). An unknown name is the error the reference application gives
for an undefined name.
"""
function eq_unit(name::AbstractString)
    offset = get(_OFFSET_UNITS, name, nothing)
    offset === nothing || return offset
    value = get(_UNIT_TABLE, name, nothing)
    value === nothing && eqerror("$name is undefined")
    value
end

const _DIMENSION_LABELS = ("length", "mass", "time", "current", "temperature", "amount",
    "luminous intensity")

"A readable dimension such as `length/time^2` for error messages."
function _describe_dimension(value)
    dims = value isa Unitful.AbstractQuantity ? dimension(value) : NoDims
    components = typeof(dims).parameters[1]
    isempty(components) && return "no units"
    parts = String[]
    for component in components
        symbol = typeof(component).parameters[1]
        label = get(_DIMENSION_NAMES, symbol, string(symbol))
        power = component.power
        push!(parts, power == 1 ? label : "$label^$(power)")
    end
    join(parts, "*")
end

_same_dimension(a, b) =
    (a isa Unitful.AbstractQuantity ? dimension(a) : NoDims) ==
    (b isa Unitful.AbstractQuantity ? dimension(b) : NoDims)

_check_override_value(value, unit) =
    if value isa AbstractMatrix
        foreach(element -> _check_override_value(element, unit), value)
    elseif value isa Number
        _same_dimension(value, unit) || eqerror(
            "the unit override does not match the result: the result has " *
            _describe_dimension(value) * ", the unit has " * _describe_dimension(unit),
        )
    else
        eqerror("a unit override needs a numeric result")
    end

"""
`eq_display_unit(value, unit)`: validate the unit override of an evaluation and
return the unit as SI quantity (its magnitude is the divisor that converts the SI result
to the display unit). The value itself is not changed. Every element of an array must
have the unit's dimension; the unit must be a nonzero real scalar.
"""
function eq_display_unit(value, unit::OffsetUnit)
    _check_override_value(value, _kelvin())
    unit
end
function eq_display_unit(value, unit)
    magnitude = unit isa Unitful.AbstractQuantity ? ustrip(unit) : unit
    magnitude isa Number && imag(magnitude) == 0 && !iszero(magnitude) &&
        isfinite(magnitude) ||
        eqerror("a unit override must be a unit or a nonzero real scalar")
    _check_override_value(value, unit)
    unit
end
