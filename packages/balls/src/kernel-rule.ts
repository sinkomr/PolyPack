/**
 * What the balls kernel's two kinds of pieces (kernel-balls.ts, kernel-solids.ts) share: the server's rule for a
 * submission, and the exact finishing of a state, both on configurations in the space's format.
 *
 * The rule is the server's (validateSpaceSubmission of packages/spaces/src/validate.ts, as apps/server calls it for
 * this space: the problem's bound, and noRecord, since the space ships without research records). The spaces
 * package depends on this one, so the rule is built here again from the same parts (ballsConfigErrors and
 * validateBalls) and the server's constants; packages/spaces/test/methods.test.ts checks that both give the same
 * verdict, score and reasons.
 */
import type { Finished, Validation } from "@polypack/methods";
import { StopSearch } from "@polypack/polyhedra";
import { BALL_MUS, legalizeBalls, polishBalls } from "./ball-pieces";
import type { BallsProblem } from "./catalogue";
import { BALLS_CLEARANCE } from "./search";
import { SOLID_MUS, legalizeSolids, polishSolids } from "./solid-pieces";
import { type BallsConfig, ballsConfigErrors, tightSize, validateBalls } from "./validate";

/**
 * The server's constants for a balls entry (SPACE_TOL, SPACE_STRICT_TOL, SPACE_BOUND_SLACK and MAX_REASONS of
 * packages/spaces, which this package cannot import).
 */
export const BALLS_SERVER_RULE = {
  /** PolyPack's touching tolerance. */
  tol: 1e-9,
  /** The strict check that every entry of a problem without a research record must also pass. */
  strictTol: 1e-11,
  /** A size below the problem's bound by more than this relative amount is refused unchecked. */
  boundSlack: 1e-9,
  /** Reasons listed at most. */
  maxReasons: 20,
} as const;

/** The server's reason when an entry of a problem without a research record is valid only within the touching tolerance. */
export const BALLS_STRICT_REASON = `valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance ${BALLS_SERVER_RULE.strictTol}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The server's verdict on a configuration of `problem` with P pieces, whose lower bound is `bound`, in the server's
 * order: the configuration's form and limits (malformed input and a wrong number of pieces have no score), the size
 * against the bound, the validator at the touching tolerance, then at the strict one.
 */
export function ballsServerRule(problem: BallsProblem, P: number, bound: number, config: unknown): Validation {
  const { tol, strictTol, boundSlack, maxReasons } = BALLS_SERVER_RULE;
  const fail = (reasons: string[], score: number | null = null): Validation => ({ valid: false, score, reasons });
  if (!isObject(config)) return fail(["config must be an object"]);
  const errors = ballsConfigErrors(problem, config, undefined, maxReasons);
  if (errors.length) return fail(errors.slice(0, maxReasons));
  // ballsConfigErrors has made sure that s is a number and pieces an array of well-formed poses
  const list = config.pieces as number[][];
  if (list.length !== P) return fail([`expected ${P} pieces for this problem, got ${list.length}`]);
  const width = problem.piece === "ball" ? 3 : 7;
  const c: BallsConfig = { s: config.s as number, pieces: list.map((p) => p.slice(0, width)) };
  if (Number.isFinite(bound) && c.s < bound * (1 - boundSlack))
    return fail([`the size ${c.s} is below the lower bound ${bound} of this problem`], c.s);
  const at = (t: number): string[] => {
    try {
      const v = validateBalls(problem, c, { tol: t, maxErrors: maxReasons });
      if (v.valid) return [];
      const reasons = v.errors.slice(0, maxReasons);
      return reasons.length ? reasons : [`not a valid packing (smallest separation ${v.minPairSep})`];
    } catch (e) {
      return [`the check failed: ${e instanceof Error ? e.message : String(e)}`];
    }
  };
  const reasons = at(tol);
  if (reasons.length) return fail(reasons, c.s);
  const strict = at(strictTol);
  if (strict.length) return fail([BALLS_STRICT_REASON, ...strict.slice(0, 3)], c.s);
  return { valid: true, score: c.s, reasons: [] };
}

/** The polish draws no random numbers (only the search's hops do); its options still name a stream. */
const NO_RNG = () => 0.5;

/**
 * The configuration's pieces in the smallest container that holds them as they are: centred again in a cube (a
 * translation, which changes no gap between pieces), at the size tightSize gives (validate.ts). The polish starts from
 * it, so that a loose stated size, up to the server's 1e6, does not have to be compressed first.
 */
function tightened(problem: BallsProblem, c: BallsConfig): BallsConfig {
  let pieces = c.pieces;
  if (problem.container === "cube") {
    // the bounding box's centre to the origin, as the legalization does (ball-pieces.ts legalizeBalls)
    const mid = [0, 1, 2].map((k) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of pieces) {
        lo = Math.min(lo, p[k]);
        hi = Math.max(hi, p[k]);
      }
      return (lo + hi) / 2;
    });
    pieces = pieces.map((p) => [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2], ...p.slice(3)]);
  }
  return { s: tightSize(problem, pieces), pieces };
}

/**
 * The space's own finishing of a configuration, as the search treats a start it is given (search.ts), with two
 * changes: a configuration valid at tolerance 0 is a result already, so that a finish is never worse than a valid
 * input (the legalization scales centres about the origin, which can take a valid configuration past the server's
 * coordinate limit); and the polish starts at the size the pieces need (tightened), not at the stated one.
 *
 * Then: the legalization with the clearance BALLS_CLEARANCE, and the polish from the penalty weight 1e4 on (the
 * polish legalizes its result too); each result is checked with the validator at tolerance 0 and the smallest is
 * kept. A configuration the server could not read (a state that blew up or left its limits) finishes to nothing.
 *
 * Stops: the legalization of solids polls `shouldStop` between its separating-axis tests (it can take seconds for
 * a hundred solids piled near one point), and a stop there ends the finish with what it has: the input when it is
 * valid, else nothing. The balls' legalization is one sweep over the pairs and is not polled. The polish polls at
 * every evaluation and between them; a stop ends it with its last iterate, legalized, which is kept when it is valid
 * and smaller (a stop before its first stage has moved leaves the legalized input).
 */
export function finishBallsConfig(
  problem: BallsProblem,
  P: number,
  start: BallsConfig,
  shouldStop?: () => boolean,
): Finished | null {
  if (ballsConfigErrors(problem, start, P).length) return null;
  const balls = problem.piece === "ball";
  const C = BALLS_CLEARANCE;
  let best: BallsConfig | null = null;
  const keep = (c: BallsConfig | undefined) => {
    if (c && (!best || c.s < best.s) && validateBalls(problem, c, { tol: 0 }).valid) best = c;
  };
  const done = (): Finished | null => {
    const out = best as BallsConfig | null;
    return out ? { config: out, score: out.s } : null;
  };
  const stop = () => {
    if (shouldStop?.()) throw new StopSearch("aborted");
  };
  keep(start);
  try {
    keep(
      balls
        ? legalizeBalls(problem, start.pieces as [number, number, number][], C, C)
        : legalizeSolids(problem, start.pieces, C, C, stop),
    );
  } catch (e) {
    if (!(e instanceof StopSearch)) throw e;
    return done();
  }
  if (shouldStop?.()) return done();
  const o = { rng: NO_RNG, tick: stop, poll: stop, clearance: C };
  const from = tightened(problem, start);
  try {
    keep(balls ? polishBalls(problem, from, o, BALL_MUS.slice(3)) : polishSolids(problem, from, o, SOLID_MUS.slice(3)));
  } catch (e) {
    if (!(e instanceof StopSearch)) throw e;
    keep((e as StopSearch & { partial?: BallsConfig }).partial);
  }
  return done();
}
