/**
 * Command-line options of the volunteer client. Parsing is pure: the machine's core count and
 * home directory are passed in, so that the defaults can be tested.
 */
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MAX_PIECES, MAX_SIDES } from "@polypack/geometry";
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
   * name --spaces: the API calls these kinds spaces), in the order of SPACE_NAMES; null when the
   * option is not given: then no space problem is ever fetched or searched.
   */
  spaces: SpaceName[] | null;
  /** --only-dimensions (or --only-spaces): the polygon work list is not used at all. */
  onlySpaces: boolean;
}

export type Parsed = { kind: "help" } | { kind: "version" } | { kind: "run"; options: Options };

/** What the defaults depend on. */
export interface Machine {
  availableParallelism: number;
  homedir: string;
}

export class OptionError extends Error {}

export const defaultCores = (m: Machine) => Math.max(1, m.availableParallelism - 1);

export function helpText(m: Machine): string {
  return `polypack-volunteer ${VERSION}: give spare CPU time to PolyPack (${DEFAULT_BASE})

It takes problems from the server's work list one at a time, searches each with many methods and
seeds on the cores it is given, and submits a result only when it beats the site's leader.

Usage: node polypack-volunteer.mjs [options]

  --name NAME              display name shown with your entries (at most ${MAX_NAME_LENGTH} characters);
                           without it nothing is submitted: the client runs as a dry run
  --base URL               server (default ${DEFAULT_BASE})
  --cores K                search threads (default: all cores but one, here ${defaultCores(m)})
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
at constant curvature), and surface, sphere and torus (2D on 3D: on the surface of a Platonic
solid, on a whole sphere, on a flat torus). The API calls these kinds spaces.
Without these options the client never asks for them.

  --dimensions LIST        also search problems of these kinds: surface, curved, sphere, torus,
                           comma-separated, or all; each next problem comes from the polygon work
                           list or from the work list of these kinds with probability 1/2
  --spaces LIST            the same as --dimensions (its earlier name)
  --only-dimensions        search only the kinds given with --dimensions
  --only-spaces            the same as --only-dimensions

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

  let stateDir = values.state ?? join(machine.homedir, ".polypack-volunteer");
  // a quoted or --state=~/... path reaches us unexpanded
  if (stateDir === "~" || stateDir.startsWith("~/")) stateDir = join(machine.homedir, stateDir.slice(1));
  if (!isAbsolute(stateDir)) stateDir = resolve(stateDir);

  return {
    kind: "run",
    options: {
      name,
      base,
      cores: values.cores === undefined ? defaultCores(machine) : positiveInteger("cores", values.cores, 1024),
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
    },
  };
}
