import {
  boundingRadius,
  circumradius,
  convexHull,
  encloseSet,
  extremePoints,
  inradius,
  pairPenetration,
  polygonSeparation,
  visitContainerProtrusions,
  type Container,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";

export interface MorphShape {
  scale: number;
  padding: number;
  /** Only square superellipse stages have a finite exponent. */
  p?: number;
  vertices: number;
}

export function roundedShape(N: number, t: number, family: "inscribed" | "circumscribed"): MorphShape {
  return {
    scale: N === 0 ? 1 : t,
    padding: N === 0 ? 0 : (1 - t) * (family === "inscribed" ? inradius(N) : circumradius(N)),
    vertices: 64,
  };
}

/** Uniform polar angles. The boundary speed is <=1 for every p>=2, hence Hausdorff error <=pi/K. */
export function superellipseError(vertices: number): number {
  return Math.PI / vertices;
}

export function superellipseVertices(pose: Pose, p: number, count: number): Float64Array {
  const out = new Float64Array(2 * count);
  // Unit square axes are theta+pi/4 under the repository's vertex-up convention.
  const angle = pose.theta + Math.PI / 4;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let k = 0; k < count; k++) {
    const a = (2 * Math.PI * k) / count;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const radius = 0.5 / (Math.abs(ux) ** p + Math.abs(uy) ** p) ** (1 / p);
    const x = radius * ux;
    const y = radius * uy;
    out[2 * k] = pose.x + c * x - s * y;
    out[2 * k + 1] = pose.y + s * x + c * y;
  }
  return out;
}

export function shapeSeparation(N: number, a: Pose, b: Pose, shape: MorphShape): number {
  if (shape.p !== undefined) {
    return polygonSeparation(
      superellipseVertices(a, shape.p, shape.vertices),
      superellipseVertices(b, shape.p, shape.vertices),
    ).sep;
  }
  return -pairPenetration(N, a, b, undefined, undefined, shape.scale, shape.padding).depth;
}

export function shapeEnclose(config: PackingConfig, shape: MorphShape): Container {
  let set;
  if (shape.p !== undefined) {
    const all = new Float64Array(2 * shape.vertices * config.P);
    config.pieces.forEach((pose, i) =>
      all.set(superellipseVertices(pose, shape.p!, shape.vertices), 2 * shape.vertices * i),
    );
    set = { pts: convexHull(all), pad: 0 };
  } else {
    // The geometry package handles a collapsed polygon hull and circle padding.
    set = extremePoints(config.N, config.pieces, shape.scale);
    set.pad += shape.padding;
  }
  const container = encloseSet(set, config.M, config.container_phi);
  const wallScale = config.M === 0 ? 1 : inradius(config.M);
  return { ...container, size: container.size + (2e-12 * Math.max(1, container.size)) / wallScale };
}

export function shapeContained(N: number, pose: Pose, container: Container, shape: MorphShape): boolean {
  let valid = true;
  if (shape.p === undefined) {
    visitContainerProtrusions(
      N,
      pose,
      container,
      (depth) => {
        if (!Number.isFinite(depth) || depth > 0) valid = false;
      },
      true,
      undefined,
      undefined,
      shape.scale,
      shape.padding,
    );
    return valid;
  }
  const points = superellipseVertices(pose, shape.p, shape.vertices);
  for (let k = 0; k < points.length; k += 2) {
    const dx = points[k] - container.cx;
    const dy = points[k + 1] - container.cy;
    if (container.M === 0) {
      if (Math.hypot(dx, dy) > container.size) return false;
    } else {
      for (let edge = 0; edge < container.M; edge++) {
        const a = container.phi - Math.PI / 2 + (2 * Math.PI * edge) / container.M;
        if (dx * Math.cos(a) + dy * Math.sin(a) > container.size * inradius(container.M)) return false;
      }
    }
  }
  return true;
}

export async function shapeClear(
  config: PackingConfig,
  shape: MorphShape,
  stopped: () => boolean,
  checkpoint: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  const reach = shape.p === undefined ? 2 * (boundingRadius(config.N) * shape.scale + shape.padding) : Math.SQRT2;
  for (let i = 0; i < config.P; i++) {
    if (stopped()) return false;
    for (let j = 0; j < i; j++) {
      if (stopped() || (j % 32 === 0 && !(await checkpoint()))) return false;
      const a = config.pieces[i];
      const b = config.pieces[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) > reach) continue;
      if (shapeSeparation(config.N, a, b, shape) < 0) return false;
    }
  }
  return true;
}

export function dilate(config: PackingConfig, factor: number): PackingConfig {
  const cx = config.pieces.reduce((sum, p) => sum + p.x, 0) / config.P;
  const cy = config.pieces.reduce((sum, p) => sum + p.y, 0) / config.P;
  return {
    ...config,
    pieces: config.pieces.map((pose) => ({ ...pose, x: cx + factor * (pose.x - cx), y: cy + factor * (pose.y - cy) })),
  };
}

/** Homothetic feasibility is monotone: the convex Minkowski difference contains zero. */
export async function rescale(
  config: PackingConfig,
  shape: MorphShape,
  stopped: () => boolean,
  checkpoint: () => Promise<boolean> = async () => true,
): Promise<PackingConfig | undefined> {
  let low = 0;
  let high = 1;
  while (!(await shapeClear(dilate(config, high), shape, stopped, checkpoint))) {
    if (stopped() || high > 1e6) return undefined;
    low = high;
    high *= 2;
  }
  for (let k = 0; k < 40; k++) {
    if (stopped()) return undefined;
    const mid = (low + high) / 2;
    if (await shapeClear(dilate(config, mid), shape, stopped, checkpoint)) high = mid;
    else low = mid;
  }
  const result = dilate(config, high * (1 + 2e-12));
  return (await shapeClear(result, shape, stopped, checkpoint)) ? result : undefined;
}
