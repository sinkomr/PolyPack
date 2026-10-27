# 3D in 3D: polyhedra packed in polyhedra

3D in 3D is the space of PolyPack's Dimensions family for solids in solids (beside 2D in 2D, polygons in
polygons; 2D on 3D, the polyhedral surfaces; and 3D on 4D). P equal solids are packed in the smallest scaled copy
s C of a container solid: the 86 three-dimensional problems of
[polyhedrainpolyhedra.wiki](https://polyhedrainpolyhedra.wiki/) (Platonic solids in Platonic solids, Archimedean
and Catalan solids in themselves, prisms and antiprisms in themselves and in a cube, elongated prisms in a cube),
and 64 of PolyPack's own in the same scheme: prisms and antiprisms with 7, 9, 10 and 11 sides in themselves and
in a cube, and their prisms of height 1.5, 2 and 3 in a cube; and the bipyramids and trapezohedra, the duals of the
prisms and antiprisms, in themselves and in a cube (150 problems with records); and, since 2026-10-26, every other
ordered pair of the 94 solids (8,836 pairs in all, without records, see "Every pair" in §1). The score is s;
smaller is better. In code and data the space is called `polyhedra`.

**Summary** (2026-10-26).

- The domain covers **4,409,164 problems**, the 8,836 ordered pairs of the 94 solids (8,686 of them new, without
  records) at P = 2 to 500. The 150 pairs of the records keep their codes, ids, titles and records; P = 101 to 500
  of those and every P of the new pairs start without research records; entries use the same volume bound and must
  pass the strict check [CALC].
- `data/polyhedra/records.json` holds **14,850 records**, one for each of the 150 problems and P = 2 to 100 (the
  wiki's range), every one with coordinates: 8,514 of the wiki's problems and 6,336 of PolyPack's (2,772 of prisms
  and antiprisms, 3,564 of bipyramids and trapezohedra). The file is the index (values, bounds, provenance;
  14.6 MB); the configurations are kept apart, one file per problem in `data/polyhedra/configs/<code>.jsonl` (150
  files, 99.8 MB, at most 0.73 MB each, one line per P), and the server
  reads the one it is asked for on demand (§2). Each is proven valid by
  `python/polyhedra/certify.py` (exact rational rotations and 170-bit interval arithmetic; the geometry is
  upstream's `certify_general.py`) at its stated s. Every PolyPack record, a random sample of the others and the
  records of P = 100 of the largest solids were also certified by upstream's own unmodified
  `certify_general.py` [CALC].
- **Sources.** The configurations come from the wiki's repository (alejandrozu/platonic-packing, MIT, commit
  `cbf76f2f`) and, through it, from Berthold, Kamp, Mexi, Pokutta and Polik's supplement (no licence; used
  with citation), Hyra-results (Apache-2.0), Ryan Xu's square_packing (no licence; used with citation), a
  reconstruction of Erich Friedman's construction and community submissions; some are PolyPack's own. Every
  record names its sources; see §3.
- **PolyPack research** beats the wiki by more than 1e-5 relative in **1,004 records** (§6), by a median of
  5.55 % and up to 23.55 % (35 dodecahedra in a tetrahedron); 769 by more than 1 %. Up to P = 30 (330 records),
  316 come from this package's search started from the case's record, run over all 725 Platonic records of that
  range, 1 from a search from scratch and 13 from the compute study of 2026-10-23 (crystal cuts and searches).
  From P = 31 to 100 (674 records) all come from that compute study's results: lattice and crystal cuts and
  searches. No new search was run for P > 30.
- 736 published values without coordinates are listed with their sources (§6).
- **PolyPack's prism and antiprism problems** (2026-10-25; §1, §6): 2,772 records, all PolyPack research, from
  layered constructions over packings of PolyPack's 2D solver, crystal cuts of column packings, searches and
  subsets, at 1.087 to 1.587 times the volume bound (median 1.173). There are no published values for them, so
  they are best_known with nothing to compare with; up to P = 60 they were searched, from P = 61 on they are the
  constructions (§6, §7).
- The board (Dimension 3D in 3D, Kind Polyhedra), the API (`/api/spaces/polyhedra`) and the volunteer client
  (opt-in) use the space (§8).
- **PolyPack's bipyramid and trapezohedron problems** (2026-10-25; §1, §6): 3,564 records, all PolyPack research,
  from lattice and double-lattice cuts, searches from scratch and from the cuts, and subsets, at 1.040 to 2.147
  times the volume bound (median 1.267); no published values exist for them, so they are best_known with nothing
  to compare with. No search ran longer than 50,000 evaluations: they are baselines for the site's searches.

Labels: [EST] established and sourced, [CALC] computed here, [SPEC] speculation.

## 1. Problem

**Solids.** Upstream's 56 canonical solids (the first 56 entries of `python/polyhedra/solids_exact.json`, copied
unchanged from upstream's `src/solids_exact.json`): 5 Platonic, 13 Archimedean, 13 Catalan solids, prisms with 3,
5, 6, 8 and 12 sides, antiprisms with 4, 5, 6, 8 and 12 sides, and the 15 prisms of height 1.5, 2 and 3; then
PolyPack's 9 bipyramids and 9 trapezohedra (below). Each vertex coordinate is an exact element of a real number
field (minimal polynomial and isolating interval), times 1/sqrt(D) for the snub solids and their duals. Every
solid is centred at the origin (its vertex centroid). Edges have length 1, except the Catalan solids (the polar
reciprocals of the unit-edge Archimedean solids about the midsphere), the elongated prisms (base edges 1, lateral
edges 1.5, 2 or 3) [EST, upstream] and the bipyramids and trapezohedra. `packages/polyhedra/src/solids.data.ts`
holds the coordinates rounded to the nearest binary64, generated by `python/polyhedra/gen_solids.py` at 100
digits; for upstream's solids they equal upstream's float file `src/solids.json` except where that file has values
near 1e-61 for coordinates that are exactly 0 [CALC].

**Bipyramids and trapezohedra** (PolyPack's, 2026-10-25). The n-bipyramid (`bipyramid<n>`, code `bp<n>`, n = 3, 5
to 12) is the canonical dual of the n-prism, and the n-trapezohedron (`trapezohedron<n>`, code `tz<n>`, n = 4 to 12)
that of the n-antiprism, as the Catalan solids are those of the Archimedean solids. The 4-bipyramid is an
octahedron and the 3-trapezohedron a cube; they are left out.

- *Canonical form.* Every uniform prism and antiprism has a midsphere: its vertices are at one distance R from the
  centre and its edges have length 1, so the nearest point of every edge to the centre is its midpoint, at distance
  sqrt(R^2 - 1/4) [CALC]. The unit-edge prism and antiprism are therefore canonical (every edge tangent to one
  sphere, whose touching points have their centroid at the centre), and their polar reciprocals about that sphere are
  the canonical bipyramid and trapezohedron, with every edge tangent to the same sphere [EST: MathWorld,
  ["Dipyramid"](https://mathworld.wolfram.com/Dipyramid.html), "the duals of the right regular equilateral prisms";
  ["Trapezohedron"](https://mathworld.wolfram.com/Trapezohedron.html), "the dual polyhedra of the canonical (i.e.,
  equilateral) n-antiprism"].
- *Scale.* No packing source has these solids: Friedman's Packing Center has three three-dimensional pages (cubes,
  tetrahedra and octahedra in cubes), and neither the wiki nor Berthold, Kamp et al. pack them (checked 2026-10-25)
  [EST]. The scale is therefore upstream's rule for the Catalan solids, "their canonical dual size" (upstream's
  `CONTRIBUTING.md`): each solid is the polar reciprocal of the catalogue's unit-edge prism or antiprism about its
  midsphere, built as upstream builds the Catalan solids (the dual vertex of a face with unit outward normal m at
  distance h is (rho^2 / h) m), in the prism's or antiprism's orientation (axis z). This is also MathWorld's
  normalisation of the canonical dipyramid (prism edge 1). The scale matters only for the cube container: s is the
  cube's edge for pieces of this size. (The duals left out would differ from the catalogue's solids: the dual of the
  unit cube is an octahedron of edge sqrt 2, that of the unit octahedron a cube of edge 1/sqrt 2.)
- *Closed forms* [CALC]. Bipyramid: midradius rho = 1/(2 sin(pi/n)); n vertices on the equator at radius
  1/sin(2 pi/n) and angles (2j+1) pi/n; apexes at height +-1/(2 sin^2(pi/n)); equator edges 1/cos(pi/n), lateral
  edges 1/(sin(pi/n) sin(2 pi/n)); volume n/(12 sin^3(pi/n) cos(pi/n)). Trapezohedron, with R = 1/(2 sin(pi/n)),
  c = cos(pi/n) and H = (1/2) sqrt(1 - 1/(4 cos^2(pi/2n))) half the height of the unit-edge antiprism: an upper ring
  of n vertices at radius R, angles (2j+1) pi/n and height R^2 (1 - c)/(2H), a lower ring at radius R, angles
  2 j pi/n and the opposite height, apexes at +-R^2 (1 + c)/(2H); midradius R cos(pi/2n) = 1/(4 sin(pi/2n)); short
  edges 1/sqrt(1 + 2c). Each was checked at 60 digits against a direct polar reciprocal of the prism or antiprism
  (upstream's exact one for the prisms of 3, 5, 6, 8 and 12 sides and the antiprisms of 4, 5, 6, 8 and 12), and the volumes against MathWorld's closed forms (the
  trapezohedron's is given for short edge 1) [CALC; EST for MathWorld's formulas].
- *Exact data.* The coordinates lie in Q(alpha) of degree 2 to 20: alpha = 1/(2 sin(pi/n)) for most bipyramids,
  upstream's antiprism field for most trapezohedra, and alpha = 1/(2 sin(pi/n)) + h (h the antiprism height) of degree
  12, 12 and 20 for the trapezohedra of 7, 9 and 11 sides, whose height is not in Q(1/(2 sin(pi/n))). The
  coefficients were found by integer relations at 160 digits (for those three, in Q(1/(2 sin(pi/n))) of degree 6 to 10
  and then converted exactly) and proved by exact arithmetic in Q(alpha): every face planar and strictly supporting,
  a closed surface, an insphere (certify_general's checks, which treat them as tangential solids like the Catalan
  ones), and every edge tangent to the sphere of radius rho with its touching point inside the edge. Each float of
  the data is the binary64 number nearest its exact value (the check requires agreement to 1e-15) [CALC].

| solid | code | V, E, F | field degree | midradius | inradius | circumradius | edges | volume |
|---|---|---|---|---|---|---|---|---|
| triangular bipyramid | `bp3` | 5, 9, 6 | 2 | 0.577350 | 0.436436 | 1.154701 | 1.333333, 2.000000 | 0.769800 |
| pentagonal bipyramid | `bp5` | 7, 15, 10 | 4 | 0.850651 | 0.733349 | 1.447214 | 1.236068, 1.788854 | 2.536151 |
| hexagonal bipyramid | `bp6` | 8, 18, 12 | 2 | 1.000000 | 0.894427 | 2.000000 | 1.154701, 2.309401 | 4.618802 |
| heptagonal bipyramid | `bp7` | 9, 21, 14 | 6 | 1.152382 | 1.057163 | 2.655971 | 1.109916, 2.947905 | 7.926599 |
| octagonal bipyramid | `bp8` | 10, 24, 16 | 4 | 1.306563 | 1.220263 | 3.414214 | 1.082392, 3.695518 | 12.875806 |
| enneagonal bipyramid | `bp9` | 11, 27, 18 | 6 | 1.461902 | 1.383235 | 4.274316 | 1.064178, 4.548632 | 19.948966 |
| decagonal bipyramid | `bp10` | 12, 30, 20 | 4 | 1.618034 | 1.545906 | 5.236068 | 1.051462, 5.505528 | 29.693770 |
| hendecagonal bipyramid | `bp11` | 13, 33, 22 | 10 | 1.774733 | 1.708233 | 6.299353 | 1.042217, 6.565293 | 42.722684 |
| dodecagonal bipyramid | `bp12` | 14, 36, 24 | 4 | 1.931852 | 1.870226 | 7.464102 | 1.035276, 7.727407 | 59.712813 |
| square trapezohedron | `tz4` | 10, 16, 8 | 4 | 0.653281 | 0.518774 | 1.015052 | 0.643594, 1.098684 | 0.957000 |
| pentagonal trapezohedron | `tz5` | 12, 20, 10 | 4 | 0.809017 | 0.688191 | 1.538842 | 0.618034, 1.618034 | 2.181695 |
| hexagonal trapezohedron | `tz6` | 14, 24, 12 | 4 | 0.965926 | 0.857813 | 2.180956 | 0.605000, 2.257892 | 4.361912 |
| heptagonal trapezohedron | `tz7` | 16, 28, 14 | 12 | 1.123490 | 1.026430 | 2.940638 | 0.597408, 3.016262 | 7.907058 |
| octagonal trapezohedron | `tz8` | 18, 32, 16 | 8 | 1.281458 | 1.193803 | 3.817604 | 0.592582, 3.892395 | 13.301173 |
| enneagonal trapezohedron | `tz9` | 20, 36, 18 | 12 | 1.439693 | 1.360008 | 4.811729 | 0.589319, 4.885957 | 21.102830 |
| decagonal trapezohedron | `tz10` | 22, 40, 20 | 8 | 1.598113 | 1.525207 | 5.922948 | 0.587006, 5.996778 | 31.945102 |
| hendecagonal trapezohedron | `tz11` | 24, 44, 22 | 20 | 1.756669 | 1.689562 | 7.151226 | 0.585307, 7.224764 | 46.535555 |
| dodecagonal trapezohedron | `tz12` | 26, 48, 24 | 8 | 1.915324 | 1.853218 | 8.496543 | 0.584022, 8.569859 | 65.656240 |

The apexes are the farthest vertices, and the solids grow longer with n: at n = 12 the bipyramid is 3.7 times as long
as it is wide and the trapezohedron 4.4 times.

**PolyPack's solids** (2026-10-25). After upstream's 56, the file holds 20 more in the same format and conventions:
prisms and antiprisms with 7, 9, 10 and 11 sides (`prism7`, `antiprism7`, ...; codes `pr7`, `ap7`, ...) and the
prisms of the 7-, 9-, 10- and 11-gon of height 1.5, 2 and 3 (`prism7_l15`, ...; `pr7l15`, ...). Prism vertex 2k is
(R cos 2 pi k/n, R sin 2 pi k/n, h/2) and vertex 2k + 1 the same at -h/2; antiprism vertex k is at angle 2 pi k/n
and height H/2, vertex n + k at angle (2k + 1) pi/n and height -H/2, with R = 1/(2 sin(pi/n)) and H = sqrt(1 - 1/(4
cos^2(pi/2n))). cos(2 pi/7), cos(2 pi/9) and cos(2 pi/11) are not constructible [EST], so the fields are not
multiquadratic: Q(alpha) has degree 6 with alpha = R for the 7- and 9-gon prisms, 10 with alpha = R for the 11-gon
prisms, 4 with alpha = cos(pi/10) for the 10-gon prisms, 12 with alpha = R + H for the 7- and 9-gon antiprisms, 20
with alpha = R + H for the 11-gon antiprism and 8 with alpha = H for the 10-gon antiprism. The minimal polynomials
were proven irreducible and each coordinate's expression in alpha was proven equal to its closed form (it is a root
of the closed form's minimal polynomial in Q(alpha), and the nearest one) with sympy and mpmath; at 80 digits the
vertices, edge lengths, planar and strictly supporting faces and volumes (prisms h n cot(pi/n) / 4, antiprisms by
the prismatoid formula) agree with the closed forms, and every float of `solids.data.ts` is the nearest binary64 of
its exact value (within 1.3e-16 for coordinates, normals, offsets and radii, 1.4e-15 for the two volumes above 16)
[CALC]. `certify_general.py` checks them exactly like upstream's; its self-check proves a convex closed solid with
planar faces and the stated edges but not regular bases (an equilateral heptagon has free angles), so
`test_certify.py` checks exactly that each base is concyclic at one height (with unit edges, so regular). An
independent review matched all 20 solids to their textbook definitions exactly [CALC].

**Problems and ids.** A problem is named by upstream's code `<piece>in<container>` from three-to-five letter
solid codes, e.g. `cubintet` (cubes in a tetrahedron) or `pr3l15incub` (triangular prisms of height 1.5 in a
cube). With P pieces its id is `polyhedra/<code>/<P>`, e.g. `polyhedra/cubintet/12`; the wiki shows the same case
at `https://polyhedrainpolyhedra.wiki/#cubintet_n12`. Ids are accepted only in that one written form. After the
wiki's 86 problems come PolyPack's 64 (`wiki: false` in `catalogue.ts`, not in `WIKI_PROBLEMS` of `catalogue.py`):
`pr7inpr7`, `pr7incub`, `pr9inpr9`, `pr9incub`, `pr10inpr10`, `pr10incub`, `pr11inpr11`, `pr11incub`, the same
eight for antiprisms (`ap7inap7`, ...), and `pr7l15incub`, `pr7l2incub`, `pr7l3incub` and the same for 9, 10 and
11; then `bp<n>inbp<n>` and `bp<n>incub` (n = 3, 5 to 12) and `tz<n>intz<n>` and `tz<n>incub` (n = 4 to 12),
families `bipyramids` and `trapezohedra` (no code of the wiki starts with `bp` or `tz`). There are no published
values for them; their records are PolyPack research only.

**Every pair** (2026-10-26). Every ordered pair (piece, container) of the 94 solids is a problem family, P = 2 to
500: 94 x 94 = 8,836 codes `<piece code>in<container code>`, 150 of them the problems above and **8,686 new**
(family `pairs` in `catalogue.ts`, `wiki: false`). The code is read by splitting at an `in` that has a solid code on
each side (`problemNameOf`; the 8,836 codes are distinct and each reads back as its own pair, tested), so the
codes need no list: `kttinpkd` is triakis tetrahedra in a pentakis dodecahedron. Titles are made from the solids'
names the same way ("Triakis tetrahedra in a pentakis dodecahedron", "Dodecagonal prisms of height 3 in a
heptagonal bipyramid"). The new pairs ship without records and without baselines: no packing was searched for
them. Their lower bound is the volume bound above, labelled "volume bound; [CALC]" like the existing ones, and an
entry must pass the same strict check; a start is the box-lattice patch of §8 ("Large problems"). Pairs where
piece and container are far apart in size (500 truncated icosidodecahedra in the tetrahedron of edge 1 needs s of
about 200; the largest container scale over all 8,836 pairs at P = 500 is below the server's limit of 1e6, and
the largest coordinate of a lattice start below 1e4) are valid problems; nothing in the validator or the server
treats a pair apart [CALC]. A pair whose piece is larger than its container (a cube of edge 1 in an octahedron of
edge 1) is an ordinary problem with s above 1 for every P. Pieces and containers that are the same solid (the 94
self-packings, 27 of them new) have s = 1 for P = 1 only, so P = 2 is already a search. The volunteers' work list
(`domain.sample`) is unchanged: it offers only the unrecorded range P = 101 to 500 of the 150 pairs; a new pair comes up
for volunteers once it has a site entry.

**Configuration.** `{s, pieces: [[x, y, z, qw, qx, qy, qz], ...]}` with P poses, upstream's own format. Piece i is
the canonical piece solid turned by the rotation of q / |q| (v -> q v q*, the matrix H(q) / |q|^2, exactly
orthogonal for any nonzero q) and centred at (x, y, z). The container is s times the canonical container solid,
centred at the origin in its canonical orientation. Quaternions need not be unit: some records store exact
rational rotations with integer quaternions of up to 5e48.

**Validity.** Every vertex of every piece lies in the closed container, and the interiors of the pieces are
disjoint. The site's float validator (`packages/polyhedra/src/validate.ts`) works at PolyPack's tolerance 1e-9:
pieces may touch, and a penetration depth or protrusion deeper than 1e-9 rejects the configuration.

**Score.** s. The volume bound s >= (P vol(piece) / vol(container))^(1/3) holds for every packing [EST]; it is the
`bound` of every record. Six records meet it to 1e-6 (cubes in a cube and triangular prisms in a triangular
prism, P = 8, 27 and 64): the pieces tile the container, so these are optimal, but they stay `best_known`
because PolyPack marks `proven` only with a published proof [CALC].

## 2. Records file

`data/polyhedra/records.json` (written by `python/polyhedra/build_records.py`) has the fields of the other
spaces' records and the wiki's provenance. The configurations are kept apart: `data/polyhedra/configs/<code>.jsonl`
has one line `{"P", "config": {s, pieces}}` per P, in increasing P, and a record's `config_at` = [offset,
length] gives the byte offset and length of its line (without the newline), so that one configuration can be
read alone.

| field | meaning |
|---|---|
| `id`, `code`, `piece`, `container`, `family`, `P` | the problem |
| configuration | `{s, pieces}` on its line of `configs/<code>.jsonl`, exactly as certified |
| `config_at` | [offset, length] of that line in bytes |
| `score_cert` | = the configuration's `s`, proven valid by `certify.py` |
| `display` | `score_cert` rounded to the nearest at 6 decimals from its exact binary value (ties to even) |
| `score_float` | the float container scale of the stored poses (pieces keep their clearance) |
| `s_tight` | upstream's uncertified touching limit, where it gives one |
| `status` | `best_known` for all |
| `bound` | the volume bound |
| `found_by`, `credit`, `lineage`, `certificate_refined_by`, `method` | upstream's fields, kept (standard credit and method strings of a family are given once in `sources.wiki`) |
| `sources`, `source` | the sources the geometry rests on (keys of the file's `sources` table) and a citation sentence |
| `origin` | the file the configuration comes from (upstream's `records/...` at `cbf76f2f`, or a PolyPack file); for a PolyPack search also `start`, the packing it started from (none for a start from random positions), and for a search of the compute study `runs`, its runs from that start, as its run logs show them |
| `wiki` | the wiki's record of the case: its s_full and page |
| `literature` | published values without coordinates (value, source, link, printed precision) |
| `notes` | modification notices (Apache-2.0 data) and remarks |

**Selection.** For each case the candidates are every upstream file of the case (`records/<p>/`,
`records/community/<p>/`, `records/external/<p>/` and the files the site lists) and PolyPack's results. The
upstream file with the smallest certified s_full is the wiki's record. A PolyPack result replaces it only when
it is smaller by more than 1e-5 relative: the wiki shows s floored at 5 decimals, and smaller gains are the
clearance convention, not a better packing. The configuration is stored exactly as its file gives it.

**Clearance.** The wiki certifies its records with every pair and wall at least 1e-7 apart. Some community
refinements cut wall gaps to about 1e-10, and some community constructions have gaps of 5e-12; all are proven
positive. Where upstream gives its touching limit s_tight, the clearance costs at most 2.6e-7 of s relative
(median 5.8e-8) [CALC]. PolyPack's own records keep 1e-7.

**Scope and size.** P = 2 to 100 for all 150 problems, the wiki's range. `records.json` is 14.6 MB (6.7 MB with the
wiki's problems alone, 9.6 MB with PolyPack's prisms and antiprisms); the 150 files of configurations take 99.8 MB at
full precision (the 86 of the wiki's problems 56.9 MB, PolyPack's prisms and antiprisms 17.2 MB, the bipyramids and
trapezohedra 25.7 MB), at most 0.73 MB each (truncated icosidodecahedra, and pentagonal trapezohedra in their own
trapezohedron), so no configuration file is near 10 MB. PolyPack's records have no
`wiki` field; their `origin` gives the research file, the construction their lineage starts from (`start`) and
the searches and subset steps after it (`runs`) in short, and `method` states the lineage in full. The 4D to 6D problems of the wiki are left out.

**Storage on the server.** The server keeps only the index in memory: each problem's id, score, bound and status
(`@polypack/spaces` `loadSpacesIndex`). A configuration is read when it is asked for (`GET
/api/spaces/polyhedra/problems/<id>`, which the board and the volunteer client use): only its line is read, at
`config_at`, and checked as the other spaces' records are (`parseSpaceConfig`, and the line's P against the
record's); the configurations read last are kept up to 4 MB (`CONFIG_CACHE_BYTES`), at most 4 reads run at once
(`CONFIG_READS_AT_ONCE`) and reads of one configuration at the same time share one. A read that fails is never
kept, so the next request tries again. The listings, the targets and the keep rule need no configuration.
Measured [CALC] (Apple Silicon, Node 26, the server as `npm run start` runs it, before the 3D on 4D space joined;
its 32 records add about 55 kB; and on 2026-10-25, after PolyPack's 28 problems joined, below):

- the index of the 8,514 problems keeps 4.6 MB of heap (all five spaces' catalogues 11.1 MB, the other four
  6.5 MB); reading `records.json` leaves about 22 MB more of garbage until the next collection;
- with PolyPack's problems (`loadSpacesIndex` of all six spaces, heap after collection, three runs each, a
  heavily loaded machine): 12.0 to 12.2 MB with the 8,514 problems and 13.3 to 13.4 MB with the 11,286, against
  7.3 MB without the polyhedra space, so the polyhedra index grew from about 4.8 MB to about 6.1 MB; the server's
  resident memory 8 s after it started was 266 to 282 MB before and 250 to 287 MB after (macOS counts freed heap
  it has not taken back, so these are upper bounds and mostly noise);
- the server's resident memory 4 s after it started was 259 to 270 MB with all five spaces and 221 to 225 MB
  without the polyhedra space (macOS counts freed heap the system has not taken back, so these are upper
  bounds);
- a request for a configuration not read before costs 0.2 to 0.3 ms of CPU, and 0.1 ms once it is kept; 86
  requests at once for 86 problems took 14 ms and 18 MB of memory at the peak (reading whole problem files, as
  this did at first, took 5 ms of CPU a request when 9 problems were asked for in turn, and 357 ms and 127 MB
  for those 86);
- the image gains the 14.6 MB index and the 99.8 MB of configurations (`Dockerfile`, `.dockerignore`), the
  website's three.js chunk (0.75 MB) and viewer (8.3 MB), and `three` and `@types/three` in `node_modules`
  (22 MB and 4.6 MB, shared with the other 3D kinds).

## 3. Licence and lineage

Upstream's code and data are MIT (`THIRD_PARTY_NOTICES.md` quotes the licence with both copyright lines: Yohei
Nakajima for the soft-to-rigid method, simulator, tightening and checker design, and Alejandro Zarzuelo for the
generalization). Records that rest on other sources cite them in `sources` and `source`, and the owner decided
on 2026-10-24 to include them all with citation. Counts are of the 8,514 records of the wiki's problems (with
coordinates) and of the published values without coordinates; PolyPack's 64 problems add 6,336 records of
PolyPack research (MIT) that rest on nothing else (PolyPack's 2D solver, lattice cuts and this package's search,
§6):

| source | terms | records with coordinates | values without coordinates |
|---|---|---|---|
| the wiki (alejandrozu/platonic-packing) | MIT | 7,834 rest on its files (all but the 680 purely PolyPack ones) | - |
| community submissions (PingYou Ltd, konoha-ily2, Stian) | MIT, by the submission form | 2,312 | - |
| Berthold, Kamp, Mexi, Pokutta, Polik 2026, arXiv:2605.04850, supplement `DominikKamp/Packing` at `27f71632` | no licence stated; used with citation | 954: 661 as the wiki stores them (130 their packings, 116 their n + 1 packing less a piece, 415 searched further by upstream from them) and 293 improved by PolyPack from them | 667 |
| Hyra-results (Haowei Lin, Tencent Hunyuan) at `09b2d2e3` | Apache-2.0, `LICENSES/Apache-2.0.txt`; modified (see notes) | 6 (cubes P = 11; octahedra in a cube P = 19, 20, 21, 24, 25; P = 21 improved by PolyPack) | 6 |
| hyra-packing-audit (Sam Scott) at `c107fda3` | MIT, with a NOTICE (quoted) | 0 | 3 |
| konoha-ily2, upstream issue #1 | no licence stated; used with citation | 1 (cubes P = 28; its P = 34 to 36 are not smaller than Ryan Xu's) | 2 |
| cubes-in-cube-n13 (@BuilderOfAgents) at `1f0c7540` | MIT | 0 (the wiki's own records are smaller) | 0 |
| soft-to-rigid-packing (Yohei Nakajima) at `efe7a920` | MIT | 0 (the wiki's record is smaller) | 1 |
| square_packing (Ryan Xu) at `9535d65d` | no licence stated; used with citation | 3 (cubes in a cube, P = 34 to 36) | 3 |
| Erich Friedman's Packing Center (values by Friedman, Ríain Walsh, Lin) | values cited; no images copied | 1 (cubes P = 33: Friedman's construction, coordinates made by upstream) | 54 (Walsh 24, trivial grids 20, Friedman 10) |
| PolyPack research | MIT | 1,004 (680 of them rest on nothing else) | - |

Lineage follows upstream's own `found_by`, `credit` and `search.lineage` fields, which its engine passes on
through every move (a packing found from a Kamp packing keeps "search started from the packing of ..."). PolyPack's
own records name what their searches started from: a sweep search the packing it was given (`origin.start`), a
search of the compute study of 2026-10-23 the start its run logs show (`origin.start`, `origin.runs`): of the 24
records from the study's searches, 20 go back to an upstream record, 3 to random starts and 1 to an FCC cut
[CALC]. Until 2026-10-25 the study's searches were taken to start from the upstream record of their own P, which
was wrong for 10 records: cubintet P = 18-20 and icointet P = 42-43 go back to random starts, icointet P = 59 from
the 56-piece FCC cut, and cubintet P = 41-44 from PingYou Ltd's packing for P = 40 with cubes inserted, none of
them from Kamp et al. A
composition of two packings records the lineage of one of them only. Up to P = 30, 12 records are compositions;
in each, one component is a single piece (upstream's one-piece fits, its own), so the recorded lineage is
complete: 4 rest on Kamp et al. and cite them, 8 have none [CALC]. The records of P = 31 to 100 were not checked
for compositions. Records derived from Hyra-results carry a notice of the
changes in `notes` (Apache-2.0, section 4(b)); the repository has no NOTICE file at that commit (checked). konoha-ily2 has since published an
MIT repository (`konoha-ily2/zerogap-packing`) with exact closed forms for cubes in a cube; it is not used here.

## 4. Certification

`python/polyhedra/certify.py` checks every record's published fields (id in its one form; piece, container and
family against the code; P poses of 7 JSON numbers; `config.s == score_cert`; the display rule; `score_float <=
score_cert`; the volume bound; status; literature entries) and then proves the configuration valid with
`certify_config`, a port of upstream's `certify_general.main` that returns its findings instead of printing them:

- the solids are checked exactly in their number fields (planar, strictly supporting faces; each edge on two
  faces; Euler; unit edges, the stated lateral edges, or an insphere);
- each rotation is the exact rational matrix H(q) / |q|^2 of the stored quaternion (JSON floats read as the
  rationals they denote);
- containment: every vertex strictly inside every face of s C, decided with 170-bit fixed-point intervals with
  outward rounding on enclosures of the exact coordinates;
- disjointness: every pair whose centres are closer than twice an upper bound of the circumradius is strictly
  separated by an explicit rational plane (floating point only proposes the six best axes: face normals and
  Gauss-map pruned edge cross products); the others are farther apart than the sum of their circumradii.

PolyPack's additions to upstream's checks: entries must be finite JSON numbers (no strings, booleans or NaN),
quaternions nonzero, s positive and P equal to the id's. Upstream's `certify_general.py`, `algebraic.py` and
`multiquad.py` are vendored with their headers; only the path of the solids file changed.

**Runs** [CALC] (Apple Silicon, Python 3.9, 2 processes at nice 10, other jobs running):

- `python3 python/polyhedra/certify.py data/polyhedra/records.json --jobs 2 --out data/polyhedra/certification.json`
  (it reads the configurations from `configs/`): 8,514 of 8,514 certified in 6,035 s. The run was paused now
  and then for other measurements, so the per-record seconds in `data/polyhedra/certification.json` are wall
  times that include those pauses; unpaused, P = 100 took 20 s for truncated icosidodecahedra, 14 s for
  disdyakis triacontahedra and 11 s for pentagonal hexecontahedra, and the 2,494 records up to P = 30 took 646 s
  of CPU. Smallest proven wall slack 1.5e-12 and pair gap 1.7e-13 (`polyhedra/pr5incub/96`, a community
  construction; most records keep 1e-7). The summary per record is in `data/polyhedra/certification.json`.
- Upstream's own `certify_general.py`, unmodified, from its checkout at `cbf76f2f`: 1,079 of 1,079 certified in
  599 s: all 1,004 PolyPack records, 50 others drawn with seed 20261025, and P = 100 of every Archimedean and
  Catalan problem (26; one was among the 50), the largest P of the largest solids: 21 s for truncated
  icosidodecahedra, 17 s for pentagonal hexecontahedra, 15 s for disdyakis triacontahedra. (Up to P = 30: 380 of
  380, all 330 PolyPack records and 50 others.)
- PolyPack's 28 problems: `python3 python/polyhedra/certify.py data/polyhedra/records.json --jobs 2 --ids <their
  2,772 ids>` from the tracked files: 2,772 of 2,772 certified in 362 s (slowest `polyhedra/pr11l2incub/98`, 1.7 s), field checks included; their results are appended to
  `data/polyhedra/certification.json` after the 8,514 others, which were not run again. Smallest proven wall
  slack 1.0e-7 and pair gap 9.75e-8 (the certifier's rational planes are near the best axis, not on it; the float
  validator finds every pair at least 9.99999994e-8 apart). Upstream's own `certify_general.py`, unmodified:
  49 of 49, P = 100 of all 28 problems and 21 others drawn with seed 20261025.
- The bipyramids and trapezohedra: `build_records.py --keep data/polyhedra/records.json --polypack <dir> --jobs 2`
  certified all 3,564 records while building (and `certify.py data/polyhedra/records.json --jobs 2 --ids <their 3,564 ids>` again, field checks included: 3,564 of 3,564 in 2,648 s on a heavily loaded machine, results appended to `data/polyhedra/certification.json`; smallest proven wall slack 1.0e-7, pair gap 8.7e-8, as for the prisms the certifier's rational planes lying near the best axis); upstream's own `certify_general.py`, unmodified, with the
  18 solids added to a copy of its exact data: 60 of 60 drawn from the tracked records with seed 20261027, among them P = 100 of the largest solids of both families, and 436 of 436 configurations checked before their last subset step (36 and 400 drawn with seeds 20261025 and 20261026).
- `python3 python/polyhedra/test_certify.py`: 26 tests, among them overlaps and protrusions of 1.7e-7 to 3e-7,
  coincident pieces, a piece turned by 1e-3 rad, malformed numbers, zero quaternions, every field check, exact
  checks of PolyPack's solids with valid, overlapping and protruding packings of them (for the bipyramids and
  trapezohedra: exact midsphere and insphere, closed-form volumes, two pieces face to face 1e-7 apart that certify
  and 2e-7 into each other or out of the container that do not), and the near-contact cross-check below.

**Validator and certifier agree.** `python/polyhedra/fixtures/crosscheck.json` (written by
`packages/polyhedra/scripts/gen-crosscheck.ts`) holds 240 near-contact cases: two pieces of ten problems in
random orientations moved to separations of +-1e-7 and +-1e-9 (face, edge-edge and vertex contacts), and single
pieces at wall gaps of +-1e-7 and +-1e-9. The certifier proves every case the validator measures as separated
by more than 1e-10, and rejects every case it measures as overlapping by more than 1e-10; the TypeScript test
checks that the stored verdicts are still the validator's [CALC]. Every record is valid by the float validator
at tolerance 0, and fails at PolyPack's tolerance when its container is shrunk by 1e-6 relative.

## 5. Validator, search and drawing (`packages/polyhedra`)

**Validator** (`validate.ts`, `geom.ts`). The separating-axis test of upstream's `geom.js` and
`verify_general.py`: face normals of both pieces and the cross products of edge pairs whose Gauss-map arcs
intersect (D. Gregorius, GDC 2013). These include every face normal of the Minkowski difference, so the smallest
overlap over them is the exact penetration depth. A bounding-sphere test skips far pairs; a pair stops at the
first axis with a gap of 1e-3 (default); the check ends after 20 errors. Limits for untrusted input: s at most
1e6, centre coordinates at most 1e4, quaternion components at most 1e100 and norm at least 1e-6.

Measured [CALC] (`scripts/bench-validate.ts`, Apple Silicon, before PolyPack's problems joined): all 8,514 records in 48.8 s, the slowest
(`polyhedra/tidintid/98`, 98 truncated icosidodecahedra of 120 vertices) 149 ms, 150 ms at the strict tolerance.
A valid grid of 100 truncated icosidodecahedra 1e-9 apart (235 near pairs) takes 74 ms; of 100 pentagonal
hexecontahedra 84 ms, of 100 cubes 1.2 ms. Only near pairs need a full scan of their candidate axes (0.62 ms for
two truncated icosidodecahedra, 576 axes; 0.29 to 0.37 ms for the snub dodecahedron and the large Catalan solids;
under 0.06 ms for prisms and antiprisms), and a packing has only so many: about a dozen neighbours per piece. The
bound of every one of the 4,950 pairs of P = 100 needing a full scan, 3.1 s for the largest solid, cannot be
reached by a configuration that is not rejected after its first 20 errors.

**Search** (`search.ts`; seeded, budgeted by evaluations, stoppable, synchronous for a worker):

1. start: a given configuration is legalized and polished; without one, a soft-to-rigid run of the simulator
   (`sim/geom.ts`, `sim/sim.ts`, ported from upstream's MIT `geom.js` and `sim.js`) packs balls that harden into
   the solids under pressure;
2. hops until the budget ends, from the best: upstream's gentle soft hop (expand 0.5 to 3 %, soften, shake,
   re-harden) or a jiggle of one to three pieces, each followed by a polish;
3. polish (`polish.ts`): the separating-plane penalty method (one plane per near pair as variables, the container
   scale and every pose; L-BFGS for penalty weights 1e1 to 1e9), then a legalization that moves the pieces apart
   by scaling their centres (each pair's gap grows by at least 2 x inradius x the scale step), translates the
   container to its best position and sets s with the wanted clearance.

Change from upstream: every solid is softened as (1 - 2r) P (+) B(r) with P scaled to inradius 1/2. Upstream uses
this for solids with an insphere and an r-rounding for the others; the scaled form also stays inside P for every
solid, because P contains the ball of radius 1/2 about its centre [CALC], but it is less tight for solids
without an insphere.

Measured [CALC] (`scripts/bench-search.ts`, seed 1, 200,000 evaluations, 1 to 17 s each):

| case | wiki record | from the record | from scratch |
|---|---|---|---|
| cubes in a cube, P = 11 | 2.881711313 | 2.881711125 (upstream's s_tight 2.881711125) | 3.000000000 (+4.1 %) |
| tetrahedra in a tetrahedron, P = 8 | 2.387426170 | 2.387425887 (s_tight 2.387425887) | 2.543019521 (+6.5 %) |
| octahedra in an octahedron, P = 10 | 2.500000184 | 2.500000000 | 2.500000000 |
| truncated tetrahedra, P = 8 | 2.333333442 | 2.333333333 | 2.586179479 (+10.8 %) |
| triangular prisms in a cube, P = 8 | 1.921405041 | **1.866025404** (-2.9 %) | 1.937219146 (+0.8 %) |
| icosahedra in a tetrahedron, P = 10 | 7.014040077 | 7.014039332 | 7.014039332 |
| dodecahedra in a dodecahedron, P = 6 | 2.236068033 | 2.236067978 | 2.236067978 |
| rhombicuboctahedra, P = 5 | 2.330956545 | 2.330956424 | **2.328901097** (-0.09 %) |
| cubes in a tetrahedron, P = 5 | 5.379446197 | 5.379445410 | 5.456795679 (+1.4 %) |
| pentagonal antiprisms, P = 12 | 2.776901805 | 2.776901419 (s_tight 2.776901419) | 2.850321824 (+2.6 %) |

From a record the polish reaches upstream's touching limit (to within 5e-10) within a second; the small decreases are
the removed clearance. From scratch it finds the optimum of the small, symmetric cases in seconds and stays 1 to
11 % above the wiki on the others at this budget, which is about a hundredth of what upstream spent per case.
The search returns valid configurations at any budget (tests: budgets, stops, reproducibility by seed).

**Sweep of the Platonic records** [CALC]. `scripts/improve.ts` ran the search from every one of the 725 Platonic
records (seed 1, 150,000 evaluations, clearance 1e-7 kept by the legalization), on 2 processes for about 2 hours,
and kept the 313 results that beat the record by more than 1e-5; two more came from the cases of the table
above. With the subsets they give for smaller P, they make 317 of the records (316 from a record, 1 from
scratch; §6). Each is reproducible from its `origin` (start file, seed, evaluations) with the search as it was at
commit `54e3ca2`. Since then the search polls for a stop inside the work between evaluations and its polish
lists near pairs by their first separating axis, so the same seed can take another path (below).

**Stopping at P = 100** [CALC]. The search checks `shouldStop` and its time limit at every evaluation and inside
the work between evaluations (the planes of a polish stage, the legalizations, the pair lists). The longest gap
between two checks was 177 ms at 100 truncated icosidodecahedra and 88 ms at 100 pentagonal hexecontahedra
(`scripts/bench-rate.ts`; it was 1.4 s before), so a stop is acted on within about 0.2 s. A job then returns
within about 0.6 s at most: it checks its best at the touching tolerance, and strictly when it beats the record
(0.3 s measured from an abort to the return of a job on 100 truncated icosidodecahedra). From a record a
simulator step takes about P (3.3 + 0.14 f + 0.0021 v f) microseconds for a solid of v vertices and f faces
(0.3 ms at 100 tetrahedra, 0.6 ms at 100 cubes, 2.8 ms at 100 truncated icosidodecahedra, 3.6 ms at 100
disdyakis triacontahedra), and a soft hop about 7,000 + 130 P evaluations; the board's rounds are sized from this
(§8). A soft hop is shortened to 60 % of the evaluations a job has left when fewer are left, and below a tenth of
its length the search jiggles instead, so that a short job still ends on a polished configuration.

**Drawing** (`draw.ts`, importable as `@polypack/polyhedra/draw`). `sceneOf` and `renderSVG` build the picture
without a DOM; `createPolyhedraView(canvas, options)` draws on a canvas with flat-shaded pieces sorted back to
front, the container as a wireframe with hidden edges dashed, drag or arrow keys to turn, wheel or pinch to zoom,
a double click to reset, an optional slow spin, light and dark palettes and `pick(x, y)` for the piece under a
point. `packages/polyhedra/viz/index.html` (built by `scripts/build-viz.ts`, 8.3 MB) is a standalone viewer of
all records: problem and P selectors, the record, the wiki's value (none for PolyPack's own problems), the
published values, credits and sources, and for PolyPack's records their lineage in short; it works at phone width
and in both colour schemes. It embeds the poses at display precision up to P = 30 (all 14,850 would take about
50 MB); above that it reads the configuration from the site's API where the site serves
it (`/spaces/polyhedra.html`), and elsewhere shows the values and names the file that holds it. The board draws
with three.js instead (§8).

## 6. Results and comparison with the wiki

**PolyPack records** [CALC]. 1,004 records beat the wiki's by more than 1e-5 relative (median 5.55 %, 769 by more
than 1 %, 530 by more than 5 %). Up to P = 30, 330 records (median 0.58 %, 116 by more than 1 %, 10 by more than
5 %); per problem (gain = 1 - ours / wiki):

| problem | records | P | median gain | largest gain | how |
|---|---|---|---|---|---|
| `tetintet` | 2 | 19-20 | 0.04 % | 0.08 % (P = 20: 3.245809 to 3.243215) | search from the record |
| `octincub` | 3 | 14-21 | 0.03 % | 0.36 % (P = 14: 2.365475 to 2.357023) | search from the record 2, crystal cut 1 |
| `tetincub` | 23 | 7-30 | 1.42 % | 2.79 % (P = 27: 1.882049 to 1.829601) | search from the record |
| `tetinoct` | 22 | 9-30 | 2.61 % | 5.16 % (P = 19: 2.126113 to 2.016358) | search from the record |
| `tetindod` | 24 | 7-30 | 1.49 % | 5.84 % (P = 30: 1.042588 to 0.981751) | search from the record |
| `tetinico` | 24 | 7-30 | 2.41 % | 8.05 % (P = 19: 1.171165 to 1.076876) | search from the record |
| `cubintet` | 11 | 9-26 | 0.71 % | 1.27 % (P = 20: 6.884003 to 6.796290) | search from the record 10, compute-study search 1 |
| `cubindod` | 18 | 9-30 | 0.33 % | 2.08 % (P = 29: 1.909830 to 1.870160) | search from the record |
| `cubinico` | 22 | 8-30 | 0.48 % | 1.37 % (P = 21: 2.736278 to 2.698861) | search from the record |
| `octintet` | 13 | 15-30 | 0.91 % | 3.21 % (P = 26: 5.854322 to 5.666668) | search from the record |
| `octindod` | 22 | 9-30 | 0.81 % | 4.28 % (P = 21: 1.356716 to 1.298699) | search from the record |
| `octinico` | 24 | 7-30 | 0.89 % | 2.91 % (P = 30: 2.397636 to 2.327982) | search from the record |
| `dodintet` | 22 | 9-30 | 0.30 % | 1.33 % (P = 30: 15.967112 to 15.754453) | search from the record |
| `dodincub` | 20 | 10-30 | 1.42 % | 6.14 % (P = 30: 7.961253 to 7.472136) | search from the record 16, crystal cut 4 |
| `dodinoct` | 22 | 5-30 | 0.37 % | 1.36 % (P = 29: 10.058055 to 9.921280) | search from the record |
| `icointet` | 17 | 13-30 | 0.26 % | 1.65 % (P = 20: 8.815280 to 8.669831) | search from the record 12, crystal cut 5 |
| `icoincub` | 20 | 11-30 | 0.39 % | 4.28 % (P = 29: 5.173597 to 4.951992) | search from the record 19, crystal cut 1 |
| `icoinoct` | 18 | 11-30 | 0.16 % | 1.96 % (P = 30: 6.617696 to 6.487819) | search from the record |
| `rcoinrco` | 1 | 5-5 | 0.09 % | 0.09 % (P = 5: 2.330957 to 2.328886) | search from scratch |
| `pr3incub` | 1 | 8-8 | 2.88 % | 2.88 % (P = 8: 1.921405 to 1.866026) | search from the record |
| `pr5l2incub` | 1 | 5-5 | 1.99 % | 1.99 % (P = 5: 3.393394 to 3.325841) | compute-study search |

The gains are largest where the search started from a packing of Berthold, Kamp et al. (293 records): pieces
other than the container's solid, mostly tetrahedra, with P >= 7. There the wiki's record was their published
packing itself, which the wiki's search had not improved. The first six problems (the five self-packings and
cubes in an octahedron) gave only 2 small gains [CALC]. The Archimedean, Catalan and prism records were not
swept, only the few cases of the benchmark above, so all but 3 of them stay the wiki's.

From P = 31 to 100, 674 records (median 7.92 %, 653 by more than 1 %, 233 by more than 10 %), all from the
results of the compute study of 2026-10-23, imported as they were (a packing of m pieces also gives every n < m
by deleting pieces; the container is then rescaled to a wall clearance of 1e-7). Per problem:

| problem | records | P | median gain | largest gain | how |
|---|---|---|---|---|---|
| `octinoct` | 6 | 95-100 | 9.68 % | 10.37 % (P = 97: 6.000001 to 5.377906) | lattice cut |
| `icoinico` | 6 | 95-100 | 14.30 % | 14.85 % (P = 97: 6.762263 to 5.757814) | lattice cut |
| `dodindod` | 34 | 67-100 | 19.10 % | 21.41 % (P = 79: 6.693234 to 5.260306) | lattice cut |
| `cubinoct` | 55 | 41-100 | 5.94 % | 9.63 % (P = 65: 7.235209 to 6.538254) | lattice cut |
| `octincub` | 23 | 53-100 | 2.63 % | 7.20 % (P = 97: 4.673265 to 4.336922) | lattice cut |
| `dodinico` | 1 | 100 | 15.38 % | 15.38 % (P = 100: 10.149366 to 8.588217) | lattice cut |
| `icoindod` | 38 | 63-100 | 13.27 % | 15.73 % (P = 63: 3.953275 to 3.331309) | lattice cut |
| `cubintet` | 60 | 41-100 | 7.60 % | 18.59 % (P = 41: 10.758893 to 8.758892) | fcc tetrahedral cut 35, lattice cut 21, search 4 |
| `cubindod` | 51 | 41-100 | 5.94 % | 10.73 % (P = 81: 2.948337 to 2.631969) | lattice cut |
| `cubinico` | 21 | 33-100 | 3.69 % | 5.20 % (P = 89: 4.460625 to 4.228553) | lattice cut |
| `octintet` | 9 | 31-100 | 6.67 % | 9.97 % (P = 98: 9.996984 to 9.000002) | fcc tetrahedral cut |
| `octindod` | 52 | 31-100 | 8.39 % | 12.50 % (P = 50: 2.150972 to 1.882153) | lattice cut |
| `octinico` | 34 | 67-100 | 8.93 % | 11.36 % (P = 97: 3.936279 to 3.489001) | lattice cut |
| `dodintet` | 70 | 31-100 | 15.89 % | 23.55 % (P = 35: 20.952291 to 16.017722) | fcc tetrahedral cut |
| `dodincub` | 62 | 31-100 | 6.66 % | 10.90 % (P = 31: 8.472137 to 7.548885) | lattice cut |
| `dodinoct` | 33 | 68-100 | 9.28 % | 20.68 % (P = 85: 15.957811 to 12.657436) | lattice cut |
| `icointet` | 22 | 31-100 | 10.42 % | 12.76 % (P = 97: 17.529809 to 15.292993) | fcc tetrahedral cut 19, search 3 |
| `icoincub` | 62 | 31-100 | 5.91 % | 11.65 % (P = 89: 7.757994 to 6.854103) | lattice cut |
| `icoinoct` | 20 | 81-100 | 7.91 % | 9.84 % (P = 85: 10.319821 to 9.304391) | lattice cut |
| `pr3inpr3` | 1 | 36 | 0.23 % | 0.23 % (P = 36: 3.894581 to 3.885609) | search |
| `ap4incub` | 12 | 85-96 | 2.34 % | 2.61 % (P = 91: 5.217892 to 5.081925) | search |
| `ap5inap5` | 2 | 56-57 | 0.17 % | 0.17 % (P = 57: 4.388640 to 4.381370) | search |

The cuts take the pieces of a lattice packing (or of a face-centred cubic arrangement of tetrahedral layers)
that fit in the container, with the lattice's position and orientation optimised; they beat the wiki most where
its large-P records of Platonic pieces in another Platonic container are loose. Every one is certified like any
other record (§4).

**Published values.** 736 values without coordinates are attached to 731 records; from P = 31 on only six, for
cubes in a cube: Friedman's 3.707107 for P = 31 to 33 and Ryan Xu's for P = 34 to 36, whose own packings are the
records of P = 33 to 36. The records lie above those six values by the wiki's clearance only (at most 1.3e-7
relative) [CALC]. Up to P = 30, 730 values are attached to 725 records. 667 are Berthold, Kamp et
al.'s published values (rounded up to 5 decimals); the records are below 468 of them by more than 1e-5 (188 with
the wiki's records alone) and above none beyond their printed precision [CALC]. The others are catalogue
values of Friedman's Packing Center and upstream's registry. The record lies above a published value by more than the printed precision in 5 cases, all
octahedra in a cube with only a published value: P = 11, 19, 23 (Walsh) and 12, 17 (Lin); no coordinates for
them are available [EST, upstream registry].

**Compute study.** The compute study of 2026-10-23 found 707 certified improvements over the wiki's records at
P <= 100 (699 by more than 1e-5), mostly lattice and crystal cuts at P >= 41; the prism and antiprism records
held up. Those for P > 30 are the 674 records above (with the subsets their packings give); those up to P = 30
are 13 of the 330.

### PolyPack's prism and antiprism problems

The 28 problems of §1 have no published values: their 2,772 records are PolyPack research, computed on
2026-10-25 (Apple Silicon, at most two processes at nice 10 beside other work, about 5 h 20 min of wall time) and
each certified (§4). They are best_known; nothing is known to compare them with but the volume bound [CALC].

1. **2D packings.** PolyPack's 2D solver (`packages/solver`, method harden, seed 1, at most 20,000 evaluations and
   25 s) packed m = 1 to 30 unit n-gons in a square (n = 7, 9, 10, 11), m = 1 to 20 unit 2n-gons in a square (the
   projections of the antiprisms, a regular 2n-gon of circumradius R) and m = 1 to 22 unit n-gons in an n-gon.
   Some larger m reached the time limit, which their records' method says; elsewhere they may end differently.
2. **Layered constructions.** k layers of prisms (height h) or antiprisms (height H) over the packing of m
   pieces: P = (k - 1) m + r pieces fit in s = max(k h, the 2D packing's side), in a cube or in the prism's own
   prism; for each P the best k.
3. **Crystal cuts.** Column packings (stacked pieces over a 2D periodic packing of their cross-section or
   projection), of which the P pieces that need the smallest container under a sampled and refined rigid motion
   are kept. The 2D packings were optimised numerically: the regular heptagon's best double lattice found has
   density 0.892691, Kuperberg and Kuperberg's value [EST]; 9-gon 0.9010 (double lattice), 10-gon 0.9137 (lattice;
   a centrally symmetric polygon packs densest in a lattice [EST, L. Fejes Toth]), 11-gon 0.9077 (double lattice);
   the antiprisms' projections 0.9075, 0.9162, 0.9073 and 0.9079 for 7, 9, 10 and 11 sides, and the antiprism
   fills 0.934 of its column for 7 sides. They are the only construction for antiprisms in their own antiprism.
4. **Searches** (`searchPolyhedra` at commit b7eb026, clearance 1e-7). From random positions for P = 2 to 12
   (seeds 1 and 2 with 400,000 evaluations for P <= 6 and 300,000 for P = 7 and 8; seed 1 with 300,000 for P = 9
   to 12). Then from the best configuration so far with seed 3: 500,000 evaluations for P <= 12, 150,000 for P = 13
   to 30 and 15,000 for P = 31 to 60 (40,000 for some P = 31 to 33); for the 11-sided problems, added later,
   300,000, 100,000 and 15,000. None from P = 61 on.
5. **Subsets.** The configuration of P + 1 less the piece that reaches farthest out, legalized and searched
   briefly (8,000 evaluations for P <= 30, 3,000 above), kept when it is better. Last, where a larger P of the
   same problem still had a smaller s (574 records, by at most 1.4e-7 relative, two of them visible at 6
   decimals: `pr9incub` P = 49 and 54), the record became that configuration less pieces, at the same s, so that
   s does not decrease with P.

Per problem (s / bound is the certified s over the volume bound; a record's lineage starts from a layered
construction, a crystal cut or random positions, and may end with a search or a subset step):

| problem | best s / bound (P) | median | worst (P) | lineage starts: layered / crystal cut / random | ends with a search / subset step |
|---|---|---|---|---|---|
| `pr7inpr7` | 1.0866 (100) | 1.1612 | 1.5793 (2) | 96 / 0 / 3 | 29 / 30 |
| `pr7incub` | 1.1189 (54) | 1.1664 | 1.3530 (3) | 90 / 0 / 9 | 19 / 40 |
| `pr9inpr9` | 1.0958 (95) | 1.1660 | 1.5853 (2) | 95 / 0 / 4 | 27 / 32 |
| `pr9incub` | 1.1137 (72) | 1.1765 | 1.3166 (4) | 88 / 0 / 11 | 29 / 30 |
| `pr10inpr10` | 1.0874 (21) | 1.1604 | 1.5846 (2) | 94 / 0 / 5 | 25 / 34 |
| `pr10incub` | 1.1038 (81) | 1.1721 | 1.3446 (7) | 89 / 0 / 10 | 23 / 36 |
| `pr11inpr11` | 1.0922 (21) | 1.1600 | 1.5866 (2) | 94 / 0 / 5 | 26 / 33 |
| `pr11incub` | 1.0936 (28) | 1.1776 | 1.3623 (13) | 92 / 0 / 7 | 28 / 31 |
| `ap7inap7` | 1.1038 (21) | 1.1909 | 1.5553 (2) | 0 / 90 / 9 | 44 / 45 |
| `ap7incub` | 1.1112 (20) | 1.1905 | 1.3074 (6) | 85 / 3 / 11 | 34 / 25 |
| `ap9inap9` | 1.1087 (21) | 1.1964 | 1.5716 (2) | 0 / 94 / 5 | 33 / 55 |
| `ap9incub` | 1.1030 (90) | 1.1889 | 1.3461 (13) | 87 / 3 / 9 | 29 / 30 |
| `ap10inap10` | 1.1052 (21) | 1.1964 | 1.5675 (2) | 0 / 91 / 8 | 48 / 19 |
| `ap10incub` | 1.0968 (99) | 1.1858 | 1.3585 (13) | 91 / 0 / 8 | 36 / 23 |
| `ap11inap11` | 1.0980 (21) | 1.1959 | 1.5820 (2) | 0 / 91 / 8 | 36 / 40 |
| `ap11incub` | 1.0983 (32) | 1.1904 | 1.3642 (2) | 90 / 0 / 9 | 38 / 21 |
| `pr7l15incub` | 1.1146 (100) | 1.1562 | 1.3896 (3) | 92 / 0 / 7 | 25 / 34 |
| `pr7l2incub` | 1.1093 (60) | 1.1648 | 1.5110 (2) | 93 / 0 / 6 | 33 / 26 |
| `pr7l3incub` | 1.1063 (54) | 1.1800 | 1.3200 (2) | 90 / 0 / 9 | 38 / 21 |
| `pr9l15incub` | 1.1112 (91) | 1.1685 | 1.4054 (3) | 92 / 0 / 7 | 29 / 30 |
| `pr9l2incub` | 1.1047 (60) | 1.1588 | 1.3956 (3) | 92 / 0 / 7 | 25 / 34 |
| `pr9l3incub` | 1.1010 (72) | 1.1628 | 1.4520 (2) | 92 / 0 / 7 | 35 / 24 |
| `pr10l15incub` | 1.1038 (54) | 1.1662 | 1.3807 (3) | 91 / 0 / 8 | 23 / 36 |
| `pr10l2incub` | 1.1014 (96) | 1.1683 | 1.4154 (3) | 86 / 7 / 6 | 28 / 32 |
| `pr10l3incub` | 1.1014 (64) | 1.1648 | 1.4907 (2) | 92 / 0 / 7 | 25 / 34 |
| `pr11l15incub` | 1.0936 (63) | 1.1741 | 1.3403 (6) | 92 / 0 / 7 | 32 / 27 |
| `pr11l2incub` | 1.1005 (45) | 1.1610 | 1.4037 (3) | 92 / 0 / 7 | 28 / 31 |
| `pr11l3incub` | 1.1004 (100) | 1.1583 | 1.5342 (2) | 93 / 0 / 6 | 38 / 21 |

All 2,772 records: s / bound 1.087 to 1.587, median 1.173; 863 end with a search that improved them, 874 with a
subset step, 1,035 are the legalized construction itself. Every one keeps 1e-7 between pieces and from the walls
(the float validator at tolerance 0: smallest pair separation 9.99999994e-8, wall gap 1.0e-7) and fails at
PolyPack's tolerance when its container is shrunk by 1e-6 relative. Two heptagonal prisms fit in their own prism
at s = 1.989843, below the s = 2 of two stacked ones (a search from random positions) [CALC].

**Bipyramids and trapezohedra** (2026-10-25) [CALC]. The 36 problems of §1 have no published values either: their
3,564 records are PolyPack research and baselines for the site's searches, not optimised further. They come from:

1. **Lattice and double-lattice packings** of each solid (translates, and for the solids without a centre of
   symmetry, the bipyramids of odd n and the trapezohedra of even n, also translates of K and of -K, a turned copy):
   minimum |det B| under the gauge constraints of the difference body, penalty method and basin hopping from 24
   starts. Densest found (n: density): bipyramids 3: 0.856, 5: 0.841, 6: 0.893, 7: 0.841, 8: 0.889, 9: 0.841,
   10: 0.875, 11: 0.845, 12: 0.863; trapezohedra 4: 0.841, 5: 0.953, 6: 0.830, 7: 0.879, 8: 0.837, 9: 0.870,
   10: 0.841, 11: 0.864, 12: 0.847 (double lattices for odd bipyramids and even trapezohedra, whose best single
   lattices reach 0.48 to 0.83). None is 1: these numerical optima are no
   proof that the solids do not tile [SPEC that they do not].
2. **Cuts**: the P pieces of the packing that need the smallest container, over a rigid motion of the packing
   (800 random motions and Nelder-Mead, seed 20261025), pieces moved apart by scaling their centres to a clearance
   of 1.5e-7.
3. **Searches** (`searchPolyhedra` at commit 07d2602, clearance 1e-7): from random positions for P = 2 to 14 (seeds
   1 and 2 with 30,000 evaluations to P = 6, seed 1 with 40,000 to 14; seeds 3 and 4 with 30,000 to P = 8) and for
   half of the cases of P = 15 to 24 (50,000); then from the best configuration so far with seed 1 (30,000
   evaluations to P = 30, 12,000 to 60, 6,000 above) and, to P = 20, seed 2 (40,000).
4. **Subsets**: from P = 100 down, the configuration of P + 1 less the piece whose removal allows the smallest
   container (best translation, wall clearance 1e-7); where a larger P still had a smaller s (58 records, by at
   most 9.1e-9 relative), the record is that configuration less a piece at the same s, so that s does not decrease
   with P.

Each record's `method` states its whole lineage and `origin` gives it in short. Per problem (s / bound as above;
lineage starts from a lattice cut, a double-lattice cut or random positions; the last step is a search, a subset or
the cut itself):

| problem | best s / bound (P) | median | worst (P) | starts: lattice / double lattice / random | ends with a search / subset / cut |
|---|---|---|---|---|---|
| `bp3inbp3` | 1.0400 (3) | 1.2796 | 1.3087 (35) | 0 / 83 / 16 | 86 / 13 / 0 |
| `bp3incub` | 1.1772 (4) | 1.2972 | 1.4030 (2) | 0 / 86 / 13 | 74 / 25 / 0 |
| `bp5inbp5` | 1.2174 (20) | 1.2626 | 1.4601 (2) | 3 / 83 / 13 | 88 / 11 / 0 |
| `bp5incub` | 1.1927 (8) | 1.2584 | 1.4691 (2) | 3 / 83 / 13 | 82 / 17 / 0 |
| `bp6inbp6` | 1.1696 (5) | 1.2360 | 1.4706 (2) | 88 / 0 / 11 | 90 / 9 / 0 |
| `bp6incub` | 1.2056 (26) | 1.2557 | 1.5036 (2) | 86 / 0 / 13 | 73 / 26 / 0 |
| `bp7inbp7` | 1.2063 (16) | 1.2635 | 1.4566 (2) | 17 / 72 / 10 | 82 / 17 / 0 |
| `bp7incub` | 1.2163 (53) | 1.2936 | 1.5843 (2) | 9 / 77 / 13 | 70 / 29 / 0 |
| `bp8inbp8` | 1.1993 (18) | 1.2432 | 1.4352 (2) | 92 / 0 / 7 | 81 / 18 / 0 |
| `bp8incub` | 1.2699 (91) | 1.3218 | 1.6529 (2) | 86 / 0 / 13 | 79 / 20 / 0 |
| `bp9inbp9` | 1.2156 (20) | 1.2515 | 1.4264 (2) | 20 / 71 / 8 | 86 / 13 / 0 |
| `bp9incub` | 1.3033 (19) | 1.3629 | 1.6649 (2) | 17 / 69 / 13 | 71 / 28 / 0 |
| `bp10inbp10` | 1.2002 (17) | 1.2441 | 1.4156 (2) | 91 / 0 / 8 | 76 / 23 / 0 |
| `bp10incub` | 1.3329 (14) | 1.3900 | 1.7686 (2) | 86 / 0 / 13 | 67 / 32 / 0 |
| `bp11inbp11` | 1.2112 (17) | 1.2477 | 1.4101 (2) | 38 / 53 / 8 | 81 / 18 / 0 |
| `bp11incub` | 1.3407 (20) | 1.4065 | 1.8702 (2) | 14 / 72 / 13 | 65 / 34 / 0 |
| `bp12inbp12` | 1.2042 (17) | 1.2438 | 1.4040 (2) | 91 / 0 / 8 | 75 / 24 / 0 |
| `bp12incub` | 1.3587 (17) | 1.4404 | 1.9685 (2) | 86 / 0 / 13 | 68 / 31 / 0 |
| `tz4intz4` | 1.2220 (26) | 1.2547 | 1.4191 (2) | 0 / 80 / 19 | 83 / 16 / 0 |
| `tz4incub` | 1.1842 (48) | 1.2579 | 1.4355 (2) | 6 / 80 / 13 | 75 / 24 / 0 |
| `tz5intz5` | 1.1730 (81) | 1.2114 | 1.4828 (2) | 86 / 0 / 13 | 75 / 24 / 0 |
| `tz5incub` | 1.1942 (57) | 1.2362 | 1.5291 (2) | 86 / 0 / 13 | 73 / 26 / 0 |
| `tz6intz6` | 1.2071 (19) | 1.2573 | 1.4555 (2) | 8 / 82 / 9 | 83 / 16 / 0 |
| `tz6incub` | 1.2383 (25) | 1.2779 | 1.5890 (2) | 34 / 52 / 13 | 74 / 25 / 0 |
| `tz7intz7` | 1.2002 (16) | 1.2396 | 1.4338 (2) | 93 / 0 / 6 | 79 / 20 / 0 |
| `tz7incub` | 1.2846 (15) | 1.3313 | 1.6357 (2) | 86 / 0 / 13 | 73 / 26 / 0 |
| `tz8intz8` | 1.2100 (16) | 1.2546 | 1.4230 (2) | 35 / 58 / 6 | 85 / 14 / 0 |
| `tz8incub` | 1.3117 (20) | 1.3643 | 1.6945 (2) | 32 / 54 / 13 | 69 / 30 / 0 |
| `tz9intz9` | 1.2046 (16) | 1.2413 | 1.4117 (2) | 89 / 0 / 10 | 86 / 13 / 0 |
| `tz9incub` | 1.3033 (18) | 1.4058 | 1.8139 (2) | 86 / 0 / 13 | 74 / 25 / 0 |
| `tz10intz10` | 1.2102 (16) | 1.2551 | 1.4068 (2) | 16 / 74 / 9 | 70 / 29 / 0 |
| `tz10incub` | 1.3558 (20) | 1.4144 | 1.9287 (2) | 20 / 66 / 13 | 71 / 28 / 0 |
| `tz11intz11` | 1.2099 (16) | 1.2448 | 1.3999 (2) | 91 / 0 / 8 | 88 / 11 / 0 |
| `tz11incub` | 1.3839 (20) | 1.4841 | 2.0394 (2) | 86 / 0 / 13 | 73 / 26 / 0 |
| `tz12intz12` | 1.2060 (17) | 1.2493 | 1.3974 (2) | 22 / 70 / 7 | 87 / 12 / 0 |
| `tz12incub` | 1.4078 (20) | 1.4734 | 2.1466 (2) | 24 / 63 / 12 | 59 / 40 / 0 |

All 3,564 records: s / bound 1.040 to 2.147, median 1.267; their lineages start from a lattice cut 1,727 times, a
double-lattice cut 1,428 times and random positions 409 times; 2,771 end with a search and 793 with a subset step.
The cube problems of the long solids are the loosest (s / bound up to 2.15 at P = 2 for dodecagonal trapezohedra:
the volume bound ignores their length of 17 against a width of 3.9).

## 7. Limitations and open questions

- The bipyramid and trapezohedron records are baselines: one or two short searches per case (at most 50,000
  evaluations, 6,000 from P = 61 on), started from lattice cuts or from scratch (§6).
- The 4D to 6D problems of the wiki are left out.
- The search's soft phase is less tight than upstream's for solids without an insphere (§5), and its fresh starts
  are far from the records at the budgets a browser can give; warm starts from the record are the useful mode.
- Only the Platonic records up to P = 30 were swept with the search; the Archimedean, Catalan and prism records
  (1,769 up to P = 30) were not, and the sweep used one seed and 150,000 evaluations per record. From P = 31 on
  no record was searched by this package; the PolyPack records there are the compute study's cuts and searches.
- Lineage is upstream's own record of it; it is not re-derived.
- An entry beats a research record only by more than `POLYHEDRA_RECORD_MARGIN = 1e-6` relative, a margin above the
  records' clearance (whose measured cost is at most 2.6e-7 relative); site entries compete with each other by
  the usual tie tolerance 1e-9 (§8).
- A server check of 100 of the largest solids takes up to 0.15 s of work for a record and could take longer for a
  crafted configuration with many near pairs (§5); it runs in slices of 20 ms, is charged to the address's
  verification budget, and an entry that could not be kept is not checked at all (§8).
- The records are not checked against the live wiki after build 2026-10-21 of its data bundle.
- PolyPack's 28 problems were searched only up to P = 60. From P = 61 on, 1,034 of their 1,120 records are the
  legalized constructions, whose layered gaps of about 1e-6 cost up to about 1e-6 of s relative, and 86 come from
  subset steps. Antiprisms in their own antiprism have no layered construction and are the weakest (median 1.19
  to 1.20 times the bound). No 3D lattice other than the column packings was tried for antiprisms. Their searches
  ran with the code of commit b7eb026, before phase B changed how the polish picks its first planes, so a rerun
  on main does not repeat the same search paths.

## 8. On the site: board, API and volunteer client

**Registry.** `@polypack/spaces` lists the space as `polyhedra` (user-facing: dimension 3D in 3D, kind Polyhedra):
ids `polyhedra/<code>/<P>`, the configuration `{s, pieces}`, P from 2 to `POLYHEDRA_MAX_P` = 500 (P = 501 and
above are refused as malformed), the validator above at the touching tolerance 1e-9, and the strict check at
1e-11 for an entry below a research record by more than the margin, or any entry without a research record.
`polyhedraDomain` defines the range, volume bounds and a bounded volunteer sample (500 ids, starting
at P = 101). The 14,850 existing records and their configurations are unchanged. The search registry runs
`searchPolyhedra` for a job (`@polypack/spaces/search`, method "polyhedra soft-to-rigid search").

**Large problems (P up to 500, 2026-10-26).** The board's domain picker offers every P from 2 to 500.
"Start from → Lattice arrangement" constructs a deterministic patch of the existing box lattice in the
piece's canonical orientation: non-overlapping axis-aligned bounding boxes separate the pieces, face supports
choose the smallest container about the origin for that patch, and a relative dilation of 1e-10 keeps clearance
through rounding. It uses code only, with no saved packing or optimization. The volunteer scheduler uses this
start when neither a record nor a site packing exists [CALC].

The validator yields during placement, wall checks and pair scans, targeting 20 ms per slice. Every P = 500
entry uses the existing heavy-check queue (one running, eight waiting). The address reserves up to 1,600 ms
for the two passes, reconciled against measured work; the shared verification budget is 4,000 ms/minute
(6.7% of one core). The unchanged 256 KiB body limit fits a full-precision 500-pose entry, tested at about
79 kB [CALC].

Board rounds above P = 100 increase the existing step-cost model's safety factor to 1.8 times its old value at
P = 500, on top of its 3.5-times slow-machine allowance. The 1,000-evaluation floor is relaxed for large P;
regular, fresh, grown and generic rounds are capped to the existing roughly 20-second slow-machine bound.
The sizing is deterministic and tested across all 150 solid pairs through P = 500; these bounds are cost-model
calculations, not a timing guarantee for arbitrary hardware [CALC].

**Keep rule.** An entry is kept when it beats the site's leader by more than the tie tolerance 1e-9 and the
research record's certified s by more than `POLYHEDRA_RECORD_MARGIN` = 1e-6 relative (`SPACE_RECORD_MARGIN`,
`beatsSpaceRecord`, `improvesSpaceBest`); the other spaces keep 1e-9 for both. The records keep the wiki's
clearance (up to 1e-7), so without the margin the same packing with its clearance removed would "beat" them.

**The server's checks.** An entry whose stated s cannot be kept is answered without a check (200, `valid: false`,
`checked: false`, a reason that says so), so that posting a research record back costs nothing; the board and the
volunteer client say "not kept" for it. Any other entry is checked in slices of about 20 ms of work
(`validateSpaceSubmissionAsync`), with a turn of the event loop between them, so that one check never holds the
server: [CALC] both checks of 100 truncated icosidodecahedra (the touching and the strict one) took 0.32 s of
work in all and held the loop for at most 22 ms (0.35 s in one piece before). An address has one check at a time
(another gets 429 with Retry-After), an estimate of its cost is reserved from the address's verification budget
before it starts and the rest charged after it (its work, not its waits), and the heavy checks (polyhedra from
P = 30) run one at a time on the server, at most 8 waiting their turn (a ninth is refused with 503, alone). [CALC]
16 entries at once that force a full check of 100 truncated icosidodecahedra (the public P = 99 record and a copy of
one piece), from one address or from four, held the loop for at most 23 ms, and a submission from another address
was answered as usual (before: 606 ms of lag, and 503 for everyone).

**Answers kept.** Every answer the server keeps (`/api/spaces`, the listings, the targets) is encoded once, and
every response sends those bytes, plain or gzip: a connection that is slow to read holds a reference, not a copy.
Gzip is made off the event loop. [CALC] 1,200 connections that asked for the whole targets list or the polyhedra
listing (3.4 MB), plain or gzip, and never read, grew the heap by 9 MB (before, 150 plain ones ran a server with a
230 MB heap out of memory).

**Targets.** The targets list (`/api/spaces/targets`) treats a site entry as the leader on the same rule, and
leaves out a problem whose record is within its margin of the lower bound (nothing could be kept below it: cubes
in a cube and triangular prisms in a triangular prism, P = 8, 27 and 64). With 14,850 problems the whole list has
16,657 targets with all seven spaces, 500 of them a sample of the balls space's domain (3.1 MB, 0.5 MB compressed;
16,157 and 3.0 MB before the balls space, 12,593 and 2.4 MB with 11,286 problems, 9,821 and 1.8 MB with the wiki's
8,514), so its largest `limit` is 20,000 (10,000 before PolyPack's prisms and antiprisms joined), and the volunteer client asks for all of
it, or for 10,000 or 2,000 from an older server. One encoded list is kept per filter (the spaces, and `max_P`; one at or above every listed P is no
filter), up to 16 MB in all (`SPACE_TARGETS_CACHE_BYTES`, the least recently used going first), and the answer of
any `limit` is a prefix of its bytes and a closing "]}", so that no limit builds an answer of its own. Only the
default 500, 2000, 10000 (older volunteer clients' limit) and the whole list are also kept gzip-compressed; other limits are sent uncompressed. [CALC] 32
clients cycling `limit` and `max_P` (512 requests in 2.2 s) held the loop for at most 27 ms, and submissions from
another address meanwhile were answered as usual (before: 820 ms of lag, and 503).

**API.** `/api/spaces/polyhedra/records` lists the 14,850 problems (6.0 MB, 0.5 MB compressed; 4.5 MB with the 11,286 before the
bipyramids and trapezohedra joined, 3.4 MB with the wiki's 8,514);
`/api/spaces/polyhedra/problems/<id>` adds the research configuration, read from its problem's file (§2).

**Board.** Dimension 3D in 3D, kind Polyhedra (`docs/spaces/BOARD.md`, "3D in 3D"): two menus of the 94 solids,
Piece and Container, grouped by family (Platonic, Archimedean and Catalan solids, prisms, antiprisms, prisms of
height 1.5, 2 and 3, bipyramids, trapezohedra; prisms by their number of sides), which make the code, and P.
`/api/spaces` describes the domain with those two fields and `joined: [{key: "code", parts: ["piece",
"container"], separator: "in"}]` (`packages/spaces/src/domain.ts`), not with 8,836 codes; an address
`#space=polyhedra/cubintet/12` opens as before. The board shows the values, a three.js drawing (instanced pieces and merged edges, solid or see-through, turned by drag or
keys; about 1 ms a frame for 100 of the largest solids on an Apple M1 Pro), and rounds of the search in a Web
Worker of at most about 20 s on a machine 3.5 times slower than the measured costs (16,800 evaluations at 11
cubes, 7,100 at 100 cubes, 2,600 at 100 truncated icosidodecahedra: jiggles; a second or two each here). A round
after the first starts from the best so far, which the search has polished, and takes it as it is. [CALC] A
"New arrangement" run of 60 s on Time alone, seed 1: 100 cubes reached 5.00059 against the record's 5 (0.01 %
above); 100 truncated icosidodecahedra 7.915 against 5.553 (43 % above; its first round, 3,400 evaluations, ends
72 % above). Large problems need a start from the record. Submit is offered only for a result the server would
keep.

**Volunteer client.** `--dimensions polyhedra` (or `all`) adds the space to the opt-in list of kinds; without the
option the client never asks the server about it. Its jobs are sized by time like the other spaces' and polled at
every evaluation: an abort of a job on 100 truncated icosidodecahedra from the record was answered after 0.16 to
0.33 s (the job then checks its best), of a fresh job on 100 pentagonal hexecontahedra within 10 ms [CALC]; a test
requires 2 s, and that a paused job uses no processor time (`apps/volunteer/test/pool.spaces.test.ts`). It reads
the whole targets list (`limit=10000`, or 2000 from an older server) and draws a space uniformly among those it
asks for, so polyhedra get their share of its searches.

## 9. Kernel for the generic methods

`polyhedraKernel({ code, P })` (`packages/polyhedra/src/kernel.ts`) is the space's kernel for the generic search
methods (`docs/methods/dimensions/README.md`). The space's own search (§5) stays the default, "Auto". P runs from 1
to 500, the largest P the server accepts; the factory refuses a larger one.

**State.** Six numbers per piece: its centre, then a rotation vector times the piece's circumradius, so that it
reads as a length. The rotation turns the piece's anchor orientation, a unit quaternion the kernel keeps in the
state; only `rebase` changes an anchor, by folding the rotation into it. The size is s and the bound the volume
bound (§1). A step of every variable is the piece's inradius. Centres are absolute, so changing s scales them.
`fromConfig` refuses a configuration outside the server's limits (§5: s at most 1e6, centres at most 1e4,
quaternion components at most 1e100 and norms at least 1e-6), so a method never works on a state no submission
could have.

**Energy.** The simulator's model (§5) in the units of the canonical solids. At shape t a piece is the solid
scaled by t about its centre and dilated by (1 - t) times its inradius: the solid at t = 1, its inscribed ball at
t = 0, and always inside the solid, because the solid's support in every direction is at least its inradius
[EST, elementary]. A pair's overlap is the soft pieces' exact penetration depth: twice the dilation minus the
signed distance of the cores, which is minus their penetration depth by the separating-axis test (§5) when they
overlap and their distance when they do not. A wall's overlap is the soft piece's support beyond the face. The
energy is the sum of the squared overlaps. Its gradient is analytic: the simulator's for the pairs and the extreme
vertex's lever arm for the walls, in world-frame rotations, which the left Jacobian of the exponential map takes
to the rotation variables. [CALC] It matches central differences to 1e-5 relative, for true and soft shapes and
rotations away from the anchor (`test/kernel.test.ts`). At t = 1 the model is exact, so a configuration valid at
tolerance 0 has zero energy. A state with a number that is not finite has energy Infinity. The kernel prunes the
edge-edge axes by the Gauss map when that is faster for the solid (it gives the same depth); the simulator's own
rule is unchanged.

**Other operations.**

- `finish`: the legalization and the polish of §5 (penalty weights 1e4 to 1e9, as the search polishes a start,
  clearance 1e-12), each result checked with the validator at tolerance 0; the smaller is kept. The polish polls
  the stop it is given, at every evaluation and between them, and a stop ends it with the legalized result. A state
  the server could not read finishes to nothing.
- `validate`: the server's rule (`packages/spaces/src/validate.ts`) for an entry that does not beat the research
  record: the configuration read as the server reads it, s not below the volume bound by more than 1e-9 relative,
  then the validator at the touching tolerance 1e-9. Left out: the server also checks an entry whose s is below the
  record's certified s by more than 1e-6 relative at the strict tolerance 1e-11 (§8). That needs the record, which
  the kernel does not have. Every configuration `finish` returns is valid at tolerance 0, so it passes that check
  too; only a start given to a method could pass `validate` and fail it.
- Random starts fill about 15 % of the container, with uniformly random orientations. `randomPose` writes its
  random orientation into the piece's rotation variables, so that writing the piece's variables back undoes it, as
  for `jiggle`.
- `shape`, `swap` (a piece's whole orientation) and `seeds`: patches of the lattice of the boxes that bound the
  turned piece, the canonical orientation first (plain, then with every second layer shifted by half a box), then
  random ones. The patch keeps the lattice points that need the smallest container. For cubes in a cube the first
  seed is the tiling at P = 8 and 27.

**Costs** [CALC]. Processor time on Apple Silicon, on a machine shared with other jobs (load average near 300 on 8
cores, so times vary by about 2 times between runs), after a squeeze from a random start. Energy with its
gradient, from the first measurement:

| problem | P = 10 | P = 50 |
|---|---|---|
| cubes in a cube | 0.024 ms | 0.22 ms |
| tetrahedra in a tetrahedron | 0.034 ms | 0.38 ms |
| octahedra in a cube | 0.050 ms | 0.40 ms |
| triangular prisms of height 3 in a cube | 0.039 ms | 0.34 ms |
| dodecahedra | 0.17 ms | 0.74 ms |
| disdyakis dodecahedra | 0.54 ms | 1.8 ms |
| truncated icosidodecahedra | 0.99 ms | 3.0 ms |
| pentagonal hexecontahedra | 3.9 ms | 8.5 ms |

A gradient costs about as much as the energy alone (0.9 to 1.4 times), so `gradCost` is left at 1. A finish takes
a fixed part and a few ms per piece for every solid, while the energy's cost per piece grows with the cost c of
one overlapping pair's separating-axis test (modelled from the solid's numbers of vertices, edges and edge
directions, in microseconds). Fitted to the medians of three random starts for 12 solids at P = 2, 3, 5, 10, 20,
40 and 80 (82 cases), `finishCost` is (1150 + 250 P) / (P (1 + c / 35)): 805 for 2 cubes and 266 for 50, 80 for
2 truncated icosidodecahedra and 27 for 50, from 10 to 805 over the 114 problems. The measured ratio was 0.44 to
2.4 times it in 80 % of the cases (median 0.94) and 0.14 to 5.7 in all: the polish takes from a few to hundreds
of iterations, depending on the state it starts from, and the three starts of one case differed by up to 10
times. A validate costs 1 to 4 energies in 90 % of the cases (median 1.9), more at small P (up to 18 for 3
truncated icosidodecahedra), so `validateCost` is 2 + 4 / P. `POLYHEDRA_KERNEL_BENCH=1` runs the measurement in
`test/kernel.test.ts`.

**Limitations.** The energy's gradient jumps where a pair's best axis or a wall's extreme vertex changes; the
polish avoids this with separating planes as variables, which the kernel's state does not have. A finish told to
stop still legalizes its start: [CALC] at 100 truncated icosidodecahedra from the record that took 0.24 s of
processor time, against 1.4 s for the whole finish.
