/**
 * The cone construction of scripts/construct.ts: P <= 20 unit-edge tetrahedra with a common vertex at the origin, one
 * in the cone over each of the first P faces of a regular icosahedron centred there (faces ordered by the height of
 * their middle, then by azimuth). See construct.ts for why they are disjoint and lie in the unit ball.
 */
type V = [number, number, number];

const phi = (1 + Math.sqrt(5)) / 2;
// the icosahedron's 12 vertices and its 20 faces (triples of vertices pairwise 2 apart)
const ico: V[] = [];
for (const a of [-1, 1]) for (const b of [-phi, phi]) ico.push([0, a, b], [a, b, 0], [b, 0, a]);
const faces: [number, number, number][] = [];
const near = (i: number, j: number) => Math.abs(Math.hypot(ico[i][0] - ico[j][0], ico[i][1] - ico[j][1], ico[i][2] - ico[j][2]) - 2) < 1e-9;
for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) for (let k = j + 1; k < 12; k++) if (near(i, j) && near(j, k) && near(i, k)) faces.push([i, j, k]);
// faces in a fixed order: by the height of their middle, then by azimuth
const mid = (f: number[]): V => {
  const m = [0, 1, 2].map((k) => f.reduce((s, v) => s + ico[v][k], 0) / 3);
  const l = Math.hypot(m[0], m[1], m[2]);
  return [m[0] / l, m[1] / l, m[2] / l];
};
faces.sort((a, b) => mid(b)[2] - mid(a)[2] || Math.atan2(mid(a)[1], mid(a)[0]) - Math.atan2(mid(b)[1], mid(b)[0]));

const unit = (v: number[]): V => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
// the canonical tetrahedron (packages/polyhedra): vertices (a, a, a), (a, -a, -a), (-a, a, -a), (-a, -a, a), a = 1 / (2 sqrt 2)
const a = 1 / (2 * Math.SQRT2);
const canon: V[] = [
  [a, a, a],
  [a, -a, -a],
  [-a, a, -a],
  [-a, -a, a],
];

/** The pose [x, y, z, qw, qx, qy, qz] of the tetrahedron with apex 0 in the cone over face f. */
export function poseIn(f: [number, number, number]): number[] {
  const n = mid(f);
  // base vertices at distance 1 from the apex, 35.26 degrees (cos^2 = 2/3) from the axis, toward the face's vertices
  const c = Math.sqrt(2 / 3);
  const sn = Math.sqrt(1 / 3);
  const base = f.map((v) => {
    const d = unit(ico[v]);
    const along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    const perp = unit([d[0] - along * n[0], d[1] - along * n[1], d[2] - along * n[2]]);
    return [c * n[0] + sn * perp[0], c * n[1] + sn * perp[1], c * n[2] + sn * perp[2]] as V;
  });
  let target: V[] = [[0, 0, 0], ...base];
  const centre = [0, 1, 2].map((k) => target.reduce((s, t) => s + t[k], 0) / 4);
  const rel = (t: V[]) => t.map((t) => [t[0] - centre[0], t[1] - centre[1], t[2] - centre[2]]);
  // R = (3 / (4 |c|^2)) sum t_k c_k^T for two regular tetrahedra of the same edge; a reflection swaps two vertices
  const rot = (t: number[][]) => {
    const R = Array.from({ length: 9 }, () => 0);
    const c2 = canon[0][0] ** 2 * 3;
    for (let k = 0; k < 4; k++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[3 * i + j] += (3 / (4 * c2)) * t[k][i] * canon[k][j];
    return R;
  };
  let R = rot(rel(target));
  const det = (M: number[]) =>
    M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
  if (det(R) < 0) {
    target = [target[0], target[1], target[3], target[2]];
    R = rot(rel(target));
  }
  // the quaternion of R (Shepperd's method)
  const tr = R[0] + R[4] + R[8];
  let q: number[];
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    q = [0.25 * S, (R[7] - R[5]) / S, (R[2] - R[6]) / S, (R[3] - R[1]) / S];
  } else if (R[0] > R[4] && R[0] > R[8]) {
    const S = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
    q = [(R[7] - R[5]) / S, 0.25 * S, (R[1] + R[3]) / S, (R[2] + R[6]) / S];
  } else if (R[4] > R[8]) {
    const S = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
    q = [(R[2] - R[6]) / S, (R[1] + R[3]) / S, 0.25 * S, (R[5] + R[7]) / S];
  } else {
    const S = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
    q = [(R[3] - R[1]) / S, (R[2] + R[6]) / S, (R[5] + R[7]) / S, 0.25 * S];
  }
  return [centre[0], centre[1], centre[2], ...q];
}

/** The poses of the construction with P tetrahedra. */
export function conePoses(P: number): number[][] {
  if (!(Number.isInteger(P) && P >= 1 && P <= 20)) throw new RangeError("the cones hold 1 to 20 tetrahedra");
  return faces.slice(0, P).map(poseIn);
}
