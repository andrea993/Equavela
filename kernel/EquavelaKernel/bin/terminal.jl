# Terminal stdio belongs to Julia's LineEdit; framed kernel RPC uses an authenticated
# loopback connection. Only one backend evaluation or RPC handler executes at a time.
# Loaded inside EquavelaKernel; implementation dependencies stay out of Main.
const Sockets = Base.require(Base.PkgId(Base.UUID("6462fe0b-24de-5631-8697-dd941f90decc"), "Sockets"))
const REPL = Base.require(REPL_ID)
const Pkg = Base.require(PKG_ID)

function run_terminal_kernel(address::String, token::String)
    isempty(token) && error("Missing kernel RPC token")
    host, port = split(address, ':'; limit=2)
    host == "127.0.0.1" || error("Kernel RPC must use loopback")
    socket = Sockets.connect(Sockets.IPv4("127.0.0.1"), parse(Int, port))
    println(socket, token)
    flush(socket)

    project = EquavelaKernel._shared()
    Core.eval(Main, :(global Project = $project))
    environment = get(ENV, "EQUAVELA_TERMINAL_ENVIRONMENT", "")
    isempty(environment) && (environment = mktempdir())
    kernel_project = dirname(Base.active_project())
    kernel_project in LOAD_PATH || push!(LOAD_PATH, kernel_project)
    Pkg.activate(environment; io=devnull)
    # Keep LineEdit output on independent descriptors while worksheet capture redirects
    # Julia's process-wide stdout/stderr descriptors.
    terminal_out = Base.TTY(Base.Libc.dup(Base.RawFD(1)))
    terminal_err = Base.TTY(Base.Libc.dup(Base.RawFD(2)))
    term = REPL.Terminals.TTYTerminal(get(ENV, "TERM", "xterm-256color"), stdin, terminal_out, terminal_err)
    repl = REPL.LineEditREPL(term, true)
    # Julia's default empty-line Tab does not offer names. Leave every nonempty
    # input and every other REPL mode to the standard LineEdit handler.
    keymap = Dict{Any,Any}('\t' => function (state, args...)
        if isempty(state) && REPL.LineEdit.mode(state) === repl.interface.modes[1]
            mod = Base.active_module(repl)
            candidates = sort!(String[string(name) for name in names(mod; all=true, imported=true)
                if Base.isidentifier(String(name)) && !startswith(String(name), "#")])
            print(term, "\n", join(candidates, "  "), "\n")
            REPL.LineEdit.refresh_line(state)
        else
            REPL.LineEdit.edit_tab(state, true)
        end
    end)
    repl.interface = REPL.setup_interface(repl; extra_repl_keymap=keymap)
    backend = REPL.REPLBackend()
    ref = REPL.REPLBackendRef(backend)
    # Run RPC work in the same backend task as REPL evaluations. Besides preventing
    # concurrent mutation/capture, Julia delivers SIGINT to the executing main task.
    rpc = @async try
        handler = function (method, params, context, binaries)
            reply = Channel{Any}(1)
            job = () -> EquavelaKernel.default_handler(method, params, context, binaries)
            put!(backend.repl_channel, ((job, reply), 3))
            ok, value = take!(reply)
            ok || throw(value)
            return value
        end
        EquavelaKernel.serve(socket, socket; handler)
    finally
        close(socket)
        # EOF and shutdown must also end a terminal that is waiting for input.
        put!(backend.repl_channel, (nothing, -1))
    end
    display = REPL.REPLDisplay(repl)
    # The host starts Julia with -i. Run the standard hooks so Pkg installs its
    # real REPL mode, as it does in Julia's ordinary interactive startup.
    isinteractive() || error("Terminal kernel must be started with Julia -i")
    Core.eval(Base, :(active_repl = $repl))
    Core.eval(Base, :(active_repl_backend = $backend))
    Base._atreplinit(repl)
    pushdisplay(display)
    frontend = errormonitor(@async REPL.run_frontend(repl, ref))
    backend.backend_task = current_task()
    try
        while true
            task_local_storage()[:SOURCE_PATH] = nothing
            request = try
                take!(backend.repl_channel)
            catch exception
                exception isa InterruptException && continue
                rethrow()
            end
            ast_or_func, mode = request
            mode == -1 && break
            if mode == 3
                job, reply = ast_or_func
                try
                    put!(reply, (true, job()))
                catch exception
                    put!(reply, (false, exception))
                end
            elseif mode == 2
                try
                    put!(backend.response_channel, Pair{Any,Bool}(ast_or_func(), false))
                catch
                    put!(backend.response_channel, Pair{Any,Bool}(current_exceptions(), true))
                end
            else
                REPL.eval_user_input(ast_or_func, backend, Base.active_module(repl))
            end
        end
    finally
        popdisplay(display)
        close(socket)
        istaskdone(frontend) || schedule(frontend, InterruptException(); error=true)
        istaskdone(rpc) || schedule(rpc, InterruptException(); error=true)
    end
end
