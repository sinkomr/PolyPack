import {
  boundingRadius,
  containerProtrusions,
  enclose,
  pieceInradius,
  MAX_COORD,
  pieceSeparation,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import { copy, type Random } from "./operators";

/**
 * Layer peel: empty the outermost layer of pieces along one container wall normal,
 * moving each of its pieces into a free lattice-adjacent site further inside.
 *
 * Near-lattice packings of P just above a perfect square (the (k+1)-grid holding
 * k^2+1 squares) have their spare room as scattered single-cell holes, and an exact
 * piece-sized hole has zero area in centre space: the random reinsertion sampler
 * cannot hit it. Here the candidate sites are the edge-reflected neighbours of
 * every remaining piece (centre at twice the inradius along an edge normal, the
 * reflected orientation; six unit-distance-two neighbours for circles), which
 * include every lattice hole. Sites must lie at least one layer inward of the
 * peeled layer, inside the current enclosure up to 1e-9 and clear of placed pieces
 * and of the layer pieces still to be moved, up to 1e-9 (the local solve's strict
 * restoration removes such contact noise).
 * Peeled pieces are placed in random order at a uniformly chosen valid site; a
 * piece without one keeps its pose. Repeated peels consolidate holes into whole
 * empty rows or columns, after which the local solve can shrink or tilt.
 */
export function* peelLayer(
  config: PackingConfig,
  random: Random,
  stopped: () => boolean = () => false,
): Generator<void, PackingConfig> {
  const result = copy(config);
  if (config.P < 2) return result;
  const N = config.N;
  const container = enclose(N, config.pieces, config.M, config.container_phi ?? 0);
  const direction =
    config.M === 0
      ? 2 * Math.PI * random()
      : container.phi - Math.PI / 2 + (2 * Math.PI * Math.floor(random() * config.M)) / config.M;
  const nx = Math.cos(direction);
  const ny = Math.sin(direction);
  const depth = (x: number, y: number) => (x - container.cx) * nx + (y - container.cy) * ny;
  const half = pieceInradius(N);
  const outer = Math.max(...config.pieces.map((p) => depth(p.x, p.y)));
  const layer = config.pieces.flatMap((p, i) => (depth(p.x, p.y) > outer - half ? [i] : []));
  if (layer.length === config.P) return result;
  const inLayer = new Set(layer);
  const placed = config.pieces.filter((_, i) => !inLayer.has(i)).map((p) => ({ ...p }));
  const reach = 2 * boundingRadius(N);
  const sides = N === 0 ? 6 : N;
  const flip = N % 2 === 1 ? Math.PI / N : 0;
  let work = 0;
  // Fisher-Yates order of the layer, from the seeded stream.
  for (let k = layer.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1));
    [layer[k], layer[j]] = [layer[j], layer[k]];
  }
  // Layer pieces not yet moved still occupy their poses: for shapes whose layer is
  // thinner than a whole cell (any N but squares), an inner site can touch them.
  const pending = new Set(layer);
  for (const index of layer) {
    pending.delete(index);
    const blockers = [...placed, ...[...pending].map((i) => config.pieces[i])];
    const sites: Pose[] = [];
    for (const q of placed) {
      for (let e = 0; e < sides; e++) {
        if (work++ % 256 === 0) yield;
        if (stopped()) return result;
        const normal = N === 0 ? (Math.PI * e) / 3 : q.theta + Math.PI / 2 + Math.PI / N + (2 * Math.PI * e) / N;
        const pose = {
          x: q.x + 2 * half * Math.cos(normal),
          y: q.y + 2 * half * Math.sin(normal),
          theta: N === 0 ? 0 : (q.theta + flip) % (2 * Math.PI),
        };
        if (depth(pose.x, pose.y) > outer - 2 * half + 1e-9) continue;
        if (Math.abs(pose.x) > MAX_COORD || Math.abs(pose.y) > MAX_COORD) continue;
        if (containerProtrusions(N, pose, container).some((c) => c.depth > 1e-9)) continue;
        let free = true;
        for (const other of blockers) {
          const dx = other.x - pose.x;
          const dy = other.y - pose.y;
          if (dx * dx + dy * dy >= reach * reach) continue;
          if (pieceSeparation(N, pose, other).sep < -1e-9) {
            free = false;
            break;
          }
        }
        // Different neighbours can name the same hole; duplicates only reweight the draw.
        if (free) sites.push(pose);
      }
    }
    if (!sites.length) {
      placed.push({ ...config.pieces[index] });
      continue;
    }
    const site = sites[Math.floor(random() * sites.length)];
    result.pieces[index] = site;
    placed.push(site);
  }
  return result;
}

export async function peelLayerCooperative(
  config: PackingConfig,
  random: Random,
  checkpoint: () => Promise<boolean>,
  stopped: () => boolean,
): Promise<PackingConfig> {
  const sampler = peelLayer(config, random, stopped);
  let next = sampler.next();
  while (!next.done) {
    if (!(await checkpoint())) return copy(config);
    next = sampler.next();
  }
  return next.value;
}

/**
 * Cross cleave: move one piece into a cross-shaped gap opened at a piece vertex,
 * turned by half a piece symmetry period.
 *
 * Two distinct container wall normals u1, u2 are drawn (a random direction and its
 * perpendicular for circle containers). Every other piece on the positive side of
 * the vertex X along u_i is translated by delta*u_i, with delta uniform in
 * [0.75, 1.25] piece circumradii. The piece whose removal shrinks the enclosure
 * most (ties broken at random) is placed at the gap centre X + delta(u1+u2)/2, with
 * the orientation of the vertex's owner plus pi/N. For k^2+1 squares packed as a
 * k-by-k block plus one protruding square, X at the block centre, perpendicular
 * normals and delta >= 1/sqrt(2), this is the valid k + delta arrangement of four
 * corner blocks around a 45-degree square. In general it is a large structured kick
 * that the local solve then compresses. The enclosure-after-removal ranking costs
 * P analytic enclosures and no assessments.
 */
export function crossCleave(config: PackingConfig, random: Random): PackingConfig {
  const result = copy(config);
  if (config.P < 3) return result;
  const N = config.N;
  const container = enclose(N, config.pieces, config.M, config.container_phi ?? 0);
  const normal = (j: number) => container.phi - Math.PI / 2 + (2 * Math.PI * j) / config.M;
  let a1: number;
  let a2: number;
  if (config.M === 0) {
    a1 = 2 * Math.PI * random();
    a2 = a1 + (random() < 0.5 ? 1 : -1) * (Math.PI / 2);
  } else {
    const j1 = Math.floor(random() * config.M);
    const j2 = (j1 + 1 + Math.floor(random() * (config.M - 1))) % config.M;
    a1 = normal(j1);
    a2 = normal(j2);
  }
  const u1 = [Math.cos(a1), Math.sin(a1)];
  const u2 = [Math.cos(a2), Math.sin(a2)];
  // Antiparallel walls would push both halves apart along one axis: still a valid
  // (single-gap) cleave, so it is kept rather than redrawn.
  // The moved piece is one whose removal shrinks the fixed-angle enclosure most:
  // analytic enclosures only, no assessments. Ties (every piece of a full grid)
  // are broken uniformly.
  const sizes = config.pieces.map(
    (_, i) =>
      enclose(
        N,
        config.pieces.filter((_, j) => j !== i),
        config.M,
        container.phi,
      ).size,
  );
  const smallest = Math.min(...sizes);
  const tied = sizes.flatMap((size, i) => (size <= smallest + 1e-9 ? [i] : []));
  const moved = tied[Math.floor(random() * tied.length)];
  const others = config.pieces.flatMap((_, i) => (i === moved ? [] : [i]));
  const owner = config.pieces[others[Math.floor(random() * others.length)]];
  const corner =
    N === 0 ? Math.PI * 2 * random() : owner.theta + Math.PI / 2 + (2 * Math.PI * Math.floor(random() * N)) / N;
  const reach = boundingRadius(N);
  const X = { x: owner.x + reach * Math.cos(corner), y: owner.y + reach * Math.sin(corner) };
  const delta = reach * (0.75 + 0.5 * random());
  for (const i of others) {
    const p = result.pieces[i];
    const dx = p.x - X.x;
    const dy = p.y - X.y;
    if (dx * u1[0] + dy * u1[1] > 0) {
      p.x += delta * u1[0];
      p.y += delta * u1[1];
    }
    if (dx * u2[0] + dy * u2[1] > 0) {
      p.x += delta * u2[0];
      p.y += delta * u2[1];
    }
  }
  // The gap is centred half a push beyond X along both directions.
  result.pieces[moved] = {
    x: X.x + (delta / 2) * (u1[0] + u2[0]),
    y: X.y + (delta / 2) * (u1[1] + u2[1]),
    theta: N === 0 ? 0 : (owner.theta + Math.PI / N) % (2 * Math.PI),
  };
  if (result.pieces.some((p) => Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD)) return copy(config);
  return result;
}
