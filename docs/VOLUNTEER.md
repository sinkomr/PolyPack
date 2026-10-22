# Volunteer client

`polypack-volunteer` lets anyone give spare CPU time to PolyPack, in the way volunteer computing projects such as Folding@home work. You download one file and run it with Node, in the background. It takes problems from the server's ranked work list one at a time and searches each with many methods, seeds and budgets on the cores it is given. It submits a result only when the result beats the site's current leader, then moves on.

It is a plain command-line program with no game in it. The Tighter idle game is unrelated.

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

You need Node.js 24 or newer and the single file `polypack-volunteer.mjs`. The file needs nothing else: no `npm install`, no repository. It contains the solver and the geometry code, and is readable JavaScript rather than minified, so you can see what runs on your machine. [CALC] It is about 400 kB. It was run from a directory outside the repository on macOS, with Node 24.22.1 and 26.5.0.

Until the file is published for download, build it from the repository:

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

To keep it running after the terminal closes, start it with `nohup` (the output goes to `volunteer.log`), or run it inside `tmux` or `screen`:

```sh
nohup node polypack-volunteer.mjs --name "your name" > volunteer.log 2>&1 &
```

Without `--name` it searches but submits nothing. Use this to try it first:

```sh
node polypack-volunteer.mjs --once --minutes-per-problem 1
```

In development, the same program runs from the sources with `npx tsx apps/volunteer/src/cli.ts`.

## Options

| Option                    | Default                    | Meaning                                                                                                                                                                                                                         |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name NAME`             | none                       | Display name shown with your entries, at most 40 characters. Without it nothing is submitted: the client says so and runs as a dry run.                                                                                         |
| `--base URL`              | `https://polypack.fly.dev` | The PolyPack server.                                                                                                                                                                                                            |
| `--cores K`               | all cores but one          | Number of search threads. One job runs on each.                                                                                                                                                                                 |
| `--hours H`               | never                      | Stop after H hours by the wall clock, so that time asleep counts. The current problem's best is still submitted if it qualifies. No problem starts with less than 2 minutes left (or the time per problem, if that is smaller). |
| `--minutes-per-problem T` | 10                         | The most active minutes the engine spends on one problem. Fractions are allowed.                                                                                                                                                |
| `--N LIST`, `--M LIST`    | all                        | Piece and container shapes, for example `0,3-6` (0 is the circle).                                                                                                                                                              |
| `--max-P K`               | all                        | Only problems with at most K pieces.                                                                                                                                                                                            |
| `--dry-run`               | off                        | Search, but never submit, even with `--name`. It still says what it would have submitted, and keeps that packing for a later real run.                                                                                          |
| `--state DIR`             | `~/.polypack-volunteer`    | Where the client keeps its state.                                                                                                                                                                                               |
| `--note TEXT`             | none                       | Free text shown with your entries, at most 200 characters.                                                                                                                                                                      |
| `--no-battery-pause`      | off                        | Keep searching on battery power.                                                                                                                                                                                                |
| `--priority low\|normal`  | `low`                      | CPU priority of the search threads.                                                                                                                                                                                             |
| `--once`                  | off                        | Search one problem, then exit. Meant for testing.                                                                                                                                                                               |
| `--help`, `--version`     |                            |                                                                                                                                                                                                                                 |

Exit codes:

- 0: normal end (`--once`, `--hours`, or Ctrl-C).
- 1: the server has no work list; another copy is using the state directory; the search threads cannot start; or, with `--once`, the work list cannot be read or its problem could not be searched.
- 2: wrong options.
- 130: a second Ctrl-C.

### Why 10 minutes per problem

[CALC] With the default of all cores but one, 10 minutes on an 8-core machine is 70 core-minutes per problem. That is about six times the 12 core-minutes of the batch runner's sawtooth run in `docs/AUTOMATION.md` (2 methods, 3 seeds, 120 s each). It still leaves time for about 6 problems an hour.

[SPEC] The site's leaders already come from such short searches, so a volunteer helps most by searching deeper than they did. Hours on one problem would cover the work list too slowly, and an interruption would lose more. These are judgements, not measurements: if the engine's statistics later show where improvements come from, the default should follow them.

### When the engine stops early

The engine stops before the limit when more time looks unlikely to pay. It counts as progress any strict packing that improves by more than a relative 1e-9 on either of two things: the score to beat (the leader's, until the search beats it), or the best of the search's own line. The own line means the packings it built itself, from scratch and from its own results, rather than from the leader's packing. So a search that has not yet caught up with the leader keeps going while it is still getting closer.

It stops once it has made no progress for the longer of two spans. One is half the time it has run so far, so it gets as much time again as it took to find its last improvement. The other is a quarter of `--minutes-per-problem` (2.5 minutes at the default), or four of the engine's shortest jobs when that is longer. After that quarter, its own line counts only while it is within 1% of the score to beat. [CALC] In the engine's calibration runs, two doublings of the run length gained 0.09% to 0.4%, so a line still more than 1% behind is unlikely to catch up in the remaining time. The constants are in `apps/volunteer/src/engine/policy.ts`.

## What it sends, and under which name

- **Reads.** `GET /api/targets`, `GET /api/problems/{N}/{M}/{P}` and `GET /api/submissions/{id}`. They are public and need no account or key. Every request carries the header `User-Agent: polypack-volunteer/<version> (Node <version>)`.
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
- **Shared addresses.** Several copies behind one address share the server's limit of 120 submissions a minute. [SPEC] That should not matter at a few submissions an hour per copy.
- **Sleep.** [SPEC] While the machine sleeps, the process is suspended, and the problem's active clock should not advance. `--hours` counts sleep, since it goes by the wall clock.
