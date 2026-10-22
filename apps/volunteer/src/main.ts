/**
 * The volunteer client's main loop: take a problem from the server's work list, search it with the
 * engine on the worker pool, submit the best only when it beats the site's leader, and move on.
 *
 * `main` returns the exit code instead of exiting, and takes its network, output, engine and
 * battery from `deps`, so that test/cli.test.ts runs it end to end against an in-process server.
 */
import { randomInt } from "node:crypto";
import os from "node:os";
import {
  type ProblemInfo,
  type SubmitResponse,
  type Target,
  type TargetsResponse,
  improvesOn,
} from "@polypack/geometry";
import { onBattery, watchBattery } from "./battery";
import { ActiveClock } from "./clock";
import { searchProblem as engineSearch } from "./engine/index";
import { formatDuration, formatScore, problemKey, problemLabel, relativePercent, timestamp } from "./format";
import { type Answer, Api, type Sleep, compactList, realSleep } from "./http";
import { type Machine, OptionError, type Options, helpText, parseOptions } from "./options";
import { type Recent, noteSearch, pickTarget, recentFromHistory } from "./pick";
import { WorkerPool } from "./pool";
import { type HistoryLine, type LeaderRef, LockHeld, StateDir, bestFileOf, candidateOf } from "./state";
import { type Decision, type StoredEntry, better, buildKnown, decideSubmission, submissionBody } from "./submit";
import type { Candidate, Control, Problem, SearchInput, SearchOutcome, SearchProblem } from "./types";
import { SOFTWARE, VERSION } from "./version";

/** The work list is read again after this long. */
export const TARGETS_TTL_MS = 10 * 60_000;
/** After the first signal (or the end of --hours), the most the client waits before it exits. */
export const STOP_GRACE_MS = 30_000;

export interface MainDeps {
  fetch?: typeof fetch;
  /** Normal output, one line per call; default console.log. */
  out?: (line: string) => void;
  /** Option errors; default console.error. */
  err?: (line: string) => void;
  /** The engine; default src/engine's searchProblem. */
  searchProblem?: SearchProblem;
  /** Install the SIGINT and SIGTERM handlers; default true. */
  signals?: boolean;
  random?: () => number;
  /** Whether the machine is on battery power; default battery.ts's onBattery. */
  checkBattery?: () => Promise<boolean>;
  batteryEveryMs?: number;
  statusEveryMs?: number;
  machine?: Partial<Machine>;
  sleep?: Sleep;
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

/** The problem being searched, for the status line. */
interface Current {
  problem: Problem;
  control: Control;
  startedAt: number;
  maxSeconds: number;
  jobs: number;
  best: Candidate | null;
  leader: number | null;
}

const isTarget = (t: unknown): t is Target => {
  const v = t as Target;
  return Number.isInteger(v?.N) && Number.isInteger(v?.M) && Number.isInteger(v?.P) && typeof v.priority === "number";
};

const isProblemInfo = (body: unknown, p: Problem): body is ProblemInfo => {
  const v = body as ProblemInfo;
  return (
    v?.N === p.N &&
    v.M === p.M &&
    v.P === p.P &&
    typeof v.accepts_submissions === "boolean" &&
    typeof v.area_bound === "number"
  );
};

const isStoredEntry = (body: unknown): body is StoredEntry => {
  const v = body as StoredEntry;
  return typeof v?.score === "number" && Array.isArray(v.pieces);
};

/** "HTTP 422: overlap of pieces 3 and 7" or "no answer". */
function describeAnswer(a: Answer | null): string {
  if (!a) return "no answer from the server";
  const body = a.body as { reasons?: unknown; error?: unknown } | null;
  const why = Array.isArray(body?.reasons)
    ? body.reasons.join("; ")
    : typeof body?.error === "string"
      ? body.error
      : typeof a.body === "string"
        ? a.body.slice(0, 200)
        : "";
  return `HTTP ${a.status}${why ? `: ${why}` : ""}`;
}

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
  private pool: WorkerPool | null = null;
  private state!: StateDir;
  private memory: unknown;
  private recent = new Map<string, Recent>();
  /** Problems not to pick again before a time (ms): closed ones forever, unreadable ones for a while. */
  private readonly skipUntil = new Map<string, number>();
  private targets: { at: number; list: Target[] } | null = null;
  /** Whether to send the filters with GET /api/targets; dropped if the server refuses them. */
  private filterOnServer = true;
  private paused = false;
  private stopReason: string | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  private current: Current | null = null;
  private readonly started = Date.now();
  private readonly counts = { problems: 0, sent: 0, accepted: 0, leading: 0 };

  constructor(
    private readonly o: Options,
    private readonly deps: MainDeps,
    private readonly out: (line: string) => void,
  ) {
    const http = {
      fetch: deps.fetch,
      sleep: deps.sleep,
      log: (m: string) => this.log(m),
      userAgent: `${SOFTWARE} (Node ${process.version})`,
    };
    this.reader = new Api(o.base, { ...http, signal: this.stop.signal });
    this.submitter = new Api(o.base, { ...http, signal: this.hard.signal });
    this.sleep = deps.sleep ?? realSleep;
    this.search = deps.searchProblem ?? engineSearch;
    this.random = deps.random ?? Math.random;
  }

  private log(message: string): void {
    this.out(`[${timestamp()}] ${message}`);
  }

  private get stopped(): boolean {
    return this.stop.signal.aborted;
  }

  async run(): Promise<number> {
    try {
      this.state = StateDir.open(this.o.stateDir);
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
    this.recent = recentFromHistory(this.state.readHistory());
    const cleanups: (() => void)[] = [];
    try {
      this.banner();
      this.pool = await WorkerPool.create({ size: this.o.cores, priority: this.o.priority, log: (m) => this.log(m) });
      if (this.o.batteryPause) {
        const watcher = watchBattery(
          this.deps.checkBattery ?? (() => onBattery()),
          (b) => this.onBatteryChange(b),
          this.deps.batteryEveryMs ?? 30_000,
        );
        cleanups.push(() => watcher.stop());
      }
      if (this.deps.signals !== false) cleanups.push(this.installSignals());
      if (Number.isFinite(this.o.hours)) cleanups.push(this.armDeadline());
      const ticker = setInterval(() => this.status(), this.deps.statusEveryMs ?? 60_000);
      ticker.unref();
      cleanups.push(() => clearInterval(ticker));
      const code = await this.loop();
      this.log(
        `Stopped after ${formatDuration((Date.now() - this.started) / 1000)}: ${this.counts.problems} problem(s) ` +
          `searched, ${this.counts.sent} submission(s) sent, ${this.counts.accepted} accepted, ` +
          `${this.counts.leading} took the lead. State is in ${this.o.stateDir}.`,
      );
      return code;
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
        `${o.cores} search thread(s) on ${os.availableParallelism()} core(s), ${o.priority} priority`,
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
        (this.current ? "The search is aborted; its best is submitted if it beats the leader. " : "") +
        `Exiting within ${STOP_GRACE_MS / 1000} s; a second Ctrl-C exits at once.`,
    );
    this.stop.abort();
    if (this.current) this.current.control.aborted = true;
    this.pool?.stop();
    this.hardTimer = setTimeout(() => this.hard.abort(), STOP_GRACE_MS);
    this.hardTimer.unref();
  }

  private armDeadline(): () => void {
    const end = this.started + this.o.hours * 3600_000;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      const left = end - Date.now();
      if (left <= 0) return this.requestStop(`The --hours limit (${this.o.hours} h) is reached`);
      // setTimeout takes at most about 24.8 days
      timer = setTimeout(arm, Math.min(left, 2 ** 31 - 1));
      timer.unref();
    };
    arm();
    return () => clearTimeout(timer);
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
    if (this.current) this.current.control.paused = paused;
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

  // ---------- the loop ----------

  private async loop(): Promise<number> {
    let failures = 0;
    while (!this.stopped) {
      // nothing new starts on battery power
      while (this.paused && !this.stopped) await this.wait(1000);
      if (this.stopped) break;
      const list = await this.readTargets();
      if (this.stopped) break;
      if (list === "missing") {
        this.log(
          `The server at ${this.o.base} has no work list: GET /api/targets answered 404, so it runs a version of ` +
            "PolyPack older than this client. Try again once it is updated, or give --base a server that has it.",
        );
        return 1;
      }
      if (list === null) {
        if (this.o.once) return 1;
        failures++;
        const ms = Math.min(60_000, 2000 * 2 ** failures);
        this.log(`Could not read the work list; trying again in ${ms / 1000} s`);
        await this.wait(ms);
        continue;
      }
      failures = 0;
      const now = Date.now();
      const skip = new Set([...this.skipUntil].filter(([, until]) => until > now).map(([key]) => key));
      const target = pickTarget(list, {
        filters: { N: this.o.N, M: this.o.M, maxP: this.o.maxP },
        recent: this.recent,
        skip,
        now,
        random: this.random,
      });
      if (!target) {
        const wait = Math.max(60_000, this.targets!.at + TARGETS_TTL_MS - now);
        this.log(
          list.length
            ? `Nothing to search: the work list's ${list.length} problem(s) are filtered out, closed, or were ` +
                "searched here in the last 7 days with the same leader." +
                (this.o.once ? "" : ` Looking again in ${formatDuration(wait / 1000)}.`)
            : "The work list is empty." + (this.o.once ? "" : ` Looking again in ${formatDuration(wait / 1000)}.`),
        );
        if (this.o.once) return 0;
        await this.wait(wait);
        continue;
      }
      await this.searchOne(target);
      if (this.o.once) break;
    }
    return 0;
  }

  /** The work list, from the cache while it is fresh; "missing" on 404; null when unreachable. */
  private async readTargets(): Promise<Target[] | "missing" | null> {
    const now = Date.now();
    if (this.targets && now - this.targets.at < TARGETS_TTL_MS) return this.targets.list;
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
    const list = body.targets.filter(isTarget);
    this.targets = { at: now, list };
    this.log(
      `Read the work list: ${list.length} problem(s)` + (body.generated_at ? `, ranked at ${body.generated_at}` : ""),
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
    if (Number.isFinite(this.o.hours))
      s = Math.min(s, Math.max(1, (this.started + this.o.hours * 3600_000 - Date.now()) / 1000));
    return s;
  }

  private async readProblem(api: Api, p: Problem): Promise<{ info: ProblemInfo | null; answer: Answer | null }> {
    const answer = await api.problem(p);
    return { info: answer?.status === 200 && isProblemInfo(answer.body, p) ? answer.body : null, answer };
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

  private async searchOne(t: Target): Promise<void> {
    const p: Problem = { N: t.N, M: t.M, P: t.P };
    const key = problemKey(p);
    const label = problemLabel(p);

    const { info, answer } = await this.readProblem(this.reader, p);
    if (this.stopped) return;
    if (!info) {
      this.log(`Could not read ${label} (${describeAnswer(answer)}); skipping it for 10 minutes`);
      this.skipUntil.set(key, Date.now() + TARGETS_TTL_MS);
      return;
    }
    if (!info.accepts_submissions) {
      this.log(`${label} is closed: its published optimum is proven. Skipping it.`);
      this.skipUntil.set(key, Infinity);
      return;
    }
    const site = info.site_best;
    const leader: LeaderRef | null = site ? { id: site.id, score: site.score, name: site.name } : null;
    const published = info.literature?.value ?? null;
    // the leader's coordinates are read only when they are the better start
    let stored: StoredEntry | null = null;
    const publishedStart = published !== null && info.literature?.pieces?.length === p.P;
    if (leader && !(publishedStart && published < leader.score)) {
      const a = await this.reader.entry(leader.id!);
      if (a?.status === 200 && isStoredEntry(a.body)) stored = a.body;
      else if (!this.stopped) this.log(`Could not read the leader's packing #${leader.id} (${describeAnswer(a)})`);
    }
    if (this.stopped) return;
    const known = buildKnown(info, stored);

    const maxSeconds = this.maxSeconds();
    const engineSeed = randomInt(2 ** 32);
    const control: Control = { aborted: this.stopped, paused: this.paused };
    const cur: Current = {
      problem: p,
      control,
      startedAt: this.clock.now(),
      maxSeconds,
      jobs: 0,
      best: null,
      leader: leader?.score ?? null,
    };
    this.current = cur;
    this.log(
      `Searching ${label} (${t.reason}): leader ` +
        (leader ? `${formatScore(leader.score)} by "${leader.name}"` : "none") +
        `, published ${published === null ? "none" : formatScore(published)}, area bound ${formatScore(info.area_bound)}; ` +
        `starting from ${known ? (known.source === "site" ? "the leader's packing" : "the published packing") : "nothing"}; ` +
        `up to ${formatDuration(maxSeconds)} on ${this.pool!.size} thread(s)`,
    );
    const input: SearchInput = {
      problem: p,
      known,
      leader: leader?.score ?? null,
      published,
      areaBound: info.area_bound,
      maxSeconds,
      lanes: this.pool!.size,
      seed: engineSeed,
      memory: this.memory,
      now: () => this.clock.now(),
      onResult: (_result, best) => {
        cur.jobs++;
        if (best && best.strict && (!cur.best || best.score < cur.best.score)) {
          cur.best = best;
          this.log(
            `  best so far ${formatScore(best.score)} (${best.job.method}, ${best.job.kind}, seed ${best.job.seed})` +
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
      this.log(`The search of ${label} failed: ${(error as Error)?.stack ?? String(error)}`);
      stopped = "error";
    }
    const activeSeconds = this.clock.now() - cur.startedAt;
    this.current = null;
    if (outcome) {
      this.memory = outcome.memory;
      this.saveMemory();
    }

    // this search's best, kept on disk when it is the best this machine has found for the problem
    const found = outcome?.best && outcome.best.strict ? outcome.best : (cur.best ?? null);
    const file = this.state.readBest(p);
    const saved = file ? candidateOf(file) : null;
    if (found && (!saved || improvesOn(found.score, saved.score))) {
      try {
        this.state.writeBest(bestFileOf(found, VERSION));
      } catch (error) {
        this.log(`Could not save the best packing: ${(error as Error).message}`);
      }
    }
    // an earlier search's best still counts: its submission may have failed
    const offer = better(found, saved);

    let decision: Decision = { submit: false, reason: "no strict packing" };
    let leaderAfter: LeaderRef | null = null;
    let status: number | null = null;
    let response: HistoryLine["response"] = null;
    let submitted = false;
    let outcomeText = "";
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
        submitted = true;
        this.counts.sent++;
        const body = submissionBody(offer, { name: this.o.name!, note: this.o.note, software: SOFTWARE });
        const { answer: a } = await this.submitter.submit(body);
        status = a?.status ?? null;
        const r = (a?.body ?? null) as Partial<SubmitResponse> | null;
        if (a && typeof r === "object" && r !== null && typeof r.valid === "boolean")
          response = {
            valid: r.valid,
            leader: r.leader ?? false,
            score: r.score ?? null,
            leader_score: r.leader_score ?? null,
            id: r.id ?? null,
            pending_verification: r.pending_verification ?? false,
            reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 5) : [],
          };
        if (!a) outcomeText = `not sent: no answer from the server; the packing stays in ${this.state.bestPath(p)}`;
        else if (a.status === 200 && response?.valid) {
          this.counts.accepted++;
          if (response.leader) {
            this.counts.leading++;
            leaderAfter = { id: response.id, score: response.score ?? offer.score, name: this.o.name! };
          }
          outcomeText =
            `submitted: HTTP 200, ` +
            (response.leader
              ? `the new leader (#${response.id})${response.pending_verification ? ", pending verification" : ""}`
              : `accepted, but the leader stays at ${response.leader_score}`);
        } else {
          if (a.status === 409) this.skipUntil.set(key, Infinity);
          outcomeText = `refused: ${describeAnswer(a)}`;
        }
      }
    }
    if (!outcomeText) outcomeText = decision.reason;

    const line: HistoryLine = {
      time: new Date().toISOString(),
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
      submitted,
      decision: decision.reason,
      status,
      response,
      version: VERSION,
    };
    try {
      this.state.appendHistory(line);
    } catch (error) {
      this.log(`Could not write the history: ${(error as Error).message}`);
    }
    noteSearch(this.recent, line);
    this.counts.problems++;

    const reference = leaderAfter?.score ?? leader?.score ?? null;
    const vs =
      offer === null
        ? "no strict packing"
        : `best ${formatScore(offer.score)} (${offer.job.method}, seed ${offer.job.seed}` +
          `${offer === found ? "" : ", from an earlier search"}) vs ` +
          (reference === null
            ? "no leader"
            : `leader ${formatScore(reference)} (${relativePercent(offer.score, reference)})`);
    this.log(
      `Finished ${label} after ${formatDuration(activeSeconds)} (${stopped}), ${line.jobs} job(s): ${vs}; ${outcomeText}`,
    );
  }

  private status(): void {
    const c = this.current;
    const s = this.pool?.stats();
    const lanes = s ? `threads ${s.busy} busy, ${s.paused} paused, ${s.idle} idle` : "";
    const subs = `${this.counts.accepted} submission(s) accepted`;
    const paused = this.paused ? "; paused on battery power" : "";
    if (!c) {
      this.log(`Status: between problems; ${subs}${paused}`);
      return;
    }
    const elapsed = this.clock.now() - c.startedAt;
    const best = c.best ? formatScore(c.best.score) : "none yet";
    const vs =
      c.leader === null
        ? "no leader"
        : `leader ${formatScore(c.leader)}` + (c.best ? ` (${relativePercent(c.best.score, c.leader)})` : "");
    this.log(
      `Status: ${problemLabel(c.problem)}, ${formatDuration(elapsed)} of ${formatDuration(c.maxSeconds)}; ` +
        `best ${best} vs ${vs}; ${c.jobs} job(s) run; ${lanes}; ${subs}${paused}`,
    );
  }
}
