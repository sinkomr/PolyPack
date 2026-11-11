// Replays one scenario against one server and writes the transcript (README.md, "Scenarios" and
// "Transcripts"). The server is started from a command line, on a fresh database in its own
// directory, and is always stopped again.
import { spawn, ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { RawResponse, RequestSpec, SseStream, freePort, openSse, send } from "./http.mts";

export const REPO = resolve(import.meta.dirname, "../../../..");
export const FIXTURES = resolve(import.meta.dirname, "../fixtures");

/** The first line of a scenario file. */
export interface ScenarioHeader {
  scenario: string;
  about?: string;
  /** Environment variables of the server ({tmp}, {repo}, {fixtures} are replaced in the values). */
  env?: Record<string, string>;
  /** The options file's content; null: the server is started without one (and has no /__test/control). */
  options?: Record<string, unknown> | null;
  /** What the server's clock reads when it is first started. */
  clockAt?: string;
  /** False: the first step starts the server itself (after `sql` or `file` steps). */
  autostart?: boolean;
  /** False: timestamps are replaced by "<t>" without the step they were made in (bulk scenarios, which do not pace their steps). */
  timeLabels?: boolean;
}

export type Step =
  | ({ op: "req"; expect?: number; note?: string } & RequestSpec)
  | { op: "burst"; requests: RequestSpec[]; unordered?: boolean; concurrency?: number; staggerMs?: number; summary?: boolean; note?: string }
  | { op: "wait"; ms: number }
  | { op: "sse_open"; stream: string; path: string; headers?: Record<string, string> }
  | { op: "sse_drain"; stream: string; settleMs?: number; atLeast?: number; timeoutMs?: number }
  | { op: "sse_close"; stream: string }
  | { op: "control"; clockAdvanceMs?: number; loopDelayMs?: number | null; flushStats?: boolean }
  | { op: "start"; expectFail?: boolean }
  | { op: "stop" }
  | { op: "restart"; options?: Record<string, unknown>; env?: Record<string, string | null>; clockAt?: string; clockAdvanceMs?: number }
  | { op: "sql"; statements: string[] }
  | { op: "file"; path: string; text?: string; gzipText?: string; remove?: boolean }
  | { op: "ls"; dir: string }
  | { op: "dump" };

export interface RunOptions {
  /** The server's command line; it receives PORT, HOST, DATABASE_PATH, POLYPACK_TEST_OPTIONS and the scenario's variables. */
  command: string;
  scenarioFile: string;
  /** A directory of this run's own (database, options file, snapshot directory); emptied first. */
  workDir: string;
  transcriptFile: string;
  /** Added to the server's environment (NODE_V8_COVERAGE, SERVERDIFF_MUTANT). */
  extraEnv?: Record<string, string>;
  portBase?: number;
}

export interface RunResult {
  scenario: string;
  steps: number;
  /** Steps whose `expect` was not met, and other signs that the scenario did not run as written. */
  warnings: string[];
  ms: number;
}

const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/;
const ISO_QUOTED = /"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)"/g;
const ISO_WHOLE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** Headers that say nothing about the answer itself (README.md, "What is not compared"). */
const DROPPED_HEADERS = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);
/** Bodies longer than this are kept as a hash only. */
const TEXT_CAP = 48 * 1024 * 1024;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function readScenario(file: string): { header: ScenarioHeader; steps: Step[] } {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const header = JSON.parse(lines[0]!) as ScenarioHeader;
  return { header, steps: lines.slice(1).map((l) => JSON.parse(l) as Step) };
}

/** Normalises one log line (README.md, "What is not compared", L1 to L3). */
export function normaliseLogLine(line: string, subst: [string, string][]): string {
  let s = line;
  for (const [from, to] of subst) s = s.split(from).join(to);
  if (s.startsWith("[submit] ") || s.startsWith("[load] ")) s = s.replace(/\d+\.\d+ ms/g, "<ms>");
  else if (s.startsWith("units: converted to diameter units in "))
    s = s.replace(/in \d+ ms:/, "in <ms>:").replace(/"ms":[0-9.e+-]+/, '"ms":"<ms>"');
  else if (s.startsWith("[pieces] ")) s = s.replace(/rows in \d+\.\d s of work/, "rows in <s> of work");
  return s;
}

/** Every table of a database: its rows, BLOBs as hex, and the schema as sqlite_master has it. */
export function dumpDatabase(path: string, mask: (text: string) => string): Record<string, unknown> {
  if (!existsSync(path)) return { missing: true };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = (
      db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as Record<string, unknown>[]
    ).map((r) => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: r.sql }));
    const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    const tables: Record<string, unknown> = {};
    for (const t of schema.filter((s) => s.type === "table")) {
      const name = t.name as string;
      const info = db.prepare(`PRAGMA table_info("${name}")`).all() as Record<string, unknown>[];
      const columns = info.map((c) => c.name as string);
      const pk = info.filter((c) => (c.pk as number) > 0);
      // by the integer key when there is one; otherwise by every column, since the order of the rows
      // of such a table is not something a query of the server can see
      const order =
        pk.length === 1 && String(pk[0]!.type).toUpperCase() === "INTEGER"
          ? `"${pk[0]!.name as string}"`
          : columns.map((c) => `"${c}"`).join(", ");
      const select = columns.map((c) => `"${c}", typeof("${c}") AS "typeof ${c}"`).join(", ");
      const rows = db.prepare(`SELECT ${select} FROM "${name}" ORDER BY ${order}`).all() as Record<string, unknown>[];
      tables[name] = {
        columns,
        // per row: the storage class of each value (n, i, r, t, b), then the values
        rows: rows.map((r) => [
          columns.map((c) => String(r[`typeof ${c}`])[0]).join(""),
          ...columns.map((c) => {
            const v = r[c];
            if (v instanceof Uint8Array) return { hex: Buffer.from(v).toString("hex") };
            if (typeof v === "bigint") return { int: v.toString() };
            if (typeof v === "string") return ISO_WHOLE.test(v) ? mask(`"${v}"`).slice(1, -1) : v;
            return v;
          }),
        ]),
      };
    }
    return { journal_mode: pragma("journal_mode"), user_version: pragma("user_version"), schema, tables };
  } finally {
    db.close();
  }
}

export async function runScenario(o: RunOptions): Promise<RunResult> {
  const began = performance.now();
  const { header, steps } = readScenario(o.scenarioFile);
  const warnings: string[] = [];
  rmSync(o.workDir, { recursive: true, force: true });
  mkdirSync(o.workDir, { recursive: true });
  mkdirSync(dirname(o.transcriptFile), { recursive: true });
  const tmp = o.workDir;
  const dbPath = join(tmp, "db.sqlite");
  const optionsPath = join(tmp, "options.json");
  const subst = (text: string) =>
    text.split("{tmp}").join(tmp).split("{repo}").join(REPO).split("{fixtures}").join(FIXTURES);
  const substDeep = (v: unknown): unknown =>
    typeof v === "string"
      ? subst(v)
      : Array.isArray(v)
        ? v.map(substDeep)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substDeep(x)]))
          : v;

  let options: Record<string, unknown> | null = header.options === null ? null : { ...(header.options ?? {}) };
  const env: Record<string, string | null> = { ...(header.env ?? {}) };
  /** The server's clock is the system clock plus this. */
  let clockOffset = 0;
  let clockSet = false;
  const setClockAt = (iso: string) => {
    clockOffset = Date.parse(iso) - Date.now();
    clockSet = true;
  };
  const serverNow = () => Date.now() + clockOffset;

  // ---- the transcript ----
  const out: string[] = [];
  const emit = (record: Record<string, unknown>) => out.push(JSON.stringify(record));
  /** The time, by the server's clock, during which each step ran. */
  const windows: { i: number; t0: number; t1: number }[] = [];
  const timeLabels = header.timeLabels !== false;
  const label = (iso: string): string => {
    const t = Date.parse(iso);
    if (!timeLabels) return windows.length && t >= windows[0]!.t0 && t <= serverNow() ? "<t>" : iso;
    // the latest step whose window holds it
    let lo = 0;
    let hi = windows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (windows[mid]!.t0 <= t) lo = mid;
      else hi = mid - 1;
    }
    const w = windows[lo];
    return w && w.t0 <= t && t <= w.t1 ? `<t:${w.i}>` : iso;
  };
  const mask = (text: string) => text.replace(ISO_QUOTED, (_m, iso: string) => `"${label(iso)}"`);

  // ---- the server ----
  let child: ChildProcess | null = null;
  let port = 0;
  let stdout: string[] = [];
  let stderr: string[] = [];
  /** How many lines of stderr the server had written when it began to answer. */
  let stderrAtReady = 0;
  let exited: Promise<{ code: number | null; signal: string | null }> | null = null;
  let runs = 0;
  const lines = (into: string[]) => {
    let rest = "";
    return (chunk: Buffer) => {
      rest += chunk.toString("utf8");
      const parts = rest.split("\n");
      rest = parts.pop()!;
      into.push(...parts);
    };
  };
  const start = async () => {
    if (child) throw new Error("the server is already running");
    if (header.clockAt && !clockSet) setClockAt(header.clockAt);
    port = await freePort(o.portBase);
    const vars: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: dbPath,
    };
    if (options !== null) {
      writeFileSync(optionsPath, JSON.stringify({ ...(substDeep(options) as object), clockOffsetMs: clockOffset }, null, 1));
      vars.POLYPACK_TEST_OPTIONS = optionsPath;
    }
    for (const [k, v] of Object.entries(env)) {
      if (v === null) delete vars[k];
      else vars[k] = subst(v);
    }
    Object.assign(vars, o.extraEnv ?? {});
    stdout = [];
    stderr = [];
    runs++;
    const c = spawn("/bin/sh", ["-c", `exec ${o.command}`], { cwd: REPO, env: vars, stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    c.stdout!.on("data", lines(stdout));
    c.stderr!.on("data", lines(stderr));
    exited = new Promise((r) => c.on("exit", (code, signal) => r({ code, signal })));
    let gone = false;
    void exited.then(() => (gone = true));
    const deadline = performance.now() + 60_000;
    for (;;) {
      if (gone) {
        child = null;
        throw new Error(`the server exited while starting: ${stderr.slice(-5).join(" | ")}`);
      }
      const r = await send(port, { path: "/api/health" }, 2000);
      if (r.status === 200) break;
      if (performance.now() > deadline) throw new Error("the server did not answer /api/health within 60 s");
      await sleep(40);
    }
    stderrAtReady = stderr.length;
  };
  const logSubst = (): [string, string][] => [
    [dbPath, "<db>"],
    [tmp, "<tmp>"],
    [REPO, "<repo>"],
    [`localhost:${port}`, "localhost:<port>"],
  ];
  const stop = async (): Promise<Record<string, unknown>> => {
    if (!child || !exited) return { stopped: false };
    const c = child;
    c.kill("SIGTERM");
    const killer = setTimeout(() => c.kill("SIGKILL"), 10_000);
    const exit = await exited;
    clearTimeout(killer);
    child = null;
    // what was written last has had its `data` event by the time the streams close
    await sleep(20);
    const s = logSubst();
    return {
      exit,
      stdout: stdout.map((l) => normaliseLogLine(l, s)),
      // L3: the warnings of startup are compared; later, stderr holds the runtime's own report of an
      // internal error (a stack trace behind a 500), of which only its presence is compared
      stderr: stderr.slice(0, stderrAtReady).map((l) => normaliseLogLine(l, s)),
      stderrLater: stderr.length > stderrAtReady,
    };
  };

  // ---- answers ----
  const recordResponse = (r: RawResponse): Record<string, unknown> => {
    const headers: Record<string, string> = {};
    for (const k of Object.keys(r.headers).sort()) if (!DROPPED_HEADERS.has(k)) headers[k] = r.headers[k]!;
    const rec: Record<string, unknown> = { status: r.status, headers };
    if (r.error) rec.error = r.error;
    // R3: how long an address must wait for its verification budget follows from how long its checks took
    const budget = r.status === 429 && /too much verification work [a-z ]+; wait \d+ s/.test(r.body.toString("utf8"));
    if (budget) {
      headers["retry-after"] = "<s>";
      delete headers["content-length"];
    }
    let bytes = r.body;
    const packed: string[] = [];
    const unpack = (what: string) => {
      try {
        bytes = gunzipSync(bytes);
        packed.push(what);
      } catch (e) {
        rec.unpackError = `${what}: ${e instanceof Error ? e.message : String(e)}`;
      }
    };
    if (bytes.length && /\bgzip\b/.test(headers["content-encoding"] ?? "")) unpack("content-encoding");
    if (bytes.length && (headers["content-type"] ?? "").startsWith("application/gzip")) unpack("gzip file");
    if (packed.length) {
      // the bytes of a compressed body are the compressor's; what it holds is compared
      rec.unpacked = packed;
      delete headers["content-length"];
    }
    if (bytes.length === 0) rec.body = "";
    else {
      let text: string | null = null;
      if (bytes.length <= TEXT_CAP) {
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          text = null;
        }
      }
      if (text === null) rec.binary = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      else rec.body = budget ? mask(text).replace(/; wait \d+ s/, "; wait <s> s") : mask(text);
    }
    return rec;
  };

  const streams = new Map<string, SseStream>();
  const drain = async (s: SseStream, settleMs: number, atLeast: number, timeoutMs: number) => {
    const blocks: { lines: string[] }[] = [];
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      blocks.push(...s.take());
      const quiet = performance.now() - s.lastAt();
      if ((blocks.length >= atLeast && quiet >= settleMs) || performance.now() > deadline || s.ended()) break;
      await sleep(10);
    }
    blocks.push(...s.take());
    return blocks.map((b) => ({ lines: b.lines.map(mask) }));
  };

  let failure: string | null = null;
  let lastEnd = 0;
  try {
    if (header.autostart !== false) {
      const t0 = serverNow();
      await start();
      windows.push({ i: -1, t0: header.clockAt ? Date.parse(header.clockAt) : t0, t1: serverNow() });
      lastEnd = Date.now();
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      // a step begins in a later millisecond than the one before it ended, so that a time made by the
      // server belongs to one step
      if (timeLabels) while (Date.now() <= lastEnd) await sleep(1);
      const w = { i, t0: serverNow(), t1: Infinity };
      windows.push(w);
      const rec: Record<string, unknown> = { i, op: step.op };
      switch (step.op) {
        case "req": {
          const { op: _op, expect, note, ...spec } = step;
          const r = await send(port, spec);
          w.t1 = serverNow();
          Object.assign(rec, { request: `${spec.method ?? "GET"} ${spec.path}`, ...recordResponse(r) });
          if (expect !== undefined && r.status !== expect)
            warnings.push(`step ${i} (${rec.request}${note ? `, ${note}` : ""}): expected ${expect}, got ${r.status} ${r.body.toString("utf8").slice(0, 300)}`);
          break;
        }
        case "burst": {
          // all at once, or `concurrency` at a time in the order given
          const answers: RawResponse[] = new Array(step.requests.length);
          let nextRequest = 0;
          const lane = async () => {
            for (;;) {
              const k = nextRequest++;
              if (k >= step.requests.length) return;
              // `staggerMs`: each request this long after the one before, so that they arrive in their order
              if (step.staggerMs) await sleep(k * step.staggerMs);
              answers[k] = await send(port, step.requests[k]!);
            }
          };
          await Promise.all(Array.from({ length: Math.min(step.requests.length, step.concurrency ?? step.requests.length) }, lane));
          w.t1 = serverNow();
          if (step.summary) {
            // many answers: how many of each kind (status and body), not each one
            const kinds = new Map<string, number>();
            for (const r of answers) {
              const kind = `${r.status}${r.error ? ` ${r.error}` : ""} ${createHash("sha256").update(JSON.stringify(recordResponse(r))).digest("hex").slice(0, 16)}`;
              kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
            }
            rec.requests = step.requests.length;
            rec.kinds = Object.fromEntries([...kinds].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
            const sample = answers[0];
            if (sample) rec.first = recordResponse(sample);
            break;
          }
          let list = answers.map((r, k) => ({
            request: `${step.requests[k]!.method ?? "GET"} ${step.requests[k]!.path}`,
            ...recordResponse(r),
          }));
          if (step.unordered) list = list.map((x) => [JSON.stringify(x), x] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
          rec.unordered = !!step.unordered;
          rec.answers = list;
          break;
        }
        case "wait":
          await sleep(step.ms);
          break;
        case "sse_open": {
          const s = await openSse(port, step.path, step.headers ?? {});
          const headers: Record<string, string> = {};
          for (const k of Object.keys(s.headers).sort()) if (!DROPPED_HEADERS.has(k)) headers[k] = s.headers[k]!;
          rec.request = `GET ${step.path}`;
          rec.status = s.status;
          rec.headers = headers;
          if (s.status === 200 && (headers["content-type"] ?? "").startsWith("text/event-stream")) {
            streams.set(step.stream, s);
            // the greeting
            rec.events = await drain(s, 100, 1, 5000);
          } else {
            rec.body = mask((await s.body()).toString("utf8"));
          }
          break;
        }
        case "sse_drain": {
          const s = streams.get(step.stream);
          if (!s) throw new Error(`step ${i}: no open stream "${step.stream}"`);
          rec.events = await drain(s, step.settleMs ?? 150, step.atLeast ?? 0, step.timeoutMs ?? 5000);
          rec.ended = s.ended();
          break;
        }
        case "sse_close": {
          const s = streams.get(step.stream);
          if (!s) throw new Error(`step ${i}: no open stream "${step.stream}"`);
          rec.events = await drain(s, 100, 0, 2000);
          s.close();
          streams.delete(step.stream);
          break;
        }
        case "control": {
          const body: Record<string, unknown> = {};
          if (step.clockAdvanceMs !== undefined) {
            clockOffset += step.clockAdvanceMs;
            body.clockOffsetMs = clockOffset;
          }
          if (step.loopDelayMs !== undefined) body.loopDelayMs = step.loopDelayMs;
          if (step.flushStats) body.flushStats = true;
          const r = await send(port, { method: "POST", path: "/__test/control", json: body });
          // the step's window ends on the clock as it is now
          rec.status = r.status;
          rec.body = r.body.toString("utf8");
          rec.set = { ...step, op: undefined };
          if (r.status !== 200) warnings.push(`step ${i}: /__test/control answered ${r.status}`);
          break;
        }
        case "start":
          if (step.expectFail) {
            // a server that must refuse to start (a database it cannot convert): how it ended, not its last words
            try {
              await start();
              warnings.push(`step ${i}: the server started, and was expected not to`);
              rec.started = true;
            } catch {
              const exit = await (exited as Promise<{ code: number | null; signal: string | null }> | null);
              child = null;
              rec.started = false;
              rec.exitedWithError = !!exit && exit.code !== 0;
            }
          } else await start();
          break;
        case "stop":
          for (const s of streams.values()) s.close();
          streams.clear();
          Object.assign(rec, await stop());
          break;
        case "restart": {
          for (const s of streams.values()) s.close();
          streams.clear();
          Object.assign(rec, await stop());
          if (step.options && options !== null) options = { ...options, ...step.options };
          if (step.env) Object.assign(env, step.env);
          if (step.clockAt) setClockAt(step.clockAt);
          if (step.clockAdvanceMs) clockOffset += step.clockAdvanceMs;
          // the window of this step is on the new clock
          w.t0 = serverNow();
          await start();
          break;
        }
        case "sql": {
          if (child) throw new Error(`step ${i}: sql needs the server stopped`);
          const db = new DatabaseSync(dbPath);
          try {
            for (const s of step.statements) db.exec(s);
          } finally {
            db.close();
          }
          break;
        }
        case "file": {
          const path = join(tmp, step.path);
          if (step.remove) rmSync(path, { force: true, recursive: true });
          else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, step.gzipText !== undefined ? gzipSync(step.gzipText) : (step.text ?? ""));
          }
          break;
        }
        case "ls": {
          const dir = join(tmp, step.dir);
          const names = existsSync(dir) ? readdirSync(dir).sort() : null;
          rec.files =
            names &&
            names.map((n) => {
              const p = join(dir, n);
              const st = statSync(p);
              if (!st.isFile()) return { name: n, directory: true };
              return n.endsWith(".json") ? { name: n, text: mask(readFileSync(p, "utf8")) } : { name: n, bytes: st.size };
            });
          break;
        }
        case "dump":
          rec.database = dumpDatabase(dbPath, mask);
          break;
        default:
          throw new Error(`step ${i}: unknown op ${(step as { op: string }).op}`);
      }
      if (w.t1 === Infinity) w.t1 = serverNow();
      lastEnd = Date.now();
      emit(rec);
    }
  } catch (e) {
    failure = e instanceof Error ? (e.stack ?? e.message) : String(e);
    warnings.push(`the run failed: ${failure}`);
  } finally {
    for (const s of streams.values()) s.close();
    let last: Record<string, unknown> = {};
    try {
      last = await stop();
    } catch (e) {
      warnings.push(`stopping the server failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (child) (child as ChildProcess).kill("SIGKILL");
    const end: Record<string, unknown> = { i: steps.length, op: "end", ...last };
    if (failure) end.failure = failure.split("\n")[0];
    try {
      end.database = dumpDatabase(dbPath, mask);
    } catch (e) {
      end.database = { error: e instanceof Error ? e.message : String(e) };
    }
    emit(end);
  }
  writeFileSync(
    o.transcriptFile,
    JSON.stringify({ scenario: header.scenario, steps: steps.length, timeLabels }) + "\n" + out.join("\n") + "\n",
  );
  return { scenario: header.scenario, steps: steps.length, warnings, ms: performance.now() - began };
}
