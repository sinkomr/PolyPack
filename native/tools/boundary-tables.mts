// Writes the tables of the boundary family for the Rust port (native/PORTING.md rule 6): the six regular 4-polytopes as
// packages/boundary/src/polytope.ts builds them (getPolytope), with the dihedral angle of every hinge of every cell (the one
// field of the engine's topology cache that comes from a transcendental function), and the five Platonic pieces as
// packages/boundary/src/pieces.ts builds them (pieceShape). The Rust crate reads them with include_str!.
//
//   node --import tsx native/tools/boundary-tables.mts            writes native/boundary/data/*.json
//   node --import tsx native/tools/boundary-tables.mts --check    fails when a file is out of date
//
// Numbers are written by JSON.stringify (the shortest text that reads back as the same double), so the tables hold the
// TypeScript's doubles bit for bit. JSON.stringify writes -0 as 0, so a -0 (the pieces' face normals have some) is written
// as -0.0, which JSON readers (serde_json, JSON.parse) read back as -0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POLYTOPES, POLYTOPE_PIECES, getPolytope, pieceShape } from "../../packages/boundary/src/index.ts";
import { topo } from "../../packages/boundary/src/polytope.ts";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "boundary", "data");
const check = process.argv.includes("--check");

const NEG_ZERO = "\u0000-0";
/** JSON text of a table of finite numbers, with -0 kept. */
function stringify(table: unknown): string {
  const text = JSON.stringify(table, (_key, v: unknown) => {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("a table holds a number that is not finite");
      if (Object.is(v, -0)) return NEG_ZERO;
    }
    return v;
  });
  return text.replaceAll(JSON.stringify(NEG_ZERO), "-0.0") + "\n";
}

const files = new Map<string, string>();
for (const name of POLYTOPES) {
  const p = getPolytope(name);
  const t = topo(p);
  const table = {
    name: p.name,
    d: p.d,
    vertices: p.vertices,
    cells: p.cells.map((c, i) => ({
      index: c.index,
      normal: c.normal,
      origin: c.origin,
      frame: c.frame,
      vertices: c.vertices,
      hinges: c.hinges,
      facets: c.facets,
      vertexIds: c.vertexIds,
      hingeDihedral: t.cells[i].hingeDihedral,
    })),
    hingeAngle: p.hingeAngle,
    edges: p.edges,
    edgeAngles: p.edgeAngles,
  };
  files.set(`polytope-${name}.json`, stringify(table));
}
{
  const table = Object.fromEntries(POLYTOPE_PIECES.map((n) => [n, pieceShape(n)]));
  files.set("pieces.json", stringify(table));
}

let stale = 0;
if (!check) mkdirSync(dataDir, { recursive: true });
for (const [file, text] of files) {
  const path = join(dataDir, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      console.error(`${file} is out of date: run node --import tsx native/tools/boundary-tables.mts`);
      stale++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`${file}: ${text.length} bytes`);
  }
}
if (check) {
  if (stale) process.exit(1);
  console.log(`${files.size} tables are up to date`);
}
