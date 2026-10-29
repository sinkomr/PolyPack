/**
 * End to end: the client's main loop against the in-process fake server, with real worker
 * threads. Nothing here talks to a real server.
 *
 * Most tests stand in a small engine that runs one real solver job capped by evaluations, so that
 * the outcome is the same on a fast machine and on a loaded CI runner; one test runs the real
 * engine and asserts only what does not depend on speed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MainDeps, main } from "../src/main";
import type { HistoryLine } from "../src/state";
import type { Candidate, Job, JobResult, SearchProblem } from "../src/types";
import { SOFTWARE } from "../src/version";
import { type FakeProblem, type FakeServer, LOOSE_SQUARES, scoreOf, startFakeServer } from "./fake-server";

let dir: string;
let server: FakeServer | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-cli-"));
});
afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the client in this process; its output is collected instead of printed, and `onLine` sees
 * each line as it comes. Unless `deps` gives a battery check, the battery is not watched.
 */
async function clientWith(argv: string[], deps: MainDeps = {}, onLine?: (line: string) => void) {
  const lines: string[] = [];
  const take = (l: string) => {
    lines.push(l);
    onLine?.(l);
  };
  const code = await main(
    [
      "--base",
      server!.url,
      "--state",
      join(dir, "state"),
      "--cores",
      "2",
      ...(argv.includes("--minutes-per-problem") ? [] : ["--minutes-per-problem", "0.05"]),
      // a low priority could not be raised again for the rest of the test run
      "--priority",
      "normal",
      ...(deps.checkBattery ? [] : ["--no-battery-pause"]),
      ...argv,
    ],
    { out: take, err: take, signals: false, searchProblem: oneJob, kinds: server!.kinds(), ...deps },
  );
  return { code, output: lines.join("\n") };
}
const client = (...argv: string[]) => clientWith(argv);

/** A random source that returns the given values in turn, again and again. */
const cycle = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const history = (): HistoryLine[] =>
  readFileSync(join(dir, "state", "history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

const candidateOf = (r: JobResult, job: Job): Candidate | null =>
  r.valid && r.strict && r.best && r.score !== null
    ? { config: r.best, score: r.score, strict: true, job, params: r.params }
    : null;

/**
 * A stand-in engine: one real asc job through the real pool, ended by its evaluation cap or by
 * completing (the time budget is only a ceiling), so that its result does not depend on speed.
 */
const oneJob: SearchProblem = async (input, runJob, control) => {
  const job: Job = {
    problem: input.problem,
    method: "asc",
    seed: 1,
    budget: { time_s: 300, evals: 20_000 },
    kind: "fresh",
  };
  const r = await runJob(job, control);
  const best = candidateOf(r, job);
  input.onResult?.(r, best);
  return { best, jobs: 1, stopped: control.aborted ? "aborted" : "time", memory: input.memory ?? null };
};

/** One job as above, then nothing until the host aborts the search. */
const bestThenWait: SearchProblem = async (input, runJob, control) => {
  const first = await oneJob(input, runJob, control);
  while (!control.aborted) await delay(20);
  return { ...first, stopped: "aborted" };
};

/** An engine that finds nothing. */
const nothing: SearchProblem = async (input) => ({
  best: null,
  jobs: 0,
  stopped: "time",
  memory: input.memory ?? null,
});

/** Two problems with easy leaders: three squares (side 2.5, best 2) and two circles (radius 2.5, best 2). */
const TWO_CIRCLES: FakeProblem = {
  N: 0,
  M: 0,
  P: 2,
  leader: {
    name: "Someone",
    container_phi: 0,
    pieces: [
      { x: -1.5, y: 0, theta: 0 },
      { x: 1.5, y: 0, theta: 0 },
    ],
  },
};

/** A problem that keeps asc busy for its whole budget. */
const PENTAGONS: FakeProblem = {
  N: 5,
  M: 5,
  P: 20,
  leader: {
    name: "Someone",
    container_phi: 0,
    pieces: Array.from({ length: 20 }, (_, i) => ({ x: 2 * i, y: 0, theta: 0 })),
  },
};

describe("the client, end to end", () => {
  // Real solver work: one evaluation-capped job on two threads, plus building the thread bundle.
  it("searches one problem and submits a result that beats the leader", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES], refuseSoftware: true });
    const before = server.leaderOf(4, 4, 3)!;
    expect(before.score).toBeCloseTo(2.5, 9);

    const { code, output } = await client("--once", "--name", "Test volunteer", "--note", "e2e");
    expect(code, output).toBe(0);

    const paths = server.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual([
      "GET /api/problems/4/4/3",
      `GET /api/submissions/${before.id}`,
      "GET /api/problems/4/4/3", // the leader again, just before submitting
      "POST /api/submit",
      "POST /api/submit", // without `software`, which this server refuses
    ]);
    const [first, second] = server.submissions;
    expect(first.software).toBe(SOFTWARE);
    expect(second).not.toHaveProperty("software");
    expect(second).toMatchObject({
      N: 4,
      M: 4,
      P: 3,
      name: "Test volunteer",
      agent_note: "e2e",
      found_with: "optimizer",
      method: "asc",
      seed: 1,
      budget: { time_s: 300, evals: 20_000 },
    });
    expect(scoreOf(second as never)!).toBeLessThan(2.1);
    const after = server.leaderOf(4, 4, 3)!;
    expect(after.name).toBe("Test volunteer");

    const state = join(dir, "state");
    expect(readdirSync(state).sort()).toEqual(["best", "history.jsonl", "memory.json", "state.json"]); // the lock is gone
    const best = JSON.parse(readFileSync(join(state, "best", "4-4-3.json"), "utf8"));
    expect(best).toMatchObject({ N: 4, M: 4, P: 3, strict: true, method: "asc", seed: 1 });
    const [line] = history();
    expect(line).toMatchObject({
      N: 4,
      M: 4,
      P: 3,
      leader_before: { id: before.id, score: before.score },
      leader_after: { id: after.id },
      dry_run: false,
      submitted: true,
      decision: "better than the leader",
      status: 200,
      response: { valid: true, leader: true, id: after.id },
    });
    expect(output).toMatch(/Searching N=4 M=4 P=3/);
    expect(output).toMatch(/sending again without it/);
    // fix 8: compared with the leader before the search, not with the new entry
    expect(output).toMatch(
      new RegExp(
        `Finished N=4 M=4 P=3 .*vs leader 2\\.500000 \\(-2\\d\\.\\d{3}%\\); submitted: HTTP 200, the new leader \\(#${after.id}\\)`,
      ),
    );
  });

  // Real solver work, as above.
  it("in a dry run, says what it would submit and sends nothing", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    const { code, output } = await client("--once");
    expect(code, output).toBe(0);
    expect(output).toMatch(/dry run: nothing is submitted, because no --name was given/);
    expect(output).toMatch(/dry run: would submit/);
    expect(server.submissions).toEqual([]);
    expect(history()[0]).toMatchObject({ submitted: false, dry_run: true, decision: "dry run: would submit" });
  });

  // Real solver work, as above.
  it(
    "does not submit when the leader is better, and with no other problem searches it again",
    { timeout: 60_000 },
    async () => {
      // three squares cannot beat side 2; a leader of side 2 cannot be improved
      const optimal = {
        ...LOOSE_SQUARES,
        leader: {
          ...LOOSE_SQUARES.leader!,
          pieces: [
            { x: 0, y: 0, theta: Math.PI / 4 },
            { x: 1, y: 0, theta: Math.PI / 4 },
            { x: 0, y: 1, theta: Math.PI / 4 },
          ],
        },
      };
      server = await startFakeServer({ problems: [optimal] });
      const first = await client("--once", "--name", "Test volunteer");
      expect(first.code, first.output).toBe(0);
      expect(server.submissions).toEqual([]);
      expect(history()[0]).toMatchObject({ submitted: false, decision: "not better than the leader" });

      // searched here today, but the draw has nothing else to offer: searched again rather than waited for
      const second = await client("--once", "--name", "Test volunteer");
      expect(second.code, second.output).toBe(0);
      expect(second.output).toMatch(/Searching N=4 M=4 P=3: leader/);
      expect(history()).toHaveLength(2);
    },
  );

  // Real solver work: two 2 s jobs (active time) on twenty pentagons, paused for about 1 s once
  // the search has started. The pause is triggered by the client's own output, not by a clock.
  it("pauses on battery power, without counting the pause, and prints status lines", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [PENTAGONS] });
    const twoJobs: SearchProblem = async (input, runJob, control) => {
      const jobs: Job[] = [1, 2].map((seed) => ({
        problem: input.problem,
        method: "asc",
        seed,
        budget: { time_s: 2 },
        kind: "fresh",
      }));
      const results = await Promise.all(jobs.map((job) => runJob(job, control)));
      for (const r of results) input.onResult?.(r, null);
      return { best: null, jobs: 2, stopped: "time", memory: null };
    };
    let pauseFrom = Infinity;
    const checkBattery = async () => Date.now() >= pauseFrom && Date.now() < pauseFrom + 1000;
    const t0 = Date.now();
    const { code, output } = await clientWith(
      ["--once"],
      { checkBattery, batteryEveryMs: 20, statusEveryMs: 50, searchProblem: twoJobs },
      (line) => {
        if (/Searching N=5 M=5 P=20/.test(line)) pauseFrom = Date.now() + 200;
      },
    );
    const wall = (Date.now() - t0) / 1000;
    expect(code, output).toBe(0);
    expect(output).toMatch(/On battery power: paused/);
    expect(output).toMatch(/On AC power: resuming/);
    expect(output).toMatch(
      /Status: N=5 M=5 P=20, \d+s of 3s; best none yet vs leader \d+\.\d{6}; 0 job\(s\) run; threads 0 busy, 2 paused, 0 idle; 0 submission\(s\) accepted; paused on battery power/,
    );
    expect(output).toMatch(/Status: N=5 M=5 P=20, .*threads 2 busy, 0 paused, 0 idle/);
    // the host's active clock left the pause out
    expect(history()[0].active_s).toBeLessThan(wall - 0.8);
  });

  // Real solver work, as above (one evaluation-capped job per problem).
  it(
    "in a dry run, keeps its best for the real run and does not keep the real run away (fix 6)",
    { timeout: 60_000 },
    async () => {
      server = await startFakeServer({ problems: [LOOSE_SQUARES] });
      const dry = await client("--once");
      expect(dry.code, dry.output).toBe(0);
      expect(dry.output).toMatch(/dry run: would submit/);
      expect(server.submissions).toEqual([]);

      // the real run searches the same problem at once; its engine finds nothing, so the dry run's
      // kept packing is what it submits
      const real = await clientWith(["--once", "--name", "Test volunteer"], { searchProblem: nothing });
      expect(real.code, real.output).toBe(0);
      expect(real.output).not.toMatch(/Nothing to search/);
      expect(real.output).toMatch(/from an earlier search\) vs leader 2\.500000 .*submitted: HTTP 200, the new leader/);
      expect(server.submissions).toHaveLength(1);
      expect(history().map((l) => l.dry_run)).toEqual([true, false]);
      expect(history()[1].best).toMatchObject({ from: "file", method: "asc", seed: 1 });
    },
  );

  // Real solver work: one evaluation-capped job per problem.
  it(
    "stops at the --hours limit by the wall clock, also after the machine slept (fix 3)",
    { timeout: 60_000 },
    async () => {
      server = await startFakeServer({ problems: [LOOSE_SQUARES, TWO_CIRCLES] });
      // the wall clock jumps two hours once the first problem is done, as after a sleep: timers do
      // not see that, the wall clock does
      let offset = 0;
      const { code, output } = await clientWith(
        ["--name", "Test volunteer", "--hours", "1", "--minutes-per-problem", "1"],
        { now: () => Date.now() + offset },
        (line) => {
          if (/^\[.*\] Finished/.test(line)) offset += 2 * 3600_000;
        },
      );
      expect(code, output).toBe(0);
      expect(output).toMatch(/The --hours limit \(1 h\) is reached: stopping/);
      expect(history()).toHaveLength(1);
      expect(server.submissions).toHaveLength(1);
    },
  );

  it("does not start a problem with too little of --hours left (fix 3)", { timeout: 30_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    const { code, output } = await client("--name", "Test volunteer", "--hours", "0.03", "--minutes-per-problem", "10");
    expect(code, output).toBe(0);
    expect(output).toMatch(/Only 1m48s of the --hours limit \(0.03 h\) is left, too little for another problem/);
    expect(server.requests).toEqual([]);
  });

  // Real solver work: one evaluation-capped job, then a search that only an abort ends.
  it("aborts a running search at the --hours limit and submits what it has (fix 3)", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    let offset = 0;
    const { code, output } = await clientWith(
      ["--name", "Test volunteer", "--hours", "1", "--minutes-per-problem", "50"],
      { now: () => Date.now() + offset, deadlineCheckMs: 20, searchProblem: bestThenWait },
      (line) => {
        if (/best so far/.test(line)) offset += 2 * 3600_000;
      },
    );
    expect(code, output).toBe(0);
    expect(output).toMatch(/The --hours limit \(1 h\) is reached: stopping\. The search is aborted/);
    expect(history()).toMatchObject([{ stopped: "aborted", submitted: true, status: 200 }]);
    expect(server.submissions).toHaveLength(1);
  });

  // Fix 1. Real solver work: one evaluation-capped job.
  for (const lost of ["drop", 502] as const) {
    it(
      `does not send again when an answer is lost (${lost}) but the packing was stored`,
      { timeout: 60_000 },
      async () => {
        server = await startFakeServer({
          problems: [LOOSE_SQUARES],
          afterSubmit: (n) => (n === 0 ? (lost === "drop" ? "drop" : { status: 502, body: "Bad Gateway" }) : undefined),
        });
        const { code, output } = await client("--once", "--name", "Test volunteer");
        expect(code, output).toBe(0);
        expect(server.submissions).toHaveLength(1);
        expect(server.stored()).toBe(1);
        const leader = server.leaderOf(4, 4, 3)!;
        expect(leader.name).toBe("Test volunteer");
        expect(output).toMatch(
          new RegExp(`no answer came \\(.*\\), but the problem now shows it as the leader \\(#${leader.id}\\)`),
        );
        expect(history()[0]).toMatchObject({
          submitted: true,
          status: null,
          response: { valid: true, leader: true, id: leader.id },
          leader_after: { id: leader.id },
        });
      },
    );
  }

  // Fix 2. Real solver work where a search runs: one evaluation-capped job.
  it("skips a problem whose answer is malformed, without crashing", { timeout: 60_000 }, async () => {
    for (const site_best of [
      { id: 1, name: "x" },
      { id: 1, name: "x", score: "2.5" },
    ]) {
      server = await startFakeServer({
        problems: [LOOSE_SQUARES],
        mangle: (path, body) => (path.startsWith("/api/problems/") ? { ...(body as object), site_best } : body),
      });
      const { code, output } = await client("--once", "--name", "Test volunteer");
      expect(code, output).toBe(1); // --once: its problem could not be searched
      expect(output).toMatch(/Could not read N=4 M=4 P=3 \(malformed answer\); skipping it for 10 minutes/);
      expect(server.submissions).toEqual([]);
      await server.close();
    }
    server = null;
  });

  it(
    "searches on when only the published value or the leader's packing is malformed",
    { timeout: 60_000 },
    async () => {
      server = await startFakeServer({
        problems: [LOOSE_SQUARES],
        mangle: (path, body) => {
          const b = body as Record<string, unknown>;
          if (path.startsWith("/api/problems/"))
            return { ...b, literature: { value: "2.1", pieces: "none", display: "2.1", status: "best_known" } };
          if (path.startsWith("/api/submissions/")) return { ...b, pieces: [null, null, null] };
          return body;
        },
      });
      const { code, output } = await client("--once", "--name", "Test volunteer");
      expect(code, output).toBe(0);
      expect(output).toMatch(/Could not read the leader's packing #\d+ \(malformed answer\)/);
      expect(output).toMatch(/published none.*starting from nothing/);
      expect(server.submissions).toHaveLength(1);
    },
  );

  it("contains an unexpected error to its problem and goes on (fix 2)", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES, TWO_CIRCLES] });
    // the engine breaks the contract on one problem: a "best" without a packing; after the other
    // problem the fake clock below jumps past the --hours limit, which ends the run
    let offset = 0;
    const broken: SearchProblem = async (input, runJob, control) => {
      if (input.problem.P === 3)
        return { best: { score: 1, strict: true } as Candidate, jobs: 0, stopped: "time", memory: null };
      const r = await oneJob(input, runJob, control);
      offset += 2 * 3600_000;
      return r;
    };
    // the first draw is LOOSE_SQUARES (the first fixture), the second TWO_CIRCLES
    const once = await clientWith(["--once", "--name", "Test volunteer"], {
      searchProblem: broken,
      random: cycle(0, 0),
    });
    expect(once.code, once.output).toBe(1);
    expect(once.output).toMatch(/Skipping N=4 M=4 P=3 for 10 minutes after an unexpected error: TypeError/);

    // without --once the client carries on with the other problem; a fake clock that sleeps
    // instantly lets the --hours limit end the run
    const run = await clientWith(["--name", "Test volunteer", "--hours", "1"], {
      searchProblem: broken,
      random: cycle(0, 0, 0.75, 0.75),
      now: () => Date.now() + offset,
      sleep: async (ms, signal) => {
        if (signal?.aborted) throw new Error("aborted");
        offset += ms;
      },
    });
    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/Skipping N=4 M=4 P=3 for 10 minutes/);
    expect(run.output).toMatch(/Finished N=0 M=0 P=2 .*submitted: HTTP 200/);
    expect(server.leaderOf(0, 0, 2)!.name).toBe("Test volunteer");
  });

  // Real solver work: one evaluation-capped job on each of the two threads, at the same time.
  it(
    "searches several problems at once with --parallel-problems, each on its share of the threads",
    { timeout: 60_000 },
    async () => {
      server = await startFakeServer({ problems: [LOOSE_SQUARES, TWO_CIRCLES] });
      let active = 0;
      let most = 0;
      const lanes: number[] = [];
      const searched: string[] = [];
      let release!: () => void;
      const together = new Promise<void>((resolve) => (release = resolve));
      let bothDone!: () => void;
      const allDone = new Promise<void>((resolve) => (bothDone = resolve));
      const both: SearchProblem = async (input, runJob, control) => {
        active++;
        most = Math.max(most, active);
        lanes.push(input.lanes);
        searched.push(`${input.problem.N}/${input.problem.M}/${input.problem.P}`);
        if (active === 2) release();
        // the first search waits for the second to start, so that they run at the same time
        await Promise.race([together, delay(10_000)]);
        try {
          return await oneJob(input, runJob, control);
        } finally {
          active--;
          // the two end together, and then the fake clock jumps past the --hours limit, which ends the run
          // before either slot draws again
          if (active === 0) {
            offset += 2 * 3600_000;
            bothDone();
          } else await Promise.race([allDone, delay(10_000)]);
        }
      };
      // a fake clock that moves on only while no search runs: the --hours limit ends the run once both are done
      let offset = 0;
      const run = await clientWith(["--name", "Test volunteer", "--hours", "1", "--parallel-problems", "2"], {
        searchProblem: both,
        // the slots draw LOOSE_SQUARES and TWO_CIRCLES (a slot does not draw the other's problem)
        random: cycle(0, 0, 0.75, 0.75),
        statusEveryMs: 100,
        now: () => Date.now() + offset,
        sleep: async (ms, signal) => {
          if (signal?.aborted) throw new Error("aborted");
          if (active > 0) await delay(Math.min(ms, 20));
          else offset += ms;
        },
      });
      expect(run.code, run.output).toBe(0);
      // two searches at once, one thread each (--cores 2), on different problems
      expect(most).toBe(2);
      expect(lanes).toEqual([1, 1]);
      expect(searched.sort()).toEqual(["0/0/2", "4/4/3"]);
      expect(run.output).toMatch(/2 search thread\(s\) on \d+ core\(s\), 2 problems at once \(1 and 1 threads\)/);
      expect(run.output).toMatch(/Searching N=4 M=4 P=3: .* on 1 thread\(s\)/);
      // their lines name their problem, and the status line shows both
      expect(run.output).toMatch(/\n\[[^\]]+\]   N=4 M=4 P=3: best so far/);
      expect(run.output).toMatch(/\n\[[^\]]+\]   N=0 M=0 P=2: best so far/);
      expect(run.output).toMatch(/Status: 2 of 2 problems being searched; threads/);
      expect(
        history()
          .map((l) => `${l.N}/${l.M}/${l.P}`)
          .sort(),
      ).toEqual(["0/0/2", "4/4/3"]);
      expect(server.leaderOf(4, 4, 3)!.name).toBe("Test volunteer");
      expect(server.leaderOf(0, 0, 2)!.name).toBe("Test volunteer");
    },
  );

  // Fix 7: threads that die as they start stop the client with an error instead of respawning forever.
  it("stops with exit code 1 when its search threads cannot start", { timeout: 30_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    let spawned = 0;
    const pool = {
      spawn: () => {
        spawned++;
        return new Worker("process.exit(3)", { eval: true });
      },
      respawnDelayMs: () => 5,
    };
    const { code, output } = await clientWith(["--name", "Test volunteer"], { pool });
    expect(code, output).toBe(1);
    expect(output).toMatch(/exited with code 3; starting a new one in 0\.005 s/);
    expect(output).toMatch(/Stopped with an error: the search threads stopped 5 times before finishing any job/);
    expect(spawned).toBeLessThanOrEqual(6);
    expect(server.submissions).toEqual([]);

    // with --once, a problem whose jobs all lost their thread was not searched: exit code 1 too
    const once = await clientWith(["--once", "--name", "Test volunteer"], { pool });
    expect(once.code, once.output).toBe(1);
    expect(once.output).toMatch(/Every job of N=4 M=4 P=3 lost its search thread|Stopped with an error/);
  });

  // Fix 8. Real solver work: one evaluation-capped job.
  it("says when the leader stays, with six decimals, and when there was no leader", { timeout: 60_000 }, async () => {
    server = await startFakeServer({
      problems: [{ ...TWO_CIRCLES, leader: null }],
      afterSubmit: (_n, answer) => ({
        status: 200,
        body: { ...answer, leader: false, rank: 2, id: null, leader_score: 1.9999999999123 },
      }),
    });
    const { code, output } = await client("--once", "--name", "Test volunteer");
    expect(code, output).toBe(0);
    expect(output).toMatch(
      /Finished N=0 M=0 P=2 .*vs no leader; submitted: HTTP 200, accepted, but the leader stays at 2\.000000$/m,
    );
  });

  it("does not repeat itself when it has nothing to submit (fix 8)", { timeout: 30_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    const { code, output } = await clientWith(["--once", "--name", "Test volunteer"], { searchProblem: nothing });
    expect(code, output).toBe(0);
    expect(output).toMatch(/: no strict packing; nothing to submit$/m);
    expect(output).not.toMatch(/no strict packing; no strict packing/);
  });

  // The real engine, on two threads for 3 s of search: only what does not depend on speed.
  it("runs the real engine", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    const { code, output } = await clientWith(["--once", "--name", "Test volunteer"], { searchProblem: undefined });
    expect(code, output).toBe(0);
    const [line] = history();
    expect(line.stopped).not.toBe("error");
    expect(line.engine_seed).toBeGreaterThanOrEqual(0);
    // whatever it found, anything it sent was valid and better than the leader
    for (const body of server.submissions) expect(scoreOf(body as never)!).toBeLessThan(2.5);
    expect(server.submissions.length).toBe(line.submitted ? 1 : 0);
  });

  it("refuses to share its state directory with a running copy", { timeout: 30_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    // another copy on this machine: our parent process, which is alive
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const other = { pid: process.ppid, hostname: hostname(), started: "2026-10-21T00:00:00Z", token: "other" };
    writeFileSync(join(state, "lock"), JSON.stringify(other));
    const { code, output } = await client("--once");
    expect(code).toBe(1);
    expect(output).toMatch(/Another copy of the client is using/);
    expect(server.requests).toEqual([]);
    expect(existsSync(join(state, "lock"))).toBe(true);
    expect(JSON.parse(readFileSync(join(state, "lock"), "utf8")).token).toBe("other");
  });

  it("refuses bad options with exit code 2", async () => {
    const lines: string[] = [];
    const code = await main(["--cores", "zero"], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/--cores/);
  });
});
