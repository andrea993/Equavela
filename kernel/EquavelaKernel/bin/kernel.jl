# Entry point. Launch with `julia --startup-file=no --project=kernel/EquavelaKernel`.
include(joinpath(@__DIR__, "julia_version.jl"))
let message = julia_version_error()
    if message !== nothing
        println(stderr, "ERROR: ", message)
        exit(1)
    end
end

using EquavelaKernel
using EqRuntime

let address = get(ENV, "EQUAVELA_RPC_ADDRESS", "")
    if isempty(address)
        protocol_out = stdout
        redirect_stdout(stderr)
        Base.exit_on_sigint(false)
        EquavelaKernel.serve(stdin, protocol_out)
    else
        Base.exit_on_sigint(false)
        Base.include(EquavelaKernel, joinpath(@__DIR__, "terminal.jl"))
        Base.invokelatest(() -> EquavelaKernel.run_terminal_kernel(address, get(ENV, "EQUAVELA_RPC_TOKEN", "")))
        exit(0)
    end
end
