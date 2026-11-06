/**
 * Which curved problems can exist, as scalars: no Space (makeSpace caches vertex arrays per key, and the
 * catalogue has about 218,000 keys), so that the site can count problems and size the board's menus.
 * `curvedFits` is the one test of curvedBound (kernel-finish.ts): a bound is null exactly when it fails.
 */
import {
  containerArea,
  maxApothem,
  maxContainerSize,
  pieceExists,
  pieceGeometry,
  sideFromApothem,
  type PieceGeometry,
} from "./shapes";

/** The largest P of the site's curved catalogue (MAX_PIECES of packages/geometry). */
export const CURVED_MAX_P = 500;

/** True when P pieces of this piece can lie in a container of this kind: some size below the admissible limit works. */
export function curvedFits(K: number, M: number, tMax: number, piece: PieceGeometry, P: number): boolean {
  // one piece: a polygon container holds its inscribed disk (inradius >= rho), a disk container its vertices (r >= R);
  // two pieces in a disk container: r >= 2 rho
  let b = sideFromApothem(M, K, M === 0 ? piece.R : piece.rho);
  if (M === 0 && P >= 2) b = Math.max(b, sideFromApothem(M, K, 2 * piece.rho));
  if (!Number.isFinite(b) || !(b < maxContainerSize(M, K))) return false;
  // area: the container at the limit (tMax, less 1e-12 relative) must be larger than P pieces by a margin of 1e-11, so that
  // rounding cannot decide a tie (ten triangles fill the open hemisphere at K = 1.2257..., exactly); without a limit it always is
  if (Number.isFinite(tMax) && containerArea(M, K, sideFromApothem(M, K, tMax * (1 - 1e-12))) < P * piece.area * (1 + 1e-11))
    return false;
  return true;
}

const validCode = (n: number) => n === 0 || (Number.isInteger(n) && n >= 3 && n <= 100);
let lastPiece: PieceGeometry | undefined;
let lastKey = "";
/** The unit piece, the last one asked for kept (a count walks M for one N and K). */
function pieceOf(K: number, N: number): PieceGeometry {
  const key = `${K}|${N}`;
  if (key !== lastKey || !lastPiece) {
    lastPiece = pieceGeometry(N, K);
    lastKey = key;
  }
  return lastPiece;
}

/**
 * The largest P <= limit with a curvedBound that is not null, 0 when the unit piece does not exist at K or no
 * container below the admissible limit holds one. The problems that can exist are P = 1 up to this [CALC]; it
 * agrees with curvedBound(makeSpace(K, N, M), P) !== null (curved.test.ts).
 */
export function curvedMaxP(K: number, N: number, M: number, limit = CURVED_MAX_P): number {
  if (!Number.isFinite(K) || !validCode(N) || !validCode(M) || !(limit >= 1) || !pieceExists(N, K)) return 0;
  const piece = pieceOf(K, N);
  const tMax = maxApothem(M, K);
  if (!curvedFits(K, M, tMax, piece, 1)) return 0;
  // a disk container that cannot hold two disks (or two pieces) holds one
  if (M === 0 && limit >= 2 && !curvedFits(K, M, tMax, piece, 2)) return 1;
  let P = Math.floor(limit);
  if (Number.isFinite(tMax)) {
    const cap = containerArea(M, K, sideFromApothem(M, K, tMax * (1 - 1e-12)));
    P = Math.min(P, Math.floor(cap / piece.area) + 1);
  }
  // fits is monotone in P from 2 on, and the estimate is off by rounding only
  while (P > 1 && !curvedFits(K, M, tMax, piece, P)) P--;
  return P;
}

const kText = (K: number) => String(Number(K.toPrecision(6)));

/**
 * Why a problem cannot exist, in a plain sentence, or null when it can (curvedMaxP(K, N, M) >= P). The board shows
 * it for a link to such an id, instead of a search that ends with an error.
 */
export function curvedWhyNot(K: number, N: number, M: number, P: number): string | null {
  if (!Number.isFinite(K) || !validCode(N) || !validCode(M)) return null;
  const piece = N === 0 ? "disk" : `${N}-gon`;
  const at = `at K = ${kText(K)}`;
  if (!pieceExists(N, K)) {
    if (N > 0 && Math.sqrt(K) * N >= 2 * Math.PI)
      return `No unit ${piece} exists ${at}: its perimeter, ${N}, is longer than a great circle, 2π/√K ≈ ${(
        (2 * Math.PI) / Math.sqrt(K)
      ).toPrecision(4)}.`;
    return N === 0
      ? `No unit disk exists ${at}: it does not fit in a hemisphere.`
      : `No unit ${piece} exists ${at}: its sides are too long for the sphere.`;
  }
  const max = curvedMaxP(K, N, M, Math.max(P, 1));
  if (max >= P) return null;
  const box = M === 0 ? "disk container" : `${M}-gon container`;
  const limit = K > 0 ? "a container stays inside an open hemisphere" : "a polygon container cannot grow past the ideal polygon";
  if (max === 0) return `A ${box} ${at} cannot hold even one unit ${piece}: ${limit}.`;
  if (M === 0 && max === 1) return `A ${box} ${at} cannot hold two unit ${piece}s: ${limit}.`;
  return `A ${box} ${at} holds at most ${max} unit ${piece}${max === 1 ? "" : "s"}: ${limit}, and ${P} pieces need more area than it has.`;
}
