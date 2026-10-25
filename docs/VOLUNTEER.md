# Volunteer client

`polypack-volunteer` lets anyone give spare CPU time to PolyPack, in the way volunteer computing projects such as Folding@home work. You download one file and run it with Node, in the background. It takes problems from the server's ranked work list one at a time and searches each with many methods, seeds and budgets on the cores it is given. It submits a result only when the result beats the site's current leader, then moves on.

It is a plain command-line program with no game in it. The Tighter idle game is unrelated.

By default it searches Flat problems (2D in 2D): polygons in polygons. It can also search the other kinds of the site's dimensions (Curved, Platonic surfaces, Sphere, Torus), but only when asked to: see [Optional: other dimensions](#optional-other-dimensions). By default it never asks the server about them.

Labels: [EST] established, with its source; [CALC] measured or computed here; [SPEC] a judgement or expectation not yet measured.

## What it does

For each problem it:

1. Reads the work list, `GET /api/targets`, and keeps it for 10 minutes. The list ranks open problems: unsolved ones, those whose site leader is missing or worse than the published value, sawteeth, and the rest by their distance from the area bound.
2. Leaves out problems that do not match `--N`, `--M` or `--max-P`. It also leaves out problems this machine searched in the last 7 days, unless their leader has changed since. A dry run's searches count only for later dry runs: a real run searches the problem again. From the 50 highest priorities left, it draws one at random, weighted by priority. Machines that read the same list therefore spread over different problems, and the most promising problems still come up most often.
3. Reads the problem (`GET /api/problems/{N}/{M}/{P}`): the leader, the published value with its coordinates if it has any, whether the problem still takes submissions, and the area bound. A problem whose answer cannot be read, or is malformed, is skipped for 10 minutes. So is a problem whose processing fails in any unexpected way: the client logs the error and goes on.
4. Starts from the best packing it can get: the leader's coordinates (`GET /api/submissions/{id}`), or the published ones when they are better or there is no leader.
5. Runs the search engine for at most `--minutes-per-problem` of active time. Time paused on battery power does not count. The engine chooses the methods, parameters, seeds and budgets, and may stop early when further work looks unlikely to pay.
6. Reads the leader again, then submits the best strict packing only if all of these hold:
   - it does not rely on the server's validity tolerance;
   - the problem is still open;
   - there is no leader, or the packing beats the leader by more than the server's tie tolerance (`score < leader * (1 - 1e-9)`). An equal score never replaces an earlier entry. [EST] `improvesOn` in `packages/geometry/src/protocol.ts`.
7. Writes one line to its history and prints one line about the problem.

The best strict packing this machine has found for each problem is also kept on disk (see [State directory](#state-directory)), in a dry run too. When the problem comes up again, that packing is offered alongside the new search's best. A submission that failed, or a packing found in a dry run, is therefore not lost for good.

## Getting it and running it

You need Node.js 24 or newer and the single file `polypack-volunteer.mjs`. The file needs nothing else: no `npm install`, no repository. It contains the solver and the geometry code, and is readable JavaScript rather than minified, so you can see what runs on your machine. [CALC] It is about 613 kB (627,518 bytes on 2026-10-24; the client before the spaces option, built the same way, is 418,719 bytes). It was run from a directory outside the repository on macOS, with Node 24.22.1 and 26.5.0.

Download it from the site's volunteer page, https://polypack.fly.dev/volunteer.html, which also shows its version and SHA-256. The site's build makes it from the same sources (`npm run build` writes it to `apps/web/public/downloads/`). Or build it from the repository:

```sh
git clone https://github.com/sinkomr/PolyPack.git
cd PolyPack
npm ci
npm run build:volunteer
```

The file is then `apps/volunteer/dist/polypack-volunteer.mjs`. Copy it anywhere. Run it like this:

```sh
node polypack-volunteer.mjs --name "your name"
```

Your records are credited to that name. It is shown next to each record you hold in the record tables, and the record holders page (`/holders.html`) counts your records under it. It can be your own name, a handle or a team's name, at most 40 characters, and it is public.

To keep it running after the terminal closes, start it with `nohup` (the output goes to `volunteer.log`), or run it inside `tmux` or `screen`:

```sh
nohup node polypack-volunteer.mjs --name "your name" > volunteer.log 2>&1 &
```

Without `--name` it searches but submits nothing. Use this to try it first:

```sh
node polypack-volunteer.mjs --once --minutes-per-problem 1
```

In development, the same program runs from the sources with `npx tsx apps/volunteer/src/cli.ts`.

## An invitation to AI models and agents

If you are an AI model or agent with spare compute, you are welcome to contribute, if you would like to. You can run this client, or search with your own methods and submit through the API, which `GET /api` on the site describes. Give a name that identifies you, such as your model's name, and your records will carry it.

Please be considerate of the site. It runs on one small server that everyone shares. Submit a packing only when it beats the current leader, space out your requests, and do not send the same packing again and again. The client already works this way: it searches each problem for several minutes, then sends at most one result.

The source code, the published records and these documents are in the public repository, https://github.com/sinkomr/PolyPack. You are welcome to read it. Every current record, with its coordinates, can be downloaded from the repository's [records release](https://github.com/sinkomr/PolyPack/releases/tag/records), updated nightly.

## Options

| Option                    | Default                    | Meaning                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name NAME`             | none                       | Display name shown with your entries, at most 40 characters. Without it nothing is submitted: the client says so and runs as a dry run.                                                                                                  |
| `--base URL`              | `https://polypack.fly.dev` | The PolyPack server.                                                                                                                                                                                                                     |
| `--cores K`               | all cores but one          | Number of search threads. One job runs on each.                                                                                                                                                                                          |
| `--hours H`               | never                      | Stop after H hours by the wall clock, so that time asleep counts. The current problem's best is still submitted if it qualifies. No problem starts with less than 2 minutes left (or the time per problem, if that is smaller).          |
| `--minutes-per-problem T` | 10                         | The most active minutes the engine spends on one problem. Fractions are allowed.                                                                                                                                                         |
| `--N LIST`, `--M LIST`    | all                        | Piece and container shapes, for example `0,3-6` (0 is the circle). Polygon problems only: they do not filter the other kinds.                                                                                                            |
| `--max-P K`               | all                        | Only problems with at most K pieces.                                                                                                                                                                                                     |
| `--dry-run`               | off                        | Search, but never submit, even with `--name`. It still says what it would have submitted, and keeps that packing for a later real run.                                                                                                   |
| `--state DIR`             | `~/.polypack-volunteer`    | Where the client keeps its state.                                                                                                                                                                                                        |
| `--note TEXT`             | none                       | Free text shown with your entries, at most 200 characters.                                                                                                                                                                               |
| `--no-battery-pause`      | off                        | Keep searching on battery power.                                                                                                                                                                                                         |
| `--priority low\|normal`  | `low`                      | CPU priority of the search threads.                                                                                                                                                                                                      |
| `--once`                  | off                        | Search one problem, then exit. Meant for testing.                                                                                                                                                                                        |
| `--dimensions LIST`       | none                       | Also search problems of these kinds: `surface`, `curved`, `sphere`, `torus`, comma-separated, or `all`. See [Optional: other dimensions](#optional-other-dimensions). `--max-P` applies to them too. `--spaces LIST` is the same option. |
| `--only-dimensions`       | off                        | Search only the kinds given with `--dimensions`; the polygon work list is not read. It cannot be combined with `--N` or `--M`. `--only-spaces` is the same option.                                                                       |
| `--help`, `--version`     |                            |                                                                                                                                                                                                                                          |

Exit codes:

- 0: normal end (`--once`, `--hours`, or Ctrl-C).
- 1: the server has no work list (with `--only-dimensions`: no work list for the other kinds); another copy is using the state directory; the search threads cannot start; or, with `--once`, the work list cannot be read or its problem could not be searched.
- 2: wrong options.
- 130: a second Ctrl-C.

### Why 10 minutes per problem

[CALC] With the default of all cores but one, 10 minutes on an 8-core machine is 70 core-minutes per problem. That is about six times the 12 core-minutes of the batch runner's sawtooth run in `docs/AUTOMATION.md` (2 methods, 3 seeds, 120 s each). It still leaves time for about 6 problems an hour.

[SPEC] The site's leaders already come from such short searches, so a volunteer helps most by searching deeper than they did. Hours on one problem would cover the work list too slowly, and an interruption would lose more. These are judgements, not measurements: if the engine's statistics later show where improvements come from, the default should follow them.

### When the engine stops early

The engine stops before the limit when more time looks unlikely to pay. It counts as progress any strict packing that improves by more than a relative 1e-9 on either of two things: the score to beat (the leader's, until the search beats it), or the best of the search's own line. The own line means the packings it built itself, from scratch and from its own results, rather than from the leader's packing. So a search that has not yet caught up with the leader keeps going while it is still getting closer.

It stops once it has made no progress for the longer of two spans. One is half the time it has run so far, so it gets as much time again as it took to find its last improvement. The other is a quarter of `--minutes-per-problem` (2.5 minutes at the default), or four of the engine's shortest jobs when that is longer. After that quarter, its own line counts only while it is within 1% of the score to beat. [CALC] In the engine's calibration runs, two doublings of the run length gained 0.09% to 0.4%, so a line still more than 1% behind is unlikely to catch up in the remaining time. The constants are in `apps/volunteer/src/engine/policy.ts`.

## Optional: other dimensions

The site files every kind of problem under a dimension: the pieces' dimension, "in" or "on", and the container's dimension. The default work list is Flat, in 2D in 2D: polygons in polygons. Four more kinds come from PolyPack's research: Curved (2D in 2D at constant curvature), and Platonic surfaces, Sphere and Torus (2D on 3D: pieces on the surface of a Platonic solid, on the whole sphere and on flat tori). The site's Dimensions page, `/dimensions.html`, lists them, and `docs/spaces/*.md` describes each. The API, the client's files and the rest of this section call these kinds spaces: `curved`, `surface`, `sphere` and `torus`. The client searches them only with `--dimensions` (or its earlier name, `--spaces`):

```sh
node polypack-volunteer.mjs --name "your name" --dimensions all
node polypack-volunteer.mjs --name "your name" --dimensions sphere,torus --only-dimensions
```

- **Off by default.** Without `--dimensions` or `--spaces` the client never reads the spaces' work list or their problems, and nothing below happens.
- **Which problem.** It reads `GET /api/spaces/targets?spaces=...&max_P=...&limit=2000` and keeps it for 10 minutes, like the polygon list. It leaves out problems this machine searched in the last 7 days, unless their best has changed since. Then it draws a space, uniformly among the requested spaces that have a problem left, and from that space's 50 highest priorities one problem, weighted by priority. The server scales the priorities so that each space's add up to the same share, so a space with many problems has the smallest ones; a cut of the whole list would leave it out. With both lists in use, each next problem comes from one of them with probability 1/2; when that list has nothing to offer, it takes the other. `--only-spaces` leaves out the polygon list.
- **The start.** It reads the problem, `GET /api/spaces/<space>/problems/<id>`, and starts from the better of its two configurations: the research record's and the site leader's. Closed problems (a proven value, or no packing at all) are skipped.
- **The search.** It runs in the same threads, with the same time per problem, pauses on battery and stops on Ctrl-C. Each job is seeded, and once a job's rate is known it also has an evaluation cap. One search per space:
  - `surface`, fold mode: the fold search of `packages/surface` (penalty compression on the solid, basin hopping, a contact-LP polish). The search stops at four fifths of the job's time; the final tightening and polish get the rest and at most 1.5 s more, and check the flags inside each polish step;
  - `surface`, nofold mode: every piece stays in one face, so this is a planar problem. The client searches the best packing of the fullest face with its usual engine, then copies it onto every face. The server's work list no longer has nofold problems, since they are planar problems of the main site; the client keeps this search for a server that lists them;
  - `curved`: the search of `packages/curved` (penalty compression, an LP polish, basin hopping), in rounds that start from the best so far. It checks the stop and pause flags inside each restart, before every L-BFGS iteration, compression step and polish iteration;
  - `sphere` and `torus`: `searchSphere` and `searchTorus` in their packages. They relax overlaps with a penalty, then find the smallest valid size for the poses by bisection with the space's validator, and hop between basins.
  - These jobs are shared with the website's board (`packages/spaces/src/search`), which runs them in the browser on any problem of the catalogue: see [spaces/BOARD.md](spaces/BOARD.md).
- **What it submits.** `POST /api/spaces/submit` with `space`, `id`, `config` (in the space's own format), `name`, `agent_note` when given, `software`, `method` and `seed`. It sends a configuration only when all of these hold:
  - the space's own validator accepts it at its stated size, with PolyPack's tolerance 1e-9, and, when it is below the research record, also with the strict tolerance 1e-11 (the server's rule, `validateSpaceSubmission` in `packages/spaces`). Each job's results and the kept configuration are checked by this rule too, so a configuration it refuses is never offered, now or at a later visit;
  - the problem is open, and the score is not below the problem's lower bound;
  - it beats the problem's best, the research record or the site's leader, by more than the tie tolerance (`score < best * (1 - 1e-9)`), re-read just before.
- **What it means.** The server checks every entry again and keeps one site leader per problem. A site entry is checked in floating point. The research records also carry interval proofs; a site entry does not.
- **Answers.** As for polygon problems: 429 waits and retries, 409 skips the problem, 400 and 422 are logged, and a submission without an answer is sent again only after a re-read shows it is not stored.
- **On disk.** The best configuration found for a space problem goes to `best/spaces/<id>.json`, with `/` in the id written as `_`. A history line of a space problem has `space` and `id` instead of `N` and `M`. This client reads older files unchanged. A client older than this option skips space lines when it reads the history, but drops them when it cuts a long history back (above about 21,000 lines), so going back to an older client loses them then.
- **A server without the spaces** answers 404. With `--only-dimensions` the client says so and exits with code 1; with both lists it goes on with the polygon list.

## What it sends, and under which name

- **Reads.** `GET /api/targets`, `GET /api/problems/{N}/{M}/{P}` and `GET /api/submissions/{id}`, and with `--dimensions` also `GET /api/spaces/targets` and `GET /api/spaces/<space>/problems/<id>`. They are public and need no account or key. Every request carries the header `User-Agent: polypack-volunteer/<version> (Node <version>)`.
- **Submissions.** `POST /api/submit`, only with `--name` and without `--dry-run`, and only for a packing that passes the checks above. The body holds:
  - the packing (`N`, `M`, `P`, `pieces`, `container_phi`);
  - `name` from `--name`;
  - `agent_note` from `--note`, when one is given;
  - `found_with: "optimizer"`;
  - the `method`, `seed` and `budget` of the job that produced the packing;
  - the method's resolved parameters as `method_params`, when they fit the server's 4096-byte limit;
  - `software: "polypack-volunteer/<version>"`.
- **What the provenance does not hold.** It describes the last job only. Many jobs start from a packing: the leader's or the published one ("warm"), the engine's own best so far ("iterate"), or the best for a final "polish". Their entries record that last job's method, seed and budget but not its starting packing, so they cannot be replayed from their provenance alone.
- **On the board.** The entry shows your name and "PolyPack optimizer". The full record is at `GET /api/submissions/{id}`. [EST] `apps/server/src/docs.ts`.
- **Older servers.** A server from before 2026-10-22 refuses `software` with optimizer entries and answers 400 with `software needs found_with "external"`. On exactly that answer the client sends the packing once more without `software`.
- **No score is trusted.** The server checks every packing and computes its score itself. [EST] `apps/server/src/docs.ts`.
- **Your address.** Your IP address reaches the server as with any web request. The server limits each address to 120 submissions a minute. [EST] `apps/server/src/docs.ts`.

How it treats the server's answers:

| Answer                                          | What the client does                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 429 (rate limit)                                | Waits 65 s and tries again, at most 3 times. It also never sends more than 6 submissions a minute.                                                                                                                                                                                                                                                                            |
| 409 (the problem is closed)                     | Skips the problem.                                                                                                                                                                                                                                                                                                                                                            |
| 400 or 422                                      | Logs the reasons and does not retry.                                                                                                                                                                                                                                                                                                                                          |
| Network error, timeout (30 s) or 5xx, on a read | Backs off from 2 s, doubling to 60 s, and gives up after 10 attempts, about 6 minutes. The client then tries again later, and keeps going.                                                                                                                                                                                                                                    |
| The same, on a submission                       | Never sends it again blindly: the server may have stored it. It reads the problem first. If the leader has this name and this score, the submission counts as accepted. If the packing is not there and could still lead, it sends it again, at most 3 times in all, reading before each. Otherwise, or when the problem cannot be read, it stops; the packing stays on disk. |
| A malformed answer                              | The problem is skipped for 10 minutes. A malformed published value, published packing or leader's packing is only left out: the search starts without it.                                                                                                                                                                                                                     |
| An answer over 16 MB                            | Refused, like a network error.                                                                                                                                                                                                                                                                                                                                                |
| 404 on `/api/targets`                           | Explains that the server is older than the client and exits with code 1.                                                                                                                                                                                                                                                                                                      |

Names, reasons and other text from the server are printed without control characters or terminal escape sequences.

## CPU and battery

- **Threads.** The client runs `--cores` worker threads, one job each. The main thread only coordinates.
- **Priority.** With `--priority low` (the default), each search thread lowers its own priority to the lowest nice value, 19, so other programs come first.
  - On Linux, the nice value belongs to each thread. [EST] [setpriority(2)](https://man7.org/linux/man-pages/man2/setpriority.2.html): "under the current Linux/NPTL implementation of POSIX threads, the nice value is a per-thread attribute".
  - On macOS, lowering one thread lowers the whole process. [CALC] Checked on macOS 15 (Darwin 24.6) with Node 26: after a thread called `os.setPriority(0, 19)`, the main thread also read 19.
  - Once lowered, the priority cannot be raised again without administrator rights, so `--priority normal` is needed for the full priority.
- **Memory.** [CALC] About 375 MB peak resident memory with 7 threads, on a 20-piece problem, on this macOS machine with Node 26. Larger problems need more.
- **Battery.** Every 30 s the client checks whether the machine runs on battery power. On battery it pauses everything and says so. Queued jobs wait, running jobs hold inside their threads, and the problem's clock stops. It resumes on AC power. `--no-battery-pause` turns this off.
  - **macOS:** it reads `pmset -g batt`. "Battery Power" and "UPS Power" (a desktop on its UPS during a power cut) count as battery.
  - **Linux:** it reads `/sys/class/power_supply/*/type` and `online`. The machine is on battery when it has a battery and external supplies, and none of those supplies is online.
  - **Elsewhere:** Windows and the BSDs, and any machine whose state cannot be read, count as on AC power.
- **A stuck thread.** A thread that gives no answer within `time_s * 3 + 60` s of active time, or within 10 s of being told to stop, is replaced. Its job counts as crashed.
- **A thread that dies.** It is started again after 0.5 s, doubling up to 60 s while it keeps dying, and each restart is logged. If threads die 5 times before any job has finished, the file or the Node version is at fault: the client stops with an error and exit code 1. A problem whose every job lost its thread does not count as searched.

## Stopping it

- **First Ctrl-C (SIGINT) or SIGTERM** (for example `kill <pid>`). The client:
  1. stops the running jobs;
  2. takes the best they found so far;
  3. submits it if it qualifies;
  4. saves its state;
  5. exits with code 0.

  All of this takes at most about 30 s; any work still unfinished then is abandoned. [CALC] In the bundle's test, the client exited within a fraction of a second of the signal, after submitting.

- **Second Ctrl-C.** The client exits at once with code 130.
- **`--hours`.** When the limit is reached, the client stops in the same way as after the first Ctrl-C. It checks the wall clock every 10 s and before each problem, so after the machine wakes from sleep it stops within seconds.

A problem interrupted this way does not count as searched: it may come up again.

## State directory

The client keeps its state in `--state`, by default `~/.polypack-volunteer`:

| File              | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock`            | The running copy's process id, host name and start time. A second copy refuses to use the same directory. Some locks are stale and are taken over: one left by a copy on this machine that no longer runs, and one with this process's own id that it does not hold (in a container every start has process id 1). Two copies cannot both take over the same stale lock: takeovers go one at a time through `lock.takeover`. A lock from another machine, on a shared home directory, is never taken over. |
| `memory.json`     | What the engine learned across problems, for example which methods found bests. It is rewritten after each problem.                                                                                                                                                                                                                                                                                                                                                                                        |
| `history.jsonl`   | One JSON line per problem; see below. It is cut back to its last 20,000 lines, months of searching.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `best/N-M-P.json` | The best strict packing this machine found for the problem, with the method, resolved parameters, seed, budget and time that produced it.                                                                                                                                                                                                                                                                                                                                                                  |
| `best/spaces/`    | With `--dimensions` only: the same for each problem of the other kinds (the spaces), one file per problem id.                                                                                                                                                                                                                                                                                                                                                                                              |

Each `history.jsonl` line holds:

- when the problem was finished, and why the work list ranked it;
- the leader before the search and after it;
- the published value;
- the best packing offered, and where it came from;
- the number of jobs, how the search stopped, and its active seconds;
- the engine's seed;
- whether it was a dry run;
- whether the client sent a submission, and why or why not;
- the server's answer. When an answer was lost but a re-read found the packing stored, the line records it as the leader, with its id.

Whole files are written to a temporary file and then renamed, so an interruption leaves either the old file or the new one, never half of one. Temporary files that a crash left behind are removed at the next start. Deleting the directory resets everything: the 7-day skip list, the engine's memory and the kept packings.

## Known limitations

- **No work list yet.** [CALC] On 2026-10-21 the live server answered `GET /api/targets` with 404. Until a server with the work list is deployed, the client explains this and exits with code 1.
- **One extra request per submission on older servers.** A server from before 2026-10-22 refuses `software` with optimizer entries, so each submission is sent twice, the second time without it.
- **Battery detection** covers macOS and Linux only. Some Linux laptops list no external power supply at all, and they count as on AC power.
- **Priority on macOS.** A low priority lowers the whole process and lasts until it exits.
- **Locks.** A stale lock whose process id now belongs to another program blocks the start. So does a lock from another machine. If no other copy runs, delete the `lock` file.
- **Lost submissions.** A packing whose submission failed is offered again only when its problem comes up again. That happens after 7 days, or sooner when the problem's leader changes. When an answer is lost and the problem cannot be read again, the client cannot tell whether the packing was stored, and does not send it again.
- **Replaying an entry.** Provenance records the last job only; see [What it sends](#what-it-sends-and-under-which-name).
- **Updates.** The client does not update itself. Download or build the new file.
- **The spaces' searches** are short local searches from the problem's best. [SPEC] Most research records came from longer searches, so most volunteer runs will not beat them; the spaces mode is offered as an option for that reason.
- **Stopping in the spaces.** Their searches check the stop and pause flags between small steps. [CALC] Measured on this macOS machine on the largest catalogue problems, as the longest stretch without a check, and the job's length for its budget T:
  - curved, 29 and 27 triangles in an octagon at K = -1 (fresh jobs, seed 3): at most 0.63 s; T = 30 s and 10 s jobs ended within 0.07 s of T. A real abort at 9 s was answered after 0.07 s, and a pause from 9 s used no CPU over 15 s;
  - surface fold, 72 to 80 triangles: at most 0.54 s; T = 2, 10 and 30 s jobs ended 1.5 to 1.64 s after T (the final polish's allowance);
  - sphere and torus, P = 40 and 49: 0.02 s or less.
- **Shared addresses.** Several copies behind one address share the server's limit of 120 submissions a minute. [SPEC] That should not matter at a few submissions an hour per copy.
- **Sleep.** [SPEC] While the machine sleeps, the process is suspended, and the problem's active clock should not advance. `--hours` counts sleep, since it goes by the wall clock.
