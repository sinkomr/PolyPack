# fresh-surface-nofold

A search for the surface problems in the nofold mode, `surface/<solid>/nofold/<N>/<P>`: P congruent pieces
(N = 0: disks of diameter 1; N = 3..100: regular N-gons of side 1), each inside one face of one of the 141
convex solids scaled to edge s, pieces on one face disjoint; minimise s. Written from scratch for the
fresh-solvers experiment (`native/FRESH.md`):

    fresh-surface-nofold --id surface/<solid>/nofold/<N>/<P> --seconds S --seed K [--evals E] [--verbose]

One thread; the clock is the thread's CPU time; with `--evals E` the run stops after E evaluations of the
objective and repeats exactly for the same id, seed and E (no decision reads the clock, only the stop). It
prints one JSON line: the best packing in the submission format `{s, pieces: [{face, x, y, theta}]}`, its
score from `polypack_spaces::validate_space_submission` and the trace of checked improvements. The library
has `fresh::{handles, fresh_search}` (`polypack_spaceauto::FreshSearch`): the same search, with the client's
stop flag and wall deadline, `on_improve` on each checked improvement, and a valid `start` that is the best
to beat and seeds the face problems.

From `polypack-surface` it reads only the definitions (the solids' faces in their frames: `unit_faces`,
`regular`, `sides`) and calls the validator's nofold check on candidates; from `polypack-spaces` the server's
check. None of the existing surface searches, nor the planar solver they use, is ported or called.

## Method

**Decomposition** (`src/search.rs`, `src/solid.rs`). Faces meet only along edges, so a nofold packing is a
packing of every face on its own, all faces scaling together with s. Congruent faces are one *face problem
class*: every regular M-gon face is the same polygon in its frame; irregular faces (the Catalan solids) are
matched up to a rotation or a reflection, and a packing of the class representative is carried to every face
by that rigid map (a reflection maps a piece angle theta to rot - theta - pi). Let s_c(k) be the least scale
at which k pieces fit in the face shape Q_c. A face holding k pieces needs s >= s_c(k); dropping pieces keeps
a packing valid, so the best known upper bounds U_c(k) are made non-decreasing in k (a packing of k' >= k
pieces serves k), and the best score for the known bounds is computed exactly: the least value s among the
U_c(k) at which the faces hold P pieces, sum over classes of |faces of c| * max{k : U_c(k) <= s} >= P. So the
search is a set of small planar problems (k pieces in one convex polygon), and the assignment of pieces to
faces is exact given their results. Load k of a class never exceeds ceil(P / |faces of c|).

**Schedule.** Below the current best s*, class c holds kappa_c pieces per face, D short of P. A *plan* raises
some classes by j_c pieces per face with sum |faces of c| j_c >= D (minimal: no raised class is spare); it needs
every face problem (c, kappa_c + j_c) below s*, and none whose lower bound (area; one piece: the piece's
inscribed disk in the face's incircle) is already at s*. A plan's difficulty is the largest gap U / s* - 1 of
its problems. The face problems of some plan form the frontier; each gets slices of evaluations (3000 + 300 k)
in turn, choosing the least effort * (difficulty + 0.01)^2, after every frontier problem has had three slices.
On a Platonic solid this is the single problem k = ceil(P / F); on the others usually two to four problems. An
empty frontier means s* is at the lower bound (the run stops with "bound"). Each face problem's search is kept
between slices, and the best packings of k - 1 and k + 1 pieces of the same face seed starts of problem k.
In the last 3 % of the budget the frontier problems' pending polishes are run.

**Face problem** (`src/model.rs`, `src/planar.rs`). Internal units: the piece's bounding radius is 1. For a
pressure w > 0, minimise over the centres, angles, the scale s and one separating line (phi, beta) per near
pair (bounding circles within a skin of 0.5)

    G = sum over near pairs of sum_{v in i} max(0, u.(v - m) - beta)^2 + sum_{v in j} max(0, beta - u.(v - m))^2
      + sum over pieces, edges e of the face and vertices v of max(0, n_e.v - s h_e)^2  +  w s

(disks: max(0, 2 - |c_i - c_j|)^2 and max(0, n_e.c + 1 - s h_e)^2); u = (cos phi, sin phi), m the midpoint of
the centres. It is zero exactly when every pair is separated by its line and every piece is inside s Q, and
continuously differentiable, also at face-to-face contacts. The vertices with a positive term form a contiguous
arc around the vertex that reaches furthest in the line's or wall's direction; that vertex is found from the
angles in O(1) and the arc is walked outward until a term vanishes, so a term costs O(1 + vertices across) and
100-gons cost about what hexagons cost. One `sin_cos` per piece and per pair per evaluation; vertex directions
by products with a table. Gradients are analytic (tests against central differences). The pair list is rebuilt
when a piece has moved a quarter of the skin; a stored line is replaced by the separating-axis line when that
has the smaller penalty. Minimiser: L-BFGS (memory 7, Armijo backtracking), adapted from `native/fresh-flat`.

Search of one face problem: monotonic basin hopping at the exploring pressure w = 0.03 in epochs (40 + 3k
failed hops end an epoch); a hop that is still 2 % above the current packing's G / w after 50 iterations is
given up. Starts: random centres with random or edge-aligned angles; a patch of a periodic arrangement
(`src/lattice.rs`: rows of one orientation, or alternating rows half a period apart, every spacing found by
bisection on the exact separation, densest first; the best of 40 turns, mostly aligned with a face edge, and
shifts by the scale its k best-placed pieces need); the best packing of this problem shaken; or a neighbouring
problem's best packing with a piece added at the roomiest of 64 points or one removed. Moves: shake all, move
one piece to a random point or the roomiest of 24, shake a neighbourhood hard, turn one or two pieces, turn one
over by half a period, copy a neighbour's angle. A soft packing that beats the best soft scale is polished at
w = 1e-5 (at most a quarter of the problem's evaluations), repaired and checked; the best is taken down the
ladder 1e-7, 1e-9, 1e-11 at the end of each epoch, and each epoch's final packing (when its soft scale is within
1 % of the best) is polished down the whole ladder too, since near ties at the exploring pressure rank either
way once hard.

**Repair and validity** (`src/geom.rs`). The solver's own exact geometry, in site units: the separating-axis
separation of two regular N-gons (the edge normals near the centre direction only, visited outward while the
bound lin - 2 r_in can still win: O(1) for 100-gons) and the support of a piece along each face normal. Repair
spreads the centres about the face centre by 1 + lambda (doubling) until every pair is separated by a margin
of 1e-13 max(1, R), then takes the least scale that holds every piece with that margin. A face packing that an
assignment uses is first checked on its face with the validator's nofold check at tolerance 1e-11; the
assembled packing is checked with `validate_space_submission` with `no_record` (strict, tolerance 1e-11, which
implies the default check) before it enters the trace, `on_improve` or the result; an improvement smaller than
1e-12 of the score (a repolish of the same packing) is not recorded. A constructive packing of
every face problem (the k cells of a hexagonal grid of bounding circles that need the least scale, of 7 turns
and 4 shifts) gives a valid packing of any problem within milliseconds.

## Tests

    cargo test --release -p polypack-fresh-surface-nofold

- `tests/agreement.rs`: pair separation against the validator's `regular_polygon_separation` / disk separation
  for N in {0, 3..9, 11, 12, 20, 37, 64, 100}, at random poses and near contact (+-1e-10, 1e-12 of a bisected
  touching position), to 1e-12; containment depth and the fit scale against the validator's vertex-by-vertex
  `face_depth` on regular and irregular faces of 11 solids; repaired random arrangements pass `validate_nofold`
  at tolerance 0; congruent faces map onto each other; the gradient matches central differences (disks,
  3..100-gons, regular and irregular faces); the penalty is exactly zero at a repaired packing and positive at
  an overlap.
- `tests/runs.rs`: short runs on 12 problems (Platonic, Archimedean, Catalan, prism, antiprism, Johnson; disks,
  triangles, squares, pentagons, 7-, 8-, 12-, 66- and 100-gons) pass the check (default and strict) at the
  reported score, above the lower bound, with an improving trace that ends at it; runs with an evaluation
  budget repeat exactly; `handles` accepts exactly the nofold ids; the stop flag and the wall deadline end
  `fresh_search` within 0.2 s; a valid start is never returned worse and nothing at or above it is reported.

## Measurements

Machine: a 4-core Xeon VM (2.1 GHz) shared with three other agents' builds and benchmarks; load averages 4 to 7
during these runs. All clocks are CPU time, so the load mostly stretches wall time, but contention (shared
caches, the port's wall-clock job deadlines) adds noise of perhaps tens of percent to any single time below, and
the port and the JavaScript ran at a different time from fresh. The coordinator's quiet run is the one to trust.

### Harness, 20 CPU seconds (measured)

`native/tools/fresh/problems-surface-nofold.json` (14 problems drawn by `draw-surface-nofold.mts`, seed
20261128: Platonic 2, Archimedean 2, Catalan 3, prisms 2, antiprisms 1, Johnson 4; disks, triangles to
octagons, 66-, 72- and 95-gons; P from 5 to 72). `run.py --solvers fresh,port,js --seeds 1,2 --seconds 20
--concurrency 1`, then `validate.mts` and `analyze.py --times 1,5,20`. R is the best final score of any run
(all three solvers). Every fresh and port packing passed the server's TypeScript validators with a matching
score; the JavaScript found no packing on the two icosahedron problems.

| solver | valid | reach 1e-2 | median t | reach 1e-3 | median t | reach 1e-4 | median t | mean gap at 1 s | at 5 s | at 20 s |
|---|---|---|---|---|---|---|---|---|---|---|
| fresh | 28/28 | 28/28 | 0.0074 s | 28/28 | 0.0074 s | 28/28 | 0.0074 s | 1.3e-7 | 3.7e-8 | 1.1e-8 |
| port | 28/28 | 11/28 | 0.76 s | 11/28 | 0.76 s | 11/28 | 0.76 s | 0.64 | 1.23 | 1.15 |
| js | 24/28 | 7/28 | 0.87 s | 6/28 | 0.86 s | 6/28 | 0.86 s | 1.14 | 1.38 | 1.37 |

Geometric mean of the speed ratio where both reach the target: fresh is 208x faster than the port to 1e-2, 240x
to 1e-3 and 229x to 1e-4 (11 pairs each; 17 more reached by fresh only, none by the port only), and about 300x
faster than the JavaScript. The port's and the JavaScript's traces are recorded when a job ends (coarse; this
favours fresh by up to a job length, about 0.4 s), but most of their misses are final gaps of 16 % to 790 %.

Per problem: final gap to R and CPU seconds to R(1 + 1e-2), R(1 + 1e-3), R(1 + 1e-4) ("-": not reached).

| problem | R | fresh s1 | fresh s2 | port s1 | port s2 | js s1 | js s2 |
|---|---|---|---|---|---|---|---|
| pentagonal_bipyramid/0/12 | 2.732050808 | 1.2e-12 (0.003, 0.003, 0.003) | 1.2e-12 (0.003, 0.003, 0.003) | 0 (0.79, 0.79, 0.79) | 2e-16 (0.80, 0.80, 0.80) | 2e-16 (0.86, 0.86, 0.86) | 0 (0.86, 0.86, 0.86) |
| triakis_octahedron/0/41 | 1.334903985 | 2e-16 (0.003, 0.003, 0.003) | 0 (0.003, 0.003, 0.003) | 1.6e-1 (-, -, -) | 1.6e-1 (-, -, -) | 3.7e-1 (-, -, -) | 1.6e-1 (-, -, -) |
| icosahedron/0/6 | 1.732050808 | 2.1e-13 (0.002, 0.002, 0.002) | 2.1e-13 (0.002, 0.002, 0.002) | 0 (0.75, 0.75, 0.75) | 2e-16 (0.74, 0.74, 0.74) | no packing | no packing |
| antiprism9/3/5 | 0.6659146177 | 0 (0.023, 0.029, 0.029) | 3e-15 (0.007, 0.007, 0.007) | 1.1e-6 (1.40, 4.58, 4.58) | 6.6e-7 (1.46, 2.80, 2.80) | 1.8e-6 (3.39, 5.01, 8.25) | 2.6e-7 (1.71, 3.33, 3.33) |
| prism11/7/30 | 2.361416975 | 0 (0.046, 0.113, 0.442) | 3.1e-7 (0.080, 0.080, 0.198) | 5.6e-1 (-, -, -) | 5.6e-1 (-, -, -) | 5.6e-1 (-, -, -) | 5.6e-1 (-, -, -) |
| truncated_octahedron/4/5 | 0.7886751346 | 1.5e-13 (0.002, 0.002, 0.002) | 1.5e-13 (0.003, 0.003, 0.003) | 0 (0.75, 0.75, 0.75) | 2e-15 (0.67, 0.67, 0.67) | 0 (0.85, 0.85, 0.85) | 2e-15 (0.87, 0.87, 0.87) |
| pentagonal_gyrocupolarotunda/3/51 | 1.224744871 | 0 (0.055, 0.055, 0.055) | 0 (0.033, 0.033, 0.033) | 6.3e-1 (-, -, -) | 6.3e-1 (-, -, -) | 6.3e-1 (-, -, -) | 6.3e-1 (-, -, -) |
| cuboctahedron/5/32 | 3.102525012 | 4e-15 (0.018, 0.018, 0.037) | 0 (0.010, 0.020, 0.020) | 2.9e-1 (-, -, -) | 3.3e-1 (-, -, -) | 2.9e-1 (-, -, -) | 2.9e-1 (-, -, -) |
| triakis_tetrahedron/66/7 | 23.2155815 | 0 (0.002, 0.002, 0.003) | 3e-15 (0.002, 0.002, 0.003) | 8e-11 (4.72, 4.72, 4.72) | 3.0e-1 (-, -, -) | 4.4e-3 (5.09, -, -) | 3.0e-1 (-, -, -) |
| prism7/0/19 | 1.381057826 | 0 (0.006, 0.006, 0.006) | 2e-15 (0.006, 0.006, 0.006) | 1.6e-2 (-, -, -) | 1.6e-2 (-, -, -) | 1.9e-2 (-, -, -) | 2.4e-1 (-, -, -) |
| disdyakis_dodecahedron/8/59 | 3.558379744 | 9e-15 (0.008, 0.008, 0.008) | 0 (0.004, 0.004, 0.004) | 4.1e-1 (-, -, -) | 4.1e-1 (-, -, -) | 4.1e-1 (-, -, -) | 4.1e-1 (-, -, -) |
| pentagonal_orthobirotunda/72/44 | 37.96943967 | 0 (0.010, 0.010, 0.010) | 5e-15 (0.014, 0.014, 0.014) | 6.1 (-, -, -) | 5.8 (-, -, -) | 6.2 (-, -, -) | 5.9 (-, -, -) |
| icosahedron/5/72 | 5.219832801 | 2.2e-12 (0.022, 0.022, 0.022) | 2.1e-12 (0.032, 0.032, 0.032) | 0 (0.74, 0.74, 0.74) | 2e-14 (0.76, 0.76, 0.76) | no packing | no packing |
| augmented_hexagonal_prism/95/39 | 60.47326332 | 2e-14 (0.064, 0.064, 0.064) | 0 (0.065, 0.065, 0.065) | 7.9 (-, -, -) | 7.8 (-, -, -) | 7.9 (-, -, -) | 7.8 (-, -, -) |

Where the port ties fresh (the Platonic problems and the one-piece-per-face problems), its packings sit at the
exact optimum to rounding, while fresh's keep the repair margin (gaps of 1e-13 to 2e-12, far below the site's tie
tolerance of 1e-9). On the many-sided pieces on Johnson solids the port's and the JavaScript's 20-second results
are 6.8 to 8.9 times fresh's.

### Other measurements

- Fresh against the port on 30 more ids drawn at random (all families, N in {0, 3..8, 9..100}, P 2..50), 3 CPU
  seconds each, seed 1: fresh's score is never above the port's; equal (to 1e-11) on 7, below on 23, by up to
  a factor 8.5 (antiprism8/64/37: 35.28 against 299.15; antiprism11/66/20: 23.06 against 171.58).
- Robustness: every one of the 141 solids once with a random N and P, plus N in {0, 3, 100} with P in {1, 100}
  on five solids with few faces (171 ids, 0.1 s each), and 150 more random ids (0.15 s): every run ended within
  its budget with a packing that passed the check; the first valid packing came within 12 ms on every id.
- Tuning (5 CPU seconds, seeds 1 and 2, 16 harder problems with 4 to 40 pieces per face; R the best of all
  variants' runs): the defaults reached R(1 + 1e-4) in 32 of 32 runs (median 0.025 s) and R(1 + 1e-6) in 31.
  Exploring at w = 0.01 or 0.1, shorter epochs (40 + 1.5 k), more lattice starts, or no polishing of each
  epoch's final packing were each worse at 5 s (mean gap 2.6e-7 to 1.5e-4 against 6.9e-8). A move that turns a piece
  so that an edge lies flush with its nearest wall (`mv_snap=1`) was not better on six structured problems (3
  seeds, 5 s: within 1e-6 of R in 14 of 18 runs against 16 of 18), so it is off. The slowest problem
  was square_pyramid/4/60, where 9 squares in a triangle at 3 + 4/sqrt(3) (load 9 on the triangles and 24 on the
  square) took 2.8 and 3.6 s to find.

## Weak spots

- Structured optima of a few pieces that random and lattice starts reach rarely, such as 9 squares in a
  triangle (seconds, see above), and the hard face problems with many pieces (15 pentagons in a triangle, 12
  heptagons in a square): seeds still differ by 1e-7 to 1e-6 after 5 seconds.
- Many-sided pieces (N >= 30) have nearly free rotations, so packings that differ only in angles have nearly
  equal scales: seeds differ by about 1e-6 on 100-gons with 10 pieces per face.
- The lower bounds are weak (area, and one piece in the incircle), so a run stops early ("bound") only when a
  face holds one piece that fits the incircle exactly; otherwise it searches to the end of its budget.

## Development knobs

`FSN_DEBUG=1` prints the improvements of the whole packing, the starts, polishes and epoch ends of the face
problems on stderr; `--verbose` prints per face problem the evaluations, starts, hops, best scale and starts
that won. Tuning overrides (environment, development only): `FSN_PARAMS="w=0.03,wq=1e-5,fails_k=3,hole=0.5,
gtol=0.01,abort_it=50,abort_m=0.02,share=0.25,latc=40,near=0.01,s_rand=1,s_align=1,s_lat=1.5,s_elite=1,s_nb=1,
mv_copy=1,mv_snap=0"`
(face searches, `planar.rs: Params`) and `FSN_TUNE="slice=3000,slice_k=300,min_slices=3,g0=0.01"` (the
schedule, `search.rs: Tuning`). `examples/lat.rs` prints the densities of the periodic arrangements.

## Files

- `src/solid.rs`: the id, face classes and the maps between their frames, lower bounds.
- `src/geom.rs`: the piece and the face polygon, exact separation and fit, repair.
- `src/model.rs`: the objective, its gradient and the local minimisation driver; the run's budget.
- `src/lbfgs.rs`, `src/rng.rs`: the minimiser and the generator (adapted from `native/fresh-flat`).
- `src/lattice.rs`: periodic arrangements for starts.
- `src/planar.rs`: the search of one face problem.
- `src/search.rs`: the assignment, the schedule, the constructive packings, the check.
- `src/fresh.rs`, `src/main.rs`: the client's entry point and the command line.
- `tests/agreement.rs`, `tests/runs.rs`: see Tests.
