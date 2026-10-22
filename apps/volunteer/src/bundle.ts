/**
 * Where the search threads' code comes from.
 *
 * In the single-file bundle (build.ts defines __POLYPACK_BUNDLE__), a thread runs the bundle
 * itself: the user needs one file and plain `node`. In development (tsx, vitest) the sources are
 * TypeScript, and threads do not reliably inherit tsx's loader (on Node 22 a thread loads a .ts
 * entry natively and then fails on the sources' extensionless imports), so worker-entry.ts is
 * bundled into a temporary JavaScript file first, as scripts/batch-search.ts does.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

declare const __POLYPACK_BUNDLE__: boolean | undefined;

/** True in the single-file bundle. */
export const BUNDLED = typeof __POLYPACK_BUNDLE__ !== "undefined" && __POLYPACK_BUNDLE__ === true;

let devWorker: Promise<URL> | null = null;

/** The file a search thread runs. */
export function workerScript(): Promise<URL> {
  if (BUNDLED) return Promise.resolve(new URL(import.meta.url));
  return (devWorker ??= buildDevWorker());
}

async function buildDevWorker(): Promise<URL> {
  // esbuild is a development dependency: the bundle marks it external and never gets here
  const { build } = await import("esbuild");
  const outfile = join(tmpdir(), `polypack-volunteer-worker-${process.pid}-${randomUUID().slice(0, 8)}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL("./worker-entry.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "error",
  });
  process.on("exit", () => rmSync(outfile, { force: true }));
  return pathToFileURL(outfile);
}
