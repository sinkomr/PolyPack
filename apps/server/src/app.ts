import {
  AtlasResponse,
  AtlasTile,
  Holder,
  HoldersResponse,
  LeaderboardEntry,
  LeaderboardEvent,
  LiteratureRecord,
  MAX_EVENT_KEYS,
  MAX_PIECES,
  MAX_SIDES,
  ProblemInfo,
  SubmitResponse,
  TOL,
  TargetRanking,
  TargetsResponse,
  areaLowerBound,
  beatsLiterature,
  closedToSubmissions,
  evaluate,
  isShapeCode,
  parseConfig,
  MAX_SOFTWARE_LENGTH,
  parseProvenance,
  rankTargets,
  reachesLiterature,
  strictVerify,
} from "@polypack/geometry";
import { Context, Hono } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { SOLVER_METHODS, docsPage } from "./docs";
import {
  MAX_BODY_BYTES,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_REPORTED_OVERLAPS,
  OVERLOAD_DELAY_MS,
  OVERLOAD_RETRY_S,
  RateLimiter,
  SUBMISSIONS_PER_MINUTE,
  TimeBudget,
  VERIFY_MS_PER_MINUTE,
  addressKey,
  readBodyWithin,
  sanitizeText,
} from "./limits";
import { LoadStats } from "./load";
import {
  CONVENTIONS_VERSION,
  UNITS_MISSING_MESSAGE,
  UPGRADE_MESSAGE,
  isOldVolunteer,
  oldClientMayRead,
  planarAffected,
} from "./units-gate";
import type { SnapshotSource } from "./snapshot";
import { registerLeadersRoute } from "./leaders";
import { SpacesOptions, registerSpaceRoutes } from "./spaces";
import { EntryEdit, ProblemLeader, Store, StoredSubmission } from "./store";

/** Names a submission may give as its `method`: the registered search methods. */
const METHOD_NAMES = SOLVER_METHODS.map(([name]) => name);

export interface AppOptions {
  store: Store;
  records: LiteratureRecord[];
  /** Admin routes are disabled when this is empty. */
  adminToken?: string;
  /** Address used for rate limiting; IPv6 addresses are limited by their /64 (see addressKey). */
  clientIp?: (c: Context) => string;
  /** Called for submissions that beat the literature. */
  log?: (msg: string) => void;
  /**
   * `perIp` submissions per `windowMs` from one address, and `verifyMsPerMinute` milliseconds of
   * verification a minute; `overloadDelayMs` is the event-loop delay above which submissions are
   * refused (0: never).
   */
  limits?: { perIp?: number; windowMs?: number; verifyMsPerMinute?: number; overloadDelayMs?: number };
  /** The current event-loop delay in ms (see LoopDelay); without it submissions are never refused as overload. */
  loopDelay?: () => number;
  /** Receives a line per submission and the counts for a line a minute (see LoadStats). */
  stats?: LoadStats;
  /**
   * Least age at which the leaders of every problem are read again after an entry changed, for
   * /api/holders and /api/targets; HOLDERS_REFRESH_MS by default.
   */
  holdersRefreshMs?: number;
  /** Least age at which /api/targets is ranked again after an entry changed; TARGETS_REFRESH_MS by default. */
  targetsRefreshMs?: number;
  /**
   * Whether a submission to a problem with disk or ball pieces or a circle or ball container must carry
   * `"units": "diameter"` (426 without it). On by default; the gate stays until its sunset date.
   */
  unitsGate?: boolean;
  /** The nightly records snapshot; without it /api/snapshot answers 404. */
  snapshots?: SnapshotSource;
  /**
   * The spaces (surface, curved, sphere, torus, polyhedra): their catalogues and the store of their site
   * entries. Without it the /api/spaces routes answer 404.
   */
  spaces?: SpacesOptions;
}

const CONVENTIONS = {
  version: CONVENTIONS_VERSION,
  units:
    "polygon pieces have side length 1; disk (circle) pieces have diameter 1 (radius 1/2); angles in radians; " +
    'a submission to a problem with disk or ball pieces or a circle or ball container carries "units": "diameter"',
  piece_pose:
    "N-gon vertex k = (x, y) + R (cos(theta + pi/2 + 2 pi k / N), sin(theta + pi/2 + 2 pi k / N)), R = 1 / (2 sin(pi / N)); circles ignore theta",
  container:
    "regular M-gon vertex k = (cx, cy) + s / (2 sin(pi / M)) (cos(phi - pi/2 + pi/M + 2 pi k / M), sin(...)); circle given by centre and size (its diameter)",
  score: "container side length s (polygon) or diameter (circle); smaller is better",
  shapes: `N and M are 0 for a circle or an integer from 3 to ${MAX_SIDES}; P is from 1 to ${MAX_PIECES}`,
  validity: `pieces may touch; two pieces overlap when their separation is below -${TOL}`,
  scoring:
    "the server scores the container at the container_phi sent (0 when it is missing) and does not search for a better orientation: turn the container to its best orientation before submitting",
};

/** Most values of P that one /api/atlas request may cover. */
export const ATLAS_MAX_SPAN = 100;
/** Most bytes of /api/records answers the server keeps in memory. */
export const RECORDS_CACHE_BYTES = 64 * 1024 * 1024;
/** Most pieces one /api/atlas response carries; the rest of the range is reached through `next`. */
export const ATLAS_MAX_PIECES = 6000;
/**
 * How far /api/holders may lag behind the entries: the leaders it is counted from are read again at
 * most once every 15 minutes (each reading holds the event loop for about a second on the live
 * server). /api/targets is ranked from the same reading.
 */
export const HOLDERS_REFRESH_MS = 900_000;
/** How far the ranking of /api/targets may lag behind the reading: it is ranked again at most every 30 minutes. */
export const TARGETS_REFRESH_MS = 1_800_000;
/** Targets one /api/targets answer holds without a `limit`. */
export const TARGETS_DEFAULT_LIMIT = 500;
/** Largest `limit` of /api/targets. */
export const TARGETS_MAX_LIMIT = 2000;

/**
 * Which packing the atlas draws for one P.
 *  - "verified": the best site entry that is not awaiting review, when it is at least as good as
 *    the published value, to the precision the source prints (never finer than 1e-9, so that a
 *    re-derived optimum such as 3.0000000000000004 still counts as matching 3);
 *  - "literature": otherwise the published coordinates;
 *  - "verified" again: a verified entry that is worse than a published value without coordinates
 *    is still the best packing that can be drawn;
 *  - "pending": an entry that claims to beat the published value and has not been reviewed is
 *    drawn only when nothing else can be, and the answer marks it as pending.
 */
export function atlasSource(
  verified: { score: number } | undefined,
  lit: LiteratureRecord | undefined,
  pending?: { score: number },
): "verified" | "literature" | "pending" | null {
  if (verified && (!lit || reachesLiterature(verified.score, lit))) return "verified";
  if (lit?.pieces) return "literature";
  if (verified) return "verified";
  return pending ? "pending" : null;
}

/**
 * The keys of GET /api/events?keys=...: comma-separated "N/M/P" (one problem) or "N/M/*" (every P
 * of a pair), at most MAX_EVENT_KEYS, written back in one form ("04/4/11" is "4/4/11"); an empty
 * list follows nothing. A message when the text is not such a list.
 */
export function parseEventKeys(text: string): string[] | string {
  const keys = new Set<string>();
  for (const part of text === "" ? [] : text.split(",")) {
    const m = /^(\d{1,3})\/(\d{1,3})\/(\d{1,3}|\*)$/.exec(part);
    const N = Number(m?.[1]);
    const M = Number(m?.[2]);
    const P = m?.[3] === "*" ? "*" : Number(m?.[3]);
    if (!isShapeCode(N) || !isShapeCode(M) || (P !== "*" && !(P >= 1 && P <= MAX_PIECES)))
      return `keys must be N/M/P or N/M/*, separated by commas, with N and M 0 or 3 to ${MAX_SIDES} and P 1 to ${MAX_PIECES}; "${part.slice(0, 20)}" is not`;
    keys.add(`${N}/${M}/${P}`);
  }
  if (keys.size > MAX_EVENT_KEYS) return `at most ${MAX_EVENT_KEYS} keys`;
  return [...keys];
}

/** A query value that is a plain decimal integer; anything else (empty, "0x10", "1e2", "1.5") is NaN. */
function decimalInteger(text: string | undefined): number {
  return text !== undefined && /^\d{1,9}$/.test(text) ? Number(text) : NaN;
}

/**
 * A query value that lists shape codes, such as "0,3-6": plain decimal integers and ranges a-b
 * whose ends are shape codes, separated by commas. A range leaves out 1 and 2, which are not.
 * Null for anything else, an empty item or a reversed range included.
 */
function shapeList(text: string): number[] | null {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const m = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(item);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (!isShapeCode(lo) || !isShapeCode(hi) || hi < lo) return null;
    for (let v = lo; v <= hi; v++) if (isShapeCode(v)) out.add(v);
  }
  return [...out];
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The HTTP API. Host-neutral: everything it needs comes in through the options. */
export function createApp(opts: AppOptions): Hono {
  const { store } = opts;
  const unitsGate = opts.unitsGate !== false;
  const app = new Hono();
  // Volunteer clients older than the unit change would read new-unit leaders as old ones and send old-unit packings that
  // pass as valid but poor: they are told to update (426) before anything else; the index, health and snapshot stay open.
  app.use("/api/*", async (c, next) => {
    if (isOldVolunteer(c.req.header("user-agent")) && !oldClientMayRead(c.req.method, c.req.path))
      return c.json({ error: UPGRADE_MESSAGE, reasons: [UPGRADE_MESSAGE], conventions_version: CONVENTIONS_VERSION }, 426);
    await next();
  });
  const windowMs = opts.limits?.windowMs ?? 60_000;
  const ipLimit = new RateLimiter(opts.limits?.perIp ?? SUBMISSIONS_PER_MINUTE, windowMs);
  const verifyBudget = new TimeBudget(opts.limits?.verifyMsPerMinute ?? VERIFY_MS_PER_MINUTE);
  const overloadDelayMs = opts.limits?.overloadDelayMs ?? OVERLOAD_DELAY_MS;
  const loopDelay = opts.loopDelay ?? (() => 0);
  const clientIp = opts.clientIp ?? (() => "unknown");
  const log = opts.log ?? ((msg: string) => console.log(msg));

  const literature = new Map<string, LiteratureRecord>();
  for (const r of opts.records) literature.set(`${r.N}/${r.M}/${r.P}`, r);

  /**
   * Closed problems take no submissions and show no site entries: their published optimum stands.
   * Entries stored before a problem was closed stay in the database and keep their share links.
   */
  const closed = (N: number, M: number, P: number) => closedToSubmissions(literature.get(`${N}/${M}/${P}`));

  // Live updates go to the streams that follow the problem, by "N/M/P" or "N/M/*", and to those that
  // follow every problem, so that each change costs a write per interested stream only.
  type Listener = (e: LeaderboardEvent) => void;
  const followAll = new Set<Listener>();
  const followers = new Map<string, Set<Listener>>();
  const follow = (fn: Listener, keys: string[] | null) => {
    if (!keys) return void followAll.add(fn);
    for (const k of keys) {
      const set = followers.get(k);
      if (set) set.add(fn);
      else followers.set(k, new Set([fn]));
    }
  };
  const unfollow = (fn: Listener, keys: string[] | null) => {
    if (!keys) return void followAll.delete(fn);
    for (const k of keys) {
      const set = followers.get(k);
      set?.delete(fn);
      if (set?.size === 0) followers.delete(k);
    }
  };
  const announce = (e: LeaderboardEvent) => {
    for (const fn of followAll) fn(e);
    const one = followers.get(`${e.N}/${e.M}/${e.P}`);
    const pair = followers.get(`${e.N}/${e.M}/*`);
    for (const fn of one ?? []) fn(e);
    for (const fn of pair ?? []) if (!one?.has(fn)) fn(e);
  };

  /** Reads N, M, P from the path; null when out of range. */
  const problemOf = (c: Context): { N: number; M: number; P: number } | null => {
    const N = Number(c.req.param("N"));
    const M = Number(c.req.param("M"));
    const P = Number(c.req.param("P"));
    if (!isShapeCode(N) || !isShapeCode(M) || !Number.isInteger(P) || P < 1 || P > MAX_PIECES) return null;
    return { N, M, P };
  };
  const badProblem = (c: Context) =>
    c.json(
      { error: `N and M must be 0 or an integer from 3 to ${MAX_SIDES}; P an integer from 1 to ${MAX_PIECES}` },
      400,
    );

  app.get("/api", (c) =>
    c.html(
      docsPage({
        atlasMaxSpan: ATLAS_MAX_SPAN,
        atlasMaxPieces: ATLAS_MAX_PIECES,
        targetsDefaultLimit: TARGETS_DEFAULT_LIMIT,
        targetsMaxLimit: TARGETS_MAX_LIMIT,
      }),
    ),
  );
  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/problems/:N/:M/:P", async (c) => {
    const p = problemOf(c);
    if (!p) return badProblem(c);
    const open = !closed(p.N, p.M, p.P);
    const body: ProblemInfo = {
      ...p,
      conventions: CONVENTIONS,
      area_bound: areaLowerBound(p.N, p.M, p.P),
      literature: literature.get(`${p.N}/${p.M}/${p.P}`) ?? null,
      site_best: open ? await store.leader(p.N, p.M, p.P) : null,
      accepts_submissions: open,
    };
    return c.json(body);
  });

  app.get("/api/leaderboard/:N/:M/:P", async (c) => {
    const p = problemOf(c);
    if (!p) return badProblem(c);
    const open = !closed(p.N, p.M, p.P);
    const [leader, total] = await Promise.all([open ? store.leader(p.N, p.M, p.P) : null, store.count(p.N, p.M, p.P)]);
    // `entries` is a list for clients written when several rows were shown; it holds the leader only
    return c.json({ ...p, entries: leader ? [leader] : [], total, accepts_submissions: open });
  });

  // The listing of one (N, M) runs a query over every entry of the pair, and SQLite blocks the
  // process while it does, so answers are kept until an entry of that pair changes. A new entry
  // clears its own pair; an administrator's change, rare, clears all. The bytes kept are bounded.
  const recordsCache = new Map<string, string>();
  let recordsCacheBytes = 0;
  const forgetRecords = (key?: string) => {
    if (key === undefined) {
      recordsCache.clear();
      recordsCacheBytes = 0;
      return;
    }
    const old = recordsCache.get(key);
    if (old !== undefined) recordsCacheBytes -= old.length;
    recordsCache.delete(key);
  };
  const keepRecords = (key: string, body: string) => {
    forgetRecords(key);
    // the oldest answers go first
    for (const [k] of recordsCache) {
      if (recordsCacheBytes + body.length <= RECORDS_CACHE_BYTES) break;
      forgetRecords(k);
    }
    if (body.length > RECORDS_CACHE_BYTES) return;
    recordsCache.set(key, body);
    recordsCacheBytes += body.length;
  };

  app.get("/api/records", async (c) => {
    const N = Number(c.req.query("N"));
    const M = Number(c.req.query("M"));
    if (!isShapeCode(N) || !isShapeCode(M)) return c.json({ error: "query parameters N and M are required" }, 400);
    const key = `${N}/${M}`;
    const cached = recordsCache.get(key);
    if (cached !== undefined) return c.body(cached, 200, { "content-type": "application/json" });
    // coordinates are left out of the listing; /api/problems/{N}/{M}/{P} has them
    const lit = opts.records
      .filter((r) => r.N === N && r.M === M)
      .sort((a, b) => a.P - b.P)
      .map(({ pieces, ...rest }) => ({ ...rest, has_coordinates: !!pieces }));
    const site = (await store.bestPerP(N, M)).filter((e) => !closed(N, M, e.P));
    // Where the best entry of a P still awaits review, the best reviewed one is listed as well, so
    // that a page never has to present an unverified claim as the smallest known value.
    const awaiting = new Set(site.filter((e) => e.verification === "pending").map((e) => e.P));
    const site_verified = awaiting.size ? (await store.bestPerP(N, M, true)).filter((e) => awaiting.has(e.P)) : [];
    const body = JSON.stringify({ N, M, literature: lit, site, site_verified });
    keepRecords(key, body);
    return c.body(body, 200, { "content-type": "application/json" });
  });

  // Who holds how many records: the leader of every open problem, counted by the exact name it was
  // submitted with. The answer of /api/holders for one reading of the leaders (below).
  const countHolders = (all: ProblemLeader[]): string => {
    const byName = new Map<string, Holder>();
    for (const e of all) {
      const lit = literature.get(`${e.N}/${e.M}/${e.P}`);
      if (closedToSubmissions(lit)) continue;
      let h = byName.get(e.name);
      if (!h) byName.set(e.name, (h = { name: e.name, records: 0, beat_published: 0, site_bests: 0, pending: 0 }));
      h.site_bests++;
      // until a claim is reviewed, the published value it claims to beat is still the record
      if (e.verification === "pending") h.pending++;
      else if (!lit || reachesLiterature(e.score, lit)) {
        h.records++;
        if (lit && beatsLiterature(e.score, lit)) h.beat_published++;
      }
    }
    const list = [...byName.values()].sort(
      (a, b) =>
        b.records - a.records || b.site_bests - a.site_bests || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    return JSON.stringify({ holders: list } satisfies HoldersResponse);
  };

  // The leader of every problem, which /api/holders and /api/targets are computed from. Reading it
  // blocked the live server for about 0.9 s with 180,000 problems (2026-10-21) while entries
  // arrived every few seconds. So one reading serves both routes: it is kept until an entry
  // changes, and after a change still until it is holdersRefreshMs old. Only a request reads it
  // again, never a timer. What the routes need is drawn from it at once: the holders' answer, and
  // for the ranking each leader's problem, id and score, five numbers per leader in one array
  // (7 MB for 180,000) rather than objects that keep their names.
  const holdersRefreshMs = opts.holdersRefreshMs ?? HOLDERS_REFRESH_MS;
  interface LeadersReading {
    holders: string;
    /** N, M, P, id and score of each leader in turn. */
    ranked: Float64Array;
    at: number;
    /** False once an entry has changed since the reading. */
    current: boolean;
  }
  let leaders: LeadersReading | null = null;
  let entriesVersion = 0;
  /** Called after any entry was added, reviewed, removed or edited; `key` is its "N/M". */
  const entriesChanged = (key?: string) => {
    forgetRecords(key);
    entriesVersion++;
    if (leaders) leaders.current = false;
  };
  // With a store that answers asynchronously, requests that arrive during a reading share it
  // rather than each starting their own.
  let reading: Promise<LeadersReading> | null = null;
  const readLeaders = (): Promise<LeadersReading> => {
    if (leaders && (leaders.current || Date.now() - leaders.at < holdersRefreshMs)) return Promise.resolve(leaders);
    reading ??= (async () => {
      const version = entriesVersion;
      const all = await store.leaders();
      const ranked = new Float64Array(5 * all.length);
      for (const [i, e] of all.entries()) {
        ranked[5 * i] = e.N;
        ranked[5 * i + 1] = e.M;
        ranked[5 * i + 2] = e.P;
        ranked[5 * i + 3] = e.id;
        ranked[5 * i + 4] = e.score;
      }
      // an entry that changed while this was read may be missing from it
      leaders = { holders: countHolders(all), ranked, at: Date.now(), current: version === entriesVersion };
      return leaders;
    })().finally(() => {
      reading = null;
    });
    return reading;
  };

  app.get("/api/holders", async (c) =>
    c.body((await readLeaders()).holders, 200, { "content-type": "application/json" }),
  );

  // The work list of volunteer searches: every open problem, ranked by rankTargets. Ranking 200,000
  // problems took about 0.2 s on an Apple M1 Pro (2026-10-21), more on the live server's shared
  // CPU, so the ranking is kept until an entry changes, and after a change it is built again, from
  // the latest reading of the leaders, only once it is targetsRefreshMs old. Each request filters
  // the ranking and takes the first `limit`.
  const targetsRefreshMs = opts.targetsRefreshMs ?? TARGETS_REFRESH_MS;
  let targets: { ranking: TargetRanking; at: number; from: LeadersReading } | null = null;
  const currentTargets = async () => {
    // a ranking whose reading is still current is up to date, however old
    if (targets && (targets.from.current || Date.now() - targets.at < targetsRefreshMs)) return targets;
    const from = await readLeaders();
    if (targets?.from !== from) {
      const { ranked } = from;
      const each = function* () {
        for (let i = 0; i < ranked.length; i += 5)
          yield { N: ranked[i], M: ranked[i + 1], P: ranked[i + 2], id: ranked[i + 3], score: ranked[i + 4] };
      };
      targets = { ranking: rankTargets(each(), opts.records), at: Date.now(), from };
    }
    return targets;
  };
  app.use("/api/targets", compress());
  app.get("/api/targets", async (c) => {
    const errors: string[] = [];
    // each parameter at most once and by its own name, so that a misspelt or repeated filter is
    // refused rather than silently ignored
    for (const [name, values] of Object.entries(c.req.queries())) {
      if (!["limit", "N", "M", "max_P"].includes(name))
        errors.push(`unknown parameter ${name}: the parameters are limit, N, M and max_P`);
      else if (values.length > 1) errors.push(`${name} is given more than once`);
    }
    const limitText = c.req.query("limit");
    const limit = limitText === undefined ? TARGETS_DEFAULT_LIMIT : decimalInteger(limitText);
    if (!(limit >= 1 && limit <= TARGETS_MAX_LIMIT))
      errors.push(`limit must be an integer from 1 to ${TARGETS_MAX_LIMIT}`);
    const maxPText = c.req.query("max_P");
    const maxP = maxPText === undefined ? MAX_PIECES : decimalInteger(maxPText);
    if (!(maxP >= 1 && maxP <= MAX_PIECES)) errors.push(`max_P must be an integer from 1 to ${MAX_PIECES}`);
    const shapes = (name: "N" | "M") => {
      const text = c.req.query(name);
      if (text === undefined) return undefined;
      const list = shapeList(text);
      if (!list)
        errors.push(
          `${name} must be a comma-separated list of shape codes (0, or 3 to ${MAX_SIDES}) and ranges such as 0,3-6`,
        );
      return list ?? undefined;
    };
    const N = shapes("N");
    const M = shapes("M");
    if (errors.length) return c.json({ error: errors.join("; ") }, 400);
    const { ranking, at } = await currentTargets();
    const body: TargetsResponse = {
      generated_at: new Date(at).toISOString(),
      targets: ranking.select({ N, M, maxP, limit }),
    };
    return c.json(body);
  });

  // The drawings of the records page: for each P in [from, to], the one best packing that can be
  // drawn. Bounded twice: the range by ATLAS_MAX_SPAN and the payload by ATLAS_MAX_PIECES.
  // Coordinates are long, repetitive numbers, so the answer is compressed for clients that accept it.
  app.use("/api/atlas", compress());
  app.get("/api/atlas", async (c) => {
    // strict parsing: Number("") is 0, which would silently mean "circle"
    const N = decimalInteger(c.req.query("N"));
    const M = decimalInteger(c.req.query("M"));
    if (!isShapeCode(N) || !isShapeCode(M)) return c.json({ error: "query parameters N and M are required" }, 400);
    const fromText = c.req.query("from");
    const toText = c.req.query("to");
    const from = fromText === undefined ? 1 : decimalInteger(fromText);
    const to = toText === undefined ? Math.min(from + ATLAS_MAX_SPAN - 1, MAX_PIECES) : decimalInteger(toText);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to > MAX_PIECES ||
      from > to ||
      to - from >= ATLAS_MAX_SPAN
    ) {
      return c.json(
        {
          error: `from and to must be integers with 1 <= from <= to <= ${MAX_PIECES}, covering at most ${ATLAS_MAX_SPAN} values of P`,
        },
        400,
      );
    }
    // bestPerP lists only entries that are not rejected; the second call also leaves out pending ones
    type Best = LeaderboardEntry & { P: number };
    // entries of closed problems are never drawn: the published packing is
    const inRange = (list: Best[]) =>
      new Map(list.filter((e) => e.P >= from && e.P <= to && !closed(N, M, e.P)).map((e) => [e.P, e]));
    const best = inRange(await store.bestPerP(N, M));
    const awaiting = [...best.values()].some((e) => e.verification === "pending");
    const verified = awaiting ? inRange(await store.bestPerP(N, M, true)) : best;

    const plan: { P: number; entry?: LeaderboardEntry; lit?: LiteratureRecord }[] = [];
    let next: number | null = null;
    let budget = 0;
    for (let P = from; P <= to; P++) {
      const lit = literature.get(`${N}/${M}/${P}`);
      const top = best.get(P);
      const pending = top?.verification === "pending" ? top : undefined;
      const reviewed = verified.get(P);
      const source = atlasSource(reviewed, lit, pending);
      if (!source) continue;
      const count = source === "literature" ? lit!.pieces!.length : P;
      // the first drawing is always sent, so a request always makes progress
      if (plan.length && budget + count > ATLAS_MAX_PIECES) {
        next = P;
        break;
      }
      budget += count;
      plan.push(source === "literature" ? { P, lit } : { P, entry: source === "verified" ? reviewed : pending, lit });
    }
    const stored = new Map<number, StoredSubmission>();
    for (const s of await store.getMany(plan.flatMap((t) => (t.entry ? [t.entry.id] : [])))) stored.set(s.id, s);

    const tiles: AtlasTile[] = [];
    for (const { P, entry, lit } of plan) {
      const sub = entry ? stored.get(entry.id) : undefined;
      // a submission rejected or deleted between the two queries is never shown
      if (sub && sub.verification !== "rejected" && sub.N === N && sub.M === M && sub.P === P) {
        tiles.push({
          P,
          source: "site",
          score: sub.score,
          pieces: sub.pieces,
          container_phi: sub.container_phi,
          id: sub.id,
          verification: sub.verification,
          found_with: sub.found_with,
        });
      } else if (lit?.pieces) {
        tiles.push({
          P,
          source: "literature",
          score: lit.value,
          pieces: lit.pieces,
          container_phi: lit.container_phi ?? 0,
        });
      }
    }
    const body: AtlasResponse = { N, M, from, to, next, tiles };
    return c.json(body);
  });

  // 404 also for an entry deleted when it was overtaken: only the leader of a problem is kept
  // (see KEEP_PER_PROBLEM)
  app.get("/api/submissions/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const s = Number.isInteger(id) ? await store.get(id) : null;
    if (!s || s.verification === "rejected") return c.json({ error: "no such submission" }, 404);
    const { strict_check: _strict, literature_value: _lit, ...rest } = s;
    return c.json(rest);
  });

  app.post("/api/submit", async (c) => {
    const started = performance.now();
    // what the log line says about this submission, filled in as the body is read
    let problem: string | null = null;
    let verifyMs: number | null = null;
    const answer = (body: SubmitResponse, status: 200 | 400 | 409 | 413 | 422 | 426 | 429 | 503, retryAfter?: number) => {
      opts.stats?.submission({ status, ms: performance.now() - started, verifyMs, problem });
      return c.json(body, status, retryAfter === undefined ? {} : { "retry-after": String(retryAfter) });
    };
    const reject = (status: 400 | 409 | 413 | 422 | 426 | 429 | 503, reasons: string[], retryAfter?: number) =>
      answer(
        {
          valid: false,
          reasons,
          score: null,
          rank: null,
          leader: false,
          leader_score: null,
          id: null,
          container: null,
          pending_verification: false,
          strict_check: null,
        },
        status,
        retryAfter,
      );
    // While the event loop lags, work is queuing: submissions, the costly requests, are refused
    // until it catches up.
    if (overloadDelayMs > 0 && loopDelay() > overloadDelayMs)
      return reject(503, ["the server is busy; try again in a few seconds"], OVERLOAD_RETRY_S);
    const address = addressKey(clientIp(c));
    if (!ipLimit.allow(address)) return reject(429, ["too many submissions from this address; wait a minute"]);
    const wait = verifyBudget.wait(address);
    if (wait > 0) return reject(429, [`too much verification work from this address; wait ${wait} s`], wait);
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return reject(413, ["request body too large"]);
    // read no further than the limit: a chunked body has no Content-Length to check first
    const text = await readBodyWithin(c);
    if (text === null) return reject(413, ["request body too large"]);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return reject(400, ["body is not valid JSON"]);
    }
    const parsed = parseConfig(json);
    // how the packing was found is read from the same body, and its errors are reported alongside
    const found =
      typeof json === "object" && json !== null && !Array.isArray(json)
        ? parseProvenance(json as Record<string, unknown>, METHOD_NAMES)
        : null;
    if (!parsed.ok || !found?.ok)
      return reject(400, [...(parsed.ok ? [] : parsed.errors), ...(found && !found.ok ? found.errors : [])]);
    const config = parsed.config;
    const provenance = found.provenance;
    problem = `${config.N}/${config.M}/${config.P}`;
    // Disk pieces and circle containers changed units on 2026-10-27; a body without the confirmation is from a client that
    // may still work in the old ones, which would be scored without error as a valid but poor packing.
    if (unitsGate && planarAffected(config.N, config.M)) {
      const units = (json as Record<string, unknown>).units;
      if (units === undefined) return reject(426, [UNITS_MISSING_MESSAGE]);
      if (units !== "diameter") return reject(400, ['units must be "diameter" (the only unit system of this API)']);
    }
    const lit = literature.get(problem);
    // decided before the packing is looked at: nothing can improve on a proven optimum
    if (closedToSubmissions(lit))
      return reject(409, [`this problem is closed: its optimum ${lit!.display} is proven (${lit!.source_name})`]);
    const name = sanitizeText(config.name ?? "", MAX_NAME_LENGTH);
    if (!name) return reject(400, ["name is required"]);

    // The score is always recomputed here: the smallest container at the container_phi sent (0
    // when none was). The server does not search for a better orientation; clients turn their
    // boards before sending (decided 2026-10-21, see CONVENTIONS.scoring). Any container or score
    // fields in the body were already dropped by parseConfig. The time it takes is charged to the
    // address.
    const verifyStart = performance.now();
    const result = evaluate(config, { maxOverlaps: MAX_REPORTED_OVERLAPS, stopWhenInvalid: true });
    const container = result.valid ? result.container : null;
    const beats = !!container && !!lit && beatsLiterature(container.size, lit);
    const strict = container && beats ? strictVerify(config.N, config.pieces, container) : null;
    verifyMs = performance.now() - verifyStart;
    verifyBudget.charge(address, verifyMs);
    if (!container) return reject(422, result.reasons);
    const score = container.size;

    // the insert, the leader and rank it gives, and the prune, in one transaction
    const { id, before, leader, position, kept } = await store.submit({
      N: config.N,
      M: config.M,
      P: config.P,
      score,
      name,
      agent_note: sanitizeText(config.agent_note ?? "", MAX_NOTE_LENGTH),
      ...provenance,
      software: provenance.software === null ? null : sanitizeText(provenance.software, MAX_SOFTWARE_LENGTH) || null,
      pieces: config.pieces,
      container_phi: container.phi,
      created_at: new Date().toISOString(),
      verification: beats ? "pending" : "none",
      literature_value: beats ? lit!.value : null,
      strict_check: strict,
    });
    // The leader is the earliest entry among the equally good ones, so an entry that only ties the
    // smallest score is not rank 1 although nothing is strictly ahead of it.
    const leads = leader?.id === id;
    const rank = leads ? 1 : Math.max(2, position);
    // A problem keeps only its leader (and, behind a pending leader, the record it displaced): the
    // entry may already have been deleted (`kept` is false). After the insert and the prune, so that
    // no answer computed in between is kept:
    entriesChanged(`${config.N}/${config.M}`);
    if (beats) {
      log(
        `[review] submission ${id} by "${name}" for N=${config.N} M=${config.M} P=${config.P}: ` +
          `score ${score} is below the published ${lit!.value} (${lit!.status}); ` +
          `shrink test ${strict!.ok ? "passed" : "FAILED"}, certified ${strict!.certifiedSize}`,
      );
    }
    // Viewers hear of a change of leader only. That is nearly always this entry; in a chain of
    // near ties it can be an earlier one that the new smallest score brought within the tolerance.
    if (leader && leader.id !== before?.id) {
      const event: LeaderboardEvent = {
        N: config.N,
        M: config.M,
        P: config.P,
        id: leader.id,
        score: leader.score,
        rank: 1,
        name: leader.name,
      };
      opts.stats?.leaderChanged();
      announce(event);
    }
    const body: SubmitResponse = {
      valid: true,
      reasons: [],
      score,
      rank,
      leader: leads,
      leader_score: leader?.score ?? null,
      id: kept ? id : null,
      container,
      pending_verification: beats,
      strict_check: strict,
    };
    return answer(body, 200);
  });

  // Live updates: one "leaderboard" event whenever a problem the stream follows gets a new leader.
  // `keys` lists the problems; without it the stream follows every problem. A client that follows
  // other problems opens a new stream; an EventSource that reconnects asks for the same keys.
  app.get("/api/events", (c) => {
    const text = c.req.query("keys");
    const keys = text === undefined ? null : parseEventKeys(text);
    if (typeof keys === "string") return c.json({ error: keys }, 400);
    return streamSSE(c, async (stream) => {
      const queue: LeaderboardEvent[] = [];
      let wake: (() => void) | null = null;
      const listener = (e: LeaderboardEvent) => {
        queue.push(e);
        wake?.();
      };
      follow(listener, keys);
      opts.stats?.stream(1, keys);
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        unfollow(listener, keys);
        opts.stats?.stream(-1, keys);
      };
      stream.onAbort(() => {
        close();
        wake?.();
      });
      try {
        await stream.writeSSE({ event: "hello", data: JSON.stringify(keys ? { keys } : { all: true }) });
        while (!stream.aborted) {
          while (queue.length) await stream.writeSSE({ event: "leaderboard", data: JSON.stringify(queue.shift()) });
          // wake on the next event, or after 20 s to send a keep-alive comment
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 20_000);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = null;
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
        }
      } finally {
        // also when a write fails on a connection that is gone
        close();
      }
    });
  });

  const admin = (c: Context): Response | null => {
    if (!opts.adminToken) return c.json({ error: "admin access is not configured" }, 503);
    const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!constantTimeEqual(given, opts.adminToken)) return c.json({ error: "unauthorized" }, 401);
    return null;
  };

  app.get("/api/admin/pending", async (c) => admin(c) ?? c.json({ pending: await store.pending() }));

  app.post("/api/admin/review", async (c) => {
    const denied = admin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as { id?: unknown; decision?: unknown } | null;
    if (!body || !Number.isInteger(body.id) || (body.decision !== "confirmed" && body.decision !== "rejected")) {
      return c.json({ error: 'body must be {"id": number, "decision": "confirmed" | "rejected"}' }, 400);
    }
    const ok = await store.review(body.id as number, body.decision);
    if (ok) entriesChanged();
    if (ok) log(`[review] submission ${body.id} marked ${body.decision}`);
    return ok ? c.json({ ok: true }) : c.json({ error: "no such pending submission" }, 404);
  });

  // Moderation: unlike a review, this applies to any listed entry, not only to those awaiting one.
  app.post("/api/admin/remove", async (c) => {
    const denied = admin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    if (!body || !Number.isInteger(body.id)) return c.json({ error: 'body must be {"id": number}' }, 400);
    const ok = await store.remove(body.id as number);
    if (ok) entriesChanged();
    if (ok) log(`[review] submission ${body.id} removed`);
    return ok ? c.json({ ok: true }) : c.json({ error: "no such listed submission" }, 404);
  });

  // Corrects an entry's name, note or provenance; the packing and its score never change.
  app.post("/api/admin/edit", async (c) => {
    const denied = admin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !Number.isInteger(body.id)) return c.json({ error: "body must be an object with a numeric id" }, 400);
    const errors: string[] = [];
    const changes: EntryEdit = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? sanitizeText(body.name, MAX_NAME_LENGTH) : "";
      if (!name) errors.push("name must be a non-empty string");
      else changes.name = name;
    }
    if (body.agent_note !== undefined) {
      if (typeof body.agent_note !== "string") errors.push("agent_note must be a string");
      else changes.agent_note = sanitizeText(body.agent_note, MAX_NOTE_LENGTH);
    }
    const touched = ["found_with", "method", "method_params", "seed", "budget", "software"].some((k) => k in body);
    if (touched) {
      // all six are replaced together, so found_with must be given rather than default to "hand"
      if (body.found_with === undefined) errors.push("found_with is required when provenance is changed");
      else {
        const parsed = parseProvenance(body, METHOD_NAMES);
        if (!parsed.ok) errors.push(...parsed.errors);
        else
          changes.provenance = {
            ...parsed.provenance,
            software:
              parsed.provenance.software === null
                ? null
                : sanitizeText(parsed.provenance.software, MAX_SOFTWARE_LENGTH) || null,
          };
      }
    }
    if (errors.length) return c.json({ error: errors.join("; ") }, 400);
    const ok = await store.edit(body.id as number, changes);
    if (ok) entriesChanged();
    if (ok) log(`[review] submission ${body.id} edited: ${Object.keys(changes).join(", ") || "nothing"}`);
    return ok ? c.json({ ok: true }) : c.json({ error: "no such listed submission" }, 404);
  });

  // The nightly records snapshot (snapshot.ts): the manifest, then one gzipped file per shape pair or space.
  app.get("/api/snapshot", (c) => {
    const manifest = opts.snapshots?.manifest() ?? null;
    if (!manifest)
      return c.json(
        { error: opts.snapshots ? "no snapshot has been built yet" : "this server builds no snapshots" },
        404,
      );
    c.header("cache-control", "no-cache");
    return c.json(manifest);
  });
  app.get("/api/snapshot/:file", (c) => {
    const name = c.req.param("file");
    const file = opts.snapshots?.file(name) ?? null;
    const headers = {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "public, max-age=300",
      etag: `"${file?.sha256}"`,
    };
    // A HEAD request runs this handler too and drops the body, so the file is opened for GET only:
    // a stream opened and never read would hold its file descriptor for good.
    if (file && c.req.method === "HEAD") return c.body(null, 200, { ...headers, "content-length": String(file.bytes) });
    const opened = file?.open() ?? null;
    if (!opened) return c.json({ error: "no such snapshot file" }, 404);
    return c.body(opened.stream, 200, { ...headers, "content-length": String(opened.bytes) });
  });

  // The spaces share the submission limits of /api/submit: one count and one verification budget per address.
  if (opts.spaces)
    registerSpaceRoutes(app, {
      spaces: opts.spaces,
      ipLimit,
      verifyBudget,
      overloaded: () => overloadDelayMs > 0 && loopDelay() > overloadDelayMs,
      clientIp,
      log,
      stats: opts.stats,
      admin,
      unitsGate,
    });

  // Who leads, for many problems at once (Tighter's rent checks); after the spaces, whose catalogues it reads.
  registerLeadersRoute(app, { store, spaceStore: opts.spaces?.store, spaces: opts.spaces?.index, closed });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  return app;
}
