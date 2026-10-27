import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { spaceViewers } from "./scripts/space-viewers";

const api = process.env.POLYPACK_API ?? "http://localhost:8787";

/**
 * three.js's licence, at the head of every built file that holds its code: the bundler drops the
 * library's own @license comment along with the import it precedes, and MIT asks for the notice in
 * every copy. A comment that starts with "/*!" is kept by the minifier.
 */
const THREE_NOTICE = `/*! three.js (https://threejs.org), bundled for the 3D drawings; see THIRD_PARTY_NOTICES.md.
${readFileSync(resolve(import.meta.dirname, "../../node_modules/three/LICENSE"), "utf8")
  .trim()
  .replace(/\*\//g, "* /")}
*/`;

export default defineConfig({
  // the standalone viewers of the spaces, at /spaces/<name>.html (copied from packages/*/viz)
  plugins: [spaceViewers(resolve(import.meta.dirname, "../.."))],
  server: { port: 5173, proxy: { "/api": { target: api, changeOrigin: true } } },
  // keep "/*!" comments (the licence notices above) when the build is minified
  esbuild: { legalComments: "inline" },
  build: {
    // three.js is one chunk of about 750 kB (190 kB gzipped), shared by the 3D drawings and loaded
    // with a dynamic import only when a 3D in 3D or 3D on 4D problem is drawn; the 3D on 4D views
    // (packages/view3d) are another of about 100 kB
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        banner: (chunk) =>
          chunk.moduleIds.some((id) => /[\\/]node_modules[\\/]three[\\/]/.test(id)) ? THREE_NOTICE : "",
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
        // the records of the dimensions other than the polygons' (browse.html is the polygons' page)
        records: resolve(import.meta.dirname, "records.html"),
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
