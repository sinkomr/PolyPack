import { resolve } from "node:path";
import { defineConfig } from "vite";
import { spaceViewers } from "./scripts/space-viewers";

const api = process.env.POLYPACK_API ?? "http://localhost:8787";

export default defineConfig({
  // the standalone viewers of the spaces, at /spaces/<name>.html (copied from packages/*/viz)
  plugins: [spaceViewers(resolve(import.meta.dirname, "../.."))],
  server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: true } } },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        browse: resolve(import.meta.dirname, "browse.html"),
        holders: resolve(import.meta.dirname, "holders.html"),
        dimensions: resolve(import.meta.dirname, "dimensions.html"),
        // the former Spaces page: it sends old links on to dimensions.html, with their query and hash
        spaces: resolve(import.meta.dirname, "spaces.html"),
        volunteer: resolve(import.meta.dirname, "volunteer.html"),
        admin: resolve(import.meta.dirname, "admin.html"),
        // the idle game, linked from every page's nav
        tighter: resolve(import.meta.dirname, "tighter.html"),
      },
    },
  },
});
