import {
  AtlasResponse,
  AtlasTile,
  LeaderboardEntry,
  LeaderboardEvent,
  LiteratureRecord,
  MAX_PIECES,
  MAX_SIDES,
  ProblemInfo,
  SubmitResponse,
  TOL,
  areaLowerBound,
  beatsLiterature,
  closedToSubmissions,
  evaluate,
  isShapeCode,
  parseConfig,
  MAX_SOFTWARE_LENGTH,
  parseProvenance,
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
  RateLimiter,
  SUBMISSIONS_PER_MINUTE,
  sanitizeText,
} from "./limits";
import { EntryEdit, Store, StoredSubmission } from "./store";

/** Names a submission may give as its `method`: the registered search methods. */
const METHOD_NAMES = SOLVER_METHODS.map(([name]) => name);

export interface AppOptions {
  store: Store;
  records: LiteratureRecord[];
  /** Admin routes are disabled when this is empty. */
  adminToken?: string;
  /** Address used for rate limiting. */
  clientIp?: (c: Context) => string;
  /** Called for submissions that beat the literature. */
  log?: (msg: string) => void;
  limits?: { perIp?: number; windowMs?: number };
}

const CONVENTIONS = {
  units: "polygon pieces have side length 1; circle pieces have radius 1; angles in radians",
  piece_pose:
    "N-gon vertex k = (x, y) + R (cos(theta + pi/2 + 2 pi k / N), sin(theta + pi/2 + 2 pi k / N)), R = 1 / (2 sin(pi / N)); circles ignore theta",
  container:
    "regular M-gon vertex k = (cx, cy) + s / (2 sin(pi / M)) (cos(phi - pi/2 + pi/M + 2 pi k / M), sin(...)); circle given by centre and radius",
  score: "container side length s (polygon) or radius r (circle); smaller is better",
  shapes: `N and M are 0 for a circle or an integer from 3 to ${MAX_SIDES}; P is from 1 to ${MAX_PIECES}`,
  validity: `pieces may touch; two pieces overlap when their separation is below -${TOL}`,
  scoring: "the server scores at container_phi and at its own auto-oriented phi and keeps the smaller",
};

/** Most values of P that one /api/atlas request may cover. */
export const ATLAS_MAX_SPAN = 100;
/** Most bytes of /api/records answers the server keeps in memory. */
export const RECORDS_CACHE_BYTES = 64 * 1024 * 1024;
/** Most pieces one /api/atlas response carries; the rest of the range is reached through `next`. */
export const ATLAS_MAX_PIECES = 6000;

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
  if (verified && (!lit || verified.score <= lit.value + Math.max(Math.pow(10, -lit.display_precision), 1e-9)))
    return "verified";
  if (lit?.pieces) return "literature";
  if (verified) return "verified";
  return pending ? "pending" : null;
}

/** A query value that is a plain decimal integer; anything else (empty, "0x10", "1e2", "1.5") is NaN. */
function decimalInteger(text: string | undefined): number {
  return text !== undefined && /^\d{1,9}$/.test(text) ? Number(text) : NaN;
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
  const app = new Hono();
  const windowMs = opts.limits?.windowMs ?? 60_000;
  const ipLimit = new RateLimiter(opts.limits?.perIp ?? SUBMISSIONS_PER_MINUTE, windowMs);
  const clientIp = opts.clientIp ?? (() => "unknown");
  const log = opts.log ?? ((msg: string) => console.log(msg));

  const literature = new Map<string, LiteratureRecord>();
  for (const r of opts.records) literature.set(`${r.N}/${r.M}/${r.P}`, r);

  /**
   * Closed problems take no submissions and show no site entries: their published optimum stands.
   * Entries stored before a problem was closed stay in the database and keep their share links.
   */
  const closed = (N: number, M: number, P: number) => closedToSubmissions(literature.get(`${N}/${M}/${P}`));

  const listeners = new Set<(e: LeaderboardEvent) => void>();

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

  app.get("/api", (c) => c.html(docsPage({ atlasMaxSpan: ATLAS_MAX_SPAN, atlasMaxPieces: ATLAS_MAX_PIECES })));
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
    const reject = (status: 400 | 409 | 413 | 422 | 429, reasons: string[]) => {
      const body: SubmitResponse = {
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
      };
      return c.json(body, status);
    };
    if (!ipLimit.allow(clientIp(c))) return reject(429, ["too many submissions from this address; wait a minute"]);
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return reject(413, ["request body too large"]);
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) return reject(413, ["request body too large"]);
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
    const lit = literature.get(`${config.N}/${config.M}/${config.P}`);
    // decided before the packing is looked at: nothing can improve on a proven optimum
    if (closedToSubmissions(lit))
      return reject(409, [`this problem is closed: its optimum ${lit!.display} is proven (${lit!.source_name})`]);
    const name = sanitizeText(config.name ?? "", MAX_NAME_LENGTH);
    if (!name) return reject(400, ["name is required"]);

    // The score is always recomputed here. Any container or score fields in the body were
    // already dropped by parseConfig.
    const result = evaluate(config, { autoOrient: true, maxOverlaps: MAX_REPORTED_OVERLAPS });
    if (!result.valid || !result.container) return reject(422, result.reasons);
    const container = result.container;
    const score = container.size;

    const beats = !!lit && beatsLiterature(score, lit);
    const strict = beats ? strictVerify(config.N, config.pieces, container) : null;

    const before = await store.leader(config.N, config.M, config.P);
    const id = await store.insert({
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
    const [leader, position] = await Promise.all([
      store.leader(config.N, config.M, config.P),
      store.rank(config.N, config.M, config.P, id),
    ]);
    const leads = leader?.id === id;
    const rank = leads ? 1 : Math.max(2, position);
    // A problem keeps only its leader (and, behind a pending leader, the record it displaced); this
    // entry may already be among the deleted.
    const kept = !(await store.prune(config.N, config.M, config.P)).includes(id);
    // after the insert and the prune, so that no answer computed in between is kept
    forgetRecords(`${config.N}/${config.M}`);
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
      for (const fn of listeners) fn(event);
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
    return c.json(body);
  });

  // Live updates: one "leaderboard" event whenever a problem gets a new leader.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: LeaderboardEvent[] = [];
      let wake: (() => void) | null = null;
      const listener = (e: LeaderboardEvent) => {
        queue.push(e);
        wake?.();
      };
      listeners.add(listener);
      stream.onAbort(() => {
        listeners.delete(listener);
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
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
      listeners.delete(listener);
    }),
  );

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
    if (ok) forgetRecords();
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
    if (ok) forgetRecords();
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
    if (ok) forgetRecords();
    if (ok) log(`[review] submission ${body.id} edited: ${Object.keys(changes).join(", ") || "nothing"}`);
    return ok ? c.json({ ok: true }) : c.json({ error: "no such listed submission" }, 404);
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  return app;
}
