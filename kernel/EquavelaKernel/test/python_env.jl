@testset "Python environment offline readiness" begin
    mktempdir() do dir
        configure = EquavelaKernel._configure_python_env!
        ready = EquavelaKernel._python_env_is_resolved
        withenv("JULIA_CONDAPKG_ENV" => dir, "JULIA_CONDAPKG_OFFLINE" => nothing) do
            configure()
            @test !haskey(ENV, "JULIA_CONDAPKG_OFFLINE")
            mkpath(joinpath(dir, "bin"))
            touch(joinpath(dir, "bin", "python"))
            site = joinpath(dir, "lib", "python3.12", "site-packages")
            mkpath(joinpath(site, "xlrd"))
            mkpath(joinpath(site, "xlwt"))
            configure()
            @test !haskey(ENV, "JULIA_CONDAPKG_OFFLINE")
            mkpath(joinpath(site, "xlutils"))
            configure()
            @test ENV["JULIA_CONDAPKG_OFFLINE"] == "yes"
            ENV["JULIA_CONDAPKG_OFFLINE"] = "no"
            configure()
            @test ENV["JULIA_CONDAPKG_OFFLINE"] == "no"
            rm(joinpath(dir, "lib"); recursive=true)
            site = joinpath(dir, "Lib", "site-packages")
            foreach(name -> mkpath(joinpath(site, name)), ("xlrd", "xlwt", "xlutils"))
            @test ready(dir)
            rm(joinpath(dir, "bin"); recursive=true)
            @test !ready(dir)
            ENV["JULIA_CONDAPKG_OFFLINE"] = "yes"
            configure()
            @test ENV["JULIA_CONDAPKG_OFFLINE"] == "yes"
        end
    end
end

# The REPL kernel activates the worksheet environment before SymPy loads, so the active project is not
# where CondaPkg locks: CondaPkg uses the first environment of the load path that depends on it (the
# kernel's own). A stale lock there kept every symbolic evaluation waiting.
@testset "Stale CondaPkg lock outside the active project" begin
    mktempdir() do dir
        kernel_env = joinpath(dir, "kernel")
        mkpath(joinpath(kernel_env, ".CondaPkg"))
        write(joinpath(kernel_env, "Project.toml"), "")
        lockfile = joinpath(kernel_env, ".CondaPkg", "lock")
        pid = open(process -> read(process, String), `$(Base.julia_cmd()) --startup-file=no -e "print(getpid())"`)
        write(lockfile, "$pid $(gethostname())")
        push!(LOAD_PATH, kernel_env)
        try
            withenv("JULIA_CONDAPKG_ENV" => joinpath(dir, "py"), "JULIA_CONDAPKG_OFFLINE" => "no") do
                @test Base.active_project() === nothing || dirname(Base.active_project()) != kernel_env
                EquavelaKernel._configure_python_env!()
            end
            @test !isfile(lockfile)
        finally
            filter!(!=(kernel_env), LOAD_PATH)
        end
    end
end
