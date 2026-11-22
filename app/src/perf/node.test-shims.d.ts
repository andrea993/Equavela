// The benchmark (`perf/edit-render.bench.test.tsx`) reads its 17 MB fixture from disk and switches on
// when `PERF` is set, while the app itself has no use for Node's types (`tsconfig.json` only loads
// `vite/client`). This declares just what the benchmark reads, so nothing else picks Node globals up.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};
