/**
 * Command-line options of the volunteer client. Parsing is pure: the machine's core count and
 * home directory are passed in, so that the defaults can be tested.
 */
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MAX_PIECES, MAX_SIDES } from "@polypack/geometry";
import { getMethod, listMethods, methodParams } from "@polypack/methods";
import { SPACE_NAMES, type SpaceName } from "@polypack/spaces";
import { VERSION } from "./version";

export const DEFAULT_BASE = "https://polypack.fly.dev";
/**
 * Most active minutes per problem. Ten minutes on the default lanes (all cores but one) is several
 * times the core time the batch runner gave a problem, and still covers about six problems an
 * hour; docs/VOLUNTEER.md explains the choice.
 */
export const DEFAULT_MINUTES_PER_PROBLEM = 10;
/** The server's limits on the display name and the note. */
export const MAX_NAME_LENGTH = 40;
export const MAX_NOTE_LENGTH = 200;

export interface Options {
  /** Display name of the submissions; null when none was given. */
  name: string | null;
  base: string;
  cores: number;
  /** Problems searched at once, each on its share of the threads (laneShares in main.ts). */
  parallelProblems: number;
  /** Hours before the client stops; Infinity for never. */
  hours: number;
  minutesPerProblem: number;
  /** Shape filters; null for all shapes. */
  N: number[] | null;
  M: number[] | null;
  maxP: number | null;
  /** True when nothing is submitted: --dry-run was given, or there is no --name. */
  dryRun: boolean;
  stateDir: string;
  note: string;
  batteryPause: boolean;
  priority: "low" | "normal";
  once: boolean;
  /**
   * The kinds of problem beyond Flat whose problems are also searched (--dimensions, or its first
   * name --spaces: the API calls these kinds spaces), in the order of SPACE_NAMES (surface, curved,
   * sphere, torus, boundary, polyhedra, balls; "all" names every one); null when the option is not given: then no
   * space problem is ever fetched or searched.
   */
  spaces: SpaceName[] | null;
  /** --only-dimensions (or --only-spaces): the polygon work list is not used at all. */
  onlySpaces: boolean;
  /**
   * --space-method: the search method of the other kinds' jobs, "auto" (each kind's own search,
   * the default) or a generic method of @polypack/methods. A problem that does not offer it runs
   * auto (packages/spaces/src/search/engine.ts).
   */
  spaceMethod: string;
  /** --space-params: that method's parameters over its defaults; null for none. */
  spaceParams: Record<string, unknown> | null;
}

export type Parsed = { kind: "help" } | { kind: "version" } | { kind: "run"; options: Options };

/** What the defaults depend on. */
export interface Machine {
  availableParallelism: number;
  homedir: string;
}

export class OptionError extends Error {}

export const defaultCores = (m: Machine) => Math.max(1, m.availableParallelism - 1);

/**
 * Threads per problem that the default number of problems at once aims at. [CALC] In simulations
 * of the engine with ideal threads (docs/VOLUNTEER.md, "Several problems at once";
 * scripts/volunteer-threads.ts), 2 minutes on three sawtooth problems with 2 seeds each, 4 threads
 * found on average 98 % of the improvement that 15 threads found, 8 threads as much as 15, 2
 * threads 84 % and 1 thread 82 %. A thread spent on another problem is worth more than the 5th to
 * 15th threads on one.
 */
export const THREADS_PER_PROBLEM = 4;
/** One problem at once per THREADS_PER_PROBLEM threads, rounded, and at least one. */
export const defaultParallelProblems = (cores: number) => Math.max(1, Math.round(cores / THREADS_PER_PROBLEM));

export function helpText(m: Machine): string {
  return `polypack-volunteer ${VERSION}: give spare CPU time to PolyPack (${DEFAULT_BASE})

It takes problems from the server's work list, several at once on a machine with many cores,
searches each with many methods and seeds on its share of the cores, and submits a result only
when it beats the site's leader.

Usage: node polypack-volunteer.mjs [options]

  --name NAME              display name shown with your entries (at most ${MAX_NAME_LENGTH} characters);
                           without it nothing is submitted: the client runs as a dry run
  --base URL               server (default ${DEFAULT_BASE})
  --cores K                search threads (default: all cores but one, here ${defaultCores(m)})
  --parallel-problems K    problems searched at once, sharing the threads (default: one per
                           ${THREADS_PER_PROBLEM} threads, here ${defaultParallelProblems(defaultCores(m))}); 1 searches one at a time
  --hours H                stop after H hours (default: never)
  --minutes-per-problem T  most minutes of search per problem, pauses excluded (default ${DEFAULT_MINUTES_PER_PROBLEM})
  --N LIST                 piece shapes, e.g. 0,3-6 (0 = circle; default: all)
  --M LIST                 container shapes, same syntax (default: all)
  --max-P K                only problems of at most K pieces (in the other kinds too)
  --dry-run                search, but never submit
  --note TEXT              free text shown with your entries (at most ${MAX_NOTE_LENGTH} characters)
  --state DIR              where the client keeps its state (default ${join(m.homedir, ".polypack-volunteer")})
  --priority low|normal    CPU priority of the search threads (default low)
  --no-battery-pause       keep searching on battery power (by default it pauses)
  --once                   search one problem, then exit
  --help                   this text
  --version                the version

Optional, off by default: the other kinds of problem (see ${DEFAULT_BASE}/dimensions.html).
The work list above is Flat (2D in 2D): polygons in polygons. These options add curved (2D in 2D
at constant curvature); surface, sphere and torus (2D on 3D: on the surface of a polyhedron,
on a whole sphere, on a flat torus); boundary (3D on 4D: unit balls and cubes on the boundary of
a tesseract); polyhedra (3D in 3D: solids in a solid); and balls (3D in 3D: unit balls in a ball
or in one of 94 solids, and each of those solids in a ball). The API calls these kinds spaces.
Without these options the client never asks for them.

  --dimensions LIST        also search problems of these kinds: surface, curved, sphere, torus,
                           boundary, polyhedra, balls, comma-separated, or all; each next problem comes
                           from the polygon work list or from the work list of these kinds with
                           probability 1/2
  --spaces LIST            the same as --dimensions (its earlier name)
  --only-dimensions        search only the kinds given with --dimensions
  --only-spaces            the same as --only-dimensions

  --space-method NAME      the search method of these kinds: auto (default), each kind's own
                           search, or a method that runs in every kind; a problem that does not
                           offer it uses auto. Nofold surface problems keep the polygon engine.
${spaceMethodLines()}
  --space-params JSON      that method's parameters, a JSON object (default: its defaults)

--max-P applies to these kinds too; --N and --M filter only the polygon work list.

Stop it with Ctrl-C: it submits the current problem's best if that beats the leader, saves its
state and exits within about 30 s. A second Ctrl-C exits at once.
`;
}

/**
 * Parse "0,3-6,12" into the sorted distinct integers it names. Every value must lie in
 * [min, max] and, when `allowed` is given, belong to it (shape codes skip 1 and 2).
 */
export function parseIntList(
  text: string,
  what: string,
  min: number,
  max: number,
  allowed?: (v: number) => boolean,
): number[] {
  const out = new Set<number>();
  const parts = text.split(",").map((s) => s.trim());
  if (parts.some((s) => s === "")) throw new OptionError(`--${what}: empty item in "${text}"`);
  for (const part of parts) {
    const m = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(part);
    if (!m) throw new OptionError(`--${what}: "${part}" is not an integer or a range a-b`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) throw new OptionError(`--${what}: range "${part}" is reversed`);
    if (lo < min || hi > max) throw new OptionError(`--${what}: "${part}" is outside ${min}..${max}`);
    for (let v = lo; v <= hi; v++) if (!allowed || allowed(v)) out.add(v);
  }
  if (out.size === 0) throw new OptionError(`--${what}: "${text}" names no allowed value`);
  return [...out].sort((a, b) => a - b);
}

const isShape = (v: number) => v === 0 || (v >= 3 && v <= MAX_SIDES);

/**
 * "surface,torus" or "all" into the named spaces, in the order of SPACE_NAMES. `flag` is the
 * option's name as it was given (--dimensions or --spaces), for the error messages.
 */
export function parseSpaces(text: string, flag = "spaces"): SpaceName[] {
  const parts = text.split(",").map((s) => s.trim().toLowerCase());
  if (parts.some((s) => s === "")) throw new OptionError(`--${flag}: empty item in "${text}"`);
  if (parts.includes("all")) {
    if (parts.length > 1) throw new OptionError(`--${flag}: "all" cannot be combined with other names`);
    return [...SPACE_NAMES];
  }
  for (const part of parts)
    if (!(SPACE_NAMES as readonly string[]).includes(part))
      throw new OptionError(`--${flag}: "${part}" is not one of ${SPACE_NAMES.join(", ")} or all`);
  return SPACE_NAMES.filter((name) => parts.includes(name));
}

/** The generic methods a client of this version has, as lines of the help text. */
function spaceMethodLines(): string {
  const names = listMethods().map((m) => m.name);
  const indent = " ".repeat(27);
  if (!names.length) return `${indent}This version has no such method yet.`;
  const lines: string[] = [];
  let line = "Methods:";
  for (const [i, name] of names.entries()) {
    const word = `${name}${i < names.length - 1 ? "," : ""}`;
    if (line.length + 1 + word.length > 70) {
      lines.push(line);
      line = word;
    } else line += ` ${word}`;
  }
  lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

/**
 * --space-method and --space-params, checked against the methods' registry and the method's
 * schema. Whether a problem offers the method is decided per problem, by its kernel.
 */
export function parseSpaceMethod(
  method: string | undefined,
  params: string | undefined,
): { spaceMethod: string; spaceParams: Record<string, unknown> | null } {
  const name = (method ?? "auto").trim();
  if (name !== "auto" && !getMethod(name)) {
    const names = listMethods().map((m) => m.name);
    throw new OptionError(
      `--space-method: "${name.slice(0, 40)}" is not a method of the other kinds; choose auto` +
        (names.length ? ` or one of ${names.join(", ")}` : " (this version has no other method yet)"),
    );
  }
  if (params === undefined) return { spaceMethod: name, spaceParams: null };
  if (name === "auto")
    throw new OptionError(
      "--space-params needs --space-method NAME: auto, each kind's own search, takes no parameters",
    );
  let value: unknown;
  try {
    value = JSON.parse(params);
  } catch {
    throw new OptionError(
      `--space-params must be a JSON object, for example '{"key": 1}'; "${params.slice(0, 40)}" is not JSON`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OptionError(`--space-params must be a JSON object, for example '{"key": 1}'`);
  try {
    methodParams(getMethod(name)!, value as Record<string, unknown>);
  } catch (error) {
    throw new OptionError(`--space-params for ${name}: ${(error as Error).message}`);
  }
  return { spaceMethod: name, spaceParams: value as Record<string, unknown> };
}

function positiveInteger(name: string, text: string, max: number): number {
  if (!/^\d{1,9}$/.test(text.trim()) || Number(text) < 1 || Number(text) > max)
    throw new OptionError(`--${name} must be an integer from 1 to ${max}`);
  return Number(text);
}

function positiveNumber(name: string, text: string): number {
  const v = Number(text);
  if (text.trim() === "" || !Number.isFinite(v) || v <= 0) throw new OptionError(`--${name} must be a positive number`);
  return v;
}

export function parseOptions(argv: readonly string[], machine: Machine): Parsed {
  let values;
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        name: { type: "string" },
        base: { type: "string", default: DEFAULT_BASE },
        cores: { type: "string" },
        "parallel-problems": { type: "string" },
        hours: { type: "string" },
        "minutes-per-problem": { type: "string" },
        N: { type: "string" },
        M: { type: "string" },
        "max-P": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        state: { type: "string" },
        note: { type: "string" },
        "no-battery-pause": { type: "boolean", default: false },
        priority: { type: "string", default: "low" },
        once: { type: "boolean", default: false },
        // --dimensions and --only-dimensions are the same options under the site's present words
        spaces: { type: "string" },
        dimensions: { type: "string" },
        "only-spaces": { type: "boolean", default: false },
        "only-dimensions": { type: "boolean", default: false },
        "space-method": { type: "string" },
        "space-params": { type: "string" },
        help: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new OptionError((error as Error).message);
  }
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  const base = values.base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+/.test(base)) throw new OptionError("--base must be an http(s) URL");
  const name = values.name === undefined ? null : values.name.trim();
  if (name === "") throw new OptionError("--name is empty");
  if (name !== null && name.length > MAX_NAME_LENGTH)
    throw new OptionError(`--name is limited to ${MAX_NAME_LENGTH} characters by the server`);
  const note = (values.note ?? "").trim();
  if (note.length > MAX_NOTE_LENGTH)
    throw new OptionError(`--note is limited to ${MAX_NOTE_LENGTH} characters by the server`);
  if (values.priority !== "low" && values.priority !== "normal")
    throw new OptionError('--priority must be "low" or "normal"');
  if (values.spaces !== undefined && values.dimensions !== undefined)
    throw new OptionError("--spaces and --dimensions are the same option: give one of them");
  const flag = values.dimensions !== undefined ? "dimensions" : "spaces";
  const list = values.dimensions ?? values.spaces;
  const spaces = list === undefined ? null : parseSpaces(list, flag);
  const onlySpaces = values["only-spaces"] || values["only-dimensions"];
  const only = values["only-dimensions"] ? "--only-dimensions" : "--only-spaces";
  const [named, other] = values["only-dimensions"] ? ["dimensions", "spaces"] : ["spaces", "dimensions"];
  if (onlySpaces && spaces === null)
    throw new OptionError(`${only} needs --${named} LIST (or --${other} LIST), for example --${named} all`);
  if (onlySpaces && (values.N !== undefined || values.M !== undefined))
    throw new OptionError(`--N and --M filter the polygon work list, which ${only} leaves out`);
  const { spaceMethod, spaceParams } = parseSpaceMethod(values["space-method"], values["space-params"]);
  if (spaceMethod !== "auto" && spaces === null)
    throw new OptionError(
      "--space-method applies to the other kinds: give --dimensions LIST too, for example --dimensions all",
    );

  const cores = values.cores === undefined ? defaultCores(machine) : positiveInteger("cores", values.cores, 1024);
  const asked =
    values["parallel-problems"] === undefined
      ? null
      : positiveInteger("parallel-problems", values["parallel-problems"], 1024);
  if (values.once && asked !== null && asked > 1)
    throw new OptionError("--once searches one problem: leave out --parallel-problems, or give 1");
  const parallelProblems = asked ?? (values.once ? 1 : defaultParallelProblems(cores));
  if (parallelProblems > cores)
    throw new OptionError(
      `--parallel-problems (${parallelProblems}) is more than the search threads (--cores ${cores}): each problem needs a thread`,
    );

  let stateDir = values.state ?? join(machine.homedir, ".polypack-volunteer");
  // a quoted or --state=~/... path reaches us unexpanded
  if (stateDir === "~" || stateDir.startsWith("~/")) stateDir = join(machine.homedir, stateDir.slice(1));
  if (!isAbsolute(stateDir)) stateDir = resolve(stateDir);

  return {
    kind: "run",
    options: {
      name,
      base,
      cores,
      parallelProblems,
      hours: values.hours === undefined ? Infinity : positiveNumber("hours", values.hours),
      minutesPerProblem:
        values["minutes-per-problem"] === undefined
          ? DEFAULT_MINUTES_PER_PROBLEM
          : positiveNumber("minutes-per-problem", values["minutes-per-problem"]),
      N: values.N === undefined ? null : parseIntList(values.N, "N", 0, MAX_SIDES, isShape),
      M: values.M === undefined ? null : parseIntList(values.M, "M", 0, MAX_SIDES, isShape),
      maxP: values["max-P"] === undefined ? null : positiveInteger("max-P", values["max-P"], MAX_PIECES),
      dryRun: values["dry-run"] || name === null,
      stateDir,
      note,
      batteryPause: !values["no-battery-pause"],
      priority: values.priority,
      once: values.once,
      spaces,
      onlySpaces,
      spaceMethod,
      spaceParams,
    },
  };
}
