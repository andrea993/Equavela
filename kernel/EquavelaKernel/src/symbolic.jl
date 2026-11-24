# The `symbolic` and `symbolic_status` requests.
#
# The bridge (symbolic_bridge.jl) needs PythonCall and SymPy. Neither is loaded when the
# kernel starts: the first `version` request (the handshake) only schedules a warm-up
# task, and the task (or the first `symbolic` request, whichever comes first) loads the
# bridge. A lock serializes the two, so a request that arrives during the warm-up waits for
# it. Julia tasks are cooperative: the warm-up runs while the serve loop waits for input,
# and a single long Python call (`import sympy`) delays a request that arrives meanwhile.

include_dependency(joinpath(@__DIR__, "symbolic_bridge.jl"))
const BRIDGE_SOURCE = read(joinpath(@__DIR__, "symbolic_bridge.jl"), String)

const SYMBOLIC_LOCK = ReentrantLock()
const SYMBOLIC_STATUS = Dict{String,Any}(
    "state" => "idle", "message" => nothing, "sympy" => nothing, "python" => nothing,
    "seconds" => nothing)
const BRIDGE_LOADED = Ref(false)
const SYMPY_IMPORTED = Ref(false)

# Where the Python environment lives when the host did not say (same default as
# `app/src-tauri/src/kernel_path.rs`): a short per-user directory.
function _default_python_env()
    base = if Sys.iswindows()
        get(ENV, "LOCALAPPDATA", nothing)
    else
        get(ENV, "XDG_DATA_HOME") do
            home = get(ENV, "HOME", nothing)
            home === nothing ? nothing : joinpath(home, ".local", "share")
        end
    end
    return base === nothing ? nothing : joinpath(base, "equavela", "py")
end

"""
    _remove_stale_condapkg_lock!(project_dir) -> Bool

CondaPkg serializes resolves with `<project>/.CondaPkg/lock`, a `Pidfile` (`"<pid> <host>"`).
When the process that held it dies (a killed test run, a kernel killed during a resolve) the
file stays and, on Windows, `Pidfile.mkpidlock(wait=true)` never reclaims it: every later load
prints "CondaPkg: Waiting for lock to be freed" and the SymPy warm-up never finishes (the
2026-11-02 regression of `core/tests/symbolic.rs`). The lock is removed only when it names
this host and a pid that is not a running process; anything else is left alone.
"""
function _remove_stale_condapkg_lock!(project_dir::AbstractString)
    lockfile = joinpath(project_dir, ".CondaPkg", "lock")
    isfile(lockfile) || return false
    try
        fields = split(read(lockfile, String), ' '; limit=2)
        pid = tryparse(Cuint, strip(fields[1]))
        (pid === nothing || pid == 0) && return false
        length(fields) == 2 && strip(fields[2]) == gethostname() || return false
        pid == getpid() && return false
        # `kill(pid, 0)` sends nothing; ESRCH means that no such process exists
        ccall(:uv_kill, Cint, (Cuint, Cint), pid, 0) == Base.UV_ESRCH || return false
        chmod(lockfile, 0o666)
        rm(lockfile; force=true)
        return true
    catch
        return false
    end
end

function _python_env_is_resolved(directory::AbstractString)
    (isfile(joinpath(directory, "python.exe")) || isfile(joinpath(directory, "bin", "python"))) || return false
    has_packages(site) = all(name -> isdir(joinpath(site, name)), ("xlrd", "xlwt", "xlutils"))
    has_packages(joinpath(directory, "Lib", "site-packages")) && return true
    lib = joinpath(directory, "lib")
    # A missing or unreadable environment should trigger a resolve, not stop kernel startup.
    versions = try
        readdir(lib)
    catch e
        e isa IOError || e isa SystemError || rethrow()
        return false
    end
    return any(name -> startswith(name, "python") &&
                       has_packages(joinpath(lib, name, "site-packages")), versions)
end

function _configure_python_env!()
    if !haskey(ENV, "JULIA_CONDAPKG_ENV") || isempty(ENV["JULIA_CONDAPKG_ENV"])
        directory = _default_python_env()
        directory === nothing || (ENV["JULIA_CONDAPKG_ENV"] = directory)
    end
    directory = get(ENV, "JULIA_CONDAPKG_ENV", "")
    # CondaPkg locks in the first environment of the load path that depends on it, which is not the
    # active project once the REPL kernel has activated the worksheet environment
    # (`bin/terminal.jl`): look at every environment of the load path.
    for env in Base.load_path()
        project = Base.env_project_file(env)
        project isa String && _remove_stale_condapkg_lock!(dirname(project))
    end
    if !haskey(ENV, "JULIA_CONDAPKG_OFFLINE") && _python_env_is_resolved(directory)
        ENV["JULIA_CONDAPKG_OFFLINE"] = "yes"
    end
    return nothing
end

const BRIDGE = Ref{Module}()

# The bridge module is created at run time, so its bindings live in a newer world than the
# code of this file: every access goes through `invokelatest`.
_bridge_call_latest(name::Symbol, args...) = getfield(BRIDGE[], name)(args...)
_bridge_call(name::Symbol, args...) = Base.invokelatest(_bridge_call_latest, name, args...)

"""Loads the bridge and imports SymPy (idempotent). Throws the underlying error on failure."""
function _ensure_symbolic!(; steps=false)
    lock(SYMBOLIC_LOCK) do
        # An interrupt that lands in the middle of the load (the warm-up task is what runs while the
        # serve loop waits for input, so the task gets the Ctrl+C meant for a request) would leave
        # PythonCall half initialised: every later symbolic request then failed with an
        # `UndefRefError`. Found driving the real app (an edit while the first pass ran interrupted
        # the warm-up). The load is therefore atomic with respect to interrupts; a pending interrupt
        # is raised right after it.
        Base.sigatomic_begin()
        try
            _load_symbolic!(steps)
        finally
            Base.sigatomic_end()
        end
    end
    return nothing
end

function _load_symbolic!(steps::Bool)
    begin
        if !BRIDGE_LOADED[]
            _configure_python_env!()
            Base.include_string(@__MODULE__, BRIDGE_SOURCE, "symbolic_bridge.jl")
            BRIDGE[] = Base.invokelatest(getfield, @__MODULE__, :SymbolicBridge)
            BRIDGE_LOADED[] = true
        end
        steps && yield()
        if !SYMPY_IMPORTED[]
            _bridge_call(:import_sympy!)
            SYMPY_IMPORTED[] = true
        end
    end
    return nothing
end

function _warm_up!()
    started = time()
    try
        lock(SYMBOLIC_LOCK) do
            _ensure_symbolic!(steps=true)
            yield()
            _bridge_call(:warm_up!)
        end
        versions = _bridge_call(:versions)
        SYMBOLIC_STATUS["sympy"] = versions.sympy
        SYMBOLIC_STATUS["python"] = versions.python
        SYMBOLIC_STATUS["message"] = nothing
        SYMBOLIC_STATUS["seconds"] = round(time() - started; digits=2)
        SYMBOLIC_STATUS["state"] = "ready"
    catch exception
        if exception isa InterruptException
            # the interrupt was meant for a request, not for the background warm-up: the next
            # `symbolic` request loads (or finishes loading) the engine itself
            SYMBOLIC_STATUS["state"] = "idle"
            return nothing
        end
        haskey(ENV, "EQUAVELA_KERNEL_DEBUG") && println(stderr, sprint(showerror, exception, catch_backtrace()))
        SYMBOLIC_STATUS["message"] = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
        SYMBOLIC_STATUS["seconds"] = round(time() - started; digits=2)
        SYMBOLIC_STATUS["state"] = "failed"
    end
    return nothing
end

"""
    start_symbolic_warmup!()

Schedules the warm-up task once (state `idle` to `warming`). `EQUAVELA_SYMBOLIC_WARMUP=off`
disables it (tests that never use symbolics); a `symbolic` request still loads everything.
"""
function start_symbolic_warmup!()
    SYMBOLIC_STATUS["state"] == "idle" || return nothing
    # Never while the package image is being built (the precompile workload sends `version`).
    ccall(:jl_generating_output, Cint, ()) != 0 && return nothing
    lowercase(get(ENV, "EQUAVELA_SYMBOLIC_WARMUP", "auto")) in ("off", "0", "false", "no") && return nothing
    SYMBOLIC_STATUS["state"] = "warming"
    @async begin
        # Let the handshake response go out before the first non-yielding step.
        sleep(0.3)
        _warm_up!()
    end
    return nothing
end

function symbolic_status_request()
    return Dict{String,Any}(
        "state" => SYMBOLIC_STATUS["state"],
        "message" => SYMBOLIC_STATUS["message"],
        "sympy" => SYMBOLIC_STATUS["sympy"],
        "python" => SYMBOLIC_STATUS["python"],
        "seconds" => SYMBOLIC_STATUS["seconds"])
end

# JSON3 values to plain Julia data (the bridge walks `Dict{String,Any}` / `Vector{Any}`).
_plain(value::JSON3.Object) = Dict{String,Any}(String(k) => _plain(v) for (k, v) in pairs(value))
_plain(value::JSON3.Array) = Any[_plain(v) for v in value]
_plain(value::AbstractDict) = Dict{String,Any}(String(k) => _plain(v) for (k, v) in value)
_plain(value::AbstractVector) = Any[_plain(v) for v in value]
_plain(value) = value

function _unavailable(exception)
    message = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
    return Dict{String,Any}("status" => "error", "error" => Dict{String,Any}(
        "category" => "unavailable",
        "message" => "the symbolic engine is not available: " * message *
                     " (the Python environment with SymPy must be resolved once)"))
end

function symbolic_request(params, context)
    params isa Union{JSON3.Object,AbstractDict} ||
        throw(KernelFailure(-32602, "`params` must be an object"))
    expr = get(params, :expr, get(params, "expr", nothing))
    (expr isa JSON3.Object || expr isa AbstractDict) ||
        throw(KernelFailure(-32602, "`expr` must be an expression object"))
    for key in ("keywords", "definitions")
        value = get(params, Symbol(key), get(params, key, nothing))
        (value === nothing || value isa JSON3.Array || value isa AbstractVector) ||
            throw(KernelFailure(-32602, "`$key` must be an array"))
    end
    origin = get(params, :origin, get(params, "origin", nothing))
    (origin === nothing || origin isa Integer) ||
        throw(KernelFailure(-32602, "`origin` must be an integer"))
    request = _plain(params)
    # The first request after a start may load Python and SymPy (and, the very first time,
    # install them): the host tells the user to wait.
    SYMBOLIC_STATUS["state"] == "ready" || activity!(context, "symbolic")
    try
        _ensure_symbolic!()
    catch exception
        exception isa InterruptException && rethrow()
        SYMBOLIC_STATUS["state"] = "failed"
        SYMBOLIC_STATUS["message"] = replace(strip(sprint(showerror, exception)), r"\s*\n\s*" => " ")
        return _unavailable(exception)
    end
    if SYMBOLIC_STATUS["state"] != "ready"
        # The warm-up did not run (or failed once and the environment works now).
        versions = _bridge_call(:versions)
        SYMBOLIC_STATUS["sympy"] = versions.sympy
        SYMBOLIC_STATUS["python"] = versions.python
        SYMBOLIC_STATUS["message"] = nothing
        SYMBOLIC_STATUS["state"] = "ready"
    end
    return _bridge_call(:evaluate, request)
end
