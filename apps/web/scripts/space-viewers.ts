import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * The standalone viewers of the spaces, served by the website at /spaces/<name>.html. They live in
 * their packages (packages/<package>/viz) and are copied into the build, and served by the dev
 * server, from there: the repository keeps one copy of each. Each viewer is one self-contained
 * HTML file (its data and scripts inline, no links to files beside it), so it works at any path.
 */
export const SPACE_VIEWERS: Readonly<Record<string, string>> = {
  "spaces/surface.html": "packages/surface/viz/index.html",
  "spaces/curved.html": "packages/curved/viz/index.html",
  "spaces/sweep.html": "packages/curved/viz/sweep.html",
  "spaces/sphere.html": "packages/sphere/viz/index.html",
  "spaces/torus.html": "packages/torus/viz/index.html",
  "spaces/polyhedra.html": "packages/polyhedra/viz/index.html",
};

/** The viewer published at a request path such as "/spaces/torus.html?x#y", or null. */
export function viewerFor(url: string | undefined): string | null {
  let path: string;
  try {
    path = decodeURIComponent((url ?? "").split(/[?#]/)[0]).replace(/^\/+/, "");
  } catch {
    return null;
  }
  return Object.hasOwn(SPACE_VIEWERS, path) ? path : null;
}

/** Vite plugin: the dev server answers the viewers' paths, and the build writes them into the output. */
export function spaceViewers(repoRoot: string): Plugin {
  const read = (published: string) => readFileSync(resolve(repoRoot, SPACE_VIEWERS[published]));
  return {
    name: "polypack-space-viewers",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const published = viewerFor(req.url);
        if (!published || (req.method !== "GET" && req.method !== "HEAD")) return next();
        // read on every request, so that a viewer rebuilt in its package is served as it is now
        const body = read(published);
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.setHeader("content-length", String(body.length));
        res.end(req.method === "HEAD" ? undefined : body);
      });
    },
    generateBundle() {
      for (const published of Object.keys(SPACE_VIEWERS))
        this.emitFile({ type: "asset", fileName: published, source: read(published) });
    },
  };
}
