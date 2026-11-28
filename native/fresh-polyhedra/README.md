# fresh-polyhedra

A search for P congruent convex polyhedra in the smallest scaled convex polyhedron
(`polyhedra/<piece>in<container>/<P>`, every ordered pair of the 186 solids, P = 2 to 500) and for P unit-edge solids in the smallest ball
(`balls/<solid>inball/<P>`, P = 2 to 100), written from scratch for the fresh-solvers benchmark (`native/FRESH.md`).
It reads only the problem definitions (`polypack-polyhedra`: the solids' vertices and face planes, the problem ids,
the volume bound, and `quat_to_r`, the validator's rotation; `polypack-balls`: the id and the bound) and calls the
server's check (`polypack_spaces::validate_space_submission`) on candidate packings, never inside its loops. Balls
in a ball or a solid (`balls/ballin*`) are fresh-balls' and answer `Err`.

    fresh-polyhedra --id polyhedra/tetintet/8 --seconds 20 --seed 1 [--evals E] [--verbose]

The library entry point is `fresh_polyhedra::fresh_search(&FreshJob, on_improve)` (`polypack_spaceauto::fresh`): CPU
budget, wall deadline, stop flag (read about every 5 ms of work), evaluation budget, and an optional valid
`start` that the search begins from and never returns worse than (a start that fails the check is ignored).

Development switches (not used by the harness): `FRESH_PARAMS="eps=2e-3,spread=5,..."` overrides the search parameters
(`search.rs: Params`), `FRESH_DEBUG=1` traces the polish trials. `examples/` holds the development tools used below
(`firstvalid`, `convergence`, `evalbench`, `startfrom`, `checktime`).

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
projecting every vertex. (A cubic penalty, max(0, r)^3, was tried: worse.) A pair is listed when the circumscribed
balls come within a skin (0.6) of each other and the pieces are not already apart by the skin along the line of
centres or along their former plane; every point of a piece has moved by at most |dc| + 2 |dq| since the list was
built, so the list stays exact until that bound reaches half the skin, which each evaluation checks.

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
1e-10, ... relative and checked again (the tests' repaired packings all pass as they are).

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
than it found.) Moves, chosen with probabilities that follow their recent success: jitter every piece (centres and
orientations), jitter a cluster, move 1-3 pieces (the most squeezed by energy share, or random ones) to the emptiest of
24 sampled places with random orientations, turn one piece (by a large angle or to a random orientation), swap two
neighbours' orientations, align a piece (the container's frame, a neighbour's orientation, or that turned half a
turn). A hop that relaxes back near the current arrangement stops early. With 24 or more pieces, a move of a few
pieces is first relaxed with only the pieces within 1.5 circumdiameters of them free (the other terms are constant),
and an accepted hop is then relaxed whole. After 30 + 2P rejections the chain restarts from the best shaken, from random
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
  repair at s; the graph walk gives the full scan's energy and gradient (6 problems with 24 to 120 vertices).
- `tests/runs.rs`: short runs on 10 problems give packings that pass the check at the reported score, also strictly,
  above the bound, with an improving trace that ends at it; runs with an evaluation budget are reproducible from the
  seed (score, configuration, trace; 4 problems, up to P = 40); `fresh_search` stops within 0.25 s of the stop flag
  and of the wall deadline with a checked packing, answers Err for ids of other engines, and returns nothing worse
  than a valid start (every `on_improve` packing checked and below it); 60 random pairs at P = 2, 7 and 500 get a
  checked packing with no search time, each in under 2 CPU seconds (in practice milliseconds).

All pass (`cargo test --release`, 2026-11-28).

## Measurements

Harness `native/tools/fresh` (`run.py`, `validate.mts`, `analyze.py`), 20 CPU seconds per run, seeds 1 and 2, two
runs at a time, 2026-11-28 on a 4-core Linux container **shared with two other agents' builds and benchmarks: load
average 4 to 8**, so a 20 s run took 20 to 37 s of wall time. The port and js runs were made once, earlier the same
day, under the same conditions; fresh is commit 66678b2 (the later commits change only tests, this README and how
often the clock is read, not the search). R is the best final score of any run of the problem (all
three solvers). Every final packing below passed the server's TypeScript validators with matching scores
(`ts_valid`, `ts_score_match`); the port produced none in 5 runs. [CALC from the harness output]

The 16 problems of `native/tools/fresh/problems-polyhedra.json` (drawn by `draw-polyhedra.mts`, seed 20261128: 12
polyhedra problems, in each of the bands P 2-5, 6-15 and 16-60 two of the 150 pairs with research records and two of
all pairs; and 4 solids-in-a-ball problems, P 2-20), 32 runs per solver:

| solver | valid | none | reach R(1+1e-2) | median t | reach R(1+1e-3) | median t | reach R(1+1e-4) | median t | mean gap at 1 s | at 5 s | at 20 s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fresh | 32 | 0 | 31/32 | 0.17 s | 26/32 | 0.96 s | 25/32 | 1.5 s | 1.2e-2 | 4.5e-3 | 9.1e-4 |
| port | 27 | 5 | 14/32 | 1.9 s | 8/32 | 0.78 s | 8/32 | 0.78 s | 3.5e-2 (22 runs) | 3.1e-2 | 2.1e-2 |
| js | 32 | 0 | 12/32 | 2.0 s | 7/32 | 2.0 s | 7/32 | 2.0 s | none yet | 1.1e-1 | 4.7e-2 |

(The medians are over the runs that reach the target, so fresh's include the hard problems the others never reach.)
The port found no packing at all in 5 runs (j57inpit/53 both seeds, pr10incub/58 seed 2, tz9intz9/23 both seeds).
Geometric-mean speed ratio over the (problem, seed) pairs where both reach the target: fresh vs port 239x (1e-2, 14
pairs; 17 more reached by fresh alone, none by the port alone), 356x (1e-3, 8 pairs; fresh alone 18), 307x (1e-4, 8;
fresh alone 17); fresh vs js 439x, 643x, 556x. Per problem (final gap to R of each seed; CPU seconds to R(1+1e-3) of
each seed, "-" when not reached; R against the research record's float score where there is one):

| problem | R | R / record - 1 | fresh gaps | port gaps | js gaps | fresh t 1e-3 | port t 1e-3 | js t 1e-3 |
|---|---|---|---|---|---|---|---|---|
| polyhedra/tz10intz10/2 | 1.7724855425 | -8.5e-6 | 1e-9, 0 | 8.5e-6, 7e-10 | 8.5e-6, 8.5e-6 | 0.004, 0.004 | 0.70, 0.60 | 1, 2 |
| polyhedra/pr3incub/2 | 1.2247448714 | -5.8e-8 | 4e-15, 0 | 2e-12, 2e-12 | 3e-12, 2e-12 | 0.001, 0.001 | 0.57, 0.87 | 2, 1 |
| polyhedra/j70intz12/3 | 2.1704173952 | | 1e-8, 0 | 3.7e-5, 2.1e-3 | 1.7e-3, 1.9e-5 | 0.03, 0.04 | 16.8, - | -, 8.3 |
| polyhedra/j46inbp9/2 | 1.3954241591 | | 0, 7e-15 | 4e-12, 5e-12 | 6e-12, 6e-12 | 0.002, 0.002 | 0.88, 0.34 | 2.0, 2.0 |
| polyhedra/pr9incub/8 | 4.6803735733 | -3.1e-2 | 4e-7, 0 | 3.5e-3, 3.3e-2 | 5.1e-3, 3.8e-2 | 1.3, 0.60 | -, - | -, - |
| polyhedra/dodintet/6 | 10.5191874267 | -2.2e-8 | 0, 9e-15 | 8.0e-3, 4e-11 | 3.3e-2, 3.0e-2 | 0.03, 0.02 | -, 11.8 | -, - |
| polyhedra/ktiinj39/9 | 5.6478895193 | | 0, 4e-8 | 1.0e-2, 2.3e-3 | 1.6e-2, 2.3e-3 | 0.67, 0.16 | -, - | -, - |
| polyhedra/pr7inj21/11 | 1.7139370418 | | 1e-13, 0 | 4.7e-2, 4.2e-2 | 4.5e-2, 4.3e-2 | 8.8, 3.0 | -, - | -, - |
| polyhedra/pr10incub/58 | 8.8105586574 | -2.1e-2 | 1.8e-2, 0 | 1.7e-1, none | 1.9e-1, 1.2e-1 | -, 14.4 | -, - | -, - |
| polyhedra/tz9intz9/23 | 3.4238576570 | -3.6e-2 | 2.9e-3, 0 | none, none | 2.4e-1, 1.8e-1 | -, 15.4 | -, - | -, - |
| polyhedra/bp10inpr5l2/16 | 6.5287024342 | | 0, 2.8e-3 | 6.9e-2, 7.0e-2 | 9.5e-2, 8.6e-2 | 12.6, - | -, - | -, - |
| polyhedra/j57inpit/53 | 3.3775734437 | | 1.5e-3, 0 | none, none | 1.0e-1, 1.1e-1 | -, 16.4 | -, - | -, - |
| balls/j23inball/12 | 6.2634957473 | | 6e-5, 0 | 2.6e-2, 1.7e-2 | 2.6e-2, 3.7e-2 | 6.2, 3.9 | -, - | -, - |
| balls/pr11inball/12 | 7.2743937822 | | 1.7e-3, 0 | 1.4e-2, 1.3e-2 | 2.7e-2, 1.3e-2 | -, 10.0 | -, - | -, - |
| balls/tz10inball/17 | 14.6380588692 | | 0, 1.7e-3 | 1.4e-2, 2.2e-2 | 1.3e-2, 2.2e-2 | 17.9, - | -, - | -, - |
| balls/ditinball/18 | 8.4543319807 | | 0, 1.0e-4 | 3.4e-3, 2.6e-3 | 3.3e-3, 5.2e-3 | 3.3, 3.6 | -, - | -, - |

Research records (`data/polyhedra/records.json`: the wiki's and PolyPack's own; their float scores keep clearances of
about 1e-7). On the 6 benchmark problems that have one, R is below the record on all 6: by 2e-8 and 6e-8 on dodintet/6
and pr3incub/2 (ties within the server's 1e-6 margin), by 8.5e-6 to 3.6 % on the other 4 (all PolyPack's own
problems). A seeded sample of 24 record problems with P <= 30 (seed 20261128), one 10 s fresh run each (seed 1): 17
below the record by more than 1e-6 (by 6e-4 to 7.6 %), 5 ties within 1e-6 (cubincub/3, octintet/3, tcuintcu/4,
cubintet/2, ap5incub/3: known optima, reached in 0.5 to 3 ms), 2 above (ap11incub/24 by 1.4e-3, pr5l2incub/24 by
1.1 %). Of the wiki's problems in the sample, fresh is below the record on ap6inap6/24 (1.5 %), pr5inpr5/20 (4.8 %),
cboincbo/29 (0.43 %), ticintic/26 (0.56 %) and idoinido/12 (0.06 %), and above on pr5l2incub/24; the largest margins
are on PolyPack's own problems (prisms and antiprisms with 7 to 11 sides, bipyramids, trapezohedra), whose records come
from a weaker search. Four of the record-beating packings (ap6inap6/24, pr5inpr5/20, cboincbo/29, tz7incub/23) were
re-run through the harness and pass the TypeScript validator.

Larger P, seed 1, 20 CPU seconds (final score; the first packing's time and score):

| problem | fresh | port |
|---|---|---|
| polyhedra/tetintet/200 | 7.1023 (first 9.0000 at 0.008 s) | 8.3514 (first 9.7839 at 3.9 s) |
| polyhedra/octincub/300 | 6.1685 (first 9.4124 at 0.004 s) | 7.7905 (first 9.7461 at 2.9 s) |
| polyhedra/j37inico/500 | 15.1628 (first 16.9597 at 0.012 s) | 26.1657 (first 27.7029 at 2.3 s) |
| balls/tetinball/100 | 3.5430 (first 4.9498 at 0.001 s) | 3.6184 (first 4.4401 at 0.68 s) |

First packing (`examples/firstvalid`: the constructive packing and its check, no search; measured on an earlier build,
the first packing's code has not changed since): 120 random pairs at P = 500 (a quarter of them solids in a ball at
P = 100): mean 34 ms, worst 0.18 s (j48inj60/500); 400 pairs at P = 2: mean 1 ms, worst 4 ms; 200 at P = 37: mean
2 ms; none without a packing. `tests/runs.rs` repeats this on 60 random pairs.

Caveats:

- The load. CPU-time clocks make the budgets comparable, but contention (shared caches, a 4-core machine running two
  other agents' jobs) lowers the work per CPU second unevenly; the port's jobs have wall-clock deadlines, so under load
  they get less CPU than their budget. The coordinator's quiet run is the one to trust.
- Trace granularity. Port and js record an improvement when a whole job finishes (up to a quarter of the budget);
  fresh records each checked improvement. This favours fresh in time-to-target by up to one job length, not in the final
  scores (a fresh run holds R on all 16 problems).
- Two seeds per problem. Fresh's own seeds still disagree by 1e-4 to 2 % on the larger problems (pr10incub/58,
  tz9intz9/23, bp10inpr5l2/16, j57inpit/53, pr11inball/12, tz10inball/17): R is not converged there.
- Fresh's packings are valid at tolerance 0 up to rounding (margins of about 1e-14) and pass the strict check; ties
  with a solver that uses the validator's 1e-9 tolerance can go against fresh by up to about 1e-9.

### Development history (what moved the numbers)

Same machine and load; comparisons at a fixed evaluation budget (`--evals`, deterministic), 8 to 12 problems with P 2
to 58, 2 or 3 seeds per variant. The seed-to-seed spread is large (1e-3 to 3e-2 on P >= 9), so only large differences
are reported as effects.

| change | effect [CALC] |
|---|---|
| separating planes as variables, L-BFGS, secant polish, basin hopping (first version) | tetintet/8 at 2.3874259 (the wiki record's float score less its 1e-7 clearance) in 0.16-0.32 s on 3 of 3 seeds; the port: 2.58 after 5 s |
| list only pairs not apart by the skin along the line of centres; staleness by the move bound; torques | P = 40 long prisms at density 0.5: 632 to 413 listed pairs, raw evaluation 55 to 40 us |
| cubic penalty max(0, r)^3 instead of the square | worse: geometric-mean gap 5.7e-5 vs 6.3e-8 (8 problems x 2 seeds, 200k evaluations) |
| windowed stopping (1e-3 over 40 iterations); basin threshold 2e-5 to 1e-3 | runs within 1e-3 of the best: 15/36 vs 10/36; mean gap 6.1e-3 vs 1.3e-2 (12 problems x 3 seeds, 100k evaluations) |
| re-polish every new best from 1e-4 below ("refine") | worse: mean gap 1.16e-2 vs 3.3e-3, within 1e-3 13/36 vs 20/36 (12 x 3, 200k evaluations); removed |
| each chain hops at its own compression (2e-3 x 4^u) | j46inbp9/2: the jammed state 1.9e-6 below found in 17 of 19 runs with it, 3 of 14 without; other problems within noise |
| graph walk for pieces with >= 20 vertices | raw evaluation 1.3x (deltoidal icositetrahedra in a ball) to 2.5x (truncated icosidodecahedra in a cube) faster |
| constant per-kind preconditioner factors (centres, quaternions, planes) | no change in the relaxation's convergence near jamming |
| local hops for P >= 24 | within noise (8 problems, P 27-58, x 3 seeds, 300k evaluations) |

## What to try next

- Faster relaxation near jamming. The polish's trials are the main cost (70 to 80 % of the evaluations at P >= 16): E
  settles in a few hundred L-BFGS iterations and then creeps down for thousands (slow collective sliding), so trials
  end on the window rule with E still somewhat high and the secant estimate is less sharp than it could be. A
  Gauss-Newton step with the planes eliminated (a 6P x 6P Schur complement, dense up to P of about 60) or an active-set
  Newton step on the contact equations should take a few steps where L-BFGS takes thousands.
- More diverse exploration for P >= 16, where two seeds still disagree by 1e-4 to 2 %: a population of chains with a
  dissimilarity test; symmetric starts for self-packings and the Platonic containers.
- Large P: the first descent from the lattice takes seconds per trial at P = 200-500, and a check of a jammed packing of
  complex pieces takes up to 0.4 s, so improvements there are rationed (see "Checks and the clock").
- The ball container still projects every vertex of a piece near the wall (|X| is not linear); a per-piece bound on
  |X| would skip most of them.
