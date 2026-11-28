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
scale would be enlarged by 1e-12, 1e-10, ... and checked again (it never refused one in the tests and runs).

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

MEASUREMENTS

## What did not help

Measured on the hard problems below (sq/9/41, hex/3/48, sq/5/33, sq/20/45, 3-4 seeds, 5-10 CPU s); single
seeds differ by up to 0.5 %, so only the larger effects are trustworthy.

| change | effect |
|---|---|
| polish every candidate to 2e-13 (instead of 1e-9, then the best to 2e-13) | 70 % of the evaluations went to polishing on sq/9/41; the two-level polish gives 2-5x more hops |
| secant trials 2 % of the step below the estimate (instead of 0.2 %, shortened after an overshoot) | 20-35 trials per polish instead of 5-13 |
| three line variables (a, b, beta) instead of the two-variable chart | 15 % fewer evaluations per second, same quality |
| a disk phase for many sides (25 % of the budget on the circumscribed disks, then polygons) | no better on sq/82/100, hex/61/108, hex/63/111, sq/38/36, hex/94/411, sq/50/300 |
| chains with their own reference score (each restart polished to its own jamming score first) | hex/3/48 reached its best on 1 of 4 seeds instead of 3 of 4 |
| L-BFGS memory 4 or 10, exploring tolerance 1e-5, hop compression 3e-4 or 3e-3, more restarts | within the noise |
| L-BFGS buffers swapped instead of copied, fused passes | no measurable speed-up |

## Weak spots and next steps

- **Glassy polygon problems depend on the seed.** hex/3/48 ends in one of three basins (4.96700, 4.97268,
  4.99600) depending on the seed, sq/9/41 and sq/5/33 vary by 0.05-0.1 %. A population of chains with a
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
