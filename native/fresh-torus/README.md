# fresh-torus

A search for the torus problems `torus/<family>/<N>/<P>` (P congruent disks of diameter 1, N = 0, or regular
N-gons of side 1, N = 3..100, on a flat square `sq`, hexagonal `hex` or `free` torus; score L for sq and hex,
sqrt |det(b1, b2)| for free), written from scratch for the fresh-solvers experiment (`native/FRESH.md`):

    fresh-torus --id torus/<family>/<N>/<P> --seconds S --seed K [--evals E] [--verbose]

and the library entry point `fresh_torus::fresh_search(&FreshJob, on_improve)` of
`polypack_spaceauto::fresh` (CPU budget, wall deadline, stop flag, evaluation budget, an optional valid `start`
that is never returned worse, `on_improve` on each checked improvement, `Err` for ids that are not torus
problems). One thread; the clock is the thread's CPU time; with `--evals E` a run is a function of (id, seed, E)
only. From `polypack-spaces` it uses the id rule and the server's check, from `polypack-flat` the clock; it never
calls or ports the existing torus searches (`native/torus/src/{search,overlap,auto}.rs`, `packages/torus/src/search*`,
`packages/spaces/src/search/*`). The tests compare its geometry with the validator's (`polypack-torus`, a
dev-dependency).

## Method

**Frame and variables** (`src/model.rs`). A relaxation runs at a fixed score s. For sq and hex the cell is the
family's at score s; for free it is upper triangular with det = s^2, B = [[s e^(T/s), U], [0, s e^(-T/s)]], and
T, U are variables, so the cell's shape is optimised with everything else (the score is fixed, the area too).
Centres are variables y_i in the frame of the cell at the last list build, the actual centres F y_i with
F = B B_ref^{-1} (an affine deformation of the whole packing, as in Torquato and Jiao's adaptive shrinking cell).
Every variable is a length: angles as R theta, line turns as R t, so one L-BFGS step moves everything by comparable
amounts, also for 100-gons.

**Energy.** Over the near image pairs (i, j, lattice vector k), with d = F (y_j - y_i + B_ref k):

- disks: max(0, 1 - |d|)^2;
- polygons: each near pair carries a separating line, offset beta from the pair's midpoint and direction
  u = (u0 + t u0') / sqrt(1 + t^2) (a local chart about the direction u0 at the last build, so two variables per
  pair and no scale zero mode); the penalty is the sum of squared distances of the vertices that lie beyond the
  line on the wrong side. It is zero exactly when the line separates the pair, and C^1 in everything.

Only the vertices beyond a line are visited: the extreme vertex in the line's direction is found by climbing from
the one cached at the previous evaluation (the vertices of a regular polygon are equally spaced), then the walk
goes both ways while vertices are beyond the line. Near contact a pair costs O(1) whatever N, which is what makes
100-gons affordable; a bounding-circle test skips pairs whose circles are on their sides of the line. All
gradients are analytic, including the free cell's shape (tested against central differences).

**Neighbour lists.** Image pairs whose centres are within 2R + skin are listed by the Cramer window of every
lattice vector that can reach (any basis), over all pairs of pieces, or for P >= 48 over a grid of the cell in
fractional coordinates (cells at least one window wide). The list is rebuilt when an unlisted pair could have come
within 2R: sigma_min(F) (cut - 2 max |y_i - y_i0|) < 2R, which covers the free cell's deformation too.

**Repair and check** (`src/geom.rs`, `src/search.rs`). The solver's exact separation of two pieces is the
separating-axis gap over the 2N edge normals (support of a regular polygon in closed form). A candidate is
repaired by the least uniform scaling of centres and lattice that separates every image pair by
1e-13 + 4e-16 s: along a fixed axis the gap of a scaled pair is lambda n.d - w(n), so each pair's factor is exact.
Then the free basis is Lagrange-Gauss reduced and turned so b1 lies along +x, centres are wrapped into the cell,
angles reduced to one period, the solver's own minimum separation is checked, and the configuration goes to
`validate_space_submission` with `no_record: true` (the strict check at tolerance 1e-11, which implies the default
check with the same score). Only packings it accepts enter the trace and the result; if it refused one, the
scale would be enlarged by 1e-12, 1e-10, ... and checked again (it refused none of the 4183 candidates checked in
387 recorded development and benchmark runs).

**Constructive phase** (`src/lattice.rs`): valid packings at once, for every family, N and P (P = 500 included,
first packing in at most about 0.1 s):

- sq, hex: every superlattice of index P of the cell (Hermite normal forms), all pieces at one angle; the least
  scale is the largest exact contact factor over Gamma's short vectors (only vectors at most R/r times the
  shortest can bind), minimised over the angle (grid and golden section); forms are pruned by the 2r / |shortest|
  lower bound;
- free: the better of the square and hexagonal lattice packings at their best angles, the torus being the
  sublattice of index P whose reduced basis is roundest;
- odd N: double lattices (pairs at theta and theta + pi, as triangles tile and pentagons pack densely); the
  motif's angle and offset (and for free the cell's shape) are optimised on a two-piece torus over Gamma (grid,
  then a pattern search with random directions on the non-smooth contact factor);
- vacancies: the same arrangements for P + k pieces (k = 1..3) with k pieces left out (P = 48 triangles on the
  hexagonal torus: the 5 x 5 tiling with two holes).

All are offered (repaired and checked), and the best four are polished.

**Polish.** Below the jamming score s* of an arrangement the relaxed energy is about k (s* - s)^2, so sqrt(E)
is nearly linear in s. Trials relax at a score just below the secant estimate of s* from the two latest
infeasible trials (the step is shortened after a trial that lands on the feasible side and lengthened again
after an infeasible one; with only one infeasible trial the slope remembered from the last polish is used); each
trial's repair is a valid upper bound. The relaxation tolerance tightens as the bracket narrows. Candidates are
polished to 1e-9 relative; the best is polished once more to 2e-13 at each restart and in a reserve of 3 % at the
end of the budget. A polish stops as soon as its bracket shows the arrangement cannot beat the best.

**Search.** Monotonic basin hopping at a score s_t = best (1 - 1e-3): perturb the current arrangement, relax at
s_t, accept when the energy is lower (by more than 2e-5 relative). Moves, chosen with probabilities that follow
their success: jitter everything (and half the time the angles), jitter a neighbourhood, move 1-3 pieces (the
most squeezed or random ones) to the emptiest of 24 sampled places, turn pieces (random, half a period, a
neighbour's angle), and for free tori stretch or shear the cell. A hop that relaxes back to within 0.01 width of
the current arrangement stops early (same basin); a hop whose energy after 200 iterations is still ten times the
current one is given up (on recorded hops this saved 20-40 % of the iterations of polygon hops and lost 0-2 of
12-25 accepted hops). An accepted arrangement whose repair is within 0.5 % of the best is polished; a new best
resets s_t. After 40 + 3P rejections in a row the best gets its deep polish and the chain restarts at the same
s_t from the best shaken, random places, a lattice arrangement, or a vacancy or double lattice. A packing at the
lower bound (Thue's density for disks, (5 - sqrt 5)/3 for pentagons, (4 + 4 sqrt 2)/(5 + 4 sqrt 2) for octagons,
1 otherwise: tilings) ends the run (`stopped: "bound"`).

**Budget** (`src/budget.rs`). The evaluation budget is checked at every evaluation, the CPU clock, the wall
deadline and the stop flag every few milliseconds of work (the interval between clock reads adapts to the cost of
an evaluation). Decisions never read the clock, so runs with `--evals` repeat exactly.

## Files

- `src/geom.rs`: families, shapes, exact separation and contact factors, lattices (Gauss reduction, Cramer
  windows, the grid), repair, canonical frame.
- `src/model.rs`: the energy, its gradient, neighbour lists, the relaxation driver.
- `src/lbfgs.rs`: L-BFGS (memory 7, Armijo backtracking, a cap on each coordinate's move).
- `src/lattice.rs`: superlattices, free lattice packings, double lattices, vacancies, random arrangements.
- `src/search.rs`: the constructive phase, polish, basin hopping, restarts, the check.
- `src/lib.rs`: `fresh_search`; `src/main.rs`: the command line.

## Tests

    cargo test --release -p polypack-fresh-torus

- unit (`src/geom.rs`, `src/model.rs`): Gauss reduction keeps the lattice; the Cramer window equals a brute
  force; the energy's gradient matches central differences for sq, hex and free, N = 0, 3, 4, 5, 6, 9, 24, 60,
  P = 1, 2, 5 (lines away from their charts' centres, the free cell deformed); the O(1) vertex walk gives the
  same penalty as visiting every vertex (N up to 100).
- `tests/agreement.rs`: the pair separation equals the validator's (`polypack_torus::disk::separation_of`) to
  1e-12 on random pairs, half of them at touching distance +-1e-9, N = 0..100; the minimum over all image pairs of
  random packings (centres spread over three cells, skewed and turned free bases, P = 1..13) equals the
  validator's `min_sep`; repaired packings are valid for the validator at tolerance 0 and tight (min separation
  below 1e-9); scaling to first contact is valid and tight; the energy is zero exactly on valid packings; lattice
  and double-lattice starts pass the server's check for all families, N = 0..100, P = 1..101.
- `tests/runs.rs`: short runs on 13 problems (all families, N = 0..100, P = 1..60) give a result that passes the
  check at the reported score, with on_improve called in decreasing order, each improvement passing the check at
  its score; runs with an evaluation budget repeat exactly (score, configuration, count); the stop flag (set from
  another thread at 0.4 s) and a wall deadline (0.3 s) end a run within 0.2 s, the CPU budget within 0.2 CPU s
  (P up to 300); a valid start is never returned worse, and an invalid start is ignored; other ids are refused.

## Development knobs

`--verbose` prints statistics (evaluations, hops, polishes, restarts, move success); `FRESH_DEBUG=1` traces
improvements and polish trials, `FRESH_HOPS=1` each hop's energy at iterations 25-400;
`FRESH_PARAMS="eps=1e-3,memory=7,..."` overrides `search::Params`.

## Measurements

All numbers below are measured [MEASURED] on a shared 4-core Linux container while two other agents built and
benchmarked their own solvers (load average 5-9; a 20 CPU-second run took 21-40 s of wall time). The clocks are
CPU time, so the load mostly stretches wall time, but caches are shared and timings are noisy (tens of percent).
They are preliminary: the coordinator's run on a quiet machine is the one to trust.

### Harness, 20 CPU seconds

    (cd native && cargo build --release -p polypack-native -p polypack-fresh-torus)
    npx tsx native/tools/fresh/draw-torus.mts
    python3 native/tools/fresh/run.py --problems native/tools/fresh/problems-torus.json --seeds 1,2 --seconds 20 --concurrency 2 --out runs-torus.jsonl
    npx tsx native/tools/fresh/validate.mts runs-torus.jsonl runs-torus.v.jsonl
    python3 native/tools/fresh/analyze.py runs-torus.v.jsonl --times 1,5,20 > native/tools/fresh/report-torus.md

`native/tools/fresh/problems-torus.json`: 14 problems drawn by `draw-torus.mts` (seed 20261128): the family
uniform; N by classes so that disks, triangles, squares, hexagons, 5/7/8-gons, medium (9-29) and many-sided
(30-90) polygons all appear; P = 2-50 for 11 of them and 51-150 for 3; only ids that exist and accept submissions
(`problemOf`, `acceptsSubmissions`, finite bound), free tori of disks, squares and hexagons excluded (a lattice
settles them exactly). Commands (`--seeds 1,2 --seconds 20 --concurrency 2`, then `validate.mts`,
`analyze.py --times 1,5,20`); port and js were run once, fresh at commit 42d407f. All 84 final packings pass the
server's TypeScript validators with matching scores (`ts_valid`, `ts_score_match`). R is the best final score of
any of these runs; the port's and the JavaScript's trace times are recorded at the end of each of their jobs, so
their times are coarse (this favours fresh by up to one job length).

| solver | runs | valid | reach 1e-2 | median t (s) | reach 1e-3 | median t (s) | reach 1e-4 | median t (s) | gap at 1 s | gap at 5 s | gap at 20 s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fresh | 28 | 28 | 28/28 | 0.0083 | 27/28 | 0.0048 | 26/28 | 0.017 | 5.9e-4 | 3.8e-4 | 5.4e-5 |
| port | 28 | 28 | 6/28 | 0.72 | 6/28 | 0.76 | 6/28 | 0.86 | 0.59 | 0.37 | 0.22 |
| js | 28 | 28 | 6/28 | 1.14 | 6/28 | 6.36 | 6/28 | 6.36 | - | 0.43 | 0.23 |

(medians over the runs that reach the target; gaps are means of best-so-far / R - 1.) Geometric mean of the speed
ratio over the (problem, seed) pairs where both reach the target: fresh is 403x faster than the port to 1e-2,
444x to 1e-3 and 493x to 1e-4 (6 pairs each; 20-22 more pairs reached by fresh only, none by the port only), and
1000-1370x faster than the JavaScript. The 6 pairs both reach are the three easy problems (hex/0/6, hex/0/29,
hex/5/8); on the other eleven the port and the JavaScript end 2-110 % above R after 20 s.

Per problem: final gap to R of seeds 1 and 2, then the median CPU seconds to R (1 + 1e-2), (1 + 1e-3),
(1 + 1e-4) ("1/2": one seed reached it, "-": neither):

| problem | R | fresh | port | js |
|---|---|---|---|---|
| free/3/26 | 3.35534354 | 0, 5.6e-11 / 0.017, 0.017, 0.017 | 7.0e-2, 2.9e-2 / -, -, - | 7.4e-2, 5.2e-2 / -, -, - |
| free/5/30 | 7.48483209 | 1.2e-10, 0 / 0.037, 0.037, 0.037 | 6.4e-2, 2.8e-2 / -, -, - | 7.8e-2, 1.1e-1 / -, -, - |
| free/40/95 | 115.35284 | 0, 2.4e-15 / 0.0046, 0.0046, 0.046 | 0.98, 1.0 / -, -, - | 1.1, 1.0 / -, -, - |
| hex/0/6 | 2.64575131 | 1.3e-15, 0 / 0.001, 0.001, 0.001 | 6.9e-9, 6.4e-9 / 0.76, 0.76, 0.76 | 7.0e-9, 7.9e-9 / 1.14, 1.14, 1.14 |
| hex/0/29 | 5.56745381 | 0, 1.6e-14 / 0.001, 0.001, 0.001 | 3.9e-5, 5.6e-5 / 3.02, 4.64, 4.86 | 5.1e-5, 2.1e-5 / 10.7, 12.2, 12.2 |
| hex/3/48 | 4.96699634 | 0, 1.1e-3 / 0.03, 1/2, 1/2 | 7.3e-2, 6.8e-2 / -, -, - | 9.4e-2, 7.8e-2 / -, -, - |
| hex/4/38 | 6.82500148 | 0, 0 / 0.0018, 0.0018, 0.0018 | 5.6e-2, 5.0e-2 / -, -, - | 5.3e-2, 4.2e-2 / -, -, - |
| hex/5/8 | 4.41636517 | 0, 1.0e-14 / 0.012, 0.035, 0.035 | 2.6e-8, 2.8e-8 / 0.63, 2.73, 2.73 | 2.5e-8, 2.8e-8 / 1.0, 6.36, 6.36 |
| hex/6/27 | 9 | 0, 0 / 0.0018, 0.0018, 0.0018 | 1.8e-2, 1.8e-2 / -, -, - | 4.3e-2, 1.8e-2 / -, -, - |
| hex/6/75 | 15 | 0, 0 / 0.0047, 0.0047, 0.0047 | 0.18, 0.14 / -, -, - | 0.23, 0.22 / -, -, - |
| sq/4/42 | 6.559298 | 0, 0 / 0.0027, 0.0027, 0.0027 | 9.6e-2, 9.1e-2 / -, -, - | 0.10, 7.3e-2 / -, -, - |
| sq/9/41 | 17.1929249 | 0, 3.5e-4 / 0.18, 1.81, 1/2 | 5.8e-2, 5.5e-2 / -, -, - | 0.12, 6.1e-2 / -, -, - |
| sq/38/36 | 70.0150986 | 1.9e-6, 0 / 0.14, 0.58, 0.58 | 0.51, 0.36 / -, -, - | 0.38, 0.31 / -, -, - |
| sq/82/100 | 248.211227 | 0, 8.6e-7 / 0.020, 8.17, 9.04 | 1.1, 0.97 / -, -, - | 1.1, 1.1 / -, -, - |

Caveats: the port's space jobs have wall-clock deadlines (as in the client), so under this load it got less CPU
than its budget; its results here are probably worse than on a quiet machine [EST], though not by the 2-100 %
that separates it from fresh on eleven problems. The baseline runs and fresh's ran at different moments of the
session under similar load. Two seeds per problem; fresh's seed spread is large on the glassy problems (hex/3/48,
sq/9/41).

### Research records

The 16 certified records of `data/torus/records.json` tried (P = 9-16), 3 CPU seconds, seed 1, commit 42d407f:
fresh is within 3e-9 of 12 of them (time to the record + 1e-6 relative: 0.001-1.2 s, median about 0.1 s), better
than 3 (hex/4/11: 3.961452 against 3.983153, -0.54 %; hex/8/15: 9.967735 against 9.991605, -0.24 %; free/7/9:
6.065515 against 6.075992, -0.17 %; all pass the server's check at tolerance 1e-11), and worse on free/5/15
(5.327420 against 5.314990, +0.23 %; 4 of 4 seeds at 3 s end in the 5.32742 basin; an earlier build whose free
double-lattice motif did not optimise the cell's shape found 5.314990 in 0.04 s).

### Robustness

40 random ids (`sweep`: family uniform, N in {0, 3..8, 9-29, 30-100}, P from 1 to 500 with a third above 50),
2 CPU seconds each: all 40 results pass the check, the first packing came at most 0.084 s after the start
(P = 392), 11 runs stopped at a proven bound (free disks, squares, hexagons; hexagon tilings and a triangle
tiling of the hexagonal torus; free triangles of even P; free pentagons of even P). The tests' runs (above) cover P = 1 and P = 300.

## What did not help

Measured on the hard problems below (sq/9/41, hex/3/48, sq/5/33, sq/20/45, 3-4 seeds, 5-10 CPU s); single
seeds differ by up to 0.5 %, so only the larger effects are trustworthy.

| change | effect |
|---|---|
| polish every candidate to 2e-13 (instead of 1e-9, then the best to 2e-13) | polishing took 50-78 % of the evaluations on sq/9/41; with the two-level polish 30-50 %, and 2-4x more hops per second |
| secant trials 2 % of the step below the estimate (instead of 0.2 %, shortened after an overshoot) | 20-35 trials per polish instead of 5-13 |
| three line variables (a, b, beta) instead of the two-variable chart | 15 % fewer evaluations per second, same quality |
| a disk phase for many sides (25 % of the budget on the circumscribed disks, then polygons) | no better on sq/82/100, hex/61/108, hex/63/111, sq/38/36, hex/94/411, sq/50/300 |
| chains with their own reference score (each restart polished to its own jamming score first) | hex/3/48 reached its best on 1 of 4 seeds instead of 3 of 4 |
| L-BFGS memory 4 or 10, exploring tolerance 1e-5, hop compression 3e-4 or 3e-3, more restarts | within the noise |
| L-BFGS buffers swapped instead of copied, fused passes | no measurable speed-up |
| free tori: short searches for 1 and 2 pieces, repeated over sublattices, as extra starts | same final scores on free/10/7, free/12/9, free/20/13, free/9/23, free/7/9; the P-piece search reaches them within 0.3 s by itself |

## Weak spots and next steps

- **Glassy polygon problems depend on the seed.** hex/3/48 ends in one of three basins (4.96700, 4.97268,
  4.99600) depending on the seed, sq/9/41 and sq/5/33 vary by 0.05-0.1 %, free/5/15 ends 0.23 % above its record
  on the seeds tried (the record's basin is reached from some double-lattice starts and not others). A population of chains with a
  distance test, or longer chains with adaptive compression, are the obvious next things to try; the
  chain-level references tried here (above) were worse.
- **L-BFGS overhead.** With two line variables per polygon pair, the L-BFGS recursion costs about as much as the
  energy (callgrind: 41 % against 43 % on sq/5/33). A Gauss-Newton (Levenberg-Marquardt) polish with the line
  variables eliminated pair by pair (a 3P x 3P system) should make the jamming polish converge in a few steps
  where L-BFGS takes hundreds.
- **Large P.** At P >= 200 a hop relaxes every piece (a few milliseconds per hop) and is rarely accepted; most of
  the result there comes from the constructive phase. Relaxing only the neighbourhood of the moved pieces would
  make hops O(local) instead of O(P).
- **Many sides.** 100-gons cost O(1) per pair near contact, but each pair still carries two line variables; a disk
  phase (the circumscribed disks first) did not pay off at the sizes tried.
- **Bounds.** The search stops only at the area bound with Thue's density (disks), the proven pentagon and
  octagon densities, or density 1 (tiles); elsewhere it runs to the end of its budget even when it is optimal
  (for example free tori of even N > 8, where the densest lattice packing is optimal for every P and is found in
  well under a second).
