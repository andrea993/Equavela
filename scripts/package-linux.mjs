#!/usr/bin/env node
// Builds the Linux packages (deb and AppImage) with the staged runtime.
//
//   node scripts/package-linux.mjs [--out DIR] [--bundles deb,appimage] [extra arguments for `tauri build`]
//
// Stage the runtime first;
// this script does not stage it.
//
// Why a wrapper: for the AppImage, Tauri runs linuxdeploy over the AppDir, and linuxdeploy
// resolves the dependencies of every ELF file it finds there, but only along
// LD_LIBRARY_PATH and the host's library paths. The portable sysimage
// (`<out>/sysimage/equavelakernel.so`) needs `libjulia-internal.so.1.13` and `libjulia.so.1.13`
// (RUNPATH `$ORIGIN:$ORIGIN/julia`), which exist only inside the staged runtime, so the
// bundle stopped with "Could not find dependency: libjulia-internal.so.1.13". Putting the
// staged Julia library directory on LD_LIBRARY_PATH fixes it; linuxdeploy then deploys
// exactly the libraries the shipped runtime uses. The frontend is built before the
// environment changes, so the Julia libraries never shadow the ones node loads.
//
// Both bundles are built again after `tauri build`: Tauri's bundler copies
// resources file by file with `fs::copy`, which dereferences the runtime's symlinks and stores
// every soname as a full copy (825 MiB of duplicates in the first package).
// `scripts/package-linux-tree.mjs` puts the staged tree back, symlinks included: the deb is
// unpacked and rebuilt with dpkg-deb, the AppImage's AppDir is corrected and squashed again with
// the plugin Tauri downloaded.
//
// Host quirk (not handled here): on Arch with open-vm-tools, `/usr/lib/vmware` holds a
// second, incomplete copy of the GTK stack. The GTK plugin's search under `/usr/lib` finds
// it, hands VMware's `libgdk_pixbuf-2.0.so.0` to linuxdeploy, and the bundle then fails on
// a missing `libcroco-0.6.so.3`. Build in a clean container (CI uses ubuntu-latest) or hide
// that directory for the run, e.g. with a `find` shim in PATH that skips `/usr/lib/vmware`
// (a user namespace does not work: `cp --archive` cannot preserve ownership there).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repackageAppImage, repackageDeb } from "./package-linux-tree.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "linux") throw new Error("scripts/package-linux.mjs builds the Linux packages only");

const args = process.argv.slice(2);
// The staging directory the packages are rebuilt from. Tauri bundles the runtime from
// `build/package` (the paths are listed in `tauri.package.conf.json`), so `--out` is for a runtime
// staged there.
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? resolve(args[outAt + 1]) : join(repo, "build", "package");
const bundlesAt = args.indexOf("--bundles");
const bundles = (bundlesAt >= 0 ? args[bundlesAt + 1] : "deb,appimage").split(",");
// `--bundles all` means both packages of this script (Tauri's own set on Linux has no others).
const wanted = new Set(bundles.flatMap((name) => (name === "all" ? ["deb", "appimage"] : [name])));
const consumed = new Set([outAt, outAt + 1, bundlesAt, bundlesAt + 1].filter((index) => index >= 0));
const forwarded = args.filter((_, index) => !consumed.has(index));

const juliaLib = join(out, "julia", "lib", "julia");
if (!existsSync(juliaLib)) {
  throw new Error(`the staged Julia runtime is missing: ${juliaLib} (run node scripts/package-runtime.mjs first)`);
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// The frontend first: `tauri build` would otherwise run `pnpm build` with the Julia
// libraries on LD_LIBRARY_PATH.
run("pnpm", ["--dir", join(repo, "app"), "build"], { cwd: repo });

const tauri = join(repo, "app", "node_modules", ".bin", "tauri");
run(
  tauri,
  [
    "build",
    "--config", "src-tauri/tauri.package.conf.json",
    "--config", '{"build":{"beforeBuildCommand":""}}',
    "--bundles", bundles.join(","),
    ...forwarded,
  ],
  {
    cwd: join(repo, "app"),
    env: {
      ...process.env,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${juliaLib}:${process.env.LD_LIBRARY_PATH}` : juliaLib,
    },
  },
);

// Tauri writes the bundles into `<target dir>/release/bundle`, the directory cargo uses: the
// workspace's `target` at the repository root, or CARGO_TARGET_DIR when it is set.
const bundleDir = join(process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(repo, "target"), "release", "bundle");

// The bundle directory keeps the packages of earlier builds (another version, an earlier product
// name), so only this build's packages are rebuilt.
const { productName: product, version } = JSON.parse(readFileSync(join(repo, "app", "src-tauri", "tauri.conf.json"), "utf8"));

if (wanted.has("deb")) {
  const debDir = join(bundleDir, "deb");
  const debs = existsSync(debDir)
    ? readdirSync(debDir).filter((name) => name.startsWith(`${product}_${version}_`) && name.endsWith(".deb"))
    : [];
  if (debs.length !== 1) {
    throw new Error(`expected one deb in ${debDir}, found ${debs.length}: ${debs.join(", ")}`);
  }
  const deb = join(debDir, debs[0]);
  console.log(`deb      putting the runtime's symlinks back into ${debs[0]}`);
  repackageDeb({ deb, stagedRuntime: out, log: (line) => console.log(`deb      ${line}`) });
  console.log(`deb      ${deb}`);
}

if (wanted.has("appimage")) {
  const appImageDir = join(bundleDir, "appimage");
  console.log(`appimage putting the runtime's symlinks back into the AppDir and squashing it again`);
  repackageAppImage({ appImageDir, stagedRuntime: out, product, log: (line) => console.log(`appimage ${line}`) });
  console.log(`appimage ${join(appImageDir, readdirSync(appImageDir).find((name) => name.startsWith(`${product}_`) && name.endsWith(".AppImage")))}`);
}
