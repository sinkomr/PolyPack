# 2D on 3D, Sphere: packings on the whole sphere

**Dimension.** On the site this is the kind **Sphere** under the dimension **2D on 3D**: pieces on a closed surface in 3D, with no container. The API calls it the space `sphere`.

Status: research build, 2026-10-24. Package `packages/sphere` (`@polypack/sphere`), search, certifier and bounds in `python/sphere/`, data in `data/sphere/`, viewer `packages/sphere/viz/index.html`.

## Summary

- **166 certified packings on the whole sphere** [CALC]: disks P = 2–40 (39), triangles, squares, pentagons and hexagons P = 2–30 (29 each), octagons P = 2–12 (11). Every record is proven strictly valid by an independent interval certifier (256-bit mpmath intervals) at `score_cert`, which exceeds the touching value `score_float` by at most 3·10⁻¹¹ relative (10⁻¹¹ for 165 of 166).
- **Chart-free pair test.** Whole-sphere pieces need not share a hemisphere, so pairs are decided by a plane through the centre of the sphere that strictly separates the two cones over the pieces (cone lemma, §3); the float validator uses the exact max-margin plane. No margin re-solve is needed: on the whole sphere a larger ρ shrinks every piece inside itself.
- **Disks = Tammes** [CALC/EST]: all 39 values agree with Cohn's table of spherical codes to within its 12-digit rounding (≤ 2.7·10⁻¹² relative); 14 records are `proven` (P = 2–14 and 24, published proofs cited in each record).
- **Exact cases** [CALC]: the five Platonic tilings (4, 8, 20 triangles, 6 squares, 12 pentagons) are stored with closed forms and meet the area bound; P = 2 meets the existence limit ρ = N/(2π) (polygons, infimum) or 2/π (disks). Squares 3 and 5, pentagons 11, hexagons 3–5 and octagons 3, 5, 6 meet the inscribed-disk bound, so they are optimal by a short argument from published Tammes theorems (kept `best_known`, per policy).
- **Against de Oliveira Filho, Spomer & Vallentin 2026** (arXiv:2604.21451, Table 2; triangles 8–24, squares 3–24, pentagons 3–24; 61 comparable entries) [CALC]: 40 certified configurations have a larger circumradius than the printed (truncated) value by more than 10⁻⁵ (non-trivial gains), one more is the classical icosahedral tiling (20 triangles, which dOSV do not list; their 20-triangle row is a weaker configuration), 18 agree within 10⁻⁵, 2 are smaller (squares 16, 23; by 0.05–0.13 % in ρ). The largest gains are for triangles (P = 12, 22, 23, 24: +1.3 % to +2.5 % in circumradius). An independent review re-certified all 166 records of the first publication by two further methods (one rigorous) and reproduced every verdict (the 14 records replaced in the re-run of 2026-10-24 are certified by `certify.py` and checked by the TypeScript validator, not yet by that review); these remain comparisons with a printed table, not with the authors' configuration files.
- **Lower bounds**: the headline `bound` of every record is rigorous (existence, area, Fejes Tóth, inscribed disks against Fejes Tóth or proven Tammes values, all decided in intervals); typical gaps are 2–9 % for polygons and 3–6 % for disks beyond P = 14. Higher published bounds from dOSV's maximality results that rest on floating-point SDP computations (squares P = 8–11, pentagons P = 6, 8) are kept separately as `bound_published` and labelled [EST, float-computed in the source].
- **Viewer**: `packages/sphere/viz/index.html` (standalone): a draggable orthographic globe (back hemisphere seen faintly through the globe) and a two-hemisphere Lambert equal-area map, with the table of certified values, bounds and literature values.

## 1. Problem definition

**Space.** The whole sphere of radius ρ (curvature K = 1/ρ²); there is no container. Problem id `sphere/N/P`.

**Pieces.** P congruent pieces: disks of geodesic radius 1 (N = 0) or regular spherical N-gons of geodesic side 1 (N = 3, 4, 5, 6, 8). Interiors must be disjoint; touching is allowed.

**Score.** The sphere radius ρ, smaller is better. Equivalently, scale the sphere to radius 1: a piece then has angular size a = 1/ρ (side angle of a polygon, angular radius of a disk), and the problem is to make P congruent pieces as large as possible on the unit sphere.

**Disks are the Tammes problem** [CALC]: caps of angular radius a are interior-disjoint iff their centres are at least 2a apart, so ρ_min(P) = 2/θ_P, where θ_P is the largest possible minimal angular distance of P points.

**Existence** [CALC]. A regular spherical N-gon with side a has angular circumradius R with sin(a/2) = sin R · sin(π/N), inradius r with tan(a/2) = sin r · tan(π/N), interior angle α with cos(π/N) = cos(a/2) · sin(α/2), and area Nα − (N − 2)π (Gauss–Bonnet, unit sphere). It is a convex polygon in an open hemisphere iff R < π/2, i.e. a < 2π/N, i.e. **ρ > N/(2π)** (0.477, 0.637, 0.796, 0.955, 1.273 for N = 3, 4, 5, 6, 8). So P = 1 and P = 2 have the same infimum N/(2π): two antipodal pieces fit for every ρ > N/(2π), and at ρ = N/(2π) the piece degenerates to a hemisphere (not attained). For disks, P = 2 is attained at ρ = 2/π (two closed hemispheres).

## 2. Coordinates and pose format (exact)

- All computation is on the unit sphere in R³. O = e3 = (0, 0, 1) is the north pole; the tangent frame at O is x = e1, y = e2. (The curved package's homogeneous point (v0, v1, v2) at K = 1 is (Z, X, Y) here.)
- **Standard piece**: centre O, vertex k at (sin R cos φ_k, sin R sin φ_k, cos R), φ_k = π/2 + 2πk/N, so vertex 0 points straight up (+y) as in PolyPack's planar convention. Disks: the cap of angular radius a around O.
- **Pose**: a quaternion `q = [w, x, y, z]`, any nonzero q. The placed piece is G(standard piece) with G the rotation of q/|q| (v ↦ q v q*, Hamilton product), whose matrix is H(q)/|q|², with
  H = [[w²+x²−y²−z², 2(xy−wz), 2(xz+wy)], [2(xy+wz), w²−x²+y²−z², 2(yz−wx)], [2(xz−wy), 2(yz+wx), w²−x²−y²+z²]].
  This is exactly orthogonal for every nonzero q, so stored floats define an exact rigid motion (no renormalisation error enters the proof).
- **Gauge** (SO(3) symmetry fixed in the search): piece 0 has q = [1, 0, 0, 0] (centre at the north pole, θ = 0).
- **Relation to the curved package's pose** (x, y, θ): G = T(c) R_z(θ), where c = G e3 is the centre, T(c) is the rotation about e3 × c by the angle d = ∠(O, c) (the transvection along the geodesic Oc) and R_z(θ) rotates about e3 by θ (counter-clockwise seen from outside). Exponential coordinates on the sphere of radius ρ: (x, y) = ρ d (c_x, c_y)/|(c_x, c_y)|. Conversions: `quatFromExp`, `expFromQuat`, `quatFromCentreTheta`, `centreThetaFromQuat` in `packages/sphere/src/geometry.ts`. The (x, y, θ) chart is singular at the south pole (all directions reach −e3 at d = π); quaternions are not, which is why records store quaternions.

## 3. Why the checks are correct (chart-free pair test)

Pieces on the whole sphere are not confined to one hemisphere, so the gnomonic-chart separating-axis test of the curved package (pieces in the open hemisphere around O) does not apply. Example [CALC]: two regular triangles with circumradius π/2 − 10⁻³ centred at the two poles, one turned by 60°: their six vertices alternate north and south of the equator, no open hemisphere contains both pieces, yet they are disjoint (tested in both validators).

**Cone lemma** [CALC, elementary]. A convex spherical polygon A with circumradius R < π/2 lies in the open hemisphere around its centre, and its cone ℝ₊A is the conic hull of its vertex vectors a_k (the gnomonic image of A is the convex hull of the projected vertices). Hence, if a vector n satisfies n·a_k > 0 for every vertex of A and n·b_l < 0 for every vertex of B, then n·x > 0 on ℝ₊A \ {0} and n·y < 0 on ℝ₊B \ {0}: the cones meet only at 0 and the closed pieces are disjoint. Conversely, two pieces with disjoint interiors have convex cones with disjoint interiors, which are separated by a plane through 0 (they are cones), so a weakly separating n always exists. The test needs no chart and no hemisphere assumption.

**Max-margin value** (float validator, search). m(A, B) = max over unit n of min(minₖ n·a_k, min_l −n·b_l). It is the cosine of the radius of the smallest cap containing S = {a_k} ∪ {−b_l}: m > 0 strictly separated, m = 0 touching, m < 0 interiors overlap. At the optimum at least two points of S are active (with one active point n would be that point and every other point of S would have to exceed it), so n is ±(p + q)/|p + q| for two points of S, or ± the unit normal of the plane through three of them; a brute force over these (C(2N, 2) + 2·C(2N, 3) candidates) is exact. This replaces the 3D separating-axis candidate list (edge planes a_k × a_{k+1}, b_l × b_{l+1} and vertex-pair planes a_i × b_j): edge planes and vertex-pair planes contain points of S and can only certify touching, while the max-margin plane gives a strictly separating witness whenever one exists. Both the TypeScript validator (`maxMarginPlane`) and the search (`max_margin_batch`) use it; tests compare it against 20,000 random normals (never beaten) and check symmetry.

**Far-pair prefilter.** Each polygon lies in the closed cap of radius R around its centre (the cap is convex for R < π/2 and contains the vertices). If c_i·c_j < cos 2R = 1 − 2 sin²R (decided in intervals; 2R < π) the caps, hence the pieces, are disjoint.

**Disks.** c_i·c_j < cos 2a = 1 − 2 sin²a, with 2a < π (proved), means the angle between the centres exceeds 2a.

**Rigorous certifier** (`python/sphere/certify.py`, separate code from the numpy search and the TypeScript validator). Reads the stored floats as exact dyadic rationals; builds the rotation matrices exactly as H(q)/|q|² in 256-bit outward-rounded interval arithmetic (mpmath `iv`); π, cos and sin come from power series with explicit remainder bounds (`python/curved/rigorous.py`, imported read-only by explicit path), so only interval +, −, ×, ÷ and √ are trusted. It proves strictly: the piece exists (sin(a/2) < sin(π/N)); for every pair either the far-pair inequality, or the plane test with the stored witness n (the float max-margin normal of the pair, stored per near pair as `[i, j, nx, ny, nz]`), or, if the witness is missing or fails, the plane test with float candidates recomputed from interval midpoints (only the sign test is trusted, so any heuristic source of n is sound). It rejects wrong P, NaN, ∞, N outside the problem set {0, 3, 4, 5, 6, 8}, ρ ≤ 0, zero or malformed quaternions, non-existent pieces and disks larger than a hemisphere (P ≥ 2). For a published record it also checks: id = sphere/N/P (optionally followed by #tag), config present, score_cert equal to config.rho, display = score_cert rounded to the nearest at 6 decimals (exact, half-even), 0 < score_float ≤ score_cert, status ∈ {best_known, proven}, and `proven` only with a cited published proof (`literature.proof`). It never raises: non-object records or fields are failures. The command line counts every entry of `records` (a missing or null config is a failure) and exits with status 1 on any failure.

**No margin re-solve on the whole sphere** [CALC]. Scaling is not a similarity on curved surfaces, which is why the curved package re-solves with a margin inside its container. Here there is no container: ρ ↦ ρ(1 + ε) shrinks every piece about its own centre on the unit sphere (a ↦ a/(1 + ε)). A regular polygon of smaller circumradius with the same centre and orientation lies in the interior of the original one (its vertices lie on the open segments from the centre to the original vertices, and the interior of a convex set contains those segments), so touching pieces become strictly disjoint with clearance of order ε. The stored poses are therefore certified unchanged at `score_cert = score_float (1 + ε)` with the smallest ε in {10⁻¹¹, 3·10⁻¹¹, 10⁻¹⁰, …} that the certifier accepts. The certifier does not rely on this argument; it checks the stored configuration at score_cert directly.

**Adversarial tests.** `python/sphere/test_certify.py` (27 tests): the cube tiling is accepted at ρ(1 + 10⁻¹⁰) and rejected at the touching value and at ρ(1 − 10⁻⁹); one square turned by 10⁻⁷ is rejected; a tetrahedral configuration with 0.1° orientation error is accepted 1 % above and rejected 1 % below; antipodal pairs at ρ = N/(2π)(1 ± 10⁻⁹) are accepted/rejected (there the circumradius is π/2 − 4·10⁻⁵, so a 10⁻³ tilt overlaps and a 10⁻⁶ tilt does not); the wrapping pair above is accepted, still accepted after a 1.5·10⁻³ tilt and rejected after 5·10⁻³; garbage and zero witnesses fall back correctly, and witnesses cannot rescue an overlapping configuration; disks overlapping by a relative 10⁻⁹ are rejected; the binary64 value of 2/π (3·10⁻¹⁷ above 2/π) is accepted for two hemispheres and the next float below is rejected; side angles beyond π (where sin(a/2) < sin(π/N) holds spuriously; regression for the flaw found in the curved certifier: "unit triangles" at ρ = 1/√20) are rejected; an id that does not match (N, P) or a score_cert different from the stored radius is rejected; two dozen malformed inputs (wrong P, NaN, ∞, bool/str/float N, ρ ≤ 0, zero or short quaternions, missing config) are rejected; N = 7, 9, 10, 12 are rejected (outside the problem set); the published-field checks (id with and without #tag, display, score_float ≤ score_cert, status, `proven` without a proof) each reject a tampered record; non-object records, list configs and list certificates return failures instead of tracebacks; the command line, run on the review's repro files (`python/sphere/fixtures/`), counts every record and exits 1; for the 14 `proven` disk records score_cert ≥ 2/θ_P with cos θ_P the exact root of Cohn's minimal polynomial (closed forms for P ≤ 6), computed at 50 digits, and score_float agrees with it to 10⁻¹²; the maximality bounds of the star rows are flagged non-rigorous and never the headline bound; sphere/3/20 is labelled a classical tiling and exactly 34 records count as gains over dOSV. `packages/sphere/test/sphere.test.ts` (15 tests) checks the geometry identities, pose conversions, the max-margin brute force against random normals, the wrapping pair, input checks (including ρ = 1/√20), and every stored record: strictly valid at score_cert, invalid at score_float (1 − 10⁻⁶), display = score_cert rounded to 6 decimals, bound ≤ score, exact tilings to 10⁻¹¹, and documents the float validator's precision near the existence limit (below).

**Float validator limits.** `validate` (TypeScript) is a float check and not authoritative. Near the existence limit ρ = N/(2π) the circumradius R = asin(sin(a/2)/sin(π/N)) approaches π/2 with π/2 − R ≈ √(2ε (π/N) cot(π/N)) at ρ = N/(2π)(1 + ε), and its float error grows like 10⁻¹⁶/(π/2 − R); the independent review found wrong strict decisions for |gap| ≤ 2·10⁻¹² within 5·10⁻⁸ relative of the limit. The certifier decides validity.

**Independent review** (2026-10-24) [CALC, reproduced there]: all 166 records re-certified by the certifier with and without witnesses, by a 50-digit check with a different method (vertex-in-piece and edge-crossing tests, no separating planes) and by a rigorous interval check with mpmath's own sin/cos and a different lemma; a 28,392-sample near-contact differential test against an independent predicate gave 0 false accepts and 0 false rejects.

**Independent sampling check** [CALC]. For the final records that beat the literature most clearly (triangles P = 12, 20, 22, 23, 24; squares P = 12, 24; pentagons P = 13) 4,000 random points per piece (convex combinations of its vertices) were tested against the edge half-spaces of every other piece, using nothing but the stored quaternions: no point lies inside another piece at score_cert, while at score_float (1 − 10⁻⁴) between 2 and 3,719 points do (`python/sphere/sample_check.py`).

## 4. Lower bounds (`python/sphere/bounds.py`)

Every bound L is checked in interval arithmetic: the stated necessary condition fails at a = 1/L, and every quantity involved is monotone in a, so it fails for every ρ < L. The float value is lowered by a relative 10⁻¹² before the check. Each entry of a record's `bounds` carries `rigorous`: true when the argument is elementary or rests on a published theorem with exact values (all items below except the float-computed maximality bounds); the headline `bound` is the best rigorous one.

- **Existence** (polygons) [CALC]: ρ > N/(2π), checked as 1/L > 2π/N.
- **Area** [CALC]: P·A(a) ≤ 4π. For polygons α(a) ≥ α\* = ((N − 2)π + 4π/P)/N, checked as cos(π/N)/cos(a/2) ≥ sin(α\*/2); for disks cos a ≥ 1 − 2/P. Sharp exactly for the tilings.
- **Fejes Tóth** (disks, P ≥ 3) [CALC from EST theorem]: cos θ_P ≥ (cot²ω − 1)/2 with ω = πP/(6(P − 2)) (L. Fejes Tóth 1943), so ρ ≥ 2/θ_FT. Sharp for P = 3, 4, 6, 12.
- **Published Tammes optimum** (disks; P = 3–14, 24) [EST]: ρ ≥ 2/θ_P with cos θ_P from Cohn's table minus 10⁻¹¹ (12 printed decimals).
- **Inscribed disks** (polygons) [CALC/EST]: the inscribed caps (angular radius r(a)) of the pieces are interior-disjoint, so their centres form a spherical code with minimal angle ≥ 2r: 2r ≤ θ_P ≤ θ_FT(P), or ≤ θ_P itself where the Tammes optimum is proven.
- **Maximality** (polygons) [EST]: de Oliveira Filho, Spomer and Vallentin (arXiv:2604.21451, Table 2) show for several (N, n) that n copies at their circumradius ϱ_n admit no (n + 1)-th copy (marks † and ⋆; the triangle rows marked "conjectured" are excluded). Packability is monotone in the size, and ϱ_n is printed truncated to 6 decimals, so n + 1 copies need R < ϱ_n + 10⁻⁶: a published lower bound for P = n + 1. **Rigour**: their ϑ′ and 3-point values were "carried out in high-precision floating-point arithmetic; the bounds obtained can be rigorously verified using standard techniques", i.e. they are not rigorously verified in the paper. Where the printed volume bound is already below n + 1 (for example the triangle † rows n = 19, 20) maximality follows from the area argument and the bound is rigorous (and weaker than our own area bound). Otherwise (squares P = 8–11 from the ⋆ rows n = 7–10, pentagons P = 6 and 8 from n = 5 and 7, and the other rows whose volume bound does not settle it) the bound is labelled **[EST, float-computed in the source]**, stored with `rigorous: false`, and reported as `bound_published` when it exceeds the rigorous bound; it is never the headline bound.

Not implemented: linear-programming / SDP bounds (Delsarte–Goethals–Seidel, Bachoc–Vallentin) and the theta' values themselves as bounds on ρ (they bound the count at a given size; converting them would need their computation at other radii).

## 5. Literature and conversion of normalisations

- **Tammes** [EST]: H. Cohn, *Table of spherical codes*, https://spherical-codes.org/ (data archived at https://hdl.handle.net/1721.1/153543), dimension 3, cosines of the minimal angle to 12 decimals; accessed 2026-10-24. P ≤ 6 is omitted there (R. A. Rankin 1955 settles at most 2n points in dimension n). Conversion: ρ = 2/arccos(cos θ_P). The table rounds cosines **up** at 12 decimals (P = 9 is printed 0.333333333334 for 1/3, P = 10 ...217 for ...21625), so the table's ρ is slightly too large and ours sit up to 2.7·10⁻¹² below it for P ≥ 15; for the proven cases the tests compare with the exact roots of Cohn's minimal polynomials instead. Proofs used for `proven`: Rankin 1955 (P ≤ 6; also Fejes Tóth 1943 for 3, 4, 6), Schütte & van der Waerden 1951 (5–9), Danzer 1963/1986 (10, 11), Böröczky 1983 (11), Fejes Tóth 1943 (12), Musin & Tarasov 2012 (13), 2015 (14), Robinson 1961 (24). Full references are in each record. Cohn's table also marks P = 15 optimal, citing a 2026 Zenodo preprint (mt0-svg, doi:10.5281/zenodo.23450670); that is not a refereed publication, so P = 15 stays `best_known`.
- **Polygons** [EST]: F. M. de Oliveira Filho, A. Spomer, F. Vallentin, *Bounding the density of spherical polygon packings*, arXiv:2604.21451 (23 April 2026), Table 2, https://arxiv.org/abs/2604.21451, accessed 2026-10-24. Their normalisation: n congruent regular N-gons on the unit sphere, maximise the circumradius ϱ (angular distance from the barycenter to a vertex; their K_ϱ has vertices R_Z((2i − 1)π/N)(0, sin ϱ, cos ϱ), the same polygon as ours up to a rotation). **Conversion**: side a = 2 arcsin(sin ϱ · sin(π/N)) and ρ = 1/a. Because ϱ is truncated to 6 decimals, the paper's ρ lies in [1/a(ϱ + 10⁻⁶), 1/a(ϱ)]; records store both ends and a verdict (better: our R exceeds the printed ϱ by more than 10⁻⁵; tiling: the same, but our configuration is a classical Platonic tiling (only 20 triangles); same: within 10⁻⁵; worse: below the printed value). Their table covers triangles n = 8–24, squares 3–24, pentagons 3–24; "maximal" there means that no (n + 1)-th copy fits (it is not optimality of ϱ).
- **Pentagons**, T. Tarnai and Zs. Gáspár, *Packing of equal regular pentagons on a sphere*, Proc. R. Soc. Lond. A 457 (2001) 1043–1058: not consulted directly (paywalled). dOSV 2026 report that their pentagon radii "approximate closely those by Tarnai and Gáspár, except for the packing of 9 pentagons", where theirs is significantly larger; so the dOSV column stands in for both.

## 6. Exact cases

Radial projections of the Platonic solids tile the sphere and meet the area bound P·A = 4πρ² exactly [CALC]; all five are reproduced by the search to 10⁻¹² and stored with the closed form as score_float:

| case | vertex angle | ρ (closed form) | value |
|---|---|---|---|
| 4 triangles (tetrahedron) | 2π/3 | 1/arccos(−1/3) | 0.523386687 |
| 8 triangles (octahedron) | π/2 | 2/π | 0.636619772 |
| 20 triangles (icosahedron) | 2π/5 | 1/arctan 2 | 0.903221025 |
| 6 squares (cube) | 2π/3 | 1/arccos(1/3) | 0.812374467 |
| 12 pentagons (dodecahedron) | 2π/3 | 1/arccos(√5/3) | 1.370374264 |
| 2 N-gons | π (hemispheres) | N/(2π), infimum | 0.477, 0.637, 0.796, 0.955, 1.273 |
| 2 disks | — | 2/π | 0.636619772 |

They are optimal by the area (or existence) argument, but stay `best_known` with a note (PolyPack's own derivation, per the proven-claims policy).

## 7. Search

Seeded and reproducible (`python/sphere/search.py`, numpy/scipy; seed 1, `np.random.default_rng([seed, N, P])`).

- **Polygons.** Variables: one quaternion per piece (piece 0 fixed), one separating-plane normal m per near pair, and the circumradius R. Constraints m̂·x ≥ 0 on the vertices of one piece and −m̂·y ≥ 0 on the other (the cone lemma, so the model is chart-free). Stage 1: penalty continuation min −R + λ Σ relu(−s)² with L-BFGS-B (λ = 10, 100, 1000; analytic gradients through the quaternion rotation formula, checked against finite differences). Stage 2: SLSQP maximising R in a box trust region re-centred each round; pairs with max-margin below 0.03 enter as "edge" witnesses (the other piece's vertices beyond one edge plane, no extra variables) when an edge plane is within 10⁻³ of the max margin, otherwise with a plane variable; pairs found touching outside the model are added. Starts: Platonic face centres (P = 4, 6, 8, 12, 20), the P − 1 optimum plus one piece in the largest hole, the best Tammes code for P, then random; basin hopping alternates jiggle / re-place one piece / spin a quarter of the pieces. Budget: 6 starts, then hops until 40 s per problem (30 s for octagons); then, for the 16 cases still behind dOSV after that pass, two further warm-started passes with seeds 2 and 3 (75 s each, run in parallel in opposite order) and a third (seed 4, 90 s) for the four that remained behind. Re-run on 2026-10-24 (evening; one process at nice 10 on a still heavily shared machine, load average 20–140): the nine cases behind dOSV got two more warm-started runs each (seed 11, 240 s; seed 12, 240 s with `--code-mix`, i.e. every other start a rotated, jittered Tammes code with random or neighbour-aligned orientations), the five still behind a third (seed 14, 200 s, `--code-mix`), and six of the largest-gap problems that had only the 40 s pass a 100 s run (seed 13, `--code-mix`: hexagons P = 15, 19, 25, 28, 29, pentagons P = 28). Replaced records: sphere/3/13,  sphere/4/14,  sphere/4/16,  sphere/4/17,  sphere/4/18,  sphere/5/17,  sphere/5/20,  sphere/5/22,  sphere/5/28,  sphere/6/15,  sphere/6/19,  sphere/6/25,  sphere/6/28,  sphere/6/29. Each record stores its seed and budget.
- **Disks.** Minimise z = max c_i·c_j: penalty continuation (L-BFGS-B) then SLSQP; 8 random starts and up to 40 hops within 120 s per P. P = 21 and 35 were warm-started from Cohn's published coordinates (https://spherical-codes.org/data/3/21, /35), since the seeded search stopped 4·10⁻⁵ short there; the records say so.

## Kernel for the generic methods

`sphereKernel({ N, P })` (`packages/sphere/src/kernel.ts`) is the sphere's kernel for the generic search methods (`docs/methods/dimensions/README.md`). The built-in search stays available as Auto.

- **Variables.** Each piece has an anchor quaternion q₀ and a rotation vector w about a world axis; its pose is exp(w) q₀, as in the TypeScript search. The kernel's variables are x = ρw, so a turn about an axis at right angles to the centre moves the centre by |x| along the sphere: every variable is a length. The size is ρ. `rebase` folds the turns into the anchors. Moves (`jiggle`, `randomPose`, `swap`) change only the moved pieces' entries of x.
- **Energy.** A sum of squared lengths. Polygons: ρ times the separating-edge value G of a pair, the largest over the edges of both pieces of the smallest sine distance of the other piece's vertices beyond the edge's great circle. G ≥ 0 separates the cones (cone lemma, §3). For two pieces in a common open hemisphere the converse also holds: the gnomonic chart maps them to convex polygons, and disjoint convex polygons are separated by the line of an edge of one of them [CALC]. Pairs whose circumscribed caps are disjoint are skipped, as in the validator. Disks: 2 − ρθ, the validator's gap negated (θ the angle between the centres). One wall term per piece below the smallest ρ at which the pieces exist. The gradient is exact: the turns enter through the left Jacobian of SO(3), and R(a) and r(a) through closed-form derivatives.
- **finish().** The search's tight-size bisection to 10⁻¹³ relative. Each step uses the energy's own pair test instead of the whole validator; the validator's max-margin plane is used only for overlapping pairs that are not in a common hemisphere. The validator then checks the result at tolerance 0. If rounding at a contact requires it, the result moves up by at most 7·10⁻¹² relative; if the validator still refuses it, the validator's own bisection decides, and that slow path polls the run's stop. When the pair test finds no valid ρ within a factor of about 14, the finish gives up at once, after about a dozen sweeps. For polygons the kernel's smallest angular size is 2π/N (1 − 10⁻¹²), against the search's 2π/N (1 − 10⁻⁹): one or two polygons, whose bound is the existence limit (an infimum), then finish within 10⁻⁹ of it, so a run stops there. On 88 squeezed states of 22 problems the result equalled the validator-driven bisection in 87 and was 3·10⁻¹³ above it in one [CALC].
- **validate().** The server's rule: the format and ranges that `packages/spaces` reads, the size against the kernel's bound with the server's slack of 10⁻⁹ relative, then `validate` at the touching tolerance 10⁻⁹. The server's strict check of a size below a research record (tolerance 10⁻¹¹) needs the record, so it stays with the server.
- **bound.** The area bound of §4.
- **Capabilities.**
  - `shape`: the soft polygon at t is the polygon cut by the cap about its centre of angular radius tR + (1 − t)r (R and r the angular circumradius and inradius): the inscribed cap at t = 0, the polygon at t = 1. A pair's term is the smaller of the polygon term and the cap term ρ(2(tR + (1 − t)r) − θ). It is positive only when both the polygons and the caps overlap, so the cut pieces are separated when it is zero, and it never exceeds the true term. The kernel definition's soft piece (the piece scaled by t and dilated by (1 − t) r) has the same circumradius, so it lies in this one; the cut piece is an approximation that stays inside the polygon. For disks `setShape` does nothing.
  - `seeds`: centres at the face centres of a Platonic solid (P = 4, 6, 8, 12, 20) or on a Fibonacci spiral, turned at random, each piece at a random orientation or with an edge facing its nearest neighbour (after the research search's starts), at the ρ where the circumscribed caps of the closest pair touch. Every seed is valid.
  - `swap`: two polygons exchange orientations, carried along the geodesic between their centres.
- **Costs** [CALC, measured on an Apple Silicon laptop under heavy load]. One energy with gradient takes 4–25 µs at P = 10 and 15–40 µs at P = 30. A finish costs 10–20 energies for disks and 80–700 for polygons (about 1,600 for octagons at P = 10); nearly all of it is the one validator call. `finishCost` is 30, 100, 500, 500, 800 and 2,500 for N = 0, 3, 4, 5, 6 and 8.
- **Tests.** `packages/sphere/test/kernel.test.ts`: the kernel contract on 14 problems; the gradient against central differences, soft shapes included; all 166 records convert, validate, have zero energy, and finish at most 10⁻⁹ above `score_cert`; squeezes from random starts; soft shapes, seeds, swap and moves; the server's rule, including a size below the bound; one or two polygons stopping at the bound; finishes that cannot succeed; a run through `runMethod`.

## 8. Tables

All values are `display` = score_cert rounded to the nearest at 6 decimals (half-even, from its exact binary64 value; until 2026-10-24 it was rounded up); every listed packing is certified (`data/sphere/certification.json`). "gap to bound" is score_float / bound − 1 for the best rigorous bound.

Bounds are rigorous (interval-checked). 'published ... (float-computed)' is a higher bound from dOSV 2026 maximality whose own computation was done in floating point; it is not used as the headline bound.

#### disks (N = 0)

| P | rho (certified, 6 decimals) | lower bound (kind) | gap to bound | Tammes rho (Cohn table) | ours - lit (rel) | status |
|---|---|---|---|---|---|---|
| 2 | 0.636620 | 0.636620 (area) | 0.000% | 0.636619772 | +0.0e+00 | proven |
| 3 | 0.954930 | 0.954930 (fejes toth) | 0.000% | 0.954929659 | +2.3e-16 | proven |
| 4 | 1.046773 | 1.046773 (fejes toth) | 0.000% | 1.046773374 | +0.0e+00 | proven |
| 5 | 1.273240 | 1.273240 (tammes proven) | 0.000% | 1.273239545 | +0.0e+00 | proven |
| 6 | 1.273240 | 1.273240 (fejes toth) | 0.000% | 1.273239545 | +0.0e+00 | proven |
| 7 | 1.471584 | 1.471584 (tammes proven) | 0.000% | 1.471583829 | -3.0e-13 | proven |
| 8 | 1.530776 | 1.530776 (tammes proven) | 0.000% | 1.530775677 | -2.0e-13 | proven |
| 9 | 1.624749 | 1.624749 (tammes proven) | 0.000% | 1.624748933 | -5.7e-13 | proven |
| 10 | 1.732382 | 1.732382 (tammes proven) | 0.000% | 1.732381928 | -7.1e-13 | proven |
| 11 | 1.806442 | 1.806442 (tammes proven) | 0.000% | 1.806442051 | -4.2e-14 | proven |
| 12 | 1.806442 | 1.806442 (fejes toth) | 0.000% | 1.806442051 | -4.2e-14 | proven |
| 13 | 2.005568 | 2.005568 (tammes proven) | 0.000% | 2.005568275 | -4.3e-13 | proven |
| 14 | 2.058387 | 2.058387 (tammes proven) | 0.000% | 2.058386667 | -6.2e-13 | proven |
| 15 | 2.135597 | 2.022031 (fejes toth) | 5.616% | 2.135597284 | -1.2e-12 | best_known |
| 16 | 2.193375 | 2.088995 (fejes toth) | 4.997% | 2.193375143 | -4.2e-13 | best_known |
| 17 | 2.242921 | 2.153890 (fejes toth) | 4.134% | 2.242920769 | -1.4e-12 | best_known |
| 18 | 2.312334 | 2.216895 (fejes toth) | 4.305% | 2.312334429 | -1.3e-12 | best_known |
| 19 | 2.402746 | 2.278166 (fejes toth) | 5.468% | 2.402746066 | -1.5e-12 | best_known |
| 20 | 2.415962 | 2.337838 (fejes toth) | 3.342% | 2.415961534 | -5.7e-13 | best_known |
| 21 | 2.512244 | 2.396030 (fejes toth) | 4.850% | 2.512244284 | -1.1e-12 | best_known |
| 22 | 2.561268 | 2.452845 (fejes toth) | 4.420% | 2.561268356 | -5.6e-13 | best_known |
| 23 | 2.621635 | 2.508377 (fejes toth) | 4.515% | 2.621634703 | -1.1e-12 | best_known |
| 24 | 2.622787 | 2.622787 (tammes proven) | 0.000% | 2.622786612 | -9.3e-13 | proven |
| 25 | 2.752325 | 2.615916 (fejes toth) | 5.215% | 2.752324770 | -1.4e-14 | best_known |
| 26 | 2.792351 | 2.668063 (fejes toth) | 4.658% | 2.792351088 | -2.0e-12 | best_known |
| 27 | 2.817068 | 2.719213 (fejes toth) | 3.599% | 2.817067799 | -9.1e-13 | best_known |
| 28 | 2.911730 | 2.769419 (fejes toth) | 5.139% | 2.911730174 | -8.3e-14 | best_known |
| 29 | 2.959978 | 2.818733 (fejes toth) | 5.011% | 2.959978082 | -6.7e-13 | best_known |
| 30 | 2.968915 | 2.867200 (fejes toth) | 3.548% | 2.968915065 | -2.7e-14 | best_known |
| 31 | 3.038772 | 2.914862 (fejes toth) | 4.251% | 3.038771631 | -8.1e-13 | best_known |
| 32 | 3.057796 | 2.961758 (fejes toth) | 3.243% | 3.057795990 | -1.9e-12 | best_known |
| 33 | 3.160749 | 3.007924 (fejes toth) | 5.081% | 3.160749468 | -1.2e-12 | best_known |
| 34 | 3.200186 | 3.053392 (fejes toth) | 4.808% | 3.200185685 | -2.7e-12 | best_known |
| 35 | 3.244399 | 3.098195 (fejes toth) | 4.719% | 3.244399300 | -7.4e-13 | best_known |
| 36 | 3.256392 | 3.142359 (fejes toth) | 3.629% | 3.256391898 | -2.1e-12 | best_known |
| 37 | 3.328981 | 3.185911 (fejes toth) | 4.491% | 3.328981488 | -2.3e-13 | best_known |
| 38 | 3.345674 | 3.228876 (fejes toth) | 3.617% | 3.345674413 | -8.7e-13 | best_known |
| 39 | 3.421762 | 3.271278 (fejes toth) | 4.600% | 3.421762359 | -1.9e-12 | best_known |
| 40 | 3.455888 | 3.313137 (fejes toth) | 4.309% | 3.455887804 | -1.8e-12 | best_known |

#### triangles (N = 3)

| P | rho (certified, 6 decimals) | circumradius R (rad) | lower bound (kind) | gap to bound | dOSV 2026 R (truncated) | vs dOSV | status |
|---|---|---|---|---|---|---|---|
| 2 | 0.477465 | 1.5707963 | 0.477465 (existence) | 0.000% | - | - | best_known |
| 3 | 0.523387 | 1.2309594 | 0.508754 (inradius fejes toth) | 2.876% | - | - | best_known |
| 4 | 0.523387 | 1.2309594 | 0.523387 (area) | 0.000% | - | - | best_known |
| 5 | 0.589579 | 1.0471976 | 0.564285 (inradius tammes) | 4.483% | - | - | best_known |
| 6 | 0.600392 | 1.0241251 | 0.581633 (area) | 3.225% | - | - | best_known |
| 7 | 0.636620 | 0.9553166 | 0.609613 (area) | 4.430% | - | - | best_known |
| 8 | 0.636620 | 0.9553166 | 0.636620 (area) | 0.000% | 0.955316 † | same | best_known |
| 9 | 0.708316 | 0.8466663 | 0.662681 (area) | 6.886% | 0.846584 | better | best_known |
| 10 | 0.722050 | 0.8289318 | 0.687853 (area) | 4.972% | 0.828930 ⋆ | same | best_known |
| 11 | 0.753803 | 0.7908852 | 0.712202 (area) | 5.841% | 0.790798 | better | best_known |
| 12 | 0.771582 | 0.7711876 | 0.735792 (area) | 4.864% | 0.760924 - | better | best_known |
| 13 | 0.803256 | 0.7385784 | 0.758682 (area) | 5.875% | 0.738005 - | better | best_known |
| 14 | 0.820883 | 0.7216690 | 0.780927 (area) | 5.116% | 0.719838 | better | best_known |
| 15 | 0.843701 | 0.7009566 | 0.802575 (area) | 5.124% | 0.699345 - | better | best_known |
| 16 | 0.859615 | 0.6872347 | 0.823668 (area) | 4.364% | 0.685159 | better | best_known |
| 17 | 0.877641 | 0.6723558 | 0.844247 (area) | 3.955% | 0.669803 | better | best_known |
| 18 | 0.895556 | 0.6582189 | 0.864345 (area) | 3.611% | 0.658112 | better | best_known |
| 19 | 0.902305 | 0.6530527 | 0.883993 (area) | 2.071% | 0.652634 † | better | best_known |
| 20 | 0.903221 | 0.6523581 | 0.903221 (area) | 0.000% | 0.651805 † | tiling | best_known |
| 21 | 0.970559 | 0.6051656 | 0.922053 (area) | 5.261% | 0.604417 | better | best_known |
| 22 | 0.975610 | 0.6019076 | 0.940512 (area) | 3.732% | 0.587346 - | better | best_known |
| 23 | 1.002937 | 0.5848911 | 0.958620 (area) | 4.623% | 0.570870 | better | best_known |
| 24 | 1.033395 | 0.5670523 | 0.976395 (area) | 5.838% | 0.558125 - | better | best_known |
| 25 | 1.050349 | 0.5575968 | 0.993855 (area) | 5.684% | - | - | best_known |
| 26 | 1.065089 | 0.5496348 | 1.011016 (area) | 5.348% | - | - | best_known |
| 27 | 1.104651 | 0.5293696 | 1.027892 (area) | 7.468% | - | - | best_known |
| 28 | 1.117208 | 0.5232527 | 1.044497 (area) | 6.961% | - | - | best_known |
| 29 | 1.134389 | 0.5151124 | 1.060844 (area) | 6.933% | - | - | best_known |
| 30 | 1.145406 | 0.5100267 | 1.076945 (area) | 6.357% | - | - | best_known |

#### squares (N = 4)

| P | rho (certified, 6 decimals) | circumradius R (rad) | lower bound (kind) | gap to bound | dOSV 2026 R (truncated) | vs dOSV | status |
|---|---|---|---|---|---|---|---|
| 2 | 0.636620 | 1.5707963 | 0.636620 (existence) | 0.000% | - | - | best_known |
| 3 | 0.700551 | 1.1831996 | 0.700551 (inradius fejes toth) | 0.000% | 1.183199 † | same | best_known |
| 4 | 0.750481 | 1.0634400 | 0.730226 (inradius fejes toth) | 2.774% | 1.063440 † | same | best_known |
| 5 | 0.812374 | 0.9553166 | 0.812374 (inradius tammes) | 0.000% | 0.955316 | same | best_known |
| 6 | 0.812374 | 0.9553166 | 0.812374 (area) | 0.000% | 0.955316 † | same | best_known |
| 7 | 0.927354 | 0.8126170 | 0.891161 (inradius tammes) | 4.061% | 0.812554 ⋆ | better | best_known |
| 8 | 0.963701 | 0.7771663 | 0.915547 (inradius tammes); published 0.927414 (float-computed) | 5.260% | 0.777160 ⋆ | same | best_known |
| 9 | 1.008775 | 0.7377245 | 0.954930 (inradius tammes); published 0.963707 (float-computed) | 5.639% | 0.737706 ⋆ | better | best_known |
| 10 | 1.055167 | 0.7014660 | 1.000909 (inradius tammes); published 1.008796 (float-computed) | 5.421% | 0.701465 ⋆ | same | best_known |
| 11 | 1.106254 | 0.6657497 | 1.033015 (inradius tammes); published 1.055167 (float-computed) | 7.090% | 0.665589 - | better | best_known |
| 12 | 1.111808 | 0.6621007 | 1.062435 (area) | 4.647% | 0.659825 ⋆ | better | best_known |
| 13 | 1.192270 | 0.6136362 | 1.120922 (inradius tammes) | 6.365% | 0.611102 - | better | best_known |
| 14 | 1.219447 | 0.5989156 | 1.144572 (inradius tammes) | 6.542% | 0.598860 - | better | best_known |
| 15 | 1.244722 | 0.5858756 | 1.168742 (area) | 6.501% | 0.585592 - | better | best_known |
| 16 | 1.288515 | 0.5646351 | 1.202148 (area) | 7.184% | 0.564943 | worse | best_known |
| 17 | 1.322031 | 0.5494332 | 1.234669 (area) | 7.076% | 0.549177 - | better | best_known |
| 18 | 1.346906 | 0.5386890 | 1.266371 (area) | 6.360% | 0.537891 - | better | best_known |
| 19 | 1.398580 | 0.5177055 | 1.297311 (area) | 7.806% | 0.516950 - | better | best_known |
| 20 | 1.417776 | 0.5103349 | 1.327540 (area) | 6.797% | 0.510062 - | better | best_known |
| 21 | 1.452239 | 0.4976309 | 1.357104 (area) | 7.010% | 0.495188 - | better | best_known |
| 22 | 1.483548 | 0.4866417 | 1.386045 (area) | 7.035% | 0.485876 - | better | best_known |
| 23 | 1.519817 | 0.4745189 | 1.414400 (area) | 7.453% | 0.475163 - | worse | best_known |
| 24 | 1.536193 | 0.4692460 | 1.442203 (area) | 6.517% | 0.465337 - | better | best_known |
| 25 | 1.566632 | 0.4597577 | 1.469484 (area) | 6.611% | - | - | best_known |
| 26 | 1.597365 | 0.4505686 | 1.496272 (area) | 6.756% | - | - | best_known |
| 27 | 1.637273 | 0.4391818 | 1.522592 (area) | 7.532% | - | - | best_known |
| 28 | 1.654463 | 0.4344563 | 1.548467 (area) | 6.845% | - | - | best_known |
| 29 | 1.694997 | 0.4237141 | 1.573920 (area) | 7.693% | - | - | best_known |
| 30 | 1.715368 | 0.4185175 | 1.598970 (area) | 7.280% | - | - | best_known |

#### pentagons (N = 5)

| P | rho (certified, 6 decimals) | circumradius R (rad) | lower bound (kind) | gap to bound | dOSV 2026 R (truncated) | vs dOSV | status |
|---|---|---|---|---|---|---|---|
| 2 | 0.795775 | 1.5707963 | 0.795775 (existence) | 0.000% | - | - | best_known |
| 3 | 0.903221 | 1.1071487 | 0.890287 (inradius fejes toth) | 1.453% | 1.107148 † | same | best_known |
| 4 | 0.948615 | 1.0270589 | 0.933848 (inradius fejes toth) | 1.581% | 1.027058 † | same | best_known |
| 5 | 1.077108 | 0.8659246 | 1.053560 (inradius tammes) | 2.235% | 0.865924 ⋆ | same | best_known |
| 6 | 1.092884 | 0.8503088 | 1.053560 (inradius fejes toth); published 1.077108 (float-computed) | 3.732% | 0.850308 † | same | best_known |
| 7 | 1.204014 | 0.7564992 | 1.167361 (inradius tammes) | 3.140% | 0.756498 ⋆ | same | best_known |
| 8 | 1.238670 | 0.7318494 | 1.202418 (inradius tammes); published 1.204014 (float-computed) | 3.015% | 0.731849 † | same | best_known |
| 9 | 1.300221 | 0.6921965 | 1.258885 (inradius tammes) | 3.284% | 0.692196 † | same | best_known |
| 10 | 1.359429 | 0.6582436 | 1.324603 (inradius tammes) | 2.629% | 0.658224 | better | best_known |
| 11 | 1.370374 | 0.6523581 | 1.370374 (inradius tammes) | 0.000% | 0.652358 | same | best_known |
| 12 | 1.370374 | 0.6523581 | 1.370374 (inradius fejes toth) | 0.000% | 0.652358 † | same | best_known |
| 13 | 1.558182 | 0.5664081 | 1.495259 (inradius tammes) | 4.208% | 0.565329 | better | best_known |
| 14 | 1.588181 | 0.5548423 | 1.528762 (inradius tammes) | 3.887% | 0.554476 | better | best_known |
| 15 | 1.629273 | 0.5397807 | 1.511951 (area) | 7.760% | 0.539673 | better | best_known |
| 16 | 1.672505 | 0.5248310 | 1.556360 (area) | 7.463% | 0.524729 | better | best_known |
| 17 | 1.710742 | 0.5123098 | 1.599562 (area) | 6.951% | 0.512308 | same | best_known |
| 18 | 1.756290 | 0.4981817 | 1.641648 (area) | 6.983% | 0.498146 - | better | best_known |
| 19 | 1.815839 | 0.4808852 | 1.682698 (area) | 7.912% | 0.480722 | better | best_known |
| 20 | 1.830938 | 0.4766952 | 1.722783 (area) | 6.278% | 0.476634 - | better | best_known |
| 21 | 1.892503 | 0.4603634 | 1.761969 (area) | 7.408% | 0.459979 - | better | best_known |
| 22 | 1.927506 | 0.4515818 | 1.800311 (area) | 7.065% | 0.451462 - | better | best_known |
| 23 | 1.988589 | 0.4370550 | 1.837862 (area) | 8.201% | 0.436889 - | better | best_known |
| 24 | 1.996442 | 0.4352566 | 1.893675 (inradius tammes) | 5.427% | 0.435221 - | better | best_known |
| 25 | 2.066724 | 0.4198139 | 1.910770 (area) | 8.162% | - | - | best_known |
| 26 | 2.097911 | 0.4133151 | 1.946208 (area) | 7.795% | - | - | best_known |
| 27 | 2.118715 | 0.4090932 | 1.981016 (area) | 6.951% | - | - | best_known |
| 28 | 2.179727 | 0.3972048 | 2.015227 (area) | 8.163% | - | - | best_known |
| 29 | 2.214629 | 0.3907159 | 2.048871 (area) | 8.090% | - | - | best_known |
| 30 | 2.241729 | 0.3858249 | 2.081974 (area) | 7.673% | - | - | best_known |

#### hexagons (N = 6)

| P | rho (certified, 6 decimals) | circumradius R (rad) | lower bound (kind) | gap to bound | dOSV 2026 R (truncated) | vs dOSV | status |
|---|---|---|---|---|---|---|---|
| 2 | 0.954930 | 1.5707963 | 0.954930 (existence) | 0.000% | - | - | best_known |
| 3 | 1.078405 | 1.1071487 | 1.078405 (inradius fejes toth) | 0.000% | - | - | best_known |
| 4 | 1.135046 | 1.0213291 | 1.135046 (inradius fejes toth) | 0.000% | - | - | best_known |
| 5 | 1.290001 | 0.8570719 | 1.290001 (inradius tammes) | 0.000% | - | - | best_known |
| 6 | 1.323564 | 0.8296478 | 1.290001 (inradius fejes toth) | 2.602% | - | - | best_known |
| 7 | 1.471547 | 0.7295798 | 1.436550 (inradius tammes) | 2.436% | - | - | best_known |
| 8 | 1.517505 | 0.7037976 | 1.481575 (inradius tammes) | 2.425% | - | - | best_known |
| 9 | 1.592875 | 0.6656068 | 1.553999 (inradius tammes) | 2.502% | - | - | best_known |
| 10 | 1.682004 | 0.6258809 | 1.638150 (inradius tammes) | 2.677% | - | - | best_known |
| 11 | 1.767198 | 0.5923931 | 1.696680 (inradius tammes) | 4.156% | - | - | best_known |
| 12 | 1.770251 | 0.5912640 | 1.696680 (inradius fejes toth) | 4.336% | - | - | best_known |
| 13 | 1.907932 | 0.5446852 | 1.856101 (inradius tammes) | 2.793% | - | - | best_known |
| 14 | 1.953380 | 0.5309598 | 1.898808 (inradius tammes) | 2.874% | - | - | best_known |
| 15 | 2.018721 | 0.5124499 | 1.869396 (inradius fejes toth) | 7.988% | - | - | best_known |
| 16 | 2.072962 | 0.4980777 | 1.923627 (inradius fejes toth) | 7.763% | - | - | best_known |
| 17 | 2.127019 | 0.4845651 | 1.976405 (inradius fejes toth) | 7.621% | - | - | best_known |
| 18 | 2.179622 | 0.4721273 | 2.027837 (inradius fejes toth) | 7.485% | - | - | best_known |
| 19 | 2.250479 | 0.4563819 | 2.078018 (inradius fejes toth) | 8.299% | - | - | best_known |
| 20 | 2.274148 | 0.4513614 | 2.127034 (inradius fejes toth) | 6.916% | - | - | best_known |
| 21 | 2.349279 | 0.4361536 | 2.174961 (inradius fejes toth) | 8.015% | - | - | best_known |
| 22 | 2.399464 | 0.4265696 | 2.221866 (inradius fejes toth) | 7.993% | - | - | best_known |
| 23 | 2.445827 | 0.4180922 | 2.267812 (inradius fejes toth) | 7.850% | - | - | best_known |
| 24 | 2.455136 | 0.4164317 | 2.362755 (inradius tammes) | 3.910% | - | - | best_known |
| 25 | 2.558073 | 0.3989324 | 2.357043 (inradius fejes toth) | 8.529% | - | - | best_known |
| 26 | 2.586795 | 0.3943152 | 2.400426 (inradius fejes toth) | 7.764% | - | - | best_known |
| 27 | 2.616551 | 0.3896458 | 2.443044 (inradius fejes toth) | 7.102% | - | - | best_known |
| 28 | 2.691252 | 0.3784068 | 2.484936 (inradius fejes toth) | 8.303% | - | - | best_known |
| 29 | 2.731462 | 0.3726268 | 2.526138 (inradius fejes toth) | 8.128% | - | - | best_known |
| 30 | 2.746907 | 0.3704542 | 2.566682 (inradius fejes toth) | 7.022% | - | - | best_known |

#### octagons (N = 8)

| P | rho (certified, 6 decimals) | circumradius R (rad) | lower bound (kind) | gap to bound | dOSV 2026 R (truncated) | vs dOSV | status |
|---|---|---|---|---|---|---|---|
| 2 | 1.273240 | 1.5707963 | 1.273240 (existence) | 0.000% | - | - | best_known |
| 3 | 1.451710 | 1.0807855 | 1.451710 (inradius fejes toth) | 0.000% | - | - | best_known |
| 4 | 1.543761 | 0.9820374 | 1.533142 (inradius fejes toth) | 0.693% | - | - | best_known |
| 5 | 1.754853 | 0.8249437 | 1.754853 (inradius tammes) | 0.000% | - | - | best_known |
| 6 | 1.754853 | 0.8249437 | 1.754853 (inradius fejes toth) | 0.000% | - | - | best_known |
| 7 | 1.988539 | 0.7077755 | 1.963440 (inradius tammes) | 1.278% | - | - | best_known |
| 8 | 2.059035 | 0.6794088 | 2.027360 (inradius tammes) | 1.562% | - | - | best_known |
| 9 | 2.164254 | 0.6414345 | 2.130038 (inradius tammes) | 1.606% | - | - | best_known |
| 10 | 2.267316 | 0.6084548 | 2.249154 (inradius tammes) | 0.808% | - | - | best_known |
| 11 | 2.381074 | 0.5760367 | 2.331900 (inradius tammes) | 2.109% | - | - | best_known |
| 12 | 2.385526 | 0.5748429 | 2.331900 (inradius fejes toth) | 2.300% | - | - | best_known |

## 9. Observations

- **Disks.** The seeded search reproduces every value of Cohn's table for P = 2–40 to within its 12-decimal rounding (largest relative difference 2.7·10⁻¹²; ours lie below because the table rounds cosines up), after warm starts from the published coordinates for P = 21 and 35 [CALC]. The Fejes Tóth bound is attained at P = 3, 4, 6, 12, as it must be.
- **Inscribed-disk bound attained** [CALC from EST]: squares P = 3 and 5, pentagons P = 11, hexagons P = 3, 4, 5 and octagons P = 3, 5, 6 meet the bound from their inscribed disks to 10⁻⁹ or better, i.e. the inscribed disks form an optimal Tammes code (θ_3 = 120°, θ_4 = arccos(−1/3), θ_5 = 90°, θ_6 = 90°, θ_11 = θ_12 = 63.43°, all proven) and the corners never collide. These are therefore optimal by a short argument from published theorems, but they stay `best_known` with a note, per the proven-claims policy.
- **Plateaus** [CALC, best found]: ρ(3 triangles) = ρ(4) (tetrahedral size), ρ(7 triangles) = ρ(8) = 2/π, ρ(5 squares) = ρ(6) (cube faces), ρ(11 pentagons) = ρ(12) (dodecahedron faces), ρ(5 octagons) = ρ(6 octagons). dOSV 2026 report the same plateau for 5 squares and 11 pentagons. Five triangles reach circumradius exactly π/3 to 12 digits.
- **Against de Oliveira Filho–Spomer–Vallentin 2026** (triangles 8–24, squares 3–24, pentagons 3–24; their values are truncated to 6 decimals): of 61 comparable entries, 40 of ours have a circumradius larger than the printed value by more than 10⁻⁵ (non-trivial gains), 1 is the classical icosahedral tiling, 18 agree within 10⁻⁵ (presumably the same configurations), and 2 are smaller (squares 16, 23), by 0.05–0.13 % in ρ. The largest differences are for triangles (P = 12, 22, 23, 24: circumradius larger by 1.3–2.5 %). Their n = 20 triangle row prints circumradius 0.651805 (†), below the icosahedral tiling's 0.652358. It is not a typo: its printed volume bound 20.03839317 equals 4π/area at R ∈ [0.651805, 0.651806) (4π/area = 20.038426 and 20.038356 at the two ends) [CALC]; the paper takes all lower bounds from manifold optimisation (except the tetrahedron-kissing and cube-tiling configurations) and does not list the icosahedral tiling for triangles. So their row is a weaker local optimum, and sphere/3/20 is classical, not a gain (verdict `tiling`). Nine of the gains are small (1.8·10⁻⁵ to 8.7·10⁻⁵ in R: triangles 9, 11; squares 7, 9, 14; pentagons 10, 18, 20, 24), probably refinements of the same configurations; squares 8, triangles 10 and pentagons 7, 17 are "same" but still strictly larger than the printed value plus its truncation (by 1.2·10⁻⁶ to 6.3·10⁻⁶ in R, i.e. 0.2·10⁻⁶ to 5.3·10⁻⁶ beyond it) [CALC]. All our "better" entries are certified, pass the TypeScript validator, and the clearest ones pass the sampling check (§3); none contradicts their maximality results (for every † or ⋆ row n, our P = n + 1 circumradius is below theirs for n). These comparisons are against a table, not against their configuration database (Harvard Dataverse, doi:10.7910/DVN/PNH45K; its configurations are licensed CC BY-NC-SA 4.0 and were deliberately not downloaded or used as starts), and deserve an independent review before anyone calls them improvements.
- **Hexagons and octagons**: no literature values were found; best-found values only. For P ≥ 15 hexagons the gap to the (weak) inscribed-disk bound is mostly 7–8.5 % (3.9 % at P = 24, where the proven θ_24 enters).

## 10. Limitations and open questions

- Search budget is small: 40 s per polygon problem (6 starts plus basin hopping), plus 75–90 s second and third passes (seeds 2–4, warm-started) only for the cases that were behind dOSV after the first pass. Two entries are still behind dOSV (listed above) after the re-run (§7). Apart from the six re-run problems listed in §7, hexagons, octagons and P = 25–30 had only the first pass.
- Rigorous lower bounds are elementary (existence, area, Fejes Tóth, inscribed disks); gaps of 2–9 % remain for most polygon entries. The dOSV maximality bounds that would tighten squares P = 8–11 and pentagons P = 6, 8 are float-computed in the source and kept only as `bound_published`. LP/SDP bounds (Delsarte–Goethals–Seidel, Bachoc–Vallentin 3-point, dOSV's ϑ′ as a function of the radius) would tighten them and are not implemented.
- Literature comparisons for polygons depend on a table truncated at 6 decimals; "same" means within 10⁻⁵ in circumradius. Tarnai & Gáspár (2001) were not consulted directly.
- `proven` is used only for disks (P = 2–14 and 24) where a published proof exists and our value matches within the certification gap. P = 15 is marked optimal in Cohn's table on the strength of a 2026 preprint; it stays `best_known`. Tilings, P = 2 limits and the inscribed-disk cases are optimal by PolyPack's own short arguments and stay `best_known` with notes.
- Polygon P = 2 is an infimum that is not attained; the record certifies the antipodal pair at ρ = N/(2π)(1 + 10⁻¹¹). P = 1 is not stored (polygons: the same infimum N/(2π); a single disk: ρ = 1/π, the cap that covers the sphere).
- The max-margin brute force costs O(N³) per near pair; fine for N ≤ 8 and P ≤ 40, not for large P.
- The TypeScript validator is a float check (not authoritative); its strict decisions can be wrong for |gap| below about 10⁻¹¹ within about 10⁻⁷ relative of the existence limit (§3).
- The (x, y, θ) pose of the curved package is singular at the south pole, so records store quaternions; the conversion helpers are given in the package.
- Disks beyond P = 40: use Cohn's table (spherical-codes.org) rather than this search.

## 11. Files and commands

- `packages/sphere/src/`: `geometry.ts` (piece measures, quaternions, pose conversions), `validate.ts` (chart-free max-margin validator), `index.ts`; `test/sphere.test.ts`; `scripts/build-viz.ts`; `viz/template.html`, generated `viz/index.html` (standalone, data embedded).
- `python/sphere/`: `sgeom.py` (float geometry), `search.py` (seeded search), `certify.py` (rigorous certifier), `bounds.py` (rigorous lower bounds), `rig.py` (loads `python/curved/rigorous.py` read-only), `exact.py` (Platonic tilings), `finalize.py` (records and certification), `report_tables.py`, `sample_check.py` (independent point-sampling check, numpy), `test_certify.py`, `fixtures/` (command-line regressions from the independent review, see `fixtures/NOTE.txt`).
- `data/sphere/`: `records.json`, `certification.json`, `literature.json` (parsed Cohn table rows and dOSV Table 2 with sources and access date).

```
npx tsc -p packages/sphere --noEmit
npx vitest run packages/sphere
python3 python/sphere/test_certify.py
python3 python/sphere/certify.py data/sphere/records.json --out data/sphere/certification.json
python3 python/sphere/search.py --N 0 --P 3-40 --seed 1 --starts 8 --hops 40 --time 120 --out RUNS/disks
python3 python/sphere/search.py --N 4 --P 3-24 --seed 1 --starts 6 --hops 60 --time 40 --codes RUNS/disks --out RUNS/poly
python3 python/sphere/exact.py --out RUNS/exact
python3 python/sphere/search.py --N 4 --P 14 --seed 2 --starts 4 --hops 200 --time 75 --warm RUNS/poly --codes RUNS/disks --out RUNS/poly2
python3 python/sphere/finalize.py --runs RUNS/disks RUNS/disks_warm RUNS/poly RUNS/poly2 RUNS/poly3 RUNS/poly4 RUNS/exact --out data/sphere
python3 python/sphere/sample_check.py data/sphere/records.json sphere/3/12,sphere/3/22
python3 python/sphere/report_tables.py data/sphere/records.json [--summary]
npx tsx packages/sphere/scripts/build-viz.ts
```

All compute ran at `nice -n 10` with single-threaded BLAS (one process, two in the last passes). Raw runs and logs are kept outside the repository (`sphere/runs/`: disks, disks_warm, poly, poly2–4, exact).
