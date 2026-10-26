/**
 * Structured starts of the sphere kernel (kernel.ts), after the research search's starts
 * (python/sphere/search.py: platonic_centres, code_start): centres at the face centres of a
 * Platonic solid (P = 4, 6, 8, 12, 20) or on a Fibonacci spiral (any P), turned by a random
 * rotation, each piece at a random orientation or with an edge facing its nearest neighbour.
 * The size is the one at which the circumscribed caps of the closest centres touch, so every seed
 * is a valid packing (loose for polygons) that the methods then tighten.
 */
import { type Quat, type Vec3, dot, quatFromCentreTheta, quatToMatrix, rotate, unit } from "./geometry";
import { maxAngle, randomQuat } from "./search";

/** Face centres of the Platonic solid with P faces as unit vectors, or null (python/sphere/search.py platonic_centres). */
export function platonicCentres(P: number): Vec3[] | null {
  const raw = platonicDirections(P);
  return raw && raw.map(unit);
}

function platonicDirections(P: number): Vec3[] | null {
  const phi = (1 + Math.sqrt(5)) / 2;
  const signs = [1, -1];
  const cube: Vec3[] = [];
  for (const x of signs) for (const y of signs) for (const z of signs) cube.push([x, y, z]);
  if (P === 4)
    return [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ];
  if (P === 6)
    return [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
  if (P === 8) return cube;
  const ico: Vec3[] = [];
  const dodeca: Vec3[] = [...cube];
  for (const s1 of signs)
    for (const s2 of signs) {
      ico.push([0, s1, s2 * phi], [s1, s2 * phi, 0], [s2 * phi, 0, s1]);
      dodeca.push([0, s1 * phi, s2 / phi], [s1 / phi, 0, s2 * phi], [s1 * phi, s2 / phi, 0]);
    }
  if (P === 12) return ico;
  if (P === 20) return dodeca;
  return null;
}

/** P points on a Fibonacci spiral: z evenly spaced, longitudes advancing by the golden angle. */
export function spiralCentres(P: number): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: P }, (_, k) => {
    const z = 1 - (2 * k + 1) / P;
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    return [s * Math.cos(golden * k), s * Math.sin(golden * k), z] as Vec3;
  });
}

/**
 * Poses for centres C (rotated by a random rotation): random orientations, or each piece turned
 * so that the midpoint of its edge 0 faces its nearest neighbour.
 */
export function posesFromCentres(N: number, C: Vec3[], rng: () => number, aligned: boolean): Quat[] {
  const turn = randomQuat(rng);
  const D = C.map((c) => unit(rotate(turn, c)));
  return D.map((c, i) => {
    if (N === 0 || !aligned) return quatFromCentreTheta(c, N === 0 ? 0 : 2 * Math.PI * rng());
    let best = -2;
    let nb = c;
    D.forEach((d, j) => {
      const g = dot(c, d);
      if (j !== i && g > best) {
        best = g;
        nb = d;
      }
    });
    // the direction towards the neighbour in the frame (T(c) e1, T(c) e2) of quatFromCentreTheta;
    // edge 0's midpoint lies at the angle pi/2 + pi/N + theta in that frame
    const M = quatToMatrix(quatFromCentreTheta(c, 0));
    const g = dot(c, nb);
    const t: Vec3 = [nb[0] - g * c[0], nb[1] - g * c[1], nb[2] - g * c[2]];
    const e1: Vec3 = [M[0][0], M[1][0], M[2][0]];
    const e2: Vec3 = [M[0][1], M[1][1], M[2][1]];
    const psi = Math.atan2(dot(t, e2), dot(t, e1));
    return quatFromCentreTheta(c, psi - Math.PI / 2 - Math.PI / N);
  });
}

/**
 * The rho at which the circumscribed caps of the closest pair of centres touch (angular
 * circumradius R = half their angle): sin(a/2) = sin R sin(pi/N) for polygons, a = R for disks;
 * never below the smallest rho at which the pieces exist.
 */
export function touchingRho(N: number, P: number, C: Vec3[]): number {
  let cmax = -1;
  for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) cmax = Math.max(cmax, dot(C[i], C[j]));
  const half = C.length > 1 ? Math.acos(Math.max(-1, Math.min(1, cmax))) / 2 : Math.PI / 2;
  const a = N === 0 ? half : 2 * Math.asin(Math.sin(half) * Math.sin(Math.PI / N));
  return 1 / Math.min(a, maxAngle(N, P) * (1 - 1e-9));
}
