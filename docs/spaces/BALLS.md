# 3D in 3D: balls in a ball or a cube, Platonic solids in a ball

The second kind of 3D in 3D, beside Polyhedra ([POLYHEDRA.md](POLYHEDRA.md)): P unit balls (radius 1) packed in
the smallest ball or the smallest cube, and P unit-edge Platonic solids (tetrahedra, cubes, octahedra,
dodecahedra, icosahedra, the polyhedra space's solids) packed in the smallest ball, for P = 2 to 100: 7 problems
and 693 cases. The score is the container's size s: the radius of the container ball, or the edge of the cube;
smaller is better. This follows PolyPack's 2D conventions (N = 0 for circle pieces of radius 1, M = 0 for circle
containers, the score of a circle container its radius). In code and data the space is called `balls`.

**Summary** (2026-10-25).

- The space ships **without research records**. Its 693 problems are given by a domain (`ballsDomain`, registered
  in `SPACE_DOMAINS` of `packages/spaces/src/domain.ts`: the 7 codes and P = 2 to 100), each answered with an
  elementary lower bound and the status `no_record`; the site's board, the volunteer client and later research fill
  them in. The first valid entry of a problem is kept, then better ones; every entry must pass the strict check (§7).
- What ships is the machinery: the float validator, the search the board and the volunteer client run, the board's
  three.js drawing, and a rigorous certifier for records to come (`python/balls/certify.py`: exact rational
  arithmetic for balls, exact rotations and 170-bit interval arithmetic with explicit separating planes for solids).
  42 test packings (every problem kind at P = 2, 5, 13, 30, 80 and 100) prove that they work; they are test data,
  not records.
- Published values (Packomania's best known packings, and the proven optima of balls in a cube) are listed in §3
  as benchmarks. No published coordinates are used.

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

The float validator (`packages/balls/src/validate.ts`) applies these at PolyPack's tolerance 1e-9: an overlap or
protrusion deeper than 1e-9 rejects the configuration.

**Score and bounds.** s. Every problem carries the largest of three elementary lower bounds [EST]: the volume bound
(the pieces' total volume is at most the container's: s >= P^(1/3) for balls in a ball, s >= (4 pi P / 3)^(1/3)
for balls in a cube, s >= (3 P v / (4 pi))^(1/3) for solids of volume v); one piece (s >= the circumradius of a
solid, the centre of its smallest enclosing ball being its vertex centroid; s >= 2 for a ball in a cube); two pieces
(two unit balls have centres at least 2 apart in the ball of radius s - 1, so s >= 2, or in the cube of edge s - 2
whose diameter is (s - 2) sqrt 3, so s >= 2 + 2 / sqrt 3; two solids hold disjoint balls of their inradius r, so
s >= 2 r). The bounds are far below the best known values: they only refuse sizes that are plainly impossible.

## 2. A domain without records, and records to come

The space's problems are its domain, `ballsDomain` (`packages/balls/src/problems.ts`): the fields `code` (the 7
codes, with their titles) and `P` (2 to 100), 693 problems; `bound(id)` gives a problem's elementary bound, and
`sample(limit)` the problems in the order the volunteers' work list offers them, small P first. `packages/spaces`
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
the container (radius 1, or edge 1) and gives the spheres' radius r; for unit balls the score is 1 / r. **Terms:**
the pages carry no licence; they state a copyright of E. Specht (`<meta name="copyright">` and the footer
"(c) E. Specht"). So the values are cited as benchmarks, and no coordinates were copied or used [EST, read
2026-10-25]. Packomania marks proven optima in bold; no entry of N <= 100 is bold on either page. Some of its
values, as 1 / r from r printed at 12 decimals (about 1e-11 absolute) [EST]:

| P | balls in a ball, R | balls in a cube, s |
|---|---|---|
| 2 | 2.000000 | 3.154701 |
| 3 | 2.154701 | 3.414214 |
| 4 | 2.224745 | 3.414214 |
| 5 | 2.414214 | 3.788854 |
| 6 | 2.414214 | 3.885618 |
| 7 | 2.591254 | 3.997823 |
| 8 | 2.645329 | 4.000000 |
| 9 | 2.732051 | 4.309401 |
| 10 | 2.832465 | 4.666667 |
| 11 | 2.902113 | 4.816440 |
| 12 | 2.902113 | 4.828427 |
| 13 | 3.000000 | 4.828427 |
| 14 | 3.091145 | 4.828427 |
| 20 | 3.473539 | 5.605155 |
| 30 | 3.916492 | 6.242641 |
| 50 | 4.550454 | 7.355401 |
| 100 | 5.635733 | 8.978083 |

Packomania's other references for these tables include Th. Gensane, Dense packings of equal spheres in a larger
sphere, Cahiers du LMPA 188 (2003); H. Pfoertner's pages (2005, 2013); W. Huang, L. Yu, Serial symmetrical
relocation algorithm for the equal sphere packing problem (2012, arXiv:1202.4149); Th. Gensane, Dense packings of
equal spheres in a cube, Electron. J. Combin. 11 (2004) #R33; M. Tatarevic, On limits of dense packing of equal
spheres in a cube, Electron. J. Combin. 22 (2015) #P1.35.

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
there, lie in the unit ball (seen from the centre, a face's vertices lie 37.38 degrees from its middle and a
tetrahedron's edges 35.26 degrees from its axis); `packages/balls/scripts/cones.ts` builds it, and a test checks it.

## 4. Certification

`python/balls/certify.py` (standard library; for solids it imports the polyhedra space's vendored
`certify_general.py`, MIT, see `THIRD_PARTY_NOTICES.md`) checks a records file's published fields (id in its one
form with 2 <= P <= 100; piece and container against the code; P pieces of 3 or 7 JSON numbers; `config.s ==
score_cert`; the display rule; the bound and that it is at most the score; status, and for `proven` a literature
entry naming its proof with an optimum at most the score; literature entries numbers with a source), then proves
the configuration valid (`certify_config`, also usable on its own):

- every JSON number is read as the exact rational it denotes;
- balls, exactly in rationals: |c_i - c_j|^2 >= 4 for every pair; s >= 1 and |c_i|^2 <= (s - 1)^2 in a ball;
  |c_ik| <= s/2 - 1 in a cube;
- solids: the solid is checked exactly in its number field; each rotation is the exact rational matrix
  H(q) / |q|^2; every world vertex is enclosed with 170-bit fixed-point intervals with outward rounding, and an
  upper bound of |x|^2 must be below s^2 rounded down; every pair whose centres are closer than twice an upper bound
  of the circumradius is strictly separated by an explicit rational plane (floating point only proposes the axes),
  the others are farther apart than the sum of their circumradii.

Floating point never decides a check: a bad proposal can make a proof fail, never succeed. The balls' checks are
closed (touching balls pass); a solid pair is certified only when strictly separated.

**Tests** (`python3 python/balls/test_certify.py`, run by `npm run test:python`; 18 tests): exactly touching balls
and walls pass; overlaps and protrusions of 1e-9 and of one ulp of s fail; two cubes 1e-10 apart pass, 1e-9 into
each other or 1e-9 out of the ball fail, and exactly touching ones are not certified; a cube turned by 1e-3 rad into
its neighbour fails; an icosahedron 1e-10 inside and 1e-9 outside its ball, also with a quaternion of 5e48;
malformed numbers (strings, booleans, NaN, infinities, wrong lengths, zero quaternions, s <= 0); every field check,
wrong P and ids out of range; `proven` without a proof; the 42 test packings (all certified, wall gaps 1e-10; those
of P = 5 and 13 fail when their container is shrunk by 1e-8 relative); and the cross-check below.

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
and 1e-11 for the strict check). Ball pairs are all tested (P <= 100: at most 4,950); solid pairs are pruned by their
circumradii and use the polyhedra space's separating-axis test, which stops at the first axis with a gap of 1e-3.
Input limits: s at most 1e6, coordinates at most 1e4, quaternion components at most 1e100 and norms at least 1e-6
(the polyhedra space's).

**Search** (`search.ts`, `ball-pieces.ts`, `solid-pieces.ts`; seeded, budgeted by evaluations, stoppable,
synchronous for a worker; PolyPack's own code):

1. Start: a given configuration is legalized and polished (or taken as it is when it is this search's own polished
   result). Without one: for balls, random centres in a container 30 % larger than the bound, or a cut of a lattice
   packing of unit balls (face-centred cubic or hexagonal close-packed, turned and shifted at random; for a cube
   also the axis-aligned simple cubic and face-centred cubic lattices), the P lattice points nearest the centre in
   the container's norm; for solids, their circumscribed balls placed as such a cut and turned at random (valid as
   placed), and for cubes also cuts of the cubic lattice.
2. Polish. Balls: s and the centres are the variables, and s + mu (sum over pairs of (2 + g - |c_i - c_j|)_+^2 +
   the walls' squared protrusions) is minimised by L-BFGS for mu = 1e1 to 1e10, the pairs read from a Verlet list
   (made again when a ball has moved a quarter of a radius; the same function as the sum over all pairs). Solids:
   the separating-plane penalty method of the polyhedra space (a plane per near pair as variables, the ball's radius
   and every pose; mu = 1e1 to 1e9) with the wall term (|x| - s + w)_+^2 for every vertex x.
3. Legalization makes the result exactly valid with the clearance 1e-10: balls are scaled about the origin until
   every distance is 2 + g (for a cube their bounding box is centred first) and s is set to the smallest size with
   wall gap w; solids are moved apart by scaling their centres until the separating-axis test shows the clearance
   between every pair, then s = the largest vertex distance + w.
4. Hops from the best so far: move one to three balls to random places, move one or two of the loosest balls into
   the largest holes found by sampling, or shake all of them (balls); move and turn one to three solids or shake all
   of them a little (solids); one in ten a new start. Each in a container 0.5 to 4 % larger, polished and legalized;
   a smaller result replaces the best.

Budget: `maxEvals` counts objective evaluations, so a run that ends on its evaluations is reproducible from its seed
and start; `maxSeconds` and `shouldStop` are polled at every evaluation and between them, and the run returns its
best so far. Tests (`packages/balls/test/balls.test.ts`): valid results at every budget, the small known optima
(8 balls in a cube of edge 4, 4 balls in a ball of radius 1 + sqrt 6 / 2), reproducibility by seed, stops and time
limits, warm starts from the test packings that never return worse, and the catalogue's ids and bounds.

**Costs** [CALC] (`scripts/bench.ts`, runs of 30,000 evaluations from a new start, wall time including the work
between evaluations, Node 26 on an Apple Silicon laptop beside other jobs, 2026-10-25): an evaluation of P balls took
about 0.6 + 0.15 P microseconds (2.2 at 10 balls, 15.4 at 100); one of P solids about k P, with k = 1.8 for
tetrahedra, 1.3 for cubes, 1.2 for octahedra and dodecahedra and 1.0 for icosahedra (182 microseconds at 100
tetrahedra, 118 at 100 dodecahedra).

## 6. Limitations and open questions

- No records: every problem's best value is whatever the site's users and volunteers send. The elementary bounds
  are weak, so the targets list gives every balls problem the largest room until it has an entry; the problems of
  P > 73 reach the work list only once someone sends an entry from the board.
- The Dimensions page's records table lists records only, so it shows none for this kind; its card and the board's
  picker show the domain.
- No proof covers any case of balls in a ball, although the small cases look elementary; and none of Platonic
  solids in a ball. The proven cases of balls in a cube (§3) are not marked, since there is no record to mark.
- Teich et al.'s densities could not be compared numerically (plots only).

## 7. On the site: board, API and volunteer client

**Registry.** `@polypack/spaces` lists the space as `balls` (dimension 3D in 3D, kind Balls): ids `balls/<code>/<P>`,
P from 2 to `SPACE_MAX_P.balls` = 100, the validator above at the touching tolerance 1e-9 and the strict one at
1e-11, and the search as a job (method "balls penalty basin hopping"). The space has no standalone viewer: its
`viewer` is the board (`/#space=balls`).

**API.** `/api/spaces` counts its 693 problems and 0 records and describes its `domain` (the id pattern
`balls/<code>/<P>`, the codes with their titles, P from 2 to 100); `/api/spaces/balls/problems` lists its records
(none yet); `/api/spaces/balls/problems/<id>` answers for any id of the domain, with `status: "no_record"`,
`certified: null`, `certified_config: null`, its bound, and the site leader's configuration once there is one. An
entry is kept when it is valid, also at the strict tolerance 1e-11, and beats the site leader by the tie tolerance
(the first valid entry is kept). The targets list holds the balls problems with site entries and the first 500 of the
domain's sample (small P first, P <= 73), with `best_score: null` and `leader: "none"` before a first entry.

**Server memory** [CALC] (the server as the image runs it, `node --import tsx src/node.ts`, Apple Silicon, Node 26,
2026-10-25, with a probe that forced a full collection 10 s after the start, measured with an interim records file
of the space that held more than the catalogue without records does): heap 49.8 to 50.0 MB with the space and 49.3
to 49.4 MB without it, about 0.5 MB more; the resident memory, 172 to 180 MB, did not differ beyond its noise on the
loaded machine.

**Board.** Dimension 3D in 3D, kind Balls ([BOARD.md](BOARD.md)): a picker of the 7 problems and P, built from the
domain; a problem
without an entry shows "No record yet: run the optimizer or submit one." over the empty drawing and runs from a new
arrangement; the three.js drawing (instanced spheres or solids, the container a faint ball with three great circles
or a cube's edges; Solid or See-through; released on leaving); rounds of the search in a Web Worker sized from P and
the piece (`ballsRound`).

**Volunteer client.** `--dimensions balls` (or `all`) adds the space to the opt-in list of kinds; without the option
the client never asks the server about it. It searches a problem without an entry from a new arrangement and applies
the strict check before it sends a result.
