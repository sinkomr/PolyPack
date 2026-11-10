import { PackingConfig, evaluate } from "@polypack/geometry";
import { readStoredBoard, taggedBoard } from "./board-units";

/**
 * Checkpoints: boards the player saves on purpose, several per problem, to come back to later (#56). The leaderboard's
 * best is usually already in a local minimum, and a worse but different layout can be a better place to start a search
 * from. They are kept in this browser only, in IndexedDB: a few boards of hundreds of pieces would soon fill
 * localStorage's 5 MB, which also holds the board's autosave. Without IndexedDB (or when it fails) they are kept in
 * memory and last until the page is closed.
 */

/** One saved board. */
export interface Checkpoint {
  /** Unique id, also the IndexedDB key. */
  id: string;
  /** The problem, "N/M/P". */
  key: string;
  name: string;
  /** Container size when all P pieces were placed, otherwise null. */
  score: number | null;
  /** Pieces placed when it was saved. */
  placed: number;
  /** ISO time it was saved. */
  savedAt: string;
  /** The board as the autosave and Export JSON write it (with its units tag). */
  board: PackingConfig & { units: string };
  /** Size of the board as JSON, in bytes: what the checkpoint costs to keep, near enough. */
  bytes: number;
}

/** Where checkpoints are kept. */
export interface CheckpointStore {
  all(): Promise<Checkpoint[]>;
  put(c: Checkpoint): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

/** A store that keeps nothing past the page (tests, and browsers without IndexedDB). */
export class MemoryCheckpointStore implements CheckpointStore {
  rows = new Map<string, Checkpoint>();
  async all(): Promise<Checkpoint[]> {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  async put(c: Checkpoint): Promise<void> {
    this.rows.set(c.id, structuredClone(c));
  }
  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
}

export const DB_NAME = "polypack-checkpoints";
export const STORE_NAME = "checkpoints";

/** The IndexedDB store, or null where the browser has none. */
export function idbCheckpointStore(): CheckpointStore | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME))
          req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opened = null; // try again next time
        reject(req.error);
      };
    }));
  const write = async (fn: (os: IDBObjectStore) => void) => {
    const tx = (await open()).transaction(STORE_NAME, "readwrite");
    fn(tx.objectStore(STORE_NAME));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    async all() {
      const req = (await open()).transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      return new Promise<Checkpoint[]>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as Checkpoint[]);
        req.onerror = () => reject(req.error);
      });
    },
    put: (c) => write((os) => void os.put(c)),
    remove: (ids) => (ids.length ? write((os) => ids.forEach((id) => os.delete(id))) : Promise.resolve()),
  };
}

export const problemKey = (c: { N: number; M: number; P: number }) => `${c.N}/${c.M}/${c.P}`;

/** A new id: the time, then random letters, so ids never collide across tabs. */
function newId(now: number): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return `${now.toString(36)}-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Longest name kept. */
export const MAX_NAME = 80;

/** A checkpoint of a board. The score is the container size, when all P pieces are placed and the board is valid. */
export function makeCheckpoint(config: PackingConfig, name: string, now = Date.now()): Checkpoint {
  const board = taggedBoard(config);
  const complete = config.pieces.length === config.P;
  const result = complete ? evaluate(config) : null;
  const score = result?.valid && result.container ? result.container.size : null;
  return {
    id: newId(now),
    key: problemKey(config),
    name: name.trim().slice(0, MAX_NAME),
    score,
    placed: config.pieces.length,
    savedAt: new Date(now).toISOString(),
    board,
    bytes: new TextEncoder().encode(JSON.stringify(board)).length,
  };
}

/** The board of a checkpoint, ready for Board.load, or why it can't be read. */
export function checkpointBoard(c: Checkpoint): { ok: true; config: PackingConfig } | { ok: false; error: string } {
  const r = readStoredBoard(c.board);
  return r.ok ? { ok: true, config: r.config } : { ok: false, error: r.errors.join("; ") };
}

/** Best first: complete boards by score, then incomplete ones by pieces placed; newest first among equals. */
export function byScore(a: Checkpoint, b: Checkpoint): number {
  if (a.score !== null && b.score !== null && a.score !== b.score) return a.score - b.score;
  if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
  if (a.placed !== b.placed) return b.placed - a.placed;
  return b.savedAt.localeCompare(a.savedAt);
}

/** What one problem's checkpoints add up to, for the overview. */
export interface ProblemSummary {
  key: string;
  count: number;
  bytes: number;
  /** Best complete score, or null. */
  best: number | null;
  /** When the newest one was saved. */
  newest: string;
}

/** The checkpoints in memory, written through to the store. */
export class Checkpoints {
  private rows = new Map<string, Checkpoint>();
  /** Bumped at every change, for whoever draws them. */
  version = 0;

  constructor(private store: CheckpointStore | null) {}

  /** Whether they are kept past this page. */
  get persistent(): boolean {
    return this.store !== null;
  }

  /** Reads them from the store again (another tab may have changed them). Keeps what's in memory if that fails. */
  async reload(): Promise<boolean> {
    if (!this.store) return true;
    try {
      const all = await this.store.all();
      this.rows = new Map(all.map((c) => [c.id, c]));
      this.version++;
      return true;
    } catch {
      return false;
    }
  }

  get size(): number {
    return this.rows.size;
  }

  get bytes(): number {
    let n = 0;
    for (const c of this.rows.values()) n += c.bytes;
    return n;
  }

  get(id: string): Checkpoint | undefined {
    return this.rows.get(id);
  }

  /** One problem's checkpoints, best first. */
  forProblem(key: string): Checkpoint[] {
    return [...this.rows.values()].filter((c) => c.key === key).sort(byScore);
  }

  /** Every problem with checkpoints, most recently saved first. */
  summary(): ProblemSummary[] {
    const by = new Map<string, ProblemSummary>();
    for (const c of this.rows.values()) {
      const s = by.get(c.key) ?? { key: c.key, count: 0, bytes: 0, best: null, newest: "" };
      s.count++;
      s.bytes += c.bytes;
      if (c.score !== null && (s.best === null || c.score < s.best)) s.best = c.score;
      if (c.savedAt > s.newest) s.newest = c.savedAt;
      by.set(c.key, s);
    }
    return [...by.values()].sort((a, b) => b.newest.localeCompare(a.newest) || a.key.localeCompare(b.key));
  }

  /** Saves a checkpoint. Throws when the store can't write it; then it isn't kept in memory either. */
  async add(c: Checkpoint): Promise<void> {
    await this.store?.put(c);
    this.rows.set(c.id, c);
    this.version++;
  }

  /** Deletes checkpoints by id. Throws when the store can't; then nothing is removed from memory. */
  async remove(ids: string[]): Promise<number> {
    const present = ids.filter((id) => this.rows.has(id));
    if (!present.length) return 0;
    await this.store?.remove(present);
    for (const id of present) this.rows.delete(id);
    this.version++;
    return present.length;
  }

  /** Deletes every checkpoint of one problem. */
  removeProblem(key: string): Promise<number> {
    return this.remove(this.forProblem(key).map((c) => c.id));
  }

  /** Deletes every checkpoint. */
  removeAll(): Promise<number> {
    return this.remove([...this.rows.keys()]);
  }
}

/** A size for people: "820 B", "14.2 KB", "3.1 MB". */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(1)} KB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}
