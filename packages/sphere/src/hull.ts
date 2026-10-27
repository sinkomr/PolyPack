/** Facets of the convex hull of unit vectors. Coplanar triangles need only one supporting plane.
 * Incremental hull, oriented away from a fixed interior tetrahedron point; O(m²) work, O(m) faces.
 * Used only to propose float planes; the Python certifier verifies its candidates in intervals.
 */
import { cross, dot, norm, type Vec3 } from "./geometry";
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export function* hullFaces(S: Vec3[]): Generator<void, [number, number, number][]> {
  const a = 0;
  let b = 1,
    c = 2,
    d = 3;
  for (let i = 1; i < S.length; i++) if (norm(sub(S[i], S[a])) > norm(sub(S[b], S[a]))) b = i;
  const line = sub(S[b], S[a]);
  for (let i = 1; i < S.length; i++) if (norm(cross(line, sub(S[i], S[a]))) > norm(cross(line, sub(S[c], S[a])))) c = i;
  const plane = cross(line, sub(S[c], S[a]));
  for (let i = 1; i < S.length; i++)
    if (Math.abs(dot(plane, sub(S[i], S[a]))) > Math.abs(dot(plane, sub(S[d], S[a])))) d = i;
  if (Math.abs(dot(plane, sub(S[d], S[a]))) < 1e-24) {
    // Coplanar unit vectors lie on a circle. A fan includes every boundary edge and its plane.
    const centre = S.reduce((v, p) => v.map((x, k) => x + p[k] / S.length) as Vec3, [0, 0, 0] as Vec3);
    const side = cross(plane, line);
    const order = S.map((_, i) => i).sort(
      (i, j) =>
        Math.atan2(dot(sub(S[i], centre), side), dot(sub(S[i], centre), line)) -
        Math.atan2(dot(sub(S[j], centre), side), dot(sub(S[j], centre), line)),
    );
    return order.slice(1, -1).map((i, k) => [order[0], i, order[k + 2]]);
  }
  const inside = S[a].map((_, k) => (S[a][k] + S[b][k] + S[c][k] + S[d][k]) / 4) as Vec3;
  type Face = { v: [number, number, number]; n: Vec3; offset: number; slack: number };
  const face = (i: number, j: number, k: number): Face => {
    let n = cross(sub(S[j], S[i]), sub(S[k], S[i]));
    if (dot(n, sub(inside, S[i])) > 0) {
      [j, k] = [k, j];
      n = [-n[0], -n[1], -n[2]];
    }
    return { v: [i, j, k], n, offset: dot(n, S[i]), slack: 1e-15 * norm(n) };
  };
  let faces = [face(a, b, c), face(a, d, b), face(a, c, d), face(b, d, c)];
  for (let i = 0; i < S.length; i++) {
    if ([a, b, c, d].includes(i)) continue;
    const edges = new Map<string, [number, number]>();
    const kept: Face[] = [];
    for (const f of faces) {
      if (dot(f.n, S[i]) - f.offset <= f.slack) {
        kept.push(f);
        continue;
      }
      for (let e = 0; e < 3; e++) {
        const u = f.v[e],
          v = f.v[(e + 1) % 3],
          key = u < v ? `${u},${v}` : `${v},${u}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [u, v]);
      }
    }
    for (const [u, v] of edges.values()) kept.push(face(u, v, i));
    faces = kept;
    yield;
  }
  return faces.map((f) => f.v);
}
