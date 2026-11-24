// The user manual is the submodule at docs/manual: its built site is served at /manual/
// by the dev server and copied into the build, so the app opens it offline. Plain JavaScript,
// because the frontend's TypeScript configuration has no Node types.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANUAL_URL = new URL("../../docs/manual/site/manual", import.meta.url);
const MANUAL = fs.existsSync(MANUAL_URL) ? fileURLToPath(MANUAL_URL) : "";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** @returns {import("vite").Plugin} */
export function manualSite() {
  return {
    name: "equavela-manual",
    configureServer(server) {
      server.middlewares.use("/manual", (request, response, next) => {
        const relative = decodeURIComponent((request.url ?? "/").split("?")[0]).replace(/^\/+/, "") || "index.html";
        const file = path.resolve(MANUAL, relative);
        if (!file.startsWith(MANUAL) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        response.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
        fs.createReadStream(file).pipe(response);
      });
    },
    writeBundle(options) {
      if (fs.existsSync(MANUAL) && options.dir) fs.cpSync(MANUAL, path.join(options.dir, "manual"), { recursive: true });
    },
  };
}
