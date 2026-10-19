/**
 * Improves records for free: wherever a shape pair's record for P is worse than the record for
 * some larger P (or P has none), the larger packing minus its outermost pieces is a valid packing
 * of P in a container no larger. For squares in a square and triangles in a triangle, a packing
 * in side s also gives one of P + 2 floor(s) + 1 pieces in side s + 1, by adding strips. See
 * scripts/trim-down/lib.ts for both constructions.
 *
 *   npx tsx scripts/trim-down.ts --N 4 --M 4                    report what would improve
 *   npx tsx scripts/trim-down.ts --N 0,3-20 --M 0,3-20 --submit --name "Claude Opus 5.5"
 *
 * Each pair is walked from P = 500 down, so a trimmed packing of P + 1 is the donor for P when
 * it is the best one above P, and improvements cascade. Donors are site entries that are not
 * awaiting review and published packings with coordinates. Problems with a proven optimum are
 * left alone. Entries are sent with found_with "external" and a software note naming the donor.
 */
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { MAX_PIECES, type Pose, improvesOn } from "@polypack/geometry";
import { parseShapes } from "./batch-search/lib";
import { growByStrip, stripsFit, trimTo } from "./trim-down/lib";

const { values: opts } = parseArgs({
  options: {
    N: { type: "string" },
    M: { type: "string" },
    base: { type: "string", default: "https://polypack.fly.dev" },
    submit: { type: "boolean", default: false },
    name: { type: "string" },
    "per-minute": { type: "string", default: "60" },
  },
});
if (!opts.N || !opts.M) throw new Error("give --N and --M, e.g. --N 4 --M 4");
if (opts.submit && !opts.name) throw new Error('--submit needs --name, e.g. --name "Claude Opus 5.5"');
const Ns = parseShapes(opts.N, "N");
const Ms = parseShapes(opts.M, "M");
const base = opts.base!.replace(/\/$/, "");
const gapMs = 60_000 / Math.max(1, Number(opts["per-minute"]));

/** The JSON at `path`; with `missingOk`, null for a 404 instead of retrying and failing. */
async function get(path: string, missingOk = false): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(60_000) });
      if (r.ok) return await r.json();
      if (r.status === 404 && missingOk) return null;
      if (r.status < 500) throw new Error(`HTTP ${r.status} for ${path}`);
    } catch (e) {
      if (attempt >= 5) throw e;
    }
    await sleep(2000 * 2 ** attempt);
  }
}

let lastPost = 0;
async function post(body: object): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastPost + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastPost = Date.now();
    try {
      const r = await fetch(`${base}/api/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const answer = { status: r.status, body: await r.json().catch(() => null) };
      if (r.status === 429 && attempt < 3) {
        await sleep(65_000);
        continue;
      }
      if (r.status < 500 || attempt >= 3) return answer;
    } catch (e) {
      if (attempt >= 3) return { status: 0, body: String(e) };
    }
    await sleep(5000 * 2 ** attempt);
  }
}

interface Donor {
  P: number;
  score: number;
  /** The stored packing it comes from, for the software note. */
  what: string;
  /** Strip growths and pieces removed since that packing (0 and 0 for a stored packing). */
  grows: number;
  removed: number;
  /** null for a site entry deleted since the listing was read (overtaken: only leaders are kept). */
  load: () => Promise<Arrangement | null>;
}

type Arrangement = { pieces: Pose[]; container_phi: number };

/** Keeps a fetched packing rather than fetching it again. */
function cached(d: Donor): Donor {
  const load = d.load;
  let cache: Promise<Arrangement | null> | null = null;
  return { ...d, load: () => (cache ??= load()) };
}

const totals = { candidates: 0, improved: 0, sent: 0, accepted: 0, refused: 0, gains: [] as number[] };

for (const N of Ns)
  for (const M of Ms) {
    const data = await get(`/api/records?N=${N}&M=${M}`);
    const closed = new Set<number>();
    const record = new Map<number, number>();
    const donors = new Map<number, Donor>();
    for (const l of data.literature) {
      if (l.status === "proven" || l.status === "trivial_tiling") closed.add(l.P);
      record.set(l.P, Math.min(record.get(l.P) ?? Infinity, l.value));
      if (l.has_coordinates)
        donors.set(
          l.P,
          cached({
            P: l.P,
            score: l.value,
            what: `published P=${l.P}`,
            grows: 0,
            removed: 0,
            load: async () => {
              const lit = (await get(`/api/problems/${N}/${M}/${l.P}`)).literature;
              return { pieces: lit.pieces, container_phi: lit.container_phi ?? 0 };
            },
          }),
        );
    }
    for (const s of data.site) {
      record.set(s.P, Math.min(record.get(s.P) ?? Infinity, s.score));
      if (s.verification === "pending") continue;
      if (donors.has(s.P) && donors.get(s.P)!.score <= s.score) continue;
      donors.set(
        s.P,
        cached({
          P: s.P,
          score: s.score,
          what: `P=${s.P} entry #${s.id}`,
          grows: 0,
          removed: 0,
          load: async () => {
            const e = await get(`/api/submissions/${s.id}`, true);
            return e ? { pieces: e.pieces, container_phi: e.container_phi } : null;
          },
        }),
      );
    }
    const original = new Map(record);
    /** Takes a derived packing for P when it beats what is known so far. */
    const offer = (
      P: number,
      from: Donor,
      made: { pieces: Pose[]; container_phi: number; score: number },
      how: Partial<Donor>,
    ) => {
      const known = record.get(P);
      if (known !== undefined && !improvesOn(made.score, known)) return;
      record.set(P, made.score);
      const { pieces, container_phi } = made;
      donors.set(P, { ...from, ...how, P, score: made.score, load: async () => ({ pieces, container_phi }) });
    };

    // Upwards: a packing of P in side s gives one of P + 2 floor(s) + 1 in side s + 1, for the
    // pairs where pieces tile a strip along the container (growByStrip). Ascending, so that a
    // grown packing grows again.
    if (stripsFit(N, M))
      for (let P = 1; P <= MAX_PIECES; P++) {
        const d = donors.get(P);
        if (!d) continue;
        const Q = P + 2 * Math.floor(d.score + 1e-9) + 1;
        if (Q > MAX_PIECES || closed.has(Q)) continue;
        const known = record.get(Q);
        if (known !== undefined && !improvesOn(d.score + 1, known)) continue;
        const from = await d.load();
        if (!from) continue;
        const grown = growByStrip(N, M, from.pieces, from.container_phi);
        if (grown && grown.pieces.length === Q) offer(Q, d, grown, { grows: d.grows + 1 });
      }

    // Downwards: the best packing of more pieces, minus its outermost pieces (trimTo). Descending,
    // so that a trimmed packing is the donor for the next P down when it is the best above it.
    let best: Donor | null = null;
    for (let P = MAX_PIECES; P >= 1; P--) {
      const own = record.get(P);
      if (best && !closed.has(P) && (own === undefined || improvesOn(best.score, own))) {
        totals.candidates++;
        const from = await best.load();
        if (from)
          offer(P, best, trimTo(N, M, from.pieces, from.container_phi, P), { removed: best.removed + (best.P - P) });
      }
      const mine = donors.get(P);
      if (mine && (!best || mine.score < best.score)) best = mine;
    }

    // Send every derived packing that beats the record this run started from.
    let pairImproved = 0;
    for (let P = 1; P <= MAX_PIECES; P++) {
      const d = donors.get(P);
      const before = original.get(P);
      if (!d || (d.grows === 0 && d.removed === 0) || closed.has(P)) continue;
      if (before !== undefined && !improvesOn(d.score, before)) continue;
      totals.improved++;
      pairImproved++;
      if (before !== undefined) totals.gains.push(1 - d.score / before);
      const steps = [
        d.grows ? `${d.grows} strip growth${d.grows === 1 ? "" : "s"}` : "",
        d.removed ? `${d.removed} removed` : "",
      ].filter(Boolean);
      const software = `polypack: from ${d.what}, ${steps.join(", ")}`;
      if (!opts.submit) continue;
      // derived packings are computed here, so they are always at hand
      const { pieces, container_phi } = (await d.load())!;
      totals.sent++;
      const answer = await post({
        N,
        M,
        P,
        pieces,
        container_phi,
        name: opts.name,
        found_with: "external",
        software: software.slice(0, 80),
      });
      if (answer.status === 200) totals.accepted++;
      else {
        totals.refused++;
        console.log(`${N}/${M}/${P}: HTTP ${answer.status} ${JSON.stringify(answer.body).slice(0, 200)}`);
      }
    }
    if (pairImproved) console.log(`${N}/${M}: ${pairImproved} improved`);
  }

const g = totals.gains.sort((a, b) => a - b);
console.log(
  `${totals.candidates} candidates, ${totals.improved} improved` +
    (g.length ? ` (median ${(100 * g[g.length >> 1]).toFixed(4)}%, max ${(100 * g[g.length - 1]).toFixed(3)}%)` : "") +
    (opts.submit
      ? `; ${totals.sent} sent, ${totals.accepted} accepted, ${totals.refused} refused`
      : "; nothing sent (no --submit)"),
);
