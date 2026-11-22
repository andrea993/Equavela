// Minimal ambient declaration for the one Node API used by the stylesheet guard test
// (`app/src/styles/stacking.test.ts`). The frontend has no Node type definitions (`tsconfig.json`
// lists only `vite/client`), and installing `@types/node` just to read one file would be heavier
// than the four lines below.
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
}
