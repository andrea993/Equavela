# Golden support: program translations and the recursive comparison used by the
# fixture runner in semantics.jl.
#
# Each file in golden/programs/ is hand-written Julia that mimics the generator
# output for one worksheet (contract: src/programs.jl) and records its the reference application
# evaluations with `@case "rNN" expression`. Every file is loaded into its own
# module, because worksheets reuse names (A, N, f, t, ...).

const GOLDEN_PROGRAM_DIR = joinpath(@__DIR__, "golden", "programs")
const GOLDEN_PROGRAM_MODULES = Dict{String,Module}()

function golden_program_module(worksheet::AbstractString)
    get!(GOLDEN_PROGRAM_MODULES, worksheet) do
        mod = Module(Symbol("GoldenProgram_", worksheet))
        Core.eval(mod, quote
            using EqRuntime
            const RESULTS = Dict{String,Any}()
            macro case(id, expression)
                quote
                    RESULTS[$(esc(id))] = try
                        $(esc(expression))
                    catch error
                        error
                    end
                end
            end
        end)
        Base.include(mod, joinpath(GOLDEN_PROGRAM_DIR, worksheet * ".jl"))
        mod
    end
end

"Value of `@case id` in the translation of `worksheet`; a captured exception is rethrown."
function golden_program_result(worksheet::AbstractString, id::AbstractString)
    mod = golden_program_module(worksheet)
    value = Base.invokelatest(() -> mod.RESULTS[id])
    value isa Exception && throw(value)
    value
end

"""
Compare a runtime value with a fixture value (`expected` from JSON3). Returns
`nothing` when they match, else a description. Matrices are `{rows, cols, data}`
with row-major `data` whose elements may be numbers, `{re, im}` complex numbers
or nested matrices.
"""
function golden_mismatch(got, expected, rtol, atol, path="")
    close(a, b) = abs(a - b) <= atol + rtol * abs(b)
    if expected isa Number
        got isa Number && !(got isa Unitful.AbstractQuantity) ||
            return "$path: expected a number, got $(typeof(got))"
        return close(got, expected) ? nothing : "$path: got $got, expected $expected"
    elseif haskey(expected, :re)
        got isa Number || return "$path: expected a complex number, got $(typeof(got))"
        z = complex(expected.re, expected.im)
        return close(got, z) ? nothing : "$path: got $got, expected $z"
    elseif haskey(expected, :rows)
        got isa AbstractMatrix || return "$path: expected a matrix, got $(typeof(got))"
        size(got) == (expected.rows, expected.cols) ||
            return "$path: expected size $((expected.rows, expected.cols)), got $(size(got))"
        for row in 1:expected.rows, col in 1:expected.cols
            item = expected.data[(row-1)*expected.cols+col]
            problem = golden_mismatch(got[row, col], item, rtol, atol, "$path[$row,$col]")
            problem === nothing || return problem
        end
        return nothing
    end
    "$path: unsupported expected value"
end
