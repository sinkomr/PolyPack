import type { GameState, PastProblem } from "./game";
import { RENT_CLASSES, rentClass } from "./standing";

/**
 * The record archive.
 *
 * The save keeps the last PAST_LIMIT problems that left the queue. A record the player still holds on
 * an older problem would be forgotten with it, so it moves here instead: one row per problem key,
 * kept in IndexedDB (the save is one string in localStorage, which holds about 5 MB). A row is the
 * past entry, with its base (the record points earned before multipliers) that rent is a share of.
 *
 * The archive is never part of the save string (toJson): a game holds it by reference (attachArchive),
 * and it is saved on its own, incrementally. Without IndexedDB, or when it fails, the rows stay in
 * memory and are lost on a reload, which is how records past the save's limit behaved before.
 */

/** A row is a past entry; its `base` (record points earned before multipliers) is the rent's basis. */
export type ArchiveRow = PastProblem;

/** Where the rows are kept. */
export interface ArchiveStore {
  loadAll(): Promise<ArchiveRow[]>;
  /** Writes and removes rows in one transaction. */
  apply(puts: ArchiveRow[], deletes: string[]): Promise<void>;
}

/** A store that keeps nothing past the page (tests, and browsers without IndexedDB). */
export class MemoryStore implements ArchiveStore {
  rows = new Map<string, ArchiveRow>();
  /** Every apply call, for tests: how many rows were written and removed. */
  writes: { puts: number; deletes: number }[] = [];
  async loadAll(): Promise<ArchiveRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async apply(puts: ArchiveRow[], deletes: string[]): Promise<void> {
    this.writes.push({ puts: puts.length, deletes: deletes.length });
    for (const k of deletes) this.rows.delete(k);
    for (const r of puts) this.rows.set(r.key, { ...r });
  }
}

/** The database of a save's archive: one per save (GameState.archiveId), so a new game never reads another's rows. */
export const dbName = (archiveId: string) => `tighter-archive-${archiveId}`;
export const STORE_NAME = "records";

/** A new archive id: 16 random bytes, base64url. */
export function newArchiveId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The IndexedDB store of the save whose archive id this is, or null where the browser has none. */
export function idbStore(archiveId: string): ArchiveStore | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName(archiveId), 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME))
          req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const done = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  return {
    async loadAll() {
      const db = await open();
      const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      return new Promise<ArchiveRow[]>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as ArchiveRow[]);
        req.onerror = () => reject(req.error);
      });
    },
    async apply(puts, deletes) {
      if (!puts.length && !deletes.length) return;
      const db = await open();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const os = tx.objectStore(STORE_NAME);
      for (const k of deletes) os.delete(k);
      for (const r of puts) os.put(r);
      await done(tx);
    },
  };
}

const effectiveBase = (r: ArchiveRow) => r.base ?? r.rp;

export class Archive {
  private rows = new Map<string, ArchiveRow>();
  private dirty = new Set<string>();
  private gone = new Set<string>();
  /** Sum of the rows' base by rent class (standing.ts rentClass), kept as rows change. */
  private sums: number[] = new Array(RENT_CLASSES).fill(0);
  private writing: Promise<void> = Promise.resolve();
  /** Bumped at every change of a row, for caches. */
  version = 0;
  /** Whether the rows of the store are in (a memory archive starts loaded). */
  loaded: boolean;

  constructor(
    private store: ArchiveStore | null = null,
    loaded = store === null,
  ) {
    this.loaded = loaded;
  }

  get size(): number {
    return this.rows.size;
  }
  get(key: string): ArchiveRow | undefined {
    return this.rows.get(key);
  }
  has(key: string): boolean {
    return this.rows.has(key);
  }
  values(): IterableIterator<ArchiveRow> {
    return this.rows.values();
  }
  keys(): IterableIterator<string> {
    return this.rows.keys();
  }
  /** Sum of the base of the rows of one rent class. */
  baseSum(c: number): number {
    return this.sums[c];
  }

  private add(row: ArchiveRow): void {
    this.rows.set(row.key, row);
    this.sums[rentClass(row)] += effectiveBase(row);
  }
  private take(key: string): ArchiveRow | undefined {
    const old = this.rows.get(key);
    if (!old) return undefined;
    this.rows.delete(key);
    this.sums[rentClass(old)] -= effectiveBase(old);
    return old;
  }

  /** Adds a row, or replaces the one with its key. */
  put(row: ArchiveRow): void {
    this.take(row.key);
    this.add(row);
    this.dirty.add(row.key);
    this.gone.delete(row.key);
    this.version++;
  }

  /** Removes a row; whether there was one. */
  remove(key: string): boolean {
    if (!this.take(key)) return false;
    this.dirty.delete(key);
    this.gone.add(key);
    this.version++;
    return true;
  }

  /** Replaces every row (an import). */
  replaceAll(rows: ArchiveRow[]): void {
    for (const k of [...this.rows.keys()]) this.remove(k);
    this.sums.fill(0);
    for (const r of rows) this.put(r);
  }

  /**
   * Reads the store's rows once. Rows already in memory win; a row whose problem is in the queue or
   * the past (`known`: a regained record, a Retake) is dropped, the entry there wins. Returns how many rows came in.
   */
  async load(known: (key: string) => boolean): Promise<number> {
    if (this.loaded) return 0;
    let stored: ArchiveRow[] = [];
    try {
      stored = this.store ? await this.store.loadAll() : [];
    } catch {
      // unreadable: the game goes on without the old rows, which stay in the store
      this.loaded = true;
      return 0;
    }
    const drop: string[] = [];
    let n = 0;
    for (const r of stored) {
      if (this.rows.has(r.key) || this.gone.has(r.key)) continue;
      if (known(r.key)) {
        drop.push(r.key);
        continue;
      }
      this.add(r);
      n++;
    }
    this.version++;
    this.loaded = true;
    if (drop.length) void this.store?.apply([], drop).catch(() => undefined);
    return n;
  }

  /** Writes the rows changed since the last flush, in one transaction. Never throws. */
  flush(): Promise<void> {
    if (!this.store || !this.loaded || (!this.dirty.size && !this.gone.size)) return this.writing;
    const puts = [...this.dirty].map((k) => this.rows.get(k)!).filter(Boolean);
    const deletes = [...this.gone];
    this.dirty.clear();
    this.gone.clear();
    const store = this.store;
    this.writing = this.writing.then(() =>
      store.apply(puts, deletes).catch(() => {
        // not written: try these rows again at the next flush
        for (const r of puts) if (this.rows.has(r.key)) this.dirty.add(r.key);
        for (const k of deletes) if (!this.rows.has(k)) this.gone.add(k);
      }),
    );
    return this.writing;
  }
}

// ---------- a game's archive ----------

/** The archive of each game, by reference: it is never a field of the game, so the save never holds it. */
const archives = new WeakMap<GameState, Archive>();

export const archiveOf = (s: GameState): Archive | undefined => archives.get(s);
export function attachArchive(s: GameState, a: Archive): void {
  archives.set(s, a);
}
/** The game's archive, a memory one when it has none. */
export function ensureArchive(s: GameState): Archive {
  let a = archives.get(s);
  if (!a) archives.set(s, (a = new Archive()));
  return a;
}
/** Rows in the game's archive. */
export const archivedCount = (s: GameState): number => archives.get(s)?.size ?? 0;
/** Whether the archive's rows are in (true when the game has none). */
export const archiveReady = (s: GameState): boolean => archives.get(s)?.loaded ?? true;
