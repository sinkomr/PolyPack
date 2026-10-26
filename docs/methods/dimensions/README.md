# Search methods in every Dimension

The polygon solver's methods (`docs/methods/*.md`) work on flat polygons in a polygon. The other
Dimensions each had one built-in search. Now they share a set of generic methods, written once in
`packages/methods` against a **kernel**: what a method needs to know about a space. Each space
implements its kernel once, on top of its own energy and validator. Every method then runs in every
space whose kernel has the capabilities it needs. The built-in search of each space stays available
as **Auto** and stays the default.

## The kernel (`packages/methods/src/kernel.ts`)

- A state is each piece's variables in a local chart around an anchor the kernel keeps (`dim`
  numbers per piece), plus the size being minimised. The size is the problem's score itself.
  `rebase` folds the chart offsets into the anchors.
- Operations:
  - the penalty energy, a sum of squared hinge terms with its gradient, including d/dsize;
  - the energy of one piece;
  - a hard clearance test;
  - random poses and local moves;
  - changing the size while keeping the normalized arrangement;
  - the space's exact finishing (`finish`, which gives a valid configuration);
  - the server's rule (`validate`).
- Optional capabilities:
  - `shape`: soft pieces, from the inscribed disk or ball at t = 0 to the true shape at t = 1, for harden and morph;
  - `seeds`: structured starts;
  - `swap`: exchanging two pieces' orientations.
- `packages/methods/src/contract.ts` checks the rules. Every kernel's test calls `checkKernel` and expects no failures.
- The reference kernel, unit disks in a circle (`packages/methods/src/reference/disks.ts`), is the methods' test bed. It has known optima.

| Space | Factory | Package |
|---|---|---|
| curved (2D in 2D) | `curvedKernel({ K, N, M, P })` | `@polypack/curved` |
| surface (2D on 3D) | `surfaceKernel({ solid, N, P, mode })` | `@polypack/surface` |
| sphere (2D on 3D) | `sphereKernel({ N, P })` | `@polypack/sphere` |
| torus (2D on 3D) | `torusKernel({ family, N, P })` | `@polypack/torus` |
| polyhedra (3D in 3D) | `polyhedraKernel({ code, P })` | `@polypack/polyhedra` |
| balls (3D in 3D) | `ballsKernel({ code, P })` | `@polypack/balls` |
| boundary (3D on 4D) | `boundaryKernel({ polytope, piece, P })` | `@polypack/boundary` |

Surface problems in the nofold mode on the Platonic solids are planar problems of one face. They
run on the polygon solver itself, so every polygon method is available for them unchanged. On the
other solids (Catalan solids, prisms, antiprisms) the surface kernel serves them in its nofold mode.

## Running a method (`packages/methods/src/framework.ts`)

- `runMethod(kernel, name, { seed, params, start, budget, shouldStop, onImprove })` runs one method synchronously.
- Methods offer states. The framework finishes each one, checks an improvement with the server's
  rule and keeps the best, so a result is always valid and never worse than a valid start.
- **Budget.** It is counted in energy evaluations: `energy()` costs 1, `pieceEnergy()` and `clear()` cost 1/P each, and `finish()` and `validate()` cost the kernel's `finishCost`.
- **Stopping.** When the budget is spent, the stop is set or the bound is reached, the kernel's next call throws `Stop`.
- **Seeding.** Runs are seeded with mulberry32, so they are reproducible from the seed when the budget is in evaluations.
- **Local solves.** `local.ts` holds the ones the methods share: `relax` (the size fixed) and `squeeze` (size plus mu times the energy, minimised together).

## Methods

Each method keeps the name of the polygon method it ports and has its own page here.

| Method | Needs |
|---|---|
| `penalty` | — |
| `mc_compress` | — |
| `asc` | — |
| `basin_hopping` | — |
| `shrink_repair` | — |
| `harden` | `shape` |
| `morph` | `shape` |
| `seed` | — (uses `seeds` when the kernel has it) |

`ls_growth` is not ported. Lubachevsky–Stillinger growth needs exact collision times between
moving pieces, which none of these spaces' geometries gives in closed form. Its effect, growth
under hard-particle moves, is covered by `mc_compress` and `asc`.
