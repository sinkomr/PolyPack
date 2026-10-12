import {
  autoOrient,
  boundingRadius,
  containerProtrusions,
  defaultTheta,
  enclose,
  findOverlaps,
  TOL,
  MAX_COORD,
  pieceSeparation,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";

import { restore } from "../penalty/restoration";

export type Random = () => number;
export const operatorNames = ["kick", "swap", "cluster", "reinsert", "restart"] as const;
export type Operator = (typeof operatorNames)[number];

const angle = (theta: number): number => theta % (2 * Math.PI);
const bounded = (value: number): number => Math.max(-MAX_COORD, Math.min(MAX_COORD, value));
export const copy = (config: PackingConfig): PackingConfig => ({
  ...config,
  pieces: config.pieces.map((p) => ({ ...p })),
});

/** Sample without replacement, guaranteeing a nonempty subset even for a tiny fraction. */
export function randomKick(
  config: PackingConfig,
  random: Random,
  magnitude: number,
  fraction: number,
  rotation: number,
): PackingConfig {
  const result = copy(config);
  const ids = config.pieces.map((_, i) => i);
  const count = Math.max(1, Math.ceil(fraction * ids.length));
  for (let k = 0; k < count; k++) {
    const j = k + Math.floor(random() * (ids.length - k));
    [ids[k], ids[j]] = [ids[j], ids[k]];
    const p = result.pieces[ids[k]];
    p.x = bounded(p.x + magnitude * (2 * random() - 1));
    p.y = bounded(p.y + magnitude * (2 * random() - 1));
    p.theta = config.N === 0 ? 0 : angle(angle(p.theta) + rotation * (2 * random() - 1));
  }
  return result;
}

/** Congruent positions are indistinguishable; exchange angles, not whole poses. */
export function swapOrientations(config: PackingConfig, random: Random): PackingConfig {
  const result = copy(config);
  if (config.P < 2 || config.N === 0) return result;
  const pairs: [number, number][] = [];
  for (let i = 0; i < config.P; i++) {
    for (let j = i + 1; j < config.P; j++) {
      if (Math.abs(Math.sin((config.N * (config.pieces[i].theta - config.pieces[j].theta)) / 2)) > 1e-9)
        pairs.push([i, j]);
    }
  }
  if (!pairs.length) return result;
  const [i, j] = pairs[Math.floor(random() * pairs.length)];
  [result.pieces[i].theta, result.pieces[j].theta] = [result.pieces[j].theta, result.pieces[i].theta];
  return result;
}

export function clusterMembers(config: PackingConfig, pivot: number, radius: number): number[] {
  const p = config.pieces[pivot];
  const reach = radius * 2 * boundingRadius(config.N);
  return config.pieces.flatMap((q, i) => (Math.hypot(q.x - p.x, q.y - p.y) <= reach ? [i] : []));
}

export function rotateCluster(config: PackingConfig, random: Random, radius: number, rotation: number): PackingConfig {
  const result = copy(config);
  const ids = clusterMembers(config, Math.floor(random() * config.P), radius);
  if (ids.length < 2) return result;
  const cx = ids.reduce((sum, i) => sum + config.pieces[i].x, 0) / ids.length;
  const cy = ids.reduce((sum, i) => sum + config.pieces[i].y, 0) / ids.length;
  const turn = rotation * (2 * random() - 1);
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const moved = ids.map((i) => {
    const p = config.pieces[i];
    const dx = p.x - cx;
    const dy = p.y - cy;
    return {
      x: cx + c * dx - s * dy,
      y: cy + s * dx + c * dy,
      theta: config.N === 0 ? 0 : angle(angle(p.theta) + turn),
    };
  });
  // Reject the entire rigid move at the coordinate boundary: clipping individual
  // centres would destroy the pair-distance invariant of a cluster rotation.
  if (moved.some((p) => Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD)) return result;
  ids.forEach((i, k) => {
    result.pieces[i] = moved[k];
  });
  return result;
}

/** First minimum wins ties. Runtime selection uses counted ctx.evaluate calls instead. */
export function worstPiece(config: PackingConfig): number {
  if (config.P === 1) return 0;
  let best = Infinity;
  let removed = 0;
  for (let i = 0; i < config.P; i++) {
    const remaining = config.pieces.filter((_, j) => i !== j);
    const size = autoOrient(config.N, remaining, config.M, config.container_phi).size;
    if (size < best) {
      best = size;
      removed = i;
    }
  }
  return removed;
}

/** Test fitting angles inside the existing enclosure; prefer compactness, then clearance. */
function* reinsertion(
  config: PackingConfig,
  removed: number,
  random: Random,
  trials: number,
  stopped: () => boolean = () => false,
): Generator<void, PackingConfig> {
  const result = copy(config);
  const fixed = config.pieces.filter((_, i) => i !== removed);
  if (!fixed.length) {
    result.pieces[removed].theta = config.N === 0 ? 0 : 2 * Math.PI * random();
    return result;
  }
  const container = enclose(config.N, config.pieces, config.M, config.container_phi);
  const reach = config.M === 0 ? container.size : container.size / (2 * Math.sin(Math.PI / config.M));
  const loX = bounded(container.cx - reach);
  const hiX = bounded(container.cx + reach);
  const loY = bounded(container.cy - reach);
  const hiY = bounded(container.cy + reach);
  let best: { pose: Pose; clearance: number; size: number } | undefined;
  let scanned = 0;
  for (let t = 0; t < trials; t++) {
    if (t % 4 === 0) yield;
    if (stopped()) return result;
    // Exact-sized holes have zero area in centre space: random samples alone
    // cannot find them. Always include the centre and removed centre as anchors.
    const x = bounded(t === 0 ? container.cx : t === 1 ? config.pieces[removed].x : loX + (hiX - loX) * random());
    const y = bounded(t === 0 ? container.cy : t === 1 ? config.pieces[removed].y : loY + (hiY - loY) * random());
    const angles = [config.N === 0 ? 0 : 2 * Math.PI * random()];
    if (config.N !== 0) {
      const neighbours = [...fixed].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
      angles.push(...neighbours.slice(0, 4).flatMap((p) => [p.theta, p.theta + Math.PI / config.N]));
      for (let j = 0; j < Math.min(config.M, 8); j++)
        angles.push(container.phi + defaultTheta(config.N) + (2 * Math.PI * j) / config.M);
    }
    const unique: number[] = [];
    for (const theta of angles) {
      if (unique.some((a) => config.N === 0 || Math.abs(Math.sin((config.N * (theta - a)) / 2)) < 1e-9)) continue;
      unique.push(theta);
      const pose = { x, y, theta: angle(theta) };
      if (containerProtrusions(config.N, pose, container).some((p) => p.depth > 1e-12)) continue;
      let clearance = Infinity;
      for (const p of fixed) {
        if (scanned++ % 256 === 0) yield;
        if (stopped()) return result;
        clearance = Math.min(clearance, pieceSeparation(config.N, pose, p).sep);
        if (clearance < 0) break;
      }
      if (clearance < 0) continue;
      const pieces = config.pieces.map((p, i) => (i === removed ? pose : p));
      const size = enclose(config.N, pieces, config.M, container.phi).size;
      if (!best || size < best.size - 1e-12 || (Math.abs(size - best.size) <= 1e-12 && clearance > best.clearance))
        best = { pose, clearance, size };
    }
  }
  if (best) result.pieces[removed] = best.pose;
  return result;
}

/** Piece symmetry matters: exchanging equivalent angles is still an exact no-op. */
export function samePacking(a: PackingConfig, b: PackingConfig): boolean {
  return a.pieces.every((p, i) => {
    const q = b.pieces[i];
    return (
      Math.abs(p.x - q.x) < 1e-12 &&
      Math.abs(p.y - q.y) < 1e-12 &&
      (a.N === 0 || Math.abs(Math.sin((a.N * (p.theta - q.theta)) / 2)) < 1e-9)
    );
  });
}

/** Synchronous pure helper; the method uses the identical cooperatively stepped sampler. */
export function reinsertPiece(
  config: PackingConfig,
  removed: number,
  random: Random,
  trials: number,
  stopped: () => boolean = () => false,
): PackingConfig {
  const sampler = reinsertion(config, removed, random, trials, stopped);
  let next = sampler.next();
  while (!next.done) next = sampler.next();
  return next.value;
}

export async function reinsertPieceCooperative(
  config: PackingConfig,
  removed: number,
  random: Random,
  trials: number,
  checkpoint: () => Promise<boolean>,
  stopped: () => boolean,
): Promise<PackingConfig> {
  const sampler = reinsertion(config, removed, random, trials, stopped);
  let next = sampler.next();
  while (!next.done) {
    if (!(await checkpoint())) return copy(config);
    next = sampler.next();
  }
  return next.value;
}

export function globalRestart(
  config: PackingConfig,
  seeds: readonly PackingConfig[],
  random: Random,
  magnitude: number,
  rotation: number,
): PackingConfig {
  const matching = seeds.filter(
    (s) => s.N === config.N && s.M === config.M && s.P === config.P && s.pieces.length === config.P,
  );
  const seed = matching.length ? matching[Math.floor(random() * matching.length)] : config;
  return randomKick(seed, random, magnitude, 1, rotation);
}

/** Remove large absolute offsets without leaving the schema's coordinate box. */
export function centerLocalStart(config: PackingConfig): PackingConfig {
  const anchor = config.pieces[0];
  let cx = anchor.x + config.pieces.reduce((sum, p) => sum + (p.x - anchor.x), 0) / config.P;
  let cy = anchor.y + config.pieces.reduce((sum, p) => sum + (p.y - anchor.y), 0) / config.P;
  // Close-to-origin inputs retain their bits. At large offsets the penalty
  // method's translation back can erase its much smaller separation margin.
  if (Math.abs(cx) <= 32 && Math.abs(cy) <= 32) return config;
  if (config.pieces.some((p) => Math.abs(p.x - cx) > MAX_COORD || Math.abs(p.y - cy) > MAX_COORD)) {
    const xs = config.pieces.map((p) => p.x);
    const ys = config.pieces.map((p) => p.y);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  }
  return { ...config, pieces: config.pieces.map((p) => ({ ...p, x: p.x - cx, y: p.y - cy })) };
}

/** A child start is assessed before repair. Close that tolerance-band shortcut. */
export function strictLocalStart(
  config: PackingConfig,
  random: Random,
  stopped: () => boolean,
): PackingConfig | undefined {
  const overlaps = findOverlaps(config.N, config.pieces, 1e-12);
  if (overlaps.length && overlaps.every((c) => c.sep >= -TOL)) {
    return restore(config, "separate", stopped, random);
  }
  return config;
}
