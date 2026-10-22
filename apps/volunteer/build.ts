/**
 * Builds the single-file client, dist/polypack-volunteer.mjs: an ES module with the solver and
 * geometry inlined that runs with plain `node` (24 or newer) and no other files.
 *
 *   npm run build:volunteer          (from the repository root)
 *
 * __POLYPACK_BUNDLE__ tells the code that it is bundled, so that its search threads run the
 * bundle itself (src/bundle.ts). esbuild is external: only the development path imports it.
 */
import { chmodSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTFILE = join(here, "dist", "polypack-volunteer.mjs");

export async function buildBundle(outfile = DEFAULT_OUTFILE): Promise<string> {
  await build({
    entryPoints: [join(here, "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    banner: { js: "#!/usr/bin/env node" },
    define: { __POLYPACK_BUNDLE__: "true" },
    external: ["esbuild"],
    // readable rather than minified, so that a volunteer can see what runs on their machine
    minify: false,
    legalComments: "inline",
    logLevel: "warning",
  });
  chmodSync(outfile, 0o755);
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = await buildBundle(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUTFILE);
  console.log(`built ${outfile} (${(statSync(outfile).size / 1024).toFixed(0)} kB)`);
}
