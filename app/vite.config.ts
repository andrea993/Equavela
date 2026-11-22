import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { manualSite } from "./scripts/manual-site.mjs";

// Tauri expects a fixed dev server port (see src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react(), manualSite()],
  clearScreen: false,
  // Plotly 4 refers to `global` and to the Node `events` module; the bundle is a lazy
  // chunk, so its size is a non-issue. Without the alias Vite externalises `events` to an empty
  // browser stub, `EventEmitter` is undefined and every plot draw throws
  // "Right-hand side of 'instanceof' is not an object".
  define: { global: "globalThis" },
  resolve: { alias: { events: "events/" } },
  // The startup splash is a second page.
  build: { chunkSizeWarningLimit: 6000, rollupOptions: { input: { main: "index.html", splash: "splash.html" } } },
  server: {
    port: 1420,
    strictPort: true,
    // The unit tables are shared with core and EqRuntime.
    fs: { allow: [".", "../core/fixtures", "../kernel/EqRuntime/src"] },
  },
  test: { environment: "jsdom", setupFiles: ["src/test-setup.ts"], testTimeout: 30000 },
});
