# 2D on 3D, Platonic surfaces: PolyPack on the surface of a Platonic solid

**Dimension.** On the site this is the kind **Platonic surfaces** under the dimension **2D on 3D**: flat
pieces on a closed surface in 3D, with no container. The API calls it the space `surface`.

PolyPack's pieces (unit disks, or regular N-gons of side 1) packed on the surface of a regular
tetrahedron, cube, octahedron, dodecahedron or icosahedron of edge s. The score is the smallest
edge s. Two record tracks:

- **nofold**: every piece lies in one closed face;
- **fold**: rigid flat pieces may cross edges, folding onto the neighbouring faces.

Every table entry carries a certificate checked by an independent rigorous certifier
(`python/surface/cert.py`), so its validity is proven, not just tested. Tables:
`data/surface/records.json`; results summary: [SURFACE_RESULTS.md](SURFACE_RESULTS.md).

Labels: [EST] established and sourced, [CALC] computed or proved here, [SPEC] speculation.

## 1. Problem definition

**Solid and surface.** H is one of the five Platonic solids with edge s; F faces, each a regular
M-gon (M = 3, 4 or 5). Its surface S is flat except at the vertices, which are cone points with
cone angle = (faces at the vertex) x (face angle) [EST, standard]:

| solid | F | M | faces per vertex | cone angle |
|---|---|---|---|---|
| tetrahedron | 4 | 3 | 3 | pi |
| cube | 6 | 4 | 3 | 3 pi/2 |
| octahedron | 8 | 3 | 4 | 4 pi/3 |
| dodecahedron | 12 | 5 | 3 | 9 pi/5 |
| icosahedron | 20 | 3 | 5 | 5 pi/3 |

Distances are intrinsic (lengths of curves on S). The metric depends only on how the faces are
glued, not on the embedding in space.

**Faces and frames.** Vertices are listed in a fixed order (section 6). A face is the cycle of
its vertex ids, counter-clockwise seen from outside, rotated to start at its smallest id; faces
are sorted lexicographically. Face f's frame is the regular M-gon of side s centred at the origin
with a horizontal bottom edge (PolyPack's container convention with phi = 0): frame vertex k is
at angle -pi/2 + pi/M + 2 pi k/M and is the solid's vertex `faces[f][k]`; edge k runs from frame
vertex k to k+1. The combinatorics is committed in `data/surface/solids.json`.

**Pieces and poses.** Shape code N as in PolyPack: N = 0 is a disk of radius 1, N >= 3 a regular
N-gon of side 1 whose vertex k sits at angle theta + pi/2 + 2 pi k/N about its centre. A pose is
(face f, x, y, theta): the centre (x, y) in the closed face f, in f's frame, and the angle in that
frame (radians).

**Development.** A piece K is placed by developing it from its centre c: each point q of K is
reached by the straight segment from c to q, continued across every edge it meets by unfolding
the next face into the plane (as when a ribbon is laid flat over the edge). This defines a map
D: K -> S whenever no segment [c, q) hits a vertex. [CALC] Any rigid flat placement, meaning a
continuous map from K to S that is a local isometry on the interior of K, agrees with this one
once the image of c and the direction of one ray are fixed (K is convex, so its interior is
simply connected and a local isometry continues uniquely along segments from c); so nothing is
lost by developing from the centre.

**Validity.**
- *nofold*: each piece lies in its closed anchor face (it may touch edges and vertices); pieces
  on the same face have disjoint interiors. Pieces on different faces never overlap, because the
  open faces are disjoint.
- *fold*: (1) the centre lies in the closed anchor face; (2) no cone point lies in D(int K);
  (3) D is injective on int K (the piece does not wrap onto itself); (4) the images of the
  interiors of distinct pieces are disjoint.

A cone point may lie on a piece's boundary. [CALC] No angle condition is needed there: at a
boundary point a convex piece occupies an angle of at most pi (pi on a smooth arc or a straight
side, the interior angle at a polygon corner), and every cone angle above is at least pi, so the
development never needs more angle than the vertex has. On the tetrahedron (cone angle exactly
pi) a disk or a polygon side through a vertex fills the whole angle there; its two boundary
rays then meet, which is touching, not overlap.

**Score and ids.** The score is s, the edge length, for side-1 polygons or radius-1 disks.
Problem id: `surface/<solid>/<mode>/<N>/<P>`, e.g. `surface/cube/fold/4/12`.

**Changes against the brief, flagged.**
1. The brief allowed a cone point on a piece's boundary with no further condition; this is kept,
   and the remark above shows that no angle condition is needed.
2. Poses must put the centre in the closed anchor face (a representation rule: every placement
   has such a pose). A centre exactly on an edge is allowed; stored exact constructions move such
   centres 1e-12 into one face, which the certificate's shrink absorbs.

## 2. Facts used by the tables

**2.1 nofold reduces to PolyPack** [CALC]. Let s2(N, M, k) be the smallest side of a regular M-gon
holding k pieces (PolyPack's problem N/M/k). Then

  s_nofold(H, N, P) = s2(N, M, ceil(P / F)).

Proof. Upper bound: put an optimal k = ceil(P/F) packing in each face (the face is a regular M-gon
of side s2) and keep P of the F k >= P pieces. Lower bound: in a nofold packing some face holds at
least ceil(P/F) pieces, all in that closed face with disjoint interiors, which is a 2D packing,
so s >= s2(N, M, ceil(P/F)). The true s2 is non-decreasing in k (drop a piece), so the formula is
exact for true optima. With best-known 2D values the best upper bound is the envelope
min over k >= ceil(P/F) of s2_best(N, M, k); this table uses k up to 8. The envelope picked a
larger k only at ties (2 and 3 hexagons in a triangle both need side 5; 3 and 4 octagons in a
square both need 2 + 2 sqrt 2), where the larger packing's coordinates scored a few 1e-13 lower.

**2.2 fold <= nofold** [CALC]: a nofold packing is a fold packing (each piece's development is
the piece itself inside its face). Also s_fold(P) <= s_fold(P+1): remove a piece. A fold record
exists where a fold search ran or a fold construction is known (an exact tiling, or a better
P+1 fold packing minus one piece); it is the best certified of: the search result, the nofold
packing certified in fold mode, the exact tiling, and the P+1 packing minus a piece. Where no
fold record exists, s_fold <= s_nofold is all that is claimed.

**2.3 Disks are geodesic balls** [CALC]. Let p be a disk's centre. On a convex polyhedral surface
a shortest path never passes through a vertex in its interior, because every cone angle is below
2 pi [EST: Mitchell, Mount, Papadimitriou 1987, doi:10.1137/0216045; Alexandrov]. Hence:
- *No cone point in the interior* holds exactly when every vertex is at surface distance >= 1
  from p: a vertex at distance d < 1 is reached by a straight shortest path of length d, which is
  a radius of the disk; conversely a radius hitting a vertex at length t < 1 makes d <= t.
- *Image = ball.* D(int K) is the open geodesic ball B(p, 1): every image point is reached by a
  path of length < 1; every point q with d(p, q) < 1 is the end of a straight shortest path from
  p, i.e. of a radius.
- *Disjointness.* Two such disks overlap exactly when d(p, q) < 2: if d < 2 the midpoint of a
  shortest path lies in both open balls; if a point lies in both, d < 1 + 1.
- *Embedding* (injectivity is not automatic). D is injective on the open disk exactly when every
  geodesic loop at p (a straight path from p back to p avoiding the vertices) has length >= 2.
  If a loop of length L < 2 exists, its midpoint is the image of two different radii of length
  L/2. Conversely suppose D(a) = D(b) for a != b in the open disk. Such pairs do not accumulate
  at the diagonal (D is a local isometry there), so max(|a|, |b|) attains a minimum rho < 1 at
  some pair. Then |a| = |b| = rho, else the shorter one could be lengthened slightly while the
  longer one is shortened (local inverse of D). And the two radii meet head-on at D(a): otherwise
  some direction at D(a) shortens both, again lowering rho. Two radii meeting head-on form a
  geodesic loop of length 2 rho < 2.

So a disk packing is valid exactly when all vertex distances are >= 1, all centre distances are
>= 2, and all geodesic loops at the centres are >= 2. Both the validator and the certifier use
this form for disks. A "loop" that runs through a vertex (a limit case of the closed wedges below)
has length d(p, V) + d(V, p) >= 2 whenever the vertex condition holds, so counting it changes
nothing.

**2.4 Developing a piece: chains and parts** [CALC]. A ray from c that avoids the vertices
crosses a sequence of edges e1, e2, ... (a chain); unfold the faces it passes into the plane of
the anchor frame. For a chain C, let W(C) be the intersection of the cones from c over the unfolded
edges e1..ek. Lemma: a ray whose direction lies in the interior of W(C) crosses e1, ..., ek in this
order and runs inside each unfolded face between consecutive crossings. (Each unfolded face lies
in the closed half-plane beyond the line of the edge it was entered through; a ray crosses a line
once, so the crossing parameters increase; equality means the ray hits the common vertex.)
Therefore the part of the piece on the last face f_k is

  part(C) = K ∩ (unfolded f_k) ∩ W(C),

a convex set, mapped into f_k's own frame by the inverse unfolding. The parts of all chains
cover D(K) and, when no vertex lies in K, two parts of one piece share no interior point unless
the piece overlaps itself. So condition (3) and (4) of fold validity become: on every face, the
parts of all pieces (two parts of one piece included) have disjoint interiors.

Enumeration: depth-first over chains from the anchor face; a branch is cut only when no
vertex-avoiding ray of length <= reach (the piece's circumradius, or 2 for disk distances) can
follow it:
- the edge lies farther than reach from c;
- c lies strictly beyond the edge's line (no ray from c can cross it outwards);
- the wedge W(C) has empty interior (a wedge of width 0 is a single ray through a vertex);
- *turn rule*: a straight line not through a vertex V sees V under exactly pi, so it can cross
  consecutive edges around V only while the faces passed between them have face angles at V
  summing to less than pi (at most 2 triangles, 1 square or 1 pentagon).
Termination: between two turns around different vertices a ray travels at least c_M s (for
example sqrt(3)/2 s for triangles), so a ray of length L crosses O(L/s) edges.

**2.5 The shrink certificate** [CALC]. Scaling the solid by 1/lam scales its intrinsic metric, so
"pieces scaled by lam about their centres at edge s" is similar to "unit pieces at edge s/lam with
centres scaled by 1/lam in their frames". If a configuration is valid (pieces may touch), the
pieces scaled by lam < 1 are valid with positive clearance: lam K lies in the interior of K
together with its centre, so every touching becomes a gap and every cone point on a boundary
moves strictly outside. The certifier proves the scaled configuration strictly valid and states
score_cert = s / lam rounded up to a float; score_float = s. Here lam = 1 - eps with eps = 1e-12
for almost every entry. The displayed value is score_cert rounded to 6 decimals (nearest, ties to
even, from its exact binary64 value), PolyPack's rule for every space since 2026-10-24: an exact 2
shows as 2.000000 although score_cert is 2.000000000002. The display is a readable value, not a
bound; score_cert is the certified bound.

**2.6 Lower bounds** [CALC].
- Area: P a(N) <= area(S) = F M s^2 / (4 tan(pi/M)), with a(N) the piece area.
- One piece: the inscribed disk of a piece (radius 1 for disks, the apothem for polygons) must
  contain no cone point, so some point is at distance >= r from every vertex. Each point of a
  face is within the face's circumradius R_f = s / (2 sin(pi/M)) of a corner of that face (a
  regular polygon is the union of the triangles (centre, v_k, v_k+1), and in such a triangle with
  apex angle 2 pi/M <= 2 pi/3 the apex is the farthest point from both base corners). So
  s >= 2 sin(pi/M) r. For one disk this is attained at a face centre (the validator and
  certifier accept s = 2 sin(pi/M)(1 + 1e-12)), so s_fold(H, 0, 1) = 2 sin(pi/M): sqrt(3) for the
  deltahedra, sqrt(2) for the cube, 2 sin 36 deg for the dodecahedron.
- The stored bound of each entry is the larger of these two. Nothing is called optimal: where a
  value meets its bound this is stated as a [CALC] fact; the status stays `best_known` as
  PolyPack's policy requires.

## 3. Exact cases

**Squares on the cube** [CALC] (the Goldberg–Coxeter construction [EST: Goldberg 1937;
Coxeter 1971; Dutour, Deza 2004, doi:10.37236/1773]). Let s^2 = a^2 + b^2 with integers a, b.
Rotate the unit square lattice so that a e1 + b e2 is the bottom edge of a face; then all four
corners of every face are lattice points. A gluing maps a corner to a corner and rotates by a
multiple of 90 degrees, which maps the square lattice onto itself, so the lattices of all six
faces fit together across the edges and the unit cells tile the surface. Pieces = cells:
P = 6 (a^2 + b^2) = 6, 12, 24, 30, 48, ... at s = 1, sqrt 2, 2, sqrt 5, sqrt 8. Cell centres are at
half-integer lattice points, never at a vertex (an integer point); cone points are cell corners.

**Triangles on the deltahedra** [CALC] (the Caspar–Klug construction [EST: Caspar, Klug 1962,
doi:10.1101/SQB.1962.027.001.005; Goldberg 1937]). With s^2 = h^2 + hk + k^2 = T, rotate the unit
triangular lattice so that h u + k v is a face's bottom edge; gluings rotate by multiples of
60 degrees, which preserve the tiling by unit triangles. P = F T: tetrahedron 4, 12, 16, 28, 36;
octahedron 8, 24, 32, 56, 72; icosahedron 20, 60, 80 (T = 1, 3, 4, 7, 9).

**Hexagons on the tetrahedron and the octahedron** [CALC] (added in the re-run of 2026-10-24). The
tiling of the plane by unit hexagons descends to a surface when the rotation about every cone
point by its cone angle (the holonomy) is a symmetry of the tiling and no cone point is a hexagon
centre. On the tetrahedron the holonomy is a half turn, so the cone points must be midpoints of
hexagon sides; the tetrahedron is the plane modulo the half turns about the points of a
triangular lattice, so it suffices that this lattice is a sublattice of the hexagon centres'
lattice (spacing sqrt 3) moved to a side midpoint. On the octahedron the holonomy is a third of a
turn, so the cone points must be hexagon vertices, all of one class (they form a triangular
lattice of spacing sqrt 3). With T = h^2 + hk + k^2 the face side is s = sqrt(3T) and
P = area / hexagon area = 2T on the tetrahedron, 4T on the octahedron: tetrahedron P = 2, 6, 8,
14 at s = sqrt 3, 3, sqrt 12, sqrt 21; octahedron P = 4, 12, 16 at s = sqrt 3, 3, sqrt 12 (and 28
beyond the table). The tiling is placed in face 0's frame and developed onto the other faces;
each construction is float-checked and certified. The construction cannot apply on the
icosahedron (a sixth of a turn is a symmetry only about hexagon centres) or on the cube and the
dodecahedron (a quarter turn and a tenth of a turn are not symmetries of the tiling).

These cases meet the area bound exactly, so they are best possible [CALC: P a(N) = area(S)];
status `best_known` with that note. Construction code: `packages/surface/scripts/build-exact.ts`.
[SPEC] Perfect tilings at other sizes were not searched for.

**One-piece replicas** [CALC] (added after the independent review, which found ten fold entries
beaten or settled this way; `packages/surface/scripts/build-replicas.ts`). Take the best one-piece
placement of a shape: the closed form where the one-piece bound s = 2 sin(pi/M) r_in(N) is attained
(disks, and polygons whose N is a multiple of M, centred on a face with the face's corners at
the midpoints of the piece's sides), and the best P = 1 search result. The rotation group of a
Platonic solid acts simply transitively on (face, corner of the face) pairs, so the placement can
be moved to any face in any of the M frame rotations, and mirrored. Fold validity is a condition
on single pieces plus pairs, so copies whose pairwise placements are valid form a packing. A
maximum clique of this compatibility graph (exact Bron–Kerbosch search over at most 2FM copies)
has size 1 on the tetrahedron, 2 on the cube and the octahedron, 3 on the dodecahedron and 4 on
the icosahedron, for every shape. It gives packings of P = 1 up to that size at the one-piece
value; with the closed form they meet the one-piece bound. Example: two squares on opposite cube
faces at s = 1/sqrt 2. The clique search is exhaustive over the copies of each placement, so,
for example, five triangles on the icosahedron at s = 1/2 cannot be made from copies of the
closed-form placement [CALC] (the reviewer's reason: the icosahedron's dual graph has no perfect
code, while the octahedron's two copies cover its surface exactly).

## 3b. Results in brief

Full tables: [SURFACE_RESULTS.md](SURFACE_RESULTS.md); data: `data/surface/records.json`
(2038 records: 1248 nofold, 790 fold; all certified, 1980 at eps = 1e-12, 16 at 3e-12 and 42
at 1e-11, so score_cert exceeds score_float by at most 1.0e-11 relative). Fold searches cover every
solid and every N in {0, 3, 4, 5, 6, 8} for P = 1..24 (720 problems); the nofold tables cover
P = 1..max(4F, 24).

- **Folding always helps except where a face packing is already tight** [CALC]. Mean gains
  1 - fold/nofold over P = 1..24 range from 12.9% (triangles on the icosahedron, where nofold is
  often tight) to 40.4% (squares on the icosahedron). Of the 720 searched problems, 17 show no
  gain: squares on the cube at P = 5, 6 and 21-24 (s = 1 and 2 either way), octagons on the cube
  at P = 6 and 22-24, triangles at P = F (tetrahedron, octahedron, icosahedron) and P = 15, 16 on
  the tetrahedron, and pentagons on the dodecahedron at P = 11, 12 (one pentagon per face of side 1).
- **The gain is a sawtooth in P with period F**: it peaks just after P passes a multiple of F
  (P = kF + 1, where nofold must fit one more piece into every face) and is smallest at P = kF.
  The largest gains (50-54%) are at P = 1 and 2, where a single piece may spread over several
  faces: one unit triangle covers the whole tetrahedron of edge 1/2 (it is the tetrahedron's
  triangular net), against edge 1 without folding.
- **Exact cases** (section 3) meet the area bound: 12 squares on the cube at s = sqrt 2
  (nofold 2), 12 triangles on the tetrahedron and 24 on the octahedron at s = sqrt 3 (nofold 2),
  60 triangles on the icosahedron at sqrt 3 (nofold 2).
- **68 entries meet a lower bound** (listed in SURFACE_RESULTS.md with their gaps): score_cert /
  bound - 1 is at most 3 eps, the float rounding of s plus the certificate's shrink, so they are
  best possible [CALC]. With the one-piece replicas (section 3) these include, at the one-piece
  bound 2 sin(pi/M) r_in(N): disks (2 sin(pi/M)) for P = 1 on the tetrahedron, P <= 2 on the cube
  and octahedron, P <= 3 on the dodecahedron and P <= 4 on the icosahedron; squares and octagons
  on the cube for P = 1, 2 (1/sqrt 2
  and 1 + 1/sqrt 2: the face's corners sit at the midpoints of the piece's sides); pentagons on the
  dodecahedron for P <= 3 (phi/2); triangles (1/2) and hexagons (3/2) for P = 1 on the
  tetrahedron, P <= 2 on the octahedron and P <= 4 on the icosahedron. Two squares on the cube
  are exactly 1/sqrt 2 [CALC] (opposite faces). The five fold entries that the first build left
  within 1e-6 of their bound (hexagons on the tetrahedron at P = 2, 6, 8, 14 and on the
  octahedron at P = 4) are exact hexagon tilings (section 3), as are hexagons on the octahedron
  at P = 12 and 16.
- Cross-checks: the cube disk values agree with the earlier exploratory experiment where both
  exist (P = 6: 1.961568; P = 12: 2.730486); that experiment's P = 2 value sqrt 2 was missed by
  the first search pass (two disks landed on adjacent faces) and found by the second.
- An independent review (2026-10-24) found no soundness defect in the certifier; it found ten
  fold entries that copies of the one-piece placement beat or settle, which led to the replica
  family above. That family changed 37 fold entries, 13 of them by more than 0.1%, e.g. three
  and four triangles on the icosahedron from 0.601948 and 0.612234 to 1/2 and two octagons on
  the cube from 1.942810 to 1 + 1/sqrt 2.

## 4. Software

- `packages/surface` (@polypack/surface, TypeScript): solids and frames (`solids.ts`, `rigid.ts`),
  chain enumeration (`chains.ts`), parts (`parts.ts`), float validator (`validate.ts`, PolyPack's
  touching tolerance 1e-9), fold search (`search/`), scripts to build nofold and exact
  configurations and to drive the search, and the viewers in `viz/`. It imports
  `polygonSeparation` and `pieceVertices` from @polypack/geometry.
- `python/surface` (certifier, standard library + mpmath only): `numfield.py` (exact arithmetic in
  Q, Q(sqrt 3) and Q(sqrt(10 + 2 sqrt 5))), `geom.py` (independent construction of the solids by an
  exact convex hull; exact frames and gluings), `cert.py` (certifier), `run_cert.py` (eps ladder,
  certificate bundles), `test_cert.py`.

**What the certifier decides, and how** [CALC].
- Inputs are taken as exact rationals (every float is a dyadic rational).
- Chain topology is decided exactly: unfolded vertices and the centre lie in Q (cube), Q(sqrt 3)
  (deltahedra) or Q(sqrt(10 + 2 sqrt 5)) (dodecahedron); the sign of an element is exact (zero
  test on coefficients, then interval evaluation at increasing precision). Exact degeneracies
  (rays exactly through vertices, frequent in symmetric constructions) are therefore handled
  correctly. Distance cuts compare exactly or with intervals and cut only when certain.
- Disks: all distances and vertex tests are exact (squared distances in the field).
- Polygons: anything involving theta uses mpmath intervals at 128 bits. A part is the set of
  points satisfying N piece half-planes, 2 wedge half-planes and M face half-planes. Two parts
  are separated by a *disk witness* (bounding disks apart) or a *Farkas witness*: multipliers
  mu >= 0 on at most three of the half-planes a.x <= b. With r = sum mu a and beta = sum mu b,
  every common point x would satisfy r.x <= beta, while every point of the part lies in the disk
  (c, rho), so r.x >= r.c - |r| rho; the witness is accepted when r.c - |r| rho - beta > 0 holds
  in interval arithmetic. The multipliers come from an untrusted float search (separating axis of
  the clipped parts, else all pairs and triples; by Helly's theorem three half-planes suffice in
  the plane). They are only clamped to >= 0, not rounded: floats are exact rationals, so the
  stored witness is exactly the one verified, while rounding a multiplier by a relative delta
  would cost about delta times the piece size in certified clearance. Parts that float clipping
  finds empty need their own Farkas witness; otherwise they stay in the pair checks.
- Cone points: each vertex of each chain's face is proved outside the closed wedge (exact) or
  strictly outside the scaled piece (interval).
- nofold: every piece vertex strictly inside the face (interval), disks at distance > lam from
  every edge line (exact), pairs on a face by the same witnesses.

- Work limits for untrusted input: before enumerating a piece's chains, the vertices of its
  anchor face are checked (a piece far too large for its solid always contains one, because
  every point of a face is within the face's circumradius of a corner), and more than 5000
  chains for one piece is a failure (real records use at most 20). Coordinates, s and theta are
  bounded by 1e6 and P by 10000. Malformed input raises CertError.

**Records mode.** `python3 python/surface/cert.py RECORDS.json` checks, for every record, that the
id is `surface/<solid>/<mode>/<N>/<P>` for the record's fields, that s == score_float, that eps is
present, that score_cert is exactly s / (1 - eps) rounded up to a float and that display is that
float rounded to 6 decimals; it then certifies the configuration at that eps and compares again.
Every problem, including malformed records (missing fields, eps "nan", unknown solid, non-object
records), is reported as FAIL and the run continues.

Certificates: `data/surface/certificates/<solid>_<mode>.json.gz` (gzip-compressed JSON), keyed by
record id: per pair of parts the face, pieces, chains, witness type, constraint labels (A/B part,
P piece edge, W wedge, F face edge) and multipliers, and a rounded-down clearance; per piece the
chain count and the cone clearance. They document what was proved; no separate witness checker
reads them, so the check is to re-run the certifier (about 6 minutes for every record).
`run_cert.py` keeps a cache of certificates whose key includes the certifier version and a hash of
`cert.py`, `numfield.py` and `geom.py`, so a changed certifier never reuses old results.

## 5. Search (fold track)

Seeded and deterministic for given counts (`packages/surface/src/search`). Pieces are developed
on the solid of edge 1 and scaled by lam (the score is 1/lam). Energy: squared penetration depths
of overlapping parts on every face (polygons, separating-axis depth), squared cone-point depths
(each vertex counted once, at its deepest appearance, so the energy is continuous), and for disks
the distance form of 2.3. Local solver: L-BFGS (analytic gradient for disks; for polygons central
finite differences of each piece's local energy, with one-sided differences across the jumps that
occur while a cone point is inside a piece); a centre crossing an edge is re-anchored in the
neighbouring face and the L-BFGS memory is rotated into the new chart. Compression: disks grow
lam geometrically with fixed-scale relaxation; polygons use a penalty -lam + mu E with lam as a
variable (mu = 1e2 .. 1e8), then back off and bisect to the largest lam that relaxes to zero
energy. Starts: the nofold packing, the exact tiling where one exists, the best result for P - 1
plus a random piece, random placements; then basin hopping (move or re-place 1 to 3 pieces).
The best packing is relaxed at lam (1 - 1e-10) to energy below 1e-26, then polished by a contact
linear program (`slp.ts`: linearise every near contact by finite differences, maximise d lam in a
trust region with a small dense simplex, accept a step only if the moved packing is still valid)
and float-checked before certification. A second pass polished the first pass's results the same
way (`scripts/polish.ts`). Seeds, start and hop counts and the time limit are stored with each
record; a run that hit its time limit is flagged (`budget.deadline_hit`) and is not exactly
reproducible.

**Re-run of the time-limited searches** (2026-10-24, evening). The 12 published search results
that had hit their time limit were run again with the same seeds, start and hop counts and warm
starts (the earlier results of the same run were replayed as the "P - 1" or "P + 1" starts): four
with the same time limit, then all others with a 1500 s limit so that the run is decided by its
counts. With the same 150 s limit, tetrahedron disks P = 13 and 22 and cube disks P = 19 gave the
published values again (to 1e-12); cube disks P = 18 finished inside the limit at 3.427469 (from
3.445888).
Counted runs: tetrahedron P = 13 5.291355 -> 5.196152 (finished, 1224 s); cube P = 19 3.498175 ->
3.491976, P = 22 3.747830 -> 3.744177, P = 23 3.839958 -> 3.839191 (finished); octahedron P = 22
4.929035 -> 4.929022 (finished); octahedron P = 11 and 21 and icosahedron P = 23 finished with
the published values (icosahedron 4e-11 above the published, polished value), so these are now
reproducible from their seeds; cube P = 24 3.928892 -> 3.882425, tetrahedron P = 22 and
dodecahedron P = 23 (unchanged) reached the 1500 s limit again. A record was replaced only by a
certified better one; its seed, counts, limit and time are stored with it (`search_file` names the
re-run). Machine load stayed high during the re-run (load average about 30), so times are not
comparable with the first build.

## 6. Conventions in code

Vertex order (unit edge; the scale does not affect the combinatorics):
- tetrahedron: (1,1,1), (1,-1,-1), (-1,1,-1), (-1,-1,1);
- cube: vertex i = (+-1/2, +-1/2, +-1/2) with + in coordinate t when bit t of i is set;
- octahedron: (1,0,0), (-1,0,0), (0,1,0), (0,-1,0), (0,0,1), (0,0,-1);
- icosahedron: the cyclic patterns (0, +-1, +-phi), (+-1, +-phi, 0), (+-phi, 0, +-1), signs in the
  order (+,+), (+,-), (-,+), (-,-);
- dodecahedron: the 8 cube vertices (+-1, +-1, +-1) in the cube order, then the cyclic patterns
  with (1/phi, phi).

Gluing: edge k of face f meets edge l of face g with g's frame vertex l+1 on f's k and l on f's
k+1; the unfolding map from g's frame into f's plane rotates by 2 pi (k - l)/M + pi.

## 7. Sources

- PolyPack 2D values: `data/records.json` in this repository (generated 2026-10-20; each record
  names its literature source, URL and access date) and the live site's public atlas
  `GET https://polypack.fly.dev/api/atlas?N=..&M=..&from=1&to=8` (read 2026-10-24, 18 requests;
  the site re-validates every entry with touching tolerance 1e-9). Each nofold record names the
  source of its face packing. Where the face packing came from a site entry (`face_packing.kind`
  = `polypack_site`, with the entry id and the site's score; 254 of the 1248 nofold records), its
  coordinates are those the atlas returned on 2026-10-24. Their validity does not rest on the
  site: every face packing is re-scored from its coordinates and certified here like any other
  configuration. What could not be checked offline is that the coordinates still match the cited
  site entry; per the independent review, 106 of these records are up to 1.0e-6 better than what
  the local `data/records.json` coordinates give.
- Exploratory cube-surface experiment of the PolyPack generalisation note (2026-10-23), used only
  as a cross-check: its flat-disk values for the cube agree with this search where both exist
  (P = 6: 1.961568; P = 12: 2.730486).
- Mitchell, Mount, Papadimitriou (1987), The discrete geodesic problem, SIAM J. Comput. 16,
  647–668, doi:10.1137/0216045. Dutour, Deza (2004), Goldberg–Coxeter construction for 3- and
  4-valent plane graphs, Electron. J. Combin. 11, doi:10.37236/1773. Caspar, Klug (1962),
  Physical principles in the construction of regular viruses, Cold Spring Harb. Symp. Quant. Biol.
  27, 1–24, doi:10.1101/SQB.1962.027.001.005. Goldberg (1937), A class of multi-symmetric
  polyhedra, Tohoku Math. J. 43, 104–108. (DOIs as verified by the generalisation note on
  2026-10-23; not re-fetched here.)

## 8. Reproduce

```
npx tsc -p packages/surface --noEmit
npx vitest run packages/surface
python3 python/surface/test_cert.py
npx tsx packages/surface/scripts/gen-solids.ts
npx tsx packages/surface/scripts/search.ts --out runs.jsonl --solids cube --N 4 --P 1-24 --starts 3 --hops 6 --seed 1 --warm warm.json --seconds 150
npx tsx packages/surface/scripts/polish.ts polished.jsonl runs.jsonl
packages/surface/scripts/build-tables.sh WORK_DIR API_DIR runs.jsonl polished.jsonl
python3 python/surface/cert.py data/surface/records.json
```

`build-tables.sh` rebuilds the nofold, exact and one-piece replica configurations, certifies
every candidate with the smallest shrink on the ladder 1e-12, 3e-12, ..., 1e-6, adds "P+1 minus
one piece" candidates, keeps the best certified candidate per problem and writes the records, the
certificate bundles, [SURFACE_RESULTS.md](SURFACE_RESULTS.md) and the viewer. `cert.py` on the
records file checks every record's published fields and re-certifies it at its stored eps.

Viewer: open `packages/surface/viz/index.html` (standalone, no network). It recomputes the parts
from the stored poses with the same development code and draws them on the solid (drag to turn)
or on a net; pieces keep their colour across folds; red dots are the cone points.

## 9. Limitations and open questions

- All values are best found, not proved optimal, except where a value meets its lower bound
  ([CALC], listed in SURFACE_RESULTS.md); even then the status stays `best_known`.
- The fold search is heuristic and its budget was small (about 3 hours on 2 cores in total, seeds and
  counts per record). Polygon results sit within roughly 1e-7 to 1e-5 (relative) of the local
  optimum their contact structure defines; some values that look like closed forms (3/2, 2, 5/2,
  3, 7/2, sqrt 3 / 2, 2 / sqrt 5) are a few 1e-6 above them [SPEC]. The searched range is P <= 24,
  with fewer starts for the dodecahedron, the icosahedron and N = 5, 8.
- The float validator in TypeScript uses PolyPack's touching tolerance; only the Python
  certificates are proofs. The certifier trusts mpmath's interval arithmetic (outward rounding)
  and Python's exact rationals; it shares the solid combinatorics with the TypeScript code only
  through `data/surface/solids.json`, which it rebuilds and compares independently.
- The chain-enumeration argument (turn rule, termination) is given in section 2.4; the code also
  has a hard depth cap that fails loudly instead of truncating.
- Not done: perfect tilings beyond the Goldberg–Coxeter, Caspar–Klug and hexagon families; lower bounds
  for disks beyond area and one piece (an argument with the vertex-free regions around the face
  centres looks possible for small P [SPEC]).
- An independent adversarial review (2026-10-24; judges with different algorithms, 2.49 million
  traced points, about 5400 perturbed records, 6000 random wrapped configurations, 2238 threshold
  tests and a tetrahedron orbifold model) found no soundness defect in the certifier. Its tooling
  and documentation findings are fixed (records mode, replicas, bound claims, multiplier text,
  cache key, work limits); its regression fixtures are in `python/surface/fixtures/review/`.
  Open from it: the stored witnesses are informative only (no separate witness checker), and
  `intersect_wedges` would mishandle two opposite half-plane wedges, a case that cannot occur
  (only the root can contribute a half-plane).
