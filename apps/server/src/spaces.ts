import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { MAX_SOFTWARE_LENGTH } from "@polypack/geometry";
import {
  SPACE_BOUND_SLACK,
  SURFACE_CATALAN,
  SPACE_EXHIBITS,
  SPACE_INFO,
  SPACE_NAMES,
  SPACE_RECORD_MARGIN,
  SiteBest,
  SpaceEntryResponse,
  SpaceName,
  SpaceCatalogue,
  SpaceProblemEntry,
  SpaceRecordsResponse,
  SpaceSiteOnlyResponse,
  SpaceProblemSummary,
  SpaceSubmitResponse,
  SpaceTarget,
  SpaceTargetsResponse,
  SpacesIndex,
  SpacesResponse,
  acceptsSubmissions,
  hasRecord,
  problemOf,
  beatsSpaceRecord,
  entryConfig,
  improvesSpaceBest,
  isSpaceName,
  parseSpaceConfig,
  parseSpaceId,
  spaceProblemSummary,
  storedSpaceConfigAsync,
  validateSpaceSubmissionAsync,
} from "@polypack/spaces";
import { Context, Hono } from "hono";
import { compress } from "hono/compress";
import {
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  OVERLOAD_RETRY_S,
  RateLimiter,
  TimeBudget,
  addressKey,
  readBodyWithin,
  sanitizeText,
} from "./limits";
import { LoadStats } from "./load";
import { SpaceEntryEdit, SpaceLeader, SpaceStore } from "./store";

/** Problems of a space's domain without a record or a site entry that the targets list holds at most. */
export const SPACE_DOMAIN_TARGETS = 500;

/**
 * The ids of a space's domain that the targets list offers besides its records: those with site entries (`entered`),
 * then the first `limit` of the domain's sample that have neither a record nor a site entry. As problems get entries
 * the sample moves on to the next ones, so every problem of the domain comes up in turn; the list stays bounded by
 * the records, the entries and `limit`.
 */
export function domainTargetIds(cat: SpaceCatalogue, entered: readonly string[], limit: number): string[] {
  if (!cat.domain) return [];
  const taken = new Set(cat.byId.keys());
  const out: string[] = [];
  for (const id of entered)
    if (!taken.has(id)) {
      taken.add(id);
      out.push(id);
    }
  let fresh = 0;
  for (const id of cat.domain.sample(limit + taken.size)) {
    if (fresh >= limit) break;
    if (taken.has(id)) continue;
    taken.add(id);
    out.push(id);
    fresh++;
  }
  return out;
}
/** Problems one /api/spaces/{space}/site-only page holds without a `limit`, and at most. */
export const SPACE_SITE_ONLY_DEFAULT_LIMIT = 1000;
export const SPACE_SITE_ONLY_MAX_LIMIT = 5000;
/** Targets one /api/spaces/targets answer holds without a `limit`. */
export const SPACE_TARGETS_DEFAULT_LIMIT = 500;
/**
  * Largest `limit` of /api/spaces/targets: the whole list fits in one answer (10000 until PolyPack's 28
  * prism and antiprism problems took the polyhedra space to 11,286 problems on 2026-10-25; its bipyramids and
  * trapezohedra make 14,850, and with the balls space's 500 sampled problems 17,657 targets in all, including 500 sampled polyhedra problems without records).
 */
export const SPACE_TARGETS_MAX_LIMIT = 20000;
/**
 * Spaces whose submissions are answered "not kept" without a check when their stated score cannot be
 * kept: a check of 500 large polyhedra takes about 0.7 s, one of 500 torus pieces on a skewed basis about
 * 0.5 s, and posting a research record or the site's best back would otherwise cost one each time. The
 * other spaces' checks are short, and they keep answering "valid, not kept" for such an entry.
 */
export const SPACES_CHECKED_ONLY_IF_KEPT: ReadonlySet<SpaceName> = new Set<SpaceName>(["polyhedra", "torus"]);
/**
 * Polyhedra, surface, curved, sphere and torus checks from this P on are heavy ([CALC] polyhedra about 0.7 s of work per pass at P = 500;
 * surface 100-gons at P = 100 up to about 15 ms since its check stops at the first overlaps and skips distant
 * parts, 0.57 s before; torus up to 0.5 s at P = 500 on a basis at the translate limit, 0.06 s on a reduced one): one runs at a time on the server, and at most SPACE_HEAVY_CHECKS_WAITING wait their
 * turn; another is refused with 503.
 */
export const SPACE_HEAVY_CHECK_P = 30;
export const SPACE_HEAVY_CHECKS_WAITING = 8;

/** Longest `method` text of a space submission. */
export const SPACE_METHOD_LENGTH = 80;
/**
 * Relative gap (best - bound) / best at or below which a problem counts as settled by its lower
 * bound: no valid entry can lead it by more than the tie tolerance, so it is left out of the targets.
 */
export const SPACE_SETTLED_GAP = 1e-9;
/**
 * Largest relative gap a target counts with. Some bounds are weak (the area bound in a hyperbolic
 * container, whose area is capped), so a larger gap says little more about the room left.
 */
export const SPACE_GAP_CAP = 0.25;
/**
 * Most bytes of /api/spaces/targets lists kept at once, encoded and gzip together. [CALC] The whole list of
 * 12,593 targets is about 2.4 MB and 0.4 MB of gzip, so this keeps about five filtered lists; the least
 * recently used goes first. Every limit of a list is served from it (a prefix of its bytes).
 */
export const SPACE_TARGETS_CACHE_BYTES = 16_000_000;
/**
 * The lengths of a targets answer that are also kept gzip-compressed: the default 500, 2000 and 10000
 * (the volunteer client's limits before 2026-10-25 and before PolyPack's prism and antiprism problems
 * joined) and the whole list (its limit since). Other limits are served uncompressed, so that no
 * request compresses an answer of its own.
 */
export const SPACE_TARGETS_GZIP_LENGTHS: readonly number[] = [SPACE_TARGETS_DEFAULT_LIMIT, 2000, 10000];

/**
 * Weight of a target by its number of pieces, min(1, (P - 1) / 5): nothing for P = 1, whose
 * records are mostly closed forms behind weak bounds, and full weight from P = 6 on.
 */
export function spaceTargetWeight(P: number): number {
  return Math.max(0, Math.min(1, (P - 1) / 5));
}

/** The spaces part of the API: the loaded catalogues and where their site entries are kept. */
export interface SpacesOptions {
  index: SpacesIndex;
  store: SpaceStore;
  /** Compresses the answers that are kept; zlib's gzip off the event loop by default (tests count its calls). */
  gzip?: (data: Uint8Array) => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>;
  /** Bytes of targets answers kept at once; SPACE_TARGETS_CACHE_BYTES by default. */
  targetsCacheBytes?: number;
  /** Told the bytes and answers the targets cache holds after each change (tests). */
  onTargetsCache?: (bytes: number, answers: number) => void;
  /** Told what each check of a submission took: its work, its slices and the longest of them (tests). */
  onCheck?: (check: { workMs: number; slices: number; longestSliceMs: number }) => void;
}

/** What the spaces routes share with the rest of the API: the limits of /api/submit, the log and the admin check. */
export interface SpaceRouteContext {
  spaces: SpacesOptions;
  ipLimit: RateLimiter;
  verifyBudget: TimeBudget;
  /** True while the event loop lags (submissions are then refused with 503). */
  overloaded: () => boolean;
  clientIp: (c: Context) => string;
  log: (msg: string) => void;
  stats?: LoadStats;
  /** null when the request carries the admin token; otherwise the refusal to send. */
  admin: (c: Context) => Response | null;
}

/** A query value that is a plain decimal integer; anything else is NaN. */
function decimalInteger(text: string | undefined): number {
  return text !== undefined && /^\d{1,9}$/.test(text) ? Number(text) : NaN;
}

const siteBestOf = (l: SpaceLeader): SiteBest => ({ id: l.id, score: l.score, name: l.name, created_at: l.created_at });

/** Whether an Accept-Encoding header accepts gzip (explicitly or by "*", with q > 0). */
export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  let gzip: number | null = null;
  let any: number | null = null;
  for (const part of header.split(",")) {
    const [name, ...params] = part.split(";").map((t) => t.trim());
    const qParam = params.find((t) => /^q=/i.test(t));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    const n = name.toLowerCase();
    if (n === "gzip" || n === "x-gzip") gzip = q;
    else if (n === "*") any = q;
  }
  return (gzip ?? any ?? 0) > 0;
}

/**
 * An answer kept as its JSON bytes, encoded once and shared by every response (a connection that is slow to
 * read holds a reference, not a copy), with its gzip bytes once a client asked for them.
 */
interface Packed {
  bytes: Uint8Array<ArrayBuffer>;
  gzip: Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>> | null;
}

const encoder = new TextEncoder();
const encode = (text: string) => encoder.encode(text) as Uint8Array<ArrayBuffer>;
const packedOf = (value: unknown): Packed => ({ bytes: encode(JSON.stringify(value)), gzip: null });
const gzipAsync = promisify(gzipCallback);
const CLOSE = encode("]}");

/**
 * The work list for one filter (spaces and max_P), encoded once: the answer of any limit is the prefix of its
 * bytes up to the end of its last target, then "]}".
 */
interface EncodedList {
  bytes: Uint8Array<ArrayBuffer>;
  /** ends[i]: the offset just after target i. */
  ends: Uint32Array;
  /** The offset just after the opening "[". */
  head: number;
  /** Gzip answers of the lengths in SPACE_TARGETS_GZIP_LENGTHS and of the whole list, by length. */
  gzips: Map<number, Packed>;
  /** Bytes it holds, gzips included. */
  size: number;
}

/** A JSON object's text with raw JSON fields appended (configurations are stored as JSON text). */
function withRaw(head: object, raw: Record<string, string | null>): string {
  const text = JSON.stringify(head);
  const tail = Object.entries(raw)
    .map(([k, v]) => `${JSON.stringify(k)}:${v ?? "null"}`)
    .join(",");
  return text === "{}" ? `{${tail}}` : `${text.slice(0, -1)},${tail}}`;
}

/**
 * The routes of the spaces (docs/spaces/*.md): their catalogues of research records, the site
 * entries submitted for them, and the optional volunteer work list. Registered by createApp when
 * it is given `spaces`.
 */
export function registerSpaceRoutes(app: Hono, ctx: SpaceRouteContext): void {
  const { index, store } = ctx.spaces;
  const gzip =
    ctx.spaces.gzip ??
    (async (data: Uint8Array) => {
      const z = await gzipAsync(data);
      return new Uint8Array(z.buffer, z.byteOffset, z.byteLength) as Uint8Array<ArrayBuffer>;
    });
  const loaded = SPACE_NAMES.filter((s) => index[s]);
  const catalogue = (space: string) => (isSpaceName(space) ? index[space] : undefined);

  // The listing of a space is kept until one of its entries changes; the ranking of the targets,
  // and the answers drawn from it, until any entry does. Each answer is kept with its gzip bytes,
  // so that it is compressed once and not per request. `version` keeps an answer computed across
  // a change from being kept.
  const recordsCache = new Map<SpaceName, Packed>();
  // the ranked targets, each encoded once (made lazily, until any entry changes)
  let ranking: { list: SpaceTarget[]; items: Uint8Array[] | null; at: number } | null = null;
  // the targets lists by filter, least recently used first, bounded in bytes (encoded and gzip)
  const targetLists = new Map<string, EncodedList>();
  const targetsLimit = ctx.spaces.targetsCacheBytes ?? SPACE_TARGETS_CACHE_BYTES;
  let targetsBytes = 0;
  const targetsChanged = () => {
    while (targetsBytes > targetsLimit && targetLists.size) {
      const [oldest, l] = targetLists.entries().next().value!;
      targetLists.delete(oldest);
      targetsBytes -= l.size;
    }
    ctx.spaces.onTargetsCache?.(targetsBytes, targetLists.size);
  };
  let version = 0;
  const changed = (space: string) => {
    if (isSpaceName(space)) recordsCache.delete(space);
    ranking = null;
    targetLists.clear();
    targetsBytes = 0;
    targetsChanged();
    version++;
  };
  const jsonHeaders = { "content-type": "application/json", vary: "Accept-Encoding" };
  // the addresses with a check in flight, and the heavy checks: one running, the others in turn
  const checking = new Set<string>();
  let heavyRunning = false;
  const heavyWaiting: (() => void)[] = [];
  const heavyTurn = async () => {
    while (heavyRunning) await new Promise<void>((resolve) => heavyWaiting.push(resolve));
    heavyRunning = true;
  };
  const heavyDone = () => {
    heavyRunning = false;
    heavyWaiting.shift()?.();
  };
  /** The gzip of a kept answer, made once and off the event loop; null when it could not be made. */
  const gzipOf = async (packed: Packed, grew?: (bytes: number) => void): Promise<Uint8Array<ArrayBuffer> | null> => {
    if (!packed.gzip) {
      packed.gzip = Promise.resolve(gzip(packed.bytes)).then(
        (z) => {
          packed.gzip = z;
          grew?.(z.byteLength);
          return z;
        },
        () => {
          packed.gzip = null;
          return null as unknown as Uint8Array<ArrayBuffer>;
        },
      );
    }
    return (await packed.gzip) ?? null;
  };
  /** A kept answer, gzip-compressed for clients that accept it and plain for the others: shared bytes either way. */
  const send = async (c: Context, packed: Packed) => {
    const z = acceptsGzip(c.req.header("accept-encoding")) ? await gzipOf(packed) : null;
    if (!z) return c.body(packed.bytes, 200, jsonHeaders);
    return c.body(z, 200, { ...jsonHeaders, "content-encoding": "gzip" });
  };

  const spacesAnswer: Packed = packedOf({
    spaces: loaded.map((s) => {
      const domain = index[s]!.domain;
      return {
        ...SPACE_INFO[s],
        problems: domain ? domain.info.problems : index[s]!.problems.length,
        records: index[s]!.problems.filter(hasRecord).length,
        ...(domain ? { domain: domain.info } : {}),
      };
    }),
    // the curvature sweeps belong with the spaces, so they are shown only when there are any
    exhibits: loaded.length ? SPACE_EXHIBITS : [],
  } satisfies SpacesResponse);
  app.get("/api/spaces", (c) => send(c, spacesAnswer));

  // The work list (docs: "spaces-targets"). Each open problem counts with its relative room above
  // its lower bound, g = (best - bound) / best capped at SPACE_GAP_CAP (best: the smaller of the
  // certified and the site value), times spaceTargetWeight(P). Problems whose best value meets the
  // bound (g at most SPACE_SETTLED_GAP), P = 1, and the surface in nofold mode on the Platonic solids,
  // Archimedean solids, prisms and antiprisms are left out: such a nofold problem is the main site's planar problem N in M
  // (the best split between two or three regular face kinds), which the polygon work list
  // covers; it stays listed and open to submissions. Catalan nofold problems (irregular faces) are offered. The priorities are then
  // scaled so that those of each space sum to 1 / (number of spaces with targets): drawn in
  // proportion to priority, every space gets the same share of the searches. A problem without a
  // research record or a site entry (status no_record) has no best value: it counts with the
  // largest room, g = SPACE_GAP_CAP, and is listed with best_score null and leader "none". A space
  // with a domain lists its records, its problems without a record that have site entries, and at
  // most SPACE_DOMAIN_TARGETS more of its domain with neither, in the order of its sample (domainTargetIds):
  // never the whole domain.
  const rank = async (): Promise<SpaceTarget[]> => {
    const leaders = await store.spaceLeaders();
    const site = new Map(leaders.map((l) => [`${l.space} ${l.problem}`, l]));
    const out: SpaceTarget[] = [];
    const sums = new Map<SpaceName, number>();
    const candidates = (space: SpaceName): SpaceProblemEntry[] => {
      const cat = index[space]!;
      if (!cat.domain) return cat.problems;
      const list = [...cat.problems];
      const entered = leaders.filter((l) => l.space === space).map((l) => l.problem);
      for (const id of domainTargetIds(cat, entered, SPACE_DOMAIN_TARGETS)) {
        const parsed = parseSpaceId(space, id);
        const p = typeof parsed === "string" ? null : problemOf(cat, parsed);
        if (p) list.push(p);
      }
      return list;
    };
    for (const space of loaded) {
      for (const p of candidates(space)) {
        if (!acceptsSubmissions(p)) continue;
        // nofold problems of solids whose faces are regular polygons are 2D in 2D problems (the polygon
        // work list's, or a split among two or three of them); a Catalan face is not
        if (space === "surface" && p.fields.mode === "nofold" && !SURFACE_CATALAN.includes(String(p.fields.solid)))
          continue;
        const weight = spaceTargetWeight(p.P);
        if (!(weight > 0)) continue;
        const lead = site.get(`${space} ${p.id}`) ?? null;
        const cert = p.certified?.score ?? null;
        // a site entry leads once it beats the research record by the space's record margin
        const siteLeads = !!lead && beatsSpaceRecord(space, lead.score, cert);
        const values = [cert, lead?.score].filter((v): v is number => typeof v === "number");
        if (!values.length && hasRecord(p)) continue;
        const best = values.length ? Math.min(...values) : null;
        const bound = p.bound?.value ?? null;
        const gap = bound === null || best === null ? SPACE_GAP_CAP : (best - bound) / best;
        if (!(gap > SPACE_SETTLED_GAP)) continue;
        // nothing can be kept when beating the record by its margin would take an entry below the
        // lower bound (polyhedra records that meet their volume bound to within the clearance)
        if (
          cert !== null &&
          bound !== null &&
          !(cert * (1 - SPACE_RECORD_MARGIN[space]) > bound * (1 - SPACE_BOUND_SLACK))
        )
          continue;
        const value = Math.min(gap, SPACE_GAP_CAP) * weight;
        sums.set(space, (sums.get(space) ?? 0) + value);
        out.push({
          space,
          id: p.id,
          P: p.P,
          priority: value,
          best_score: best,
          bound,
          leader: siteLeads ? "site" : cert !== null ? "certified" : "none",
          leader_id: siteLeads ? lead!.id : null,
        });
      }
    }
    for (const t of out) t.priority /= sums.size * sums.get(t.space)!;
    const order = (s: SpaceName) => SPACE_NAMES.indexOf(s);
    return out.sort(
      (a, b) =>
        b.priority - a.priority ||
        a.P - b.P ||
        order(a.space) - order(b.space) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  };

  app.get("/api/spaces/targets", async (c) => {
    const errors: string[] = [];
    // each parameter at most once and by its own name, as /api/targets
    for (const [name, values] of Object.entries(c.req.queries())) {
      if (!["limit", "spaces", "max_P"].includes(name))
        errors.push(`unknown parameter ${name}: the parameters are spaces, max_P and limit`);
      else if (values.length > 1) errors.push(`${name} is given more than once`);
    }
    const limitText = c.req.query("limit");
    const limit = limitText === undefined ? SPACE_TARGETS_DEFAULT_LIMIT : decimalInteger(limitText);
    if (!(limit >= 1 && limit <= SPACE_TARGETS_MAX_LIMIT))
      errors.push(`limit must be an integer from 1 to ${SPACE_TARGETS_MAX_LIMIT}`);
    const maxPText = c.req.query("max_P");
    const maxP = maxPText === undefined ? Infinity : decimalInteger(maxPText);
    if (!(maxP >= 1)) errors.push("max_P must be a positive integer");
    const spacesText = c.req.query("spaces");
    let wanted: Set<SpaceName> | null = null;
    if (spacesText !== undefined && spacesText !== "all") {
      const names = spacesText.split(",");
      if (!names.every(isSpaceName))
        errors.push(`spaces must be all or a comma-separated list of ${SPACE_NAMES.join(", ")}`);
      else wanted = new Set(names);
    }
    if (errors.length) return c.json({ error: errors.join("; ") }, 400);
    const at = version;
    let current = ranking;
    if (!current) {
      current = { list: await rank(), items: null, at: Date.now() };
      // a ranking read across a change is answered but not kept
      if (at === version) ranking = current;
    }
    // One list per filter, shared by every limit: a max_P at or above every listed P is no filter.
    const spacesKey = wanted ? SPACE_NAMES.filter((s) => wanted.has(s)).join(",") : "all";
    const largestP = Math.max(
      0,
      ...SPACE_NAMES.filter((s) => !wanted || wanted.has(s)).map((s) => index[s]?.maxP ?? 0),
    );
    const key = `${spacesKey}|${maxP >= largestP ? "all" : maxP}`;
    let list = targetLists.get(key);
    if (list) {
      // the most recently used goes last
      targetLists.delete(key);
      targetLists.set(key, list);
    } else {
      list = encodeList(current, (t) => (!wanted || wanted.has(t.space)) && t.P <= maxP);
      if (at === version) {
        targetLists.set(key, list);
        targetsBytes += list.size;
        targetsChanged();
      }
    }
    const kept = list;
    const n = Math.min(limit, kept.ends.length);
    const whole = n === kept.ends.length;
    // the common lengths are also kept compressed; the others are served as they are
    if ((whole || SPACE_TARGETS_GZIP_LENGTHS.includes(n)) && acceptsGzip(c.req.header("accept-encoding"))) {
      let packed = kept.gzips.get(n);
      if (!packed) {
        packed = { bytes: whole ? kept.bytes : concat(prefixOf(kept, n), CLOSE), gzip: null };
        kept.gzips.set(n, packed);
      }
      const z = await gzipOf(packed, (bytes) => {
        // only the gzip is kept: a plain answer is a prefix of the list's own bytes
        if (!whole) packed!.bytes = kept.bytes.subarray(0, 0);
        kept.size += bytes;
        if ([...targetLists.values()].includes(kept)) {
          targetsBytes += bytes;
          targetsChanged();
        }
      });
      if (z) return c.body(z, 200, { ...jsonHeaders, "content-encoding": "gzip" });
    }
    if (whole) return c.body(kept.bytes, 200, jsonHeaders);
    // a prefix of the shared bytes, then "]}": nothing is copied
    const prefix = prefixOf(kept, n);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
        controller.enqueue(CLOSE);
        controller.close();
      },
    });
    return c.body(body, 200, { ...jsonHeaders, "content-length": String(prefix.byteLength + CLOSE.byteLength) });
  });

  /** The bytes of a list up to the end of its n-th target (the opening of the answer when n is 0). */
  const prefixOf = (list: EncodedList, n: number) => list.bytes.subarray(0, n ? list.ends[n - 1] : list.head);
  const concat = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a, 0);
    out.set(b, a.byteLength);
    return out;
  };

  /**
   * The targets of the ranking that pass a filter, encoded as one answer {"generated_at", "targets"} (the
   * same text as JSON.stringify of it) with the end of each target. The targets are encoded once per ranking.
   */
  const encodeList = (current: NonNullable<typeof ranking>, keep: (t: SpaceTarget) => boolean): EncodedList => {
    const items = (current.items ??= current.list.map((t) => encode(JSON.stringify(t))));
    const open = encode(`{"generated_at":${JSON.stringify(new Date(current.at).toISOString())},"targets":[`);
    const picked: number[] = [];
    let total = open.byteLength + CLOSE.byteLength;
    for (let i = 0; i < current.list.length; i++)
      if (keep(current.list[i])) {
        total += items[i].byteLength + (picked.length ? 1 : 0);
        picked.push(i);
      }
    const bytes = new Uint8Array(total);
    const ends = new Uint32Array(picked.length);
    bytes.set(open, 0);
    let at = open.byteLength;
    picked.forEach((i, k) => {
      if (k) bytes[at++] = 44; // ","
      bytes.set(items[i], at);
      at += items[i].byteLength;
      ends[k] = at;
    });
    bytes.set(CLOSE, at);
    return { bytes, ends, head: open.byteLength, gzips: new Map(), size: bytes.byteLength + ends.byteLength };
  };

  // Share links: a stored entry with its configuration. 404 also once it was overtaken (only the
  // leader of a problem is kept) or removed.
  app.get("/api/spaces/entries/:id", compress(), async (c) => {
    const id = decimalInteger(c.req.param("id"));
    const e = Number.isInteger(id) ? await store.spaceGet(id) : null;
    if (!e) return c.json({ error: "no such space entry" }, 404);
    const { config, ...rest } = e;
    const head: Omit<SpaceEntryResponse, "config"> = {
      id: rest.id,
      space: rest.space as SpaceName,
      problem: rest.problem,
      score: rest.score,
      name: rest.name,
      agent_note: rest.agent_note,
      software: rest.software,
      method: rest.method,
      seed: rest.seed,
      created_at: rest.created_at,
    };
    return c.body(withRaw(head, { config }), 200, { "content-type": "application/json" });
  });

  app.post("/api/spaces/submit", async (c) => {
    const started = performance.now();
    let problem: string | null = null;
    let verifyMs: number | null = null;
    const answer = (
      body: SpaceSubmitResponse,
      status: 200 | 400 | 409 | 413 | 422 | 429 | 503,
      retryAfter?: number,
    ) => {
      ctx.stats?.submission({ status, ms: performance.now() - started, verifyMs, problem });
      return c.json(body, status, retryAfter === undefined ? {} : { "retry-after": String(retryAfter) });
    };
    const reject = (status: 400 | 409 | 413 | 422 | 429 | 503, reasons: string[], retryAfter?: number) =>
      answer(
        { valid: false, reasons, score: null, leader: false, best_score: null, id: null, beats_certified: false },
        status,
        retryAfter,
      );
    // the same limits, counted together, as /api/submit
    if (ctx.overloaded()) return reject(503, ["the server is busy; try again in a few seconds"], OVERLOAD_RETRY_S);
    const address = addressKey(ctx.clientIp(c));
    if (!ctx.ipLimit.allow(address)) return reject(429, ["too many submissions from this address; wait a minute"]);
    const wait = ctx.verifyBudget.wait(address);
    if (wait > 0) return reject(429, [`too much verification work from this address; wait ${wait} s`], wait);
    // read no further than the limit, also for a chunked body without a Content-Length
    const text = await readBodyWithin(c);
    if (text === null) return reject(413, ["request body too large"]);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return reject(400, ["body is not valid JSON"]);
    }
    if (typeof json !== "object" || json === null || Array.isArray(json))
      return reject(400, ['body must be an object {"space", "id", "config", "name", ...}']);
    const body = json as Record<string, unknown>;
    const space = body.space;
    const cat = typeof space === "string" ? catalogue(space) : undefined;
    if (!cat || !isSpaceName(space))
      return reject(400, [`space must be one of ${loaded.join(", ") || "(no spaces are loaded)"}`]);
    const parsedId = parseSpaceId(space, body.id);
    if (typeof parsedId === "string") return reject(400, [parsedId]);
    const p = problemOf(cat, parsedId);
    if (!p)
      return reject(400, [
        `${parsedId.id} is not in the ${space} catalogue: submissions are accepted for its problems only`,
      ]);
    problem = p.id;
    // decided before the packing is looked at
    if (!acceptsSubmissions(p)) return reject(409, [`this problem is closed: ${p.closed_reason}`]);

    const errors: string[] = [];
    const name = typeof body.name === "string" ? sanitizeText(body.name, MAX_NAME_LENGTH) : "";
    if (!name) errors.push("name is required");
    const optionalText = (key: string, max: number, truncate: boolean): string | null => {
      const v = body[key];
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") {
        errors.push(`${key} must be a string`);
        return null;
      }
      if (!truncate && v.length > max) errors.push(`${key} must be at most ${max} characters`);
      return sanitizeText(v, max) || null;
    };
    const agent_note = optionalText("agent_note", MAX_NOTE_LENGTH, true) ?? "";
    const software = optionalText("software", MAX_SOFTWARE_LENGTH, false);
    const method = optionalText("method", SPACE_METHOD_LENGTH, false);
    let seed: number | null = null;
    if (body.seed !== undefined && body.seed !== null) {
      if (!Number.isSafeInteger(body.seed) || (body.seed as number) < 0)
        errors.push("seed must be a non-negative integer");
      else seed = body.seed as number;
    }
    if (body.config === undefined) errors.push("config is required");
    if (errors.length) return reject(400, errors);

    const cert = p.certified?.score ?? null;
    const current = await store.spaceLeader(space, p.id);
    const bestBefore = [cert, current?.score].filter((v): v is number => typeof v === "number");
    const best = bestBefore.length ? Math.min(...bestBefore) : null;
    if (SPACES_CHECKED_ONLY_IF_KEPT.has(space)) {
      // the stated score is known before any geometry: one that cannot be kept is not checked
      const stated = parseSpaceConfig(parsedId, body.config);
      if (stated.ok && !improvesSpaceBest(space, stated.score, cert, current?.score ?? null))
        return answer(
          {
            valid: false,
            reasons: [
              `not checked: a size of ${stated.score} cannot be kept, since it is not below the research record by more than a relative ${SPACE_RECORD_MARGIN[space].toExponential()} and below the site's best by more than a relative 1e-9`,
            ],
            score: stated.score,
            leader: false,
            best_score: best,
            id: null,
            beats_certified: false,
            checked: false,
          },
          200,
        );
    }

    // The time the check takes is charged to the address, as for /api/submit. A configuration that
    // beats the research record must also be valid at the strict tolerance. A polyhedra check gives
    // (and a surface check) the event loop a turn every 20 ms (validateSpaceSubmissionAsync), so that one large check never
    // holds the server; its work, not its waits, is charged. An address has one check at a time, an
    // estimate of its cost is reserved from the budget before it starts, and the heavy checks run
    // one at a time server-wide, a few waiting their turn.
    if (checking.has(address))
      return reject(
        429,
        ["an entry from this address is still being checked; send the next one when it is answered"],
        1,
      );
    // A body that is not a configuration of this problem (types, ids, sizes, finite numbers, piece count)
    // is refused here, before it takes a place in the heavy queue or any of the budget.
    const shape = parseSpaceConfig(parsedId, body.config);
    if (!shape.ok) return reject(shape.malformed ? 400 : 422, shape.errors.slice(0, 20));
    const heavy =
      (["polyhedra", "surface", "curved", "sphere", "torus"].includes(space) && parsedId.P >= SPACE_HEAVY_CHECK_P) ||
      (space === "sphere" && Number(parsedId.fields.N) >= 20);
    if (heavy && heavyRunning && heavyWaiting.length >= SPACE_HEAVY_CHECKS_WAITING)
      return reject(503, ["the server is busy checking other entries; try again in a few seconds"], OVERLOAD_RETRY_S);
    // Reserve work before checking; a many-sided sphere also queues at small P.
    const sides = Math.max(8, Number(parsedId.fields.N) || 0);
    // [CALC] Reserve up to 1.6 s for two polyhedra passes at P = 500 (about 0.7 s each).
    const estimate =
      space === "polyhedra"
        ? Math.min(1600, 0.04 * parsedId.P * parsedId.P)
        : space === "surface"
          ? Math.min(100, 5 + 1e-5 * parsedId.P * parsedId.P * sides)
          : space === "torus"
            ? // [CALC] A torus entry of 500 disks on a basis at the limit of TORUS_MAX_TRANSLATES candidates per
              // pair, the worst case, took 0.5 s of work (the check, its strict pass and the reduced basis'
              // check; the sent configuration is not checked again), and 0.06 s on a reduced basis. Reserve
              // 0.002 P^2 ms: 0.5 s at P = 500 (at least the earlier many-sided estimate).
              Math.min(800, Math.max(5 + 0.002 * parsedId.P * parsedId.P, 5 + 1e-5 * parsedId.P * parsedId.P * sides * sides))
            : ["curved", "sphere"].includes(space)
              ? Math.min(400, 5 + 1e-5 * parsedId.P * parsedId.P * sides * sides)
              : 5;
    checking.add(address);
    ctx.verifyBudget.charge(address, estimate);
    let verdict: Awaited<ReturnType<typeof validateSpaceSubmissionAsync>>;
    try {
      if (heavy) await heavyTurn();
      try {
        verdict = await validateSpaceSubmissionAsync(space, p.id, body.config, {
          bound: p.bound?.value ?? null,
          maxP: cat.maxP,
          certified: cert,
          // without a research record, every entry must pass the strict check (validate.ts)
          noRecord: !hasRecord(p),
        });
        // normalised whenever the entry could be kept against the research record, not only when it beats
        // the leader read above: the leader can change while this entry is checked, and then this entry
        // may be stored as the leader with its basis as sent
        if (
          verdict.valid &&
          verdict.score !== null &&
          verdict.config &&
          (best === null || improvesSpaceBest(space, verdict.score, cert, null))
        ) {
          const stored = await storedSpaceConfigAsync(space, p.id, verdict.config, {
            bound: p.bound?.value ?? null,
            maxP: cat.maxP,
            certified: cert,
            noRecord: !hasRecord(p),
          }, verdict.score);
          verdict.config = stored.config;
          verdict.workMs += stored.workMs;
          verdict.slices += stored.slices;
          verdict.longestSliceMs = Math.max(verdict.longestSliceMs, stored.longestSliceMs);
        }
      } finally {
        if (heavy) heavyDone();
      }
    } finally {
      checking.delete(address);
    }
    verifyMs = verdict.workMs;
    ctx.verifyBudget.charge(address, verifyMs - estimate);
    ctx.spaces.onCheck?.(verdict);
    if (!verdict.valid || verdict.score === null || !verdict.config)
      return reject(verdict.malformed ? 400 : 422, verdict.reasons);
    const score = verdict.score;
    const beats = cert !== null && beatsSpaceRecord(space, score, cert);

    // Kept only when it beats the site leader by more than the tie tolerance and the research
    // record by more than the space's record margin (the tie tolerance too, except for polyhedra,
    // whose records keep a clearance); otherwise it is valid and not kept.
    if (best !== null && !improvesSpaceBest(space, score, cert, current?.score ?? null))
      return answer(
        { valid: true, reasons: [], score, leader: false, best_score: best, id: null, beats_certified: beats },
        200,
      );

    const { id, before, leader, kept } = await store.spaceSubmit({
      space,
      problem: p.id,
      score,
      name,
      agent_note,
      software,
      method,
      seed,
      config: JSON.stringify(verdict.config),
      created_at: new Date().toISOString(),
    });
    if (kept || leader?.id !== before?.id) changed(space);
    if (leader?.id !== before?.id) ctx.stats?.leaderChanged();
    const leads = leader?.id === id;
    if (beats && leads)
      ctx.log(
        `[spaces] entry ${id} by "${name}" leads ${p.id}: score ${score} is below the certified ${cert} ` +
          `(${p.status}) by ${(((cert! - score) / cert!) * 100).toPrecision(3)}%`,
      );
    const values = [cert, leader?.score].filter((v): v is number => typeof v === "number");
    return answer(
      {
        valid: true,
        reasons: [],
        score,
        leader: leads,
        best_score: values.length ? Math.min(...values) : null,
        id: kept ? id : null,
        beats_certified: beats,
      },
      200,
    );
  });

  const unknownSpace = (c: Context) =>
    c.json({ error: `no such space; the spaces are ${loaded.join(", ") || "(none loaded)"}` }, 404);

  // The listing of a space's research records (a space with a domain answers for its other problems one by one,
  // below); /problems is the same answer.
  const listing = async (c: Context) => {
    const space = c.req.param("space") ?? "";
    const cat = catalogue(space);
    if (!cat || !isSpaceName(space)) return unknownSpace(c);
    const cached = recordsCache.get(space);
    if (cached !== undefined) return send(c, cached);
    const at = version;
    const site = new Map((await store.spaceBest(space)).map((l) => [l.problem, siteBestOf(l)]));
    const packed = packedOf({
      space,
      generated_at: new Date().toISOString(),
      problems: cat.problems.map((p) => spaceProblemSummary(p, site.get(p.id) ?? null)),
    } satisfies SpaceRecordsResponse);
    if (at === version) recordsCache.set(space, packed);
    return send(c, packed);
  };
  // The problems of a space's domain that have a site entry and no research record: the listing above does not hold
  // them. Each as in the listing, by problem id, a page at a time (`after` is the last id of the page before).
  app.get("/api/spaces/:space/site-only", async (c) => {
    const space = c.req.param("space") ?? "";
    const cat = catalogue(space);
    if (!cat || !isSpaceName(space)) return unknownSpace(c);
    const errors: string[] = [];
    for (const [name, values] of Object.entries(c.req.queries())) {
      if (!["limit", "after"].includes(name)) errors.push(`unknown parameter ${name}: the parameters are limit and after`);
      else if (values.length > 1) errors.push(`${name} is given more than once`);
    }
    const limitText = c.req.query("limit");
    const limit = limitText === undefined ? SPACE_SITE_ONLY_DEFAULT_LIMIT : decimalInteger(limitText);
    if (!(limit >= 1 && limit <= SPACE_SITE_ONLY_MAX_LIMIT))
      errors.push(`limit must be an integer from 1 to ${SPACE_SITE_ONLY_MAX_LIMIT}`);
    if (errors.length) return c.json({ error: errors.join("; ") }, 400);
    const after = c.req.query("after");
    const found: SpaceProblemSummary[] = [];
    for (const l of await store.spaceBest(space)) {
      if (after !== undefined && !(l.problem > after)) continue;
      const parsed = parseSpaceId(space, l.problem);
      const p = typeof parsed === "string" ? null : problemOf(cat, parsed);
      if (p && !hasRecord(p)) found.push(spaceProblemSummary(p, siteBestOf(l)));
    }
    found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = found.slice(0, limit);
    return c.json({
      space,
      generated_at: new Date().toISOString(),
      problems: page,
      next: found.length > limit ? page[page.length - 1].id : null,
    } satisfies SpaceSiteOnlyResponse);
  });
  app.get("/api/spaces/:space/records", listing);
  app.get("/api/spaces/:space/problems", listing);

  // The id holds slashes, so it is the rest of the path: /api/spaces/curved/problems/curved/-1/3/4/7.
  app.get("/api/spaces/:space/problems/*", compress(), async (c) => {
    const space = c.req.param("space");
    const cat = catalogue(space);
    if (!cat || !isSpaceName(space)) return unknownSpace(c);
    const prefix = `/api/spaces/${space}/problems/`;
    let id: string;
    try {
      id = decodeURIComponent(c.req.path.slice(prefix.length));
    } catch {
      return c.json({ error: "the problem id is not a valid path" }, 400);
    }
    const parsed = parseSpaceId(space, id);
    if (typeof parsed === "string") return c.json({ error: parsed }, 400);
    // a record, or a problem of the space's domain without one (answered with its bound)
    const p: SpaceProblemEntry | null = problemOf(cat, parsed);
    if (!p) return c.json({ error: `${parsed.id} is not in the ${space} catalogue` }, 404);
    const lead = acceptsSubmissions(p) ? await store.spaceLeader(space, p.id) : null;
    const entry = lead ? await store.spaceGet(lead.id) : null;
    // an entry removed between the two reads leaves the problem without a site entry
    const summary = spaceProblemSummary(p, lead && entry ? siteBestOf(lead) : null);
    const head = { ...summary, conventions: SPACE_INFO[space].conventions };
    // a space that keeps its configurations apart (polyhedra) reads this one now, from a small cache
    const certified = await entryConfig(cat, p);
    return c.body(withRaw(head, { certified_config: certified, site_config: entry?.config ?? null }), 200, {
      "content-type": "application/json",
    });
  });

  // Moderation of space entries, as /api/admin/remove and /api/admin/edit for polygon entries.
  app.post("/api/admin/spaces/remove", async (c) => {
    const denied = ctx.admin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    if (!body || !Number.isInteger(body.id)) return c.json({ error: 'body must be {"id": number}' }, 400);
    const r = await store.spaceRemove(body.id as number);
    if (!r) return c.json({ error: "no such space entry" }, 404);
    changed(r.space);
    ctx.log(`[spaces] entry ${body.id} (${r.problem}) removed`);
    return c.json({ ok: true });
  });

  app.post("/api/admin/spaces/edit", async (c) => {
    const denied = ctx.admin(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || !Number.isInteger(body.id))
      return c.json({ error: "body must be an object with a numeric id" }, 400);
    const errors: string[] = [];
    const changes: SpaceEntryEdit = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? sanitizeText(body.name, MAX_NAME_LENGTH) : "";
      if (!name) errors.push("name must be a non-empty string");
      else changes.name = name;
    }
    if (body.agent_note !== undefined) {
      if (typeof body.agent_note !== "string") errors.push("agent_note must be a string");
      else changes.agent_note = sanitizeText(body.agent_note, MAX_NOTE_LENGTH);
    }
    if (errors.length) return c.json({ error: errors.join("; ") }, 400);
    const r = await store.spaceEdit(body.id as number, changes);
    if (!r) return c.json({ error: "no such space entry" }, 404);
    changed(r.space);
    ctx.log(`[spaces] entry ${body.id} (${r.problem}) edited: ${Object.keys(changes).join(", ") || "nothing"}`);
    return c.json({ ok: true });
  });
}
