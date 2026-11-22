// Filesystem helpers for staging the packaged runtime. Never follow a staged symlink while
// changing permissions: it may point outside the staging directory.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function makeWritable(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode | 0o200);
  if (stat.isDirectory()) readdirSync(path).forEach((name) => makeWritable(`${path}${sep}${name}`));
}

export function copyTree(from, to, skip, stagingRoot = null) {
  const root = realpathSync(from);
  let ancestor = resolve(to);
  const missing = [];
  while (!existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const destination = resolve(realpathSync(ancestor), ...missing);
  const inside = (parent, child) => {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  if (stagingRoot && !inside(realpathSync(stagingRoot), destination)) {
    throw new Error(`staging destination points outside its output directory: ${to}`);
  }
  if (inside(root, destination) || inside(destination, root)) {
    throw new Error(`staging source and destination overlap: ${from} -> ${to}`);
  }
  const check = (path) => {
    const rel = relative(root, path).split(sep).join("/");
    if (rel && skip(rel, path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path);
      const resolved = realpathSync(resolve(dirname(path), link));
      const target = relative(root, resolved);
      if (isAbsolute(link) || target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target)) {
        throw new Error(`staging link points outside its source: ${path} -> ${link}`);
      }
      let component = "";
      for (const part of target.split(sep).filter(Boolean)) {
        component = component ? `${component}/${part}` : part;
        if (skip(component, join(root, ...component.split("/")))) {
          throw new Error(`staging link points to an excluded path: ${path} -> ${link}`);
        }
      }
    } else if (stat.isDirectory()) {
      readdirSync(path).forEach((name) => check(resolve(path, name)));
    }
  };
  check(root);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(root, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const rel = relative(root, source).split(sep).join("/");
      return rel === "" || !skip(rel, source);
    },
  });
}
