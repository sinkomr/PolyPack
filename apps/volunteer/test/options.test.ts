import { readFileSync } from "node:fs";
import { type SpaceMethodDefinition, getMethod, registerMethod } from "@polypack/methods";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE,
  DEFAULT_MINUTES_PER_PROBLEM,
  type Options,
  OptionError,
  THREADS_PER_PROBLEM,
  defaultParallelProblems,
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
      // one problem at once per 4 threads, rounded: 7 threads search 2 problems (4 and 3 threads)
      parallelProblems: 2,
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
      // the new spaces are off unless asked for
      spaces: null,
      onlySpaces: false,
      // and their jobs run each kind's own search
      spaceMethod: "auto",
      spaceParams: null,
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
      parallelProblems: 1,
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
      spaces: null,
      onlySpaces: false,
      spaceMethod: "auto",
      spaceParams: null,
    } satisfies Options);
  });

  it("searches one problem at once per 4 threads by default, and as many as --parallel-problems says", () => {
    const parallel = (...argv: string[]) => run(...argv).parallelProblems;
    expect(THREADS_PER_PROBLEM).toBe(4);
    expect([1, 2, 3, 5, 6, 7, 10, 15, 31].map(defaultParallelProblems)).toEqual([1, 1, 1, 1, 2, 2, 3, 4, 8]);
    expect(parallel("--cores", "15")).toBe(4);
    expect(parallel("--cores", "15", "--parallel-problems", "1")).toBe(1);
    expect(parallel("--cores", "15", "--parallel-problems", "15")).toBe(15);
    // --once searches one problem with every thread
    expect(parallel("--cores", "15", "--once")).toBe(1);
    expect(parallel("--cores", "15", "--once", "--parallel-problems", "1")).toBe(1);
    const bad =
      (...argv: string[]) =>
      () =>
        parseOptions(argv, machine);
    expect(bad("--cores", "4", "--parallel-problems", "5")).toThrow(/each problem needs a thread/);
    expect(bad("--parallel-problems", "0")).toThrow(/--parallel-problems must be an integer/);
    expect(bad("--once", "--parallel-problems", "2")).toThrow(/--once searches one problem/);
    expect(helpText(machine)).toMatch(/--parallel-problems K +problems searched at once/);
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

describe("the other kinds' method", () => {
  // a generic method for this test file only: the real ones are registered by @polypack/methods
  const method: SpaceMethodDefinition = {
    name: "volunteer_test_method",
    title: "Test",
    summary: "Does nothing.",
    doc: "docs/methods/dimensions/volunteer_test_method.md",
    requires: [],
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { hops: { type: "integer", minimum: 1 } },
    },
    defaults: { hops: 3 },
    run() {},
  };
  if (!getMethod(method.name)) registerMethod(method);
  const bad =
    (...argv: string[]) =>
    () =>
      parseOptions(argv, machine);

  it("is auto unless --space-method names a method, with --space-params over its defaults", () => {
    expect(run("--dimensions", "all")).toMatchObject({ spaceMethod: "auto", spaceParams: null });
    expect(run("--dimensions", "all", "--space-method", "auto")).toMatchObject({
      spaceMethod: "auto",
      spaceParams: null,
    });
    expect(run("--dimensions", "sphere", "--space-method", method.name)).toMatchObject({
      spaceMethod: method.name,
      spaceParams: null,
    });
    expect(run("--dimensions", "sphere", "--space-method", method.name, "--space-params", '{"hops": 7}')).toMatchObject(
      { spaceMethod: method.name, spaceParams: { hops: 7 } },
    );
  });

  it("refuses an unknown method and parameters that are not the method's, with a readable message", () => {
    expect(bad("--dimensions", "all", "--space-method", "warp_drive")).toThrow(
      /--space-method: "warp_drive" is not a method of the other kinds; choose auto or one of .*volunteer_test_method/,
    );
    expect(bad("--space-method", method.name)).toThrow(/--space-method applies to the other kinds: give --dimensions/);
    expect(bad("--dimensions", "all", "--space-params", '{"hops": 7}')).toThrow(
      /--space-params needs --space-method NAME: auto, each kind's own search, takes no parameters/,
    );
    const params = (text: string) => bad("--dimensions", "all", "--space-method", method.name, "--space-params", text);
    expect(params("{hops: 7}")).toThrow(/--space-params must be a JSON object.*is not JSON/);
    expect(params("[7]")).toThrow(/--space-params must be a JSON object/);
    expect(params('{"hops": 0}')).toThrow(/--space-params for volunteer_test_method: params\.hops: below minimum/);
    expect(params('{"jumps": 1}')).toThrow(/unknown parameter jumps/);
    for (const argv of [
      ["--space-method", "warp_drive"],
      ["--space-params", "{}"],
    ])
      expect(bad("--dimensions", "all", ...argv)).toThrow(OptionError);
  });

  it("is in the help text", () => {
    const help = helpText(machine);
    expect(help).toContain("--space-method NAME");
    expect(help).toContain("--space-params JSON");
    expect(help).toContain(method.name);
  });
});
