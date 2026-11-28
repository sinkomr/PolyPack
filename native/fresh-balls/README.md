# fresh-balls

A search for P balls of diameter 1 in the smallest ball or scaled solid (`balls/ballin<container>/<P>`), written
from scratch for the fresh-solvers benchmark (`native/FRESH.md`). It reads only the problem definitions
(`polypack-balls`: the id, the solid's face planes) and calls the server's check
(`polypack_spaces::validate_space_submission`) on candidate packings, never inside its loops.

    fresh-balls --id balls/ballinj63/55 --seconds 60 --seed 1 [--evals E] [--verbose]

Development switches (not used by the harness): `FRESH_PARAMS="eps=1e-3,memory=5,..."` overrides the search
parameters (`search.rs: Params`), `FRESH_DEBUG=1` traces the polish trials, `FRESH_DEBUG_HOPS=1` the hops.

One thread, CPU-time clock (`thread_cpu_seconds`, read every 256 evaluations), one JSON line on stdout as the
contract says. `--evals E` stops after E energy evaluations; the run is then a function of (id, seed, E) only.

## Method

**Geometry** (`shape.rs`). A centre c is inside size s of the container when |c| <= s/2 - 1/2 (ball, s its
diameter) or N_f . c <= s b_f - 1/2 for every face (solid: s times the canonical solid about its vertex centroid;
the cube is the case N = +-e_k, b = 1/2). The search needs no other description of the container.

**Energy** (`energy.rs`). At a fixed size s, with centres x in R^{3P},

    E(x) = sum_{i<j} max(0, 1 - |c_i - c_j|)^2 + sum_i sum_f max(0, N_f . c_i - (s b_f - 1/2))^2

(ball container: the last term is max(0, |c_i| - (s/2 - 1/2))^2), with its analytic gradient. E = 0 exactly
when the packing fits at s. Verlet lists keep it cheap: at a rebuild the pairs closer than 1 + 0.35 and, per ball,
the faces within 0.35 are listed; the lists stay exact while every ball has moved less than half the skin and the
faces have moved inward (s shrank) by less than the rest, which each evaluation checks in O(P). Flat arrays, no
allocation after setup.

**Relaxation** (`lbfgs.rs`). L-BFGS (memory 5) with an Armijo backtracking line search (safeguarded quadratic
steps) and a cap of 0.25 on any coordinate's move per step; it stops on E <= 1e-26, a small gradient, or a
stalled relative decrease.

**Repair and polish** (`search.rs`). `repair` turns any arrangement into a valid packing by scaling the centres
about the origin by 1 / (least pair distance) and taking the least size that holds them (with 1e-14 relative
margins, so the packing is valid without the validator's 1e-9 tolerance). `polish` finds the arrangement's
jamming size s*: relaxed at s < s*, E is about k (s* - s)^2, so sqrt(E) is close to linear in s; each trial
relaxes at a size just below the secant estimate of s* from the two latest infeasible trials (their distance to s*
shrinks every step, so the secant converges superlinearly), and every trial's repair is a valid upper bound. It
stops when the valid bound and the infeasible bound meet to 2e-13 relative (about six trials), or as soon as the
secant shows the arrangement cannot beat the best.

**Search** (`search.rs`). Monotonic basin hopping on E at a size held 0.1 % below the best packing found:
perturb the current arrangement, relax, accept when E is lower (by more than 2e-5 relative, the noise of the
exploring relaxation). Moves, chosen with probabilities that follow their recent success: jitter every ball
(amplitude log-uniform in 0.02..0.5), jitter a cluster about a random ball, or move 1-3 balls (the most squeezed,
by energy share, or random ones) to the emptiest of 24 random places. A hop that relaxes back to within 0.01 of
the current arrangement (rattlers excepted) stops early as a return to the same basin. An accepted arrangement
whose repair is within 0.5 % of the best is polished, and a polished packing below the best is checked and becomes
the best (then hopping resumes from it at the new size). After 40 + 3P rejections in a row the chain restarts, in
turn from the best shaken by 0.3, from random centres, or (every other restart) from a lattice cut by the
container: close-packed layers stacked ABC (FCC) or AB (HCP), or square layers (FCC along a cube axis), with the
layers parallel to a random face and rows along one of its edges (3 times in 4; otherwise a random orientation),
scaled about the origin until every centre is inside.

**Validity.** Only packings that `validate_space_submission("balls", id, config, default)` accepts enter the trace
or the output, at the score the check returns; if the check refused a packing, its size would be enlarged by
1e-12, 1e-10, ... relative and checked again (in the tests and runs so far it never refused one).

## Tests

    cargo test --release -p polypack-fresh-balls

- `tests/geometry.rs`: on 15 containers (ball, cube, Platonic, Catalan, bipyramids, prisms, trapezohedra, Johnson
  solids) and random cases, the wall gap and the least size agree with the validator's to 1e-12; each pair term of
  the energy is the square of the validator's overlap depth; the wall term lies between the square of the
  validator's worst protrusion and F times it; E = 0 exactly when the validator (at tolerance 0) accepts the
  packing, also near contact; the gradient matches finite differences; the neighbour lists give the full energy
  after many moves and size changes; repaired packings pass the server's check, and are valid at tolerance 0;
  random and lattice starts lie in the container, and the face frames are orthonormal.
- `tests/runs.rs`: short runs on 10 problems give packings that pass the check at the reported score, with an
  improving trace that ends at it; runs with an evaluation budget are reproducible from the seed.

## Measurements

Harness `native/tools/fresh` (`run.py`, `validate.mts`, `analyze.py`), 20 CPU seconds per run, seeds 1 and 2, two
runs at a time, 2026-11-20 on this Mac (6 performance + 2 efficiency cores) **while other benchmark jobs were
benchmarking: load average 30-170**, so runs were often far from a full core (a 20 s run took 30-130 s of wall
time). R is the best final score of any run of the problem (all three solvers). Every one of the 57 final
packings below passed the server's TypeScript validators with matching scores (`ts_valid`, `ts_score_match`).

The 8 balls problems of `problems.json` (seed 20261121), 16 runs per solver [CALC]:

| solver | reach R(1+1e-2) | median t | reach R(1+1e-3) | median t | reach R(1+1e-4) | median t | mean gap at 1 s | at 5 s | at 20 s |
|---|---|---|---|---|---|---|---|---|---|
| fresh | 16/16 | 0.056 s | 16/16 | 0.32 s | 16/16 | 0.49 s | 8.8e-5 | 1.8e-5 | 2.2e-7 |
| port | 16/16 | 0.75 s | 10/16 | 0.87 s | 7/16 | 0.84 s | 5.4e-3 | 2.6e-3 | 1.0e-3 |
| js | 16/16 | 1.0 s | 6/16 | 1.0 s | 5/16 | 1.0 s | none yet | 4.5e-3 | 1.7e-3 |

Geometric-mean speed ratio over the (problem, seed) pairs where both reach the target: fresh vs port 18x (1e-2),
23x (1e-3), 32x (1e-4); fresh vs js 37x, 74x, 86x. Per problem (worst final gap of the two seeds; median time to
the target, or how many runs reached it):

| problem | R | fresh gap / t 1e-3 / t 1e-4 | port gap / t 1e-3 / t 1e-4 | js gap / t 1e-3 / t 1e-4 |
|---|---|---|---|---|
| ballinbp10/10 | 0.7381632568 | 7e-16 / 0.04 s / 0.04 s | 1.4e-10 / 0.46 s / 0.46 s | 1.4e-10 / 1.0 s / 1.0 s |
| ballinbp3/41 | 3.7847242598 | 3e-14 / 0.77 s / 0.79 s | 1.8e-3 / 1 of 2 / 1 of 2 | 5.0e-3 / 0 of 2 / 0 of 2 |
| ballinj25/33 | 1.3518754902 | 3e-15 / 0.06 s / 0.06 s | 1.3e-10 / 5.8 s / 5.8 s | 1.3e-3 / 1 of 2 / 1 of 2 |
| ballinj52/7 | 1.6952403231 | 9e-16 / 0.005 s / 0.006 s | 1.5e-10 / 0.70 s / 0.70 s | 1.5e-10 / 1.0 s / 1.0 s |
| ballinj54/37 | 2.3903901370 | 1e-13 / 0.35 s / 0.49 s | 2.6e-3 / 0 of 2 / 0 of 2 | 2.0e-3 / 0 of 2 / 0 of 2 |
| ballinj55/43 | 2.4379486021 | 2e-15 / 0.97 s / 0.97 s | 6.9e-3 / 0 of 2 / 0 of 2 | 3.7e-3 / 0 of 2 / 0 of 2 |
| ballinj63/55 | 3.4880883903 | 1e-14 / 0.34 s / 0.44 s | 2.5e-4 / 5.4 s / 0 of 2 | 5.7e-3 / 1 of 2 / 0 of 2 |
| ballinj86/46 | 3.1137321030 | 3.4e-6 / 0.76 s / 5.1 s | 1.6e-3 / 1 of 2 / 0 of 2 | 1.6e-3 / 0 of 2 / 0 of 2 |

Three larger problems, seed 1 only (final score; time to R(1+1e-3)):

| problem | fresh | port | js |
|---|---|---|---|
| ballinball/60 | 4.7749335903 (0.65 s) | 4.7793578922 (7.0 s) | 4.7793578922 (10.7 s) |
| ballincub/55 | 3.8186348557 (3.9 s) | 3.8274160753 (never) | 3.8240123368 (never) |
| ballintet/48 | 7.4448176875 (0.07 s) | 7.4463809779 (0.75 s) | 7.4465249811 (1.0 s) |

Caveats:

- The load. CPU-time clocks make the budgets comparable, but contention (shared caches, efficiency cores) lowers
  the work per CPU second unevenly. The port's jobs have wall-clock deadlines (as in the client), so under this
  load it got less CPU than its budget (bp10/10 seed 2: 120 s of wall time for a 20 s budget); fresh and js
  are bounded by CPU time only. The coordinator's quiet 60 s run is the one to trust.
- Trace granularity. Port and js record an improvement when a whole job finishes (a job is up to a quarter of the
  budget); fresh records each checked improvement. This favours fresh in time-to-target by up to one job length,
  but not in the final scores: fresh's is the best on all 11 problems, on 3 of them only by polish precision
  (bp10/10, j25/33, j52/7: port and js found the same arrangement, 1.3e-10 to 1.5e-10 relative higher).
- Two seeds per problem; fresh's own seeds disagree on the hardest instances (in development runs cub/55 ended
  between 3.8104 and 3.8199, oct/52 between 4.80577 and 4.80998 within 10 s), so R itself is not converged there.
- Fresh does not use the validator's 1e-9 tolerance: its packings are valid at tolerance 0 (1e-14 relative
  margins), so ties with a solver that does use it can go against fresh by up to about 1e-9.

### Development history (what moved the numbers)

All on this Mac, CPU-time clocks, 2 processes at a time; the machine was shared with other benchmark jobs
(load average 18-32 on 8 cores for most of the later runs), so absolute speeds are indicative only.

| change | effect [CALC] |
|---|---|
| L-BFGS loops as bounds-check-free zipped iterators | profile: L-BFGS vector work was 75 % of the time; evaluations/s +45 % (j63/55: 200k to 294k) |
| polish trials just below the secant estimate, bisection after a feasible trial | polish converges to ~1e-12 relative in about 6 trials (it stalled near 1e-9 before) |
| abort a polish once it cannot beat the best; looser tolerance for its early trials | polish evaluations per polish 8k to 3.7k (j63/55) |
| energies within 2e-5 at the hopping size are the same basin (no re-polish of the best's basin) | polish share of evaluations 26 % to 2 % (j52/7), 38 % to 14 % (j63/55) |
| hops that fall back within 0.01 of the current arrangement stop early | +7 % hops on j63/55 (over half the jitter hops return to the current basin) |
| L-BFGS memory 8 to 5, hopping compression 2e-3 to 1e-3 | hard set, 10 s: runs within 1e-6 of the reference 13/20 to 18/20 |
| face-aligned lattice starts; repolish of creeping bests | no measurable difference (kept the lattices, dropped the repolish) |

## What to try next

- A cheaper polish: an active-set Newton step on the contact equations (or an augmented Lagrangian with s as a
  variable) instead of 6-10 relaxations per polish.
- Fewer iterations per hop (about 300 L-BFGS iterations at P = 55, mostly the slow linear tail): a
  preconditioner from the contact network, or FIRE for the early phase.
- More diverse exploration for the hardest instances (population basin hopping with a dissimilarity test), since
  rare arrangements (cub/55 at 3.8104) are found by one seed in several.
- Container symmetry: symmetric starts and moves for the Platonic and Catalan containers.
