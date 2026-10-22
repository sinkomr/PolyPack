import { resolve } from "node:path";
import { defineConfig } from "vite";

const api = process.env.POLYPACK_API ?? "http://localhost:8787";

export default defineConfig({
  server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: true } } },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        browse: resolve(import.meta.dirname, "browse.html"),
        admin: resolve(import.meta.dirname, "admin.html"),
        // the idle game, linked from every page's nav
        tighter: resolve(import.meta.dirname, "tighter.html"),
      },
    },
  },
});
