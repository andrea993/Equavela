# the reference application physical constants. The names, dimensions and CODATA values
# are in `constants.tsv`, which the Rust code generator and dimensional analysis also read
# (`core/src/constants.rs`). Generated code never writes a value: a constant `c` becomes
# `eq_constant("c")`, which is a quantity in SI base units, like `eq_unit`.

const _CONSTANTS_FILE = joinpath(@__DIR__, "constants.tsv")
Base.include_dependency(_CONSTANTS_FILE)

const _BASE_UNIT_NAMES = ("m", "kg", "s", "A", "K", "mol", "cd")

function _read_constants(text::AbstractString)
    canonical = Dict{String,Any}()
    aliases = Pair{String,String}[]
    for line in eachline(IOBuffer(text))
        line = strip(line)
        (isempty(line) || startswith(line, '#')) && continue
        fields = split(line)
        if fields[1] == "@alias"
            push!(aliases, String(fields[2]) => String(fields[3]))
            continue
        end
        length(fields) == 3 || error("constants.tsv: bad line `$line`")
        exponents = parse.(Int, split(fields[2], ','))
        length(exponents) == 7 || error("constants.tsv: bad dimension in `$line`")
        value = parse(Float64, fields[3]) * one(Float64)
        for (unit, exponent) in zip(_BASE_UNIT_NAMES, exponents)
            exponent == 0 || (value = value * eq_unit(unit)^exponent)
        end
        canonical[String(fields[1])] = value
    end
    table = copy(canonical)
    for (alias, target) in aliases
        table[alias] = canonical[target]
    end
    table, sort!(collect(keys(canonical)))
end

const _CONSTANT_TABLE, _CONSTANT_NAMES = _read_constants(read(_CONSTANTS_FILE, String))

"""
`eq_constant("c")`: a reference application physical constant as a quantity in SI base units (a plain
number for the dimensionless fine-structure constant `α`). An unknown name is the error
the reference application gives for an undefined name.
"""
function eq_constant(name::AbstractString)
    value = get(_CONSTANT_TABLE, name, nothing)
    value === nothing && eqerror("$name is undefined")
    value
end

"The canonical constant names, sorted (the Rust table lists the same names)."
eq_constant_names() = copy(_CONSTANT_NAMES)
