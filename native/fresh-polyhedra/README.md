# fresh-polyhedra

A search for P congruent convex polyhedra in the smallest scaled convex polyhedron (`polyhedra/<piece>in<container>/<P>`,
every ordered pair of the 186 solids, P = 2 to 500) and for P unit-edge solids in the smallest ball
(`balls/<solid>inball/<P>`, P = 2 to 100), written from scratch for the fresh-solvers benchmark (`native/FRESH.md`).
It reads only the problem definitions (`polypack-polyhedra`: the solids' vertices and face planes, the problem ids,
the volume bound, and `quat_to_r`, the validator's rotation; `polypack-balls`: the id and the bound) and calls the
server's check (`polypack_spaces::validate_space_submission`) on candidate packings, never inside its loops. Balls
in a ball or a solid (`balls/ballin*`) are fresh-balls' and answer `Err`.

    fresh-polyhedra --id polyhedra/tetintet/8 --seconds 20 --seed 1 [--evals E] [--verbose]

The library entry point is `fresh_polyhedra::fresh_search(&FreshJob, on_improve)` (`polypack_spaceauto::fresh`): CPU
budget, wall deadline, stop flag (all read at least every 128 evaluations), evaluation budget, and an optional valid
`start` that the search begins from and never returns worse than (a start that fails the check is ignored).

Development switches (not used by the harness): `FRESH_PARAMS="eps=2e-3,spread=5,..."` overrides the search parameters
(`search.rs: Params`), `FRESH_DEBUG=1` traces the polish trials. `examples/` holds the development tools used below
(`firstvalid`, `convergence`, `evalbench`, `startfrom`).

## Method

**Units and poses** (`model.rs`). Lengths are divided by the piece's circumradius rho, so every piece lies in the unit
ball about its centre; the container size s is the score itself (face g of the container is N_g . x <= s b_g with
b_g = B_g / rho; the ball is |x| <= s / (2 rho)). A pose is a centre and a quaternion (any length; the rotation is
H(q) / |q|^2, the validator's convention).

**Energy** (`energy.rs`). The overlap of two pieces is measured against a separating plane that is itself a variable
of the optimisation: for each listed pair (i, j) a direction w (unit normal u = w / |w|) and an offset e relative to
the midpoint of the centres. At a fixed size s,

    E = sum_pairs [ sum_{vertices a of i} max(0, u . (X_a - m) - e)^2 + sum_{vertices b of j} max(0, e - u . (X_b - m))^2 ]
      + sum_pieces sum_vertices sum_faces max(0, N_g . X - s b_g)^2       (or max(0, |X| - s beta)^2 for the ball)

with X = c + R(q) v. E = 0 exactly when every pair is separated by its plane and every vertex is inside: the pieces
are then disjoint (touching allowed) and contained. The gradient is exact: per vertex term, the centre gets the
derivative and the piece a torque, and the torque becomes the quaternion's gradient by
dE/dq = 2 [-tau . q_v, w tau + tau x q_v] / |q|^2. A side whose piece's bounding box (in its own frame) cannot reach
the plane is skipped without looking at its vertices; for pieces with 20 or more vertices the violating vertices are
found by climbing the vertex-edge graph to the support vertex and spreading from it (on a convex polytope the vertices
above any level of a linear function are connected and include the maximum), 1.3 to 2.5 times faster than
projecting every vertex. (A cubic penalty, max(0, r)^3, was tried: worse.) A pair is listed when the circumscribed balls come within a
skin (0.6) of each other and the pieces are not already apart by the skin along the line of centres or along their
former plane; every point of a piece has moved by at most |dc| + 2 |dq| since the list was built, so the list stays
exact until that bound reaches half the skin, which each evaluation checks.

**Relaxation** (`lbfgs.rs`). L-BFGS (memory 6) with an Armijo backtracking line search and a cap on any variable's
move per step. Since the planes are variables, the variable vector changes with the pair list: a minimisation runs in
segments, and when a trial step leaves the list's range the step is shortened, taken, and the list rebuilt there
(planes of pairs that stay listed are kept; a new pair's plane is the best of the line of centres and the face normals
of both pieces). Stopping rules: E below a floor (about (1e-13)^2), a small relative decrease per iteration several
times in a row, or a decrease of less than 1e-3 relative over a window of 40 iterations. The last matters: near
jamming, E typically settles within a few hundred iterations and then creeps down by about 1e-4 per hundred (slow
collective sliding), which kept the polish's trials running to their iteration caps before.

**Repair and check** (`repair.rs`). Any arrangement becomes a valid packing in true units with the validator's own
rotation and vertex formula: every pair closer than twice the circumradius gets a separating direction (its plane,
else the line of centres or a face normal), its overlap delta along it and its centres' spread D along it (positive:
the centres are interior points); all centres are scaled about the origin by the largest 1 + (delta + margin) / D,
which separates every pair along its direction (pieces move rigidly with their centres, all distances grow), and s is
the least size that holds every vertex, enlarged by 1e-14 relative. The packings are valid at tolerance 0 up to
rounding, so they pass the server's strict check (1e-11, asked of every entry of a problem without a research record)
as well as the default one; the engine checks with the strict options. A refused packing would be enlarged by 1e-12,
1e-10, ... relative and checked again (it has not happened in any run so far).

**First packing** (`search.rs: constructive`). Two lattice packings that are valid as built: the pieces' bounding
boxes stacked in the canonical orientation (8 shifts), and close-packed circumscribed balls with random orientations;
the P lattice points that need the least size are taken, and the better of the two is checked and reported. It takes
no relaxation: a valid packing in milliseconds for every pair of solids and every P.

**Polish** (`search.rs: polish`). The jamming size s* of an arrangement: relaxed at s < s*, E is about k (s* - s)^2,
so sqrt(E) is close to linear in s; each trial relaxes at a size just below the secant estimate of s* from the two
latest infeasible trials, and every trial's repair is a valid upper bound. Trials are coarse while the bounds are far
apart and precise at the end; the polish stops when the bounds meet (1e-12 relative; 1e-9 once a trial takes more
than 1500 evaluations), or as soon as the arrangement cannot beat the best. Long polishes offer their trial packings
that beat the best by 1e-3 on the way (large problems show progress).

**Search** (`search.rs: run`). After the first packing: the lattice packing polished (P >= 20), then a random start
compressed at density 0.35, then monotonic basin hopping on E at a size held eps below the best: perturb, relax,
accept when E is lower (by 1e-3 relative); an accepted arrangement whose repair is within 1 % of the best is polished,
and a polished packing below the best is checked and becomes the best. The jammed state a polish reaches depends on
the size it approaches from (relaxing the best packing of j46inbp9/2 at 1e-3 or 2e-3 below it and polishing gives a
neighbouring state 1.9e-6 worse; at 1e-4 or 1e-2 below, the same one), so each chain hops at its own compression
eps = 2e-3 times 4^u, u uniform in [-1, 1]. (Re-polishing every new best from 1e-4 below was tried: it cost more
than it found.) Moves, chosen with probabilities that follow their recent success:
jitter every piece (centres and orientations), jitter a cluster, move 1-3 pieces (the most squeezed by energy share, or
random ones) to the emptiest of 24 sampled places with random orientations, turn one piece (by a large angle or to a
random orientation), swap two neighbours' orientations, align a piece (the container's frame, a neighbour's
orientation, or that turned half a turn). A hop that relaxes back near the current arrangement stops early. With 24 or more pieces, a move of a few pieces
is first relaxed with only the pieces within 1.5 circumdiameters of them free (the other terms are constant), and an
accepted hop is then relaxed whole. After 30 + 2P rejections the chain restarts from the best shaken, from random
poses, or from a lattice (close-packed balls or stacked boxes in the canonical frame, a container face's frame or a
random one). The run stops with "bound" when it reaches the problem's lower bound.

**Checks and the clock** (`lib.rs`). Every improvement is checked (strict options) before it is reported. A check of
a jammed packing of many complex pieces is not free (P = 300 truncated icosidodecahedra in a cube: 0.39 s strict, 0.19
s default), so its cost is estimated from the pairs closer than 1e-3 (where the validator's separating-axis test runs
in full): a polish's trial on the way is not checked when checks would take more than a fifth of the time, and no
check is started that would end more than 0.15 s past the CPU budget or after a stop (the improvement is then lost
rather than the budget overrun). Runs with an evaluation budget make none of these decisions, so they stay
reproducible.

## Tests

    cargo test --release -p polypack-fresh-polyhedra

- `tests/geometry.rs`: on 14 problems (Platonic, Archimedean, Catalan, long prisms, antiprisms, bipyramids,
  trapezohedra, Johnson solids, solids in a ball) and random poses: the gradient matches central finite differences
  (with arbitrary quaternion lengths and perturbed planes); a pair's overlap along its plane is never less than the
  validator's penetration depth (`separation`), and a pair the plane shows apart is apart for the validator; the size
  the search computes is where the validator's wall gap is zero; repaired packings of overlapping and of relaxed
  arrangements pass the check (default and strict) and the polyhedra validator at tolerance 0, and E = 0 at s gives a
  repair at s.
- `tests/runs.rs`: short runs on 10 problems give packings that pass the check at the reported score, also strictly,
  above the bound, with an improving trace that ends at it; runs with an evaluation budget are reproducible from the
  seed (score, configuration, trace); `fresh_search` stops within 0.25 s of the stop flag and of the wall deadline with
  a checked packing, answers Err for ids of other engines, and returns nothing worse than a valid start (every
  `on_improve` packing checked and below it).

## Measurements

MEASUREMENTS

## What to try next

NEXT
