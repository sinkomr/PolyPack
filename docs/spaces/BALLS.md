# 3D in 3D: balls in a ball or a cube, Platonic solids in a ball

The second kind of 3D in 3D, beside Polyhedra ([POLYHEDRA.md](POLYHEDRA.md)): P unit balls (radius 1) packed in
the smallest ball or the smallest cube, and P unit-edge Platonic solids (tetrahedra, cubes, octahedra,
dodecahedra, icosahedra, the polyhedra space's solids) packed in the smallest ball, for P = 2 to 100: 7 problems
and 693 records. The score is the container's size s: the radius of the container ball, or the edge of the cube;
smaller is better. This follows PolyPack's 2D conventions (N = 0 for circle pieces of radius 1, M = 0 for circle
containers, the score of a circle container its radius). In code and data the space is called `balls`.

**Summary** (2026-10-25).

- `data/balls/records.json` holds **693 records** (the index: values, bounds, provenance) and
  `data/balls/configs/<code>.jsonl` their configurations, one file per problem and one line per P, read on demand
  by the server as the polyhedra space's are. Every record is proven valid by `python/balls/certify.py` (exact
  rational arithmetic for balls; exact rotations and 170-bit interval arithmetic with explicit separating planes
  for solids, reusing the polyhedra space's vendored certifier) and passed an independent float check on a sample.
- Every configuration is PolyPack's own, found by this package's search (`packages/balls`). No published
  coordinates were used.
- RESULTS_SUMMARY
- The board (Dimension 3D in 3D, Kind Balls), the API (`/api/spaces/balls`) and the volunteer client (opt-in)
  use the space (§8).

Labels: [EST] established and sourced, [CALC] computed here, [SPEC] speculation.

## 1. Problem

**Problems and ids.** A problem is named by a code `<piece>in<container>`, in the manner of the polyhedra space:
`ballinball` (balls in a ball), `ballincub` (balls in a cube), `tetinball`, `cubinball`, `octinball`, `dodinball`,
`icoinball` (tetrahedra, cubes, octahedra, dodecahedra, icosahedra in a ball). With P pieces its id is
`balls/<code>/<P>`, e.g. `balls/ballinball/13`. Ids are accepted only in that one written form.

**Units and container.** Balls have radius 1. The Platonic solids are the polyhedra space's canonical solids
(`python/polyhedra/solids_exact.json`): edge 1, centred at their vertex centroid, in their canonical orientation.
The container is s times the canonical container, centred at the origin: the ball of radius s, or the cube
[-s/2, s/2]^3 with its faces normal to the axes (the polyhedra space's unit cube scaled by s).

**Configuration.** `{s, pieces}` with P pieces: a ball is its centre `[x, y, z]`; a solid is
`[x, y, z, qw, qx, qy, qz]`, the canonical solid turned by the rotation of q / |q| (v -> q v q*, the matrix
H(q) / |q|^2) and centred at (x, y, z), as in the polyhedra space.

**Validity.** Pieces may touch; their interiors are disjoint and they lie in the closed container:

- two balls: |c_i - c_j| >= 2;
- a ball in the ball: |c| <= s - 1; in the cube: |c_k| <= s/2 - 1 for k = 1, 2, 3;
- a solid in the ball: every vertex has |x| <= s (a convex solid lies in a ball when its vertices do);
- two solids: disjoint interiors, decided by the separating-axis test of the polyhedra space (face normals of both
  and the Gauss-map pruned cross products of their edges, which decide the penetration depth exactly).

The site's float validator (`packages/balls/src/validate.ts`) applies these at PolyPack's tolerance 1e-9: an overlap
or protrusion deeper than 1e-9 rejects the configuration.

**Score and bounds.** s. Every record carries the largest of three elementary lower bounds [EST]: the volume bound
(the pieces' total volume is at most the container's: s >= P^(1/3) for balls in a ball, s >= (4 pi P / 3)^(1/3)
for balls in a cube, s >= (3 P v / (4 pi))^(1/3) for solids of volume v); one piece (s >= the circumradius of a
solid; s >= 2 for a ball in a cube); two pieces (two unit balls have centres at least 2 apart in the ball of radius
s - 1, so s >= 2, or in the cube of edge s - 2 whose diameter is (s - 2) sqrt 3, so s >= 2 + 2 / sqrt 3; two
solids hold disjoint balls of their inradius r, so s >= 2 r).

## 2. Records file

`data/balls/records.json` (written by `python/balls/build_records.py` from the search's result files) has, per
record: `id`, `code`, `piece`, `container`, `P`; `config_at` = [offset, length] of the record's line
`{"P", "config"}` in `configs/<code>.jsonl`; `score_cert` (= the configuration's s, proven valid) and `display`
(rounded to the nearest at 6 decimals from its exact binary value); `status` (`best_known`, or `proven` with the
published proof of the exact case, §3); `bound` {value, kind, label}; `origin` (the method, the script and the
`chain` of search rounds that produced it: each round's seed and evaluation budget and whether it started fresh,
from the previous round's result, or from the record of P + 1 with one piece removed); and `literature`, the
published values with their sources. The file's `sources` table gives the full citations.

**Clearance.** Every record keeps a clearance of 1e-10 between pieces and from the container, so that its stored
binary64 numbers are valid exactly, with no float slack. The exact certificates need no more. It costs CLEARANCE_COST
of s relative [CALC], below the tie tolerance 1e-9, so the space's record margin is the tie tolerance itself
(`SPACE_RECORD_MARGIN.balls` = 1e-9): removing the clearance cannot beat a record. (The polyhedra records keep the
wiki's 1e-7, hence that space's margin of 1e-6.)

**Size.** RECORDS_SIZE. The server keeps only the index in memory (§8).

## 3. Sources, licences and proofs

**Packomania** (E. Specht, https://www.packomania.com/): the best known packings of equal spheres in a sphere
(`ssp`, page of 13 July 2026, complete to N = 1000) and in a cube (`scu`, 17 October 2026). Its values are the
comparison numbers of §6: Packomania normalises the container (radius 1, or edge 1) and gives the spheres' radius
r; for unit balls the score is 1 / r, here computed from the radius printed at 12 decimals (about 1e-11
absolute). **Terms:** the pages carry no licence; they state a copyright of E. Specht (`<meta name="copyright">`
and the footer). So the values are cited, and no coordinates were copied or used [EST, read 2026-10-25].
Packomania marks proven optima in bold; no entry of N <= 100 is bold on either page.

**Proven cases, balls in a cube** [EST]. With d_n the largest smallest distance of n points in the unit cube, the
smallest cube for n unit balls has edge s = 2 + 2 / d_n. Gensane (2004, §3) states that Schaer (1966) "gave the
solutions for n = 2, 3, 4, 5, 6, 8, 9, the case n = 10 have been treated in [Schaer 1994]. These results are the
only ones of optimality proved in the cube"; Tatarevic (2015, introduction) states "the optimality of d_n is
proved for n=2,3,4,5,6,8,9 [Schaer 1966], n=10 [Schaer 1994] and n=14 [Joos 2009]". The case n = 7 is open by
both (Gensane: Schaer's 1966 configuration is not optimal; the best known one is conjectured optimal).

| n | d_n | s = 2 + 2 / d_n | proof |
|---|---|---|---|
| 2 | sqrt 3 | 3.154701 | J. Schaer, On the densest packing of spheres in a cube, Canad. Math. Bull. 9 (1966) 265-270, doi:10.4153/CMB-1966-033-0 |
| 3, 4 | sqrt 2 | 3.414214 | the same |
| 5 | sqrt 5 / 2 | 3.788854 | J. Schaer, The densest packing of five spheres in a cube, Canad. Math. Bull. 9 (1966) 271-274, doi:10.4153/CMB-1966-034-8 |
| 6 | 3 sqrt 2 / 4 | 3.885618 | J. Schaer, The densest packing of six spheres in a cube, Canad. Math. Bull. 9 (1966) 275-280, doi:10.4153/CMB-1966-035-5 |
| 8 | 1 | 4 | Schaer 1966 (265-270) |
| 9 | sqrt 3 / 2 | 4.309401 | Schaer 1966 (265-270) |
| 10 | 3 / 4 | 4.666667 | J. Schaer, The densest packing of ten congruent spheres in a cube, in: Intuitive Geometry (Szeged, 1991), Colloq. Math. Soc. János Bolyai 63, North-Holland (1994) 403-424 |
| 14 | sqrt 2 / 2 | 4.828427 | A. Joós, On the packing of fourteen congruent spheres in a cube, Geom. Dedicata 140 (2009) 49-80, doi:10.1007/s10711-008-9308-3 |

Read for this: Gensane 2004 (Electron. J. Combin. 11, #R33, full text) and the introduction of Tatarevic 2015
(Electron. J. Combin. 22(1), #P1.35, arXiv:1503.07933). Schaer's and Joós's papers themselves were not read
(they are behind paywalls); the attribution of each case rests on the two surveys. These 9 records are `proven`
PROVEN_NOTE, and take no entries.

**Balls in a ball.** No published proof of any case was found, so every record is `best_known`. The small best
known configurations are those of the Tammes problem (all centres on one sphere; Packomania cites the Tammes
papers of Fejes Tóth 1943, Schütte and van der Waerden 1951, Danzer 1963 and others for N <= 12), but no paper was
found that proves the reduction to the Tammes problem, nor even the elementary cases N = 2 to 4. Searched:
Packomania's references, Huang and Yu (2012, arXiv:1202.4149, introduction read), and the Tammes literature.

**Platonic solids in a ball.** The one study found is E. G. Teich, G. van Anders, D. Klotsa, J. Dshemuchadse and
S. C. Glotzer, Clusters of polyhedra in spherical confinement, PNAS 113 (2016) E669-E678,
doi:10.1073/pnas.1524875113: isobaric Monte Carlo compressions of hard Platonic solids in a spherical container,
the densest of 50 runs for each N up to 60. It reports densities only as plots (its Fig. 4; the main text has no
table, and its supplement could not be read here), so no numbers are compared. TEICH_NOTE

## 4. Certification

`python/balls/certify.py` (standard library; for solids it imports the polyhedra space's vendored
`certify_general.py`, MIT, see `THIRD_PARTY_NOTICES.md`) checks every record's published fields (id in its one
form with 2 <= P <= 100; piece and container against the code; P pieces of 3 or 7 JSON numbers; `config.s ==
score_cert`; the display rule; the bound and that it is at most the score; status, and for `proven` a literature
entry naming its proof with an optimum at most the score; literature entries numbers with a source), then proves
the configuration valid:

- every JSON number is read as the exact rational it denotes;
- balls, exactly in rationals: |c_i - c_j|^2 >= 4 for every pair; s >= 1 and |c_i|^2 <= (s - 1)^2 in a ball;
  |c_ik| <= s/2 - 1 in a cube;
- solids: the solid is checked exactly in its number field; each rotation is the exact rational matrix
  H(q) / |q|^2; every world vertex is enclosed with 170-bit fixed-point intervals with outward rounding, and an
  upper bound of |x|^2 must be below s^2 rounded down; every pair whose centres are closer than twice an upper bound
  of the circumradius is strictly separated by an explicit rational plane (floating point only proposes the
  axes), the others are farther apart than the sum of their circumradii.

Floating point never decides a check: a bad proposal can make a proof fail, never succeed. The balls' checks are
closed (touching balls pass); a solid pair is certified only when strictly separated, which the clearance gives.

**Runs** [CALC]: CERT_RUNS

**Tests** (`python3 python/balls/test_certify.py`, run by `npm run test:python`): exactly touching balls and walls
pass; overlaps and protrusions of 1e-9 and of one ulp of s fail; two cubes 1e-10 apart pass, 1e-9 into each other
or 1e-9 out of the ball fail, and exactly touching ones are not certified; a cube turned by 1e-3 rad into its
neighbour fails; an icosahedron 1e-10 inside and 1e-9 outside its ball, also with a quaternion of 5e48; malformed
numbers (strings, booleans, NaN, infinities, wrong lengths, zero quaternions, s <= 0); every field check, wrong P
and ids out of range; `proven` without a proof; and a sample of the shipped records, which also fail when their
container is shrunk by 1e-8 relative.

**Independent check** [CALC]: SPOT_CHECK

## 5. Validator and search (`packages/balls`)

**Validator** (`validate.ts`): the rules of §1 in floating point, at the tolerance it is given (the server's
1e-9, and 1e-11 for an entry below a research record). Ball pairs are all tested (P <= 100: at most 4,950); solid
pairs are pruned by their circumradii and use the polyhedra space's separating-axis test, which stops at the first
axis with a gap of 1e-3. Input limits: s at most 1e6, coordinates at most 1e4, quaternion components at most 1e100
and norms at least 1e-6 (the polyhedra space's).

**Search** (`search.ts`, `ball-pieces.ts`, `solid-pieces.ts`; seeded, budgeted by evaluations, stoppable,
synchronous for a worker; PolyPack's own code):

1. Start: a given configuration is legalized and polished (or taken as it is when it is this search's own polished
   result). Without one: for balls, random centres in a container 30 % larger than the bound, or a cut of a
   lattice packing of unit balls (face-centred cubic or hexagonal close-packed, turned and shifted at random; for
   a cube also the axis-aligned simple cubic and face-centred cubic lattices), the P lattice points nearest the
   centre in the container's norm; for solids, their circumscribed balls placed as such a cut and turned at random
   (valid as placed), and for cubes also cuts of the cubic lattice.
2. Polish. Balls: s and the centres are the variables, and s + mu (sum over pairs of (2 + g - |c_i - c_j|)_+^2 +
   the walls' squared protrusions) is minimised by L-BFGS for mu = 1e1 to 1e10. Solids: the separating-plane
   penalty method of the polyhedra space (a plane per near pair as variables, the ball's radius and every pose;
   mu = 1e1 to 1e9) with the wall term (|x| - s + w)_+^2 for every vertex x.
3. Legalization makes the result exactly valid with the clearance: balls are scaled about the origin until every
   distance is 2 + g (for a cube their bounding box is centred first) and s is set to the smallest size with wall
   gap w; solids are moved apart by scaling their centres until the separating-axis test shows the clearance
   between every pair, then s = the largest vertex distance + w.
4. Hops from the best so far: move one to three balls to random places or shake all of them (balls); move and turn
   one to three solids or shake all of them a little (solids); one in ten a new start. Each in a container 0.5 to
   4 % larger, polished and legalized; a smaller result replaces the best.

Budget: `maxEvals` counts objective evaluations, so a run that ends on its evaluations is reproducible from its
seed and start; `maxSeconds` and `shouldStop` are polled at every evaluation and between them, and the run returns
its best so far. Tests (`packages/balls/test/balls.test.ts`) check valid results at every budget, the small known
optima (8 balls in a cube of edge 4, 4 balls in a ball of radius 1 + sqrt 6 / 2), reproducibility by seed, stops
and warm starts.

**Compute** [CALC]: COMPUTE_NOTE

## 6. Results

RESULTS

## 7. Limitations and open questions

- The searches ran for minutes per problem on one laptop; above P = 30 many balls records stay above Packomania's
  values (§6). More compute, or better starts (Packomania's own methods), would close some of the gap.
- No proof covers any case of balls in a ball, although the small cases look elementary; and none of Platonic
  solids in a ball. Such records stay `best_known` until a published proof covers them.
- Teich et al.'s densities could not be compared numerically (plots only).
- The search tests every ball pair at every evaluation: fine for P <= 100, quadratic beyond.

## 8. On the site: board, API and volunteer client

**Registry.** `@polypack/spaces` lists the space as `balls` (dimension 3D in 3D, kind Balls): ids
`balls/<code>/<P>`, P from 2 to `SPACE_MAX_P.balls` = 100, the validator above at the touching tolerance 1e-9 and
1e-11 for an entry below a research record by more than the tie tolerance, and the search as a job (method
"balls penalty basin hopping"). The record margin is the tie tolerance (§2). The space has no standalone viewer:
its `viewer` is the board (`/#space=balls`).

**Server.** The configurations are kept apart and read on demand like the polyhedra space's (`CONFIGS_APART`):
only the index stays in memory. SERVER_MEMORY A check is cheap (§5) and runs in one piece.

**Board.** Dimension 3D in 3D, kind Balls ([BOARD.md](BOARD.md)): a picker of the 7 problems and P, the values, a
three.js drawing (instanced spheres or solids, the container a faint ball with three great circles or a cube's
edges; Solid or See-through; released on leaving), and rounds of the search in a Web Worker sized from P and the
piece (`ballsRound`).

**Volunteer client.** `--dimensions balls` (or `all`) adds the space to the opt-in list of kinds; without the
option the client never asks the server about it.
