# Porting the server's validators to Rust

The Rust server must behave as the TypeScript server does: the same requests accepted and refused,
the same verdicts, the same messages. This file holds the rules every port in `native/` follows, and
how a port is compared with its TypeScript source. The TypeScript in `packages/` stays the
reference until a port has passed the comparison.

## What "the same" means

- **Verdicts are identical**: valid or invalid, malformed or not, which checks ran, how many
  reasons.
- **Messages are identical in their text**, numbers included.
- **Numbers are identical bit for bit** to those of Node on the production platform (Node 24 on
  Linux x86-64). `polypack_js::math` is a port of the functions V8 runs there (fdlibm, in V8's
  `src/base/ieee754.cc`; Node's builds do not use the glibc-derived sine and cosine that Chrome's
  do), checked against that Node on a million arguments per function with no difference.

Two things can still differ, and both are named where they are compared:

- **`Math.pow` with an exponent other than 2 and 0.5.** V8 calls the C library's `pow`, which is
  not the same on every platform. `math::pow` is correctly rounded; glibc's differs from that by one
  unit in the last place for about 1 argument in 1,200. It is used for volume bounds, not in a
  validator's geometry.
- **Node on an Apple Silicon Mac is not the reference.** Its V8 is compiled with fused
  multiply-add, which changes the last bit of sine, cosine and the rest for up to 0.6% of
  arguments. A comparison run against the Mac's Node shows these as last-digit differences; the
  same comparison against `node:24-slim` for linux/amd64 (in a container) shows none. The
  comparison tools therefore count "equal up to the last digits" separately from "identical", and
  the final check of a port is the run against the Linux Node.

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
6. **Tables of data** (the solids of surface and polyhedra, the nD polytopes) are not retyped. A
   tool in `native/tools/` writes them from the TypeScript module as JSON into the crate's `data/`
   directory, the crate reads them with `include_str!`, and the tool's `--check` mode fails when
   the file is out of date. A table that the source *computes* with sines and cosines (the
   4-polytopes of boundary) is computed by the ported builder instead: a file of it would hold the
   numbers of whichever Node wrote it.
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

- **`Math.pow`** is correctly rounded, where the C library's that Node calls is off by one unit in
  the last place for about 1 argument in 1,200 (see above).
- **Three kinds of request body** are read differently (`polypack_js::json::parse`): a number too
  large for a double is read as `null` (JavaScript: `Infinity`; both are refused where a number is
  wanted), an escaped half of a surrogate pair becomes U+FFFD at once (JavaScript: when the text
  is stored), and nesting deeper than 4,096 levels is invalid JSON (`json::MAX_DEPTH`). Node reads
  a body nested as deep as its 256 KiB allow, 131,072 levels. So a submission that nests deeper
  than 4,096 levels in a field the server does not read is accepted there and refused here (400,
  `body is not valid JSON`), and a `method_params` that deep is refused by both, there for its
  size and here as invalid JSON. Up to 4,096 levels the two answer alike. The limit exists because
  a JSON value is copied, compared, written and released by functions that call themselves once
  per level, and a stack that overflows ends the whole process. It is twice what either server
  can store: `method_params`, the one field stored as it was sent, is at most 4,096 bytes as
  JSON, which nest 2,046 levels deep. Every thread has a stack of 64 MiB, 49 times what the
  deepest value needs in a release build (`pool::THREAD_STACK_BYTES`, measured with
  `server/examples/stackprobe.rs`), and a test runs every step at the full depth on a quarter of
  it. A stored text nested deeper than 4,096 levels, which only a hand can have put into the
  database, is a SyntaxError (500) for the routes that read its row; JavaScript reads it.
- **Overload.** The TypeScript server does everything on one thread and refuses submissions with
  503 (`the server is busy`, `Retry-After: 5`) while that thread runs late: the delay of its event
  loop over the last one to two seconds is above `OVERLOAD_DELAY_MS` (load.ts: `LoopDelay`). The
  Rust server verifies submissions on worker threads, one per core, beside the threads that answer
  requests, so it has no event-loop delay. It measures instead how long a submission waits for a
  free worker, over the same windows (`native/server/src/pool.rs`), and refuses with the same
  status, body and header while that wait is above the same setting. The minute's `[load]` line
  keeps its words, "event loop delay up to N ms", and N is the longest such wait of the minute. So
  the refusal says the same thing, the server cannot keep up, and comes later: once every core is
  busy verifying.
- **Requests that are handled at the same time** can be served in another order than Node serves
  them, since they run on several threads. Each request alone is answered as in the source, and
  requests that touch the same data end as they would have in some order of arrival: the
  transaction that stores an entry still decides who leads. The lines of the log follow that order.
  Requests that read the store on their own task wait for one of a few turns first, one per core
  (`pool::blocking`), in the order they came, so that however many wait, the process keeps a few
  threads per core (600 requests at once on eight cores: 35 threads, where it was 530).
- **The heavy checks of the spaces** (spaces.ts: `heavyTurn`). In the source a heavy check
  shares the server's one thread with every other request, in slices of 20 ms, and one runs at a
  time. Here one runs at a time too, on a thread kept for the heavy checks beside the workers that
  verify everything else, so the queue is the source's: the same checks count as heavy, eight may
  wait their turn, and one more is refused with the same 503 (`the server is busy checking other
  entries`, `Retry-After: 5`). What a client can see of the change is how long a turn lasts (the
  500 polyhedra of the harness's `spaces-heavy`: 0.8 to 0.9 s of work in the source, 0.15 to 0.2 s
  here, on the same machine), and so how often a request finds the queue full; and a submission
  that is not heavy is not slowed by one that is.
- **One check at a time per address** (spaces.ts: `checking`). The source answers 429 (`an entry
  from this address is still being checked`, `Retry-After: 1`) to a submission that it looks at
  while an entry of the same address, or of the submit key, is being checked. On one thread that
  happens only while that check waits for its turn as a heavy check or has worked for more than a
  slice of 20 ms: a shorter check is over before the next request is read. The Rust server gives
  the same 429 while a heavy check of the address waits or runs. A submission that finds a check
  of its address that is not heavy waits for it, some milliseconds, and is then handled as the
  next request would have been in the source; it is not refused, so that two entries sent at once
  are not told to wait where the source would have taken both. A check that is not heavy and yet
  outlasts a slice in the source (29 many-sided pieces on a surface, say) therefore refuses no
  one here.
- **The connection itself** is the HTTP library's (hyper) and zlib's: the `Date`, `Connection` and
  `Keep-Alive` headers, when an idle connection is closed (Node: after 5 s; here: after 60 s), the
  version in the status line of an answer to an HTTP/1.0 request, where a streamed body is cut into
  chunks, the bytes of a compressed body (its content is the same), and which malformed request
  lines are refused before the server sees them (a `<` in a request target, for one). A client that
  closes its sending side before it has read the answer gets none (Node: the answer, if it was
  ready at that moment).
- **The limits of a request** are Node's (`node.rs`: `ConnLimits`), and a request that breaks one
  gets the bytes Node writes before it destroys the socket (`HTTP/1.1 408 Request Timeout`, `431
  Request Header Fields Too Large` or `400 Bad Request`, each with `Connection: close` and nothing
  else), with these differences in when:
  - a head that has not arrived is given up after 60 s, where Node looks every 30 s and so gives
    it up after 60 to 90 s;
  - a request that has not arrived whole is given up 300 s after its head, where Node gives it up
    300 to 330 s after its first byte;
  - a head is refused when its request target and the names and values of its headers come to
    16,384 bytes or more, as in Node, except that the spaces after a value do not count here
    (hyper drops them before the server sees the head) and do count there;
  - a head of more than 64 KiB in all, or of more than 2,000 headers, is refused by hyper itself,
    whose 431 also carries `content-length: 0` and `date`. Node reads the first 2,000 headers of
    a request and drops the rest without a word;
  - a header that hyper joins or drops before the server sees the head is counted as hyper leaves
    it (a `Content-Length` sent many times with one value counts once here; Node's parser refuses
    a second one in any case);
  - a request without a body to read (a GET) that names a body and does not send it: Node gives
    the connection up when the 300 s are over, also in the middle of a live stream. Here the
    body is not waited for, the answer is given, and the connection is closed after it; a live
    stream goes on as long as any other.

  A request whose body does not arrive whole (a chunk size that is none, a connection closed
  before the length it named, the time above) is answered by no route and changes nothing, on
  both servers; the submit routes write a line to stderr for it, as Hono's error handler does.
- **The stop.** On SIGTERM or SIGINT Node closes its listening socket and exits at once. It can:
  on its one thread the transaction that stores an entry and the writing of its answer are one
  uninterrupted step. Here they are steps of two threads, and a process that exited between them
  left an entry stored whose sender never heard of it (2 of 22,385 entries in 12 stops under
  load). So the Rust server takes no further connection and no further request (a request that
  comes now finds its connection closed, as it would after the exit), waits until every POST
  request under way has been answered, and exits then with status 0: after 25 to 33 ms under
  load, and after two seconds at most, when a request under way does not end (a body still being
  sent, heavy checks in their queue, a client that does not read its answer: an answer counts as
  under way until the connection has written it out). Open live streams are not waited for.
- **The repository's root** is the working directory of `polypack-server`; the TypeScript server
  finds it from the place of its own source file. `data/records.json`, the spaces' records
  (`data/<space>/records.json`, and the configurations kept apart in `data/<space>/configs/`),
  `apps/web/dist` and the default database are looked for there.
- **What an internal error writes to stderr** is one line with the error's text, where Node prints
  the exception with its stack; the answer (500, `Internal Server Error`) is the same.

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

Two more classes are counted and listed, never hidden, and each case in them is verified from the
data by the compare tool: a **tie** (two pairs equally deep, two axes or orientations equally good,
to 1e-12: the message may name the other one), and a number equal **at the scale of its inputs**
(a container centre of pieces at coordinates of 1e6 agrees to 1e-15 of those coordinates, not of
itself).

A few dozen cases with the TypeScript's verdicts are kept in `native/<family>/tests/fixtures/`, so
that `cargo test` checks the port without Node. The fixtures are written by Node 24 on linux/amd64
and the tests demand every number exactly; `native/tools/LINUX_REFERENCE.md` says how to run a
reference tool under that Node.
