// Line and block coverage of apps/server/src/ from the V8 coverage files that the reference
// server wrote while the scenarios were replayed (run.mts --coverage).
//
//   node --import tsx native/tools/serverdiff/coverage.mts DIR/coverage [MORE/coverage ...] [--ranges]
//
// The server runs as code that tsx compiled, so each file's source map (kept by Node in the
// coverage file) takes a position of the compiled code back to its line of the source.
//   lines   a line counts when the compiled code has a token of it; it is covered when one of its
//           tokens ran in some process, and "partly" covered when another of its tokens never ran
//           (a branch of that line not taken);
//   blocks  the ranges V8 counts apart inside the functions that ran (the arms of an `if`, of `?:`,
//           `??`, `&&`, `||`, loop bodies, the code after a `return`), plus one per function; a
//           block is covered when it ran in some process. This is V8's notion of a branch.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}
interface V8Script {
  url: string;
  functions: { functionName: string; ranges: V8Range[]; isBlockCoverage: boolean }[];
}
interface MapEntry {
  lineLengths: number[];
  data: { mappings: string; sources: string[] };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** The segments of a source map: [generated line, generated column, source index, source line]. */
function decodeMappings(mappings: string): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let genLine = 0;
  let src = 0;
  let line = 0;
  let col = 0;
  for (const lineText of mappings.split(";")) {
    let genCol = 0;
    for (const seg of lineText.split(",")) {
      if (!seg) continue;
      const v: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        const d = B64.indexOf(ch);
        value += (d & 31) << shift;
        if (d & 32) shift += 5;
        else {
          v.push(value & 1 ? -(value >> 1) : value >> 1);
          value = 0;
          shift = 0;
        }
      }
      genCol += v[0]!;
      if (v.length >= 4) {
        src += v[1]!;
        line += v[2]!;
        col += v[3]!;
        out.push([genLine, genCol, src, line]);
      }
    }
    genLine++;
  }
  return out;
}

export interface FileCoverage {
  file: string;
  lines: number;
  linesCovered: number;
  /** Covered lines with a token that never ran. */
  partial: number[];
  blocks: number;
  blocksCovered: number;
  /** Runs of lines with no token that ran: [first, last]. */
  uncovered: [number, number][];
}

export function coverageOf(dirs: string | string[], under = "/apps/server/src/"): FileCoverage[] {
  const files = (Array.isArray(dirs) ? dirs : [dirs]).flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => join(d, f)));
  /** Per file: for each offset of the compiled code, how often it ran, summed over the processes. */
  const hits = new Map<string, Float64Array>();
  const maps = new Map<string, MapEntry>();
  const blocks = new Map<string, Map<string, number>>();
  for (const name of files) {
    const j = JSON.parse(readFileSync(name, "utf8")) as { result: V8Script[]; "source-map-cache"?: Record<string, MapEntry> };
    for (const script of j.result) {
      if (!script.url.includes(under)) continue;
      const map = j["source-map-cache"]?.[script.url];
      if (!map) continue;
      maps.set(script.url, map);
      const size = map.lineLengths.reduce((n, l) => n + l + 1, 0);
      const mine = new Float64Array(size);
      const all = script.functions.flatMap((f) => f.ranges.map((r, i) => ({ ...r, first: i === 0 })));
      // outer ranges first, so that the innermost range has the last word on each offset
      all.sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
      for (const r of all) mine.fill(r.count, r.startOffset, Math.min(size, r.endOffset));
      let sum = hits.get(script.url);
      if (!sum) hits.set(script.url, (sum = new Float64Array(size)));
      for (let i = 0; i < size; i++) sum[i]! += mine[i]!;
      let bl = blocks.get(script.url);
      if (!bl) blocks.set(script.url, (bl = new Map()));
      for (const r of all) {
        // the range of the whole file is not a block
        if (r.startOffset === 0 && r.endOffset >= size - 2) continue;
        const key = `${r.startOffset}-${r.endOffset}`;
        bl.set(key, (bl.get(key) ?? 0) + r.count);
      }
    }
  }
  const out: FileCoverage[] = [];
  for (const [url, sum] of hits) {
    const map = maps.get(url)!;
    const starts: number[] = [];
    let at = 0;
    for (const l of map.lineLengths) {
      starts.push(at);
      at += l + 1;
    }
    const lineHit = new Map<number, boolean>();
    const lineMiss = new Set<number>();
    for (const [genLine, genCol, , line] of decodeMappings(map.data.mappings)) {
      const offset = (starts[genLine] ?? 0) + genCol;
      const ran = (sum[offset] ?? 0) > 0;
      lineHit.set(line + 1, (lineHit.get(line + 1) ?? false) || ran);
      if (!ran) lineMiss.add(line + 1);
    }
    const lines = [...lineHit.keys()].sort((a, b) => a - b);
    const uncovered: [number, number][] = [];
    for (const l of lines) {
      if (lineHit.get(l)) continue;
      const last = uncovered[uncovered.length - 1];
      // lines without code between two uncovered lines belong to the same run
      if (last && !lines.some((x) => x > last[1] && x < l && lineHit.get(x))) last[1] = l;
      else uncovered.push([l, l]);
    }
    const bl = blocks.get(url)!;
    out.push({
      file: url.slice(url.indexOf(under) + 1),
      lines: lines.length,
      linesCovered: lines.filter((l) => lineHit.get(l)).length,
      partial: lines.filter((l) => lineHit.get(l) && lineMiss.has(l)),
      blocks: bl.size,
      blocksCovered: [...bl.values()].filter((c) => c > 0).length,
      uncovered,
    });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!dirs.length) {
    console.error("usage: node --import tsx native/tools/serverdiff/coverage.mts DIR/coverage [MORE/coverage ...] [--ranges]");
    process.exit(2);
  }
  const files = coverageOf(dirs);
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-").padStart(7);
  console.log(`${"file".padEnd(36)} ${"lines".padStart(11)} ${"".padStart(7)} ${"blocks".padStart(11)}`);
  const total = { l: 0, lc: 0, b: 0, bc: 0 };
  for (const f of files) {
    console.log(`${f.file.padEnd(36)} ${`${f.linesCovered}/${f.lines}`.padStart(11)} ${pct(f.linesCovered, f.lines)} ${`${f.blocksCovered}/${f.blocks}`.padStart(11)} ${pct(f.blocksCovered, f.blocks)}`);
    total.l += f.lines;
    total.lc += f.linesCovered;
    total.b += f.blocks;
    total.bc += f.blocksCovered;
  }
  console.log(`${"all".padEnd(36)} ${`${total.lc}/${total.l}`.padStart(11)} ${pct(total.lc, total.l)} ${`${total.bc}/${total.b}`.padStart(11)} ${pct(total.bc, total.b)}`);
  if (process.argv.includes("--ranges"))
    for (const f of files) {
      console.log(`\n${f.file}`);
      console.log(`  not run: ${f.uncovered.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ") || "(none)"}`);
      console.log(`  partly run: ${f.partial.join(", ") || "(none)"}`);
    }
}
