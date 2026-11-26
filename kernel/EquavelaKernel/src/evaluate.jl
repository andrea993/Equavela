# The `evaluate` and `discard` requests.
#
# Each worksheet id owns an isolated module with EqRuntime loaded. A request
# carries generated Julia (see core/src/codegen.rs): per region some `code`
# (statements that define names) and an optional `value` expression whose
# result is returned as a typed kernel value. Regions run in the order given;
# a failing region reports its own error and the next regions still run.

const WORKSHEETS = Dict{String,Module}()
const _MODULE_COUNTER = Ref(0)

# every worksheet of the kernel is a module the REPL reaches by the worksheet's name
# (`Project.beam.M_smax_v1`). The name is given by the app with each pass; it can change (a save, a new
# file with the same name), the module stays.
const SHEET_NAMES = Dict{String,Symbol}()
# Names a worksheet no longer has: Project clears them on the next update.
const _RETIRED_NAMES = Set{Symbol}()

function worksheet_module(name::AbstractString; reset::Bool=false, module_name=nothing)
    key = String(name)
    if reset || !haskey(WORKSHEETS, key)
        reset && release_handles!(key)
        _MODULE_COUNTER[] += 1
        symbol = module_name === nothing ? Symbol("Worksheet", _MODULE_COUNTER[]) : Symbol(module_name)
        mod = Module(symbol)
        Core.eval(mod, :(using EqRuntime))
        WORKSHEETS[key] = mod
    end
    if module_name !== nothing
        previous = get(SHEET_NAMES, key, nothing)
        previous === nothing || previous === Symbol(module_name) || push!(_RETIRED_NAMES, previous)
        SHEET_NAMES[key] = Symbol(module_name)
    end
    return WORKSHEETS[key]
end

# Keep worksheet aliases in Project; worksheet modules themselves remain independently
# replaceable on reset and therefore do not need a permanent Julia parent binding.
function _bind_names!(target::Module)
    project = _shared()
    live = Set(values(SHEET_NAMES))
    for name in _RETIRED_NAMES
        name in live || Core.eval(project, :(global $name = nothing))
    end
    empty!(_RETIRED_NAMES)
    for (id, name) in SHEET_NAMES
        mod = get(WORKSHEETS, id, nothing)
        mod === nothing || Core.eval(project, :(global $name = $mod))
    end
    target === project || Core.eval(target, :(global Project = $project))
    return target
end

function _eval_text(mod::Module, text::AbstractString)
    result = nothing
    expr = Meta.parseall(text)
    for statement in expr.args
        if statement isa Expr && statement.head in (:error, :incomplete)
            throw(Meta.ParseError(string(statement.args[1])))
        end
    end
    try
        result = Core.eval(mod, expr)
    catch exception
        throw(exception isa LoadError ? exception.error : exception)
    end
    return result
end

_field(object, name::Symbol, default=nothing) = get(object, name, default)

function _shift_binary!(node::Dict{String,Any}, offset::Int)
    offset == 0 && return node
    node["type"] == "matrix" || return node
    storage = node["storage"]
    if storage["type"] == "binary"
        storage["index"] += offset
    else
        for element in storage["values"]
            _shift_binary!(element, offset)
        end
    end
    return node
end

# `using Foo` / `import Foo` of a package that is not in any environment on the
# load path. Returns the package name or `nothing`.
function _missing_package(exception)
    exception isa ArgumentError || return nothing
    m = match(r"Package (\w+)(?: \[[^\]]*\])? (?:not found|is required but does not seem to be installed)",
        exception.msg)
    return m === nothing ? nothing : String(m.captures[1])
end

# A call with the wrong number of arguments: the Julia MethodError becomes the sentence
# the reference application shows. Any other MethodError (a wrong argument type) keeps its own text.
function _arity_message(exception::MethodError)
    function_name = string(nameof(exception.f))
    startswith(function_name, "eq_") && (function_name = function_name[4:end])
    given = length(exception.args)
    arities = Int[]
    variadic = false
    for method in methods(exception.f)
        method.isva && (variadic = true)
        push!(arities, Int(method.nargs) - 1 - (method.isva ? 1 : 0))
    end
    isempty(arities) && return nothing
    given in arities && return nothing
    fewest, most = extrema(arities)
    plural(n) = n == 1 ? "1 argument" : "$n arguments"
    if given < fewest
        return "$function_name needs " * (fewest == most && !variadic ? "" : "at least ") *
               plural(fewest) * " but is applied to $given"
    elseif !variadic && given > most
        return "$function_name " * (fewest == most ? "needs " : "accepts at most ") *
               plural(most) * " but is applied to $given"
    end
    return nothing
end

function _region_error(exception)
    missing_package = _missing_package(exception)
    if missing_package !== nothing
        return Dict{String,Any}(
            "category" => "evaluation",
            "message" => "package $missing_package is not installed in the worksheet environment; install the worksheet packages first",
            "statement" => nothing,
            "julia_type" => "MissingPackage",
            "package" => missing_package,
        )
    end
    message, statement, julia_type = if exception isa EqError
        exception.message, exception.statement, nothing
    elseif exception isa MethodError && !(exception.f isa Function) && !(exception.f isa Type)
        "cannot call a value that is not a function", nothing, nothing
    elseif exception isa MethodError && _arity_message(exception) !== nothing
        _arity_message(exception), nothing, "MethodError"
    elseif exception isa Meta.ParseError
        "Syntax error in generated code: " * sprint(showerror, exception), nothing, "ParseError"
    else
        replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " "),
        nothing, string(nameof(typeof(exception)))
    end
    error = Dict{String,Any}(
        "category" => "evaluation",
        "message" => message,
        "statement" => statement,
    )
    julia_type === nothing || (error["julia_type"] = julia_type)
    return error
end

# what a Julia cell writes and how long it takes. The text is kept up to this size.
const _OUTPUT_LIMIT = 64 * 1024

function _limited(text::AbstractString)
    sizeof(text) <= _OUTPUT_LIMIT && return String(text)
    cut = prevind(text, _OUTPUT_LIMIT + 1)
    return String(text[1:cut]) * "\n… (output cut at 64 KiB)"
end

# The stack trace of the user's code: the first (original) exception of the stack, cut where
# the kernel's own frames begin, since `_eval_text` rethrows it without its backtrace.
function _user_trace()
    stack = current_exceptions()
    isempty(stack) && return ""
    frames = stacktrace(first(stack).backtrace)
    cut = findfirst(frame -> frame.func === :_eval_text || (frame.func === :eval && occursin("boot.jl", String(frame.file))), frames)
    frames = cut === nothing ? frames : frames[1:cut-1]
    return strip(sprint(Base.show_backtrace, frames)) |> String
end

# Runs `f` with stdout and stderr going, interleaved, into one pipe read while it runs.
function _captured(f)
    pipe = Pipe()
    Base.link_pipe!(pipe; reader_supports_async=true, writer_supports_async=true)
    reader = @async read(pipe, String)
    result = try
        redirect_stdout(pipe) do
            redirect_stderr(pipe) do
                f()
            end
        end
    finally
        close(pipe.in)
    end
    return result, fetch(reader)
end

function _evaluate_region(mod::Module, region, descriptors, payloads)
    capture = _field(region, :capture, false) === true
    capture || return _evaluate_region_plain(mod, region, descriptors, payloads)
    started = time()
    trace = Ref{Any}(nothing)
    # In the latest world, as an uncaptured region runs: names an earlier cell defined are
    # current here (Julia 1.12 world age).
    entry, output = _captured() do
        Base.invokelatest(_evaluate_region_plain, mod, region, descriptors, payloads; trace)
    end
    entry["output"] = _limited(output)
    entry["duration"] = time() - started
    if trace[] !== nothing && haskey(entry, "error")
        entry["error"]["trace"] = _limited(trace[])
    end
    return entry
end

function _evaluate_region_plain(mod::Module, region, descriptors, payloads; trace=nothing)
    id = String(region.id)
    entry = Dict{String,Any}("id" => id)
    try
        code = _field(region, :code)
        code === nothing || isempty(code) || _eval_text(mod, String(code))
        value = _field(region, :value)
        encoded = nothing
        if value !== nothing && !isempty(value)
            result = _eval_text(mod, String(value))
            result === nothing && throw(EqError("the expression has no value"))
            encoded = try
                encode_value(result)
            catch exception
                exception isa ArgumentError || rethrow()
                throw(EqError("cannot display this value: " * exception.msg))
            end
        end
        entry["status"] = "ok"
        display_unit = _field(region, :display_unit)
        if encoded !== nothing && display_unit !== nothing && !isempty(display_unit)
            # A unit override: the value stays in SI, the unit goes with the result.
            unit = eq_display_unit(result, _eval_text(mod, String(display_unit)))
            if unit isa EqRuntime.OffsetUnit
                # °C and °F show (value - offset) / scale, the offset in kelvin.
                entry["display_unit"] = encode_value(unit.scale * EqRuntime.eq_unit("K")).value
                entry["display_offset"] = unit.offset
            else
                entry["display_unit"] = encode_value(unit).value
            end
        end
        if encoded === nothing
            entry["value"] = nothing
        else
            offset = length(descriptors)
            append!(descriptors, encoded.descriptors)
            append!(payloads, encoded.payloads)
            entry["value"] = _shift_binary!(encoded.value, offset)
        end
    catch exception
        exception isa InterruptException && rethrow()
        entry["status"] = "error"
        entry["error"] = _region_error(exception)
        # In the latest world: the trace names functions the cell itself just defined.
        trace === nothing || (trace[] = Base.invokelatest(_user_trace))
    end
    return entry
end

# The project module files load once per kernel into one shared module: the
# worksheets, the other files and the REPL all see the same `module X`. A pass never replaces a
# module the regions already use; a saved file restarts the kernel.
const _SHARED = Ref{Union{Nothing,Module}}(nothing)
const _SHARED_FILES = Dict{String,Vector{Symbol}}()

function _shared()
    if _SHARED[] === nothing
        mod = Module(:Project)
        Core.eval(mod, :(using EqRuntime))
        _SHARED[] = mod
    end
    return _SHARED[]::Module
end

function _include_module(mod::Module, path::AbstractString)
    entry = Dict{String,Any}("name" => String(path), "error" => nothing)
    try
        if !haskey(_SHARED_FILES, String(path))
            isfile(path) || throw(ArgumentError("the file was not found"))
            shared = _shared()
            before = Set(names(shared; all=true))
            Base.include(shared, String(path))
            # The new bindings exist only in the world after the include (Julia 1.12 binding partitions).
            after = Base.invokelatest(names, shared; all=true)
            _SHARED_FILES[String(path)] = Symbol[name for name in after
                if !(name in before) && !startswith(String(name), "#")]
        end
        shared = _shared()
        if mod !== shared
            for name in _SHARED_FILES[String(path)]
                Core.eval(mod, :(global $name = $(Base.invokelatest(getglobal, shared, name))))
            end
        end
    catch exception
        exception isa InterruptException && rethrow()
        entry["error"] = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
    end
    return entry
end

function terminal_prepare_request(params, context)
    environment = _field(params, :environment)
    environment === nothing || (environment isa AbstractString && !isempty(environment)) ||
        throw(KernelFailure(-32602, "`environment` must be a non-empty string or null"))
    packages = _field(params, :packages, [])
    packages isa AbstractVector && all(p -> p isa AbstractString && Base.isidentifier(p), packages) ||
        throw(KernelFailure(-32602, "`packages` must be an array of package names"))
    modules = _field(params, :modules, [])
    modules isa AbstractVector && all(p -> p isa AbstractString && isabspath(p), modules) ||
        throw(KernelFailure(-32602, "`modules` must be an array of absolute file paths"))
    if environment !== nothing
        _use_environment_or_fail(environment)
        active_project = Base.active_project()
        if active_project !== nothing
            active_dir = dirname(active_project)
            active_dir in LOAD_PATH || push!(LOAD_PATH, active_dir)
        end
        pkg = Base.require(PKG_ID)
        Base.invokelatest(pkg.activate, String(environment); io=devnull)
    end
    project = _shared()
    result = Dict("packages" => [_import_package(project, p) for p in packages],
                  "modules" => [_include_module(project, p) for p in modules])
    if !isempty(get(ENV, "EQUAVELA_RPC_ADDRESS", ""))
        for entries in values(result), entry in entries
            entry["error"] === nothing || println(stderr,
                "Could not load ", entry["name"], ": ", entry["error"])
        end
    end
    return result
end

"""The packages a worksheet loads that are neither loaded nor precompiled: loading them compiles them."""
function _packages_to_compile(packages)
    names = String[]
    for name in packages
        Base.isidentifier(name) || continue
        id = Base.identify_package(String(name))
        id === nothing && continue
        haskey(Base.loaded_modules, id) && continue
        Base.isprecompiled(id) || push!(names, String(name))
    end
    return names
end

function _import_package(mod::Module, name::AbstractString)
    entry = Dict{String,Any}("name" => String(name), "error" => nothing)
    try
        Base.isidentifier(name) || throw(ArgumentError("invalid package name $name"))
        Core.eval(mod, Expr(:import, Expr(:., Symbol(name))))
        project = _shared()
        mod === project || Core.eval(project, Expr(:import, Expr(:., Symbol(name))))
    catch exception
        exception isa InterruptException && rethrow()
        entry["error"] = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
        missing_package = _missing_package(exception)
        missing_package === nothing || (entry["missing"] = missing_package)
    end
    return entry
end

# Worksheet environments. The kernel's own project
# (EqRuntime, JSON3) stays the active project; the worksheet environment directory is put
# on the load path right after it, so `using Foo` finds packages of its
# `Project.toml`/`Manifest.toml` without `Pkg.activate`. A kernel serves one environment.
# a new one replaces the previous one instead of accumulating with it.
function _project_file(dir::AbstractString)
    for name in ("JuliaProject.toml", "Project.toml")
        file = joinpath(dir, name)
        isfile(file) && return file
    end
    return nothing
end

"The worksheet environment this kernel last put on the load path."
const WORKSHEET_ENVIRONMENT = Ref{Union{Nothing,String}}(nothing)

function use_environment(dir::AbstractString)
    path = abspath(String(dir))
    isdir(path) || throw(ArgumentError("environment directory does not exist: $path"))
    _project_file(path) === nothing &&
        throw(ArgumentError("environment directory has no Project.toml: $path"))
    previous = WORKSHEET_ENVIRONMENT[]
    if previous !== nothing && previous != path
        filter!(!=(previous), LOAD_PATH)
    end
    if !(path in LOAD_PATH)
        insert!(LOAD_PATH, min(2, length(LOAD_PATH) + 1), path)
    end
    WORKSHEET_ENVIRONMENT[] = path
    return path
end

# A request that names an environment the kernel cannot use is an invalid request, not an internal error.
function _use_environment_or_fail(dir::AbstractString)
    try
        return use_environment(dir)
    catch exception
        exception isa ArgumentError || rethrow()
        throw(KernelFailure(-32602, exception.msg))
    end
end

"""
    _scoped(scope, inner)

`inner` entered inside `scope`: the zero-argument function a request runs. Every scope of a
request is built with it, because a closure that captured the variable of the previous scope
would capture the variable itself and call itself (a stack overflow), not the scope it wraps.
"""
_scoped(scope::Function, inner::Function) = () -> scope(inner)

# A Julia identifier that is not a keyword (`end` parses as an error, not as a name).
_plain_name(name::AbstractString) =
    Base.isidentifier(name) && (try Meta.parse(name) isa Symbol catch; false end)

function evaluate_request(params, context)
    name = _field(params, :worksheet)
    name isa AbstractString && !isempty(name) ||
        throw(KernelFailure(-32602, "`worksheet` must be a non-empty string"))
    regions = _field(params, :regions)
    regions isa AbstractVector ||
        throw(KernelFailure(-32602, "`regions` must be an array"))
    for region in regions
        (region isa JSON3.Object && _field(region, :id) isa AbstractString) ||
            throw(KernelFailure(-32602, "every region needs a string `id`"))
        for key in (:code, :value, :display_unit)
            field = _field(region, key)
            (field === nothing || field isa AbstractString) ||
                throw(KernelFailure(-32602, "region `$key` must be a string"))
        end
    end
    packages = _field(params, :packages, [])
    packages isa AbstractVector && all(p -> p isa AbstractString, packages) ||
        throw(KernelFailure(-32602, "`packages` must be an array of strings"))
    # Project module files to include into the worksheet module.
    modules = _field(params, :modules, [])
    modules isa AbstractVector && all(p -> p isa AbstractString && isabspath(p), modules) ||
        throw(KernelFailure(-32602, "`modules` must be an array of absolute file paths"))
    origin = _field(params, :origin)
    origin === nothing || origin isa Integer ||
        throw(KernelFailure(-32602, "`origin` must be an integer"))
    tol = _field(params, :tol)
    tol === nothing || (tol isa Real && !(tol isa Bool) && isfinite(tol) && tol > 0) ||
        throw(KernelFailure(-32602, "`tol` must be a positive number"))
    ctol = _field(params, :ctol)
    ctol === nothing || (ctol isa Real && !(ctol isa Bool) && isfinite(ctol) && ctol >= 0) ||
        throw(KernelFailure(-32602, "`ctol` must be a non-negative number"))
    exact_boolean = _field(params, :exact_boolean)
    exact_boolean === nothing || exact_boolean isa Bool ||
        throw(KernelFailure(-32602, "`exact_boolean` must be a boolean"))
    reset = _field(params, :reset, false)
    reset isa Bool || throw(KernelFailure(-32602, "`reset` must be a boolean"))
    environment = _field(params, :environment)
    environment === nothing || (environment isa AbstractString && !isempty(environment)) ||
        throw(KernelFailure(-32602, "`environment` must be a non-empty string"))
    # The directory of the worksheet, which a built-in that reads a file with a relative
    # path resolves against.
    base_dir = _field(params, :base_dir)
    base_dir === nothing || (base_dir isa AbstractString && !isempty(base_dir)) ||
        throw(KernelFailure(-32602, "`base_dir` must be a non-empty string"))
    # the name the REPL reaches this worksheet's module by.
    module_name = _field(params, :module_name)
    module_name === nothing || (module_name isa AbstractString && _plain_name(module_name)) ||
        throw(KernelFailure(-32602, "`module_name` must be a Julia identifier"))

    mod = worksheet_module(name; reset, module_name)
    module_name === nothing || Base.invokelatest(_bind_names!, _shared())
    run = function ()
        environment_result = nothing
        if environment !== nothing
            environment_result = Dict{String,Any}(
                "path" => abspath(String(environment)), "error" => nothing)
            try
                environment_result["path"] = use_environment(environment)
            catch exception
                exception isa InterruptException && rethrow()
                environment_result["error"] = sprint(showerror, exception)
            end
        end
        compiling = _packages_to_compile(packages)
        isempty(compiling) || activity!(context, "compiling"; message=join(compiling, ", "))
        package_results = [_import_package(mod, package) for package in packages]
        module_results = [_include_module(mod, path) for path in modules]
        descriptors = Dict{String,Any}[]
        payloads = Vector{UInt8}[]
        results = Dict{String,Any}[]
        total = length(regions)
        step = max(1, total ÷ 100)
        for (index, region) in enumerate(regions)
            push!(results, _evaluate_region(mod, region, descriptors, payloads))
            if index % step == 0 || index == total
                progress!(context; fraction=index / total, message=String(region.id))
            end
        end
        return BinaryResult(
            Dict{String,Any}("regions" => results, "packages" => package_results,
                "modules" => module_results, "environment" => environment_result),
            descriptors, payloads)
    end
    scoped = _scoped(f -> with_handle_owner(f, String(name)), run)
    tol === nothing || (scoped = _scoped(f -> with_tol(f, tol), scoped))
    ctol === nothing || (scoped = _scoped(f -> with_ctol(f, ctol), scoped))
    exact_boolean === false &&
        (scoped = _scoped(f -> with_exact_boolean(f, false), scoped))
    base_dir === nothing || (scoped = _scoped(f -> with_base_dir(f, base_dir), scoped))
    return origin === nothing ? scoped() : with_origin(scoped, Int(origin))
end

function discard_request(params)
    name = _field(params, :worksheet)
    name isa AbstractString ||
        throw(KernelFailure(-32602, "`worksheet` must be a string"))
    key = String(name)
    delete!(WORKSHEETS, key)
    release_handles!(key)
    retired = pop!(SHEET_NAMES, key, nothing)
    retired === nothing || push!(_RETIRED_NAMES, retired)
    retired === nothing || Base.invokelatest(_bind_names!, _shared())
    return nothing
end

const PKG_ID = Base.PkgId(Base.UUID("44cfe95a-1eb2-52ea-b672-e2afdf69b78f"), "Pkg")
const REPL_ID = Base.PkgId(Base.UUID("3fa0cd96-eef1-5676-8a61-b3b8758bbffb"), "REPL")

# one completion module per set of packages; it is never given the edited text.
const _COMPLETION_MODULES = Dict{Vector{String},Module}()

function _completion_module(packages::Vector{String})
    get!(_COMPLETION_MODULES, packages) do
        mod = Module(:EquavelaCompletion)
        for package in packages
            try
                Core.eval(mod, Expr(:using, Expr(:., Symbol(package))))
            catch exception
                exception isa InterruptException && rethrow()
            end
        end
        mod
    end
end

# one REPL module per environment, kept until the kernel restarts.
const _REPL_MODULES = Dict{String,Module}()

function _repl_module(key::String, packages::Vector{String}; reset::Bool=false)
    reset && delete!(_REPL_MODULES, key)
    get!(_REPL_MODULES, key) do
        mod = Module(:REPL_)
        Core.eval(mod, :(using EqRuntime))
        for package in packages
            try
                Core.eval(mod, Expr(:using, Expr(:., Symbol(package))))
            catch exception
                exception isa InterruptException && rethrow()
            end
        end
        mod
    end
end

"""
`repl`: evaluates `code` in the REPL module of the environment.
"""
function repl_request(params, context)
    code = _field(params, :code)
    code isa AbstractString || throw(KernelFailure(-32602, "`code` must be a string"))
    packages = _field(params, :packages, [])
    packages isa AbstractVector && all(p -> p isa AbstractString && Base.isidentifier(p), packages) ||
        throw(KernelFailure(-32602, "`packages` must be an array of package names"))
    environment = _field(params, :environment)
    environment === nothing || environment isa AbstractString ||
        throw(KernelFailure(-32602, "`environment` must be a string"))
    reset = _field(params, :reset, false) === true
    environment === nothing || isempty(environment) || _use_environment_or_fail(environment)
    parsed = Meta.parseall(String(code))
    if any(statement -> statement isa Expr && statement.head === :incomplete, parsed.args)
        return Dict{String,Any}("incomplete" => true, "output" => "", "value" => nothing,
            "error" => nothing, "trace" => nothing, "duration" => 0.0)
    end
    key = environment === nothing ? "" : String(environment)
    mod = Base.invokelatest(_repl_module, key, sort!(String[String(p) for p in packages]); reset)
    Base.invokelatest(_bind_names!, mod)
    started = time()
    value = Ref{Any}(nothing)
    error = Ref{Any}(nothing)
    trace = Ref{Any}(nothing)
    _, output = _captured() do
        try
            value[] = Base.invokelatest(Core.eval, mod, parsed)
        catch exception
            exception isa InterruptException && rethrow()
            error[] = exception isa LoadError ? exception.error : exception
            trace[] = Base.invokelatest(_user_trace)
        end
    end
    shown = error[] === nothing && value[] !== nothing ?
        _limited(Base.invokelatest(repr, MIME("text/plain"), value[]; context=:limit => true)) : nothing
    return Dict{String,Any}(
        "incomplete" => false,
        "output" => _limited(output),
        "value" => shown,
        "error" => error[] === nothing ? nothing : replace(strip(sprint(showerror, error[])), r"\s*\n\s*" => " "),
        "trace" => trace[] === nothing ? nothing : _limited(trace[]),
        "duration" => time() - started,
    )
end

# The text of one candidate. Julia's `completion_text` has no method for the LaTeX and emoji
# candidates (`\alpha` gives `α`): their text is the `completion` field.
function _completion_candidate(REPL, candidate)
    if nameof(typeof(candidate)) === :BslashCompletion
        return String(candidate.completion)
    end
    return REPL.REPLCompletions.completion_text(candidate)
end

"""
`complete`: the completions of `text` at character `position`, by Julia's REPL completion
engine, in a module that uses `packages`.
The text is parsed, not evaluated.
"""
function complete_request(params, context)
    text = _field(params, :text)
    text isa AbstractString || throw(KernelFailure(-32602, "`text` must be a string"))
    position = _field(params, :position)
    position isa Integer && 0 <= position <= length(text) ||
        throw(KernelFailure(-32602, "`position` must be a character offset inside `text`"))
    packages = _field(params, :packages, [])
    packages isa AbstractVector && all(p -> p isa AbstractString && Base.isidentifier(p), packages) ||
        throw(KernelFailure(-32602, "`packages` must be an array of package names"))
    environment = _field(params, :environment)
    environment === nothing || environment isa AbstractString ||
        throw(KernelFailure(-32602, "`environment` must be a string"))
    environment === nothing || isempty(environment) || _use_environment_or_fail(environment)
    code = String(text)
    prefix = first(code, position)
    point = isempty(prefix) ? 0 : lastindex(prefix)
    REPL = Base.require(REPL_ID)
    names = sort!(String[String(p) for p in packages])
    # the specification : the REPL panel completes in its own REPL module, so names defined there complete too.
    mod = if _field(params, :repl, false) === true
        Base.invokelatest(_bind_names!, Base.invokelatest(_repl_module, environment === nothing ? "" : String(environment), names))
    else
        Base.invokelatest(_bind_names!, Base.invokelatest(_completion_module, names))
    end
    completions, range, _ = Base.invokelatest(REPL.REPLCompletions.completions, code, point, mod)
    items = String[Base.invokelatest(_completion_candidate, REPL, c) for c in completions]
    if isempty(strip(code)) && _field(params, :repl, false) === true
        # Julia may return no candidates for an empty input. Offer the visible bindings,
        # with Project first so it remains available under the completion limit.
        visible = Base.invokelatest(Base.names, mod; all=true, imported=true)
        items = vcat(["Project"], String[string(name) for name in visible
            if Base.isidentifier(String(name)) && !startswith(String(name), "#")], items)
    end
    unique!(items)
    length(items) > 200 && resize!(items, 200)
    characters(byte) = byte <= 1 ? 0 : length(code, 1, prevind(code, min(byte, ncodeunits(code) + 1)))
    from = isempty(range) ? position : characters(first(range))
    return Dict{String,Any}("items" => items, "from" => from, "to" => position)
end

function _install_in(Pkg, dir::String, packages::Vector{String}, log::IO)
    previous = Base.active_project()
    try
        Pkg.activate(dir) do
            isempty(packages) || Pkg.add(packages; io=log)
            Pkg.instantiate(; io=log)
        end
    finally
        # The kernel's own project must stay the active one.
        Base.set_active_project(previous)
    end
    return nothing
end

"""
`install_packages`: adds `packages` to the environment in `environment` (a directory;
`Project.toml` is created when missing) and instantiates it, then stacks it on the load
path. This is the only place the kernel touches the network, and the host sends it only
after the user trusted the worksheet.
"""
function install_packages_request(params, context)
    environment = _field(params, :environment)
    environment isa AbstractString && !isempty(environment) ||
        throw(KernelFailure(-32602, "`environment` must be a non-empty string"))
    packages = _field(params, :packages, [])
    packages isa AbstractVector &&
        all(p -> p isa AbstractString && Base.isidentifier(p), packages) ||
        throw(KernelFailure(-32602, "`packages` must be an array of package names"))
    dir = abspath(String(environment))
    isdir(dir) ||
        throw(KernelFailure(-32602, "environment directory does not exist: $dir"))
    names = String[String(p) for p in packages]
    log = IOBuffer()
    try
        activity!(context, "packages")
        Pkg = Base.require(PKG_ID)
        Base.invokelatest(_install_in, Pkg, dir, names, log)
        use_environment(dir)
    catch exception
        exception isa InterruptException && rethrow()
        text = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
        throw(KernelFailure(-32000, "package installation failed: " * text,
            Dict{String,Any}("category" => "evaluation", "request_id" => context.id,
                "retryable" => false,
                "details" => Dict{String,Any}("log" => String(take!(log))))))
    end
    return Dict{String,Any}("environment" => dir, "packages" => names,
        "log" => String(take!(log)))
end

function _develop_in(Pkg, dir::String, paths::Vector{String}, log::IO)
    previous = Base.active_project()
    try
        # A relative path is resolved from the environment and recorded as written, so the
        # environment keeps working when both projects move together.
        cd(dir) do
            Pkg.activate(dir) do
                Pkg.develop([Pkg.PackageSpec(path=path) for path in paths]; io=log)
            end
        end
    finally
        Base.set_active_project(previous)
    end
    return nothing
end

"""
`develop_packages`: develops the packages in the folders `paths` (relative to the environment)
into the environment in `environment`. Both are
resolved together. The kernel's own project stays active.
"""
function develop_packages_request(params, context)
    environment = _field(params, :environment)
    environment isa AbstractString && !isempty(environment) ||
        throw(KernelFailure(-32602, "`environment` must be a non-empty string"))
    paths = _field(params, :paths, [])
    paths isa AbstractVector && !isempty(paths) &&
        all(p -> p isa AbstractString && !isempty(p) && !isabspath(p), paths) ||
        throw(KernelFailure(-32602, "`paths` must be a non-empty array of relative folders"))
    dir = abspath(String(environment))
    isdir(dir) ||
        throw(KernelFailure(-32602, "environment directory does not exist: $dir"))
    folders = String[String(p) for p in paths]
    for folder in folders
        isfile(joinpath(dir, folder, "Project.toml")) ||
            throw(KernelFailure(-32602, "not a Julia package folder: $folder"))
    end
    log = IOBuffer()
    try
        activity!(context, "packages")
        Pkg = Base.require(PKG_ID)
        Base.invokelatest(_develop_in, Pkg, dir, folders, log)
    catch exception
        exception isa InterruptException && rethrow()
        text = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
        throw(KernelFailure(-32000, "package development failed: " * text,
            Dict{String,Any}("category" => "evaluation", "request_id" => context.id,
                "retryable" => false,
                "details" => Dict{String,Any}("log" => String(take!(log))))))
    end
    return Dict{String,Any}("environment" => dir, "packages" => folders,
        "log" => String(take!(log)))
end

function _remove_in(Pkg, dir::String, packages::Vector{String}, log::IO)
    previous = Base.active_project()
    try
        Pkg.activate(dir) do
            Pkg.rm(packages; io=log)
        end
    finally
        # The kernel's own project must stay the active one.
        Base.set_active_project(previous)
    end
    return nothing
end

"""
`remove_packages`: removes `packages` from the direct dependencies of the environment in
`environment`. The kernel's own project stays active.
"""
function remove_packages_request(params, context)
    environment = _field(params, :environment)
    environment isa AbstractString && !isempty(environment) ||
        throw(KernelFailure(-32602, "`environment` must be a non-empty string"))
    packages = _field(params, :packages, [])
    packages isa AbstractVector && !isempty(packages) &&
        all(p -> p isa AbstractString && Base.isidentifier(p), packages) ||
        throw(KernelFailure(-32602, "`packages` must be a non-empty array of package names"))
    dir = abspath(String(environment))
    _project_file(dir) === nothing &&
        throw(KernelFailure(-32602, "environment directory has no Project.toml: $dir"))
    names = String[String(p) for p in packages]
    log = IOBuffer()
    try
        activity!(context, "packages")
        Pkg = Base.require(PKG_ID)
        Base.invokelatest(_remove_in, Pkg, dir, names, log)
    catch exception
        exception isa InterruptException && rethrow()
        text = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
        throw(KernelFailure(-32000, "package removal failed: " * text,
            Dict{String,Any}("category" => "evaluation", "request_id" => context.id,
                "retryable" => false,
                "details" => Dict{String,Any}("log" => String(take!(log))))))
    end
    return Dict{String,Any}("environment" => dir, "packages" => names,
        "log" => String(take!(log)))
end

function _manage_environment_in(Pkg, dir::String, operation::String, log::IO)
    previous = Base.active_project()
    try
        Pkg.activate(dir) do
            if operation == "instantiate"
                Pkg.instantiate(; io=log)
            elseif operation == "resolve"
                Pkg.resolve(; io=log)
            else # The request validates this as "update".
                Pkg.update(; io=log)
            end
        end
    finally
        Base.set_active_project(previous)
    end
    return nothing
end

"""Run an explicitly requested Pkg operation in an existing worksheet environment."""
function manage_environment_request(params, context)
    environment = _field(params, :environment)
    environment isa AbstractString && !isempty(environment) ||
        throw(KernelFailure(-32602, "`environment` must be a non-empty string"))
    operation = _field(params, :operation)
    operation isa AbstractString && operation in ("instantiate", "resolve", "update") ||
        throw(KernelFailure(-32602, "`operation` must be instantiate, resolve, or update"))
    dir = abspath(String(environment))
    isdir(dir) ||
        throw(KernelFailure(-32602, "environment directory does not exist: $dir"))
    _project_file(dir) === nothing &&
        throw(KernelFailure(-32602, "environment directory has no Project.toml: $dir"))
    log = IOBuffer()
    try
        activity!(context, "packages")
        Pkg = Base.require(PKG_ID)
        Base.invokelatest(_manage_environment_in, Pkg, dir, String(operation), log)
    catch exception
        exception isa InterruptException && rethrow()
        text = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
        throw(KernelFailure(-32000, "environment operation failed: " * text,
            Dict{String,Any}("category" => "evaluation", "request_id" => context.id,
                "retryable" => false,
                "details" => Dict{String,Any}("log" => String(take!(log))))))
    end
    return Dict{String,Any}("environment" => dir, "packages" => String[],
        "log" => String(take!(log)))
end

# Pkg can choose version-specific manifest names. Save only its environment files,
# including absent variants that it might create, rather than other worksheet files.
function _pkg_environment_files(dir::String)
    return filter(name -> occursin(r"^(?:(?:Julia)?Project|(?:Julia)?Manifest(?:-v\d+\.\d+)?)\.toml$", name), readdir(dir))
end

function _set_compatibility_in(Pkg, dir::String, package::String, compatibility::String, log::IO)
    project = _project_file(dir)
    deps = get(Pkg.TOML.parsefile(project), "deps", Dict())
    haskey(deps, package) && package != "julia" && package != "Julia" ||
        throw(KernelFailure(-32602, "`package` must be a direct dependency"))
    files = _pkg_environment_files(dir)
    all(name -> !islink(joinpath(dir, name)) && isfile(joinpath(dir, name)), files) ||
        throw(KernelFailure(-32602, "environment metadata must contain only regular files"))
    saved = Dict(name => read(joinpath(dir, name)) for name in files)
    previous = Base.active_project()
    try
        Pkg.activate(dir) do
            if isempty(strip(compatibility))
                # In an interactive (`julia -i`) kernel, `Pkg.compat(pkg, "")` prompts on `stdin`
                # and blocks forever. Remove the `[compat]` entry via TOML and let `Pkg.resolve`
                # validate and update the environment.
                data = Pkg.TOML.parsefile(project)
                compat = get(data, "compat", nothing)
                if compat isa AbstractDict && haskey(compat, package)
                    delete!(compat, package)
                    isempty(compat) && delete!(data, "compat")
                    open(project, "w") do io
                        Pkg.TOML.print(io, data; sorted=true)
                    end
                end
            else
                Pkg.compat(package, compatibility; io=log)
            end
            # Pkg.compat may report a resolver failure without throwing it.
            Pkg.resolve(; io=log)
        end
    catch
        for name in _pkg_environment_files(dir)
            path = joinpath(dir, name)
            isfile(path) && !haskey(saved, name) && rm(path)
        end
        for (name, bytes) in saved
            write(joinpath(dir, name), bytes)
        end
        rethrow()
    finally
        Base.set_active_project(previous)
    end
    return nothing
end

"""Set or clear a direct dependency's Pkg compatibility bound atomically on failure."""
function set_compatibility_request(params, context)
    environment = _field(params, :environment)
    environment isa AbstractString && !isempty(environment) ||
        throw(KernelFailure(-32602, "`environment` must be a non-empty string"))
    package = _field(params, :package)
    package isa AbstractString && Base.isidentifier(package) ||
        throw(KernelFailure(-32602, "`package` must be a package name"))
    compatibility = _field(params, :compatibility)
    compatibility isa AbstractString ||
        throw(KernelFailure(-32602, "`compatibility` must be a string"))
    dir = abspath(String(environment))
    isdir(dir) && _project_file(dir) !== nothing ||
        throw(KernelFailure(-32602, "environment directory has no Project.toml: $dir"))
    log = IOBuffer()
    try
        activity!(context, "packages")
        Pkg = Base.require(PKG_ID)
        Base.invokelatest(_set_compatibility_in, Pkg, dir, String(package), String(compatibility), log)
    catch exception
        (exception isa InterruptException || exception isa KernelFailure) && rethrow()
        text = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
        throw(KernelFailure(-32000, "compatibility change failed: " * text,
            Dict{String,Any}("category" => "evaluation", "request_id" => context.id,
                "retryable" => false,
                "details" => Dict{String,Any}("log" => String(take!(log))))))
    end
    return Dict{String,Any}("environment" => dir, "packages" => [String(package)],
        "log" => String(take!(log)))
end
