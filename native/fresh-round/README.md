# fresh-round

A search for disks at constant curvature written from scratch, for the fresh-solvers experiment
(`native/FRESH.md`): `curved/<K>/0/<M>/<P>` (disks of diameter 1 in a disk or regular M-gon
container at curvature K != 0) and `sphere/0/<P>` (P disks on a sphere, Tammes' problem). One engine
serves both.

    fresh-round --id ID --seconds S --seed K [--evals E]

prints the contract's JSON line. Experiment flags (defaults are what was measured): `--mbh`,
`--delta`, `--patience`, `--mu0`, `--mu-max`, `--explore-tol`, `--max-iter`, `--max-outer`, `--memory`,
`--polish-outer`; `FRESH_STATS=1` / `FRESH_DEBUG=1` print statistics / a trace to stderr. Only `polypack-curved` / `polypack-sphere` / `polypack-spaces`
definitions are used (curvature functions are re-derived here; `curved_max_p` decides that a problem
cannot exist; `centre_of` turns a quaternion into the centre the validator sees) and the check
`validate_space_submission(.., &SpaceValidateOptions::default())` on candidates. Nothing of the
existing searches is used or ported.

## Method

**Representation.** Every centre is an ambient vector v = (v0, v1, v2) with
v0^2 + K (v1^2 + v2^2) = 1, so that the bilinear form <a, b> = a0 b0 + K (a1 b1 + a2 b2) is
cs_K(distance). Charts (unconstrained, so plain L-BFGS applies):

- K < 0: the hyperboloid's spatial part w in R^2, v = (sqrt(1 - K |w|^2), w) (one sqrt per point);
- K > 0 and the sphere: any u in R^3, v = u / sqrt(u0^2 + K (u1^2 + u2^2)) (isotropic, no chart
  distortion; the radial direction is a null direction of every function).

**Constraints** are all bilinear or linear in v, no trigonometry in the inner loop:

- pair: (<v_i, v_j> - cs(D)) / K <= 0 (= vs(D) - vs(d_ij), D = 1 + 2e-15);
- disk container, size variable R' = r - 1/2: (1 - v0) / K <= sign(R') vs(|R'|);
- M-gon container, size variable h (apothem): wall covector n = (-sn h, cs h cos a, cs h sin a),
  n . v + sn(1/2) <= 0;
- sphere, size variable c = cos(theta_min): v_i . v_j - c <= 0, score rho = 1 / acos(c).

Gradients are analytic (`tests/gradient.rs` checks them against finite differences). Pairs come from
a neighbour list (pairs within D + 0.35, or 1.4 contact angles on the sphere) rebuilt when a point
has moved by a quarter of the skin; all buffers are allocated once.

**Local solvers.**

- *Augmented Lagrangian*: minimise sigma + (mu/2) sum max(0, o + lambda/mu)^2 with L-BFGS (memory
  8, Armijo backtracking with interpolation), multipliers updated between solves, mu x4 when the
  largest violation does not fall by 4. Used from every start and to optimise a new best.
- *Overlap energy at a fixed size*: E = sum max(0, o)^2 with sigma held (L-BFGS). E = 0 exactly
  once a configuration fits, so the test "fits at this size" is cheap and sharp.
- *Contact Newton polish*: Gauss-Newton with minimum-norm steps on o_c = 0 for the near-active
  constraints (multiplier > 0 or o > -eps), sparse rows (7 nonzeros), J J^T by Cholesky, violated
  constraints added to the system; tried for eps = 1e-12 ... 1e-4 and the best configuration that
  violates nothing is kept. This closes the contacts to ~1e-15, so no safety margin is needed.

**Global search (frontier search).** Start (random by area in the container / hexagonal patch in
exponential coordinates / random or golden-spiral points on the sphere), augmented-Lagrangian solve,
polish. Then hop at a fixed target size a hair (1e-7 relative) below the best packing found: perturb
(jitter all points, jitter the points near a random one, or re-seat 1-3 points into the largest of 24
sampled holes), minimise E at the target, accept when E decreases; when E reaches 0 the move has beaten
the best: optimise that basin (augmented Lagrangian, Newton), check it, record it, and move the target.
After 20 + 2P failed hops, restart. (`--mbh` selects plain monotonic basin hopping on the
augmented-Lagrangian optimum instead; it is slower on the sphere because the max-min solves creep.)

**Validity.** `finish` turns the variables into the submission format (exponential coordinates
for curved, a quaternion rotating e3 to the centre for the sphere, chosen so that no component
cancels), computes the exact tight size from the centres (disk container: max distance + 1/2; M-gon:
max over walls of beta + asn(sn(1/2) / A), the same closed form as the validator's), relaxes it by
2e-15 relative, and the check `validate_space_submission` decides. Only checked packings enter the
trace; the final one is checked again in `main`. A problem that `curved_max_p` rules out prints a null
result at once.

## Tests

`cargo test --release -p polypack-fresh-round`:

- `tests/geometry.rs`: distances, cs of the bilinear form and distance from O against the validator's
  `centre_distance` (K = -1, -0.25, 0.5, 1, 2000 random pairs each); our tight container size against
  the validator's `tight_size` for single disks (K = +-1, -0.5, M = 0, 3, 4, 5, 6, 8) and that 1e-6
  smaller fails; the signs of our constraints against the validator's verdict on random
  configurations; sphere centres and pair gaps against `centre_of` and `pair_gaps`;
- `tests/gradient.rs`: analytic gradients against central differences;
- `tests/runs.rs`: short seeded runs (evaluation budgets) on 7 problems pass the check; the same seed
  and budget give the same result; the icosahedron (P = 12) and octahedron (P = 6) are found;
  impossible problems are recognised.

## Measurements

All on the shared Mac while three other benchmark jobs ran (load average 9 to 24 at first, over 100 at the
end; CPU-time clocks, at most two of my runs at a time), so treat ratios as indicative: the coordinator's
60 s run on a quiet machine is the measurement. Harness `native/tools/fresh/` (`run.py`, `validate.mts`,
`analyze.py`), 15 s CPU, seeds 1 and 2, the curved and sphere problems of `problems.json` that have
any packing. R = the best TypeScript-valid score of all runs. Gap = score / R - 1 (seed 1 / seed 2);
t = CPU seconds to reach R (1 + 1e-3).

| problem | R | port gap at 15 s | js gap at 15 s | fresh gap at 15 s | port t 1e-3 | js t 1e-3 | fresh t 1e-3 | fresh t 1e-6 |
|---|---|---|---|---|---|---|---|---|
| curved/-1/0/6/6 | 2.5182163068 | 0 / 0 | 0 / 0 | 0 / 0 | 0.33 / 0.56 | 3.2 / 5.0 | 0.0017 / 0.0012 | 0.0017 / 0.0012 |
| curved/-1/0/0/17 | 4.1736232878 | 1.6e-12 / 1.6e-12 | 1.6e-12 / 1.6e-12 | 0 / 0 | 0.89 / 0.65 | 1.0 / 1.0 | 0.0042 / 0.0031 | 0.0042 / 0.0031 |
| sphere/0/30 | 1.4844575326 | 3.5e-8 / 2.2e-8 | 2.7e-8 / 2.0e-8 | 0 / 0 | 1.3 / 0.94 | 1.0 / 1.0 | 0.0066 / 0.021 | 0.0066 / 0.021 |
| sphere/0/35 | 1.6221996500 | 4.5e-4 / 2.0e-3 | 4.0e-3 / 5.0e-4 | 0 / 0 | 5.1 / - | - / 14.6 | 0.041 / 0.037 | 0.10 / 0.21 |
| sphere/0/46 | 1.8506888772 | 8.3e-3 / 9.2e-3 | 9.0e-3 / 8.4e-3 | 0 / 0 | - / - | - / - | 0.14 / 0.55 | 0.18 / 1.0 |
| sphere/0/50 | 1.9257171875 | 1.1e-2 / 6.2e-3 | 9.9e-3 / 7.6e-3 | 0 / 0 | - / - | - / - | 0.21 / 0.17 | 0.46 / 0.35 |
| sphere/0/62 | 2.1471962960 | 3.5e-3 / 3.0e-3 | - / 9.2e-3 | 0 / 0 | - / - | - / - | 0.46 / 0.54 | 0.63 / 1.7 |
| sphere/0/65 | 2.1977810989 | 4.3e-3 / 6.2e-3 | 1.6e-2 / 7.8e-3 | 0 / 0 | - / - | - / - | 0.51 / 0.52 | 0.94 / 3.0 |

(- : not reached, or, for js sphere/0/62 seed 1, a run starved by the load. Four fresh runs of the
harness, sphere/0/35, 46 and 62 seed 1 and 46 seed 2, were killed by the harness timeout when the load
passed 100 (port and js runs died the same way); their rows use the same binary, budget and seeds run
directly, TypeScript-validated.) analyze.py over the same runs: fresh reaches 1e-2 / 1e-3 / 1e-4 of R
about 40 / 90 / 90 times sooner than the port on the sphere (geometric mean over pairs where both
reach it) and 250 to 340 times sooner on the two curved problems; mean gap at 5 s: fresh 2e-16, port 5.5e-3,
js 9.4e-3.

Earlier, smaller checks: sphere/0/80 at 10 s (3 seeds) ends within 2e-6 of the best of all my runs
(2.43263418); a 1 s run of every problem the catalogue allows here (K = +-1, M in {0, 3, 4, 5, 6, 8},
P 5..30 under `curved_max_p`, sphere P 5..80: 166 problems) gave 124 packings, all accepted by the
TypeScript validator, and every sphere P <= 40 equal to Cohn's table of spherical codes (Tammes, via
`data/sphere/literature.json`) within 1e-9. The 42 curved problems without a packing are polygon
containers at K = -1 near the ideal polygon and K = 1, P = 7, 8; the port finds none either on the 8 of
them I tried (10 s each).

## Caveats and what next

- The machine was heavily loaded throughout (see above); the port's space jobs have wall-clock
  deadlines, so load costs it more than the CPU-clocked fresh and js. The port and js traces are
  coarse (a job's result is seen when the job ends, up to a quarter of the budget), which favours
  fresh in time-to-target by up to one job length (README of the harness); the sphere gaps at 15 s
  do not depend on that.
- The benchmark's curved draw is weak: of the 8 curved problems in `problems.json`, 4 cannot exist by
  the catalogue's own `curvedMaxP` (`curved/1/0/0/17`, `curved/-1/0/4/28`, `curved/1/0/5/10`,
  `curved/-1/0/8/29`: `problemOf` returns a NoRecord entry with a null bound for them; fresh prints
  null at once), 2 have no packing from any solver (`curved/1/0/0/7`, `curved/-1/0/8/14`), and the
  other 2 are solved to the same optimum by all three. Filtering the draw with `curvedMaxP` (or the
  domain's `impossible`) and preferring the disk container at K = -1 would make the family informative.
- Last digits: the Newton polish closes the contacts of the near-active set, which is the local
  optimum when that set is the optimum's vertex; otherwise the result is valid but can sit ~1e-12
  (curved) to ~1e-9 (sphere, seen once) above the true local optimum.
- Only N = 0 (disks) and K != 0; K = 0, polygons and other ids print a null result. The forms divide
  by K (o = (<u, v> - cs D) / K), so tiny |K| (the catalogue's +-1e-6) would lose digits: the
  benchmark only has K = +-1.
- `--evals E` makes a run reproducible (tested); evaluations count L-BFGS function+gradient calls and
  Newton steps, not the port's restarts and hops.

What I would try next: a real KKT polish (active-set SQP: drop contacts with negative multipliers and
move along the contact manifold) for exact local optima; a 2-coordinate tangent chart on the sphere
(L-BFGS's own vector work is about half the time at P = 80); holes from the Voronoi vertices rather
than 24 samples; adaptive perturbation strength; series forms of the constraints for small |K|.
