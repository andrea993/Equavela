import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeRuntime,
  findRuntimeRoot,
  installedSize,
  md5Sums,
  PORTABLE_CPU_TARGET,
  precompileAtInstallPath,
  precompileCommand,
  replaceRuntimeTree,
  repackageAppImage,
  repackageDeb,
  setInstalledSize,
} from "./package-linux-tree.mjs";

const dpkgDeb = spawnSync("dpkg-deb", ["--version"], { stdio: "ignore" }).status === 0;

function temp(name) {
  return mkdtempSync(join(tmpdir(), `equavela-package-linux-${name}-`));
}

const md5 = (text) => createHash("md5").update(text).digest("hex");

/// A staged runtime: one library under three sonames, as the real one has it.
function stagedRuntime(dir) {
  mkdirSync(join(dir, "julia", "bin"), { recursive: true });
  mkdirSync(join(dir, "julia", "lib", "julia"), { recursive: true });
  writeFileSync(join(dir, "julia", "bin", "julia"), "runtime");
  writeFileSync(join(dir, "julia", "lib", "julia", "libLLVM.so.20.1jl"), "x".repeat(1024));
  symlinkSync("libLLVM.so.20.1jl", join(dir, "julia", "lib", "julia", "libLLVM-20jl.so"));
  symlinkSync("libLLVM.so.20.1jl", join(dir, "julia", "lib", "julia", "libLLVM.so"));
  for (const name of ["python", "sysimage", "kernel", "depot"]) mkdirSync(join(dir, name));
  return dir;
}

/// The tree of a Tauri bundle: the same library stored three times, no symlink anywhere.
function packagedTree(dir) {
  const runtime = join(dir, "usr", "lib", "Equavela");
  mkdirSync(join(runtime, "julia", "bin"), { recursive: true });
  mkdirSync(join(runtime, "julia", "lib", "julia"), { recursive: true });
  writeFileSync(join(runtime, "julia", "bin", "julia"), "runtime");
  for (const name of ["libLLVM.so.20.1jl", "libLLVM-20jl.so", "libLLVM.so"]) {
    writeFileSync(join(runtime, "julia", "lib", "julia", name), "x".repeat(1024));
  }
  mkdirSync(join(dir, "usr", "bin"), { recursive: true });
  writeFileSync(join(dir, "usr", "bin", "equavela-app"), "binary");
  return runtime;
}

/// A stand-in for Tauri's AppImage plugin: it records what it was asked to squash in the image.
function fakePlugin(dir) {
  const path = join(dir, "linuxdeploy-plugin-appimage.AppImage");
  writeFileSync(
    path,
    '#!/bin/sh\n{ echo "$@"; find "$2/usr/lib/Equavela" -type l | wc -l; } > "$LDAI_OUTPUT"\n',
  );
  chmodSync(path, 0o755);
  return path;
}

test("the runtime directory of a bundle tree is the one with julia/bin/julia", () => {
  const dir = temp("find");
  const runtime = packagedTree(dir);
  assert.equal(findRuntimeRoot(dir), runtime);
  assert.throws(() => findRuntimeRoot(join(dir, "nowhere")), /no usr\/lib/);
  mkdirSync(join(dir, "usr", "lib", "Second", "julia", "bin"), { recursive: true });
  writeFileSync(join(dir, "usr", "lib", "Second", "julia", "bin", "julia"), "runtime");
  assert.throws(() => findRuntimeRoot(dir), /expected one directory/);
  rmSync(dir, { recursive: true, force: true });
});

test("replacing the runtime tree keeps the staged symlinks instead of the copies", { skip: process.platform === "win32" }, () => {
  const dir = temp("replace");
  const staged = stagedRuntime(join(dir, "staged"));
  const runtime = packagedTree(join(dir, "data"));
  const before = describeRuntime(runtime);
  replaceRuntimeTree(runtime, staged);
  const after = describeRuntime(runtime);
  assert.equal(before.links, 0);
  assert.equal(after.links, 2);
  assert.equal(after.files, 2);
  assert.ok(after.bytes <= before.bytes / 2, `${after.bytes} is not smaller than ${before.bytes}`);
  const library = join(runtime, "julia", "lib", "julia");
  assert.equal(readlinkSync(join(library, "libLLVM.so")), "libLLVM.so.20.1jl");
  assert.equal(readlinkSync(join(library, "libLLVM-20jl.so")), "libLLVM.so.20.1jl");
  assert.equal(statSync(join(library, "libLLVM.so.20.1jl")).size, 1024);
  // The rest of the data tree is untouched.
  assert.equal(statSync(join(runtime, "..", "..", "bin", "equavela-app")).size, 6);
  rmSync(dir, { recursive: true, force: true });
});

test("replacing the runtime tree fails on a staged runtime without a directory", () => {
  const dir = temp("incomplete");
  const runtime = packagedTree(join(dir, "data"));
  assert.throws(() => replaceRuntimeTree(runtime, join(dir, "missing")), /no julia directory/);
  rmSync(dir, { recursive: true, force: true });
});

test("the installed size counts the data tree and not the control directory", () => {
  const dir = temp("size");
  const runtime = packagedTree(dir);
  mkdirSync(join(dir, "DEBIAN"), { recursive: true });
  writeFileSync(join(dir, "DEBIAN", "control"), "x".repeat(1 << 20));
  const withoutControl = installedSize(dir);
  assert.ok(withoutControl >= 3 && withoutControl < 1024, `control directory counted: ${withoutControl} KiB`);
  writeFileSync(join(runtime, "julia", "extra"), "x".repeat(1 << 20));
  assert.ok(installedSize(dir) >= withoutControl + 1024, `${installedSize(dir)} KiB`);
  rmSync(dir, { recursive: true, force: true });
});

test("md5sums lists regular files only, in dpkg's format", { skip: process.platform === "win32" }, () => {
  const dir = temp("md5");
  const runtime = packagedTree(dir);
  symlinkSync("libLLVM.so", join(runtime, "julia", "lib", "julia", "alias.so"));
  mkdirSync(join(dir, "DEBIAN"), { recursive: true });
  writeFileSync(join(dir, "DEBIAN", "control"), "control");
  const lines = md5Sums(dir).trimEnd().split("\n");
  assert.equal(lines.length, 5);
  assert.ok(lines.every((line) => /^[0-9a-f]{32} {2}\S+$/.test(line)), lines.join("\n"));
  const paths = lines.map((line) => line.split("  ")[1]);
  assert.deepEqual(paths, [...paths].sort());
  assert.ok(!paths.some((path) => path.startsWith("DEBIAN/") || path.endsWith("alias.so")));
  assert.ok(lines.includes(`${md5("binary")}  usr/bin/equavela-app`), lines.join("\n"));
  rmSync(dir, { recursive: true, force: true });
});

test("the Installed-Size field is replaced and the other fields are kept", () => {
  const control = "Package: math-master\nVersion: 0.1.0\nInstalled-Size: 1792790\nDepends: libgtk-3-0\n";
  assert.equal(
    setInstalledSize(control, 914000),
    "Package: math-master\nVersion: 0.1.0\nInstalled-Size: 914000\nDepends: libgtk-3-0\n",
  );
  assert.throws(() => setInstalledSize("Package: math-master\n", 1), /no Installed-Size/);
});

test("a repackaged deb keeps the runtime's symlinks and the same files", { skip: !dpkgDeb }, () => {
  const dir = temp("repackage");
  const staged = stagedRuntime(join(dir, "staged"));
  const tree = join(dir, "data");
  packagedTree(tree);
  mkdirSync(join(tree, "DEBIAN"), { recursive: true });
  writeFileSync(
    join(tree, "DEBIAN", "control"),
    "Package: math-master\nVersion: 0.1.0\nArchitecture: amd64\nInstalled-Size: 1\nMaintainer: Equavela\nDescription: test\n",
  );
  writeFileSync(join(tree, "DEBIAN", "md5sums"), md5Sums(tree));
  const deb = join(dir, "test.deb");
  assert.equal(spawnSync("dpkg-deb", ["--root-owner-group", "-b", tree, deb]).status, 0);
  repackageDeb({ deb, stagedRuntime: staged, precompile: false });
  const installed = join(dir, "installed");
  mkdirSync(installed);
  assert.equal(spawnSync("dpkg-deb", ["-x", deb, installed]).status, 0);
  const library = join(installed, "usr", "lib", "Equavela", "julia", "lib", "julia");
  assert.equal(readlinkSync(join(library, "libLLVM.so")), "libLLVM.so.20.1jl");
  const listing = spawnSync("dpkg-deb", ["-c", deb], { encoding: "utf8" }).stdout;
  assert.match(listing, /usr\/lib\/Equavela\/julia\/lib\/julia\/libLLVM\.so -> libLLVM\.so\.20\.1jl/);
  const size = spawnSync("dpkg-deb", ["-f", deb, "Installed-Size"], { encoding: "utf8" }).stdout.trim();
  assert.ok(Number(size) >= 2, `Installed-Size ${size}`);
  rmSync(dir, { recursive: true, force: true });
});

test("the AppDir is corrected and the image squashed again with the plugin", { skip: process.platform === "win32" }, () => {
  const dir = temp("appimage");
  const staged = stagedRuntime(join(dir, "staged"));
  const appImageDir = join(dir, "appimage");
  const appDir = join(appImageDir, "Equavela.AppDir");
  packagedTree(appDir);
  writeFileSync(join(appDir, "AppRun"), "apprun");
  const image = join(appImageDir, "Equavela_0.1.0_amd64.AppImage");
  writeFileSync(image, "image from tauri");
  const result = repackageAppImage({
    appImageDir,
    stagedRuntime: staged,
    plugin: fakePlugin(dir),
  });
  assert.equal(result.before.links, 0);
  assert.equal(result.after.links, 2);
  const [argumentsForPlugin, links] = readFileSync(image, "utf8").trimEnd().split("\n");
  assert.equal(argumentsForPlugin, `--appdir ${appDir}`);
  assert.equal(links, "2");
  assert.equal(readlinkSync(join(appDir, "usr", "lib", "Equavela", "julia", "lib", "julia", "libLLVM.so")), "libLLVM.so.20.1jl");
  rmSync(dir, { recursive: true, force: true });
});

test("a failed AppImage plugin leaves the image Tauri built untouched", { skip: process.platform === "win32" }, () => {
  const dir = temp("appimage-fail");
  const staged = stagedRuntime(join(dir, "staged"));
  const appImageDir = join(dir, "appimage");
  packagedTree(join(appImageDir, "Equavela.AppDir"));
  const image = join(appImageDir, "Equavela_0.1.0_amd64.AppImage");
  writeFileSync(image, "image from tauri");
  assert.throws(
    () => repackageAppImage({ appImageDir, stagedRuntime: staged, plugin: join(dir, "missing") }),
    /AppImage plugin is missing/,
  );
  assert.equal(readFileSync(image, "utf8"), "image from tauri");
  rmSync(dir, { recursive: true, force: true });
});

test("the pkgimages are built with the runtime mounted at the install path and the portable targets", () => {
  const [command, args] = precompileCommand({ runtimeRoot: "/work/usr/lib/Equavela", installRoot: "/usr/lib/Equavela", uid: 1000, gid: 1000 });
  assert.equal(command, "docker");
  assert.ok(args.includes("/work/usr/lib/Equavela:/usr/lib/Equavela"));
  assert.ok(args.includes("JULIA_DEPOT_PATH=/usr/lib/Equavela/depot"));
  assert.ok(args.includes(`JULIA_CPU_TARGET=${PORTABLE_CPU_TARGET}`));
  assert.ok(args.includes("--network") && args.includes("none"));
  assert.ok(args.includes("--sysimage=/usr/lib/Equavela/sysimage/equavelakernel.so"));
  assert.ok(args.includes("--project=/usr/lib/Equavela/kernel/EquavelaKernel"));
  assert.equal(args.at(-1), "using EquavelaKernel");
});

test("only the compiled directory is added to the depot", () => {
  const dir = temp("precompile");
  const runtime = join(dir, "usr", "lib", "Equavela");
  mkdirSync(join(runtime, "depot", "packages"), { recursive: true });
  mkdirSync(join(runtime, "depot", "compiled", "old"), { recursive: true });
  const calls = [];
  precompileAtInstallPath({
    runtimeRoot: runtime,
    installRoot: "/usr/lib/Equavela",
    runCommand: (command, args) => {
      calls.push([command, args]);
      // What a precompile leaves in the depot.
      mkdirSync(join(runtime, "depot", "compiled", "v1.13", "EquavelaKernel"), { recursive: true });
      writeFileSync(join(runtime, "depot", "compiled", "v1.13", "EquavelaKernel", "a.ji"), "ji");
      mkdirSync(join(runtime, "depot", "logs"));
      mkdirSync(join(runtime, "depot", "scratchspaces"));
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(readdirSync(join(runtime, "depot")).sort(), ["compiled", "packages"]);
  assert.deepEqual(readdirSync(join(runtime, "depot", "compiled")), ["v1.13"]);
  rmSync(dir, { recursive: true, force: true });
});
