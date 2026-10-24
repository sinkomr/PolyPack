/**
 * The fold search of packages/surface (src/search/search.ts, searchProblem), step for step, from
 * its own parts: compress every start (penalty compression on the unit solid with the scale as a
 * variable for polygons, geometric growth for disks), basin-hop from the best, then the final
 * tightening and the contact-LP polish, and the float check (validateFold, tolerance 1e-10).
 *
 * One change for the volunteer client: searchProblem's final stage has no stop check, and on 80
 * pieces it can take minutes. Here it stops on `finalStop` (the job's abort, or a time allowance:
 * spaces/run.ts gives the search four fifths of the job's time and the final stage the rest and
 * SURFACE_FINAL_OVERRUN s more), which the contact-LP polish also polls inside its iterations. A
 * polish cut short returns its last accepted, valid packing; a tightening cut short is checked
 * like any other result and dropped when it is not valid, and the job then keeps its start.
 *
 * Imported by path: the package's index does not export its search.
 */
import { validateFold } from "@polypack/surface";
import type { Solid, SurfacePose } from "@polypack/surface";
import { Packing, compress, compressPenalty } from "../../../../packages/surface/src/search/optimize";
import { type Start, areaScale, mulberry32, randomPose } from "../../../../packages/surface/src/search/search";
import { slpPolish } from "../../../../packages/surface/src/search/slp";

/** searchProblem's perturbation: re-place or shift one to three pieces, sometimes jiggle them all. */
function perturb(solid: Solid, poses: SurfacePose[], rand: () => number, lam: number): SurfacePose[] {
  const out = poses.map((p) => ({ ...p }));
  const kind = rand();
  const k = 1 + Math.floor(rand() * Math.min(3, out.length));
  for (let t = 0; t < k; t++) {
    const i = Math.floor(rand() * out.length);
    if (kind < 0.35) out[i] = randomPose(solid, rand);
    else {
      const r = (0.15 + 0.5 * rand()) * lam;
      const a = 2 * Math.PI * rand();
      out[i] = {
        ...out[i],
        x: out[i].x + r * Math.cos(a),
        y: out[i].y + r * Math.sin(a),
        theta: out[i].theta + (rand() - 0.5) * 1.5,
      };
    }
  }
  if (kind > 0.85) {
    for (const p of out) {
      p.x += (rand() - 0.5) * 0.05 * lam;
      p.y += (rand() - 0.5) * 0.05 * lam;
      p.theta += (rand() - 0.5) * 0.1;
    }
  }
  return out;
}

function runCompress(pk: Packing, N: number, lam0: number, stop: () => boolean) {
  return N === 0
    ? compress(pk, lam0, { shouldStop: stop })
    : compressPenalty(pk, lam0, { maxIter: 300, shouldStop: stop });
}

export interface FoldOptions {
  seed: number;
  randomStarts: number;
  hops: number;
  warm: Start[];
  /** Ends the starts and the hops. */
  stop: () => boolean;
  /** Ends the final stage. */
  finalStop: () => boolean;
}

/**
 * The best fold packing on the unit solid (pieces scaled by lam, so the edge is 1/lam), and the
 * number of compressions run; null when none produced a packing or the final check failed.
 */
export function surfaceFoldSearch(
  solid: Solid,
  N: number,
  P: number,
  o: FoldOptions,
): { lam: number; poses: SurfacePose[]; compressions: number } | null {
  const rand = mulberry32(o.seed);
  const la = areaScale(solid, N, P);
  let best: { lam: number; poses: SurfacePose[] } | null = null;
  let compressions = 0;
  const take = (lam: number, poses: SurfacePose[]) => {
    compressions++;
    if (!best || lam > best.lam) best = { lam, poses: poses.map((p) => ({ ...p })) };
  };
  const starts: Start[] = [...o.warm];
  for (let k = 0; k < o.randomStarts; k++)
    starts.push({
      label: `random#${k}`,
      lam: 0.55 * la,
      poses: Array.from({ length: P }, () => randomPose(solid, rand)),
    });
  for (const st of starts) {
    if (o.stop()) break;
    const pk = new Packing(solid, N, st.lam, st.poses);
    const r = runCompress(pk, N, st.lam, o.stop);
    if (r) take(r.lam, r.poses);
  }
  for (let h = 0; h < o.hops && best; h++) {
    if (o.stop()) break;
    const b: { lam: number; poses: SurfacePose[] } = best;
    const pk = new Packing(solid, N, b.lam * 0.97, perturb(solid, b.poses, rand, b.lam));
    const r = runCompress(pk, N, b.lam * 0.97, o.stop);
    if (r) take(r.lam, r.poses);
  }
  if (!best) return null;
  const fin: { lam: number; poses: SurfacePose[] } = best;
  // optimize.ts finalize, with the stop check: relax hard at a slightly smaller scale
  const pk = new Packing(solid, N, fin.lam, fin.poses);
  let f0 = { lam: fin.lam, poses: fin.poses };
  let l = fin.lam * (1 - 1e-10);
  for (let k = 0; k < 12 && !o.finalStop(); k++) {
    pk.setScale(l);
    pk.setPoses(fin.poses);
    const r = pk.relax(3000, 1e-28, 0.002, o.finalStop);
    if (r.energy <= 1e-26) {
      f0 = { lam: l, poses: pk.poses.map((p) => ({ ...p })) };
      break;
    }
    l *= 1 - 3e-10 * 3 ** k;
  }
  const pol = slpPolish(solid, N, f0.lam, f0.poses, { iterations: 120, shouldStop: o.finalStop });
  const f = pol.lam >= f0.lam ? pol : f0;
  const poses = f.poses.map((p) => ({ face: p.face, x: p.x / f.lam, y: p.y / f.lam, theta: p.theta }));
  const v = validateFold({ solid: solid.name, N, s: 1 / f.lam, pieces: poses }, { tol: 1e-10 });
  return v.ok ? { lam: f.lam, poses: f.poses, compressions } : null;
}
