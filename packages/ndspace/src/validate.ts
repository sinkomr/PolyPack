/**
 * Configurations of the nD in nD space as the server reads and checks them: the form (packages/ndim poses), the work
 * bounds, and the sliced check with a cap on its work (docs/spaces/NDIM.md §10).
 *
 * A configuration is `{ s, pieces }`: the container scale s and one pose per piece, `[t_1..t_d, k_1..k_m, flip?]` for a
 * polytope (m = d(d - 1)/2) or the centre `[t_1..t_d]` for a ball. It is checked by the ndim package's validator
 * (validateNdSteps) at PolyPack's touching tolerance, with the work of the check capped at NDIM_CHECK_MS of processor
 * time: a check that needs more is refused, with that reason, so that no input costs unbounded time. The problem set is
 * finite, so the cap is also checked against the worst problems (the tests).
 */
import { MAX_SIZE, type NdProblem, isLoaded, loadPolytope, readPose, ndCheck as coreCheck } from "@polypack/ndim";
import { ND_BALL, ND_INFO, ndCode, type NdProblemId } from "./catalogue";

/**
 * Largest processor time one pass of a check may take (the server runs a second, strict pass for entries that beat a record or
 * have no record). [CALC] The worst valid case, 20 4_21 polytopes in a 4_21 container (4.67 million vertex-facet tests each),
 * took 2.3 s before the validator skipped facets that cannot lower the gap (docs/spaces/NDIM.md section 10): the cap is above that.
 */
export const NDIM_CHECK_MS = 8000;
/**
 * Reasons listed at most per verdict. A check stops after this many, and an overlapping pair of 8D or 10D polytopes costs up to
 * 0.8 s of GJK and EPA (when their centres are farther apart than twice the inradius), so this bounds the work of a bad input.
 */
export const NDIM_MAX_REASONS = 5;

export interface NdConfigShape {
  s: number;
  pieces: number[][];
}

export type NdParsed =
  { ok: true; config: NdConfigShape; score: number } | { ok: false; malformed: boolean; errors: string[] };

/** The core's problem for an id: catalogue codes ("4:cube") and "ball". */
export const ndProblemOf = (p: Pick<NdProblemId, "d" | "piece" | "container">): NdProblem => ({
  d: p.d,
  piece: ndCode(p.d, p.piece),
  container: ndCode(p.d, p.container),
});

/**
 * Reads a configuration for a problem of P pieces: s a number in (0, MAX_SIZE], P poses of the right length with finite
 * numbers in range (the ndim package's readPose). Malformed input is `malformed`; a wrong number of pieces is not. The
 * result has only the known fields, with the poses copied.
 */
export function parseNdConfig(p: NdProblemId, raw: unknown): NdParsed {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, malformed: true, errors: ["config must be an object {s, pieces}"] };
  const c = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof c.s !== "number" || !Number.isFinite(c.s) || !(c.s > 0) || c.s > MAX_SIZE)
    errors.push(`s must be a positive finite number of at most ${MAX_SIZE}`);
  if (!Array.isArray(c.pieces)) {
    errors.push("pieces must be an array of poses");
    return { ok: false, malformed: true, errors };
  }
  if (c.pieces.length !== p.P && !errors.length)
    return { ok: false, malformed: false, errors: [`expected ${p.P} pieces for this problem, got ${c.pieces.length}`] };
  const ball = p.piece === ND_BALL;
  const pieces: number[][] = [];
  for (let i = 0; i < Math.min(c.pieces.length, p.P) && errors.length < NDIM_MAX_REASONS; i++) {
    const r = readPose(p.d, c.pieces[i], ball);
    if (typeof r === "string") errors.push(`pieces[${i}] ${r}`);
    else pieces.push((c.pieces[i] as number[]).slice());
  }
  if (errors.length) return { ok: false, malformed: true, errors };
  return { ok: true, config: { s: c.s as number, pieces }, score: c.s as number };
}

/** Loads the polytopes of a problem that are kept on demand (8D 4_21); a no-op for the others. */
export async function loadNdProblem(p: Pick<NdProblemId, "d" | "piece" | "container">): Promise<void> {
  for (const code of [ndCode(p.d, p.piece), ndCode(p.d, p.container)])
    if (code !== ND_BALL && !isLoaded(code)) await loadPolytope(code);
}

/**
 * Work of a check in multiply-adds, by the sizes alone: every vertex of every piece against every facet of the container
 * (P nV nF d; a ball piece P nF d, a ball container P nV d), and about P^2/2 pair tests of cost 40 nV d each. The
 * estimate of the server's heavy queue and budget; the cap is on the measured time.
 */
export function ndCheckOps(p: NdProblemId): number {
  const nV = (shape: string) => (shape === ND_BALL ? 1 : (ND_INFO.get(ndCode(p.d, shape))?.nV ?? 1));
  const nF = (shape: string) => (shape === ND_BALL ? 1 : (ND_INFO.get(ndCode(p.d, shape))?.nF ?? 1));
  const walls = p.container === ND_BALL ? p.P * nV(p.piece) * p.d : p.P * nV(p.piece) * nF(p.container) * p.d;
  const pairs = ((p.P * (p.P - 1)) / 2) * 40 * nV(p.piece) * p.d;
  return walls + pairs;
}

/** Checks of at least this many multiply-adds (ndCheckOps) are heavy: the server queues them, one at a time (about 50 ms of work). */
export const NDIM_HEAVY_OPS = 2e7;
/** True when a problem's check is heavy (see NDIM_HEAVY_OPS). */
export const ndIsHeavy = (p: NdProblemId): boolean => ndCheckOps(p) >= NDIM_HEAVY_OPS;

/**
 * The reasons a configuration is not valid at `tol` (empty when valid), as steps for a sliced run. The polytopes must be
 * loaded (loadNdProblem). The work is capped at `capMs`: past it the check ends with a reason that says so.
 */
export function* ndCheckSteps(
  p: NdProblemId,
  config: NdConfigShape,
  tol: number,
  maxErrors = NDIM_MAX_REASONS,
  capMs = NDIM_CHECK_MS,
  now: () => number = () => performance.now(),
): Generator<void, string[]> {
  // the core's limits (pieces, vertex and wall work) are those of the problem's registry, never of the request
  const inner = coreCheck(ndProblemOf(p), config, { tol, maxErrors });
  let work = 0;
  for (;;) {
    const t = now();
    const r = inner.next();
    work += now() - t;
    if (r.done) {
      const v = r.value;
      if (v.valid) return [];
      return v.reasons.length
        ? v.reasons.slice(0, maxErrors)
        : [`not a valid packing (smallest separation ${v.minPairSep})`];
    }
    if (work > capMs)
      return [`the check was stopped after ${Math.round(work)} ms of work, above the cap of ${capMs} ms for one check`];
    yield;
  }
}

/** The check run to its end (tests and tools). */
export function ndCheck(
  p: NdProblemId,
  config: NdConfigShape,
  tol: number,
  maxErrors?: number,
  capMs?: number,
): string[] {
  const steps = ndCheckSteps(p, config, tol, maxErrors, capMs);
  for (;;) {
    const s = steps.next();
    if (s.done) return s.value;
  }
}
