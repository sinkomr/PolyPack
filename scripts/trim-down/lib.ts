import { Pose, evaluate } from "@polypack/geometry";

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
