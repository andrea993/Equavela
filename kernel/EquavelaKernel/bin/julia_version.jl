# The oldest Julia the kernel runs on. Plain Base code: it runs before any package is loaded, so an
# older Julia gets this message instead of a package load error.

const MINIMUM_JULIA = (1, 13)

"""
    julia_version_error(version = VERSION)

The message for a Julia older than the supported one, or `nothing` when `version` is supported.
Pre-releases of a supported minor version count as that version.
"""
function julia_version_error(version::VersionNumber = VERSION)
    (Int(version.major), Int(version.minor)) >= MINIMUM_JULIA && return nothing
    required = join(MINIMUM_JULIA, ".")
    return "Equavela needs Julia $required or later; this is Julia $version. " *
           "Update it with `juliaup update`, or install Julia $required from https://julialang.org/downloads/."
end
