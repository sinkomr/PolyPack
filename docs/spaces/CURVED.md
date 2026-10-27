# 2D in 2D, Curved: packings at constant curvature K

**Dimension.** On the site this is the kind **Curved** under the dimension **2D in 2D**: pieces inside a container, as on the classic board, but at constant curvature K. The API calls it the space `curved`.

Status: research build, 2026-10-24. Package `packages/curved` (`@polypack/curved`), certifier and bounds in `python/curved/`, data in `data/curved/`.

[SPEC] The site domain is `curved/<K>/<N>/<M>/<P>`: N = 0 (unit disks) or every integer 3–100, P = 1–100. The existing curvature choices and containers M = 0, 3–10, 12 stay unchanged. The ten K values are listed in `packages/spaces/src/piece-domains.ts`, including the published sweep curvatures. This Cartesian domain has 990,000 problems; a choice whose unit piece does not exist is rejected by the geometry. New choices ship without research records. [CALC] Without a record, the bound reuses `curvedBound`: the area requirement, one-piece containment, and (disk containers with P ≥ 2) the two-inscribed-disks requirement. When these give no finite bound, the API returns null.

[SPEC] `SPACE_DOMAINS` describes the ranges to the API and board picker. The volunteer list samples the domain; it never enumerates it all. Problems without a record have status `no_record`, null certified values/configurations, and require the strict float check on every entry. Existing record files are unchanged. Server validation shares the synchronous geometry through generators, yields between small units of work (8 ms default budget), stops after 20 overlapping pairs, and uses the shared heavy-check queue from P = 30. Sphere also queues N ≥ 20 at any P. Timing measurements are recorded with the implementation report. No new records or optimisation runs accompany this change.

## Summary

- **The engine works for every real K** (hyperbolic K < 0, Euclidean K = 0, spherical K > 0) with one set of formulas that never divides by K, so a curvature sweep can pass smoothly through K = 0. At K = ±10⁻⁶ it reproduces PolyPack's Euclidean records to O(|K|) (tests).
- **Every table entry is proven valid.** An independent Python certifier re-derives the geometry and decides every inequality with 256-bit interval arithmetic; transcendental functions are built from power series with explicit remainder bounds, so only interval +, −, ×, ÷ and √ are trusted.
- **Hyperbolic catalogues are finite and small** [CALC]. A regular hyperbolic M-gon is never bigger than the ideal M-gon, which is spiky: inradius acosh(1/sin(π/M)) = 0.549, 0.881, 1.124, 1.317, 1.615 for M = 3, 4, 5, 6, 8. Unit squares fit in no triangle (proved), two unit squares fit in no square (numerical), a unit disk needs M ≥ 5 and M ≤ 10 holds at most one (proved).
- **Spherical catalogues (K = +1) are tiny**: containers must lie in an open hemisphere; disks, pentagons and hexagons fit only once (proved), squares three times in every container tried (upper bound 5), triangles up to about ten (bound 12).
- **Scale-free family** a\*(N, M, P) (largest side of P pieces in the ideal M-gon at K = −1) is computed and certified; it gives the finite catalogue at every negative curvature at once.

The detailed tables follow; `packages/curved/viz/index.html` draws every certified packing (Poincaré or Klein disk for K < 0, globe or gnomonic view for K > 0).

## 1. Problem definition

**Space.** The complete simply connected surface of constant curvature K: the hyperbolic plane (K < 0), the Euclidean plane (K = 0), the sphere of radius 1/√K (K > 0). Problem id `curved/K/N/M/P`.

**Pieces.** P congruent pieces: regular N-gons of geodesic side 1 (N ≥ 3), or disks of geodesic radius 1 (N = 0). A unit N-gon exists at K > 0 if and only if √K < 2π/N, i.e. its perimeter N is below the length 2π/√K of a great circle: a convex regular N-gon with circumradius R < π/(2√K) has sin(√K a/2) = sin(√K R) sin(π/N), so its side a ranges over (0, 2π/(N√K)) [CALC]. At K = 1 this allows N ≤ 6 (no unit heptagon or octagon). The sine condition √K sn_K(1/2) < sin(π/N) is necessary but not sufficient (for triangles it holds again for K > 17.5); both checkers use the perimeter condition.

**Container.** Centred at the base point O with φ = 0 (horizontal bottom edge): a regular M-gon of geodesic side s (M ≥ 3), or a disk of radius r (M = 0). Wall k has outward normal angle −π/2 + 2πk/M at distance h (the apothem) from O, where tn_K(s/2) = sn_K(h) tan(π/M). For K > 0 the container (hence every piece) must lie in the open hemisphere around O: s < 2π/(M√K), r < π/(2√K).

**Score.** s or r, smaller is better. Validity: interiors disjoint, every piece in the closed container.

**Curvature functions** (t = K x²; entire in t, so they never divide by K):
C(t) = Σ (−t)ᵏ/(2k)!, S(t) = Σ (−t)ᵏ/(2k+1)!, V(t) = Σ (−t)ᵏ/(2k+2)!;
cs_K(x) = C(Kx²), sn_K(x) = x S(Kx²), tn_K = sn_K/cs_K, vs_K(x) = (1 − cs_K(x))/K = x² V(Kx²).

**Unit pieces.** Circumradius R and inradius ρ from sn_K(1/2) = sn_K(R) sin(π/N) and tn_K(1/2) = sn_K(ρ) tan(π/N); interior angle α from cos(π/N) = cs_K(1/2) sin(α/2); area (Nα − (N − 2)π)/K (Gauss–Bonnet), computed without cancellation as 2N times a right triangle with tan(|K|A/2) = |K| tn_K(ρ/2) tn_K(1/4).

| N | R at K = −1 | ρ at K = −1 | area at K = −1 | R at K = +1 | ρ at K = +1 | area at K = +1 |
|---|---|---|---|---|---|---|
| disk | 1 | 1 | 3.4123 | 1 | 1 | 2.8884 |
| 3 | 0.5703 | 0.2637 | 0.3852 | 0.5867 | 0.3209 | 0.4956 |
| 4 | 0.6827 | 0.4471 | 0.8608 | 0.7451 | 0.5779 | 1.2123 |
| 5 | 0.7988 | 0.5995 | 1.4234 | 0.9538 | 0.8510 | 2.3040 |
| 6 | 0.9109 | 0.7330 | 2.0577 | 1.2829 | 1.2414 | 4.3335 |
| 8 | 1.1155 | 0.9608 | 3.4861 | — | — | — |

**Pose.** (x, y, θ): the piece is G(standard piece) with G = T(c) R(θ), where
- the standard piece is centred at O with vertex k at direction π/2 + 2πk/N (a vertex straight up) and geodesic circumradius R;
- R(θ) is the rotation about O by θ;
- c = exp_O(x, y) is the point at geodesic distance √(x² + y²) from O in direction (x, y);
- T(c) is the transvection along the geodesic from O to c.

θ is therefore the orientation at c relative to the frame parallel-transported from O along Oc. Exponential coordinates are well conditioned at every K and K-independent, and at K = 0 they are exactly PolyPack's Euclidean pose. The container need not move: moving it is the same as moving all pieces by an isometry.

**Homogeneous model used in all computations.** Points are v = (v0, v1, v2) with Q_K(v) = v0² + K(v1² + v2²) = 1, v0 > 0 (the hyperboloid for K = −1, the unit sphere for K = 1). In TypeScript a point is stored as (e, x, y) with v0 = 1 − Ke, where e = vs_K(distance from O), so nothing divides by K. T(x, y) is the matrix
[[C, −KSx, −KSy], [Sx, 1 − KVx², −KVxy], [Sy, −KVxy, 1 − KVy²]] with D² = x² + y², S = S(KD²), V = V(KD²), C = 1 − KD²V.
A line at signed distance h from O with outward normal angle a is the covector n = (−sn_K(h), cs_K(h) cos a, cs_K(h) sin a); for a normalised point, n·v = sn_K(signed geodesic distance to the line). The line through two points is their cross product.

## 2. Why the checks are correct

**Chart argument** [EST]. The Beltrami–Klein model (K < 0) and the gnomonic projection (K > 0, open hemisphere) are the chart p = (v1, v2)/v0 of this model. Both map geodesics to straight lines (central projection of planes through the origin of R³). A geodesically convex polygon is therefore a Euclidean convex polygon in the chart, and disjointness and containment are preserved by the bijection. So the separating-axis theorem applies: two convex polygons have disjoint interiors iff an edge line of one of them has the other on its far side. We evaluate the side of a point as the sign of n·v, which equals the chart test after multiplying by v0 > 0. Disks are not round in the chart, so disk tests use intrinsic distances: disk–disk d ≥ 2; disk inside a wall: signed distance ≤ −1; anything inside a disk container: distance from O.

**Tolerance trap.** Chart lengths are not geodesic lengths (one Klein unit at distance ρ from the centre is about cosh²ρ hyperbolic units), so a tolerance applied to chart coordinates is meaningless far from O. Neither checker uses chart lengths: the float validator reports signed geodesic distances asn_K(n·v / √(Qd(n)Q(v))), and the certifier only decides signs. Both have a test with a real 10⁻⁴ overlap 8 units from the centre (rejected) and a real 10⁻⁴ gap there (accepted); the certifier also rejects a 10⁻⁸ overlap there.

**Float validator** (`validate`, TypeScript). Gaps in geodesic length units: polygon pairs by the separating-axis value (largest over edge lines of either piece of the smallest signed distance of the other piece's vertices), disk pairs by d − 2, walls and rims by signed distances. A configuration is valid when every gap ≥ −10⁻⁹ (PolyPack's touching rule). Float accuracy is about 10⁻¹⁶ cosh²D for pieces at distance D from O.

**Rigorous certifier** (`python/curved/certify.py`, separate code). Reads the stored floats as exact dyadic rationals and K as an exact rational. With 256-bit outward-rounded intervals it builds π (Machin's formula with alternating-series remainder), cos and sin (series with remainder), C, S, V (series with geometric tail bound), and the vertices T(c)R(θ)V_k. It then proves, all strictly:
- for K > 0: the unit piece exists (√K < 2π/N, decided as (2π/N)² − K > 0), the container lies in an open hemisphere (K s² < (2π/M)² for polygons, K r² < (π/2)² for disks; without the polygon check a side near 4πk/√K would wrap around to a smaller polygon), and every vertex and centre has v0 > 0;
- containment: n_k·v < 0 for every vertex and wall; sn_K(signed distance) < −sn_K(1) for disk centres; vs_K(d(O, v)) < vs_K(r) (or vs_K(r − 1)) in disk containers;
- pairs: a stored witness (edge `edge` of piece `owner`) with the owner's other vertices on n·v < 0 and all vertices of the other piece on n·v > 0, or circumscribed disks disjoint (vs_K(d) > vs_K(2R) = 2 sn_K(R)²), or for disks vs_K(d) > vs_K(2). Without a witness, or if it fails, every axis is tried.
For a published record it first checks the record itself: id = curved/K/N/M/P (optionally followed by `#tag`, as the sweep does for branches), `K_exact` (if present) equal to `K`, `score_cert` present and equal to the size of the published `config`, and `display` equal to `score_cert` rounded to the nearest at 6 decimals (ties to even, from its exact binary64 value); it then certifies `config` (and `config_cert` too, if a record carries a different one). Angles are reduced modulo 2π with the rigorous π before the series, so large θ is handled. It rejects malformed input (wrong P, NaN, ∞, numbers outside the binary64 range, non-integer or out-of-range N or M, size ≤ 0, containers beyond the hemisphere, non-existent pieces, records that are not objects) without crashing, and the command line keeps going and reports every failure.

**Margin re-solve.** Curved spaces have no similarity, so the PolyPack scaling trick does not apply. The touching optimum (`score_float`) is re-polished with every gap ≥ μ (μ = 4·10⁻¹¹, smaller where s is very sensitive to the apothem), and the resulting size is `score_cert`, at which the stored configuration is certified with clearance about μ. Over all 299 records `score_cert − score_float` is at most 1.7·10⁻¹⁰ relative (median 4·10⁻¹¹). In 26 degenerate cases the margin re-solve found a slightly better configuration than the float polish; there `score_float` is set to `score_cert` and the record says so.

## 3. Engine API (for the curvature sweep)

All functions are pure and seeded; nothing depends on the UI. Import from `@polypack/curved`.

```ts
validate(problem, K, config, { tol?, contactTol? }) -> { valid, strictlyValid, score, tightSize, minGap, minPairGap, minContainerGap, contacts, errors }
solve(problem, K, { seed, restarts, hops, start?, timeLimitMs? }) -> { found, config, polish, optima, validation }
polishAt(problem, K, config, { margin?, maxIter? }) -> { config, polish: { active, kktResidual, rattlers, t, size }, validation }
sensitivity(problem, K, config, polish?) -> { dsdK, active, kktResidual }            // envelope theorem
multiplierRange(problem, K, config, polish) -> { min, max }                        // range of -sum lambda dg/dK over all KKT multipliers
oneSidedSlopes(problem, K, config, dK) -> { left, right, sMinus, sPlus }          // warm-started re-polish at K -+ dK
continueTo(problem, K0, K1, config, steps) -> [{ K, config, size, feasible, dsdK, active, added, removed, predictionError, note }]
certifyPrep(problem, K, config, margin) -> { config, witnesses, validation }        // margin re-solve for the certifier
kPolish(N, M, poses, K0) -> { K, a, poses, unbounded }                              // ideal container: maximise a = sqrt(-K)
```

`problem = { N, M, P }`, `config = { size, pieces: [{ x, y, theta }] }`. Each active row carries its identity (pair with separating edge and vertex, wall with vertex, rim) and its Lagrange multiplier λ with respect to s, so that ds/dK = −Σ λ_k ∂g_k/∂K at fixed poses and fixed s. For non-unique multipliers (degenerate contact graphs, common in Euclidean records) the one-sided slopes are bounded by `multiplierRange` and measured by `oneSidedSlopes`; `continueTo` reports active-set changes (`added`, `removed`) and the first-order prediction error, which flags kinks and jumps. A failed step (no valid polish, the piece ceases to exist, the container would leave the hemisphere) ends the walk with a note.

Search method: random starts in a roomy container; penalty compression (L-BFGS on squared overlaps at a fixed container); sequential-LP polish with a box trust region, a 10⁻⁷ L1 step cost (keeps rattlers still) and a second-order correction step; basin hopping (re-place, jiggle, rotate); each P warm-started from the P − 1 optimum plus one piece. Gradients are analytic (body-frame Lie-algebra generators, then the chain rule to (x, y, θ)), checked against finite differences.

## 4. Tables

All values are `display` = score_cert rounded to the nearest at 6 decimals (ties to even, from its exact binary64 value; a certified upper bound is score_cert itself, kept at full precision in the records); every listed packing is certified (`data/curved/certification.json`). Status is `best_known` throughout [CALC]; records also carry `score_float` (touching limit), a rigorous lower bound (`bound`), the Euclidean record for comparison, ds/dK and its multiplier range, seed and budget. Searches: seed 1, 6 restarts × 25 hops for polygon containers, 5 × 20 for disk containers, each P warm-started from P − 1, one retry with a doubled budget before a P counted as "not found"; total about 3 hours on two processes at nice 10 on a heavily shared machine.

Some exact facts visible in the tables [CALC]: s(1) = 1 for N = M (the piece is the container; the inradius bound gives s ≥ 1); one disk needs exactly the container with inradius 1 (bound attained); two disks in a disk need r = 2 (both centres within r − 1 of O, 2 apart); at K = −1 ten disks fit in r = 3 exactly (nine around one, best found).

#### K = -1: certified sizes s(P) (score_cert rounded to 6 decimals), P = 1, 2, ...

| N \\ M | container | values |
|---|---|---|
| disk | disk | 1: 1.000000, 2: 2.000000, 3: 2.112735, 4: 2.281385, 5: 2.443354, 6: 2.590192, 7: 2.722022, 8: 2.840647, 9: 2.948004, 10: 3.000000, 11: 3.045799, 12: 3.135451, 13: 3.218124, 14: 3.294768, 15: 3.366166, 16: 3.432963, 17: 3.495699, 18: 3.554825, 19: 3.610725, 20: 3.663725, 21: 3.714105, 22: 3.762109, 23: 3.807946, 24: 3.851802, 25: 3.893838, 26: 3.934197, 27: 3.957884, 28: 3.975285, 29: 4.010382, 30: 4.046422 |
| disk | 5-gon | 1: 2.540266 |
| disk | 6-gon | 1: 1.652668 |
| disk | 8-gon | 1: 1.063675 |
| triangle | disk | 1: 0.570290, 2: 0.834025, 3: 0.932050, 4: 0.967039, 5: 0.992486, 6: 1.000000, 7: 1.016615, 8: 1.115510, 9: 1.207773, 10: 1.249682, 11: 1.306227, 12: 1.374281 |
| triangle | 3-gon | 1: 1.000000, 2: 3.594700 |
| triangle | 4-gon | 1: 1.000000, 2: 1.240070, 3: 1.674709, 4: 1.949225, 5: 1.981453, 6: 2.843790, 7: 4.286247 |
| triangle | 5-gon | 1: 0.843023, 2: 1.098573, 3: 1.234508, 4: 1.348015, 5: 1.552143, 6: 1.847531, 7: 1.965826, 8: 2.147089, 9: 2.297767, 10: 2.387892, 11: 2.767381, 12: 3.109604, 13: 3.817299 |
| triangle | 6-gon | 1: 0.592983, 2: 0.903128, 3: 1.038830, 4: 1.102341, 5: 1.158886, 6: 1.199212, 7: 1.559220, 8: 1.724149, 9: 1.882524, 10: 1.942396, 11: 2.006671, 12: 2.207071, 13: 2.410355, 14: 2.549220, 15: 2.649973, 16: 2.662906, 17: 3.410023, 18: 3.885671, 19: 5.003810 |
| triangle | 8-gon | 1: 0.489555, 2: 0.700543, 3: 0.825317, 4: 0.854190, 5: 0.931469, 6: 0.954101, 7: 0.975572, 8: 1.000000, 9: 1.205218, 10: 1.318218, 11: 1.463486, 12: 1.583595, 13: 1.707684, 14: 1.802338, 15: 1.868379, 16: 1.942748, 17: 1.989459, 18: 2.056760, 19: 2.218353, 20: 2.378572, 21: 2.530984, 22: 2.633464, 23: 2.802496, 24: 2.848648, 25: 3.101038, 26: 3.294997, 27: 3.813693, 28: 4.169243, 29: 4.396215 |
| square | disk | 1: 0.682666, 2: 1.054331, 3: 1.226551, 4: 1.333568, 5: 1.427402, 6: 1.572471, 7: 1.632291, 8: 1.712552, 9: 1.799096, 10: 1.881536, 11: 1.928132, 12: 1.983350 |
| square | 4-gon | 1: 1.000000 |
| square | 5-gon | 1: 0.979761, 2: 2.175862, 3: 2.462656, 4: 2.615087, 5: 2.898805 |
| square | 6-gon | 1: 0.856117, 2: 1.348683, 3: 1.619232, 4: 2.117991, 5: 2.316920, 6: 2.474469 |
| square | 8-gon | 1: 0.556809, 2: 0.960456, 3: 1.187279, 4: 1.299436, 5: 1.712314, 6: 2.038421, 7: 2.107384, 8: 2.177821, 9: 2.246180 |
| pentagon | disk | 1: 0.798829, 2: 1.398319, 3: 1.493454, 4: 1.547386, 5: 1.735711, 6: 1.895273, 7: 2.022252, 8: 2.069616 |
| pentagon | 4-gon | 1: 2.254010 |
| pentagon | 5-gon | 1: 1.000000 |
| pentagon | 6-gon | 1: 0.974860, 2: 2.239596, 3: 6.633999 |
| pentagon | 8-gon | 1: 0.754510, 2: 1.349877, 3: 1.876196, 4: 2.205045, 5: 5.356534 |
| hexagon | disk | 1: 0.910894, 2: 1.597895, 3: 1.767466, 4: 1.913845, 5: 2.087447, 6: 2.219235, 7: 2.321730, 8: 2.404011, 9: 2.473322, 10: 2.553216 |
| hexagon | 4-gon | 1: 4.252460 |
| hexagon | 5-gon | 1: 1.782123 |
| hexagon | 6-gon | 1: 1.000000 |
| hexagon | 8-gon | 1: 0.905338, 2: 2.507479, 3: 3.702222 |
| octagon | disk | 1: 1.115510, 2: 2.046423, 3: 2.222714, 4: 2.398280, 5: 2.560481, 6: 2.690682, 7: 2.834433, 8: 2.951490 |
| octagon | 5-gon | 1: 3.920113 |
| octagon | 6-gon | 1: 2.028031 |
| octagon | 8-gon | 1: 1.000000 |

#### K = 1: certified sizes s(P) (score_cert rounded to 6 decimals), P = 1, 2, ...

| N \\ M | container | values |
|---|---|---|
| disk | disk | 1: 1.000000 |
| disk | 3-gon | 1: 1.938893 |
| disk | 4-gon | 1: 1.399043 |
| disk | 5-gon | 1: 1.097468 |
| disk | 6-gon | 1: 0.904484 |
| disk | 8-gon | 1: 0.670763 |
| triangle | disk | 1: 0.586672, 2: 0.907559, 3: 0.975932, 4: 1.000000, 5: 1.000000, 6: 1.244336, 7: 1.280832, 8: 1.403255, 9: 1.491760, 10: 1.560514 |
| triangle | 3-gon | 1: 1.000000, 2: 1.728493, 3: 1.736194, 4: 1.882764, 5: 1.916475, 6: 1.991416, 7: 2.010640, 8: 2.074257, 9: 2.089147, 10: 2.094285 |
| triangle | 4-gon | 1: 0.914420, 2: 1.182026, 3: 1.280680, 4: 1.316078, 5: 1.366961, 6: 1.491433, 7: 1.517498, 8: 1.549537, 9: 1.565878, 10: 1.570721 |
| triangle | 5-gon | 1: 0.729465, 2: 1.003879, 3: 1.027907, 4: 1.037939, 5: 1.039687, 6: 1.197851, 7: 1.210201, 8: 1.240642, 9: 1.253136, 10: 1.256575 |
| triangle | 6-gon | 1: 0.560917, 2: 0.809963, 3: 0.868360, 4: 0.883145, 5: 0.890946, 6: 0.986996, 7: 0.999330, 8: 1.032180, 9: 1.044191, 10: 1.047144 |
| triangle | 8-gon | 1: 0.441898, 2: 0.612648, 3: 0.649779, 4: 0.661539, 5: 0.668269, 6: 0.744996, 7: 0.753888, 8: 0.774725, 9: 0.783018, 10: 0.785358 |
| square | disk | 1: 0.745052, 2: 1.209208, 3: 1.436811 |
| square | 3-gon | 1: 1.646957, 2: 2.000425, 3: 2.075759 |
| square | 4-gon | 1: 1.000000, 2: 1.477478, 3: 1.557631 |
| square | 5-gon | 1: 0.883221, 2: 1.184039, 3: 1.246252 |
| square | 6-gon | 1: 0.733399, 2: 0.974376, 3: 1.038454 |
| square | 8-gon | 1: 0.524933, 2: 0.735629, 3: 0.778634 |
| pentagon | disk | 1: 0.953847 |
| pentagon | 3-gon | 1: 1.885017 |
| pentagon | 4-gon | 1: 1.342108 |
| pentagon | 5-gon | 1: 1.000000 |
| pentagon | 6-gon | 1: 0.868309 |
| pentagon | 8-gon | 1: 0.649576 |
| hexagon | disk | 1: 1.282927 |
| hexagon | 3-gon | 1: 2.045876 |
| hexagon | 4-gon | 1: 1.525907 |
| hexagon | 5-gon | 1: 1.212644 |
| hexagon | 6-gon | 1: 1.000000 |
| hexagon | 8-gon | 1: 0.755648 |

#### Catalogue (polygon containers)

| K | N | M | P_max found | upper bound | exact | arguments |
|---|---|---|---|---|---|---|
| 1 | disk | 3 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | disk | 4 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | disk | 5 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | disk | 6 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | disk | 8 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | triangle | 3 | 10 | 12 | no | area <= 12 |
| 1 | triangle | 4 | 10 | 12 | no | area <= 12 |
| 1 | triangle | 5 | 10 | 12 | no | area <= 12 |
| 1 | triangle | 6 | 10 | 12 | no | area <= 12 |
| 1 | triangle | 8 | 10 | 12 | no | area <= 12 |
| 1 | square | 3 | 3 | 5 | no | area <= 5 |
| 1 | square | 4 | 3 | 5 | no | area <= 5 |
| 1 | square | 5 | 3 | 5 | no | area <= 5 |
| 1 | square | 6 | 3 | 5 | no | area <= 5 |
| 1 | square | 8 | 3 | 5 | no | area <= 5 |
| 1 | pentagon | 3 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | pentagon | 4 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | pentagon | 5 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | pentagon | 6 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | pentagon | 8 | 1 | 1 | yes | area <= 2; near_wall <= 1 |
| 1 | hexagon | 3 | 1 | 1 | yes | area <= 1; near_wall <= 1 |
| 1 | hexagon | 4 | 1 | 1 | yes | area <= 1; near_wall <= 1 |
| 1 | hexagon | 5 | 1 | 1 | yes | area <= 1; near_wall <= 1 |
| 1 | hexagon | 6 | 1 | 1 | yes | area <= 1; near_wall <= 1 |
| 1 | hexagon | 8 | 1 | 1 | yes | area <= 1; near_wall <= 1 |
| -1 | disk | 3 | 0 | 0 | yes | area <= 0; inradius <= 0; cusp <= 0; near_wall <= 1 |
| -1 | disk | 4 | 0 | 0 | yes | area <= 1; inradius <= 0; cusp <= 0; near_wall <= 1 |
| -1 | disk | 5 | 1 | 1 | yes | area <= 2; cusp <= 1; near_wall <= 1 |
| -1 | disk | 6 | 1 | 1 | yes | area <= 3; cusp <= 2; near_wall <= 1 |
| -1 | disk | 8 | 1 | 1 | yes | area <= 5; cusp <= 3; near_wall <= 1 |
| -1 | triangle | 3 | 2 | 5 | no | area <= 8; cusp <= 5 |
| -1 | triangle | 4 | 7 | 12 | no | area <= 16; cusp <= 12 |
| -1 | triangle | 5 | 13 | 19 | no | area <= 24; cusp <= 19 |
| -1 | triangle | 6 | 19 | 26 | no | area <= 32; cusp <= 26 |
| -1 | triangle | 8 | 29 | 40 | no | area <= 48; cusp <= 40 |
| -1 | square | 3 | 0 | 0 | yes | area <= 3; cusp <= 1; near_wall <= 1; centre_bb_r0_0: proved (1299 boxes) |
| -1 | square | 4 | 1 | 4 | no | area <= 7; cusp <= 4 |
| -1 | square | 5 | 5 | 7 | no | area <= 10; cusp <= 7 |
| -1 | square | 6 | 6 | 10 | no | area <= 14; cusp <= 10 |
| -1 | square | 8 | 9 | 16 | no | area <= 21; cusp <= 16 |
| -1 | pentagon | 3 | 0 | 0 | yes | area <= 2; inradius <= 0; cusp <= 0; near_wall <= 1 |
| -1 | pentagon | 4 | 1 | 1 | yes | area <= 4; cusp <= 2; near_wall <= 1 |
| -1 | pentagon | 5 | 1 | 4 | no | area <= 6; cusp <= 4 |
| -1 | pentagon | 6 | 3 | 5 | no | area <= 8; cusp <= 5 |
| -1 | pentagon | 8 | 5 | 9 | no | area <= 13; cusp <= 9 |
| -1 | hexagon | 3 | 0 | 0 | yes | area <= 1; inradius <= 0; cusp <= 0; near_wall <= 1 |
| -1 | hexagon | 4 | 1 | 1 | yes | area <= 3; cusp <= 1; near_wall <= 1 |
| -1 | hexagon | 5 | 1 | 1 | yes | area <= 4; cusp <= 2; near_wall <= 1 |
| -1 | hexagon | 6 | 1 | 1 | yes | area <= 6; cusp <= 3; centre_bb_r0_rho: proved (45651 boxes) |
| -1 | hexagon | 8 | 3 | 6 | no | area <= 9; cusp <= 6 |
| -1 | octagon | 3 | 0 | 0 | yes | area <= 0; inradius <= 0; cusp <= 0; near_wall <= 1 |
| -1 | octagon | 4 | 0 | 0 | yes | area <= 1; inradius <= 0; cusp <= 0; near_wall <= 1 |
| -1 | octagon | 5 | 1 | 1 | yes | area <= 2; cusp <= 1; near_wall <= 1 |
| -1 | octagon | 6 | 1 | 1 | yes | area <= 3; cusp <= 2; near_wall <= 1 |
| -1 | octagon | 8 | 1 | 1 | yes | area <= 5; cusp <= 3; near_wall <= 1 |

Notes on the hyperbolic polygon containers: the found limits agree with the independent research run (§10); unit squares fit in no triangle (proved), two squares in no square (numerical only), and every pairing marked exact has P_max 0 or 1. At K = +1 hexagons, pentagons and disks fit once in every container (proved by the hemisphere argument), squares three times, triangles up to about ten; containers approach the hemisphere (s → 2π/M) at the last P.

## 5. P_max: how many unit pieces fit at all

**Finiteness** [CALC]. At K < 0 every regular M-gon centred at O lies inside the ideal regular M-gon Π (vertices at infinity, area (M − 2)π, inradius acosh(1/sin(π/M))), and the finite M-gons exhaust Π as s → ∞. A packing in a finite M-gon is a packing in Π; conversely a packing of compact pieces in the open Π lies in some finite M-gon. So P_max(N, M) is the most unit pieces that fit in Π, it is finite, and s(P) is finite exactly for P ≤ P_max. At K > 0 the container lies in an open hemisphere (area 2π), so the catalogue is finite as well.

**Upper-bound arguments** (all decided in interval arithmetic by `python/curved/bounds.py`; results in `data/curved/bounds.json`):

1. *Area.* P·A_N < (M − 2)π at K = −1; P·A_N < 2π at K = +1.
2. *Cusp exclusion* (K = −1). Put one ideal vertex of Π at ∞ in the upper half-plane with its two edges at x = 0 and x = 1; the other edges are semicircles of radius ≤ 1/2. A piece placed anywhere is y0·Q_θ + x0, where Q_θ is the piece centred at i with orientation θ (z ↦ y0 z + x0 is an isometry). It fits in the strip only if y0·width(Q_θ) ≤ 1, and then its highest point is at most Y\* = max_θ top(Q_θ)/width(Q_θ). The strip above height Y\* has area 1/Y\* and holds no piece. For Y\* ≥ 1 these M cusp regions are disjoint (the area-1 horoball neighbourhoods of a regular ideal polygon are disjoint), so P·A_N < (M − 2)π − M/Y\*. Y\* is bounded above by interval bisection over θ: 1.1565 (disk, exactly e/(2 sinh 1)), 2.4938 (triangle), 1.6697 (square), 1.4019 (pentagon), 1.2730 (hexagon), 1.1523 (octagon).
3. *Inradius.* A piece contains its inscribed disk (radius ρ_N); the inradius of a regular M-gon is below that of Π. ρ_N ≥ acosh(1/sin(π/M)) ⇒ P_max = 0.
4. *Nearest wall* (K = −1). Let c be at distance a from O, its direction within π/M of the outward normal of wall k of Π. With sinh h∞ = cot(π/M) and cosh h∞ cos(π/M) = cot(π/M): n_k·c = cosh h∞ sinh a cos φ − sinh h∞ cosh a ≥ −cot(π/M) e^(−a). The inscribed disk at c needs n_k·c ≤ −sinh ρ, so a ≤ a_ρ = ln(cot(π/M)/sinh ρ). Two pieces have centre distance ≥ 2ρ (disjoint inscribed disks), so a_ρ < ρ ⇒ P_max ≤ 1. For disks (ρ = 1) this is cot(π/M) < e·sinh 1 = 3.1945, i.e. **at most one unit disk fits in any regular M-gon with M ≤ 10** at K = −1. At K = +1 the inscribed disk lies in the open hemisphere, so a < π/2 − ρ, and ρ > π/4 ⇒ P_max ≤ 1 (disks, pentagons, hexagons).
5. *Centre branch-and-bound* (K = −1). Interval branch-and-bound over (a, φ, θ) ∈ [r0, a_ρ] × [0, 2π/M) × [0, 2π/N) (the rotation symmetry of Π moves (φ, θ) together) shows that no orientation of a piece centred at distance ≥ r0 fits in Π. With r0 = 0 this proves P_max = 0. With r0 = ρ every admissible centre lies within distance ρ of O, so any two are less than 2ρ apart and cannot both be piece centres: P_max ≤ 1. Proved: **no unit square fits in any hyperbolic triangle** (1,299 boxes) and **two unit hexagons do not fit in any hyperbolic hexagon** (45,651 boxes). The same test cannot settle squares in a square or pentagons in a pentagon, because there the target is false: a single unit square or pentagon centred slightly beyond ρ from O still fits in the ideal polygon (the independent review found a unit pentagon centred at distance ρ + 0.005 with containment margin 0.0071, and a square with margin 0.077). The pentagon run stopping at its box limit is a symptom of this, not the reason. Settling these needs a genuine two-piece argument.

Lower bounds are the certified packings in the tables. The catalogue table in §4 lists both ends; "exact" means they meet.

**Behaviour near P_max.** s(P) grows slowly and then jumps at the last one or two P: for triangles in a square s = 1, 1.240, 1.675, 1.949, 1.981, 2.844, 4.286 (P = 1…7). The jump comes from the ideal limit: as the needed apothem h approaches h∞, s = 2 atanh(sinh h · tan(π/M)) diverges like −2 ln(h∞ − h). So s(P) is large exactly when the scale-free value a\*(N, M, P) (§7) is barely above 1: pentagons in a hexagon have a\*(5, 6, 3) = 1.00261 and s(3) = 6.634; triangles in a square have a\*(3, 4, 7) ≈ 1.03 and s(7) = 4.286 [CALC]. Across the last entries of each catalogue the relation is close to s ≈ −ln(a\* − 1) + 0.7 [CALC, empirical fit, not a theorem]:

| last P | a\* − 1 | −ln(a\* − 1) | s(P) at K = −1 |
|---|---|---|---|
| 3 pentagons in a hexagon | 0.0026 | 5.95 | 6.634 |
| 5 pentagons in an octagon | 0.0085 | 4.77 | 5.357 |
| 19 triangles in a hexagon | 0.0170 | 4.07 | 5.004 |
| 29 triangles in an octagon | 0.0253 | 3.68 | 4.396 |
| 7 triangles in a square | 0.0311 | 3.47 | 4.286 |
| 3 hexagons in an octagon | 0.0395 | 3.23 | 3.702 |
| 13 triangles in a pentagon | 0.0519 | 2.96 | 3.817 |

The curvature sensitivity is correspondingly huge there (ds/dK = −188 for three pentagons in a hexagon), and the certification margin is reduced so that score_cert − score_float stays small.

At K = +1 the analogue is the hemisphere: s(P) approaches 2π/M (triangles in a triangle reach s = 2.0943 at P = 10, against the limit 2π/3 = 2.0944).

## 6. Perfect and closed-form cases

- **{3, q} tilings** [CALC]. q unit triangles around a vertex fill a regular q-gon of side 1 when the unit triangle's angle is 2π/q, i.e. cs_K(1/2) = 1/(2 sin(π/q)): K\* = +1.2258 (q = 5), 0 (q = 6), −1.1893 (7), −2.3365 (8), −3.4413 (9), −4.5052 (10), −6.5197 (12). The packing is optimal by area (a smaller container has smaller area). These K\* are where the sweep should see exact tilings; records with certified margins are in `data/curved/records.json` under K = K\* (binary64), built by `scripts/run-perfect.ts`.
- **No exact tilings at K = ±1** [CALC]: the unit angles 52.643° (triangle), 77.669° (square), 91.689° (pentagon), 100.351° (hexagon), 110.03° (octagon) at K = −1 and 69.465°, 107.364°, 134.402°, 161.382° at K = +1 are not of the form 2π/q or π/q, so beyond P = 1 no container is tiled.
- **Disk rings at K = −1**: for P ≤ 9 the optimum found is the ring with R = 1 + asinh(sinh 1 / sin(π/P)); P = 10 is nine around one at R = 3 exactly (2π divided by the ring gap angle 2 asin(sinh 1/sinh 2) is 9.52); P = 11 … 26 a (P − 1)-ring around one disk (R(P) = ring value for P − 1); P = 27 and 28: two inner disks inside a deformed ring of P − 2 (R = 3.957884 and 3.975285, below the (P − 1)-ring-plus-one values 3.973007 and 4.010382); P = 29, 30: a circular (P − 2)-ring around two (R = 4.010382, 4.046422), possible once the ring radius reaches 3 [CALC, best found]. The structural change therefore comes at P = 27, two earlier than a circular ring would allow.
- **Pieces around a common vertex.** Five unit triangles around one vertex fit in the unit-radius disk at K = +1 (5 × 69.465° < 360°) and six at K = −1 (6 × 52.643° < 360°), so the best found sizes for P = 4, 5 (K = +1) and P = 6 (K = −1) triangles in a disk container are exactly r = 1 [found values, not claimed optimal].
- **Single disk** in any container (both signs of K): s(1) is the size whose inradius is 1; this is optimal because a disk inside a convex container needs inradius ≥ 1 [CALC].

## 7. The scale-free family a\*(N, M, P)

All ideal M-gons are congruent, and P pieces of side a at K = −1 are P unit pieces at curvature K = −a² (lengths scale by √−K). So the supremum a\*(N, M, P) of the side of P congruent regular N-gons (radius for disks) in the ideal M-gon at K = −1 settles the whole negative-curvature family at once [CALC], up to the boundary case: P unit pieces fit in some finite regular M-gon at curvature K < 0 **if** √−K < a\*(N, M, P) (take a packing with side a ∈ (√−K, a\*], shrink every piece about its centre to side √−K; the pieces stay disjoint and lie compactly inside the open ideal polygon, hence inside a finite M-gon), and **only if** √−K ≤ a\* (a finite M-gon lies inside the ideal one). Whether the pieces fit when √−K = a\* exactly depends on whether the supremum is attained by a packing that keeps away from the ideal vertices; we have not proved that [SPEC]. a\* is non-increasing in P. Hence P_max(N, M; K) = max{P : a\*(N, M, P) > √−K} at every K with √−K different from all the a\* values; the K = −1 catalogue is max{P : a\* > 1} (all our certified lower bounds for found P are strictly above 1).

`kPolish` computes a local maximum of a by sequential LP in (poses, K) with the container fixed to the ideal M-gon at the current K; `scripts/run-ideal.ts` starts it from each K = −1 optimum (plus seeded hops) and, for the first P without a K = −1 packing, from searches at K = −0.25 and −0.5. Every finite value is certified as a lower bound: the configuration is re-polished at K_c = K\*(1 − 10⁻⁹) inside a finite M-gon and checked by `certify.py`, which proves a\* ≥ √−K_c. a\* = ∞ is claimed only with a proof [CALC]: a regular N-gon of any size, concentric and aligned with an ideal regular N-gon, is the intersection of half-planes parallel-shifted inside the ideal one's, so it fits in it; an ideal triangulation gives M − 2 disjoint ideal triangles (so a\*(3, M, P) = ∞ for P ≤ M − 2), and every k-th vertex of the ideal kN-gon spans an ideal regular N-gon (so a\*(N, kN, 1) = ∞). Vertices 0, 1, 2, 4 of the ideal hexagon also span a regular ideal square (cross-ratio |z0 − z2||z1 − z4| / (|z0 − z4||z1 − z2|) = 2√3/√3 = 2, as for a square), so a\*(4, 6, 1) = ∞; our K-polish only reached 2.743 there. An enumeration of all vertex subsets (M ≤ 8, N ≥ 4) finds no two interior-disjoint regular ideal N-gons, so no other P ≥ 2 entry with N ≥ 4 is infinite by this construction. When K-polish runs past side 20 without such a proof the result is discarded ("n/d"): at that size the float coordinates (about e^20) are meaningless; this happened for squares in the octagon, P = 3 and 5, where the monotone envelope still gives a certified lower bound. "≥" marks a lower bound inherited from a larger P (a\* is non-increasing in P).

#### a*(N, M, P) at K = -1 (ideal M-gon); certified lower bounds, rounded down

| N | M | a* for P = 1, 2, ... |
|---|---|---|
| disk | 5 | 1: 1.124177, 2: 0.650581 |
| disk | 6 | 1: 1.316957, 2: 0.748033 |
| disk | 8 | 1: 1.614890, 2: 0.881373 |
| triangle | 3 | 1: ∞, 2: 1.061275, 3: 0.977937 |
| triangle | 4 | 1: ∞, 2: ∞, 3: 1.532936, 4: 1.368621, 5: 1.325032, 6: 1.127504, 7: 1.031069, 8: 0.977937 |
| triangle | 5 | 1: ∞, 2: ∞, 3: ∞, 4: 1.865009, 5: ≥1.522099, 6: 1.522099, 7: 1.387608, 8: 1.248285, 9: 1.219164, 10: 1.181135, 11: 1.122002, 12: 1.089815, 13: 1.051882, 14: 0.934193 |
| triangle | 6 | 1: ∞, 2: ∞, 3: ∞, 4: ∞, 5: 2.121455, 6: 1.720301, 7: ≥1.443158, 8: ≥1.443158, 9: 1.443158, 10: 1.355142, 11: 1.332950, 12: ≥1.225257, 13: 1.225257, 14: 1.140462, 15: 1.124201, 16: 1.119678, 17: 1.070418, 18: 1.047654, 19: 1.017002, 20: 0.910889 |
| triangle | 8 | 1: ∞, 2: ∞, 3: ∞, 4: ∞, 5: ∞, 6: ∞, 7: 2.135188, 8: 2.124709, 9: 1.597716, 10: 1.591063, 11: 1.476024, 12: ≥1.471473, 13: ≥1.471473, 14: 1.471473, 15: 1.307131, 16: 1.280218, 17: 1.229229, 18: 1.220906, 19: 1.187655, 20: 1.152975, 21: 1.146112, 22: 1.118488, 23: 1.100183, 24: 1.088871, 25: 1.076379, 26: 1.065742, 27: 1.041925, 28: 1.030731, 29: 1.025345, 30: 0.885042 |
| square | 3 | 1: 0.924806 |
| square | 4 | 1: ∞, 2: 0.982202 |
| square | 5 | 1: 2.697882, 2: 1.217170, 3: 1.148420, 4: 1.142928, 5: 1.120024, 6: 0.856615 |
| square | 6 | 1: ∞, 2: 1.762747, 3: 1.376160, 4: 1.334721, 5: 1.220389, 6: 1.185621, 7: 0.950983 |
| square | 8 | 1: ∞, 2: 2.878369, 3: ≥1.725290, 4: 1.725290, 5: ≥1.305998, 6: 1.305998, 7: ≥1.251305, 8: 1.251305, 9: 1.157164, 10: 0.894054 |
| pentagon | 3 | 1: 0.746309 |
| pentagon | 4 | 1: 1.223982, 2: 0.800363 |
| pentagon | 5 | 1: ∞, 2: 0.982304 |
| pentagon | 6 | 1: 2.605187, 2: 1.205740, 3: 1.002614, 4: 0.929808 |
| pentagon | 8 | 1: 3.157759, 2: 1.600066, 3: 1.274596, 4: 1.192586, 5: 1.008488, 6: 0.922978 |
| hexagon | 3 | 1: 0.693147 |
| hexagon | 4 | 1: 1.028618, 2: 0.693147 |
| hexagon | 5 | 1: 1.376830, 2: 0.783289 |
| hexagon | 6 | 1: ∞, 2: 0.927197 |
| hexagon | 8 | 1: 2.765794, 2: 1.148603, 3: 1.039495, 4: 0.984845 |
| octagon | 5 | 1: 1.039295, 2: 0.563218 |
| octagon | 6 | 1: 1.283368, 2: 0.685555 |
| octagon | 8 | 1: ∞, 2: 0.881373 |

Reading the table: the jump of s(P) near P_max (§5) is where a\* comes close to 1, and the curvature at which the catalogue changes is K = −a\*². For example the unit-triangle catalogue in a square loses its 7th piece at K = −a\*(3, 4, 7)².

## 8. Curvature sensitivity and continuation

For a polished optimum the engine returns the active rows and multipliers λ_k (with respect to s), so ds/dK = −Σ λ_k ∂g_k/∂K at fixed poses and size. Checks [CALC]:
- disk rings at K = 0 reproduce the closed form dR/dK = r0(r0² − 1)/6 with r0 = R − 1 the ring radius (0.064150, 0.235702, 0.537165 for P = 3, 4, 5) to 5 digits (test);
- at K = −1 the envelope value matches central finite differences of re-polished optima to 6–7 digits for non-degenerate optima (two triangles in a triangle: −6.62087 vs −6.62087; seven disks: 0.2451276 vs 0.2451276);
- degenerate records (tilings, rattlers, symmetric contact graphs) have non-unique multipliers and one-sided slopes; four hexagons in a hexagon at K = 0: NNLS multipliers give −1.494, the central difference −1.729, and the multiplier range from `multiplierRange` brackets both one-sided slopes (test). Every record stores `dsdK_envelope` and `dsdK_multiplier_range`; where the range has positive width the slope is one-sided.

`continueTo` walks K in steps from a solved start, polishing each step from the previous configuration (exponential coordinates are K-independent, so the same numbers are a valid start). It reports active-set additions and removals and the first-order prediction error; a jump to a different branch must be found by a fresh `solve` at the new K, so a sweep should combine continuation with periodic re-solves.

Continuation examples (20 steps, warm-started, [CALC]):

| start (K = 0) | path | s along the path | ends |
|---|---|---|---|
| 4 squares in a square, s = 2 | K = 0 → −1 | 2.0516 (K = −0.05), 2.7713 (−0.5), 3.9616 (−0.75), 4.6795 (−0.8) | infeasible at K = −0.85, consistent with a\*(4, 4, 4) = 0.9206 (catalogue change at K = −0.848) |
| 4 triangles in a triangle, s = 2 | K = 0 → −1 | 2.0386 (−0.05), 2.5566 (−0.5), 4.3960 (−0.9), 6.5450 (−0.95) | infeasible at K = −1, consistent with a\*(3, 3, 4) = 0.9779 (change at K = −0.956) |
| 7 disks in a disk, r = 3 | K = 0 → +1 | 3.1227 (0.1), 3.3366 (0.2) | the container must leave the open hemisphere between K = 0.2 and 0.3 (r = 3.34 at 0.2; the hemisphere radius π/(2√K) is 3.51 at 0.2 and 2.87 at 0.3), so the walk stops |

The first step from K = 0 changes the active set and has a first-order prediction error of 0.03: the Euclidean tilings are kinked at K = 0. Near the end of each hyperbolic path ds/dK diverges (−158 at K = −0.95 for the triangles), the continuous version of the jump in §5.

## 9. Euclidean limit

At K = 0 the validator reproduces PolyPack's separating-axis values to 10⁻¹² and the enclosing sizes of stored Euclidean records exactly (tests on (4,4,5), (0,0,5), (3,3,5), (6,6,4), (0,4,6), (3,4,4), (4,0,3), (0,6,3)). Polishing those records at K = ±10⁻⁶ changes s by at most 10·|K|·s³ (test). Polishing at K = 0 occasionally tightens a stored Euclidean record slightly: five triangles in a triangle go from the stored poses' 2.7320567 to 1 + √3 = 2.7320508.

Certified records at K = ±10⁻⁶ (in `records.json`) show the typical kinks of Euclidean records [CALC]:

| problem | Euclidean | K = +10⁻⁶ | K = −10⁻⁶ | slope K > 0 | slope K < 0 |
|---|---|---|---|---|---|
| 5 squares in a square | 2.70710678 | 2.70710613 | 2.70710902 | −0.65 | −2.24 |
| 7 disks in a disk | 3 | 3.0000010 | 3.0000000 | +1 | 0 |

Seven disks are six around one at K = 0; for K > 0 the ring of six no longer fits at distance 2 and must move out (slope 1), for K < 0 it fits with room to spare (slope 0).

## 10. Cross-checks

An independent non-Euclidean research run (kept outside the repository, different code: SLSQP with separating-line variables, Poincaré-disk verification) found the same catalogue limits P_max = 2, 7, 13 (triangles in M = 3, 4, 5), 0, 1, 5, 6 (squares in M = 3, 4, 5, 6), 3 (pentagons in a hexagon), 1 for disks in M = 5, 6, 8, and the same disk-in-disk values to all printed digits. Where both searches have values our sizes are equal or smaller (for example triangles in a pentagon, P = 5: 1.552143 against 1.688292; squares in a hexagon, P = 3: 1.619232 against 2.117991; triangles in a square, P = 4 and 5: 1.949225 and 1.981453 against 1.950121 and 1.988888). Their a\* values agree with ours to 6 digits where both exist (for example a\*(3,3,2) = 1.061275, a\*(5,6,3) = 1.002615, r\*(6,1) = 1.316958); for squares in a pentagon, P = 2, our K-polish from the K = −1 optimum reached 1.21717 against their 1.253739, so our a\* entries are lower bounds from a modest search.

## 11. Limitations and open questions

- Values are best found, not proven optimal (except P = 1 disk cases and the {3, q} tilings, which meet the inradius or area bound). Status is `best_known` throughout.
- Open P_max gaps at K = −1: triangles in M = 3, 4, 5, 6, 8 (found 2, 7, 13, 19, 29 against cusp bounds 5, 12, 19, 26, 40), squares in a square (1 against 4) and pentagon (5 against 7), pentagons in a pentagon (1 against 4) and hexagon (3 against 5), squares in a hexagon (6 against 10) and octagon (9 against 16), hexagons in an octagon (3 against 6), pentagons in an octagon (5 against 9). A two-piece branch-and-bound over separating lines would likely settle squares and pentagons in their own polygon.
- At K = +1: squares fit three times in every container tried (bound 5); triangles about ten (bound 12).
- The spherical problem is restricted to containers in an open hemisphere. Larger caps (r up to π/√K) are meaningful for disk containers (two unit disks need r = 2, three r = 1 + asin(sin 1 / sin 60°) = 2.3327 at K = 1) but need a chart-free pair test; not implemented.
- The float validator's accuracy degrades like cosh² of the distance from O; the certifier has no such limit. Containers far beyond s ≈ 30 at K = −1 were not needed.
- `continueTo` follows one branch; it does not detect a better branch appearing elsewhere.

## 12. Files and commands

- `packages/curved/src/`: `kfun.ts` (curvature functions), `shapes.ts`, `space.ts` (lifted points, transvections, lines), `problem.ts`, `evaluate.ts` (gaps and analytic gradients), `validate.ts`, `optim.ts` (L-BFGS, bounded simplex LP, NNLS, seeded RNG), `model.ts`, `polish.ts` (SLP), `search.ts`, `engine.ts`, `sensitivity.ts`, `ideal.ts`.
- `packages/curved/scripts/`: `run-table.ts`, `run-ideal.ts`, `run-perfect.ts`, `recert.ts` (repeat an unconverged margin re-solve with 3000 iterations; used once, for 29 triangles in an octagon), `build-viz.ts`.
- `packages/curved/viz/`: `template.html`, generated `index.html` (standalone, data embedded).
- `python/curved/`: `rigorous.py`, `certify.py`, `bounds.py`, `finalize.py`, `floatgeom.py` (test helper), `report_tables.py`, tests `test_certify.py`, `test_bounds.py`.
- `data/curved/`: `records.json`, `certification.json`, `bounds.json`, `ideal.json`.

```
npx tsc -p packages/curved --noEmit
npx vitest run packages/curved
python3 python/curved/test_certify.py
python3 python/curved/test_bounds.py
python3 python/curved/certify.py data/curved/records.json
python3 python/curved/certify.py data/curved/ideal.json --ideal
npx tsx packages/curved/scripts/run-table.ts --K -1 --N 3 --M 4 --P 1-8 --out runs/km1 --restarts 6 --hops 25 --seed 1
python3 python/curved/bounds.py --bb --out data/curved/bounds.json
python3 python/curved/finalize.py --runs runs/km1 runs/kp1 runs/perfect runs/eps --ideal runs/ideal --out data/curved
npx tsx packages/curved/scripts/build-viz.ts
```

## 13. Kernel for the generic methods

`curvedKernel({ K, N, M, P })` (`packages/curved/src/kernel.ts`, helpers `kernel-chart.ts`, `kernel-energy.ts`, `kernel-start.ts`, `kernel-finish.ts`) lets the generic search methods (`docs/methods/dimensions/README.md`) run on `curved/K/N/M/P`. Its id writes K as the catalogue does (`curved/1e-06/4/4/5`). The size is the score: the side s, or the radius r for M = 0.

- **Variables.** Each piece has an anchor pose (x, y, θ) in the exponential coordinates of §1 and chart offsets (u, v, φ) in the anchor's own frame: the piece is A·T(u, v)·R(φ), with A = T(exp_O(x, y))·R(θ). A unit of u or v moves the piece by one geodesic unit wherever it is (exponential coordinates about O would stretch by about sinh(r)/r far out at K < 0). Disks have no φ. Steps are ρ, ρ and ρ/R (disks: 1, 1); `inradius` is ρ. `rebase` reads the pose of A·T(u, v)·R(φ) back into the anchor; the configuration changes only by rounding. `randomPose` and `jiggle` change only the piece's offsets (a new pose G is written as the offsets of A⁻¹G), so writing them back undoes a move.
- **Starts.** `randomStart` takes the container at area density 0.45, as the package's search does (where that is too small, 95% of the way from the pieces' area to the largest container's). Its centres are uniform by area where a piece's inscribed disk fits, and each piece takes the best of 12 such centres: the one farthest from those placed before it. A near-ideal polygon at K < 0 keeps much of its room in its corners, which the search's placement (a disk about O) does not reach. On 13 problems near their P_max, finish succeeded from 76 of 104 relaxed random starts with that placement and from 86 with this one [CALC]. The capability `seeds` gives rings about O: none, one, or about a quarter or a third of the pieces inside, the rest on an outer ring, each ring as tight as its pieces allow, every piece with a vertex out, a vertex in or an edge in, the ring aligned with a wall, a corner or at random. One ring of triangles with a vertex at O is the {3, q} tiling (§6): from the seeds, finish reaches the tiling records at K* for q = 8, 9, 10 and 12, the disk rings for 7 and 10 disks at K = −1, and six squares in a hexagon at K = −1 (2.474469), none of which relaxed random starts reach reliably [CALC]. Where no ring fits, `seeds` returns fewer layouts.
- **Energy.** The squared negative gaps of §2, as geodesic lengths: the separating-axis value per polygon pair, d − 2 per disk pair, one term per protruding vertex (or disk centre) and wall or rim. Gradients are the analytic row gradients, taken in (u, v, φ); dE/ds goes through the apothem. A gap that is not a number (a piece beyond float range, about 710/√−K from O) makes the energy infinite and the piece not clear.
- **setSize.** Each centre's geodesic polar radius about O is multiplied by the ratio of the container's apothem (K ≤ 0) or circumradius (K > 0) at the new and old size; directions and θ are kept. At K = 0 this is the Euclidean homothety. For a growing container this ratio is the smaller of the wall and corner ratios, so the scaled points of the old container lie in the new one [CALC; checked numerically for K from −4 to 2, M = 3 to 8]. Sizes beyond the open hemisphere (K > 0) are evaluated at its limit.
- **Growth is not monotone for polygons.** For disks in a disk container, growing never creates an overlap [CALC]: at K ≤ 0 the distance between two geodesics from O is convex, so centre distances grow at least by the factor [EST, Bridson and Haefliger, *Metric Spaces of Non-Positive Curvature*, II.2.2]; at K > 0 the spherical law of cosines shows they do not shrink inside the hemisphere; and d + 1 ≤ λ(r − 1) + 1 ≤ λr keeps disks inside. Polygons can overlap after a growth. Moving two pieces apart radially turns them against each other by K times the change of the area of the triangle O c_i c_j, and a turn δ opens an overlap of about δ times half an edge between pieces in flush contact. For flush pairs this beats their separation beyond a radius: [CALC, 6000 random flush pairs per case, growth by 10⁻⁶]
  - K = −1: from 2.1 (triangles) or 3.5 (squares); none up to 4 for pentagons and larger.
  - K = −4: from 0.5 to 0.7; K = −6.5: from 0.26 to 0.32.
  - K = ±10⁻⁶: from about 1350 (|K|r² ≈ 1.8).
  - K > 0: none inside the hemisphere.

  A piece flush against a wall turns against it in the same way (protrusions of 10⁻⁴ after growth by 1% for triangles in octagons at K = −4 and −6.5).

  No setSize that moves the pieces with the container avoids this. Around a closed chain of touching pieces the turns between neighbours add up to K times the area the chain encloses (Gauss–Bonnet), and that area grows with the container, so some neighbours must turn. Only a setSize that leaves the pieces in place when the container grows is monotone, and it parts no overlap, which is what the methods grow for.

  In the catalogue, finished states of the {3, q} tilings at K* (q = 9, 10) overlap by about 10⁻⁸ after a growth of 10⁻⁶, and fail `checkKernel`'s growth check. A relaxation closes such overlaps (test). Elsewhere no growth raised the energy [CALC]: not the 299 records grown by 10%, and not 187 finished random starts (K = −1, −0.3, 0.3, 1; N = 0, 3, 4, 6; M = 0, 3, 4, 6, 8; P = 3, 6) grown by 0.1%, 10% and 50%.
- **finish.** The SLP polish of §3 (at most 40 iterations, every gap ≥ 10⁻¹²), then `validate` at tolerance 0. When the polish stops just short of feasibility (gaps about −10⁻¹¹), the configuration is grown along the setSize map by the smallest factor the validator accepts (bisection; only accepted configurations are returned). When the polish leaves overlaps, the pieces are separated as the package's search repairs a start (L-BFGS on its penalty energy; the arrangement grown by 15% up to three times when that does not separate them) and polished again. Infeasible problems give null. On all 299 records the finished size is at most the record's `score_cert` (worst relative difference −1.1·10⁻¹²) [CALC].
- **Work cap and stop.** A finish counts its work in energy evaluations: a row sweep (a pass over pairs and walls) or an L-BFGS evaluation is one, a validator call is three, and 1500P entries of simplex tableau work are one [CALC: LP work per energy time measured as 1·10⁴–2·10⁴ at P = 10, 3·10⁴–4·10⁴ at P = 20, 4.5·10⁴ at P = 30]. The repair and the polish end once the count passes 4 × finishCost, or when the caller's stop says so. The stop is polled at every simplex pivot. The point reached is then made valid as above, if it can be, and otherwise finish returns null.
- **finishCost** = 100 + 8P² (disks) or 100 + 25P² (polygons) energy evaluations. The measurement used 3 relaxed and 3 squeezed random starts of each of 70 problems (K = ±1; N = 0, 3, 4, 6; M = 0, 3, 8; P = 1 to 30) [CALC]. A finish's counted work was a median 0.8 times finishCost (0.08 to 2.3 by problem), at most 3.8 times. Timed against energy() on the states a squeeze visits, finishes at P = 10 to 20 took 1400 to 7400 energy times. `validateCost` is 3: the validator took 1 to 4 energy times on records. One energy() with gradient took 0.11 ms (10 disks), 0.12 ms (10 triangles in an octagon), 0.16 ms (30 disks) and 0.41 ms (29 triangles in an octagon). These were at K = −1, on states a squeeze visits, on a heavily loaded machine.
- **validate** is the server's rule (`packages/spaces/src/validate.ts`): P ≤ 30, the form and limits of the configuration (size ≤ 10⁶, coordinates ≤ 10⁴), the kernel's lower bound minus 10⁻⁹ relative, the far-centre test, then `validate` at TOL = 10⁻⁹. `fromConfig` refuses what the form, the limits or the far-centre test refuse. The server's strict check against a research record, and the record's own bound, are left to the server; finished configurations are valid at tolerance 0 and pass the strict check anyway.
- **bound.** The largest of the record bounds that apply (area; inradius ≥ ρ for polygon containers; r ≥ R and, for P ≥ 2, r ≥ 2ρ for disk containers), lowered by 10⁻¹² relative; null when none is finite below the admissible limit. It holds for the true shapes only.
- **Capabilities.** `shape`: curved space has no scaling, so the soft piece at t is the polygon cut by the disk of radius ρ + t(R − ρ) about its centre. It has the inradius and circumradius of the Euclidean soft piece of `kernel.ts` (the piece scaled by t and dilated by (1 − t)ρ), runs from the inscribed disk (t = 0) to the polygon (t = 1) and always lies inside the polygon. Its gaps are the largest of separation certificates (the polygons' separating-axis value, d − 2r, an edge line of one piece against the other's disk; per vertex and wall, the vertex or the disk), so the soft energy never exceeds the true one. For disks `shape` changes nothing. `seeds`: the rings above. `swap` (polygons): two pieces exchange θ, their orientation relative to the frame carried from O.
- **Problems that do not exist.** A unit piece that does not exist (K > 0 and √K ≥ 2π/N) makes the factory throw. Infeasible problems (P beyond P_max, §5) build a kernel whose finish returns null.
