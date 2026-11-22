#!/usr/bin/env node
// Stages the runtime that the installer ships: a trimmed Julia, the trimmed Python
// environment of the symbolic engine, the kernel sources and the sysimage, all under
// build/package/ (git-ignored). Platform neutral: the same script runs on Windows and Linux.
//
//   node scripts/package-runtime.mjs [--julia-home DIR] [--python-env DIR] [--sysimage FILE] [--out DIR]
//
// --julia-home Julia installation to copy (default: the one `julia` on PATH reports, same version
//               as the sysimage was built with; the staged runtime is tested with that sysimage)
// --python-env a resolved CondaPkg environment (default: the per-user one, see kernel_path.rs)
// --sysimage the portable sysimage built by `julia scripts/build-sysimage.jl --portable`
//               (default: <out>/sysimage/equavelakernel.<ext>)
// --out staging directory (default: build/package)
// --keep-stock-sysimage also ship Julia's own system image (lib/julia/sys.*, ~300 MB), the fallback of a
//               sysimage that Julia rejects; without it (default) the installed runtime has no fallback
//
// Layout produced (the installer copies each directory as is; `kernel_path.rs` finds them):
//   <out>/julia/... trimmed Julia runtime
//   <out>/python/... trimmed Python + SymPy environment
//   <out>/sysimage/equavelakernel.<dll|so>
//   <out>/depot/artifacts/... the two JLL artifacts (pixi, micromamba) that CondaPkg's JLLs look up
//                              when the kernel starts; their binaries are emptied
//   <out>/kernel/EquavelaKernel, <out>/kernel/EqRuntime sources and manifests, without tests

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { copyTree, makeWritable } from "./package-files.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? resolve(args[at + 1]) : fallback;
};

const out = option("--out", join(repo, "build", "package"));
const keepStockSysimage = args.includes("--keep-stock-sysimage");
const dlext = windows ? "dll" : process.platform === "darwin" ? "dylib" : "so";
const sysimage = option("--sysimage", join(out, "sysimage", `equavelakernel.${dlext}`));
const juliaHome = option(
  "--julia-home",
  resolve(execFileSync("julia", ["--startup-file=no", "-e", "print(dirname(Sys.BINDIR))"], { encoding: "utf8" })),
);
const dataDir = windows
  ? process.env.LOCALAPPDATA
  : process.env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
const pythonEnv = option("--python-env", join(dataDir, "equavela", "py"));

function megabytes(dir) {
  let total = 0;
  const walk = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) readdirSync(path).forEach((name) => walk(join(path, name)));
    else total += stat.size;
  };
  walk(dir);
  return Math.round(total / 2 ** 20);
}

if (!existsSync(sysimage)) throw new Error(`sysimage not found: ${sysimage} (run scripts/build-sysimage.jl --portable)`);
const pythonExe = join(pythonEnv, windows ? "python.exe" : "bin/python");
if (!existsSync(pythonExe)) {
  throw new Error(`Python environment not found: ${pythonEnv} (start the app once, or pass --python-env)`);
}
try {
  execFileSync(pythonExe, ["-I", "-c", "import sympy, xlrd, xlwt, xlutils"], { stdio: "pipe" });
} catch {
  throw new Error(`Python environment is missing required packages: ${pythonEnv} (resolve the kernel environment before packaging)`);
}
mkdirSync(out, { recursive: true });

// ---- Julia: runtime only (no headers, static libraries, docs, tests, stdlib test suites) ----
const juliaSkip = (rel) =>
  rel === "include" ||
  rel.startsWith("include/") ||
  // Static libraries are not needed, except libgcc.a: the first start links the pkgimages of the kernel
  // with the shipped lld, which asks for -lgcc.
  (rel.endsWith(".a") && rel !== "lib/julia/libgcc.a") ||
  rel === "share/man" ||
  rel === "share/doc" ||
  rel.startsWith("share/julia/test") ||
  rel.startsWith("share/julia/juliac") ||
  rel.startsWith("share/julia/compiled") || // stdlib pkgimages: rebuilt on demand, the sysimage has what the kernel uses
  (!keepStockSysimage && /^lib\/julia\/sys\.(dll|so|dylib)$/.test(rel)) || // stock system image,
  /^libexec\/julia\/dsymutil(\.exe)?$/.test(rel) || // macOS debug-symbol tool, never used at run time
  /^share\/julia\/stdlib\/v[\d.]+\/[^/]+\/(test|docs|deps)(\/|$)/.test(rel);
copyTree(juliaHome, join(out, "julia"), juliaSkip, out);
makeWritable(join(out, "julia"));

// ---- Python: interpreter, standard library and SymPy; no pip, tests, GUI or BLAS ----
// Linux layout: bin/python, lib/python3.12/..., lib/lib*.so
const pythonSkipPosix = (rel) => {
  if (rel === "lib/terminfo" || /^[^/]+-conda-linux-gnu\/bin\/ld$/.test(rel)) return true; // targets are trimmed below
  if (["include", "share", "conda-meta", "pkgs", "etc", "man", "compiler_compat", "ssl"].includes(rel.split("/")[0])) return true;
  if (/^lib\/python[\d.]+\/(test|idlelib|tkinter|turtledemo|lib2to3|ensurepip|venv|distutils|config-[^/]*)(\/|$)/.test(rel)) return true;
  if (/^lib\/python[\d.]+\/site-packages\/(pip|setuptools|wheel|packaging|_distutils_hack|pkg_resources)([-/.]|$)/.test(rel)) return true;
  if (/^lib\/python[\d.]+\/site-packages\/[^/]+\.pth$/.test(rel)) return true;
  if (/^lib\/python[\d.]+\/site-packages\//.test(rel) && /\/tests?(\/|$)/.test(rel)) return true;
  if (/^lib\/(libopenblas|libblas|liblapack|libcblas|libmkl|libgfortran|libquadmath|libtcl|libtk|tcl|tk)/.test(rel)) return true;
  if (/^lib\/(pkgconfig|cmake)(\/|$)/.test(rel) || rel.endsWith(".a")) return true;
  if (/^bin\/(?!python)/.test(rel)) return true; // keep only the interpreter (python, python3, python3.12)
  return false;
};
const pythonSkipWindows = (rel) => {
  const top = rel.split("/")[0];
  if (["include", "libs", "Scripts", "Tools", "conda-meta", "share", "pkgs", "etc", "man", "Menu", "tcl"].includes(top)) return true;
  if (rel.endsWith(".pdb") || /^Lib\/site-packages\/[^/]+\.pth$/.test(rel)) return true;
  if (/^Lib\/(test|idlelib|tkinter|turtledemo|lib2to3|ensurepip|venv|distutils)(\/|$)/.test(rel)) return true;
  if (/^Lib\/site-packages\/(pip|setuptools|wheel|packaging|_distutils_hack|pkg_resources)([-/.]|$)/.test(rel)) return true;
  if (/\/tests?(\/|$)/.test(rel) && rel.startsWith("Lib/site-packages/")) return true;
  if (/^Library\/(include|lib|share|ssl|bin\/(mkl|libblas|liblapack|libopenblas|libcblas|libgfortran|libgcc|libquadmath|libomp|libiomp|libcharset))/.test(rel)) return true;
  if (/^DLLs\/(_tkinter|tcl|tk)/.test(rel)) return true;
  if (/^Library\/bin\/(openblas|tcl\d|tk\d|openssl\.exe)/.test(rel)) return true; // BLAS (no NumPy is shipped), Tcl/Tk, the OpenSSL tool
  return false;
};
copyTree(pythonEnv, join(out, "python"), windows ? pythonSkipWindows : pythonSkipPosix, out);

// ---- Kernel sources: EquavelaKernel and EqRuntime without tests or local environments ----
const kernelSkip = (rel) => /(^|\/)(test|\.CondaPkg|build)(\/|$)/.test(rel);
for (const name of ["EquavelaKernel", "EqRuntime"]) {
  copyTree(join(repo, "kernel", name), join(out, "kernel", name), kernelSkip, out);
}

// ---- Depot packages: the sysimage holds the numeric runtime only, so the exact
// sources of every registered package in the kernel's Manifest are shipped in <out>/depot/packages,
// at the paths Julia looks them up (`packages/<Name>/<slug>`). The installed kernel precompiles
// EquavelaKernel, PythonCall and the rest of the closure into the per-user depot at its first start,
// so no compile-time constant ever holds a path of this machine.
{
  const listing = execFileSync(
    "julia",
    [
      "--startup-file=no",
      `--project=${join(out, "kernel", "EquavelaKernel")}`,
      "-e",
      "using Pkg; for (_, p) in Pkg.dependencies(); p.is_tracking_registry && p.source !== nothing && !startswith(p.source, Sys.STDLIB) && println(p.source); end",
    ],
    { encoding: "utf8" },
  );
  const target = join(out, "depot", "packages");
  makeWritable(join(out, "depot"));
  rmSync(target, { recursive: true, force: true });
  let count = 0;
  for (const source of listing.split(/\r?\n/).filter(Boolean)) {
    const parts = source.split(/[\\/]/);
    const [name, slug] = parts.slice(-2);
    copyTree(source, join(target, name, slug), (rel) => /(^|\/)(test|docs|\.git|\.github)(\/|$)/.test(rel), out);
    count += 1;
  }
  makeWritable(target);
  console.log(`depot   ${count} package sources`);
}

// ---- Depot artifacts: CondaPkg's JLLs (pixi_jll, micromamba_jll) resolve their artifact directory when
// the kernel loads, and download it when it is missing. We never run those programs (the Python
// environment is shipped, backend Null), so a directory with emptied files satisfies the lookup offline.
// The directories are learned from a real kernel start in a throw-away depot (needs the network once).
{
  const scratch = mkdtempSync(join(os.tmpdir(), "equavela-depot-"));
  const pythonExe = join(out, "python", windows ? "python.exe" : "bin/python");
  execFileSync(
    join(out, "julia", "bin", windows ? "julia.exe" : "julia"),
    ["--startup-file=no", `--sysimage=${sysimage}`, `--project=${join(out, "kernel", "EquavelaKernel")}`, "-e", "using EquavelaKernel"],
    {
      stdio: "inherit",
      // The shipped package sources come second, read-only, exactly as on the user's machine.
      env: {
        ...process.env,
        JULIA_DEPOT_PATH: [scratch, join(out, "depot")].join(windows ? ";" : ":"),
        JULIA_PYTHONCALL_EXE: pythonExe,
        JULIA_CONDAPKG_BACKEND: "Null",
      },
    },
  );
  const target = join(out, "depot", "artifacts");
  makeWritable(join(out, "depot"));
  mkdirSync(dirname(target), { recursive: true });
  copyTree(join(scratch, "artifacts"), target, () => false, out);
  makeWritable(target);
  const empty = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) readdirSync(path).forEach((name) => empty(join(path, name)));
    else if (stat.size > 2 ** 20) truncateSync(path, 0);
  };
  empty(target);
  makeWritable(scratch);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`julia   ${megabytes(join(out, "julia"))} MB (from ${juliaHome})`);
console.log(`python  ${megabytes(join(out, "python"))} MB (from ${pythonEnv})`);
console.log(`kernel  ${megabytes(join(out, "kernel"))} MB`);
console.log(`depot   ${megabytes(join(out, "depot"))} MB (package sources and artifact stubs)`);
console.log(`sysimage ${Math.round(statSync(sysimage).size / 2 ** 20)} MB`);
