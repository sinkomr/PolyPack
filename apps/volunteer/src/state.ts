/**
 * The state directory (default ~/.polypack-volunteer):
 *
 *   lock            the running copy's pid, host and start time; a second copy refuses to start
 *   memory.json     the engine's memory, rewritten atomically after each problem
 *   history.jsonl   one line per problem searched (HistoryLine)
 *   best/N-M-P.json the best strict packing this machine found for a problem, with its provenance
 *
 * Every whole-file write goes to a temporary file that is then renamed over the target, so that an
 * interruption leaves either the old file or the new one, never half of one.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { PackingConfig } from "@polypack/geometry";
import { problemKey } from "./format";
import type { Candidate, Problem } from "./types";

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
  ) {
    super(
      holder
        ? `${path} is held by process ${holder.pid} on ${holder.hostname}, started ${holder.started}`
        : `${path} exists and cannot be read`,
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

export class Lock {
  private released = false;
  constructor(
    readonly path: string,
    readonly info: LockInfo,
  ) {}

  /** Removes the lock file if it is still this copy's. Safe to call more than once. */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (readLock(this.path)?.token === this.info.token) rmSync(this.path, { force: true });
  }
}

/**
 * Takes the lock at `path`, or throws LockHeld. The lock file is written complete under a
 * temporary name and then hard-linked to `path`, which fails when `path` exists: two copies
 * starting together cannot both succeed, and nobody reads a half-written lock. A lock left by a
 * copy on this machine that no longer runs is stale and is taken over. One from another machine
 * (a shared home directory) cannot be checked and counts as held.
 */
export function acquireLock(path: string, alive: (pid: number) => boolean = pidAlive): Lock {
  const info: LockInfo = {
    pid: process.pid,
    hostname: hostname(),
    started: new Date().toISOString(),
    token: randomUUID(),
  };
  const tmp = `${path}.${info.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(info) + "\n");
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, path);
        return new Lock(path, info);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          // a file system without hard links: an exclusive create is nearly as good
          if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
            try {
              writeFileSync(path, JSON.stringify(info) + "\n", { flag: "wx" });
              return new Lock(path, info);
            } catch (inner) {
              if ((inner as NodeJS.ErrnoException).code !== "EEXIST") throw inner;
            }
          } else throw error;
        }
      }
      const holder = readLock(path);
      if (!holder || holder.hostname !== info.hostname || alive(holder.pid)) throw new LockHeld(path, holder);
      rmSync(path, { force: true });
    }
    throw new LockHeld(path, readLock(path));
  } finally {
    rmSync(tmp, { force: true });
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

export class StateDir {
  private constructor(
    readonly dir: string,
    readonly lock: Lock,
  ) {}

  /** Creates the directory if needed and takes its lock; throws LockHeld when another copy runs. */
  static open(dir: string): StateDir {
    mkdirSync(join(dir, "best"), { recursive: true });
    const state = new StateDir(dir, acquireLock(join(dir, "lock")));
    // a line cut short by a crash must not swallow the next one
    const history = state.historyPath;
    if (existsSync(history)) {
      const text = readFileSync(history, "utf8");
      if (text.length && !text.endsWith("\n")) appendFileSync(history, "\n");
    }
    return state;
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
  }

  /** Every readable line of history.jsonl, oldest first. */
  readHistory(): HistoryLine[] {
    let text: string;
    try {
      text = readFileSync(this.historyPath, "utf8");
    } catch {
      return [];
    }
    const out: HistoryLine[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line);
        if (Number.isInteger(v?.N) && Number.isInteger(v?.M) && Number.isInteger(v?.P)) out.push(v);
      } catch {
        // a line cut short by a crash
      }
    }
    return out;
  }

  readBest(p: Problem): BestFile | null {
    try {
      const f = JSON.parse(readFileSync(this.bestPath(p), "utf8")) as BestFile;
      const ok =
        f.N === p.N &&
        f.M === p.M &&
        f.P === p.P &&
        f.strict === true &&
        Number.isFinite(f.score) &&
        typeof f.method === "string" &&
        Array.isArray(f.config?.pieces);
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
