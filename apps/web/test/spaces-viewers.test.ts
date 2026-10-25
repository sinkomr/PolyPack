import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SPACE_VIEWERS, spaceViewers, viewerFor } from "../scripts/space-viewers";

const root = resolve(import.meta.dirname, "../../..");

describe("the viewers of the spaces", () => {
  it("publishes the six viewers at /spaces/<name>.html", () => {
    expect(Object.keys(SPACE_VIEWERS).sort()).toEqual(
      ["curved", "polyhedra", "sphere", "surface", "sweep", "torus"].map((n) => `spaces/${n}.html`),
    );
  });

  it("copies self-contained pages: nothing they load or link is relative to where they live", () => {
    for (const [published, source] of Object.entries(SPACE_VIEWERS)) {
      const html = readFileSync(resolve(root, source), "utf8");
      expect(html.trimStart().toLowerCase().startsWith("<!doctype html>"), source).toBe(true);
      expect(html, source).toMatch(/<title>[^<]+<\/title>/);
      // href, src and CSS url() may only point within the page, to data, or to another site
      const refs = [
        ...[...html.matchAll(/\b(?:href|src|action)\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]),
        ...[...html.matchAll(/url\(\s*["']?([^"')]*)/gi)].map((m) => m[1]),
      ];
      const relative = refs.filter((r) => !/^(#|data:|https?:\/\/|mailto:|\$\{|$)/i.test(r));
      expect(relative, published).toEqual([]);
    }
  });

  it("leaves the 3D on 4D viewer to the build: a page of the site, not a copied file", async () => {
    expect(viewerFor("/spaces/boundary.html")).toBeNull();
    const html = readFileSync(resolve(root, "apps/web/spaces/boundary.html"), "utf8");
    expect(html).toMatch(/<title>PolyPack — 3D on 4D viewer<\/title>/);
    expect(html).toContain('<script type="module" src="/src/boundary-viewer.ts"></script>');
    // it is an input of the build, at the address the API names (SPACE_INFO.boundary.viewer)
    const config = (await import("../vite.config")).default as {
      build: { rollupOptions: { input: Record<string, string> } };
    };
    expect(config.build.rollupOptions.input["spaces/boundary"]).toBe(resolve(root, "apps/web/spaces/boundary.html"));
    const { SPACE_INFO } = await import("@polypack/spaces");
    expect(SPACE_INFO.boundary.viewer).toBe("/spaces/boundary.html");
  });

  it("finds the viewer of a request path", () => {
    expect(viewerFor("/spaces/torus.html")).toBe("spaces/torus.html");
    expect(viewerFor("/spaces/sweep.html?K=1#x")).toBe("spaces/sweep.html");
    expect(viewerFor("/spaces/other.html")).toBeNull();
    expect(viewerFor("/spaces.html")).toBeNull();
    expect(viewerFor("/spaces/../packages/torus/viz/index.html")).toBeNull();
    expect(viewerFor("/spaces/%E0%A4%A")).toBeNull();
    expect(viewerFor("/toString")).toBeNull();
    expect(viewerFor(undefined)).toBeNull();
  });

  it("serves the viewers from the dev server, as they are in their packages", () => {
    let middleware: (req: unknown, res: unknown, next: () => void) => void = () => {};
    const plugin = spaceViewers(root);
    (plugin.configureServer as (s: unknown) => void)({
      middlewares: { use: (f: typeof middleware) => (middleware = f) },
    });

    const headers: Record<string, string> = {};
    const res = { statusCode: 0, setHeader: (k: string, v: string) => (headers[k] = v), end: vi.fn() };
    const next = vi.fn();
    middleware({ url: "/spaces/torus.html", method: "GET" }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(headers["content-type"]).toMatch(/^text\/html/);
    // Buffer.equals: a deep comparison of megabytes is slow
    expect(readFileSync(resolve(root, "packages/torus/viz/index.html")).equals(res.end.mock.calls[0][0])).toBe(true);

    middleware({ url: "/spaces.html", method: "GET" }, res, next);
    middleware({ url: "/spaces/torus.html", method: "POST" }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("writes every viewer into the build output", () => {
    const emitted: { fileName: string; source: Buffer }[] = [];
    const plugin = spaceViewers(root);
    (plugin.generateBundle as (this: unknown) => void).call({ emitFile: (f: (typeof emitted)[0]) => emitted.push(f) });
    expect(emitted.map((f) => f.fileName).sort()).toEqual(Object.keys(SPACE_VIEWERS).sort());
    for (const f of emitted)
      expect(readFileSync(resolve(root, SPACE_VIEWERS[f.fileName])).equals(f.source), f.fileName).toBe(true);
  });
});
