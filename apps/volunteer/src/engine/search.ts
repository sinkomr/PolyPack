/**
 * searchProblem: one problem, from the first job to the final polish. The numbers are in
 * policy.ts; this is how they are applied.
 *
 * 1. Arms. An arm is a method with its parameters on one kind of start: "fresh" (none), "warm"
 *    (input.known) or "iterate" (the engine's best when the job starts, so every improvement
 *    becomes the start of the next improver jobs). Warm arms need input.known; iterate arms need
 *    a packing, the strict best or else the best valid one that is not strict. A packing that is
 *    not strict is a start only, never the best.
 * 2. Exploration round. Each arm runs once at the base budget T0, in the order of its family's
 *    memory (best first); an iterate arm waits for a packing, and meanwhile the bandit fills the
 *    lanes.
 * 3. Bandit. Thompson sampling: each eligible arm draws theta from its Beta posterior and the arm
 *    with the largest theta / expected seconds of its next job runs. A finished job pulls its
 *    arm's posterior back toward the prior by POLICY.discount, then adds its reward r in [0, 1]
 *    (policy.ts `reward`: the job's relative improvement of the best, on a log scale) to alpha
 *    and 1 - r to beta. Expected seconds are the job's budget times the share of their budgets
 *    the arm's jobs have used, so arms that stop early (asc, morph) are charged what they spend.
 * 4. Budgets. Each arm has a level, starting at 0; its jobs get T0 * 2^level seconds, up to the
 *    cap, clipped to the time left. The level rises by one after a job at that level improves
 *    the best (an arm that keeps improving gets longer runs) and after every two at that level
 *    that do not (an arm that stalls is tried at twice the length before its posterior lets it
 *    go). This is the doubling trick: when a problem needs runs of some length L that nobody
 *    knows in advance, an arm spends at most about 2L on shorter runs before its first run of
 *    length L. Every job also gets an evaluation cap, 0.8 of what its time buys at the method's
 *    measured rate, so that most jobs end on evaluations and are reproducible.
 * 5. Stopping. No job starts when control.aborted is set ("aborted"), when the best is within
 *    1e-9 of the area bound ("bound"), when less than T0 / 2 is left before maxSeconds minus the
 *    polish reserve ("time"), or when there has been no progress for max(floor, elapsed / 2)
 *    seconds ("stagnation"). Progress is a strict result that improves by more than 1e-9
 *    relative either the score to beat (the best, or input.known before the best beats it) or
 *    the best of the search's own line. The own line is every packing not derived from
 *    input.known: fresh results, and iterated results from such packings; warm results, and
 *    iterated ones from them, belong to the known packing's line. So a warm search that cannot
 *    beat its start yet goes on while its own packings keep getting better. The floor is the fair
 *    share, a quarter of maxSeconds (at least 4 T0); after it, the own line counts only while it
 *    is within 1% of the score to beat, so a search that cannot even approach the leader stops.
 *    When no job may start, the search waits for the jobs in flight; if one of them makes
 *    progress, jobs start again. It ends when nothing is in flight and no job may start.
 * 6. Final polish. Unless aborted, method "polish" from the best packing, for at most the time
 *    left (the reserve is kept for it) and 60 s.
 * 7. Memory. Each arm's share of the problem's reward and each method's evaluation rate are
 *    added to the family's record (memory.ts) and returned.
 *
 * A job that fails (rejects, errors or crashes) is a result without reward; an arm whose jobs
 * fail three times in a row is dropped for the problem. All the engine's own choices draw from
 * one stream seeded by input.seed, and job seeds are mixed from input.seed and the job's index,
 * so the same input, the same job answers and the same clock give the same jobs.
 */
import type { PackingConfig } from "@polypack/geometry";
import type {
  Candidate,
  Control,
  Job,
  JobResult,
  Problem,
  RunJob,
  SearchInput,
  SearchOutcome,
  SearchProblem,
} from "../types";
import { armCredit, armPrior, parseMemory, remember, type FamilyRecord, type Memory } from "./memory";
import { POLICY, armsFor, familyKey, fitsProblem, levelSeconds, makePlan, reward, type Arm, type Plan } from "./policy";
import { betaSample, mixSeed, seededStream, toUint32 } from "./random";

type Stop = SearchOutcome["stopped"];

interface ArmState {
  arm: Arm;
  prior: { alpha: number; beta: number };
  alpha: number;
  beta: number;
  level: number;
  /** Jobs in a row at the current level without an improvement. */
  misses: number;
  /** Failed jobs in a row. */
  errors: number;
  disabled: boolean;
  explored: boolean;
  /** This problem's jobs and their rewards, for memory. */
  jobs: number;
  rewards: number;
  /** Budget seconds and active seconds of the finished jobs, for the expected cost. */
  planned: number;
  spent: number;
}

interface Flight {
  id: number;
  job: Job;
  /** Absent for the final polish, which belongs to no arm. */
  state?: ArmState;
  level: number;
  /** Whether its start is input.known or derived from it, so its packing is not the own line's. */
  fromKnown: boolean;
  startedAt: number;
  done: Promise<{ id: number; result: JobResult }>;
}

/** Runs a job and turns every failure, thrown or returned, into a result. */
async function settle(runJob: RunJob, job: Job, control: Control): Promise<JobResult> {
  const failure = (reason: unknown): JobResult => ({
    job,
    score: null,
    valid: false,
    strict: false,
    evaluations: 0,
    wallTime: 0,
    termination: "error",
    reasons: [reason instanceof Error ? reason.message : String(reason)],
  });
  try {
    const result = await runJob(job, control);
    return typeof result === "object" && result !== null ? result : failure("runJob returned no result");
  } catch (error) {
    return failure(error);
  }
}

class Search {
  private readonly problem: Problem;
  private readonly lanes: number;
  private readonly maxSeconds: number;
  private readonly seed: number;
  private readonly random: () => number;
  private readonly memory: Memory;
  private readonly family: string;
  private readonly states: ArmState[];
  /** Exploration order: the family's best arms first. */
  private readonly order: ArmState[];
  private readonly plan: Plan;
  private readonly known?: { config: PackingConfig; score: number };
  private readonly t0: number;
  /** Evaluations and active seconds by method, with the prior rate. */
  private readonly rates = new Map<string, { evaluations: number; seconds: number; prior: number }>();
  private readonly flights = new Map<number, Flight>();
  private best: Candidate | null = null;
  /** The best valid packing that is not strict: a start, never the best. */
  private fallback: { config: PackingConfig; score: number } | null = null;
  /** Whether the best and the fallback derive from input.known. */
  private bestFromKnown = false;
  private fallbackFromKnown = false;
  /** Score of the best strict packing of the search's own line (not derived from input.known). */
  private ownBest = Infinity;
  /** Elapsed seconds when the score to beat, and the own line's best, last improved. */
  private lastBeaten = 0;
  private lastOwn = 0;
  private jobs = 0;

  constructor(
    private readonly input: SearchInput,
    private readonly runJob: RunJob,
    private readonly control: Control,
  ) {
    const { N, M, P } = input.problem;
    this.problem = { N, M, P };
    this.lanes = Number.isFinite(input.lanes) ? Math.max(1, Math.floor(input.lanes)) : 1;
    this.maxSeconds = Number.isFinite(input.maxSeconds) ? Math.max(0, input.maxSeconds) : 0;
    this.seed = toUint32(input.seed);
    this.random = seededStream(mixSeed(this.seed, 0xffffffff));
    this.memory = parseMemory(input.memory);
    this.family = familyKey(this.problem);
    const family: FamilyRecord | undefined = Object.hasOwn(this.memory.families, this.family)
      ? this.memory.families[this.family]
      : undefined;
    const known = input.known;
    if (known && fitsProblem(known.config, this.problem))
      this.known = {
        config: known.config,
        score: Number.isFinite(known.score) && known.score > 0 ? known.score : Infinity,
      };

    const arms = armsFor(this.problem).filter((arm) => arm.start !== "warm" || this.known);
    this.states = arms.map((arm) => {
      const prior = armPrior(family, arm.key);
      return {
        arm,
        prior,
        alpha: prior.alpha,
        beta: prior.beta,
        level: 0,
        misses: 0,
        errors: 0,
        disabled: false,
        explored: false,
        jobs: 0,
        rewards: 0,
        planned: 0,
        spent: 0,
      };
    });
    // Stable sort: arms without a record keep the catalogue's order, after those with one
    this.order = [...this.states].sort(
      (a, b) => (armCredit(family, b.arm.key) ?? -1) - (armCredit(family, a.arm.key) ?? -1),
    );

    const generic = 1 / (POLICY.secondsPerEvaluationPerPiece * P);
    const remembered = Object.entries(family?.rates ?? {}).map(([method, rate]) => [method, rate / P] as const);
    for (const arm of arms)
      if (!this.rates.has(arm.method)) this.rates.set(arm.method, { evaluations: 0, seconds: 0, prior: generic });
    for (const [method, rate] of remembered) {
      const totals = this.rates.get(method);
      if (totals) totals.prior = rate;
    }
    // The base budget follows the family's measured rates when there are any
    const typical = remembered.length
      ? Math.exp(remembered.reduce((sum, [, rate]) => sum + Math.log(rate), 0) / remembered.length)
      : generic;
    this.plan = makePlan(this.maxSeconds, this.lanes, this.states.length, typical);
    this.t0 = input.now();
  }

  private elapsed(): number {
    return this.input.now() - this.t0;
  }

  async run(): Promise<SearchOutcome> {
    let stop: Stop = "time";
    for (;;) {
      while (this.flights.size < this.lanes) {
        const next = this.decide();
        if (typeof next === "string") {
          stop = next;
          break;
        }
        this.launch(next.job, next.state, next.fromKnown);
      }
      if (this.flights.size === 0) break;
      const { id, result } = await Promise.race(Array.from(this.flights.values(), (flight) => flight.done));
      const flight = this.flights.get(id)!;
      this.flights.delete(id);
      this.absorb(flight, result);
    }
    if (!this.control.aborted) await this.polish();
    return {
      best: this.best,
      jobs: this.jobs,
      stopped: this.control.aborted ? "aborted" : stop,
      memory: this.learned(),
    };
  }

  /** The next job, or why none may start. */
  private decide(): { job: Job; state: ArmState; fromKnown: boolean } | Stop {
    if (this.control.aborted) return "aborted";
    if (this.atBound()) return "bound";
    if (this.jobs >= POLICY.maxJobs) return "stagnation";
    const t = this.elapsed();
    const available = this.maxSeconds - this.plan.polishReserve - t;
    if (available < this.plan.minJob) return "time";
    if (t - this.lastProgress(t) >= Math.max(this.plan.stagnationFloor, POLICY.stagnationShare * t))
      return "stagnation";
    const state = this.order.find((s) => !s.explored && this.eligible(s)) ?? this.sample(available);
    // Every arm failed for good
    if (!state) return "stagnation";
    state.explored = true;
    const job = this.makeJob(state, Math.min(levelSeconds(this.plan, state.level), available));
    return { job, state, fromKnown: this.startFromKnown(state.arm) };
  }

  /**
   * Elapsed seconds at the last progress: the score to beat improved, or the own line did while
   * it counts, which is before the fair share or while it is within approachGap of that score.
   */
  private lastProgress(t: number): number {
    const target = Math.min(this.best?.score ?? Infinity, this.known?.score ?? Infinity);
    const counts = t < this.plan.stagnationFloor || this.ownBest <= target * (1 + POLICY.approachGap);
    return counts ? Math.max(this.lastBeaten, this.lastOwn) : this.lastBeaten;
  }

  private atBound(): boolean {
    const bound = this.input.areaBound;
    return this.best !== null && bound > 0 && this.best.score <= bound * (1 + POLICY.minImprovement);
  }

  private startFor(arm: Arm): PackingConfig | undefined {
    if (arm.start === "warm") return this.known?.config;
    if (arm.start === "iterate") return this.best?.config ?? this.fallback?.config;
    return undefined;
  }

  /** Whether an arm's start is input.known or derived from it. */
  private startFromKnown(arm: Arm): boolean {
    if (arm.start === "warm") return true;
    if (arm.start === "iterate") return this.best ? this.bestFromKnown : this.fallbackFromKnown;
    return false;
  }

  private eligible(state: ArmState): boolean {
    return !state.disabled && (state.arm.start === "fresh" || this.startFor(state.arm) !== undefined);
  }

  /** Thompson sampling over the eligible arms, per expected second. */
  private sample(available: number): ArmState | undefined {
    let chosen: ArmState | undefined;
    let top = -Infinity;
    for (const state of this.states) {
      if (!this.eligible(state)) continue;
      const theta = betaSample(this.random, state.alpha, state.beta);
      const base = this.plan.base;
      const share = Math.min(1, Math.max(0.1, (state.spent + base) / (state.planned + base)));
      const value = theta / (Math.min(levelSeconds(this.plan, state.level), available) * share);
      if (value > top) {
        top = value;
        chosen = state;
      }
    }
    return chosen;
  }

  /** Evaluations per second of a method on this problem: its jobs, with one second of prior. */
  private rate(method: string): number {
    const totals = this.rates.get(method);
    if (!totals) return 1 / (POLICY.secondsPerEvaluationPerPiece * this.problem.P);
    return (totals.evaluations + totals.prior) / (totals.seconds + 1);
  }

  private makeJob(state: ArmState, seconds: number): Job {
    const { arm } = state;
    const wanted = Math.floor(this.rate(arm.method) * seconds * POLICY.evaluationFill);
    // The solver takes a safe integer; NaN (an absurd rate) falls to the minimum
    const evals = Math.min(1e9, Math.max(POLICY.minEvaluations, wanted || 0));
    const job: Job = {
      problem: { ...this.problem },
      method: arm.method,
      seed: mixSeed(this.seed, this.jobs),
      budget: { time_s: seconds, evals },
      kind: arm.start,
    };
    if (arm.params) job.params = arm.params(this.random);
    const start = this.startFor(arm);
    if (start) job.start = start;
    return job;
  }

  private launch(job: Job, state: ArmState | undefined, fromKnown: boolean): Flight {
    const id = this.jobs++;
    const startedAt = this.elapsed();
    const done = settle(this.runJob, job, this.control).then((result) => ({ id, result }));
    const flight: Flight = { id, job, state, level: state?.level ?? 0, fromKnown, startedAt, done };
    this.flights.set(id, flight);
    return flight;
  }

  /** Learns from a finished job: the best, the arm's posterior and level, the method's rate. */
  private absorb(flight: Flight, result: JobResult): void {
    const t = this.elapsed();
    const seconds = Math.max(0, t - flight.startedAt);
    const gain = this.consider(result, flight, t);
    const failed = result.termination === "error" || result.termination === "crashed";
    const state = flight.state;
    if (state) {
      state.jobs += 1;
      state.rewards += gain;
      state.planned += flight.job.budget.time_s;
      state.spent += seconds;
      state.alpha = state.prior.alpha + POLICY.discount * (state.alpha - state.prior.alpha) + gain;
      state.beta = state.prior.beta + POLICY.discount * (state.beta - state.prior.beta) + (1 - gain);
      if (failed) {
        state.errors += 1;
        if (state.errors >= POLICY.errorLimit) state.disabled = true;
      } else {
        state.errors = 0;
        // Only a job at the arm's current level moves it: lanes may finish older, shorter jobs late
        if (flight.level === state.level && state.level < this.plan.maxLevel) {
          if (gain > 0 || ++state.misses >= POLICY.missesPerLevel) {
            state.level += 1;
            state.misses = 0;
          }
        }
      }
    }
    const totals = this.rates.get(flight.job.method);
    if (totals && !failed && seconds > 0.01 && Number.isFinite(result.evaluations) && result.evaluations > 0) {
      totals.evaluations += result.evaluations;
      totals.seconds += seconds;
    }
    try {
      this.input.onResult?.(result, this.best);
    } catch {
      // The host's log must not end the search
    }
  }

  /**
   * Takes a job's packing as the best or as a start, records progress (see the stopping rule)
   * and returns the job's reward.
   */
  private consider(result: JobResult, flight: Flight, t: number): number {
    const { best: config, score } = result;
    if (result.valid !== true || typeof score !== "number" || !Number.isFinite(score) || !(score > 0)) return 0;
    if (!fitsProblem(config, this.problem)) return 0;
    const { job, fromKnown } = flight;
    if (result.strict !== true) {
      if (!this.fallback || score < this.fallback.score) {
        this.fallback = { config, score };
        this.fallbackFromKnown = fromKnown;
      }
      return 0;
    }
    // The score to beat: the best so far, or the known packing before there is one
    const before = Math.min(this.best?.score ?? Infinity, this.known?.score ?? Infinity);
    if (!this.best || score < this.best.score) {
      this.best = { config, score, strict: true, job, params: result.params };
      this.bestFromKnown = fromKnown;
    }
    if (!Number.isFinite(before) || (before - score) / before > POLICY.minImprovement) this.lastBeaten = t;
    if (!fromKnown && score < this.ownBest * (1 - POLICY.minImprovement)) {
      this.ownBest = score;
      this.lastOwn = t;
    }
    return reward(before, score);
  }

  /** The final polish of the best packing (or of the best valid one when none is strict). */
  private async polish(): Promise<void> {
    const target = this.best ?? this.fallback;
    const fromKnown = this.best ? this.bestFromKnown : this.fallbackFromKnown;
    const seconds = Math.min(this.maxSeconds - this.elapsed(), POLICY.polishMaxSeconds);
    if (!target || !(seconds >= 0.05)) return;
    const job: Job = {
      problem: { ...this.problem },
      method: "polish",
      seed: mixSeed(this.seed, this.jobs),
      budget: { time_s: seconds, evals: POLICY.polishEvaluations },
      start: target.config,
      finalPolish: false,
      kind: "polish",
    };
    const flight = this.launch(job, undefined, fromKnown);
    const { result } = await flight.done;
    this.flights.delete(flight.id);
    this.absorb(flight, result);
  }

  /**
   * Memory with this problem added: each arm's share of the reward (nothing when no job improved
   * anything, which says nothing about the arms), each method's rate.
   */
  private learned(): Memory {
    const total = this.states.reduce((sum, state) => sum + state.rewards, 0);
    return remember(this.memory, this.family, {
      arms: this.states
        .filter((state) => state.jobs > 0 && total > 0)
        .map((state) => ({ key: state.arm.key, credit: state.rewards / total })),
      rates: [...this.rates]
        .filter(([, totals]) => totals.seconds >= 1)
        .map(([method, totals]) => ({ method, rate: (totals.evaluations / totals.seconds) * this.problem.P })),
    });
  }
}

export const searchProblem: SearchProblem = (input, runJob, control) => new Search(input, runJob, control).run();
