/**
 * Improves records for free: wherever a shape pair's record for P is worse than the record for
 * some larger P (or P has none), the larger packing minus its outermost pieces is a valid packing
 * of P in a container no larger. See scripts/trim-down/lib.ts for how pieces are chosen.
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
import { trimTo } from "./trim-down/lib";

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

async function get(path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(60_000) });
      if (r.ok) return await r.json();
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
  /** The P of the stored packing it was trimmed from (its own P when not trimmed). */
  origin: number;
  score: number;
  /** Where the packing comes from, for the software note. */
  what: string;
  load: () => Promise<{ pieces: Pose[]; container_phi: number }>;
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
        donors.set(l.P, {
          P: l.P,
          origin: l.P,
          score: l.value,
          what: `published P=${l.P}`,
          load: async () => {
            const lit = (await get(`/api/problems/${N}/${M}/${l.P}`)).literature;
            return { pieces: lit.pieces, container_phi: lit.container_phi ?? 0 };
          },
        });
    }
    for (const s of data.site) {
      record.set(s.P, Math.min(record.get(s.P) ?? Infinity, s.score));
      if (s.verification === "pending") continue;
      if (donors.has(s.P) && donors.get(s.P)!.score <= s.score) continue;
      donors.set(s.P, {
        P: s.P,
        origin: s.P,
        score: s.score,
        what: `P=${s.P} entry #${s.id}`,
        load: async () => {
          const e = await get(`/api/submissions/${s.id}`);
          return { pieces: e.pieces, container_phi: e.container_phi };
        },
      });
    }

    let best: Donor | null = null;
    let pairImproved = 0;
    for (let P = MAX_PIECES; P >= 1; P--) {
      const own = record.get(P);
      if (best && !closed.has(P) && (own === undefined || improvesOn(best.score, own))) {
        totals.candidates++;
        const from = await best.load();
        const trimmed = trimTo(N, M, from.pieces, from.container_phi, P);
        if (own === undefined || improvesOn(trimmed.score, own)) {
          totals.improved++;
          pairImproved++;
          if (own !== undefined) totals.gains.push(1 - trimmed.score / own);
          const removed = best.origin - P;
          const software = `polypack trim: ${best.what}, ${removed} piece${removed === 1 ? "" : "s"} removed`;
          if (opts.submit) {
            totals.sent++;
            const answer = await post({
              N,
              M,
              P,
              pieces: trimmed.pieces,
              container_phi: trimmed.container_phi,
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
          record.set(P, trimmed.score);
          const pieces = trimmed.pieces;
          const phi = trimmed.container_phi;
          donors.set(P, {
            P,
            origin: best.origin,
            score: trimmed.score,
            what: best.what,
            load: async () => ({ pieces, container_phi: phi }),
          });
        }
      }
      // the best packing above the next P: this one, if it is better than every larger one
      const mine = donors.get(P);
      if (mine && (!best || mine.score < best.score)) best = mine;
      // keep a fetched donor's packing rather than fetch it again for the next P
      if (best && best === mine && !best.load.name.startsWith("cached")) {
        const load = best.load;
        let cache: Promise<{ pieces: Pose[]; container_phi: number }> | null = null;
        best.load = Object.defineProperty(() => (cache ??= load()), "name", { value: "cached" });
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
