import { boundingRadius, pieceSeparation, MAX_COORD, type PackingConfig } from "@polypack/geometry";
import { nearbyPairs } from "./objective";

/** Unit pieces on a loose jittered grid; only the context's seeded stream is used. */
export function scatter(problem: { N: number; M: number; P: number }, random: () => number): PackingConfig {
  const width = Math.ceil(Math.sqrt(problem.P));
  const spacing = 2.4 * boundingRadius(problem.N);
  return {
    ...problem,
    container_phi: 0,
    pieces: Array.from({ length: problem.P }, (_, i) => ({
      x: spacing * ((i % width) - (width - 1) / 2 + 0.15 * (random() - 0.5)),
      y: spacing * (Math.floor(i / width) - (Math.ceil(problem.P / width) - 1) / 2 + 0.15 * (random() - 0.5)),
      theta: problem.N === 0 ? 0 : 2 * Math.PI * random(),
    })),
  };
}

/** Restore only pair separation; the framework computes the true enclosing container. */
export function restore(
  input: PackingConfig,
  strategy: "separate" | "expand",
  stopped: () => boolean,
  random?: () => number,
  coordinateLimit = MAX_COORD,
): PackingConfig | undefined {
  if (!input.pieces.every((p) => [p.x, p.y, p.theta].every((v) => Number.isFinite(v)))) return undefined;
  const config = { ...input, pieces: input.pieces.map((p) => ({ ...p })) };
  const reach = 2 * boundingRadius(input.N);
  const accepted = () =>
    config.pieces.every(
      (p) =>
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        Math.abs(p.x) <= coordinateLimit &&
        Math.abs(p.y) <= coordinateLimit,
    );
  if (random) {
    // Expansion cannot separate coincident rays. Give each unresolved pair a
    // seeded direction and a bounding-circle separating move before either repair.
    for (const [i, j] of nearbyPairs(config.pieces, reach, stopped)) {
      if (stopped()) return undefined;
      if (Math.hypot(config.pieces[i].x - config.pieces[j].x, config.pieces[i].y - config.pieces[j].y) >= 1e-8 * reach)
        continue;
      const angle = 2 * Math.PI * random();
      const dx = (reach / 2 + 2e-12) * Math.cos(angle);
      const dy = (reach / 2 + 2e-12) * Math.sin(angle);
      config.pieces[i].x += dx;
      config.pieces[i].y += dy;
      config.pieces[j].x -= dx;
      config.pieces[j].y -= dy;
    }
  }
  if (strategy === "separate") {
    for (let sweep = 0; sweep < 48; sweep++) {
      if (stopped()) return undefined;
      let moved = false;
      for (const [i, j] of nearbyPairs(config.pieces, reach, stopped)) {
        if (stopped()) return undefined;
        const c = pieceSeparation(input.N, config.pieces[i], config.pieces[j]);
        if (c.sep >= 0) continue;
        const delta = (-c.sep + 2e-12) / 2;
        let nx = c.nx;
        let ny = c.ny;
        // Coincident centres have no geometric separating direction. A seeded
        // direction avoids restoring a whole coincident cluster to an exact row.
        if (
          random &&
          Math.hypot(config.pieces[i].x - config.pieces[j].x, config.pieces[i].y - config.pieces[j].y) < 1e-8 * reach
        ) {
          const angle = 2 * Math.PI * random();
          nx = Math.cos(angle);
          ny = Math.sin(angle);
        }
        config.pieces[i].x += delta * nx;
        config.pieces[i].y += delta * ny;
        config.pieces[j].x -= delta * nx;
        config.pieces[j].y -= delta * ny;
        moved = true;
      }
      if (!moved) return accepted() ? config : undefined;
    }
  }
  const cx = config.pieces.reduce((s, p) => s + p.x, 0) / config.P;
  const cy = config.pieces.reduce((s, p) => s + p.y, 0) / config.P;
  const base = config.pieces.map((p) => ({ ...p }));
  const feasible = (factor: number): boolean => {
    for (let i = 0; i < config.P; i++) {
      config.pieces[i].x = cx + factor * (base[i].x - cx);
      config.pieces[i].y = cy + factor * (base[i].y - cy);
    }
    if (!accepted()) return false;
    for (const [i, j] of nearbyPairs(config.pieces, reach, stopped)) {
      if (stopped() || pieceSeparation(input.N, config.pieces[i], config.pieces[j]).sep < 0) return false;
    }
    return !stopped();
  };
  if (feasible(1)) return accepted() ? config : undefined;
  let low = 1;
  let high = 1.001;
  for (let k = 0; k < 40 && !feasible(high); k++) {
    if (stopped()) return undefined;
    if (!accepted()) return undefined;
    low = high;
    high *= 2;
  }
  if (!feasible(high)) return undefined;
  // Along each fixed centre ray, the separating half-spaces are monotone in scale.
  for (let k = 0; k < 44; k++) {
    if (stopped()) return undefined;
    const mid = (low + high) / 2;
    if (feasible(mid)) high = mid;
    else low = mid;
  }
  return feasible(high * (1 + 2e-12)) && accepted() ? config : undefined;
}
