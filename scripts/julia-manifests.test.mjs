// Every Julia manifest of the kernel environments must hold the dependencies their Project.toml files
// declare, and there is one manifest per environment: the kernel runs on one Julia version, which
// reads Manifest.toml. A version-specific Manifest-v1.x.toml would win over it and fall behind when
// a dependency changes, and the kernel would then fail to start on that Julia version.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const kernel = resolve("kernel");

/** Names under the `[deps]` table of a Project.toml. */
function projectDeps(path) {
  const deps = [];
  let inDeps = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const header = line.match(/^\s*\[(.+)\]\s*$/);
    if (header) {
      inDeps = header[1] === "deps";
      continue;
    }
    const entry = inDeps && line.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
    if (entry) deps.push(entry[1]);
  }
  return deps;
}

/** Package entries of a Manifest.toml: name -> the names in its `deps` list (array or table form). */
function manifestEntries(path) {
  const entries = new Map();
  let current = null;
  let inDepsTable = false;
  let pendingArray = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (pendingArray !== null) {
      pendingArray += line;
      if (line.includes("]")) {
        current.push(...[...pendingArray.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
        pendingArray = null;
      }
      continue;
    }
    const entry = line.match(/^\s*\[\[deps\.([^\]]+)\]\]\s*$/);
    if (entry) {
      current = [];
      entries.set(entry[1], current);
      inDepsTable = false;
      continue;
    }
    const table = line.match(/^\s*\[(.+)\]\s*$/);
    if (table) {
      inDepsTable = current !== null && /^deps\.[^.]+\.deps$/.test(table[1]);
      continue;
    }
    if (current === null) continue;
    if (inDepsTable) {
      const dep = line.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
      if (dep) current.push(dep[1]);
      continue;
    }
    const array = line.match(/^\s*deps\s*=\s*(\[.*)$/);
    if (array) {
      if (array[1].includes("]")) current.push(...[...array[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
      else pendingArray = array[1];
    }
  }
  return entries;
}

function manifestsOf(dir) {
  return readdirSync(dir)
    .filter((name) => /^Manifest(-v[\d.]+)?\.toml$/.test(name))
    .map((name) => join(dir, name));
}

const eqRuntimeDeps = projectDeps(join(kernel, "EqRuntime", "Project.toml"));
const kernelDeps = projectDeps(join(kernel, "EquavelaKernel", "Project.toml"));

for (const manifest of manifestsOf(join(kernel, "EquavelaKernel"))) {
  test(`${manifest} holds the dependencies of EquavelaKernel and EqRuntime`, () => {
    const entries = manifestEntries(manifest);
    const missingTop = kernelDeps.filter((dep) => !entries.has(dep));
    assert.deepEqual(missingTop, [], "packages of kernel/EquavelaKernel/Project.toml missing from the manifest");
    const eqRuntime = entries.get("EqRuntime");
    assert.ok(eqRuntime, "the manifest has no EqRuntime entry");
    const missingInEntry = eqRuntimeDeps.filter((dep) => !eqRuntime.includes(dep));
    assert.deepEqual(missingInEntry, [], "packages of kernel/EqRuntime/Project.toml missing from the EqRuntime entry: re-resolve this manifest with its Julia version");
    const missingEntries = eqRuntimeDeps.filter((dep) => !entries.has(dep));
    assert.deepEqual(missingEntries, [], "packages of kernel/EqRuntime/Project.toml without a manifest entry");
  });
}

for (const manifest of manifestsOf(join(kernel, "EqRuntime"))) {
  test(`${manifest} holds the dependencies of EqRuntime`, () => {
    const entries = manifestEntries(manifest);
    assert.deepEqual(eqRuntimeDeps.filter((dep) => !entries.has(dep)), []);
  });
}

test("the kernel environments have manifests to check", () => {
  assert.ok(existsSync(join(kernel, "EquavelaKernel", "Manifest.toml")));
  assert.ok(manifestsOf(join(kernel, "EquavelaKernel")).length >= 1);
});

test("each kernel environment has only Manifest.toml, no version-specific manifest", () => {
  for (const env of ["EqRuntime", "EquavelaKernel"]) {
    const names = manifestsOf(join(kernel, env)).map((path) => path.slice(path.lastIndexOf(env) + env.length + 1));
    assert.deepEqual(names, ["Manifest.toml"], `kernel/${env}`);
  }
});
