# The dimensions on the board

Labels: **[EST]** established with a source, **[CALC]** measured or computed here, **[SPEC]** a design idea not yet built.

The site files every kind of problem under a **dimension**: the pieces' dimension, "in" or "on", and the container's dimension. "In" means inside a container; "on" means on a closed surface or boundary, with no container. The API calls the kinds beyond Flat **spaces** (`/api/spaces`), and the code keeps that name.

| Dimension | Kind | Space (API and address) | On the board |
|---|---|---|---|
| 2D in 2D | Flat | none: the classic polygon board | yes |
| 2D in 2D | Curved | `curved` | yes |
| 2D on 3D | Polyhedral surfaces | `surface` | yes |
| 2D on 3D | Sphere | `sphere` | yes |
| 2D on 3D | Torus | `torus` | yes |
| 3D in 3D | Polyhedra | `polyhedra` | yes |
| 3D on 4D | Polytope boundaries (the tesseract first) | `boundary` | yes |

A flat torus is filed under 2D on 3D because a torus is pictured as a surface in 3D, although it cannot be embedded there both flat and smooth ([TORUS.md](TORUS.md)).

The board's Problem section has two menus. **Dimension** lists every dimension; one with no kind available yet is listed but disabled, as "coming soon". **Kind** lists the kinds of the chosen dimension. Flat is the board as it always was. Choosing another kind shows a problem of its catalogue in place of the polygon board. Choosing Flat again shows the polygon board as it was left: its parts were only hidden. Choosing a dimension shows the kind last shown in it, or its first kind.

## What it offers

| Kind | See | Optimise | Submit | Move pieces by hand |
|---|---|---|---|---|
| Polyhedral surfaces, fold | the solid, which turns, or its net | fold search | yes | no |
| Polyhedral surfaces, nofold | the same | Platonic solids: basin hopping on the fullest face, copied onto every face; the other solids: the surface search with every piece kept in its face | yes | no |
| Curved | Poincaré or Klein disk (K < 0), globe or gnomonic chart (K > 0), plane (K near 0) | curved search | yes | no |
| Sphere | a globe that turns, or both hemispheres | sphere basin hopping | yes | no |
| Torus | the tiled plane, or one cell with its glued sides | torus basin hopping | yes | no |
| Polytope boundaries (3D on 4D) | the eight cells side by side, the net with a Fold slider that folds it into the fourth dimension, or slices across one axis (three.js) | boundary compression search | yes | no |
| Polyhedra | the solids in their container in 3D, solid or see-through, which turns | polyhedra soft-to-rigid search | yes | no |

- **The problem.** One field per part of the id (solid, folding, piece, P; curvature, piece, container, P; piece, P; torus, piece, P; polytope, piece, P; for polyhedra the problem, such as "Cubes in a cube", and P from 2 to 100). Each field offers only values that occur in the catalogue (`GET /api/spaces/<space>/records`) with the fields before it.
- **The address.** `/#space=<problem id>`, such as `/#space=sphere/4/12` or `/#space=curved/-1/3/4/5`, opens a problem; `/#space=torus` opens a kind at its starting problem (an open one with room above its lower bound). The address keeps the API's name, so that older links still work, and choosing a kind writes the same address as the former Space menu did. Each row of the dimensions page links to it ("Open on the board").
- **The values.** The packing shown is the better of the research record and the site's best entry (the record on a tie), from `GET /api/spaces/<space>/problems/<id>`. Beside it: its size, the certified value, the status, the lower bound, the site best and whether the problem takes entries, in the dimensions page's words. 3D on 4D adds two rows from the listing's `extra`: **Without folding**, the best edge when every piece stays inside one cell (with how it is derived, under "Why"), and **Folding gains**, 1 − best / without folding, the problem's best edge against it, to one decimal of a percent. The gain follows the problem's best, so a site entry that beats the research record raises it; for the record itself it is the server's `fold_gain` to within 1e-12.
- **Closed problems.** A proven problem is shown and can be optimised, but its entries are closed. A problem where no packing exists has nothing to show or run.
- **Loading.** While the space's code, its problems or a problem are read, the drawing area says so and Run and Submit wait. When a read fails, nothing of the earlier problem stays live: the drawing and the values are cleared, and a Try again button reads it again. The address keeps the problem that was asked for (a link such as `#space=torus/hex/5/8` stays as it is), so a reload asks for it again.
- **Going back.** Any address that names no space problem (a polygon link, or none, as after Back) shows the polygon board, and both menus say Flat (2D in 2D).
- **The polygon board's own run.** A run of the polygon optimizer is paused while another kind is shown, so that two searches do not compete for the processor unseen; the panel says so, and the run goes on when Flat is chosen again. A run the user paused stays paused.
- **The layout.** The board's `<main>` carries `data-dimension` (for example `2-on-3`) and, while a kind other than Flat is shown, `data-space`. The CSS hides the polygon board's parts while `data-space` is set. A dimension's mode can use `data-dimension` to adapt the layout and the optimizer panel. 3D on 4D does: on a narrow screen (820 px or less, where the stage stacks above the panel at 62% of the screen's height) the stage takes the height it needs, and the 3D drawing is a square as wide as the screen (at most three quarters of its height) under its own controls, so that it can be turned and read; on a wide screen the drawing fills the stage beside the panel, as the other kinds do.
- **3D on 4D.** The drawing is the three.js view of `packages/view3d` (`createBoundaryView`), wrapped in the board's drawing interface by `src/space/render/boundary.ts`. Its toolbar (Cells, Net, Slice, Reset view), the Fold slider and its Fold up button, the slice's axis, position and strip of nine, a legend of the cells' colours and a status line that names a piece pointed at all sit in the stage. three.js is loaded with a dynamic import when the first 3D on 4D problem is drawn, not with the space mode, so the other kinds never load it; until it arrives the stage says so, and a failed load offers Try again. One view serves every P of a piece: choosing another P keeps the camera, the fold and the slice; another piece opens a new view in the view last used. Without WebGL the stage says, in a sentence, that the drawing needs it; the values, the optimizer and Submit still work. The keys: arrows turn (Shift for larger steps), + and − zoom, Page Up and Page Down follow one piece, Escape lets it go, Home resets.
- **3D in 3D.** See [3D in 3D](#3d-in-3d) below.
- **Torus.** The drawing reduces the lattice's basis first (Lagrange-Gauss), so that a basis written skewed, such as b2 + 320 b1, draws as fast as any; at most 6,000 shapes are drawn, over at most 100,000 cells. A lattice whose shortest vector is below a twentieth of the piece's circumradius (no packing has one), or that would need more cells, is not drawn, and the drawing says why. A configuration whose free basis is degenerate (det(b1, b2) = 0) or not finite is not read; a left-handed one (det < 0) is, since the torus search itself often returns one. The server stores a kept free-lattice entry with its basis reduced and det > 0 (the same lattice and score, the poses as sent), so every reader gets a basis it can draw.

## How a run works

A run is a sequence of **rounds**. Each round is one job of the space's search, the same job the volunteer client runs (`runSpaceJob`), started from the best packing so far with the seed `mixSeed(seed, round)`. It runs in a Web Worker.

- **Budget.** Evaluations in the search's own unit, and optionally a time limit. A round from a packing has 10,000 evaluations (sphere, torus), 9 starts and hops (curved), 4 compressions (surface fold; 2 from 40 pieces), 5,000 solver evaluations (nofold) or 300,000 energy evaluations (3D on 4D, `BOUNDARY_ROUND_EVALS` of the job runner, with or without a start; a check of a whole packing counts as 500), and at most what is left of the budget and of the time. The panel takes at most 1,000,000 evaluations, or 100,000,000 for 3D on 4D, whose evaluations are cheap; it starts 3D on 4D problems at 3,000,000 and 30 s. A round that does not improve on its start doubles the next one, up to 4 times the usual size (2 times for fold surfaces, 3 times for 3D on 4D); an improvement brings the size back. A fold round's compressions include its start's (or its two random starts'), so no round uses more than it is given, and the run never more than its budget. Polyhedra rounds grow with P and the solid (below), and the panel takes at most 10,000,000 of their evaluations. [CALC] On an Apple Silicon laptop a round of 10,000 took 2 to 3 s on sphere and torus problems of 30 pieces, a curved round 1 to 1.7 s, and a fold round 1 to 8 s at 12 to 14 pieces; 4 compressions of 80 pieces took 141 s. A 3D on 4D round of 300,000 took 1.5 to 2.2 s at 16 pieces, and from nothing 1.0 to 2.5 s at 4 to 16 pieces (in Node), finding a valid packing each time.
- **Rounds long enough to leave a basin.** A sphere or torus job first relaxes its start and finds its tight size, and only then hops between basins. [CALC] From a tight packing (the best of a new arrangement with seed 4), ten rounds of 2,000 evaluations never improved it: sphere/4/30 stayed at 1.819980 and torus/free/4/12 at 3.905795. Two rounds of 10,000 (the default budget) reached 1.737518 to 1.774667 and 3.464102 to 3.793237 over seeds 9 to 11. A test checks a gain of more than 2% on both with seed 9.
- **New arrangement.** A round with no start has to build a packing from nothing first, so it gets more: 10,000 evaluations on sphere and torus problems, doubled after each such round that finds nothing. [CALC] With 10,000, all 5 seeds found a valid packing on sphere/0/12, sphere/4/30, torus/sq/5/7 and torus/free/4/12; with 2,000 none of 12 tries did, and with 5,000 a third failed. A test runs two seeds on each.
- **Large fold surfaces.** The starting budget is 60 s and 480 / P evaluations (8 to 40), and the panel says that such rounds are slow. While a round runs for more than 2 s, the progress line counts its seconds.
- **Reproducible.** With Evaluations only, a round ends on its evaluations, so the same start, seed and budget give the same result. A test checks this (`apps/web/test/space-search.test.ts`). One exception: the curved search also stops each of its calls after 5 s, so a curved round slower than that is not reproducible.
- **Pause and stop.** The searches are synchronous, so they cannot read the page's messages. Stop ends the worker at once and keeps the best of the finished rounds. Pause ends the worker at once too; Resume starts a new one and runs the interrupted round again from its start, with the same job. A paused run on Evaluations only therefore ends with the same result as one that was never paused, and pause and stop answer at once. pause() and resume() may follow each other in either order within one tick: no round is lost or counted as failed, and none starts while the run is paused. [CALC] Both took about 30 ms on a torus problem in a browser test.
- **Live view.** The drawing shows the best packing after each round that improves it.
- **Validity.** Each round checks its result with the server's rule (`validateSpaceSubmission`, with the problem's lower bound and certified value) in the worker, and the page checks the final result again before it offers it. Submit is offered only for a result that passes and beats the problem's best by more than a relative 1e-9 (for polyhedra, and the research record by more than a relative 1e-6, the server's margin above the records' clearance). The server checks it once more and decides.
- **The result.** A run's result is its best packing, with the seed and the start of that run. A run that ends without one clears the earlier result, unless it started from that result: then the earlier result stays, with its own seed and start. The drawing, the values and Submit always show the same packing.
- **Submit.** `POST /api/spaces/submit` with the board's Name and Note fields, the seed of the run that found the result, and the method with where that run started, for example "sphere basin hopping (board, from the research record)". The board says what the server answered: kept, valid but not kept, closed (409), not accepted (400, 422), or too many submissions (429, 503). An answer that arrives after another problem was chosen is shown under the problem's id.

## 3D in 3D

- **Drawing** (`apps/web/src/space/render/polyhedra.ts`). three.js 0.186.1 (MIT, see `THIRD_PARTY_NOTICES.md`) with a depth buffer, so a nearer solid always covers a farther one, however tightly the solids are packed (a canvas drawing that orders whole pieces by their centres' depth cannot promise that). The pieces are one instanced mesh (one geometry, a matrix and a colour per piece) and their edges one set of line segments, so 100 pieces of the largest solids are two draw calls; the container is drawn as its edges over faint see-through faces. Views: Solid, and See-through (the pieces at 40 % opacity, to see the inner ones). Drag or the arrow keys turn it; it is drawn only when something changes. Colours come from the page's tokens and follow the light and dark schemes. three.js (747 kB, 190 kB compressed) is a chunk of its own, shared with 3D on 4D and loaded with a dynamic import when the first 3D drawing is made, so only these two kinds load it. Without WebGL the drawing says so in a sentence, and the values, the search and Submit still work.
- **Released on leaving.** While the board shows another kind, the 3D drawing is destroyed and gives back its WebGL context and buffers; choosing 3D in 3D again makes it anew, showing the same packing. (The 2D kinds keep their drawings, which hold no GPU resources; 3D on 4D keeps its view, with the user's camera, fold and slice.)
- **Frame time** [CALC]. One frame of 100 truncated icosidodecahedra (120 vertices each) or 100 pentagonal hexecontahedra in a 940 x 598 px drawing, read back to wait for the GPU: about 1 ms in Chromium on an Apple M1 Pro (Metal), 28 to 37 ms with the software renderer of a headless browser (SwiftShader).
- **Rounds.** The search polishes its start (in a run's first round; a later round starts from the best so far, which the search has polished, and takes it as it is), then hops from the best so far by soft hops of its simulator (3,800 + 120 P steps and a polish, shortened to 60 % of the evaluations left when fewer are left) and jiggles (a polish). [CALC] A simulator step took about P (3.3 + 0.14 f + 0.0021 v f) microseconds for a solid of v vertices and f faces, under Node on an idle Apple Silicon laptop: 0.6 ms at 100 cubes, 2.8 ms at 100 truncated icosidodecahedra, 3.6 ms at 100 disdyakis triacontahedra; a heavily loaded machine was 3.4 times slower. Rounds are sized for a machine 3.5 times slower than these costs, so that one takes at most about 20 s there: room for a polish of the start (300 + 15 P evaluations, at most 1,800), then 8 s of steps, at most two hops; a round that could make a soft hop longer than about 18 s is cut to one that cannot. So 16,800 evaluations at 11 cubes, 7,100 at 100 cubes, 2,600 at 100 truncated icosidodecahedra (jiggles, a second or two here). A round with no start runs the simulator's soft-to-rigid schedule first, on at most 40 % of a round that fits it in about 20 s there; at 100 large solids that is far too short, so start those from the record. A round that does not improve doubles the next one, up to twice its size. The sizes depend on the problem only, so a run on Evaluations only stays reproducible. The starting budget is ten rounds and time for five on the slow machine (60 to 300 s). Pause and stop end the worker at once whatever the round's size: a browser test stops a run of 100 truncated icosidodecahedra within a second.
- **Problems.** The picker lists the 114 problems in the order of polyhedrainpolyhedra.wiki, with PolyPack's 28 prism and antiprism problems (7, 9, 10 and 11 sides) among the wiki's prisms and antiprisms by their number of sides ("Heptagonal prisms in a cube" after "Hexagonal prisms in a cube"), then P from 2 to 100. The server reads a problem's configuration from its file when it is asked for (`docs/spaces/POLYHEDRA.md`, §2).

## The code

- `packages/spaces/src/search/` (`@polypack/spaces/search`): the space jobs, the check of their results, the nofold conversion and the volunteer client's job scheduler. It moved there from `apps/volunteer/src/spaces/`, which now re-exports it, so the client and the website run one implementation.
- `apps/web/src/space/`: the board's space mode. `model.ts` (pure: problem reader, rounds, answers), `pick.ts` (pure: the picker and the problem each kind opens with) and `facts.ts` (pure: the rows of values), both shared with the 3D on 4D viewer, `search.ts` (rounds, pause, stop), `worker.ts` and `nofold-round.ts` (the Web Worker), `view.ts` and `render/*.ts` (the drawings, ported from the standalone viewers; `render/torus-layout.ts` is the torus drawing's numbers, tested in Node; `render/boundary.ts` wraps the three.js views), `load.ts` (the API calls), `mode.ts` (the panel), `index.ts` (the interface below).
- `apps/web/src/boundary-model.ts`: the pure parts of the 3D on 4D pages: the nofold comparison and its gain, a boundary configuration and problem read from the server, the viewer's address.
- `apps/web/spaces/boundary.html` and `src/boundary-viewer.ts`: the 3D on 4D viewer at `/spaces/boundary.html`, a page of the site built by vite (the other viewers are copied from their packages by `scripts/space-viewers.ts`). See [BOUNDARY.md](BOUNDARY.md), "On the website".
- `storedSpaceConfig` in `packages/spaces/src/validate.ts`: the form in which the server stores a kept configuration (a free torus basis reduced).
- `apps/web/src/dimension-table.ts`: the table of dimensions and their kinds, read by the menus and by the dimensions page. Each kind names its board mode (`polygon` or a space) and an `available` flag. A kind can be made available only when its space is one the board can show (`BOARD_SPACES` in `space-address.ts`); the type checks this. So adding a kind is one line of the table, plus the mode's code: 3D in 3D (`render/polyhedra.ts` and the `polyhedra` cases of `model.ts`, `pick.ts` and `view.ts`) and 3D on 4D were added so.
- `apps/web/src/dimension-switch.ts` and `space-address.ts`: the Dimension and Kind menus, and the address. With the table they are the only space code in the default board; the rest loads with a dynamic import when a kind other than Flat is chosen, and three.js with another when 3D in 3D or 3D on 4D is. [CALC] Built with `vite build` on 2026-10-25, the default board's files grew by 1.0 kB (0.43 kB gzipped) with 3D on 4D: the table's words, the CSS of its layout and vite's import helper, now a file of its own. three.js is one chunk of 747 kB (190 kB gzipped) that 3D in 3D and 3D on 4D share, loaded only by those kinds; the 3D on 4D views add a chunk of 101 kB (33 kB gzipped) [CALC, `vite build` of the merged tree, 2026-10-25].
- `apps/web/dimensions.html` and `src/dimensions.ts`: the Dimensions page, grouped by dimension and then by kind, with the records of each space. The former `/spaces.html` sends old links on to it, with their query and hash.

## The interface

`apps/web/src/space/index.ts`, meant for any page of the site. Import it with `import()`: it holds the spaces' geometry and validators.

```ts
openSpaceProblem(id: string): Promise<SpaceProblemHandle | string>   // a handle, or why not
listSpaceProblems(space: SpaceName): Promise<SpaceProblemSummary[] | null>

interface SpaceProblemHandle {
  readonly problem: LoadedSpaceProblem;     // values, rule, best configuration and its source
  readonly method: string;                  // the search's name, as a submission names it
  render(host: HTMLElement): SpaceView;     // view.show(config | null), view.destroy(),
                                            // view.canShow?(problem): it can draw that problem too
  search(start: SpaceConfig | null, options: {
    seed: number;
    budget: { evals: number; time_s?: number };
    fresh: boolean;                          // true: the first round builds its own start
    onProgress?: (p: SpaceSearchProgress) => void;
    shouldStop?: () => boolean;
    now?: () => number;
  }): SpaceSearch;                           // pause(), resume(), stop(), state, done: Promise<SpaceSearchResult>
  validate(config: SpaceConfig): SpaceCheck; // the server's rule
  improves(score: number): boolean;          // would be kept: beats the problem's best by more than 1e-9 relative
                                             // (polyhedra: and the research record by more than 1e-6)
  submit(config: SpaceConfig, fields: { name: string; note?: string; method?: string; seed?: number; software?: string })
    : Promise<SubmitAnswer & { status: number | null }>;
}
```

`SpaceSearchProgress` has `state`, `rounds`, `evaluations`, `seconds`, `best` (config, score, round, seed) and `improved`. `SpaceSearchResult` adds `ended` ("evals", "time", "bound", "stopped" or "error"), `reasons` and `trace`.

## How Tighter could use it after a prestige reset [SPEC]

Nothing below is built. Tighter is unchanged.

1. **A new board after prestige.** After a reset the player could choose what to work on next: Flat polygons again, or another kind. The choice could be the board's Dimension and Kind menus, so that the same words appear in both places.
2. **Problems as levels.** Within a kind, a ladder of catalogue problems could replace Tighter's polygon queue, for example by P within one shape, from `listSpaceProblems(space)`. `openSpaceProblem(id)` gives the starting packing, the lower bound and the problem's best, which is what a level needs.
3. **The game's searches.** `search(start, { seed, budget, onProgress, shouldStop })` runs in its own worker. The game could own the budgets and seeds, and connect its pause on battery to `pause()` and `resume()`. A paused run loses no reproducibility.
4. **Points.** Progress could be scored by `improved` rounds and by the relative gap to the lower bound, `(score - bound) / score`, in place of Tighter's polygon scores. The gap is known for every catalogue problem.
5. **Sending a record.** A result that `improves()` could be sent with `submit()` under the player's name, as Tighter sends polygon records. The server stays the judge.
6. **Drawing.** `render(host)` gives the drawing with its own small toolbar; the game could hide the toolbar and draw only the packing.

Open questions: whether a kind counts as a new game or as an upgrade within one; how a level should be scored when its record is already at its lower bound (several are); and whether Tighter's offline play needs the catalogue shipped with the game rather than read from the server.

## Limitations

- Pieces cannot be moved by hand. That would need a drag that never overlaps, like the polygon board's, for each kind; it is not built, so the board shows and optimises only. In 3D on 4D a piece can be pointed at, tapped or picked with Page Up and Page Down to see where it lies, not moved.
- Pausing ends the round in flight: its work is done again on resume. A round of a fold surface with many pieces, or of 100 of the largest polyhedra, can take a minute or more, so a pause near its end loses most of it.
- A submission names where its run started, but the API has no field for the start itself; a result found from an earlier result is reproduced from the run JSON, which holds the start.
- The board does not follow other people's entries live in a kind other than Flat: it reads the problem again after each submission.
- One method per kind. The volunteer client runs the same jobs, with its own scheduler of starts and budgets.
