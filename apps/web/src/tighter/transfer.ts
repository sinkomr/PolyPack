import { MAX_PIECES, evaluate, findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { FRONTIER_P, PolygonKey } from "./frontier";

/**
 * Transfers (plan §4): a new problem starts from the best known packing of a neighbour with fewer
 * pieces (same N and M), the missing pieces placed in free space around it as Load all places
 * pieces (findFreeSpot), instead of Load all. The start is used only when it is clearly smaller
 * than Load all (TRANSFER_MARGIN), and it is never a record by itself: the problem's free floor becomes the smallest of Load
 * all, the trim floor (P + 1 less a piece) and the transferred board, so the first record must
 * improve on all three by more than F. The neighbour's packing is public: the player's own board in
 * the queue, or the site's record of that problem.
 */

/** Most neighbours looked up on the site for one problem (one GET each, plus one for the packing). */
export const MAX_NEIGHBOUR_LOOKUPS = 4;

/**
 * Neighbours worth looking for, closest first: with the wider frontier (any P), P − 1 to P − 3;
 * then the frontier's piece counts below P.
 */
export function neighbourPs(P: number, wide: boolean): number[] {
  const out: number[] = [];
  if (wide) for (let k = 1; k <= 3; k++) if (P - k >= 2) out.push(P - k);
  for (const q of [...FRONTIER_P].reverse()) if (q < P && !out.includes(q)) out.push(q);
  return out.slice(0, MAX_NEIGHBOUR_LOOKUPS);
}

/** The centroid of a packing's pieces (where Load all would place the next ones around). */
function centroid(pieces: readonly Pose[]): { x: number; y: number } {
  if (!pieces.length) return { x: 0, y: 0 };
  let x = 0,
    y = 0;
  for (const q of pieces) {
    x += q.x;
    y += q.y;
  }
  return { x: x / pieces.length, y: y / pieces.length };
}

/** Points tried for each added piece when they are placed one by one where they grow the container least. */
const GREEDY_DIRECTIONS = 16;
/** Most evaluations spent placing pieces so (beyond it, pieces go around the centre as Load all's do). */
export const GREEDY_BUDGET = 200;

/**
 * The free spot (findFreeSpot from points around the packing's rim and centre) that leaves the
 * smallest container, scored with the container at the neighbour's angle.
 */
function leastGrowth(N: number, M: number, pieces: Pose[], phi: number): Pose {
  const c = centroid(pieces);
  const R = Math.max(0, ...pieces.map((q) => Math.hypot(q.x - c.x, q.y - c.y)));
  const seeds: [number, number][] = [[c.x, c.y]];
  for (let k = 0; k < GREEDY_DIRECTIONS; k++) {
    const a = (2 * Math.PI * k) / GREEDY_DIRECTIONS;
    for (const f of [0.7, 1]) seeds.push([c.x + f * R * Math.cos(a), c.y + f * R * Math.sin(a)]);
  }
  let best: Pose | null = null;
  let top = Infinity;
  for (const [x, y] of seeds) {
    const spot = findFreeSpot(N, pieces, x, y);
    const e = evaluate(
      { N, M, P: pieces.length + 1, pieces: [...pieces, spot], container_phi: phi },
      { autoOrient: false },
    );
    if (e.valid && e.score !== null && e.score < top) {
      top = e.score;
      best = spot;
    }
  }
  return best ?? findFreeSpot(N, pieces, c.x, c.y);
}

/**
 * The neighbour's packing grown to `target`'s P pieces: its own pieces unchanged, the rest placed in
 * free space. A few pieces are placed one by one where each grows the container least; many go
 * around the centre. Null when the neighbour is not a smaller packing of the same N and M.
 */
export function transferBoard(neighbour: PackingConfig, target: PolygonKey): PackingConfig | null {
  if (neighbour.N !== target.N || neighbour.M !== target.M) return null;
  if (neighbour.pieces.length !== neighbour.P || neighbour.P >= target.P || target.P > MAX_PIECES) return null;
  const pieces: Pose[] = neighbour.pieces.map((q) => ({ x: q.x, y: q.y, theta: q.theta }));
  const greedy = (target.P - neighbour.P) * (2 * GREEDY_DIRECTIONS + 1) <= GREEDY_BUDGET;
  const c = centroid(pieces);
  while (pieces.length < target.P)
    pieces.push(
      greedy
        ? leastGrowth(target.N, target.M, pieces, neighbour.container_phi)
        : findFreeSpot(target.N, pieces, c.x, c.y),
    );
  return { N: target.N, M: target.M, P: target.P, pieces, container_phi: neighbour.container_phi };
}

export interface TransferStart {
  board: PackingConfig;
  score: number;
  /** The neighbour's piece count. */
  from: number;
}

/** The transferred board scored as the server scores it (container at its best angle), or null if not valid. */
export function scoredTransfer(neighbour: PackingConfig, target: PolygonKey): TransferStart | null {
  const board = transferBoard(neighbour, target);
  if (!board) return null;
  const e = evaluate(board, { autoOrient: true });
  if (!e.valid || !e.container || e.score === null || !(e.score > 0)) return null;
  return { board: { ...board, container_phi: e.container.phi }, score: e.score, from: neighbour.P };
}

/**
 * A transfer starts the problem only when it is this much smaller than Load all. Compact (100
 * evaluations) from each start, 14 neighbours of frontier problems [CALC, 2026-10-20, scratchpad
 * runs/transfer-bench*.mts]: every transfer that started at least 4 % smaller than Load all was
 * still smaller or equal after Compact (ratios 0.957 to 1.000); one that started 1.1 % smaller
 * (a weakly compacted neighbour) ended 0.8 % larger; starts larger than Load all ended 2.7 to 5.1 %
 * larger.
 */
export const TRANSFER_MARGIN = 0.98;

/**
 * The start of a new problem: Load all, or a transfer when it is clearly smaller. The free floor is
 * the smallest of the scores, so neither start can be sent unimproved.
 */
export function chooseStart(
  loadAll: { board: PackingConfig; score: number },
  trim: number | null,
  transfer: TransferStart | null,
): { board: PackingConfig; score: number; floor: number; transferred: boolean } {
  const t = transfer && transfer.score < TRANSFER_MARGIN * loadAll.score ? transfer : null;
  const start = t ?? loadAll;
  const floor = Math.min(loadAll.score, start.score, trim ?? Infinity);
  return { board: start.board, score: start.score, floor, transferred: !!t };
}
