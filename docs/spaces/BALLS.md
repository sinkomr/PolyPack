# 3D in 3D: balls in a ball or a solid, solids in a ball

The second kind of 3D in 3D, beside Polyhedra ([POLYHEDRA.md](POLYHEDRA.md)): P balls of diameter 1 (radius 1/2) packed in
the smallest ball or the smallest copy of any of the polyhedra space's 94 solids (a cube, a Catalan solid, a prism,
an antiprism, ...), and P unit-edge solids, any of the 94 (tetrahedra, cubes, ..., triakis tetrahedra, prisms), packed
in the smallest ball, for P = 2 to 100: 189 problems and 18,711 cases. The score is the container's size s: the diameter
of the container ball, or the scale of the container solid (the edge of the cube); smaller is better. This follows
PolyPack's 2D conventions (N = 0 for circle pieces of diameter 1, M = 0 for circle containers, the score of a circle
container its diameter). Since 2026-10-27 balls have diameter 1 and a ball container is scored by its diameter; before, balls had radius 1 and the score was the radius. The space had no records, so only entries and the test packings were affected (§4). In code and data the space is called `balls`.

**Summary** (2026-10-25; the solids as containers and as pieces 2026-10-26).

- The space started with 7 problems (balls in a ball and in a cube, the five Platonic solids in a ball) and has 189:
  balls in each of the 94 solids, and each of the 94 solids in a ball (§1). The first 7 keep their codes and ids,
  and the volunteers' default draw still samples these 7 only (`BALLS_ORIGINAL_CODES`, §7).
- The space ships **without research records**. Its 18,711 problems are given by a domain (`ballsDomain`, registered
  in `SPACE_DOMAINS` of `packages/spaces/src/domain.ts`: the 189 codes and P = 2 to 100), each answered with an
  elementary lower bound and the status `no_record`; the site's board, the volunteer client and later research fill
  them in. The first valid entry of a problem is kept, then better ones; every entry must pass the strict check (§7).
- What ships is the machinery: the float validator, the search the board and the volunteer client run, the board's
  three.js drawing, and a rigorous certifier for records to come (`python/balls/certify.py`: exact rational
  arithmetic for balls in a ball or a cube, 170-bit interval arithmetic for balls against the faces of another solid,
  exact rotations and interval arithmetic with explicit separating planes for solids). 42 test packings (the first
  7 kinds at P = 2, 5, 13, 30, 80 and 100) and short searches on every new problem at small P prove that they work;
  they are test data, not records.
- Published values (Packomania's best known packings, and the proven optima of balls in a cube) are listed in §3
  as benchmarks. No published coordinates are used.

Labels: [EST] established and sourced, [CALC] computed here, [SPEC] speculation.

## 1. Problem

**Problems and ids.** A problem is named by a code `<piece>in<container>`, in the manner of the polyhedra space,
with `ball` or one of the polyhedra space's solid codes (`tet`, `cub`, `oct`, `dod`, `ico`, `tte`, `ktt`, `pr3`,
`pr3l15`, `ap5`, `bp7`, `tz8`, ...) for the piece or the container: `ballinball` (balls in a ball),
`ballin<solid>` (balls in that solid: `ballincub` in a cube, `ballinpkd` in a pentakis dodecahedron, `ballinpr3` in a
triangular prism) and `<solid>inball` (that solid in a ball: `tetinball`, `kttinball`, `pr3l15inball`). That is 1 + 94
+ 94 = 189 codes, 182 of them new; the first 7 (`ballinball`, `ballincub`, `tetinball`, `cubinball`, `octinball`,
`dodinball`, `icoinball`) are as they were. With P pieces the id is `balls/<code>/<P>`, e.g. `balls/ballinball/13`,
`balls/ballinpkd/20`, `balls/pr3l15inball/7`. Ids are accepted only in that one written form. Titles read
"Balls in a pentakis dodecahedron", "Triakis tetrahedra in a ball", "Balls in a triangular prism of height 1.5". The
board's menu groups the codes (balls in a ball or a Platonic solid, in an Archimedean, a Catalan solid, a prism, an
antiprism, an elongated prism, a bipyramid, a trapezohedron; then the solids of each family in a ball; prisms by
sides, elongated ones by sides and height).

**Units and container.** Balls have radius `BALL_RADIUS` = 1/2, diameter 1 (`catalogue.ts`; `BALL_RADIUS` in
`python/balls/balls_catalogue.py`): every length in this space that is a ball's size is written through that one
constant, in the validator, the bounds, the search, the kernel, the certifier and the drawing. The solids are the
polyhedra space's canonical solids (`python/polyhedra/solids_exact.json`), centred at their vertex centroid, in their
canonical orientation: edge 1 for the Platonic, Archimedean, prism and antiprism solids, the lateral edges 1.5, 2 or
3 for the elongated prisms, the Catalan, bipyramid and trapezohedron solids the polar duals of unit-edge solids. The
container is s times the canonical container, centred at the origin: the ball of diameter s (radius s / 2), or the canonical solid
scaled by s (for the cube the cube [-s/2, s/2]^3 with its faces normal to the axes, the polyhedra space's unit cube
scaled by s).

**Configuration.** `{s, pieces}` with P pieces: a ball is its centre `[x, y, z]`; a solid is
`[x, y, z, qw, qx, qy, qz]`, the canonical solid turned by the rotation of q / |q| (v -> q v q*, the matrix
H(q) / |q|^2) and centred at (x, y, z), as in the polyhedra space.

**Validity.** Pieces may touch; their interiors are disjoint and they lie in the closed container:

- two balls: |c_i - c_j| >= 2 r = 1;
- a ball (radius r = 1/2) in the ball (radius s / 2): |c| <= s / 2 - r; in the cube: |c_k| <= s/2 - r for k = 1, 2, 3; in any other solid
  C: N_f . c <= s b_f - r for every face f, N_f the unit outward normal and b_f the offset of the canonical solid's
  face f [EST, elementary: the ball lies in the half-space N_f . x <= s b_f iff its centre is r inside the plane, and
  a convex polyhedron is the intersection of its face half-spaces]. So the centres lie in the container "shrunk
  inward by r", a polyhedron with the same normals and offsets s b_f - r (for a solid with all b_f equal to its
  inradius rho, the scaled solid (s - r / rho) C); the cube is the special case with N = +-e_k and b = 1/2;
- a solid in the ball: every vertex has |x| <= s / 2 (a convex solid lies in a ball when its vertices do);
- two solids: disjoint interiors, decided by the separating-axis test of the polyhedra space (face normals of both
  and the Gauss-map pruned cross products of their edges, which decide the penetration depth exactly).

The float validator (`packages/balls/src/validate.ts`) applies these at PolyPack's tolerance 1e-9: an overlap or
protrusion deeper than 1e-9 rejects the configuration.

**Score and bounds.** s. Every problem carries the largest of three elementary lower bounds [EST], written with the ball radius r = 1/2 and, for a ball container, its radius rho_B = s / 2: the volume bound (the pieces' total volume is at most the container's: s >= P^(1/3) for balls in a ball, since (s/2)^3 >= P (1/2)^3; s >= (pi P / 6)^(1/3) for balls in a cube, s >= (pi P / (6 V))^(1/3) for balls in another solid of volume V, and s >= 2 (3 P v / (4 pi))^(1/3) for solids of volume v in a ball); one piece (s >= twice the circumradius of a solid, the centre of its smallest enclosing ball being its vertex centroid; s >= r / rho for a ball in a solid of inradius rho, so s >= 1 for a ball in a cube); two pieces (two balls have centres at least 1 apart in the ball of radius (s - 1) / 2, so s >= 2, or in the cube of edge s - 1 whose diameter is (s - 1) sqrt 3, so s >= 1 + 1 / sqrt 3; in a solid with all faces at its inradius rho and diameter D (the tangential solids: the Platonic, Catalan, bipyramid and trapezohedron ones) the centres lie in (s - r / rho) C, so s >= r / rho + 2 r / D, which two balls at the ends of a diameter attain exactly, a test checks it; in any solid the width of the shrunk container in every direction is the solid's less 2 r, so a pair 2 r apart needs a direction of width 4 r, s >= 4 r / D; two solids hold disjoint balls of their inradius, so a ball container has radius at least 2 times that inradius, s >= 4 times it). The bounds are far below the best known values: they only refuse sizes that are plainly impossible. (Before 2026-10-27, with radius-1 balls: balls in a ball and the solids' ball bounds were radii, so a solid's bound doubled, and every size for a ball in a solid was twice as large.)

**Two facts about the 94 solids** [EST, and checked by a linear programme and a minimisation on the data to 4e-16]:
the vertex centroid is the centre of each solid's largest inscribed ball and of its smallest enclosing ball, so the
inradius (the least face offset) and the circumradius (the largest vertex distance) the bounds, the search and the
kernel use are the true Chebyshev and enclosing radii, also for the long and the spiky ones (the circumradius is up to
5.6 times the inradius: the triangular prism of height 3 has inradius 0.289 and circumradius 1.607; the 12-gonal
trapezohedron 1.853 and 8.497). The reason: the unique smallest enclosing ball is mapped to itself by every
symmetry, an inscribed ball of the Chebyshev radius can be averaged over the symmetry group, and the only point
fixed by each solid's symmetry group (the Platonic, Archimedean and Catalan point groups, the dihedral groups D_nh
and D_nd of the prisms, antiprisms, elongated prisms, bipyramids and trapezohedra, n >= 3) is the centroid.

## 2. A domain without records, and records to come

The space's problems are its domain, `ballsDomain` (`packages/balls/src/problems.ts`): the fields `code` (the 189
codes, with their titles and the menu's groups) and `P` (2 to 100), 18,711 problems; `bound(id)` gives a problem's
elementary bound, and `sample(limit)` the problems in the order the volunteers' work list offered them until it was
removed on 2026-10-29, small P first, from the first 7 codes only (693 problems). All 18,711 are on the board and the
API, open to entries, and since then in the volunteer client's random draw. `packages/spaces`
loads the space without a records file (`SPACE_DOMAINS`, `buildSpaceCatalogue`, `problemOf`): its catalogue holds no
records, and any id of the domain answers with `status: "no_record"`, `certified: null` and its bound. Nothing of
the space is in `data/`; the image copies no data for it.

A research record added later goes in `data/balls/records.json`, as the polyhedra space keeps its records: the index
there, the configurations in `data/balls/configs/<code>.jsonl` (one line `{"P", "config"}` per P, at each record's
`config_at`); a record then takes the place of its listed problem. `python/balls/certify.py` checks such a file
(§4). Records should keep a clearance of 1e-10 between pieces and from the container, so that their stored binary64
numbers are valid exactly; the exact certificates need no more, and removing 1e-10 cannot beat a record by the tie
tolerance 1e-9 [CALC: the clearance costs at most about g / (2 r) + w / s of s relative, r the piece's inradius:
about 4e-10 for tetrahedra and 1e-10 for balls], so the space's record margin is the tie tolerance itself
(`SPACE_RECORD_MARGIN.balls` = 1e-9). The polyhedra records keep the wiki's 1e-7, hence that space's margin of 1e-6.

## 3. Literature: benchmarks and proofs

**Packomania** (E. Specht, https://www.packomania.com/): the best known packings of equal spheres in a sphere
(`ssp`, page of 13 July 2026, complete to N = 1000) and in a cube (`scu`, 17 October 2026). Packomania normalises
the container (radius 1, or edge 1) and gives the spheres' radius r; for balls of diameter 1 the score is 1 / r in a ball (the container's diameter over the ball's) and 1 / (2 r) in a cube (before 2026-10-27, with radius-1 balls, 1 / r for both). **Terms:**
the pages carry no licence; they state a copyright of E. Specht (`<meta name="copyright">` and the footer
"(c) E. Specht"). So the values are cited as benchmarks, and no coordinates were copied or used [EST, read
2026-10-25]. Packomania marks proven optima in bold; no entry of N <= 100 is bold on either page. Some of its
values, as 1 / r (balls in a ball) and 1 / (2 r) (cubes) from r printed at 12 decimals (about 1e-11 absolute; the cube column is half the former 6-decimal value and shows 7 decimals where needed) [EST]:

| P | balls in a ball, s | balls in a cube, s |
|---|---|---|
| 2 | 2.000000 | 1.5773505 |
| 3 | 2.154701 | 1.707107 |
| 4 | 2.224745 | 1.707107 |
| 5 | 2.414214 | 1.894427 |
| 6 | 2.414214 | 1.942809 |
| 7 | 2.591254 | 1.9989115 |
| 8 | 2.645329 | 2.000000 |
| 9 | 2.732051 | 2.1547005 |
| 10 | 2.832465 | 2.3333335 |
| 11 | 2.902113 | 2.408220 |
| 12 | 2.902113 | 2.4142135 |
| 13 | 3.000000 | 2.4142135 |
| 14 | 3.091145 | 2.4142135 |
| 20 | 3.473539 | 2.8025775 |
| 30 | 3.916492 | 3.1213205 |
| 50 | 4.550454 | 3.6777005 |
| 100 | 5.635733 | 4.4890415 |

Packomania's other references for these tables include Th. Gensane, Dense packings of equal spheres in a larger
sphere, Cahiers du LMPA 188 (2003); H. Pfoertner's pages (2005, 2013); W. Huang, L. Yu, Serial symmetrical
relocation algorithm for the equal sphere packing problem (2012, arXiv:1202.4149); Th. Gensane, Dense packings of
equal spheres in a cube, Electron. J. Combin. 11 (2004) #R33; M. Tatarevic, On limits of dense packing of equal
spheres in a cube, Electron. J. Combin. 22 (2015) #P1.35.

**Proven cases, balls in a cube** [EST]. With d_n the largest smallest distance of n points in the unit cube, the
smallest cube for n balls of diameter 1 has edge s = 1 + 1 / d_n (with radius-1 balls, 2 + 2 / d_n). Gensane (2004, §3) states that Schaer (1966) "gave the
solutions for n = 2, 3, 4, 5, 6, 8, 9, the case n = 10 have been treated in [Schaer 1994]. These results are the
only ones of optimality proved in the cube"; Tatarevic (2015, introduction) states "the optimality of d_n is
proved for n=2,3,4,5,6,8,9 [Schaer 1966], n=10 [Schaer 1994] and n=14 [Joos 2009]". The case n = 7 is open by
both (Gensane: Schaer's 1966 configuration is not optimal; the best known one is conjectured optimal).

| n | d_n | s = 1 + 1 / d_n | proof |
|---|---|---|---|
| 2 | sqrt 3 | 1.577350 | J. Schaer, On the densest packing of spheres in a cube, Canad. Math. Bull. 9 (1966) 265-270, doi:10.4153/CMB-1966-033-0 |
| 3, 4 | sqrt 2 | 1.707107 | the same |
| 5 | sqrt 5 / 2 | 1.894427 | J. Schaer, The densest packing of five spheres in a cube, Canad. Math. Bull. 9 (1966) 271-274, doi:10.4153/CMB-1966-034-8 |
| 6 | 3 sqrt 2 / 4 | 1.942809 | J. Schaer, The densest packing of six spheres in a cube, Canad. Math. Bull. 9 (1966) 275-280, doi:10.4153/CMB-1966-035-5 |
| 8 | 1 | 2 | Schaer 1966 (265-270) |
| 9 | sqrt 3 / 2 | 2.154701 | Schaer 1966 (265-270) |
| 10 | 3 / 4 | 2.333333 | J. Schaer, The densest packing of ten congruent spheres in a cube, in: Intuitive Geometry (Szeged, 1991), Colloq. Math. Soc. János Bolyai 63, North-Holland (1994) 403-424 |
| 14 | sqrt 2 / 2 | 2.414214 | A. Joós, On the packing of fourteen congruent spheres in a cube, Geom. Dedicata 140 (2009) 49-80, doi:10.1007/s10711-008-9308-3 |

Read for this: Gensane 2004 (full text) and the introduction of Tatarevic 2015 (arXiv:1503.07933). Schaer's and
Joós's papers themselves were not read (they are behind paywalls); the attribution of each case rests on the two
surveys. With no records, no problem is `proven` here; a record that attains one of these optima to within its
clearance could be marked `proven` with the proof cited, and its problem closed.

**Balls in a ball.** No published proof of any case was found. The small best known configurations are those of
the Tammes problem (all centres on one sphere; Packomania cites the Tammes papers of Fejes Tóth 1943, Schütte and
van der Waerden 1951, Danzer 1963 and others for N <= 12), but no paper was found that proves the reduction to the
Tammes problem, nor even the elementary cases N = 2 to 4. Searched: Packomania's references, Huang and Yu (2012,
introduction read) and the Tammes literature.

**Platonic solids in a ball.** The one study found is E. G. Teich, G. van Anders, D. Klotsa, J. Dshemuchadse and
S. C. Glotzer, Clusters of polyhedra in spherical confinement, PNAS 113 (2016) E669-E678,
doi:10.1073/pnas.1524875113: isobaric Monte Carlo compressions of hard Platonic solids in a spherical container,
the densest of 50 runs for each N up to 60. It reports densities only as plots (its Fig. 4; the main text has no
table, and its supplement could not be read here), so no numbers are listed. One construction is elementary
[CALC]: up to 20 tetrahedra with a common vertex, one in the cone over each face of a regular icosahedron centred
there, lie in the ball of radius 1 (diameter 2, the score; seen from the centre, a face's vertices lie 37.38 degrees from its middle and a
tetrahedron's edges 35.26 degrees from its axis); `packages/balls/scripts/cones.ts` builds it, and a test checks it.

## 4. Certification

`python/balls/certify.py` (standard library; for solids it imports the polyhedra space's vendored
`certify_general.py`, MIT, see `THIRD_PARTY_NOTICES.md`) checks a records file's published fields (id in its one
form with 2 <= P <= 100; piece and container against the code; P pieces of 3 or 7 JSON numbers; `config.s ==
score_cert`; the display rule; the bound and that it is at most the score; status, and for `proven` a literature
entry naming its proof with an optimum at most the score; literature entries numbers with a source), then proves
the configuration valid (`certify_config`, also usable on its own):

- every JSON number is read as the exact rational it denotes;
- balls (radius r = `BALL_RADIUS`), exactly in rationals: |c_i - c_j|^2 >= (2 r)^2 for every pair; s >= 2 r and
  |c_i|^2 <= (s/2 - r)^2 in a ball; |c_ik| <= s/2 - r in a cube;
- balls in any other solid: for every ball and face, N_f . c + r |N_f| < s B_f, with the exact outward normals N_f
  (not unit) and offsets B_f of the container in its number field (`certify_general.Solid`, which checks the solid
  exactly: faces planar and supporting, the closed surface), decided with 170-bit fixed-point intervals with outward
  rounding, |N_f| bounded above by the fixed-point square root of an upper bound of N_f . N_f. These walls are
  certified strictly, as the solids' are: a ball touching the face of an irrational solid is refused rather than
  guessed (a cube's walls stay exact and closed);
- solids: the solid is checked exactly in its number field; each rotation is the exact rational matrix
  H(q) / |q|^2; every world vertex is enclosed with 170-bit fixed-point intervals with outward rounding, and an
  upper bound of |x|^2 must be below (s/2)^2 rounded down; every pair whose centres are closer than twice an upper bound
  of the circumradius is strictly separated by an explicit rational plane (floating point only proposes the axes),
  the others are farther apart than the sum of their circumradii.

Floating point never decides a check: a bad proposal can make a proof fail, never succeed. The balls' checks are
closed (touching balls pass); a solid pair is certified only when strictly separated.

**Tests** (`python3 python/balls/test_certify.py`, run by `npm run test:python`; 24 tests): exactly touching balls
and walls pass; overlaps and protrusions of 1e-9 and of one ulp of s fail; two cubes 1e-10 apart pass, 1e-9 into
each other or 1e-9 out of the ball fail, and exactly touching ones are not certified; a cube turned by 1e-3 rad into
its neighbour fails; an icosahedron 1e-10 inside and 1e-9 outside its ball, also with a quaternion of 5e48;
malformed numbers (strings, booleans, NaN, infinities, wrong lengths, zero quaternions, s <= 0); every field check,
wrong P and ids out of range; `proven` without a proof; the 42 test packings (all certified, wall gaps 1e-10; those
of P = 5 and 13 fail when their container is shrunk by 1e-8 relative); and the cross-check below. The 189-code catalogue, the solids' volume, inradius, circumradius, diameter and tangential
flag (computed from the exact solids' coordinates at 80 bits) and the bounds of every problem at P = 2, 13 and 100
agree with the TypeScript ones to 1e-12 (`fixtures/bounds.json`, written by `packages/balls/scripts/gen-bounds.ts`,
which a TypeScript test keeps current); a centred ball in the octahedron passes from s = sqrt 6 on and fails by 1e-15
relative below it; a ball against a hexagonal prism's end, pairs and walls together; unknown containers and malformed
input; and a record of a new problem through the field checks.

**Validator and certifier agree on the new containers** [CALC]. `fixtures/crosscheck_solids.json` (written by
`scripts/gen-crosscheck-solids.ts`) holds 702 cases: one ball against the walls of each of the 93 solids that are no
cube, with the container's size found so that the validator's wall gap is +-1e-7, +-1e-9 and +-1e-12, and for eight
solids as pieces (a truncated tetrahedron, triakis tetrahedron, triangular prism, square antiprism, triangular prism
of height 3, heptagonal bipyramid, hexagonal trapezohedron and pentagonal hexecontahedron) two pieces at pair
separations of the same gaps and one against the ball's wall. The certifier is exact and the validator's floats err by
about 1e-16 of the sizes, so they agree wherever the gap exceeds 1e-13: the certifier proves all 351 cases measured
as separated by more than that and refuses all 351 measured as overlapping (`test_certify.py`; a TypeScript test checks
the stored gaps, `test/containers.test.ts`).

**Validator and certifier agree** [CALC]. `python/balls/fixtures/crosscheck.json` (written by
`packages/balls/scripts/gen-crosscheck.ts`) holds 140 near-contact cases: for each problem, two pieces in random
orientations moved to separations of +-1e-7 and +-1e-9, and one piece at wall gaps of +-1e-7 and +-1e-9, with the
validator's measured gaps. The certifier proves every case the validator measures as separated by more than 1e-10
and refuses every case it measures as overlapping by more than 1e-10 (`test_certify.py`); a TypeScript test checks
that the stored gaps are still the validator's (`test/crosscheck.test.ts`).

**Independent check** [CALC]: all 42 test packings also pass a float check written apart from both (numpy and
scipy: every ball distance, every vertex norm, and every near solid pair by a brute-force separating-axis test over
the facet normals of scipy's convex hulls and every edge-edge cross product, without pruning): wall gaps of 1e-10,
pair gaps of 1e-10 and up.

**Test packings** (`python/balls/fixtures/packings.json`, 193 kB): every problem kind at P = 2, 5, 13, 30 and 80
from short runs of the search (seconds to a minute each), and at P = 100 a new start of the search, legalized and
unpolished (a loose packing). The certifier's tests, the validator's and the search's tests and the volunteer
client's (a job started from one) share them. They are not records.

## 5. Validator and search (`packages/balls`)

**Validator** (`validate.ts`): the rules of §1 in floating point, at the tolerance it is given (the server's 1e-9,
and 1e-11 for the strict check). A ball's gap to a solid container is the least over the faces of
s b_f - r - N_f . c (`wallGap` in `container.ts`: one expression, which the validator, the search's legalization and
the kernel's energy all round alike; the cube keeps its axis-aligned test). Ball pairs are all tested (P <= 100: at most 4,950); solid pairs are pruned by their
circumradii and use the polyhedra space's separating-axis test, which stops at the first axis with a gap of 1e-3.
Input limits: s at most 1e6, coordinates at most 1e4, quaternion components at most 1e100 and norms at least 1e-6
(the polyhedra space's).

**Search** (`search.ts`, `ball-pieces.ts`, `solid-pieces.ts`; seeded, budgeted by evaluations, stoppable,
synchronous for a worker; PolyPack's own code):

1. Start: a given configuration is legalized and polished (or taken as it is when it is this search's own polished
   result). Without one: for balls, random centres in a container 30 % larger than the bound, or a cut of a lattice
   packing of balls (face-centred cubic or hexagonal close-packed, turned and shifted at random; for a cube
   also the axis-aligned simple cubic and face-centred cubic lattices), the P lattice points nearest the centre in
   the container's norm; for balls in another solid also the axis-aligned hexagonal close-packed lattice (its layers
   lie along the canonical axis of the prisms and bipyramids) and the norm is the solid's gauge max_f N_f . x / b_f,
   the scale of the solid that just holds the point, with the lattice made large enough that no point of smaller
   gauge is missing (it grows by half until the P-th gauge times the circumradius is inside it, for the thin and long
   solids; a test cuts the 100 least-gauge points of a lattice and compares them with a brute-force enumeration);
   random centres in the container are drawn by rejection from its bounding box, and, if 60 draws fail, from the
   copy (s - r / rho) C that lies inside the shrunk container; for solids, their circumscribed balls placed as such a
   cut and turned at random (valid as placed), and for cubes also cuts of the cubic lattice.
2. Polish. Balls: s and the centres are the variables, and s + mu (sum over pairs of (2 r + g - |c_i - c_j|)_+^2 +
   the walls' squared protrusions: |c| - (s / 2 - r - w) in a ball, one hinge per face N_f . c - (s b_f - r - w) in
   another solid, with the gradient in s through b_f) is minimised by L-BFGS for mu = 1e1 to 1e10, the pairs read from a Verlet list
   (made again when a ball has moved a quarter of a radius; the same function as the sum over all pairs). Solids:
   the separating-plane penalty method of the polyhedra space (a plane per near pair as variables, the ball's radius
   and every pose; mu = 1e1 to 1e9) with the wall term (|x| - s + w)_+^2 for every vertex x.
3. Legalization makes the result exactly valid with the clearance 1e-10: balls are scaled about the origin until
   every distance is 2 r + g (for a cube their bounding box is centred first) and s is set to the smallest size with
   wall gap w (for another solid the largest over the centres and faces of (N_f . c + r + w) / b_f); solids are moved apart by scaling their centres until the separating-axis test shows the clearance
   between every pair, then s = 2 (the largest vertex distance + w) for a ball container.
4. Hops from the best so far: move one to three balls to random places, move one or two of the loosest balls into
   the largest holes found by sampling, or shake all of them (balls); move and turn one to three solids or shake all
   of them a little (solids); one in ten a new start. Each in a container 0.5 to 4 % larger, polished and legalized;
   a smaller result replaces the best.

Budget: `maxEvals` counts objective evaluations, so a run that ends on its evaluations is reproducible from its seed
and start; `maxSeconds` and `shouldStop` are polled at every evaluation and between them, and the run returns its
best so far. Tests (`packages/balls/test/balls.test.ts`): valid results at every budget, the small known optima
(8 balls in a cube of edge 2, 4 balls in a ball of diameter 1 + sqrt 6 / 2), reproducibility by seed, stops and time
limits, warm starts from the test packings that never return worse, and the catalogue's ids and bounds.

**Costs** [CALC] (`scripts/bench.ts`, runs of 30,000 evaluations from a new start, wall time including the work
between evaluations, Node 26 on an Apple Silicon laptop beside other jobs, 2026-10-25): an evaluation of P balls took
about 0.6 + 0.15 P microseconds (2.2 at 10 balls, 15.4 at 100); one of P solids about k P, with k = 1.8 for
tetrahedra, 1.3 for cubes, 1.2 for octahedra and dodecahedra and 1.0 for icosahedra (182 microseconds at 100
tetrahedra, 118 at 100 dodecahedra). The same bench on the new problems (2026-10-26, 8,000 to 20,000 evaluations, the
machine busier): balls in another solid cost 0.65 (tetrahedron) to 1.75 (the 120 faces of the disdyakis
triacontahedron) times the balls in a ball, one hinge per face and ball; 11 of the other solids cost 1.6 to 5.6
microseconds a piece, 10 for 100 pentagonal hexecontahedra. The board sizes its rounds with these (§7).

## 6. Limitations and open questions

- No records: every problem's best value is whatever the site's users and volunteers send. The elementary bounds
  are weak, so the targets list gave every balls problem the largest room until it had an entry, and the problems of
  P > 73 reached the work list only once the problems before them in the sample had entries. Since the work list was
  removed (2026-10-29) the volunteer client draws from every problem of the domain at random.
- The Dimensions page's records table lists records only, so it shows none for this kind; its card and the board's
  picker show the domain.
- No proof covers any case of balls in a ball, although the small cases look elementary; and none of Platonic
  solids in a ball. The proven cases of balls in a cube (§3) are not marked, since there is no record to mark.
- Teich et al.'s densities could not be compared numerically (plots only).
- The new problems have no benchmark at all: the elementary bounds are the only reference, and the searches are
  short runs. The search is PolyPack's own and untuned for them; a result is valid (checked at tolerance 0 and by
  the server's rule), not near optimal. In 6,000 evaluations from a new start the score was 1.24 to 1.4 times the bound
  for most containers and solids at P = 100, but 1.73 for triangular prisms of height 3 and 3.4 for 100 12-gonal
  trapezohedra (circumradius 8.5, inradius 1.85): the start places the pieces' circumscribed balls as a lattice,
  which is loose for spiky and long solids, and the polish does not close it in so few evaluations. Thin containers
  (the 12-gonal prism of height 1 and the triangular prism, whose inradii are 0.5 and 0.29) hold one ball only from s = r / rho on (1 for the 12-gonal prism of height 1, 1.73 for the
  triangular prism), and the lattice cut for them is large.
- The kernel's `finishCost` for the solids is the Platonic fit with a floor of 30; its error is up to 7 times at P =
  5 for the solids with the most edges (§8).

## 7. On the site: board, API and volunteer client

**Registry.** `@polypack/spaces` lists the space as `balls` (dimension 3D in 3D, kind Balls): ids `balls/<code>/<P>`,
P from 2 to `SPACE_MAX_P.balls` = 100, the validator above at the touching tolerance 1e-9 and the strict one at
1e-11, and the search as a job (method "balls penalty basin hopping"). The space has no standalone viewer: its
`viewer` is the board (`/#space=balls`).

**API.** `/api/spaces` counts its 18,711 problems and 0 records and describes its `domain` (the id pattern
`balls/<code>/<P>`, the 189 codes with their titles and menu groups, P from 2 to 100); `/api/spaces/balls/problems` lists its records
(none yet); `/api/spaces/balls/problems/<id>` answers for any id of the domain, with `status: "no_record"`,
`certified: null`, `certified_config: null`, its bound, and the site leader's configuration once there is one. An
entry is kept when it is valid, also at the strict tolerance 1e-11, and beats the site leader by the tie tolerance
(the first valid entry is kept). Until the work list was removed on 2026-10-29, the targets list held the balls problems with site entries and the first 500 of the
domain's sample that have none (small P first: P <= 73 before any entry; the sample is the first 7 codes, so the
default draw and the targets list are as they were), with `best_score: null` and
`leader: "none"`; as those get entries, the next problems of the sample come in, so every problem comes up in turn.

**Server memory** [CALC] (the server as the image runs it, `node --import tsx src/node.ts`, Apple Silicon, Node 26,
2026-10-25, with a probe that forced a full collection 10 s after the start, measured with an interim records file
of the space that held more than the catalogue without records does): heap 49.8 to 50.0 MB with the space and 49.3
to 49.4 MB without it, about 0.5 MB more; the resident memory, 172 to 180 MB, did not differ beyond its noise on the
loaded machine.

**Board.** Balls, under 3D in 3D in the Problem set menu ([BOARD.md](BOARD.md)): a picker of the 189 problems in 16 groups (`Balls in a Catalan solid`, `Prisms in a ball`, ...,
the `groups` of the domain's field, one `optgroup` each) and P, built from the domain; a problem
without an entry shows "No record yet: run the optimizer or submit one." over the empty drawing and runs from a new
arrangement; the three.js drawing (instanced spheres or solids, the container a faint ball with three great circles
or a solid's edges over its faint faces; Solid or See-through; released on leaving); rounds of the search in a Web Worker sized from P and
the piece and container (`ballsRound`: balls in a solid with F faces cost 1 + F / 150 times the balls in a ball; the other
89 solids 5 microseconds a piece). The Method select offers the eight generic methods beside Auto (§8).

**Volunteer client.** `--dimensions balls` (or `all`) adds the space to the opt-in list of kinds; without the option
the client never asks the server about it, and with it, since 0.3.0, it draws from all 18,711 problems of the domain
at random (before, from the first 7 problems, the work list's sample, §2). It searches a problem without an entry from a new arrangement and applies
the strict check before it sends a result.

## 8. Kernel for the generic methods

`ballsKernel({ code, P })` (`packages/balls/src/kernel.ts`, with `kernel-balls.ts`, `kernel-solids.ts` and
`kernel-rule.ts`) is the space's kernel for the generic search methods (`docs/methods/dimensions/README.md`), so
that every balls problem offers the eight methods beside Auto, the space's own search (§5), which stays the default.
P runs from 2 to 100, the catalogue's and the server's range; the factory refuses any other P.

**State.** Balls: three numbers per ball, its centre. Solids: six numbers per piece, as in the polyhedra space's
kernel ([POLYHEDRA.md](POLYHEDRA.md) §9): its centre, then a rotation vector times the solid's circumradius, so that
it reads as a length, which turns an anchor orientation the kernel keeps in the state; only `rebase` changes an
anchor. The size is s and the bound the elementary bound of §1. Centres are absolute (the container is centred at
the origin), so changing s scales them. A step of every variable is the piece's inradius (`BALL_RADIUS` for a ball; for the long and thin solids the step is
as small as 0.29, the triangular prism of height 3's inradius).
`fromConfig` refuses a configuration outside the server's limits (§5: s at most 1e6, coordinates at most 1e4,
quaternion components at most 1e100 and norms at least 1e-6), so a method never works on a state no submission
could have.

**Energy.** For balls, the validator's own distances: a pair's overlap 2 r - |c_i - c_j|, the protrusion
|c_i| + r - s / 2 from the ball, one term per face of the cube, +-c_ik + r - s/2, and for another solid one term per face
f, N_f . c_i + r - s b_f (gradient N_f in the centre and -b_f in s). For solids, the polyhedra kernel's
model with a ball for the container: at shape t a piece is the solid scaled by t about its centre and dilated by
(1 - t) times its inradius rho (the solid at t = 1, its inscribed ball at t = 0); a pair's overlap is the soft
pieces' exact penetration depth, twice the dilation minus the signed distance of the scaled solids by the
separating-axis test; the protrusion from the ball is max |X_v| + (1 - t) rho - s / 2 over the scaled solid's vertices
X_v, since the farthest point of a convex body from a point is a vertex [EST, elementary]. The energy is the
weighted sum of the squared overlaps and protrusions, with analytic gradients (for the wall, the unit vector to the
farthest vertex and its lever arm about the centre). [CALC] They match central differences to 1e-6 relative on
overlapping states of every problem, for true and soft shapes and rotations away from the anchor
(`test/kernel.test.ts`). For balls each term is minus one of the validator's gaps, rounded as the validator rounds
it, so the energy is zero exactly when the configuration is valid at tolerance 0. For solids at t = 1 the model is
the validator's up to rounding (the kernel's vertices and separating-axis depths agree with the validator's to about
1e-15, as in the polyhedra kernel), so a configuration valid at tolerance 0 has an energy of about 1e-30 at most, and
none with a clearance. A state with a number that is not finite has energy Infinity.

**Other operations.**

- `finish`: what the search does with a start it is given (§5): the legalization of the state's configuration with
  the clearance 1e-10, and the polish from the penalty weight 1e4 on (to 1e10 for balls, 1e9 for solids), which
  legalizes its result too; each result is checked with the validator at tolerance 0 and the smallest is kept. Two
  changes from the search: a configuration already valid at tolerance 0 is a result itself, so that a finish is
  never worse than a valid input (the legalization scales centres about the origin, which can take a valid
  configuration near the coordinate limit 1e4 past it); and the polish starts at the size the pieces need (the
  largest |c| + r or vertex distance, or for the cube twice the largest coordinate plus 2 after centring the
  pieces' bounding box), not at the stated one, which may be as loose as 1e6. The legalization of solids polls the
  stop between its separating-axis tests (it can take seconds for a hundred solids piled near one point), and a stop
  there ends the finish with the input when it is valid and nothing otherwise. The polish polls at every evaluation
  and between them, and every stop in it hands over its last iterate, legalized (a stop before its first stage has
  moved leaves the legalized input). A state the server could not read finishes to nothing.
- `validate`: the server's rule for a balls entry (`packages/spaces/src/validate.ts`): the configuration read as the
  server reads it (malformed input and a wrong number of pieces have no score), s not below the bound by more than
  1e-9 relative, the validator at the touching tolerance 1e-9, then at the strict tolerance 1e-11, which the server
  asks of every entry of a problem without a research record (§7). The spaces package depends on this one, so the
  rule is built again from the same parts; `packages/spaces/test/methods.test.ts` compares the two on the test
  packings of P <= 30 (each with about 30 variants: shrunk within and beyond each tolerance, below the bound, out of
  range, malformed) and on configurations the kernel finished, and they give the same verdict, score and reasons.
  Once the space has records, the server asks the strict check only of an entry that beats one, and this rule stays
  the stricter for the others; a finished configuration, valid at tolerance 0, passes both.
- Capabilities: `shape` (for balls a ball is its own inscribed ball, so `setShape` changes nothing, as for the
  methods' reference disks; for solids the soft shapes above), `seeds`, and for solids `swap` (a piece's whole
  orientation). Seeds are the search's own lattice cuts (§5), legalized: for balls in a ball face-centred cubic and
  hexagonal close-packed cuts, turned at random; in a cube first the axis-aligned face-centred and simple cubic ones;
  in another solid the axis-aligned face-centred, hexagonal and simple cubic ones, then the turned ones;
  for solids, balls of the circumradius placed as a face-centred cubic or hexagonal close-packed cut, each solid
  turned at random, and for cubes first a cut of the cubic lattice. Every turn and shift comes from the stream the
  method passes in.
- Random starts fill about 15 % of the container; `randomPose` writes a solid's random orientation into its rotation
  variables, so that writing the piece's variables back undoes it.

**Costs** [CALC]. Processor time, Node 26 on Apple Silicon, on a machine shared with other jobs (load average 25 to
50 on 8 cores, 2026-10-26), after a squeeze from a random start; medians of three starts. Energy with its gradient:

| problem | P = 10 | P = 80 |
|---|---|---|
| balls in a ball | 0.0012 ms | 0.015 ms |
| balls in a cube | 0.0010 ms | 0.014 ms |
| tetrahedra | 0.043 ms | 0.48 ms |
| cubes | 0.028 ms | 0.26 ms |
| octahedra | 0.040 ms | 0.37 ms |
| dodecahedra | 0.069 ms | 0.60 ms |
| icosahedra | 0.11 ms | 0.64 ms |

The balls' energy tests every pair (0.023 ms at P = 100). Their finish costs 190 to 2,500 energies up to P = 5 and
6,500 to 8,300 from P = 20 on, where the polish runs out of iterations at every penalty weight (about 0.19 s at
P = 100); at P = 10 it costs 450 to 6,200, depending on the start. `finishCost` is max(500, 7500 P^2 / (P^2 + 200)),
which the measured finishes were 0.47 to 1.4 times in 80 % of 48 runs (median 1.03; 0.18 to 5.0 in all). For the
solids a finish takes about 1 ms per piece whatever the solid, while the energy's cost per piece grows with the cost
c of one overlapping pair's separating-axis test (modelled as for the polyhedra space, in microseconds), so
`finishCost` is max(30, 250 / (1 + c / 35)): 233 to 244 for tetrahedra, cubes and octahedra, 141 for dodecahedra and
icosahedra. The measured finishes were 0.41 to 2.9 times that in 80 % of 105 runs (median 0.95; 0.21 to 5.2 in
all, and the three starts of one case up to 10 times apart). A validate (the check at the touching and at the
strict tolerance) costs 1.9 to 3.2 energies for balls and 1.7 to 8.2 for solids, so `validateCost` is 2.5 and 3.
[CALC] The same bench on 12 of the new solids at P = 5, 10 and 30 (truncated tetrahedra, truncated icosidodecahedra,
pentagonal hexecontahedra, disdyakis triacontahedra, triakis icosahedra, prisms of height 3 and 12-gonal prisms of
height 3, 12-gonal trapezohedra, bipyramids and antiprisms): an energy took 0.011 to 5.4 ms, and the finishes were 0.5
to 3.6 times the fit where it gives 31 or more, and up to 9 times at P = 5 where the many edges drive it lower
(truncated icosidodecahedra: fit 24, measured 48 to 214; pentagonal hexecontahedra 12, 20 to 62; disdyakis
triacontahedra 10, 26 to 39), hence the floor of 30. Balls in another solid (tetrahedron, pentakis dodecahedron,
disdyakis triacontahedron, 12-gonal prism of height 3, 12-gonal trapezohedron, P = 5 to 80): an energy took 0.0010 to
0.18 ms, finishes were 1,100 to 8,800 energies, 0.2 to 6.8 times the balls' fit (above 3 times only at P of 10 or
less on the solids with many faces), and validates 0.4 to 1.3 energies; the balls' fit is kept.
`BALLS_KERNEL_BENCH=1` runs the measurement in `test/kernel.test.ts`. An energy of deeply overlapping solids costs
more than these: a 2 s run of penalty on 13 dodecahedra averaged about 1 ms per energy with its gradient.

**Rounds on the board.** A generic method's round is K / P evaluations (`genericRound`, `apps/web/src/space/model.ts`),
clamped to 5,000 to 300,000. [CALC] The eight methods' median rate times P, in rounds of 2 s from a test packing grown
by 3 %, was 7.2 to 8.1 million at 13 balls, 5.1 million at 30 and 4.0 million at 80, and 33,000 to 140,000 for the
solids (13 tetrahedra, octahedra and dodecahedra, 30 cubes and icosahedra, 80 dodecahedra). So balls take
K = 10,000,000 (`GENERIC_ROUND_K_BALL_PIECES`: rounds of 0.5 to 2 s up to P = 33, where 300,000 caps them, and about
2.5 s at P = 80) and solids K = 150,000 (`GENERIC_ROUND_K.balls`: 1 to 3.5 s up to P = 30; beyond, the floor of
5,000 makes them longer, about 12 s for 80 dodecahedra).

**Tests.** `test/containers.test.ts` (the new problems): the 189 codes, titles, groups and ids; the container's
geometry (the inradius and circumradius at the centroid, no random direction improves either; the gap to the walls
against planes built from the faces' vertices; two balls at the ends of a diameter attaining the two-piece bound of
eight tangential solids; one ball at s = r / rho valid and 1e-8 below it not, for all 93 non-cube containers); the
validator with solid containers (valid, borderline and invalid at both tolerances); the lattice cut against a brute-force
enumeration for thin and long containers at P = 100; searches that return a valid packing at or above the bound for
balls in each of the 94 solids and each of the 94 solids in a ball at P = 2 and 3; reproducibility, stops and warm
starts; the kernel's contract on 17 problems (one container and one piece solid of each family, the long and the flat
prisms among them) at P = 2 and 4; gradients; energy zero exactly when valid at tolerance 0, and clear() against the
validator, a few units of rounding either side of contact; and every method on 7 of them at P = 3 (from a found
packing grown by 3 % and from nothing), each result valid by the server's rule and at tolerance 0.
`packages/spaces/test/methods.test.ts` adds the rules compared on the same 17 problems (a found packing and about 30
variants) and Auto and two generic methods run as jobs on them at P = 2 to 4. `test/kernel.test.ts`: the methods' contract for the first 7 problems at P = 2, 5 and 13 and at 60 balls in a
cube and 40 icosahedra; the gradients; soft shapes; moves undone; seeds; the test packings in and finished no
worse; states that blew up; absurd starts; a finish told to stop; a legalized iterate from every stop in either
polish; a stop in the solids' legalization answered at once; valid inputs (near the coordinate limit, touching)
never finished to something worse; the same finish whatever size is stated; energy and clear() against the
validator a few units of rounding either side of contact; and every method on each of the first 7 problems at P = 5, from
the test packing grown by 3 % and from nothing, each result valid by the server's rule and at tolerance 0 and never
worse than its start. `packages/spaces/test/methods.test.ts` lists the methods of balls problems, compares the
rules, and runs generic methods as jobs. [CALC] Four short runs from nothing (basin_hopping on 9 balls in a ball,
harden on 7 balls in a cube, morph on 4 dodecahedra, penalty on 6 tetrahedra; 4,500 to 11,000 evaluations each)
were proved valid by the certifier (§4), with gaps of at least 1e-10 between the pieces and from the container.

**Limitations.** The energy's gradient jumps where a pair's best axis or a solid's farthest vertex changes. The
balls' energy tests every pair, which stays cheap up to P = 100; their finish, the search's own polish with its
iteration limits, is the dearest part of a run at large P.
