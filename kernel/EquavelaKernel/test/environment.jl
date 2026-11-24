# Julia regions: worksheet environments, missing packages and `install_packages`.
# Only stdlib packages and a local path package are
# used, so no network access is needed.

@testset "EquavelaKernel julia environments" begin
    foo_uuid = "d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b11"
    root = mktempdir()
    mkpath(joinpath(root, "Foo", "src"))
    write(joinpath(root, "Foo", "Project.toml"),
        "name = \"Foo\"\nuuid = \"$foo_uuid\"\nversion = \"0.1.0\"\n")
    write(joinpath(root, "Foo", "src", "Foo.jl"),
        "module Foo\ntriple(x) = 3x\nend\n")
    env = joinpath(root, "env")
    mkpath(env)
    write(joinpath(env, "Project.toml"), "[deps]\nFoo = \"$foo_uuid\"\n")
    write(joinpath(env, "Manifest.toml"),
        "julia_version = \"$(VERSION)\"\nmanifest_format = \"2.0\"\n\n" *
        "[[deps.Foo]]\npath = \"../Foo\"\nuuid = \"$foo_uuid\"\nversion = \"0.1.0\"\n")

    @testset "a package of the worksheet environment loads once the environment is stacked" begin
        before = copy(LOAD_PATH)
        try
            result, _ = evaluate(Dict(
                "worksheet" => "env1",
                "regions" => [region("r1"; code="using Foo"), region("r2"; code="y = Foo.triple(2.0)", value="from_julia(y)")]))
            # Without `environment` the package is unknown: a clear, structured error.
            error = result.result["regions"][1]
            @test error["status"] == "error"
            @test error["error"]["julia_type"] == "MissingPackage"
            @test error["error"]["package"] == "Foo"
            @test occursin("not installed", error["error"]["message"])
            @test result.result["environment"] === nothing

            result, _ = evaluate(Dict(
                "worksheet" => "env2", "environment" => env,
                "regions" => [region("r1"; code="using Foo"), region("r2"; code="y = Foo.triple(2.0)", value="from_julia(y)")]))
            @test result.result["environment"]["error"] === nothing
            @test result.result["environment"]["path"] == abspath(env)
            @test [r["status"] for r in result.result["regions"]] == ["ok", "ok"]
            @test result.result["regions"][2]["value"]["value"] == 6.0
            @test count(==(abspath(env)), LOAD_PATH) == 1
            # The kernel project stays first: "@" is not displaced.
            @test LOAD_PATH[1] == "@"
            # Asking again does not duplicate the entry.
            evaluate(Dict("worksheet" => "env3", "environment" => env, "regions" => []))
            @test count(==(abspath(env)), LOAD_PATH) == 1
        finally
            empty!(LOAD_PATH)
            append!(LOAD_PATH, before)
        end
    end

    @testset "a second environment replaces the first on the load path" begin
        before = copy(LOAD_PATH)
        try
            other = joinpath(root, "other")
            mkpath(other)
            write(joinpath(other, "Project.toml"), "")
            evaluate(Dict("worksheet" => "first", "environment" => env, "regions" => []))
            @test abspath(env) in LOAD_PATH
            evaluate(Dict("worksheet" => "second", "environment" => other, "regions" => []))
            @test abspath(other) in LOAD_PATH
            @test !(abspath(env) in LOAD_PATH)
            @test LOAD_PATH[1] == "@"
        finally
            EquavelaKernel.WORKSHEET_ENVIRONMENT[] = nothing
            empty!(LOAD_PATH)
            append!(LOAD_PATH, before)
        end
    end

    @testset "stdlib packages need no environment" begin
        # The Pkg.test sandbox has no "@stdlib" on its load path; the real kernel has.
        before = copy(LOAD_PATH)
        "@stdlib" in LOAD_PATH || push!(LOAD_PATH, "@stdlib")
        try
            result, _ = evaluate(Dict(
                "worksheet" => "std",
                "regions" => [
                    region("r1"; code="using LinearAlgebra, Statistics"),
                    region("r2"; value="from_julia(norm([3.0, 4.0]))"),
                    region("r3"; value="from_julia(mean([1.0, 2.0, 6.0]))")]))
            @test [r["status"] for r in result.result["regions"]] == ["ok", "ok", "ok"]
            @test result.result["regions"][2]["value"]["value"] == 5.0
            @test result.result["regions"][3]["value"]["value"] == 3.0
        finally
            empty!(LOAD_PATH)
            append!(LOAD_PATH, before)
        end
    end

    @testset "a missing package in `packages` is flagged" begin
        result, _ = evaluate(Dict("worksheet" => "pk", "packages" => ["NoSuchPackageForSure"], "regions" => []))
        entry = result.result["packages"][1]
        @test entry["error"] !== nothing
        @test entry["missing"] == "NoSuchPackageForSure"
    end

    @testset "invalid environments" begin
        result, _ = evaluate(Dict("worksheet" => "bad", "environment" => joinpath(root, "nowhere"), "regions" => []))
        @test result.result["environment"]["error"] !== nothing
        empty = joinpath(root, "empty")
        mkpath(empty)
        result, _ = evaluate(Dict("worksheet" => "bad2", "environment" => empty, "regions" => []))
        @test occursin("no Project.toml", result.result["environment"]["error"])
        try
            evaluate(Dict("worksheet" => "bad3", "environment" => "", "regions" => []))
            @test false
        catch exception
            @test exception isa EquavelaKernel.KernelFailure && exception.code == -32602
        end
    end

    @testset "install_packages" begin
        function install(params)
            out = IOBuffer()
            context = EquavelaKernel.RequestContext(5, out, 0)
            return EquavelaKernel.default_handler("install_packages", JSON3.read(JSON3.write(params)), context, Vector{UInt8}[])
        end
        function failure(params)
            try
                install(params)
            catch exception
                return exception
            end
        end
        before = copy(LOAD_PATH)
        activated = Base.active_project()
        try
            # Instantiating an environment without packages needs no network.
            fresh = joinpath(root, "fresh")
            mkpath(fresh)
            write(joinpath(fresh, "Project.toml"), "")
            result = install(Dict("environment" => fresh, "packages" => []))
            @test result["environment"] == abspath(fresh)
            @test isfile(joinpath(fresh, "Manifest.toml"))
            @test abspath(fresh) in LOAD_PATH
            # The kernel's own project is still the active one.
            @test Base.active_project() == activated
            # Instantiating the local-path environment works offline too.
            install(Dict("environment" => env))
        finally
            empty!(LOAD_PATH)
            append!(LOAD_PATH, before)
        end
        @test failure(Dict("packages" => [])).code == -32602
        @test failure(Dict("environment" => joinpath(root, "nowhere"))).code == -32602
        @test failure(Dict("environment" => env, "packages" => ["not a name"])).code == -32602
        @test failure(Dict("environment" => env, "packages" => 3)).code == -32602
    end

    @testset "manage_environment" begin
        function manage(params)
            context = EquavelaKernel.RequestContext(7, IOBuffer(), 0)
            return EquavelaKernel.default_handler("manage_environment", JSON3.read(JSON3.write(params)), context, Vector{UInt8}[])
        end
        function failure(params)
            try
                manage(params)
            catch exception
                return exception
            end
        end
        activated = Base.active_project()
        before = copy(LOAD_PATH)
        empty_env = joinpath(root, "managed")
        mkpath(empty_env)
        write(joinpath(empty_env, "Project.toml"), "[deps]\n")
        withenv("JULIA_PKG_OFFLINE" => "true") do
            for operation in ("instantiate", "resolve", "update")
                result = manage(Dict("environment" => empty_env, "operation" => operation))
                @test result["environment"] == abspath(empty_env)
                @test result["packages"] == []
                @test result["log"] isa String
                @test Base.active_project() == activated
                @test LOAD_PATH == before
            end
        end
        @test isfile(joinpath(empty_env, "Manifest.toml"))
        @test failure(Dict("operation" => "resolve")).code == -32602
        @test failure(Dict("environment" => joinpath(root, "nowhere"), "operation" => "resolve")).code == -32602
        @test failure(Dict("environment" => root, "operation" => "resolve")).code == -32602
        @test failure(Dict("environment" => empty_env)).code == -32602
        @test failure(Dict("environment" => empty_env, "operation" => "Pkg.update()")).code == -32602
        @test failure(Dict("environment" => empty_env, "operation" => 1)).code == -32602
        broken = joinpath(root, "broken")
        mkpath(broken)
        write(joinpath(broken, "Project.toml"), "[invalid\n")
        err = failure(Dict("environment" => broken, "operation" => "resolve"))
        @test err.code == -32000
        @test err.data["request_id"] == 7
        @test err.data["details"]["log"] isa String
        @test Base.active_project() == activated
    end

    @testset "set_compatibility" begin
        target = joinpath(root, "compat")
        cp(env, target)
        params(spec; package="Foo", environment=target) = Dict(
            "environment" => environment, "package" => package, "compatibility" => spec)
        function request(p; id=81)
            line = JSON3.write(Dict("jsonrpc" => "2.0", "id" => id,
                "method" => "set_compatibility", "params" => p))
            messages = run_serve(line * "\n")
            # Package work is announced before the response; a refused request announces nothing.
            for message in messages[1:end-1]
                @test message.method == "kernel/activity" && message.params.kind == "packages"
            end
            return last(messages)
        end
        files() = Dict(name => read(joinpath(target, name)) for name in readdir(target))
        active = Base.active_project()
        load_path = copy(LOAD_PATH)
        withenv("JULIA_PKG_OFFLINE" => "true") do
            result = request(params("0.1"))
            @test result.id == 81
            @test result.result.packages == ["Foo"]
            @test occursin("Foo = \"0.1\"", read(joinpath(target, "Project.toml"), String))
            @test result.result.environment == abspath(target)
            @test result.result.log isa AbstractString
            @test Base.active_project() == active && LOAD_PATH == load_path

            before = files()
            for spec in ("not a version", "2")
                error = request(params(spec); id=82)
                @test error.id == 82 && error.error.code == -32000
                @test error.error.data.request_id == 82
                @test files() == before
                @test Base.active_project() == active
            end
            for bad in (params("1"; package="Unknown"), params("1"; package="julia"),
                        params("1"; package="not a name"), params("1"; environment=root),
                        Dict("environment" => target, "package" => "Foo", "compatibility" => 1))
                @test request(bad).error.code == -32602
                @test files() == before
            end
            result = request(params(""))
            @test result.id == 81 && result.result.packages == ["Foo"]
            @test !occursin("Foo = \"0.1\"", read(joinpath(target, "Project.toml"), String))
            @test Base.active_project() == active && LOAD_PATH == load_path

            # Reject metadata symlinks before Pkg can modify an external target.
            if !Sys.iswindows()
                cleared = files()
                linked = joinpath(root, "linked")
                mkpath(linked)
                symlink(joinpath(target, "Project.toml"), joinpath(linked, "Project.toml"))
                @test request(params("0.1"; environment=linked)).error.code == -32602
                @test islink(joinpath(linked, "Project.toml"))
                @test files() == cleared
            end
        end
    end

    @testset "terminal preparation loads sources before worksheets" begin
        file = joinpath(root, "Prepared.jl")
        write(file, "module Prepared\nvalue = Ref(41)\nend\n")
        context = EquavelaKernel.RequestContext(14, IOBuffer(), 0)
        params = JSON3.read(JSON3.write(Dict("modules" => [file], "packages" => [])))
        prepared = EquavelaKernel.default_handler("terminal_prepare", params, context, Vector{UInt8}[])
        @test prepared["modules"][1]["error"] === nothing
        previous_project = Base.active_project()
        previous_load_path = copy(LOAD_PATH)
        previous_worksheet_environment = EquavelaKernel.WORKSHEET_ENVIRONMENT[]
        try
            packages = JSON3.read(JSON3.write(Dict("environment" => env, "packages" => ["Foo"])))
            loaded = EquavelaKernel.default_handler("terminal_prepare", packages, context, Vector{UInt8}[])
            @test loaded["packages"][1]["error"] === nothing
            sheet, _ = evaluate(Dict("worksheet" => "prepared-sheet", "modules" => [file],
                "regions" => [region("r"; value="from_julia(Prepared.value[])")]))
            @test sheet.result["regions"][1]["value"]["value"] == 41.0
            @test Base.invokelatest(getglobal, EquavelaKernel._shared(), :Prepared) ===
                Base.invokelatest(getglobal, EquavelaKernel.WORKSHEETS["prepared-sheet"], :Prepared)
            evaluate(Dict("worksheet" => "prepared-sheet", "environment" => env,
                "packages" => ["Foo"], "regions" => []))
            @test Base.invokelatest(getglobal, EquavelaKernel._shared(), :Foo) ===
                Base.invokelatest(getglobal, EquavelaKernel.WORKSHEETS["prepared-sheet"], :Foo)
        finally
            Base.set_active_project(previous_project)
            empty!(LOAD_PATH)
            append!(LOAD_PATH, previous_load_path)
            EquavelaKernel.WORKSHEET_ENVIRONMENT[] = previous_worksheet_environment
        end
    end

    @testset "worksheets are named modules the REPL reaches; .jl modules load once per kernel" begin
        repl(params) = EquavelaKernel.default_handler("repl", JSON3.read(JSON3.write(params)),
            EquavelaKernel.RequestContext(12, IOBuffer(), 0), Vector{UInt8}[])
        file = joinpath(root, "Shared.jl")
        write(file, "module Shared\ncounter = Ref(0)\nbump() = (counter[] += 1)\nend\n")
        result, _ = evaluate(Dict("worksheet" => "named1", "module_name" => "beam", "modules" => [file],
            "regions" => [region("r1"; code = "x_v1 = 7", value = "from_julia(Shared.bump())")]))
        @test result.result["regions"][1]["value"]["value"] == 1.0
        # A second worksheet shares the same loaded module, not a copy of it.
        result, _ = evaluate(Dict("worksheet" => "named2", "module_name" => "column", "modules" => [file],
            "regions" => [region("r1"; value = "from_julia(Shared.bump())")]))
        @test result.result["regions"][1]["value"]["value"] == 2.0
        # The REPL sees the worksheets by name and the shared module.
        @test repl(Dict("code" => "Project.beam.x_v1"))["value"] == "7"
        @test repl(Dict("code" => "Project.Shared.counter[]"))["value"] == "2"
        @test repl(Dict("code" => "nameof(Project.column)"))["value"] == ":column"
        @test repl(Dict("code" => "parentmodule(Project.Shared) === Project"))["value"] == "true"
        @test repl(Dict("code" => "Project.beam.Shared === Project.column.Shared === Project.Shared"))["value"] == "true"
        @test repl(Dict("code" => "isdefined(@__MODULE__, :beam) || isdefined(@__MODULE__, :Shared)"))["value"] == "false"
        # A worksheet renamed (saved under a name) keeps its module; the old name is cleared.
        evaluate(Dict("worksheet" => "named1", "module_name" => "girder", "regions" => []))
        @test repl(Dict("code" => "Project.girder.x_v1"))["value"] == "7"
        @test repl(Dict("code" => "Project.beam"))["value"] === nothing
        # A discarded worksheet leaves the REPL too; a bad name is refused.
        EquavelaKernel.discard_request(JSON3.read(JSON3.write(Dict("worksheet" => "named2"))))
        @test repl(Dict("code" => "Project.column"))["value"] === nothing
        bad = try evaluate(Dict("worksheet" => "named3", "module_name" => "end", "regions" => [])) catch exception exception end
        @test bad isa EquavelaKernel.KernelFailure && bad.code == -32602
    end

    @testset "project module files load once per worksheet module" begin
        file = joinpath(root, "Tools.jl")
        write(file, "module Tools\nhidden(x) = 2x\nend\n")
        result, _ = evaluate(Dict(
            "worksheet" => "modules1", "modules" => [file],
            "regions" => [region("r1"; code="y = Tools.hidden(3)", value="from_julia(y)")]))
        @test result.result["modules"][1]["error"] === nothing
        @test result.result["regions"][1]["value"]["value"] == 6.0
        # A second pass does not include the file again (the module is not replaced).
        result, _ = evaluate(Dict(
            "worksheet" => "modules1", "modules" => [file],
            "regions" => [region("r2"; code="z = Tools.hidden(4)", value="from_julia(z)")]))
        @test result.result["modules"][1]["error"] === nothing
        @test result.result["regions"][1]["value"]["value"] == 8.0
        missing_file = joinpath(root, "Nowhere.jl")
        result, _ = evaluate(Dict("worksheet" => "modules2", "modules" => [missing_file], "regions" => []))
        @test occursin("not found", result.result["modules"][1]["error"])
    end

    @testset "a captured Julia cell returns its output, duration and trace" begin
        result, _ = evaluate(Dict("worksheet" => "capture1", "regions" => [
            Dict("id" => "c1", "code" => "println(\"one\"); print(stderr, \"two\"); println(\" three\")", "capture" => true),
            Dict("id" => "c2", "code" => "f() = error(\"boom\")\nprintln(\"before\")\nf()", "capture" => true),
            Dict("id" => "c3", "code" => "x = 1"),
        ]))
        first, second, third = result.result["regions"]
        @test first["status"] == "ok"
        @test first["output"] == "one\ntwo three\n"
        @test first["duration"] isa Real && first["duration"] >= 0
        @test second["status"] == "error"
        @test second["output"] == "before\n"
        @test occursin("f()", second["error"]["trace"])
        @test !occursin("_eval_text", second["error"]["trace"])
        @test !haskey(third, "output") && !haskey(third, "duration")
        big, _ = evaluate(Dict("worksheet" => "capture2", "regions" => [
            Dict("id" => "c", "code" => "print(repeat(\"x\", 70_000))", "capture" => true)]))
        @test endswith(big.result["regions"][1]["output"], "(output cut at 64 KiB)")
    end

    @testset "complete returns REPL completions in characters" begin
        complete(params) = EquavelaKernel.default_handler("complete", JSON3.read(JSON3.write(params)),
            EquavelaKernel.RequestContext(9, IOBuffer(), 0), Vector{UInt8}[])
        result = complete(Dict("text" => "x = prin", "position" => 8))
        @test "println" in result["items"]
        @test result["from"] == 4 && result["to"] == 8
        result = complete(Dict("text" => "α = sq", "position" => 6))
        @test "sqrt" in result["items"] && result["from"] == 4
        # The environment's package is completed after `using` and by its module's names.
        result = complete(Dict("text" => "Foo.tri", "position" => 7, "environment" => env, "packages" => ["Foo"]))
        @test "triple" in result["items"]
        # The text is parsed, never run.
        result = complete(Dict("text" => "error(\"boom\"); pri", "position" => 18))
        @test "print" in result["items"]
        failure = try complete(Dict("text" => "x", "position" => 5)) catch exception exception end
        @test failure.code == -32602
    end

    @testset "complete in the repl module" begin
        call(method, params) = EquavelaKernel.default_handler(method, JSON3.read(JSON3.write(params)),
            EquavelaKernel.RequestContext(11, IOBuffer(), 0), Vector{UInt8}[])
        empty = call("complete", Dict("text" => "", "position" => 0, "repl" => true))
        @test "Project" in empty["items"] && empty["from"] == 0 && empty["to"] == 0
        call("repl", Dict("code" => "myreplvariable = 1"))
        # A name defined in the REPL completes only with `repl: true`.
        text = "myrepl"
        inrepl = call("complete", Dict("text" => text, "position" => 6, "repl" => true))
        @test "myreplvariable" in inrepl["items"] && inrepl["from"] == 0 && inrepl["to"] == 6
        @test !("myreplvariable" in call("complete", Dict("text" => text, "position" => 6))["items"])
        project = call("complete", Dict("text" => "Project.", "position" => 8, "repl" => true))
        @test "girder" in project["items"] && "Shared" in project["items"]
        # Module members after a dot, and LaTeX names (the range covers the backslash).
        @test "println" in call("complete", Dict("text" => "Base.printl", "position" => 11, "repl" => true))["items"]
        latex = call("complete", Dict("text" => "x = \\alpha", "position" => 10, "repl" => true))
        @test latex["items"] == ["α"] && latex["from"] == 4
    end

    @testset "repl runs in a module of its own per environment" begin
        repl(params) = EquavelaKernel.default_handler("repl", JSON3.read(JSON3.write(params)),
            EquavelaKernel.RequestContext(10, IOBuffer(), 0), Vector{UInt8}[])
        @test repl(Dict("code" => "k = 20"))["value"] == "20"
        result = repl(Dict("code" => "println(\"hi\")\nk + 1"))
        @test result["output"] == "hi\n" && result["value"] == "21" && result["error"] === nothing
        @test repl(Dict("code" => "function f(x)"))["incomplete"] === true
        failed = repl(Dict("code" => "boom() = error(\"kaput\")\nboom()"))
        @test failed["error"] == "kaput" && occursin("boom()", failed["trace"])
        @test repl(Dict("code" => "nothing"))["value"] === nothing
        # The environment's package is used, and a worksheet module never sees REPL names.
        @test repl(Dict("code" => "Foo.triple(2)", "environment" => env, "packages" => ["Foo"]))["value"] == "6"
        result, _ = evaluate(Dict("worksheet" => "repl-iso", "regions" => [region("r"; value = "isdefined(@__MODULE__, :k)")]))
        @test result.result["regions"][1]["value"]["value"] == false
        @test repl(Dict("code" => "k", "reset" => true))["error"] !== nothing
        # An environment folder that does not exist is an invalid request that names the folder,
        # not an opaque internal error (GitHub ).
        missing_env = joinpath(tempdir(), "equavela-no-such-environment")
        failure = try repl(Dict("code" => "1+1", "environment" => missing_env)) catch exception exception end
        @test failure isa EquavelaKernel.KernelFailure && failure.code == -32602
        @test occursin("does not exist", failure.message)
    end

    @testset "develop_packages" begin
        # the specification : a referenced project's package, by relative path.
        function develop(params)
            out = IOBuffer()
            context = EquavelaKernel.RequestContext(7, out, 0)
            return EquavelaKernel.default_handler("develop_packages", JSON3.read(JSON3.write(params)), context, Vector{UInt8}[])
        end
        function failure(params)
            try
                develop(params)
            catch exception
                return exception
            end
        end
        consumer = joinpath(root, "consumer")
        mkpath(consumer)
        write(joinpath(consumer, "Project.toml"), "")
        activated = Base.active_project()
        withenv("JULIA_PKG_OFFLINE" => "true") do
            result = develop(Dict("environment" => consumer, "paths" => ["../Foo"]))
            @test result["packages"] == ["../Foo"]
            @test occursin("Foo", read(joinpath(consumer, "Project.toml"), String))
            manifest = read(joinpath(consumer, "Manifest.toml"), String)
            @test occursin("path = \"../Foo\"", manifest)
            @test Base.active_project() == activated
        end
        @test failure(Dict("environment" => consumer, "paths" => [])).code == -32602
        @test failure(Dict("environment" => consumer, "paths" => [joinpath(root, "Foo")])).code == -32602
        @test failure(Dict("environment" => consumer, "paths" => ["../nowhere"])).code == -32602
        @test failure(Dict("environment" => joinpath(root, "nowhere"), "paths" => ["../Foo"])).code == -32602
    end

    @testset "remove_packages" begin
        function remove(params)
            out = IOBuffer()
            context = EquavelaKernel.RequestContext(6, out, 0)
            return EquavelaKernel.default_handler("remove_packages", JSON3.read(JSON3.write(params)), context, Vector{UInt8}[])
        end
        function failure(params)
            try
                remove(params)
            catch exception
                return exception
            end
        end
        before = copy(LOAD_PATH)
        activated = Base.active_project()
        copy_env = joinpath(root, "removable")
        # The Manifest's `path = "../Foo"` still points at the package from the copy.
        cp(env, copy_env)
        try
            result = remove(Dict("environment" => copy_env, "packages" => ["Foo"]))
            @test result["packages"] == ["Foo"]
            @test !occursin("Foo", read(joinpath(copy_env, "Project.toml"), String))
            @test Base.active_project() == activated
        finally
            EquavelaKernel.WORKSHEET_ENVIRONMENT[] = nothing
            empty!(LOAD_PATH)
            append!(LOAD_PATH, before)
        end
        @test failure(Dict("environment" => copy_env, "packages" => [])).code == -32602
        @test failure(Dict("environment" => joinpath(root, "nowhere"), "packages" => ["Foo"])).code == -32602
        @test failure(Dict("environment" => copy_env, "packages" => ["not a name"])).code == -32602
        @test failure(Dict("environment" => copy_env, "packages" => ["Foo"])).code == -32000
    end
end

@testset "terminal source failures leave the terminal available" begin
    mktempdir() do folder
        withenv("EQUAVELA_RPC_ADDRESS" => "test") do
            result, output = EquavelaKernel._captured() do
                EquavelaKernel.terminal_prepare_request(Dict(:modules => [joinpath(folder, "missing.jl")]), nothing)
            end
            @test result["modules"][1]["error"] !== nothing
            @test occursin("Could not load", output)
            @test occursin("missing.jl", output)
        end
    end
end
