# fresh-flat

A search for Flat problems (P regular N-gons of side 1, or disks of diameter 1, in the smallest regular
M-gon or circle), written from scratch for the fresh-solvers experiment (`native/FRESH.md`):

    fresh-flat --id flat/N/M/P --seconds S --seed K [--evals E]

One thread; the clock is the thread's CPU time; with `--evals E` the run stops after E evaluations of the
objective and repeats exactly for the same id, seed and E (no decision reads the clock, only the stop). It
prints one JSON line: the best packing, its score from `polypack_flat::validate::server_check` (valid and
strict) and the trace of improvements. From `polypack-flat` it uses only the conventions (`shapes`), the
clock and that check, never the port's search code.

## Method

**Frame.** The container is fixed at the origin with phi = 0 (pieces turn freely, so nothing is lost);
its size s is a variable. A packing is reported with `container_phi = 0`; the check computes the smallest
container at that angle, so containment never makes a packing invalid, only pair overlap does.

**Objective** (`src/model.rs`). For a pressure w > 0, minimise

    G = sum over near pairs of the pair penalty + sum over pieces of the wall penalty + w * s

- Polygons: every near pair (i, j) carries its own separating line, a unit normal u = (a, b)/|(a, b)| and
  an offset beta from the pair's midpoint, as extra variables. The pair penalty is
  sum over vertices v of i of max(0, u.(v - m) - beta)^2 plus sum over vertices of j of max(0, beta - u.(v - m))^2.
  It is zero exactly when the line separates the two polygons, and it is continuously differentiable in
  the poses and the line, also at face-to-face contacts where a separating-axis depth has kinks.
- Disks: max(0, 1 - |c_i - c_j|)^2.
- Walls: for every vertex (or disk centre), max(0, n.v - apothem)^2 over the container's edge normals,
  or max(0, |v| - s/2)^2 for a circle.

All gradients are analytic (tested against central differences). Near pairs are listed once per local
minimisation (bounding circles within a skin of R/2) and the list is rebuilt when a piece has moved a
quarter of R; a stored line is replaced by the separating-axis line of the pair when that one has the
smaller penalty. Vertices are rebuilt once per evaluation from one `sin_cos` per piece; nothing allocates
in the loop.

**Minimiser** (`src/lbfgs.rs`): L-BFGS, memory 7, Armijo backtracking with quadratic interpolation.

**Why a pressure.** w trades overlap for container size: the minimiser of G is a slightly overlapping
packing whose overlap shrinks in proportion to w. A large w (0.03) makes the landscape soft: a local
minimisation after a perturbation takes 100 to 400 iterations, where w = 1e-4 took thousands (the
pieces creep under a tiny force). So the search explores at w = 0.03 and compares candidates by their
soft size s, and only candidates that beat the best soft size are taken down the pressure ladder.

**Polish, repair, check** (`src/search.rs`). A new best soft packing is minimised once at w = 1e-5 (the
quick polish), then repaired and checked; the best one is later taken down to w = 1e-11 (deep polish) at
the end of each epoch and in the last 3 % of the budget. Repair: the solver's own exact separating-axis
separation (`geom::sat_sep`) finds the deepest pair; the centres are spread from the origin by a factor
1 + lambda (orientations kept), doubling lambda until every pair is separated by at least 1e-13. Spreading
never decreases a pair's separation (the separation along a ray from the origin of a convex body
containing the origin is monotone), and it costs about the remaining overlap in score. Only packings that
pass `server_check` with valid and strict enter the trace. Polishing is capped at a quarter of the
evaluations (counted, not timed, so runs repeat); a capped candidate waits and is polished later.

**Search.** Monotonic basin hopping in epochs. An epoch starts from

- random centres with random angles, or with angles aligned to the container's bottom edge (odd N: half
  of them turned over), at a container 1.45 times the area bound, or
- a patch of a periodic arrangement (`src/lattice.rs`): rows of pieces in one orientation, or for odd N
  alternating vertex-up and vertex-down, with every spacing and the row offset found by bisection on the
  exact separation (squares, hexagons and triangles come out as their tilings, disks hexagonal, octagons
  at density 0.906). Of 40 random turns (mostly aligned with a container edge) and shifts, one of the
  best three by the size of container its P best-placed pieces need is used,

and is minimised at the exploring pressure. Then it perturbs the current packing and minimises again,
keeping the result when its soft size is smaller, until 40 + 3P perturbations in a row have failed. The
perturbations: shake every piece (up to 0.4 R; half the time the angles too), move one piece to a random
point or to the roomiest of 24 sampled points (half the time each), shake a neighbourhood hard, turn one
or two pieces, turn a piece over (half a period), give a piece its nearest neighbour's orientation.

**Giving up on a hop.** G only decreases during a minimisation, so G/w after 50 iterations bounds the
hop's final s + E/w from above, and the current packing's s + E/w is known. A hop whose G/w is still more
than 2 % above the current packing's at iteration 50 is abandoned. On logged hops this skipped 26 to 44 %
of the iterations and lost 4 to 9 % of the accepted hops.

## Development knobs

`FRESH_DEBUG=1` prints the epochs, polishes, hop statistics and move success counts on stderr. Tuning
overrides (environment, development only; defaults in `Params::for_problem`): `FRESH_W` (exploring
pressure), `FRESH_FAILS`, `FRESH_LAT` (share of lattice starts), `FRESH_LATC`, `FRESH_WQ`, `FRESH_SHARE`,
`FRESH_HOLE`, `FRESH_GTOL`, `FRESH_SKIN`, `FRESH_MEM`, `FRESH_MOVES`, `FRESH_VNS`, `FRESH_ELITE`,
`FRESH_ADAPT`, `FRESH_ABORT_IT`, `FRESH_ABORT_M`. `examples/conv.rs` prints the convergence of one local
minimisation; `examples/lat.rs` the densities of the periodic arrangements.

## Files

- `src/geom.rs`: shapes, container gauge and fit, exact separating-axis separation.
- `src/model.rs`: the objective and the local minimisation driver.
- `src/lbfgs.rs`: the minimiser.
- `src/lattice.rs`: periodic arrangements for starts.
- `src/search.rs`: starts, basin hopping, polish, repair, check, trace.
- `src/main.rs`: the command line and the JSON output.
- `tests/agreement.rs`: the solver's separation and container fit against `server_check` on random cases,
  short runs on all 42 shape pairings pass the check, `--evals` runs repeat.

## Measurements

Machine: the shared Apple Silicon Mac (6 performance + 2 efficiency cores) with three other benchmark jobs and
desktop applications running; load averages were 9 to 58 during these runs. All clocks are CPU time, so the
load mostly stretches wall time, but a thread may also land on an efficiency core or lose cache, which adds
noise of perhaps tens of percent to any single time below. The coordinator's quiet 60-second run is the
authoritative one.

### Harness, 20 CPU seconds

`native/tools/fresh/run.py --only <the 10 flat problems of problems.json> --solvers js,port,fresh --seeds 1,2
--seconds 20 --concurrency 2`, then `validate.mts` and `analyze.py --times 1,5,20`. All 60 packings are valid
for the server's TypeScript validators. R is the best final score of any run. Times are CPU seconds to
reach R (1 + eps); the port's and the JavaScript's traces are recorded at the end of each job, so their times
are coarse (this favours fresh by up to one job length, about 0.4 s for the port).

| solver | reach 1 % | median t (s) | reach 0.1 % | median t (s) | reach 0.01 % | median t (s) | gap at 1 s | gap at 5 s | gap at 20 s |
|---|---|---|---|---|---|---|---|---|---|
| fresh | 20/20 | 0.26 | 18/20 | 0.36 | 17/20 | 0.21 | 0.44 % | 0.068 % | 0.036 % |
| port | 20/20 | 0.42 | 18/20 | 0.44 | 12/20 | 0.43 | 0.42 % | 0.077 % | 0.029 % |
| js | 19/20 | 3.76 | 12/20 | 4.73 | 10/20 | 7.08 | - | 0.41 % | 0.16 % |

Geometric mean of the speed ratio over the (problem, seed) pairs where both reach the target: fresh is
2.9x faster than the port to 1 % (20 pairs), 2.7x to 0.1 % (16 pairs; 2 more reached by fresh only, 2 by
the port only) and 6.2x to 0.01 % (12 pairs; 5 more by fresh only, none by the port only); against the
JavaScript 28x, 51x and 88x.

Per problem (score at 20 s; CPU seconds to 1 %, 0.1 %, 0.01 % of R; "-" not reached):

| problem | R | fresh seed 1 | fresh seed 2 | port seed 1 | port seed 2 | js seed 1 | js seed 2 |
|---|---|---|---|---|---|---|---|
| flat/0/0/27 | 5.906398 | 5.906410 (0.00, 0.03, 0.03) | 5.906410 (0.02, 0.02, 0.02) | 5.906410 (0.24, 0.24, 0.74) | 5.906398 (0.23, 0.23, 0.23) | 5.906398 (6.00, 6.00, 6.00) | 5.906398 (6.00, 6.00, 6.00) |
| flat/3/8/32 | 1.828830 | 1.828830 (0.36, 7.89, 8.15) | 1.831889 (2.03, -, -) | 1.833274 (1.00, -, -) | 1.829321 (0.94, 13.14, -) | 1.834732 (11.80, -, -) | 1.835294 (6.00, -, -) |
| flat/5/8/24 | 3.287289 | 3.287299 (0.86, 3.33, 3.33) | 3.287289 (0.37, 2.79, 2.79) | 3.287437 (0.41, 1.87, 1.87) | 3.287349 (0.41, 0.41, 2.33) | 3.305170 (17.43, -, -) | 3.292270 (3.43, -, -) |
| flat/5/8/33 | 3.821990 | 3.821990 (0.51, 0.51, 0.73) | 3.842937 (1.21, -, -) | 3.822423 (0.96, 0.96, -) | 3.822605 (0.96, 1.46, -) | 3.822603 (5.62, 5.62, -) | 3.822021 (3.84, 3.84, 9.06) |
| flat/7/0/14 | 9.317656 | 9.317657 (0.03, 0.11, 0.11) | 9.317659 (0.03, 0.10, 0.10) | 9.317656 (0.38, 1.38, 6.43) | 9.317667 (0.38, 0.88, 8.64) | 9.318190 (2.54, 2.54, 8.89) | 9.318019 (2.59, 2.59, 8.15) |
| flat/7/3/11 | 11.499977 | 11.499977 (0.01, 0.01, 0.01) | 11.499977 (0.05, 0.05, 0.05) | 11.499977 (0.42, 0.42, 0.42) | 11.499977 (0.42, 0.42, 0.42) | 11.499981 (2.85, 5.76, 9.37) | 11.499994 (2.58, 2.58, 2.58) |
| flat/7/3/24 | 16.130538 | 16.130546 (0.20, 1.02, 1.34) | 16.130538 (1.15, 1.15, 1.31) | 16.132340 (0.46, 1.89, -) | 16.134837 (0.44, 0.44, -) | 16.159069 (3.76, -, -) | 16.160143 (7.47, -, -) |
| flat/7/3/38 | 20.095224 | 20.095224 (0.32, 1.10, 1.10) | 20.097455 (0.60, 1.87, -) | 20.113076 (0.50, 0.50, -) | 20.122985 (0.50, -, -) | 20.158242 (10.89, -, -) | 20.325629 (-, -, -) |
| flat/8/6/12 | 5.386696 | 5.386700 (0.03, 0.03, 0.07) | 5.386696 (0.21, 0.21, 0.21) | 5.386697 (0.43, 0.43, 0.43) | 5.386713 (0.42, 0.42, 0.42) | 5.386696 (2.07, 2.07, 2.07) | 5.386696 (2.05, 2.05, 2.05) |
| flat/8/8/21 | 5.196949 | 5.196958 (0.59, 0.59, 0.59) | 5.196949 (0.17, 0.17, 0.17) | 5.196983 (0.42, 0.42, 0.42) | 5.196981 (0.42, 0.42, 0.42) | 5.198417 (2.90, 16.40, -) | 5.196954 (2.33, 6.34, 14.63) |

### What the tuning showed

Development runs: 5 CPU seconds, 2 seeds, on the 10 benchmark problems plus a random validation set (0/5/13,
3/5/28, 4/0/24, 4/5/28, 5/4/18, 5/6/38, 6/5/28, 6/8/40, 7/3/31, 8/3/24, 8/4/15), compared by the geometric
mean of the time to 1 %, 0.1 % and 0.01 % of the best score known from all runs (a miss counted as twice the
budget). Single-seed differences on the hard problems are large, so only big effects are trustworthy;
the later comparisons ran the two variants side by side so that both saw the same load.

| change | effect |
|---|---|
| explore at w = 0.03 instead of 1e-4, quick polish, deep polish later | the step that made the method competitive: hops 10-30x cheaper; at 10 s it beat the port's 20 s score on 8 of 14 problems |
| periodic-arrangement starts (half of the starts) | squares, hexagons, octagons and triangles found their ordered optima (4/4/20 = 5, 6/6/30 = 6) |
| relocation to the roomiest of 24 points (half of relocations) | time to 0.1 %: 0.43 -> 0.33 s, mean gap 0.079 -> 0.050 % |
| w = 0.01 or 0.1 instead of 0.03 | worse (0.1: time to 0.01 % 0.41 -> 0.70 s) |
| hop gradient tolerance 0.1 w or 0.003 w instead of 0.01 w | worse (0.1 w: noisy acceptance, 2.7x slower to 0.1 %) |
| skin R instead of R/2 | fewer list rebuilds but slower overall |
| scored lattice patches (40 turns and shifts) instead of one random | hard problems: time to 0.1 % 5.9 -> 4.9 s, gap slightly worse; kept |
| giving up hopeless hops at iteration 50 | mean gap 0.087 -> 0.051 %, time to 1 % slightly worse; kept |
| restarts near the best packing, adaptive choice of start, 75 % lattice starts, reweighted moves, longer epochs | not better within the noise; off |

### Weak spots

- `flat/5/8/33` is bimodal: a run either reaches about 3.8220 (better than the port) or stays 0.5 to 0.9 %
  above it in a disordered basin for 10 to 20 s (about half of the seeds tried). The good packings are double
  lattices (two orientation clusters a pentagon flip apart); the port reaches 0.01 to 0.02 % on every seed.
- `flat/3/8/32` (two tiling patches at slightly different angles) and `flat/7/3/38` vary by 0.1 to 0.3 %
  between seeds, as they do for the port.
- `flat/0/0/27`: both 20-second runs ended at 5.906410, a neighbouring optimum 2e-6 above the 5.906398 that the
  port (one seed) and the JavaScript found. At the exploring pressure the two cannot be ranked.

## What to try next

- A Gauss-Newton (Levenberg-Marquardt) polish: the objective is a sum of squares, and with the line
  variables eliminated block by block the normal equations are 3P + 1 unknowns. Near a jammed packing it
  would converge in a handful of steps where L-BFGS takes about 500 per pressure stage, so the quick polish
  could run on every candidate and rank near ties exactly.
- A population (a few epochs kept alive and hopped in turn, with a distance test between them) instead of
  independent epochs, to make the hard problems less seed-dependent.
- Denser periodic starts for odd N: optimise the two-piece cell of a double lattice with the same penalty
  objective (pentagons reach 0.921 in the literature against 0.864 here, heptagons 0.893 against 0.880).
