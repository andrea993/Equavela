// Puts the staged runtime into the Linux bundles with its symbolic links intact.
//
// `tauri build` copies every resource entry with `fs::copy`, which dereferences symbolic links:
// the staged runtime names `libLLVM.so`, `libLLVM-20jl.so` and `libLLVM.so.20.1jl` as one file and
// two links, and the first deb carried three copies of 119 MiB (140 links, 825 MiB of duplicated
// content; `Installed-Size` 1.71 GiB for a 916 MiB runtime). Neither dpkg nor the squashfs of the
// AppImage needs the copies (it stores identical files once), but the tree each of them installs
// must not carry them either, so both bundles are assembled again with the staged tree:
//
// - deb: unpacked with `dpkg-deb -R`, the runtime subtree replaced, `Installed-Size` and `md5sums`
//   recomputed, built again with `dpkg-deb --root-owner-group -b`. Everything else (the binary,
//   the desktop entry, the MIME file, the icons, the control fields) is the one of the Tauri
//   bundle, as the specification requires.
// - AppImage: Tauri leaves the AppDir next to the image (`<bundle>/appimage/<product>.AppDir`); the
//   runtime subtree is replaced there and the image is squashed again with the plugin Tauri used
//   (`linuxdeploy-plugin-appimage` in Tauri's cache directory, which takes the output path from
//   `LDAI_OUTPUT`). The AppDir keeps the duplicates linuxdeploy deployed into `usr/lib`
//   (`libLLVM.so.20.1jl`, `libjulia.so.1.13`, `libjulia-internal.so.1.13`): the sysimage's RUNPATH
//   does not point into the Julia tree of the AppDir, so those copies are what makes the image run.
//
// dpkg-deb ships with Debian and Ubuntu only. On another host the same command runs in an
// ubuntu container with the repository mounted at the same path; every path this module hands to
// dpkg-deb is inside the repository (the bundle directory and the staging directory are).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTree } from "./package-files.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/// The directories of the runtime that `scripts/package-runtime.mjs` stages and that the
/// installer ships under `<root>`.
export const RUNTIME_DIRECTORIES = ["julia", "python", "sysimage", "kernel", "depot"];

/// The control directory of an unpacked package.
const CONTROL = "DEBIAN";

const has = (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;

/// The `dpkg-deb` command line, run in a container on a host that has no dpkg-deb (see the header).
function dpkgDeb(argumentsForDpkg) {
  if (has("dpkg-deb")) return ["dpkg-deb", argumentsForDpkg];
  if (has("docker")) {
    // Only the repository is mounted, so that a container never writes outside the tree this
    // script works in (a CARGO_TARGET_DIR elsewhere is therefore refused, not silently misplaced).
    const outside = argumentsForDpkg.filter((argument) => argument.startsWith("/") && !argument.startsWith(`${repo}/`));
    if (outside.length > 0) {
      throw new Error(`dpkg-deb in a container reaches ${repo} only, not ${outside.join(", ")} (is CARGO_TARGET_DIR outside the repository?)`);
    }
    return [
      "docker",
      [
        "run", "--rm",
        "--user", `${process.getuid()}:${process.getgid()}`,
        "-v", `${repo}:${repo}`,
        "-w", repo,
        "ubuntu:24.04",
        "dpkg-deb",
        ...argumentsForDpkg,
      ],
    ];
  }
  throw new Error(
    "dpkg-deb is required to rebuild the deb with the runtime's symlinks: install dpkg " +
      "(Debian, Ubuntu) or docker, or build the packages on Ubuntu as CI does",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

/// Every entry of a tree, without following symbolic links.
function walk(root, visit, rel = "") {
  for (const name of readdirSync(rel ? join(root, rel) : root)) {
    const path = rel ? `${rel}/${name}` : name;
    const stat = lstatSync(join(root, path));
    visit(path, stat);
    if (stat.isDirectory()) walk(root, visit, path);
  }
}

/// The directory of a bundle tree that holds the bundled runtime (`usr/lib/Equavela` in both the
/// deb and the AppImage): the one whose `julia/bin/julia` exists.
export function findRuntimeRoot(dataRoot) {
  const libraryDir = join(dataRoot, "usr", "lib");
  if (!existsSync(libraryDir)) throw new Error(`no usr/lib in the bundle tree: ${dataRoot}`);
  const roots = readdirSync(libraryDir)
    .map((name) => `usr/lib/${name}`)
    .filter((path) => existsSync(join(dataRoot, path, "julia", "bin", "julia")));
  if (roots.length !== 1) {
    throw new Error(
      `expected one directory with the bundled runtime under ${libraryDir}, found ${roots.length}: ${roots.join(", ")}`,
    );
  }
  return join(dataRoot, roots[0]);
}

/// Replaces the runtime directories of a bundle tree with the staged ones, symlinks included
/// (`copyTree` copies links verbatim; see `scripts/package-files.mjs`).
export function replaceRuntimeTree(runtimeRoot, stagedRuntime) {
  mkdirSync(runtimeRoot, { recursive: true });
  for (const name of RUNTIME_DIRECTORIES) {
    const source = join(stagedRuntime, name);
    if (!existsSync(source)) {
      throw new Error(`the staged runtime has no ${name} directory: ${stagedRuntime}`);
    }
    copyTree(source, join(runtimeRoot, name), () => false, runtimeRoot);
  }
}

/// `Installed-Size` in KiB, computed as dpkg computes it (`du -k` of the data tree without the
/// control directory).
export function installedSize(dataRoot) {
  let bytes = 0;
  walk(dataRoot, (path, stat) => {
    if (path.split("/")[0] !== CONTROL) bytes += stat.blocks * 512;
  });
  return Math.ceil(bytes / 1024);
}

/// `md5sums` of a data tree, in the format dpkg writes: `<md5> <path>`, one per regular file,
/// symbolic links and the control directory excluded.
export function md5Sums(dataRoot) {
  const files = [];
  walk(dataRoot, (path, stat) => {
    if (stat.isFile() && path.split("/")[0] !== CONTROL) files.push(path);
  });
  return `${files
    .sort()
    .map((path) => `${createHash("md5").update(readFileSync(join(dataRoot, path))).digest("hex")}  ${path}`)
    .join("\n")}\n`;
}

/// The runtime tree of a bundle, as a reviewer sees it: files, symbolic links and their bytes.
export function describeRuntime(runtimeRoot) {
  let files = 0;
  let links = 0;
  let bytes = 0;
  walk(runtimeRoot, (path, stat) => {
    if (stat.isSymbolicLink()) links += 1;
    else if (stat.isFile()) files += 1;
    else return;
    bytes += stat.blocks * 512;
  });
  return { files, links, bytes };
}

/// The CPU targets of the portable sysimage on x86_64 (`PackageCompiler.default_app_cpu_target()`,
/// `scripts/build-sysimage.jl --portable`). The shipped pkgimages carry the same targets, or a
/// machine whose CPU differs from the build host rejects them.
export const PORTABLE_CPU_TARGET = "generic;sandybridge,-xsaveopt,clone_all;haswell,-rdrnd,base(1)";

/// The container command that precompiles EquavelaKernel and its closure into `<root>/depot`
/// with the runtime tree mounted at the directory the package installs it to:
/// Julia records absolute source paths, so pkgimages built anywhere else are rejected.
export function precompileCommand({ runtimeRoot, installRoot, uid = process.getuid(), gid = process.getgid() }) {
  const julia = `${installRoot}/julia/bin/julia`;
  return [
    "docker",
    [
      "run", "--rm", "--network", "none",
      "--user", `${uid}:${gid}`,
      "-v", `${resolve(runtimeRoot)}:${installRoot}`,
      "-e", "HOME=/tmp",
      "-e", `JULIA_DEPOT_PATH=${installRoot}/depot`,
      "-e", `JULIA_CPU_TARGET=${PORTABLE_CPU_TARGET}`,
      "-e", `JULIA_PYTHONCALL_EXE=${installRoot}/python/bin/python`,
      "-e", "JULIA_CONDAPKG_BACKEND=Null",
      "ubuntu:24.04",
      julia,
      "--startup-file=no",
      `--sysimage=${installRoot}/sysimage/equavelakernel.so`,
      `--project=${installRoot}/kernel/EquavelaKernel`,
      "-e", "using EquavelaKernel",
    ],
  ];
}

/// Builds the pkgimages of the deb. Only `compiled` is added to the depot: anything else
/// the build writes there (logs, scratch spaces) is removed.
export function precompileAtInstallPath({ runtimeRoot, installRoot, runCommand = run, log = () => {} }) {
  if (runCommand === run && !has("docker")) {
    throw new Error("docker is required to build the deb's pkgimages at its install path");
  }
  const depot = join(runtimeRoot, "depot");
  const shipped = new Set(readdirSync(depot));
  rmSync(join(depot, "compiled"), { recursive: true, force: true });
  runCommand(...precompileCommand({ runtimeRoot, installRoot }));
  for (const name of readdirSync(depot)) {
    if (name !== "compiled" && !shipped.has(name)) rmSync(join(depot, name), { recursive: true, force: true });
  }
  if (!existsSync(join(depot, "compiled"))) throw new Error(`the precompile step wrote no pkgimages into ${depot}`);
  const { files, bytes } = describeRuntime(join(depot, "compiled"));
  log(`pkgimages ${files} files (${megabytes(bytes)}) built at ${installRoot}`);
}

const megabytes = (bytes) => `${Math.round(bytes / 2 ** 20)} MiB`;

/// Rewrites the `Installed-Size` field of a control file.
export function setInstalledSize(control, kib) {
  const field = /^Installed-Size:.*$/m;
  if (!field.test(control)) throw new Error("the control file has no Installed-Size field");
  return control.replace(field, `Installed-Size: ${kib}`);
}

/// Unpacks the deb, replaces the runtime tree with the staged one, updates `Installed-Size` and
/// `md5sums`, builds the kernel's pkgimages at the install path,
/// and builds the package again in place. Returns the before and after measurements.
export function repackageDeb({ deb, stagedRuntime, precompile = true, log = () => {} }) {
  const work = join(dirname(deb), "repackage");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    run(...dpkgDeb(["-R", deb, work]));
    const runtimeRoot = findRuntimeRoot(work);
    const before = describeRuntime(runtimeRoot);
    replaceRuntimeTree(runtimeRoot, stagedRuntime);
    const after = describeRuntime(runtimeRoot);
    log(`runtime  ${before.files} files + ${before.links} links (${megabytes(before.bytes)}) -> ${after.files} files + ${after.links} links (${megabytes(after.bytes)})`);
    if (precompile) {
      precompileAtInstallPath({ runtimeRoot, installRoot: `/${relative(work, runtimeRoot).split(sep).join("/")}`, log });
    }
    const control = join(work, CONTROL, "control");
    writeFileSync(control, setInstalledSize(readFileSync(control, "utf8"), installedSize(work)));
    const sums = join(work, CONTROL, "md5sums");
    if (existsSync(sums)) writeFileSync(sums, md5Sums(work));
    // `dpkg-deb -b` refuses to overwrite its own output, and a failure must not leave a
    // half-written package behind: build next to it and move it into place.
    const built = `${deb}.rebuild`;
    run(...dpkgDeb(["--root-owner-group", "-b", work, built]));
    renameSync(built, deb);
    return { before, after };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/// The AppImage plugin of Tauri's cache directory (where Tauri downloads `linuxdeploy`'s
/// `appimage` plugin before it bundles the AppImage).
export function appImagePlugin() {
  const cache = process.env.XDG_CACHE_HOME || (process.env.HOME ? join(process.env.HOME, ".cache") : null);
  return cache ? join(cache, "tauri", "linuxdeploy-plugin-appimage.AppImage") : null;
}

/// Corrects the runtime tree of the AppDir Tauri left next to the AppImage and squashes the image
/// again, so that the AppImage carries the symlinks too. `product` selects this build's AppDir and
/// image when the directory still holds those of an earlier product name. Returns the measurements and whether the
/// image was rebuilt.
export function repackageAppImage({ appImageDir, stagedRuntime, product = "", plugin = appImagePlugin(), log = () => {} }) {
  if (!existsSync(appImageDir)) {
    throw new Error(`no AppImage bundle directory: ${appImageDir} (Tauri bundles it next to the deb)`);
  }
  const appDirs = readdirSync(appImageDir).filter((name) => name.startsWith(product) && name.endsWith(".AppDir"));
  if (appDirs.length !== 1) {
    throw new Error(`expected one AppDir in ${appImageDir}, found ${appDirs.length}: ${appDirs.join(", ")}`);
  }
  const images = readdirSync(appImageDir).filter((name) => name.startsWith(product) && name.endsWith(".AppImage"));
  if (images.length !== 1) {
    throw new Error(`expected one AppImage in ${appImageDir}, found ${images.length}: ${images.join(", ")}`);
  }
  const appDir = join(appImageDir, appDirs[0]);
  const runtimeRoot = findRuntimeRoot(appDir);
  const before = describeRuntime(runtimeRoot);
  replaceRuntimeTree(runtimeRoot, stagedRuntime);
  const after = describeRuntime(runtimeRoot);
  log(`runtime  ${before.files} files + ${before.links} links (${megabytes(before.bytes)}) -> ${after.files} files + ${after.links} links (${megabytes(after.bytes)})`);
  if (!plugin || !existsSync(plugin)) {
    throw new Error(
      `Tauri's AppImage plugin is missing (${plugin}), so the corrected AppDir cannot be squashed ` +
        "again; run the AppImage bundle once with a network connection (Tauri downloads the plugin) " +
        "or build only the deb with --bundles deb",
    );
  }
  // The image is written next to the bundle and moved into place, so a failing plugin leaves the
  // AppImage Tauri built untouched.
  const image = join(appImageDir, images[0]);
  const rebuilt = `${image}.rebuild`;
  run(plugin, ["--appdir", appDir], {
    cwd: appImageDir,
    env: { ...process.env, LDAI_OUTPUT: rebuilt, APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  renameSync(rebuilt, image);
  return { before, after };
}
