/**
 * Curvature functions that are uniform in the curvature K (K < 0 hyperbolic, K = 0 Euclidean,
 * K > 0 spherical) and smooth through K = 0.
 *
 * With t = K x^2 the entire functions
 *   C(t) = sum_k (-t)^k / (2k)!      so  cs_K(x) = C(K x^2)   = cos(sqrt(K) x) | 1 | cosh(sqrt(-K) x)
 *   S(t) = sum_k (-t)^k / (2k+1)!    so  sn_K(x) = x S(K x^2) = sin(sqrt(K) x)/sqrt(K) | x | sinh(..)/sqrt(-K)
 *   V(t) = sum_k (-t)^k / (2k+2)!    so  vs_K(x) = (1 - cs_K(x)) / K = x^2 V(K x^2)
 *   U(t) = sum_k (-t)^k / (2k+3)!    so  (1 - S(t)) / t = U(t)
 * never divide by K, so every formula built from them is well conditioned for small |K|.
 */

/** Below this |t| the power series are used; above it the closed forms (both are accurate there). */
const SERIES_T = 0.5;

function series(t: number, first: number): number {
  // sum_k (-t)^k / (first + 2k)! / (first)!-normalised: term ratio -t / ((first+2k+1)(first+2k+2))
  let fact = 1;
  for (let i = 2; i <= first; i++) fact *= i;
  let term = 1 / fact;
  let sum = term;
  for (let k = 0; k < 40; k++) {
    const a = first + 2 * k + 1;
    term *= -t / (a * (a + 1));
    sum += term;
    if (Math.abs(term) < 1e-18 * Math.abs(sum)) break;
  }
  return sum;
}

export function Cfun(t: number): number {
  if (Math.abs(t) < SERIES_T) return series(t, 0);
  if (t > 0) return Math.cos(Math.sqrt(t));
  return Math.cosh(Math.sqrt(-t));
}

export function Sfun(t: number): number {
  if (Math.abs(t) < SERIES_T) return series(t, 1);
  if (t > 0) {
    const r = Math.sqrt(t);
    return Math.sin(r) / r;
  }
  const r = Math.sqrt(-t);
  return Math.sinh(r) / r;
}

export function Vfun(t: number): number {
  if (Math.abs(t) < SERIES_T) return series(t, 2);
  if (t > 0) {
    const r = Math.sqrt(t);
    const s = Math.sin(r / 2);
    return (2 * s * s) / t;
  }
  const r = Math.sqrt(-t);
  const s = Math.sinh(r / 2);
  return (2 * s * s) / -t;
}

export function Ufun(t: number): number {
  if (Math.abs(t) < SERIES_T) return series(t, 3);
  if (t > 0) {
    const r = Math.sqrt(t);
    return (r - Math.sin(r)) / (r * r * r);
  }
  const r = Math.sqrt(-t);
  return (Math.sinh(r) - r) / (r * r * r);
}

/** cs_K(x): cos(sqrt(K) x), 1 or cosh(sqrt(-K) x). */
export function csK(K: number, x: number): number {
  return Cfun(K * x * x);
}

/** sn_K(x): sin(sqrt(K) x)/sqrt(K), x or sinh(sqrt(-K) x)/sqrt(-K). */
export function snK(K: number, x: number): number {
  return x * Sfun(K * x * x);
}

/** tn_K(x) = sn_K(x) / cs_K(x). */
export function tnK(K: number, x: number): number {
  return snK(K, x) / csK(K, x);
}

/** vs_K(x) = (1 - cs_K(x)) / K = 2 sn_K(x/2)^2; equals x^2/2 at K = 0. */
export function vsK(K: number, x: number): number {
  return x * x * Vfun(K * x * x);
}

/** Inverse of sn_K on its monotone branch |x| <= pi/(2 sqrt K). Arguments beyond the range clamp. */
export function asnK(K: number, y: number): number {
  if (K > 0) {
    const r = Math.sqrt(K);
    const a = r * y;
    return Math.asin(a > 1 ? 1 : a < -1 ? -1 : a) / r;
  }
  if (K < 0) {
    const r = Math.sqrt(-K);
    return Math.asinh(r * y) / r;
  }
  return y;
}

/** Inverse of tn_K. For K < 0 the argument must satisfy |y| < 1/sqrt(-K) (else +-Infinity). */
export function atnK(K: number, y: number): number {
  if (K > 0) {
    const r = Math.sqrt(K);
    return Math.atan(r * y) / r;
  }
  if (K < 0) {
    const r = Math.sqrt(-K);
    const a = r * y;
    if (a >= 1) return Infinity;
    if (a <= -1) return -Infinity;
    return Math.atanh(a) / r;
  }
  return y;
}

/**
 * Length x >= 0 from (sn_K(x), cs_K(x)) given up to a common positive factor. For K > 0 this is
 * the atan2 branch, valid on [0, pi/sqrt K]; for K <= 0 cs is positive and sn decides.
 */
export function angK(K: number, sn: number, cs: number): number {
  if (K > 0) {
    const r = Math.sqrt(K);
    return Math.atan2(r * sn, cs) / r;
  }
  if (K < 0) {
    // tanh(r x) = r sn / cs; use asinh of the normalised sine for accuracy at large x
    const r = Math.sqrt(-K);
    const A = Math.sqrt(cs * cs + K * sn * sn);
    return Math.asinh((r * sn) / A) / r;
  }
  return sn / cs;
}

/** Distance from its versine: d with vs_K(d) = v, i.e. d = 2 asn_K(sqrt(v/2)). */
export function distFromVs(K: number, v: number): number {
  return 2 * asnK(K, Math.sqrt(Math.max(0, v) / 2));
}

/** Half the circumference of the space for K > 0 (antipodal distance), Infinity otherwise. */
export function antipodal(K: number): number {
  return K > 0 ? Math.PI / Math.sqrt(K) : Infinity;
}
