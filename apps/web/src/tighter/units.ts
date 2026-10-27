import { ballsProblemOf } from "@polypack/balls/catalogue";
import { isPolygon, parseKey } from "./frontier";
import { spaceFields } from "./families";

/**
 * The unit change of 2026-10-27 as it reaches a Tighter save (save.ts, migration 5). Disk and ball
 * pieces had radius 1 and now have diameter 1; a circle or ball container was scored by its radius
 * and now by its diameter. Every length of an affected problem moves by a power of two, so the
 * conversion is exact. The factors are the server's (apps/server/src/units-migration.ts planarFactors
 * and spacePlan), which a test compares with these.
 */
export interface UnitPlan {
  /** Factor of every score of the problem: its best, trace, leader, floor, bound and the like. */
  score: number;
  /** Rewrites a copy of a board of the problem in place. */
  board(b: Record<string, unknown>): void;
}

/**
 * Curved disk problems at K != 0 have no counterpart: radius-1 disks at K are diameter-1 disks at 4K,
 * another problem. The server set their entries aside, and a save drops them.
 */
export const DROPPED = "dropped" as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const scale = (o: Record<string, unknown>, key: string, f: number) => {
  if (typeof o[key] === "number") o[key] = (o[key] as number) * f;
};
const scaleAt = (list: unknown, f: number, ...indices: number[]) => {
  if (Array.isArray(list)) for (const i of indices) if (typeof list[i] === "number") list[i] = (list[i] as number) * f;
};
/** x and y of every piece object in `list` times f. */
const scaleXY = (list: unknown, f: number) => {
  if (Array.isArray(list))
    for (const p of list)
      if (isObj(p)) {
        scale(p, "x", f);
        scale(p, "y", f);
      }
};
const plan = (score: number, board: (b: Record<string, unknown>) => void): UnitPlan => ({ score, board });

/** What the unit change does to the problem of a save's key; null when it leaves it alone. */
export function unitPlan(key: string): UnitPlan | typeof DROPPED | null {
  const k = parseKey(key);
  if (!k) return null;
  if (isPolygon(k)) {
    // disks in a disk: the old radius is the new diameter; disks in a polygon: the side halves
    if (k.N === 0) return plan(k.M === 0 ? 1 : 0.5, (b) => scaleXY(b.pieces, 0.5));
    // polygons keep side 1, and the circle container is scored by its diameter
    if (k.M === 0) return plan(2, () => {});
    return null;
  }
  const f = spaceFields(k.id);
  if (!f) return null;
  switch (f.family) {
    case "surface":
      if (f.N !== 0) return null;
      return plan(0.5, (b) => {
        scale(b, "s", 0.5);
        scaleXY(b.pieces, 0.5);
      });
    case "sphere":
      // the pieces are rotations, which keep; the sphere's radius halves
      return f.N === 0 ? plan(0.5, (b) => scale(b, "rho", 0.5)) : null;
    case "torus":
      if (f.N !== 0) return null;
      return plan(0.5, (b) => {
        if (isObj(b.lattice)) {
          scale(b.lattice, "L", 0.5);
          scaleAt(b.lattice.b1, 0.5, 0, 1);
          scaleAt(b.lattice.b2, 0.5, 0, 1);
        }
        if (Array.isArray(b.poses)) for (const q of b.poses) scaleAt(q, 0.5, 0, 1);
      });
    case "curved":
      if (f.N === 0) {
        if (Number(f.K) !== 0) return DROPPED;
        const size = f.M === 0 ? 1 : 0.5;
        return plan(size, (b) => {
          scale(b, "size", size);
          scaleXY(b.pieces, 0.5);
        });
      }
      return f.M === 0 ? plan(2, (b) => scale(b, "size", 2)) : null;
    case "balls": {
      const p = ballsProblemOf(f.code);
      if (!p) return null;
      if (p.piece === "ball") {
        // a ball's centre is [x, y, z]; in a ball the old radius is the new diameter
        const s = p.container === "ball" ? 1 : 0.5;
        return plan(s, (b) => {
          scale(b, "s", s);
          if (Array.isArray(b.pieces)) for (const q of b.pieces) scaleAt(q, 0.5, 0, 1, 2);
        });
      }
      // solids keep their size, and the ball container is scored by its diameter
      return p.container === "ball" ? plan(2, (b) => scale(b, "s", 2)) : null;
    }
    case "polyhedra":
      return null;
  }
}

/** What a save's conversion did: problems converted, and problems dropped (DROPPED). */
export interface UnitsReport {
  converted: number;
  dropped: number;
}

/** A copy of `o` with the numbers at `keys` times f; a key it does not have stays absent. */
function times<T extends Record<string, unknown>>(o: T, f: number, ...keys: string[]): T {
  const out: Record<string, unknown> = { ...o };
  for (const k of keys) scale(out, k, f);
  return out as T;
}
/** A leader-like object ({score, ...}) with its score times f. */
const scoreOf = (v: unknown, f: number) => (isObj(v) ? times(v, f, "score") : v);

/** A board converted by the plan: a deep copy, so that the save read is left untouched. */
function convertBoard(v: unknown, u: UnitPlan): unknown {
  if (!isObj(v)) return v;
  const b = structuredClone(v);
  u.board(b);
  return b;
}

/** A queued problem with every length converted (save.ts problemState reads these). */
function convertQueued(q: Record<string, unknown>, u: UnitPlan): Record<string, unknown> {
  const f = u.score;
  const out = times(q, f, "best", "floor", "published", "bound", "verified", "paidTo", "progressBest");
  if ("board" in q) out.board = convertBoard(q.board, u);
  for (const k of ["leader", "refused", "lattice"]) if (k in q) out[k] = scoreOf(q[k], f);
  if (isObj(q.sending)) {
    const sending = times(q.sending, f, "score");
    if ("leaderBefore" in sending) sending.leaderBefore = scoreOf(sending.leaderBefore, f);
    out.sending = sending;
  }
  // the board's score after each improvement, by evaluations: [evaluations, score]
  if (Array.isArray(q.trace))
    out.trace = q.trace.map((x) =>
      Array.isArray(x) ? x.map((v, i) => (i === 1 && typeof v === "number" ? v * f : v)) : x,
    );
  return out;
}

/** The key of a saved offer, as picks.ts normalizeOffer reads it. */
const offerKey = (o: Record<string, unknown>) =>
  typeof o.id === "string" && o.family !== "polygon" ? o.id : `${o.N}/${o.M}/${o.P}`;

/**
 * A save of version 5 in the units of version 6: the queue, the problems that left it and the offers
 * of Your pick, each by its problem's plan. Every other field is kept as it is. Run once, by the
 * migration: a save of version 6 is already in these units.
 */
export function convertSaveUnits(save: Record<string, unknown>): {
  save: Record<string, unknown>;
  report: UnitsReport;
} {
  const report: UnitsReport = { converted: 0, dropped: 0 };
  const dropped = new Set<string>();
  const planOf = (key: unknown) => (typeof key === "string" ? unitPlan(key) : null);
  const queue = Array.isArray(save.queue)
    ? save.queue.flatMap((q) => {
        if (!isObj(q)) return [q];
        const u = planOf(q.key);
        if (u === DROPPED) {
          dropped.add(q.key as string);
          return [];
        }
        if (!u) return [q];
        report.converted++;
        return [convertQueued(q, u)];
      })
    : save.queue;
  const past = Array.isArray(save.past)
    ? save.past.flatMap((q) => {
        if (!isObj(q)) return [q];
        const u = planOf(q.key);
        if (u === DROPPED) {
          dropped.add(q.key as string);
          return [];
        }
        if (!u) return [q];
        report.converted++;
        return [times(q, u.score, "best", "verified")];
      })
    : save.past;
  report.dropped = dropped.size;
  let picks = save.picks;
  if (isObj(picks)) {
    const offers = Array.isArray(picks.offers)
      ? picks.offers.flatMap((o) => {
          if (!isObj(o)) return [o];
          const u = planOf(offerKey(o));
          if (u === DROPPED) return [];
          if (!u) return [o];
          const out = times(o, u.score, "target", "bound");
          if ("leader" in o) out.leader = scoreOf(o.leader, u.score);
          return [out];
        })
      : picks.offers;
    const retake = Array.isArray(picks.retake)
      ? picks.retake.filter((k) => !(typeof k === "string" && planOf(k) === DROPPED))
      : picks.retake;
    const dealt = isObj(picks.dealt)
      ? Object.fromEntries(Object.entries(picks.dealt).filter(([k]) => planOf(k) !== DROPPED))
      : picks.dealt;
    picks = { ...picks, offers, retake, dealt };
  }
  return { save: { ...save, queue, past, ...(picks !== undefined ? { picks } : {}) }, report };
}
