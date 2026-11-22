import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTree, makeWritable } from "./package-files.mjs";

test("staging copies included files and makes read-only copies writable", () => {
  const dir = mkdtempSync(join(tmpdir(), "equavela-package-test-"));
  const source = join(dir, "source"), dest = join(dir, "staged");
  mkdirSync(source);
  writeFileSync(join(source, "keep"), "runtime");
  writeFileSync(join(source, "skip"), "unused");
  chmodSync(join(source, "keep"), 0o444);
  copyTree(source, dest, (rel) => rel === "skip");
  makeWritable(dest);
  assert.equal(statSync(join(dest, "keep")).mode & 0o200, 0o200);
  assert.throws(() => statSync(join(dest, "skip")), { code: "ENOENT" });
});

test("staging preserves relative symlinks and executable permissions without touching their source", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "equavela-package-test-"));
  const source = join(dir, "source"), dest = join(dir, "staged");
  mkdirSync(source);
  const executable = join(source, "julia");
  writeFileSync(executable, "runtime");
  chmodSync(executable, 0o555);
  symlinkSync("julia", join(source, "julia-link"));
  symlinkSync(".", join(source, "cycle"));
  const external = join(dir, "external");
  writeFileSync(external, "outside");
  chmodSync(external, 0o444);
  copyTree(source, dest, () => false);
  assert.equal(readlinkSync(join(dest, "julia-link")), "julia");
  symlinkSync("../external", join(dest, "outside-link"));
  makeWritable(dest);
  assert.equal(statSync(executable).mode & 0o777, 0o555);
  assert.equal(statSync(external).mode & 0o777, 0o444);
  assert.equal(statSync(join(dest, "julia")).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(dest, "cycle")).isSymbolicLink(), true);
});

test("staging rejects links outside the source before replacing an existing destination", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "equavela-package-test-"));
  const source = join(dir, "source"), dest = join(dir, "staged");
  mkdirSync(source);
  mkdirSync(dest);
  writeFileSync(join(dir, "external"), "outside");
  writeFileSync(join(dest, "keep"), "old");
  symlinkSync("../external", join(source, "bad"));
  assert.throws(() => copyTree(source, dest, () => false), /outside its source/);
  assert.equal(statSync(join(dest, "keep")).size, 3);
  copyTree(source, dest, (rel) => rel === "bad");
  assert.throws(() => lstatSync(join(dest, "bad")), { code: "ENOENT" });
});

test("staging rejects overlapping source and destination without removing data", () => {
  const dir = mkdtempSync(join(tmpdir(), "equavela-package-test-"));
  const source = join(dir, "source");
  mkdirSync(source);
  writeFileSync(join(source, "keep"), "important");
  for (const dest of [source, dir, join(source, "nested")]) {
    assert.throws(() => copyTree(source, dest, () => false), /overlap/);
    assert.equal(statSync(join(source, "keep")).size, 9);
  }
});

test("staging accepts a linked source root but rejects an output link escaping staging", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "equavela-package-test-"));
  const source = join(dir, "source"), output = join(dir, "output"), outside = join(dir, "outside");
  mkdirSync(source);
  mkdirSync(output);
  mkdirSync(outside);
  mkdirSync(join(outside, "artifacts"));
  writeFileSync(join(source, "data"), "source");
  writeFileSync(join(outside, "artifacts", "keep"), "important");
  symlinkSync(source, join(dir, "source-link"));
  copyTree(join(dir, "source-link"), join(output, "copy"), () => false, output);
  assert.equal(statSync(join(output, "copy", "data")).size, 6);
  symlinkSync(outside, join(output, "depot"));
  assert.throws(() => copyTree(source, join(output, "depot", "artifacts"), () => false, output), /outside its output directory/);
  assert.equal(statSync(join(outside, "artifacts", "keep")).size, 9);
});

test("staging rejects links to excluded targets before replacing the destination", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "equavela-package-test-"));
  const source = join(dir, "source"), dest = join(dir, "staged");
  mkdirSync(join(source, "excluded"), { recursive: true });
  mkdirSync(dest);
  writeFileSync(join(source, "excluded", "target"), "source");
  writeFileSync(join(dest, "keep"), "important");
  symlinkSync("excluded/target", join(source, "link"));
  assert.throws(() => copyTree(source, dest, (rel) => rel === "excluded"), /excluded path/);
  assert.equal(statSync(join(dest, "keep")).size, 9);
});
