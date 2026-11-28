# fresh-surface-fold

A search for `surface/<solid>/fold/<N>/<P>` written from scratch for the fresh-solvers experiment
(`native/FRESH.md`): P regular N-gons of side 1 (N = 0: disks of diameter 1) on the surface of one of the
141 convex solids, folding over its edges, in the smallest scale s of the solid.

    fresh-surface-fold --id surface/cube/fold/4/12 --seconds S --seed K [--evals E]

prints the contract's JSON line (plus `stopped`). The library has the client's entry point
`fresh::{handles, fresh_search}` (`polypack_spaceauto::FreshSearch`). From `polypack-surface` it reads only the
solids' definitions (frame vertices, adjacency, cone angles, 3D frames for a distance proxy) and the domain's lower
bound; from `polypack-spaces` the check `validate_space_submission(Surface, id, config, default)`, on candidates
only. Nothing of the existing searches (`native/surface/src/search`, `surface_auto.rs`, `nofold_planar.rs`, the
TypeScript kernels) is used or ported; the chain development and every overlap computation are this crate's own.

Development switches (stderr only, not used by the harness): `FRESH_DEBUG=1` (improvements and statistics),
`FRESH_DEBUG_POLISH=1`, `FRESH_DEBUG_HOPS=1`, `FRESH_DUMP=1` (configurations the check refused); tuning overrides
`FRESH_CLIMB`, `FRESH_STARTPOL`, `FRESH_D0`, `FRESH_DMIN`, `FRESH_DMAX`, `FRESH_PAT0`, `FRESH_PAT1` (patience
PAT0 + PAT1 P), `FRESH_REVERY` (every k-th restart from random centres). `examples/diag.rs` prints a
configuration's images against the validator, `examples/agree.rs` the agreement statistics below.

## Method

**Units.** The solid is held at a working scale S = the problem's lower bound on s, and every piece is scaled by
mu, so a packing at mu has score S / mu (mu <= 1). Changing the scale moves nothing: the faces stay put.

**Surface geometry** (`src/geo.rs`). Each face in its own frame (the validator's convention), the rigid gluing
map across every edge (computed from the edge's endpoints), a *walk* that moves a point along a straight path
across edges (the exponential map: moves, re-anchoring), and the *development* of a disk about a point: the
chains of faces a straight ray of bounded length can follow, each with its map into the anchor frame and its
wedge of directions (cones over the crossed edges intersected; a chain whose wedge is empty is cut).

**Images** (`src/model.rs`). The surface is flat away from the vertices and pieces may not contain a vertex, so
overlap is measured in developments:

- *pair images*: every other centre seen from c_i through a chain's wedge (the segment is a geodesic of the
  surface) closer than two circumradii plus a skin: piece j placed by the chain's map next to piece i;
- *cone images*: every vertex developed the same way within a circumradius plus half the skin;
- *self images*: a centre seen from itself along a geodesic loop (small solids);
- *round-the-vertex images* (polygons): two pieces that both hug a vertex can overlap on the side of it the
  geodesic between their centres does not pass (seen on the antiprisms and with triangles: the validator found
  overlaps of depth 2e-3 that no geodesic image showed). For every vertex near both pieces of a pair image, the
  image turned about that vertex by its cone angle is added;
- *sheets*: an overlap at a point x of an image is real only if the path c_i -> x -> c_j sweeps the same angle
  about each nearby vertex as the image's own path (otherwise the vertex lies between them and the overlap is
  an artefact of the flat development). The sweep is continuous over each piece (a piece contains no vertex),
  so it is constant over an overlap region; it is tested at a point between the deepest crossing corners. This
  removes the false overlaps the round-the-vertex images would otherwise add.

For disks the pair and cone images are exactly the validator's own test (geodesic distances between centres,
centre-vertex distances, loops).

**Energy** at a fixed scale mu, zero exactly when every image is separated: disks max(0, mu - d)^2 and
max(0, mu/2 - d_vertex)^2; polygons carry a separating line per pair image (unit normal from (a, b), offset from
the centres' midpoint) as extra variables, with the squared crossings of the corners on the wrong side, and a
line through the vertex per cone image. Only corners that cross are visited (from the corner most in the line's
direction outwards), so a 100-gon costs about what a square does. Gradients are analytic (tested). The lists are
built from canonical poses (every centre in its own face); during a minimisation a piece moves in the plane of
its face (its chart, extended across edges), and the lists are rebuilt (pieces walked back into their faces)
when one has moved half the skin.

**Exact jamming scale** (`jam_scale`). For fixed poses, the largest mu at which every image is separated:
d for disk pairs, 2 d for disk-vertex, and for polygons the separating-axis bound max over the 2N edge normals of
(n . d) / (inradius + support of the other piece) (a vertex: max over edge normals / inradius), with the sheet
test at the touching point. Separation is monotone in mu for convex pieces scaled about their centres, so the
poses at this scale are a valid packing; it is the *repair* used everywhere, and the check confirms it.

**Local solver.** L-BFGS (memory 8, Armijo backtracking with quadratic interpolation, a cap on each coordinate's
move per step), stopping when the energy reaches zero (a fit), on a small gradient, on stalling, or, for a hop,
early when its energy is clearly above the current arrangement's or has come back to it.

**Search** (`src/search.rs`).

- *Start*: random points (each re-seated at the roomiest of 8 samples, 3D distance as a proxy) with random
  angles; its repair is checked at once (a valid packing within milliseconds on every problem tried), then the
  *polish* finds its jamming scale: relaxations at growing scales while they fit, then the secant of sqrt(E)
  against mu over the infeasible trials (a bisection once a trial fits), every trial repaired; it stops when the
  valid and the infeasible scale meet to 2e-13, or when it cannot beat the best.
- *Frontier basin hopping*: at mu_h = mu_best (1 + delta), perturb the current arrangement and relax; keep it if
  its energy is lower; if its energy reaches zero it beats the best: *climb* (relax at scales growing by doubling
  steps while it fits, each repaired), check, record, and move mu_h up. delta adapts: x1.5 after a success (up to
  0.03), /4 when 15 hops in a row fail (down to 2e-4; then the chain ends). Moves, with weights that follow
  their success: shake all (log-uniform amplitude), shake a neighbourhood hard, re-seat 1-3 pieces in holes (half
  the time the most squeezed piece first), one piece to a random place, turn one or two pieces, a small shake of
  everything, and (polygons) turn a piece to its neighbour's developed angle or an edge parallel to its face's
  nearest edge.
- At the end of a chain its best is polished precisely (secant) and checked, and once more the best at 90 % of
  the budget (CPU time, or evaluations when they are capped, so `--evals` runs stay reproducible). Restarts
  alternate between random starts and the best shaken by 1-3 moves (P = 1: always the best). Short chains with
  frequent random starts did better on the large-P problems than long chains (development runs below).
- Starts for polygons: half of them turn every piece so that an edge is parallel to its face's nearest edge.
- *Check*: only packings that beat the best are checked; s = S / mu (1 + 2e-13), so packings are valid at
  tolerance ~0 (also for the server's strict 1e-11 check). A packing the check refuses is enlarged by 1e-9, 1e-7,
  1e-5 and checked again; if all fail it is dropped (not seen in any run since the round-the-vertex images).

## Tests

    cargo test --release -p polypack-fresh-surface-fold

- `tests/geometry.rs`: gluing maps take each neighbour's edge onto the face's edge and agree in 3D; walks end in
  a face and follow the map; on 16 solids (Platonic, Archimedean, Catalan, prism, antiprism, Johnson) and
  N in {0, 3, 4, 5, 7, 12, 40}, 1340 random configurations (uniform, near vertices and edges, and clusters of
  pieces around one vertex): the validator accepts every one at 1 - 1e-7 of the model's jamming scale and refuses
  every one at 1 + 1e-7 (0 misses, 0 stricter); the energy's gradient matches central differences for positions,
  angles and line variables (worst relative error ~1e-6); the sheet test's fast atan2 is within 1e-4 rad.
  `examples/agree.rs` runs the same comparison on 21 solids and 8 shapes (4193 configurations, 0 disagreements).
- `tests/runs.rs`: 12 short runs (evaluation budgets) on Platonic, Archimedean, Catalan, prism, antiprism and
  Johnson solids, N from 0 to 100, P from 1 to 30: the packing passes the check at the reported score, the trace
  strictly improves and ends at it; `--evals` runs are reproducible; `handles` reads ids only;
  `fresh_search` honours the stop flag and the wall deadline within 0.25 s and never returns worse than a valid
  `start` (also with a budget of one evaluation).

## Measurements

Preliminary: the 4-core machine was shared with three other agents' builds and benchmarks throughout (load
average 4 to 6), one benchmark process of mine at a time. All clocks are CPU time; the coordinator's run on a
quiet machine is the measurement.

Problems: `native/tools/fresh/problems-surface-fold.json`, drawn by `draw-surface.mts` (seed 20261128): 3
Platonic, 3 Archimedean, 2 Catalan, 2 prisms, 1 antiprism, 3 Johnson solids; disks (4), small polygons (6), large
polygons (4); P from 4 to 59. Harness `native/tools/fresh/` (`run.py --solvers js,port,fresh --seeds 1,2 --seconds
20 --concurrency 1`, `validate.mts`, `analyze.py`, and `table-surface.py` for the per-problem table). R = the best
TypeScript-valid final score of the 84 runs; gap = score / R - 1; t = CPU seconds to R (1 + eps), "-" never.

All 84 final packings pass the server's TypeScript validators with matching scores (fresh 28/28, port 28/28,
js 28/28).

| solver | reach 1e-2 | median t | reach 1e-3 | median t | reach 1e-4 | median t | mean gap 1 s | 5 s | 20 s |
|---|---|---|---|---|---|---|---|---|---|
| fresh | 28/28 | 0.34 s | 24/28 | 0.30 s | 22/28 | 0.37 s | 0.099 | 0.0023 | 0.00051 |
| port | 10/28 | 1.6 s | 5/28 | 3.5 s | 5/28 | 3.5 s | 1.16 (8 runs) | 1.29 | 0.46 |
| js | 6/28 | 5.0 s | 3/28 | 3.8 s | 3/28 | 3.8 s | (1 run) | 1.41 | 1.26 |

Geometric-mean speed ratio over the (problem, seed) pairs where both reach the target: fresh vs port 118x (1e-2,
10 pairs), 109x (1e-3, 5 pairs), 96x (1e-4, 5 pairs); fresh vs js 460x, 583x, 445x. Pairs where only one reaches
it: fresh only 18 / 19 / 17 (vs port), port only 0.

Per problem (final gap seed 1 / seed 2; CPU seconds to R (1 + 1e-3)):

| problem | R | fresh gap | fresh t 1e-3 | port gap | port t 1e-3 | js gap |
|---|---|---|---|---|---|---|
| icosahedron/fold/0/5 | 0.9199844371 | 2.5e-13 / 2.4e-13 | 0.005 / 0.008 | 2e-15 / 0 | 3.5 / 0.88 | 2e-15 / 0 |
| cube/fold/4/4 | 0.9428090416 | 1e-14 / 0 | 0.33 / 0.65 | 6.2e-3 / 6.2e-3 | - / - | 6.7e-3 / 6.1e-2 |
| tetrahedron/fold/5/31 | 5.895986353 | 1.4e-3 / 0 | - / 7.9 | 3.7e-2 / 3.2e-2 | - / - | 6.6e-2 / 5.6e-2 |
| icosidodecahedron/fold/8/59 | 3.485468995 | 0 / 4.8e-4 | 6.7 / 2.4 | 0.17 / 0.14 | - / - | 0.39 / 0.22 |
| truncated_cuboctahedron/fold/0/41 | 0.8217971265 | 0 / 4e-16 | 0.11 / 0.13 | 0.17 / 0.16 | - / - | 0.17 / 0.16 |
| cuboctahedron/fold/66/7 | 18.77856207 | 0 / 5e-14 | 0.13 / 0.22 | 0.10 / 0.097 | - / - | 0.13 / 0.68 |
| triakis_icosahedron/fold/7/29 | 1.069966348 | 0 / 5.2e-4 | 4.1 / 18 | 0.11 / 0.077 | - / - | 0.34 / 0.23 |
| tetrakis_hexahedron/fold/0/18 | 0.7713918463 | 0 / 8e-15 | 0.029 / 0.015 | 8.2e-3 / 4.5e-3 | - / - | 9.0e-3 / 9.0e-3 |
| prism9/fold/3/4 | 0.392624043 | 4e-13 / 0 | 0.48 / 0.19 | 8.9e-8 / 1.9e-6 | 9.1 / 6.4 | 0.18 / 0.18 |
| prism7/fold/72/44 | 39.22227466 | 0 / 2.4e-3 | 1.8 / - | 9.0 / 1.6 | - / - | 9.1 / 9.0 |
| antiprism7/fold/3/51 | 1.4131586 | 0 / 8.0e-3 | 14.7 / - | 7.5e-2 / 2.6e-2 | - / - | 0.14 / 6.7e-2 |
| pentagonal_bipyramid/fold/0/12 | 1.645820486 | 9e-13 / 8e-13 | 0.008 / 0.005 | 7.0e-3 / 0 | - / 1.7 | 1.4e-2 / 9e-16 |
| tridiminished_rhombicosidodecahedron/fold/7/48 | 2.051724412 | 0 / 1.6e-3 | 7.7 / - | 0.13 / 6.5e-2 | - / - | 0.39 / 0.16 |
| elongated_pentagonal_gyrobirotunda/fold/65/19 | 17.3729422 | 5e-15 / 0 | 0.27 / 0.37 | 0.35 / 0.21 | - / - | 6.6 / 6.1 |

The fresh gaps of ~1e-13 on the problems that every solver solves (icosahedron/0/5, pentagonal_bipyramid/0/12)
are its safety margin (s is reported 2e-13 above the jamming scale, so packings are valid at tolerance ~0); the
port and js use the validator's 1e-9 tolerance. Earlier in development, one shorter run of fresh (v1 below) found
antiprism7/fold/3/51 at 1.41133 (0.13 % below this R): R itself is not converged on the large-P problems.

**Development runs** (same harness, 20 s, seeds 1-2, fresh only): v1 (patience 30 + 2P hops per frontier level,
random restarts every 3rd chain) reached 1e-2 / 1e-3 / 1e-4 on 26 / 23 / 22 of 28 runs, mean gap at 20 s 0.0016;
v2 (patience 15, random restarts every 2nd chain; the table above) 28 / 24 / 22, 0.00051; v2 / v1 final scores,
geometric mean 0.9989. The choice came from evaluation-budget runs (400k evaluations, about 15 to 20 s) on six
large-P problems with seeds 1 to 4: geometric mean of score / best 1.0064 (v1 settings) vs 1.0035 (v2-like) on
seeds 1-2, 1.0043 vs 1.0023-1.0029 on seeds 3-4. Earlier, before the round-the-vertex images, 8 to 36 of ~100
checks per 5 s run on antiprism7/3/51, tridiminished_rhombicosidodecahedron/7/48 and triakis_icosahedron/7/29
were refused by the validator (overlaps of depth up to 2e-3 round a vertex); since then none in any run.

Robustness: 130 random problems (all families, N = 0 / 3-8 / 9-100, P from 1 to 100, 0.3 s each, seeds 1 and 2
of `sweep.py`-style draws) and 11 stress cases (P = 100 with N = 100 on the truncated icosidodecahedron and the
tetrahedron, 100 disks on the tetrahedron and the disdyakis triacontahedron, P = 1 and 2 with N = 100 on the
tetrahedron, ...) all returned a valid packing, the first one within 1 to 5 ms, and ended within about 0.1 s of
the budget (wall time, including the final check).

P = 70 to 100, one run each (10 CPU seconds, seed 1, fresh vs port `bench-space`, both valid): tetrahedron/0/100
7.0887 vs 7.2107; cube/4/80 3.7574 vs 4.2474; snub_dodecahedron/3/100 1.0406 vs 1.3125; prism5/12/70 10.460 vs
12.459; pentakis_dodecahedron/6/90 1.9236 vs 2.5085; elongated_square_gyrobicupola/100/85 61.896 vs 630.03 (in
an earlier attempt the port returned no packing there). Fresh's first packing came within 2 ms, the port's after
2.5 to 5 s.

## Caveats and what next

- Load and noise: see above. The port's space jobs have wall-clock deadlines (as in the client), so load costs
  it more than the CPU-clocked fresh and js; its and js's traces are recorded when a job ends (up to a quarter
  of the budget), which favours fresh in time-to-target by up to one job length. The final gaps do not depend on
  that: on 12 of 14 problems fresh's worse seed beats the better port and js seeds (on prism9/3/4 only by the
  port's polish, 1e-7); the other two (icosahedron/0/5, pentagonal_bipyramid/0/12) are ties within fresh's 2e-13
  margin.
- Large P (29 to 59) is where fresh's seeds still differ, by 0.05 to 0.8 % at 20 s (tetrahedron/5/31,
  icosidodecahedron/8/59, triakis_icosahedron/7/29, prism7/72/44, antiprism7/3/51,
  tridiminished_rhombicosidodecahedron/7/48), and R is not converged there. P = 60 to 100 was only run in the
  robustness sweeps (valid packings, quality not measured against a reference).
- The model of overlap is exact for disks (the validator's own form) and for polygons up to the round-the-vertex
  cases with one vertex between the pieces; an overlap that needs a path round two vertices is not modelled (the
  check would refuse such a packing; the offer step then grows it by 1e-9 to 1e-5 and drops it if it still
  fails). No refusal was seen since the round-the-vertex images were added, and the agreement tests found no
  disagreement in 4193 + 1340 random configurations.
- The jamming polish is a secant of relaxations; it closes contacts to about 1e-13 relative, but a relaxation
  near jamming needs thousands of L-BFGS iterations. The development switches (env) are for experiments only.
- What next: an active-set (contact Newton / LP) polish for exact local optima in a few steps; wedges as unit
  vectors (the chain development's atan2 / cos / sin are ~8 % of the time); for large P, local relaxations of the
  moved region before the global one, a small population of good arrangements instead of the single best, and
  lattice-like starts; tuning of the move mix per family (shake-all, turns, small shakes and alignment win most
  hops on large P, the local re-seating moves rarely).
- The client (`native/client/src/fresh_engines.rs`) does not list this engine yet: one `Engine` line
  (`claims: polypack_fresh_surface_fold::fresh::handles, search: polypack_fresh_surface_fold::fresh::fresh_search`)
  and the dependency in `client/Cargo.toml` (fresh-engines feature) would add it.
