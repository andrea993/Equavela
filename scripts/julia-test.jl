# Fast Julia test runner for development (agents and humans).
#
# `Pkg.test` rebuilds a temporary environment on every call (~25 s) and a fresh
# Julia process recompiles all test code (~35 s). This script avoids both:
#
#   julia scripts/julia-test.jl [EqRuntime|EquavelaKernel|all]
#       One-shot run in a persistent test environment (.julia-test-env/, created
#       on first use, gitignored). Saves the environment rebuild.
#
#   julia scripts/julia-test.jl --serve
#       Starts a test server on 127.0.0.1:$PORT (default 8763) that keeps Julia,
#       the packages and compiled code warm; Revise reloads edited source files.
#
#   julia --startup-file=no scripts/julia-test.jl --remote [EqRuntime|EquavelaKernel|all]
#       Asks the running server to run the suite and prints its output. Exit
#       code 0 when all tests pass, 1 on failures, 2 if no server is running.
#
# `Pkg.test()` stays the reference check before a final commit.

using Sockets

const ROOT = normpath(joinpath(@__DIR__, ".."))
const ENV_DIR = joinpath(ROOT, ".julia-test-env")
const PORT = parse(Int, get(ENV, "EQUAVELA_TEST_PORT", "8763"))
const SUITES = Dict(
    "EqRuntime" => joinpath(ROOT, "kernel", "EqRuntime", "test", "runtests.jl"),
    "EquavelaKernel" => joinpath(ROOT, "kernel", "EquavelaKernel", "test", "runtests.jl"),
)

suites_for(name) = name == "all" ? ["EqRuntime", "EquavelaKernel"] :
    haskey(SUITES, name) ? [name] : error("unknown suite $(repr(name)); use EqRuntime, EquavelaKernel or all")

function remote(name)
    sock = try
        Sockets.connect(Sockets.localhost, PORT)
    catch
        println(stderr, "no test server on port $PORT; start it with: julia scripts/julia-test.jl --serve")
        exit(2)
    end
    println(sock, name)
    status = 1
    for line in eachline(sock)
        if startswith(line, "##STATUS ")
            status = parse(Int, line[10:end])
        else
            println(line)
        end
    end
    exit(status)
end

function ensure_env()
    @eval using Pkg
    Base.invokelatest(setup_env)
end

function setup_env()
    if !isfile(joinpath(ENV_DIR, "Manifest.toml"))
        mkpath(ENV_DIR)
        Pkg.activate(ENV_DIR; io=devnull)
        Pkg.develop([Pkg.PackageSpec(path=joinpath(ROOT, "kernel", "EqRuntime")),
                     Pkg.PackageSpec(path=joinpath(ROOT, "kernel", "EquavelaKernel"))])
        Pkg.add(["Test", "JSON3", "Unitful", "LinearAlgebra", "Revise"])
    end
    Pkg.activate(ENV_DIR; io=devnull)
end

# Each run gets a fresh anonymous module, so test files that define modules,
# structs or constants can be included again without redefinition errors.
function run_suite(name, io)
    file = SUITES[name]
    t0 = time()
    ok = try
        redirect_stdout(io) do
            redirect_stderr(io) do
                cd(dirname(file)) do
                    m = Module(Symbol(name, "Tests"))
                    Core.eval(m, :(include(path) = Base.include($m, path)))
                    Core.eval(m, :(eval(x) = Core.eval($m, x)))
                    Base.include(m, file)
                end
            end
        end
        true
    catch err
        nameof(typeof(err)) == :TestSetException || showerror(io, err, catch_backtrace())
        false
    end
    println(io, "$name: ", ok ? "passed" : "FAILED", " in ", round(time() - t0; digits=1), " s")
    return ok
end

function serve()
    @eval using Revise
    @eval using EqRuntime, EquavelaKernel
    Base.invokelatest(serve_loop)
end

function serve_loop()
    server = Sockets.listen(Sockets.localhost, PORT)
    println("test server ready on 127.0.0.1:$PORT (Ctrl+C to stop)")
    while true
        sock = Sockets.accept(server)
        try
            name = strip(readline(sock))
            isempty(name) && continue  # readiness probe
            ok = try
                Main.Revise.revise()
                # Output goes through a pipe, not the socket itself: on Windows a
                # child process (Pkg, the linker) cannot inherit a socket handle.
                out = Pipe()
                Base.link_pipe!(out; reader_supports_async=true, writer_supports_async=true)
                forward = @async write(sock, out)
                result = try
                    all(run_suite(s, out) for s in suites_for(name))
                finally
                    close(out.in)
                    wait(forward)
                end
                result
            catch err
                println(sock, sprint(showerror, err))
                false
            end
            println(sock, "##STATUS ", ok ? 0 : 1)
        catch err
            err isa Base.IOError || @warn "test request failed" exception = err
        finally
            close(sock)
        end
    end
end

function main(args)
    if !isempty(args) && args[1] == "--remote"
        remote(length(args) > 1 ? args[2] : "all")
    end
    ensure_env()
    if !isempty(args) && args[1] == "--serve"
        serve()
    else
        ok = all(run_suite(s, stdout) for s in suites_for(isempty(args) ? "all" : args[1]))
        exit(ok ? 0 : 1)
    end
end

main(ARGS)
