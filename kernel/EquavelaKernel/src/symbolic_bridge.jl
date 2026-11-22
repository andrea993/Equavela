# Bridge between the canonical worksheet AST and SymPy.
#
# This file is not included by `EquavelaKernel.jl` at load time: its source text is stored in
# a constant and evaluated on the first symbolic request or by the warm-up task
# (symbolic.jl), so `using PythonCall` (which resolves the Python environment and loads
# libpython) never delays the handshake or the numeric requests.
#
# Input and output are plain Julia data (`Dict{String,Any}`, `Vector{Any}`, numbers and
# strings) shaped like the serde JSON of `core/src/ast.rs`: every expression is a dictionary
# with a "type" key ("Num", "Ident", "Add", ...). No SymPy text parsing is involved in either
# direction.

module SymbolicBridge

using PythonCall

export evaluate, import_sympy!, warm_up!, versions, SymbolicError

const sp = PythonCall.pynew()

"""
    SymbolicError(category, message)

A failure that is reported to the host as `{status: "error", error: {category, message}}`
.
"""
struct SymbolicError <: Exception
    category::String
    message::String
end

unsupported(what) = throw(SymbolicError("unsupported", "$what is not supported in a symbolic evaluation yet"))
invalid(message) = throw(SymbolicError("invalid", message))

function import_sympy!()
    sympy = pyimport("sympy")
    assumptions = pyimport("sympy.assumptions")
    # SymPy's solver accesses the submodule through its parent package.
    pyhasattr(sympy, "assumptions") || pysetattr(sympy, "assumptions", assumptions)
    PythonCall.pycopy!(sp, sympy)
    return nothing
end

function versions()
    return (python=pyconvert(String, pyimport("platform").python_version()),
        sympy=pyconvert(String, sp.__version__))
end

# --------------------------------------------------------------------------------------
# Names and context
# --------------------------------------------------------------------------------------

"""The text key of a `Name` (base text, literal subscripts joined with `_`)."""
function name_key(name)
    segments = name["segments"]
    isempty(segments) && invalid("the expression is incomplete (an empty variable)")
    io = IOBuffer()
    for (index, segment) in enumerate(segments)
        index > 1 && segment["subscript"] && write(io, '_')
        write(io, segment["text"])
    end
    return String(take!(io))
end

mutable struct Context
    vars::Dict{String,Any}            # variable definitions bound so far
    funs::Dict{String,Any}            # function definitions bound so far (`Lambda`s)
    free::Vector{String}              # names that are never substituted (binders, keyword variables)
    assume::Dict{String,Dict{Symbol,Bool}}
    origin::Int
    names::Dict{String,Any}           # symbol text => original Name (for the way back)
    rawfuns::Dict{String,Any}         # functions requiring vector arguments, with lexical context
    indexed::Dict{String,Any}         # generated vector-coordinate symbols => original AST
    ranges::Dict{String,Tuple{Py,Py}} # `assume, x == RealRange(a, b)`: symbol text => (a, b)
    ascending::Any                    # the expansion variable of a last `series`: terms in rising powers
end

Context() = Context(Dict{String,Any}(), Dict{String,Any}(), String[],
    Dict{String,Dict{Symbol,Bool}}(), 0, Dict{String,Any}(), Dict{String,Any}(), Dict{String,Any}(), Dict{String,Tuple{Py,Py}}(), nothing)

"""A result that is already an AST (a form SymPy would re-evaluate: `confrac`)."""
struct AstValue
    node::Any
end

is_free(ctx::Context, key) = key in ctx.free

function with_free(f, ctx::Context, keys)
    count = length(ctx.free)
    append!(ctx.free, keys)
    try
        return f()
    finally
        resize!(ctx.free, count)
    end
end

function symbol(ctx::Context, name)
    key = name_key(name)
    ctx.names[key] = get(ctx.names, key, name)
    assumptions = get(ctx.assume, key, nothing)
    if assumptions === nothing
        return sp.Symbol(key)
    end
    return sp.Symbol(key; assumptions...)
end

plain_name(text::AbstractString) = Dict{String,Any}(
    "segments" => Any[Dict{String,Any}("text" => String(text), "subscript" => false)],
    "label" => nothing)

# --------------------------------------------------------------------------------------
# AST -> SymPy
# --------------------------------------------------------------------------------------

const BUILTINS = Dict{String,Function}()

function _install_builtins!()
    empty!(BUILTINS)
    direct = ["sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "asinh",
        "acosh", "atanh", "csc", "sec", "cot", "acsc", "asec", "acot", "csch", "sech", "coth",
        "exp", "sqrt", "sign", "floor", "re", "im", "arg", "erf", "erfc"]
    for name in direct
        BUILTINS[name] = (args...) -> getproperty(sp, Symbol(name))(args...)
    end
    BUILTINS["erfc"] = (x,) -> pytruth(x.is_number) ? sp.erfc(x) : sp.Integer(1) - sp.erf(x)
    # SymPy uses (y, x), while the reference application names the Cartesian coordinates (x, y).
    BUILTINS["atan2"] = (x, y) -> sp.atan2(y, x)
    BUILTINS["ln"] = (x,) -> sp.log(x)
    BUILTINS["abs"] = (x,) -> sp.Abs(x)
    BUILTINS["ceil"] = (x,) -> sp.ceiling(x)
    BUILTINS["conj"] = (x,) -> sp.conjugate(x)
    BUILTINS["Gamma"] = (x,) -> sp.gamma(x)
    # the reference application's special-function spellings and argument order. Keep these
    # here, rather than relying on SymPy's differently named functions.
    BUILTINS["Γ"] = (args...) -> length(args) == 1 ? sp.gamma(args[1]) :
        length(args) == 2 ? sp.uppergamma(args[1], args[2]) : invalid("Γ takes one or two arguments")
    BUILTINS["Gamma"] = BUILTINS["Γ"]
    BUILTINS["lnΓ"] = (x,) -> sp.loggamma(x)
    BUILTINS["lnGamma"] = (x,) -> sp.loggamma(x)
    BUILTINS["Psi"] = (args...) -> length(args) == 1 ? sp.digamma(args[1]) :
        length(args) == 2 ? sp.polygamma(args[1], args[2]) : invalid("Psi takes one or two arguments")
    for (prefix, sympy_name) in (("J", "besselj"), ("Y", "bessely"),
                                 ("I", "besseli"), ("K", "besselk"))
        BUILTINS[prefix * "n"] = (n, z) -> getproperty(sp, Symbol(sympy_name))(n, z)
        scale = prefix in ("J", "Y") ? (z -> sp.exp(-sp.Abs(sp.im(z)))) :
                prefix == "I" ? (z -> sp.exp(-sp.Abs(sp.re(z)))) : (z -> sp.exp(z))
        BUILTINS[prefix * "n.sc"] = (n, z) -> getproperty(sp, Symbol(sympy_name))(n, z) * scale(z)
        for order in 0:1
            BUILTINS[prefix * string(order)] = (z,) -> getproperty(sp, Symbol(sympy_name))(sp.Integer(order), z)
            BUILTINS[prefix * string(order) * ".sc"] = (z,) -> getproperty(sp, Symbol(sympy_name))(sp.Integer(order), z) * scale(z)
        end
    end
    BUILTINS["H1"] = (n, z) -> sp.hankel1(n, z)
    BUILTINS["H2"] = (n, z) -> sp.hankel2(n, z)
    BUILTINS["H1.sc"] = (n, z) -> sp.hankel1(n, z) * sp.exp(-sp.I * z)
    BUILTINS["H2.sc"] = (n, z) -> sp.hankel2(n, z) * sp.exp(sp.I * z)
    for (name, sympy_name) in (("Ai", "airyai"), ("DAi", "airyaiprime"),
                               ("Bi", "airybi"), ("DBi", "airybiprime"))
        BUILTINS[name] = (z,) -> getproperty(sp, Symbol(sympy_name))(z)
        BUILTINS[name * ".sc"] = function (z)
            phase = sp.Rational(2, 3) * z * sp.sqrt(z)
            factor = name in ("Ai", "DAi") ? sp.exp(phase) : sp.exp(-sp.Abs(sp.re(phase)))
            return getproperty(sp, Symbol(sympy_name))(z) * factor
        end
    end
    BUILTINS["ber"] = (m, x) -> sp.re(sp.besselj(m, x * sp.exp(3 * sp.pi * sp.I / 4)))
    BUILTINS["bei"] = (m, x) -> sp.im(sp.besselj(m, x * sp.exp(3 * sp.pi * sp.I / 4)))
    BUILTINS["js"] = (m, z) -> sp.sqrt(sp.pi / (2 * z)) * sp.besselj(m + sp.Rational(1, 2), z)
    BUILTINS["ys"] = (m, z) -> sp.sqrt(sp.pi / (2 * z)) * sp.bessely(m + sp.Rational(1, 2), z)
    BUILTINS["Jac"] = (n, a, b, x) -> sp.jacobi(n, a, b, x)
    BUILTINS["ibeta"] = function (a, x, y)
        result = sp.betainc(x, y, 0, a) / sp.beta(x, y)
        all(v -> pytruth(v.is_number), (a, x, y)) ? result.evalf() : result
    end
    BUILTINS["fhyper"] = (a, b, c, x) -> sp.hyper(pylist((a, b)), pylist((c,)), x)
    BUILTINS["mhyper"] = (a, b, x) -> sp.hyper(pylist((a,)), pylist((b,)), x)
    BUILTINS["Φ"] = (x,) -> sp.Heaviside(x)
    BUILTINS["δ"] = (m, n) -> sp.KroneckerDelta(m, n)
    BUILTINS["max"] = (args...) -> sp.Max(args...)
    BUILTINS["min"] = (args...) -> sp.Min(args...)
    BUILTINS["mod"] = (a, b) -> sp.Mod(a, b)
    BUILTINS["log"] = function (x, base...)
        isempty(base) && return sp.log(x) / sp.log(sp.Integer(10))
        return sp.log(x) / sp.log(base[1])
    end
    BUILTINS["identity"] = (n,) -> sp.eye(pyconvert(Int, n))
    BUILTINS["tr"] = (m,) -> sp.trace(m)
    return nothing
end

const CONSTANTS = Dict{String,Function}(
    "π" => () -> sp.pi,
    "e" => () -> sp.E,
    "∞" => () -> sp.oo,
    "γ" => () -> sp.EulerGamma,
)

function number(text::AbstractString)
    if occursin(r"[.eE]", text)
        return sp.Float(String(text), 15)
    end
    return sp.Integer(pybuiltins.int(String(text)))
end

_is_matrix(x) = pyhasattr(x, "rows") && pyhasattr(x, "cols")

add(a, b) = _is_matrix(a) || _is_matrix(b) ? a + b : sp.Add(a, b)
mul(a, b) = _is_matrix(a) || _is_matrix(b) ? a * b : sp.Mul(a, b)
neg(a) = _is_matrix(a) ? -a : sp.Mul(sp.Integer(-1), a)
sub(a, b) = add(a, neg(b))
divide(a, b) = _is_matrix(b) ? a * b^(-1) : _is_matrix(a) ? a / b : sp.Mul(a, sp.Pow(b, sp.Integer(-1)))
power(a, b) = _is_matrix(a) ? a^b : sp.Pow(a, b)

function tosympy(ctx::Context, e)
    kind = e["type"]
    if kind == "Num"
        return number(e["text"])
    elseif kind == "Imag"
        return sp.Mul(number(e["text"]), sp.I)
    elseif kind == "Ident"
        return identifier(ctx, e["name"])
    elseif kind == "Paren"
        return tosympy(ctx, e["expr"])
    elseif kind == "Neg"
        return neg(tosympy(ctx, e["expr"]))
    elseif kind == "Not"
        return sp.Not(tosympy(ctx, e["expr"]))
    elseif kind == "Factorial"
        return sp.factorial(tosympy(ctx, e["expr"]))
    elseif kind == "Transpose"
        v = tosympy(ctx, e["expr"])
        return _is_matrix(v) ? v.T : v
    elseif kind == "Conj"
        return sp.conjugate(tosympy(ctx, e["expr"]))
    # The real and imaginary part operators.
    elseif kind == "RealPart"
        return sp.re(tosympy(ctx, e["expr"]))
    elseif kind == "ImagPart"
        return sp.im(tosympy(ctx, e["expr"]))
    # The polar form r·e^(i·θ).
    elseif kind == "Polar"
        return mul(tosympy(ctx, e["left"]), sp.exp(mul(sp.I, tosympy(ctx, e["right"]))))
    elseif kind == "Abs"
        v = tosympy(ctx, e["expr"])
        return _is_matrix(v) ? v.det() : sp.Abs(v)
    elseif kind == "Det"
        return tosympy(ctx, e["expr"]).det()
    elseif kind in ("Add", "Sub", "Mul", "InlineDiv", "Juxt", "Div", "Pow")
        a = tosympy(ctx, e["left"])
        b = tosympy(ctx, e["right"])
        kind == "Add" && return add(a, b)
        kind == "Sub" && return sub(a, b)
        kind in ("Mul", "InlineDiv", "Juxt") && return kind == "InlineDiv" ? divide(a, b) : mul(a, b)
        kind == "Div" && return divide(a, b)
        return power(a, b)
    elseif kind in ("Eq", "Ne", "Lt", "Gt", "Le", "Ge")
        a = tosympy(ctx, e["left"])
        b = tosympy(ctx, e["right"])
        kind == "Eq" && return sp.Eq(a, b)
        kind == "Ne" && return sp.Ne(a, b)
        kind == "Lt" && return sp.Lt(a, b)
        kind == "Gt" && return sp.Gt(a, b)
        kind == "Le" && return sp.Le(a, b)
        return sp.Ge(a, b)
    elseif kind in ("And", "Or", "Xor")
        a = tosympy(ctx, e["left"])
        b = tosympy(ctx, e["right"])
        kind == "And" && return sp.And(a, b)
        kind == "Or" && return sp.Or(a, b)
        return sp.Xor(a, b)
    elseif kind == "Root"
        radicand = tosympy(ctx, e["radicand"])
        index = get(e, "index", nothing)
        index === nothing && return sp.sqrt(radicand)
        return sp.root(radicand, tosympy(ctx, index))
    elseif kind == "Call"
        return call(ctx, e)
    elseif kind == "Matrix"
        rows, cols = e["rows"], e["cols"]
        cells = [tosympy(ctx, cell) for cell in e["cells"]]
        # A matrix of equations (a system for solve) is a plain list: SymPy matrices hold expressions.
        any(cell -> pytruth(pyhasattr(cell, "is_Relational") && cell.is_Relational), cells) && return pylist(cells)
        return sp.ImmutableMatrix(pylist([pylist([cells[(i - 1) * cols + j] for j in 1:cols]) for i in 1:rows]))
    elseif kind in ("Index", "Column", "Row")
        return matrix_element(ctx, e)
    # The gradient: the column of the partial derivatives.
    elseif kind == "Gradient"
        vars = [v["name"] for v in e["vars"]]
        return with_free(ctx, [name_key(v) for v in vars]) do
            body = tosympy(ctx, e["body"])
            sp.ImmutableMatrix(pylist([pylist([sp.diff(body, symbol(ctx, v))]) for v in vars]))
        end
    elseif kind in ("Deriv", "Partial")
        var = e["var"]["name"]
        key = name_key(var)
        order = get(e, "order", nothing)
        n = order === nothing ? 1 : positive_integer(tosympy(ctx, order), "the order of a derivative")
        return with_free(ctx, [key]) do
            body = tosympy(ctx, e["body"])
            sp.diff(body, symbol(ctx, var), n)
        end
    elseif kind == "Integral"
        var = e["var"]["name"]
        key = name_key(var)
        bounds = get(e, "bounds", nothing)
        return with_free(ctx, [key]) do
            body = tosympy(ctx, e["body"])
            x = symbol(ctx, var)
            if bounds === nothing
                sp.integrate(body, x)
            else
                sp.integrate(body, pytuple((x, tosympy(ctx, bounds["lo"]), tosympy(ctx, bounds["hi"]))))
            end
        end
    elseif kind in ("Sum", "Prod")
        var = e["var"]["name"]
        key = name_key(var)
        bounds = get(e, "bounds", nothing)
        bounds === nothing && unsupported("a sum or product without bounds")
        return with_free(ctx, [key]) do
            body = tosympy(ctx, e["body"])
            limits = pytuple((symbol(ctx, var), tosympy(ctx, bounds["lo"]), tosympy(ctx, bounds["hi"])))
            kind == "Sum" ? sp.summation(body, limits) : sp.product(body, limits)
        end
    elseif kind == "Limit"
        var = e["var"]["name"]
        key = name_key(var)
        target = tosympy(ctx, e["target"])
        direction = get(e, "side", "both")
        dir = direction == "left" ? "-" : direction == "right" ? "+" : "+-"
        return with_free(ctx, [key]) do
            body = tosympy(ctx, e["body"])
            sp.limit(body, symbol(ctx, var), target, dir)
        end
    elseif kind == "PrimeDeriv"
        unsupported("a derivative function without an argument")
    elseif kind == "Placeholder"
        invalid("the expression is incomplete (an empty placeholder)")
    elseif kind == "Str"
        unsupported("a string")
    elseif kind == "Range"
        unsupported("a range")
    elseif kind == "Program"
        unsupported("a program")
    elseif kind == "JuliaCall"
        unsupported("a Julia call")
    elseif kind in ("Norm", "Vectorize", "Cross", "Conv", "CircConv", "In")
        unsupported("the $kind operator")
    end
    unsupported("the construct $kind")
end

function positive_integer(value, what)
    pytruth(value.is_Integer) && pyconvert(Int, value) >= 0 || invalid("$what must be a non-negative integer")
    return pyconvert(Int, value)
end

function matrix_element(ctx::Context, e)
    kind = e["type"]
    base = tosympy(ctx, e["base"])
    _is_matrix(base) || unsupported("indexing a symbolic value that is not a matrix")
    function literal(index)
        value = tosympy(ctx, index)
        pytruth(value.is_Integer) || unsupported("a non-literal matrix index")
        return pyconvert(Int, value) - ctx.origin
    end
    if kind == "Index"
        indices = e["indices"]
        if length(indices) == 1
            i = literal(indices[1])
            rows, cols = pyconvert(Int, base.rows), pyconvert(Int, base.cols)
            (cols == 1 || rows == 1) || unsupported("a single index into a matrix")
            return cols == 1 ? base[i, 0] : base[0, i]
        end
        return base[literal(indices[1]), literal(indices[2])]
    elseif kind == "Column"
        return base.col(literal(e["index"]))
    end
    return base.row(literal(e["index"]))
end

function identifier(ctx::Context, name)
    key = name_key(name)
    if !is_free(ctx, key)
        haskey(ctx.vars, key) && return ctx.vars[key]
        haskey(ctx.funs, key) || (constant = get(CONSTANTS, key, nothing); constant === nothing || return constant())
    end
    return symbol(ctx, name)
end

"""
    bind_definition!(ctx, definition)

Binds one worksheet definition in the context, in worksheet order: its body is converted
with the definitions bound before it (so a later redefinition does not change an earlier
definition's meaning). A definition that cannot be converted leaves its name free.
"""
function bind_definition!(ctx::Context, definition)
    key = name_key(definition["name"])
    params = get(definition, "params", nothing)
    keywords = Any[k for k in get(definition, "keywords", Any[])]
    delete!(ctx.vars, key)
    delete!(ctx.funs, key)
    delete!(ctx.rawfuns, key)
    captured = Context(copy(ctx.vars), copy(ctx.funs), String[], copy(ctx.assume), ctx.origin,
        ctx.names, copy(ctx.rawfuns), ctx.indexed, copy(ctx.ranges), nothing)
    try
        if params === nothing
            value = tosympy(ctx, definition["body"])
            isempty(keywords) || (value = run_keywords(ctx, value, keywords))
            ctx.vars[key] = value
        else
            keys = String[name_key(p) for p in params]
            value = with_free(ctx, keys) do
                body = tosympy(ctx, definition["body"])
                isempty(keywords) ? body : run_keywords(ctx, body, keywords)
            end
            symbols = [symbol(ctx, p) for p in params]
            ctx.funs[key] = (sp.Lambda(pytuple(Tuple(symbols)), value), length(params))
        end
    catch error
        (error isa SymbolicError || error isa PythonCall.PyException) || rethrow()
        params === nothing || (ctx.rawfuns[key] = (definition, captured))
    end
    return nothing
end

function arguments(ctx::Context, e)
    args = Any[]
    for arg in e["args"]
        arg["type"] == "Expr" || unsupported("an inline definition argument")
        push!(args, tosympy(ctx, arg["expr"]))
    end
    return args
end

function simple_callee(callee)
    callee["type"] == "Paren" && return simple_callee(callee["expr"])
    callee["type"] == "Ident" || return nothing
    return callee["name"]
end

function call(ctx::Context, e)
    callee = e["callee"]
    if callee["type"] == "PrimeDeriv"
        return prime_call(ctx, e)
    end
    name = simple_callee(callee)
    name === nothing && unsupported("calling an expression")
    key = name_key(name)
    if key == "Jacob" && !is_free(ctx, key) && !haskey(ctx.funs, key) && !haskey(ctx.vars, key) && !haskey(ctx.rawfuns, key)
        return jacob(ctx, e)
    end
    args = arguments(ctx, e)
    if !is_free(ctx, key)
        if haskey(ctx.funs, key)
            lambda, arity = ctx.funs[key]
            length(args) == arity ||
                invalid("the function $key takes $arity arguments, not $(length(args))")
            return lambda(args...)
        end
        if haskey(ctx.rawfuns, key)
            definition, captured = ctx.rawfuns[key]
            params = definition["params"]
            length(args) == length(params) || invalid("the function $key takes $(length(params)) arguments, not $(length(args))")
            localctx = Context(copy(captured.vars), copy(captured.funs), String[], copy(captured.assume),
                captured.origin, ctx.names, copy(captured.rawfuns), ctx.indexed, copy(captured.ranges), nothing)
            for (param, arg) in zip(params, args)
                localctx.vars[name_key(param)] = arg
            end
            value = tosympy(localctx, definition["body"])
            keywords = get(definition, "keywords", Any[])
            return isempty(keywords) ? value : run_keywords(localctx, value, keywords)
        end
        builtin = haskey(ctx.vars, key) ? nothing : get(BUILTINS, key, nothing)
        builtin !== nothing && return builtin(args...)
    end
    return sp.Function(key)(args...)
end

# The unknown vector has no declared size in a symbolic worksheet. Infer the
# smallest size covering literal indices in the expression and referenced functions.
function jacob_extent(ctx, obj, targets, seen=Set{Any}())
    obj isa AbstractVector && return maximum((jacob_extent(ctx, x, targets, seen) for x in obj); init=0)
    obj isa AbstractDict || return 0
    extent = 0
    if get(obj, "type", "") == "Index"
        base = simple_callee(obj["base"])
        indices = obj["indices"]
        if base !== nothing && name_key(base) in targets && length(indices) == 1 && get(indices[1], "type", "") == "Num"
            index = tryparse(Int, indices[1]["text"])
            index === nothing || (extent = max(0, index - ctx.origin + 1))
        end
    elseif get(obj, "type", "") == "Call"
        name = simple_callee(obj["callee"])
        key = name === nothing ? "" : name_key(name)
        if haskey(ctx.rawfuns, key)
            definition, captured = ctx.rawfuns[key]
            # A formal parameter denotes the differentiated vector only when its
            # corresponding actual argument is that vector (possibly parenthesized).
            formals = String[]
            for (arg, param) in zip(obj["args"], definition["params"])
                arg["type"] == "Expr" || continue
                actual = simple_callee(arg["expr"])
                actual !== nothing && name_key(actual) in targets && push!(formals, name_key(param))
            end
            marker = (key, Tuple(formals))
            if !isempty(formals) && !(marker in seen)
                push!(seen, marker)
                extent = jacob_extent(captured, definition["body"], Set(formals), seen)
            end
        end
    end
    for value in values(obj)
        extent = max(extent, jacob_extent(ctx, value, targets, seen))
    end
    return extent
end

"""
`Jacob(F, [x; y])` with a vector of names: the derivatives of F with respect
to each name, a name that has a value standing for itself while F is differentiated and its value
put back in the result, as for the other symbolic derivatives.
"""
function jacob_names(ctx::Context, body, variable, args)
    cells = variable["cells"]
    (variable["rows"] == 1 || variable["cols"] == 1) && !isempty(cells) ||
        invalid("Jacob: x must be a vector")
    all(cell -> cell["type"] == "Ident", cells) ||
        invalid("Jacob: the second argument must be a variable name or a vector of names")
    keys = [name_key(cell["name"]) for cell in cells]
    allunique(keys) || invalid("Jacob: a variable is named twice")
    count = length(args) == 3 ? positive_integer(tosympy(ctx, args[3]["expr"]), "Jacob: k") : length(cells)
    count <= length(cells) || invalid("Jacob: k exceeds the length of x")
    vars, result = with_free(ctx, keys) do
        vars = [symbol(ctx, cell["name"]) for cell in cells]
        vars, tosympy(ctx, body)
    end
    _is_matrix(result) && pyconvert(Int, result.cols) == 1 && pyconvert(Int, result.rows) > 0 ||
        invalid("Jacob: the expression must be a non-empty column vector")
    result = result.jacobian(sp.ImmutableMatrix(pylist(vars[1:count])))
    values = [(vars[i], ctx.vars[keys[i]]) for i in eachindex(keys) if haskey(ctx.vars, keys[i])]
    isempty(values) || (result = result.subs(pylist([pytuple(v) for v in values]); simultaneous=true))
    return result
end

function jacob(ctx::Context, e)
    args = e["args"]
    2 <= length(args) <= 3 || invalid("Jacob takes an expression, a vector and optionally a variable count")
    all(a -> a["type"] == "Expr", args) || invalid("Jacob needs expression arguments")
    body, variable = args[1]["expr"], args[2]["expr"]
    variable["type"] == "Matrix" && return jacob_names(ctx, body, variable, args)
    variable["type"] == "Ident" || invalid("Jacob: the second argument must be a variable name or a vector of names")
    key = name_key(variable["name"])
    defined = get(ctx.vars, key, nothing)
    if defined !== nothing
        _is_matrix(defined) && pyconvert(Int, defined.cols) == 1 || invalid("Jacob: x must be a column vector")
    end
    count = if length(args) == 3
        positive_integer(tosympy(ctx, args[3]["expr"]), "Jacob: k")
    elseif defined !== nothing
        pyconvert(Int, defined.rows)
    else
        jacob_extent(ctx, body, Set([key]))
    end
    count > 0 || invalid("Jacob: the number of variables must be positive")
    defined !== nothing && count > pyconvert(Int, defined.rows) && invalid("Jacob: k exceeds the length of x")
    # Dummy names are mapped back to indexed worksheet expressions after differentiation.
    size = defined === nothing ? max(count, jacob_extent(ctx, body, Set([key]))) : pyconvert(Int, defined.rows)
    vars = Any[]
    for i in 0:size-1
        dummy = sp.Dummy("__jacob_$(length(ctx.indexed))")
        push!(vars, dummy)
        dummykey = pyconvert(String, dummy.name)
        ctx.indexed[dummykey] = node("Index"; base=variable, indices=Any[num_node(string(i + ctx.origin))])
    end
    vector = sp.ImmutableMatrix(pylist(vars))
    saved = get(ctx.vars, key, nothing)
    ctx.vars[key] = vector
    # Temporarily remove a surrounding binder for this name.
    oldfree = copy(ctx.free)
    filter!(x -> x != key, ctx.free)
    result = try
        tosympy(ctx, body)
    finally
        saved === nothing ? delete!(ctx.vars, key) : (ctx.vars[key] = saved)
        ctx.free = oldfree
    end
    _is_matrix(result) && pyconvert(Int, result.cols) == 1 && pyconvert(Int, result.rows) > 0 ||
        invalid("Jacob: the expression must be a non-empty column vector")
    result = result.jacobian(sp.ImmutableMatrix(pylist(vars[1:count])))
    if defined !== nothing
        result = result.subs(pylist([pytuple((vars[i], defined[i-1, 0])) for i in eachindex(vars)]); simultaneous=true)
    end
    return result
end

function prime_call(ctx::Context, e)
    prime = e["callee"]
    name = simple_callee(prime["function"])
    name === nothing && unsupported("a derivative of an expression that is not a function name")
    key = name_key(name)
    order = prime["order"]
    args = arguments(ctx, e)
    if haskey(ctx.funs, key)
        lambda, arity = ctx.funs[key]
        arity == 1 || unsupported("the derivative of a function of several variables")
        variable = lambda.args[0][0]
        derived = sp.Lambda(pytuple((variable,)), sp.diff(lambda.expr, variable, order))
        return derived(args...)
    end
    builtin = get(BUILTINS, key, nothing)
    builtin === nothing && unsupported("the derivative of the function $key")
    dummy = sp.Dummy("x")
    derived = sp.Lambda(pytuple((dummy,)), sp.diff(builtin(dummy), dummy, order))
    return derived(args...)
end

# --------------------------------------------------------------------------------------
# SymPy -> AST
# --------------------------------------------------------------------------------------

node(kind::AbstractString; pairs...) = begin
    d = Dict{String,Any}("type" => String(kind))
    for (k, v) in pairs
        d[String(k)] = v
    end
    d
end

num_node(text) = node("Num"; text=String(text))
ident_node(name) = node("Ident"; name=name)
const_ident(text) = ident_node(plain_name(text))
neg_node(x) = node("Neg"; expr=x)
binary(kind, a, b) = node(kind; left=a, right=b, split=false)
binary_plain(kind, a, b) = node(kind; left=a, right=b)
call_node(name, args) = node("Call"; callee=const_ident(name),
    args=Any[Dict{String,Any}("type" => "Expr", "expr" => a) for a in args])
imag_node(text) = node("Imag"; text=String(text), symbol="i")

pyname(e) = pyconvert(String, pytype(e).__name__)
function negative_number(e)
    pyhasattr(e, "is_number") || return false
    pytruth(e.is_number) || return false
    try
        return pytruth(e.is_negative)
    catch
        return false
    end
end

function is_numeric_literal(e)
    return pytruth(e.is_Integer) || pytruth(e.is_Rational) || pytruth(e.is_Float)
end

function float_text(e)
    text = pyconvert(String, pystr(e))
    mantissa, exponent = occursin('e', text) ? split(text, 'e'; limit=2) : (text, nothing)
    if occursin('.', mantissa)
        mantissa = replace(mantissa, r"0+$" => "")
        endswith(mantissa, ".") && (mantissa *= "0")
    end
    exponent === nothing && return String(mantissa)
    exponent = replace(exponent, "+" => "")
    return string(mantissa, "e", exponent)
end

const FUNCTION_NAMES = Dict{String,String}(
    "sin" => "sin", "cos" => "cos", "tan" => "tan", "asin" => "asin", "acos" => "acos",
    "atan" => "atan", "sinh" => "sinh", "cosh" => "cosh", "tanh" => "tanh",
    "asinh" => "asinh", "acosh" => "acosh", "atanh" => "atanh", "csc" => "csc", "sec" => "sec",
    "cot" => "cot", "acsc" => "acsc", "asec" => "asec", "acot" => "acot", "csch" => "csch",
    "sech" => "sech", "coth" => "coth", "log" => "ln", "sign" => "sign", "floor" => "floor",
    "ceiling" => "ceil", "re" => "re", "im" => "im", "arg" => "arg", "erf" => "erf",
    "erfc" => "erfc", "gamma" => "Gamma", "Heaviside" => "Φ", "Max" => "max", "Min" => "min",
    "Mod" => "mod", "KroneckerDelta" => "δ",
    "uppergamma" => "Γ", "loggamma" => "lnΓ", "digamma" => "Psi",
    "besselj" => "Jn", "bessely" => "Yn", "besseli" => "In", "besselk" => "Kn",
    "hankel1" => "H1", "hankel2" => "H2",
    "airyai" => "Ai", "airyaiprime" => "DAi", "airybi" => "Bi", "airybiprime" => "DBi",
    "jacobi" => "Jac")

function name_of_symbol(ctx::Context, e)
    key = pyconvert(String, e.name)
    return get(ctx.names, key) do
        plain_name(key)
    end
end

function sympy_list(e)
    return pyconvert(Vector{Py}, pybuiltins.list(e))
end

function column_matrix(ctx, items)
    return node("Matrix"; rows=length(items), cols=1, cells=Any[to_expr(ctx, item) for item in items])
end

function integer_node(e)
    text = pyconvert(String, pystr(e))
    if startswith(text, "-")
        return neg_node(num_node(text[2:end]))
    end
    return num_node(text)
end

function to_expr(ctx::Context, e)
    e isa AstValue && return e.node
    # Plain Julia values that sneak in (a count, a string) are not SymPy objects.
    if e isa Integer
        return e < 0 ? neg_node(num_node(string(-e))) : num_node(string(e))
    end
    if pyisinstance(e, pybuiltins.list) || pyisinstance(e, pybuiltins.tuple) || pyisinstance(e, sp.Tuple)
        return column_matrix(ctx, sympy_list(e))
    end
    if _is_matrix(e)
        rows, cols = pyconvert(Int, e.rows), pyconvert(Int, e.cols)
        cells = Any[to_expr(ctx, e[i - 1, j - 1]) for i in 1:rows for j in 1:cols]
        return node("Matrix"; rows=rows, cols=cols, cells=cells)
    end
    name = pyname(e)
    if pytruth(e.is_Integer)
        return integer_node(e)
    elseif pytruth(e.is_Rational)
        p, q = pyconvert(String, pystr(e.p)), pyconvert(String, pystr(e.q))
        fraction = binary_plain("Div", num_node(lstrip(p, '-')), num_node(q))
        return startswith(p, "-") ? neg_node(fraction) : fraction
    elseif pytruth(e.is_Float)
        text = float_text(e)
        return startswith(text, "-") ? neg_node(num_node(text[2:end])) : num_node(text)
    elseif name == "Pi"
        return const_ident("π")
    elseif name == "Exp1"
        return const_ident("e")
    elseif name == "ImaginaryUnit"
        return imag_node("1")
    elseif name == "Infinity"
        return const_ident("∞")
    elseif name == "NegativeInfinity"
        return neg_node(const_ident("∞"))
    elseif name in ("ComplexInfinity", "NaN")
        return const_ident("NaN")
    elseif name == "EulerGamma"
        return const_ident("γ")
    elseif name == "BooleanTrue"
        return num_node("1")
    elseif name == "BooleanFalse"
        return num_node("0")
    elseif pytruth(e.is_Symbol)
        key = pyconvert(String, e.name)
        haskey(ctx.indexed, key) && return ctx.indexed[key]
        return ident_node(name_of_symbol(ctx, e))
    elseif pytruth(e.is_Add)
        return add_expr(ctx, e)
    elseif pytruth(e.is_Mul)
        return mul_expr(ctx, e)
    elseif pytruth(e.is_Pow)
        return pow_expr(ctx, e)
    end
    return other_expr(ctx, e, name)
end

function add_expr(ctx::Context, e)
    terms = sympy_list(e.as_ordered_terms())
    if ctx.ascending !== nothing && pytruth(e.has(ctx.ascending))
        terms = rising_terms(terms, ctx.ascending)
    end
    result = nothing
    for term in terms
        coeff = term.as_coeff_Mul()[0]
        negative = negative_number(coeff)
        body = negative ? to_expr(ctx, -term) : to_expr(ctx, term)
        if result === nothing
            result = negative ? neg_node(body) : body
        else
            result = negative ? binary("Sub", result, body) : binary("Add", result, body)
        end
    end
    return result
end

"""
The terms of a series in rising powers of its variable, as a series is written
; terms whose power is not a plain number keep their place after the others.
"""
function rising_terms(terms, variable)
    power(term) = try
        pyconvert(Float64, sp.N(term.as_coeff_exponent(variable)[1]))
    catch
        Inf
    end
    return sort(terms; by=power)
end

function mul_expr(ctx::Context, e)
    numerator, denominator = sp.fraction(e)
    if !pytruth(denominator == sp.Integer(1))
        negative = negative_number(numerator.as_coeff_Mul()[0])
        top = to_expr(ctx, negative ? -numerator : numerator)
        fraction = binary_plain("Div", top, to_expr(ctx, denominator))
        return negative ? neg_node(fraction) : fraction
    end
    coeff, rest = e.as_coeff_Mul()
    if negative_number(coeff)
        return neg_node(to_expr(ctx, -e))
    end
    factors = sympy_list(e.as_ordered_factors())
    # `3*I` is the imaginary literal `3i`.
    if length(factors) == 2 && pytruth(factors[2] == sp.I) &&
       (pytruth(factors[1].is_Integer) || pytruth(factors[1].is_Float))
        return imag_node(pyconvert(String, pystr(factors[1])))
    end
    result = nothing
    for factor in factors
        node_ = to_expr(ctx, factor)
        result = result === nothing ? node_ : binary("Mul", result, node_)
    end
    return result
end

function pow_expr(ctx::Context, e)
    base, exponent = e.args
    if pyname(base) == "Exp1"
        return binary_plain("Pow", const_ident("e"), to_expr(ctx, exponent))
    end
    if pytruth(exponent.is_Rational) && !pytruth(exponent.is_Integer)
        p, q = pyconvert(Int, exponent.p), pyconvert(Int, exponent.q)
        if p == 1 && q >= 2
            index = q == 2 ? nothing : num_node(string(q))
            return node("Root"; index=index, radicand=to_expr(ctx, base))
        end
    end
    if negative_number(exponent)
        positive = -exponent
        denominator = pytruth(positive == sp.Integer(1)) ? to_expr(ctx, base) :
                      pow_expr_parts(ctx, base, positive)
        return binary_plain("Div", num_node("1"), denominator)
    end
    return binary_plain("Pow", to_expr(ctx, base), to_expr(ctx, exponent))
end

function pow_expr_parts(ctx::Context, base, exponent)
    if pytruth(exponent.is_Rational) && !pytruth(exponent.is_Integer)
        p, q = pyconvert(Int, exponent.p), pyconvert(Int, exponent.q)
        if p == 1 && q >= 2
            index = q == 2 ? nothing : num_node(string(q))
            return node("Root"; index=index, radicand=to_expr(ctx, base))
        end
    end
    return binary_plain("Pow", to_expr(ctx, base), to_expr(ctx, exponent))
end

function ident_binder(ctx::Context, symbol_)
    return Dict{String,Any}("name" => name_of_symbol(ctx, symbol_))
end

function beta_expr(ctx::Context, a, b)
    numerator = binary_plain("Mul", generic_call(ctx, "Γ", [a]), generic_call(ctx, "Γ", [b]))
    binary_plain("Div", numerator, generic_call(ctx, "Γ", [a + b]))
end

function other_expr(ctx::Context, e, name::String)
    args = pyhasattr(e, "args") ? sympy_list(e.args) : Py[]
    if name == "beta" && length(args) == 2
        return beta_expr(ctx, args[1], args[2])
    elseif name == "betainc" && length(args) == 4
        a, b, lo, hi = args
        upper = generic_call(ctx, "ibeta", [hi, a, b])
        difference = pytruth(lo == 0) ? upper : binary_plain("Sub", upper, generic_call(ctx, "ibeta", [lo, a, b]))
        return binary_plain("Mul", difference, beta_expr(ctx, a, b))
    elseif name == "atan2" && length(args) == 2
        return call_node("atan2", [to_expr(ctx, args[2]), to_expr(ctx, args[1])])
    elseif name == "exp" && length(args) == 1
        return binary_plain("Pow", const_ident("e"), to_expr(ctx, args[1]))
    elseif name == "Abs" && length(args) == 1
        return node("Abs"; expr=to_expr(ctx, args[1]))
    elseif name == "factorial" && length(args) == 1
        return node("Factorial"; expr=to_expr(ctx, args[1]))
    elseif name == "conjugate" && length(args) == 1
        return node("Conj"; expr=to_expr(ctx, args[1]))
    elseif name == "Equality" && length(args) == 2
        return binary_plain("Eq", to_expr(ctx, args[1]), to_expr(ctx, args[2]))
    elseif name == "Unequality" && length(args) == 2
        return binary_plain("Ne", to_expr(ctx, args[1]), to_expr(ctx, args[2]))
    elseif name == "StrictLessThan" && length(args) == 2
        return binary_plain("Lt", to_expr(ctx, args[1]), to_expr(ctx, args[2]))
    elseif name == "StrictGreaterThan" && length(args) == 2
        return binary_plain("Gt", to_expr(ctx, args[1]), to_expr(ctx, args[2]))
    elseif name == "LessThan" && length(args) == 2
        return binary_plain("Le", to_expr(ctx, args[1]), to_expr(ctx, args[2]))
    elseif name == "GreaterThan" && length(args) == 2
        return binary_plain("Ge", to_expr(ctx, args[1]), to_expr(ctx, args[2]))
    elseif name == "And" && length(args) >= 2
        return foldl((a, b) -> binary_plain("And", a, to_expr(ctx, b)), args[2:end]; init=to_expr(ctx, args[1]))
    elseif name == "Or" && length(args) >= 2
        return foldl((a, b) -> binary_plain("Or", a, to_expr(ctx, b)), args[2:end]; init=to_expr(ctx, args[1]))
    elseif name == "Not" && length(args) == 1
        return node("Not"; expr=to_expr(ctx, args[1]))
    elseif name == "Derivative"
        body = args[1]
        variable, count = pyconvert(Vector{Py}, args[2])
        order = pyconvert(Int, count)
        return node("Deriv"; var=ident_binder(ctx, variable),
            order=order == 1 ? nothing : num_node(string(order)), body=to_expr(ctx, body))
    elseif name == "Integral"
        limits = pyconvert(Vector{Py}, args[2])
        variable = limits[1]
        bounds = length(limits) == 3 ?
                 Dict{String,Any}("lo" => to_expr(ctx, limits[2]), "hi" => to_expr(ctx, limits[3])) : nothing
        return node("Integral"; var=ident_binder(ctx, variable), bounds=bounds, algorithm=nothing,
            body=to_expr(ctx, args[1]))
    elseif name in ("Sum", "Product") && length(args) == 2
        limits = pyconvert(Vector{Py}, args[2])
        length(limits) == 3 || return generic_call(ctx, name, args)
        bounds = Dict{String,Any}("lo" => to_expr(ctx, limits[2]), "hi" => to_expr(ctx, limits[3]))
        return node(name == "Sum" ? "Sum" : "Prod"; var=ident_binder(ctx, limits[1]), bounds=bounds,
            body=to_expr(ctx, args[1]))
    elseif name == "Limit" && length(args) >= 3
        direction = length(args) >= 4 ? pyconvert(String, pystr(args[4])) : "+"
        side = direction == "-" ? "left" : direction == "+-" ? "both" : "right"
        return node("Limit"; var=ident_binder(ctx, args[2]), target=to_expr(ctx, args[3]),
            side=side, body=to_expr(ctx, args[1]))
    elseif name == "hyper" && length(args) == 3
        upper = sympy_list(args[1])
        lower = sympy_list(args[2])
        if length(upper) == 2 && length(lower) == 1
            return call_node("fhyper", Any[to_expr(ctx, a) for a in (upper..., lower..., args[3])])
        elseif length(upper) == 1 && length(lower) == 1
            return call_node("mhyper", Any[to_expr(ctx, a) for a in (upper..., lower..., args[3])])
        end
    end
    if name == "polygamma" && length(args) == 2
        # polygamma(0, y) is the digamma Psi(y); a higher order is Psi(n, y).
        pytruth(args[1] == sp.Integer(0)) && return call_node("Psi", Any[to_expr(ctx, args[2])])
        return call_node("Psi", Any[to_expr(ctx, a) for a in args])
    end
    known = get(FUNCTION_NAMES, name, nothing)
    if known !== nothing
        return call_node(known, [to_expr(ctx, a) for a in args])
    end
    if pyhasattr(e, "is_Function") && pytruth(e.is_Function) && pyhasattr(e, "func")
        # An applied function (undefined `f(x)` or a SymPy function without a reference application name).
        return generic_call(ctx, pyconvert(String, e.func.__name__), args)
    end
    return generic_call(ctx, name, args)
end

function generic_call(ctx::Context, name::AbstractString, args)
    return call_node(name, [to_expr(ctx, a) for a in args])
end

# --------------------------------------------------------------------------------------
# Keywords
# --------------------------------------------------------------------------------------

# Recognized keywords that have no implementation, with the reason.
const BACKLOG = Dict{String,String}(
    "cauchy" => "its meaning is not documented in the compatibility spec",
    "decomp" => "its meaning is not documented in the compatibility spec",
    "explicit" => "its meaning is not documented in the compatibility spec",
    "fully" => "alone it is not documented; it is implemented as a modifier of solve",
    "standard" => "its meaning is not documented in the compatibility spec",
    "using" => "its meaning is not documented in the compatibility spec")

# keyword => (default source variable, default result variable), the specification
const TRANSFORM_KEYWORDS = Dict{String,Tuple{String,String}}(
    "laplace" => ("t", "s"), "invlaplace" => ("s", "t"),
    "fourier" => ("t", "ω"), "invfourier" => ("ω", "t"),
    "ztrans" => ("n", "z"), "invztrans" => ("z", "n"))

const VARIABLE_KEYWORDS = Set(["solve", "collect", "series", "coeffs", "parfrac", "partfrac",
    "substitute", "laplace", "invlaplace", "fourier", "invfourier", "ztrans", "invztrans",
    "confrac"])

# Words that are modifiers, never variables, in the arguments of a keyword.
const MODIFIER_WORDS = Set(["real", "complex", "fully", "sincos", "sinhcos", "exp", "ln", "log",
    "fact", "gamma", "nfact", "ofact", "parts", "power", "sin", "cos", "tan", "cot", "sinh",
    "cosh", "tanh", "coth", "asin", "acos", "atan", "acot", "sign", "signum"])

"""The text of a call's function name, or `nothing`."""
function call_name(e)
    e["type"] == "Call" || return nothing
    name = simple_callee(e["callee"])
    return name === nothing ? nothing : name_key(name)
end

"""The modifier word of an argument (`real`, `RealRange(0, 5)`), or `nothing` for any other argument."""
function modifier_of(arg)
    a = arg
    while a["type"] == "Paren"
        a = a["expr"]
    end
    if a["type"] == "Ident"
        word = name_key(a["name"])
        return word in MODIFIER_WORDS ? word : nothing
    end
    return call_name(a) == "RealRange" ? "RealRange" : nothing
end

function keyword_variable_names(keyword)
    names = String[]
    for arg in keyword["args"]
        a = arg
        while a["type"] == "Paren"
            a = a["expr"]
        end
        if a["type"] == "Matrix"
            for cell in a["cells"]
                while cell["type"] == "Paren"
                    cell = cell["expr"]
                end
                cell["type"] == "Ident" && push!(names, name_key(cell["name"]))
            end
        elseif a["type"] == "Ident" && modifier_of(a) === nothing
            push!(names, name_key(a["name"]))
        elseif a["type"] == "Eq" && a["left"]["type"] == "Ident"
            push!(names, name_key(a["left"]["name"]))
        end
    end
    return names
end

function keyword_name(keyword)
    name = String(keyword["keyword"])
    isempty(name) && invalid("the expression is incomplete (an empty symbolic keyword)")
    return name
end

function register_assumptions!(ctx::Context, keywords)
    for keyword in keywords
        keyword_name(keyword) == "assume" || continue
        for arg in keyword["args"]
            a = arg
            while a["type"] == "Paren"
                a = a["expr"]
            end
            kind = a["type"]
            kind in ("Gt", "Lt", "Ge", "Le", "Eq") || invalid("an assumption must compare a variable with 0 or name a set (x == real)")
            left, right = a["left"], a["right"]
            left["type"] == "Ident" || invalid("an assumption is about a variable")
            key = name_key(left["name"])
            facts = get!(ctx.assume, key, Dict{Symbol,Bool}())
            if kind == "Eq" && right["type"] == "Ident"
                word = name_key(right["name"])
                if word in ("real", "integer", "positive", "negative", "nonnegative", "nonpositive",
                    "rational", "complex", "even", "odd")
                    facts[Symbol(word)] = true
                else
                    invalid("unknown assumption `$word`")
                end
            elseif kind == "Eq" && right["type"] == "Call" && call_name(right) == "RealRange"
                bounds = [arg["expr"] for arg in right["args"] if arg["type"] == "Expr"]
                length(bounds) == 2 || invalid("RealRange takes the two bounds of the range")
                lo, hi = tosympy(ctx, bounds[1]), tosympy(ctx, bounds[2])
                facts[:real] = true
                ctx.ranges[key] = (lo, hi)
                pytruth(lo.is_number) && pytruth(lo >= 0) && (facts[:nonnegative] = true)
                pytruth(hi.is_number) && pytruth(hi <= 0) && (facts[:nonpositive] = true)
            elseif right["type"] == "Num" && right["text"] in ("0", "0.0")
                kind == "Gt" && (facts[:positive] = true)
                kind == "Lt" && (facts[:negative] = true)
                kind == "Ge" && (facts[:nonnegative] = true)
                kind == "Le" && (facts[:nonpositive] = true)
                kind == "Eq" && (facts[:zero] = true)
            else
                invalid("an assumption must compare a variable with 0 or name a set (x == real)")
            end
        end
    end
end

function variable_argument(ctx::Context, arg, what)
    a = arg
    while a["type"] == "Paren"
        a = a["expr"]
    end
    a["type"] == "Ident" || invalid("$what must be a variable")
    return symbol(ctx, a["name"])
end

function free_symbols(value)
    return sympy_list(pybuiltins.sorted(value.free_symbols; key=sp.default_sort_key))
end

"""The equations of a solve: the cells of a matrix, the operands of an `And`, or the one expression."""
function equations_of(value)
    if _is_matrix(value)
        return Py[value[i - 1, j - 1] for i in 1:pyconvert(Int, value.rows) for j in 1:pyconvert(Int, value.cols)]
    elseif pyisinstance(value, pybuiltins.list)
        return sympy_list(value)
    elseif pytruth(value.func == sp.And)
        return sympy_list(value.args)
    end
    return Py[value]
end

function solve_keyword(ctx::Context, value, args; selected_only=false)
    parameters = Set{String}()
    if selected_only
        isempty(args) && invalid("Select a variable for Solve")
        for arg in args[2:end]
            symbol = variable_argument(ctx, arg, "a parameter of the system")
            push!(parameters, pyconvert(String, symbol.name))
        end
        args = args[1:1]
    end
    variables = Py[]
    real_only = false
    fully = false
    bounds = Tuple{Py,Py}[]
    for arg in args
        a = arg
        while a["type"] == "Paren"
            a = a["expr"]
        end
        modifier = modifier_of(a)
        if modifier == "real"
            real_only = true
        elseif modifier == "complex"
        elseif modifier == "fully"
            fully = true
        elseif modifier == "RealRange"
            range_args = [x["expr"] for x in a["args"] if x["type"] == "Expr"]
            length(range_args) == 2 || invalid("RealRange takes the two bounds of the range")
            push!(bounds, (tosympy(ctx, range_args[1]), tosympy(ctx, range_args[2])))
        elseif modifier !== nothing
            unsupported("the modifier `$modifier` of solve")
        elseif a["type"] == "Matrix"
            for cell in a["cells"]
                push!(variables, variable_argument(ctx, cell, "the unknown of solve"))
            end
        else
            push!(variables, variable_argument(ctx, a, "the unknown of solve"))
        end
    end
    equations = equations_of(value)
    isempty(equations) && invalid("solve needs at least one equation")
    if isempty(variables)
        symbols = Py[]
        for e in equations
            append!(symbols, sympy_list(e.free_symbols))
        end
        candidates = sympy_list(pybuiltins.sorted(pybuiltins.set(pylist(symbols)); key=sp.default_sort_key))
        if length(equations) == 1
            length(candidates) == 1 ||
                invalid("solve needs the unknown: the expression has $(length(candidates)) free variables")
        else
            isempty(candidates) && invalid("solve needs the unknowns of the system")
        end
        variables = candidates
    end
    if selected_only && length(equations) > 1
        # Solve the system together, then project the result onto the explicitly selected unknown.
        # Definitions in scope have already been substituted, so they do not become unknowns.
        symbols = Py[]
        for equation in equations
            append!(symbols, sympy_list(equation.free_symbols))
        end
        candidates = sympy_list(pybuiltins.sorted(pybuiltins.set(pylist(symbols)); key=sp.default_sort_key))
        push!(parameters, pyconvert(String, first(variables).name))
        append!(variables, [v for v in candidates if pyconvert(String, v.name) ∉ parameters])
    end
    # One equation in one unknown goes through the univariate solver (it knows RootOf).
    found = if length(equations) == 1 && length(variables) == 1
        sympy_list(sp.solve(equations[1], variables[1]; dict=true))
    else
        sympy_list(sp.solve(pylist(equations), pylist(variables); dict=true))
    end
    if selected_only
        found = filter(solution -> pytruth(solution.__contains__(first(variables))), found)
    end
    if isempty(found)
        unknowns = join([pyconvert(String, v.name) for v in variables], ", ")
        problem = length(equations) == 1 ? "the equation" : "the system of $(length(equations)) equations"
        throw(SymbolicError("symbolic", "No solution found for $unknowns in $problem. Check the equations and parameter values."))
    end
    rows = Vector{Py}[]
    for solution in found
        row = Py[pytruth(solution.__contains__(v)) ? solution[v] : v for v in variables]
        push!(rows, row)
    end
    # Solutions outside a RealRange or complex under the `real` modifier are dropped.
    keep(row) = all(zip(variables, row)) do (variable, v)
        ok = true
        key = pyconvert(String, variable.name)
        limits = copy(bounds)
        haskey(ctx.ranges, key) && push!(limits, ctx.ranges[key])
        if real_only || !isempty(limits)
            ok = !pyis(v.is_real, pybuiltins.False)
        end
        if ok
            for (lo, hi) in limits
                ok &= !pyis(sp.Ge(v, lo), pygetattr(sp.S, "false")) && !pyis(sp.Le(v, hi), pygetattr(sp.S, "false"))
            end
        end
        ok
    end
    rows = filter(keep, rows)
    isempty(rows) && throw(SymbolicError("symbolic", "No solution satisfies the requested assumptions or range"))
    if fully
        rows = [Py[explicit_root(v) for v in row] for row in rows]
    end
    if selected_only || length(variables) == 1
        return length(rows) == 1 ? rows[1][1] : pylist([row[1] for row in rows])
    end
    return sp.ImmutableMatrix(pylist([pylist(row) for row in rows]))
end

"""`fully`: roots with no closed form (`CRootOf`) become numbers."""
function explicit_root(v)
    return pytruth(v.has(sp.CRootOf)) ? v.evalf(15) : v
end

# --------------------------------------------------------------------------------------
# Transforms
# --------------------------------------------------------------------------------------

function transform_keyword(ctx::Context, value, args, name::String; automatic_target=false)
    _is_matrix(value) && unsupported("a transform of a matrix")
    source_default, target_default = TRANSFORM_KEYWORDS[name]
    free = free_symbols(value)
    names = String[pyconvert(String, s.name) for s in free]
    source = nothing
    if length(args) >= 1
        source = variable_argument(ctx, args[1], "the variable of $name")
    elseif source_default in names
        source = free[findfirst(==(source_default), names)]
    elseif length(free) == 1
        source = free[1]
    elseif isempty(free)
        source = symbol(ctx, plain_name(source_default))
    else
        invalid("$name needs the variable: write `$name, $source_default`")
    end
    source_name = pyconvert(String, source.name)
    if automatic_target
        base = target_default
        suffix = 1
        while target_default == source_name || target_default in names
            target_default = base * string(suffix)
            suffix += 1
        end
    end
    target = length(args) >= 2 ? variable_argument(ctx, args[2], "the result variable of $name") :
             symbol(ctx, plain_name(target_default))
    target_name = pyconvert(String, target.name)
    if source_name != target_name && target_name in names
        invalid("the result variable `$target_name` of $name is a variable of the expression: " *
                "name another one (`$name, $source_name, p`)")
    end
    result = if name == "laplace"
        laplace_transform(value, source, target)
    elseif name == "invlaplace"
        inverse_laplace(value, source, target)
    elseif name == "fourier"
        fourier_transform(value, source, target)
    elseif name == "invfourier"
        inverse_fourier(value, source, target)
    elseif name == "ztrans"
        z_transform(value, source, target)
    else
        inverse_z_transform(value, source, target)
    end
    return result
end

function no_closed_form(name)
    throw(SymbolicError("symbolic", "no closed form found for the $name"))
end

function laplace_transform(value, t, s)
    result = sp.laplace_transform(value, t, s; noconds=true)
    if pytruth(result.has(sp.LaplaceTransform))
        # `b^t` with a numeric base (the Fibonacci closed form) transforms as `e^(t·ln b)`.
        result = sp.laplace_transform(sp.expand(value.rewrite(sp.exp)), t, s; noconds=true)
    end
    pytruth(result.has(sp.LaplaceTransform)) && no_closed_form("Laplace transform")
    return result
end

function inverse_laplace(value, s, t)
    result = sp.inverse_laplace_transform(value, s, t)
    pytruth(result.has(sp.InverseLaplaceTransform)) && no_closed_form("inverse Laplace transform")
    # The inverse is for t > 0 (unilateral transform): the step Heaviside(t) is 1.
    return sp.simplify(result.subs(sp.Heaviside(t), 1))
end

# F(ω) = ∫ f(t) e^(-iωt) dt. SymPy's convention is e^(-2πikt), so k = ω / 2π.
function fourier_transform(value, t, w)
    real_t = sp.Symbol(pyconvert(String, t.name); real=true)
    x = sp.Symbol("k_"; real=true)
    result = sign_aware(x, value.subs(t, real_t), real_t) do k
        r = sp.fourier_transform(value.subs(t, real_t), real_t, k)
        pytruth(r.has(sp.FourierTransform)) && no_closed_form("Fourier transform")
        r
    end
    return sp.simplify(result.subs(x, w / (2 * sp.pi)))
end

# f(t) = 1/(2π) ∫ F(ω) e^(iωt) dω, that is SymPy's inverse with ω = 2πk.
function inverse_fourier(value, w, t)
    real_w = sp.Symbol(pyconvert(String, w.name); real=true)
    x = sp.Symbol("t_"; real=true)
    result = sign_aware(x, value.subs(w, real_w), real_w) do tau
        r = sp.inverse_fourier_transform(value.subs(w, 2 * sp.pi * sp.Symbol("k_"; real=true)),
            sp.Symbol("k_"; real=true), tau)
        pytruth(r.has(sp.InverseFourierTransform)) && no_closed_form("inverse Fourier transform")
        r
    end
    return sp.simplify(result.subs(x, t))
end

"""
SymPy's Fourier results hold for a positive transform variable only (it returns `e^(-2πk)`
for the transform of `e^-|t|`, whatever the sign of `k`). The result for a positive symbol is
computed and the symmetry of the input extends it: an even input has an even result (`Abs`
of the variable), an odd input an odd one (`sign(x)` times it). An input with neither
symmetry gets SymPy's result unchanged.
"""
function sign_aware(compute, x, input, input_variable)
    positive = sp.Dummy("p"; positive=true)
    result = compute(positive).subs(positive, x)
    mirrored = input.subs(input_variable, -input_variable)
    if pytruth(sp.simplify(input - mirrored) == sp.Integer(0))
        return result.subs(x, sp.Abs(x))
    elseif pytruth(sp.simplify(input + mirrored) == sp.Integer(0))
        return sp.sign(x) * result.subs(x, sp.Abs(x))
    end
    return result
end

# F(z) = Σ_{n≥0} f(n) z^(-n). SymPy has no Z transform: the sum is evaluated term by term
# and the branch of the region of convergence is taken (|z| large enough).
function z_transform(value, n, z)
    k = sp.Dummy("n"; integer=true, nonnegative=true)
    total = sp.Integer(0)
    for term in sympy_list(sp.Add.make_args(sp.expand(value.subs(n, k))))
        summed = sp.piecewise_fold(sp.summation(term * z^(-k), pytuple((k, 0, sp.oo))))
        if pytruth(summed.func == sp.Piecewise)
            summed = summed.args[0][0]
        end
        pytruth(summed.has(sp.Sum)) && no_closed_form("Z transform")
        total = total + summed
    end
    return sp.simplify(total)
end

# f(n) from the poles of F(z)/z (causal sequences): c/(z-p)^m terms give
# binomial p^(n-m+1), poles at the origin give Kronecker deltas.
function inverse_z_transform(value, z, n)
    h = sp.cancel(value / z)
    numerator, denominator = sp.fraction(h)
    (pytruth(numerator.is_polynomial(z)) && pytruth(denominator.is_polynomial(z))) ||
        unsupported("the inverse Z transform of an expression that is not rational in $(pyconvert(String, z.name))")
    quotient, remainder = sp.div(numerator, denominator, z)
    pytruth(quotient == sp.Integer(0)) ||
        unsupported("the inverse Z transform of a non-causal transform (a polynomial part in z)")
    poly = sp.Poly(denominator, z)
    degree = pyconvert(Int, poly.degree())
    degree >= 1 || no_closed_form("inverse Z transform")
    roots = sp.roots(poly)
    multiplicities = [(p, pyconvert(Int, roots[p])) for p in sympy_list(roots.keys())]
    sum(last, multiplicities) == degree ||
        unsupported("the inverse Z transform when the poles have no closed form")
    leading = poly.LC()
    result = sp.Integer(0)
    for (index, (p, m)) in enumerate(multiplicities)
        others = leading
        for (j, (q, mq)) in enumerate(multiplicities)
            j == index || (others = others * (z - q)^mq)
        end
        g = remainder / others
        for k in 1:m
            coefficient = sp.simplify(sp.diff(g, z, m - k).subs(z, p) / sp.factorial(m - k))
            if pytruth(p == sp.Integer(0))
                result = result + coefficient * sp.KroneckerDelta(n, k - 1)
            else
                result = result + coefficient * sp.expand_func(sp.binomial(n, k - 1)) * p^(n - k + 1)
            end
        end
    end
    return result
end

# --------------------------------------------------------------------------------------
# rewrite, combine, confrac, rectangular
# --------------------------------------------------------------------------------------

function modifier_words(args)
    words = String[]
    for arg in args
        a = arg
        while a["type"] == "Paren"
            a = a["expr"]
        end
        word = modifier_of(a)
        if word === nothing && a["type"] == "Ident"
            word = name_key(a["name"])
        end
        word === nothing && invalid("expected a modifier word, not an expression")
        push!(words, word)
    end
    return words
end

const REWRITE_TARGETS = Dict{String,Function}(
    "sin" => () -> sp.sin, "cos" => () -> sp.cos, "tan" => () -> sp.tan, "cot" => () -> sp.cot,
    "sinh" => () -> sp.sinh, "cosh" => () -> sp.cosh, "tanh" => () -> sp.tanh,
    "coth" => () -> sp.coth, "asin" => () -> sp.asin, "acos" => () -> sp.acos,
    "atan" => () -> sp.atan, "acot" => () -> sp.acot, "exp" => () -> sp.exp,
    "ln" => () -> sp.log, "log" => () -> sp.log, "gamma" => () -> sp.gamma,
    "fact" => () -> sp.factorial, "nfact" => () -> sp.factorial, "ofact" => () -> sp.factorial,
    "sign" => () -> sp.sign, "signum" => () -> sp.sign)

function rewrite_keyword(ctx::Context, value, args)
    isempty(args) && invalid("rewrite needs a modifier (sin, cos, exp, ln, sincos, ...)")
    for word in modifier_words(args)
        if word == "sincos"
            value = value.replace(sp.tan, Py(x -> sp.sin(x) / sp.cos(x))).
                    replace(sp.cot, Py(x -> sp.cos(x) / sp.sin(x))).
                    replace(sp.sec, Py(x -> 1 / sp.cos(x))).
                    replace(sp.csc, Py(x -> 1 / sp.sin(x)))
        elseif word == "sinhcos"
            value = value.replace(sp.tanh, Py(x -> sp.sinh(x) / sp.cosh(x))).
                    replace(sp.coth, Py(x -> sp.cosh(x) / sp.sinh(x))).
                    replace(sp.sech, Py(x -> 1 / sp.cosh(x))).
                    replace(sp.csch, Py(x -> 1 / sp.sinh(x)))
        elseif haskey(REWRITE_TARGETS, word)
            value = value.rewrite(REWRITE_TARGETS[word]())
        else
            unsupported("the modifier `$word` of rewrite")
        end
    end
    return value
end

function combine_keyword(ctx::Context, value, args)
    words = modifier_words(args)
    isempty(words) && return sp.together(value)
    for word in words
        value = if word in ("parts", "power")
            word == "power" ? sp.powsimp(value) : sp.together(value)
        elseif word == "exp"
            sp.powsimp(value; combine="exp")
        elseif word in ("ln", "log")
            sp.logcombine(value; force=true)
        elseif word in ("sin", "cos", "sincos")
            pyimport("sympy.simplify.fu").TR8(value)
        elseif word in ("fact", "gamma", "nfact", "ofact")
            sp.combsimp(value)
        else
            unsupported("the modifier `$word` of combine")
        end
    end
    return value
end

function confrac_keyword(ctx::Context, value, args)
    count = nothing
    variable = nothing
    for arg in args
        a = arg
        while a["type"] == "Paren"
            a = a["expr"]
        end
        if a["type"] == "Num"
            count = parse(Int, a["text"])
            count >= 1 || invalid("the number of terms of confrac must be at least 1")
        else
            variable = variable_argument(ctx, a, "the variable of confrac")
        end
    end
    terms = Py[]
    if pytruth(value.is_Rational)
        append!(terms, sympy_list(sp.continued_fraction(value)))
        count === nothing || (terms = terms[1:min(count, length(terms))])
    elseif pytruth(value.is_number)
        limit = count === nothing ? 6 : count
        iterator = sp.continued_fraction_iterator(value)
        for _ in 1:limit
            push!(terms, pybuiltins.next(iterator))
        end
    else
        if variable === nothing
            free = free_symbols(value)
            length(free) == 1 || invalid("confrac needs the variable of the rational function")
            variable = free[1]
        end
        numerator, denominator = sp.fraction(sp.cancel(sp.together(value)))
        limit = count === nothing ? 12 : count
        while length(terms) < limit
            quotient, remainder = sp.div(numerator, denominator, variable)
            push!(terms, quotient)
            pytruth(remainder == sp.Integer(0)) && break
            numerator, denominator = denominator, remainder
        end
    end
    terms = Py[sp.sympify(term) for term in terms]
    node = to_expr(ctx, terms[end])
    for term in reverse(terms[1:end - 1])
        node = binary("Add", to_expr(ctx, term), binary_plain("Div", num_node("1"), node))
    end
    return AstValue(node)
end

function rectangular_keyword(ctx::Context, value, args)
    isempty(args) || invalid("rectangular takes no arguments")
    # As the reference application, the variables are taken as real: e^(i·x) is cos(x) + i·sin(x), not written with
    # re(x) and im(x).
    to_real = Pair{Py,Py}[]
    back = Pair{Py,Py}[]
    for symbol in free_symbols(value)
        pyis(symbol.is_real, pybuiltins.True) && continue
        real = sp.Dummy(symbol.name; real=true)
        push!(to_real, symbol => real)
        push!(back, real => symbol)
    end
    result = sp.expand_complex(value.subs(pylist([pytuple((a, b)) for (a, b) in to_real])))
    return isempty(back) ? result : result.subs(pylist([pytuple((a, b)) for (a, b) in back]))
end

function series_keyword(ctx::Context, value, args)
    if isempty(args)
        # No argument: about 0 in the only free variable, as solve without a variable (the reference application does
        # the same: `1/(1 - x) →[series]` in a test worksheet).
        free = free_symbols(value)
        length(free) == 1 || invalid("series needs the expansion variable")
        ctx.ascending = free[1]
        return sp.series(value, free[1], sp.Integer(0), 6).removeO()
    end
    first = args[1]
    point = sp.Integer(0)
    variable = nothing
    while first["type"] == "Paren"
        first = first["expr"]
    end
    if first["type"] == "Eq"
        variable = variable_argument(ctx, first["left"], "the expansion variable")
        point = with_free(ctx, keyword_variable_names(Dict("args" => [first]))) do
            tosympy(ctx, first["right"])
        end
    else
        variable = variable_argument(ctx, first, "the expansion variable")
    end
    order = 6
    if length(args) >= 2
        order = positive_integer(tosympy(ctx, args[2]), "the order of a series")
        order >= 1 || invalid("the order of a series must be at least 1")
    end
    ctx.ascending = variable
    return sp.series(value, variable, point, order).removeO()
end

function substitute_keyword(ctx::Context, value, args)
    length(args) >= 1 || invalid("substitute needs `x == value`")
    for arg in args
        a = arg
        while a["type"] == "Paren"
            a = a["expr"]
        end
        a["type"] == "Eq" || invalid("substitute needs `x == value`")
        variable = variable_argument(ctx, a["left"], "the left side of substitute")
        replacement = tosympy(ctx, a["right"])
        value = value.subs(variable, replacement)
    end
    return value
end

function collect_keyword(ctx::Context, value, args)
    length(args) == 1 || invalid("collect needs one variable")
    variable = variable_argument(ctx, args[1], "the variable of collect")
    together = sp.together(value)
    numerator, denominator = sp.fraction(together)
    if pytruth(denominator == sp.Integer(1))
        return sp.collect(sp.expand(value), variable)
    end
    return sp.collect(sp.expand(numerator), variable) / denominator
end

function float_keyword(ctx::Context, value, args)
    digits = 15
    if !isempty(args)
        digits = positive_integer(tosympy(ctx, args[1]), "the number of digits")
        digits >= 1 || invalid("the number of digits must be at least 1")
    end
    return _is_matrix(value) ? value.evalf(digits) : sp.N(value, digits)
end

function coeffs_keyword(ctx::Context, value, args)
    length(args) == 1 || invalid("coeffs needs one variable")
    variable = variable_argument(ctx, args[1], "the variable of coeffs")
    polynomial = sp.Poly(value, variable)
    descending = sympy_list(polynomial.all_coeffs())
    return pylist(reverse(descending))
end

function parfrac_keyword(ctx::Context, value, args)
    isempty(args) && return sp.apart(value)
    return sp.apart(value, variable_argument(ctx, args[1], "the variable of parfrac"))
end

function factor_keyword(ctx::Context, value, args)
    words = modifier_words(args)
    for word in words
        word == "complex" || unsupported("the modifier `$word` of factor")
    end
    return isempty(words) ? sp.factor(value) : sp.factor(value; extension=sp.I)
end

function run_keywords(ctx::Context, value, keywords)
    for keyword in keywords
        name = keyword_name(keyword)
        args = keyword["args"]
        value isa AstValue && invalid("no keyword can follow confrac: its result is a fixed form")
        # Only a series that is not transformed further is written in rising powers (`float` keeps it).
        name in ("float", "assume") || (ctx.ascending = nothing)
        value = if name == "simplify"
            sp.simplify(value)
        elseif name == "expand"
            sp.expand(value)
        elseif name == "factor"
            factor_keyword(ctx, value, args)
        elseif name == "solve" || name == "worksheet_solve_for"
            solve_keyword(ctx, value, args; selected_only=name == "worksheet_solve_for")
        elseif name == "substitute"
            substitute_keyword(ctx, value, args)
        elseif name == "series"
            series_keyword(ctx, value, args)
        elseif name == "collect"
            collect_keyword(ctx, value, args)
        elseif name == "float"
            float_keyword(ctx, value, args)
        elseif haskey(TRANSFORM_KEYWORDS, name)
            transform_keyword(ctx, value, args, name)
        elseif startswith(name, "worksheet_") && haskey(TRANSFORM_KEYWORDS, chopprefix(name, "worksheet_"))
            transform_keyword(ctx, value, args, String(chopprefix(name, "worksheet_")); automatic_target=true)
        elseif name == "rewrite"
            rewrite_keyword(ctx, value, args)
        elseif name == "combine"
            combine_keyword(ctx, value, args)
        elseif name == "confrac"
            confrac_keyword(ctx, value, args)
        elseif name == "rectangular"
            rectangular_keyword(ctx, value, args)
        elseif name == "assume"
            value
        elseif name == "coeffs"
            coeffs_keyword(ctx, value, args)
        elseif name in ("parfrac", "partfrac")
            parfrac_keyword(ctx, value, args)
        elseif haskey(BACKLOG, name)
            throw(SymbolicError("unsupported", "the keyword `$name` is not supported: $(BACKLOG[name])"))
        else
            throw(SymbolicError("unknown_keyword", "unknown keyword `$name`"))
        end
    end
    return value
end

# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------

function build_context(request)
    ctx = Context()
    ctx.origin = Int(get(request, "origin", 0))
    for name in get(request, "free", Any[])
        push!(ctx.free, name_key(name))
    end
    return ctx
end

function error_result(category, message)
    return Dict{String,Any}("status" => "error",
        "error" => Dict{String,Any}("category" => category, "message" => message))
end

function python_message(error)
    try
        kind = pyconvert(String, error.t.__name__)
        detail = pyconvert(String, pystr(error.v))
        return isempty(detail) ? kind : "$kind: $detail"
    catch
        return "SymPy failed"
    end
end

"""
    evaluate(request) -> result

`request` is the plain-data form of the `symbolic` request.
Returns the `{status, value | error}` result.
"""
function evaluate(request)
    ctx = build_context(request)
    keywords = Any[k for k in get(request, "keywords", Any[])]
    try
        register_assumptions!(ctx, keywords)
        for keyword in keywords
            keyword_name(keyword) in VARIABLE_KEYWORDS && append!(ctx.free, keyword_variable_names(keyword))
        end
        for definition in get(request, "definitions", Any[])
            bind_definition!(ctx, definition)
        end
        value = tosympy(ctx, request["expr"])
        value = run_keywords(ctx, value, keywords)
        expr = to_expr(ctx, value)
        return Dict{String,Any}("status" => "ok",
            "value" => Dict{String,Any}("type" => "symbolic", "expr" => expr))
    catch error
        error isa InterruptException && rethrow()
        if error isa SymbolicError
            return error_result(error.category, error.message)
        elseif error isa PythonCall.PyException
            return error_result("symbolic", python_message(error))
        end
        return error_result("symbolic", "internal error: " * sprint(showerror, error))
    end
end

"""Whether two expressions (AST) are mathematically equal: `simplify(a - b) == 0`."""
function equivalent(a, b)
    ctx = Context()
    difference = sp.simplify(tosympy(ctx, a) - tosympy(ctx, b))
    return pytruth(difference == sp.Integer(0))
end

"""A few representative operations, so the first request does not pay for SymPy's lazy imports."""
function warm_up!()
    ctx = Context()
    x = sp.Symbol("x")
    expression = sp.sin(x)^2 * x
    sp.simplify(sp.diff(expression, x))
    sp.solve(x^2 - 5x + 6, x)
    sp.integrate(expression, x)
    sp.series(sp.exp(x), x, 0, 4)
    sp.limit(sp.sin(x) / x, x, 0)
    sp.factor(x^4 - 1)
    to_expr(ctx, sp.diff(expression, x))
    return nothing
end

_install_builtins!()

end # module SymbolicBridge
