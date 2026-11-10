# Porting the server's validators to Rust

The Rust server must behave as the TypeScript server does: the same requests accepted and refused,
the same verdicts, the same messages. This file holds the rules every port in `native/` follows, and
how a port is compared with its TypeScript source. The TypeScript in `packages/` stays the
reference until a port has passed the comparison.

## What "the same" means

- **Verdicts are identical**: valid or invalid, malformed or not, which checks ran, how many
  reasons.
- **Messages are identical in their text.** Numbers inside a message may differ in their last
  digits (see below); everything else is the same character for character.
- **Numbers**: a size the configuration states is passed through bit for bit. A computed number
  agrees to about 1e-12 relative. The cause of the difference is the transcendental functions:
  V8's `Math.sin` and `Math.cos` come from glibc and cannot be copied (LGPL); `polypack-js` uses the
  `libm` crate, which gives the same bits for about 98.5% of arguments and the neighbouring double
  otherwise. A verdict can therefore differ only when a quantity lies within about 1e-15 of its
  tolerance.

## Rules of a port

1. **Port line by line.** Keep the order of operations, of loops, of early exits and of the
   reasons collected, and every limit (`maxErrors`, chain limits, work caps). `(a + b) + c` stays
   `(a + b) + c`. Do not replace an algorithm with a better one; a port that is faster because Rust
   is faster is the goal, not a different method.
2. **Math**: `polypack_js::math::*` for every `Math.*` (`Math.hypot` is V8's own algorithm,
   `Math.round` rounds halves up, `Math.max` and `Math.min` have rules for NaN). `x ** 2` is
   `x * x`; other powers are `math::pow`. `Math.sqrt`, `+ - * /` are IEEE and need nothing.
3. **Numbers in messages**: `polypack_js::fmt::num(x)` for `${x}`, and `fmt::exponential`,
   `fmt::fixed`, `fmt::precision` for `toExponential`, `toFixed`, `toPrecision`. Never `{}` on an
   `f64`.
4. **JavaScript semantics that are easy to lose**:
   - every number is a double: an index or count kept in an integer type must not overflow or wrap
     where the double would not; `|0`, `>>>` and `Math.imul` are 32-bit;
   - comparisons with NaN are false: `!(a <= b)` is not `a > b`. Keep the form the source has;
   - `Map` and `Set` iterate in insertion order: use a `Vec` or an insertion-ordered structure, never
     the iteration order of a `HashMap`;
   - `Array.prototype.sort` is stable, and without a comparator it sorts by the text of the values;
   - integer keys of an object iterate in ascending order before string keys;
   - a thrown `Error` becomes an `Err` with the same message, caught where the source catches it;
   - `JSON.stringify` drops `undefined` fields and writes `-0` as `0`.
5. **Generators that yield for the event loop** (`validationSteps`, `runStepsAsync`) become plain
   functions: the Rust server runs a check on a worker thread. A cap on the work that changes the
   verdict stays.
6. **Tables** (solids, polytopes) are not retyped. A tool in `native/tools/` writes them from the
   TypeScript module as JSON into the crate's `data/` directory, the crate reads them with
   `include_str!`, and the tool's `--check` mode fails when the file is out of date.
7. **Names** follow the source in snake_case, and each function's comment names the TypeScript
   function it ports (`packages/torus/src/validate.ts: validationSteps`). Geometry that is not
   obvious keeps the source's explanation.
8. **A defect in the source is ported as it is** and reported, not fixed: fixing it is a change of
   behaviour that needs its own review.
9. **JSON**: an answer is written with `polypack_js::json::stringify` (JavaScript's number text:
   `2`, not `2.0`), a request body is read with `polypack_js::json::parse` (which decodes and
   parses as `await c.req.json()` does). A field that is `undefined` in the source is left out of
   the answer, and keys come in the order the source builds them.

## Differences that are meant

These are the places where the Rust server does not do what the TypeScript does, each because the
thing itself does not exist in Rust or is the reason for the port. Anything not listed here is a
defect.

- **Numbers computed with sine, cosine and the other transcendental functions** can differ in
  their last digits (see above).
- **Three kinds of request body** are read differently (`polypack_js::json::parse`): a number too
  large for a double, a string with a lone surrogate escape, and nesting deeper than 128 levels.

## Comparing a port with its source

Each family has three pieces, after the pattern of the flat one (`native/tools/flat-ref.mts`,
`native/flat/examples/serverdiff.rs`, `native/tools/flat-compare.mjs`):

- `native/tools/<family>-ref.mts`: builds the cases and writes the TypeScript verdicts and timings;
- `native/<family>/examples/<family>diff.rs`: the Rust verdicts and timings for the same cases;
- `native/tools/<family>-compare.mjs`: compares field by field and prints the tables.

Cases come from real packings (the research records in `data/<family>/` and the site's leading
entries in the nightly snapshot `space-<family>.json.gz`) and from mutants of them: a piece moved
into another, the size shrunk by 1e-10, 3e-9 and 1e-6 relative (inside, at and beyond the
tolerance), a piece outside the container, a wrong count, malformed fields, and random
configurations. Each case is checked at both tolerances (1e-9 and 1e-11).

The comparison treats two messages as the same when they are equal after each number in them is
replaced by a placeholder, and the numbers agree to 1e-6 relative or 1e-12 absolute (a penetration
depth is a difference of nearly equal numbers, so it keeps fewer digits than its inputs). It counts
separately the cases that are identical byte for byte. A difference of any other kind is a defect of
the port until it is explained.

A few dozen cases with the TypeScript's verdicts are kept in `native/<family>/tests/fixtures/`, so
that `cargo test` checks the port without Node.
