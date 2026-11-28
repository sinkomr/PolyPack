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
`FRESH_CLIMB`, `FRESH_STARTPOL`, `FRESH_D0`, `FRESH_DMIN`, `FRESH_DMAX`. `examples/diag.rs` prints a
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
  0.03), /4 when 30 + 2P hops in a row fail (down to 2e-4; then the chain ends). Moves, with weights that follow
  their success: shake all (log-uniform amplitude), shake a neighbourhood hard, re-seat 1-3 pieces in holes (half
  the time the most squeezed piece first), one piece to a random place, turn one or two pieces, a small shake of
  everything, and (polygons) turn a piece to its neighbour's developed angle or an edge parallel to its face's
  nearest edge.
- At the end of a chain its best is polished precisely (secant) and checked. Restarts alternate between random
  starts and the best shaken by 1-3 moves (P = 1: always the best).
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
  angles and line variables (worst relative error ~1e-6).
- `tests/runs.rs`: 12 short runs (evaluation budgets) on Platonic, Archimedean, Catalan, prism, antiprism and
  Johnson solids, N from 0 to 100, P from 1 to 30: the packing passes the check at the reported score, the trace
  strictly improves and ends at it; `--evals` runs are reproducible; `handles` reads ids only;
  `fresh_search` honours the stop flag and the wall deadline within 0.25 s and never returns worse than a valid
  `start` (also with a budget of one evaluation).

## Measurements

MEASUREMENTS

## Caveats and what next

CAVEATS
