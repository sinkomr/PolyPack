# Lattice and symmetry seeds (`seed`)

[CALC] This method generates starting configurations rather than optimizing piece
poses. It is registered alongside the other solver methods. Every proposed
configuration is scored and validated by `ctx.evaluate`; the framework retains
the best valid result. Unit polygon sides and unit circle radii follow Phase 1.

```ts
const result = await run(
  { N: 5, M: 5, P: 6 },
  {
    method: "seed",
    params: { kind: "auto" },
    budget: { evals: 1000 },
    seed: 17,
    finalPolish: false,
  },
);
```

## Generators and applicability

[CALC] Unless restricted below, shapes are `N,M ∈ {0,3,…,100}` and counts are
`1 ≤ P ≤ 500`. Circle pieces use radius one, not diameter one.

| Kind                      | Construction and applicability                                                                                                                                                              | Useful cases and limitations                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `square_lattice`          | Square-lattice sites, with contact spacing measured by shared geometry. Triangles decorate a rectangular lattice with four upright/inverted pieces per cell.                                | Squares and rectangular cuts; poor for circular pieces compared with the hex lattice.                                                                                                                                           |
| `hex_lattice`             | Triangular-lattice sites, with contact spacing measured by shared geometry. Triangles use two pieces per cell; hexagons align face normals with neighbour directions.                       | Circles, triangles and hexagons; a plane packing can have inefficient finite boundaries.                                                                                                                                        |
| `pentagon_double_lattice` | The two-pose ice-ray cell derived below; requires `N = 5`, any allowed M and P.                                                                                                             | Dense bulk pentagon seeds, including arbitrary odd cuts. Finite pentagon containers often favour rings instead. Other N is rejected.                                                                                            |
| `rings`                   | Polygon perimeters with growing multiples of M pieces, or circular rings with optional centre. Adjacent circular rings alternate half-step offsets.                                         | Good for small symmetric clusters and circular containers. Polygon-container restrictions below are binding; all applicable counts, including P=500, are supported.                                                             |
| `rows`                    | Near-square row widths, or explicit `perRow`; alternate rows may shift half a step. Triangles use both orientations.                                                                        | Exact square grids, strips and rectangular containers. Automatic triangles include one triangular block, then distinct strip widths; an explicit width selects strips. Ragged final rows and elongated layouts can waste space. |
| `record_plus_one`         | Validate an adjacent Phase 1 record; consider free centre and exterior contacts, outermost pieces first, then two-contact circle insertions or polygon tangent slides.                      | Requires matching N/M and exactly P−1 pieces, hence `2 ≤ P ≤ 500`. Preserves every original piece pose. Best among positions actually found and evaluated, not a global insertion optimum.                                      |
| `record_minus_one`        | Validate an adjacent Phase 1 record and evaluate every single-piece deletion.                                                                                                               | Requires matching N/M and exactly P+1 pieces, hence `1 ≤ P ≤ 499`. Finds the best deletion when the budget permits all P+1 assessments; otherwise the best tested deletion.                                                     |
| `auto`                    | Round-robin traversal, cheap generators first, using the same trial table as single runs; omit rings above P=100. Record generators participate only when an adjacent `record` is supplied. | Broad default. More evaluations than one generator; does not turn seeds into a pose optimizer.                                                                                                                                  |

[CALC] A polygon-container ring must have a piece count divisible by M, or one
more than a multiple of M. In the latter case a central polygon is compatible
with D_M only when M divides N; a central circle is always compatible. Peripheral
pieces rotate with their positions, and their radial line is a reflection axis.
An explicit `perRing` must be zero or divisible by M. Nonzero `orientation` or
`orientationRange` is rejected for polygon-container rings because it would
generally destroy their reflection symmetry. `auto` skips an incompatible ring
generator. These restrictions explain why, for example, two pieces cannot form
the required D_4 ring seed, and triangles cannot supply the central piece of a
five-piece D_4 seed.

[CALC] Polygon ring k has k times M perimeter samples on a k-scaled regular
M-gon, rather than putting M pieces at every radius. Centre-containing profiles
use even k=2,4,…, and profiles without a centre use odd k=1,3,…; the final
perimeter uses the remaining multiple of M. For example, 484 squares in a square
form eleven nested perimeters with populations 4,12,…,84 and score 22. Small
one-orbit clusters retain vertex/edge-axis arrangements. An explicit `perRing`
sets a maximum perimeter population instead.

[CALC] For a circle container, any count applies. Profiles with and without a
centre are tried for every P. For P≤12, the remaining pieces occupy a single
outer ring; otherwise automatic populations are 6,12,18,… with an exact final
remainder. `perRing` fixes a maximum count. Radial pieces use the requested
orientation relative to the radial direction. Polygon-container rings preserve
reflection-compatible orientations instead. Rings give radii 3.304764871,
3.613125930 and 3.923804400 for 8,9,10 circles respectively, below the sampled
lattice cuts.

[CALC] Records are parsed with `parseConfig` and validated with `findOverlaps`.
Their container is recomputed when candidates are evaluated; input container
fields are not trusted. Count, shape, malformed poses and overlaps give explicit
error Results. Missing records report that a record is required; count errors
name the expected adjacent count. Non-record generators ignore an unrelated
record configuration after ordinary parameter-schema validation. Phase 1 cannot represent a zero-piece or 501-piece record, so
plus-one at P=1 and minus-one at P=500 are intentionally unsupported. At the
coordinate boundary, out-of-range exterior spots are filtered before spending
the trial cap; if all four exterior spots are out of range, a 4R-spaced finite
grid supplies a guaranteed free, in-range fallback.

[CALC] Insertion cannot guarantee the optimal eight-circle radius for an
arbitrary seven-circle record while preserving its poses. For the optimal
seven-circle hexagonal cluster, put the original centre at zero and the six
outer centres at radius 2. A free new centre has distance at least 2√3 from zero:
its angular distance from an outer centre is at most π/6 and non-overlap requires
radial distance at least 4 cos(π/6). If all centres fit in a disk of radius q,
its centre displacement c obeys c²+2√3c+4≤q², since a hexagon vertex lies within
π/6 of the opposite direction. Thus c≤√(q²−1)−√3 and q≥2√3−c, giving
q+√(q²−1)≥3√3 and q≥14/(3√3). Adding unit piece radius gives the sharp score
1+14/(3√3)=3.69430125622279, attained by the two-contact insertion. A
3.3048 target therefore needs a different source record or an optimizer that
moves its original pieces. A seven-centre regular ring with radius
1/sin(π/7) has a free centre; insertion there gives 3.30476487096249. Both cases
are tested. No pose optimization is silently added to this generator.

## Parameters and defaults

[CALC] Every schema property has a title and description. Unknown top-level
parameters are rejected. `record` is optional and has no default. Its Phase 1
metadata is accepted; `theta` and `container_phi` may be omitted and then mean
zero. The complete registered JSON Schema appears below.

| Parameter              | Default  | Meaning                                                                                                                           |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                 | `"auto"` | One of the eight generator names.                                                                                                 |
| `trials`               | `12`     | Trials per lattice/ring/row generator, integer 1–256.                                                                             |
| `orientation`          | `0`      | Radians added to automatic orientation, or absolute if automatic orientation is off. Range ±2π.                                   |
| `automaticOrientation` | `true`   | Horizontal-base and cached minimum-cell-area anchors; triangles use both tiling orientations.                                     |
| `latticeAngle`         | `0`      | Base lattice rotation, ±2π; the hexagon hex-lattice basis follows the actual piece orientation.                                   |
| `angleRange`           | `π/2`    | Maximum random lattice rotation in either direction, 0–2π.                                                                        |
| `orientationRange`     | `0`      | Maximum random piece rotation in either direction, 0–π.                                                                           |
| `offsetRange`          | `1`      | Maximum fractional lattice offset in each basis coordinate, 0–1.                                                                  |
| `perRow`               | `0`      | Zero tries nearby square widths, a single row and a single column; otherwise integer 1–500.                                       |
| `alternateRows`        | `false`  | Odd rows shift half a step; even rows align. Contact-derived pitch is √3 for circles, instead of 2. Triangle strips already tile. |
| `perRing`              | `0`      | Automatic ring counts, or a specified maximum count 1–500.                                                                        |
| `recordTrials`         | `128`    | Maximum scored insertions and bounded sampling attempts, integer 1–4096. Occupied samples are skipped.                            |
| `poolLimit`            | `8`      | Maximum distinct emitted classes, integer 0–64; score/pair-distance tolerance 1e−7. Emission consumes an evaluation.              |
| `record`               | absent   | Valid Phase 1 adjacent configuration; required by the two record generators.                                                      |

## Cuts, budgets and pipeline seeds

[CALC] The first four lattice trials use offsets (0,0), (½,½), (½,0) and (0,½),
multiplied by `offsetRange`, with the base angle and orientation. Trial five includes the minimum-cell-area piece orientation when automatic
orientation is enabled. This is a cached one-dimensional search: a 24-interval
scan followed by 30 golden-section refinements around the best interval. It is a
numerical minimum, not a symbolic global optimality proof. Later trials draw
bounded angles, orientations and offsets from `ctx.random`. Circle-container
trials omit a pure rotation of the whole arrangement, and triangle rows do not
repeat the identical triangular block. The whole
table is drawn before running generators, so applicability does not change the
random sequence. Identical inputs, seed and evaluation budget give identical
poses and scores in the same JavaScript runtime. Time budgets and wall-time
metadata are machine-dependent, as in the framework.

[CALC] Lattice spacing is the smallest uniform cell dilation found by bisection
on shared `pieceSeparation` contacts, over both motif orientations and nearby
translation vectors. Spacing is cached per generator kind and motif orientation
within each run. An inscribed-circle lower bound excludes vectors farther than
twice the bounding radius before SAT bisection. Vertex trigonometry and polygon
supports are hoisted out of cut-ranking loops. A 2e−13 relative outward margin
covers rounding. For these
reduced cells, translation indices outside ±4 cannot contact at the resulting
scale: the polygon circumradius/inradius ratio is at most two, and the omitted
vectors exceed the two-piece bounding reach. Pentagon spacing uses the derived
exact cell, not guessed contacts. Hexagons use their face-normal basis before
dilation, avoiding the lower-density vertex-to-vertex arrangement.

[CALC] At each sampled offset, enumerate a finite patch with basis indices
±(ceil(sqrt(P / motif count))+3). Rank each whole piece by the concentric
container size needed at fixed centre zero and orientation zero, and select
exactly the first P. This selects the smallest **fixed-centre cut among the
enumerated sites**. The shared enclosing solver then translates and auto-orients
the actual container. The method keeps the smallest evaluated sampled cut; it
does not prove the globally smallest translated container among every possible
P-site subset of the infinite lattice. Triangle-container anchor trials also
include the exact k² triangle block, giving side k for k=2,3 without a dense-cut
boundary artefact.

[CALC] Ring radii are bracketed outside the previous ring and bisected using
shared pair separation. The upper bracket is valid by bounding-circle reach;
only valid radii are retained. A centre-distance filter skips SAT beyond twice
the piece bounding radius. Radial intervals skip all non-neighbouring rings.
Trials are still quadratic in cheap intra-ring distance scans, and shared final
geometry assessment remains uninterruptible. `auto` skips rings for P>100: large
perimeters incur more generation work than lattice/row cuts, and one full rings
trial can otherwise consume a short time budget before other trials advance.
Direct rings remain available up to P=500; measured costs are below. This finds
a valid outer contact branch, not a
proof of the smallest radius across all possible radial contact branches.

[CALC] Framework calls are sequential. Hot loops check `shouldStop`, and
generation phases and long scans await `checkpoint`. All candidate validity and
score assessments use `ctx.evaluate`. No decisions use clocks or `Math.random`.
The framework supplies best/start/starts and performs the final optional polish;
this method needs no custom polish or nested optimizer. Set `finalPolish:false`
to measure the generators themselves. The framework still performs its ordinary
final orientation assessment, which the server reproduces from the result.

[CALC] Evaluate a complete first round before emitting one seed per applicable
generator, up to `poolLimit`. This gives a diverse pool even when later rounds
hit the budget. After all generators finish, emit the best remaining distinct evaluated
snapshots until the cap or budget is reached. Congruence signatures quantize the
score and sorted multiset of pairwise centre distances to 1e−7, retaining the best
representative of each class. Two 32-bit hashes compact the distance multiset;
this is a practical filter, with possible hash collisions and homometric sets,
not an exact geometric congruence decision. Pairwise distances also ignore piece
orientations. Fewer than poolLimit seeds are emitted if fewer distinct classes
are found. The initial seeds are deliberate
diversity choices, so the pool is not guaranteed to be the globally best K
candidates. A budget exhausted by the first assessment cannot pay for an
additional emission. The framework retains at most 64 emitted starts for the
next pipeline stage. With evaluation-only budgets, the same trial limits and
parameters, `auto` visits at least the candidate prefix each single generator
gets from an equal budget share; batching initial emissions is necessary for
the share-one case. There is no corresponding time-budget guarantee.

## Pentagon cell derivation and verification

[EST] Kuperberg and Kuperberg's construction uses translates of a body and its
point reflection. Their pentagon packing is the alternating-column ice-ray;
the authors' conference abstract confirms its density. Hales and Kusner's
version-2 preprint proves the global density bound. References and verification
details are below.

[CALC] These coordinates are our contact reconstruction in PolyPack's side-one,
vertex-up convention, not a quoted coordinate table. Let

```text
R = 1/(2 sin(π/5)), r = R cos(π/5)
w = R sin(2π/5), q = R cos(2π/5)
a = (3w, 0), b = (0, R+r)
d = (3w/2, (R+3q)/2)
motif = (0,0,θ=0), (d.x,d.y,θ=π)
```

[CALC] A reflected copy d−K meets K when d reaches the boundary of 2K.
The two nearest reflected-neighbour contacts are

```text
(sin(π/5), cos(π/5)) · d = 2r
(sin(2π/5), −cos(2π/5)) · (d−b) = 2r
```

[CALC] Solving gives d above. Vertical same-orientation neighbours touch with
spacing R+r; mirrored contact lines cover the nearest opposing columns. All
remaining centres lie farther than 2R in at least one coordinate, so they cannot
overlap. Placing the second motif at b/2 instead would overlap; its vertical
offset is essential. With A = 5R² sin(π/5) cos(π/5),

```text
cell area = |det(a,b)| = 3.7348474273241696
piece area = 1.720477400588967
density = 2A/|det(a,b)| = 5/[3(1+cos(π/5))]
        = (5−sqrt(5))/3 = 0.921310674166737
```

[CALC] The test checks density to 12 decimal digits and both motif pieces against
every nonidentical copy with translation indices −10,…,10, using the shared
SAT function and a 1e−12 contact tolerance. It also checks finite cuts in mixed
containers and P=500. The exterior reach argument above covers translations
beyond that finite numerical test.

## Verified references

- [EST] G. Kuperberg and W. Kuperberg, **Double-lattice packings of convex bodies in the plane**, _Discrete & Computational Geometry_ **5**, 389–397 (1990), DOI [10.1007/BF02187800](https://link.springer.com/article/10.1007/BF02187800). Verified the publisher's author, title, year, volume, pages, DOI and constructive double-lattice abstract on 2026-10-08. The full publisher article is paywalled; the explicit coordinates here are independently reconstructed rather than attributed to unseen pages.
- [EST] W. Kuperberg, **Double-lattice packings revisited — recent developments**, [2016 Discrete Geometry conference program](https://www.utrgv.edu/discgeo/_files/documents/schedule-2016.pdf), printed page 4. Verified the author's abstract attributes the pentagon double lattice and its density to the 1990 paper.
- [EST] Thomas Hales and Wöden Kusner, **Packings of Regular Pentagons in the Plane**, [arXiv:1602.07220v2](https://arxiv.org/pdf/1602.07220v2), 13 September 2016. Verified title/authors/date, the density on page 1 and Theorem 1 on page 2. The [author's publication page](https://wkusner.github.io/papers/p001-pentagonglobal.html) labels it a preprint; no journal venue is asserted. Version 1 has a weaker bound and is not the source of the optimality claim.

## Validation and limits

[CALC] Generator tests disable final polish and cover every kind, fast-check
shape/count cases, exact square/triangle tilings, circle clusters, pentagon
contacts and density, explicit orientations, staggered rows, large counts,
adjacent records, invalid records, deterministic evaluation budgets, aborts,
distinct pipeline pools and equal-share auto comparisons. Cache tests check that
repeated calls perform no additional contact work. Tangent slides use the shared
geometry routine after excluding pieces beyond the swept bounding reach, so
large polygon records also receive second-contact attempts.

[CALC] A cold triangle spacing calculation formerly took more than 50,000
stop checks, reflecting exhaustive 81×16×44 bisections. Bounding-radius
pruning reduces that to 2,112.

[CALC] A randomized geometry property was once observed to fail in shared
geometry, independently of this method. At N=0, M=8, phi=0, one piece at
(0,2.992182701345876), `autoOrient` returned size 0.8284271247461906 versus
fixed-angle 0.8284271247461904, violating the exact no-worse assertion in
`packages/geometry/test/enclose.test.ts`. Reproduced directly; fast-check
seed 929674524, path `37:0:18:12:4:26:29`. A geometry fix
would compare the returned enclosing polygon's actual size with enclosures at
zero and the supplied angle, retaining the smallest, rather than relying only
on the pre-reconstruction apothem comparison.

[CALC] Strict preemption of shared synchronous geometry and 50-digit final polish
would require framework/geometry changes. Existing final
polish is float64. A run stopped before any assessment with no valid supplied
start cannot return a valid best without spending an evaluation. Cut selection
is over enumerated, sampled offsets, not a proof of the global optimum among
all P-site subsets. Browser throughput has not been measured.

## Measured results (final polish disabled)

[CALC] Re-measured 2026-10-09, Apple M1 Pro, Node v26.5.0, macOS arm64.
Each run: seed=17, evals=1000, trials=12, poolLimit=0, finalPolish=false,
remaining parameters at defaults. Entries are computed score / printed value
from `data/records.json`; — means inapplicable, with an explicit rejection.
No new record is claimed; printed pentagon/hexagon values are truncated.

| Generator                 | 4/4/5               | 4/4/10              | 4/4/17              | 0/0/7               | 0/0/19              | 5/5/6               | 6/6/7               |
| ------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| `square_lattice`          | 2.828427 / 2.707107 | 4.000000 / 3.707107 | 4.949747 / 4.675530 | 3.500000 / 3.000000 | 5.472136 / 4.863703 | 3.360712 / 2.618030 | 3.406723 / 2.886000 |
| `hex_lattice`             | 3.000000 / 2.707107 | 4.000000 / 3.707107 | 5.000000 / 4.675530 | 3.000000 / 3.000000 | 5.000000 / 4.863703 | 3.226514 / 2.618030 | 2.886751 / 2.886000 |
| `pentagon_double_lattice` | — / 2.707107        | — / 3.707107        | — / 4.675530        | — / 3.000000        | — / 4.863703        | 3.045085 / 2.618030 | — / 2.886000        |
| `rings`                   | 2.828427 / 2.707107 | — / 3.707107        | 5.000000 / 4.675530 | 3.000000 / 3.000000 | 4.863703 / 4.863703 | 2.809017 / 2.618030 | 2.886751 / 2.886000 |
| `rows`                    | 3.000000 / 2.707107 | 4.000000 / 3.707107 | 5.000000 / 4.675530 | 3.828427 / 3.000000 | 6.000000 / 4.863703 | 3.381966 / 2.618030 | 3.882901 / 2.886000 |
| `record_plus_one`         | 3.000000 / 2.707107 | 4.000000 / 3.707107 | 5.000000 / 4.675530 | 3.000000 / 3.000000 | 4.863703 / 4.863703 | 2.618034 / 2.618030 | 2.886751 / 2.886000 |
| `record_minus_one`        | 3.000000 / 2.707107 | 4.000000 / 3.707107 | 4.949747 / 4.675530 | 3.304765 / 3.000000 | 5.122321 / 4.863703 | 3.045085 / 2.618030 | 2.886751 / 2.886000 |
| `auto`                    | 2.828427 / 2.707107 | 4.000000 / 3.707107 | 4.949747 / 4.675530 | 3.000000 / 3.000000 | 4.863703 / 4.863703 | 2.809017 / 2.618030 | 2.886751 / 2.886000 |

[CALC] Auto uses no record. Record runs preserve valid published adjacent
coordinates when available; otherwise they use auto-generated neighbours under
the same protocol. Plus / minus input provenance:

- 4/4/5: data/records.json coordinates / data/records.json coordinates.
- 4/4/10: data/records.json coordinates / generated auto neighbour; published coordinates unavailable.
- 4/4/17: data/records.json coordinates / generated auto neighbour; published coordinates unavailable.
- 0/0/7: data/records.json coordinates / data/records.json coordinates.
- 0/0/19: data/records.json coordinates / data/records.json coordinates.
- 5/5/6: generated auto neighbour; published coordinates unavailable / generated auto neighbour; published coordinates unavailable.
- 6/6/7: generated auto neighbour; published coordinates unavailable / generated auto neighbour; published coordinates unavailable.

[CALC] End-to-end auto throughput at P=30, N=M, one warm-up then five identical
runs, including generation, shared scoring and final orientation assessment:

| N=M | Evaluations |  Seconds | Evaluations/second |
| --- | ----------: | -------: | -----------------: |
| 0   |         200 | 0.018909 |            10576.8 |
| 3   |         200 | 0.054039 |             3701.1 |
| 4   |         180 | 0.028605 |             6292.5 |
| 5   |         260 | 0.121732 |             2135.8 |
| 6   |         200 | 0.076588 |             2611.4 |
| 8   |         180 | 0.052922 |             3401.2 |

## Matched before/after measurements

[CALC] Captured the prior implementation in an isolated temporary bundle before
editing. Ring timings use N/0/500, trials=1, poolLimit=0, seed=17, no stop,
shared fixed-angle geometry assessment, no polish. One trial each; timings
include generator and assessment, so they are observations rather than
worst-case guarantees. Both versions return one valid candidate.

| N   | Before (ms) | After (ms) | Speedup |
| --- | ----------: | ---------: | ------: |
| 5   |     989.656 |     30.444 |   32.5× |
| 12  |    2637.202 |     20.388 |  129.3× |
| 100 |   30771.333 |     41.631 |  739.1× |

[CALC] Matched triangle throughput uses real framework auto on 3/3/30, seed=17,
evals=1000, poolLimit=0 and finalPolish=false, with one warm-up and five runs:
before 240 assessments in 1.127265s (212.9/s), after
200 in 0.068874s (2903.8/s), 13.6× throughput.
Fewer assessments reflect removed congruent trials. The separate warmed table
above varies with JIT state and scheduling; it uses the same run protocol.

[CALC] For 3/3/3 with default auto parameters and ample budget, score plus
sorted pair-distance classes quantized to 1e−7: before 8 emitted / 2 distinct;
after 5 emitted / 5 distinct. The pool stops short of its default eight
when only five distinct sampled classes exist. Emission assessments are included
in framework budgets.

## Registered JSON Schema

```json
{
  "type": "object",
  "title": "Lattice and symmetry seeds",
  "description": "Generate valid starts from lattice cuts, symmetric rings, rows, or an adjacent record.",
  "additionalProperties": false,
  "properties": {
    "kind": {
      "type": "string",
      "title": "Generator",
      "description": "Auto interleaves cheap generators first and includes rings only up to P=100; record generators need record.",
      "enum": [
        "square_lattice",
        "hex_lattice",
        "pentagon_double_lattice",
        "rings",
        "rows",
        "record_plus_one",
        "record_minus_one",
        "auto"
      ],
      "default": "auto"
    },
    "trials": {
      "type": "integer",
      "title": "Trials per generator",
      "description": "Bounded orientation and offset trials; four offset anchors followed by a cached minimum-cell-area orientation anchor.",
      "default": 12,
      "minimum": 1,
      "maximum": 256
    },
    "orientation": {
      "type": "number",
      "title": "Piece orientation",
      "description": "Radians, added to the automatic horizontal-base orientation, or absolute when automaticOrientation is false.",
      "default": 0,
      "minimum": -6.283185307179586,
      "maximum": 6.283185307179586
    },
    "automaticOrientation": {
      "type": "boolean",
      "title": "Automatic orientation",
      "description": "Include horizontal-base and minimum-cell-area anchors; triangles use both orientations. Pentagon double lattice rotates its entire motif.",
      "default": true
    },
    "latticeAngle": {
      "type": "number",
      "title": "Lattice angle",
      "description": "Radians added to the lattice direction; hexagonal pieces use face normals at their actual orientation. Whole-arrangement rotation trials are omitted for circle containers.",
      "default": 0,
      "minimum": -6.283185307179586,
      "maximum": 6.283185307179586
    },
    "angleRange": {
      "type": "number",
      "title": "Lattice angle range",
      "description": "Random trials rotate the lattice by up to this many radians in either direction.",
      "default": 1.5707963267948966,
      "minimum": 0,
      "maximum": 6.283185307179586
    },
    "orientationRange": {
      "type": "number",
      "title": "Piece angle range",
      "description": "Random trials vary the piece orientation by up to this many radians in either direction.",
      "default": 0,
      "minimum": 0,
      "maximum": 3.141592653589793
    },
    "offsetRange": {
      "type": "number",
      "title": "Offset range",
      "description": "Maximum fractional lattice offset in each basis coordinate; zero disables offset trials.",
      "default": 1,
      "minimum": 0,
      "maximum": 1
    },
    "perRow": {
      "type": "integer",
      "title": "Pieces per row",
      "description": "Zero tries near-square row widths automatically; otherwise use this width.",
      "default": 0,
      "minimum": 0,
      "maximum": 500
    },
    "alternateRows": {
      "type": "boolean",
      "title": "Offset alternate rows",
      "description": "Shift odd rows by half a horizontal step, with the tight non-overlapping row pitch; even rows remain aligned.",
      "default": false
    },
    "perRing": {
      "type": "integer",
      "title": "Pieces per ring",
      "description": "Zero grows polygon perimeter populations in multiples of M; circles try a centre with 6,12,… or a single outer ring for small P. Explicit polygon counts must be multiples of M.",
      "default": 0,
      "minimum": 0,
      "maximum": 500
    },
    "recordTrials": {
      "type": "integer",
      "title": "Insertion positions",
      "description": "Maximum free contact or grid positions scored for record_plus_one; record_minus_one tries every removal.",
      "default": 128,
      "minimum": 1,
      "maximum": 4096
    },
    "poolLimit": {
      "type": "integer",
      "title": "Emitted seed pool",
      "description": "Emit distinct score and pair-distance classes to this cap, initially across generators, then by score. Tolerance 1e−7. Emit costs an evaluation.",
      "default": 8,
      "minimum": 0,
      "maximum": 64
    },
    "record": {
      "type": "object",
      "title": "Adjacent record",
      "description": "Valid Phase 1 configuration of the same N and M, with P−1 or P+1 pieces; required by record generators.",
      "required": ["N", "M", "P", "pieces"],
      "properties": {
        "N": {
          "type": "integer",
          "title": "Piece shape",
          "description": "Circle 0, or polygon side count 3–100.",
          "default": 0,
          "minimum": 0,
          "maximum": 100
        },
        "M": {
          "type": "integer",
          "title": "Container shape",
          "description": "Circle 0, or polygon side count 3–100.",
          "default": 0,
          "minimum": 0,
          "maximum": 100
        },
        "P": {
          "type": "integer",
          "title": "Record count",
          "description": "Piece count of the adjacent record.",
          "default": 1,
          "minimum": 1,
          "maximum": 500
        },
        "container_phi": {
          "type": "number",
          "title": "Container angle",
          "description": "Phase 1 container orientation in radians."
        },
        "pieces": {
          "type": "array",
          "title": "Record pieces",
          "description": "Phase 1 piece poses.",
          "minItems": 1,
          "maxItems": 500,
          "items": {
            "type": "object",
            "title": "Pose",
            "description": "Unit piece position and rotation.",
            "required": ["x", "y"],
            "properties": {
              "x": {
                "type": "number",
                "title": "X",
                "description": "Horizontal position."
              },
              "y": {
                "type": "number",
                "title": "Y",
                "description": "Vertical position."
              },
              "theta": {
                "type": "number",
                "title": "Piece angle",
                "description": "Rotation in radians; omitted means zero."
              }
            }
          }
        }
      }
    }
  }
}
```
