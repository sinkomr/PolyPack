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
implies the default check) before it enters the trace, `on_improve` or the result. A constructive packing of
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
