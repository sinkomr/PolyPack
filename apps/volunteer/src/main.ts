/**
 * The volunteer client's main loop: take a problem from the server's work list, search it with the
 * engine on the worker pool, submit the best only when it beats the site's leader, and move on.
 *
 * With --spaces it also takes problems of the new spaces from their own work list (or only those,
 * with --only-spaces): each next problem comes from one list or the other with probability 1/2.
 * Without the option nothing here asks the server about the spaces.
 *
 * `main` returns the exit code instead of exiting, and takes its network, output, engine, clock
 * and battery from `deps`, so that test/cli.test.ts runs it end to end against an in-process server.
 */
import { randomInt } from "node:crypto";
import os from "node:os";
import { type ProblemInfo, type Target, type TargetsResponse, improvesOn } from "@polypack/geometry";
import type { SpaceTarget, SpaceTargetsResponse } from "@polypack/spaces";
import { onBattery, watchBattery } from "./battery";
import { ActiveClock } from "./clock";
import { searchProblem as engineSearch } from "./engine/index";
import { formatDuration, formatScore, problemKey, problemLabel, relativePercent, timestamp } from "./format";
import { type Answer, Api, type Sleep, type SubmitOutcome, compactList, realSleep } from "./http";
import { type Machine, OptionError, type Options, helpText, parseOptions } from "./options";
import { type Recent, noteSearch, pickSpaceTarget, pickTarget, pruneRecent, recentFromHistory } from "./pick";
import { type PoolOptions, WorkerPool } from "./pool";
import { type SpaceCandidate, type SpaceSearchOutcome, chooseSpaceMethod, searchSpaceProblem } from "./spaces/engine";
import {
  type SpaceProblem,
  type SpaceRule,
  checkSpaceConfig,
  checkSpaceMethod,
  nofoldOnPolygonEngine,
  parseSpaceId,
  spaceMethodName,
  spaceMethodNote,
} from "./spaces/model";
import { type NofoldProblem, faceProblem, surfaceFromFace } from "./spaces/nofold";
import { type SpaceProblemInfo, readSpaceProblem, readSpaceSubmitResponse, readSpaceTarget } from "./spaces/read";
import {
  betterSpace,
  bestRef,
  buildSpaceKnown,
  checkSpaceStored,
  decideSpaceSubmission,
  spaceSubmissionBody,
} from "./spaces/submit";
import {
  type HistoryLine,
  type LeaderRef,
  LockHeld,
  type SpaceHistoryLine,
  type SpaceLeaderRef,
  StateDir,
  bestFileOf,
  candidateOf,
  spaceBestFileOf,
  spaceCandidateOf,
} from "./state";
import {
  type Decision,
  type StoredEntry,
  type SubmitCheck,
  better,
  buildKnown,
  checkStored,
  decideSubmission,
  submissionBody,
} from "./submit";
import type { Candidate, Control, Problem, SearchInput, SearchOutcome, SearchProblem } from "./types";
import { cleanText, readProblemInfo, readStoredEntry, readSubmitResponse, readTarget } from "./validate";
import { SOFTWARE, UNITS, UPGRADE_URL, VERSION } from "./version";

/** The work list is read again after this long; a problem that could not be read is skipped as long. */
export const TARGETS_TTL_MS = 10 * 60_000;
/**
 * The largest limit of GET /api/spaces/targets (apps/server SPACE_TARGETS_MAX_LIMIT), and older servers' largest,
 * newest first: 10000 until PolyPack's prism and antiprism problems joined (2026-10-25), 2000 before that.
 */
export const SPACE_TARGETS_LIMIT = 20000;
export const SPACE_TARGETS_LIMITS_BEFORE: readonly number[] = [10000, 2000];
/** After the first signal (or the end of --hours), the most the client waits before it exits. */
export const STOP_GRACE_MS = 30_000;
/** No problem starts with less of --hours left than this, or than the time per problem if smaller. */
export const MIN_PROBLEM_SECONDS = 120;

export interface MainDeps {
  fetch?: typeof fetch;
  /** Normal output, one line per call; default console.log. */
  out?: (line: string) => void;
  /** Option errors; default console.error. */
  err?: (line: string) => void;
  /** The engine; default src/engine's searchProblem. */
  searchProblem?: SearchProblem;
  /** The engine of the spaces; default spaces/engine.ts's searchSpaceProblem. */
  searchSpace?: typeof searchSpaceProblem;
  /** Install the SIGINT and SIGTERM handlers; default true. */
  signals?: boolean;
  random?: () => number;
  /** Whether the machine is on battery power; default battery.ts's onBattery. */
  checkBattery?: () => Promise<boolean>;
  batteryEveryMs?: number;
  statusEveryMs?: number;
  machine?: Partial<Machine>;
  sleep?: Sleep;
  /** Wall-clock milliseconds; default Date.now. Tests move it on to stand in for a machine that slept. */
  now?: () => number;
  /** How often the --hours limit is checked, in ms; default 10 s. */
  deadlineCheckMs?: number;
  /** Worker pool options, for tests (a thread that dies at start). */
  pool?: Partial<PoolOptions>;
}

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const machine: Machine = { availableParallelism: os.availableParallelism(), homedir: os.homedir(), ...deps.machine };
  let parsed;
  try {
    parsed = parseOptions(argv, machine);
  } catch (error) {
    if (!(error instanceof OptionError)) throw error;
    err(`polypack-volunteer: ${error.message}\nRun it with --help to see the options.`);
    return 2;
  }
  if (parsed.kind === "help") {
    out(helpText(machine));
    return 0;
  }
  if (parsed.kind === "version") {
    out(VERSION);
    return 0;
  }
  return new Volunteer(parsed.options, deps, out).run();
}

/** A problem being searched, for the status line, the stop and the pause. */
interface Current {
  /** "N=4 M=4 P=3", or a space problem's id. */
  label: string;
  /** Its key in skipUntil and in the problems being searched. */
  key: string;
  /** The threads it is searched on: its slot's share of --cores. */
  lanes: number;
  control: Control;
  startedAt: number;
  maxSeconds: number;
  jobs: number;
  best: { score: number } | null;
  /** The score to beat: the site's leader, or a space problem's best. */
  leader: number | null;
  /** What `leader` is called in the status line. */
  against: "leader" | "best";
  /** Jobs that ended because their thread was lost. */
  crashed: number;
}

/** The next problem: from the polygon work list or the spaces' one; why there is none; or a failure. */
type Pick =
  | { kind: "polygon"; target: Target }
  | { kind: "space"; target: SpaceTarget }
  | { kind: "none"; message: string }
  | { kind: "missing"; message: string }
  | { kind: "unreachable" };

/** "HTTP 422: overlap of pieces 3 and 7" or "no answer", safe to print. */
function describeAnswer(a: Answer | null): string {
  if (!a) return "no answer from the server";
  const body = a.body as { reasons?: unknown; error?: unknown } | null;
  const why = Array.isArray(body?.reasons)
    ? body.reasons
        .slice(0, 5)
        .map((r) => cleanText(r))
        .join("; ")
    : typeof body?.error === "string"
      ? cleanText(body.error)
      : typeof a.body === "string"
        ? cleanText(a.body)
        : "";
  return `HTTP ${a.status}${why ? `: ${why}` : ""}`;
}

const errorText = (error: unknown) => cleanText((error as Error)?.stack ?? String(error), 2000);

/**
 * The threads of each of `problems` problems searched at once: `cores` split as evenly as it goes,
 * the larger shares first (15 threads, 4 problems: 4, 4, 4 and 3).
 */
export function laneShares(cores: number, problems: number): number[] {
  const k = Math.max(1, Math.min(problems, cores));
  return Array.from({ length: k }, (_, i) => Math.floor(cores / k) + (i < cores % k ? 1 : 0));
}

/** "4, 4, 4 and 3". */
const andList = (xs: readonly number[]) =>
  xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

class Volunteer {
  private readonly clock = new ActiveClock();
  /** Aborted to stop: no new problem starts, and waits between problems end. */
  private readonly stop = new AbortController();
  /** Aborted STOP_GRACE_MS after `stop`: the final requests end too. */
  private readonly hard = new AbortController();
  /** Reads before a search, which a stop cuts short. */
  private readonly reader: Api;
  /** The leader's re-read and the submission after a search, which may outlast a stop by STOP_GRACE_MS. */
  private readonly submitter: Api;
  private readonly sleep: Sleep;
  private readonly search: SearchProblem;
  private readonly random: () => number;
  /** Wall-clock milliseconds. */
  private readonly now: () => number;
  private pool: WorkerPool | null = null;
  private state!: StateDir;
  private memory: unknown;
  private recent = new Map<string, Recent>();
  /** Problems not to pick again before a time (ms): closed ones forever, unreadable ones for a while. */
  private readonly skipUntil = new Map<string, number>();
  private targets: { at: number; list: Target[] } | null = null;
  /** Whether to send the filters with GET /api/targets; dropped if the server refuses them. */
  private filterOnServer = true;
  /** The limit the spaces' work list is asked for: the server's largest, or 2000 for an older server. */
  private spaceTargetsLimit = SPACE_TARGETS_LIMIT;
  /** The spaces' work list (--spaces), cached like `targets`. */
  private spaceTargets: { at: number; list: SpaceTarget[] } | null = null;
  private spaceFilterOnServer = true;
  /** Set when the server has no spaces' work list: the polygon list goes on alone. */
  private spacesGone = false;
  private paused = false;
  private stopReason: string | null = null;
  /** Set when the client cannot go on (its threads do not start): it exits with code 1. */
  private fatal: string | null = null;
  /** Set when the server answered 426: it works in other units than this client. */
  private upgrade: string | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  /** The problems being searched now: one per slot (--parallel-problems), between their searches none. */
  private readonly currents = new Set<Current>();
  /** Keys of the problems the slots have drawn and not yet finished: no other slot draws them. */
  private readonly inFlight = new Set<string>();
  /** The slots draw their problems one at a time. */
  private picking: Promise<unknown> = Promise.resolve();
  /** The last note the slots share (its `same`), so that each slot does not print it again (note). */
  private lastNote = { text: "", at: -Infinity };
  private readonly started: number;
  private readonly deadline: number;
  private readonly counts = { problems: 0, sent: 0, accepted: 0, leading: 0 };

  constructor(
    private readonly o: Options,
    private readonly deps: MainDeps,
    private readonly out: (line: string) => void,
  ) {
    this.now = deps.now ?? Date.now;
    this.started = this.now();
    this.deadline = this.started + o.hours * 3600_000;
    const http = {
      fetch: deps.fetch,
      sleep: deps.sleep,
      now: this.now,
      log: (m: string) => this.log(m),
      userAgent: `${SOFTWARE} (Node ${process.version})`,
      onUpgradeRequired: (message: string) => this.upgradeRequired(message),
    };
    this.reader = new Api(o.base, { ...http, signal: this.stop.signal });
    this.submitter = new Api(o.base, { ...http, signal: this.hard.signal });
    this.sleep = deps.sleep ?? realSleep;
    this.search = deps.searchProblem ?? engineSearch;
    this.random = deps.random ?? Math.random;
  }

  /** The server asks for a newer client (426): there is nothing useful this one can send or read, so it stops. */
  private upgradeRequired(message: string): void {
    if (this.upgrade !== null) return;
    this.upgrade = message;
    this.requestStop("The server answered 426 (upgrade required)");
  }

  private log(message: string): void {
    this.out(`[${timestamp()}] ${message}`);
  }

  private get stopped(): boolean {
    return this.stop.signal.aborted;
  }

  async run(): Promise<number> {
    try {
      this.state = StateDir.open(this.o.stateDir, { log: (m) => this.log(m) });
    } catch (error) {
      if (error instanceof LockHeld)
        this.log(
          `Another copy of the client is using ${this.o.stateDir} (${error.message}). Stop it first, or give ` +
            `this one its own --state directory. If no other copy is running, delete ${error.path}.`,
        );
      else this.log(`Cannot use the state directory ${this.o.stateDir}: ${(error as Error).message}`);
      return 1;
    }
    // the lock goes even when a second signal exits at once
    const release = () => this.state.close();
    process.on("exit", release);
    this.memory = this.state.readMemory();
    this.recent = recentFromHistory([...this.state.initialHistory, ...this.state.initialSpaceHistory], this.o.dryRun);
    const cleanups: (() => void)[] = [];
    try {
      this.banner();
      this.pool = await WorkerPool.create({
        size: this.o.cores,
        priority: this.o.priority,
        log: (m) => this.log(m),
        onFatal: (message) => {
          this.fatal = message;
          this.requestStop("The search threads cannot run");
        },
        ...this.deps.pool,
      });
      if (this.o.batteryPause) {
        const watcher = watchBattery(
          this.deps.checkBattery ?? (() => onBattery()),
          (b) => this.onBatteryChange(b),
          this.deps.batteryEveryMs ?? 30_000,
        );
        cleanups.push(() => watcher.stop());
      }
      if (this.deps.signals !== false) cleanups.push(this.installSignals());
      if (Number.isFinite(this.o.hours)) {
        // a timer alone would be late after the machine sleeps: its clock stops, the wall clock does not
        const deadlineTimer = setInterval(() => this.checkDeadline(false), this.deps.deadlineCheckMs ?? 10_000);
        deadlineTimer.unref();
        cleanups.push(() => clearInterval(deadlineTimer));
      }
      const ticker = setInterval(() => this.status(), this.deps.statusEveryMs ?? 60_000);
      ticker.unref();
      cleanups.push(() => clearInterval(ticker));
      const code = await this.loop();
      if (this.upgrade !== null)
        this.log(
          `This client (${VERSION}) is out of date: ${this.upgrade} Download the current client from ${UPGRADE_URL} ` +
            "(or run `npm run build` in a current checkout), and start it again.",
        );
      if (this.fatal)
        this.log(
          `Stopped with an error: ${this.fatal}. The file may be incomplete, or this Node version too old ` +
            "(24 or newer is needed).",
        );
      this.log(
        `Stopped after ${formatDuration((this.now() - this.started) / 1000)}: ${this.counts.problems} problem(s) ` +
          `searched, ${this.counts.sent} submission(s) sent, ${this.counts.accepted} accepted, ` +
          `${this.counts.leading} took the lead. State is in ${this.o.stateDir}.`,
      );
      return this.fatal || this.upgrade !== null ? 1 : code;
    } finally {
      for (const cleanup of cleanups) cleanup();
      if (this.hardTimer) clearTimeout(this.hardTimer);
      await this.pool?.close();
      this.saveMemory();
      this.state.close();
      process.off("exit", release);
    }
  }

  private banner(): void {
    const o = this.o;
    this.log(
      `polypack-volunteer ${VERSION} (Node ${process.version}, ${process.platform} ${process.arch}): ` +
        `${o.cores} search thread(s) on ${os.availableParallelism()} core(s), ` +
        (o.parallelProblems > 1
          ? `${o.parallelProblems} problems at once (${andList(laneShares(o.cores, o.parallelProblems))} threads), `
          : "") +
        `${o.priority} priority`,
    );
    this.log(
      `Server ${o.base}; ` +
        (o.dryRun
          ? o.name === null
            ? "dry run: nothing is submitted, because no --name was given"
            : "dry run (--dry-run): nothing is submitted"
          : `submitting as "${o.name}"${o.note ? ` with the note "${o.note}"` : ""}`),
    );
    this.log(
      `Up to ${formatDuration(o.minutesPerProblem * 60)} per problem; state in ${o.stateDir}; ` +
        (o.batteryPause ? "pauses on battery power" : "keeps running on battery power") +
        (Number.isFinite(o.hours) ? `; stops after ${o.hours} h` : "") +
        (o.N || o.M || o.maxP
          ? `; problems with ${[
              o.N ? `N in ${compactList(o.N)}` : "",
              o.M ? `M in ${compactList(o.M)}` : "",
              o.maxP ? `P <= ${o.maxP}` : "",
            ]
              .filter(Boolean)
              .join(", ")}`
          : ""),
    );
    if (o.spaces)
      this.log(
        (o.onlySpaces
          ? "Searches only problems of the new spaces: "
          : "Also searches problems of the new spaces, half of the time: ") +
          `${o.spaces.join(", ")} (--spaces); a result is submitted only when the space's own check accepts it ` +
          "and it beats the problem's best, the research record or the site's leader",
      );
  }

  // ---------- stopping, pausing ----------

  private installSignals(): () => void {
    const handler = (signal: NodeJS.Signals) => {
      if (this.stopReason !== null) {
        this.out(`${signal} again: exiting at once`);
        process.exit(130);
      }
      this.requestStop(signal);
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    };
  }

  /** Aborts the search (whose best is still submitted if it qualifies), and starts nothing new. */
  private requestStop(why: string): void {
    if (this.stopReason !== null) return;
    this.stopReason = why;
    this.log(
      `${why}: stopping. ` +
        (this.currents.size > 1
          ? "The searches are aborted; each one's best is submitted if it beats the leader. "
          : this.currents.size === 1
            ? "The search is aborted; its best is submitted if it beats the leader. "
            : "") +
        `Exiting within ${STOP_GRACE_MS / 1000} s; a second Ctrl-C exits at once.`,
    );
    this.stop.abort();
    for (const c of this.currents) c.control.aborted = true;
    this.pool?.stop();
    this.hardTimer = setTimeout(() => this.hard.abort(), STOP_GRACE_MS);
    this.hardTimer.unref();
  }

  /**
   * Stops at the --hours limit, by the wall clock. Before a new problem (`starting`), it also stops
   * when less than MIN_PROBLEM_SECONDS (or the time per problem, if smaller) is left. True when stopping.
   */
  private checkDeadline(starting: boolean): boolean {
    if (!Number.isFinite(this.o.hours) || this.stopReason !== null) return this.stopReason !== null;
    const left = (this.deadline - this.now()) / 1000;
    if (left <= 0) {
      this.requestStop(`The --hours limit (${this.o.hours} h) is reached`);
      return true;
    }
    const least = Math.min(MIN_PROBLEM_SECONDS, this.o.minutesPerProblem * 60);
    if (starting && left < least) {
      this.requestStop(
        `Only ${formatDuration(left)} of the --hours limit (${this.o.hours} h) is left, too little for another problem`,
      );
      return true;
    }
    return false;
  }

  private onBatteryChange(battery: boolean): void {
    this.setPaused(battery);
    this.log(
      battery
        ? "On battery power: paused. The search resumes on AC power (--no-battery-pause keeps it running)."
        : "On AC power: resuming.",
    );
  }

  private setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.clock.pause();
    else this.clock.resume();
    for (const c of this.currents) c.control.paused = paused;
    this.pool?.setPaused(paused);
  }

  /** Sleeps until `ms` passes or the client stops. */
  private async wait(ms: number): Promise<void> {
    try {
      await this.sleep(ms, this.stop.signal);
    } catch {
      // stopped
    }
  }

  private saveMemory(): void {
    try {
      this.state.writeMemory(this.memory ?? null);
    } catch (error) {
      this.log(`could not save the engine's memory: ${(error as Error).message}`);
    }
  }

  /** Forgets skips and searches that no longer matter, so that a long run does not grow. */
  private prune(now: number): void {
    for (const [key, until] of this.skipUntil) if (until <= now) this.skipUntil.delete(key);
    pruneRecent(this.recent, now);
  }

  // ---------- the loop ----------

  /**
   * Searches --parallel-problems problems at once: one slot each, on its share of the threads
   * (laneShares), each taking its next problem when its search ends. Exit code 1 when a slot ends
   * with 1.
   */
  private async loop(): Promise<number> {
    const shares = laneShares(this.o.cores, this.o.parallelProblems);
    const codes = await Promise.all(shares.map((lanes) => this.slot(lanes)));
    return codes.some((code) => code !== 0) ? 1 : 0;
  }

  /**
   * A note that every slot would print, such as an unreachable work list: with several slots it is
   * printed once a minute at most. `same` is what makes two notes the same (default the text).
   */
  private note(text: string, same = text): void {
    const now = this.now();
    if (this.o.parallelProblems > 1 && same === this.lastNote.text && now - this.lastNote.at < 60_000) return;
    this.lastNote = { text: same, at: now };
    this.log(text);
  }

  /** One problem after another on `lanes` threads, until the client stops. */
  private async slot(lanes: number): Promise<number> {
    let failures = 0;
    while (!this.stopped) {
      // nothing new starts on battery power
      while (this.paused && !this.stopped) await this.wait(1000);
      if (this.stopped || this.checkDeadline(true)) break;
      const pick = await this.pickFree();
      if (this.stopped) {
        if (pick.kind === "polygon") this.inFlight.delete(problemKey(pick.target));
        if (pick.kind === "space") this.inFlight.delete(pick.target.id);
        break;
      }
      if (pick.kind === "missing") {
        this.note(pick.message);
        return 1;
      }
      if (pick.kind === "unreachable") {
        if (this.o.once) return 1;
        failures++;
        const ms = Math.min(60_000, 2000 * 2 ** failures);
        this.note(`Could not read the work list; trying again in ${ms / 1000} s`);
        await this.wait(ms);
        continue;
      }
      failures = 0;
      if (pick.kind === "none") {
        const now = this.now();
        const expiries = [this.targets, this.spaceTargets]
          .filter((c) => c !== null)
          .map((c) => c!.at + TARGETS_TTL_MS - now);
        const wait = Math.max(60_000, ...expiries);
        const again = this.o.once ? "" : ` Looking again in ${formatDuration(wait / 1000)}.`;
        this.note(`${pick.message}${again}`, pick.message);
        if (this.o.once) return 0;
        await this.wait(wait);
        continue;
      }
      const key = pick.kind === "polygon" ? problemKey(pick.target) : pick.target.id;
      const label = pick.kind === "polygon" ? problemLabel(pick.target) : pick.target.id;
      let searched: boolean;
      try {
        searched =
          pick.kind === "polygon"
            ? await this.searchOne(pick.target, lanes)
            : await this.searchSpace(pick.target, lanes);
      } catch (error) {
        // a bug or an answer nobody foresaw: skip the problem, keep the client
        for (const c of this.currents) if (c.key === key) this.currents.delete(c);
        this.log(`Skipping ${label} for 10 minutes after an unexpected error: ${errorText(error)}`);
        this.skipUntil.set(key, this.now() + TARGETS_TTL_MS);
        searched = false;
      } finally {
        this.inFlight.delete(key);
      }
      if (this.fatal) return 1;
      if (this.o.once) return searched || this.stopped ? 0 : 1;
    }
    return 0;
  }

  /** The next problem (pickNext), drawn by one slot at a time; a problem being searched is not drawn again. */
  private pickFree(): Promise<Pick> {
    const pick = this.picking.then(async () => {
      const next = await this.pickNext();
      if (next.kind === "polygon") this.inFlight.add(problemKey(next.target));
      if (next.kind === "space") this.inFlight.add(next.target.id);
      return next;
    });
    this.picking = pick.catch(() => undefined);
    return pick;
  }

  /**
   * The next problem. Without --spaces this is the polygon work list's draw alone. With both
   * lists, one of them is tried first with probability 1/2 (from the same random source as the
   * draws), and the other when the first has nothing to offer.
   */
  private async pickNext(): Promise<Pick> {
    const polygon = !this.o.onlySpaces;
    const spaces = this.o.spaces !== null && !this.spacesGone;
    const order: ("polygon" | "space")[] =
      polygon && spaces
        ? this.random() < 0.5
          ? ["polygon", "space"]
          : ["space", "polygon"]
        : polygon
          ? ["polygon"]
          : ["space"];
    const empty: string[] = [];
    let reached = false;
    for (const queue of order) {
      if (queue === "polygon") {
        const list = await this.readTargets();
        if (this.stopped) return { kind: "unreachable" };
        if (list === "missing")
          return {
            kind: "missing",
            message:
              `The server at ${this.o.base} has no work list: GET /api/targets answered 404, so it runs a version of ` +
              "PolyPack older than this client. Try again once it is updated, or give --base a server that has it.",
          };
        if (list === null) continue;
        reached = true;
        const now = this.now();
        this.prune(now);
        const target = pickTarget(list, {
          filters: { N: this.o.N, M: this.o.M, maxP: this.o.maxP },
          recent: this.recent,
          skip: new Set([...this.skipUntil.keys(), ...this.inFlight]),
          now,
          random: this.random,
        });
        if (target) return { kind: "polygon", target };
        empty.push(
          list.length
            ? `the work list's ${list.length} problem(s) are filtered out, closed, or were searched here in the last 7 days with the same leader`
            : "the work list is empty",
        );
      } else {
        const list = await this.readSpaceTargets();
        if (this.stopped) return { kind: "unreachable" };
        if (list === "missing") {
          const why =
            `The server at ${this.o.base} has no work list for the new spaces: GET /api/spaces/targets answered 404, ` +
            "so it runs a version of PolyPack without them.";
          if (this.o.onlySpaces)
            return { kind: "missing", message: `${why} Try again once it is updated, or leave out --only-spaces.` };
          this.log(`${why} Searching the polygon work list only.`);
          this.spacesGone = true;
          continue;
        }
        if (list === null) continue;
        reached = true;
        const now = this.now();
        this.prune(now);
        const target = pickSpaceTarget(list, {
          filters: { spaces: this.o.spaces!, maxP: this.o.maxP },
          recent: this.recent,
          skip: new Set([...this.skipUntil.keys(), ...this.inFlight]),
          now,
          random: this.random,
        });
        if (target) return { kind: "space", target };
        empty.push(
          list.length
            ? `the spaces' work list's ${list.length} problem(s) are filtered out, closed, or were searched here in the last 7 days with the same best`
            : "the spaces' work list is empty",
        );
      }
    }
    if (!reached) return { kind: "unreachable" };
    const text = empty.join("; ");
    return {
      kind: "none",
      message:
        empty.length === 1 && text === "the work list is empty"
          ? "The work list is empty."
          : `Nothing to search: ${text}.`,
    };
  }

  /** The spaces' work list, from the cache while it is fresh; "missing" on 404; null when unreachable. */
  private async readSpaceTargets(): Promise<SpaceTarget[] | "missing" | null> {
    const now = this.now();
    if (this.spaceTargets && now - this.spaceTargets.at < TARGETS_TTL_MS && now >= this.spaceTargets.at)
      return this.spaceTargets.list;
    const query = this.spaceTargetsQuery(this.spaceFilterOnServer);
    let answer = await this.reader.spaceTargets(query);
    for (;;) {
      // an older server takes at most limit=10000, or 2000: ask for the next smaller limit
      const next = SPACE_TARGETS_LIMITS_BEFORE.find((l) => l < this.spaceTargetsLimit);
      if (!(answer?.status === 400 && next !== undefined && /limit/.test(describeAnswer(answer)))) break;
      this.log(`The server refused limit=${this.spaceTargetsLimit} for the spaces' work list; asking for ${next}`);
      this.spaceTargetsLimit = next;
      answer = await this.reader.spaceTargets(this.spaceTargetsQuery(this.spaceFilterOnServer));
    }
    if (answer?.status === 400 && this.spaceFilterOnServer) {
      // the filters are applied here as well
      this.log(`The server refused the spaces' work list filters (${describeAnswer(answer)}); filtering here instead`);
      this.spaceFilterOnServer = false;
      answer = await this.reader.spaceTargets(this.spaceTargetsQuery(false));
    }
    if (!answer) return null;
    if (answer.status === 404) return "missing";
    const body = answer.body as Partial<SpaceTargetsResponse> | null;
    if (answer.status !== 200 || !Array.isArray(body?.targets)) {
      this.log(`Unexpected answer to GET /api/spaces/targets: ${describeAnswer(answer)}`);
      return null;
    }
    const list = body.targets.map(readSpaceTarget).filter((t): t is SpaceTarget => t !== null);
    this.spaceTargets = { at: now, list };
    this.log(
      `Read the spaces' work list: ${list.length} problem(s)` +
        (body.generated_at ? `, ranked at ${cleanText(body.generated_at, 40)}` : "") +
        (list.length < body.targets.length
          ? `; ${body.targets.length - list.length} entries left out (malformed or unknown ids)`
          : ""),
    );
    return list;
  }

  /**
   * ?spaces=...&max_P=...&limit=20000, the server's largest limit, so that the client draws from
   * the whole list (16,657 targets with the catalogues of 2026-10-25, so that every space gets its
   * share); only the limit once the server has refused the filters (they then apply here only).
   * An older server takes at most 10000, or 2000, which the client then asks for.
   */
  private spaceTargetsQuery(filters: boolean): string {
    const q = new URLSearchParams();
    if (filters) {
      q.set("spaces", this.o.spaces!.join(","));
      if (this.o.maxP !== null) q.set("max_P", String(this.o.maxP));
    }
    // without it the server answers its default 500, which may leave out every problem of a space
    q.set("limit", String(this.spaceTargetsLimit));
    return `?${q.toString()}`;
  }

  /** The work list, from the cache while it is fresh; "missing" on 404; null when unreachable. */
  private async readTargets(): Promise<Target[] | "missing" | null> {
    const now = this.now();
    if (this.targets && now - this.targets.at < TARGETS_TTL_MS && now >= this.targets.at) return this.targets.list;
    const query = this.filterOnServer ? this.targetsQuery() : "";
    let answer = await this.reader.targets(query);
    if (answer?.status === 400 && query) {
      // the filters are applied here as well: a server that refuses them still works
      this.log(`The server refused the work list's filters (${describeAnswer(answer)}); filtering here instead`);
      this.filterOnServer = false;
      answer = await this.reader.targets("");
    }
    if (!answer) return null;
    if (answer.status === 404) return "missing";
    const body = answer.body as Partial<TargetsResponse> | null;
    if (answer.status !== 200 || !Array.isArray(body?.targets)) {
      this.log(`Unexpected answer to GET /api/targets: ${describeAnswer(answer)}`);
      return null;
    }
    const list = body.targets.map(readTarget).filter((t): t is Target => t !== null);
    this.targets = { at: now, list };
    this.log(
      `Read the work list: ${list.length} problem(s)` +
        (body.generated_at ? `, ranked at ${cleanText(body.generated_at, 40)}` : "") +
        (list.length < body.targets.length ? `; ${body.targets.length - list.length} malformed entries left out` : ""),
    );
    return list;
  }

  private targetsQuery(): string {
    const q = new URLSearchParams();
    if (this.o.N) q.set("N", compactList(this.o.N));
    if (this.o.M) q.set("M", compactList(this.o.M));
    if (this.o.maxP !== null) q.set("max_P", String(this.o.maxP));
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  private maxSeconds(): number {
    let s = Math.max(1, this.o.minutesPerProblem * 60);
    if (Number.isFinite(this.o.hours)) s = Math.min(s, Math.max(1, (this.deadline - this.now()) / 1000));
    return s;
  }

  private async readProblem(api: Api, p: Problem): Promise<{ info: ProblemInfo | null; answer: Answer | null }> {
    const answer = await api.problem(p);
    return { info: answer?.status === 200 ? readProblemInfo(answer.body, p) : null, answer };
  }

  /** Resolves with `promise`, or with null once the grace period after a stop is over. */
  private untilHardStop<T>(promise: Promise<T>): Promise<T | null> {
    const signal = this.hard.signal;
    if (signal.aborted) return Promise.resolve(null);
    return new Promise<T | null>((resolve, reject) => {
      const onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  // ---------- one problem ----------

  /** The start of a line about one problem's search: indented, and with the problem's label when several run at once. */
  private sub(label: string): string {
    return this.o.parallelProblems > 1 ? `  ${label}: ` : "  ";
  }

  /** Searches one problem and submits its best if it qualifies. False when it could not be searched. */
  private async searchOne(t: Target, lanes: number): Promise<boolean> {
    const p: Problem = { N: t.N, M: t.M, P: t.P };
    const key = problemKey(p);
    const label = problemLabel(p);

    const { info, answer } = await this.readProblem(this.reader, p);
    if (this.stopped) return false;
    if (!info) {
      this.log(
        `Could not read ${label} (${answer?.status === 200 ? "malformed answer" : describeAnswer(answer)}); skipping it for 10 minutes`,
      );
      this.skipUntil.set(key, this.now() + TARGETS_TTL_MS);
      return false;
    }
    if (!info.accepts_submissions) {
      this.log(`${label} is closed: its published optimum is proven. Skipping it.`);
      this.skipUntil.set(key, Infinity);
      return false;
    }
    const site = info.site_best;
    const leader: LeaderRef | null = site ? { id: site.id, score: site.score, name: site.name } : null;
    const published = info.literature?.value ?? null;
    // the leader's coordinates are read only when they are the better start
    let stored: StoredEntry | null = null;
    const publishedStart = published !== null && info.literature?.pieces !== undefined;
    if (leader && !(publishedStart && published < leader.score)) {
      const a = await this.reader.entry(leader.id!);
      stored = a?.status === 200 ? readStoredEntry(a.body, p.P) : null;
      if (!stored && !this.stopped)
        this.log(
          `Could not read the leader's packing #${leader.id} (${a?.status === 200 ? "malformed answer" : describeAnswer(a)})`,
        );
    }
    if (this.stopped) return false;
    const known = buildKnown(info, stored);

    const maxSeconds = this.maxSeconds();
    const engineSeed = randomInt(2 ** 32);
    const control: Control = { aborted: this.stopped, paused: this.paused };
    const cur: Current = {
      label,
      key,
      lanes,
      control,
      startedAt: this.clock.now(),
      maxSeconds,
      jobs: 0,
      best: null,
      leader: leader?.score ?? null,
      against: "leader",
      crashed: 0,
    };
    this.currents.add(cur);
    /** The best strict packing reported so far. */
    let seen: Candidate | null = null;
    this.log(
      `Searching ${label} (${t.reason}): leader ` +
        (leader ? `${formatScore(leader.score)} by "${cleanText(leader.name, 60)}"` : "none") +
        `, published ${published === null ? "none" : formatScore(published)}, area bound ${formatScore(info.area_bound)}; ` +
        `starting from ${known ? (known.source === "site" ? "the leader's packing" : "the published packing") : "nothing"}; ` +
        `up to ${formatDuration(maxSeconds)} on ${lanes} thread(s)`,
    );
    const input: SearchInput = {
      problem: p,
      known,
      leader: leader?.score ?? null,
      published,
      areaBound: info.area_bound,
      maxSeconds,
      lanes,
      seed: engineSeed,
      memory: this.memory,
      memoryNow: () => this.memory,
      now: () => this.clock.now(),
      onResult: (result, best) => {
        cur.jobs++;
        if (result.termination === "crashed") cur.crashed++;
        if (best && best.strict && (!cur.best || best.score < cur.best.score)) {
          cur.best = best;
          seen = best;
          this.log(
            `${this.sub(label)}best so far ${formatScore(best.score)} (${best.job.method}, ${best.job.kind}, seed ${best.job.seed})` +
              (cur.leader === null ? "" : `, ${relativePercent(best.score, cur.leader)} against the leader`),
          );
        }
      },
    };

    let outcome: SearchOutcome | null = null;
    let stopped: string;
    try {
      outcome = await this.untilHardStop(this.search(input, this.pool!.runJob, control));
      stopped = outcome ? outcome.stopped : "interrupted";
    } catch (error) {
      this.log(`The search of ${label} failed: ${errorText(error)}`);
      stopped = "error";
    }
    // a search whose every job lost its thread searched nothing: it is not a search to skip for a week
    const allCrashed = cur.jobs > 0 && cur.crashed === cur.jobs;
    if (allCrashed) {
      stopped = "crashed";
      this.log(`Every job of ${label} lost its search thread; skipping it for 10 minutes`);
      this.skipUntil.set(key, this.now() + TARGETS_TTL_MS);
    }
    const activeSeconds = this.clock.now() - cur.startedAt;
    this.currents.delete(cur);
    if (outcome) {
      this.memory = outcome.memory;
      this.saveMemory();
    }

    // this search's best, kept on disk when it is the best this machine has found for the problem
    const found = outcome?.best && outcome.best.strict ? outcome.best : seen;
    const file = this.state.readBest(p);
    const saved = file ? candidateOf(file) : null;
    if (found && (!saved || improvesOn(found.score, saved.score))) {
      try {
        this.state.writeBest(bestFileOf(found, VERSION, new Date(this.now())));
      } catch (error) {
        this.log(`Could not save the best packing: ${(error as Error).message}`);
      }
    }
    // an earlier search's best still counts: its submission may have failed, or it was a dry run
    const offer = better(found, saved);

    let decision: Decision = { submit: false, reason: "no strict packing" };
    let leaderAfter: LeaderRef | null = null;
    let sent: SubmitOutcome | null = null;
    if (offer) {
      // the leader is read again just before submitting: it may have changed during the search
      const fresh = await this.readProblem(this.submitter, p);
      if (!fresh.info)
        decision = { submit: false, reason: `could not re-read the leader (${describeAnswer(fresh.answer)})` };
      else {
        const fl = fresh.info.site_best;
        leaderAfter = fl ? { id: fl.id, score: fl.score, name: fl.name } : null;
        cur.leader = fl?.score ?? null;
        if (!fresh.info.accepts_submissions) this.skipUntil.set(key, Infinity);
        decision = decideSubmission({
          best: offer,
          open: fresh.info.accepts_submissions,
          leader: fl?.score ?? null,
          dryRun: this.o.dryRun,
        });
      }
      if (decision.submit) {
        const name = this.o.name!;
        const body = submissionBody(offer, { name, note: this.o.note, software: SOFTWARE });
        // after a POST without an answer: is the packing stored?
        const check = async (): Promise<SubmitCheck | null> => {
          const again = await this.readProblem(this.submitter, p);
          return again.info ? checkStored(again.info, name, offer.score) : null;
        };
        sent = await this.submitter.submit(body, check);
        if (sent.requests > 0) this.counts.sent++;
      }
    }
    const result = this.interpret(p, offer, sent);
    if (result.leaderAfter !== undefined) leaderAfter = result.leaderAfter;

    const line: HistoryLine = {
      time: new Date(this.now()).toISOString(),
      ...p,
      reason: t.reason ?? null,
      priority: t.priority ?? null,
      leader_before: leader,
      leader_after: leaderAfter ?? (offer ? null : leader),
      published,
      best: offer
        ? {
            score: offer.score,
            method: offer.job.method,
            seed: offer.job.seed,
            kind: offer.job.kind,
            budget: { ...offer.job.budget },
            from: offer === found ? "search" : "file",
          }
        : null,
      jobs: outcome?.jobs ?? cur.jobs,
      stopped,
      active_s: Math.round(activeSeconds * 1000) / 1000,
      engine_seed: engineSeed,
      dry_run: this.o.dryRun,
      submitted: (sent?.requests ?? 0) > 0,
      decision: result.decision ?? decision.reason,
      status: sent?.answer?.status ?? null,
      response: result.response,
      version: VERSION,
    };
    try {
      this.state.appendHistory(line);
    } catch (error) {
      this.log(`Could not write the history: ${(error as Error).message}`);
    }
    noteSearch(this.recent, line, this.o.dryRun);
    this.counts.problems++;

    // compared with the leader the search started against, not with an entry it just made
    const vs =
      offer === null
        ? "no strict packing"
        : `best ${formatScore(offer.score)} (${offer.job.method}, seed ${offer.job.seed}` +
          `${offer === found ? "" : ", from an earlier search"}) vs ` +
          (leader === null
            ? "no leader"
            : `leader ${formatScore(leader.score)} (${relativePercent(offer.score, leader.score)})`);
    const what = result.text ?? (offer === null ? "nothing to submit" : decision.reason);
    this.log(
      `Finished ${label} after ${formatDuration(activeSeconds)} (${stopped}), ${line.jobs} job(s): ${vs}; ${what}`,
    );
    return !allCrashed;
  }

  /**
   * What a submission came to: the text for the end-of-problem line, the history's `response` and
   * `decision` when they differ from the plain answer, and the leader after it when it is known.
   */
  private interpret(
    p: Problem,
    offer: Candidate | null,
    sent: SubmitOutcome | null,
  ): {
    text?: string;
    decision?: string;
    response: HistoryLine["response"];
    leaderAfter?: LeaderRef | null;
  } {
    if (!sent || !offer) return { response: null };
    const key = problemKey(p);
    const kept = `the packing stays in ${this.state.bestPath(p)}`;
    const a = sent.answer;
    if (a) {
      const response = readSubmitResponse(a.body);
      if (a.status === 200 && response?.valid) {
        this.counts.accepted++;
        if (response.leader) {
          this.counts.leading++;
          return {
            text:
              `submitted: HTTP 200, the new leader (#${response.id})` +
              (response.pending_verification ? ", pending verification" : ""),
            response,
            leaderAfter: { id: response.id, score: response.score ?? offer.score, name: this.o.name! },
          };
        }
        const stays = response.leader_score === null ? "unchanged" : formatScore(response.leader_score);
        return { text: `submitted: HTTP 200, accepted, but the leader stays at ${stays}`, response };
      }
      if (a.status === 409) this.skipUntil.set(key, Infinity);
      return { text: `refused: ${describeAnswer(a)}`, response };
    }
    const failure = cleanText(sent.failure ?? "no answer");
    if (sent.requests === 0)
      return { text: `not sent (${failure}); ${kept}`, decision: `not sent: ${failure}`, response: null };
    const c = sent.check;
    if (c?.state === "ours") {
      // the POST was stored although its answer was lost
      this.counts.accepted++;
      this.counts.leading++;
      return {
        text: `submitted: no answer came (${failure}), but the problem now shows it as the leader (#${c.id})`,
        decision: "no answer, but a re-read found it stored as the leader",
        response: {
          valid: true,
          leader: true,
          score: c.score,
          leader_score: c.score,
          id: c.id,
          pending_verification: false,
          reasons: [],
        },
        leaderAfter: { id: c.id, score: c.score, name: this.o.name! },
      };
    }
    if (c?.state === "closed") {
      this.skipUntil.set(key, Infinity);
      return {
        text: `no answer came (${failure}), and the problem is now closed`,
        decision: "no answer; closed",
        response: null,
      };
    }
    if (c?.state === "beaten")
      return {
        text: `no answer came (${failure}); the leader is now ${formatScore(c.leader)}, at least as good: not sent again`,
        decision: "no answer; beaten meanwhile",
        response: null,
      };
    if (c?.state === "absent")
      return {
        text: `sent ${sent.requests} time(s) without an answer (${failure}), and not stored; ${kept}`,
        decision: "no answer; not stored",
        response: null,
      };
    return {
      text: `sent, but no answer came (${failure}) and the problem could not be read again: it may be stored or not; ${kept}`,
      decision: "no answer; unknown whether stored",
      response: null,
    };
  }

  // ---------- one problem of the new spaces ----------

  private async readSpaceProblem(
    api: Api,
    p: SpaceProblem,
  ): Promise<{ info: SpaceProblemInfo | null; answer: Answer | null }> {
    const answer = await api.spaceProblem(p.space, p.id);
    return { info: answer?.status === 200 ? readSpaceProblem(answer.body, p) : null, answer };
  }

  /**
   * Searches one space problem and submits its best if it qualifies, as searchOne does for the
   * polygon problems. False when it could not be searched.
   */
  private async searchSpace(t: SpaceTarget, lanes: number): Promise<boolean> {
    const p = parseSpaceId(t.id);
    if (!p) throw new Error(`not a space problem id: ${t.id}`);
    const key = p.id;
    const label = p.id;

    const { info, answer } = await this.readSpaceProblem(this.reader, p);
    if (this.stopped) return false;
    if (!info) {
      this.log(
        `Could not read ${label} (${answer?.status === 200 ? "malformed answer" : describeAnswer(answer)}); skipping it for 10 minutes`,
      );
      this.skipUntil.set(key, this.now() + TARGETS_TTL_MS);
      return false;
    }
    if (!info.accepts_submissions) {
      const why =
        info.closed_reason ??
        (info.certified?.status === "infeasible" ? "no packing exists (proved)" : "its value is proven");
      this.log(`${label} is closed: ${why}. Skipping it.`);
      this.skipUntil.set(key, Infinity);
      return false;
    }
    const before = bestRef(info);
    const known = buildSpaceKnown(info);
    // the server's whole rule: also valid at the strict tolerance when below the research record, or when the
    // problem has no research record yet
    const rule: SpaceRule = {
      bound: info.bound,
      certified: info.certified?.score ?? null,
      ...(info.no_record ? { noRecord: true } : {}),
    };
    const maxSeconds = this.maxSeconds();
    const engineSeed = randomInt(2 ** 32);
    const control: Control = { aborted: this.stopped, paused: this.paused };
    const cur: Current = {
      label,
      key,
      lanes,
      control,
      startedAt: this.clock.now(),
      maxSeconds,
      jobs: 0,
      best: null,
      leader: info.best_score,
      against: "best",
      crashed: 0,
    };
    this.currents.add(cur);
    // nofold problems of the Platonic solids are planar problems of one face (the polygon engine); those
    // of the other solids run the surface search in its nofold mode, like any other space job (Auto only)
    const nofold = nofoldOnPolygonEngine(p);
    // the method of its jobs: --space-method where the problem offers it, else auto
    const asked = this.o.spaceMethod;
    const chosen = nofold ? { method: "auto", fallback: false } : chooseSpaceMethod(p.space, p.id, asked);
    const params = chosen.method !== "auto" ? (this.o.spaceParams ?? undefined) : undefined;
    const methodText = nofold
      ? "the polygon engine's methods"
      : spaceMethodNote(p.space, chosen.method, params, Infinity);
    this.log(
      `Searching ${label} (priority ${t.priority.toPrecision(3)}): best ` +
        (before
          ? `${formatScore(before.score)} (${before.source === "site" ? `site entry by "${cleanText(before.name, 60)}"` : "research record"})`
          : "none") +
        `, lower bound ${info.bound === null ? "none" : formatScore(info.bound)}; ` +
        `starting from ${known ? (known.source === "site" ? "the site's leader" : "the research record") : "nothing"}` +
        (nofold ? ", as a planar packing of one face" : "") +
        `; method ${methodText}; up to ${formatDuration(maxSeconds)} on ${lanes} thread(s)`,
    );
    if (nofold && asked !== "auto")
      this.log(
        `${this.sub(label)}--space-method ${asked} does not apply here: nofold problems run the polygon engine's own methods`,
      );
    else if (chosen.fallback)
      this.log(
        `${this.sub(label)}${p.id} does not offer ${asked} (${checkSpaceMethod(p, asked, this.o.spaceParams ?? undefined) ?? "not offered"}), so it runs auto`,
      );
    const onBest = (score: number, what: string) => {
      if (cur.best && !(score < cur.best.score)) return;
      cur.best = { score };
      this.log(
        `${this.sub(label)}best so far ${formatScore(score)} (${what})` +
          (cur.leader === null ? "" : `, ${relativePercent(score, cur.leader)} against the best`),
      );
    };

    let outcome: { best: SpaceCandidate | null; jobs: number; stopped: string } | null = null;
    let stopped: string;
    try {
      outcome = nofold
        ? await this.searchNofold(p as NofoldProblem, known, rule, maxSeconds, engineSeed, cur, onBest)
        : await this.untilHardStop<SpaceSearchOutcome>(
            (this.deps.searchSpace ?? searchSpaceProblem)(
              {
                space: p.space,
                id: p.id,
                known,
                bound: info.bound,
                certified: rule.certified,
                ...(rule.noRecord ? { noRecord: true } : {}),
                maxSeconds,
                lanes,
                seed: engineSeed,
                now: () => this.clock.now(),
                method: this.o.spaceMethod,
                ...(this.o.spaceParams ? { params: this.o.spaceParams } : {}),
                onResult: (result, best) => {
                  cur.jobs++;
                  if (result.termination === "crashed") cur.crashed++;
                  // the engine hands a generic method that reached its kernel's bound over to auto
                  if (result.termination === "bound" && result.valid && (result.job.method ?? "auto") !== "auto")
                    this.log(
                      `${this.sub(label)}${result.job.method} reached its kernel's bound at ${formatScore(result.score!)}; auto goes on`,
                    );
                  if (best)
                    onBest(
                      best.score,
                      `${spaceMethodName(best.job.space, best.job.method)}, ${best.job.kind}, seed ${best.job.seed}`,
                    );
                },
              },
              this.pool!.runSpaceJob,
              control,
            ),
          );
      stopped = outcome ? outcome.stopped : "interrupted";
    } catch (error) {
      this.log(`The search of ${label} failed: ${errorText(error)}`);
      stopped = "error";
    }
    const allCrashed = cur.jobs > 0 && cur.crashed === cur.jobs;
    if (allCrashed) {
      stopped = "crashed";
      this.log(`Every job of ${label} lost its search thread; skipping it for 10 minutes`);
      this.skipUntil.set(key, this.now() + TARGETS_TTL_MS);
    }
    const activeSeconds = this.clock.now() - cur.startedAt;
    this.currents.delete(cur);

    // The best this machine has found for the problem stays in best/spaces/. Both it and the
    // search's best are checked by the server's rule first, with the score the check computes: a
    // configuration the rule refuses is never offered, so it is not sent again at later visits.
    const passing = (c: SpaceCandidate | null): SpaceCandidate | null => {
      if (!c) return null;
      const v = checkSpaceConfig(p.space, p.id, c.config, rule);
      return v.valid && v.score !== null ? { ...c, score: v.score } : null;
    };
    const found = passing(outcome?.best ?? null);
    const file = this.state.readSpaceBest(p);
    const saved = passing(file ? spaceCandidateOf(file) : null);
    if (file && !saved)
      this.log(
        `The configuration kept in ${this.state.spaceBestPath(p.id)} does not pass the check now; it is not offered`,
      );
    if (found && (!saved || improvesOn(found.score, saved.score))) {
      try {
        this.state.writeSpaceBest(spaceBestFileOf(found, p.P, VERSION, new Date(this.now())));
      } catch (error) {
        this.log(`Could not save the best configuration: ${(error as Error).message}`);
      }
    }
    const offer = betterSpace(found, saved);

    let decision = { submit: false, reason: "no valid configuration" };
    let after: SpaceLeaderRef | null = null;
    let sent: SubmitOutcome | null = null;
    if (offer) {
      // the problem's best is read again just before submitting, and the configuration checked once more
      const fresh = await this.readSpaceProblem(this.submitter, p);
      if (!fresh.info)
        decision = { submit: false, reason: `could not re-read the problem (${describeAnswer(fresh.answer)})` };
      else {
        after = bestRef(fresh.info);
        cur.leader = fresh.info.best_score;
        if (!fresh.info.accepts_submissions) this.skipUntil.set(key, Infinity);
        decision = decideSpaceSubmission({
          best: offer,
          check: checkSpaceConfig(p.space, p.id, offer.config, {
            bound: fresh.info.bound ?? info.bound,
            certified: fresh.info.certified?.score ?? rule.certified,
            ...(fresh.info.no_record ? { noRecord: true } : {}),
          }),
          open: fresh.info.accepts_submissions,
          bestScore: fresh.info.best_score,
          bound: fresh.info.bound ?? info.bound,
          dryRun: this.o.dryRun,
          // the server's keep rule, with the record margin of the space (polyhedra: 1e-6)
          record: {
            space: p.space,
            certified: fresh.info.certified?.score ?? null,
            leader: fresh.info.site_best?.score ?? null,
          },
        });
      }
      if (decision.submit) {
        const name = this.o.name!;
        const body = spaceSubmissionBody(p, offer, { name, note: this.o.note, software: SOFTWARE });
        const check = async (): Promise<SubmitCheck | null> => {
          const again = await this.readSpaceProblem(this.submitter, p);
          return again.info ? checkSpaceStored(again.info, name, offer.score) : null;
        };
        sent = await this.submitter.submit(body as unknown as Record<string, unknown>, check, "/api/spaces/submit");
        if (sent.requests > 0) this.counts.sent++;
      }
    }
    const result = this.interpretSpace(p, offer, sent, rule.certified ?? null);
    if (result.after !== undefined) after = result.after;

    const line: SpaceHistoryLine = {
      time: new Date(this.now()).toISOString(),
      space: p.space,
      id: p.id,
      P: p.P,
      priority: t.priority,
      leader_before: before,
      leader_after: after ?? (offer ? null : before),
      bound: info.bound,
      best: offer
        ? {
            score: offer.score,
            method: spaceMethodName(offer.job.space, offer.job.method),
            ...(offer.job.params ? { params: offer.job.params } : {}),
            seed: offer.job.seed,
            kind: offer.job.kind,
            budget: { ...offer.job.budget },
            from: offer === found ? "search" : "file",
          }
        : null,
      jobs: outcome?.jobs ?? cur.jobs,
      stopped,
      active_s: Math.round(activeSeconds * 1000) / 1000,
      engine_seed: engineSeed,
      dry_run: this.o.dryRun,
      submitted: (sent?.requests ?? 0) > 0,
      decision: result.decision ?? decision.reason,
      status: sent?.answer?.status ?? null,
      response: result.response,
      version: VERSION,
    };
    try {
      this.state.appendHistory(line);
    } catch (error) {
      this.log(`Could not write the history: ${(error as Error).message}`);
    }
    noteSearch(this.recent, line, this.o.dryRun);
    this.counts.problems++;

    const vs =
      offer === null
        ? "no valid configuration"
        : `best ${formatScore(offer.score)} (${spaceMethodName(offer.job.space, offer.job.method)}, seed ${offer.job.seed}` +
          `${offer === found ? "" : ", from an earlier search"}) vs ` +
          (before === null
            ? "no best"
            : `best ${formatScore(before.score)} (${relativePercent(offer.score, before.score)})`);
    const what = result.text ?? (offer === null ? "nothing to submit" : decision.reason);
    this.log(
      `Finished ${label} after ${formatDuration(activeSeconds)} (${stopped}), ${line.jobs} job(s): ${vs}; ${what}`,
    );
    return !allCrashed;
  }

  /**
   * A surface problem in the nofold mode on a Platonic solid: the polygon engine searches the planar packing of one
   * face (spaces/nofold.ts), and its best is copied onto the faces.
   */
  private async searchNofold(
    p: NofoldProblem,
    known: ReturnType<typeof buildSpaceKnown>,
    rule: SpaceRule,
    maxSeconds: number,
    seed: number,
    cur: Current,
    onBest: (score: number, what: string) => void,
  ): Promise<{ best: SpaceCandidate | null; jobs: number; stopped: string } | null> {
    const face = faceProblem(p, known?.config);
    let seen: Candidate | null = null;
    const input: SearchInput = {
      problem: face.problem,
      known: face.known ? { ...face.known, source: known?.source === "site" ? "site" : "literature" } : undefined,
      leader: null,
      published: null,
      areaBound: face.areaBound,
      maxSeconds,
      lanes: cur.lanes,
      seed,
      memory: this.memory,
      memoryNow: () => this.memory,
      now: () => this.clock.now(),
      onResult: (result, best) => {
        cur.jobs++;
        if (result.termination === "crashed") cur.crashed++;
        if (best && best.strict && (!seen || best.score < seen.score)) {
          seen = best;
          onBest(best.score, `${best.job.method} on one face, ${best.job.kind}, seed ${best.job.seed}`);
        }
      },
    };
    const out = await this.untilHardStop(this.search(input, this.pool!.runJob, cur.control));
    if (out) {
      this.memory = out.memory;
      this.saveMemory();
    }
    const best2D = out?.best && out.best.strict ? out.best : seen;
    let best: SpaceCandidate | null = null;
    const b = best2D as Candidate | null;
    const config = b ? surfaceFromFace(p, b.config) : null;
    if (b && config) {
      const check = checkSpaceConfig(p.space, p.id, config, rule);
      if (check.valid && check.score !== null)
        best = {
          config,
          score: check.score,
          job: {
            space: "surface",
            id: p.id,
            method: `nofold face packing: ${b.job.method}`,
            seed: b.job.seed,
            budget: { ...b.job.budget },
            kind: b.job.kind as SpaceCandidate["job"]["kind"],
          },
        };
    }
    return out
      ? { best, jobs: out.jobs, stopped: out.stopped }
      : best
        ? { best, jobs: cur.jobs, stopped: "interrupted" }
        : null;
  }

  /** What a space submission came to, as interpret() does for the polygon problems. */
  private interpretSpace(
    p: SpaceProblem,
    offer: SpaceCandidate | null,
    sent: SubmitOutcome | null,
    certified: number | null,
  ): { text?: string; decision?: string; response: SpaceHistoryLine["response"]; after?: SpaceLeaderRef | null } {
    if (!sent || !offer) return { response: null };
    const kept = `the configuration stays in ${this.state.spaceBestPath(p.id)}`;
    const a = sent.answer;
    if (a) {
      const response = readSpaceSubmitResponse(a.body);
      if (a.status === 200 && response?.valid) {
        this.counts.accepted++;
        if (response.leader) {
          this.counts.leading++;
          return {
            text:
              `submitted: HTTP 200, the new leader of the site's entries (#${response.id})` +
              (response.beats_certified ? ", below the research record" : ""),
            response,
            after: { id: response.id, score: response.score ?? offer.score, source: "site", name: this.o.name! },
          };
        }
        const stays = response.best_score === null ? "unchanged" : formatScore(response.best_score);
        return { text: `submitted: HTTP 200, valid, but the best stays at ${stays}`, response };
      }
      // a score the server could not keep is answered without a check (polyhedra)
      if (a.status === 200 && (a.body as { checked?: unknown } | null)?.checked === false) {
        const stays = response?.best_score == null ? "unchanged" : formatScore(response.best_score);
        return { text: `submitted: HTTP 200, not kept and not checked: the best is now ${stays}`, response };
      }
      if (a.status === 409) this.skipUntil.set(p.id, Infinity);
      return { text: `refused: ${describeAnswer(a)}`, response };
    }
    const failure = cleanText(sent.failure ?? "no answer");
    if (sent.requests === 0)
      return { text: `not sent (${failure}); ${kept}`, decision: `not sent: ${failure}`, response: null };
    const c = sent.check;
    if (c?.state === "ours") {
      this.counts.accepted++;
      this.counts.leading++;
      return {
        text: `submitted: no answer came (${failure}), but the problem now shows it as the site's leader (#${c.id})`,
        decision: "no answer, but a re-read found it stored as the leader",
        response: {
          valid: true,
          leader: true,
          score: c.score,
          best_score: c.score,
          id: c.id,
          beats_certified: certified !== null && improvesOn(c.score, certified),
          reasons: [],
        },
        after: { id: c.id, score: c.score, source: "site", name: this.o.name! },
      };
    }
    if (c?.state === "closed") {
      this.skipUntil.set(p.id, Infinity);
      return {
        text: `no answer came (${failure}), and the problem is now closed`,
        decision: "no answer; closed",
        response: null,
      };
    }
    if (c?.state === "beaten")
      return {
        text: `no answer came (${failure}); the best is now ${formatScore(c.leader)}, at least as good: not sent again`,
        decision: "no answer; beaten meanwhile",
        response: null,
      };
    if (c?.state === "absent")
      return {
        text: `sent ${sent.requests} time(s) without an answer (${failure}), and not stored; ${kept}`,
        decision: "no answer; not stored",
        response: null,
      };
    return {
      text: `sent, but no answer came (${failure}) and the problem could not be read again: it may be stored or not; ${kept}`,
      decision: "no answer; unknown whether stored",
      response: null,
    };
  }

  /**
   * The status line, once a minute: the problem being searched, the threads and the submissions.
   * With several problems at once, a line for each problem and then one for the threads.
   */
  private status(): void {
    const s = this.pool?.stats();
    const lanes = s ? `threads ${s.busy} busy, ${s.paused} paused, ${s.idle} idle` : "";
    const subs = `${this.counts.accepted} submission(s) accepted`;
    const paused = this.paused ? "; paused on battery power" : "";
    const describe = (c: Current) => {
      const elapsed = this.clock.now() - c.startedAt;
      const best = c.best ? formatScore(c.best.score) : "none yet";
      const vs =
        c.leader === null
          ? `no ${c.against}`
          : `${c.against} ${formatScore(c.leader)}` + (c.best ? ` (${relativePercent(c.best.score, c.leader)})` : "");
      return (
        `${c.label}, ${formatDuration(elapsed)} of ${formatDuration(c.maxSeconds)}; ` +
        `best ${best} vs ${vs}; ${c.jobs} job(s) run`
      );
    };
    if (this.o.parallelProblems > 1) {
      for (const c of this.currents) this.log(`Status: ${describe(c)} on ${c.lanes} thread(s)`);
      this.log(
        `Status: ${this.currents.size} of ${this.o.parallelProblems} problems being searched; ${lanes}; ${subs}${paused}`,
      );
      return;
    }
    const [c] = this.currents;
    if (!c) {
      this.log(`Status: between problems; ${subs}${paused}`);
      return;
    }
    this.log(`Status: ${describe(c)}; ${lanes}; ${subs}${paused}`);
  }
}
