# serverdiff: the differential HTTP harness

This directory holds the test that decides whether another PolyPack server behaves as the
TypeScript server in `apps/server/` does. It sends the same requests to both servers over real
HTTP, and compares everything they answer, write to their database and write to their log.
`native/PORTING.md` says what "the same" means: numbers computed with sine and cosine may differ in
their last digits, and everything else is identical.

```
node --import tsx native/tools/serverdiff/run.mts --out SCRATCH_DIR \
     --ref  "node --import tsx native/tools/serverdiff/ref-server.mts" \
     --cand "native/target/release/polypack-server"
```

`--ref` is the default shown, so `--out` and `--cand` are enough. The command writes the scenarios
to `SCRATCH_DIR/scenarios/`, replays each against both servers (`SCRATCH_DIR/a/` holds the
reference's transcripts, `SCRATCH_DIR/b/` the candidate's), compares them, prints every difference
with its step, and exits 0 only when there is none. `SCRATCH_DIR` must be outside the repository.

| file | what it is |
| --- | --- |
| `ref-server.mts` | the TypeScript server started from an options file: the reference |
| `run.mts` | scenarios, both runs, the comparison, in one command |
| `prove.mts` | the proofs that the harness itself is sound (below) |
| `coverage.mts` | line and block coverage of `apps/server/src/` from the reference's runs |
| `lib/runner.mts` | replays one scenario against one server and writes a transcript |
| `lib/compare.mts` | compares two transcripts |
| `lib/http.mts` | the HTTP client: nothing added to a request, nothing done to an answer |
| `lib/test-clock.mts`, `lib/mutants.mts` | the reference's test clock; its deliberate defects |
| `scenarios/*.mts` | the scenarios, written as code that emits JSON lines |
| `fixtures/` | a small literature file and a small static site |

Options of `run.mts`: `--self` (the candidate is the reference again), `--only REGEX`,
`--skip REGEX`, `--quick` (without the scenario that waits two minutes), `--bulk N` (real entries
per bulk scenario, 1500 by default; 0 leaves the bulk scenarios out), `--jobs J` (scenarios at
once, 4 by default), `--reuse-ref`, `--mutant NAME`, `--coverage`, `--list`.

The bulk scenarios and some others replay the site's leading entries from a nightly snapshot that is
not in the repository. `SERVERDIFF_SNAP` names the directory of `n-*.json.gz` (polygon boards) and
`SERVERDIFF_SPACESNAP` that of `space-*.json.gz`; without them those scenarios are shorter or left
out, and the inventory that `run.mts` prints says what ran. The first run draws its sample of
boards from all of `n-*.json.gz` (about a minute) and keeps it in `SCRATCH_DIR/cache/`.

With both set, the suite is 33 scenarios and 10,808 steps (33 of them added with the hardening of
the Rust server, after the results below were taken), and one comparison of two servers takes
about six minutes with `--jobs 7` (four and a half with `--quick`): the longest scenarios are
`minute` (125 s a run) and `snapshot` (70 s a run, most of it waiting for builds).

## The contract of a server under test

A server is testable when it does the following. The Rust server is started as `polypack-server`;
the reference is `ref-server.mts`, and where this text is silent, what the reference does is the
contract.

### Start, readiness, stop

- The runner starts the server with the repository root as its working directory and these
  environment variables, with the meaning they have in `apps/server/src/node.ts`: `PORT`,
  `HOST` (always `127.0.0.1`), `DATABASE_PATH`, and per scenario `ADMIN_TOKEN`, `SUBMIT_KEY`,
  `TRUST_PROXY`, `CLIENT_IP_HEADER`, `PIECES_MIGRATION_BATCH`, `PIECES_MIGRATION_PAUSE_MS`,
  `SNAPSHOT_DIR`, `SNAPSHOT_HOUR`, `OVERLOAD_DELAY_MS`. `PATH` and `HOME` are passed through;
  nothing else is set. A setting that is not a whole number of 1 to 9 digits is warned about on
  stderr and replaced by its default, as `wholeNumber` in node.ts does (`SNAPSHOT_HOUR` of 24 or
  more is 11, silently).
- `POLYPACK_TEST_OPTIONS` is the path of the options file (next section). Without it the server is
  the production server: no test clock, no `/__test/control`.
- The database is the SQLite file `DATABASE_PATH`. It may not exist (a new one is made), or be one
  an older server wrote: everything the constructor of `SqliteStore` does to it happens before the
  port answers (added columns, the indexes, the tallies and their prune, the units conversion), and
  the pieces migration runs in the background from then on, as in node.ts.
- The server is ready when `GET /api/health` answers 200. The runner asks every 40 ms for up to
  60 s.
- The runner stops the server with SIGTERM. The server exits with status 0 without waiting for open
  streams, within 10 s (after that it is killed, and the transcript says so). Every write it
  answered for is in the database file when it has exited. The runner then reads the database with
  its own SQLite (journal mode WAL, as the reference leaves it).
- A scenario may stop the server, change the database or the snapshot directory, and start it again
  with changed variables or options, on the same database.

### The options file

A JSON object. Every field is optional; an absent field has the default given, which is what
node.ts does. Unknown fields are ignored. Paths are absolute.

| field | default | meaning |
| --- | --- | --- |
| `recordsFile` | `data/records.json` of the repository | the published records: a JSON object whose `records` is the list of `LiteratureRecord` |
| `spacesRoot` | the repository root | the directory under which `data/<space>/records.json` and `data/<space>/configs/` are read (`loadSpacesIndex(root)`); a space whose file is missing is its domain alone; a file that cannot be read leaves the space out, with the log line the reference writes |
| `staticDir` | `apps/web/dist` of the repository, when it exists | the static site served for every path the API does not answer; `null`: none, even when the default exists |
| `limits.perIp` | 120 | submissions per window from one address (both submit routes together) |
| `limits.windowMs` | 60000 | that window, and the submit key's |
| `limits.verifyMsPerMinute` | 4000 | milliseconds of verification an address may cause a minute |
| `limits.perKey` | 600 | submissions per window with the submit key |
| `limits.keyVerifyMsPerMinute` | 20000 | verification a minute with the submit key |
| `limits.overloadDelayMs` | `OVERLOAD_DELAY_MS`, else 250 | the event-loop delay above which submissions are refused with 503; 0: never. When the file gives it, `OVERLOAD_DELAY_MS` is not used |
| `limits.snapshotFilesPerHour` | 20000 | snapshot files one address may fetch an hour |
| `holdersChunk` | 250 | problems per step of the first count of `/api/holders` |
| `holderChunk` | 500 | problems per step of an answer of `/api/holder` (at most 500) |
| `unitsGate` | true | false: no submission is asked for `"units": "diameter"` |
| `snapshotStartDelayMs` | 300000 | the delay of the snapshot build at startup, when one is due (`ScheduleOptions.startDelayMs`) |
| `clockOffsetMs` | 0 | the test clock's offset at startup (below) |
| `loopDelayMs` | none | a number: the overload check reads this as the event-loop delay instead of measuring it; `null` or absent: the measured delay |
| `statsFlushMs` | 60000 | how often the server writes its `[load]` line by itself; 0: never by itself (only when `/__test/control` asks) |

Two of these exist because the server's own behaviour depends on how busy the machine is, which no
two runs share: the overload refusal (503 when the event loop is late) and the moment the minute's
load line falls among the other lines. The scenarios pin both (`loopDelayMs: 0`,
`statsFlushMs: 0`) except where they test them (`limits`, `minute`).

`limits.*`, `holdersChunk` and `holderChunk` are `AppOptions` of `createApp`; a number is taken as
it is given (a fraction too: scenarios use `verifyMsPerMinute: 1e-6`).

The client's address needs no test option: `CLIENT_IP_HEADER` names a request header that carries
it (the scenarios use `x-test-client-ip`), exactly as in production. Without it and with
`TRUST_PROXY=1` the first entry of `X-Forwarded-For` is the address; otherwise the address of the
connection.

### The clock

Every time the server reads the wall clock, it reads the system clock plus an offset in
milliseconds: `clockOffsetMs` at startup, then whatever `/__test/control` last set. That covers
`created_at` of both kinds of entry, `generated_at` of the spaces' listings, `computed_at` of
`/api/holder` and the 15 minutes its answers are kept, the windows of the submission and snapshot
limits, the refill of the verification budgets, every time of the snapshot (`generated_at`,
`completed_at`, `as_of`, whether the stored snapshot is recent, when the next hour of `SNAPSHOT_HOUR`
comes), and the minute between two progress lines of the pieces migration. It does not cover
durations (the milliseconds of log lines, the verification time charged to a budget), nor how long
a timer waits: the pause of the pieces migration, the snapshot's start delay, the 20 s of the
stream's keep-alive and the 60 s of the load line run in real time. A build due "at 11:00" is
therefore set at startup for as many real milliseconds ahead as the test clock is short of 11:00.

The runner and the server share the machine's clock, so the runner knows the server's time exactly,
and uses that to say in which step each timestamp was made (see "What is not compared").

### POST /__test/control

The one test-only route. It exists only when `POLYPACK_TEST_OPTIONS` is set; without it the path is
like any other path outside `/api` (the static site or the fallback 404), and so is every other
method on it. The body is a JSON object with any of:

- `"clockOffsetMs": number`: the test clock's offset from now on;
- `"loopDelayMs": number | null`: as the option of that name;
- `"flushStats": true`: the server writes its load line now, exactly as its timer would (nothing
  when there was no submission since the last line and no stream is open), and the counts start
  again.

They are applied in this order. The answer is 200 with the body `{"ok":true}` and
`content-type: application/json`. A body that is not JSON, or is not a JSON object, is answered 400
with `{"error":"body must be a JSON object"}`. Fields of another type are ignored.

### What goes where

- **stdout**: the server's log, one line per event, exactly the lines the reference writes with
  `console.log` and nothing else: the `[spaces]` lines of the catalogues at startup, `units: ...`
  after a units conversion, `[pieces] ...`, `[snapshot] ...`, the line
  `PolyPack server on http://localhost:<port> (database <path>, <n> literature records)` once it
  listens, then `[submit] ...` per submission, `[review] ...`, `[spaces] ...`, `[holders] ...`, and
  `[load] ...`. No timestamps, levels or prefixes of a logging library.
- **stderr**: before the server answers, the warnings of its settings
  (`ADMIN_TOKEN is still the placeholder; ...`, `SUBMIT_KEY has fewer than 32 characters; ...`,
  `<NAME>=<text> is not a whole number; using <n>`) and nothing else: these lines are compared.
  After that the reference writes to stderr only its runtime's report of an internal error (a
  stack trace behind an answer of 500); of that, only whether a run wrote any is compared.
  The order of the lines within each stream is compared; the two streams are not interleaved.
- A database that cannot be converted (disk pieces that cannot be decoded, in a database of the old
  units) makes the server exit with a status other than 0 before it answers, leaving the units of
  the database as they were; what it prints then is not compared.
- **HTTP**: every header of an answer is compared except `date`, `connection`, `keep-alive` and
  `transfer-encoding`. A server must therefore not add headers of its own (`server`, CORS headers,
  `vary` where the reference has none), and must send `content-length` where the reference does.
  Header names are compared in lower case; a header sent twice is its values joined by `", "`.

## Scenarios

A scenario is a JSON-lines file. The first line is its header: `scenario` (its name), `about`,
`env` (the server's variables), `options` (the options file; `null`: none), `clockAt` (what the
server's clock reads when it is first started; the runner turns it into `clockOffsetMs`),
`autostart` (false: the scenario prepares files or the database first), `timeLabels`. In `env` and
`options`, `{tmp}` is the run's own directory, `{repo}` the repository and `{fixtures}`
`native/tools/serverdiff/fixtures`. Each further line is a step:

| `op` | fields | what it does and records |
| --- | --- | --- |
| `req` | `method`, `path`, `headers`, and a body as `json`, `text` or `repeat` (`prefix`, `text` x `count`, `suffix`); `chunked: n` sends it in chunks of n bytes without a Content-Length; `expect` | one request; the status, the headers and the body. `expect` is the status the author of the scenario expected: a mismatch is a warning of the run, not part of the transcript |
| `burst` | `requests`, `unordered`, `concurrency`, `staggerMs`, `summary` | the requests at once (or `concurrency` at a time; or each `staggerMs` after the one before, so that they arrive in order); the answers in the order of the requests, or sorted when `unordered` (when which request wins is not determined), or with `summary` only how many answers of each kind (status and content) there were |
| `wait` | `ms` | waits |
| `sse_open` | `stream`, `path`, `headers` | opens `GET /api/events...`; records status, headers and the greeting; an answer that is not a stream is recorded as an answer |
| `sse_drain` | `stream`, `settleMs` | waits until the stream has been quiet for `settleMs` (150) and records the blocks that arrived since the last drain, line for line |
| `sse_close` | `stream` | records what is left and closes the connection |
| `control` | `clockAdvanceMs`, `loopDelayMs`, `flushStats` | `POST /__test/control` (the runner keeps the offset) |
| `stop`, `start`, `restart` | `restart`: `env`, `options` (merged into the current ones; an `env` value of `null` unsets), `clockAt`, `clockAdvanceMs`; `start`: `expectFail` | stops with SIGTERM and records the exit status and the log of that run; starts on the same database. `expectFail`: the server must exit with an error instead of answering, and only that is recorded |
| `sql` | `statements` | runs SQL on the database while the server is stopped (databases of older versions) |
| `file` | `path` under `{tmp}`, `text` or `gzipText`, `remove` | writes or removes a file (the snapshot directory, literature files) |
| `ls` | `dir` | records the names in a directory, and the text of its `.json` files |
| `dump` | | records the whole database |

At the end the runner stops the server and records its log and the database: every table of
`sqlite_master` with every row (the storage class of each value, BLOBs as hex), the schema rows
(`type`, `name`, `tbl_name`, `sql`), `journal_mode` and `user_version`. Rows are in the order of the
table's integer key, or of all columns for a table without one.

The scenarios are generated by `scenarios/*.mts` (`run.mts --list` prints the inventory):

- `flat.mts`: the polygon family. `flat-submit` (valid boards, every malformed body and field, a
  backslash before a character of several bytes and an escape cut short, the body limit with and
  without Content-Length, names and notes, units, closed problems, unknown routes),
  `flat-provenance` (with a `method_params` nested as deep as its 4,096 bytes allow, 2,046 levels,
  stored and read back; one level more and 3,000 levels, refused for the size; a field the server
  does not read nested 3,000 deep, accepted; every other field nested where a number or a text
  belongs), `flat-leaders` (ties, losing entries, `/api/records`, pairs,
  `/api/leaders`, `/api/atlas` and its paging), `flat-review` (claims, the administrator's routes),
  `flat-holders` (counts, peaks, the answers kept for 15 minutes, restarts), `flat-closed`.
- `corpus.mts`: `flat-corpus`, every board of `data/corpus/`.
- `spaces.mts`: `spaces-read`, `spaces-submit-bodies` (among its bodies: the almost-JSON ones of
  `flat-submit`, and a configuration and the other fields nested 3,000 deep), one scenario per space (`spaces-surface` ...
  `spaces-ndim`: research records posted back, scaled and damaged; leading entries of the site
  replayed, tied, edited, removed), `spaces-heavy`, `spaces-no-records`.
- `server.mts`: `events`, `limits`, `snapshot` (one of its entries has a `method_params` nested
  2,000 deep: read back, and in the file of its pair), `snapshot-broken-dir`, `units-gate`,
  `static-files`, `migrate-first-schema`, `migrate-units`, `migrate-fails`, `entry-defaults`,
  `entry-settings`, `minute`.
- `bulk.mts`: `bulk-flat` and `bulk-spaces`: real leading entries in a random (seeded) order with
  mutants between them, then every listing and the snapshot's files.

Scenarios whose answers depend on timing, by their nature:

- `spaces-heavy`: eight entries of 500 polyhedra arrive at once from one address (one is checked,
  seven are told to wait), twelve from twelve addresses (one runs, eight wait, three are refused
  with 503), and three more 15 ms apart. The reference checks such an entry for about a second, so
  its answers are the same in every run. A server that checks it in less time than the requests
  take to arrive answers differently without being wrong; such a difference has to be judged by
  reading it.
- the bursts of `flat-holders` are built so that their answers do not depend on the order in which
  the requests are handled.
- `snapshot` restarts the server ten seconds before the hour of the nightly build and waits
  12.5 s: a server that takes more than ten seconds to start misses that build.
- `minute` waits for the server's own 60 s timer.
- `snapshot-broken-dir` compares the line `[snapshot] build failed: EEXIST: file already exists,
  mkdir '<path>'`, whose text is Node's rendering of the system's error.

## The comparison

Two transcripts are compared record for record. Equal lines are identical records. Otherwise the
records are walked field by field, and everything must be equal: the status, each header, the body's
text, the lines of each stream block in order, each row and schema line of the database, each log
line in order. The allowance of PORTING.md is applied in three places, and every use of it is
counted and reported ("equal up to the last digits": so many records, so many numbers, the largest
relative difference):

1. A number of a JSON body, of a stream's `data`, of a JSON text stored in the database, or a REAL
   of the database: equal, or within 1e-12 relative, or within 1e-12 absolute (centres near zero).
2. A number inside a message (an element of `reasons`, an `error`, a log line): the texts are equal
   once each number is replaced by a placeholder, and the numbers agree to 1e-6 relative or 1e-12
   absolute (PORTING.md: a penetration depth keeps fewer digits than its inputs).
3. `content-length` is not compared for an answer whose body differs only by such numbers (their
   digits may be fewer or more).

Not allowed even then: the `pieces` and `container_phi` of a polygon entry in an answer (they are
what the submitter sent, passed through: bit for bit; in the database `pieces` is a BLOB and is
compared as bytes), a different order of keys, a number written differently that parses to the same
double (`1.0` for `1`), different whitespace. Those are reported as differences of kind `format`.

### What is not compared (the normalisation)

Each rule is here because two runs of the same reference server differ in it, or because the bytes
are not the server's to choose.

- **R1, timestamps.** A string that is an ISO time with milliseconds is replaced by `<t:K>`, where
  K is the step during which the server's clock read that time (the runner knows the server's
  clock, and starts each step in a later millisecond than the one before ended). So the transcript
  still says *when* each time was made: an entry's `created_at` in the step that stored it, a kept
  listing's `generated_at` in the step that first asked for it, an unchanged snapshot file's
  `as_of` in the step of the earlier build. A time outside every step (static data, rows a scenario
  wrote itself) stays as it is. Bulk scenarios (`timeLabels: false`) send their steps without
  pacing and use `<t>` for any time since the scenario began.
- **R2, compressed bytes.** A body with `content-encoding: gzip`, and a snapshot file
  (`application/gzip`), are decompressed and their content is compared; their `content-length` is
  not. Whether an answer is compressed is compared (`content-encoding`, `vary`).
- **R3, the wait of the verification budget.** In a 429 whose reason is `too much verification
  work ...; wait N s`, N and the `retry-after` header are replaced: N follows from how many
  milliseconds the address's checks took.
- **L1.** In log lines, the port, the database path, the run's directory and the repository's path.
- **L2.** The durations of `[submit]` and `[load]` lines (`12.34 ms`), of `units: converted ... in
  N ms` (and the `ms` of its report), and of `[pieces] ... rows in N s of work`.
- **L3.** What a server writes to stderr after it began to answer: only whether it wrote anything
  (see "What goes where").
- **L4.** The order of the log lines written during a `burst` whose requests are under way
  together (not one of `concurrency: 1`): they are compared as a set, in sorted order. Which of
  two requests a server takes up first when both are waiting for it is the server's own: the
  TypeScript server itself logged two edits of one burst in either order from run to run on a
  busy machine, also when they were sent 15 ms apart, and a server with several threads is
  allowed another order (`native/PORTING.md`, "Requests that are handled at the same time").
  The answers of the burst are still compared each with its request, and what the requests left
  behind by every later step.
- Headers `date`, `connection`, `keep-alive`, `transfer-encoding`.
- The order of the rows of a table without an integer key (`tallies`, `meta`, `holder_peaks`): no
  query of the server can see it.

Nothing else is normalised. In particular ids, ranks, scores, fingerprints, ETags, the text of every
message, and the order of log lines outside such a burst are compared as they are.

## Soundness

`prove.mts --out DIR` runs, with the TypeScript server alone:

- **(a)** every scenario twice on fresh databases: the comparator must find the two transcripts
  identical. A difference means a scenario that is not deterministic or a missing normalisation; it
  is fixed in the scenario where it can be (a wait before the next step), and stated above where it
  cannot.
- **(b)** the suite against a reference with one deliberate defect (`lib/mutants.mts`, chosen by
  `SERVERDIFF_MUTANT`): one answer (`total` of a leaderboard one more), one status (a 404 as 410),
  one header (`retry-after` one more), one database value that no route reads (the legacy column
  `agent`), one log line (`[submit] 200` as `201`), one float in its 10th digit (`score` times
  1 + 1e-10). Each must be reported. The mutant `ulp` changes a score by one unit in the last place
  and must be counted as "equal up to the last digits" and not reported as a difference.
- **(c)** coverage: the reference runs under `NODE_V8_COVERAGE`, and `coverage.mts` reports the
  lines and blocks of each file of `apps/server/src/` that ran.
- **(d)** with `--entry`: the scenarios that use no options file (`entry-*`) give the same
  transcripts against `apps/server/src/node.ts` itself as against `ref-server.mts`, which shows that
  the reference repeats the real entry point.

### Results (2026-11-10, TypeScript server alone, 33 scenarios, 10,775 steps)

- (a) 10,841 transcript records in two fresh runs, the first under V8 coverage and both with seven
  scenarios at once: 32 scenarios identical record for record. `spaces-heavy` differed in the order
  of two log lines of answers given in the same instant; its burst was changed, and it was then
  identical in two more pairs of runs. Differences found on the way and removed at their cause, not
  by normalising: the snapshot's build at startup racing the first submissions (a wait), the nightly
  build missed when a loaded machine took more than three seconds to start the server (ten seconds
  now), 503 "the server is busy" under load (`loopDelayMs`), the minute's load line falling among
  other lines (`statsFlushMs`).
- (b) every defect reported: `answer` in 11 scenarios, `status` in 6, `header` in 1, `db` in 8,
  `log` in 22, `float` in 12; `ulp` reported in none and counted as a last-digit difference in 12.
- (d) `entry-defaults` and `entry-settings`: identical against `apps/server/src/node.ts`.
- (c) coverage, lines 3291 of 3457 (95.2%), blocks 1536 of 1853 (82.9%):

| file | lines | | blocks | |
| --- | --- | --- | --- | --- |
| app.ts | 932/941 | 99.0% | 560/634 | 88.3% |
| docs.ts | 183/183 | 100% | 10/10 | 100% |
| leaders.ts | 73/74 | 98.6% | 59/66 | 89.4% |
| limits.ts | 143/143 | 100% | 83/90 | 92.2% |
| load.ts | 107/110 | 97.3% | 49/51 | 96.1% |
| node.ts | 88/101 | 87.1% | 19/52 | 36.5% |
| pieces.ts | 44/45 | 97.8% | 25/27 | 92.6% |
| snapshot.ts | 373/388 | 96.1% | 116/171 | 67.8% |
| spaces.ts | 479/483 | 99.2% | 301/358 | 84.1% |
| sqlite-store.ts | 585/635 | 92.1% | 182/220 | 82.7% |
| store.ts | 2/2 | 100% | none | |
| units-gate.ts | 36/36 | 100% | 20/23 | 87.0% |
| units-migration.ts | 246/316 | 77.8% | 112/151 | 74.2% |

`node.ts` is run only by (d); everywhere else `ref-server.mts` stands in for it.

The lines that did not run, and why no request reaches them:

| file | lines | reason |
| --- | --- | --- |
| app.ts | 367-368 | kept `/api/records` answers are dropped only beyond 64 MB of them |
| app.ts | 551-552, 571-572, 640-642 | the store fails (a peak cannot be stored or read, a change fails midway): SQLite on a local file does not fail on request; the tests use a store that throws |
| leaders.ts | 101 | no store of space entries: node.ts always gives one |
| load.ts | 58-60 | `LoopDelay.stop`, which the server never calls |
| node.ts | 107 | a connection without an address |
| node.ts | 114-130 | the static site: `apps/web/dist` is not built in this checkout, and the harness may not write there. `ref-server.mts` repeats these lines for `staticDir`, and `static-files` runs them there |
| pieces.ts | 43 | stored pieces that are neither text nor a BLOB: the column's TEXT affinity makes text of anything else |
| snapshot.ts | 297-299 | the gzip stream fails |
| snapshot.ts | 320-322, 348-350 | an entry is overtaken between the reading of a file's leaders and of that entry: a window of microseconds inside one request |
| snapshot.ts | 448, 586-587 | a stored file cannot be examined or removed |
| snapshot.ts | 620-622 | the schedule's `stop`, never called |
| spaces.ts | 207-210 | gzip of a kept listing fails |
| sqlite-store.ts | 250-252, 586-588, 742-744, 828-830 | ROLLBACK after a failure inside a transaction |
| sqlite-store.ts | 255-257, 354-356, 373-375, 412-423, 688-693 | `insert`, `prune`, `rank`, `leaders`, `spaceLeaders`: methods the server does not call |
| sqlite-store.ts | 304 | more than 500 ids in one lookup: no caller passes more |
| sqlite-store.ts | 775 | a migration step of no rows: the migration is not started then |
| sqlite-store.ts | 877-886 | a failed step of the pieces migration: needs another process holding the database's write lock, then 60 s of real time per retry |
| sqlite-store.ts | 910-912 | the migration's `stop`, never called |
| units-migration.ts | 173-174 | a balls problem with neither ball pieces nor a ball container: the domain has none |
| units-migration.ts | 205-255, 399-412 | the reverse conversion and the digest: the rollback tools, not the server |
| units-migration.ts | 278-280 | a database already converted: the store checks the epoch before it calls |

The blocks that did not run on lines that did are of four kinds: `?? default` and `|| fallback`
where node.ts always gives the value (app.ts 254-256, node.ts, `"(none loaded)"` in spaces.ts 302
and 510, since every space has a domain); the `String(e)` arm of `e instanceof Error ? ... :`;
arms that need the failures of the table above; and arms that need two things to interleave inside
one call of the synchronous store (app.ts 424, 444, 445: an entry added or removed while the pairs
are read). Two more are unreachable by the data: app.ts 1036, `shrink test FAILED` (a board valid
at tolerance 1e-9 has gaps of at least -1e-9, and shrinking every piece by 1e-8 about its centre
opens each gap by more than that), and app.ts 1060 (a stored entry always leaves a leader).

## Behaviour of the TypeScript server that a port has to know about

Found while writing the scenarios. They are compared like everything else; none is hidden.

- `OPTIONS` on a static file is answered 200 with the file's `Content-Length` and no body, so a
  client waits for bytes that never come until the connection is closed after about 5 s
  (`@hono/node-server` serve-static treats OPTIONS as HEAD). `static-files` has one such request.
- A `Range` beyond the end of a static file (`bytes=3000-3001` of 3000 bytes) is answered 206 with
  `content-length: 2` and no bytes: the same hang. `bytes=-5` is answered with bytes 0 to 5, not
  the last five; `items=0-1` and `bytes=x` are answered 206; `bytes=10-5` is a 500.
- A static file is served for every method (`POST /index.html` answers the file).
- The static 206 answers carry the file's creation time in `Date`; that header is not compared.
- A stored BLOB of pieces whose length is not a multiple of 24, or pieces text that is not JSON,
  makes every route that reads the row answer 500 `Internal Server Error` (text/plain).
- A name is cut after 40 UTF-16 units, a note after 200. A cut through the two units of one
  character (an emoji at the limit) leaves half of it, which the database and every answer then
  hold as U+FFFD (`flat-submit`, the names of 4/4/20).
- `Number()` reads the path parameters: `/api/problems/0x10/4/1` is the problem 16/4/1,
  `/api/problems/4/4/1e2` is 4/4/100, `/api/problems/%204/4/1` is 4/4/1, and `/api/submissions/1e0`
  is submission 1.
- An empty value of the header named by `CLIENT_IP_HEADER` is no address: the request counts for
  the address of its connection.
- `/api/snapshot/%34-4.json.gz` is the file `4-4.json.gz`, and counts for the limit.
