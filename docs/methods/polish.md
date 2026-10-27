# Contact-system polish

**[CALC]** `polish(config, options)` is a deterministic local float64 contact solver for congruent regular polygons or disks of diameter 1 (radius 1/2) in either regular polygon or circle containers. It reduces the container size from an already promising arrangement and can repair small penetrations. It returns the best configuration that passed the shared geometry evaluator; a start that meets the stricter polish residual tolerance retains its poses when no improvement is found, with `container_phi` set to the assessed orientation. Malformed starts, wrong piece counts, and starts without a strict, no-worse repair return `undefined`. A server-valid start with separation below `-1e-12` or protrusion above `1e-12` is excluded from the fallback; `maxIterations: 0` therefore returns `undefined` for such a start.

## Numerical method

**[CALC]** Variables are every piece's `(x, y, theta)` and the container's `(cx, cy, phi, size)`. Near piece contacts use the shared `pieceSeparation` signed SAT/distance residual. Boundary contacts use the shared `pieceVertices` convention, polygon edge normals and apothem, or distance to the circle centre. Positive residuals mean free space, zero means contact, and negative values mean penetration or protrusion.

At each iteration the solver selects contacts within the contact tolerance, computes sparse central finite-difference derivatives on the variables participating in each contact, and solves a sequential quadratic programming subproblem:

```text
minimize  0.5 * ||d - target||^2
subject to J d >= -g + 2e-13
target = (0, ..., 0, -trust)
```

The shrinking target acts on the container size variable. Nonnegative dual coordinate updates solve the convex subproblem; a multiplier falling to zero releases that contact from the active set. This avoids singular contact Gram matrices in symmetric or overconstrained layouts. A trust bound limits motion, starting at `0.05`. Its maximum is `clip(0.1 * (initialScore - areaLowerBound), 0.05, 0.5)`, so loosely spaced starts can take larger steps while near-contact fixtures retain the smaller bound. A backtracking line search and contact-normal Newton corrections restore small nonlinear penetrations. Every tested pose configuration goes through the shared evaluator, which recomputes the enclosing container. The initial assessment searches container orientation; numerical trials assess the optimized current orientation without repeating the full orientation search. A final assessment uses auto-orientation. Container variables in the local model are never accepted as a score or a containment certificate. Candidate pair restoration rejects separations below `-1e-12`, rather than exploiting the server's looser touching tolerance. Circle candidates are restored to nonnegative separation before scoring, preventing a tiny negative gap from being stored as a falsely improved score through a framework callback. Initial fallbacks and scored containers also receive the strict residual check. Best-pose updates require an improvement exceeding `2e-13`, so numerical rounding at a tight optimum does not replace its poses.

Once the trust search finishes, a float64 Newton refinement snaps contacts within `2e-7` to their final active equalities. Sequential row projections solve the linearized equalities without requiring an invertible contact Gram matrix. Backtracking and the same strict pair restoration apply; the shared evaluator accepts an improved candidate. Redundant or inconsistent equalities may prevent this refinement from converging, in which case the previously validated packing remains the fallback.

**[EST]** Sequential quadratic programming forms constrained quadratic subproblems from local derivatives; see the [NEOS SQP guide](https://neos-guide.org/guide/algorithms/sqp/). The dual coordinate procedure follows Clifford Hildreth, [“A quadratic programming procedure,” _Naval Research Logistics Quarterly_ 4 (1957), 79–85](https://onlinelibrary.wiley.com/doi/10.1002/nav.3800040113). Both references were verified on 2026-10-08. The trust bound, SAT residuals, restoration and acceptance rules above are this implementation's choices.

## Options and budgets

| Option              | Default                      | Meaning                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxIterations`     | `300`                        | Maximum outer SQP iterations; floored and capped at 300. The search can stop earlier when the trust radius or step stalls. Zero validates and returns the input poses without numerical work if they satisfy the strict polish tolerance.                       |
| `iterations`        | —                            | Deprecated compatibility alias used only when `maxIterations` is absent.                                                                                                                                                                                        |
| `contactTolerance`  | `0.05`                       | Contact inclusion gap in piece units; clipped to `[1e-7, 1]`. Start with this when pieces are within a few percent of contact.                                                                                                                                  |
| `checkpoint`        | Cooperative event-loop yield | Async callback at outer numerical phase boundaries. Returning false stops and retains the best valid configuration evaluated so far.                                                                                                                            |
| `shouldStop`        | Always false                 | Cheap synchronous cancellation/deadline predicate checked throughout inner numerical loops.                                                                                                                                                                     |
| `evaluate`          | Shared geometry              | Framework callback `(config, {autoOrient?})` returns an evaluation, or `undefined` when no budget remains; all validity and score assessments use this hook. Initial/final assessments request auto-orientation; intermediate trials request fixed orientation. |
| `initialEvaluation` | —                            | Reuse a trusted assessment of the exact input, avoiding duplicate start assessment through the framework.                                                                                                                                                       |

Negative or nonfinite numerical options throw `RangeError`. There is no random seed inside polish. The portable runtime checkpoint yields to the event loop after roughly 12 ms of elapsed work, at the next outer phase boundary; a framework checkpoint additionally enforces time, evaluation and cancellation budgets. Async checkpoints occur before initialization, each outer SQP iteration, each final Newton phase and the final assessment. Contact scanning, finite differences, dual sweeps, backtracking and penetration repair use synchronous `shouldStop` checks. There are no awaited checkpoints per contact row or dual update. Each initial/candidate assessment counts as one shared evaluator call; residual and derivative calculations do not count as separate scoring evaluations.

**[CALC]** Dense Jacobian work is bounded to at most 100 pieces, 2048 selected contacts, and `selectedContacts * max(N, 1) <= 50000`. Exceeding a cap returns the best validated configuration, or `undefined` if none exists. The dual subproblem has at most 300 sweeps, each line search 16 trials, and each penetration repair 48 sweeps. Final Newton refinement has at most eight phases, 1000 row-projection sweeps per phase and eight backtracking trials. These are local-work limits, not convergence or optimality guarantees. In particular a valid packing above a cap receives no numerical improvement.

**[CALC]** A checkpoint cannot preempt one synchronous call to the shared geometry evaluator. Auto-orientation for many-sided containers can overrun a wall-clock or stop deadline inside that call. The caller should account for this unavoidable synchronous boundary; this module makes no absolute one-second cancellation claim for arbitrary supported shape codes.

## Portable contact system

Exports support the separate Python high-precision stage:

```ts
type ContactConstraint =
  | { kind: "pair"; i: number; j: number }
  | { kind: "wall"; i: number; edge: number; vertex?: number }
  | { kind: "radial"; i: number; vertex?: number };

identifyContacts(config, container?, tolerance = 0.05): ContactConstraint[];
contactResiduals(config, container, contacts): number[];
packContactVariables(config, container): number[];
unpackContactVariables(config, variables): { config, container };
```

Indices are zero-based. A pair residual is the shared signed separation of pieces `i` and `j`, including the maximum over SAT axes for polygons. A wall residual is `size / (2*tan(pi/M)) - (point-centre)·normal - pad`, with normal angle `phi-pi/2+2*pi*edge/M`. A radial residual is `size - distance(point,centre) - pad`. Polygon `point` is the indexed piece vertex; circle contacts omit `vertex`, use the piece centre, and have `pad=1`; polygons have `pad=0`. Coordinates flatten as `[x0,y0,theta0,...,cx,cy,phi,size]`. If no container is supplied, `identifyContacts` obtains one with the shared evaluator; the synchronous exported helper has no cancellation hook.

## Fit and limitations

**[CALC]** This stage works well when the contact graph is almost correct: the tests tighten clean, rotated and jittered five-square constructions of side `2+1/sqrt(2)`, settle four tilted squares to side 2, and compress the central-plus-six-circle construction to radius 3 from expansion 1.5. Two circle centres ten units apart compress to radius 2. Three corner triangles converge to side 2 without exploiting touching tolerance. None of these constructions is present as a branch or target in the solver. Slightly overlapping seven-circle starts are repaired in tests.

**[SPEC]** Some disconnected and widely separated starts compress successfully, but these and heavily overlapping starts can still remain stuck or need a global search method first. Polygon SAT residuals are nonsmooth when their maximizing axis changes, so finite differences and restoration can stall near a contact change. The method makes no guarantee of finding a global minimum, repairing arbitrary invalid starts, or identifying every useful future contact. Float64 outputs receive server-equivalent validation, not an exact proof; the separate 50-digit Python refinement also requires shared TypeScript validation before acceptance.
