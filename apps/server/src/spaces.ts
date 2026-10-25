import { gzipSync } from "node:zlib";
import { MAX_SOFTWARE_LENGTH, SCORE_TIE } from "@polypack/geometry";
import {
  SPACE_EXHIBITS,
  SPACE_INFO,
  SPACE_NAMES,
  SiteBest,
  SpaceEntryResponse,
  SpaceName,
  SpaceProblemEntry,
  SpaceRecordsResponse,
  SpaceSubmitResponse,
  SpaceTarget,
  SpaceTargetsResponse,
  SpacesIndex,
  SpacesResponse,
  acceptsSubmissions,
  beatsSpaceScore,
  isSpaceName,
  parseSpaceId,
  spaceProblemSummary,
  storedSpaceConfig,
  validateSpaceSubmission,
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

/** Targets one /api/spaces/targets answer holds without a `limit`. */
export const SPACE_TARGETS_DEFAULT_LIMIT = 500;
/** Largest `limit` of /api/spaces/targets. */
export const SPACE_TARGETS_MAX_LIMIT = 2000;
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
/** Most distinct /api/spaces/targets queries whose answers are kept at once. */
const TARGET_ANSWERS_KEPT = 256;

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
  /** Compresses the answers that are kept; zlib's gzip by default (tests count its calls). */
  gzip?: (text: string) => Uint8Array<ArrayBuffer>;
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

/** An answer kept as JSON text, with its gzip bytes once a client asked for them. */
interface Packed {
  text: string;
  gzip: Uint8Array<ArrayBuffer> | null;
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
  const gzip = ctx.spaces.gzip ?? ((text: string) => new Uint8Array(gzipSync(text)));
  const loaded = SPACE_NAMES.filter((s) => index[s]);
  const catalogue = (space: string) => (isSpaceName(space) ? index[space] : undefined);

  // The listing of a space is kept until one of its entries changes; the ranking of the targets,
  // and the answers drawn from it, until any entry does. Each answer is kept with its gzip bytes,
  // so that it is compressed once and not per request. `version` keeps an answer computed across
  // a change from being kept.
  const recordsCache = new Map<SpaceName, Packed>();
  let ranking: { list: SpaceTarget[]; at: number } | null = null;
  const targetAnswers = new Map<string, Packed>();
  let version = 0;
  const changed = (space: string) => {
    if (isSpaceName(space)) recordsCache.delete(space);
    ranking = null;
    targetAnswers.clear();
    version++;
  };
  /** A kept answer, gzip-compressed for clients that accept it and plain for the others. */
  const send = (c: Context, packed: Packed) => {
    const headers = { "content-type": "application/json", vary: "Accept-Encoding" };
    if (!acceptsGzip(c.req.header("accept-encoding"))) return c.body(packed.text, 200, headers);
    packed.gzip ??= gzip(packed.text);
    return c.body(packed.gzip, 200, { ...headers, "content-encoding": "gzip" });
  };

  const spacesAnswer: Packed = {
    text: JSON.stringify({
      spaces: loaded.map((s) => ({ ...SPACE_INFO[s], problems: index[s]!.problems.length })),
      // the curvature sweeps belong with the spaces, so they are shown only when there are any
      exhibits: loaded.length ? SPACE_EXHIBITS : [],
    } satisfies SpacesResponse),
    gzip: null,
  };
  app.get("/api/spaces", (c) => send(c, spacesAnswer));

  // The work list (docs: "spaces-targets"). Each open problem counts with its relative room above
  // its lower bound, g = (best - bound) / best capped at SPACE_GAP_CAP (best: the smaller of the
  // certified and the site value), times spaceTargetWeight(P). Problems whose best value meets the
  // bound (g at most SPACE_SETTLED_GAP), P = 1, and the surface in nofold mode are left out: a
  // nofold problem is the main site's planar problem N in M with ceil(P / F) pieces, which the
  // polygon work list covers; it stays listed and open to submissions. The priorities are then
  // scaled so that those of each space sum to 1 / (number of spaces with targets): drawn in
  // proportion to priority, every space gets the same share of the searches.
  const rank = async (): Promise<SpaceTarget[]> => {
    const site = new Map((await store.spaceLeaders()).map((l) => [`${l.space} ${l.problem}`, l]));
    const out: SpaceTarget[] = [];
    const sums = new Map<SpaceName, number>();
    for (const space of loaded) {
      for (const p of index[space]!.problems) {
        if (!acceptsSubmissions(p)) continue;
        if (space === "surface" && p.fields.mode === "nofold") continue;
        const weight = spaceTargetWeight(p.P);
        if (!(weight > 0)) continue;
        const lead = site.get(`${space} ${p.id}`) ?? null;
        const cert = p.certified?.score ?? null;
        const siteLeads = !!lead && (cert === null || lead.score < cert * (1 - SCORE_TIE));
        const values = [cert, lead?.score].filter((v): v is number => typeof v === "number");
        if (!values.length) continue;
        const best = Math.min(...values);
        const bound = p.bound?.value ?? null;
        const gap = bound === null ? SPACE_GAP_CAP : (best - bound) / best;
        if (!(gap > SPACE_SETTLED_GAP)) continue;
        const value = Math.min(gap, SPACE_GAP_CAP) * weight;
        sums.set(space, (sums.get(space) ?? 0) + value);
        out.push({
          space,
          id: p.id,
          P: p.P,
          priority: value,
          best_score: best,
          bound,
          leader: siteLeads ? "site" : "certified",
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
    const key = `${wanted ? SPACE_NAMES.filter((s) => wanted.has(s)).join(",") : "all"}|${maxP}|${limit}`;
    const kept = targetAnswers.get(key);
    if (kept) return send(c, kept);
    const at = version;
    let current = ranking;
    if (!current) {
      current = { list: await rank(), at: Date.now() };
      // a ranking read across a change is answered but not kept
      if (at === version) ranking = current;
    }
    const picked: SpaceTarget[] = [];
    for (const t of current.list) {
      if (picked.length >= limit) break;
      if ((wanted && !wanted.has(t.space)) || t.P > maxP) continue;
      picked.push(t);
    }
    const body: SpaceTargetsResponse = { generated_at: new Date(current.at).toISOString(), targets: picked };
    const packed: Packed = { text: JSON.stringify(body), gzip: null };
    if (at === version) {
      if (targetAnswers.size >= TARGET_ANSWERS_KEPT) targetAnswers.clear();
      targetAnswers.set(key, packed);
    }
    return send(c, packed);
  });

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
    const p = cat.byId.get(parsedId.id);
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

    // The time the check takes is charged to the address, as for /api/submit. A configuration that
    // beats the research record must also be valid at the strict tolerance (validateSpaceSubmission).
    const cert = p.certified?.score ?? null;
    const verifyStart = performance.now();
    const verdict = validateSpaceSubmission(space, p.id, body.config, {
      bound: p.bound?.value ?? null,
      maxP: cat.maxP,
      certified: cert,
    });
    verifyMs = performance.now() - verifyStart;
    ctx.verifyBudget.charge(address, verifyMs);
    if (!verdict.valid || verdict.score === null || !verdict.config)
      return reject(verdict.malformed ? 400 : 422, verdict.reasons);
    const score = verdict.score;
    const beats = cert !== null && beatsSpaceScore(score, cert);

    // Kept only when it beats the problem's best value, the research record's or the site
    // leader's, by more than the tie tolerance; otherwise it is valid and not kept.
    const current = await store.spaceLeader(space, p.id);
    const bestBefore = [cert, current?.score].filter((v): v is number => typeof v === "number");
    const best = bestBefore.length ? Math.min(...bestBefore) : null;
    if (best !== null && !beatsSpaceScore(score, best))
      return answer(
        { valid: true, reasons: [], score, leader: false, best_score: best, id: null, beats_certified: beats },
        200,
      );

    // a free torus is stored in a reduced basis (the same lattice and score), so that every reader
    // gets one it can draw; that check is charged to the address too
    const storeStart = performance.now();
    const stored = storedSpaceConfig(space, p.id, verdict.config, {
      bound: p.bound?.value ?? null,
      maxP: cat.maxP,
      certified: cert,
    });
    ctx.verifyBudget.charge(address, performance.now() - storeStart);
    const { id, before, leader, kept } = await store.spaceSubmit({
      space,
      problem: p.id,
      score,
      name,
      agent_note,
      software,
      method,
      seed,
      config: JSON.stringify(stored),
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

  app.get("/api/spaces/:space/records", async (c) => {
    const space = c.req.param("space");
    const cat = catalogue(space);
    if (!cat || !isSpaceName(space)) return unknownSpace(c);
    const cached = recordsCache.get(space);
    if (cached !== undefined) return send(c, cached);
    const at = version;
    const site = new Map((await store.spaceBest(space)).map((l) => [l.problem, siteBestOf(l)]));
    const packed: Packed = {
      text: JSON.stringify({
        space,
        generated_at: new Date().toISOString(),
        problems: cat.problems.map((p) => spaceProblemSummary(p, site.get(p.id) ?? null)),
      } satisfies SpaceRecordsResponse),
      gzip: null,
    };
    if (at === version) recordsCache.set(space, packed);
    return send(c, packed);
  });

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
    const p: SpaceProblemEntry | undefined = cat.byId.get(parsed.id);
    if (!p) return c.json({ error: `${parsed.id} is not in the ${space} catalogue` }, 404);
    const lead = acceptsSubmissions(p) ? await store.spaceLeader(space, p.id) : null;
    const entry = lead ? await store.spaceGet(lead.id) : null;
    // an entry removed between the two reads leaves the problem without a site entry
    const summary = spaceProblemSummary(p, lead && entry ? siteBestOf(lead) : null);
    const head = { ...summary, conventions: SPACE_INFO[space].conventions };
    return c.body(withRaw(head, { certified_config: p.config, site_config: entry?.config ?? null }), 200, {
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
