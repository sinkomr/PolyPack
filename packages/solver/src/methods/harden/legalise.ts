// Legalisation of a hardening run: the reference scales centres apart about their mean until
// no true pieces overlap (engine2d.js `legalize`, after Yohei Nakajima,
// https://github.com/yoheinakajima/soft-to-rigid). This is the same homothety as morph's shared
// `rescale`, searched with the shared cell grid instead of an all-pairs scan so that one
// assessment stays cheap at P = 500, and with a checkpoint after every scan.
import { boundingRadius, pieceSeparation, type PackingConfig } from "@polypack/geometry";
import { dilate } from "../morph/shapes";
import { nearbyPairs } from "../penalty/objective";

/**
 * Homothety of the true-shape arrangement about its mean centre to first contact: the smallest
 * factor at which every pair has nonnegative separation, apart when pieces overlap and together
 * when none touch. Feasibility is monotone in the factor because each pair's separating
 * half-space is. Returns undefined when stopped or when no factor up to 1e6 separates the
 * pieces (coincident centres), which the caller hands to the seeded shared restoration.
 *
 * `tick` receives the counted work of each scan and returns false to stop.
 *
 * Precondition: coordinates of the order of the container size. The final 2e-12 margin is
 * relative to the factor, so it moves a pair apart by 2e-12 times its distance from the mean
 * centre and is lost in rounding when the whole arrangement sits far from the origin (around
 * 4.5e5 the result can fail its own check and be undefined). The method always calls this in
 * the moving container's frame, which `scatter` and `adopt` centre on the origin, and hands an
 * undefined result to the shared restoration in any case.
 */
export async function legalise(
  config: PackingConfig,
  stopped: () => boolean,
  tick: (work: number) => Promise<boolean> | boolean,
): Promise<PackingConfig | undefined> {
  const reach = 2 * boundingRadius(config.N);
  let scanned = 0;
  const clear = (candidate: PackingConfig): boolean => {
    const pairs = nearbyPairs(candidate.pieces, reach, stopped);
    scanned = 12 * config.P + pairs.length * Math.max(1, 2 * config.N);
    for (const [i, j] of pairs) {
      if (pieceSeparation(config.N, candidate.pieces[i], candidate.pieces[j]).sep < 0) return false;
    }
    return !stopped();
  };
  const test = async (factor: number): Promise<boolean | undefined> => {
    const free = clear(dilate(config, factor));
    return (await tick(scanned)) ? free : undefined;
  };
  let low = 0;
  let high = 1;
  for (;;) {
    const free = await test(high);
    if (free === undefined) return undefined;
    if (free) break;
    if (high > 1e6) return undefined;
    low = high;
    high *= 2;
  }
  for (let k = 0; k < 40; k++) {
    const middle = (low + high) / 2;
    const free = await test(middle);
    if (free === undefined) return undefined;
    if (free) high = middle;
    else low = middle;
  }
  // The same last-place margin as rescale and restore, so contact does not round into overlap.
  const result = dilate(config, high * (1 + 2e-12));
  const free = clear(result);
  return (await tick(scanned)) && free ? result : undefined;
}
