# Shape continuation (`morph`)

[CALC] `morph` starts from a supplied arrangement, or an automatic seed sub-run
with 3–24 assessments (5% of the available evaluation budget, clipped by the
framework). It warms a sequence of local shape problems from the previous
stage's raw arrangement. Each accepted local step, stage endpoint and final
endpoint attempts sharp-piece repair by uniform expansion about the centroid.
Only repaired true-shape arrangements with every pair gap >=0 are submitted
through `ctx.evaluate`. Exact duplicate submissions and repeated local-solve
starts are skipped. Intermediate soft shapes are never evaluated as valid
unit-piece packings. A previously assessed valid packing remains a fallback.
Incomplete starts use the existing scatter generator; coincident starts receive
seeded separating moves before expansion. No record coordinates are used.

## Shape families and geometry

[CALC] Every regular N-gon P has side 1, inradius r and circumradius R, with the
repository's vertex-up angle convention. The **inscribed** path is
`S(t)=tP (+) disc((1-t)r)`: S(0) is the inradius circle, S(1)=P, and
S(t) is contained in P, since the disk is contained in P and P is convex.
The **circumscribed** path is `tP (+) disc((1-t)R)`: it starts from the
circumradius circle and contains P at every stage, since P is contained in that
disk. The same construction applies to triangles, squares, pentagons, hexagons
and every other supported regular polygon; no shape-specific contact patterns
are hard-coded. Corner radius is `(1-t)r` or `(1-t)R`, respectively.

[CALC] The scale/padding extension is backward compatible. Optional final
arguments `scale=1, padding=0` were added to geometry `pairPenetration`,
`visitContainerProtrusions`, `containerProtrusions`, and the solver's
`createPenaltyObjective`. Existing callers retain their original arithmetic and
selected SAT branches. Circle pieces use radius `scale+padding`. A collapsed
polygon core uses an exact disk test with radius padding and zero angular
pair derivatives. Broad-phase reach is `2*(scale*boundingRadius+padding)`.
Polygon walls use support of the scaled core plus padding; circular walls use
the maximum vertex radius plus padding. These containment tests are exact.

[EST] Shared polygon SAT reports a **lower bound** on disjoint Euclidean
distance, not that distance itself (`packages/geometry/src/overlap.ts`).
[CALC] Therefore the literal formula
`sharedSAT(tP_a,tP_b)-2padding` cannot simultaneously give true rounded
distances and the exact circle endpoint. For overlapping cores, signed SAT is
exact. For disjoint cores with positive padding, this implementation finds the
Euclidean closest vertex/segment features, then subtracts twice the padding.
This is the signed distance of the disk-offset Minkowski difference. Local
vertex offsets prevent tiny cores from collapsing at large coordinates;
coincident closest features reuse the bounded SAT derivative. At the sharp
endpoint padding=0 the legacy SAT result is retained, including its positive
distance convention. Thus positive reported distances can change at that
endpoint, while feasibility and the active penetration penalty are continuous.

[CALC] The square **superellipse** path uses
`|x|^p+|y|^p <= (1/2)^p` in axes rotated by `theta+pi/4`. It starts at p=2,
a circle of radius 1/2, and increases geometrically to `maxExponent` on the
last finite base stage (when there are at least three stages), then changes to
the exact unit square. It uses an inscribed convex polygon sampled at K
uniform polar angles, K rounded up to a multiple of eight. Shared generic
`polygonSeparation` tests this polygon. These stages always use gradient-free
hard-particle Monte Carlo, even when `localMethod="penalty"`; the exact-square
stage uses the selected local method. For N other than 4, requesting this path
uses the rounded family. The family parameter has no effect on square
superellipse stages.

[CALC] The polygon's Hausdorff error is **at most pi/K**. In each octant the
radial boundary `rho=(1/2)/(cos^p(a)+sin^p(a))^(1/p)` satisfies
`|rho'/rho|<=1`, and `rho<=1/sqrt(2)`, hence its boundary speed is <=1.
Each omitted boundary point is within half the angular sample interval of a
sample; the polygon lies inside the convex superellipse. This conservative
bound applies for every p>=2, including 2, 4, 8 and 32. Default K=64 gives
pi/64≈0.04909; it is a certified upper bound, not the typical error. The
finite-p superellipse is at most `(1-2^(-1/p))/sqrt(2)` from the square:
distance to a convex set reaches its maximum over the square at a corner,
whose closest superellipse point lies on the diagonal. At p=32 this is
approximately 0.01515. Final repair and final shape are exact unit squares,
so neither approximation is used for result validity or score.

## Local stages, schedule and budgets

[CALC] Penalty stages reuse the existing analytic augmented objective and
L-BFGS machinery. The weight starts at 10 and grows by four when residual
reduction is insufficient. Each stage has at most six outer solves and 120
accepted inner iterations per solve by default. Objective values are cached
per solve to avoid repeating identical line-search evaluations. A solve with
no accepted step, or a repeated solve-start state, ends the stage. New shapes
reset multipliers. SAT feature switches remain nonsmooth; this is a heuristic
continuation method, not a certified homotopy curve tracker.

[CALC] Monte Carlo stages propose P single-piece translations/rotations per
sweep, reject negative shape separation or positive protrusion, contract
centres by 0.998 after five diffusion sweeps, and tighten the explicit enclosure.
Initial enclosure slack is 3%. Move widths adapt toward 30% acceptance.
Forty unchanged sweeps or 200 sweeps without size improvement end a stage.
No temperature schedule is used. This rounded-shape variant follows the
`mc_compress` hard-particle mechanism; it does not invoke the registered sharp
method on incompatible shapes. Circle pieces have nothing to morph and
receive **one** local stage of the selected mechanism, followed by the
framework's automatic polish. It deliberately avoids a nested local-method
start reassessment.

[CALC] Base stages have `t=(j/(stages-1))^spacing`, including exactly 0 and 1.
Adaptive scheduling halves a next step when the preceding stage's residual
exceeds `residualThreshold`, adding at most two stages per base interval.
Monte Carlo has zero overlap residual, so its adaptive schedule is unchanged.
Before every stage, homothetic centre rescaling with bisection removes deep
next-shape overlap and tightens to that shape's first contact. Shapes and all
random choices are deterministic for a seed and an evaluation-only budget.
Assessments are split equally over the then-remaining stages; convergence and
stagnation may end a stage early. The budget is a ceiling, not an instruction
to pad the run with duplicate assessments. All counted work goes through
`ctx.evaluate` or the initial `ctx.run("seed")`; numerical gradients, local
line searches and feasibility tests follow the existing penalty counting
convention. Checkpoints cover stage boundaries, inner iterations, MC moves
and batches of pair tests during rescaling.

## Parameter schema and defaults

[CALC] The registered schema is an object with `additionalProperties:false`.
Every node has a title and description; every property has a default.

| Parameter         | Default   | Allowed values / purpose                          |
| ----------------- | --------- | ------------------------------------------------- |
| path              | rounded   | rounded, superellipse                             |
| family            | inscribed | inscribed, circumscribed                          |
| localMethod       | penalty   | penalty, mc_compress                              |
| stages            | 7         | Integer 2–64, endpoints included                  |
| spacing           | 1         | 0.25–4, schedule power                            |
| adaptive          | true      | Boolean, bounded residual-based subdivisions      |
| residualThreshold | 0.02      | 0–1, in piece units                               |
| maxExponent       | 32        | 2–128, final finite superellipse exponent         |
| vertices          | 64        | Integer 16–256, rounded up to a multiple of eight |
| innerIterations   | 120       | Integer 1–2000, per outer solve                   |
| outerIterations   | 6         | Integer 1–30, per shape                           |
| initialWeight     | 10        | 0.001–1e8                                         |
| jitter            | 0.03      | 0–0.5, initial seeded pose perturbation           |
| mcSweeps          | 2000      | Integer 1–20000, per shape                        |
| translationStep   | 0.1       | 1e-6–0.5, MC displacement half-width              |
| rotationStep      | 0.1       | 1e-6–0.5, MC angular half-width in radians        |

## Fit and limitations

[SPEC] Continuation can help when sharp contacts prevent a useful rearrangement,
but may carry the same poor topology through every stage. More stages trade
local work for finer shape changes and do not guarantee better packings. The
measured comparisons below establish where that occurs on this benchmark;
defaults were chosen as general work limits before the twenty-seed measurements,
not tuned on a few successful seeds. Rounded penalty is generally cheaper than
sampled-superellipse MC; generic polygon SAT has quadratic vertex cost.

[EST] The framework's final polish is float64 SQP/Newton, not the optional
50-digit mpmath stage under `python/`. The current framework's strict
margin is `1e-12 + 4*Number.EPSILON*maxAbsCoordinate`: approximately 1e-12
near the origin, larger when coordinate subtraction has less precision.
It can retain an existing supplied/seed/polish best with a tiny negative
gap even when every candidate submitted by morph has gap >=0. Morph cannot
change that selection rule, the seed child's internal duplicate assessments,
or the final container's rounding.
A global zero-tolerance guarantee would require zero-gap best tracking and
outward-safe result containment in `framework.ts`, zero-gap restoration for
polygons in `polish.ts`, and strict/deduplicated seed assessments in `seed.ts`.
A zero time or already-aborted no-start
run, or a one-evaluation budget reserved for polish, can have no valid result;
the framework never executes this method in those circumstances. Supplied
valid starts are still assessed mandatorily. Abort response was measured for
P<=20, N/M<=8; an atomic shared enclosure/auto-orientation call cannot be
preempted at arbitrary input sizes. Browser throughput was not measured.

[CALC] An independent review verified 12,000 random pair derivative checks,
8,000 core-contact stress cases and 4,000 legacy comparisons. It found the two
degenerate-distance issues fixed above and the gradient-test filtering issue.

## References and verification

[EST] Verified on 2026-10-09 from the linked primary sources:

- Eugene L. Allgower and Kurt Georg, _Numerical Continuation Methods: An
  Introduction_, Springer Series in Computational Mathematics 13, Springer,
  1990, xiv + 388 pages. Chapters “The Basic Principles of Continuation
  Methods,” pp. 7–16, and “Steplength Adaptations for the Predictor,” pp. 44–60.
  [Publisher metadata and contents](https://link.springer.com/book/10.1007/978-3-642-61257-2)
  verify authors, title, year and page ranges. This supports the continuation
  concept, not convergence of this nonsmooth packing implementation.
- Hossein Mobahi and John W. Fisher III, “A Theoretical Analysis of Optimization
  by Gaussian Continuation,” _Proceedings of the Twenty-Ninth AAAI Conference
  on Artificial Intelligence_ 29 (1), 2015, pp. 1205–1211.
  [Publisher metadata](https://ojs.aaai.org/index.php/AAAI/article/view/9356)
  verifies authors, title, venue and year; the
  [publisher's seven-page PDF](https://cdn.aaai.org/ojs/9356/9356-13-12884-1-2-20201228.pdf)
  has printed first and last pages 1205 and 1211. Its analysis concerns Gaussian
  objective continuation; its convergence bounds are not claimed for the shape
  continuation implemented here.
- Yang Jiao, Frank H. Stillinger and Salvatore Torquato, “Optimal Packings of
  Superdisks and the Role of Symmetry,” _Physical Review Letters_ 100 (24),
  245504, 2008, pp. 245504-1–245504-4.
  [Author-hosted published paper](https://fhstillinger.github.io/FrankStillingerWebsite/fhspapers/fhspaper334.pdf)
  verifies authors, title, venue, date, pages and the superdisk family. Their
  exponent is 2p; this implementation's exponent is p, and its half-width is
  1/2. The paper studies dense periodic superdisk packings; this method does
  not claim to reproduce its algorithm or to certify finite-container optima.

[CALC] No separately verified paper using this precise polygon Minkowski-sum
continuation in finite regular containers was found, so none is claimed.

## Verification and benchmarks

Benchmark measurements follow. Commands are run from the repository root,
with dependencies already installed.

[CALC] The method's own test file (`packages/solver/test/morph.test.ts`, 20
tests) was measured at **4.107 s**. The optional scale/padding extension of the
shared penalty geometry is covered by `packages/geometry/test/penalty.test.ts`.

[CALC] Benchmark: seeds 1–20, no supplied start, final polish enabled, budgets
3,000 and 30,000. Every row uses all twenty seeds without selection. Comparison
success means absolute error <=1e-4 or <=1e-9 against the value stored in
`data/records.json`; truncated printed records make the 1e-9 count informational,
not a proof of failure to attain their underlying construction. Median is the
average of sorted positions 10 and 11; worst is the maximum. Wall times are
median / worst seconds per complete run. Stage-count comparisons use square/
square P=5 and pentagon/pentagon P=6; all family comparisons use the full
problem list. Square-path comparisons include both default rounded
penalty and rounded MC so the geometry-path effect can be compared with a
similar MC mechanism. The superellipse final exact-square stage uses penalty.
Node v26.5.0 on darwin/arm64.

### N=4, M=4, P=5

[EST] Stored published value: 2.70710678118654; [source](https://kingbird.myphotos.cc/packing/squares_in_squares.html).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.0547 / 0.0798         | 322–1066      |  1.77636e-15 |
|   3000 | rounded       | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.2571 / 0.3514         | 1053–1916     |  1.77636e-15 |
|   3000 | circumscribed | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.1342 / 0.3810         | 1165–1923     |  1.77636e-15 |
|   3000 | 3 stages      | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.2742 / 0.4125         | 417–1255      |  1.77636e-15 |
|   3000 | 13 stages     | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.6110 / 1.0558         | 1992–2838     |  1.77636e-15 |
|   3000 | superellipse  | 20/20 |       10/20 |       10/20 | 2.737436980866 | 2.828427124746 | 1.4148 / 1.7119         | 2760–3000     | -8.43769e-15 |
|   3000 | rounded MC    | 20/20 |       14/20 |       14/20 | 2.707106781191 | 2.828427124746 | 0.5547 / 0.9338         | 2611–3000     | -8.77076e-15 |
|  30000 | penalty       | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.0678 / 0.1020         | 322–1066      |  1.77636e-15 |
|  30000 | rounded       | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.3440 / 0.5222         | 1053–1916     |  1.77636e-15 |
|  30000 | circumscribed | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.1502 / 0.2124         | 1165–2105     |  1.77636e-15 |
|  30000 | 3 stages      | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.1277 / 0.2090         | 417–1255      |  1.77636e-15 |
|  30000 | 13 stages     | 20/20 |        0/20 |        0/20 | 2.828427124746 | 2.828427124746 | 0.5875 / 1.6391         | 2192–3542     |  1.77636e-15 |
|  30000 | superellipse  | 20/20 |        9/20 |        9/20 | 2.767767317155 | 2.828427124746 | 3.6193 / 8.8809         | 4204–11609    |  1.77636e-15 |
|  30000 | rounded MC    | 20/20 |       12/20 |       12/20 | 2.707106781189 | 2.828427124746 | 1.0756 / 1.6719         | 2817–8662     |  1.77636e-15 |

### N=4, M=4, P=10

[EST] Stored published value: 3.70710678118654; [source](https://kingbird.myphotos.cc/packing/squares_in_squares.html).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |        0/20 |        0/20 | 4.000000000001 | 4.000000000001 | 0.2447 / 0.3057         | 297–841       |  1.71196e-13 |
|   3000 | rounded       | 20/20 |       20/20 |       19/20 | 3.707106781189 | 3.707171862916 | 1.5802 / 1.6252         | 2944–3000     | -8.32667e-15 |
|   3000 | circumscribed | 20/20 |       20/20 |       20/20 | 3.707106781189 | 3.707106781190 | 0.7047 / 0.7877         | 2939–3000     |  1.69975e-13 |
|   3000 | superellipse  | 20/20 |        8/20 |        3/20 | 3.707642686843 | 3.859704450932 | 4.5755 / 5.5099         | 2822–3000     | -8.88178e-16 |
|   3000 | rounded MC    | 20/20 |        8/20 |        3/20 | 3.719110970163 | 3.871952289037 | 1.2175 / 1.7487         | 2854–3000     | -1.67644e-14 |
|  30000 | penalty       | 20/20 |        0/20 |        0/20 | 4.000000000001 | 4.000000000001 | 0.2173 / 0.2621         | 297–841       |  1.71196e-13 |
|  30000 | rounded       | 20/20 |       20/20 |       19/20 | 3.707106781189 | 3.707118774519 | 2.3852 / 3.2365         | 4701–5556     |  1.70974e-13 |
|  30000 | circumscribed | 20/20 |       20/20 |       20/20 | 3.707106781190 | 3.707106781193 | 1.1993 / 1.3980         | 4870–5065     |  1.65978e-13 |
|  30000 | superellipse  | 20/20 |       11/20 |        5/20 | 3.707164476097 | 3.823709620904 | 15.5187 / 20.8091       | 6633–12353    | -1.60982e-14 |
|  30000 | rounded MC    | 20/20 |        6/20 |        2/20 | 3.718727526311 | 3.843632732466 | 3.6179 / 4.6950         | 6643–11787    | -1.76525e-14 |

### N=4, M=4, P=11

[EST] Stored published value: 3.87708359002281; [source](https://kingbird.myphotos.cc/packing/squares_in_squares.html).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |        0/20 |        0/20 | 4.000000000001 | 4.000000000001 | 0.5698 / 0.7179         | 990–1960      |  1.68976e-13 |
|   3000 | rounded       | 20/20 |        0/20 |        0/20 | 4.000000000001 | 4.000000000001 | 1.2967 / 1.7345         | 2789–3000     | -1.17684e-14 |
|   3000 | circumscribed | 20/20 |        0/20 |        0/20 | 3.976888317326 | 4.000000000001 | 0.8328 / 1.0282         | 2789–3000     | -1.82077e-14 |
|   3000 | superellipse  | 20/20 |        0/20 |        0/20 | 3.940756372856 | 4.000000000001 | 4.9787 / 5.3388         | 2789–3000     | -1.12133e-14 |
|   3000 | rounded MC    | 20/20 |        0/20 |        0/20 | 3.950326475848 | 4.000000000001 | 1.3101 / 1.6807         | 2789–3000     | -1.80966e-14 |
|  30000 | penalty       | 20/20 |        0/20 |        0/20 | 4.000000000001 | 4.000000000001 | 0.5563 / 0.6758         | 990–1960      |  1.68976e-13 |
|  30000 | rounded       | 20/20 |        0/20 |        0/20 | 4.000000000001 | 4.000000000001 | 2.1747 / 2.8054         | 4398–4902     | -4.21885e-15 |
|  30000 | circumscribed | 20/20 |        0/20 |        0/20 | 3.951423473877 | 4.000000000001 | 1.3887 / 2.1246         | 4626–6237     | -1.76525e-14 |
|  30000 | superellipse  | 20/20 |        0/20 |        0/20 | 3.914213648487 | 4.000000000001 | 18.0745 / 23.2793       | 5440–13873    | -1.94289e-14 |
|  30000 | rounded MC    | 20/20 |        0/20 |        0/20 | 3.939270363885 | 3.954425464521 | 4.9918 / 6.5866         | 8976–14420    | -1.97620e-14 |

### N=3, M=3, P=5

[EST] Stored published value: 2.732; [source](https://erich-friedman.github.io/packing/triintri/).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |        0/20 |        0/20 | 3.000000000000 | 3.000000000000 | 0.1270 / 0.1578         | 1077–1756     | -3.33067e-16 |
|   3000 | rounded       | 20/20 |        0/20 |        0/20 | 2.958396052832 | 3.000000000000 | 0.5321 / 0.5884         | 2348–3000     | -1.33227e-15 |
|   3000 | circumscribed | 20/20 |        0/20 |        0/20 | 2.958552246680 | 3.000000000000 | 0.2345 / 0.2994         | 2589–3000     | -1.69864e-14 |
|  30000 | penalty       | 20/20 |        0/20 |        0/20 | 3.000000000000 | 3.000000000000 | 0.1259 / 0.1587         | 1077–1756     | -3.33067e-16 |
|  30000 | rounded       | 20/20 |        0/20 |        0/20 | 2.979356412372 | 3.000000000000 | 0.6925 / 0.9319         | 3300–5401     | -1.22125e-14 |
|  30000 | circumscribed | 20/20 |        0/20 |        0/20 | 3.000000000000 | 3.000000000000 | 0.2631 / 0.4330         | 2923–4399     | -3.33067e-16 |

### N=3, M=3, P=7

[EST] Stored published value: 3; [source](https://erich-friedman.github.io/packing/triintri/).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |       20/20 |       20/20 | 3.000000000000 | 3.000000000000 | 0.3856 / 0.4321         | 1662–2124     | -3.33067e-16 |
|   3000 | rounded       | 20/20 |       20/20 |       20/20 | 3.000000000000 | 3.000000000000 | 0.7777 / 0.8050         | 2789–2789     | -3.33067e-16 |
|   3000 | circumscribed | 20/20 |       20/20 |       20/20 | 3.000000000000 | 3.000000000000 | 0.2839 / 0.3024         | 2789–2789     | -3.33067e-16 |
|  30000 | penalty       | 20/20 |       20/20 |       20/20 | 3.000000000000 | 3.000000000000 | 0.3856 / 0.4295         | 1662–2124     | -3.33067e-16 |
|  30000 | rounded       | 20/20 |       20/20 |       20/20 | 3.000000000000 | 3.000000000000 | 1.2304 / 1.3050         | 3906–4565     | -3.33067e-16 |
|  30000 | circumscribed | 20/20 |       20/20 |       20/20 | 3.000000000000 | 3.000000000000 | 0.4622 / 0.4868         | 3993–4581     | -3.33067e-16 |

### N=5, M=5, P=6

[EST] Stored published value: 2.61803; [source](https://erich-friedman.github.io/packing/peninpen/).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |       20/20 |        0/20 | 2.618034170192 | 2.618034940925 | 0.4345 / 0.4457         | 3000–3000     |  1.99729e-13 |
|   3000 | rounded       | 20/20 |       19/20 |        0/20 | 2.618034023212 | 2.809016994375 | 0.7112 / 0.8223         | 2356–3000     |  1.23235e-14 |
|   3000 | circumscribed | 20/20 |       18/20 |        0/20 | 2.618034025936 | 2.809016994375 | 0.4183 / 0.4823         | 1467–3000     |  1.55431e-14 |
|   3000 | 3 stages      | 20/20 |       17/20 |        0/20 | 2.618034017030 | 2.809016994375 | 0.5623 / 0.6454         | 631–3000      |  1.94511e-13 |
|   3000 | 13 stages     | 20/20 |       19/20 |        0/20 | 2.618034056112 | 2.809016994375 | 0.7671 / 0.8217         | 2790–3000     |  1.94511e-13 |
|  30000 | penalty       | 20/20 |       20/20 |        0/20 | 2.618034063925 | 2.618034877397 | 0.7544 / 0.8091         | 3499–5575     | -1.11022e-14 |
|  30000 | rounded       | 20/20 |       19/20 |        0/20 | 2.618034001312 | 2.809016994375 | 1.2577 / 1.5805         | 2356–7227     | -2.33147e-15 |
|  30000 | circumscribed | 20/20 |       17/20 |        0/20 | 2.618034018777 | 2.809016994375 | 0.9477 / 1.0867         | 1467–7473     | -5.21805e-15 |
|  30000 | 3 stages      | 20/20 |       17/20 |        0/20 | 2.618033988896 | 2.809016994375 | 0.8679 / 0.9597         | 631–5226      |  2.77556e-15 |
|  30000 | 13 stages     | 20/20 |       20/20 |        0/20 | 2.618033988911 | 2.618034090150 | 1.7568 / 2.0190         | 6762–9241     | -1.35447e-14 |

### N=5, M=5, P=10

[EST] Stored published value: 3.68324; [source](https://erich-friedman.github.io/packing/peninpen/).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |        0/20 |        0/20 | 3.790207717751 | 3.791158156992 | 1.0120 / 1.0984         | 2127–3000     | -6.43929e-15 |
|   3000 | rounded       | 20/20 |        0/20 |        0/20 | 3.693818711709 | 3.740808648410 | 1.4667 / 1.6088         | 3000–3000     | -1.87628e-14 |
|   3000 | circumscribed | 20/20 |        0/20 |        0/20 | 3.704784382894 | 3.785027653706 | 0.6841 / 0.7375         | 3000–3000     | -1.95399e-14 |
|  30000 | penalty       | 20/20 |        0/20 |        0/20 | 3.790207717751 | 3.791157762080 | 1.0196 / 2.1259         | 2127–5169     | -1.27676e-14 |
|  30000 | rounded       | 20/20 |        0/20 |        0/20 | 3.693452228006 | 3.730950811938 | 3.7961 / 4.0638         | 5732–8202     | -1.05471e-14 |
|  30000 | circumscribed | 20/20 |        0/20 |        0/20 | 3.698250915286 | 3.729675925141 | 2.3389 / 2.5896         | 5386–8178     | -1.88738e-14 |

### N=6, M=6, P=7

[EST] Stored published value: 2.886; [source](https://erich-friedman.github.io/packing/hexinhex/).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |        0/20 |        0/20 | 2.886751345948 | 2.886751345948 | 0.0961 / 0.1277         | 527–782       |  1.98952e-13 |
|   3000 | rounded       | 20/20 |        0/20 |        0/20 | 2.886751345948 | 2.886751345948 | 0.7416 / 0.9365         | 1268–2066     |  1.98952e-13 |
|   3000 | circumscribed | 20/20 |        0/20 |        0/20 | 2.886751345948 | 2.886751345948 | 0.3359 / 0.4675         | 1294–2107     |  1.98952e-13 |
|  30000 | penalty       | 20/20 |        0/20 |        0/20 | 2.886751345948 | 2.886751345948 | 0.0946 / 0.1182         | 527–782       |  1.98952e-13 |
|  30000 | rounded       | 20/20 |        0/20 |        0/20 | 2.886751345948 | 2.886751345948 | 0.7408 / 0.9306         | 1268–2066     |  1.98952e-13 |
|  30000 | circumscribed | 20/20 |        0/20 |        0/20 | 2.886751345948 | 2.886751345948 | 0.3333 / 0.4705         | 1294–2107     |  1.98952e-13 |

### N=6, M=6, P=10

[EST] Stored published value: 3.732; [source](https://erich-friedman.github.io/packing/hexinhex/).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |        0/20 |        0/20 | 3.752776749733 | 3.752776749733 | 0.2070 / 0.2820         | 270–714       |  1.82299e-13 |
|   3000 | rounded       | 20/20 |        0/20 |        0/20 | 3.752776749733 | 3.752776749733 | 1.4806 / 1.5301         | 2470–2790     |  1.82299e-13 |
|   3000 | circumscribed | 20/20 |        0/20 |        0/20 | 3.752776749733 | 3.752776749733 | 0.6608 / 0.7333         | 2488–2790     |  1.82299e-13 |
|  30000 | penalty       | 20/20 |        0/20 |        0/20 | 3.752776749733 | 3.752776749733 | 0.2062 / 0.2828         | 270–714       |  1.82299e-13 |
|  30000 | rounded       | 20/20 |        0/20 |        0/20 | 3.752776749733 | 3.752776749733 | 1.9740 / 2.3424         | 2744–4164     |  1.82299e-13 |
|  30000 | circumscribed | 20/20 |        0/20 |        0/20 | 3.752776749733 | 3.752776749733 | 0.7556 / 0.9570         | 2954–3692     |  1.82299e-13 |

### N=4, M=0, P=5

[EST] Stored published value: 1.58113; [source](https://erich-friedman.github.io/packing/squincir/).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 0.0996 / 0.1164         | 708–1372      |  1.86406e-13 |
|   3000 | rounded       | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 0.5502 / 0.6194         | 2108–2789     |  1.86406e-13 |
|   3000 | circumscribed | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 0.2791 / 0.3129         | 2247–2789     |  1.86406e-13 |
|   3000 | superellipse  | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 1.4324 / 1.5036         | 2550–2789     |  1.86406e-13 |
|   3000 | rounded MC    | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 0.4234 / 0.4544         | 2782–2789     |  1.86406e-13 |
|  30000 | penalty       | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 0.1007 / 0.1161         | 708–1372      |  1.86406e-13 |
|  30000 | rounded       | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 0.6389 / 0.7137         | 2365–3525     |  1.86406e-13 |
|  30000 | circumscribed | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 0.3040 / 0.3771         | 2506–3534     |  1.86406e-13 |
|  30000 | superellipse  | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 3.2711 / 4.7266         | 4803–8875     |  1.86406e-13 |
|  30000 | rounded MC    | 20/20 |       20/20 |        0/20 | 1.581138830084 | 1.581138830084 | 1.1906 / 1.4727         | 5897–9393     |  1.86406e-13 |

### N=4, M=0, P=8

[EST] Stored published value: 1.97877; [source](https://erich-friedman.github.io/packing/squincir/).

| Budget | Variant       | Valid | Within 1e-4 | Within 1e-9 |   Median score |    Worst score | Wall median / worst (s) | Evals min–max | Min pair gap |
| -----: | ------------- | ----: | ----------: | ----------: | -------------: | -------------: | ----------------------- | ------------- | -----------: |
|   3000 | penalty       | 20/20 |        0/20 |        0/20 | 2.061552812809 | 2.061552812809 | 0.0951 / 0.1276         | 459–802       | -7.99361e-15 |
|   3000 | rounded       | 20/20 |        2/20 |        0/20 | 1.979015026565 | 1.979387600835 | 0.9722 / 0.9989         | 3000–3000     | -8.21565e-15 |
|   3000 | circumscribed | 20/20 |        3/20 |        0/20 | 1.979046619024 | 1.979279514356 | 0.4875 / 0.5088         | 3000–3000     | -1.77636e-14 |
|   3000 | superellipse  | 20/20 |        1/20 |        0/20 | 1.979030304898 | 2.026871248991 | 3.0646 / 3.2117         | 3000–3000     | -1.96509e-14 |
|   3000 | rounded MC    | 20/20 |        0/20 |        0/20 | 2.012746217162 | 2.061552812809 | 0.8330 / 0.8651         | 2789–3000     | -1.23235e-14 |
|  30000 | penalty       | 20/20 |        0/20 |        0/20 | 2.061552812809 | 2.061552812809 | 0.0953 / 0.1283         | 459–802       | -7.99361e-15 |
|  30000 | rounded       | 20/20 |        3/20 |        0/20 | 1.978934541390 | 1.979147858490 | 1.5861 / 2.1881         | 3847–7803     | -1.03251e-14 |
|  30000 | circumscribed | 20/20 |        4/20 |        0/20 | 1.979007602338 | 1.979405608979 | 1.0240 / 1.3431         | 4140–7694     |  1.22125e-14 |
|  30000 | superellipse  | 20/20 |        5/20 |        0/20 | 1.979147937824 | 2.024830933937 | 13.3059 / 14.8470       | 11536–14716   |  1.03251e-14 |
|  30000 | rounded MC    | 20/20 |        0/20 |        0/20 | 2.020732956679 | 2.061552812809 | 3.3040 / 4.3675         | 10239–14114   | -1.80966e-14 |

[CALC] Total measured runs: 1880; invalid results: 0; minimum pair
separation across all reported results: **-1.976196983833e-14**.

## Benchmark conclusions

[CALC] These comparisons use median score and success/reliability over all
20 seeds, rather than selecting the best seed. Lower scores are better.
`rounded` means the default inscribed family with penalty stages.

| Problem                    | Default rounded versus plain penalty at both budgets                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Squares / square, P=5      | Ties at 2.828427124746; neither matches the record. Rounded MC improves success to 14/20 and 12/20 at 3,000 and 30,000; superellipse gives 10/20 and 9/20.                                          |
| Squares / square, P=10     | Beats plain penalty: median 3.707106781189 versus 4.000000000001. Both budgets give 20/20 within 1e-4 and 19/20 within 1e-9. Circumscribed gives 20/20 at both thresholds and budgets.              |
| Squares / square, P=11     | Default ties plain penalty at 4.000000000001. Circumscribed and both MC paths improve the median, but none matches the record. Superellipse has the best measured median at 30,000: 3.914213648487. |
| Triangles / triangle, P=5  | Improves median to 2.958396052832 / 2.979356412372 versus 3; worst remains 3 and no run reaches the stored record thresholds.                                                                       |
| Triangles / triangle, P=7  | Ties at 3, with 20/20 success at both thresholds and budgets; default continuation costs more time.                                                                                                 |
| Pentagons / pentagon, P=6  | Mixed: a slightly more accurate median but worse reliability. Default gets 19/20 within 1e-4 versus plain penalty's 20/20; one continuation run remains at 2.809016994375.                          |
| Pentagons / pentagon, P=10 | Beats plain penalty on median and worst: median 3.693818711709 / 3.693452228006 versus 3.790207717751. Neither reaches the record thresholds.                                                       |
| Hexagons / hexagon, P=7    | Ties at 2.886751345948 with substantially more work. This is the cited 5/sqrt(3) construction, despite zero success against the truncated stored decimal 2.886.                                     |
| Hexagons / hexagon, P=10   | Ties at 3.752776749733 and misses the stored record thresholds.                                                                                                                                     |
| Squares / circle, P=5      | All paths tie at 1.581138830084; plain penalty is faster. All get 20/20 within 1e-4 of the printed record.                                                                                          |
| Squares / circle, P=8      | Beats plain penalty on median and worst. Default median 1.979015026565 / 1.978934541390 versus 2.061552812809, with only 2/20 / 3/20 within 1e-4.                                                   |

[CALC] The circumscribed family is faster in these measurements and improves
reliability for ten squares and median score for eleven squares. It is worse
than inscribed on median score for ten pentagons and on reliability for six
pentagons; five triangles at 30,000 regress to the plain-penalty median. It
has no uniform quality advantage. The two families tie on both hexagon cases,
seven triangles and five squares in a circle.

[CALC] Superellipses improve five and eleven squares compared with the default
rounded penalty path, but rounded MC does better for five squares. Rounded
penalty does better for ten squares. All square paths tie for P=5 in a circle;
for P=8, default rounded penalty has a better worst score than superellipse
and a substantially better median than rounded MC. At 30,000 superellipse
matches the printed P=8 circle threshold more often (5/20 versus 3/20) while
having a worse median and worst score. The superellipse variant uses MC on
finite shapes and penalty on its exact-square endpoint; rounded MC uses MC
at every stage. These comparisons include a local-mechanism difference and
do not isolate the effect of boundary parametrization alone.

[CALC] Stage-count sweeps were measured on squares/square P=5 and
pentagons/pentagon P=6, using 3, 7 and 13 base stages and twenty seeds at each
budget. All stage counts leave the default five-square path in the same basin.
For six pentagons, 3/7/13 stages give 17/19/19 successes within 1e-4 at 3,000,
and 17/19/20 at 30,000. Thirteen stages at 30,000 remove the worst failure,
with worst 2.618034090150, but median wall time rises to 1.7568 s versus
1.2577 s for seven and 0.8679 s for three. No stage-count sweep was made on
the other problems, and defaults were not retuned after measurement.

[CALC] Success counts deliberately use the literal `records.json` values.
Truncation affects more than the 1e-9 threshold: 5/sqrt(3) differs
from the stored hexagon P=7 value 2.886 by approximately 7.51346e-4, so a run
attaining that construction gets zero at both thresholds. The
triangle P=5 value, pentagon P=6 value, hexagon P=10 value and square/circle
P=5 value also have truncated final digits. Their underlying exact expressions
are present in the record citations; they were not silently substituted into
the counts.

## Reproduction, verification and source files

[CALC] Benchmark variant parameters, with all unlisted parameters at the
registered defaults:

| Report label  | Method  | Explicit params                 |
| ------------- | ------- | ------------------------------- |
| penalty       | penalty | `{}`                            |
| rounded       | morph   | `{}`                            |
| circumscribed | morph   | `{"family":"circumscribed"}`    |
| 3 stages      | morph   | `{"stages":3}`                  |
| 13 stages     | morph   | `{"stages":13}`                 |
| superellipse  | morph   | `{"path":"superellipse"}`       |
| rounded MC    | morph   | `{"localMethod":"mc_compress"}` |

[CALC] The final duplicate-key normalization ignores circle-piece angles and
circle-container angles, and avoids object-property-order dependence. All
benchmark pieces are polygons, all circle-container angles are zero, and
parser pose property order is canonical; this normalization preserves their
search decisions. Timings were captured before that final key normalization
and include varying concurrent verification load. They are measured costs,
not universal throughput or deterministic timing claims.

[CALC] The following command reproduces the measured matrix and prints one
summary JSON object per twenty-seed group, without writing extra repository
files. Wall times depend on machine load.

```bash
node --import tsx --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
import { run } from './packages/solver/src/index.ts';
import { pieceSeparation } from './packages/geometry/src/index.ts';
const { records } = JSON.parse(readFileSync('data/records.json', 'utf8'));
const problems = [[4,4,5],[4,4,10],[4,4,11],[3,3,5],[3,3,7],[5,5,6],[5,5,10],[6,6,7],[6,6,10],[4,0,5],[4,0,8]];
const variants = [
  ['penalty','penalty',{}],
  ['rounded','morph',{}],
  ['circumscribed','morph',{family:'circumscribed'}],
  ['3 stages','morph',{stages:3}],
  ['13 stages','morph',{stages:13}],
  ['superellipse','morph',{path:'superellipse'}],
  ['rounded MC','morph',{localMethod:'mc_compress'}],
];
const median = values => {
  const sorted = values.slice().sort((a,b) => a-b);
  return (sorted[9]+sorted[10])/2;
};
for (const [N,M,P] of problems) {
  const record = records.find(r => r.N===N && r.M===M && r.P===P);
  for (const evals of [3000,30000]) {
    for (const [variant,method,params] of variants) {
      if (['superellipse','rounded MC'].includes(variant) && N!==4) continue;
      if (['3 stages','13 stages'].includes(variant) && !((N===4 && M===4 && P===5) || (N===5 && M===5 && P===6))) continue;
      const rows = [];
      for (let seed=1; seed<=20; seed++) {
        const result = await run({N,M,P},{method,params,seed,budget:{evals},finalPolish:true});
        let gap = Infinity;
        if (result.best) {
          for (let i=0; i<P; i++) {
            for (let j=0; j<i; j++) gap = Math.min(gap,pieceSeparation(N,result.best.pieces[i],result.best.pieces[j]).sep);
          }
        }
        rows.push({score:result.score??Infinity,time:result.wallTime,evaluations:result.evaluations,gap,valid:result.valid});
      }
      const success = tolerance => record ? rows.filter(r => r.valid && Math.abs(r.score-record.value)<=tolerance).length : null;
      console.log(JSON.stringify({
        N,M,P,evals,variant,
        valid:rows.filter(r => r.valid).length,
        within1e4:success(1e-4),within1e9:success(1e-9),
        median:median(rows.map(r => r.score)),worst:Math.max(...rows.map(r => r.score)),
        wallMedian:median(rows.map(r => r.time)),wallWorst:Math.max(...rows.map(r => r.time)),
        evalMin:Math.min(...rows.map(r => r.evaluations)),evalMax:Math.max(...rows.map(r => r.evaluations)),
        minimumPairSeparation:Math.min(...rows.map(r => r.gap)),
      }));
    }
  }
}
JS
```

[CALC] Server throughput check: N=M=6, P=30, defaults, seeds 1–3, final
polish enabled, 3,000-evaluation ceiling. All three results were valid and used
2,790 counted assessments. Wall times were 11.6068, 8.6630 and 6.6582 s;
throughput was 240.38, 322.06 and 419.03 assessments/s respectively. These
runs shared machine load with the benchmark. A supplementary N=M=4, P=500,
K=256 superellipse abort check returned a valid best approximately 1.22 ms
after the abort callback, at 59.62 ms total wall time. This establishes that
workload's response, not a universal atomic-call bound. Browser throughput
was not measured.

[CALC] Where the method lives:

- `packages/solver/src/methods/morph.ts`: registered method, schema and schedule.
- `packages/solver/src/methods/morph/shapes.ts`: families, sampling, containment and rescaling.
- `packages/solver/src/methods/morph/local.ts`: rounded penalty and MC stages.
- `packages/solver/src/index.ts`: only the morph import and registration.
- `packages/solver/test/morph.test.ts`: geometry, framework and duplicate-state tests.
- `packages/geometry/src/penalty.ts`: optional scale/padding extension.
- `packages/geometry/test/penalty.test.ts`: added rounded tests; existing tests retained.
- `packages/solver/src/methods/penalty/objective.ts`: optional scale/padding propagation and reach.
- `docs/methods/morph.md`: method, parameters, verified references and measurements.

[EST] Not provided, as described in “Fit and
limitations”: universal zero-gap best selection and containment, polygon
polish restoration, seed-child deduplication, and a 50-digit automatic polish.
Benchmark results are recorded on this page only, not as JSON. No browser throughput measurement or finite-container
packing optimality proof is claimed.

## Independent acceptance checks (2026-10-10)

[CALC] Besides the 20 morph tests there are 17 independent adversarial tests
(`packages/solver/test/morph.review.test.ts`). Their construction-quality assertion uses 1e-4 rather
than requiring the last digits of historical Apple Silicon scores, because
same-runtime determinism does not imply cross-architecture convergence digits.

[CALC] An independent review found no implementation blocker. Its bounded pause/resume/abort
probes cover rounded penalty, rounded Monte Carlo and K=256 square superellipse
stages. This check does not independently reproduce the full benchmark
matrix or supply browser throughput or automatic 50-digit polish.
