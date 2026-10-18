import { Pose, containerVertices, evaluate } from "@polypack/geometry";

/**
 * A record can never be worse than one for more pieces: removing pieces from a valid packing of
 * Q > P pieces leaves a valid packing of P, in a container no larger. This turns the packing of a
 * larger P into one of a smaller P, removing one piece at a time.
 *
 * Each step removes the piece whose removal lets the container shrink most. Only pieces far from
 * the centre can matter, so at most `candidates` of the outermost are tried at each step; the
 * container is refitted (auto-oriented) after every removal, so the result is at most the donor's
 * size and usually below it.
 */
export function trimTo(
  N: number,
  M: number,
  pieces: readonly Pose[],
  phi: number,
  P: number,
  candidates = 12,
): { pieces: Pose[]; container_phi: number; score: number } {
  let kept = pieces.map((p) => ({ ...p }));
  let fit = evaluate({ N, M, P: kept.length, pieces: kept, container_phi: phi }, { autoOrient: true });
  if (!fit.container) throw new Error("an empty packing cannot be trimmed");
  while (kept.length > P) {
    const { cx, cy } = fit.container!;
    const outermost = kept
      .map((p, i) => ({ i, d: Math.hypot(p.x - cx, p.y - cy) }))
      .sort((a, b) => b.d - a.d)
      .slice(0, candidates);
    let best: { rest: Pose[]; fit: typeof fit } | null = null;
    for (const { i } of outermost) {
      const rest = kept.filter((_, j) => j !== i);
      const f = evaluate(
        { N, M, P: rest.length, pieces: rest, container_phi: fit.container!.phi },
        { autoOrient: true },
      );
      if (f.container && (!best || f.container.size < best.fit.container!.size)) best = { rest, fit: f };
    }
    kept = best!.rest;
    fit = best!.fit;
  }
  return { pieces: kept, container_phi: fit.container!.phi, score: fit.container!.size };
}

/**
 * The other direction, for pieces that tile a strip along a container side: a container one unit
 * larger holds the old packing in a corner plus a strip of new pieces. [CALC]
 *  - squares in a square of side s: side s + 1 adds a row of floor(s) + 1 and a column of
 *    floor(s) squares along two adjacent sides, P + 2 floor(s) + 1 in all;
 *  - triangles in a triangle of side s: side s + 1, the old triangle at one corner, adds a strip
 *    of height sqrt(3)/2 along the opposite side, holding floor(s) + 1 upright and floor(s)
 *    inverted triangles, again P + 2 floor(s) + 1.
 * The new pieces lie outside the old container and inside the new one, touching at most along
 * edges, so the result is valid whenever the input is. Returns null for other pairs.
 */
/** The pairs growByStrip handles: squares in a square, triangles in a triangle. */
export const stripsFit = (N: number, M: number) => (N === 4 && M === 4) || (N === 3 && M === 3);

export function growByStrip(
  N: number,
  M: number,
  pieces: readonly Pose[],
  phi: number,
): { pieces: Pose[]; container_phi: number; score: number } | null {
  if (!stripsFit(N, M)) return null;
  const fit = evaluate({ N, M, P: pieces.length, pieces: [...pieces], container_phi: phi }, { autoOrient: true });
  if (!fit.valid || !fit.container) return null;
  const c = fit.container;
  const v = containerVertices(c);
  const s = c.size;
  const k = Math.floor(s + 1e-9);
  const added: Pose[] = [];
  if (N === 4) {
    // frame at corner V0 with axes along the two sides that meet there
    const [ox, oy] = [v[0], v[1]];
    const u = [(v[2] - ox) / s, (v[3] - oy) / s];
    const w = [(v[6] - ox) / s, (v[7] - oy) / s];
    const at = (a: number, b: number) => ({ x: ox + a * u[0] + b * w[0], y: oy + a * u[1] + b * w[1] });
    const theta = Math.PI / 4 + Math.atan2(u[1], u[0]);
    for (let i = 0; i <= k; i++) added.push({ ...at(i + 0.5, s + 0.5), theta });
    for (let j = 0; j < k; j++) added.push({ ...at(s + 0.5, j + 0.5), theta });
  } else {
    // the strip goes along side V0V1, away from V2; the new triangle is the old one scaled about V2
    const [ax, ay, bx, by, tx, ty] = [v[0], v[1], v[2], v[3], v[4], v[5]];
    const grow = (s + 1) / s;
    const ox = tx + (ax - tx) * grow;
    const oy = ty + (ay - ty) * grow;
    const u = [(bx - ax) / s, (by - ay) / s];
    // unit normal from the side towards V2
    let n = [-u[1], u[0]];
    if ((tx - ax) * n[0] + (ty - ay) * n[1] < 0) n = [-n[0], -n[1]];
    const h = Math.sqrt(3) / 2;
    const at = (a: number, b: number) => ({ x: ox + a * u[0] + b * n[0], y: oy + a * u[1] + b * n[1] });
    // an unrotated triangle points a vertex up: theta turns that vertex towards n
    const up = Math.atan2(n[1], n[0]) - Math.PI / 2;
    for (let i = 0; i <= k; i++) added.push({ ...at(i + 0.5, h / 3), theta: up });
    for (let j = 0; j < k; j++) added.push({ ...at(j + 1, (2 * h) / 3), theta: up + Math.PI });
  }
  const all = [...pieces.map((p) => ({ ...p })), ...added];
  const e = evaluate({ N, M, P: all.length, pieces: all, container_phi: c.phi }, { autoOrient: true });
  if (!e.valid || !e.container) return null;
  return { pieces: all, container_phi: e.container.phi, score: e.container.size };
}
