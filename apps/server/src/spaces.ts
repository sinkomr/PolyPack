import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { MAX_SOFTWARE_LENGTH } from "@polypack/geometry";
import {
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
import { ndCheckOps, ndIsHeavy } from "@polypack/ndspace";
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
import { UNITS_MISSING_MESSAGE, spaceAffected } from "./units-gate";
import { SpaceEntryEdit, SpaceLeader, SpaceStore } from "./store";

/** Problems one /api/spaces/{space}/site-only page holds without a `limit`, and at most. */
export const SPACE_SITE_ONLY_DEFAULT_LIMIT = 1000;
export const SPACE_SITE_ONLY_MAX_LIMIT = 5000;
/**
 * Spaces whose submissions are answered "not kept" without a check when their stated score cannot be
 * kept: a check of 500 large polyhedra takes about 0.7 s, one of 500 torus pieces on a skewed basis about
 * 0.5 s, and posting a research record or the site's best back would otherwise cost one each time. The
 * other spaces' checks are short, and they keep answering "valid, not kept" for such an entry.
 */
export const SPACES_CHECKED_ONLY_IF_KEPT: ReadonlySet<SpaceName> = new Set<SpaceName>(["polyhedra", "torus", "ndim"]);
/**
 * nD in nD checks are heavy by their size (ndIsHeavy: more than 2e7 multiply-adds, i.e. about 50 ms of work).
 * Polyhedra, surface, curved, sphere and torus checks from this P on are heavy ([CALC] polyhedra about 0.7 s of work per pass at P = 500;
 * surface 100-gons at P = 100 up to about 15 ms since its check stops at the first overlaps and skips distant
 * parts, 0.57 s before; torus up to 0.5 s at P = 500 on a basis at the translate limit, 0.06 s on a reduced one): one runs at a time on the server, and at most SPACE_HEAVY_CHECKS_WAITING wait their
 * turn; another is refused with 503.
 */
export const SPACE_HEAVY_CHECK_P = 30;
export const SPACE_HEAVY_CHECKS_WAITING = 8;

/** Longest `method` text of a space submission. */
export const SPACE_METHOD_LENGTH = 80;
/** The spaces part of the API: the loaded catalogues and where their site entries are kept. */
export interface SpacesOptions {
  index: SpacesIndex;
  store: SpaceStore;
  /** Compresses the answers that are kept; zlib's gzip off the event loop by default (tests count its calls). */
  gzip?: (data: Uint8Array) => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>;
  /** Told what each check of a submission took: its work, its slices and the longest of them (tests). */
  onCheck?: (check: { workMs: number; slices: number; longestSliceMs: number }) => void;
}

/** What the spaces routes share with the rest of the API: the limits of /api/submit, the log and the admin check. */
export interface SpaceRouteContext {
  spaces: SpacesOptions;
  /** Whether submissions to problems of the unit change must carry units (see AppOptions.unitsGate). */
  unitsGate?: boolean;
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

/** The nD problem of a parsed id. */
const ndProblem = (id: { P: number; fields: Record<string, string | number> }) => ({
  d: id.fields.d as number,
  piece: id.fields.piece as string,
  container: id.fields.container as string,
  P: id.P,
});

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

/** A JSON object's text with raw JSON fields appended (configurations are stored as JSON text). */
function withRaw(head: object, raw: Record<string, string | null>): string {
  const text = JSON.stringify(head);
  const tail = Object.entries(raw)
    .map(([k, v]) => `${JSON.stringify(k)}:${v ?? "null"}`)
    .join(",");
  return text === "{}" ? `{${tail}}` : `${text.slice(0, -1)},${tail}}`;
}

/**
 * The routes of the spaces (docs/spaces/*.md): their catalogues of research records and the site
 * entries submitted for them. Registered by createApp when it is given `spaces`.
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

  // The listing of a space is kept until one of its entries changes, with its gzip bytes, so that
  // it is compressed once and not per request. `version` keeps an answer computed across a change
  // from being kept.
  const recordsCache = new Map<SpaceName, Packed>();
  let version = 0;
  const changed = (space: string) => {
    if (isSpaceName(space)) recordsCache.delete(space);
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
      status: 200 | 400 | 409 | 413 | 422 | 426 | 429 | 503,
      retryAfter?: number,
    ) => {
      ctx.stats?.submission({ status, ms: performance.now() - started, verifyMs, problem });
      return c.json(body, status, retryAfter === undefined ? {} : { "retry-after": String(retryAfter) });
    };
    const reject = (status: 400 | 409 | 413 | 422 | 426 | 429 | 503, reasons: string[], retryAfter?: number) =>
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
    // the same confirmation as /api/submit, for the problems the unit change touched (disks, balls, ball and circle containers)
    if (ctx.unitsGate !== false && spaceAffected(space, p.id)) {
      if (body.units === undefined) return reject(426, [UNITS_MISSING_MESSAGE]);
      if (body.units !== "diameter") return reject(400, ['units must be "diameter" (the only unit system of this API)']);
    }
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
      (space === "sphere" && Number(parsedId.fields.N) >= 20) ||
      // nD in nD: by the size of the check (vertices of the pieces times facets of the container, pairs), not by P alone
      (space === "ndim" && ndIsHeavy(ndProblem(parsedId)));
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
              : space === "ndim"
                ? // [CALC] about 3 ns per multiply-add of a check without the validator's facet skipping, the worst case
                  // (docs/spaces/NDIM.md section 10); the charge is corrected by the work measured
                  Math.min(8000, 5 + 3e-6 * ndCheckOps(ndProblem(parsedId)))
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
