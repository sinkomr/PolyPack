# PolyPack pieces on flat tori

**Summary** (2026-10-24). `data/torus/records.json` holds 544 records, each proven valid by an interval-arithmetic certificate (`data/torus/certificates/`, checker `python/torus/certify_torus.py`). There are 336 records for P = 1–16 in each of the three torus families (square `sq`, hexagonal `hex`, free lattice `free`) and the seven shapes N = 0 (disk) and N = 3–8. Another 208 are exact constructions for P = 17–49 where a bound is attained. Every certified score exceeds its search value by at most 1.0003e-12 relative (shrink ε = 1e-12).

- **Equal to a lower bound.** 125 of the 336 records equal a lower bound to 1e-12 [CALC]; P = 1 on `hex` for squares, pentagons, heptagons and octagons is within 1e-9 of a rigorous computer-assisted bound.
- **Published results.** Every disk result on the square torus matches the published optimum (P ≤ 8, proven) or best-known value (P = 9–16). The exception is P = 13, which improves on the published table: density 0.789924 against 0.788 [CALC, certified]. Squares on the square torus match all of Blair–Santangelo–Machta's values for P ≤ 16. Disks on the hexagonal torus match Thue's bound, the published optima and the Density Gap Conjecture values.
- **Free lattice.** The free-lattice P = 1 entries equal the known densest lattice packings. Pentagons with even P reach the proven (preprint) optimum (5 − √5)/3, heptagons with even P the best-known double lattice 0.8926906861, and octagons with every P the proven optimum (4 + 4√2)/(5 + 4√2).
- **Status.** Nothing is marked `proven`; see §7 for the entries a published proof covers.

## 1. Problem

**Pieces.** P congruent PolyPack pieces, with the conventions of `PROMPT.md` §2: N = 0 is a closed disk of radius 1; N ≥ 3 is a regular N-gon of side 1 with pose (x, y, θ), circumradius R = 1/(2 sin(π/N)), and vertex k at (x, y) + R (cos a_k, sin a_k), a_k = θ + π/2 + 2πk/N. At θ = 0 a vertex points up.

**Space.** A flat torus R²/Λ with Λ = Z b1 + Z b2. Three families:

| family | lattice | score |
|---|---|---|
| `sq` | b1 = L (1, 0), b2 = L (0, 1) | L |
| `hex` | b1 = L (1, 0), b2 = L (1/2, √3/2) | L |
| `free` | any basis (part of the solution) | √(cell area) = √\|det(b1, b2)\| |

Problem id: `torus/<family>/<N>/<P>`, for example `torus/hex/0/7`. Smaller scores are better. For `free` the records also give the density P · A_piece / cell area; minimising the score is maximising this density, so `free` asks for the densest periodic packing with P pieces per fundamental cell.

**Validity.** The interiors of all pieces and of all their lattice translates are pairwise disjoint: for all pieces i, j and lattice vectors λ with (i, λ) ≠ (j, 0), int(K_i) ∩ int(K_j + λ) = ∅. This includes a piece and its own nonzero translates, which matters when the torus is small (one disk on the square torus needs L ≥ 2). Touching is allowed.

**Simple relations** [CALC]:

- A packing on R²/Λ lifts to a Λ-periodic packing of the plane with the same density, so every density bound for packings of congruent copies in the plane bounds the torus problems.
- `sq` and `hex` packings are `free` packings with cell area L² and (√3/2) L², so score_free(N, P) ≤ score_sq(N, P) and score_free(N, P) ≤ (3/4)^{1/4} score_hex(N, P).
- Deleting a piece keeps a packing valid, so each score is non-decreasing in P.
- A q-piece packing on Λ repeated over the cosets of a sublattice Λ' ⊂ Λ of index k is a qk-piece packing on Λ' with the same density. For `free` every index occurs; for `sq` the square sublattices have index a² + b² (Λ' spanned by (a, b) and (−b, a)); for `hex` the hexagonal sublattices have index a² + ab + b².

## 2. Which lattice vectors matter

Let K_i lie in the closed disk B(c_i, R) about its centre (R = circumradius, 1 for disks). If |c_j + λ − c_i| ≥ 2R the open disks are disjoint, hence so are the interiors of K_i and K_j + λ; if the distance is > 2R even the closed pieces are disjoint. So only

  v = c_j − c_i + λ with |v| < 2R

can produce an overlap. **Lemma (enumeration window)** [CALC]. Write v = α b1 + β b2. By Cramer's rule α = det(v, b2)/det(b1, b2) and β = det(b1, v)/det(b1, b2), and |det(x, y)| ≤ |x| |y|, so

  |α| ≤ |v| |b2| / |det|,  |β| ≤ |v| |b1| / |det|.

With α₀, β₀ the coordinates of c_j − c_i and λ = m b1 + n b2, every λ that can matter satisfies

  |α₀ + m| < X1 = 2R |b2| / |det|,  |β₀ + n| < X2 = 2R |b1| / |det|.

This is a finite box of integers, valid for **any** basis. A Lagrange–Gauss reduced basis (|b1| ≤ |b2|, |b1·b2| ≤ |b1|²/2, angle in [60°, 120°]) has |b1| |b2| ≤ (2/√3) |det|, so the box is small; with a reduced basis and centres reduced into the fundamental cell, the relevant λ satisfy |λ| < 2R + |b1| + |b2|. The validator and the certifier both enumerate the box (with one extra integer on each side, and with interval endpoints in the certifier), so neither relies on a reduced basis; tests use bases such as b2 = (2500.3, 1.9) whose short vector b2 − 1000 b1 is far from the given basis. For i = j only λ ≠ 0 in the half plane m > 0 or (m = 0, n > 0) is checked, because λ and −λ give the same pair.

## 3. Certificates

**Shrink argument** [CALC]. Store a configuration (lattice Λ, poses) at score s_float. Shrink every piece by the factor 1 − ε about its own centre. If every image pair of shrunk pieces is *strictly* separated, then for every k ≥ 1/(1 − ε) the map x ↦ kx sends the shrunk pieces to full-size pieces about the centres k c_i (the shrunk piece c + (1/k)(K − c) is contained in c + (1 − ε)(K − c), because K is convex and contains its centre) and Λ to kΛ. Scaling is a similarity of the plane, so the image is a valid packing on R²/kΛ, whose score is k s_float. Hence every score ≥ s_float / (1 − ε) is attained, and `score_cert` is the smallest double above the interval upper bound of s_float / (1 − ε). The packing at `score_cert` is the stored configuration scaled about the origin by score_cert / score_float.

**Interval proof** (`python/torus/certify_torus.py`, standard library + mpmath, 128-bit intervals with outward rounding; independent of the search and of the TypeScript validator). For each pair i ≤ j it computes α₀, β₀, X1, X2 as intervals, enumerates the integer box from rigorous endpoints, and for each λ:

1. if the interval lower bound of |v|² exceeds the upper bound of (2(1 − ε)R)², the bounding disks of the shrunk pieces are strictly disjoint (disks need nothing else);
2. otherwise (polygons) it looks for a separating axis among the 2N edge normals of the two shrunk polygons, computed from interval vertices: with p the start of the owner's edge k and n its outward normal, it proves min over the other polygon's vertices of (w − p)·n > max over the owner's vertices of (w − p)·n. A line strictly between the two vertex sets separates their convex hulls. Floats are used only to choose which axis to try first.

If any pair is not proven, the record is rejected. The certificate (`data/torus/certificates/<family>_<N>_<P>.json`) stores ε, the enumeration window, the number of image pairs settled by bounding disks, every polygon pair settled by an axis (piece indices, λ, axis owner and edge, clearance lower bound) and the overall minimum clearance. ε is the first value on the ladder 1e-12, 1e-11, 1e-10, 1e-9 that certifies with a proven clearance of at least 5e-14 (thinner proofs are valid, but too thin for the float re-check below), so score_cert exceeds score_float by about 1e-12 relative. Adversarial tests (`python/torus/test_certify_torus.py`, 38 tests) include overlaps of 1e-9 inside the cell, across the cell boundary and through a piece's own short translate, an unreduced basis whose overlap uses λ = (1000, −1), centres given far outside the cell, a 1e-9 overlap that a 1e-12 shrink must not clear, coincident pieces, a claimed score below the certified bound, NaN/inf/strings in every field, wrong P, bad N, ε ∉ (0, 1e-3], degenerate and nearly degenerate bases, and a randomised comparison with exact rational arithmetic for disks.

**Independent review** (2026-10-24; a separate reviewer with its own 70-digit checker, which computes the critical shrink of every image pair exactly; reproduced results): 2,951 random configurations and 34,073 certifier calls with ε within a few ulps of each configuration's critical value, skewed, rotated and lattice-shifted bases, θ up to 1e4, N up to 12: no invalid configuration accepted, no valid one rejected; all 1,390 lattice vectors with |v| < 2sR in 140 skewed cases were visited by the enumeration; every score claim one double below the bound was refused. The review found no soundness issue. It found crashes outside `CertError` (|θ| ≥ 1e16, integers beyond the double range), a misleading message for very large P, a precision side effect and a possibly non-positive reported clearance; all are fixed, with regression tests.

**Float validator** (`packages/torus`, TypeScript). `validateTorusPacking` uses the shared PolyPack kernel (`pieceSeparation` from `@polypack/geometry`) on every image pair from the same enumeration lemma and reports overlaps, contacts, the minimum separation, score and density. Its tests (`packages/torus/test/torus.test.ts`) cover the same adversarial cases plus property tests (moving a piece by a lattice vector and changing the basis leave the result unchanged; scaling up keeps validity; the number of image pairs checked equals a brute force over a large box; the enumeration equals a brute force for random skewed bases). `packages/torus/test/records.test.ts` re-checks every record in floats: the stored configuration, the shrunk configuration (strictly), and the configuration scaled to `score_cert`.

## 4. Search

`python/torus/torus_search.py` (numpy/scipy; seeded; not a proof). Local solver: sequential linear programming in the spirit of Torquato and Jiao's adaptive shrinking cell [EST: S. Torquato and Y. Jiao, *Phys. Rev. E* 80, 041104 (2009), arXiv:0909.0940; the LP form in *Phys. Rev. E* 82, 061302 (2010), arXiv:1008.2747; both verified 2026-10-24]. Variables are the fractional centres u_i (x_i = B u_i), the angles θ_i and the lattice parameters (L for `sq`/`hex`; an upper-triangular basis (a, b; 0, c) for `free`, with the rotation gauge fixed by b1 ∥ x). Each step linearises every near contact (disks: centre distance; polygons: for the best SAT axis, one row per vertex of the other polygon within a window of the minimum), minimises L or the cell area inside a trust box, and accepts by a merit ratio test (score + 3·score·overlap); the box grows on good steps and shrinks on poor ones. For `free` the basis is Gauss-reduced after every step. Exploration stops at a box of 1e-5, the final polish at 1e-11; the result typically overlaps by at most 1e-15.

Starts, per (family, N, P): translative lattice packings on every superlattice of index P of the family lattice (Hermite normal forms; the best piece angle is found from the gauge of the difference body K − K), replications of smaller solutions over sublattices (same density), a double-lattice start (two orientations θ and θ + π on a superlattice of index P/2), the P − 1 solution plus one piece in its largest sampled hole, random sequential addition at density 0.25, and, for `sq`/`hex`, the `free` solution deformed to the target cell. Then basin hopping on the pool of the 8 best (expand 2–8 % and jitter; re-place up to P/3 pieces; turn one polygon by up to π/N; shear the free cell). Budget per problem (deterministic counts): s (6 + P) random starts and s (12 + 5P) hops with scale s; a search stops early when it reaches a density bound (π/√12 for disks, (5 − √5)/3 for pentagons, 1 otherwise), because no packing can do better.

The run of 2026-10-24 (00:59–03:09, at most 2 processes, `nice -n 10`, seed 20261024): phase A, `free` with s = 1.5 (the octagon job was stopped after P = 12 once Fejes Tóth's theorem, §6, made the lattice packing provably optimal; exact replications supply every octagon entry); phase B, `sq` and `hex` with s = 0.6, seeded with the deformed `free` solutions; phase S, structured seeds only for `sq` and `hex` (seed + 11), after a bug fix: the first superlattice enumeration used column-style Hermite forms, which list sublattices, and so missed most superlattices (all but two for prime P); phase C, `free` for N = 3, 5, 7 with s = 0.3 (seed + 7), seeded with the `sq` and `hex` solutions; finally `polish_raw.py` (SLP from every stored result with a box down to 1e-12, keeping improvements, which were at most a few 1e-9 relative). Each raw result records its label, seed, budget and how it stopped. scipy 1.7's HiGHS occasionally aborts the process or stalls on these degenerate LPs, so each local solve runs in a forked child with a 90 s limit and each LP has a 2 s limit; a failed solve is dropped (counts are in the raw results).

`python/torus/build_records.py` then takes, for each problem, the best of: the search result; for `free`, the `sq` and `hex` results read as free lattices; the P + 1 result with one piece deleted; and exact replications from `python/torus/extend_torus.py`. It certifies the winner and writes `data/torus/records.json`.

## 5. Results

Display values are `score_cert` rounded up at 6 decimals, so an exact value such as 2 shows as 2.000001. Where the score equals a bound, the record also has `exact` (for example `sqrt(5)` or `sqrt(7 * 2 sqrt(3))`). Densities are P · A_piece / cell area. The lower bound kept in each record is the best of these:

- the area bound;
- a density bound for congruent copies in the plane: π/√12 for disks, (5 − √5)/3 for pentagons, (4 + 4√2)/(5 + 4√2) for octagons (§6);
- a published proven optimum: disks on the square torus, P ≤ 8;
- for P = 1 on `sq`/`hex`, a rigorous interval branch and bound over the piece angle (`python/torus/p1_bound.py`; [CALC], computer-assisted, not published). It brackets every P = 1 polygon value to within 1e-9.

### Square torus (score L)

Certified score (rounded up), with density below. **Bold**: equal to the lower bound in the record (to 1e-12 relative).

| P | disks | triangles | squares | pentagons | hexagons | heptagons | octagons |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **2.000001**<br>0.7854 | **0.896576**<br>0.5387 | **1.000001**<br>1.0000 | **1.558024**<br>0.7088 | **1.793151**<br>0.8080 | **2.204505**<br>0.7477 | **2.414214**<br>0.8284 |
| 2 | **2.828428**<br>0.7854 | 0.954748<br>0.9501 | **1.414214**<br>1.0000 | 2.120995<br>0.7649 | 2.535899<br>0.8080 | 3.017103<br>0.7984 | 3.414214<br>0.8284 |
| 3 | **3.863704**<br>0.6313 | 1.344864<br>0.7182 | 2.000001<br>0.7500 | 2.774480<br>0.6705 | 3.464102<br>0.6495 | 4.079906<br>0.6549 | 4.765891<br>0.6377 |
| 4 | **3.863704**<br>0.8418 | 1.350217<br>0.9501 | **2.000001**<br>1.0000 | 2.776419<br>0.8928 | 3.464102<br>0.8660 | 4.111522<br>0.8599 | 4.765891<br>0.8503 |
| 5 | **4.472136**<br>0.7854 | 1.692811<br>0.7555 | **2.236068**<br>1.0000 | 3.387249<br>0.7498 | 4.009608<br>0.8080 | 4.831474<br>0.7784 | 5.398346<br>0.8284 |
| 6 | **4.994936**<br>0.7555 | 1.793151<br>0.8080 | 2.683282<br>0.8333 | 3.503920<br>0.8408 | 4.437823<br>0.7915 | 5.325567<br>0.7688 | 6.161761<br>0.7630 |
| 7 | **5.464102**<br>0.7366 | 1.811734<br>0.9234 | 2.828428<br>0.8750 | 3.923707<br>0.7823 | 4.885777<br>0.7619 | 5.787544<br>0.7594 | 6.723128<br>0.7478 |
| 8 | **5.464102**<br>0.8418 | 1.872993<br>0.9875 | **2.828428**<br>1.0000 | 3.926449<br>0.8928 | 4.898980<br>0.8660 | 5.814571<br>0.8599 | 6.739987<br>0.8503 |
| 9 | 5.818626<br>0.8351 | 2.094070<br>0.8887 | **3.000001**<br>1.0000 | 4.309277<br>0.8338 | 5.196153<br>0.8660 | 6.263837<br>0.8336 | 7.135642<br>0.8535 |
| 10 | 6.324556<br>0.7854 | 2.134881<br>0.9501 | **3.162278**<br>1.0000 | 4.638836<br>0.7995 | 5.670442<br>0.8080 | 6.746448<br>0.7984 | 7.634414<br>0.8284 |
| 11 | 6.547758<br>0.8060 | 2.320509<br>0.8846 | 3.478506<br>0.9091 | 4.775184<br>0.8300 | 5.705772<br>0.8778 | 7.023959<br>0.8102 | 8.035534<br>0.8226 |
| 12 | 6.656403<br>0.8508 | 2.356352<br>0.9358 | 3.535534<br>0.9600 | 4.792445<br>0.8989 | 5.776590<br>0.9343 | 7.139950<br>0.8554 | 8.190704<br>0.8637 |
| 13 | 7.190417<br>0.7899 | 2.552559<br>0.8640 | **3.605552**<br>1.0000 | 5.224368<br>0.8195 | 6.276029<br>0.8575 | 7.702229<br>0.7963 | 8.704571<br>0.8284 |
| 14 | 7.241691<br>0.8387 | 2.562178<br>0.9234 | 3.882902<br>0.9286 | 5.320280<br>0.8510 | 6.276029<br>0.9234 | 7.827717<br>0.8303 | 8.949748<br>0.8439 |
| 15 | 7.276069<br>0.8901 | 2.621426<br>0.9452 | 4.000001<br>0.9375 | 5.388975<br>0.8886 | 6.302152<br>0.9812 | 7.881092<br>0.8776 | 8.997243<br>0.8947 |
| 16 | 7.727407<br>0.8418 | 2.648812<br>0.9875 | **4.000001**<br>1.0000 | 5.552837<br>0.8928 | 6.928204<br>0.8660 | 8.223044<br>0.8599 | 9.525484<br>0.8514 |

### Hexagonal torus (score L)

Certified score (rounded up), with density below. **Bold**: equal to the lower bound in the record (to 1e-12 relative).

| P | disks | triangles | squares | pentagons | hexagons | heptagons | octagons |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **2.000001**<br>0.9069 | **0.866026**<br>0.6667 | 1.154701<br>0.8660 | 1.573221<br>0.8027 | **1.732051**<br>1.0000 | 2.215388<br>0.8550 | 2.499378<br>0.8925 |
| 2 | **3.464102**<br>0.6046 | **1.000001**<br>1.0000 | 2.000001<br>0.5774 | 2.503614<br>0.6339 | 3.000001<br>0.6667 | 3.732274<br>0.6025 | 4.266705<br>0.6125 |
| 3 | **3.464102**<br>0.9069 | 1.401259<br>0.7639 | 2.000001<br>0.8660 | 2.616619<br>0.8705 | **3.000001**<br>1.0000 | 3.780347<br>0.8809 | 4.329050<br>0.8925 |
| 4 | **4.000001**<br>0.9069 | 1.599948<br>0.7813 | 2.309402<br>0.8660 | 3.013138<br>0.8753 | **3.464102**<br>1.0000 | 4.368224<br>0.8796 | 4.998756<br>0.8925 |
| 5 | 5.048676<br>0.7116 | 1.700841<br>0.8642 | 2.886752<br>0.6928 | 3.745645<br>0.7080 | 4.493572<br>0.7429 | 5.395121<br>0.7208 | 6.246890<br>0.7144 |
| 6 | **5.291503**<br>0.7773 | **1.732051**<br>1.0000 | 3.000001<br>0.7698 | 3.907093<br>0.7808 | 4.582576<br>0.8571 | 5.747856<br>0.7620 | 6.556230<br>0.7782 |
| 7 | **5.291503**<br>0.9069 | 1.963962<br>0.9074 | 3.000001<br>0.8981 | 3.963369<br>0.8853 | **4.582576**<br>1.0000 | 5.778922<br>0.8795 | 6.612733<br>0.8925 |
| 8 | 6.000001<br>0.8061 | **2.000001**<br>1.0000 | 3.055051<br>0.9897 | 4.416366<br>0.8149 | 5.196153<br>0.8889 | 6.434735<br>0.8107 | 7.318687<br>0.8327 |
| 9 | **6.000001**<br>0.9069 | 2.236068<br>0.9000 | 3.401681<br>0.8981 | 4.502288<br>0.8821 | **5.196153**<br>1.0000 | 6.544421<br>0.8817 | 7.498134<br>0.8925 |
| 10 | 6.854069<br>0.7722 | 2.415329<br>0.8571 | 3.779645<br>0.8083 | 4.917678<br>0.8215 | 6.000001<br>0.8333 | 7.310701<br>0.7851 | 8.485114<br>0.7744 |
| 11 | 6.928204<br>0.8313 | 2.500001<br>0.8800 | 4.000001<br>0.7939 | 5.146917<br>0.8249 | 6.000001<br>0.9167 | 7.539097<br>0.8121 | 8.642668<br>0.8211 |
| 12 | **6.928204**<br>0.9069 | 2.596953<br>0.8897 | 4.000001<br>0.8660 | 5.192396<br>0.8842 | **6.000001**<br>1.0000 | 7.557439<br>0.8816 | 8.658099<br>0.8925 |
| 13 | **7.211103**<br>0.9069 | 2.598077<br>0.9630 | 4.041452<br>0.9190 | 5.410898<br>0.8821 | **6.244998**<br>1.0000 | 7.862185<br>0.8825 | 9.011635<br>0.8925 |
| 14 | 7.935884<br>0.8064 | **2.645752**<br>1.0000 | 4.041452<br>0.9897 | 5.750558<br>0.8411 | 6.928204<br>0.8750 | 8.474116<br>0.8181 | 9.728317<br>0.8248 |
| 15 | 8.000001<br>0.8502 | 2.882307<br>0.9028 | 4.163332<br>0.9993 | 5.912064<br>0.8526 | 6.928204<br>0.9375 | 8.707971<br>0.8300 | 9.991605<br>0.8377 |
| 16 | **8.000001**<br>0.9069 | 2.945942<br>0.9218 | 4.437602<br>0.9382 | 5.912064<br>0.9094 | **6.928204**<br>1.0000 | 8.723435<br>0.8822 | 9.997512<br>0.8925 |

### Free lattice (score sqrt(cell area))

Certified score (rounded up), with density below. **Bold**: equal to the lower bound in the record (to 1e-12 relative).

| P | disks | triangles | squares | pentagons | hexagons | heptagons | octagons |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **1.861210**<br>0.9069 | 0.805928<br>0.6667 | **1.000001**<br>1.0000 | 1.450927<br>0.8173 | **1.611855**<br>1.0000 | 2.055369<br>0.8602 | **2.308339**<br>0.9062 |
| 2 | **2.632149**<br>0.9069 | **0.930605**<br>1.0000 | **1.414214**<br>1.0000 | **1.932576**<br>0.9213 | **2.279508**<br>1.0000 | 2.853329<br>0.8927 | **3.264484**<br>0.9062 |
| 3 | **3.223710**<br>0.9069 | 1.231075<br>0.8571 | **1.732051**<br>1.0000 | 2.416617<br>0.8838 | **2.791815**<br>1.0000 | 3.516536<br>0.8816 | **3.998160**<br>0.9062 |
| 4 | **3.722420**<br>0.9069 | **1.316075**<br>1.0000 | **2.000001**<br>1.0000 | **2.733075**<br>0.9213 | **3.223710**<br>1.0000 | 4.035216<br>0.8927 | **4.616678**<br>0.9062 |
| 5 | **4.161792**<br>0.9069 | 1.543234<br>0.9091 | **2.236068**<br>1.0000 | 3.094331<br>0.8984 | **3.604218**<br>1.0000 | 4.528522<br>0.8860 | **5.161603**<br>0.9062 |
| 6 | **4.559015**<br>0.9069 | **1.611855**<br>1.0000 | **2.449490**<br>1.0000 | **3.347319**<br>0.9213 | **3.948223**<br>1.0000 | 4.942110<br>0.8927 | **5.654252**<br>0.9062 |
| 7 | **4.924299**<br>0.9069 | 1.802109<br>0.9333 | **2.645752**<br>1.0000 | 3.657910<br>0.9001 | **4.264568**<br>1.0000 | 5.364265<br>0.8840 | **6.107290**<br>0.9062 |
| 8 | **5.264297**<br>0.9069 | **1.861210**<br>1.0000 | **2.828428**<br>1.0000 | **3.865151**<br>0.9213 | **4.559015**<br>1.0000 | 5.706657<br>0.8927 | **6.528968**<br>0.9062 |
| 9 | **5.583630**<br>0.9069 | 2.028207<br>0.9474 | **3.000001**<br>1.0000 | 4.139026<br>0.9038 | **4.835565**<br>1.0000 | 6.075993<br>0.8859 | **6.925016**<br>0.9062 |
| 10 | **5.885662**<br>0.9069 | **2.080896**<br>1.0000 | **3.162278**<br>1.0000 | **4.321370**<br>0.9213 | **5.097133**<br>1.0000 | 6.380236<br>0.8927 | **7.299608**<br>0.9062 |
| 11 | **6.172935**<br>0.9069 | 2.231513<br>0.9565 | **3.316625**<br>1.0000 | 4.558446<br>0.9108 | **5.345918**<br>1.0000 | 6.712678<br>0.8871 | **7.655894**<br>0.9062 |
| 12 | **6.447420**<br>0.9069 | **2.279508**<br>1.0000 | **3.464102**<br>1.0000 | **4.733824**<br>0.9213 | **5.583630**<br>1.0000 | 6.989199<br>0.8927 | **7.996320**<br>0.9062 |
| 13 | **6.710688**<br>0.9069 | 2.417783<br>0.9630 | **3.605552**<br>1.0000 | 4.951189<br>0.9124 | **5.811626**<br>1.0000 | 7.293997<br>0.8879 | **8.322834**<br>0.9062 |
| 14 | **6.964010**<br>0.9069 | **2.462150**<br>1.0000 | **3.741658**<br>1.0000 | **5.113114**<br>0.9213 | **6.031009**<br>1.0000 | 7.549197<br>0.8927 | **8.637013**<br>0.9062 |
| 15 | **7.208435**<br>0.9069 | 2.590695<br>0.9677 | **3.872984**<br>1.0000 | 5.314991<br>0.9136 | **6.242688**<br>1.0000 | 7.832289<br>0.8886 | **8.940157**<br>0.9062 |
| 16 | **7.444839**<br>0.9069 | **2.632149**<br>1.0000 | **4.000001**<br>1.0000 | **5.466149**<br>0.9213 | **6.447420**<br>1.0000 | 8.070431<br>0.8927 | **9.233355**<br>0.9062 |

**Beyond P = 16** (exact replications, `extend_torus.py`; every one attains its bound):

- `free` disks, squares, hexagons and octagons: all P ≤ 49;
- `free` triangles and pentagons: even P ≤ 48;
- `sq` squares: P a sum of two squares;
- `hex` disks and hexagons: P = a² + ab + b²;
- `hex` triangles: P = 2(a² + ab + b²).

Heptagon double lattices replicate to even P ≤ 16 only.

### Free-lattice densities against the densest known packings

| shape | P = 1 (densest lattice) | best in our table | densest known packing in the plane |
|---|---|---|---|
| disk | 0.906900 (π/√12) | 0.906900, every P | π/√12, proven (Thue) |
| triangle | 0.666667 (2/3) | 1 for even P (tiling) | 1 (tiling) |
| square, hexagon | 1 | 1, every P | 1 (tiling) |
| pentagon | 0.817256 | 0.921311 for even P | (5 − √5)/3 = 0.921311, proven in a preprint (Hales–Kusner) |
| heptagon | 0.860191 | 0.892691 for even P | 0.8926906861 double lattice, best known (Kuperbergs) |
| octagon | 0.906164 | 0.906164, every P | (4 + 4√2)/(5 + 4√2) = 0.906164, proven (Fejes Tóth) |

[CALC] Odd P cannot use a double lattice:

- **Triangles.** Our odd-P values are exactly 2P/(2P + 1) for P = 1, 3, …, 15 (6/7, 10/11, …, 30/31): P triangles and one triangle-sized hole per cell. [SPEC] We conjecture that this is optimal for odd P.
- **Pentagons.** Odd-P values rise from 0.8838 (P = 3) to 0.9136 (P = 15).
- **Heptagons.** Odd-P values lie between 0.8816 and 0.8886.

### Comparison with the literature

| problem | ours (score_float) | literature | status | ours - literature | source |
|---|---:|---:|---|---:|---|
| torus/sq/0/2 | 2.828427125 | 2.828427125 | proven | -4.44e-16 | Dickinson et al. 2011; Brandt et al. 2019; L = 2 sqrt2 |
| torus/sq/0/3 | 3.863703305 | 3.863703305 | proven | 4.44e-16 | Dickinson et al. 2011; Brandt et al. 2019; d = (sqrt6 - sqrt2)/2, L = sqrt6 + sqrt2 |
| torus/sq/0/4 | 3.863703305 | 3.863703305 | proven | 4.44e-16 | Dickinson et al. 2011; Brandt et al. 2019; d = (sqrt6 - sqrt2)/2, L = sqrt6 + sqrt2 |
| torus/sq/0/5 | 4.472135955 | 4.472135955 | proven | 0.00e+00 | Dickinson et al. 2011; d = 1/sqrt5, L = 2 sqrt5 |
| torus/sq/0/6 | 4.994935777 | 4.994935777 | proven | -1.78e-15 | Musin and Nikitenko 2016, Thm 1; d = sqrt3/2 - sqrt2 sqrt(3 sqrt3 + 2)/6 + 1/6 |
| torus/sq/0/7 | 5.464101615 | 5.464101615 | proven | 0.00e+00 | Musin and Nikitenko 2016, Thm 2; d = 1/(1 + sqrt3); three optimal arrangements |
| torus/sq/0/8 | 5.464101615 | 5.464101615 | proven | 0.00e+00 | Musin and Nikitenko 2016, Thm 3; d = 1/(1 + sqrt3) |
| torus/sq/0/9 | 5.818625822 | 5.818625822 | conjecture | 0.00e+00 | Musin and Nikitenko 2016, Conjecture 2.1; d = 1/sqrt(5 + 2 sqrt3) |
| torus/sq/0/10 | 6.324555320 | 6.324555320 | best known | 0.00e+00 | Connelly et al. 2017; square grid, conjectured optimal; table bracket L in [6.3241, 6.3282] |
| torus/sq/0/11 | 6.547757332 | — | best known |  | Connelly et al. 2017; table bracket L in [6.5459, 6.5500] (r = 0.153, delta = 0.806) |
| torus/sq/0/12 | 6.656402355 | 6.656402355 | best known | 0.00e+00 | Connelly et al. 2017; Type I (a, b) = (3, 2): L = 24/sqrt13; table bracket [6.6539, 6.6578] |
| torus/sq/0/13 | 7.190416372 | — | best known |  | Connelly et al. 2017; table bracket L in [7.1969, 7.2015] (r = 0.139, delta = 0.788) |
| torus/sq/0/14 | 7.241690393 | — | best known |  | Connelly et al. 2017; table bracket L in [7.2382, 7.2425] (r = 0.138, delta = 0.839) |
| torus/sq/0/15 | 7.276068751 | 7.276068751 | best known | 8.88e-16 | Connelly et al. 2017; Type II (a, b) = (4, 1): L = 30/sqrt17; table bracket [7.2745, 7.2786] |
| torus/sq/0/16 | 7.727406610 | 7.727406610 | best known | 8.88e-16 | Connelly et al. 2017; table bracket [7.7241, 7.7287]; 2 x 2 copy of the P = 4 optimum gives 2 (sqrt6 + sqrt2) [SPEC identification] |
| torus/sq/4/1 | 1.000000000 | 1.000000000 | proven | 2.22e-16 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/sq/4/2 | 1.414213562 | 1.414213562 | proven | 0.00e+00 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/sq/4/3 | 2.000000000 | 2.000000000 | best known | -4.44e-16 | Blair et al. 2012; density 0.75 (2^2 - 1); conjectured optimal |
| torus/sq/4/4 | 2.000000000 | 2.000000000 | proven | -4.44e-16 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/sq/4/5 | 2.236067977 | 2.236067977 | proven | 4.44e-16 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/sq/4/6 | 2.683281573 | 2.683281573 | best known | 1.60e-14 | Blair et al. 2012; density 0.8333333333333334 (gapped bricklayer); conjectured optimal |
| torus/sq/4/7 | 2.828427125 | 2.828427125 | best known | 0.00e+00 | Blair et al. 2012; density 0.875 (2^2 + 2^2 - 1); conjectured optimal |
| torus/sq/4/8 | 2.828427125 | 2.828427125 | proven | 0.00e+00 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/sq/4/9 | 3.000000000 | 3.000000000 | proven | 0.00e+00 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/sq/4/10 | 3.162277660 | 3.162277660 | proven | -8.88e-16 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/sq/4/11 | 3.478505426 | 3.478505426 | best known | 1.33e-15 | Blair et al. 2012; density 0.9090909090909091 (gapped bricklayer); conjectured optimal |
| torus/sq/4/12 | 3.535533906 | 3.535533906 | best known | 4.59e-12 | Blair et al. 2012; density 0.96 (lattice of 1/2 x 1/2 holes); conjectured optimal |
| torus/sq/4/13 | 3.605551275 | 3.605551275 | proven | 4.44e-16 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/sq/4/14 | 3.882901374 | 3.882901374 | best known | 1.64e-14 | Blair et al. 2012; density 0.9285714285714286 (gapped bricklayer); conjectured optimal |
| torus/sq/4/15 | 4.000000000 | 4.000000000 | best known | 0.00e+00 | Blair et al. 2012; density 0.9375 (4^2 - 1); conjectured optimal |
| torus/sq/4/16 | 4.000000000 | 4.000000000 | proven | 0.00e+00 | Blair et al. 2012; density one (P is a sum of two squares) |
| torus/hex/0/1 | 2.000000000 | 2.000000000 | proven | 0.00e+00 | Thue; Connelly and Dickinson 2014, Thm 1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/2 | 3.464101615 | 3.464101615 | proven | 0.00e+00 | Brandt et al. 2019; Dickinson et al. 2011; L = 2 sqrt3 (3-point lattice minus one) |
| torus/hex/0/3 | 3.464101615 | 3.464101615 | proven | 0.00e+00 | Thue; Connelly and Dickinson 2014, Thm 1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/4 | 4.000000000 | 4.000000000 | proven | 0.00e+00 | Thue; Connelly and Dickinson 2014, Thm 1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/5 | 5.048675598 | — | proven |  | Dickinson et al. 2011 (J. Geom.); optimal packing proven there; value not seen (paper not opened) |
| torus/hex/0/6 | 5.291502622 | 5.291502622 | proven | 0.00e+00 | Dickinson et al. 2011 (J. Geom.); 7-point lattice minus one disk, L = 2 sqrt7 (as described by Connelly-Dickinson) |
| torus/hex/0/7 | 5.291502622 | 5.291502622 | proven | 0.00e+00 | Thue; Connelly and Dickinson 2014, Thm 1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/8 | 6.000000000 | 6.000000000 | conjecture | 0.00e+00 | Connelly and Dickinson 2014, Density Gap Conjecture 2; (P + 1)-lattice minus one disk |
| torus/hex/0/9 | 6.000000000 | 6.000000000 | proven | 0.00e+00 | Thue; Connelly and Dickinson 2014, Thm 1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/11 | 6.928203230 | 6.928203230 | conjecture | 0.00e+00 | Connelly and Dickinson 2014, Density Gap Conjecture 2; (P + 1)-lattice minus one disk |
| torus/hex/0/12 | 6.928203230 | 6.928203230 | proven | 0.00e+00 | Thue; Connelly and Dickinson 2014, Thm 1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/13 | 7.211102551 | 7.211102551 | proven | 8.88e-16 | Thue; Connelly and Dickinson 2014, Thm 1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/15 | 8.000000000 | 8.000000000 | conjecture | 0.00e+00 | Connelly and Dickinson 2014, Density Gap Conjecture 2; (P + 1)-lattice minus one disk |
| torus/hex/0/16 | 8.000000000 | 8.000000000 | proven | 0.00e+00 | Thue; Connelly and Dickinson 2014, Thm 1; triangular lattice, density pi/sqrt12 |
| torus/free/0/1 | 1.861209718 | 1.861209718 | proven | 0.00e+00 | Thue 1910; hexagonal lattice, density pi/sqrt12 |
| torus/free/3/1 | 0.805927449 | 0.805927449 | best known | -3.33e-16 | Torda et al. 2022 (p1); densest lattice packing, table density 0.66666; score from the [CALC] value 0.6666666666667 |
| torus/free/5/1 | 1.450926546 | 1.450926546 | best known | -3.82e-14 | Torda et al. 2022 (p1); densest lattice packing, table density 0.81725; score from the [CALC] value 0.8172560023684 |
| torus/free/5/2 | 1.932575335 | 1.932575335 | proven | 0.00e+00 | Kuperberg and Kuperberg 1990; Hales and Kusner 2016; pentagonal ice-ray double lattice, density (5 - sqrt5)/3; optimality: computer-assisted preprint proof |
| torus/free/7/1 | 2.055368878 | 2.055368878 | best known | 3.51e-14 | Torda et al. 2022 (p1); densest lattice packing, table density 0.86019; score from the [CALC] value 0.8601910243450 |
| torus/free/7/2 | 2.853328180 | 2.853328180 | best known | 8.88e-16 | Kuperberg and Kuperberg 1990; densest double lattice of the regular heptagon, density 0.8926906861 = (2/97)(-111 + 492 cos(pi/7) - 356 cos^2(pi/7)) (J. Baez, AMS Visual Insight 2014) |
| torus/free/8/1 | 2.308338607 | 2.308338607 | best known | 1.33e-15 | Torda et al. 2022 (p1); densest lattice packing, table density 0.90616; score from the [CALC] value 0.9061636786439 |
| torus/free/8/1 | 2.308338607 | 2.308338607 | proven | 1.33e-15 | L. Fejes Toth 1950; densest packing of congruent regular octagons is the lattice packing, density (4 + 4 sqrt2)/(5 + 4 sqrt2) |

Notes on the comparison:

- [CALC] **Disks on the square torus, P = 13.** Our certified packing has L ≤ 7.19041637230147, density 0.789924 and radius 0.139074 on the unit torus, with 26 contacts. Connelly–Funkhouser–Kuperberg–Solomonides (2017, table on p. 22) list δ = 0.788 and r = 0.139 for 13 disks, and offer their 10–16-disk packings as conjectured optimal. Our δ would print as 0.790, so the certified packing is denser than their table entry. That r column, rounded to 3 decimals, is consistent with both packings.
- **Disks, P = 11 and 14.** Our values lie inside the brackets implied by the same table.
- **Disks on the hexagonal torus, P = 5.** Our 5.0486756 equals an independent numerical maximisation run by the literature reviewer; the published optimum (Dickinson et al. 2011) was not opened.
- **New values.** P = 10 and 14 on the hexagonal torus have no published values that we found.
- **Squares on the square torus, P = 12.** Our float value is 4.6e-12 above 5/√2; the polish stopped there.


## 6. Literature (verified 2026-10-24) and what is proven

Values are converted to PolyPack units (disks of radius 1: L = 2/d for minimal distance d on the unit torus; squares of side 1: L = √(P/ρ) for density ρ).

- **Disks, square torus.** [EST] Optimal for P ≤ 5: W. Dickinson, D. Guillot, A. Keaton, S. Xhumari, *Beitr. Algebra Geom.* 52 (2011) 315–333 (values as given in Musin–Nikitenko, Fig. 2; the paper itself was not opened); P = 2–4 also on every flat torus: Brandt, Dickinson, Ellsworth, Kenkel, Smith, *Discrete Math.* 342 (2019) 111597, [arXiv:1708.05395](https://arxiv.org/abs/1708.05395). P = 6, 7, 8 proven by a computer-assisted proof: O. R. Musin, A. V. Nikitenko, *Discrete Comput. Geom.* 55 (2016) 1–20, [arXiv:1212.0649](https://arxiv.org/abs/1212.0649) (d₆ = √3/2 − √2 √(3√3 + 2)/6 + 1/6, d₇ = d₈ = 1/(1 + √3)); P = 9 conjectured there (d₉ = 1/√(5 + 2√3)). Best known for P = 10–16 (conjectures, radius given to 3 decimals): R. Connelly, M. Funkhouser, V. Kuperberg, E. Solomonides, *Discrete Comput. Geom.* 58 (2017) 614–642, [arXiv:1512.08762](https://arxiv.org/abs/1512.08762). B. D. Lubachevsky, R. L. Graham, F. H. Stillinger, *Period. Math. Hungar.* 34 (1997) 123–142 study thousands of disks and give no small-P table.
- **Disks, hexagonal torus.** [EST] Density π/√12 is attained iff P = a² + ab + b² (R. Connelly, W. Dickinson, *Phil. Trans. R. Soc. A* 372 (2014) 20120039, [arXiv:1201.5965](https://arxiv.org/abs/1201.5965), Theorem 1; the bound is Thue's theorem). Their Density Gap Conjecture: if P + 1 has that form and P does not, the optimum is the (P + 1)-point lattice minus one disk, L = 2√(P + 1). Optimal packings of 1–6 disks: Dickinson, Guillot, Keaton, Xhumari, *J. Geom.* 102 (2011) 27–51 (not opened; described by Connelly–Dickinson, §1.4).
- **Squares, square torus.** [EST] J. Blair, C. D. Santangelo, J. Machta, *J. Stat. Mech.* (2012) P01018, [arXiv:1110.5348](https://arxiv.org/abs/1110.5348): density 1 iff P is a sum of two squares (optimal by construction); all other entries of their Table I (P ≤ 27) are conjectures from simulated annealing (gapped bricklayer for P = 6, 11, 14; a lattice of ½ × ½ holes for P = 12 and 23; one 45° square for P = 21).
- **Densest lattice packings (free, P = 1).** [EST] M. Torda, J. Y. Goulermas, V. Kurlin, G. M. Day, *Phys. Rev. E* 106 (2022) 054603, [arXiv:2207.08959](https://arxiv.org/abs/2207.08959), Table I, plane group p1: triangle 0.66666, pentagon 0.81725, heptagon 0.86019, octagon 0.90616 (5 decimals). [CALC] `python/torus/lattice_density.py` (critical determinant of K − K) gives 2/3, 0.8172560024, 0.8601910243, 0.9061636786, equal to our P = 1 entries to 10 digits; the pentagon value equals 10/(10 + √5) to 3e-16 [SPEC closed form].
- **Centrally symmetric pieces.** [EST] L. Fejes Tóth (1950): for a centrally symmetric convex disk K the densest packing of congruent copies has the lattice density, δ(K) = δ_T(K) = δ_L(K) (G. Fejes Tóth, "Packing and covering", *Handbook of Discrete and Computational Geometry*, 3rd ed., ch. 2, p. 29, [preprint](http://www.csun.edu/~ctoth/Handbook/chap2.pdf)). For the regular octagon δ_L = (4 + 4√2)/(5 + 4√2) = 0.9061636786. So every `free` octagon entry built on the lattice packing is optimal, and the octagon bound applies to `sq` and `hex`. Disks: Thue's theorem δ = π/√12 (same chapter, Table 2.1.1).
- **Pentagons.** [EST] The pentagonal ice-ray double lattice has density (5 − √5)/3 (G. and W. Kuperberg, *Discrete Comput. Geom.* 5 (1990) 389–397, as quoted by Y. Kallus and W. Kusner, "The local optimality of the double lattice packing", *Discrete Comput. Geom.* 56 (2016) 449–471, [arXiv:1509.02241](https://arxiv.org/abs/1509.02241)). T. Hales and W. Kusner, [arXiv:1602.07220](https://arxiv.org/abs/1602.07220) v2, prove by computer that no packing of congruent regular pentagons is denser; no refereed publication was found, so this bound rests on a preprint.
- **Heptagons.** [EST] The best known packing is the Kuperbergs' double lattice, density 0.8926906861 = (2/97)(−111 + 492 cos(π/7) − 356 cos²(π/7)) (J. Baez, AMS Visual Insight, 15 Nov 2014); no sharp upper bound is proven (Kallus–Kusner).
- **Search method.** [EST] Torquato and Jiao's adaptive shrinking cell and its LP form (references in §4).


## 7. Entries a published proof covers (status left `best_known`)

These are [EST] facts with the sources in §6; whether to mark any of them `proven` is the maintainer's decision.

- `sq/0/P`, P = 1–8: P = 1 trivial; P = 2–5 Dickinson et al. 2011 (P = 2–4 also Brandt et al. 2019); P = 6–8 Musin–Nikitenko 2016.
- `hex/0/P` for P = a² + ab + b² (1, 3, 4, 7, 9, 12, 13, 16, and the extensions): Thue's density bound is attained. `hex/0/2` and `hex/0/6`: Dickinson et al. 2011 (J. Geom.), as described by Connelly–Dickinson, and Brandt et al. 2019 for P = 2.
- `free/0/P`, every P: Thue.
- `free/8/P`, every P: L. Fejes Tóth 1950 (δ(K) = δ_L(K) for centrally symmetric K).
- Area-bound cases (optimal by the trivial area argument; Blair et al. call the square cases "optimal by construction"): `sq/4/P` for P a sum of two squares, `hex/6/P` for P = a² + ab + b², `hex/3/P` for P = 2(a² + ab + b²), `free/3/P` for even P, `free/4/P` and `free/6/P` for every P.
- `free/5/P` for even P: Hales–Kusner, a computer-assisted proof in an arXiv preprint with no refereed publication found.
- [CALC] P = 1 on `sq` (N = 3, 5, 6, 7, 8) and on `hex` (N = 3), and P = 1 disks: our rigorous branch and bound or the trivial bound L ≥ 2 equals the value. This is our own computation, not a published proof.

## 8. Limitations and open questions

- The search is heuristic. Where no bound is attained (most `sq`/`hex` polygon entries and odd P for `free` triangles, pentagons and heptagons), values are best found, not optimal; budgets were modest (phase B scale 0.6, about 70–130 local solves for P = 16).
- A few entries were still improving by about 1e-8 per polish round when polishing stopped (`hex/3/12`, `hex/7/11`, `sq/7/11`), so they are probably not exact local optima. The certificates are unaffected: they prove validity of the stored configuration, not optimality.
- Phase B ran partly with the faulty superlattice enumeration, and phase S re-ran only the structured seeds with the fix. Random starts and hops never ran with the fixed lattice seeds for the early families (disks, triangles, squares and their `hex` counterparts).
- A few results are reproducible only up to timing effects: HiGHS solves have a 2 s limit, and failed child solves are dropped.
- Three tilings never occur, so `hex/4`, `sq/6` and `sq/3` never reach density 1 (`hex/4/15` reaches 0.99926):
  - **Squares on the hexagonal torus.** [CALC] A tiling of the plane by unit squares has straight rows (or columns); we use this standard structure fact without proving it here. The projections k1, k2 of the hexagonal torus basis on the row normal would then be integers with k1² − k1k2 + k2² = √3 P/2, which is irrational.
  - **Hexagons on the square torus.** [CALC] The honeycomb is the only tiling by regular hexagons, and the triangular lattice contains no square sublattice, since i·Z[ω] ∩ Z[ω] = 0.
  - **Triangles on the square torus.** [CALC] We assume that unit-triangle tilings consist of straight strips of height √3/2, which we have not proven. A square torus would then need integers k1, k2 with k1² + k2² = P/√3.

## Reproduction

```
python3 python/torus/run_all.py --out data/torus/raw --phases A --scale 1.5
python3 python/torus/run_all.py --out data/torus/raw --phases B,S,C --scale 0.6 --final-scale 0.3 --c-Ns 3,5,7
python3 python/torus/polish_raw.py --raw data/torus/raw
python3 python/torus/p1_bound.py data/torus/p1_bounds.json
python3 python/torus/extend_torus.py --raw data/torus/raw --out data/torus/raw_ext --Pmax 49 --octagons
python3 python/torus/build_records.py --raw data/torus/raw --raw-ext data/torus/raw_ext --out data/torus
python3 python/torus/certify_torus.py data/torus/records.json
python3 python/torus/test_certify_torus.py
python3 python/torus/test_torus_tools.py
python3 python/torus/lattice_density.py
python3 python/torus/doc_tables.py data/torus/records.json
npx tsc -p packages/torus --noEmit
npx vitest run packages/torus
npx tsx packages/torus/viz/build.ts
```

Python is the anaconda build used for the run (numpy 1.21.5, scipy 1.7.3, mpmath 1.2.1). Searches use `nice -n 10` and single-threaded BLAS. Seeds are recorded per record; the LP time limit makes a rerun on a much slower machine able to differ.
