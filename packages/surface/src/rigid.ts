import { Solid, frameVertex } from "./solids";

/**
 * Orientation-preserving rigid motion of the plane: p -> R(ang) p + (tx, ty).
 * `c` and `s` are cos(ang) and sin(ang); `ang` is kept so that piece angles compose exactly.
 */
export interface Rigid {
  ang: number;
  c: number;
  s: number;
  tx: number;
  ty: number;
}

export const IDENTITY: Rigid = { ang: 0, c: 1, s: 0, tx: 0, ty: 0 };

export function apply(T: Rigid, x: number, y: number): [number, number] {
  return [T.c * x - T.s * y + T.tx, T.s * x + T.c * y + T.ty];
}

/** Rotation part only (for direction vectors). */
export function applyDir(T: Rigid, x: number, y: number): [number, number] {
  return [T.c * x - T.s * y, T.s * x + T.c * y];
}

/** A after B: p -> A(B(p)). */
export function compose(A: Rigid, B: Rigid): Rigid {
  return {
    ang: A.ang + B.ang,
    c: A.c * B.c - A.s * B.s,
    s: A.s * B.c + A.c * B.s,
    tx: A.c * B.tx - A.s * B.ty + A.tx,
    ty: A.s * B.tx + A.c * B.ty + A.ty,
  };
}

export function inverse(T: Rigid): Rigid {
  // p = R^-1 (q - t)
  return { ang: -T.ang, c: T.c, s: -T.s, tx: -(T.c * T.tx + T.s * T.ty), ty: -(-T.s * T.tx + T.c * T.ty) };
}

/** Rigid motion with rotation `ang` taking point (px, py) to (qx, qy). */
export function rigidThrough(ang: number, px: number, py: number, qx: number, qy: number): Rigid {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { ang, c, s, tx: qx - (c * px - s * py), ty: qy - (s * px + c * py) };
}

/**
 * Gluing map across edge k of face f: it takes the frame of the neighbour g (glued along its edge l)
 * to the plane of f's frame, so that g lies on the far side of edge k.
 * g's frame vertex l+1 goes to f's frame vertex k and g's l goes to f's k+1; the rotation is
 * 2 pi (k - l) / M + pi (edge k of a frame has direction angle 2 pi (k + 1) / M).
 */
export function glue(solid: Solid, s: number, f: number, k: number): { face: number; edge: number; T: Rigid } {
  const M = solid.M;
  const { face: g, edge: l } = solid.adj[f][k];
  const ang = (2 * Math.PI * (k - l)) / M + Math.PI;
  const [px, py] = frameVertex(M, s, l + 1);
  const [qx, qy] = frameVertex(M, s, k);
  return { face: g, edge: l, T: rigidThrough(ang, px, py, qx, qy) };
}
