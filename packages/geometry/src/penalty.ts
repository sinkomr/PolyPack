import { Container, DISK_RADIUS, Pose, containerInradius, circumradius, inradius, pieceVertices } from "./shapes";

/** Selected SAT feature; edge starts at vertex `edge` on `edgePiece`. */
export interface PenetrationFeature {
  edgePiece: "a" | "b";
  edge: number;
  vertex: number;
}

export interface PairPenetration {
  /** Signed penetration: positive means overlap, negative means separation. */
  depth: number;
  a: Pose;
  b: Pose;
  feature?: PenetrationFeature;
}

export interface ContainerGradient {
  cx: number;
  cy: number;
  size: number;
  phi: number;
}

export interface Protrusion {
  /** Signed constraint: depth <= 0 means this feature is inside the container. */
  depth: number;
  pose: Pose;
  container: ContainerGradient;
  /** Polygon piece vertex, absent for circle pieces. */
  vertex?: number;
  /** Container edge ending at this vertex, absent for circle containers. */
  edge?: number;
}

/** Numeric derivative arguments avoid constructing a constraint object per call. */
export type ProtrusionVisitor = (
  depth: number,
  px: number,
  py: number,
  ptheta: number,
  cx: number,
  cy: number,
  size: number,
  phi: number,
  index: number,
  vertex?: number,
  edge?: number,
) => void;

/**
 * Cache the SAT edge axes for one orientation as [angle, cos, sin] triples.
 * The angle expression deliberately matches regularPolygonSeparation exactly:
 * changing its arithmetic or reducing angles modulo a turn can change tie
 * selection. Reuse a correctly sized output array to avoid allocation.
 */
export function penaltyEdgeNormals(N: number, theta: number, out?: Float64Array): Float64Array {
  const axes = out?.length === 3 * N ? out : new Float64Array(3 * N);
  const step = (2 * Math.PI) / N;
  for (let edge = 0; edge < N; edge++) {
    const angle = theta + Math.PI / 2 + Math.PI / N + edge * step;
    axes[3 * edge] = angle;
    axes[3 * edge + 1] = Math.cos(angle);
    axes[3 * edge + 2] = Math.sin(angle);
  }
  return axes;
}

/** Container wall axes as [angle, cos, sin] triples, in the enclosingPolygon order. */
export function penaltyContainerNormals(M: number, phi: number, out?: Float64Array): Float64Array {
  const axes = out?.length === 3 * M ? out : new Float64Array(3 * M);
  for (let edge = 0; edge < M; edge++) {
    const angle = phi - Math.PI / 2 + (2 * Math.PI * edge) / M;
    axes[3 * edge] = angle;
    axes[3 * edge + 1] = Math.cos(angle);
    axes[3 * edge + 2] = Math.sin(angle);
  }
  return axes;
}

/**
 * Negative of pieceSeparation, with analytic pose derivatives of the selected
 * SAT branch. Feature switches are non-smooth; at a tie this returns one branch
 * derivative, with the same axis order and strict comparison as the existing SAT.
 * Optional axis caches must be produced for the corresponding N and theta.
 * scale*P + padding*disc uses Euclidean closest features outside the polygon
 * difference and SAT inside it; scale=0 is an exact disk, not a degenerate SAT.
 */
export function pairPenetration(
  N: number,
  a: Pose,
  b: Pose,
  axesA?: Float64Array,
  axesB?: Float64Array,
  scale = 1,
  padding = 0,
): PairPenetration {
  if (N === 0 || scale === 0) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const distance = Math.hypot(dx, dy);
    // Coincident centres have no unique derivative. Choose a bounded subgradient
    // that separates the pair rather than leaving it stationary.
    const ux = distance === 0 ? 1 : dx / distance;
    const uy = distance === 0 ? 0 : dy / distance;
    return {
      depth: 2 * ((N === 0 ? scale * DISK_RADIUS : 0) + padding) - distance,
      a: { x: -ux, y: -uy, theta: 0 },
      b: { x: ux, y: uy, theta: 0 },
    };
  }

  const R = circumradius(N) * scale;
  const r = inradius(N) * scale;
  const step = (2 * Math.PI) / N;
  const cacheA = axesA && axesA.length >= 3 * N ? axesA : undefined;
  const cacheB = axesB && axesB.length >= 3 * N ? axesB : undefined;
  let best = -Infinity;
  let bestEdge = 0;
  let bestPass = 0;
  let bestRel = 0;
  let bestUx = 1;
  let bestUy = 0;
  let bestDx = 0;
  let bestDy = 0;
  for (let edge = 0; edge < N; edge++) {
    for (let pass = 0; pass < 2; pass++) {
      const p = pass === 0 ? a : b;
      const q = pass === 0 ? b : a;
      const axes = pass === 0 ? cacheA : cacheB;
      const angle = axes ? axes[3 * edge] : p.theta + Math.PI / 2 + Math.PI / N + edge * step;
      const ux = axes ? axes[3 * edge + 1] : Math.cos(angle);
      const uy = axes ? axes[3 * edge + 2] : Math.sin(angle);
      const rel = angle + Math.PI / 2 - q.theta;
      let delta = rel % step;
      if (delta < 0) delta += step;
      if (delta > step / 2) delta = step - delta;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const separation = dx * ux + dy * uy - r - R * Math.cos(delta);
      if (separation <= best) continue;
      best = separation;
      bestEdge = edge;
      bestPass = pass;
      bestRel = rel;
      bestUx = ux;
      bestUy = uy;
      bestDx = dx;
      bestDy = dy;
    }
  }
  // SAT is exact inside the Minkowski difference, but only a lower bound
  // outside it. Disk offsets need Euclidean closest features outside.
  if (padding > 0 && best > 0) {
    const closest = paddedClosestPair(N, a, b, scale, padding);
    if (closest) return closest;
  }
  const q = bestPass === 0 ? b : a;
  const nearest = Math.round(bestRel / step);
  const vertex = ((nearest % N) + N) % N;
  const vertexAngle = q.theta + Math.PI / 2 + vertex * step;
  const vx = R * Math.cos(vertexAngle);
  const vy = R * Math.sin(vertexAngle);
  // sep = (q - p + vertexOffset) . u - r. Rotation of the
  // edge contributes J*u, and rotation of the vertex contributes J*v.
  const dp = { x: bestUx, y: bestUy, theta: (bestDx + vx) * bestUy - (bestDy + vy) * bestUx };
  const dq = { x: -bestUx, y: -bestUy, theta: vy * bestUx - vx * bestUy };
  return {
    depth: padding === 0 ? -best : -best + 2 * padding,
    a: bestPass === 0 ? dp : dq,
    b: bestPass === 0 ? dq : dp,
    feature: { edgePiece: bestPass === 0 ? "a" : "b", edge: bestEdge, vertex },
  };
}

/** Closest vertex/segment pair; envelope derivatives include the selected lever arms. */
function paddedClosestPair(N: number, a: Pose, b: Pose, scale: number, padding: number): PairPenetration | undefined {
  // Keep offsets local: tiny cores must not collapse at large absolute centres.
  const A = pieceVertices(N, { x: 0, y: 0, theta: a.theta }, scale);
  const B = pieceVertices(N, { x: 0, y: 0, theta: b.theta }, scale);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let distance = Infinity;
  let ax = 0;
  let ay = 0;
  let bx = 0;
  let by = 0;
  let ux = 1;
  let uy = 0;
  for (let pass = 0; pass < 2; pass++) {
    const vertices = pass === 0 ? A : B;
    const edges = pass === 0 ? B : A;
    const cx = pass === 0 ? dx : -dx;
    const cy = pass === 0 ? dy : -dy;
    for (let i = 0; i < N; i++) {
      const x = vertices[2 * i];
      const y = vertices[2 * i + 1];
      for (let j = 0; j < N; j++) {
        const k = (j + 1) % N;
        const ex = edges[2 * k] - edges[2 * j];
        const ey = edges[2 * k + 1] - edges[2 * j + 1];
        const length2 = ex * ex + ey * ey;
        const t =
          length2 === 0
            ? 0
            : Math.max(0, Math.min(1, ((x - cx - edges[2 * j]) * ex + (y - cy - edges[2 * j + 1]) * ey) / length2));
        const qx = edges[2 * j] + t * ex;
        const qy = edges[2 * j + 1] + t * ey;
        const vx = x - cx - qx;
        const vy = y - cy - qy;
        const d = Math.hypot(vx, vy);
        // SAT may report +ulp at exact core contact. Reuse its bounded branch
        // derivative when the closest features coincide.
        if (d === 0) return undefined;
        if (d >= distance) continue;
        distance = d;
        ax = pass === 0 ? x : qx;
        ay = pass === 0 ? y : qy;
        bx = pass === 0 ? qx : x;
        by = pass === 0 ? qy : y;
        ux = (pass === 0 ? vx : -vx) / d;
        uy = (pass === 0 ? vy : -vy) / d;
      }
    }
  }
  return {
    depth: 2 * padding - distance,
    a: { x: -ux, y: -uy, theta: ay * ux - ax * uy },
    b: { x: ux, y: uy, theta: bx * uy - by * ux },
  };
}

/**
 * Visit signed containment constraints and their analytic derivatives.
 *
 * Full mode uses vertex-major indices: vertex*M+edge for polygon walls,
 * and vertex for radial walls. Support-only polygon walls use index=edge and
 * the furthest piece vertex on each edge normal, reducing the count from N*M
 * to M. Both describe the same feasible set; their squared-penalty objectives
 * differ when several vertices protrude through the same wall.
 *
 * Support-only mode and radial walls allocate nothing. Full polygon walls
 * precompute vertices and normals once; passing scratch with length at least
 * 2*(N+M) also makes that path allocation-free. Scratch must not be shared
 * between recursively nested calls to this visitor.
 * Optional container axes must be cached for the corresponding M and phi.
 * scale shrinks the piece core about its centre; padding adds disk support to
 * each constraint (or radius for circles), without changing constraint IDs.
 */
export function visitContainerProtrusions(
  N: number,
  pose: Pose,
  container: Container,
  visitor: ProtrusionVisitor,
  supportOnly = false,
  scratch?: Float64Array,
  containerAxes?: Float64Array,
  scale = 1,
  padding = 0,
): void {
  const count = N === 0 ? 1 : N;
  const R = N === 0 ? 0 : circumradius(N) * scale;
  const step = N === 0 ? 0 : (2 * Math.PI) / N;
  const a0 = pose.theta + Math.PI / 2;
  const radius = (N === 0 ? scale * DISK_RADIUS : 0) + padding;
  if (container.M === 0) {
    for (let vertex = 0; vertex < count; vertex++) {
      const angle = a0 + vertex * step;
      const vx = N === 0 ? pose.x : pose.x + R * Math.cos(angle);
      const vy = N === 0 ? pose.y : pose.y + R * Math.sin(angle);
      const ox = vx - pose.x;
      const oy = vy - pose.y;
      const dx = vx - container.cx;
      const dy = vy - container.cy;
      const distance = Math.hypot(dx, dy);
      const ux = distance === 0 ? 1 : dx / distance;
      const uy = distance === 0 ? 0 : dy / distance;
      visitor(
        distance + radius - container.size * containerInradius(0),
        ux,
        uy,
        ox * uy - oy * ux,
        -ux,
        -uy,
        -containerInradius(0),
        0,
        vertex,
        N === 0 ? undefined : vertex,
      );
    }
    return;
  }

  const unitApothem = inradius(container.M);
  const axes = containerAxes && containerAxes.length >= 3 * container.M ? containerAxes : undefined;
  if (N === 0 || supportOnly) {
    for (let edge = 0; edge < container.M; edge++) {
      // As in enclosingPolygon, edge 0 is the bottom edge at phi=0,
      // and edge j ends at container vertex j.
      const angle = axes ? axes[3 * edge] : container.phi - Math.PI / 2 + (2 * Math.PI * edge) / container.M;
      const ux = axes ? axes[3 * edge + 1] : Math.cos(angle);
      const uy = axes ? axes[3 * edge + 2] : Math.sin(angle);
      // A regular polygon's support vertex is the nearest vertex direction
      // to u. This selects it in O(1), without enumerating the N vertices.
      const nearest = N === 0 ? 0 : Math.round((angle - a0) / step);
      const vertex = N === 0 ? 0 : ((nearest % N) + N) % N;
      const vertexAngle = a0 + vertex * step;
      const vx = N === 0 ? pose.x : pose.x + R * Math.cos(vertexAngle);
      const vy = N === 0 ? pose.y : pose.y + R * Math.sin(vertexAngle);
      const ox = vx - pose.x;
      const oy = vy - pose.y;
      const dx = vx - container.cx;
      const dy = vy - container.cy;
      visitor(
        dx * ux + dy * uy + radius - container.size * unitApothem,
        ux,
        uy,
        ox * uy - oy * ux,
        -ux,
        -uy,
        -unitApothem,
        -dx * uy + dy * ux,
        edge,
        N === 0 ? undefined : vertex,
        edge,
      );
    }
    return;
  }

  const needed = 2 * N + (axes ? 0 : 2 * container.M);
  const work = scratch && scratch.length >= needed ? scratch : new Float64Array(needed);
  for (let vertex = 0; vertex < N; vertex++) {
    const angle = a0 + vertex * step;
    work[2 * vertex] = pose.x + R * Math.cos(angle);
    work[2 * vertex + 1] = pose.y + R * Math.sin(angle);
  }
  const normals = 2 * N;
  if (!axes) {
    for (let edge = 0; edge < container.M; edge++) {
      const angle = container.phi - Math.PI / 2 + (2 * Math.PI * edge) / container.M;
      work[normals + 2 * edge] = Math.cos(angle);
      work[normals + 2 * edge + 1] = Math.sin(angle);
    }
  }
  for (let vertex = 0; vertex < N; vertex++) {
    const vx = work[2 * vertex];
    const vy = work[2 * vertex + 1];
    const ox = vx - pose.x;
    const oy = vy - pose.y;
    const dx = vx - container.cx;
    const dy = vy - container.cy;
    for (let edge = 0; edge < container.M; edge++) {
      const ux = axes ? axes[3 * edge + 1] : work[normals + 2 * edge];
      const uy = axes ? axes[3 * edge + 2] : work[normals + 2 * edge + 1];
      visitor(
        dx * ux + dy * uy + padding - container.size * unitApothem,
        ux,
        uy,
        ox * uy - oy * ux,
        -ux,
        -uy,
        -unitApothem,
        -dx * uy + dy * ux,
        vertex * container.M + edge,
        vertex,
        edge,
      );
    }
  }
}

/** All signed containment constraints, in vertex-major order. */
export function containerProtrusions(
  N: number,
  pose: Pose,
  container: Container,
  scale = 1,
  padding = 0,
): Protrusion[] {
  const out: Protrusion[] = [];
  visitContainerProtrusions(
    N,
    pose,
    container,
    (depth, px, py, ptheta, cx, cy, size, phi, index, vertex, edge) => {
      out[index] = {
        depth,
        pose: { x: px, y: py, theta: ptheta },
        container: { cx, cy, size, phi },
        ...(vertex === undefined ? {} : { vertex }),
        ...(edge === undefined ? {} : { edge }),
      };
    },
    false,
    undefined,
    undefined,
    scale,
    padding,
  );
  return out;
}
