/**
 * The balls space's kernel for the generic search methods (packages/methods/src/kernel.ts,
 * docs/methods/dimensions/README.md; docs/spaces/BALLS.md, "Kernel for the generic methods"): P unit balls in the
 * ball of radius s or the cube of edge s, or P unit-edge Platonic solids in the ball of radius s, the container
 * centred at the origin.
 *
 *  - Balls (kernel-balls.ts): 3 numbers per piece, its centre. The energy is the validator's own: squared pair
 *    overlaps 2 - |c_i - c_j| and squared protrusions from the ball or each face of the cube. Capabilities "shape"
 *    (a ball is its own inscribed ball, so setShape changes nothing, as for the reference kernel's disks) and
 *    "seeds".
 *  - Solids (kernel-solids.ts): 6 numbers per piece, its centre and a chart rotation times its circumradius, as in
 *    the polyhedra space's kernel; soft shapes t P (+) B((1 - t) rho), the pairs' penetration depth by the polyhedra
 *    simulator's separating-axis test, and the farthest point's protrusion max_v |X_v| + (1 - t) rho - s from the
 *    ball. Capabilities "shape", "seeds" and "swap".
 *  - finish() is the space's own finishing (kernel-rule.ts): the search's legalization and polish of a start with
 *    the clearance BALLS_CLEARANCE, the polish from the size the pieces need, each result checked with the
 *    validator at tolerance 0 and a valid input kept as a result itself; it polls the stop.
 *  - validate() is the server's rule for a balls submission (kernel-rule.ts): the configuration's form and limits,
 *    s against the problem's bound (ballsBound) with the server's slack, the validator at the touching tolerance
 *    1e-9 and, since the space has no research records and the server so asks it of every entry, at the strict
 *    tolerance 1e-11 too. Once the space has records, the server asks the strict check only of an entry that beats
 *    one, and this rule is stricter than the server's for the others; a finished configuration (valid at tolerance
 *    0) passes either way.
 *  - seeds() are the lattice cuts of the search's new starts, legalized; every random number comes from the stream
 *    the methods pass in.
 *  - finishCost and validateCost are measured (each kernel file states its fit; docs/spaces/BALLS.md has the
 *    numbers).
 *
 * P runs from BALLS_MIN_P to BALLS_MAX_P, the catalogue's and the server's range; the factory refuses any other.
 */
import type { SpaceKernel } from "@polypack/methods";
import { BALLS_MAX_P, BALLS_MIN_P, formatBallsId } from "./catalogue";
import { ballPiecesKernel } from "./kernel-balls";
import { solidPiecesKernel } from "./kernel-solids";
import { ballsBound, getBallsProblem } from "./problems";

export { BALLS_SERVER_RULE, BALLS_STRICT_REASON } from "./kernel-rule";

export function ballsKernel(problem: { code: string; P: number }): SpaceKernel {
  const pb = getBallsProblem(problem.code);
  if (!pb) throw new Error(`unknown balls problem ${problem.code}`);
  const P = problem.P;
  if (!Number.isInteger(P) || P < 1) throw new Error("P must be a positive integer");
  // the server refuses a P outside its catalogue's, so no state of another P could ever be submitted or kept
  if (P < BALLS_MIN_P || P > BALLS_MAX_P)
    throw new RangeError(`P must be from ${BALLS_MIN_P} to ${BALLS_MAX_P}, the P the server accepts`);
  const common = { id: formatBallsId(pb.code, P), bound: ballsBound(pb, P).value };
  return pb.piece === "ball" ? ballPiecesKernel(pb, P, common) : solidPiecesKernel(pb, P, common);
}
