# PolyPack

Pack P congruent regular polygons or circles into the smallest regular polygon or circle, and compete for records.

- The board: drag and rotate pieces that can never overlap; the smallest enclosing container and its size are computed live.
- Records: published values with sources, and one live leader per problem: the earliest of the best entries. Problems with a proven optimum are closed to entries.
- API: everything is scriptable; see `/api` on the running site, `examples/submit.py` and, for running an optimizer and submitting its result, `examples/solve-and-submit.ts`. The server scores a packing at the container orientation it is sent (`container_phi`, 0 when missing) and does not search for a better one, so turn the container to its best orientation before submitting; the board, Tighter and the optimizers do so themselves.
- Automated search: seven optimizers, seed generators and a contact polish, in the browser or as a TypeScript library.
- Dimensions: each kind of problem is filed under a dimension, the pieces' dimension, "in" or "on", and the container's. The classic problems are Flat, in 2D in 2D. The others are Curved (2D in 2D at constant curvature); Polyhedral surfaces (Platonic and Catalan solids, prisms, antiprisms), Sphere and Torus (2D on 3D: on a closed surface, with no container); Polyhedra and Balls (3D in 3D: solids in a polyhedron; unit balls in a ball or a cube, Platonic solids in a ball); and Polytope boundaries (3D on 4D: unit balls and cubes on the boundary of a tesseract, a closed 3D space). The board's Problem set menu lists every kind, grouped by dimension; the board draws their problems, runs their searches in the browser and submits better packings, and `/dimensions.html` lists their records; see [docs/spaces/BOARD.md](docs/spaces/BOARD.md).
- Volunteer computing: a single-file program that searches in the background on spare cores and submits records under your name. Download it from `/volunteer.html` on the running site; see [docs/VOLUNTEER.md](docs/VOLUNTEER.md).
- Downloads: every current record with its coordinates, refreshed nightly, in the [records release](https://github.com/sinkomr/PolyPack/releases/tag/records); published values with their sources in `data/records.json`.

Problems are written (N, M, P): P pieces with N sides in a container with M sides, 0 meaning a circle. Polygon pieces have side 1 and circle pieces radius 1; the score is the container's side length, or its radius for a circle. The exact conventions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#conventions). Documentation labels claims **[EST]** (established, with a source), **[CALC]** (computed here) or **[SPEC]** (speculation).

## Run it locally

Needs Node 24 or newer.

```
npm install
npm run dev
```

Then open http://localhost:5173. The API server runs on port 8787 and stores its database in `polypack.sqlite`.

## Automated search on the board

Use **Solve automatically** in the right-hand panel. Choose a method, a starting arrangement, time/evaluation limits and a random seed, then click **Run optimizer**. A complete board is used by default; an empty or partial board starts a new arrangement. Contact polish requires a complete board.

Search runs in a Web Worker. The canvas shows a read-only preview; **Pause**, **Resume** and **Stop** control the job. **Accept result** loads its strict valid packing as one undoable change. **Back to board** restores your original view. Editing the board or changing the problem cancels an outstanding search and clears its preview.

**Method settings** use the registered schemas and defaults, with angles displayed in degrees. The optional adjacent-record JSON uses the stored radians convention. **Download run JSON** saves the starting configuration, supplied and resolved settings, seed, budget, result and trace; its result can also be imported onto the board. An accepted result can be edited, exported, shared and submitted through the existing authoritative server validation. A submission records how the board was found: by hand, with the PolyPack optimizer (an accepted result, unchanged; its method, resolved settings, seed and budget are sent with it) or with the optimizer and then edited. Undo and a reload return each board to how it was found. The board and the records show only that short label; the note field stays your own free text.

All seven completed optimizers (the seventh is soft-to-rigid hardening, after Yohei Nakajima; see [docs/methods/harden.md](docs/methods/harden.md)), lattice/symmetry seeds and float64 contact polish are available. From a script, `examples/solve-and-submit.ts` runs one method and can submit an improvement. For unattended searches over many problems, see [docs/AUTOMATION.md](docs/AUTOMATION.md). A full command-line interface, solver jobs over HTTP, population search and LLM-guided search are not built yet.

## Tests

```
npm test
npm run typecheck
npm run e2e
npm run test:python
```

`npm run e2e` needs a one-time `npx playwright install chromium`. `npm run test:python` checks the corpus against the independent Python reference and needs only Python 3's standard library.

After `npm run build`, test the production worker bundle with:

```sh
POLYPACK_E2E_PRODUCTION=1 npm run e2e -- e2e/solve.spec.ts e2e/mobile.spec.ts
```

## Layout

| Path | Contents |
|---|---|
| `packages/geometry` | Shared geometry: overlap tests, enclosing container, auto-orient, no-overlap moves, validation. Used by browser and server. |
| `packages/solver` | Search framework and methods (budgets, seeds, pause/stop, pipelines). See its [README](packages/solver/README.md). |
| `packages/spaces` | The kinds beyond Flat, which the API and the code call spaces: their problem ids, the server's check of a configuration, and (`src/search`) the searches the board and the volunteer client share. The geometry of each space is in `packages/surface`, `curved`, `sphere`, `torus`, `boundary`, `polyhedra` and `balls`. |
| `packages/balls` | 3D in 3D: unit balls in a ball or a cube, Platonic solids in a ball (problems, validator, search). See [docs/spaces/BALLS.md](docs/spaces/BALLS.md). |
| `packages/boundary`, `packages/view3d` | 3D on 4D: pieces on the boundary of a 4D polytope (its geometry, validator and search), and the 3D views of it. See [docs/spaces/BOUNDARY.md](docs/spaces/BOUNDARY.md). |
| `apps/web` | The website (Vite, TypeScript, Canvas). |
| `apps/server` | The API (Hono, SQLite). |
| `apps/volunteer` | The volunteer client. See [docs/VOLUNTEER.md](docs/VOLUNTEER.md). |
| `data/records.json` | Published records, generated by `scripts/`. See [docs/RECORDS.md](docs/RECORDS.md). |
| `examples/submit.py` | Submitting from Python. |
| `examples/solve-and-submit.ts` | Running a search method from Node and submitting an improvement. |
| `python/` | Independent geometry reference and optional 50-digit polish (mpmath). See its [README](python/README.md). |
| `scripts/` | Record importers, corpus export and measurement scripts. |
| `e2e/` | Playwright end-to-end tests. |
| `docs/ARCHITECTURE.md` | Stack, geometric conventions and design decisions. |
| `docs/SOLVER_FRAMEWORK.md` | Solver framework design and measurements. |
| `docs/DEPLOY_FLY.md`, `Dockerfile`, `fly.toml` | Running a public copy on Fly.io. |
| `docs/HOSTING.md`, `deploy/` | Running a public copy on an always-on Mac. |
| `docs/methods/` | One page per search method: algorithm, parameters, benchmarks, limitations. |

## Acknowledgements

With thanks to **Yohei Nakajima**, who originated soft-to-rigid hardening and published the method, paper, code, pre-registered experiments and replays openly under the MIT licence: [site](https://yoheinakajima.github.io/soft-to-rigid/), [repository](https://github.com/yoheinakajima/soft-to-rigid), [paper](https://github.com/yoheinakajima/soft-to-rigid/blob/main/paper/main.pdf). PolyPack's `harden` method is built on that work; [docs/methods/harden.md](docs/methods/harden.md) says what is his and what was adapted here.

## Licence

PolyPack's code is released under the [MIT licence](LICENSE). The published records in `data/` come from the compilations of Erich Friedman, David Ellsworth and Eckard Specht, from the online supplement of Berthold, Kamp, Mexi, Pokutta and Polik (2026) and from the people credited in each record; they remain their authors' work and are included with attribution, not relicensed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
