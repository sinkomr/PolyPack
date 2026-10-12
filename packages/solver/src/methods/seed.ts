import {
  boundingRadius,
  containerVertices,
  findOverlaps,
  parseConfig,
  pieceSeparation,
  snapDistance,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import type { MethodContext, MethodDefinition } from "../framework";
import type { ParameterSchema } from "../schema";
import {
  automaticTheta,
  baseCell,
  latticeCut,
  pentagonCell,
  rotate,
  triangleBlock,
  SpacingCache,
} from "./seed/lattice";

import { congruenceSignature } from "./seed/signature";

export const seedKinds = [
  "square_lattice",
  "hex_lattice",
  "pentagon_double_lattice",
  "rings",
  "rows",
  "record_plus_one",
  "record_minus_one",
  "auto",
] as const;
type Kind = (typeof seedKinds)[number];
interface Trial {
  angle: number;
  orientation: number;
  offset: [number, number];
}

function numeric(
  title: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
): ParameterSchema {
  return { type: integer ? "integer" : "number", title, description, default: value, minimum, maximum };
}

const recordSchema: ParameterSchema = {
  type: "object",
  title: "Adjacent record",
  description:
    "Valid Phase 1 configuration of the same N and M, with P−1 or P+1 pieces; required by record generators.",
  required: ["N", "M", "P", "pieces"],
  properties: {
    N: numeric("Piece shape", "Circle 0, or polygon side count 3–100.", 0, 0, 100, true),
    M: numeric("Container shape", "Circle 0, or polygon side count 3–100.", 0, 0, 100, true),
    P: numeric("Record count", "Piece count of the adjacent record.", 1, 1, 500, true),
    container_phi: {
      type: "number",
      title: "Container angle",
      description: "Phase 1 container orientation in radians.",
    },
    pieces: {
      type: "array",
      title: "Record pieces",
      description: "Phase 1 piece poses.",
      minItems: 1,
      maxItems: 500,
      items: {
        type: "object",
        title: "Pose",
        description: "Unit piece position and rotation.",
        required: ["x", "y"],
        properties: {
          x: { type: "number", title: "X", description: "Horizontal position." },
          y: { type: "number", title: "Y", description: "Vertical position." },
          theta: { type: "number", title: "Piece angle", description: "Rotation in radians; omitted means zero." },
        },
      },
    },
  },
};

export const seedMethod: MethodDefinition = {
  name: "seed",
  doc: "docs/methods/seed.md",
  defaults: {
    kind: "auto",
    trials: 12,
    orientation: 0,
    automaticOrientation: true,
    latticeAngle: 0,
    angleRange: Math.PI / 2,
    orientationRange: 0,
    offsetRange: 1,
    perRow: 0,
    alternateRows: false,
    perRing: 0,
    recordTrials: 128,
    poolLimit: 8,
  },
  schema: {
    type: "object",
    title: "Lattice and symmetry seeds",
    description: "Generate valid starts from lattice cuts, symmetric rings, rows, or an adjacent record.",
    additionalProperties: false,
    properties: {
      kind: {
        type: "string",
        title: "Generator",
        description:
          "Auto interleaves cheap generators first and includes rings only up to P=100; record generators need record.",
        enum: [...seedKinds],
        default: "auto",
      },
      trials: numeric(
        "Trials per generator",
        "Bounded orientation and offset trials; four offset anchors followed by a cached minimum-cell-area orientation anchor.",
        12,
        1,
        256,
        true,
      ),
      orientation: numeric(
        "Piece orientation",
        "Radians, added to the automatic horizontal-base orientation, or absolute when automaticOrientation is false.",
        0,
        -2 * Math.PI,
        2 * Math.PI,
      ),
      automaticOrientation: {
        type: "boolean",
        title: "Automatic orientation",
        description:
          "Include horizontal-base and minimum-cell-area anchors; triangles use both orientations. Pentagon double lattice rotates its entire motif.",
        default: true,
      },
      latticeAngle: numeric(
        "Lattice angle",
        "Radians added to the lattice direction; hexagonal pieces use face normals at their actual orientation. Whole-arrangement rotation trials are omitted for circle containers.",
        0,
        -2 * Math.PI,
        2 * Math.PI,
      ),
      angleRange: numeric(
        "Lattice angle range",
        "Random trials rotate the lattice by up to this many radians in either direction.",
        Math.PI / 2,
        0,
        2 * Math.PI,
      ),
      orientationRange: numeric(
        "Piece angle range",
        "Random trials vary the piece orientation by up to this many radians in either direction.",
        0,
        0,
        Math.PI,
      ),
      offsetRange: numeric(
        "Offset range",
        "Maximum fractional lattice offset in each basis coordinate; zero disables offset trials.",
        1,
        0,
        1,
      ),
      perRow: numeric(
        "Pieces per row",
        "Zero tries near-square row widths automatically; otherwise use this width.",
        0,
        0,
        500,
        true,
      ),
      alternateRows: {
        type: "boolean",
        title: "Offset alternate rows",
        description:
          "Shift odd rows by half a horizontal step, with the tight non-overlapping row pitch; even rows remain aligned.",
        default: false,
      },
      perRing: numeric(
        "Pieces per ring",
        "Zero grows polygon perimeter populations in multiples of M; circles try a centre with 6,12,… or a single outer ring for small P. Explicit polygon counts must be multiples of M.",
        0,
        0,
        500,
        true,
      ),
      recordTrials: numeric(
        "Insertion positions",
        "Maximum free contact or grid positions scored for record_plus_one; record_minus_one tries every removal.",
        128,
        1,
        4096,
        true,
      ),
      poolLimit: numeric(
        "Emitted seed pool",
        "Emit distinct score and pair-distance classes to this cap, initially across generators, then by score. Tolerance 1e−7. Emit costs an evaluation.",
        8,
        0,
        64,
        true,
      ),
      record: recordSchema,
    },
  },
  execute: executeSeeds,
};

function config(ctx: MethodContext, pieces: Pose[], phi = 0): PackingConfig {
  return { ...ctx.problem, pieces, container_phi: phi };
}

function readRecord(ctx: MethodContext, delta?: number): PackingConfig {
  if (ctx.params.record === undefined) throw new Error("record is required for this generator");
  const parsed = parseConfig(ctx.params.record);
  if (!parsed.ok) throw new Error(`record: ${parsed.errors.join("; ")}`);
  const record = parsed.config;
  if (record.N !== ctx.problem.N || record.M !== ctx.problem.M)
    throw new Error("record shape N and M must match the problem");
  if (record.pieces.length !== record.P || (delta !== undefined && record.P !== ctx.problem.P + delta))
    throw new Error(
      `record must contain exactly ${delta === undefined ? record.P : ctx.problem.P + delta} pieces for this generator`,
    );
  if (findOverlaps(record.N, record.pieces).length) throw new Error("record contains overlapping pieces");
  return record;
}

function ringReason(ctx: MethodContext): string | undefined {
  const { N, M, P } = ctx.problem;
  const count = ctx.params.perRing as number;
  if (M === 0) return undefined;
  if (count !== 0 && count % M !== 0) return "polygon rings require perRing to be zero or a multiple of M";
  const remainder = P % M;
  if (remainder !== 0 && remainder !== 1)
    return "D_M rings require P to be a multiple of M, or one more than a multiple of M";
  if (remainder === 1 && N !== 0 && N % M !== 0) return "a central polygon has D_M symmetry only when M divides N";
  if ((ctx.params.orientation as number) !== 0 || (ctx.params.orientationRange as number) !== 0)
    return "D_M rings require orientation and orientationRange to be zero (radial reflection axes)";
  return undefined;
}

async function* lattices(
  ctx: MethodContext,
  kind: Kind,
  trials: Trial[],
  cache: SpacingCache,
): AsyncGenerator<PackingConfig> {
  const { N, M, P } = ctx.problem;
  if (kind === "pentagon_double_lattice" && N !== 5) throw new Error("pentagon_double_lattice applies only to N = 5");
  const seen = new Set<string>();
  for (let t = 0; t < trials.length; t++) {
    if (!(await ctx.checkpoint())) return;
    const trial = trials[t];
    if (N === 3 && M === 3 && t === 0) {
      yield config(ctx, triangleBlock(P, trial.orientation + trial.angle));
      continue;
    }
    const hex = kind === "hex_lattice";
    let orientation = trial.orientation;
    let angle = M === 0 ? 0 : trial.angle;
    if (t === 4 && ctx.params.automaticOrientation && kind !== "pentagon_double_lattice") {
      const optimum = await cache.optimum(hex);
      if (optimum === undefined) return;
      orientation = optimum + (ctx.params.orientation as number);
      angle = M === 0 ? 0 : (ctx.params.latticeAngle as number);
    }
    // Circle-container rotations, and triangle-cell rotations, do not change
    // a cut. Offset/orientation changes relative to the lattice still do.
    const key = `${N === 3 && M === 0 ? trials[0].orientation : orientation}:${angle}:${trial.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cell = kind === "pentagon_double_lattice" ? pentagonCell() : baseCell(N, hex, orientation);
    if (hex && N === 6) {
      // The vertex-up convention puts face normals at theta (mod pi/3).
      // This alignment follows the actual requested piece orientation.
      for (const basis of ["a", "b"] as const) {
        const vector = rotate({ x: cell[basis][0], y: cell[basis][1], theta: 0 }, orientation);
        cell[basis] = [vector.x, vector.y];
      }
    }
    const scale = kind === "pentagon_double_lattice" ? 1 : await cache.scale(kind, cell, orientation);
    if (scale === undefined) return;
    if (kind === "pentagon_double_lattice") angle += M === 0 ? 0 : orientation;
    const pieces = await latticeCut(ctx, cell, scale, angle, trial.offset);
    if (!pieces) return;
    yield config(ctx, pieces);
  }
}

async function rowPitch(ctx: MethodContext, theta: number, shifted: boolean): Promise<[number, number] | undefined> {
  const N = ctx.problem.N;
  const origin = { x: 0, y: 0, theta };
  const contact = (offset: number, horizontal: boolean): number | undefined => {
    let lo = 0;
    let hi = 2 * boundingRadius(N);
    for (let i = 0; i < 44; i++) {
      if (ctx.shouldStop()) return undefined;
      const mid = (lo + hi) / 2;
      const p = { x: horizontal ? mid : offset, y: horizontal ? 0 : mid, theta };
      if (pieceSeparation(N, origin, p).sep < 0) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const dx = contact(0, true);
  const vertical = contact(0, false);
  if (dx === undefined || vertical === undefined) return undefined;
  const left = shifted ? contact(-dx / 2, false) : vertical;
  const right = shifted ? contact(dx / 2, false) : vertical;
  if (left === undefined || right === undefined) return undefined;
  return [dx * (1 + 2e-13), Math.max(left, right, shifted ? vertical / 2 : vertical) * (1 + 2e-13)];
}

async function* rows(ctx: MethodContext, trials: Trial[], cache: SpacingCache): AsyncGenerator<PackingConfig> {
  const { N, M, P } = ctx.problem;
  const specified = ctx.params.perRow as number;
  const root = Math.ceil(Math.sqrt(P));
  const widths = [
    ...new Set([
      root,
      Math.floor(Math.sqrt(P)),
      root + 1,
      Math.max(1, root - 2),
      1,
      P,
      ...Array.from({ length: Math.min(P, trials.length) }, (_, i) => i + 1),
    ]),
  ];
  const pitches = new Map<number, [number, number]>();
  const seen = new Set<string>();
  for (let t = 0; t < trials.length; t++) {
    if (!(await ctx.checkpoint())) return;
    const trial = trials[t];
    if (N === 3 && specified === 0 && t === 0) {
      yield config(ctx, triangleBlock(P, trial.orientation + trial.angle));
      continue;
    }
    const width = specified || widths[t % widths.length];
    const angle = M === 0 ? 0 : trial.angle;
    const key = `${Math.min(width, P)}:${N === 3 ? 0 : trial.orientation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let scale = 1;
    let pitch: [number, number] | undefined;
    if (N === 3) {
      scale = (await cache.scale("triangle-rows", baseCell(N, false, trial.orientation), trial.orientation)) ?? 0;
      if (!scale) return;
    } else {
      pitch = pitches.get(trial.orientation);
      if (!pitch) pitch = await rowPitch(ctx, trial.orientation, ctx.params.alternateRows as boolean);
      if (!pitch) return;
      pitches.set(trial.orientation, pitch);
    }
    const pieces: Pose[] = [];
    for (let i = 0; i < P; i++) {
      const row = Math.floor(i / width);
      const col = i % width;
      const pose =
        N === 3
          ? {
              x: scale * (Math.floor(col / 2) + (col % 2) / 2 + (row % 2) / 2),
              y: scale * ((row * Math.sqrt(3)) / 2 + ((col % 2) * Math.sqrt(3)) / 6),
              theta: (col % 2) * Math.PI,
            }
          : {
              x: pitch![0] * (col + (ctx.params.alternateRows ? (row % 2) / 2 : 0)),
              y: row * pitch![1],
              theta: trial.orientation,
            };
      pieces.push(rotate(pose, angle + (N === 3 ? trial.orientation : 0)));
    }
    yield config(ctx, pieces);
  }
}

async function* rings(ctx: MethodContext, trials: Trial[]): AsyncGenerator<PackingConfig> {
  const reason = ringReason(ctx);
  if (reason) throw new Error(reason);
  const { N, M, P } = ctx.problem;
  const reach = 2 * boundingRadius(N);
  const reach2 = (reach + 1e-10) ** 2;
  const polygon = M === 0 ? undefined : containerVertices({ M, cx: 0, cy: 0, phi: 0, size: 1 });
  const seen = new Set<string>();
  for (let t = 0; t < trials.length; t++) {
    const trial = trials[t];
    if (!(await ctx.checkpoint())) return;
    const central = M === 0 ? P === 1 || t % 2 === 0 : P % M === 1;
    const smallPolygon = M !== 0 && P <= M + 1;
    const profile = `${central}:${N === 0 && M === 0 && P <= 12 ? 0 : t % 4}:${N === 0 ? 0 : trial.orientation}`;
    if (seen.has(profile)) continue;
    seen.add(profile);
    const pieces: Pose[] = [];
    const bands: { pieces: Pose[]; low: number; high: number }[] = [];
    const centralFlip = N !== 0 && (t % 4 === 1 || t % 4 === 2) ? Math.PI / N : 0;
    const ringFlip = N !== 0 && t % 2 === 1 ? Math.PI / N : 0;
    if (central) {
      const centre = { x: 0, y: 0, theta: M === 0 ? trial.orientation : -Math.PI + centralFlip };
      pieces.push(centre);
      bands.push({ pieces: [centre], low: 0, high: 0 });
    }
    let previousScale = 0;
    let ring = 1;
    while (pieces.length < P) {
      if (!(await ctx.checkpoint())) return;
      const prescribed = ctx.params.perRing as number;
      const population =
        prescribed || (M === 0 ? (P <= 12 ? P : 6 * ring) : smallPolygon ? M : M * (2 * ring - (central ? 0 : 1)));
      const count = Math.min(P - pieces.length, population);
      const slots = M === 0 ? 0 : count / M;
      const units = Array.from({ length: count }, (_, i) => {
        if (M !== 0 && !smallPolygon) {
          const edge = Math.floor(i / slots);
          const fraction = (i % slots) / slots;
          const next = (edge + 1) % M;
          const x = polygon![2 * edge] * (1 - fraction) + polygon![2 * next] * fraction;
          const y = polygon![2 * edge + 1] * (1 - fraction) + polygon![2 * next + 1] * fraction;
          const normal = -Math.PI / 2 + (2 * Math.PI * next) / M;
          const theta =
            N === 0 || N % M === 0
              ? automaticTheta(N) + ringFlip
              : (fraction === 0 ? Math.atan2(y, x) : normal) - Math.PI / 2 + ringFlip;
          return { x, y, theta };
        }
        const phase = (ring + (t % 4 === 2 ? 1 : 0)) % 2 === 0 ? Math.PI / count : 0;
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / count + phase;
        return {
          x: Math.cos(angle),
          y: Math.sin(angle),
          theta: N === 0 ? 0 : angle - Math.PI / 2 + (M === 0 ? trial.orientation : ringFlip),
        };
      });
      const norms = units.map((p) => Math.hypot(p.x, p.y));
      const lowNorm = Math.min(...norms);
      const highNorm = Math.max(...norms);
      let minDistance = Infinity;
      for (let i = 0; i < count; i++)
        for (let j = 0; j < i; j++) {
          minDistance = Math.min(minDistance, Math.hypot(units[i].x - units[j].x, units[i].y - units[j].y));
        }
      const makeRing = (scale: number): Pose[] =>
        units.map((p) => ({ x: scale * p.x, y: scale * p.y, theta: p.theta }));
      const feasible = async (scale: number): Promise<boolean | undefined> => {
        const added = makeRing(scale);
        let scanned = 0;
        for (let i = 0; i < added.length; i++) {
          const a = added[i];
          const radius = scale * norms[i];
          for (const band of bands) {
            // Radial intervals identify neighbouring rings rigorously, even
            // for polygon perimeters whose points have different radii.
            if (radius - reach > band.high || radius + reach < band.low) continue;
            for (const b of band.pieces) {
              if (scanned++ % 256 === 0 && !(await ctx.checkpoint())) return undefined;
              if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > reach2) continue;
              if (pieceSeparation(N, a, b).sep < 0) return false;
            }
          }
          for (let j = 0; j < i; j++) {
            if (scanned++ % 256 === 0 && !(await ctx.checkpoint())) return undefined;
            const b = added[j];
            if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > reach2) continue;
            if (pieceSeparation(N, a, b).sep < 0) return false;
          }
        }
        return true;
      };
      let lo = previousScale;
      const outerRadius = bands.length ? bands[bands.length - 1].high : 0;
      let hi = Math.max((outerRadius + reach) / lowNorm, reach / minDistance, previousScale + reach);
      for (let step = 0; step < 40; step++) {
        const mid = (lo + hi) / 2;
        const valid = await feasible(mid);
        if (valid === undefined) return;
        if (valid) hi = mid;
        else lo = mid;
      }
      previousScale = hi * (1 + 2e-13);
      const added = makeRing(previousScale);
      pieces.push(...added);
      bands.push({ pieces: added, low: previousScale * lowNorm, high: previousScale * highNorm });
      ring++;
    }
    yield config(ctx, pieces);
  }
}

async function* recordMinus(ctx: MethodContext): AsyncGenerator<PackingConfig> {
  const record = readRecord(ctx, 1);
  for (let removed = 0; removed < record.P; removed++) {
    if (!(await ctx.checkpoint())) return;
    yield config(
      ctx,
      record.pieces.filter((_, i) => i !== removed),
      record.container_phi,
    );
  }
}

async function* recordPlus(ctx: MethodContext, trials: Trial[]): AsyncGenerator<PackingConfig> {
  const record = readRecord(ctx, -1);
  const { N } = ctx.problem;
  const radius = boundingRadius(N);
  const reach = 2 * radius;
  const theta = trials[0].orientation;
  const cx = record.pieces.reduce((sum, p) => sum + p.x, 0) / record.P;
  const cy = record.pieces.reduce((sum, p) => sum + p.y, 0) / record.P;
  const outer = record.pieces
    .map((p, i) => ({ p, i, distance: Math.hypot(p.x - cx, p.y - cy) }))
    .sort((a, b) => b.distance - a.distance || a.i - b.i);
  const margin = 1e-11 + 8 * Number.EPSILON * Math.max(...record.pieces.map((p) => Math.abs(p.x) + Math.abs(p.y)));
  const clear = async (p: Pose): Promise<boolean> => {
    if (Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) return false;
    for (let i = 0; i < record.P; i++) {
      if (i % 64 === 0 && !(await ctx.checkpoint())) return false;
      const q = record.pieces[i];
      if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 > (reach + margin) ** 2) continue;
      if (pieceSeparation(N, p, q).sep < 0) return false;
    }
    return true;
  };
  const pending: Pose[] = [];
  const minX = Math.min(...record.pieces.map((p) => p.x));
  const maxX = Math.max(...record.pieces.map((p) => p.x));
  const minY = Math.min(...record.pieces.map((p) => p.y));
  const maxY = Math.max(...record.pieces.map((p) => p.y));
  for (const p of [
    { x: maxX + reach + margin, y: cy, theta },
    { x: minX - reach - margin, y: cy, theta },
    { x: cx, y: maxY + reach + margin, theta },
    { x: cx, y: minY - reach - margin, theta },
  ]) {
    if (!(await clear(p))) continue;
    if (N === 0 || record.P <= 30) {
      const distance = Math.hypot(p.x - cx, p.y - cy);
      const ux = (cx - p.x) / distance;
      const uy = (cy - p.y) / distance;
      const shift = snapDistance(N, [...record.pieces, p], [record.P], ux, uy, distance);
      const touching = { x: p.x + Math.max(0, shift - margin) * ux, y: p.y + Math.max(0, shift - margin) * uy, theta };
      if (await clear(touching)) pending.push(touching);
      else pending.push(p);
    } else pending.push(p);
  }
  if (pending.length === 0) {
    const extent = Math.ceil(Math.sqrt(record.P));
    search: for (let x = -extent; x <= extent; x++)
      for (let y = -extent; y <= extent; y++) {
        if (ctx.shouldStop()) return;
        const p = { x: 4 * radius * x, y: 4 * radius * y, theta };
        if (await clear(p)) {
          pending.push(p);
          break search;
        }
      }
  }
  const centre = { x: cx, y: cy, theta };
  if (await clear(centre)) pending.push(centre);
  // A two-contact circle insertion is the intersection of radius-two circles
  // about two existing centres. The tiny outward margin keeps both contacts
  // on the valid side of float64 rounding; shared geometry checks every pose.
  if (N === 0)
    for (const { p: a } of outer) {
      if (!(await ctx.checkpoint())) return;
      for (const { p: b } of outer) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d < 1e-12 || d > 2 * (reach + margin)) continue;
        const h = Math.sqrt(Math.max(0, (reach + margin) ** 2 - (d * d) / 4));
        for (const sign of [-1, 1])
          pending.push({ x: (a.x + b.x) / 2 + (sign * h * dy) / d, y: (a.y + b.y) / 2 - (sign * h * dx) / d, theta });
      }
      // Bound preparation as well as scoring; the outermost neighbourhood is
      // sufficient to supply contacts even when the record has hundreds of pieces.
      if (pending.length >= 4 * (ctx.params.recordTrials as number)) break;
    }
  const cap = ctx.params.recordTrials as number;
  const seen = new Set<string>();
  let attempts = 0;
  let scored = 0;
  for (const p of pending) {
    if (attempts++ >= cap) break;
    if (!(await ctx.checkpoint())) return;
    const key = `${Math.round(p.x / 1e-8)}:${Math.round(p.y / 1e-8)}`;
    if (seen.has(key) || !(await clear(p))) continue;
    seen.add(key);
    yield config(ctx, [...record.pieces, p], record.container_phi);
    if (++scored >= cap) return;
  }
  for (let i = attempts; i < cap; i++) {
    if (!(await ctx.checkpoint())) return;
    const anchor = outer[(i - attempts) % outer.length].p;
    const phase = Math.floor((i - attempts) / outer.length);
    const angle = Math.atan2(anchor.y - cy, anchor.x - cx) + (phase * 2 * Math.PI) / 12;
    let lo = 0;
    let hi = reach;
    for (let step = 0; step < 44; step++) {
      if (ctx.shouldStop()) return;
      const mid = (lo + hi) / 2;
      if (
        pieceSeparation(N, anchor, { x: anchor.x + mid * Math.cos(angle), y: anchor.y + mid * Math.sin(angle), theta })
          .sep < 0
      )
        lo = mid;
      else hi = mid;
    }
    const p = { x: anchor.x + (hi + margin) * Math.cos(angle), y: anchor.y + (hi + margin) * Math.sin(angle), theta };
    if (!(await clear(p))) continue;
    yield config(ctx, [...record.pieces, p], record.container_phi);
    if (++scored >= cap) return;
    if (N !== 0)
      for (const sign of [-1, 1]) {
        if (!(await ctx.checkpoint())) return;
        const contact = pieceSeparation(N, p, anchor);
        const ux = -sign * contact.ny;
        const uy = sign * contact.nx;
        // A tangent slide travels at most 2R. Pieces initially farther than
        // 4R cannot be contacted along that segment; prune before the shared
        // conservative-advancement routine, including for large records.
        const neighbours = record.pieces.filter(
          (q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 <= (2 * reach + margin) ** 2,
        );
        const shift = snapDistance(N, [...neighbours, p], [neighbours.length], ux, uy, reach);
        const slide = { x: p.x + Math.max(0, shift - margin) * ux, y: p.y + Math.max(0, shift - margin) * uy, theta };
        if (shift > margin && (await clear(slide))) {
          yield config(ctx, [...record.pieces, slide], record.container_phi);
          if (++scored >= cap) return;
        }
      }
  }
}

async function executeSeeds(ctx: MethodContext): Promise<void> {
  const requested = ctx.params.kind as Kind;
  const record =
    requested === "record_plus_one"
      ? readRecord(ctx, -1)
      : requested === "record_minus_one"
        ? readRecord(ctx, 1)
        : requested === "auto" && ctx.params.record !== undefined
          ? readRecord(ctx)
          : undefined;
  const kinds: Kind[] =
    requested === "auto"
      ? [
          "square_lattice",
          "hex_lattice",
          ...(ctx.problem.N === 5 ? ["pentagon_double_lattice" as const] : []),
          "rows",
          ...(!ringReason(ctx) && ctx.problem.P <= 100 ? ["rings" as const] : []),
          ...(record?.P === ctx.problem.P - 1 ? ["record_plus_one" as const] : []),
          ...(record?.P === ctx.problem.P + 1 ? ["record_minus_one" as const] : []),
        ]
      : [requested];
  if (requested === "auto" && record && Math.abs(record.P - ctx.problem.P) !== 1)
    throw new Error("auto record must have P−1 or P+1 pieces");
  const orientation =
    (ctx.params.automaticOrientation ? automaticTheta(ctx.problem.N) : 0) + (ctx.params.orientation as number);
  const trials: Trial[] = [];
  for (let t = 0; t < (ctx.params.trials as number); t++) {
    // Draw the same trial table for single and auto runs, independently of which
    // generators apply. Round-robin evaluation then gives equal budget shares.
    const random = [ctx.random(), ctx.random(), ctx.random(), ctx.random()];
    const anchorOffsets: [number, number][] = [
      [0, 0],
      [0.5, 0.5],
      [0.5, 0],
      [0, 0.5],
    ];
    const offset = t < 4 ? anchorOffsets[t] : [random[2], random[3]];
    trials.push({
      angle:
        (ctx.params.latticeAngle as number) + (t < 4 ? 0 : (2 * random[0] - 1) * (ctx.params.angleRange as number)),
      orientation: orientation + (t < 4 ? 0 : (2 * random[1] - 1) * (ctx.params.orientationRange as number)),
      offset: [offset[0] * (ctx.params.offsetRange as number), offset[1] * (ctx.params.offsetRange as number)],
    });
  }
  const cache = new SpacingCache(ctx);
  const generators = kinds.map((kind) =>
    kind === "rows"
      ? rows(ctx, trials, cache)
      : kind === "rings"
        ? rings(ctx, trials)
        : kind === "record_plus_one"
          ? recordPlus(ctx, trials)
          : kind === "record_minus_one"
            ? recordMinus(ctx)
            : lattices(ctx, kind, trials, cache),
  );
  const active = generators.map(() => true);
  const pool: { config: PackingConfig; score: number; key: string }[] = [];
  const poolLimit = ctx.params.poolLimit as number;
  const emitted = new Set<string>();
  const emittedGenerator = new Set<number>();
  while (active.some(Boolean)) {
    const initialSeeds: { config: PackingConfig; key: string }[] = [];
    for (let i = 0; i < generators.length; i++) {
      if (!active[i]) continue;
      if (!(await ctx.checkpoint())) return;
      const next = await generators[i].next();
      if (next.done) {
        active[i] = false;
        continue;
      }
      const result = await ctx.evaluate(next.value);
      if (!result) return;
      if (!result.valid) throw new Error(`seed ${kinds[i]} produced invalid geometry: ${result.reasons.join("; ")}`);
      if (poolLimit > 0) {
        const candidate = { ...next.value, container_phi: result.container!.phi };
        const key = await congruenceSignature(ctx, candidate, result.score!);
        if (key === undefined) return;
        const previous = pool.find((member) => member.key === key);
        if (!previous) pool.push({ config: candidate, score: result.score!, key });
        else if (result.score! < previous.score) {
          previous.config = candidate;
          previous.score = result.score!;
        }
        pool.sort((a, b) => a.score - b.score);
        if (pool.length > poolLimit) pool.pop();
        // Finish the first evaluation round before emitting: even a budget of
        // one evaluation per generator must visit every generator in auto.
        if (
          !emittedGenerator.has(i) &&
          !emitted.has(key) &&
          !initialSeeds.some((member) => member.key === key) &&
          emitted.size + initialSeeds.length < poolLimit
        ) {
          initialSeeds.push({ config: candidate, key });
          emittedGenerator.add(i);
        }
      }
    }
    for (const candidate of initialSeeds) {
      if (!(await ctx.emit(candidate.config))) return;
      emitted.add(candidate.key);
    }
  }
  for (const member of pool) {
    if (emitted.has(member.key)) continue;
    if (emitted.size >= poolLimit) break;
    if (!(await ctx.checkpoint())) return;
    if (!(await ctx.emit(member.config))) return;
    emitted.add(member.key);
  }
}
