# 2D on 3D, Torus: PolyPack pieces on flat tori

**Dimension.** On the site this is the kind **Torus** under the dimension **2D on 3D**: pieces on a closed surface, with no container. The API calls it the space `torus`. A torus is usually pictured as a surface in 3D, which is why it is filed there, but a flat torus cannot be embedded in 3D both flat and smooth [EST]. Every closed surface in R³ that is smooth (of class C²) has a point of positive Gaussian curvature, and a flat torus has curvature 0 everywhere. Embeddings that keep every length but are only C¹ do exist: J. Nash, "C¹ isometric imbeddings", Annals of Mathematics 60 (1954), and N. H. Kuiper, "On C¹-isometric imbeddings", Indagationes Mathematicae 17 (1955). Borrelli, Jabrane, Lazarus and Thibert drew one: "Flat tori in three-dimensional space and convex integration", PNAS 109 (2012) 7218–7223. The board and the viewer draw the torus flat instead: the tiled plane, or one cell with its glued sides.

**Summary** (2026-10-25). `data/torus/records.json` holds 544 records, each proven valid by an interval-arithmetic certificate (`data/torus/certificates/`, checker `python/torus/certify_torus.py`). There are 336 records for P = 1–16 in each of the three torus families (square `sq`, hexagonal `hex`, free lattice `free`) and the seven shapes N = 0 (disk) and N = 3–8. Another 208 are exact constructions for P = 17–49 where a bound is attained. Every certified score exceeds its search value by at most 1.0003e-12 relative (shrink ε = 1e-12).

[SPEC] The site domain is `torus/<family>/<N>/<P>`: families `sq`, `hex`, `free`, N = 0 (unit disks) or every integer 3–100, P = 1–500, giving 148,500 problems (29,700 up to P = 100; P = 101–500 was added on 2026-10-27). The lattice and pose conventions are unchanged. New choices ship without research records. [CALC] Their lower bound uses `areaScoreBound` with density bound 1: sqrt(P A_piece), or sqrt(P A_piece/(√3/2)) for `hex`, lowered slightly for floating-point rounding. Stronger bounds already attached to research records take precedence.

[SPEC] `SPACE_DOMAINS` describes the ranges to the API and board picker. The volunteer list samples the domain; it never enumerates it all. Problems without a record have status `no_record`, null certified values/configurations, and require the strict float check on every entry. Existing record files are unchanged. Server validation shares the synchronous geometry through generators, yields between small units of work (8 ms default budget), stops after 20 overlapping pairs, and uses the shared heavy-check queue from P = 30. Sphere also queues N ≥ 20 at any P. No new records or optimisation runs accompany this change, nor the extension to P = 500 (see "Large P" below).

- **Equal to a lower bound.** 126 of the 336 records equal a lower bound to 1e-12 [CALC]; P = 1 on `hex` for squares, pentagons, heptagons and octagons is within 1e-9 of a rigorous computer-assisted bound.
- **Published results.** Every disk result on the square torus matches the published optimum (P ≤ 8, proven) or best-known value (P = 9–16). The exception is P = 13, which improves on the published table: density 0.789924 against 0.788 [CALC, certified]. Squares on the square torus match all of Blair–Santangelo–Machta's values for P ≤ 16. Disks on the hexagonal torus match Thue's bound, the published optima and the Density Gap Conjecture values.
- **Free lattice.** The free-lattice P = 1 entries equal the known densest lattice packings (proven for the disk and the triangle, §7). Pentagons with even P reach the proven (preprint) optimum (5 − √5)/3, heptagons with even P the best-known double lattice 0.8926906861, and octagons with every P the proven optimum (4 + 4√2)/(5 + 4√2).
- **Status.** 52 records are `proven` (§7): disks on the square torus for P = 2–4 and 6–8; disks on the hexagonal torus for P = 2 and for the 20 numbers P = a² + ab + b² up to 49; squares on the square torus for the 23 sums of two squares up to 49; one disk and one triangle on a free torus (the densest lattice packings). Each cites a refereed proof of that exact torus case with its theorem and DOI, and the certifier refuses `proven` without one. The other 492 are `best_known`, among them cases settled only by a theorem about the plane, by a preprint, or by a paper we have not read.

[CALC] One Node 26 run at N = P = 100 used 9.5 ms of validation work for a near-contact periodic grid (including the strict check), with a longest slice of 5.7 ms. Coincident pieces stopped at 20 overlaps in 0.3 ms. Reduced-basis storage rechecks also run in slices inside the heavy-check turn (11.5 ms total work, longest slice 3.1 ms in the same run).

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

If any pair is not proven, the record is rejected. The certificate (`data/torus/certificates/<family>_<N>_<P>.json`) stores ε, the enumeration window, the number of image pairs settled by bounding disks, every polygon pair settled by an axis (piece indices, λ, axis owner and edge, clearance lower bound) and the overall minimum clearance. ε is the first value on the ladder 1e-12, 1e-11, 1e-10, 1e-9 that certifies with a proven clearance of at least 5e-14 (thinner proofs are valid, but too thin for the float re-check below), so score_cert exceeds score_float by about 1e-12 relative. Adversarial tests (`python/torus/test_certify_torus.py`, 46 tests) include overlaps of 1e-9 inside the cell, across the cell boundary and through a piece's own short translate, an unreduced basis whose overlap uses λ = (1000, −1), centres given far outside the cell, a 1e-9 overlap that a 1e-12 shrink must not clear, coincident pieces, a claimed score below the certified bound, NaN/inf/strings in every field, wrong P, bad N, ε ∉ (0, 1e-3], degenerate and nearly degenerate bases, and a randomised comparison with exact rational arithmetic for disks.

**Status.** The certifier also checks every record's status (`check_status`). `proven` needs a literature entry with status `proven`, a DOI, the theorem or section that proves this exact torus case in `proof`, and a value that score_cert attains (value ≤ score_cert ≤ value (1 + 2e-9)); no record may lie below the value of any literature entry with status `proven`. Its tests include a proven record without literature, entries lacking each of these parts or with a malformed DOI, a record above the proven value by 1e-6, a record below it, and the records file itself (exactly the 52 records of §7 are proven).

**Independent review** (2026-10-24; a separate reviewer with its own 70-digit checker, which computes the critical shrink of every image pair exactly; reproduced results): 2,951 random configurations and 34,073 certifier calls with ε within a few ulps of each configuration's critical value, skewed, rotated and lattice-shifted bases, θ up to 1e4, N up to 12: no invalid configuration accepted, no valid one rejected; all 1,390 lattice vectors with |v| < 2sR in 140 skewed cases were visited by the enumeration; every score claim one double below the bound was refused. The review found no soundness issue. It found crashes outside `CertError` (|θ| ≥ 1e16, integers beyond the double range), a misleading message for very large P, a precision side effect and a possibly non-positive reported clearance; all are fixed, with regression tests.

**Float validator** (`packages/torus`, TypeScript). `validateTorusPacking` uses the shared PolyPack kernel (`pieceSeparation` from `@polypack/geometry`) on every image pair from the same enumeration lemma and reports overlaps, contacts, the minimum separation, score and density. Its tests (`packages/torus/test/torus.test.ts`) cover the same adversarial cases plus property tests (moving a piece by a lattice vector and changing the basis leave the result unchanged; scaling up keeps validity; the number of image pairs checked equals a brute force over a large box; the enumeration equals a brute force for random skewed bases). `packages/torus/test/records.test.ts` re-checks every record in floats: the stored configuration, the shrunk configuration (strictly), and the configuration scaled to `score_cert`.

## 4. Search

`python/torus/torus_search.py` (numpy/scipy; seeded; not a proof). Local solver: sequential linear programming in the spirit of Torquato and Jiao's adaptive shrinking cell [EST: S. Torquato and Y. Jiao, *Phys. Rev. E* 80, 041104 (2009), arXiv:0909.0940; the LP form in *Phys. Rev. E* 82, 061302 (2010), arXiv:1008.2747; both verified 2026-10-24]. Variables are the fractional centres u_i (x_i = B u_i), the angles θ_i and the lattice parameters (L for `sq`/`hex`; an upper-triangular basis (a, b; 0, c) for `free`, with the rotation gauge fixed by b1 ∥ x). Each step linearises every near contact (disks: centre distance; polygons: for the best SAT axis, one row per vertex of the other polygon within a window of the minimum), minimises L or the cell area inside a trust box, and accepts by a merit ratio test (score + 3·score·overlap); the box grows on good steps and shrinks on poor ones. For `free` the basis is Gauss-reduced after every step. Exploration stops at a box of 1e-5, the final polish at 1e-11; the result typically overlaps by at most 1e-15.

Starts, per (family, N, P): translative lattice packings on every superlattice of index P of the family lattice (Hermite normal forms; the best piece angle is found from the gauge of the difference body K − K), replications of smaller solutions over sublattices (same density), a double-lattice start (two orientations θ and θ + π on a superlattice of index P/2), the P − 1 solution plus one piece in its largest sampled hole, random sequential addition at density 0.25, and, for `sq`/`hex`, the `free` solution deformed to the target cell. Then basin hopping on the pool of the 8 best (expand 2–8 % and jitter; re-place up to P/3 pieces; turn one polygon by up to π/N; shear the free cell). Budget per problem (deterministic counts): s (6 + P) random starts and s (12 + 5P) hops with scale s; a search stops early when it reaches a density bound (π/√12 for disks, (5 − √5)/3 for pentagons, 1 otherwise), because no packing can do better.

The run of 2026-10-24 (00:59–03:09, at most 2 processes, `nice -n 10`, seed 20261024): phase A, `free` with s = 1.5 (the octagon job was stopped after P = 12 once Fejes Tóth's theorem, §6, made the lattice packing provably optimal; exact replications supply every octagon entry); phase B, `sq` and `hex` with s = 0.6, seeded with the deformed `free` solutions; phase S, structured seeds only for `sq` and `hex` (seed + 11), after a bug fix: the first superlattice enumeration used column-style Hermite forms, which list sublattices, and so missed most superlattices (all but two for prime P); phase C, `free` for N = 3, 5, 7 with s = 0.3 (seed + 7), seeded with the `sq` and `hex` solutions; finally `polish_raw.py` (SLP from every stored result with a box down to 1e-12, keeping improvements, which were at most a few 1e-9 relative). Each raw result records its label, seed, budget and how it stopped.

**Rerun on a quieter machine (2026-10-24, 16:35–18:15, one process, `nice -n 10`, logs in `data/torus/raw/rerun-2026-10-24/`):**

1. The three records that were still creeping (`hex/3/12`, `hex/7/11`, `sq/7/11`) were polished to convergence: `polish_raw.py --deep 200`, then `--slsqp 60`. The SLSQP mode freezes the contact set (pair, lattice vector, axis owner, edge, vertex), solves the exact nonlinear constraints with scipy's SLSQP and re-selects. A final pass with `--slsqp 60 --deep 3` changed nothing by more than 1e-15 relative.
2. Random starts and hops with the corrected lattice seeds (seed 20261025, s = 1.5) ran for the early families: `sq` and `hex` disks, triangles and squares, P ≤ 16, skipping entries that are proven or at a bound.
3. Odd-P free pentagons were searched again (seed 20261026, s = 1.0).

Records were then rebuilt with `build_records.py --only-improve`, which replaces a record only by a certified candidate lower by more than 1e-11 relative and leaves every other record unchanged except for the display rule. Nine records improved:

| record | old score_float | new score_float | gain |
|---|---:|---:|---:|
| sq/3/6 | 1.793150944336 | 1.791836944045 | 7.3e-4 |
| sq/3/13 | 2.552558883258 | 2.538945636830 | 5.3e-3 |
| sq/7/11 | 7.023958888775 | 7.023958869017 | 2.8e-9 (polish) |
| hex/3/10 | 2.415328488045 | 2.413240644942 | 8.6e-4 |
| hex/3/11 | 2.500000000040 | 2.500000000002 | 1.5e-11 |
| hex/3/12 | 2.596952237790 | 2.582838096277 | 5.4e-3 |
| hex/3/16 | 2.945941519798 | 2.884441020371 | 2.1e-2 (density 25/26 to 1e-16) |
| hex/4/11 | 4.000000000000 | 3.983152676502 | 4.2e-3 |
| hex/7/11 | 7.539096719347 | 7.539096598716 | 1.6e-8 (polish) |

Disks on both tori, squares on the square torus and the odd-P free pentagons did not improve. Four further candidates were lower only at the 1e-12 level and were not taken: `sq/4/12`, `hex/3/13`, `hex/4/5`, `free/5/15`. scipy 1.7's HiGHS occasionally aborts the process or stalls on these degenerate LPs, so each local solve runs in a forked child with a 90 s limit and each LP has a 2 s limit; a failed solve is dropped (counts are in the raw results).

`python/torus/build_records.py` then takes, for each problem, the best of: the search result; for `free`, the `sq` and `hex` results read as free lattices; the P + 1 result with one piece deleted; and exact replications from `python/torus/extend_torus.py`. It certifies the winner and writes `data/torus/records.json`.

## Large P (101 to 500)

[SPEC] Problems with P = 101–500 ship without records, like the other new choices: nothing was searched for them. Everything else is the same code as for P ≤ 100.

- **Start.** `torusLatticeStart({ family, N, P })` (`packages/torus/src/start.ts`) is a deterministic packing with no search and no random numbers: the P pieces at the points of the superlattice of index P (Hermite normal form (a, b, d), ad = P) of a square or hexagonal cell whose shortest vector is longest, all at angle 0, the cell scaled so that the circumscribed disks of the closest pair touch, plus a relative 1e-9. [CALC] It is valid at the strict tolerance 1e-11 for all three families, N = 0, 3, 4, 7 and 100, and P = 1, 2, 7, 101, 499 and 500 (`packages/torus/test/start.test.ts`), and takes 0.1–1.7 ms. Its score is a plain translative lattice packing's, not a record: for disks on `sq` at P = 500 it is 42.875 [CALC], density π·500/42.875² = 0.855 against the bound 0.907. The board offers it as "Lattice arrangement" and the volunteer client starts from it for P > 100 without a record; at P ≤ 100 both start as before.
- **Searches.** Auto and every generic method accept P = 500. [CALC] On an Apple Silicon laptop (Node 26, 2026-10-27), one evaluation of Auto costs about P (5 + 1.5 N)/500 ms (4.8 ms for disks, 12.8 ms for triangles and hexagons, 157 ms for 100-gons, all at P = 500), most of it the separating-axis tests of the pairs; the generic methods' rounds of K/P = 1,800 evaluations took 3–4 s for N ≤ 6. All of them keep to their time limit to within one evaluation. The board sizes a round of Auto at about 3 s (`torusRound` in `apps/web/src/space/model.ts`), at least 100 evaluations. A new arrangement from nothing rarely finds a valid packing at this size in one round, which is why the lattice start is offered.
- **Server.** Checks of P ≥ 30 are heavy: one at a time, at most 8 waiting. [CALC] A strict check (an entry without a record is checked twice, at 1e-9 and at 1e-11) of 500 pieces at the lattice start took 50–65 ms of work, with the longest slice 8 ms, for every family and N = 0, 3, 6 and 100. The worst case is a valid packing on an unreduced basis with as many translates per pair as `TORUS_MAX_TRANSLATES = 1000` allows: 500 disks took 1.4 s of work, the check, its strict pass and the stored configuration's recheck together, in slices of at most 8 ms (`apps/server/test/spaces.test.ts`). The budget reserves 0.006 P² ms before the check, 1.5 s at P = 500. A body of 500 poses is about 34 kB, below the 256 kB limit. The limit of 1,000 translates was left as it was.
- **Certifier.** `python/torus/certify_torus.py` accepts P ≤ 500 (`MAX_PIECES`); [CALC] it certified the lattice starts at P = 500 with shrink ε = 1e-10 in 80 s (disks, `sq`), 103 s (hexagons, `hex`) and 199 s (100-gons, `free`) on an Apple Silicon laptop (Python 3.12, mpmath, one core): minutes, not hours, and unchanged.

## Kernel for the generic methods

`torusKernel({ family, N, P })` (`packages/torus/src/kernel.ts`) is the torus's kernel for the generic search methods (`docs/methods/dimensions/README.md`), in every family. The built-in search stays available as Auto.

- **Variables.** As in the TypeScript search: a base packing (basis, centres and angles) mapped by kF. The factor k = size / score(base) scales the lattice and the centres together; pieces keep side 1 or radius 1. For `free`, F = [[e^t1, t2], [0, e^−t1]] has determinant 1 and shears the cell; t1 and t2 are the kernel's two globals. `sq` and `hex` have none. Per piece: the centre's offset in the base frame, and the angle's offset times the circumradius (disks: the centre only), so every variable is a length. The size is the score. Because the centres live in the base frame, a change of the globals deforms the whole packing with the cell, as in Torquato and Jiao's adaptive shrinking cell (§4). `rebase` folds offsets, scale and shear into the base packing. It, `fromConfig` and the starts also replace a skewed free basis by a reduced one and bring centres more than a cell away back into the cell; neither changes the packing. `fromConfig` refuses numbers beyond the server's limits, as the server does, and the energy brings far centres back into the cell too, so its enumeration stays a few lattice vectors per pair whatever the offsets. Moves (`jiggle`, `randomPose`, `swap`) change only the moved pieces' entries of x.
- **Energy.** For every image pair within 2R (the window of §2), the squared penetration depth from `pairPenetration` of the shared geometry kernel. It is the validator's separating-axis value (`pieceSeparation`) negated, which is the exact penetration depth of two overlapping convex polygons, and it comes with analytic derivatives. A piece and its own translates count once per lattice vector. The gradient in the globals and the size follows from v = kFδ for an image vector v (δ in the base frame).
- **finish().** The search's tight-scale bisection to 10⁻¹³ relative, after a free basis is Lagrange–Gauss reduced (as the server stores it) and the centres are brought into the cell. Each step uses the energy's pair test, which computes the same separating-axis values as the validator; the validator then checks the result at tolerance 0, and if rounding at a contact requires it the result moves up by at most 7·10⁻¹² relative; else the validator's own bisection decides, polling the run's stop. When the pair test finds no valid scale within a factor of about 14, the finish gives up at once. The results equalled the validator-driven bisection exactly on 18 squeezed states (P = 10 and 30, every family), and to 10⁻¹² on the records tested [CALC].
- **validate().** The server's rule: format and ranges, the size against the kernel's bound with the server's slack of 10⁻⁹ relative, a shortest lattice vector at least the piece's width, at most 1,000 translates per pair, then `validateTorusPacking` at the touching tolerance 10⁻⁹. The server's strict check of a size below a research record (tolerance 10⁻¹¹) needs the record, so it stays with the server.
- **bound.** The area bound, with Thue's density π/√12 for disks (§5) and 1 otherwise.
- **Capabilities.**
  - `shape`: exactly the kernel definition's soft piece, the piece scaled by t about its centre and dilated by (1 − t) r (r the inradius). `pairPenetration` gives the exact penetration depth of these rounded polygons. They lie in the piece and penetration depth grows with the shapes, so softening never adds energy. For disks `setShape` does nothing.
  - `seeds`: lattice placements after the research search's starts. The pieces sit at the points of a superlattice of index P of the cell's lattice (Hermite normal forms (a, b, d), ad = P, 0 ≤ b < d), all at one angle. For odd N and even P, half the seeds are double lattices: a superlattice of index P/2 and a shifted copy turned by π. The cell has the family's shape (square or hexagonal at random for `free`) and is scaled so that the circumscribed disks of the closest pair touch. Every seed is valid.
  - `swap`: two polygons exchange angles.
- **Costs** [CALC, measured on an Apple Silicon laptop under heavy load]. One energy with gradient takes 3–35 µs at P = 10 and 15–90 µs at P = 30 (one squeezed hexagon state took 175 µs). A finish costs 9–45 energies, a validate 1–8; `finishCost` is 50 and `validateCost` 10.
- **Tests.** `packages/torus/test/kernel.test.ts`: the kernel contract on 11 problems in each family; the gradient against central differences, globals and soft shapes included; all 544 records convert, validate, have zero energy, and finish at most 10⁻⁹ above `score_cert` (at most 1.2·10⁻¹³ above `score_float`); squeezes from random starts in every family; one disk on a free torus shears to the hexagonal lattice; soft shapes, seeds, swap, moves and rebase; the server's rule, including a size below the bound; a start with a centre at 10¹⁷ and states with far offsets (once a hang); a skewed free basis; finishes that cannot succeed; a run through `runMethod`.

## 5. Results

Display values are `score_cert` rounded to the nearest at 6 decimals (from its exact binary64 value, ties to even). Where the score equals a bound, the record also has `exact` (for example `sqrt(5)` or `sqrt(7 * 2 sqrt(3))`). Densities are P · A_piece / cell area. The lower bound kept in each record is the best of these:

- the area bound;
- a density bound for congruent copies in the plane: π/√12 for disks, (5 − √5)/3 for pentagons, (4 + 4√2)/(5 + 4√2) for octagons (§6);
- the value of a literature entry with status `proven`, where it is larger: disks on the square torus (P = 2–8), disks on the hexagonal torus (P = 2 and 6), one triangle on a free torus (Fáry 1950, density 2/3);
- for P = 1 on `sq`/`hex`, a rigorous interval branch and bound over the piece angle (`python/torus/p1_bound.py`; [CALC], computer-assisted, not published). It brackets every P = 1 polygon value to within 1e-9.

### Square torus (score L)

Certified score (rounded to 6 decimals), with density below. **Bold**: equal to the lower bound in the record (to 1e-12 relative). †: status `proven` (§7).

| P | disks | triangles | squares | pentagons | hexagons | heptagons | octagons |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **2.000000**<br>0.7854 | **0.896575**<br>0.5387 | **1.000000** †<br>1.0000 | **1.558024**<br>0.7088 | **1.793151**<br>0.8080 | **2.204505**<br>0.7477 | **2.414214**<br>0.8284 |
| 2 | **2.828427** †<br>0.7854 | 0.954747<br>0.9501 | **1.414214** †<br>1.0000 | 2.120995<br>0.7649 | 2.535898<br>0.8080 | 3.017103<br>0.7984 | 3.414214<br>0.8284 |
| 3 | **3.863703** †<br>0.6313 | 1.344863<br>0.7182 | 2.000000<br>0.7500 | 2.774480<br>0.6705 | 3.464102<br>0.6495 | 4.079906<br>0.6549 | 4.765890<br>0.6377 |
| 4 | **3.863703** †<br>0.8418 | 1.350217<br>0.9501 | **2.000000** †<br>1.0000 | 2.776418<br>0.8928 | 3.464102<br>0.8660 | 4.111522<br>0.8599 | 4.765890<br>0.8503 |
| 5 | **4.472136**<br>0.7854 | 1.692811<br>0.7555 | **2.236068** †<br>1.0000 | 3.387248<br>0.7498 | 4.009607<br>0.8080 | 4.831473<br>0.7784 | 5.398346<br>0.8284 |
| 6 | **4.994936** †<br>0.7555 | 1.791837<br>0.8092 | 2.683282<br>0.8333 | 3.503920<br>0.8408 | 4.437822<br>0.7915 | 5.325566<br>0.7688 | 6.161760<br>0.7630 |
| 7 | **5.464102** †<br>0.7366 | 1.811733<br>0.9234 | 2.828427<br>0.8750 | 3.923707<br>0.7823 | 4.885776<br>0.7619 | 5.787543<br>0.7594 | 6.723128<br>0.7478 |
| 8 | **5.464102** †<br>0.8418 | 1.872993<br>0.9875 | **2.828427** †<br>1.0000 | 3.926449<br>0.8928 | 4.898979<br>0.8660 | 5.814570<br>0.8599 | 6.739986<br>0.8503 |
| 9 | 5.818626<br>0.8351 | 2.094070<br>0.8887 | **3.000000** †<br>1.0000 | 4.309276<br>0.8338 | 5.196152<br>0.8660 | 6.263837<br>0.8336 | 7.135642<br>0.8535 |
| 10 | 6.324555<br>0.7854 | 2.134880<br>0.9501 | **3.162278** †<br>1.0000 | 4.638836<br>0.7995 | 5.670441<br>0.8080 | 6.746447<br>0.7984 | 7.634414<br>0.8284 |
| 11 | 6.547757<br>0.8060 | 2.320508<br>0.8846 | 3.478505<br>0.9091 | 4.775184<br>0.8300 | 5.705771<br>0.8778 | 7.023959<br>0.8102 | 8.035534<br>0.8226 |
| 12 | 6.656402<br>0.8508 | 2.356351<br>0.9358 | 3.535534<br>0.9600 | 4.792445<br>0.8989 | 5.776590<br>0.9343 | 7.139949<br>0.8554 | 8.190703<br>0.8637 |
| 13 | 7.190416<br>0.7899 | 2.538946<br>0.8732 | **3.605551** †<br>1.0000 | 5.224367<br>0.8195 | 6.276028<br>0.8575 | 7.702229<br>0.7963 | 8.704571<br>0.8284 |
| 14 | 7.241690<br>0.8387 | 2.562178<br>0.9234 | 3.882901<br>0.9286 | 5.320280<br>0.8510 | 6.276028<br>0.9234 | 7.827717<br>0.8303 | 8.949747<br>0.8439 |
| 15 | 7.276069<br>0.8901 | 2.621425<br>0.9452 | 4.000000<br>0.9375 | 5.388975<br>0.8886 | 6.302152<br>0.9812 | 7.881092<br>0.8776 | 8.997243<br>0.8947 |
| 16 | 7.727407<br>0.8418 | 2.648812<br>0.9875 | **4.000000** †<br>1.0000 | 5.552837<br>0.8928 | 6.928203<br>0.8660 | 8.223044<br>0.8599 | 9.525483<br>0.8514 |

### Hexagonal torus (score L)

Certified score (rounded to 6 decimals), with density below. **Bold**: equal to the lower bound in the record (to 1e-12 relative). †: status `proven` (§7).

| P | disks | triangles | squares | pentagons | hexagons | heptagons | octagons |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **2.000000** †<br>0.9069 | **0.866025**<br>0.6667 | 1.154701<br>0.8660 | 1.573220<br>0.8027 | **1.732051**<br>1.0000 | 2.215387<br>0.8550 | 2.499378<br>0.8925 |
| 2 | **3.464102** †<br>0.6046 | **1.000000**<br>1.0000 | 2.000000<br>0.5774 | 2.503613<br>0.6339 | 3.000000<br>0.6667 | 3.732274<br>0.6025 | 4.266705<br>0.6125 |
| 3 | **3.464102** †<br>0.9069 | 1.401259<br>0.7639 | 2.000000<br>0.8660 | 2.616618<br>0.8705 | **3.000000**<br>1.0000 | 3.780346<br>0.8809 | 4.329049<br>0.8925 |
| 4 | **4.000000** †<br>0.9069 | 1.599947<br>0.7813 | 2.309401<br>0.8660 | 3.013137<br>0.8753 | **3.464102**<br>1.0000 | 4.368224<br>0.8796 | 4.998756<br>0.8925 |
| 5 | 5.048676<br>0.7116 | 1.700840<br>0.8642 | 2.886751<br>0.6928 | 3.745645<br>0.7080 | 4.493572<br>0.7429 | 5.395121<br>0.7208 | 6.246889<br>0.7144 |
| 6 | **5.291503**<br>0.7773 | **1.732051**<br>1.0000 | 3.000000<br>0.7698 | 3.907092<br>0.7808 | 4.582576<br>0.8571 | 5.747856<br>0.7620 | 6.556230<br>0.7782 |
| 7 | **5.291503** †<br>0.9069 | 1.963961<br>0.9074 | 3.000000<br>0.8981 | 3.963368<br>0.8853 | **4.582576**<br>1.0000 | 5.778922<br>0.8795 | 6.612732<br>0.8925 |
| 8 | 6.000000<br>0.8061 | **2.000000**<br>1.0000 | 3.055050<br>0.9897 | 4.416365<br>0.8149 | 5.196152<br>0.8889 | 6.434734<br>0.8107 | 7.318686<br>0.8327 |
| 9 | **6.000000** †<br>0.9069 | 2.236068<br>0.9000 | 3.401680<br>0.8981 | 4.502288<br>0.8821 | **5.196152**<br>1.0000 | 6.544421<br>0.8817 | 7.498133<br>0.8925 |
| 10 | 6.854068<br>0.7722 | 2.413241<br>0.8586 | 3.779645<br>0.8083 | 4.917678<br>0.8215 | 6.000000<br>0.8333 | 7.310700<br>0.7851 | 8.485113<br>0.7744 |
| 11 | 6.928203<br>0.8313 | 2.500000<br>0.8800 | 3.983153<br>0.8006 | 5.146917<br>0.8249 | 6.000000<br>0.9167 | 7.539097<br>0.8121 | 8.642667<br>0.8211 |
| 12 | **6.928203** †<br>0.9069 | 2.582838<br>0.8994 | 4.000000<br>0.8660 | 5.192395<br>0.8842 | **6.000000**<br>1.0000 | 7.557438<br>0.8816 | 8.658099<br>0.8925 |
| 13 | **7.211103** †<br>0.9069 | 2.598076<br>0.9630 | 4.041452<br>0.9190 | 5.410898<br>0.8821 | **6.244998**<br>1.0000 | 7.862184<br>0.8825 | 9.011635<br>0.8925 |
| 14 | 7.935884<br>0.8064 | **2.645751**<br>1.0000 | 4.041452<br>0.9897 | 5.750557<br>0.8411 | 6.928203<br>0.8750 | 8.474115<br>0.8181 | 9.728316<br>0.8248 |
| 15 | 8.000000<br>0.8502 | 2.882307<br>0.9028 | 4.163332<br>0.9993 | 5.912063<br>0.8526 | 6.928203<br>0.9375 | 8.707970<br>0.8300 | 9.991605<br>0.8377 |
| 16 | **8.000000** †<br>0.9069 | 2.884441<br>0.9615 | 4.437602<br>0.9382 | 5.912063<br>0.9094 | **6.928203**<br>1.0000 | 8.723434<br>0.8822 | 9.997511<br>0.8925 |

### Free lattice (score sqrt(cell area))

Certified score (rounded to 6 decimals), with density below. **Bold**: equal to the lower bound in the record (to 1e-12 relative). †: status `proven` (§7).

| P | disks | triangles | squares | pentagons | hexagons | heptagons | octagons |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **1.861210** †<br>0.9069 | **0.805927** †<br>0.6667 | **1.000000**<br>1.0000 | 1.450927<br>0.8173 | **1.611855**<br>1.0000 | 2.055369<br>0.8602 | **2.308339**<br>0.9062 |
| 2 | **2.632148**<br>0.9069 | **0.930605**<br>1.0000 | **1.414214**<br>1.0000 | **1.932575**<br>0.9213 | **2.279507**<br>1.0000 | 2.853328<br>0.8927 | **3.264484**<br>0.9062 |
| 3 | **3.223710**<br>0.9069 | 1.231075<br>0.8571 | **1.732051**<br>1.0000 | 2.416616<br>0.8838 | **2.791815**<br>1.0000 | 3.516536<br>0.8816 | **3.998160**<br>0.9062 |
| 4 | **3.722419**<br>0.9069 | **1.316074**<br>1.0000 | **2.000000**<br>1.0000 | **2.733074**<br>0.9213 | **3.223710**<br>1.0000 | 4.035215<br>0.8927 | **4.616677**<br>0.9062 |
| 5 | **4.161791**<br>0.9069 | 1.543234<br>0.9091 | **2.236068**<br>1.0000 | 3.094331<br>0.8984 | **3.604217**<br>1.0000 | 4.528521<br>0.8860 | **5.161602**<br>0.9062 |
| 6 | **4.559014**<br>0.9069 | **1.611855**<br>1.0000 | **2.449490**<br>1.0000 | **3.347319**<br>0.9213 | **3.948222**<br>1.0000 | 4.942109<br>0.8927 | **5.654252**<br>0.9062 |
| 7 | **4.924298**<br>0.9069 | 1.802109<br>0.9333 | **2.645751**<br>1.0000 | 3.657910<br>0.9001 | **4.264567**<br>1.0000 | 5.364265<br>0.8840 | **6.107290**<br>0.9062 |
| 8 | **5.264296**<br>0.9069 | **1.861210**<br>1.0000 | **2.828427**<br>1.0000 | **3.865151**<br>0.9213 | **4.559014**<br>1.0000 | 5.706656<br>0.8927 | **6.528968**<br>0.9062 |
| 9 | **5.583629**<br>0.9069 | 2.028206<br>0.9474 | **3.000000**<br>1.0000 | 4.139025<br>0.9038 | **4.835565**<br>1.0000 | 6.075992<br>0.8859 | **6.925016**<br>0.9062 |
| 10 | **5.885662**<br>0.9069 | **2.080896**<br>1.0000 | **3.162278**<br>1.0000 | **4.321370**<br>0.9213 | **5.097133**<br>1.0000 | 6.380236<br>0.8927 | **7.299608**<br>0.9062 |
| 11 | **6.172934**<br>0.9069 | 2.231512<br>0.9565 | **3.316625**<br>1.0000 | 4.558445<br>0.9108 | **5.345918**<br>1.0000 | 6.712677<br>0.8871 | **7.655893**<br>0.9062 |
| 12 | **6.447420**<br>0.9069 | **2.279507**<br>1.0000 | **3.464102**<br>1.0000 | **4.733823**<br>0.9213 | **5.583629**<br>1.0000 | 6.989198<br>0.8927 | **7.996319**<br>0.9062 |
| 13 | **6.710687**<br>0.9069 | 2.417782<br>0.9630 | **3.605551**<br>1.0000 | 4.951189<br>0.9124 | **5.811625**<br>1.0000 | 7.293997<br>0.8879 | **8.322833**<br>0.9062 |
| 14 | **6.964009**<br>0.9069 | **2.462149**<br>1.0000 | **3.741657**<br>1.0000 | **5.113114**<br>0.9213 | **6.031009**<br>1.0000 | 7.549197<br>0.8927 | **8.637012**<br>0.9062 |
| 15 | **7.208434**<br>0.9069 | 2.590694<br>0.9677 | **3.872983**<br>1.0000 | 5.314990<br>0.9136 | **6.242687**<br>1.0000 | 7.832288<br>0.8886 | **8.940157**<br>0.9062 |
| 16 | **7.444839**<br>0.9069 | **2.632148**<br>1.0000 | **4.000000**<br>1.0000 | **5.466148**<br>0.9213 | **6.447420**<br>1.0000 | 8.070431<br>0.8927 | **9.233354**<br>0.9062 |

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
| disk | 0.906900 (π/√12, proven: Fukshansky 2011) | 0.906900, every P | π/√12, proven (Thue) |
| triangle | 0.666667 (2/3, proven: Fáry 1950; Sriamorn 2016) | 1 for even P (tiling) | 1 (tiling) |
| square, hexagon | 1 | 1, every P | 1 (tiling) |
| pentagon | 0.817256 | 0.921311 for even P | (5 − √5)/3 = 0.921311, proven in a preprint (Hales–Kusner) |
| heptagon | 0.860191 | 0.892691 for even P | 0.8926906861 double lattice, best known (Kuperbergs) |
| octagon | 0.906164 | 0.906164, every P | (4 + 4√2)/(5 + 4√2) = 0.906164, proven (Fejes Tóth) |

[CALC] Odd P cannot use a double lattice:

- **Triangles.** Our odd-P values are exactly 2P/(2P + 1) for P = 1, 3, …, 15 (6/7, 10/11, …, 30/31): P triangles and one triangle-sized hole per cell. [SPEC] We conjecture that this is optimal for odd P.
- **Pentagons.** Odd-P values rise from 0.8838 (P = 3) to 0.9136 (P = 15).
- **Heptagons.** Odd-P values lie between 0.8816 and 0.8886.

### Comparison with the literature

The record column is the record's status; the source's claim is that of the paper, and "proof checked" marks the entries that make a record `proven` (§7).

| problem | record | ours (score_float) | literature | source's claim | ours - literature | source |
|---|---|---:|---:|---|---:|---|
| torus/sq/0/1 | best known | 2.000000000 | 2.000000000 | proven | 0.00e+00 | Dickinson et al. 2011 (not read); one disk: the shortest lattice vector must be at least 2 (trivial); Connelly et al. 2017 report the square grid optimal for N = 1, 2 and 5 |
| torus/sq/0/2 | proven | 2.828427125 | 2.828427125 | proven; proof checked | -4.44e-16 | Brandt et al. 2019, Thm 1.1; L = 2 sqrt2 |
| torus/sq/0/2 | proven | 2.828427125 | 2.828427125 | proven | -4.44e-16 | Dickinson et al. 2011 (not read); d = sqrt2/2, L = 2 sqrt2 |
| torus/sq/0/3 | proven | 3.863703305 | 3.863703305 | proven; proof checked | 4.44e-16 | Brandt et al. 2019, Thm 1.1; L = sqrt6 + sqrt2 |
| torus/sq/0/3 | proven | 3.863703305 | 3.863703305 | proven | 4.44e-16 | Dickinson et al. 2011 (not read); d = (sqrt6 - sqrt2)/2, L = sqrt6 + sqrt2 |
| torus/sq/0/4 | proven | 3.863703305 | 3.863703305 | proven; proof checked | 4.44e-16 | Brandt et al. 2019, Thm 1.1; L = sqrt6 + sqrt2 |
| torus/sq/0/4 | proven | 3.863703305 | 3.863703305 | proven | 4.44e-16 | Dickinson et al. 2011 (not read); d = (sqrt6 - sqrt2)/2, L = sqrt6 + sqrt2 |
| torus/sq/0/5 | best known | 4.472135955 | 4.472135955 | proven | 0.00e+00 | Dickinson et al. 2011 (not read); d = 1/sqrt5, L = 2 sqrt5 |
| torus/sq/0/6 | proven | 4.994935777 | 4.994935777 | proven; proof checked | -1.78e-15 | Musin and Nikitenko 2016, Thm 1; d6 = sqrt3/2 - sqrt2 sqrt(3 sqrt3 + 2)/6 + 1/6 |
| torus/sq/0/7 | proven | 5.464101615 | 5.464101615 | proven; proof checked | 0.00e+00 | Musin and Nikitenko 2016, Thm 2; d7 = 1/(1 + sqrt3), three optimal arrangements |
| torus/sq/0/8 | proven | 5.464101615 | 5.464101615 | proven; proof checked | 0.00e+00 | Musin and Nikitenko 2016, Thm 3; d8 = 1/(1 + sqrt3) |
| torus/sq/0/9 | best known | 5.818625822 | 5.818625822 | conjecture | 0.00e+00 | Musin and Nikitenko 2016, Conjecture 2.1; d = 1/sqrt(5 + 2 sqrt3); Voloshinov and Smirnov reach the same arrangement with a floating-point branch and bound (V. V. Voloshinov, S. A. Smirnov, Optimal packings of congruent circles on a square flat torus as mixed-integer nonlinear optimization problem, Communications in Computer and Information Science (Springer, 2019) 87-97, doi:10.1007/978-3-030-36592-9_8), not a rigorous proof |
| torus/sq/0/10 | best known | 6.324555320 | 6.324555320 | best known | 0.00e+00 | Connelly et al. 2017; square grid, conjectured optimal; table bracket L in [6.3241, 6.3282] |
| torus/sq/0/11 | best known | 6.547757332 | — | best known |  | Connelly et al. 2017; table bracket L in [6.5459, 6.5500] (r = 0.153, delta = 0.806) |
| torus/sq/0/12 | best known | 6.656402355 | 6.656402355 | best known | 0.00e+00 | Connelly et al. 2017; Type I (a, b) = (3, 2): L = 24/sqrt13; table bracket [6.6539, 6.6578] |
| torus/sq/0/13 | best known | 7.190416372 | — | best known |  | Connelly et al. 2017; table bracket L in [7.1969, 7.2015] (r = 0.139, delta = 0.788) |
| torus/sq/0/14 | best known | 7.241690393 | — | best known |  | Connelly et al. 2017; table bracket L in [7.2382, 7.2425] (r = 0.138, delta = 0.839) |
| torus/sq/0/15 | best known | 7.276068751 | 7.276068751 | best known | 8.88e-16 | Connelly et al. 2017; Type II (a, b) = (4, 1): L = 30/sqrt17; table bracket [7.2745, 7.2786] |
| torus/sq/0/16 | best known | 7.727406610 | 7.727406610 | best known | 8.88e-16 | Connelly et al. 2017; table bracket [7.7241, 7.7287]; 2 x 2 copy of the P = 4 optimum gives 2 (sqrt6 + sqrt2) [SPEC identification] |
| torus/sq/4/1 | proven | 1.000000000 | 1.000000000 | proven; proof checked | 2.22e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/2 | proven | 1.414213562 | 1.414213562 | proven; proof checked | 0.00e+00 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/3 | best known | 2.000000000 | 2.000000000 | best known | -4.44e-16 | Blair et al. 2012, Table I; density 0.75 (2^2 - 1); conjectured optimal |
| torus/sq/4/4 | proven | 2.000000000 | 2.000000000 | proven; proof checked | -4.44e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/5 | proven | 2.236067977 | 2.236067977 | proven; proof checked | 4.44e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/6 | best known | 2.683281573 | 2.683281573 | best known | 1.60e-14 | Blair et al. 2012, Table I; density 0.8333333333333334 (gapped bricklayer); conjectured optimal |
| torus/sq/4/7 | best known | 2.828427125 | 2.828427125 | best known | 0.00e+00 | Blair et al. 2012, Table I; density 0.875 (2^2 + 2^2 - 1); conjectured optimal |
| torus/sq/4/8 | proven | 2.828427125 | 2.828427125 | proven; proof checked | 0.00e+00 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/9 | proven | 3.000000000 | 3.000000000 | proven; proof checked | 0.00e+00 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/10 | proven | 3.162277660 | 3.162277660 | proven; proof checked | -8.88e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/11 | best known | 3.478505426 | 3.478505426 | best known | 1.33e-15 | Blair et al. 2012, Table I; density 0.9090909090909091 (gapped bricklayer); conjectured optimal |
| torus/sq/4/12 | best known | 3.535533906 | 3.535533906 | best known | 4.59e-12 | Blair et al. 2012, Table I; density 0.96 (lattice of 1/2 x 1/2 holes); conjectured optimal |
| torus/sq/4/13 | proven | 3.605551275 | 3.605551275 | proven; proof checked | 4.44e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/14 | best known | 3.882901374 | 3.882901374 | best known | 1.64e-14 | Blair et al. 2012, Table I; density 0.9285714285714286 (gapped bricklayer); conjectured optimal |
| torus/sq/4/15 | best known | 4.000000000 | 4.000000000 | best known | 0.00e+00 | Blair et al. 2012, Table I; density 0.9375 (4^2 - 1); conjectured optimal |
| torus/sq/4/16 | proven | 4.000000000 | 4.000000000 | proven; proof checked | 0.00e+00 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/17 | proven | 4.123105626 | 4.123105626 | proven; proof checked | 8.88e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/18 | proven | 4.242640687 | 4.242640687 | proven; proof checked | 8.88e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/20 | proven | 4.472135955 | 4.472135955 | proven; proof checked | 8.88e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/25 | proven | 5.000000000 | 5.000000000 | proven; proof checked | 1.78e-15 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/26 | proven | 5.099019514 | 5.099019514 | proven; proof checked | 8.88e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/29 | proven | 5.385164807 | 5.385164807 | proven; proof checked | 8.88e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/32 | proven | 5.656854249 | 5.656854249 | proven; proof checked | 8.88e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/34 | proven | 5.830951895 | 5.830951895 | proven; proof checked | 1.78e-15 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/36 | proven | 6.000000000 | 6.000000000 | proven; proof checked | 1.78e-15 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/37 | proven | 6.082762530 | 6.082762530 | proven; proof checked | 1.78e-15 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/40 | proven | 6.324555320 | 6.324555320 | proven; proof checked | 8.88e-16 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/41 | proven | 6.403124237 | 6.403124237 | proven; proof checked | 1.78e-15 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/45 | proven | 6.708203932 | 6.708203932 | proven; proof checked | 1.78e-15 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/sq/4/49 | proven | 7.000000000 | 7.000000000 | proven; proof checked | 1.78e-15 | Blair et al. 2012, sec. II.A.1; density one (P is a sum of two squares) |
| torus/hex/0/1 | proven | 2.000000000 | 2.000000000 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/2 | proven | 3.464101615 | 3.464101615 | proven; proof checked | 0.00e+00 | Brandt et al. 2019, Thm 1.1; L = 2 sqrt3 (3-point lattice minus one) |
| torus/hex/0/2 | proven | 3.464101615 | 3.464101615 | proven | 0.00e+00 | Dickinson et al. 2011, J. Geom. (not read); L = 2 sqrt3 |
| torus/hex/0/3 | proven | 3.464101615 | 3.464101615 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/3 | proven | 3.464101615 | 3.464101615 | proven; proof checked | 0.00e+00 | Brandt et al. 2019, Thm 1.1; L = 2 sqrt3 |
| torus/hex/0/4 | proven | 4.000000000 | 4.000000000 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/4 | proven | 4.000000000 | 4.000000000 | proven; proof checked | 0.00e+00 | Brandt et al. 2019, Thm 1.1; L = 4 |
| torus/hex/0/5 | best known | 5.048675598 | — | proven |  | Dickinson et al. 2011, J. Geom. (not read); optimal packing proven there; no published value seen |
| torus/hex/0/6 | best known | 5.291502622 | 5.291502622 | proven | 0.00e+00 | Dickinson et al. 2011, J. Geom. (not read); 7-point lattice minus one disk, L = 2 sqrt7 (as described by Connelly-Dickinson 2014, sec. 1(d)) |
| torus/hex/0/7 | proven | 5.291502622 | 5.291502622 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/8 | best known | 6.000000000 | 6.000000000 | conjecture | 0.00e+00 | Connelly and Dickinson 2014, Conjecture 1.3; density gap conjecture: (P + 1)-lattice minus one disk |
| torus/hex/0/9 | proven | 6.000000000 | 6.000000000 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/11 | best known | 6.928203230 | 6.928203230 | conjecture | 0.00e+00 | Connelly and Dickinson 2014, Conjecture 1.3; density gap conjecture: (P + 1)-lattice minus one disk |
| torus/hex/0/12 | proven | 6.928203230 | 6.928203230 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/13 | proven | 7.211102551 | 7.211102551 | proven; proof checked | 8.88e-16 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/15 | best known | 8.000000000 | 8.000000000 | conjecture | 0.00e+00 | Connelly and Dickinson 2014, Conjecture 1.3; density gap conjecture: (P + 1)-lattice minus one disk |
| torus/hex/0/16 | proven | 8.000000000 | 8.000000000 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/19 | proven | 8.717797887 | 8.717797887 | proven; proof checked | -1.78e-15 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/21 | proven | 9.165151390 | 9.165151390 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/25 | proven | 10.000000000 | 10.000000000 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/27 | proven | 10.392304845 | 10.392304845 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/28 | proven | 10.583005244 | 10.583005244 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/31 | proven | 11.135528726 | 11.135528726 | proven; proof checked | 1.78e-15 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/36 | proven | 12.000000000 | 12.000000000 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/37 | proven | 12.165525061 | 12.165525061 | proven; proof checked | 1.78e-15 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/39 | proven | 12.489995997 | 12.489995997 | proven; proof checked | -1.78e-15 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/43 | proven | 13.114877049 | 13.114877049 | proven; proof checked | 1.78e-15 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/48 | proven | 13.856406461 | 13.856406461 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/hex/0/49 | proven | 14.000000000 | 14.000000000 | proven; proof checked | 0.00e+00 | Connelly and Dickinson 2014, Thm 1.1; triangular lattice, density pi/sqrt12 |
| torus/free/0/1 | proven | 1.861209718 | 1.861209718 | proven; proof checked | 0.00e+00 | Fukshansky 2011, Thm 1.1; densest lattice packing of disks: the hexagonal lattice, density pi/sqrt12 (first proved by Lagrange 1773) |
| torus/free/0/1 | proven | 1.861209718 | 1.861209718 | proven | 0.00e+00 | Lagrange 1773 (not read); the origin of the densest lattice packing of disks; the record cites Fukshansky 2011 for a proof |
| torus/free/0/1 | proven | 1.861209718 | 1.861209718 | proven | 0.00e+00 | Thue 1910; hexagonal lattice, density pi/sqrt12 (a theorem for the plane) |
| torus/free/3/1 | proven | 0.805927449 | 0.805927449 | proven; proof checked | -3.33e-16 | Sriamorn 2016, Thm 1.1; densest lattice packing of a triangle, density 2/3 |
| torus/free/3/1 | proven | 0.805927449 | 0.805927449 | proven | -3.33e-16 | Fary 1950, Theoreme 1; every convex domain has a lattice packing of density at least 2/3, denser unless it is a triangle; for a triangle this gives a lattice of density 2/3. The paper does not prove that no lattice packing of a triangle is denser (Sriamorn 2016 does) |
| torus/free/3/1 | proven | 0.805927449 | 0.805927449 | best known | -3.33e-16 | Torda et al. 2022 (p1); densest lattice packing, numerical table density 0.66666; score from the [CALC] value 0.6666666666667 |
| torus/free/5/1 | best known | 1.450926546 | 1.450926546 | best known | -3.82e-14 | Torda et al. 2022 (p1); densest lattice packing, numerical table density 0.81725; score from the [CALC] value 0.8172560023684 |
| torus/free/5/2 | best known | 1.932575335 | 1.932575335 | proven unrefereed | 0.00e+00 | Kuperberg and Kuperberg 1990; Hales and Kusner 2016; pentagonal ice-ray double lattice, density (5 - sqrt5)/3; optimality: computer-assisted preprint proof for the plane |
| torus/free/7/1 | best known | 2.055368878 | 2.055368878 | best known | 3.51e-14 | Torda et al. 2022 (p1); densest lattice packing, numerical table density 0.86019; score from the [CALC] value 0.8601910243450 |
| torus/free/7/2 | best known | 2.853328180 | 2.853328180 | best known | 8.88e-16 | Kuperberg and Kuperberg 1990; densest double lattice of the regular heptagon, density 0.8926906861 = (2/97)(-111 + 492 cos(pi/7) - 356 cos^2(pi/7)) (J. Baez, AMS Visual Insight 2014) |
| torus/free/8/1 | best known | 2.308338607 | 2.308338607 | best known | 1.33e-15 | Torda et al. 2022 (p1); densest lattice packing, numerical table density 0.90616; score from the [CALC] value 0.9061636786439 |
| torus/free/8/1 | best known | 2.308338607 | 2.308338607 | proven | 1.33e-15 | L. Fejes Toth 1950; densest packing of congruent regular octagons is the lattice packing, density (4 + 4 sqrt2)/(5 + 4 sqrt2) (the octagon's value computed here) |

Notes on the comparison:

- [CALC] **Disks on the square torus, P = 13.** Our certified packing has L ≤ 7.19041637230147, density 0.789924 and radius 0.139074 on the unit torus, with 26 contacts. Connelly–Funkhouser–Kuperberg–Solomonides (2017, table on p. 22) list δ = 0.788 and r = 0.139 for 13 disks, and offer their 10–16-disk packings as conjectured optimal. Our δ would print as 0.790, so the certified packing is denser than their table entry. That r column, rounded to 3 decimals, is consistent with both packings.
- **Disks, P = 11 and 14.** Our values lie inside the brackets implied by the same table.
- **Disks on the hexagonal torus, P = 5.** Our 5.0486756 equals an independent numerical maximisation run by the literature reviewer; the published optimum (Dickinson et al. 2011) was not read. Our packing has 9 contacts, as in W. Dickinson's 2011 Fields Institute slides, and L² = 14 + 2√33 to 5e-17 [CALC; SPEC closed form].
- **New values.** P = 10 and 14 on the hexagonal torus have no published values that we found.
- **Squares on the square torus, P = 12.** Our float value is 4.6e-12 above 5/√2; the polish stopped there.


## 6. Literature (verified 2026-10-24; proofs checked 2026-10-25)

Values are converted to PolyPack units (disks of radius 1: L = 1/r for radius r and L = 2/d for minimal distance d on the unit torus; squares of side 1: L = √(P/ρ) for density ρ). "Read" means the paper itself was read; "not read" means only abstracts or other papers' descriptions were.

- **Disks, square torus.** [EST]
  - P = 2–4 on every flat torus: M. Brandt, W. Dickinson, A. Ellsworth, J. Kenkel, H. Smith, "Optimal packings of two to four equal circles on any flat torus", *Discrete Math.* 342(12) (2019) 111597, Theorem 1.1, doi:10.1016/j.disc.2019.111597, [arXiv:1708.05395](https://arxiv.org/abs/1708.05395) (read). With v1 = (1, 0) and v2 = (0, 1), regions R1₂, R1₃ and R1₄ of their Table 1 give r₂ = √2/4 and r₃ = r₄ = (√6 − √2)/4.
  - P = 6, 7, 8 by a computer-assisted proof (an enumeration of irreducible toroidal contact graphs): O. R. Musin, A. V. Nikitenko, "Optimal packings of congruent circles on a square flat torus", *Discrete Comput. Geom.* 55(1) (2016) 1–20, Theorems 1–3, doi:10.1007/s00454-015-9742-6, [arXiv:1212.0649](https://arxiv.org/abs/1212.0649) (read): d₆ = √3/2 − √2 √(3√3 + 2)/6 + 1/6, d₇ = d₈ = 1/(1 + √3). P = 9 is their Conjecture 2.1 (d₉ = 1/√(5 + 2√3)).
  - P = 9, numerically: V. V. Voloshinov, S. A. Smirnov, *Communications in Computer and Information Science* (Springer, 2019) 87–97, doi:10.1007/978-3-030-36592-9_8, [arXiv:1809.10525](https://arxiv.org/abs/1809.10525) (read), reach the conjectured arrangement with a floating-point branch and bound (ParaSCIP) and call it a computer-aided proof; with the solver's numerical tolerances it is no rigorous proof.
  - P ≤ 5: W. Dickinson, D. Guillot, A. Keaton, S. Xhumari, "Optimal packings of up to five equal circles on a square flat torus", *Beitr. Algebra Geom.* 52(2) (2011) 315–333, doi:10.1007/s13366-011-0029-7 (not read; its values as quoted by Musin–Nikitenko, Fig. 2).
  - Earlier proofs, not read: A. Heppes, "Densest circle packing on the flat torus", *Period. Math. Hungar.* 39 (1999) 129–134, doi:10.1023/A:1004847008346 (2–4 circles on every rectangular torus, as described by Brandt et al., who correct a factor in two of its formulas); J. B. M. Melissen, *Packing and covering with circles*, PhD thesis, Utrecht University, 1997 (1–4 circles on the square torus, as described by Brandt et al.); A. Przeworski, "Packing disks on a torus", *Discrete Comput. Geom.* 35 (2006) 159–174, doi:10.1007/s00454-005-1198-7 (two circles on every flat torus, Theorem 2.3, as described by Brandt et al.).
  - Best known for P = 10–16 (conjectures, radius given to 3 decimals): R. Connelly, M. Funkhouser, V. Kuperberg, E. Solomonides, *Discrete Comput. Geom.* 58(3) (2017) 614–642, doi:10.1007/s00454-016-9843-x, [arXiv:1512.08762](https://arxiv.org/abs/1512.08762) (read). B. D. Lubachevsky, R. L. Graham, F. H. Stillinger, *Period. Math. Hungar.* 34 (1997) 123–142 study thousands of disks and give no small-P table.
- **Disks, hexagonal torus.** [EST]
  - R. Connelly, W. Dickinson, "Periodic planar disc packings", *Phil. Trans. R. Soc. A* 372 (2014) 20120039, Theorem 1.1 (Theorem 1 in [arXiv:1201.5965](https://arxiv.org/abs/1201.5965)), doi:10.1098/rsta.2012.0039 (journal version read): on the triangular torus the density π/√12 is reached exactly when P = a² + ab + b² (the bound is Thue's theorem), so L = 2√P. Their density gap conjecture (Conjecture 1.3; Conjecture 2 on arXiv): if P + 1 has that form and P does not, the optimum is the (P + 1)-point lattice minus one disk, L = 2√(P + 1).
  - P = 2–4: Brandt et al. 2019, Theorem 1.1 at v2 = (1/2, √3/2) (regions R1₂, R2₃, R2₄): r₂ = r₃ = 1/(2√3), r₄ = 1/4.
  - P = 1–6: W. Dickinson, D. Guillot, A. Keaton, S. Xhumari, "Optimal packings of up to six equal circles on a triangular flat torus", *J. Geom.* 102(1-2) (2011) 27–51, doi:10.1007/s00022-011-0099-6 (not read). Connelly–Dickinson §1(d) (§1.4 on arXiv) describe it: one locally maximally dense packing for each P ≤ 6, for P = 6 the 7-point lattice minus one disk (L = 2√7), and for P = 5 a packing with threefold dihedral symmetry, whose value we have not seen.
- **Squares, square torus.** [EST]
  - D. W. Blair, C. Santangelo, J. Machta, "Packing squares in a torus", *J. Stat. Mech.* (2012) P01018, doi:10.1088/1742-5468/2012/01/P01018, [arXiv:1110.5348](https://arxiv.org/abs/1110.5348) (read). Section II.A.1 shows that a density-one packing exists when P is a sum of two squares, which no packing can beat (they call it optimal by construction), and that density one occurs only then. All other entries of their Table I (P ≤ 27) are conjectures from simulated annealing (gapped bricklayer for P = 6, 11, 14; a lattice of ½ × ½ holes for P = 12 and 23; one 45° square for P = 21).
  - A. V. Reztsov, I. H. Sloan, "On 2D packings of cubes in the torus", *Proc. Amer. Math. Soc.* 125 (1997) 17–26, doi:10.1090/S0002-9939-97-03930-0 (abstract only): the largest number of squares of side 1/λ in the unit torus, apparently of translates of one axis-parallel square [SPEC], so not our problem, in which the squares turn. T. Gensane, P. Ryckelynck, "Square packings in the flat torus", *Geombinatorics* 17(4) (2008) 141–156 (not read).
- **Densest lattice packings (free, P = 1).** [EST] One piece on a free torus is a lattice packing of it, so `free/N/1` is the densest lattice packing.
  - Disks: δ_L = π/√12, first proved by J. L. Lagrange, "Recherches d'arithmétique", *Nouv. Mém. Acad. Roy. Sci. Belles-Lettres Berlin* (1773) 265–312 (not read; cited in the Handbook chapter below, Table 2.1.3). A proof we read: L. Fukshansky, "Revisiting the hexagonal lattice: on optimal lattice circle packing", *Elem. Math.* 66(1) (2011) 1–9, Theorem 1.1, doi:10.4171/EM/163 (read: the [author's copy](https://www1.cmc.edu/pages/faculty/lenny/papers/hexagon.pdf)): every lattice in R² gives a circle packing of density at most π/(2√3) = π/√12, with equality only for lattices similar to the hexagonal one. So L = √(2√3) for `free/0/1`.
  - Triangles: I. Fáry, "Sur la densité des réseaux de domaines convexes", *Bull. Soc. Math. France* 78 (1950) 152–161, Théorème 1, doi:10.24033/bsmf.1413, [Numdam](http://www.numdam.org/item/BSMF_1950__78__152_0/) (read): every convex domain has a lattice packing of density at least 2/3, denser unless it is a triangle. The proof constructs the lattice; it does not show that no lattice packing of a triangle is denser. That upper bound is in K. Sriamorn, "On the multiple packing densities of triangles", *Discrete Comput. Geom.* 55(1) (2016) 228–242, Theorem 1.1, doi:10.1007/s00454-015-9748-0, [arXiv:1501.00467](https://arxiv.org/abs/1501.00467) (read): for every triangle T and k ≥ 1 the k-fold translative and lattice packing densities are 2k²/(2k + 1), the upper bound proved with stair polygons (§§4–5); k = 1 gives δ_L(T) ≤ δ_T(T) = 2/3. So δ_L(triangle) = 2/3 and L = √(3√3/8) for `free/3/1`. The value 2/3 also follows from Minkowski's relation δ_L(K) = 4 δ_L(K − K) A(K)/A(K − K), since T − T is a hexagon of area 6 A(T).
  - Polygons, numerically: M. Torda, J. Y. Goulermas, V. Kurlin, G. M. Day, *Phys. Rev. E* 106 (2022) 054603, doi:10.1103/PhysRevE.106.054603, [arXiv:2207.08959](https://arxiv.org/abs/2207.08959), Table I, plane group p1: triangle 0.66666, pentagon 0.81725, heptagon 0.86019, octagon 0.90616 (5 decimals, from an approximate optimisation). [CALC] `python/torus/lattice_density.py` (critical determinant of K − K) gives 2/3, 0.8172560024, 0.8601910243, 0.9061636786, equal to our P = 1 entries to 10 digits; the pentagon value equals 10/(10 + √5) to 3e-16 [SPEC closed form].
- **Centrally symmetric pieces.** [EST] L. Fejes Tóth, "Some packing and covering theorems", *Acta Sci. Math. (Szeged)* 12A (1950) 62–67: for a centrally symmetric convex disk K the densest packing of congruent copies has the lattice density, δ(K) = δ_T(K) = δ_L(K) (G. Fejes Tóth, "Packing and covering", *Handbook of Discrete and Computational Geometry*, 3rd ed., ch. 2, p. 29, [preprint](http://www.csun.edu/~ctoth/Handbook/chap2.pdf)). For the regular octagon δ_L = (4 + 4√2)/(5 + 4√2) = 0.9061636786 [CALC]. With the lifting of §1, every `free` octagon entry built on the lattice packing is optimal, and the octagon bound applies to `sq` and `hex`; the theorem is about the plane, so these records stay `best_known`. Disks: Thue's theorem δ = π/√12 (same chapter, Table 2.1.1).
- **Pentagons.** [EST] The pentagonal ice-ray double lattice has density (5 − √5)/3 (G. and W. Kuperberg, *Discrete Comput. Geom.* 5 (1990) 389–397, as quoted by Y. Kallus and W. Kusner, "The local optimality of the double lattice packing", *Discrete Comput. Geom.* 56 (2016) 449–471, [arXiv:1509.02241](https://arxiv.org/abs/1509.02241)). T. Hales and W. Kusner, [arXiv:1602.07220](https://arxiv.org/abs/1602.07220) v2, prove by computer that no packing of congruent regular pentagons is denser; no refereed publication was found, so this bound rests on a preprint.
- **Heptagons.** [EST] The best known packing is the Kuperbergs' double lattice, density 0.8926906861 = (2/97)(−111 + 492 cos(π/7) − 356 cos²(π/7)) (J. Baez, AMS Visual Insight, 15 Nov 2014); no sharp upper bound is proven (Kallus–Kusner).
- **Search method.** [EST] Torquato and Jiao's adaptive shrinking cell and its LP form (references in §4).


## 7. Proven records

A record is `proven` only when a refereed paper, read and checked, proves that exact torus case: the same torus shape, piece, count and objective. Its literature entry then carries the DOI and, in `proof`, the theorem or section; `build_records.py` sets the status from that entry, and the certifier refuses `proven` without one or when score_cert does not attain its value (§3). One piece on a free torus is a lattice packing of it by definition, so a theorem on the densest lattice packing of the piece proves `free/N/1` itself. Our own derivations, theorems about the plane, unrefereed preprints and papers we have not read do not count.

52 records are proven [EST, sources in §6]:

| records | proof | DOI |
|---|---|---|
| `sq/0/2`, `sq/0/3`, `sq/0/4` | Brandt et al. 2019, Theorem 1.1 (square torus, regions R1₂, R1₃, R1₄) | 10.1016/j.disc.2019.111597 |
| `sq/0/6`, `sq/0/7`, `sq/0/8` | Musin–Nikitenko 2016, Theorems 1, 2, 3 | 10.1007/s00454-015-9742-6 |
| `hex/0/2` | Brandt et al. 2019, Theorem 1.1 (triangular torus, region R1₂) | 10.1016/j.disc.2019.111597 |
| `hex/0/P`, P = 1, 3, 4, 7, 9, 12, 13, 16, 19, 21, 25, 27, 28, 31, 36, 37, 39, 43, 48, 49 | Connelly–Dickinson 2014, Theorem 1.1 (P = 3 and 4 also Brandt et al., regions R2₃, R2₄) | 10.1098/rsta.2012.0039 |
| `sq/4/P`, P = 1, 2, 4, 5, 8, 9, 10, 13, 16, 17, 18, 20, 25, 26, 29, 32, 34, 36, 37, 40, 41, 45, 49 | Blair–Santangelo–Machta 2012, §II.A.1 (density one when P is a sum of two squares) | 10.1088/1742-5468/2012/01/P01018 |
| `free/0/1` | Fukshansky 2011, Theorem 1.1 (densest lattice packing of disks, first proved by Lagrange 1773) | 10.4171/EM/163 |
| `free/3/1` | Sriamorn 2016, Theorem 1.1 with k = 1 (densest lattice packing of a triangle, 2/3; Fáry 1950 gives the lattice) | 10.1007/s00454-015-9748-0 |

[CALC] For each, score_cert exceeds the proven optimum by 1.000e-12 relative (the certificate's shrink) and score_float is within 4.2e-16 of it.

Covered by a proof that does not count, so `best_known`:

- `sq/0/1`, `sq/0/5` (Dickinson et al. 2011, *Beitr. Algebra Geom.*) and `hex/0/5`, `hex/0/6` (Dickinson et al. 2011, *J. Geom.*): the papers were not read. Other papers confirm the values of `sq/0/5` (Musin–Nikitenko, Fig. 2) and `hex/0/6` (Connelly–Dickinson §1(d)); for `hex/0/5` we have seen no published value. `sq/0/1` is also trivial (L ≥ 2).
- `sq/0/9`: a conjecture (Musin–Nikitenko), reached by a numerical branch and bound (Voloshinov–Smirnov).
- `free/0/P` for P ≥ 2, `free/8/P` for every P and `free/5/P` for even P: optimal by theorems about the plane (Thue; L. Fejes Tóth 1950) or by a preprint (Hales–Kusner), carried to the torus by the lifting of §1.
- `hex/3/1`: the triangle's lattice optimum 2/3 over all lattices (Sriamorn 2016; Fáry 1950) is attained by a hexagonal one (our specialisation).
- Area-bound cases, optimal by the trivial area argument, with no published statement for the torus that we found: `hex/6/P` for P = a² + ab + b², `hex/3/P` for P = 2(a² + ab + b²), `free/3/P` for even P, `free/4/P` and `free/6/P` for every P.
- [CALC] P = 1 on `sq` (N = 3, 5, 6, 7, 8) and on `hex` (N = 3): our rigorous branch and bound equals the value. This is our own computation, not a published proof.

## 8. Limitations and open questions

- The search is heuristic. Where no bound is attained (most `sq`/`hex` polygon entries and odd P for `free` triangles, pentagons and heptagons), values are best found, not optimal; budgets were modest (phase B scale 0.6, about 70–130 local solves for P = 16).
- The three records that were still creeping are now converged at a fixed contact set (see the rerun). The rerun found improvements of up to 2 % for triangles on the hexagonal torus, so other unbounded entries, especially for pentagons to octagons on `sq`/`hex`, may still improve with more search. The certificates prove validity, not optimality.
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
python3 python/torus/polish_raw.py --raw data/torus/raw --pattern hex_7_11.json --deep 200 --slsqp 60
python3 python/torus/p1_bound.py data/torus/p1_bounds.json
python3 python/torus/extend_torus.py --raw data/torus/raw --out data/torus/raw_ext --Pmax 49 --octagons
python3 python/torus/build_records.py --raw data/torus/raw --raw-ext data/torus/raw_ext --out data/torus
python3 python/torus/build_records.py --raw data/torus/raw --raw-ext data/torus/raw_ext --out data/torus --only-improve data/torus/records.json
python3 python/torus/build_records.py --refresh data/torus/records.json --out data/torus
python3 python/torus/certify_torus.py data/torus/records.json
python3 python/torus/test_certify_torus.py
python3 python/torus/test_torus_tools.py
python3 python/torus/lattice_density.py
python3 python/torus/doc_tables.py data/torus/records.json
python3 python/torus/doc_tables.py data/torus/records.json --compare
npx tsc -p packages/torus --noEmit
npx vitest run packages/torus
npx tsx packages/torus/viz/build.ts
```

Python is the anaconda build used for the run (numpy 1.21.5, scipy 1.7.3, mpmath 1.2.1). Searches use `nice -n 10` and single-threaded BLAS. Seeds are recorded per record; the LP time limit makes a rerun on a much slower machine able to differ.
