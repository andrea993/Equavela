#!/usr/bin/env julia
# Builds the EquavelaKernel sysimage. Platform neutral: the same script
# runs on Windows and Linux and writes build/sysimage/equavelakernel.<dll|so|dylib>.
#
#   julia scripts/build-sysimage.jl [--output PATH] [--portable]
#
# --output target file (default: build/sysimage/equavelakernel.<ext> in the repository)
# --portable compile for a generic x86-64 CPU target set (release builds); without it the
#             image is tuned for this machine and may be rejected on others
#
# PackageCompiler is a build-time tool: it lives in the separate environment
# scripts/sysimage and is never a dependency of EqRuntime or EquavelaKernel. The image
# contains EqRuntime, JSON3 and their dependencies (Unitful, LinearAlgebra, Distributions),
# precompiled with scripts/sysimage/precompile_workload.jl; EquavelaKernel is not in it
#. A sysimage is only valid for the Julia version and the kernel sources it was
# built from: rebuild after changing either
# (the kernel manager ignores an image that is older than the kernel sources, and falls
# back to the stock runtime if Julia rejects it).

using Libdl
using Pkg

const REPO = normpath(joinpath(@__DIR__, ".."))
const KERNEL = joinpath(REPO, "kernel", "EquavelaKernel")
const BUILD_ENV = joinpath(@__DIR__, "sysimage")

function parse_arguments(arguments)
    output = joinpath(REPO, "build", "sysimage", "equavelakernel." * Libdl.dlext)
    portable = false
    i = 1
    while i <= length(arguments)
        argument = arguments[i]
        if argument == "--output" && i < length(arguments)
            output = abspath(arguments[i+1])
            i += 2
        elseif argument == "--portable"
            portable = true
            i += 1
        else
            error("unknown argument `$argument` (see the header of scripts/build-sysimage.jl)")
        end
    end
    return output, portable
end

function main(arguments)
    output, portable = parse_arguments(arguments)
    mkpath(dirname(output))

    # The kernel project must be installed before PackageCompiler can bundle its packages.
    Pkg.activate(KERNEL)
    Pkg.instantiate()
    Pkg.activate(BUILD_ENV)
    Pkg.instantiate()
    @eval using PackageCompiler

    Base.invokelatest(build, output, portable)
end

function build(output, portable)
    started = time()
    kwargs = (;)
    portable && (kwargs = (; cpu_target=PackageCompiler.default_app_cpu_target()))
    # the image holds the numeric runtime only — EqRuntime and JSON3 with
    # their dependencies — and never EquavelaKernel or PythonCall, whose compile-time constants
    # would bake this machine's depot paths into the image. Those load from the package sources
    # shipped in `<root>/depot` and are precompiled into the per-user depot at the first start.
    PackageCompiler.create_sysimage(["EqRuntime", "JSON3"];
        sysimage_path=output,
        project=KERNEL,
        precompile_execution_file=joinpath(BUILD_ENV, "precompile_workload.jl"),
        kwargs...)
    seconds = round(time() - started; digits=1)
    megabytes = round(filesize(output) / 2^20; digits=1)
    println("sysimage: ", output, " (", megabytes, " MB, built in ", seconds, " s, Julia ",
        VERSION, portable ? ", portable" : "", ")")
end

main(ARGS)
