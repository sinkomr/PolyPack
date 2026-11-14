// The TypeScript side of the comparison of the SQLite store (apps/server/src/sqlite-store.ts) with its Rust port
// (native/server/src/store). It drives the TypeScript SqliteStore on a database file and writes every call and its
// JSON result; native/server/examples/storediff.rs replays the same calls with the Rust store, and
// native/tools/store-compare.mjs compares the results and the two database files. native/tools/store-diff.sh runs all of it.
//
//   node --import tsx native/tools/store-ref.mts gen OUTDIR SEED COUNT SNAPDIR SPACESNAPDIR
//       a seeded random sequence of COUNT calls of every method, made while running it on OUTDIR/ts.sqlite:
//       writes calls.jsonl, ts.jsonl (the results), spaceids.json
//   node --import tsx native/tools/store-ref.mts old KIND OUTDIR SNAPDIR SPACESNAPDIR
//       a database as an older server left it (OUTDIR/old.sqlite), the calls to make on it (calls.jsonl), and the
//       call at which the crossed runs change hands (cut.txt). KIND: prediet (JSON pieces, no meta table), ancient
//       (the first schema: no provenance columns, no tallies, the narrow index), partial (half-way between),
//       preunits (today's schema in the old units, no epoch marker), epoch1 (as the reverse conversion left it),
//       poison (preunits with a row whose pieces cannot be read: the store refuses to open)
//   node --import tsx native/tools/store-ref.mts run CALLS DB FROM TO OUT [leave]
//       opens DB with the TypeScript store and makes the calls FROM <= i < TO, appending the results to OUT
//   node --import tsx native/tools/store-ref.mts fixtures DIR
//       the fixtures of `cargo test -p polypack-server` (answers of the TypeScript for the ported unit tests)
//
// The clocks the store reads (performance.now for the timings in its log, Date.now for the pace of the migration's
// progress lines) and setTimeout are replaced here by counters, so that a run gives the same log on both sides. No
// source file of the server is changed.
import { appendFileSync, createReadStream, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { crc32, createGunzip, zstdCompressSync } from "node:zlib";
import { SPACE_NAMES, isSpaceName, parseSpaceId } from "../../packages/spaces/src/index.ts";
import { blobFromJson, decodePieces, encodePieces, packPieces, unpackPieces } from "../../apps/server/src/pieces.ts";
import { SqliteStore } from "../../apps/server/src/sqlite-store.ts";
import {
  migrateUnits,
  planarFactors,
  spacePlan,
  unitsDigest,
  unitsEpoch,
} from "../../apps/server/src/units-migration.ts";

// ---- the clocks -----------------------------------------------------------------------------------------------

/** performance.now() advances 4.25 ms a call, Date.now() 25 s a call: exact in binary, so differences are exact. */
let perf = 0;
let date = 1_800_000_000_000;
const delays: number[] = [];
function mockClocks() {
  perf = 0;
  date = 1_800_000_000_000;
  // Only the store's own readings count: tsx reads Date.now() too, in an immediate of its own (the expiry of its
  // disk cache), at a moment that depends on the event loop, which would shift the counter in some runs.
  const realDateNow = Date.now.bind(Date), realPerfNow = globalThis.performance.now.bind(globalThis.performance);
  const fromStore = () => /apps\/server\/src\/(sqlite-store|units-migration)\.ts/.test(new Error().stack ?? "");
  globalThis.performance.now = () => (fromStore() ? (perf += 4.25) : realPerfNow());
  Date.now = () => (fromStore() ? (date += 25_000) : realDateNow());
  const realSetTimeout = globalThis.setTimeout;
  // the delays the store asks for are recorded and not waited for; the store's unref() of its timer is not passed
  // on, since nothing else keeps this process alive while it waits for the migration to finish
  (globalThis as any).setTimeout = (fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    realSetTimeout(fn, 0);
    return { unref() {} };
  };
}

// ---- the statements the store sends to SQLite ------------------------------------------------------------------

/**
 * With STORE_TRACE=FILE in the environment, every statement the store prepares (P), steps with its bound values (S)
 * or executes (E) is appended to FILE, those of the constructor included: the driver's methods are wrapped on its
 * prototypes. storediff.rs writes the same lines for the Rust store.
 */
function traceStatements() {
  const file = process.env.STORE_TRACE;
  if (!file) return;
  const lines: string[] = [];
  const flush = () => { if (lines.length) appendFileSync(file, lines.join("\n") + "\n"); lines.length = 0; };
  process.on("exit", flush);
  const shown = (v: unknown) => (v === null ? "null" : typeof v === "number" ? String(v) : typeof v === "string" ? JSON.stringify(v) : "x" + Buffer.from(v as Uint8Array).toString("hex"));
  const proto = DatabaseSync.prototype as any;
  const prepare = proto.prepare, exec = proto.exec;
  proto.exec = function (sql: string) { lines.push(`E ${JSON.stringify(sql)}`); return exec.call(this, sql); };
  proto.prepare = function (sql: string) {
    lines.push(`P ${JSON.stringify(sql)}`);
    const st = prepare.call(this, sql);
    for (const m of ["run", "get", "all"] as const) {
      const real = st[m].bind(st);
      st[m] = (...values: unknown[]) => { lines.push(`S ${JSON.stringify(sql)} [${values.map(shown).join(",")}]`); if (lines.length > 5000) flush(); return real(...values); };
    }
    return st;
  };
}

// ---- values that JSON cannot carry ----------------------------------------------------------------------------

/** NaN, the infinities and -0 travel in the calls as {"$num": "NaN"} and so on. */
function enc(v: unknown): unknown {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $num: "NaN" };
    if (v === Infinity) return { $num: "Infinity" };
    if (v === -Infinity) return { $num: "-Infinity" };
    if (Object.is(v, -0)) return { $num: "-0" };
    return v;
  }
  if (Array.isArray(v)) return v.map(enc);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
  return v;
}
function dec(v: unknown): any {
  if (Array.isArray(v)) return v.map(dec);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.$num === "string") return o.$num === "-0" ? -0 : Number(o.$num);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, dec(x)]));
  }
  return v;
}

// ---- one call -------------------------------------------------------------------------------------------------

type Call = { op: string; [k: string]: unknown };
const rawDb = (store: SqliteStore) => (store as unknown as { db: DatabaseSync }).db;

async function perform(store: SqliteStore, c: any): Promise<unknown> {
  switch (c.op) {
    case "submit": return store.submit(c.s);
    case "insert": return store.insert(c.s);
    case "get": return store.get(c.id);
    case "get_many": return store.getMany(c.ids);
    case "leader": return store.leader(c.N, c.M, c.P);
    case "count": return store.count(c.N, c.M, c.P);
    case "prune": return store.prune(c.N, c.M, c.P);
    case "rank": return store.rank(c.N, c.M, c.P, c.id);
    case "best_per_p": return c.verified === undefined ? store.bestPerP(c.N, c.M) : store.bestPerP(c.N, c.M, c.verified);
    case "pairs": return store.pairs();
    case "leaders": return store.leaders();
    case "leaders_after": return store.leadersAfter(c.after, c.limit);
    case "leaders_of": return store.leadersOf(c.problems);
    case "problems_named": return store.problemsNamed(c.name, c.after, c.limit);
    case "holder_peaks": return store.holderPeaks();
    case "raise_holder_peaks": return store.raiseHolderPeaks(c.rows);
    case "pending": return store.pending();
    case "review": return store.review(c.id, c.decision);
    case "remove": return store.remove(c.id);
    case "edit": return store.edit(c.id, c.changes);
    case "space_submit": return store.spaceSubmit(c.e);
    case "space_get": return store.spaceGet(c.id);
    case "space_leader": return store.spaceLeader(c.space, c.problem);
    case "space_best": return store.spaceBest(c.space);
    case "space_leaders": return store.spaceLeaders();
    case "space_leaders_of": return store.spaceLeadersOf(c.problems);
    case "space_remove": return store.spaceRemove(c.id);
    case "space_edit": return store.spaceEdit(c.id, c.changes);
    case "pieces_migrated": return store.piecesMigrated();
    case "migrate_pieces": return store.migratePieces(c.batch);
    case "start_pieces_migration": {
      const log: string[] = [];
      delays.length = 0;
      const run = store.startPiecesMigration({ batch: c.batch, pauseMs: c.pauseMs, logEveryMs: c.logEveryMs, log: (m) => log.push(m) });
      await run.finished;
      return { log, delays: [...delays] };
    }
    case "units_epoch": return unitsEpoch(rawDb(store));
    case "units_migrate": return migrateUnits(rawDb(store), c.reverse);
    case "units_digest": return unitsDigest(rawDb(store));
    case "exec": return rawDb(store).exec(c.sql);
    default: throw new Error(`unknown op ${c.op}`);
  }
}

/** The result of a call as one line of JSON; an error as its class and message (a SyntaxError of JSON.parse by its class only: V8's wording is not ported). */
async function resultLine(store: SqliteStore, call: Call): Promise<string> {
  try {
    const r = await perform(store, dec(call));
    return JSON.stringify(r ?? null);
  } catch (e) {
    const err = e as Error;
    return JSON.stringify({ error: err.name === "SyntaxError" ? { name: err.name } : { name: err.name, message: err.message } });
  }
}

/** Opens the store as the server does and returns the line that records what the constructor did. */
function open(path: string, units: "migrate" | "leave"): { store: SqliteStore | null; line: string } {
  const log: string[] = [];
  try {
    const store = new SqliteStore(path, { units, log: (m) => log.push(m) });
    return { store, line: JSON.stringify({ open: { unitsReport: store.unitsReport, log, piecesMigrated: store.piecesMigrated() } }) };
  } catch (e) {
    const err = e as Error;
    return { store: null, line: JSON.stringify({ open: { error: { name: err.name, message: err.message }, log } }) };
  }
}

// ---- real boards and space entries ----------------------------------------------------------------------------

type Pose = { x: number; y: number; theta: number };
type Board = { N: number; M: number; P: number; score: number; pieces: Pose[]; container_phi: number };
type SpaceRec = { space: string; problem: string; score: number; config: unknown; software: string | null; method: string | null };

/**
 * Boards of a snapshot file (one piece shape, its containers in turn): every `every`-th record, at most four per
 * container, until `take` are found; the file is read no further than that.
 */
async function readBoards(file: string, every: number, take: number): Promise<Board[]> {
  const out: Board[] = [];
  let N = 0, M = 0, seen = 0, ofM = 0;
  const stream = createReadStream(file);
  const rl = createInterface({ input: stream.pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    const mN = /^\{"format":\d+,"N":(\d+)/.exec(line); if (mN) N = +mN[1];
    const mM = /"M":(\d+),"records"/.exec(line); if (mM) { M = +mM[1]; ofM = 0; seen = 0; }
    if (!line.startsWith('{"P":')) continue;
    if (ofM >= 4 || seen++ % every !== 0) continue;
    let text = line.trim().replace(/,$/, ""); let r: any = null;
    for (let k = 0; k < 4 && !r; k++) { try { r = JSON.parse(text); } catch { text = text.slice(0, -1); } }
    if (!r) throw new Error("unreadable record in " + file);
    ofM++;
    out.push({ N, M, P: r.P, score: r.score, container_phi: r.container_phi ?? 0, pieces: r.pieces.map((p: number[]) => ({ x: p[0], y: p[1], theta: p[2] ?? 0 })) });
    if (out.length >= take) break;
  }
  rl.close(); stream.destroy();
  return out;
}

async function readSpace(file: string, space: string, every: number, take: number): Promise<SpaceRec[]> {
  const out: SpaceRec[] = [];
  let seen = 0;
  const stream = createReadStream(file);
  const rl = createInterface({ input: stream.pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith('{"problem":')) continue;
    if (seen++ % every !== 0) continue;
    let text = line.trim().replace(/,$/, ""); let r: any = null;
    for (let k = 0; k < 4 && !r; k++) { try { r = JSON.parse(text); } catch { text = text.slice(0, -1); } }
    if (!r) throw new Error("unreadable record in " + file);
    out.push({ space, problem: r.problem, score: r.score, config: r.config, software: r.software ?? null, method: r.method ?? null });
    if (out.length >= take) break;
  }
  rl.close(); stream.destroy();
  return out;
}

const SNAP_NS = [0, 3, 4, 6, 37, 50, 67, 100];
async function loadData(snapDir: string, spaceDir: string, perFile: number) {
  const boards: Board[] = [];
  for (const n of SNAP_NS) {
    const f = `${snapDir}/n-${n}.json.gz`;
    // small boards from some shapes and large ones from the others (their BLOBs run over several pages of the file)
    if (existsSync(f)) boards.push(...(await readBoards(f, n % 2 ? 7 : 113, perFile)));
  }
  const spaces: SpaceRec[] = [];
  for (const s of SPACE_NAMES) {
    const f = `${spaceDir}/space-${s}.json.gz`;
    if (existsSync(f)) spaces.push(...(await readSpace(f, s, s === "polyhedra" || s === "surface" ? 5 : 3, perFile)));
  }
  return { boards, spaces };
}

// ---- the table of problem ids the Rust side reads instead of packages/spaces ----------------------------------

const idTable: Record<string, unknown> = {};
function noteSpaceId(space: string, id: string) {
  if (!isSpaceName(space)) return;
  const parsed = parseSpaceId(space, id);
  idTable[`${space}\n${id}`] = typeof parsed === "string" ? null : parsed.fields;
}
const writeIds = (dir: string) => writeFileSync(`${dir}/spaceids.json`, JSON.stringify({ names: SPACE_NAMES, ids: idTable }));

// ---- a seeded random sequence of calls ------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ["ann", "Ann", "bob", "ánn", "ann ", "Zoë 🙂", "x".repeat(40), "o'brien \"q\"", "bot-7", "名前", "a%", "tab\there"];
const NOTES = ["", "a note", "line\nbreak", "ünïcödé — dash", '{"json":"in a note"}'];
const SOFTWARE = [null, "polypack-volunteer/0.3.1", "my tool 1.0", "PolyPack board"];
const METHODS = ["asc", "basin_hopping", "penalty_method"];
const PARAMS = [null, { steps: 1000, T0: 0.5 }, { a: 1e21, b: 1e-7, c: -0, d: [1, 2.5, "x"], "10": 1, "2": 2, z: { deep: true } }, { text: "é\n\"q\"\\   / \u0001" }, {}];
const BUDGETS = [null, { evals: 100000 }, { time_s: 12.5 }, { evals: 5, time_s: 0.001 }];
const STRICT = [
  (size: number) => ({ ok: true, certifiedSize: size / (1 - 1e-8), eps: 1e-8 }),
  (size: number) => ({ ok: false, certifiedSize: size / (1 - 1e-8), eps: 1e-8, reason: "pieces 3 and 7 touch after shrinking" }),
];

async function gen(outDir: string, seed: number, count: number, snapDir: string, spaceDir: string) {
  mkdirSync(outDir, { recursive: true });
  for (const f of ["ts.sqlite", "ts.sqlite-wal", "ts.sqlite-shm", "calls.jsonl", "ts.jsonl"]) rmSync(`${outDir}/${f}`, { force: true });
  const { boards, spaces } = await loadData(snapDir, spaceDir, 24);
  const rnd = rng(seed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  // a few problems are hit again and again, so that entries lead, tie, lose and repeat
  const hot = Array.from({ length: 14 }, () => pick(boards));
  const hotSpaces = Array.from({ length: 10 }, () => pick(spaces));
  mockClocks();
  const { store, line } = open(`${outDir}/ts.sqlite`, "migrate");
  if (!store) throw new Error("the store did not open: " + line);
  const db = rawDb(store);
  const calls: string[] = [];
  const results: string[] = [line];
  let clock = Date.UTC(2026, 10, 1);
  const stamp = () => new Date((clock += int(1, 90_000))).toISOString();
  const liveIds = () => (db.prepare("SELECT id FROM submissions ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  const pendingIds = () => (db.prepare("SELECT id FROM submissions WHERE verification = 'pending'").all() as { id: number }[]).map((r) => r.id);
  const spaceIds = () => (db.prepare("SELECT id FROM space_entries ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  const maxId = () => ((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'submissions'").get() as { seq: number } | undefined)?.seq ?? 0);
  const maxSpaceId = () => ((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'space_entries'").get() as { seq: number } | undefined)?.seq ?? 0);
  const anyId = () => {
    const k = rnd();
    const live = liveIds();
    if (k < 0.6 && live.length) return pick(live);
    if (k < 0.85) return int(1, Math.max(1, maxId())); // often an entry deleted since
    return pick([0, -1, 999_999_999, 1.5, 1e300, 2 ** 53]);
  };
  const anySpaceId = () => {
    const k = rnd();
    const live = spaceIds();
    if (k < 0.6 && live.length) return pick(live);
    if (k < 0.85) return int(1, Math.max(1, maxSpaceId()));
    return pick([0, -3, 123_456_789, 2.5]);
  };
  const problemOf = (b: Board) => ({ N: b.N, M: b.M, P: b.P });
  const anyProblem = () => (rnd() < 0.8 ? problemOf(rnd() < 0.7 ? pick(hot) : pick(boards)) : { N: int(0, 9), M: int(0, 9), P: int(1, 30) });
  const anySpaceProblem = () => {
    const r = rnd() < 0.8 ? (rnd() < 0.7 ? pick(hotSpaces) : pick(spaces)) : null;
    return r ? { space: r.space, problem: r.problem } : { space: pick(["sphere", "nowhere", ""]), problem: pick(["sphere/3/6", "x", ""]) };
  };
  const provenance = () => {
    const k = rnd();
    if (k < 0.3) return { found_with: "hand", method: null, method_params: null, seed: null, budget: null, software: null };
    if (k < 0.75)
      return { found_with: rnd() < 0.8 ? "optimizer" : "optimizer_edited", method: pick(METHODS), method_params: pick(PARAMS), seed: rnd() < 0.8 ? int(0, 2 ** 31) : pick([0, 9007199254740991, null]), budget: pick(BUDGETS), software: pick(SOFTWARE) };
    if (k < 0.9) return { found_with: "external", method: null, method_params: null, seed: null, budget: null, software: pick(SOFTWARE) };
    return { found_with: null, method: null, method_params: null, seed: null, budget: null, software: null };
  };
  /** A score for a new entry of a problem, chosen against the leader it has now. */
  const scoreAgainst = (lead: number | null, own: number) => {
    if (lead === null) return own;
    const k = rnd();
    if (k < 0.22) return lead * (1 - rnd() * 0.02); // leads
    if (k < 0.34) return lead; // repeats the leader's score
    if (k < 0.46) return lead * (1 + 3e-10); // ties within the tolerance, later: does not lead
    if (k < 0.56) return lead * (1 - 4e-10); // smaller but within the tolerance: the earlier entry still leads
    if (k < 0.64) return lead * (1 + 2e-9); // just beyond the tolerance
    if (k < 0.7) return lead * (1 - 2e-9);
    return lead * (1 + rnd() * 0.3); // loses
  };
  const submission = () => {
    const b = rnd() < 0.75 ? pick(hot) : pick(boards);
    const lead = (db.prepare("SELECT MIN(score) AS s FROM submissions WHERE n = ? AND m = ? AND p = ? AND verification != 'rejected'").get(b.N, b.M, b.P) as { s: number | null }).s;
    const score = scoreAgainst(lead, b.score);
    const pending = rnd() < 0.12;
    const k = rnd();
    const pieces = k < 0.85 ? b.pieces : k < 0.95 ? b.pieces.map((p) => ({ x: p.x * (1 + 1e-12), y: p.y, theta: -p.theta })) : [{ x: -0, y: 0, theta: -0 }, ...b.pieces.slice(1)];
    return {
      N: b.N, M: b.M, P: b.P, score, name: pick(NAMES), agent_note: pick(NOTES), ...provenance(), pieces, container_phi: rnd() < 0.5 ? b.container_phi : (rnd() - 0.5) * 6,
      created_at: stamp(), verification: pending ? "pending" : "none", literature_value: pending ? score * 1.01 : null, strict_check: pending ? pick(STRICT)(score) : null,
    };
  };
  const spaceEntry = () => {
    const r = rnd() < 0.75 ? pick(hotSpaces) : pick(spaces);
    noteSpaceId(r.space, r.problem);
    const lead = (db.prepare("SELECT MIN(score) AS s FROM space_entries WHERE space = ? AND problem = ?").get(r.space, r.problem) as { s: number | null }).s;
    return { space: r.space, problem: r.problem, score: scoreAgainst(lead, r.score), name: pick(NAMES), agent_note: pick(NOTES), software: pick(SOFTWARE), method: rnd() < 0.5 ? r.method : null, seed: rnd() < 0.5 ? int(0, 1e9) : null, config: JSON.stringify(r.config), created_at: stamp() };
  };
  const afterKey = () => (rnd() < 0.3 ? null : anyProblem());

  const next = (): Call => {
    const k = rnd() * 100;
    if (k < 30) return { op: "submit", s: submission() };
    if (k < 33) return { op: "insert", s: submission() };
    if (k < 35) return { op: "prune", ...anyProblem() };
    if (k < 46) return { op: "space_submit", e: spaceEntry() };
    if (k < 50) return { op: "get", id: anyId() };
    if (k < 53) return { op: "get_many", ids: Array.from({ length: int(0, 12) }, anyId) };
    if (k < 56) return { op: "leader", ...anyProblem() };
    if (k < 58) return { op: "count", ...anyProblem() };
    if (k < 60) return { op: "rank", ...anyProblem(), id: anyId() };
    if (k < 63) { const p = anyProblem(); const v = pick([undefined, false, true]); return v === undefined ? { op: "best_per_p", N: p.N, M: p.M } : { op: "best_per_p", N: p.N, M: p.M, verified: v }; }
    if (k < 64) return { op: "pairs" };
    if (k < 65.5) return { op: "leaders" };
    if (k < 68) return { op: "leaders_after", after: afterKey(), limit: pick([1, 2, 5, 50, 1000]) };
    if (k < 70) return { op: "leaders_of", problems: Array.from({ length: int(0, 8) }, anyProblem) };
    if (k < 72.5) return { op: "problems_named", name: pick([...NAMES, "nobody", "an_"]), after: afterKey(), limit: pick([1, 3, 100]) };
    if (k < 73.5) return { op: "pending" };
    if (k < 76) { const p = pendingIds(); return { op: "review", id: rnd() < 0.75 && p.length ? pick(p) : anyId(), decision: pick(["confirmed", "rejected"]) }; }
    if (k < 78) return { op: "remove", id: anyId() };
    if (k < 81) {
      const changes: Record<string, unknown> = {};
      if (rnd() < 0.5) changes.name = pick(NAMES);
      if (rnd() < 0.4) changes.agent_note = pick(NOTES);
      if (rnd() < 0.35) changes.provenance = provenance();
      return { op: "edit", id: anyId(), changes };
    }
    if (k < 83) return { op: "holder_peaks" };
    if (k < 85) return { op: "raise_holder_peaks", rows: Array.from({ length: int(0, 4) }, () => ({ name: pick(NAMES), peak: int(1, 40) })) };
    if (k < 87) return { op: "space_get", id: anySpaceId() };
    if (k < 89) return { op: "space_leader", ...anySpaceProblem() };
    if (k < 90.5) return { op: "space_best", space: pick([...SPACE_NAMES, "nowhere"]) };
    if (k < 91.5) return { op: "space_leaders" };
    if (k < 93) return { op: "space_leaders_of", problems: Array.from({ length: int(0, 8) }, anySpaceProblem) };
    if (k < 94.5) return { op: "space_remove", id: anySpaceId() };
    if (k < 96.5) {
      const changes: Record<string, unknown> = {};
      if (rnd() < 0.6) changes.name = pick(NAMES);
      if (rnd() < 0.4) changes.agent_note = pick(NOTES);
      return { op: "space_edit", id: anySpaceId(), changes };
    }
    if (k < 97) return { op: "pieces_migrated" };
    if (k < 97.5) return { op: "migrate_pieces", batch: pick([1, 50]) };
    if (k < 98) return { op: "units_epoch" };
    if (k < 98.3) return { op: "units_digest" };
    // what the caller must not do, and values on the edge: the same refusal, and nothing written
    return pick<() => Call>([
      () => ({ op: "get_many", ids: Array.from({ length: 501 }, (_, i) => i + 1) }),
      () => ({ op: "get_many", ids: Array.from({ length: 500 }, (_, i) => i + 1) }),
      () => ({ op: "leaders_after", after: null, limit: pick([0, 1.5, -1, NaN, Infinity, 1e300, 2 ** 32, 2 ** 63]) }),
      () => ({ op: "problems_named", name: "ann", after: null, limit: pick([0, 2.5, NaN, 1e300, 2 ** 53]) }),
      () => ({ op: "get", id: pick([NaN, Infinity, -Infinity, -0, 1e19]) }),
      () => ({ op: "rank", N: 4, M: 4, P: 1, id: pick([NaN, 0.5, 1e19]) }),
      () => ({ op: "leader", N: pick([NaN, 0.5, -0]), M: pick([Infinity, 4]), P: 1.5 }),
      () => ({ op: "leaders_of", problems: Array.from({ length: 501 }, (_, i) => ({ N: 4, M: 4, P: i + 1 })) }),
      () => ({ op: "leaders_of", problems: Array.from({ length: 500 }, (_, i) => ({ N: pick(hot).N, M: pick(hot).M, P: i + 1 })) }),
      () => ({ op: "space_leaders_of", problems: Array.from({ length: 501 }, (_, i) => ({ space: "sphere", problem: `sphere/3/${i + 1}` })) }),
      () => ({ op: "migrate_pieces", batch: pick([0, 1.5, -2, NaN]) }),
      () => ({ op: "submit", s: { ...submission(), score: NaN } }), // NOT NULL fails inside the transaction
      () => ({ op: "submit", s: { ...submission(), N: 99, M: 98, P: 1, score: pick([Infinity, 1e308, 5e-324]) } }),
      () => ({ op: "space_submit", e: { ...spaceEntry(), score: NaN } }),
      () => ({ op: "start_pieces_migration", batch: pick([0, 10]), pauseMs: 0 }),
      () => ({ op: "raise_holder_peaks", rows: [{ name: "ann", peak: NaN }] }),
    ])();
  };

  for (let i = 0; i < count; i++) {
    const call = enc(next()) as Call;
    calls.push(JSON.stringify(call));
    results.push(await resultLine(store, call));
  }
  db.close();
  writeFileSync(`${outDir}/calls.jsonl`, calls.join("\n") + "\n");
  writeFileSync(`${outDir}/ts.jsonl`, results.join("\n") + "\n");
  writeIds(outDir);
  const kinds = new Map<string, number>();
  for (const c of calls) { const op = JSON.parse(c).op; kinds.set(op, (kinds.get(op) ?? 0) + 1); }
  console.log(`${count} calls on ${boards.length} boards and ${spaces.length} space entries: ` + [...kinds].sort().map(([k, n]) => `${k} ${n}`).join(", "));
}

// ---- databases as older servers left them ---------------------------------------------------------------------

/** P poses with full-precision coordinates, different for every seed (as the source's tests make them). */
const poses = (P: number, seed: number): Pose[] =>
  Array.from({ length: P }, (_, i) => ({ x: Math.sin(seed * 7919 + i) * 1000, y: Math.cos(seed * 104729 + i) / 3, theta: (seed + i) * 0.1234567890123 }));
const TIE = 1e-9;

/** The schema the server had before pieces became BLOBs (the source's tests build the same). */
const PREDIET = `PRAGMA journal_mode = WAL;
    CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL,
      p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '',
      agent_note TEXT NOT NULL, pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT, found_with TEXT,
      method TEXT, method_params TEXT, seed INTEGER, budget TEXT, software TEXT);
    CREATE INDEX submissions_verification ON submissions (verification);
    CREATE INDEX submissions_listing
      ON submissions (n, m, p, score, id, verification, name, found_with, agent_note, created_at);
    CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
      PRIMARY KEY (n, m, p));`;
/** The first deployment's schema: no provenance columns, no tallies, the narrow index. */
const ANCIENT = `PRAGMA journal_mode = WAL;
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      n INTEGER NOT NULL,
      m INTEGER NOT NULL,
      p INTEGER NOT NULL,
      score REAL NOT NULL,
      name TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT '',
      agent_note TEXT NOT NULL,
      pieces TEXT NOT NULL,
      container_phi REAL NOT NULL,
      created_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'none',
      literature_value REAL,
      strict_check TEXT
    );
    CREATE INDEX submissions_verification ON submissions (verification);
    CREATE INDEX submissions_problem ON submissions (n, m, p, score, id);`;

type OldRow = { n: number; m: number; p: number; score: number; v?: string; pieces: Pose[] | string | Uint8Array; lit?: number | null; strict?: string | null; name?: string };

/** Rows of every kind an older database held: near-ties, claims, rejected rows, text that is not a list of poses, and problems the unit change touches. */
function oldRows(boards: Board[]): OldRow[] {
  const rows: OldRow[] = [
    { n: 4, m: 4, p: 2, score: 2.2, pieces: poses(2, 1) },
    { n: 4, m: 4, p: 2, score: 2.0, pieces: poses(2, 2) },
    { n: 4, m: 4, p: 2, score: 2.1, pieces: poses(2, 3) },
    { n: 4, m: 4, p: 3, score: 6.0, pieces: poses(3, 4) },
    { n: 4, m: 4, p: 3, score: 3.0, v: "pending", pieces: poses(3, 5), lit: 3.5, strict: JSON.stringify({ ok: true, certifiedSize: 3.00000003, eps: 1e-8 }) },
    { n: 4, m: 4, p: 3, score: 6.5, pieces: poses(3, 6) },
    { n: 4, m: 4, p: 5, score: 5.0, v: "confirmed", pieces: poses(5, 7), lit: 5.5 },
    { n: 4, m: 4, p: 5, score: 4.0, v: "rejected", pieces: poses(5, 8) },
    { n: 4, m: 4, p: 6, score: 6, pieces: poses(6, 9) },
    { n: 4, m: 4, p: 6, score: 6 * (1 + 0.3 * TIE), pieces: poses(6, 10) },
    { n: 4, m: 4, p: 6, score: 6 * (1 - 0.6 * TIE), pieces: poses(6, 11) },
    { n: 4, m: 4, p: 7, score: 7, pieces: '[{"x":1,"y":2}]' },
    { n: 4, m: 4, p: 8, score: 8, v: "rejected", pieces: poses(8, 13) },
    { n: 4, m: 4, p: 9, score: 9, pieces: [{ x: -0, y: 1e6, theta: -1e6 }, ...poses(8, 14)] },
    { n: 4, m: 4, p: 9, score: 9.5, pieces: poses(9, 15) },
    { n: 4, m: 4, p: 9, score: 9.7, pieces: poses(9, 16) },
    // two claims of one problem, which only the old code could leave (the known limitation the source's tests document)
    { n: 4, m: 4, p: 10, score: 1 + 1.5 * TIE, pieces: poses(10, 17) },
    { n: 4, m: 4, p: 10, score: 1 + 0.9 * TIE, v: "pending", pieces: poses(10, 18) },
    { n: 4, m: 4, p: 10, score: 1, v: "pending", pieces: poses(10, 19) },
    // text in other shapes: extra keys, another key order, exponents, spaces, not JSON at all, an empty list
    { n: 4, m: 4, p: 11, score: 11, pieces: '[{"x": 1e0, "y": -2.50E+1, "theta": 0.1e-3}, {"theta":1,"y":2,"x":3}]' },
    { n: 4, m: 4, p: 12, score: 12, pieces: '[{"x":1,"y":2,"theta":3,"extra":4}]' },
    { n: 4, m: 4, p: 13, score: 13, pieces: "not json" },
    { n: 4, m: 4, p: 14, score: 14, pieces: "[]" },
    { n: 4, m: 4, p: 15, score: 15, pieces: '[{"x":1e999,"y":2,"theta":3}]' },
    { n: 4, m: 4, p: 16, score: 16, pieces: '{"10":1,"b":2,"2":3}' },
    { n: 4, m: 4, p: 17, score: 17, pieces: "5" },
    { n: 4, m: 4, p: 18, score: 18, pieces: '"text"' },
    { n: 4, m: 4, p: 19, score: 19, pieces: "null" },
    // certificates that are not what the server writes
    { n: 0, m: 4, p: 2, score: 4.5, v: "confirmed", pieces: poses(2, 20), lit: 4.75, strict: "{oops" },
    { n: 0, m: 5, p: 2, score: 4.5, v: "confirmed", pieces: poses(2, 21), lit: 4.75, strict: "null" },
    { n: 0, m: 6, p: 2, score: 4.5, v: "confirmed", pieces: poses(2, 22), lit: 4.75, strict: '{"ok":true,"eps":1e-8,"certifiedSize":4.500000045,"1":"x"}' },
    { n: 0, m: 7, p: 2, score: 4.5, v: "confirmed", pieces: poses(2, 23), lit: null, strict: "" },
    { n: 0, m: 8, p: 2, score: 4.5, v: "confirmed", pieces: poses(2, 24), lit: 1e308, strict: '[1, 2.50]' },
  ];
  // problems the unit change touches, three entries each
  let seed = 100;
  for (const [n, m] of [[0, 0], [0, 3], [0, 5], [6, 0], [3, 0]] as const)
    for (const p of [1, 2, 7])
      for (const k of [0, 1, 2])
        rows.push({ n, m, p, score: p + 1 + 0.25 * k + (0.1 + 0.2), pieces: poses(p, seed++), v: k === 2 && p === 7 ? "pending" : "none", lit: k === 2 && p === 7 ? p + 2.125 : null, strict: k === 2 && p === 7 ? JSON.stringify({ ok: true, certifiedSize: (p + 1.5) / (1 - 1e-8), eps: 1e-8 }) : null });
  // real boards, as JSON text
  for (const b of boards.slice(0, 40)) rows.push({ n: b.N, m: b.M, p: b.P, score: b.score, pieces: b.pieces });
  for (const b of boards.slice(0, 12)) rows.push({ n: b.N, m: b.M, p: b.P, score: b.score * 1.05, pieces: b.pieces.map((q) => ({ ...q, x: q.x + 1 })) });
  return rows;
}

function fillOld(db: DatabaseSync, rows: OldRow[], provenance: boolean) {
  const add = provenance
    ? db.prepare(`INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification, literature_value, strict_check, found_with, method, seed)
        VALUES (?, ?, ?, ?, ?, '', ?, ?, '2026-10-12T00:00:00Z', ?, ?, ?, 'optimizer', 'asc', 7)`)
    : db.prepare(`INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at, verification, literature_value, strict_check)
        VALUES (?, ?, ?, ?, ?, 'ai', 'old note', ?, ?, '2026-10-02T00:00:00Z', ?, ?, ?)`);
  rows.forEach((r, i) =>
    add.run(r.n, r.m, r.p, r.score, r.name ?? `row ${i + 1}`, typeof r.pieces === "string" || r.pieces instanceof Uint8Array ? r.pieces : JSON.stringify(r.pieces), (i % 5) * 0.3, r.v ?? "none", r.lit ?? null, r.strict ?? null),
  );
  // a name that is not UTF-8, which only a hand-made row can hold
  db.exec("UPDATE submissions SET name = CAST(x'61ff62c3' AS TEXT) WHERE id = 3");
}

/** Space entries in the old units, of every class of the conversion, with configurations in awkward forms. */
function oldSpaceEntries(db: DatabaseSync, spaces: SpaceRec[]) {
  const ent = db.prepare(`INSERT INTO space_entries (space, problem, score, name, agent_note, software, method, seed, created_at, config) VALUES (?, ?, ?, ?, '', ?, ?, ?, '2026-10-20T00:00:00Z', ?)`);
  const A = 0.1 + 0.2, B = 1 / 3;
  const put = (space: string, problem: string, score: number, config: string, name = "ann") => { noteSpaceId(space, problem); ent.run(space, problem, score, name, null, null, null, config); };
  const P2 = [[0, 0, 0], [A, B, 1]];
  put("torus", "torus/sq/0/2", 4, JSON.stringify({ lattice: { L: 4 }, poses: P2 }));
  put("torus", "torus/free/0/2", 3, JSON.stringify({ lattice: { b1: [3, 0], b2: [1, 3] }, poses: P2 }));
  put("torus", "torus/sq/4/2", 5, JSON.stringify({ lattice: { L: 5 }, poses: P2 }));
  put("sphere", "sphere/0/3", 1.5, JSON.stringify({ rho: 1.5, pieces: [{ q: [1, 0, 0, 0] }] }));
  put("sphere", "sphere/4/3", 1.25, JSON.stringify({ rho: 1.25, pieces: [{ q: [1, 0, 0, 0] }] }));
  put("surface", "surface/cube/fold/0/3", 2 + A, JSON.stringify({ s: 2 + A, pieces: [{ face: 1, x: A, y: B, theta: 2 }] }));
  put("boundary", "boundary/tesseract/ball/3", 6, JSON.stringify({ s: 6, pieces: [{ cell: 2, u: [A, B, 1] }] }));
  put("boundary", "boundary/tesseract/cube/3", 7, JSON.stringify({ s: 7, pieces: [{ cell: 2, u: [A, B, 1], q: [1, 0, 0, 0] }] }));
  put("balls", "balls/ballinball/3", 5, JSON.stringify({ s: 5, pieces: [[A, B, 1]] }));
  put("balls", "balls/ballincub/3", 6, JSON.stringify({ s: 6, pieces: [[A, B, 1]] }));
  put("balls", "balls/cubinball/2", 2.8 / 2, JSON.stringify({ s: 1.4, pieces: [[0.6, 0, 0, 1, 0, 0, 0]] }));
  put("curved", "curved/0/0/4/2", 5, JSON.stringify({ size: 5, pieces: [{ x: A, y: B, theta: 1 }] }));
  put("curved", "curved/0/0/0/2", 3, JSON.stringify({ size: 3, pieces: [{ x: A, y: B, theta: 1 }] }));
  put("curved", "curved/-1/3/0/2", 1.25, JSON.stringify({ size: 1.25, pieces: [{ x: A, y: B, theta: 1 }] }));
  put("curved", "curved/1/0/0/2", 2, JSON.stringify({ size: 2, pieces: [{ x: A, y: B, theta: 1 }] }));
  put("curved", "curved/-1/0/4/2", 6, JSON.stringify({ size: 6, pieces: [{ x: A, y: B, theta: 1 }] }));
  put("curved", "curved/1/3/4/2", 2, JSON.stringify({ size: 2, pieces: [{ x: A, y: B, theta: 1 }] }));
  // two entries of one problem (a leader and a worse one), so that the order must survive
  put("sphere", "sphere/0/5", 2.5, JSON.stringify({ rho: 2.5, pieces: [] }), "lead");
  put("sphere", "sphere/0/5", 2.75, JSON.stringify({ rho: 2.75, pieces: [] }), "worse");
  // configurations that are not what the server writes: the conversion must do to them what the TypeScript does
  put("surface", "surface/cube/fold/0/4", 3, '{ "s" : 3.0 , "pieces" : [ {"face":0,"x":1e0,"y":-2.5E-7,"theta":1e21}, [1,2], null, "x", {"x":"1","y":null} ], "10": 1, "2": {"s": 4}, "s": 5e-324 }');
  put("surface", "surface/cube/fold/0/5", 3, "not json");
  put("surface", "surface/cube/fold/0/6", 3, "[1, 2, 3]");
  put("surface", "surface/cube/fold/0/7", 3, '"text"');
  put("surface", "surface/cube/fold/0/8", 3, '{"s":"3","pieces":{"x":1}}');
  put("surface", "surface/cube/fold/0/9", 3, '{"s":1e308,"pieces":[{"x":1.7976931348623157e308,"y":12345678901234567890,"theta":0}],"note":"\\u00e9\\n\\"q\\" \\ud83d\\ude00 / \\/"}');
  put("surface", "surface/cube/fold/4/3", 3, '{"s": 3.0}');
  put("surface", "surface/nosuch/fold/0/3", 3, '{"s": 3.0}');
  put("torus", "torus/hex/0/3", 2, '{"lattice":[1,2],"poses":[[1,2,3],[4],"x",{"0":1},[null,2.5,1]]}');
  put("torus", "torus/free/0/3", 2, '{"lattice":{"L":"4","b1":[2,"x",3],"b2":{"0":1}},"poses":{"0":[1,2,3]}}');
  put("boundary", "boundary/5cell/ball/2", 2, '{"s":2,"pieces":[{"cell":0,"u":[1,"a",null,2.5,[3]]},{"cell":1,"u":{"0":1}},{"cell":2}]}');
  put("balls", "balls/ballinball/4", 2, '{"s":2,"pieces":[[1,2,3,4],[1],"x",{"0":1,"1":2}]}');
  put("curved", "curved/0/0/3/2", 2, '{"size":-0.0,"pieces":[{"x":-0,"y":0.1,"theta":1}]}');
  put("curved", "curved/1e-06/0/0/2", 2, '{"size":2}');
  put("ndim", "ndim/4/ball/ball/2", 2, '{"s":2,"pieces":[[1,2,3,4]]}');
  put("polyhedra", "polyhedra/cubincub/8", 2, '{"s": 2.0, "pieces": []}');
  put("legacy", "legacy/1", 2, '{"s": 2.0}');
  // real entries of the site, written here as the old units held them is not possible; their numbers are what counts
  for (const r of spaces) { noteSpaceId(r.space, r.problem); ent.run(r.space, r.problem, r.score, "real", r.software, r.method, 42, JSON.stringify(r.config)); }
}

/** The calls made on an old database: reads of everything, the migration in steps with live calls between them, and the unit change back and forth. */
function oldScript(db: DatabaseSync): { calls: Call[]; cut: number } {
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const ids = (db.prepare("SELECT id FROM submissions ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  const problems = db.prepare("SELECT DISTINCT n AS N, m AS M, p AS P FROM submissions ORDER BY n, m, p").all() as { N: number; M: number; P: number }[];
  const pairs = db.prepare("SELECT DISTINCT n AS N, m AS M FROM submissions ORDER BY n, m").all() as { N: number; M: number }[];
  const spaceIds = has("space_entries") ? (db.prepare("SELECT id FROM space_entries ORDER BY id").all() as { id: number }[]).map((r) => r.id) : [];
  const archived = has("space_entries_units_archive") ? (db.prepare("SELECT id FROM space_entries_units_archive ORDER BY id").all() as { id: number }[]).map((r) => r.id) : [];
  const allSpaceIds = [...new Set([...spaceIds, ...archived])].sort((a, b) => a - b);
  const reads = (): Call[] => [
    { op: "pieces_migrated" }, { op: "units_epoch" }, { op: "units_digest" }, { op: "leaders" }, { op: "pairs" }, { op: "pending" }, { op: "holder_peaks" },
    { op: "space_leaders" },
    ...[...ids, (ids.at(-1) ?? 0) + 1].map((id) => ({ op: "get", id })),
    // in small lists: a row whose stored JSON cannot be read fails the whole call, as it does in the source
    ...Array.from({ length: Math.ceil(ids.length / 20) }, (_, i) => ({ op: "get_many", ids: ids.slice(i * 20, i * 20 + 20) })),
    ...pairs.flatMap((p) => [{ op: "best_per_p", ...p }, { op: "best_per_p", ...p, verified: true }]),
    ...problems.flatMap((p) => [{ op: "count", ...p }, { op: "leader", ...p }]),
    { op: "leaders_of", problems: problems.slice(0, 500) },
    { op: "leaders_after", after: null, limit: 7 },
    { op: "problems_named", name: "row 2", after: null, limit: 10 },
    ...allSpaceIds.map((id) => ({ op: "space_get", id })),
    ...[...SPACE_NAMES, "legacy"].map((space) => ({ op: "space_best", space })),
  ];
  const b: Call[] = [];
  b.push(...reads());
  b.push({ op: "migrate_pieces", batch: 3 }, { op: "migrate_pieces", batch: 5 }, { op: "pieces_migrated" });
  // live calls between the steps
  const s = (N: number, M: number, P: number, score: number, verification = "none") => ({
    op: "submit",
    s: { N, M, P, score, name: "live", agent_note: "", found_with: "hand", method: null, method_params: null, seed: null, budget: null, software: null, pieces: poses(P, 900 + P), container_phi: 0, created_at: "2026-11-10T00:00:00.000Z", verification, literature_value: verification === "pending" ? score * 1.5 : null, strict_check: verification === "pending" ? { ok: true, certifiedSize: score / (1 - 1e-8), eps: 1e-8 } : null },
  });
  b.push(s(4, 4, 2, 1.9), s(4, 4, 9, 10), s(0, 5, 7, 2, "pending"), s(4, 4, 40, 3));
  b.push({ op: "review", id: 5, decision: "confirmed" }, { op: "remove", id: 9 }, { op: "edit", id: 7, changes: { name: "renamed" } });
  b.push({ op: "migrate_pieces", batch: 4 }, { op: "migrate_pieces", batch: 4 });
  // the crossed runs change hands here, in the middle of the migration
  const cut = b.length;
  b.push({ op: "migrate_pieces", batch: 6 }, { op: "pieces_migrated" });
  b.push({ op: "start_pieces_migration", batch: 5, pauseMs: 250, logEveryMs: 60_000 });
  b.push({ op: "pieces_migrated" }, { op: "migrate_pieces", batch: 100 }, { op: "start_pieces_migration", batch: 5, pauseMs: 0 });
  b.push(...reads());
  // the unit change, back and forth
  b.push({ op: "units_migrate", reverse: false }, ...reads());
  b.push({ op: "units_migrate", reverse: true }, ...reads());
  b.push({ op: "space_submit", e: { space: "curved", problem: "curved/1/0/0/3", score: 2.5, name: "new units", agent_note: "", software: null, method: null, seed: null, config: '{"size":2.5,"pieces":[]}', created_at: "2026-11-10T00:00:00.000Z" } });
  b.push({ op: "units_migrate", reverse: true }, { op: "units_migrate", reverse: false }, ...reads());
  b.push({ op: "units_migrate", reverse: false }, { op: "units_migrate", reverse: true }, { op: "units_epoch" }, { op: "units_digest" }, { op: "units_migrate", reverse: false }, ...reads());
  noteSpaceId("curved", "curved/1/0/0/3");
  // a step that fails while something holds the rows: five failures, then the run gives up
  b.push({ op: "exec", sql: "UPDATE meta SET value = 0 WHERE key IN ('pieces_packed', 'pieces_packed_cursor')" });
  b.push({ op: "exec", sql: "UPDATE submissions SET pieces = '[{\"x\":1,\"y\":2,\"theta\":3}]' WHERE id = (SELECT MIN(id) FROM submissions)" });
  b.push({ op: "exec", sql: "CREATE TRIGGER held BEFORE UPDATE OF pieces ON submissions BEGIN SELECT RAISE(ABORT, 'the rows are held'); END" });
  b.push({ op: "start_pieces_migration", batch: 5, pauseMs: 10, logEveryMs: 60_000 }, { op: "pieces_migrated" });
  b.push({ op: "exec", sql: "DROP TRIGGER held" });
  b.push({ op: "start_pieces_migration", batch: 50, pauseMs: 70_000, logEveryMs: 1 }, { op: "pieces_migrated" }, { op: "units_digest" });
  return { calls: b, cut };
}

async function old(kind: string, outDir: string, snapDir: string, spaceDir: string) {
  mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/old.sqlite`;
  for (const f of ["", "-wal", "-shm"]) rmSync(path + f, { force: true });
  const { boards, spaces } = await loadData(snapDir, spaceDir, 6);
  mockClocks();
  if (kind === "prediet" || kind === "ancient" || kind === "partial") {
    const db = new DatabaseSync(path);
    db.exec(kind === "prediet" ? PREDIET : ANCIENT);
    if (kind === "partial") {
      // a database half-way between the two: two of the added columns, the tallies, neither index of today
      db.exec("ALTER TABLE submissions ADD COLUMN found_with TEXT; ALTER TABLE submissions ADD COLUMN seed INTEGER;");
      db.exec("CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL, PRIMARY KEY (n, m, p));");
    }
    fillOld(db, oldRows(boards), kind === "prediet");
    if (kind !== "ancient") db.exec("INSERT INTO tallies SELECT n, m, p, COUNT(*) + 10 FROM submissions GROUP BY n, m, p");
    db.close();
  } else if (kind === "preunits" || kind === "poison" || kind === "epoch1") {
    // a database of the current schema from before the unit change: no epoch marker, rows in the old units
    const fresh = new SqliteStore(path);
    const db = rawDb(fresh);
    db.exec("DELETE FROM meta WHERE key = 'units_epoch'");
    const sub = db.prepare(`INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at, verification, literature_value, strict_check)
       VALUES (?, ?, ?, ?, ?, '', ?, 0, '2026-10-20T00:00:00Z', ?, ?, ?)`);
    oldRows(boards).forEach((r, i) => {
      const text = typeof r.pieces === "string" ? r.pieces : JSON.stringify(r.pieces);
      // most rows hold BLOBs, as the migration left them; every seventh still holds its text
      const stored = typeof r.pieces === "string" || i % 7 === 3 ? text : encodePieces(r.pieces as Pose[]);
      sub.run(r.n, r.m, r.p, r.score, `row ${i + 1}`, stored, r.v ?? "none", r.lit ?? null, r.strict ?? null);
    });
    db.exec("INSERT INTO tallies SELECT n, m, p, COUNT(*) FROM submissions GROUP BY n, m, p");
    db.exec("INSERT INTO holder_peaks (name, peak) VALUES ('row 1', 3), ('ann', 12)");
    oldSpaceEntries(db, spaces);
    if (kind === "poison") db.prepare("UPDATE submissions SET pieces = ? WHERE id = (SELECT MAX(id) FROM submissions WHERE n = 0)").run(new Uint8Array(23));
    if (kind === "epoch1") {
      // converted, used for a while in the new units, then rolled back by the operator's tool
      if (migrateUnits(db).action !== "forward") throw new Error("not converted");
      const ent = db.prepare(`INSERT INTO space_entries (space, problem, score, name, agent_note, created_at, config) VALUES (?, ?, ?, 'after', '', '2026-10-28T00:00:00Z', ?)`);
      for (const [space, problem, score, config] of [["curved", "curved/1/0/0/4", 2.25, '{"size":2.25,"pieces":[{"x":0.1,"y":0.2,"theta":0}]}'], ["curved", "curved/-1/0/3/2", 1.5, '{"size":1.5,"pieces":[]}'], ["sphere", "sphere/0/9", 1.75, '{"rho":1.75,"pieces":[]}']] as const) { noteSpaceId(space, problem); ent.run(space, problem, score, config); }
      db.prepare(`INSERT INTO submissions (n, m, p, score, name, agent_note, pieces, container_phi, created_at) VALUES (0, 0, 30, 6.5, 'after', '', ?, 0, '2026-10-28T00:00:00Z')`).run(encodePieces(poses(30, 77)));
      if (migrateUnits(db, true).action !== "reverse") throw new Error("not reversed");
    }
    db.close();
  } else throw new Error(`unknown kind ${kind}`);
  const db = new DatabaseSync(path);
  // integers beyond 2^53 - 1, which the driver refuses to read as numbers (only a hand-made row can hold one)
  const column = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);
  if (column("submissions", "seed")) db.exec("UPDATE submissions SET seed = 9007199254740993 WHERE id = 29; UPDATE submissions SET seed = -9007199254740991 WHERE id = 30");
  if (column("space_entries", "seed")) db.exec("UPDATE space_entries SET seed = -9007199254740992 WHERE id = 2");
  // every space problem of the file, for the table of ids
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'space_entries'").get())
    for (const t of ["space_entries", "space_entries_units_archive"])
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t))
        for (const r of db.prepare(`SELECT DISTINCT space, problem FROM ${t}`).all() as { space: string; problem: string }[]) noteSpaceId(r.space, r.problem);
  const { calls, cut } = kind === "poison" ? { calls: [], cut: 0 } : oldScript(db);
  const count = (db.prepare("SELECT COUNT(*) AS c FROM submissions").get() as { c: number }).c;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  writeFileSync(`${outDir}/calls.jsonl`, calls.map((c) => JSON.stringify(enc(c))).join("\n") + (calls.length ? "\n" : ""));
  writeFileSync(`${outDir}/cut.txt`, `${cut}\n`);
  writeIds(outDir);
  console.log(`${kind}: ${count} rows, ${calls.length} calls, the crossed runs change hands at call ${cut}`);
}

// ---- running calls on a file ----------------------------------------------------------------------------------

async function run(callsFile: string, dbPath: string, from: number, to: number, out: string, units: "migrate" | "leave") {
  const calls = readFileSync(callsFile, "utf8").split("\n").filter(Boolean).slice(from, to);
  mockClocks();
  traceStatements();
  const { store, line } = open(dbPath, units);
  const lines = [line];
  if (store) {
    for (const c of calls) lines.push(await resultLine(store, JSON.parse(c)));
    rawDb(store).close();
  }
  appendFileSync(out, lines.join("\n") + "\n");
}

// ---- fixtures of cargo test -----------------------------------------------------------------------------------

function fixtures(dir: string) {
  mkdirSync(dir, { recursive: true });
  // the problem ids of the ported unit tests (apps/server/test/units-migration.test.ts)
  for (const [space, id] of [
    ["torus", "torus/sq/0/2"], ["torus", "torus/free/0/2"], ["torus", "torus/sq/4/2"], ["torus", "torus/sq/0/3"], ["sphere", "sphere/0/3"], ["sphere", "sphere/4/3"],
    ["surface", "surface/cube/fold/0/3"], ["boundary", "boundary/tesseract/ball/3"], ["boundary", "boundary/tesseract/cube/3"],
    ["balls", "balls/ballinball/3"], ["balls", "balls/ballincub/3"], ["balls", "balls/cubinball/2"], ["balls", "balls/cubinball/3"],
    ["curved", "curved/0/0/4/2"], ["curved", "curved/0/0/0/2"], ["curved", "curved/-1/3/0/2"], ["curved", "curved/1/0/0/2"], ["curved", "curved/-1/0/4/2"], ["curved", "curved/1/3/4/2"],
    ["polyhedra", "polyhedra/cubincub/8"], ["ndim", "ndim/4/ball/ball/2"], ["surface", "surface/nosuch/fold/0/3"], ["sphere", "x"],
  ] as const) noteSpaceId(space, id);
  writeIds(dir);
  // spacePlan and planarFactors, by what they do to a probe configuration
  const probe = () => ({ s: 8, size: 8, rho: 8, lattice: { L: 8, b1: [8, 8], b2: [8, 8] }, poses: [[8, 8, 8]], pieces: [{ x: 8, y: 8, theta: 8, u: [8, 8, 8] }] });
  const probeList = () => ({ s: 8, pieces: [[8, 8, 8, 8]] });
  const plans = Object.keys(idTable).map((key) => {
    const [space, id] = key.split("\n") as [string, string];
    const plan = spacePlan(space, id);
    if (plan === null || plan === "archive") return { space, id, plan };
    const a = probe(), b = probeList();
    plan.apply(a as any); plan.apply(b as any);
    return { space, id, plan: { score: plan.score, label: plan.label, probe: a, probeList: b } };
  });
  const planar = [[0, 0], [0, 7], [9, 0], [4, 4], [0, 3], [3, 0]].map(([N, M]) => ({ N, M, factors: planarFactors(N!, M!) }));
  writeFileSync(`${dir}/units-plans.json`, JSON.stringify({ plans, planar }, null, 1));
  // JSON.stringify(JSON.parse(text)), or null where JSON.parse refuses
  const texts: string[] = [
    "1", "-0", "0.1", "1e21", "1E21", "1e-7", "123456789012345678901234567890", "1.7976931348623157e308", "1e999", "-1e999", "5e-324", "2.5e-324", "1e-400",
    "0.30000000000000004", "100", "1.0", "1.50", "-0.0", "4.35", "0.000001", "0.0000001", "123456789.123456789", "9007199254740993", "1e+2", "[1,2 , 3]", " {\"a\" : 1 } ",
    '{"b":1,"10":2,"a":3,"2":4,"01":5,"b":6,"4294967295":7,"4294967294":8,"-1":9,"1.5":10,"0":11}', '{"__proto__":1,"constructor":2}', '"\\u0041\\/\\n\\u001f\\u00e9é\\ud83d\\ude00\\u2028\\u007f"',
    '"a\\tb\\rc\\fd\\be"', '{"":1}', "[[[[[[]]]]]]", '{"a":{"b":{"c":[1,{"d":null}]}}}', "true", "false", "null", '""', "[]", "{}",
    "", " ", "{", "[1,]", '{"a":1,}', "01", "1.", ".5", "+1", "1e", "'a'", '"a\nb"', '"\\x"', "nul", "[1] x", "﻿1", "NaN", "Infinity", "-", "{a:1}", '"\\u12"', "[1 2]", '{"a" 1}', "tru", "-01", "1e+", "0x10", "1_0", '"unterminated',
    "\t\r\n[ ]\n", "[ 1]", "1 ", "-1E-2", "1e0", "0e0", "0.0", "-0e-0", "[1e5,1e-5,123e-20,0.00001234]",
  ];
  let s = 12345; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 300; i++) {
    const x = (r() - 0.5) * 10 ** Math.floor(r() * 60 - 30);
    texts.push(i % 3 === 0 ? String(x) : i % 3 === 1 ? x.toExponential(Math.floor(r() * 18)) : x.toPrecision(1 + Math.floor(r() * 20)));
  }
  const round = texts.map((text) => { try { return { text, out: JSON.stringify(JSON.parse(text)) }; } catch { return { text, out: null }; } });
  writeFileSync(`${dir}/json-roundtrip.json`, JSON.stringify(round, null, 0));
  // blobFromJson: the bytes as hex, or null
  const hex = (b: Uint8Array | null) => (b ? Buffer.from(b).toString("hex") : null);
  const blobTexts = ["", "{", "{}", "[1, 2]", "[null]", "[[1, 2, 3]]", '[{"x": 1, "y": 2}]', '[{"x": 1, "y": 2, "theta": "3"}]', '[{"x": 1, "y": 2, "theta": 3, "extra": 4}]', '[{"x": 1e999, "y": 2, "theta": 3}]',
    "[]", '[{"x":1.5,"y":-2,"theta":0.25}]', '[{"theta":1,"y":2,"x":3},{"x":-0,"y":1e6,"theta":-1e6}]', '[{"x":1,"x":2,"y":3,"theta":4}]', '[{"x":1,"y":2,"theta":3},{"x":1,"y":2}]', '[{"x":true,"y":2,"theta":3}]', '[{"x":0.1,"y":5e-324,"theta":1.7976931348623157e308}]'];
  writeFileSync(`${dir}/blob-from-json.json`, JSON.stringify(blobTexts.map((text) => ({ text, blob: hex(blobFromJson(text)) }))));
  // encodePieces of awkward doubles, by their bits
  const awkward: Pose[] = [{ x: -0, y: 0, theta: -0 }, { x: 1e6, y: -1e6, theta: Math.PI }, { x: Number.MIN_VALUE, y: -Number.MIN_VALUE, theta: 2 ** -1074 }, { x: 0.1 + 0.2, y: 1 / 3, theta: -Math.PI / 4 },
    { x: Number.MAX_VALUE, y: -Number.MAX_VALUE, theta: 1e308 }, { x: 999999.9999999999, y: -2.2250738585072014e-308, theta: 123456.789 }];
  const bytes = encodePieces(awkward);
  if (JSON.stringify(decodePieces(bytes)) !== JSON.stringify(awkward)) throw new Error("pieces do not round-trip");
  writeFileSync(`${dir}/pieces-awkward.json`, JSON.stringify({ hex: hex(bytes), json: JSON.stringify(awkward) }));
  // packPieces: the stored value of triples of several kinds, byte for byte, and what unpackPieces refuses
  const lattice = (count: number): Pose[] => Array.from({ length: count }, (_, i) => ({ x: (i % 17) * 1.0000000000000002, y: Math.floor(i / 17) / 3, theta: 0 }));
  const scattered = (count: number): Pose[] => Array.from({ length: count }, () => ({ x: (r() - 0.5) * 40, y: (r() - 0.5) * 40, theta: r() * 6.283 }));
  const mixed = (count: number): Pose[] => scattered(count).map((p, i) => ({ x: p.x, y: i % 5 ? p.y : 0.25, theta: i % 3 ? 0 : p.theta }));
  const kinds: Pose[][] = [[], awkward, scattered(1), scattered(2), scattered(40), scattered(500), lattice(1), lattice(4), lattice(30), lattice(500), mixed(7), mixed(60), mixed(333)];
  // and the padded form (tag 2), wherever these counts give it
  let padded = 0;
  for (let count = 1; count <= 520 && padded < 6; count++) for (const pieces of [lattice(count), mixed(count)]) { const stored = packPieces(encodePieces(pieces)); if (stored.length % 24 !== 0 && stored[0] === 2) { kinds.push(pieces); padded++; } }
  if (padded < 6) throw new Error("no padded form among the fixtures");
  const packed = kinds.map((pieces) => {
    const triples = encodePieces(pieces);
    const stored = packPieces(triples);
    if (hex(unpackPieces(stored)) !== hex(triples)) throw new Error("packed pieces do not round-trip");
    return { triples: hex(triples), stored: hex(stored) };
  });
  const good = packPieces(encodePieces(lattice(40)));
  const made = (claimed: number, content: Uint8Array, crc = crc32(content), after = new Uint8Array(0), tag = 1) => {
    const head = Buffer.alloc(9, tag); head.writeUInt32LE(claimed, 1); head.writeUInt32LE(crc, 5);
    const value = Buffer.concat([head, zstdCompressSync(content), after]);
    return value.length % 24 === 0 ? Buffer.concat([value, Buffer.alloc(1)]).fill(2, 0, 1) : value;
  };
  const cut = (value: Uint8Array, by: number) => { const shorter = value.subarray(0, value.length - by); return shorter.length % 24 === 0 ? value.subarray(0, value.length - by - 1) : shorter; };
  const zeros = new Uint8Array(48);
  const flip = (value: Uint8Array, at: number, mask: number) => Uint8Array.from(value, (b, i) => (i === at ? b ^ mask : b));
  // a padded value (tag 2) whose last byte is not the zero it must be, and one with its tag turned into the other
  const paddedOne = packed.map((c) => Buffer.from(c.stored, "hex")).find((v) => v.length % 24 !== 0 && v[0] === 2)!;
  // frames by hand: a raw block and a run-length block, each the last; an empty last block after one; a reserved block type; a checksum
  const frameOf = (...blocks: [type: number, size: number, body: number[], last: number][]) => Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58]), ...blocks.map(([type, size, body, last]) => { const h = (size << 3) | (type << 1) | last; return Buffer.from([h & 255, (h >> 8) & 255, (h >> 16) & 255, ...body]); })]);
  const handMade = (frame: Uint8Array, content: Uint8Array) => { const head = Buffer.alloc(9, 1); head.writeUInt32LE(content.length, 1); head.writeUInt32LE(crc32(content), 5); const value = Buffer.concat([head, frame]); return value.length % 24 === 0 ? Buffer.concat([value, Buffer.alloc(1)]).fill(2, 0, 1) : value; };
  const body24 = Array.from({ length: 24 }, (_, i) => i * 7 + 1);
  const values: Uint8Array[] = [new Uint8Array(25), new Uint8Array([3, 1, 2, 3, 4]), new Uint8Array([1]), new Uint8Array([2, 0]), good.subarray(0, 9), good.subarray(0, 10), cut(good, 1), cut(good, 2), cut(good, 3), cut(good, 5), cut(good, 40),
    flip(good, 30, 0xff), flip(good, good.length - 2, 1), flip(good, 1, 24), flip(good, 6, 1), flip(good, 9, 1), flip(good, 13, 0x20), flip(good, 13, 3), flip(good, 13, 8), flip(good, 0, 3),
    flip(paddedOne, paddedOne.length - 1, 1), flip(paddedOne, 0, 3), paddedOne.subarray(0, paddedOne.length - 1),
    made(72, zeros), made(24, zeros), made(50, new Uint8Array(50)), made(48, zeros), made(0, new Uint8Array(0)), made((1 << 24) + 24, new Uint8Array(24)), made(48 << 20, new Uint8Array(48 << 20)),
    made(48, zeros, (crc32(zeros) ^ 1) >>> 0), made(48, zeros, crc32(zeros), new Uint8Array([7, 7, 7])), made(48, zeros, crc32(zeros), zstdCompressSync(new Uint8Array(0))), made(48, zeros, crc32(zeros), new Uint8Array(0), 2),
    handMade(frameOf([0, 24, body24, 1]), Uint8Array.from(body24)), handMade(frameOf([1, 24, [9], 1]), new Uint8Array(24).fill(9)), handMade(frameOf([0, 24, body24, 0], [0, 0, [], 1]), Uint8Array.from(body24)),
    handMade(frameOf([0, 24, body24, 0]), Uint8Array.from(body24)), handMade(frameOf([0, 24, body24, 0], [0, 0, [], 1]).subarray(0, 35), Uint8Array.from(body24)), handMade(frameOf([3, 24, body24, 1]), Uint8Array.from(body24)),
    handMade(frameOf([0, 24, body24.slice(0, 20), 1]), Uint8Array.from(body24))];
  const unpacked = values.map((value) => { try { return { value: hex(value), triples: hex(unpackPieces(value)), error: null }; } catch (e) { return { value: hex(value), triples: null, error: `${(e as Error).name}: ${(e as Error).message}` }; } });
  writeFileSync(`${dir}/pieces-packed.json`, JSON.stringify({ packed, unpacked }));
  console.log(`fixtures written to ${dir}`);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "gen") await gen(args[0]!, Number(args[1]), Number(args[2]), args[3]!, args[4]!);
else if (mode === "old") await old(args[0]!, args[1]!, args[2]!, args[3]!);
else if (mode === "run") await run(args[0]!, args[1]!, Number(args[2]), Number(args[3]), args[4]!, args[5] === "leave" ? "leave" : "migrate");
else if (mode === "fixtures") fixtures(args[0]!);
else throw new Error("usage: store-ref.mts gen|old|run|fixtures ... (see the head of the file)");
