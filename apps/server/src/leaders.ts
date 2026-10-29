import { MAX_PIECES, Verification, isShapeCode } from "@polypack/geometry";
import { SpacesIndex, acceptsSubmissions, isSpaceName, parseSpaceId, problemOf } from "@polypack/spaces";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { SpaceStore, Store } from "./store";

/** Most keys one /api/leaders request names. */
export const LEADERS_MAX_KEYS = 200;
/** Longest request URL /api/leaders answers, in characters: 200 keys of the longest ids stay well under it. */
export const LEADERS_MAX_URL = 12_000;
/** The name a research record goes by as a leader (the one Tighter shows for it). */
export const RESEARCH_RECORD_NAME = "the research record";

/** One problem's leader, as /api/leaders answers it. */
export interface LeaderInfo {
  score: number;
  name: string;
  /** Submission id of the site entry; null for a research record. */
  id: number | null;
  /** A polygon leader's verification, as in `site_best` ("none", "confirmed" or "pending"); absent for space problems. */
  verification?: Verification;
  /** Present, true, when the leader is the problem's research record and not a site entry. */
  research?: true;
}

export interface LeadersResponse {
  leaders: Record<string, LeaderInfo | null>;
  unknown: string[];
}

/** A polygon problem written "N/M/P", without leading zeros. */
const POLYGON_KEY = /^(0|[1-9]\d{0,2})\/(0|[1-9]\d{0,2})\/([1-9]\d{0,5})$/;

/**
 * GET /api/leaders?keys=<k1>,<k2>,...: the current leader of each named problem, for a client that holds
 * many records and checks them in batches. A polygon problem's answer is its `site_best` of
 * /api/problems/N/M/P (null when it is closed or has no entry). A space problem's is the best value of
 * /api/spaces/<space>/problems/<id>: the research record when it is at least as good as the site entry
 * (that is `research: true`, `id` null), else the site entry. One indexed read per kind, no configurations.
 */
export function registerLeadersRoute(
  app: Hono,
  ctx: {
    store: Store;
    spaceStore?: SpaceStore;
    spaces?: SpacesIndex;
    /** Whether a polygon problem is closed to submissions (its published optimum stands; no site entry shows). */
    closed: (N: number, M: number, P: number) => boolean;
  },
): void {
  const { store } = ctx;
  app.use("/api/leaders", compress());
  app.get("/api/leaders", async (c) => {
    if (c.req.url.length > LEADERS_MAX_URL) return c.json({ error: `the URL is over ${LEADERS_MAX_URL} characters` }, 414);
    const url = new URL(c.req.url);
    const given = url.searchParams.getAll("keys");
    const other = [...new Set(url.searchParams.keys())].filter((k) => k !== "keys");
    if (given.length !== 1 || other.length)
      return c.json({ error: "give keys once, as a comma-separated list: ?keys=3/3/5,sphere/0/12 (no other parameter)" }, 400);
    const list = given[0]!.split(",");
    if (given[0] === "" || list.length > LEADERS_MAX_KEYS)
      return c.json({ error: `keys: from 1 to ${LEADERS_MAX_KEYS} keys, comma-separated` }, 400);

    const unknown: string[] = [];
    const polygons = new Map<string, { N: number; M: number; P: number }>();
    const spaces = new Map<string, { space: string; id: string; certified: number | null; open: boolean }>();
    const seen = new Set<string>();
    for (const key of list) {
      if (seen.has(key)) continue;
      seen.add(key);
      const m = POLYGON_KEY.exec(key);
      if (m) {
        const [N, M, P] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (isShapeCode(N) && isShapeCode(M) && P <= MAX_PIECES) polygons.set(key, { N, M, P });
        else unknown.push(key);
        continue;
      }
      const space = key.split("/")[0]!;
      const cat = isSpaceName(space) ? ctx.spaces?.[space] : undefined;
      const parsed = cat ? parseSpaceId(space as never, key) : null;
      const p = cat && parsed && typeof parsed !== "string" ? problemOf(cat, parsed) : null;
      if (!p) unknown.push(key);
      else spaces.set(key, { space, id: p.id, certified: p.certified?.score ?? null, open: acceptsSubmissions(p) });
    }

    const leaders: Record<string, LeaderInfo | null> = {};
    // polygons: one read for the open problems; a closed one shows no site entry
    const open = [...polygons].filter(([, p]) => !ctx.closed(p.N, p.M, p.P));
    const found = new Map(
      (await store.leadersOf(open.map(([, p]) => p))).map((l) => [`${l.N}/${l.M}/${l.P}`, l] as const),
    );
    for (const [key, p] of polygons) {
      const l = found.get(`${p.N}/${p.M}/${p.P}`);
      leaders[key] = l && !ctx.closed(p.N, p.M, p.P) ? { score: l.score, name: l.name, id: l.id, verification: l.verification } : null;
    }
    // spaces: one read for the open problems
    const entered = ctx.spaceStore
      ? await ctx.spaceStore.spaceLeadersOf(
          [...spaces.values()].filter((s) => s.open).map((s) => ({ space: s.space, problem: s.id })),
        )
      : [];
    const site = new Map(entered.map((l) => [`${l.space} ${l.problem}`, l] as const));
    for (const [key, s] of spaces) {
      const lead = s.open ? (site.get(`${s.space} ${s.id}`) ?? null) : null;
      const cert = s.certified !== null && s.certified > 0 ? s.certified : null;
      leaders[key] =
        cert !== null && (!lead || cert <= lead.score)
          ? { score: cert, name: RESEARCH_RECORD_NAME, id: null, research: true }
          : lead
            ? { score: lead.score, name: lead.name, id: lead.id }
            : null;
    }
    // answered in the order the keys were asked
    const ordered: Record<string, LeaderInfo | null> = {};
    for (const key of seen) if (key in leaders) ordered[key] = leaders[key]!;
    return c.json({ leaders: ordered, unknown } satisfies LeadersResponse);
  });
}