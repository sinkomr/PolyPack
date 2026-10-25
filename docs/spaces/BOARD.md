# The spaces on the board

Labels: **[EST]** established with a source, **[CALC]** measured or computed here, **[SPEC]** a design idea not yet built.

The board's Problem section has a **Space** menu: Polygon in polygon (the board as it always was), Platonic surfaces, Constant curvature, Whole sphere and Flat tori. Choosing a space shows a problem of its catalogue in place of the polygon board. Choosing Polygon in polygon again shows the polygon board as it was left: its parts were only hidden.

## What it offers

| Space | See | Optimise | Submit | Move pieces by hand |
|---|---|---|---|---|
| Platonic surfaces, fold | the solid, which turns, or its net | fold search | yes | no |
| Platonic surfaces, nofold | the same | basin hopping on the fullest face, copied onto every face | yes | no |
| Constant curvature | Poincaré or Klein disk (K < 0), globe or gnomonic chart (K > 0), plane (K near 0) | curved search | yes | no |
| Whole sphere | a globe that turns, or both hemispheres | sphere basin hopping | yes | no |
| Flat tori | the tiled plane, or one cell with its glued sides | torus basin hopping | yes | no |

- **The problem.** One field per part of the id (solid, folding, piece, P; curvature, piece, container, P; piece, P; torus, piece, P). Each field offers only values that occur in the catalogue (`GET /api/spaces/<space>/records`) with the fields before it.
- **The address.** `/#space=<problem id>`, such as `/#space=sphere/4/12` or `/#space=curved/-1/3/4/5`, opens a problem; `/#space=torus` opens a space at its starting problem (an open one with room above its lower bound). Each row of the spaces page links to it ("Open on the board").
- **The values.** The packing shown is the better of the research record and the site's best entry (the record on a tie), from `GET /api/spaces/<space>/problems/<id>`. Beside it: its size, the certified value, the status, the lower bound, the site best and whether the problem takes entries, in the spaces page's words.
- **Closed problems.** A proven problem is shown and can be optimised, but its entries are closed. A problem where no packing exists has nothing to show or run.

## How a run works

A run is a sequence of **rounds**. Each round is one job of the space's search, the same job the volunteer client runs (`runSpaceJob`), started from the best packing so far with the seed `mixSeed(seed, round)`. It runs in a Web Worker.

- **Budget.** Evaluations in the search's own unit, and optionally a time limit. A round has at most 2,000 evaluations (sphere, torus), 9 starts and hops (curved), 4 compressions (surface fold) or 5,000 solver evaluations (nofold), and at most the time left. [CALC] On an Apple Silicon laptop a round took 0.1 to 2 s on sphere and torus problems of 12 to 49 pieces, 1 to 1.7 s on curved problems and 1 to 8 s on fold surfaces of 12 to 14 pieces (much longer at 80).
- **Reproducible.** With Evaluations only, a round ends on its evaluations, so the same start, seed and budget give the same result. A test checks this (`apps/web/test/space-search.test.ts`). One exception: the curved search also stops each of its calls after 5 s, so a curved round slower than that is not reproducible.
- **Pause and stop.** The searches are synchronous, so they cannot read the page's messages. Stop ends the worker at once and keeps the best of the finished rounds. Pause ends the worker at once too; Resume starts a new one and runs the interrupted round again from its start, with the same job. A paused run on Evaluations only therefore ends with the same result as one that was never paused, and pause and stop answer at once. [CALC] Both took about 30 ms on a torus problem in a browser test.
- **Live view.** The drawing shows the best packing after each round that improves it.
- **Validity.** Each round checks its result with the server's rule (`validateSpaceSubmission`, with the problem's lower bound and certified value) in the worker, and the page checks the final result again before it offers it. Submit is offered only for a result that passes and beats the problem's best by more than a relative 1e-9. The server checks it once more and decides.
- **Submit.** `POST /api/spaces/submit` with the board's Name and Note fields, the method and the seed. The board says what the server answered: kept, valid but not kept, closed (409), not accepted (400, 422), or too many submissions (429, 503).

## The code

- `packages/spaces/src/search/` (`@polypack/spaces/search`): the space jobs, the check of their results, the nofold conversion and the volunteer client's job scheduler. It moved there from `apps/volunteer/src/spaces/`, which now re-exports it, so the client and the website run one implementation.
- `apps/web/src/space/`: the board's space mode. `model.ts` (pure: picker, problem reader, rounds, answers), `search.ts` (rounds, pause, stop), `worker.ts` and `nofold-round.ts` (the Web Worker), `view.ts` and `render/*.ts` (the drawings, ported from the standalone viewers), `load.ts` (the API calls), `mode.ts` (the panel), `index.ts` (the interface below).
- `apps/web/src/space-switch.ts` and `space-address.ts`: the Space menu and the address. They are the only space code in the default board; the rest loads with a dynamic import when a space is chosen.

## The interface

`apps/web/src/space/index.ts`, meant for any page of the site. Import it with `import()`: it holds the spaces' geometry and validators.

```ts
openSpaceProblem(id: string): Promise<SpaceProblemHandle | string>   // a handle, or why not
listSpaceProblems(space: SpaceName): Promise<SpaceProblemSummary[] | null>

interface SpaceProblemHandle {
  readonly problem: LoadedSpaceProblem;     // values, rule, best configuration and its source
  readonly method: string;                  // the search's name, as a submission names it
  render(host: HTMLElement): SpaceView;     // view.show(config | null), view.destroy()
  search(start: SpaceConfig | null, options: {
    seed: number;
    budget: { evals: number; time_s?: number };
    fresh: boolean;                          // true: the first round builds its own start
    onProgress?: (p: SpaceSearchProgress) => void;
    shouldStop?: () => boolean;
    now?: () => number;
  }): SpaceSearch;                           // pause(), resume(), stop(), state, done: Promise<SpaceSearchResult>
  validate(config: SpaceConfig): SpaceCheck; // the server's rule
  improves(score: number): boolean;          // beats the problem's best by more than 1e-9 relative
  submit(config: SpaceConfig, fields: { name: string; note?: string; method?: string; seed?: number; software?: string })
    : Promise<SubmitAnswer & { status: number | null }>;
}
```

`SpaceSearchProgress` has `state`, `rounds`, `evaluations`, `seconds`, `best` (config, score, round, seed) and `improved`. `SpaceSearchResult` adds `ended` ("evals", "time", "bound", "stopped" or "error"), `reasons` and `trace`.

## How Tighter could use it after a prestige reset [SPEC]

Nothing below is built. Tighter is unchanged.

1. **A new board after prestige.** After a reset the player could choose what to work on next: polygons again, or one of the four spaces. The choice could be a menu like the board's, so that the same words appear in both places.
2. **Problems as levels.** Within a space, a ladder of catalogue problems could replace Tighter's polygon queue, for example by P within one shape, from `listSpaceProblems(space)`. `openSpaceProblem(id)` gives the starting packing, the lower bound and the problem's best, which is what a level needs.
3. **The game's searches.** `search(start, { seed, budget, onProgress, shouldStop })` runs in its own worker. The game could own the budgets and seeds, and connect its pause on battery to `pause()` and `resume()`. A paused run loses no reproducibility.
4. **Points.** Progress could be scored by `improved` rounds and by the relative gap to the lower bound, `(score - bound) / score`, in place of Tighter's polygon scores. The gap is known for every catalogue problem.
5. **Sending a record.** A result that `improves()` could be sent with `submit()` under the player's name, as Tighter sends polygon records. The server stays the judge.
6. **Drawing.** `render(host)` gives the drawing with its own small toolbar; the game could hide the toolbar and draw only the packing.

Open questions: whether a space counts as a new game or as an upgrade within one; how a level should be scored when its record is already at its lower bound (several are); and whether Tighter's offline play needs the catalogue shipped with the game rather than read from the server.

## Limitations

- Pieces cannot be moved by hand. That would need a drag that never overlaps, like the polygon board's, for each space; it is not built, so the board shows and optimises only.
- Pausing ends the round in flight: its work is done again on resume. A round of a fold surface with many pieces can take a minute, so a pause near its end loses most of it.
- The board does not follow other people's entries live in a space: it reads the problem again after each submission.
- One method per space. The volunteer client runs the same jobs, with its own scheduler of starts and budgets.
