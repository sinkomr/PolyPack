# 2D on 3D, polyhedral surfaces: PolyPack on the surface of a convex polyhedron

**Dimension.** On the site this is the kind **Polyhedral surfaces** under the dimension **2D on 3D**
(called Platonic surfaces until 2026-10-26): flat pieces on a closed surface in 3D, with no
container. The API calls it the space `surface`.

PolyPack's pieces (unit disks, or regular N-gons of side 1, N = 3 to 100) packed on the surface of
a convex solid scaled by s: a Platonic solid, one of the 13 Catalan solids, a prism (3 and 5 to 12
sides) or an antiprism (4 to 12 sides). The score is the smallest s. Two tracks:

- **nofold**: every piece lies in one closed face;
- **fold**: rigid flat pieces may cross edges, folding onto the neighbouring faces.

Every table entry carries a certificate checked by an independent rigorous certifier
(`python/surface/cert.py`), so its validity is proven, not just tested. Tables:
`data/surface/records.json`; results summary: [SURFACE_RESULTS.md](SURFACE_RESULTS.md). The tables
cover the Platonic solids with N in {0, 3, 4, 5, 6, 8}; the other solids, and N = 7 and 9 to 100,
have problems but no records yet. The problems are a domain of ranges (`packages/surface/src/domain.ts`,
registered in `packages/spaces/src/domain.ts`): 36 solids, both modes, 99 shapes and P = 1 to 100,
712,800 problems, each with the larger of its area and one-piece bounds (2.6); 2038 have a record.

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
side, the interior angle at a polygon corner), and every cone angle of the space is at least pi
(tables above), so the development never needs more angle than the vertex has. On the tetrahedron
(cone angle exactly
pi) a disk or a polygon side through a vertex fills the whole angle there; its two boundary
rays then meet, which is touching, not overlap.

**Score and ids.** The score is s, the scale of the canonical solid (the edge length for the
Platonic solids, prisms and antiprisms), for side-1 polygons or radius-1 disks.
Problem id: `surface/<solid>/<mode>/<N>/<P>`, e.g. `surface/cube/fold/4/12`.

**The other solids** (2026-10-26). The Catalan solids, prisms and antiprisms are the polyhedra
space's canonical solids (`python/polyhedra/solids_exact.json`, [POLYHEDRA.md](POLYHEDRA.md)
section 1), in its vertex order and scale: prisms and antiprisms have unit edges, so s is their
edge; a Catalan solid is the polar reciprocal of the unit-edge Archimedean solid about the
midsphere, and s scales it (its edges are not of length 1). Ids keep the scheme:
`surface/rhombic_dodecahedron/fold/4/6`, `surface/prism5/nofold/0/9`, `surface/antiprism4/fold/3/3`.
Their faces are convex polygons of up to two shapes, and the vertices of a Catalan solid have two
or three cone angles [CALC]:

| solids | faces | cone angle / pi |
|---|---|---|
| prism n (n = 3, 5 to 12) | 2 regular n-gons, n squares | 1 + (n - 2)/n at every vertex |
| antiprism n (n = 4 to 12) | 2 regular n-gons, 2n triangles | 1 + (n - 2)/n at every vertex |
| Catalan solids | 12 to 120 congruent faces: isosceles or scalene triangles, kites, rhombi, irregular pentagons | 2 or 3 values per solid, from 1.1186 (triakis tetrahedron, 6-valent vertices) to 1.9840 |

Every cone angle of the 36 solids lies in [pi, 2 pi) [CALC: `packages/surface/test/general.test.ts`,
`python/surface/test_general.py`], so the boundary rule below holds on all of them; the certifier
refuses a solid with a sharper vertex. A Catalan face is tangential: every edge of a Catalan solid
touches the midsphere, which meets a face plane in a circle tangent to the face's edges, centred at
the foot of the perpendicular from the centre [EST, standard; checked to 1e-30 in the tests].

**Frames of any face.** The origin is the foot of the perpendicular from the solid's centre to the
face plane, and the last edge (frame vertex M - 1 to frame vertex 0) runs along +x at the bottom.
On a regular face (Platonic solids, prisms, antiprisms: the vertices lie on a sphere about the
centre, so the foot is the face centre) this is the regular frame above; a Catalan face's origin is
its incentre. Gluing maps rotate by (direction of f's edge k) + pi - (direction of g's edge l).

**Pieces and sizes.** As in 2D in 2D: N = 0 or 3 to 100 and P up to 100, with and without folding, on
every solid. Nothing in the geometry depends on N (a regular 100-gon of side 1 has circumradius 15.9,
so its solids are large).

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

On the Platonic solids the site's board (beside a nofold problem's values), the Dimensions page (a link in each
nofold row) and the viewer at `/spaces/surface.html` say this and link to the equivalent 2D in 2D
problem N/M/ceil(P/F) on the polygon board, `/#p=N,M,k` (disks are N = 0 there too).

**2.1b Prisms and antiprisms: nofold is a 2D in 2D value** [CALC]. Their faces are regular polygons
of two kinds, both of side s: F1 faces that are M1-gons and F2 that are M2-gons (a prism with n sides:
2 n-gons and n squares; an antiprism: 2 n-gons and 2n triangles). Write s2(N, M, 0) = 0. Then

  s_nofold(H, N, P) = min over k1, k2 >= 0 with F1 k1 + F2 k2 >= P of max(s2(N, M1, k1), s2(N, M2, k2)).

Proof. Upper bound: take a split (k1, k2) and s = max(s2(N, M1, k1), s2(N, M2, k2)). Each face of
kind i is a regular Mi-gon of side s >= s2(N, Mi, ki); it contains the regular Mi-gon of side
s2(N, Mi, ki) with the same centre and orientation (a homothety about the centre with ratio at most
1 maps a convex polygon about that centre into itself), so it holds an optimal ki-piece packing.
Keep P of the F1 k1 + F2 k2 >= P pieces. Lower bound: in a nofold packing of P pieces let ki be the
largest number of pieces on one face of kind i. Then F1 k1 + F2 k2 >= P, and a face of kind i with
ki > 0 pieces holds a 2D packing in its regular Mi-gon of side s, so s >= s2(N, Mi, ki) for both
kinds; s is at least the maximum for this split, hence at least the minimum over splits. For the
true 2D optima (non-decreasing in k) the formula is exact; with best-known 2D values it is an upper
bound, best taken over the envelope min over k' >= k of s2_best(N, M, k') as in 2.1. The board and
the volunteer client run the surface search in its nofold mode on them; a link to the 2D in 2D
problems of the best split is not built yet, and PolyPack's 2D records (`data/records.json`) do not
yet cover containers with 9 to 12 sides.

**2.1c Catalan solids: nofold problems are new 2D problems** [CALC]. All faces of a Catalan solid
are congruent (by rotations or reflections, which map regular pieces to regular pieces), so the
same argument as 2.1 gives s_nofold(H, N, P) = t(N, ceil(P/F)), where t(N, k)
is the smallest scale of the solid's face (an irregular triangle, kite, rhombus or pentagon) that
holds k pieces. There is no 2D in 2D problem to reduce to: PolyPack's 2D problems have regular or
circular containers. The board and the volunteer client run the surface search in its nofold mode on
them (section 5).

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

**Separating axes** [CALC] (since 2026-10-26). The float check measures two parts by the
separating-axis test, with its axes taken from the half-planes each part was cut from: the
piece's sides, the two rays of its wedge and its face's edges, all from their exact angles
(`parts.ts`, `partSeparation`). Every side of a part lies on one of these lines, and a
half-plane that does not touch the part gives a smaller gap along its normal, while any positive
gap separates the parts. So for overlapping parts the result is exactly their separating-axis
depth, and positive values (parts apart) are a lower bound on their distance. Before, the axes
came from the clipped parts' own sides. Clipping can leave a side about 1e-15 long (a piece
corner on a vertex or an edge) whose direction rounding makes arbitrary, and such an axis cuts
a sliver off the part: two triangles on the octahedron overlapping by 7.9e-4 were accepted
by the earlier rule (`packages/surface/test/axes.test.ts`; the certifier
rejected it). Every research record passes the new check, at the touching tolerance and at 1e-11.

Enumeration: depth-first over chains from the anchor face; a branch is cut only when no
vertex-avoiding ray of length <= reach (the piece's circumradius, or 2 for disk distances) can
follow it:
- the edge lies farther than reach from c;
- c lies strictly beyond the edge's line (no ray from c can cross it outwards);
- the wedge W(C) has empty interior (a wedge of width 0 is a single ray through a vertex);
- *turn rule*: a straight line not through a vertex V sees V under exactly pi, so it can cross
  consecutive edges around V only while the faces passed between them have face angles at V
  summing to less than pi (on the Platonic solids at most 2 triangles, 1 square or 1 pentagon; on
  the others the faces' own angles at V are summed).
Termination: between two turns around different vertices a ray travels at least c_M s (for
example sqrt(3)/2 s for triangles), so a ray of length L crosses O(L/s) edges; on the other solids
the constant is set by the smallest face angle and the shortest distance from a corner of a face to
an edge not at it. Both implementations also have a hard depth cap that fails loudly.

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
- On any solid of the space the one-piece argument gives s >= r / max_f rho_f, with rho_f the largest
  distance from a point of face f to that face's nearest corner at scale 1 (attained at a vertex of
  the corners' Voronoi diagram in the face or where one of its edges meets the boundary;
  `faceCornerRadius` in `solids.ts`), and the area bound is P a(N) <= s^2 area(S at scale 1).
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

**One-piece replicas** [CALC] (added on 2026-10-24, when a second, separately written check found ten
fold entries beaten or settled this way; `packages/surface/scripts/build-replicas.ts`). Take the best one-piece
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
closed-form placement [CALC] (the reason: the icosahedron's dual graph has no perfect code, while
the octahedron's two copies cover its surface exactly).

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
- A second certifier written separately (2026-10-24) re-checked the records and found no soundness
  defect in this one; it found ten fold entries that copies of the one-piece placement beat or settle, which led to the replica
  family above. That family changed 37 fold entries, 13 of them by more than 0.1%, e.g. three
  and four triangles on the icosahedron from 0.601948 and 0.612234 to 1/2 and two octagons on
  the cube from 1.942810 to 1 + 1/sqrt 2.

## 4. Software

- `packages/surface` (@polypack/surface, TypeScript): solids and frames (`solids.ts`, `rigid.ts`),
  chain enumeration (`chains.ts`), parts (`parts.ts`), float validator (`validate.ts`, PolyPack's
  touching tolerance 1e-9), fold search (`search/`), scripts to build nofold and exact
  configurations, to drive the search, to build the test packings (`build-test-packings.ts`) and
  the other solids' data (`gen-general.ts`), and the viewers in `viz/` (Platonic records). It imports
  `pieceSeparation` (nofold) and `pieceVertices` from @polypack/geometry; fold parts are
  separated by `partSeparation` (2.4, separating axes).
- `python/surface` (certifier, standard library + mpmath only): `numfield.py` (exact arithmetic in
  Q, Q(sqrt 3) and Q(sqrt(10 + 2 sqrt 5)), and in the field of any solid), `geom.py` (independent
  construction of the Platonic solids by an exact convex hull; exact frames and gluings), `general.py`
  (the other solids, below), `cert.py` (certifier), `run_cert.py` (eps ladder, certificate bundles),
  `test_cert.py`, `test_general.py`.

**The generalisation** (2026-10-26). `packages/surface` describes any convex polyhedral surface:
per face its number of sides, frame vertices and corner angles, per vertex its degree and cone
angle (`Solid.sides`, `unitFaces`, `corner`, `vertexCone`); development, parts, the validator and the
search read them face by face. The Platonic solids keep their code paths (`Solid.uniform`): with
the separating axes of 2.4 aside, their validation, parts and seeded searches were bit for bit those
of before [CALC: all 2038 records validated three ways and their parts compared, 17052 results, and
five seeded searches, all identical]. Their records keep their ids and bytes and re-certify
unchanged (`cert.py` on `data/surface/records.json`: 2038 certified, 0 failed).

**Separating parts** (2026-10-26). The separating axes of two parts are the half-planes each was cut
from (2.4); on the other solids the face's own edge lines, from `faceCutsOf`.

**Certifying the other solids** (`general.py`) [CALC]. Built from `solids_exact.json`, not from the
TypeScript: exact checks (field arithmetic, exact signs) that every face is planar, convex and
counter-clockwise from outside, that every other vertex lies strictly inside every face plane, that
the faces glue into a closed surface with Euler characteristic 2, and that prism and antiprism faces
are regular and centred at the foot; interval checks that every cone angle is at least pi. Frames
are exact field elements over square roots, enclosed at 320 bits and kept as 128-bit intervals, and
so are the gluing motions and their compositions. Fields of degree up to 20 make exact chain
topology too costly, so it is decided otherwise:
- each wedge boundary is a ray through a developed vertex with a key naming that vertex; a vertex
  shared by consecutive crossed edges is inherited, so two rays with one key are the same ray
  exactly. Every other orientation is decided by intervals, and one that intervals cannot decide
  (the centre exactly in line with two developed vertices, or on the line of an unfolded edge)
  refuses the configuration as degenerate, never guesses;
- prunings are made only when certain (an edge certainly beyond reach, the centre certainly beyond
  the edge line, the turn rule certainly broken, exactly for regular faces); cone points and disk
  images are skipped only when certainly outside the closed wedge, so doubt only adds checks;
- fold mode first tries the nofold certificate: scaled pieces strictly inside their faces and
  disjoint on each face are a fold packing (2.2);
- parts, witnesses and the shrink are those of `cert.py`. For pieces with more than 8 sides an
  empty part's witness comes from the separating axis of the piece and the face's region of its
  chain instead of all triples of constraints (both paths; N <= 8 is unchanged): a 100-gon packing
  certifies in about a second.
Tests (`test_general.py`): the exact checks of all 31 solids and their combinatorics against
`data/surface/solids.json`, tangential Catalan faces, regular prism and antiprism frames, holonomy
equal to the cone angle at every vertex, 67 test packings (below), 160 random configurations on
which the certifier and the TypeScript validator agree (`fixtures/crosscheck_general.json`), and
adversarial cases: a piece pushed 2e-9 across an edge without folding, disks and polygons (up to
100-gons) overlapping by 1e-9 across a fold, a piece 1e-9 over a vertex of every kind (the sharpest
included), pieces larger than the whole surface, a solid with a vertex sharper than pi, a clockwise
or open solid, degenerate centres and malformed input.

**Test packings, not records** (`python/surface/fixtures/general_packings.json`, built by
`packages/surface/scripts/build-test-packings.ts` with short seeded searches). Disks, triangles and
hexagons on a deltoidal icositetrahedron (kites), a rhombic dodecahedron, a pentagonal prism and a
square antiprism, with folding (P = 3, every one crossing edges) and without (P = F + 2, faces
holding several pieces); folding packings on the triakis tetrahedron (its 6-valent vertices are the
sharpest), the pentagonal icositetrahedron (chiral) and the 9-gon antiprism; and N = 3, 7, 12, 20
and 100 on a cube, a rhombic dodecahedron, a heptagonal prism and a pentagonal antiprism, with and
without folding. All 67 certify at eps = 1e-12, and each fails 1e-7 smaller.

**What the certifier decides, and how** [CALC].
- Inputs are taken as exact rationals (every float is a dyadic rational).
- On the Platonic solids chain topology is decided exactly (the other solids: `general.py`, above): unfolded vertices and the centre lie in Q (cube), Q(sqrt 3)
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

Seeded and deterministic for given counts (`packages/surface/src/search`); since the separating
axes changed (2.4, 2026-10-26) the same seeds give other values than before, so a run from
before that date is reproduced with the code of its time. It runs on every solid of the space;
random starts pick a face by area on the solids beyond the Platonic ones. In its nofold mode
(`mode: "nofold"`, for the nofold problems of those solids, which no planar engine covers) every
piece is its own polygon in its anchor face, and the cone-point term is replaced by the squared
protrusion beyond the face's edges (disks: the shortfall of the distance to each edge line), with
the same compression, hops and contact-LP polish and the nofold validator at the end. Pieces are developed
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

## 5b. Kernel for the generic methods

`surfaceKernel({ solid, N, P, mode })` (`packages/surface/src/kernel.ts`) lets the generic search
methods (`docs/methods/dimensions/README.md`) run on the surface problems of all 36 solids: with
folding (`mode` "fold", the default) and without ("nofold"). The nofold problems of the Platonic
solids are planar problems of one face and keep the polygon solver's methods; on the other solids
the kernel's nofold mode serves them, so every problem offers Auto and the generic methods.

- **State.** Per piece, (u, v) = (x, y) / s in its anchor face's frame, and theta for polygons:
  the fold search's packing on the solid of scale 1, pieces scaled by 1/s. The size is s, the
  score. `setSize` changes s only, so centres keep their places on the surface and pieces shrink
  or grow about them. `fromConfig` refuses what the server refuses unchecked: a malformed
  configuration, P above 100, and a size below the bound (by more than 1e-9 relative). Random
  starts put each piece at a point drawn uniformly on the surface (a face by its area, then a point
  of it). They are roomy (the fold search's density) and never smaller than the scale at which a
  piece fits in the smallest face: larger pieces wrap around vertices, and a relaxation from
  random poses then often leaves cone points inside them.
- **Faces.** Each face is read on its own: its polygon in its frame (`solids.ts` facePolygonOf: the
  regular polygon's formulas on a regular face, the stored corners on a Catalan face), its area,
  the largest disk about its frame origin inside it, and its corners' vertex ids
  (`kernel-solid.ts`). Frame origins lie inside their faces: a regular face's centre, and on a
  Catalan solid the point where the insphere touches the face. On the Platonic solids the kernel
  gives the numbers it gave before it covered the other solids [CALC: states, energies, gradients,
  moves, seeds, squeezes and finishes compared bit for bit on 8 problems], with two exceptions: the
  model's chain cap rose from 400 to 1200 chains per piece with the server's cap (200 to 600), so
  states far below the bound, where it used to give Infinity, now get finite energies (66 of 240
  states at 0.05 to 0.25 of the bound); and two disk centres at one point now count as a full
  overlap, where the model skipped them.
- **Charts.** A local solve can move a centre off its face. Every operation reads it by developing
  the straight segment from the face's centre to it, across the edges it crosses (`unfoldChart`
  in `kernel-solid.ts`); across one edge this is the fold search's `canonicalize`. A segment never
  circles a vertex, so every chart point has one surface point. `rebase` stores it. `randomPose`
  writes a uniform random point into the piece's own chart: the end of a shortest path from the
  anchor face's centre. The chains it needs reach the farthest point of the surface, bounded by
  shortest paths between face centres through the shared edges; a few faces' chains are kept per
  solid [CALC: all 120 faces of the disdyakis triacontahedron would hold about 118 MB, one takes
  about 3 ms].
- **Energy** with folding (`kernel-energy.ts`): the fold search's terms with per-piece weights, in
  piece units (s² times the energy at scale 1). Gradient: analytic for disks; central differences
  per piece for polygons, and of the whole energy for d/ds. [CALC] Clipping can leave a part an edge of
  length about 1e-15 whose direction rounding makes arbitrary, and the separating-axis depth then
  jumps at isolated poses, where line searches stall (seen on the icosahedron with 30 triangles).
  The kernel's depth therefore uses as axes the exact half-planes each part was cut from (piece
  sides, wedge rays, face edges). Every edge of a part lies on one of them, and a half-plane that
  does not touch the part only lowers the gap, so the result is the separating-axis depth with
  exact normals.
- **Energy** without folding (`kernel-nofold.ts`): the squared protrusion of each piece beyond
  each edge line of its face (its farthest point past the line, times 4 as the fold search weighs
  walls) and the squared overlap depth of every pair on one face (separating axes from the pieces'
  exact sides; disks by their centres' distance). Per edge only the farthest point counts, so a
  soft piece never sticks out more than the true one (the fold search's nofold energy sums the
  corners instead). A piece belongs to the face its centre is in, as with folding, so it can move to
  a neighbouring face. There the energy jumps: a piece that is not symmetric about the shared edge
  sticks out of the two faces by different amounts, the other edges of the new face count instead
  of the old one's, and its pair terms change faces [CALC: a triangle on the rhombic dodecahedron at
  s = 4 has energy 1.3154 just inside an edge and 0.4753 just across]. The energy is a model and
  finish decides validity. Gradient: central differences per piece, and of the whole energy for
  d/ds; a pose that is not a finite number has energy Infinity, with or without folding.
- **finish** (`kernel-finish.ts`): the largest scale at which the fold search's energy of the mode
  is exactly zero, by bisection with the poses fixed (shrinking a piece about its centre keeps it
  inside the old one, so the energy falls with the scale). It starts at the bound at the latest,
  since nothing valid is smaller, shrinks the pieces to a tenth at most, and, with folding, counts a
  scale at which a piece crosses more than the server's 600 chains of faces as infeasible before
  developing it. Below half
  the bound it returns null at once. Then the contact-LP polish within a deterministic work budget
  (its stop polls, about eight iterations of a loose packing; the mode's), and the mode's validator
  at tolerance 0, lowering the scale by 1e-13, 1e-12, ... until it passes. [CALC] On 22 fold records (every 37th
  of the table) it returned a valid configuration within 4e-12 of the record's s.
- **validate**: the server's rule (`packages/spaces/src/validate.ts`), with its reasons word for
  word: the format and limits (P at most 100, s at most 1e6, coordinates and angles at most 1e4),
  the lower bound, and the mode's validator at the touching tolerance 1e-9 with at most 600 chains
  per piece. A problem without a research record has every entry checked at 1e-11 too; the kernel
  knows that a problem has none when its solid is not Platonic or its N is not one of the records'
  shapes (0, 3, 4, 5, 6, 8), and then checks at 1e-11 as well. The Platonic problems with those N
  and no record (some P above 24), and the further check of an entry that beats a research record,
  need the catalogue; they are left to the server, and a job's own rule (packages/spaces run.ts
  checkSpaceConfig, which replaces `validate` in a job) applies both.
- **Bound**: the domain's (`domain.ts` surfaceBound), the larger of the area and one-piece bounds
  (2.6), which the server checks against every problem without a record. On the Platonic solids it
  uses the float operations and the tangents (Python's `math.tan`) the records were computed with,
  so it also equals `bound.value` of every record [CALC: all 2038], which the server checks
  against the problems with one. V8's `Math.tan` differs in the last bit for pi/5, pi/6 and pi/8;
  through the bound's formula this moved the domain's Platonic bounds by up to 3 representable
  steps (about 7e-16 relative).
- **Capabilities.** `shape`: polygon t K plus a disk of radius (1 - t) r_in, its round corners
  replaced by chords, which lies inside the piece and grows with t. At t = 0 it is the N J-gon
  inscribed in the inscribed circle (J = ceil(12 / N) chords per corner), whose inradius is
  cos(pi / (N J)) r_in, 0.966 to 0.981 r_in for N = 3 to 8. For disks it changes nothing.
  `seeds`: the pieces spread over the faces in proportion to their areas, as evenly as whole pieces
  allow, each face's share on a triangular patch about its frame origin, valid at the size returned
  in both modes. `swap` (polygons): two pieces exchange their angles in
  their faces' frames.
- **Costs** [CALC] (Apple Silicon, load average about 90): with folding, an energy sweep takes 0.3
  to 0.6 ms at P = 10 and 0.6 to 1.1 ms at P = 30 for polygons, 0.1 to 0.15 ms for disks. With the
  gradient it takes 8.3 to 8.9 sweeps for polygons (`gradCost` 9) and about one sweep for disks.
  One finish costs 140 to 1200 sweeps for polygons and 490 to 2600 for disks, measured against a
  sweep that develops every piece (`finishCost` = 100 + 20 P and 200 + 60 P); one validation
  about 2. The Catalan solids, prisms and antiprisms measured alike. At P = 100 (measured later)
  a disk finish took 9,000 to 12,000 sweeps and a polygon finish 600 to 800, so `finishCost` is
  low for many disks and high for many polygons there; it is kept as it was, so that runs on the
  Platonic solids stay the same. Without folding a sweep has no chains to develop and takes about
  0.01 to 0.03 ms. Against it, measured on one kernel with nothing cached, a gradient costs 3.9 to
  9.0 sweeps for disks and 7.7 to 11.2 for polygons (central differences, at least 2 dim + 3 sweeps:
  `gradCost` 7 and 10), a finish 1,400 to 3,100 sweeps for disks at P = 10 and 30 and up to 7,100
  at P = 100, 270 to 960 for polygons and up to 3,900 at P = 100 (`finishCost` = 1500 + 35 P and
  400 + 25 P), and a validation 1.2 to 2.6 (`validateCost` 4).
- **basin_hopping** squeezes its start and the kernel's four structured starts before it first
  offers, which on polygon problems with folding needs 25,000 to 50,000 evaluations [CALC: on the cube
  and the rhombic dodecahedron with 5 squares]; below that it returns nothing.

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

The other solids: vertices in the order of `python/polyhedra/solids_exact.json` (and
`packages/polyhedra`), faces from its face list made canonical as above; `packages/surface` reads
them from `src/general.data.ts` (generated by `scripts/gen-general.ts` from the polyhedra data). Frames
as in section 1; gluing rotates by (direction of f's edge k) + pi - (direction of g's edge l).

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
  site entry; a separate re-check (2026-10-24) found 106 of these records up to 1.0e-6 better than
  what the local `data/records.json` coordinates give.
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
npx tsx packages/surface/scripts/gen-general.ts
npx tsx packages/surface/scripts/build-test-packings.ts python/surface/fixtures/general_packings.json
npx tsx packages/surface/scripts/gen-crosscheck.ts --general python/surface/fixtures/crosscheck_general.json
python3 python/surface/test_general.py
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
or on a net; pieces keep their colour across folds; red dots are the cone points. A nofold record
links to its 2D in 2D problem on the site's board (section 2.1), a link that works where the viewer
is served by the site, at `/spaces/surface.html`.

## 9. Limitations and open questions

- The Catalan solids, prisms and antiprisms, and N = 7 and 9 to 100 on every solid, have no records:
  their problems are open, and only test packings exist. Prism and antiprism nofold values are 2D in
  2D values (2.1b); Catalan nofold problems are new 2D problems with irregular containers (2.1c).
- The certifier of the other solids refuses degenerate configurations (a centre exactly in line with
  two developed vertices, or on the line of an unfolded edge) rather than decide them; exact
  constructions with such symmetry need a tiny perturbation before certification.
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
- Adversarial checks written separately (2026-10-24; judges with different algorithms, 2.49 million
  traced points, about 5400 perturbed records, 6000 random wrapped configurations, 2238 threshold
  tests and a tetrahedron orbifold model) found no soundness defect in the certifier. Their tooling
  and documentation findings are fixed (records mode, replicas, bound claims, multiplier text,
  cache key, work limits); their regression fixtures are in `python/surface/fixtures/review/`.
  Still open: the stored witnesses are informative only (no separate witness checker), and
  `intersect_wedges` would mishandle two opposite half-plane wedges, a case that cannot occur
  (only the root can contribute a half-plane).
