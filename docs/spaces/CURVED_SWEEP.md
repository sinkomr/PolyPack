# Curvature sweeps (2D in 2D, Curved): how packings change as K changes

**Dimension.** These sweeps belong to the kind **Curved** under the dimension **2D in 2D** ([CURVED.md](CURVED.md)). The site shows them as an exhibit: they take no entries.

Status: research build, 2026-10-24. Code: `packages/curved/src/sweep.ts` and `packages/curved/scripts/sweep/`. Certification and curation: `python/curved/sweep_*.py`. Data: `data/curved/sweep/`. Viewer: `packages/curved/viz/sweep.html`. The engine and the certifier are described in `docs/spaces/CURVED.md`. Labels: [EST] established with a source, [CALC] computed here, [SPEC] speculation.

**Units (2026-10-27).** Disks now have diameter 1 and a disk container is scored by its diameter ([CURVED.md](CURVED.md)). The sweeps of **disks in a disk** (P = 2 … 12 and 27 … 30; their 15 files, 633 records and summaries) were made for disks of radius 1 and are **archived** in `data/curved/archive/sweep/`, not served; `data/curved/sweep/` holds the polygon sweeps (triangles in a triangle and in other polygons, squares in a square), which are unchanged. Every disk result on this page (sections 1, 3, 4.1, 5 and the tables of crossings and branches) is quoted in its original radius-1 units: a radius-1 disk packing at curvature K is the packing of diameter-1 disks at curvature 4K with all lengths halved, so the container radius s\* quoted here is the diameter score of the same packing at 4K (K = −2 … 0.65 corresponds to K = −8 … 2.6). The sweeps of diameter-1 disks at K = ±1 are not yet made. Statements about triangles and squares are unchanged.

## 1. Answer

**Question (Michael):** if the curvature K changes slowly, do the best packings also change smoothly, or are there sharp changes or discontinuities, and where?

**Short answer.**
- **The best size s\*(K) never jumps.** It is continuous wherever the pieces fit [EST: Berge's maximum theorem; the feasible set changes continuously with K]. The sweeps agree: every change of the lowest branch was traced to a point where both branches coexist and have equal size.
- **s\*(K) is not smooth.** It is smooth (analytic) between isolated points and has **corners (kinks) at isolated curvatures**, where the slope ds\*/dK jumps [CALC].
- **The optimal arrangement can jump discontinuously while s\* stays continuous.** This happens at every crossing of two branches, a first-order transition. Example: for 7 disks at K_c = −0.29732464 the 7-ring hands over to 6-around-1. The size is 3 on both sides, the slope drops from 0.666 to 0, and the pieces jump to a different arrangement.
- **Hysteresis is common.** The branch that loses the lead usually survives as a metastable local optimum. If K is changed slowly, a system following its local optimum keeps the old arrangement past K_c, until that branch folds or hits a limit. Then it drops to a lower state (the arrows in the viewer). Two triangles in a triangle show a complete small loop around K ≈ 0.767: a mirror-asymmetric state, a symmetric state that is unstable below K = 0.76697, a crossing at K_c = 0.76701, and a fold of the asymmetric state at 0.76783.
- **Generic packings change smoothly.** Rings of 3, 4 and 5 disks follow one analytic branch over the whole range (from K = −2 to the hemisphere limit), with ds/dK(0) = s₀(s₀² − 1)/24 as the envelope theorem predicts (s₀ the container diameter at K = 0; for disks of radius 1 and a radius-scored container it was r₀(r₀² − 1)/6, the same law at K four times smaller).

**Where the sharp changes are** [CALC; details and certificates in §4]:
1. **At K = 0 itself, for degenerate Euclidean records.** The flat plane allows angle coincidences such as six 60° angles making 360°, a disk ringed by six equal disks, or tilings. They make more contacts tight than a generic optimum has, so the contact forces (multipliers) are not unique. For K ≠ 0 the angle sums change by K × area (Gauss–Bonnet), and the coincidence breaks in a direction set by the sign of K. One subset of contacts stays tight for K < 0, another for K > 0, and the one-sided slopes are the minimum and maximum of −Σλ ∂g/∂K over the multiplier polytope. Examples [CALC, table in §6]: 6, 7 and 11 disks; 2, 3, 4, 5, 6, 8 and 9 triangles in a triangle; 2 to 9 squares in a square; 6 triangles in a hexagon. 7 disks keep one arrangement with slopes 0 | +1. In many cases (6 and 11 disks; 3, 5, 8 triangles; 2, 5, 6, 7, 8, 9 squares), K = 0 is itself a crossing: the flat optimum is one member of a continuum or a tie, and different members continue on the two sides. Records without such coincidences are smooth through K = 0: rings of 3–5 disks, the 8- and 9-disk records (whose centre disk is a rattler), and 10 and 12 disks.
2. **At the {3, q} tiling curvatures K\*.** For 5, 6, 7 and 8 triangles in a regular q-gon, s\*(K) falls to exactly 1 at K\*, kinks (slope about −0.17 → 0), and stays flat at s = 1, every triangle's base locked along a wall, until a crossing well beyond K\*.
3. **At crossings (first-order transitions).** Disks in a disk give a closed form: as K decreases, the (P−1)-ring around one disk (size exactly 3) loses to the P-ring when the P-ring's radius reaches 3, at **K_c(P) = −(arccosh(1/(2 sin(π/P))))²**. That is K_c = −0.29732, −0.58413, −0.86033, −1.12630, −1.38263, −1.62993 for P = 7…12, and the sweeps reproduce all six to 10 digits. Polygon problems have several crossings each, some of them crowded together near the hemisphere limit.
4. **Where a contact appears or disappears along a branch.** Usually s stays C¹ and only the second derivative jumps. It kinks when the contact set is degenerate, for example when a disk ringed at distance exactly 2 locks the centre at K_c(P−1) and the curve leaves the flat s = 3 plateau.
5. **Symmetry breaking.** A symmetric branch stops being a local optimum (a stability probe finds a lower state nearby), and an asymmetric optimum takes over, as in the two-triangle case above.
6. **Endpoints.** At negative K a polygon container has to grow without bound as K → K∞ = −a\*² (a\* is the scale-free ideal-container value). There s ≈ −α ln(K − K∞) + β with α → 1/√(−K∞) = 1/a\* [CALC]. Fits on s ∈ [5, 14] give α within 0.3–5% of 1/a\*; that window is not yet fully asymptotic. The fitted K∞ agrees with `kPolish`'s a\* to 10⁻⁷–10⁻⁵. At positive K the container reaches the open-hemisphere limit s = 2π/(M√K) (or π/(2√K) for disks). Density stays finite at both ends, so the density view shows the structure better near them.

**Plateaus.** s\*(K) can be exactly constant on an interval when the binding contacts do not depend on K. Two cases occur: a ring of disks at distance exactly 2 from a central disk and touching the rim (s = 3), and triangle bases lying along walls of length 1 (s = 1). The configuration on such a plateau is usually not unique (floppy), so contact changes there do not affect s.

## 2. How to look at it

Open `packages/curved/viz/sweep.html` (standalone; works offline, in light and dark mode and at phone width).
- **Top plot:** s(K), with buttons for density and s/s(0), and a log option. Each branch is a coloured curve; the thick curve is the lowest found, coloured by the branch in the lead; dashed curves are metastable. Markers: ◆ crossing, ◇ kink, × fold (with an arrow down to where the system drops), ○ contact change, △ stability change, | end. Drag across the plot to zoom in K, double-click to reset. Hover for values, click to set K, click near a thin curve to follow that branch.
- **Second plot:** ds/dK from finite differences along each branch. A kink is a jump; a smooth contact change is a corner of this curve.
- **Configuration:** drawn in the conformal model. A point at distance r from the centre in direction φ goes to radius 2 tn_K(r/2), which is 2w/(1 + v₀) in homogeneous coordinates: the Poincaré disk for K < 0 and stereographic projection for K > 0, scaled to be exact at the centre. The picture therefore morphs continuously through K = 0. Contacts are drawn as geodesic segments; rattlers are grey and dashed. The dashed circle is the boundary at infinity (K < 0) or the equator (K > 0); the grey polygon is the ideal container.
- **Controls:** a K slider; Play animates either the lowest branch (the arrangement jumps at crossings) or any single branch adiabatically (it follows the branch through its metastable stretch to its fold). Event chips jump to and zoom on an event; the event table lists every event with slopes and certification.
- **Atlas tab:** one strip per problem, coloured by the lowest configuration along K. Colours can show configuration, shell structure or symmetry. Crossings are ticks.

**Designs tried.** The configuration view was drawn two ways. The Klein/gnomonic chart has straight edges but distorts shapes strongly near the boundary and blows up near the hemisphere. The conformal chart keeps angles and disks round and has a finite image at both ends of every sweep: the ideal polygon fits inside a circle of radius 2/√−K, and the hemisphere inside 2/√K. The conformal chart is the default; the other remains a toggle. The plots were tried with s alone, which makes asymptotes dominate; with log s; and with density and s/s(0). Density is the clearest near the endpoints, and s is the clearest for kinks. A first version drew branches only as thin lines; colouring the thick ground-state curve by branch made crossings and hysteresis readable at a glance.

## 3. Method

**Problems.** Disks in a disk, P = 2 … 12, K ∈ [−2, 0.65], and P = 27 … 30, K ∈ [−1.5, −0.5]. Triangles in a triangle, P = 2 … 6, 8 and 9, K ∈ [−1.2, 3]. Squares in a square, P = 2 … 9, K ∈ [−1, 1.6]. (7 and 10 triangles and 10 squares were not run.) Four problems with a {3, q} tiling curvature K\*: 5 triangles in a pentagon (K\* = 1.2258), 6 in a hexagon (K\* = 0), 7 in a heptagon (K\* = −1.1893) and 8 in an octagon (K\* = −2.3365). Each range runs from where the pieces stop fitting (or a practical limit) to the hemisphere limit. Disks give the cleanest closed forms, triangles and squares cover the tilings at P = 4, 9 and the proven 5-piece records, and the {3, q} problems contain an exact tiling at K\* ≠ 0.

**Grid.** K takes multiples of 1/64. Each is an exact binary64 number and an exact rational, so the certifier reads K exactly. Sub-steps (halvings) are also dyadic.

**Seeds.** At every multiple of 1/4 in K, 3 seeded searches run (`solve`, restarts 1, 12 basin hops; seed = 7919(64K + 1000) + 31j + 1009N + 13M + P). Further seeds: the Euclidean record from `data/records.json`, re-centred, at K = 0, and every record of the same problem in `data/curved/records.json` (K = ±1 and the K\* tilings), each polished at the nearest grid K.

**Branches** (`followBranch` in `src/sweep.ts`). A seed within 8% of the best size known at its K is followed in both directions. Each step polishes a secant prediction of the pose vector at K + h; the poses are exponential coordinates, which do not depend on K. A step is accepted unless the polished configuration lies more than 0.03 (geodesic units) from the prediction *and* its size fell below the prediction. Then h is halved, and below h = 2⁻²⁶ the branch ends in a **fold**. The configuration found beyond the fold becomes a new seed. Other ends: no valid polish (at K < 0 in a polygon container this is the approach to the ideal polygon; the walk also stops at s = 14, where float coordinates become unreliable), the open-hemisphere limit, or a unit piece that stops existing. A branch also stops when it joins a branch already followed (same size within 10⁻⁷ and same sorted centre radii), or when it rises 8% above the best size known there.

**Refinement.** Up to three rounds perturb the lowest configuration at every second grid K (σ = 10⁻³, 2·10⁻², 8·10⁻², two trials each) and re-polish. Anything lower is followed as a new branch. The rounds caught real misses: the first pass missed lower states near the asymptote of 5 squares, and refinement found them.

**Ground state.** At each grid K, s\*(K) is the minimum over all branches. Changes of the lowest branch between neighbouring grid points are located by bisection on s_A − s_B. Both branches are polished from their nearest stored configurations, so every crossing is confirmed from both branches on both sides. A change where the two branches never coexist would be a discontinuity of the best-found curve, i.e. a search failure; analyze.ts reports it as a "gap".

**Event analysis** (`scripts/sweep/analyze.ts`):
- one-sided slopes and second differences of each branch at every event (finite differences, step 2·10⁻⁴ or 10⁻⁴);
- contact-graph changes (pairs in contact, piece–wall contacts, rattlers) and symmetry changes (the symmetry group of the non-rattler part about O, tested in conformal coordinates) along every branch that is lowest somewhere, located by bisection to about 10⁻¹¹ in K;
- a stability probe at every second grid value of those branches (3 random perturbations of size 10⁻³, then re-polish; a lower size means a saddle). Changes of stability are located by bisection. The probe matters because a polish started from an exactly symmetric configuration keeps the symmetry, so it can track a symmetric saddle beyond its loss of stability;
- hysteresis: from every crossing, the branch that loses the lead is followed onward with no 8% cut until it really ends;
- the asymptote at the negative end: a fit of s = −α ln(K − K∞) + β, and `kPolish` from the last configuration for a\* (P pieces fit iff √−K < a\*, so K∞ = −a\*²).

**Certification.** The ground state is certified every 4th grid value (spacing 1/16), plus the last grid value, and both branches at every crossing: at K_c (an exact binary64) and at the two grid values around it. Each configuration is re-polished with all gaps ≥ μ (`certifyPrep`; μ = 4·10⁻¹¹, smaller where s is very sensitive to the apothem). It is then checked by the unchanged `python/curved/certify.py` (256-bit interval arithmetic), driven by `python/curved/sweep_certify.py`. It counts as certified when certify.py proves it *and* score_cert − score_float ≤ 10⁻⁹ · score_float.

**What is and is not claimed.** Every certified size is a proven upper bound for its problem at its K. The ground state is the best found [CALC], not proven optimal, except where a published proof exists at K = 0. A crossing is reported only when both branches were followed through it from both sides. Its location is a numerical root [CALC], with both branch values certified as upper bounds on both sides.

### 3a. Rerun on a quieter machine (2026-10-24, evening)

The first sweeps ran on a machine with load average 35–50. The rerun ran at load average about 12. It searched the least complete problems again **on top of the earlier branches** (`run-sweep.ts --resume` with the new options `--solveOnResume`, `--seedOffset`, `--hopEvery`, `--maxBranches`, `--refineEvery`, `--refineTrials`, `--refineSigmas`):
- 4 new seeded multistart searches every 1/8 in K (20 hops; seeds offset from the first run);
- warm-started basin hopping (20 hops) from the lowest configuration at every second grid value;
- up to 140 branches;
- 4 refinement rounds at *every* grid value (σ = 10⁻³, 10⁻², 3·10⁻², 8·10⁻², 0.15; 3 trials each).

This covered 6, 7 and 9 squares and 5 and 6 triangles. 8 squares got a moderate version (3 seeds, 15 hops, 90 branches, 2 rounds). New problems: 8 triangles in a triangle (4 seeds and 15 hops every 1/8, basin hopping, 120 branches, 3 rounds) and 28, 29 and 30 disks (as for 27, plus basin hopping every 4th grid value). Analysis and certification are unchanged. Every crossing of the rerun problems was recomputed from the new branches and certified on both sides.

| problem | grid values with a lower s\* now | largest drop | crossings before → after | what changed |
|---|---|---|---|---|
| 5 triangles in a triangle | 0 of 147 | – | 4 → 4 | nothing: all four crossings reproduced to 10 digits |
| 6 triangles in a triangle | 8 of 127 | 3.1·10⁻⁴ (K = 1.42) | 5 → 5 | the "crossing" at K = 0 was an artefact: one configuration continues through 0 with a contact change and a kink (−1.904 \| −1.655); new crossing at 1.35840; the other four unchanged |
| 6 squares in a square | 34 of 74 | 0.566 (K = −0.4375) | 2 → 3 | much lower states near the negative asymptote (K∞ moves from −0.45116 to −0.45761); new crossing at 0.65909; K = 0 and 0.47129 unchanged |
| 7 squares in a square | 21 of 65 | 0.698 (K = −0.4375) | 2 → 5 | lower states for K < 0 (K∞ from −0.43962 to −0.44089); new crossings at −0.38890, −0.18073, 0.51489; K = 0 and 0.45683 unchanged |
| 8 squares in a square | 0 of 62 | – | 6 → 6 | nothing: all six crossings reproduced |
| 9 squares in a square | 12 of 56 | 4.6·10⁻³ (K = 0.25) | 7 → 8 | the cascade toward the hemisphere changed: 0.25753 and 0.38172 moved by 4.6·10⁻⁴ and 8.4·10⁻⁴; 0.24637, 0.34577, 0.42930, 0.44316, 0.47085 removed; new at 0 (the 3×3 tiling now meets a different branch for K > 0), 0.02161, 0.20563, 0.22485, 0.35461, 0.39844 |
| 8 triangles in a triangle | new | | 10 | a crossing at K = 0 (−2.334 \| −0.708) and a cascade of nine crossings for K ∈ (0.33, 1.2) |
| 28, 29, 30 disks | new | | 4, 5, 4 | the inner shell grows one disk at a time (§4.1) |

So the deeper search confirmed 5 triangles and 8 squares exactly and found real misses for 6 and 7 squares near the asymptote. The fine structure of the 9-square cascade near the hemisphere limit is not converged: its crossings are certified for the branches found, but a still deeper search could move them again.

## 4. Results by family

### 4.1 Disks in a disk (P = 2 … 12, K ∈ [−2, 0.65])

- **P = 2 … 5: one smooth branch over the whole range** [CALC]. P = 2 is flat (r = 2 for every K). P = 3, 4, 5 are rings with r = 1 + r₀(K), where sn_K(1) = sn_K(r₀) sin(π/P); their slope at K = 0 is 0.0641, 0.2357, 0.5371, matching r₀(r₀² − 1)/6. Each branch ends only at the hemisphere limit.
- **P = 6: exact tie at K = 0.** For K < 0 the 6-ring is smaller than 3; for K > 0, 5 around 1 stays at exactly 3 while the ring grows. s\* kinks at K = 0 (slopes +1.00 | 0), and the arrangement jumps there. Both states survive on the other side: the ring up to the hemisphere limit, and 5+1 down to K = −2.
- **P = 7 … 12: the ring transition** [CALC]. For decreasing K, the lowest state is first the Euclidean-type arrangement, then the (P−1)-ring around one disk, then the P-ring. The (P−1)+1 state has r = 3 exactly while its ring sits at distance 2: a plateau with a floppy ring. The P-ring wins once its own radius drops below 3, at K_c(P) = −(arccosh(1/(2 sin(π/P))))². The swept roots agree with the closed form to 10 digits:

  | P | K_c (closed form) | K_c (sweep) | slope of the P-ring at K_c (left) | slope of (P−1)+1 (right) |
  |---|---|---|---|---|
  | 7 | −0.2973246421 | −0.2973246421 | 0.666 | 0 |
  | 8 | −0.5841322640 | −0.5841322640 | 0.501 | 0 |
  | 9 | −0.8603277945 | −0.8603277945 | 0.404 | 0 |
  | 10 | −1.1263047570 | −1.1263047570 | 0.339 | 0 |
  | 11 | −1.3826331690 | −1.3826331690 | 0.293 | 0 |
  | 12 | −1.6299293599 | −1.6299293599 | 0.259 | 0 |

  The plateau ends at the upper side, at K_c(P − 1), where the (P−1)-ring closes at radius 2. There the centre disk becomes loose and s starts to rise with the (P−1)-ring's slope: a kink with no crossing, because the same configuration bends. For P = 10, 11, 12 further crossings follow nearer K = 0: 9+1 → 8+1+1 at −0.0625 (P = 10); 10+1 → 9+1+1 at −0.1402, then the Euclidean record from K = 0 (P = 11); 11+1 → 10+1+1 at −0.2200 and → 9+3 at −0.0624 (P = 12). Every losing branch survives as a metastable state, usually to the end of the range or to a fold, so the hysteresis windows are wide.
- **27–30 disks, K ∈ [−1.5, −0.5]: the inner shell grows one disk at a time** [CALC]. These sweeps used a smaller budget: 2 seeds every 0.5 (P = 27) or 0.25 in K, 6 hops, one refinement round, plus the K = −1 record as a seed (28–30 also had basin hopping every 4th grid value). As K increases, the lowest state goes 26+1 → 25+2 at K = −1.04090 (slopes 0.791 | 0.462) → 24+3 at −0.85470 (0.995 | 0.375) → 23+4 at −0.64937 (1.366 | 0.910). Between crossings, a contact kink appears where the deformed outer ring becomes circular: −0.9492 (0.32 → 0.87), −0.7889 and −0.5772. At K = −1 the lowest state is 25+2, as in `CURVED.md` (r = 3.957884). The 26-ring around one disk takes over below K = −1.0409. 28, 29 and 30 disks repeat the pattern. For 28: 27+1 → 26+2 → 25+3 → 24+4 → 23+5 at K = −1.08523, −0.90073, −0.69413, −0.53141. For 29: 28+1 → 27+2 → 26+3 → 25+4 → 24+5 at −1.12560, −0.93497, −0.72172, −0.54933, with one more 24+5 crossing at −0.51348. For 30: 29+1 → 28+2 → 27+3 → 26+4 → 25+5 at −1.16789, −0.97526, −0.77192, −0.58911. The first transition moves down by about 0.04 per added disk (−1.0409, −1.0852, −1.1256, −1.1679 for P = 27 … 30). At K = −1 the lowest states are 25+2, 26+2, 27+2 and 28+2, as in `CURVED.md`.
- A curiosity [CALC]: K_c(10) = −(arccosh φ)², with φ the golden ratio, because 1/(2 sin(π/10)) = φ. The same number, −1.1263047570, is the end K∞ = −a\*(3,3,2)² of two triangles in a triangle (a\* = 1.0612750619 from `kPolish`; it agrees with `data/curved/ideal.json`). I have not checked whether that coincidence is exact.

### 4.2 Triangles in a triangle (P = 2 … 6, 8, 9)

- **K = 0 is a corner for every degenerate record:** 2 triangles (slopes −0.498 | −0.282), 3 triangles (−0.750 | −0.250, also a crossing), 4 triangles, the tiling (−0.750 | 0), the proven 5 triangles with s = 1 + √3 (−1.433 | −0.894), 6 triangles (−1.904 | −1.655: after the rerun one configuration with a contact change at K = 0, not a crossing), 8 triangles (−2.334 | −0.708, a crossing) and the 9-triangle tiling (−2.500 | −0.625). The values for 2, 4 and 5 triangles agree with the research note's re-optimised slopes (−0.50 | −0.281, −0.751 | 0, −1.436 | −0.895).
- **Two triangles: a complete small hysteresis loop near K = 0.767.** For K < K_c = 0.76701290 the lowest state is mirror-asymmetric (C1, two mirror copies). Above it, the lowest state is the mirror-symmetric D1 arrangement. The symmetric branch exists far below K_c, but the stability probe finds it is a saddle there, and it becomes stable only above K = 0.76697. The asymmetric branch survives to its fold at K = 0.76783. Copies started elsewhere fold between 0.768 and 0.782, because the soft asymmetric mode makes the fold location sensitive to the step control. Coming down from K = 1 slowly, the system stays symmetric until 0.76697, where the symmetry breaks. Going up, it stays asymmetric until 0.76783 and then drops (by 7·10⁻⁷ in s) to the symmetric state. This is a subcritical pitchfork with a fold: a first-order transition with a narrow hysteresis window.
- **5 triangles** have four crossings for K > 0, at 0.2403, 0.6362, 0.9079 and 1.4577, and a kink at K = 1.22578 = K\*(q = 5), where five unit triangles fit around a common vertex: the {3,5} angle coincidence appears even in a triangular container.
- **8 triangles** (new): a crossing at K = 0 between a 3+5 state (K < 0) and a 2+6 state, then a cascade of nine crossings for K ∈ (0.33, 1.2): 2+6 → 6+2 → 7+1 → 6+2 arrangements, each with folds on both sides.
- At the negative end, s ≈ −α ln(K − K∞) + β with K∞ = −a\*² (table below).

### 4.3 Squares in a square (P = 2 … 9)

- **K = 0 is a corner for all of them.** 2 squares: −0.750 | −1.000, a crossing between two arrangements that tie at K = 0. 3, 4 squares: −1.000 | 0. 5 squares: −2.24 | −0.655. The proven D4 record is lowest only at K = 0: the branch from K < 0 and the branch from K > 0 are twisted C4 arrangements that both meet the D4 record there. 6, 7, 8 and 9 squares have crossings at K = 0 with slopes near −3 on the left. For 9 squares the 3×3 tiling meets, after the rerun, a different branch on the K > 0 side.
- **For K > 0, cascades of crossings** lead toward the hemisphere limit. 4 squares go C4 → C2 → C1 → D1 → D2 at K = 0.6214, 0.6614, 0.7474, 0.8757; 8 squares cross six times between K = 0 and 0.37; 9 squares eight times between K = 0 and 0.40. The individual positions in that cascade moved when the search was deepened (§3a); the number and range of crossings are the robust part. Each crossing has a hysteresis window ending in folds, shown in the viewer as × with a drop arrow.
- **Negative end:** P squares stop fitting at K∞ = −a\*², with a\* = 0.98220, 0.92481, 0.92062, 0.73915, 0.67647, 0.66400, 0.65924, 0.61473 for P = 2 … 9 (`kPolish` from the last configuration; floats, not certified). P = 4 agrees with the value quoted in `docs/spaces/CURVED.md` (0.9206).

### 4.4 Triangles in a q-gon with a {3, q} tiling curvature

All four show the same shape [CALC]:
- for K below K\*, a pinwheel (C_q) with s > 1, decreasing in K;
- at K\*, an exact tiling with s = 1;
- above K\*, a **plateau s = 1**: each triangle's base lies along a wall of length 1, and the bases are what pin the size;
- a crossing to a lower, less symmetric state well beyond K\*.

| problem | K\* | slope below K\* | plateau s = 1 on | crossing off the plateau |
|---|---|---|---|---|
| 5 triangles in a pentagon | 1.2258 | −0.172 | [1.2258, 1.5049] | 1.5049 (D5 → D1) |
| 6 triangles in a hexagon | 0 | −0.167 | [0, 0.8988] | 0.8988 (D6 → C3) |
| 7 triangles in a heptagon | −1.1893 | −0.171 | [−1.1893, 0.3935] | 0.3935 (D7 → 6+1) |
| 8 triangles in an octagon | −2.3365 | −0.177 | [−2.3365, −0.1687] | −0.1687 (D8 → 7+1) |

So the tiling curvature is a corner of s\*(K). It is not an isolated optimum: the s = 1 state is optimal on a whole interval above K\*.

## 5. Limitations and open questions

- **Best found, not proven.** Every size is a certified upper bound at its K. s\*(K) is the lowest of the branches found; a lower branch that no seed reached would move crossings or add new ones. Refinement found real misses near asymptotes (5 squares), and the rerun (§3a) found more for 6 and 7 squares. After the rerun the least converged part is the 9-square cascade near the hemisphere limit. 8 triangles and 28–30 disks had a single, moderate search.
- **Branch identity.** Branches are separated by size and sorted centre radii. Floppy configurations (s = 3 disk plateaus, s = 1 triangle plateaus) are not unique, so contact and symmetry changes inside a plateau are changes of representative, not of s.
- **Stability probe.** Perturbations of size 10⁻³ with re-polishing detect saddles reliably. On floppy or nearly degenerate branches they can flip back and forth; only the two-triangle pitchfork was checked in detail.
- **Folds versus slides.** A step is a fold when the configuration jumps *and* s drops. A fast but continuous rearrangement with no drop in s is accepted as continuous. Near a pitchfork, several numerically distinct folds can belong to one bifurcation (two triangles near 0.77).
- **Kink locations.** Crossings are roots of polished branch differences, located to about 10⁻¹⁰. Kinks found by the slope scan are located to about 10⁻⁶ by fits to sampled sizes. Contact changes are located by bisection, to about 10⁻¹¹, except in floppy states.
- **Not done:** 7 and 10 triangles and 10 squares (not reached within the rerun budget), and a second-order (Hessian) test for bifurcations.
- **Open:** is K_c(10) = K∞(two triangles) = −(arccosh φ)² exact? Do the crossing cascades near the hemisphere limit continue to accumulate for larger P?

## 6. Tables [CALC]

Generated by `python3 python/curved/sweep_report.py data/curved/sweep`. "certified" counts configurations proven by `certify.py`. For crossings it covers both branches at K_c and at the grid values on either side. Slopes are one-sided finite differences of polished branches. s\* is the lowest found, not proven optimal.

#### Ground-state sequence (lowest branch found; K ranges on the 1/64 grid)

| problem | K range | sequence of lowest configurations (shells · symmetry, K interval) | certified |
|---|---|---|---|
| 2 disks in a disk | [-2.000, 0.609] | b0 2 · D2 [-2.000, 0.609] | 43/43 |
| 3 disks in a disk | [-2.000, 0.500] | b0 3 · D3 [-2.000, 0.500] | 41/41 |
| 4 disks in a disk | [-2.000, 0.375] | b0 4 · D4 [-2.000, 0.375] | 39/39 |
| 5 disks in a disk | [-2.000, 0.281] | b0 5 · D5 [-2.000, 0.281] | 38/38 |
| 6 disks in a disk | [-2.000, 0.266] | b0 6 · D6 [-2.000, 0.000]; b1 5+1 · C1 [0.016, 0.266] | 44/44 |
| 7 disks in a disk | [-2.000, 0.203] | b1 7 · D7 [-2.000, -0.312]; b0 6+1 · D6 [-0.297, 0.203] | 43/43 |
| 8 disks in a disk | [-2.000, 0.156] | b1 8 · D8 [-2.000, -0.594]; b0 7+1 · D1 [-0.578, 0.156] | 42/42 |
| 9 disks in a disk | [-2.000, 0.125] | b1 9 · D9 [-2.000, -0.875]; b0 8+1 · D4 [-0.859, 0.125] | 41/41 |
| 10 disks in a disk | [-2.000, 0.125] | b1 10 · D10 [-2.000, -1.141]; b2 9+1 · C1 [-1.125, -0.062]; b0 8+1+1 · D1 [-0.047, 0.125] | 47/47 |
| 11 disks in a disk | [-2.000, 0.125] | b2 11 · D11 [-2.000, -1.391]; b1 10+1 · C1 [-1.375, -0.141]; b3 9+1+1 · C1 [-0.125, 0.000]; b0 8+1+2 · D1 [0.016, 0.125] | 53/53 |
| 12 disks in a disk | [-2.000, 0.094] | b2 12 · D12 [-2.000, -1.641]; b1 11+1 · C1 [-1.625, -0.234]; b3 10+1+1 · D1 [-0.219, -0.062]; b0 9+3 · D3 [-0.047, 0.094] | 53/53 |
| 27 disks in a disk | [-1.500, -0.500] | b1 26+1 · D26 [-1.500, -1.047]; b0 25+2 · C1 [-1.031, -0.859]; b7 24+3 · D3 [-0.844, -0.656]; b2 23+4 · D1 [-0.641, -0.500] | 35/35 |
| 28 disks in a disk | [-1.500, -0.500] | b0 27+1 · D27 [-1.500, -1.094]; b1 26+2 · D1 [-1.078, -0.906]; b2 25+3 · D1 [-0.891, -0.703]; b6 24+4 · D2 [-0.688, -0.547]; b3 23+5 · D1 [-0.531, -0.500] | 41/41 |
| 29 disks in a disk | [-1.500, -0.500] | b1 28+1 · D28 [-1.500, -1.141]; b5 27+2 · C1 [-1.125, -0.938]; b2 26+3 · D1 [-0.922, -0.734]; b7 25+4 · D1 [-0.719, -0.562]; b4 24+5 · D1 [-0.547, -0.516]; b3 24+5 · D1 [-0.500, -0.500] | 47/47 |
| 30 disks in a disk | [-1.500, -0.500] | b1 29+1 · C1 [-1.500, -1.172]; b2 28+2 · D1 [-1.156, -1.062]; b0 28+2 · D28 [-1.047, -0.984]; b5 27+3 · D3 [-0.969, -0.781]; b3 26+4 · D1 [-0.766, -0.594]; b4 25+5 · D5 [-0.578, -0.500] | 41/41 |
| 2 triangles in a triangle | [-1.125, 2.453] | b1 2 · D1 [-1.125, 0.766]; b0 1+1 · D1 [0.781, 2.453] | 64/64 |
| 3 triangles in a triangle | [-0.953, 2.453] | b2 2+1 · C1 [-0.953, 0.000]; b0 3 · C3 [0.016, 2.453] | 62/62 |
| 4 triangles in a triangle | [-0.953, 2.453] | b1 3+1 · C3 [-0.953, 0.922]; b0 4 · C1 [0.938, 1.359]; b2 4 · C1 [1.375, 1.500]; b3 4 · C1 [1.516, 1.828]; b0 4 · C1 [1.844, 2.344]; b4 4 · C1 [2.359, 2.406]; b0 4 · C1 [2.422, 2.453] | 67/67 |
| 5 triangles in a triangle | [-0.594, 1.688] | b1 3+2 · D1 [-0.594, 0.000]; b8 3+2 · D1 [0.016, 0.234]; b2 1+4 · C1 [0.250, 0.625]; b3 5 · C1 [0.641, 0.859]; b9 5 · C1 [0.875, 0.906]; b0 5 · D1 [0.922, 1.453]; b4 5 · C1 [1.469, 1.688] | 61/61 |
| 6 triangles in a triangle | [-0.516, 1.469] | b0 3+3 · C1 [-0.516, -0.156]; b1 3+3 · C1 [-0.141, 0.000]; b29 3+3 · C1 [0.016, 0.047]; b7 3+3 · C1 [0.062, 0.062]; b2 5+1 · C1 [0.078, 0.750]; b3 5+1 · C1 [0.766, 1.109]; b4 5+1 · C1 [1.125, 1.344]; b17 5+1 · D1 [1.359, 1.469] | 63/63 |
| 8 triangles in a triangle | [-0.438, 1.219] | b2 3+5 · C1 [-0.438, 0.000]; b3 2+6 · C1 [0.016, 0.312]; b9 2+6 · D1 [0.328, 0.344]; b4 2+6 · C1 [0.359, 0.469]; b5 6+2 · C1 [0.484, 0.516]; b11 6+2 · C1 [0.531, 0.531]; b45 7+1 · C1 [0.547, 0.609]; b70 7+1 · C1 [0.625, 0.641]; b6 7+1 · C1 [0.656, 0.766]; b7 7+1 · C1 [0.781, 0.969]; b1 6+2 · C1 [0.984, 1.016]; b69 6+2 · C1 [1.031, 1.062]; b1 6+2 · C1 [1.078, 1.141]; b8 6+2 · C1 [1.156, 1.203]; b1 6+2 · C1 [1.219, 1.219] | 97/97 |
| 9 triangles in a triangle | [-0.438, 1.078] | b0 3+6 · C3 [-0.438, 0.422]; b12 6+3 · C3 [0.438, 0.484]; b3 5+3+1 · C1 [0.500, 0.562]; b4 8+1 · C1 [0.578, 0.750]; b20 6+2+1 · C1 [0.766, 0.781]; b53 6+2+1 · C1 [0.797, 0.812]; b49 6+2+1 · C1 [0.828, 0.844]; b16 7+1+1 · C1 [0.859, 0.859]; b1 7+2 · C1 [0.875, 1.078] | 74/74 |
| 2 squares in a square | [-0.953, 1.500] | b0 2 · D2 [-0.953, 0.000]; b1 2 · C2 [0.016, 1.500] | 47/47 |
| 3 squares in a square | [-0.844, 1.141] | b0 3 · C1 [-0.844, -0.469]; b1 3 · C1 [-0.453, 0.000]; b0 3 · C1 [0.016, 1.141] | 33/33 |
| 4 squares in a square | [-0.844, 0.891] | b0 4 · C4 [-0.844, 0.609]; b3 4 · C2 [0.625, 0.656]; b2 4 · C1 [0.672, 0.734]; b1 4 · D1 [0.750, 0.875]; b4 4 · D2 [0.891, 0.891] | 53/53 |
| 5 squares in a square | [-0.531, 0.859] | b9 4+1 · C1 [-0.531, -0.516]; b10 4+1 · C1 [-0.500, -0.484]; b6 4+1 · C4 [-0.469, 0.000]; b3 4+1 · C4 [0.016, 0.281]; b1 4+1 · C4 [0.297, 0.859] | 40/40 |
| 6 squares in a square | [-0.453, 0.703] | b61 2+2+2 · C2 [-0.453, 0.000]; b1 1+4+1 · C1 [0.016, 0.016]; b68 1+4+1 · C1 [0.031, 0.047]; b1 1+4+1 · C1 [0.062, 0.219]; b72 5+1 · C1 [0.234, 0.250]; b1 5+1 · C1 [0.266, 0.344]; b73 5+1 · C1 [0.359, 0.375]; b1 5+1 · C1 [0.391, 0.469]; b2 5+1 · C1 [0.484, 0.656]; b70 5+1 · C1 [0.672, 0.688]; b69 5+1 · C1 [0.703, 0.703] | 38/38 |
| 7 squares in a square | [-0.438, 0.562] | b15 4+2+1 · C1 [-0.438, -0.391]; b17 4+2+1 · C1 [-0.375, -0.328]; b22 4+2+1 · C1 [-0.312, -0.297]; b17 4+2+1 · C1 [-0.281, -0.188]; b0 3+3+1 · C1 [-0.172, 0.000]; b1 2+4+1 · C2 [0.016, 0.453]; b2 6+1 · C1 [0.469, 0.500]; b18 5+1+1 · C1 [0.516, 0.562] | 47/47 |
| 8 squares in a square | [-0.422, 0.531] | b0 4+4 · C4 [-0.422, 0.000]; b25 3+4+1 · C1 [0.016, 0.047]; b26 7+1 · C1 [0.062, 0.062]; b17 7+1 · C1 [0.078, 0.109]; b8 6+1+1 · C1 [0.125, 0.234]; b1 6+1+1 · C1 [0.250, 0.266]; b18 5+2+1 · C1 [0.281, 0.297]; b1 6+1+1 · C1 [0.312, 0.328]; b8 6+2 · C1 [0.344, 0.359]; b10 6+2 · C2 [0.375, 0.516]; b3 6+2 · C1 [0.531, 0.531] | 52/52 |
| 9 squares in a square | [-0.375, 0.484] | b0 4+4+1 · D4 [-0.375, 0.000]; b68 4+4+1 · C4 [0.016, 0.016]; b0 4+4+1 · C4 [0.031, 0.203]; b111 7+1+1 · C1 [0.219, 0.219]; b71 5+2+2 · C1 [0.234, 0.250]; b5 7+2 · C1 [0.266, 0.328]; b135 7+2 · C1 [0.344, 0.344]; b61 7+2 · C1 [0.359, 0.375]; b23 7+2 · C1 [0.391, 0.391]; b95 6+3 · C1 [0.406, 0.484] | 62/62 |
| 5 triangles in a pentagon | [-1.000, 1.688] | b0 5 · C5 [-1.000, 1.500]; b4 5 · D1 [1.516, 1.688] | 50/50 |
| 6 triangles in a hexagon | [-1.500, 1.469] | b0 6 · C6 [-1.500, -0.062]; b13 6 · C6 [-0.047, 0.000]; b0 6 · D6 [0.016, 0.891]; b1 6 · C3 [0.906, 1.094]; b2 5+1 · C1 [1.109, 1.250]; b3 5+1 · D1 [1.266, 1.469] | 73/73 |
| 7 triangles in a heptagon | [-2.000, 1.000] | b0 7 · C7 [-2.000, 0.391]; b1 6+1 · C1 [0.406, 0.500]; b6 6+1 · C1 [0.516, 0.516]; b10 6+1 · C1 [0.531, 0.719]; b2 6+1 · C1 [0.734, 1.000] | 61/61 |
| 8 triangles in an octagon | [-3.000, 0.500] | b0 8 · C8 [-3.000, -2.422]; b46 8 · C8 [-2.406, -2.328]; b0 8 · D8 [-2.312, -0.172]; b1 7+1 · C1 [-0.156, 0.047]; b20 7+1 · C1 [0.062, 0.203]; b47 7+1 · C1 [0.219, 0.219]; b26 7+1 · C1 [0.234, 0.297]; b40 7+1 · C1 [0.312, 0.359]; b27 7+1 · C1 [0.375, 0.391]; b2 7+1 · C1 [0.406, 0.500] | 81/81 |

#### Events on the ground state (crossings, stability changes, and kinks of at least 5% of the slope; the viewer lists every event)

| problem | K | type | s | slope left | slope right | before → after | metastable continuation | certified |
|---|---|---|---|---|---|---|---|---|
| 6 disks in a disk | 0.00000000 | crossing | 3.000000 | 0.9997 | 0.0000 | 6 D6 → 5+1 C1 | b0 up to 0.2150 (hemisphere); b1 down to -2.0000 (infeasible) | 6/6 |
| 7 disks in a disk | -0.29732464 | crossing | 3.000000 | 0.6660 | 0.0000 | 7 D7 → 6+1 D6 | b1 up to 0.1676 (hemisphere); b0 down to -2.0000 (range) | 6/6 |
| 7 disks in a disk | -0.00000000 | contact | 3.000000 | 0.0000 | 1.0002 | branch 0: contacts +[p:0-1, p:0-2, p:1-4, p:2-5, p:4-6, p:5-6] -[none]; symmetry D6 -> D6; |  |  |
| 8 disks in a disk | -0.58413226 | crossing | 3.000000 | 0.5013 | 0.0000 | 8 D8 → 7+1 D1 | b1 up to 0.1336 (hemisphere); b0 down to -2.0000 (range) | 6/6 |
| 8 disks in a disk | -0.29732494 | kink | 3.000000 | 0.0000 | 0.6664 | branch 0 (shells 7+1, D1, 14 contacts): slope jumps from nan to 0.6664 with no change of t |  |  |
| 9 disks in a disk | -0.86032779 | crossing | 3.000000 | 0.4036 | 0.0000 | 9 D9 → 8+1 D4 | b1 up to 0.1086 (hemisphere); b0 down to -2.0000 (range) | 6/6 |
| 9 disks in a disk | -0.58413196 | kink | 3.000000 | -0.0000 | 0.5015 | branch 0 (shells 8+1, D4, 16 contacts): slope jumps from -0.0000 to 0.5015 with no change  |  |  |
| 10 disks in a disk | -1.12630476 | crossing | 3.000000 | 0.3391 | 0.0000 | 10 D10 → 9+1 C1 | b1 up to 0.0898 (hemisphere); b2 down to -2.0000 (range) | 6/6 |
| 10 disks in a disk | -0.86032754 | kink | 3.000000 | -0.0000 | 0.4038 | branch 2 (shells 9+1, D1, 20 contacts): slope jumps from -0.0000 to 0.4038 with no change  |  |  |
| 10 disks in a disk | -0.06247764 | crossing | 3.736029 | 2.4808 | 1.2779 | 9+1 D9 → 8+1+1 D1 | b2 up to 0.1086 (hemisphere); b0 down to -0.2100 (fold) | 6/6 |
| 10 disks in a disk | 0.08118176 | contact | 3.895310 | 0.8096 | 4.9313 | branch 0: contacts +[p:8-9] -[p:0-4, p:1-4, p:7-8, p:7-9]; symmetry D1 -> C1; kink (slope  |  |  |
| 11 disks in a disk | -1.38263317 | crossing | 3.000000 | 0.2934 | 0.0000 | 11 D11 → 10+1 C1 | b2 up to 0.0754 (hemisphere); b1 down to -2.0000 (range) | 6/6 |
| 11 disks in a disk | -1.12630423 | kink | 3.000000 | 0.0000 | 0.3392 | branch 1 (shells 10+1, C1, 20 contacts): slope jumps from nan to 0.3392 with no change of  |  |  |
| 11 disks in a disk | -0.14020449 | crossing | 3.781418 | 2.1606 | 1.1532 | 10+1 D10 → 9+1+1 C1 | b1 up to 0.0898 (hemisphere); b3 down to -0.3137 (fold) | 6/6 |
| 11 disks in a disk | -0.00000000 | contact | 3.923804 | 0.7733 | 3.6798 | branch 3: contacts +[p:1-10] -[none]; symmetry C1 -> D1; kink (slope 0.7733 | 3.6798) |  |  |
| 11 disks in a disk | 0.00000000 | crossing | 3.923804 | 0.7735 | 2.1323 | 9+2 D1 → 8+1+2 D1 | b3 up to 0.1086 (hemisphere); b0 down to -0.4314 (fold) | 6/6 |
| 11 disks in a disk | 0.11631567 | contact | 4.118128 | 0.8101 | 8.3925 | branch 0: contacts +[p:9-10] -[p:2-4, p:3-5, p:4-8, p:5-8, p:8-10, p:8-9]; rattlers [] ->  |  |  |
| 12 disks in a disk | -1.62992936 | crossing | 3.000000 | 0.2593 | -0.0000 | 12 D12 → 11+1 C1 | b2 up to 0.0641 (hemisphere); b1 down to -2.0000 (range) | 6/6 |
| 12 disks in a disk | -1.38263372 | kink | 3.000000 | 0.0000 | 0.2934 | branch 1 (shells 11+1, C1, 28 contacts): slope jumps from 0.0000 to 0.2934 with no change  |  |  |
| 12 disks in a disk | -0.21996369 | crossing | 3.801978 | 1.8715 | 1.0049 | 11+1 D11 → 10+1+1 D1 | b1 up to 0.0754 (hemisphere); b3 down to -0.4202 (fold) | 6/6 |
| 12 disks in a disk | -0.08364468 | contact | 3.921231 | 0.6565 | 2.8406 | branch 3: contacts +[p:2-7] -[p:0-5, p:1-5, p:2-6, p:5-6, p:6-7]; symmetry D1 -> C1; kink  |  |  |
| 12 disks in a disk | -0.06243829 | crossing | 3.985208 | 3.2061 | 0.7083 | 10+2 C1 → 9+3 D3 | b3 up to 0.0898 (hemisphere); b0 down to -0.9122 (fold) | 6/6 |
| 12 disks in a disk | 0.03046174 | contact | 4.051163 | 0.7038 | 4.7793 | branch 0: contacts +[p:1-5, p:10-11, p:2-6] -[p:1-3, p:2-4, p:3-5, p:4-6, p:7-10, p:7-11]; |  |  |
| 27 disks in a disk | -1.04089622 | crossing | 3.939796 | 0.7913 | 0.4621 | 26+1 D26 → 25+2 C1 | b1 up to -0.5000 (range); b0 down to -1.4581 (fold) | 6/6 |
| 27 disks in a disk | -0.94923390 | contact | 3.976936 | 0.3201 | 0.8706 | branch 0: contacts +[p:10-17] -[p:10-25, p:16-26, p:17-25, p:19-26, p:25-26]; rattlers []  |  |  |
| 27 disks in a disk | -0.85469994 | crossing | 4.064886 | 0.9948 | 0.3746 | 25+2 D25 → 24+3 D3 | b0 up to -0.5000 (range); b7 down to -1.5000 (range) | 6/6 |
| 27 disks in a disk | -0.78894913 | contact | 4.088340 | 0.3350 | 1.0727 | branch 7: contacts +[p:0-5, p:16-23, p:2-20] -[p:0-25, p:12-16, p:12-23, p:2-6, p:5-25, p: |  |  |
| 27 disks in a disk | -0.64936949 | crossing | 4.257112 | 1.3658 | 0.9100 | 24+3 C1 → 23+4 D1 | b7 up to -0.5000 (range); b2 down to -0.9653 (fold) | 6/6 |
| 27 disks in a disk | -0.57720168 | contact | 4.308034 | 0.3241 | 1.5318 | branch 2: contacts +[p:4-23] -[p:1-10, p:14-25, p:2-10, p:2-13, p:2-14, p:4-6, p:6-10, p:6 |  |  |
| 28 disks in a disk | -1.08522611 | crossing | 3.941547 | 0.7660 | 0.4474 | 27+1 D27 → 26+2 D1 | b0 up to -0.5000 (range); b1 down to -1.5000 (range) | 6/6 |
| 28 disks in a disk | -0.99562538 | contact | 3.976664 | 0.3093 | 0.8382 | branch 1: contacts +[p:2-5] -[p:1-12, p:1-2, p:1-5, p:12-16, p:3-12]; rattlers [] -> [1, 1 |  |  |
| 28 disks in a disk | -0.90073317 | crossing | 4.061451 | 0.9530 | 0.3511 | 26+2 D26 → 25+3 D1 | b1 up to -0.5000 (range); b2 down to -1.5000 (range) | 6/6 |
| 28 disks in a disk | -0.88612083 | contact | 4.066519 | 0.3423 | 0.6023 | branch 2: contacts +[p:1-2, p:18-20] -[p:1-25, p:11-18]; symmetry D1 -> D1; kink (slope 0. |  |  |
| 28 disks in a disk | -0.81631103 | contact | 4.104205 | 0.4464 | 1.0546 | branch 2: contacts +[p:10-12] -[p:10-15, p:11-15, p:11-20, p:11-25, p:12-15, p:15-25, p:2- |  |  |
| 28 disks in a disk | -0.69412893 | crossing | 4.246717 | 1.2919 | 0.5423 | 25+3 C1 → 24+4 D2 | b2 up to -0.5000 (range); b6 down to -1.2703 (fold) | 6/6 |
| 28 disks in a disk | -0.63615656 | contact | 4.275391 | 0.4384 | 1.4012 | branch 6: contacts +[p:14-24, p:8-9] -[p:1-16, p:10-16, p:13-15, p:14-27, p:24-27, p:7-13, |  |  |
| 28 disks in a disk | -0.53599208 | contact | 4.435819 | 1.8216 | -0.6181 | branch 3: contacts +[p:12-20, p:2-16, p:3-23, p:4-14] -[p:10-12, p:14-26, p:16-22, p:3-7]; |  |  |
| 28 disks in a disk | -0.53141016 | crossing | 4.438969 | 1.7436 | 1.2787 | 24+4 C2 → 23+5 D1 | b6 up to -0.5000 (range); b3 down to -1.3726 (fold) | 6/6 |
| 29 disks in a disk | -1.12560080 | crossing | 3.945339 | 0.7453 | 0.4368 | 28+1 D28 → 27+2 C1 | b1 up to -0.5000 (range); b5 down to -1.5000 (range) | 6/6 |
| 29 disks in a disk | -1.03774898 | contact | 3.978989 | 0.3031 | 0.8120 | branch 5: contacts +[p:18-22] -[p:0-14, p:0-27, p:17-18, p:17-22]; symmetry C1 -> C1; kink |  |  |
| 29 disks in a disk | -0.93496578 | crossing | 4.068229 | 0.9289 | 0.5914 | 27+2 C1 → 26+3 D1 | b5 up to -0.5000 (range); b2 down to -1.5000 (range) | 6/6 |
| 29 disks in a disk | -0.85447292 | contact | 4.107046 | 0.2846 | 1.0195 | branch 2: contacts +[p:19-20] -[p:15-22, p:15-26, p:19-26, p:2-15, p:2-26, p:2-28, p:20-26 |  |  |
| 29 disks in a disk | -0.72172178 | crossing | 4.257478 | 1.2616 | 0.4847 | 26+3 D26 → 25+4 D1 | b2 up to -0.5000 (range); b7 down to -0.8821 (fold) | 6/6 |
| 29 disks in a disk | -0.68782315 | contact | 4.272889 | 0.4213 | 0.7935 | branch 7: contacts +[p:0-14, p:8-17] -[p:0-27, p:8-13]; symmetry D1 -> D1; kink (slope 0.4 |  |  |
| 29 disks in a disk | -0.65811444 | contact | 4.294814 | 0.6696 | 1.3806 | branch 7: contacts +[p:3-24] -[p:13-17, p:13-23, p:14-27, p:23-24, p:23-27, p:3-23, p:4-10 |  |  |
| 29 disks in a disk | -0.54932665 | crossing | 4.462449 | 1.7230 | 1.2066 | 25+4 C1 → 24+5 D1 | b7 up to -0.5000 (range); b4 down to -0.6599 (fold) | 6/6 |
| 29 disks in a disk | -0.51348097 | crossing | 4.501528 | 0.9185 | 0.8227 | 24+5 D1 → 24+5 C1 | b4 up to -0.5000 (range); b3 down to -0.5708 (fold) | 6/6 |
| 30 disks in a disk | -1.16788840 | crossing | 3.946797 | 0.7238 | 0.4242 | 29+1 D29 → 28+2 D1 | b1 up to -0.5000 (range); b2 down to -1.5000 (range) | 6/6 |
| 30 disks in a disk | -1.08190878 | contact | 3.978759 | 0.2939 | 0.7850 | branch 2: contacts +[p:14-17] -[p:1-14, p:1-17, p:1-22, p:11-22, p:22-27]; rattlers [] ->  |  |  |
| 30 disks in a disk | -0.97525781 | crossing | 4.068291 | 0.8982 | 0.3473 | 28+2 D28 → 27+3 D3 | b0 up to -0.5000 (range); b5 down to -1.5000 (range) | 6/6 |
| 30 disks in a disk | -0.91320325 | contact | 4.088756 | 0.3087 | 0.9577 | branch 5: contacts +[p:13-19, p:17-24, p:6-29] -[p:13-20, p:4-7, p:7-17, p:7-24]; symmetry |  |  |
| 30 disks in a disk | -0.77192006 | crossing | 4.239225 | 1.1863 | 0.4935 | 27+3 D27 → 26+4 D1 | b5 up to -0.5000 (range); b3 down to -1.1235 (fold) | 6/6 |
| 30 disks in a disk | -0.76845206 | contact | 4.240927 | 0.4881 | 0.8172 | branch 3: contacts +[p:9-28] -[p:16-20, p:5-29]; symmetry D1 -> D1; kink (slope 0.4881 | 0 |  |  |
| 30 disks in a disk | -0.69642269 | contact | 4.290120 | 0.4459 | 1.3196 | branch 3: contacts +[p:22-25] -[p:11-28, p:20-26, p:5-11, p:5-18, p:5-6, p:6-20, p:6-22, p |  |  |
| 30 disks in a disk | -0.58910966 | crossing | 4.447075 | 1.6236 | 0.5915 | 26+4 C1 → 25+5 D5 | b3 up to -0.5000 (range); b4 down to -1.5000 (range) | 6/6 |
| 30 disks in a disk | -0.54247304 | contact | 4.474351 | 0.5766 | 1.7501 | branch 4: contacts +[p:0-27, p:11-23, p:2-14, p:3-7, p:5-21] -[p:0-1, p:1-26, p:1-27, p:1- |  |  |
| 2 triangles in a triangle | 0.00000095 | contact | 2.000000 | -0.4976 | -0.2815 | branch 1: contacts +[none] -[w:1:1]; symmetry D1 -> C1; kink (slope -0.4976 | -0.2815) |  |  |
| 2 triangles in a triangle | 0.76696676 | stability | 1.793584 | – | – | branch 0 (D1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 2 triangles in a triangle | 0.76701290 | crossing | 1.793571 | -0.2625 | -0.2793 | 2 C1 → 1+1 D1 | b1 up to 0.7678 (fold); b0 down to 0.3897 (fold) | 5/5 |
| 3 triangles in a triangle | -0.00005333 | symmetry | 2.000040 | -0.7501 | -0.5167 | branch 2: contacts +[none] -[none]; symmetry C1 -> D1; kink (slope -0.7501 | -0.5167) |  |  |
| 3 triangles in a triangle | 0.00000000 | crossing | 2.000000 | -0.7501 | -0.2500 | 2+1 D1 → 3 D3 | b2 up to 2.4674 (hemisphere); b0 down to 0.0000 (infeasible) | 6/6 |
| 4 triangles in a triangle | -0.00004619 | symmetry | 2.000035 | -0.7501 | -0.3464 | branch 1: contacts +[none] -[none]; symmetry C3 -> D3; kink (slope -0.7501 | -0.3464) |  |  |
| 4 triangles in a triangle | 0.92670356 | crossing | 1.925221 | -0.2162 | -0.5974 | 3+1 D3 → 4 C1 | b1 up to 1.5153 (hemisphere); b0 down to 0.5948 (fold) | 6/6 |
| 4 triangles in a triangle | 2.35742193 | stability | 1.363570 | – | – | branch 4 (C1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 5 triangles in a triangle | 0.00000037 | kink | 2.732050 | -1.4334 | -0.8943 | branch 1 (shells 3+2, D1, 9 contacts, 1 rattler): slope jumps from -1.4334 to -0.8943 with |  |  |
| 5 triangles in a triangle | 0.24034676 | crossing | 2.557572 | -0.4252 | -1.3659 | 3+2 D1 → 1+4 C1 | b8 up to 1.1512 (fold); b2 down to -0.0000 (fold) | 6/6 |
| 5 triangles in a triangle | 0.63622248 | crossing | 2.170978 | -0.6286 | -0.8206 | 4+1 C1 → 5 C1 | b2 up to 1.4789 (hemisphere); b3 down to -0.4196 (cap) | 6/6 |
| 5 triangles in a triangle | 0.90792341 | crossing | 1.974786 | -0.6383 | -0.6564 | 5 C1 → 5 D1 | b9 up to 1.0006 (fold); b0 down to 0.8139 (fold) | 6/6 |
| 5 triangles in a triangle | 1.22577828 | contact | 1.789376 | -0.5188 | -0.4295 | branch 0: contacts +[none] -[p:0-2, p:0-3, p:1-2, p:1-4, p:3-4]; symmetry D1 -> C1; kink ( |  |  |
| 5 triangles in a triangle | 1.43617535 | contact | 1.702747 | -0.4036 | -0.2698 | branch 0: contacts +[w:4:1] -[w:0:2]; symmetry C1 -> C1; kink (slope -0.4036 | -0.2698) |  |  |
| 5 triangles in a triangle | 1.45771220 | crossing | 1.696224 | -0.3334 | -0.3683 | 5 C1 → 5 C1 | b0 up to 1.4663 (fold); b4 down to 1.4453 (fold) | 5/5 |
| 5 triangles in a triangle | 1.48451780 | contact | 1.685940 | -0.3996 | -0.2857 | branch 4: contacts +[w:2:2] -[none]; symmetry C1 -> D1; kink (slope -0.3996 | -0.2857) |  |  |
| 6 triangles in a triangle | -0.15302831 | crossing | 3.329106 | -2.6633 | -2.8101 | 3+3 C1 → 3+3 C1 | b0 up to 0.0000 (fold); b1 down to -0.2843 (fold) | 6/6 |
| 6 triangles in a triangle | -0.00000002 | contact | 2.977082 | -1.9042 | -1.6551 | branch 1: contacts +[w:2:2] -[none]; rattlers [2] -> []; symmetry C1 -> C1; kink (slope -1 |  |  |
| 6 triangles in a triangle | 0.01562494 | stability | 2.951356 | – | – | branch 1 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 6 triangles in a triangle | 0.06951021 | crossing | 2.865760 | -0.8999 | -1.7819 | 3+3 C1 → 5+1 C1 | b7 up to 0.5994 (fold); b2 down to -0.4602 (cap) | 6/6 |
| 6 triangles in a triangle | 0.55519110 | contact | 2.286824 | -0.8331 | -0.6365 | branch 2: contacts +[w:1:1] -[none]; symmetry C1 -> C1; kink (slope -0.8331 | -0.6365) |  |  |
| 6 triangles in a triangle | 0.64631121 | kink | 2.226673 | -0.6975 | -0.5796 | branch 2 (shells 5+1, C1, 16 contacts): slope jumps from -0.6975 to -0.5796 with no change |  |  |
| 6 triangles in a triangle | 0.76276815 | crossing | 2.159024 | -0.5827 | -0.7771 | 5+1 C1 → 5+1 C1 | b2 up to 0.9919 (fold); b3 down to 0.6116 (fold) | 6/6 |
| 6 triangles in a triangle | 1.11383321 | crossing | 1.924409 | -0.4740 | -0.4845 | 5+1 C1 → 5+1 C1 | b3 up to 1.1395 (fold); b4 down to 1.0959 (fold) | 6/6 |
| 6 triangles in a triangle | 1.33203894 | stability | 1.807713 | – | – | branch 17 (C1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 6 triangles in a triangle | 1.35840497 | crossing | 1.792299 | -0.5725 | -0.5835 | 5+1 C1 → 5+1 D1 | b4 up to 1.4634 (hemisphere); b17 down to 1.3242 (fold) | 6/6 |
| 8 triangles in a triangle | 0.00000000 | crossing | 3.000000 | -2.3339 | -0.7084 | 3+5 D3 → 2+6 D1 | b2 up to 0.4466 (fold); b3 down to -0.4196 (cap) | 6/6 |
| 8 triangles in a triangle | 0.32697730 | crossing | 2.700482 | -0.8840 | -0.8961 | 2+6 C1 → 2+6 D1 | b3 up to 0.3974 (fold); b9 down to -0.4196 (cap) | 6/6 |
| 8 triangles in a triangle | 0.35389754 | crossing | 2.676422 | -0.8914 | -0.9251 | 8 D1 → 2+6 C1 | b9 up to 0.7615 (fold); b4 down to 0.1845 (fold) | 6/6 |
| 8 triangles in a triangle | 0.49877614 | stability | 2.542992 | – | – | branch 4 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in a triangle | 0.51818117 | crossing | 2.525118 | -0.9199 | -0.9517 | 6+2 C1 → 6+2 C1 | b5 up to 0.6313 (fold); b11 down to 0.4041 (fold) | 6/6 |
| 8 triangles in a triangle | 0.53146302 | crossing | 2.512470 | -0.9529 | -1.3057 | 6+2 C1 → 7+1 C1 | b11 up to 0.6147 (fold); b45 down to -0.0000 (fold) | 6/6 |
| 8 triangles in a triangle | 0.54796159 | contact | 2.491168 | -1.2767 | -1.1478 | branch 45: contacts +[w:2:1] -[none]; symmetry C1 -> C1; kink (slope -1.2767 | -1.1478) |  |  |
| 8 triangles in a triangle | 0.62042454 | crossing | 2.407580 | -1.1567 | -1.1771 | 7+1 C1 → 7+1 C1 | b45 up to 0.8940 (fold); b70 down to 0.4163 (fold) | 6/6 |
| 8 triangles in a triangle | 0.64531607 | contact | 2.379945 | -1.0261 | -0.9191 | branch 6: contacts +[p:0-5, p:1-3] -[w:6:0]; symmetry C1 -> C1; kink (slope -1.0261 | -0.9 |  |  |
| 8 triangles in a triangle | 0.77732992 | crossing | 2.269898 | -0.7866 | -0.9494 | 7+1 C1 → 7+1 C1 | b6 up to 0.8939 (fold); b7 down to -0.0000 (fold) | 6/6 |
| 8 triangles in a triangle | 0.98308508 | crossing | 2.088641 | -0.8462 | -0.8609 | 6+2 C1 → 6+2 C1 | b7 up to 1.0092 (fold); b1 down to 0.9407 (fold) | 6/6 |
| 8 triangles in a triangle | 1.07253585 | crossing | 2.014554 | 3.9478 | -0.8240 | 6+2 C1 → 6+2 C1 | b69 up to 1.2258 (hemisphere); b1 down to 0.9923 (fold) | 5/5 |
| 8 triangles in a triangle | 1.14366326 | crossing | 1.956698 | 2.6237 | – | 6+2 C1 → 6+2 C1 | b1 up to 1.2258 (hemisphere) | 5/5 |
| 9 triangles in a triangle | -0.00000001 | contact | 3.000000 | -2.3336 | -0.5797 | branch 0: contacts +[p:0-1, p:1-7, p:2-6, p:3-4, p:3-6, p:3-7, p:4-5, p:4-7, p:5-8] -[none |  |  |
| 9 triangles in a triangle | 0.43077186 | crossing | 2.658738 | -0.9162 | -0.9541 | 3+3+3 C3 → 6+3 C3 | b0 up to 0.5813 (fold); b12 down to 0.3926 (fold) | 6/6 |
| 9 triangles in a triangle | 0.49183500 | contact | 2.599887 | -1.4108 | -1.2676 | branch 3: contacts +[none] -[p:2-4, w:1:0]; symmetry C1 -> C1; kink (slope -1.4108 | -1.26 |  |  |
| 9 triangles in a triangle | 0.49286993 | crossing | 2.598576 | -0.9821 | -1.2659 | 6+3 C3 → 5+3+1 C1 | b12 up to 0.7676 (fold); b3 down to -0.0000 (fold) | 6/6 |
| 9 triangles in a triangle | 0.52472974 | contact | 2.559016 | -1.2240 | -1.7618 | branch 3: contacts +[p:6-7] -[w:3:0]; symmetry C1 -> C1; kink (slope -1.2240 | -1.7618) |  |  |
| 9 triangles in a triangle | 0.56250592 | crossing | 2.515106 | -1.0685 | -1.2907 | 5+3+1 C1 → 8+1 C1 | b3 up to 0.7188 (fold); b4 down to 0.4899 (fold) | 6/6 |
| 9 triangles in a triangle | 0.75523631 | crossing | 2.311514 | -0.8365 | -0.8933 | 5+3+1 C1 → 6+2+1 C1 | b4 up to 0.9911 (fold); b20 down to 0.5106 (fold) | 6/6 |
| 9 triangles in a triangle | 0.79428818 | crossing | 2.277697 | -0.8068 | -0.9067 | 6+2+1 C1 → 6+2+1 C1 | b20 up to 0.9789 (fold); b53 down to 0.6481 (fold) | 6/6 |
| 9 triangles in a triangle | 0.80847162 | stability | 2.266254 | – | – | branch 20 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 9 triangles in a triangle | 0.82743679 | crossing | 2.249819 | -0.8383 | -0.8571 | 6+2+1 C1 → 6+2+1 C1 | b53 up to 0.8540 (fold); b49 down to 0.6481 (fold) | 6/6 |
| 9 triangles in a triangle | 0.85596760 | crossing | 2.225064 | -0.8787 | -0.9286 | 6+2+1 C1 → 7+1+1 C1 | b49 up to 1.0340 (hemisphere); b16 down to 0.4775 (fold) | 6/6 |
| 9 triangles in a triangle | 0.86226232 | crossing | 2.219215 | -0.9298 | -0.9670 | 7+1+1 C1 → 7+2 C1 | b16 up to 0.9806 (fold); b1 down to 0.8084 (fold) | 6/6 |
| 9 triangles in a triangle | 0.92187494 | stability | 2.162369 | – | – | branch 1 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 9 triangles in a triangle | 0.94757080 | contact | 2.138206 | -0.9383 | -1.3545 | branch 1: contacts +[p:2-5, p:6-8] -[p:2-4]; symmetry C1 -> C1; kink (slope -0.9383 | -1.3 |  |  |
| 9 triangles in a triangle | 0.96093768 | stability | 2.125622 | – | – | branch 1 (C1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 2 squares in a square | 0.00000000 | crossing | 2.000000 | -0.7501 | -0.9997 | 2 D2 → 2 D2 | b0 up to 1.5153 (hemisphere); b1 down to -0.8909 (cap) | 6/6 |
| 2 squares in a square | 0.00000387 | stability | 1.999997 | – | – | branch 0 (D2) loses stability as K increases (perturb-and-polish probe) |  |  |
| 3 squares in a square | -0.00000001 | contact | 2.000000 | -1.0001 | -0.0003 | branch 1: contacts +[w:1:3] -[none]; symmetry C1 -> C1; kink (slope -1.0001 | -0.0003) |  |  |
| 4 squares in a square | 0.00000000 | contact | 2.000000 | -1.0000 | -0.0000 | branch 0: contacts +[none] -[p:0-3, p:1-2]; symmetry D4 -> D4; kink (slope -1.0000 | -0.00 |  |  |
| 4 squares in a square | 0.62141109 | crossing | 1.875095 | -0.5478 | -0.5899 | 4 C4 → 4 C2 | b0 up to 0.8659 (hemisphere); b3 down to 0.4076 (fold) | 6/6 |
| 4 squares in a square | 0.66137262 | crossing | 1.850217 | -0.6549 | -0.6608 | 4 C2 → 4 C1 | b3 up to 0.8873 (fold); b2 down to 0.5178 (fold) | 6/6 |
| 4 squares in a square | 0.74742907 | crossing | 1.787761 | -0.7865 | -0.8125 | 4 C1 → 4 D1 | b2 up to 0.8146 (fold); b1 down to 0.5840 (fold) | 6/6 |
| 4 squares in a square | 0.76576233 | symmetry | 1.772736 | -0.8264 | -0.5012 | branch 1: contacts +[none] -[none]; symmetry C1 -> D1; kink (slope -0.8264 | -0.5012) |  |  |
| 4 squares in a square | 0.87565117 | crossing | 1.678038 | -0.9054 | -0.9112 | 4 C1 → 4 D2 | b1 up to 0.8981 (hemisphere); b4 down to -0.5295 (fold) | 6/6 |
| 5 squares in a square | -0.51235609 | crossing | 6.059239 | -37.3159 | -37.0876 | 4+1 C1 → 4+1 C1 | b9 up to 0.1181 (fold); b10 down to -0.5462 (cap) | 6/6 |
| 5 squares in a square | -0.46900040 | crossing | 5.039837 | -15.7050 | -15.7436 | 4+1 C1 → 4+1 C4 | b10 up to 0.1181 (fold); b6 down to -0.5463 (cap) | 5/5 |
| 5 squares in a square | -0.00002420 | symmetry | 2.707161 | -2.2373 | -1.0379 | branch 6: contacts +[none] -[none]; symmetry C4 -> D4; kink (slope -2.2373 | -1.0379) |  |  |
| 5 squares in a square | 0.00000000 | crossing | 2.707107 | -2.2399 | -0.6550 | 4+1 D4 → 4+1 D4 | b6 up to 0.8599 (hemisphere); b3 down to -0.4780 (cap) | 5/5 |
| 6 squares in a square | 0.00000000 | crossing | 3.000000 | -3.1260 | -2.9987 | 2+2+2 C2 → 1+4+1 C1 | b61 up to 0.0000 (fold); b1 down to -0.3776 (cap) | 6/6 |
| 6 squares in a square | 0.03124994 | stability | 2.912028 | – | – | branch 1 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 6 squares in a square | 0.04198974 | stability | 2.883460 | – | – | branch 1 (C1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 6 squares in a square | 0.47129048 | crossing | 2.168641 | -1.2660 | -1.2812 | 5+1 C1 → 5+1 C1 | b1 up to 0.7022 (fold); b2 down to -0.3776 (cap) | 6/6 |
| 6 squares in a square | 0.65908628 | crossing | 1.931059 | 0.6124 | -0.2025 | 5+1 C1 → 5+1 C1 | b2 up to 0.7084 (hemisphere); b70 down to 0.6339 (fold) | 6/6 |
| 7 squares in a square | -0.38890098 | crossing | 5.822911 | -26.4663 | -26.7907 | 4+2+1 C1 → 4+2+1 C1 | b15 up to 0.0519 (fold); b17 down to -0.4399 (cap) | 6/6 |
| 7 squares in a square | -0.18072985 | crossing | 3.682729 | -4.9290 | -4.9838 | 4+2+1 C1 → 3+3+1 C1 | b17 up to 0.2288 (fold); b0 down to -0.4394 (cap) | 6/6 |
| 7 squares in a square | 0.00000000 | crossing | 3.000000 | -3.0006 | -2.2495 | 3+3+1 C1 → 2+4+1 C2 | b0 up to 0.0574 (fold); b1 down to -0.3776 (cap) | 6/6 |
| 7 squares in a square | 0.45683098 | crossing | 2.272465 | -1.5532 | -1.5940 | 6+1 C2 → 6+1 C1 | b1 up to 0.5688 (hemisphere); b2 down to -0.3776 (cap) | 6/6 |
| 7 squares in a square | 0.51489339 | crossing | 2.177176 | -1.6933 | -1.7255 | 6+1 C1 → 5+1+1 C1 | b2 up to 0.5710 (hemisphere); b18 down to 0.4062 (fold) | 6/6 |
| 8 squares in a square | -0.00006336 | contact | 3.000190 | -3.0007 | -1.9010 | branch 0: contacts +[p:0-5, p:1-2, p:3-6, p:4-7] -[none]; symmetry C4 -> D4; kink (slope - |  |  |
| 8 squares in a square | 0.00000006 | crossing | 3.000000 | -2.9999 | -0.0023 | 4+4 D4 → 3+4+1 C1 | b0 up to 0.1149 (fold); b25 down to -0.3776 (cap) | 6/6 |
| 8 squares in a square | 0.06533154 | crossing | 2.969949 | -0.1452 | -0.8188 | 7+1 C1 → 7+1 C1 | b26 up to 0.1711 (fold); b17 down to -0.3776 (cap) | 6/6 |
| 8 squares in a square | 0.09861749 | stability | 2.938747 | – | – | branch 8 (C1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 8 squares in a square | 0.11648939 | crossing | 2.917893 | -1.1885 | -1.2306 | 7+1 C1 → 6+1+1 C1 | b17 up to 0.1279 (fold); b8 down to 0.0916 (fold) | 6/6 |
| 8 squares in a square | 0.27182044 | crossing | 2.675011 | -1.7752 | -1.8310 | 6+1+1 C1 → 5+2+1 C1 | b1 up to 0.3350 (fold); b18 down to -0.3776 (fold) | 6/6 |
| 8 squares in a square | 0.30766057 | crossing | 2.610208 | -1.7821 | -1.8398 | 5+3 C1 → 6+1+1 C1 | b18 up to 0.3578 (fold); b1 down to 0.2280 (fold) | 6/6 |
| 8 squares in a square | 0.36308110 | crossing | 2.506328 | -1.9140 | -2.2510 | 6+2 C1 → 6+2 C2 | b8 up to 0.3705 (fold); b10 down to -0.0253 (fold) | 5/5 |
| 9 squares in a square | 0.00000000 | contact | 3.000000 | -3.0004 | -0.0002 | branch 0: contacts +[none] -[p:0-2, p:0-4, p:0-5, p:0-7, p:1-3, p:1-8, p:3-6, p:6-8, w:1:2 |  |  |
| 9 squares in a square | 0.00000002 | crossing | 3.000000 | -3.0006 | -0.0004 | 4+4+1 D4 → 4+4+1 C4 | b0 up to 0.4052 (fold); b68 down to -0.3776 (cap) | 5/5 |
| 9 squares in a square | 0.00050563 | stability | 3.000000 | – | – | branch 0 (D4) loses stability as K increases (perturb-and-polish probe) |  |  |
| 9 squares in a square | 0.02160653 | crossing | 2.999152 | 0.1846 | -0.0858 | 4+4+1 C1 → 4+4+1 C4 | b68 up to 0.4052 (hemisphere); b0 down to -0.3776 (cap) | 6/6 |
| 9 squares in a square | 0.03125006 | stability | 2.998080 | – | – | branch 0 (C4) gains stability as K increases (perturb-and-polish probe) |  |  |
| 9 squares in a square | 0.20562501 | crossing | 2.891624 | -1.2109 | -1.3334 | 4+4+1 C4 → 7+1+1 C1 | b0 up to 0.4052 (fold); b111 down to 0.1388 (fold) | 6/6 |
| 9 squares in a square | 0.22485311 | crossing | 2.864306 | -1.5082 | -1.5688 | 5+2+1+1 C1 → 5+2+2 C1 | b111 up to 0.2579 (fold); b71 down to 0.1306 (infeasible) | 6/6 |
| 9 squares in a square | 0.25752509 | crossing | 2.807798 | -1.8856 | -2.8491 | 5+2+2 C1 → 7+2 C1 | b71 up to 0.2946 (fold); b5 down to 0.1061 (fold) | 6/6 |
| 9 squares in a square | 0.34374994 | stability | 2.581259 | – | – | branch 135 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 9 squares in a square | 0.35460772 | crossing | 2.556358 | -2.2570 | -2.4964 | 7+2 C1 → 7+2 C1 | b135 up to 0.4552 (fold); b61 down to 0.2582 (fold) | 6/6 |
| 9 squares in a square | 0.38171720 | crossing | 2.495204 | -2.1739 | -2.2488 | 7+2 C1 → 7+2 C1 | b61 up to 0.4649 (fold); b23 down to 0.2582 (fold) | 6/6 |
| 9 squares in a square | 0.39843750 | crossing | 2.458354 | -2.2137 | -2.3859 | 7+2 C1 → 6+3 C1 | b23 up to 0.4619 (fold); b95 down to 0.0694 (fold) | 6/6 |
| 5 triangles in a pentagon | 1.22577826 | contact | 1.000000 | -0.1723 | -0.0000 | branch 0: contacts +[w:0:1, w:1:2, w:2:3, w:3:4, w:4:0] -[none]; symmetry C5 -> D5; kink ( |  |  |
| 5 triangles in a pentagon | 1.50491634 | crossing | 1.000000 | 0.0000 | -0.0890 | 5 D5 → 5 D1 | b0 up to 1.5245 (fold); b4 down to 1.4796 (fold) | 6/6 |
| 6 triangles in a hexagon | -0.03125006 | stability | 1.005229 | – | – | branch 0 (C6) loses stability as K increases (perturb-and-polish probe) |  |  |
| 6 triangles in a hexagon | -0.00775629 | stability | 1.001294 | – | – | branch 0 (D6) gains stability as K increases (perturb-and-polish probe) |  |  |
| 6 triangles in a hexagon | -0.00000001 | contact | 1.000000 | -0.1667 | -0.0000 | branch 13: contacts +[p:0-3, p:0-4, p:0-5, p:1-2, p:1-3, p:1-5, p:2-4, p:2-5, p:3-4, w:0:4 |  |  |
| 6 triangles in a hexagon | 0.89880212 | crossing | 1.000000 | 0.0000 | -0.1050 | 6 D6 → 6 C3 | b0 up to 0.9758 (fold); b1 down to 0.8073 (fold) | 6/6 |
| 6 triangles in a hexagon | 1.10392308 | crossing | 0.968212 | -0.2087 | -0.2768 | 6 C3 → 5+1 C1 | b1 up to 1.3589 (hemisphere); b2 down to -1.5000 (range) | 6/6 |
| 6 triangles in a hexagon | 1.26127482 | crossing | 0.924132 | -0.2837 | -0.2894 | 5+1 C1 → 5+1 D1 | b2 up to 1.4634 (hemisphere); b3 down to 1.0469 (fold) | 6/6 |
| 7 triangles in a heptagon | -1.18945218 | kink | 1.000026 | -0.1708 | -0.0134 | branch 0 (shells 7, C7, 14 contacts): slope jumps from -0.1708 to -0.0134 with no change o |  |  |
| 7 triangles in a heptagon | 0.39352675 | crossing | 1.000000 | 0.0000 | -0.1862 | 7 D7 → 6+1 C1 | b0 up to 0.6359 (fold); b1 down to 0.3903 (fold) | 6/6 |
| 7 triangles in a heptagon | 0.50390619 | stability | 0.978658 | – | – | branch 6 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 7 triangles in a heptagon | 0.73124128 | crossing | 0.934726 | -0.1931 | -0.2686 | 6+1 C1 → 6+1 C1 | b10 up to 0.7637 (fold); b2 down to 0.4301 (fold) | 6/6 |
| 8 triangles in an octagon | -2.40625006 | stability | 1.012575 | – | – | branch 0 (C8) loses stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in an octagon | -2.34148210 | stability | 1.000879 | – | – | branch 0 (D8) gains stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in an octagon | -2.33654785 | contact | 1.000003 | -0.1773 | -0.0333 | branch 46: contacts +[w:0:1, w:0:7, w:1:4, w:1:6, w:2:2, w:2:4, w:3:0, w:3:2, w:4:1, w:4:3 |  |  |
| 8 triangles in an octagon | -0.16867917 | crossing | 1.000000 | -0.0000 | -0.1367 | 8 D8 → 7+1 C1 | b0 up to 0.4118 (fold); b1 down to -3.0000 (range) | 6/6 |
| 8 triangles in an octagon | -0.12890631 | stability | 0.995843 | – | – | branch 1 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in an octagon | -0.08398432 | stability | 0.993305 | – | – | branch 1 (C1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in an octagon | -0.04687506 | stability | 0.990992 | – | – | branch 1 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in an octagon | -0.03027338 | stability | 0.989891 | – | – | branch 1 (C1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in an octagon | 0.02539057 | stability | 0.985889 | – | – | branch 1 (C1) loses stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in an octagon | 0.05977627 | crossing | 0.983169 | -0.0819 | -0.2145 | 7+1 C1 → 7+1 C1 | b1 up to 0.5000 (range); b20 down to -0.3541 (fold) | 6/6 |
| 8 triangles in an octagon | 0.06250006 | stability | 0.982945 | – | – | branch 1 (C1) gains stability as K increases (perturb-and-polish probe) |  |  |
| 8 triangles in an octagon | 0.30224131 | crossing | 0.935655 | -0.2081 | -0.2332 | 7+1 C1 → 7+1 C1 | b26 up to 0.5000 (range); b40 down to 0.2656 (fold) | 6/6 |
| 8 triangles in an octagon | 0.39688132 | crossing | 0.914262 | -0.1952 | -0.2059 | 7+1 C1 → 7+1 C1 | b27 up to 0.5000 (range); b2 down to 0.1281 (fold) | 6/6 |

#### One-sided slopes of s*(K) at K = 0 (lowest branch on each side; finite differences ±1e-4, in brackets ±2e-3)

| problem | Euclidean record | s*(0) found | slope of s* for K → 0⁻ | slope for K → 0⁺ | kink | same configuration on both sides? | contacts at 0 |
|---|---|---|---|---|---|---|---|
| 2 disks in a disk | 2.000000 | 2.000000 | 0.0000 (0.0000) | 0.0000 (0.0000) | +0.0000 | yes | 3 |
| 3 disks in a disk | 2.154701 | 2.154701 | 0.0641 (0.0641) | 0.0642 (0.0642) | +0.0000 | yes | 6 |
| 4 disks in a disk | 2.414214 | 2.414214 | 0.2357 (0.2353) | 0.2357 (0.2361) | +0.0000 | yes | 8 |
| 5 disks in a disk | 2.701302 | 2.701302 | 0.5371 (0.5358) | 0.5372 (0.5385) | +0.0001 | yes | 10 |
| 6 disks in a disk | 3.000000 | 3.000000 | 0.9998 (0.9965) | 0.0000 (0.0000) | -0.9998 | no (crossing at 0) | 12 |
| 7 disks in a disk | 3.000000 | 3.000000 | 0.0000 (0.0000) | 1.0002 (1.0035) | +1.0002 | yes | 18 |
| 8 disks in a disk | 3.304765 | 3.304765 | 1.6559 (1.6486) | 1.6567 (1.6641) | +0.0008 | yes | 14 |
| 9 disks in a disk | 3.613126 | 3.613126 | 2.5376 (2.5232) | 2.5392 (2.5539) | +0.0015 | yes | 16 |
| 10 disks in a disk | 3.813026 | 3.813026 | 1.1682 (1.1708) | 1.1679 (1.1653) | -0.0003 | yes | 20 |
| 11 disks in a disk | 3.923804 | 3.923804 | 0.7733 (0.7783) | 2.1324 (2.1306) | +1.3591 | no (crossing at 0) | 23 |
| 12 disks in a disk | 4.029602 | 4.029602 | 0.7107 (0.7108) | 0.7107 (0.7106) | -0.0000 | yes | 24 |
| 2 triangles in a triangle | 2.000000 | 2.000000 | -0.5000 (-0.5007) | -0.2812 (-0.2812) | +0.2188 | yes | 5 |
| 3 triangles in a triangle | 2.000000 | 2.000000 | -0.7500 (-0.7510) | -0.2500 (-0.2501) | +0.5000 | no (crossing at 0) | 10 |
| 4 triangles in a triangle | 2.000000 | 2.000000 | -0.7500 (-0.7510) | -0.0000 (-0.0001) | +0.7500 | yes | 15 |
| 5 triangles in a triangle | 2.732057 | 2.732051 | -1.4332 (-1.4358) | -0.8943 (-0.8944) | +0.5388 | yes (relabelled copy) | 9 |
| 6 triangles in a triangle | 2.977000 | 2.977082 | -1.9042 (-1.9081) | -1.6550 (-1.6540) | +0.2492 | yes (relabelled copy) | 13 |
| 8 triangles in a triangle | 3.000000 | 3.000000 | -2.3336 (-2.3392) | -0.7083 (-0.7085) | +1.6253 | no (crossing at 0) | 31 |
| 9 triangles in a triangle | 3.000000 | 3.000000 | -2.5004 (-2.5071) | -0.6250 (-0.5804) | +1.8753 | yes | 39 |
| 2 squares in a square | 2.000000 | 2.000000 | -0.7500 (-0.7508) | -0.9999 (-0.9971) | -0.2498 | no (crossing at 0) | 3 |
| 3 squares in a square | 2.000000 | 2.000000 | -1.0001 (-1.0011) | -0.0001 (-0.0034) | +0.9999 | yes (relabelled copy) | 8 |
| 4 squares in a square | 2.000000 | 2.000000 | -1.0001 (-1.0015) | -0.0000 (-0.0003) | +1.0001 | yes | 14 |
| 5 squares in a square | 2.707107 | 2.707107 | -2.2372 (-2.2409) | -0.6550 (-0.6562) | +1.5822 | no (crossing at 0) | 12 |
| 6 squares in a square | 3.000000 | 3.000000 | -3.1255 (-2.7555) | -2.9994 (-2.9871) | +0.1261 | no (crossing at 0) | 10 |
| 7 squares in a square | 3.000000 | 3.000000 | -3.0003 (-3.0059) | -2.2497 (-2.2447) | +0.7506 | no (crossing at 0) | 17 |
| 8 squares in a square | 3.000000 | 3.000000 | -3.0005 (-3.0090) | -0.0011 (-0.0230) | +2.9993 | no (crossing at 0) | 24 |
| 5 triangles in a pentagon | 1.240076 | 1.240076 | -0.2286 (-0.2286) | -0.2286 (-0.2285) | +0.0000 | yes | 15 |
| 6 triangles in a hexagon | 1.000000 | 1.000000 | -0.1667 (-0.1667) | -0.0000 (-0.0000) | +0.1667 | yes (relabelled copy) | 33 |
| 7 triangles in a heptagon | – | 1.000000 | -0.0000 (-0.0000) | -0.0000 (0.0000) | +0.0000 | yes | 28 |
| 8 triangles in an octagon | 0.987770 | 0.987775 | -0.0722 (-0.0721) | -0.0723 (-0.0724) | -0.0000 | yes | 24 |

#### Asymptote at the negative end (polygon containers): s ≈ −α ln(K − K∞) + β

| problem | last K reached | s there | K∞ (fit) | K∞ = −a*² (kPolish) | α (fit) | 1/√−K∞ | rms |
|---|---|---|---|---|---|---|---|
| 2 triangles in a triangle | -1.126303 | 13.999 | -1.1263047 | -1.1263048 | 0.9394 | 0.9423 | 0.0056 |
| 3 triangles in a triangle | -0.956358 | 13.999 | -0.9563621 | -0.9563622 | 1.0169 | 1.0226 | 0.0055 |
| 4 triangles in a triangle | -0.956358 | 13.999 | -0.9563621 | -0.9563622 | 1.0169 | 1.0226 | 0.0055 |
| 5 triangles in a triangle | -0.606158 | 14.000 | -0.6062054 | -0.6062089 | 1.2522 | 1.2844 | 0.0196 |
| 6 triangles in a triangle | -0.521256 | 14.000 | -0.5213472 | -0.5213565 | 1.3353 | 1.3850 | 0.0215 |
| 8 triangles in a triangle | -0.452432 | 14.000 | -0.4525697 | -0.4525885 | 1.4189 | 1.4865 | 0.0275 |
| 9 triangles in a triangle | -0.446688 | 14.000 | -0.4468338 | -0.4468488 | 1.4344 | 1.4960 | 0.0248 |
| 2 squares in a square | -0.964717 | 13.999 | -0.9647207 | -0.9647208 | 1.0105 | 1.0181 | 0.0083 |
| 3 squares in a square | -0.855259 | 13.999 | -0.8552663 | -0.8552666 | 1.0717 | 1.0813 | 0.0082 |
| 4 squares in a square | -0.847534 | 13.999 | -0.8475419 | -0.8475421 | 1.0789 | 1.0862 | 0.0060 |
| 5 squares in a square | -0.546249 | 14.000 | -0.5463286 | -0.5463365 | 1.3098 | 1.3529 | 0.0207 |
| 6 squares in a square | -0.457431 | 14.000 | -0.4575891 | -0.4576054 | 1.4194 | 1.4783 | 0.0217 |
| 7 squares in a square | -0.440694 | 14.000 | -0.4408742 | -0.4408933 | 1.4437 | 1.5061 | 0.0193 |
| 8 squares in a square | -0.434390 | 14.000 | -0.4345738 | -0.4345947 | 1.4514 | 1.5169 | 0.0246 |
| 9 squares in a square | -0.377643 | 14.000 | -0.3778620 | -0.3778870 | 1.5470 | 1.6268 | 0.0225 |

## 7. Files, commands and checks

**Code**
- `packages/curved/src/sweep.ts`: `followBranch` (adaptive continuation with fold detection), `symmetryLabel`, `familyLabel`, `contactKeys`, `densityOf`, `poseDistance`, `bisectChange`, `rootBisect`, `sameConfig`, `pieceExistsStrict`. No change to the existing engine files.
- `packages/curved/scripts/sweep/run-sweep.ts`: seeds, branches, refinement, preliminary events (`--resume` reuses a run; for the rerun also `--solveOnResume`, `--seedOffset`, `--hopEvery`, `--hopHops`, `--maxBranches`, `--refineEvery`, `--refineTrials`, `--refineSigmas`).
- `packages/curved/scripts/sweep/analyze.ts`: the authoritative event analysis and certification prep.
- `packages/curved/scripts/sweep/build-sweep-viz.ts`: builds the viewer. `shoot.mjs` and `debug-probe.ts` are development helpers (headless screenshots; stability probe check). `timing.ts` is the timing probe used to plan the budget.
- `packages/curved/viz/sweep-template.html`, `sweep-about.html`, generated `sweep.html` (standalone, data embedded, 6.4 MB).
- `python/curved/sweep_certify.py` runs `certify.py` (`certify_configuration`) on a sweep's prepared configurations. `sweep_curate.py` writes `data/curved/sweep/`. `sweep_report.py` prints the tables in §6.
- `packages/curved/test/sweep.test.ts`: 6 tests (labels, symmetry, existence, the 3-ring closed form and hemisphere end, the 7-disk crossing against the closed form to 10⁻⁷).

**Data** (`data/curved/sweep/`)
- `sweep_N_M_P.json`, one per problem: the lowest branch on the grid (with certification flags), the branch curves (K, s, density, envelope ds/dK, symmetry, shells, contacts, rattlers), events, K = 0 slopes, asymptote fit, stability probe, and the list of certified points.
- `records.json`: all 1711 certified configurations, in the format of `data/curved/records.json`. `id` = `curved/K/N/M/P#b<branch>`, `K` an exact binary64 value, `K_exact` its exact rational, `config` the certified configuration at `score_cert`, `display` = score_cert rounded to the nearest at 6 decimals (ties to even, from its exact binary64 value; score_cert itself is the certified upper bound), plus the certifier's witnesses. It can be re-checked on its own.
- `summary.json`: headline events per problem.

**Pipeline** (raw runs and logs are kept outside the repository; first run about 1.5 h on two processes at nice 10 on a heavily loaded machine, load average 35–50; rerun about 2 h at load average about 12)
```
npx tsx packages/curved/scripts/sweep/run-sweep.ts --N 0 --M 0 --P 7 --Kmin -2 --Kmax 0.65 --seeds 3 --hops 12 --solveStep 0.25 --out RUN.json
npx tsx packages/curved/scripts/sweep/analyze.ts RUN.json ANA.json
python3 python/curved/sweep_certify.py ANA.json
python3 python/curved/sweep_curate.py --runs RUNS --ana ANAS --out data/curved/sweep --viewer VIEWER.json --about packages/curved/viz/sweep-about.html
npx tsx packages/curved/scripts/sweep/build-sweep-viz.ts VIEWER.json packages/curved/viz/sweep.html
python3 python/curved/sweep_report.py data/curved/sweep
```
Rerun of an existing problem (§3a), for example 9 squares:
```
npx tsx packages/curved/scripts/sweep/run-sweep.ts --N 4 --M 4 --P 9 --Kmin -1 --Kmax 1.6 --resume OLD_RUN.json --solveOnResume 1 --seedOffset 1 --seeds 4 --hops 20 --solveStep 0.125 --hopEvery 2 --hopHops 20 --maxBranches 140 --refine 4 --refineEvery 1 --refineTrials 3 --refineSigmas 0.001,0.01,0.03,0.08,0.15 --out RUN.json
```
Ranges used: disks [−2, 0.65]; triangles in a triangle [−1.2, 3]; squares [−1, 1.6]; 5 triangles in a pentagon [−1, 2.5]; 6 in a hexagon [−1.5, 1.5]; 7 in a heptagon [−2, 1]; 8 in an octagon [−3, 0.5]. All stay below √K = 2π/N, the existence limit of the unit polygon, and every container stays in the open hemisphere (K s² < (2π/M)²).

**Checks run** (2026-10-24, after the rerun)
```
npx tsc -p packages/curved --noEmit                                  -> no errors
npx vitest run packages/curved                                       -> 28 passed (3 files)
python3 python/curved/test_certify.py                                -> 17 tests OK
python3 python/curved/certify.py data/curved/sweep/records.json      -> 1711/1711 records certified
python3 python/curved/certify.py data/curved/records.json            -> 299/299 records certified
```
Certification margins: score_cert − score_float is at most 2.7·10⁻¹⁰ relative, with median 2.7·10⁻¹¹.
