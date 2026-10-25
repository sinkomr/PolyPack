import { resolve } from "node:path";
import { defineConfig } from "vite";
import { spaceViewers } from "./scripts/space-viewers";

const api = process.env.POLYPACK_API ?? "http://localhost:8787";

export default defineConfig({
  // the standalone viewers of the spaces, at /spaces/<name>.html (copied from packages/*/viz)
  plugins: [spaceViewers(resolve(import.meta.dirname, "../.."))],
  server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: true } } },
  build: {
    // three.js with the 3D views (packages/view3d) is one chunk of about 640 kB (166 kB gzipped),
    // loaded with a dynamic import only when a 3D on 4D problem is drawn
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // that chunk under a plain name, assets/view3d-<hash>.js, so that it is easy to find; only
        // its name changes (manualChunks would also move shared modules into it, and so load it
        // with every kind)
        chunkFileNames: (chunk) =>
          /[\\/]packages[\\/]view3d[\\/]src[\\/]index\.ts$/.test(chunk.facadeModuleId ?? "")
            ? "assets/view3d-[hash].js"
            : "assets/[name]-[hash].js",
      },
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
        // the 3D on 4D viewer, built from src/boundary-viewer.ts (the other viewers are copied, above)
        "spaces/boundary": resolve(import.meta.dirname, "spaces/boundary.html"),
      },
    },
  },
});
