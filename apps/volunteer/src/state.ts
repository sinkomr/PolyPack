/**
 * The state directory (default ~/.polypack-volunteer):
 *
 *   lock            the running copy's pid, host and start time; a second copy refuses to start
 *   memory.json     the engine's memory, rewritten atomically after each problem
 *   history.jsonl   one line per problem searched (HistoryLine), kept to the last 20,000
 *   best/N-M-P.json the best strict packing this machine found for a problem, with its provenance
 *
 * Every whole-file write goes to a temporary file that is then renamed over the target, so that an
 * interruption leaves either the old file or the new one, never half of one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { PackingConfig } from "@polypack/geometry";
import { problemKey } from "./format";
import type { Candidate, Problem } from "./types";
import { isFiniteNumber, readPieces } from "./validate";

/** Writes `data` to `path` through a temporary file in the same directory and a rename. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Blocks the thread for `ms`: the lock is taken synchronously, before anything else runs. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------- the lock ----------

export interface LockInfo {
  pid: number;
  hostname: string;
  started: string;
  /** Distinguishes this copy's lock from a later one that took over a stale lock. */
  token: string;
}

export class LockHeld extends Error {
  constructor(
    readonly path: string,
    readonly holder: LockInfo | null,
    detail?: string,
  ) {
    super(
      detail ??
        (holder
          ? `${path} is held by process ${holder.pid} on ${holder.hostname}, started ${holder.started}`
          : `${path} exists and cannot be read`),
    );
  }
}

/** Whether a process with this pid exists on this machine. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return typeof v?.pid === "number" && typeof v?.hostname === "string" ? (v as LockInfo) : null;
  } catch {
    return null;
  }
}

/** Tokens of the locks this process holds. A lock with this process's pid is stale unless listed. */
const heldHere = new Set<string>();

export class Lock {
  private released = false;
  constructor(
    readonly path: string,
    readonly info: LockInfo,
  ) {
    heldHere.add(info.token);
  }

  /** Removes the lock file if it is still this copy's. Safe to call more than once. */
  release(): void {
    if (this.released) return;
    this.released = true;
    heldHere.delete(this.info.token);
    if (readLock(this.path)?.token === this.info.token) rmSync(this.path, { force: true });
  }
}

export interface LockOptions {
  alive?: (pid: number) => boolean;
  /** This copy's pid and host name; tests stand in rival copies with their own. */
  pid?: number;
  hostname?: string;
  /** Called between finding a stale lock and taking it over; tests run a rival copy there. */
  beforeTakeover?: () => void;
  /** Age after which a takeover file is itself left over from a crash; default 10 s. */
  takeoverStaleMs?: number;
  /** How long to wait for another copy's takeover; default 2 s. */
  takeoverWaitMs?: number;
}

/**
 * Takes the lock at `path`, or throws LockHeld.
 *
 * The lock file is written complete under a temporary name and then hard-linked to `path`, which
 * fails when `path` exists: two copies starting together cannot both succeed, and nobody reads a
 * half-written lock.
 *
 * A lock is stale when it comes from this machine and its process no longer runs, or carries this
 * process's own pid without being held here (in a container every start is pid 1 on the same
 * host name). Removing a stale lock and linking a new one is not atomic, so takeovers go one at a
 * time through `path`.takeover, created exclusively: under it the lock is read again, and replaced
 * only if it is still the stale one. A takeover file older than 10 s was left by a crash and is
 * removed. A lock from another machine (a shared home directory) cannot be checked and counts as
 * held.
 */
export function acquireLock(path: string, o: LockOptions = {}): Lock {
  const alive = o.alive ?? pidAlive;
  const info: LockInfo = {
    pid: o.pid ?? process.pid,
    hostname: o.hostname ?? hostname(),
    started: new Date().toISOString(),
    token: randomUUID(),
  };
  const text = JSON.stringify(info) + "\n";
  const stale = (h: LockInfo | null): h is LockInfo =>
    h !== null && h.hostname === info.hostname && (h.pid === info.pid ? !heldHere.has(h.token) : !alive(h.pid));
  const tmp = `${path}.${info.token}.tmp`;
  writeFileSync(tmp, text);
  /** Links the lock into place; false when a lock is already there. */
  const link = (): boolean => {
    try {
      linkSync(tmp, path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // a file system without hard links: an exclusive create is nearly as good
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
      try {
        writeFileSync(path, text, { flag: "wx" });
        return true;
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw inner;
      }
    }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (link()) return new Lock(path, info);
      const holder = readLock(path);
      if (!stale(holder)) throw new LockHeld(path, holder);
      o.beforeTakeover?.();
      if (takeOver(path, holder.token, link, o)) return new Lock(path, info);
      // another copy replaced the stale lock first: look at its lock
    }
    throw new LockHeld(path, readLock(path));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Replaces the stale lock `staleToken` under the takeover file; false when it was replaced already. */
function takeOver(path: string, staleToken: string, link: () => boolean, o: LockOptions): boolean {
  const guard = `${path}.takeover`;
  const staleMs = o.takeoverStaleMs ?? 10_000;
  const deadline = Date.now() + (o.takeoverWaitMs ?? 2000);
  for (;;) {
    try {
      writeFileSync(guard, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let age: number;
    try {
      age = Date.now() - statSync(guard).mtimeMs;
    } catch {
      continue; // gone meanwhile: try again
    }
    if (age > staleMs) rmSync(guard, { force: true });
    else if (Date.now() >= deadline)
      throw new LockHeld(path, null, `another copy is taking over the stale lock ${path}`);
    else sleepSync(50);
  }
  try {
    const now = readLock(path);
    if (now && now.token !== staleToken) return false;
    rmSync(path, { force: true });
    return link();
  } finally {
    rmSync(guard, { force: true });
  }
}

// ---------- history and best packings ----------

export interface LeaderRef {
  id: number | null;
  score: number;
  name?: string;
}

/** One line of history.jsonl: one problem searched. */
export interface HistoryLine {
  /** When the problem was finished, ISO 8601. */
  time: string;
  N: number;
  M: number;
  P: number;
  /** Why the work list ranked it, and its priority there. */
  reason: string | null;
  priority: number | null;
  /** The site leader when the search began, and after it (re-read before submitting). */
  leader_before: LeaderRef | null;
  leader_after: LeaderRef | null;
  published: number | null;
  /** The best strict packing offered for submission: from this search, or an earlier one's file. */
  best: {
    score: number;
    method: string;
    seed: number;
    kind: string;
    budget: { time_s: number; evals?: number };
    from: "search" | "file";
  } | null;
  jobs: number;
  /** The engine's `stopped`, or "error" / "interrupted" when the host had to give up on it. */
  stopped: string;
  active_s: number;
  /** Seed of the engine's own choices. */
  engine_seed: number;
  /** Whether the client ran without submitting (--dry-run, or no --name). */
  dry_run?: boolean;
  /** Whether a POST was actually made. */
  submitted: boolean;
  decision: string;
  /** The server's answer to the submission. */
  status: number | null;
  response: {
    valid: boolean;
    leader: boolean;
    score: number | null;
    leader_score: number | null;
    id: number | null;
    pending_verification: boolean;
    reasons: string[];
  } | null;
  version: string;
}

/** best/N-M-P.json. */
export interface BestFile {
  N: number;
  M: number;
  P: number;
  score: number;
  strict: true;
  method: string;
  /** The method's resolved parameters. */
  params?: Record<string, unknown>;
  seed: number;
  budget: { time_s: number; evals?: number };
  kind: string;
  found_at: string;
  version: string;
  config: PackingConfig;
}

export function bestFileOf(c: Candidate, version: string, at = new Date()): BestFile {
  const { problem } = c.job;
  return {
    N: problem.N,
    M: problem.M,
    P: problem.P,
    score: c.score,
    strict: true,
    method: c.job.method,
    ...(c.params ? { params: c.params } : {}),
    seed: c.job.seed,
    budget: { ...c.job.budget },
    kind: c.job.kind,
    found_at: at.toISOString(),
    version,
    config: c.config,
  };
}

export function candidateOf(f: BestFile): Candidate {
  const problem = { N: f.N, M: f.M, P: f.P };
  return {
    config: f.config,
    score: f.score,
    strict: true,
    job: { problem, method: f.method, seed: f.seed, budget: { ...f.budget }, kind: f.kind },
    ...(f.params ? { params: f.params } : {}),
  };
}

/** Lines history.jsonl is cut back to: at a few problems an hour, months of searches. */
export const MAX_HISTORY_LINES = 20_000;
/** Temporary files older than this are left over from a crash. */
const STALE_TMP_MS = 10 * 60_000;

function parseHistory(text: string): { lines: HistoryLine[]; count: number } {
  const lines: HistoryLine[] = [];
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    count++;
    try {
      const v = JSON.parse(line);
      if (Number.isInteger(v?.N) && Number.isInteger(v?.M) && Number.isInteger(v?.P)) lines.push(v);
    } catch {
      // a line cut short by a crash
    }
  }
  return { lines, count };
}

export class StateDir {
  /** history.jsonl as it was read when the directory was opened, oldest first. */
  readonly initialHistory: HistoryLine[];
  private historyCount: number;

  private constructor(
    readonly dir: string,
    readonly lock: Lock,
    private readonly maxHistory: number,
  ) {
    this.removeStaleTemporaryFiles();
    const { lines, count } = this.loadHistory();
    this.initialHistory = lines;
    this.historyCount = count;
  }

  /** Creates the directory if needed and takes its lock; throws LockHeld when another copy runs. */
  static open(dir: string, o: { lock?: LockOptions; maxHistory?: number } = {}): StateDir {
    mkdirSync(join(dir, "best"), { recursive: true });
    const lock = acquireLock(join(dir, "lock"), o.lock);
    try {
      return new StateDir(dir, lock, o.maxHistory ?? MAX_HISTORY_LINES);
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  get memoryPath(): string {
    return join(this.dir, "memory.json");
  }
  get historyPath(): string {
    return join(this.dir, "history.jsonl");
  }
  bestPath(p: Problem): string {
    return join(this.dir, "best", `${problemKey(p)}.json`);
  }

  /** Removes *.tmp files that a crash left behind; a fresh one may be another copy's lock in progress. */
  private removeStaleTemporaryFiles(): void {
    for (const sub of [this.dir, join(this.dir, "best")]) {
      let names: string[];
      try {
        names = readdirSync(sub);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".tmp")) continue;
        try {
          const path = join(sub, name);
          if (Date.now() - statSync(path).mtimeMs > STALE_TMP_MS) rmSync(path, { force: true });
        } catch {
          // gone meanwhile
        }
      }
    }
  }

  /** Reads history.jsonl once: mends a line cut short by a crash and cuts the file back when long. */
  private loadHistory(): { lines: HistoryLine[]; count: number } {
    let text: string;
    try {
      text = readFileSync(this.historyPath, "utf8");
    } catch {
      return { lines: [], count: 0 };
    }
    const parsed = parseHistory(text);
    if (parsed.count > this.maxHistory) return this.compact(parsed.lines);
    // a line cut short by a crash must not swallow the next one
    if (text.length && !text.endsWith("\n")) appendFileSync(this.historyPath, "\n");
    return parsed;
  }

  /** Keeps the last maxHistory readable lines. */
  private compact(lines: HistoryLine[]): { lines: HistoryLine[]; count: number } {
    const kept = lines.slice(-this.maxHistory);
    writeFileAtomic(this.historyPath, kept.map((l) => JSON.stringify(l) + "\n").join(""));
    return { lines: kept, count: kept.length };
  }

  /** The engine's memory, or undefined when there is none or it cannot be read. */
  readMemory(): unknown {
    try {
      return JSON.parse(readFileSync(this.memoryPath, "utf8"));
    } catch {
      return undefined;
    }
  }

  writeMemory(memory: unknown): void {
    writeFileAtomic(this.memoryPath, (JSON.stringify(memory) ?? "null") + "\n");
  }

  appendHistory(line: HistoryLine): void {
    appendFileSync(this.historyPath, JSON.stringify(line) + "\n");
    // cut back now and then while running, not after every line
    if (++this.historyCount > this.maxHistory + Math.max(1, Math.floor(this.maxHistory / 20)))
      this.historyCount = this.compact(this.readHistory()).count;
  }

  /** Every readable line of history.jsonl, oldest first. */
  readHistory(): HistoryLine[] {
    try {
      return parseHistory(readFileSync(this.historyPath, "utf8")).lines;
    } catch {
      return [];
    }
  }

  /** The kept packing of a problem, or null when there is none or it does not fit the problem. */
  readBest(p: Problem): BestFile | null {
    try {
      const f = JSON.parse(readFileSync(this.bestPath(p), "utf8")) as BestFile;
      const c = f?.config;
      const b = f?.budget;
      const ok =
        f.N === p.N &&
        f.M === p.M &&
        f.P === p.P &&
        c?.N === p.N &&
        c.M === p.M &&
        c.P === p.P &&
        readPieces(c.pieces, p.P) !== null &&
        isFiniteNumber(c.container_phi) &&
        f.strict === true &&
        isFiniteNumber(f.score) &&
        f.score > 0 &&
        typeof f.method === "string" &&
        typeof f.kind === "string" &&
        Number.isSafeInteger(f.seed) &&
        f.seed >= 0 &&
        isFiniteNumber(b?.time_s) &&
        b.time_s > 0 &&
        (b.evals === undefined || (Number.isSafeInteger(b.evals) && b.evals > 0));
      return ok ? f : null;
    } catch {
      return null;
    }
  }

  writeBest(f: BestFile): void {
    writeFileAtomic(this.bestPath(f), JSON.stringify(f, null, 1) + "\n");
  }

  close(): void {
    this.lock.release();
  }
}
