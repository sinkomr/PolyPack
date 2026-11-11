// Writes the fixture that holds the Rust port's builders of the boundary family to the TypeScript's: the six regular
// 4-polytopes as packages/boundary/src/polytope.ts builds them (getPolytope, with the engine's topology cache, topo) and
// the five Platonic pieces as packages/boundary/src/pieces.ts builds them (pieceShape), each as its counts, a hash of
// its whole numbers (the structure), and the count, a hash of the bits and the sum of its doubles.
//
//   node --import tsx native/tools/boundary-tables.mts            writes native/boundary/tests/fixtures/builders.json
//   node --import tsx native/tools/boundary-tables.mts --check    fails when that file is out of date
//
// RUN IT UNDER NODE 24 ON LINUX x86-64, the production platform (native/tools/LINUX_REFERENCE.md says how, from any
// machine). The polytopes are computed with atan2, cos, sin and acos, and Node on an Apple Silicon Mac gives another
// last bit for a few of their arguments: under it this tool writes other hashes for the 16-cell, the 24-cell, the
// 120-cell and the 600-cell, and --check fails. (The crate once embedded the polytopes as tables written by this tool
// on such a Mac; 373 of their numbers were not the server's. It now builds them with the ported builder, which
// `cargo test -p polypack-boundary` checks against this fixture: native/boundary/src/polytope.rs.)
//
// The lists that are hashed, in order (native/boundary/tests/port.rs builds the same lists from the Rust structures):
//   a polytope's whole numbers: for each cell its index, vertexIds, hinges, then for each facet neighbor,
//     neighborFacet and vertices, then the cell's pairHinge and hingeEdge (topo); then the polytope's edges;
//   a polytope's doubles: its vertices; for each cell normal, origin, frame, vertices, then for each facet inside.n,
//     inside.h, toNeighbor.A and toNeighbor.b, then the cell's hingeDihedral and each facet's glue (m, t) (topo); then
//     hingeAngle, edgeAngles and boundaryVolume;
//   a piece's whole numbers: for each face its length and its vertices; then the edges;
//   a piece's doubles: vertices, normals, inradius, circumradius, midradius, volume, mirror, edgeDirs.
// The hash is FNV-1a on 32 bits, of each whole number, and of the high and then the low 32 bits of each double (so a
// -0 is not a 0); the sum is taken from left to right from 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POLYTOPES, POLYTOPE_PIECES, getPolytope, pieceShape } from "../../packages/boundary/src/index.ts";
import { boundaryVolume, topo } from "../../packages/boundary/src/polytope.ts";

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "boundary", "tests", "fixtures", "builders.json");
const check = process.argv.includes("--check");

const PRIME = 0x01000193;
const hashInts = (list: number[]): number => {
  let h = 0x811c9dc5;
  for (const v of list) {
    if (!Number.isInteger(v)) throw new Error(`${v} is not a whole number`);
    h = Math.imul(h ^ v, PRIME) >>> 0;
  }
  return h;
};
const view = new DataView(new ArrayBuffer(8));
const hashBits = (list: number[]): number => {
  let h = 0x811c9dc5;
  for (const x of list) {
    if (!Number.isFinite(x)) throw new Error("a builder gave a number that is not finite");
    view.setFloat64(0, x);
    h = Math.imul(h ^ view.getUint32(0), PRIME) >>> 0;
    h = Math.imul(h ^ view.getUint32(4), PRIME) >>> 0;
  }
  return h;
};
const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0);

const polytopes = POLYTOPES.map((name) => {
  const p = getPolytope(name);
  const t = topo(p);
  const ints: number[] = [];
  const doubles: number[] = [...p.vertices.flat()];
  p.cells.forEach((c, i) => {
    const ct = t.cells[i];
    ints.push(c.index, ...c.vertexIds, ...c.hinges.flat());
    doubles.push(...c.normal, ...c.origin, ...c.frame.flat(), ...c.vertices.flat());
    for (const f of c.facets) {
      ints.push(f.neighbor, f.neighborFacet, ...f.vertices);
      doubles.push(...f.inside.n, f.inside.h, ...f.toNeighbor.A.flat(), ...f.toNeighbor.b);
    }
    ints.push(...ct.pairHinge, ...t.hingeEdge[i]);
    doubles.push(...ct.hingeDihedral);
    for (const g of ct.glue) doubles.push(...g.m, ...g.t);
  });
  ints.push(...p.edges.flat());
  const volume = boundaryVolume(p);
  doubles.push(p.hingeAngle, ...p.edgeAngles, volume);
  return {
    name: p.name,
    d: p.d,
    vertices: p.vertices.length,
    cells: p.cells.length,
    facets: sum(p.cells.map((c) => c.facets.length)),
    hinges: sum(p.cells.map((c) => c.hinges.length)),
    edges: p.edges.length,
    ints: ints.length,
    structure: hashInts(ints),
    doubles: doubles.length,
    bits: hashBits(doubles),
    sum: sum(doubles),
    hingeAngle: p.hingeAngle,
    volume,
  };
});

const pieces = POLYTOPE_PIECES.map((name) => {
  const s = pieceShape(name);
  const ints = [...s.faces.flatMap((f) => [f.length, ...f]), ...s.edges.flat()];
  const doubles = [...s.vertices.flat(), ...s.normals.flat(), s.inradius, s.circumradius, s.midradius, s.volume, ...s.mirror, ...s.edgeDirs.flat()];
  return {
    name: s.name,
    vertices: s.vertices.length,
    faces: s.faces.length,
    edges: s.edges.length,
    edgeDirs: s.edgeDirs.length,
    ints: ints.length,
    structure: hashInts(ints),
    doubles: doubles.length,
    bits: hashBits(doubles),
    sum: sum(doubles),
    inradius: s.inradius,
    circumradius: s.circumradius,
    midradius: s.midradius,
    volume: s.volume,
  };
});

const rows = (list: object[]) => list.map((r) => JSON.stringify(r)).join(",\n");
const platform = `Node ${process.versions.node} (V8 ${process.versions.v8}) on ${process.platform}/${process.arch}`;
const text = `{"writtenBy":${JSON.stringify(platform)},\n"polytopes":[\n${rows(polytopes)}\n],\n"pieces":[\n${rows(pieces)}\n]}\n`;
// the line that names the platform is not compared: the same numbers from another Node 24 are the same fixture
const body = (t: string) => t.slice(t.indexOf("\n") + 1);

if (check) {
  if (!existsSync(target) || body(readFileSync(target, "utf8")) !== body(text)) {
    console.error(`${target} is out of date (this is ${platform}): run node --import tsx native/tools/boundary-tables.mts under Node 24 on Linux x86-64`);
    process.exit(1);
  }
  console.log(`${target} is up to date (${polytopes.length} polytopes, ${pieces.length} pieces; this is ${platform})`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  console.log(`${target}: ${text.length} bytes, written by ${platform}`);
}
