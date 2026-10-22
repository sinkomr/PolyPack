import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE,
  DEFAULT_MINUTES_PER_PROBLEM,
  type Options,
  OptionError,
  helpText,
  parseIntList,
  parseOptions,
} from "../src/options";
import { VERSION } from "../src/version";

const machine = { availableParallelism: 8, homedir: "/home/vol" };

function run(...argv: string[]): Options {
  const parsed = parseOptions(argv, machine);
  if (parsed.kind !== "run") throw new Error(`expected a run, got ${parsed.kind}`);
  return parsed.options;
}

describe("options", () => {
  it("has defaults for everything, and runs dry without a name", () => {
    expect(run()).toEqual({
      name: null,
      base: DEFAULT_BASE,
      cores: 7,
      hours: Infinity,
      minutesPerProblem: DEFAULT_MINUTES_PER_PROBLEM,
      N: null,
      M: null,
      maxP: null,
      dryRun: true,
      stateDir: "/home/vol/.polypack-volunteer",
      note: "",
      batteryPause: true,
      priority: "low",
      once: false,
    } satisfies Options);
  });

  it("leaves at least one core, even on a one-core machine", () => {
    expect(parseOptions([], { ...machine, availableParallelism: 1 })).toMatchObject({ options: { cores: 1 } });
    expect(parseOptions([], { ...machine, availableParallelism: 2 })).toMatchObject({ options: { cores: 1 } });
  });

  it("reads every option", () => {
    const o = run(
      "--name",
      "  Ada  ",
      "--base",
      "http://localhost:9999/",
      "--cores",
      "3",
      "--hours",
      "1.5",
      "--minutes-per-problem",
      "0.5",
      "--N",
      "0,3-6",
      "--M",
      "4",
      "--max-P",
      "50",
      "--state",
      "~/vol-state",
      "--note",
      "spare laptop",
      "--no-battery-pause",
      "--priority",
      "normal",
      "--once",
    );
    expect(o).toEqual({
      name: "Ada",
      base: "http://localhost:9999",
      cores: 3,
      hours: 1.5,
      minutesPerProblem: 0.5,
      N: [0, 3, 4, 5, 6],
      M: [4],
      maxP: 50,
      dryRun: false,
      stateDir: "/home/vol/vol-state",
      note: "spare laptop",
      batteryPause: false,
      priority: "normal",
      once: true,
    } satisfies Options);
  });

  it("runs dry with --dry-run even with a name", () => {
    expect(run("--name", "Ada", "--dry-run")).toMatchObject({ name: "Ada", dryRun: true });
  });

  it("refuses bad values with a readable message", () => {
    const bad =
      (...argv: string[]) =>
      () =>
        parseOptions(argv, machine);
    expect(bad("--cores", "0")).toThrow(OptionError);
    expect(bad("--cores", "two")).toThrow(/--cores/);
    expect(bad("--hours", "-1")).toThrow(/--hours/);
    expect(bad("--minutes-per-problem", "0")).toThrow(/--minutes-per-problem/);
    expect(bad("--max-P", "501")).toThrow(/--max-P/);
    expect(bad("--N", "1,2")).toThrow(/no allowed value/);
    expect(bad("--M", "101")).toThrow(/outside/);
    expect(bad("--priority", "high")).toThrow(/--priority/);
    expect(bad("--base", "polypack.fly.dev")).toThrow(/--base/);
    expect(bad("--name", "x".repeat(41))).toThrow(/40 characters/);
    expect(bad("--name", "  ")).toThrow(/empty/);
    expect(bad("--note", "x".repeat(201))).toThrow(/200 characters/);
    expect(bad("--frobnicate")).toThrow(OptionError);
    expect(bad("positional")).toThrow(OptionError);
  });

  it("answers --help and --version before anything else", () => {
    expect(parseOptions(["--help", "--cores", "0"], machine)).toEqual({ kind: "help" });
    expect(parseOptions(["--version"], machine)).toEqual({ kind: "version" });
    const help = helpText(machine);
    for (const flag of ["--name", "--base", "--cores", "--hours", "--minutes-per-problem", "--N", "--M", "--max-P"])
      expect(help).toContain(flag);
    for (const flag of ["--dry-run", "--state", "--note", "--no-battery-pause", "--priority", "--once", "--version"])
      expect(help).toContain(flag);
    expect(help).toContain("here 7");
  });

  it("parses shape lists like the batch runner", () => {
    expect(parseIntList("5,1-3,2", "x", 0, 10)).toEqual([1, 2, 3, 5]);
    expect(() => parseIntList("1,,2", "x", 0, 10)).toThrow(/empty/);
    expect(() => parseIntList("5-3", "x", 0, 10)).toThrow(/reversed/);
  });

  it("has the version of package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
