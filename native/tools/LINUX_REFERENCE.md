# The reference is Node 24 on Linux x86-64

The Rust ports in `native/` must give the numbers of the TypeScript server **as it runs in production**:
`node:24-slim` on linux/amd64 (the repository's `Dockerfile`). Anything that records what "the TypeScript
says" (a comparison's reference, a crate's fixtures under `tests/fixtures/`, a table or a hash of computed
numbers) must be written by that Node, not by the Node of the machine at hand.

## Why not a Mac's Node

Node's `Math.sin`, `cos`, `atan2`, `acos`, `exp`, `log`, `cbrt`, `hypot` and the rest are V8's own code
(fdlibm). On an Apple Silicon Mac that code is compiled with fused multiply-add, and its results differ
from Linux x86-64's in the last bit for a small share of arguments. `polypack_js::math` is the Linux
x86-64 results, bit for bit. What that meant when it was measured (2026-11-10, Node 26 on macOS arm64
against `node:24-slim` on linux/amd64, the same Rust):

| compared with | cases identical to Rust | not identical |
|---|---|---|
| Linux Node 24 | all, in every family and in the spaces layer | 5 of 10,250 ndim bound rows (`Math.pow`, below) |
| the Mac's Node 26 | flat 8,786 of 9,218; sphere 2,738 of 4,130; curved 9,770 of 10,510; spaces 24,069 of 24,111 | last digits of numbers, and some ties, in every family that uses a sine |

It is not only the last digit of an answer. The boundary crate once embedded its six 4-polytopes as tables
written by the TypeScript on a Mac. One `Math.sin` of the convex hull differed in its last bit, 373 numbers
of four polytopes were not the server's, and among 14,127 checks one verdict at the tolerance came out the
other way. (The crate now builds the polytopes with its ported builder; `boundary-tables.mts` writes the
fixture that holds the builder to Linux Node.)

One function is not the same even on Linux: `Math.pow` with an exponent other than 2 and 0.5 is the C
library's, which is not correctly rounded; `polypack_js::math::pow` is. The ndim volume bound,
`Math.pow(x, 1 / d)`, was the neighbouring double in 5 of the 7,889 volume bounds compared. Fixture tests
name that exception where it applies and are exact everywhere else.

## On a Linux x86-64 machine with Node 24 (CI)

Nothing here is needed: run the tools directly, from the repository's root, as their headers say.

    node --import tsx native/tools/<family>-ref.mts ...
    node --import tsx native/tools/boundary-tables.mts --check

## On any other machine: bundle the tool, run it in a container

Docker is needed (OrbStack or Docker Desktop on a Mac; the image runs emulated, several times slower), and
`npm install` done once (for esbuild). The three scripts are in `native/tools/linuxref/`:

    export LINUXREF_DIR=/some/scratch/dir                # outside the repository: bundles and outputs
    export LINUXREF_INPUTS=/dir/of/the/snapshots         # optional: inputs outside the two, mounted read-only

    native/tools/linuxref/bundle.sh flat-ref             # -> $LINUXREF_DIR/bundle/flat-ref.mjs
    native/tools/linuxref/linux.sh flat flat-ref $LINUXREF_DIR/flat 4 --no-times \
        $LINUXREF_INPUTS/n-0.json.gz $LINUXREF_INPUTS/n-3.json.gz ...   # the TypeScript's answers, by Linux Node 24
    native/tools/linuxref/rust.sh flat $LINUXREF_DIR/flat   # Rust's answers (natively) and flat-compare.mjs

- `bundle.sh TOOL...` makes one plain JavaScript file of `native/tools/TOOL.mts` with esbuild. tsx cannot run
  in the container, because `node_modules` holds the host's binaries. The bundle believes it is at the
  tool's own path, so the paths a tool derives from its place still resolve.
- `linux.sh NAME TOOL ARGS...` runs the bundle under `node:24-slim` for linux/amd64 in a container named
  `linuxref-NAME`, removed when it ends, with the repository mounted read-only at its own path, the scratch
  directory read-write, and the working directory at the repository's root. `LINUXREF_RW=1` mounts the
  repository read-write, for a tool that writes into it (fixtures, the boundary fixture).
- `rust.sh FAMILY DIR` runs the family's Rust example on DIR and then its compare tool, unchanged, into
  `DIR/compare.txt`. The port's answers do not depend on the platform, so this runs natively.

Check a bundle once on the host against the tool under tsx (`node $LINUXREF_DIR/bundle/TOOL.mjs ...` and
`node --import tsx native/tools/TOOL.mts ...` must write the same files); all the ref tools did when this
was written.

### Things to know

- **`--no-times`**: every ref tool has it. Under emulation the timing passes cost several times the run
  and mean nothing, so leave them out. The compare tools read `ts-times.json`; `rust.sh` lets
  `rust-times.json` stand in when it is missing and says so: the timing tables of that `compare.txt` are
  then not timings. Take timings from a native run.
- **The order of flat's snapshot files matters** (the cases are drawn in the order the files are given):
  `n-0 n-3 n-4 n-6 n-37 n-50 n-67 n-100`, not the shell's alphabetical order.
- **The cases differ a little between Nodes.** Most ref tools build their cases and answer them in one
  run, and the builders use `Math.sin`, `cos` and `log` themselves (random rotations, Gaussian
  quaternions): a few per cent of the generated cases differ in the last digits of a coordinate from the
  ones a Mac's Node generates. Each side of a comparison must use the cases of its own reference run. ndim
  and boundary build their cases apart from answering them (`--build`, `gen`), so one set of cases can be
  answered by any Node.
- **A reference cannot show a -0**: `JSON.stringify` writes it as `0`. Where a tool writes numbers as JSON
  numbers, the compare tools and the fixture tests take 0 and -0 for one number.
- **`Math.pow`** in the container is glibc's baseline variant: the emulated CPU reports `fma` without
  `avx2`. A production CPU with both selects glibc's FMA variant, whose results may be the neighbouring
  double for other arguments than here. The class of difference (one unit in the last place of a volume
  bound) is the same.

## The fixtures of the crates

`native/<family>/tests/fixtures/` and `native/spaces/tests/fixtures/` were written under Linux Node 24
with the commands below (each also writes the full comparison's files into its OUTDIR), and the fixture
tests compare exactly. `LINUXREF_RW=1` lets the tools write into the crates; `$S` is the directory of the
snapshots (`n-<N>.json.gz` of the flat boards, `space-<family>.json.gz`).

    L=native/tools/linuxref; export LINUXREF_RW=1 LINUXREF_INPUTS=$S; O=$LINUXREF_DIR
    $L/bundle.sh flat-ref surface-ref curved-ref sphere-ref torus-ref ndim-ref boundary-ref polyhedra-ref balls-ref spaces-ref boundary-tables
    $L/linux.sh flat flat-ref $O/flat 4 --fixtures native/flat/tests/fixtures --no-times $S/n-0.json.gz $S/n-3.json.gz $S/n-4.json.gz $S/n-6.json.gz $S/n-37.json.gz $S/n-50.json.gz $S/n-67.json.gz $S/n-100.json.gz
    $L/linux.sh surface surface-ref $O/surface --snapshot $S/space-surface.json.gz --fixtures native/surface/tests/fixtures --no-times
    $L/linux.sh curved curved-ref $O/curved --snapshot $S/space-curved.json.gz --fixtures native/curved/tests/fixtures --no-times
    $L/linux.sh sphere sphere-ref $O/sphere $S/space-sphere.json.gz --fixtures native/sphere/tests/fixtures --no-times
    $L/linux.sh torus torus-ref $O/torus $S/space-torus.json.gz --fixtures native/torus/tests/fixtures --no-times
    $L/linux.sh polyhedra polyhedra-ref $O/polyhedra --snapshot $S/space-polyhedra.json.gz --fixtures native/polyhedra/tests/fixtures --no-times
    $L/linux.sh balls balls-ref $O/balls --snapshot $S/space-balls.json.gz --fixtures native/balls/tests/fixtures --no-times
    $L/linux.sh spaces spaces-ref $O/spaces $S --fixtures native/spaces/tests/fixtures --no-times
    # ndim and boundary answer cases built beforehand (cases.jsonl, and extras.jsonl for boundary, in OUTDIR)
    $L/linux.sh ndim ndim-ref $O/ndim --no-times
    $L/linux.sh ndim-fx ndim-ref $O/ndim --fixtures 72 native/ndim/tests/fixtures/cases.jsonl
    $L/linux.sh boundary boundary-ref run $O/boundary --no-times
    $L/linux.sh boundary-fx boundary-ref fixtures $O/boundary
    $L/linux.sh boundary-tables boundary-tables              # native/boundary/tests/fixtures/builders.json

Under emulation on an Apple Silicon Mac these took between one minute (balls) and twenty-two (sphere).
`native/boundary/tests/fixtures/cbrt.json` is `[x, Math.cbrt(x)]` for 1,507 arguments; Linux Node 24 gives
the values it holds.

The tools that write tables of typed-in constants (`ndim-tables`, `polyhedra-solids`, `surface-export`,
`spaces-tables`) write the same bytes under either Node; their `--check` may run anywhere.
`boundary-tables.mts --check` passes only under Linux Node 24: a Mac's Node builds four of the polytopes
with other last bits.
