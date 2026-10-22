import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PowerSupply,
  onBattery,
  onBatteryFromPmset,
  onBatteryFromSupplies,
  readPowerSupplies,
  watchBattery,
} from "../src/battery";

describe("macOS pmset -g batt", () => {
  it("is on battery when drawing from the battery", () => {
    const out =
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=23330915)\t87%; discharging; 5:12 remaining present: true\n";
    expect(onBatteryFromPmset(out)).toBe(true);
  });

  it("is on AC when charging, charged or on a desktop", () => {
    expect(
      onBatteryFromPmset(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23330915)\t100%; charged; 0:00 remaining present: true\n",
      ),
    ).toBe(false);
    expect(
      onBatteryFromPmset(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23330915)\t64%; charging; 1:05 remaining present: true\n",
      ),
    ).toBe(false);
    // a Mac mini lists no battery at all
    expect(onBatteryFromPmset("Now drawing from 'AC Power'\n")).toBe(false);
  });

  it("is on battery on a UPS during a power cut", () => {
    expect(
      onBatteryFromPmset(
        "Now drawing from 'UPS Power'\n -CP1500PFCLCDa (id=4325376)\t96%; discharging; present: true\n",
      ),
    ).toBe(true);
  });

  it("counts unreadable output as AC", () => {
    expect(onBatteryFromPmset("")).toBe(false);
    expect(onBatteryFromPmset("pmset: command failed")).toBe(false);
  });
});

describe("Linux /sys/class/power_supply", () => {
  const laptop = (acOnline: string): PowerSupply[] => [
    { name: "AC", type: "Mains\n", online: `${acOnline}\n` },
    { name: "BAT0", type: "Battery\n" },
    { name: "ucsi-source-psy-USBC000:001", type: "USB\n", online: "0\n" },
  ];

  it("is on battery when every external supply is offline", () => {
    expect(onBatteryFromSupplies(laptop("0"))).toBe(true);
  });

  it("is on AC when an external supply is online, including a programmable USB-C one", () => {
    expect(onBatteryFromSupplies(laptop("1"))).toBe(false);
    expect(
      onBatteryFromSupplies([
        { name: "BAT1", type: "Battery" },
        { name: "ucsi-source-psy-USBC000:002", type: "USB", online: "2" },
      ]),
    ).toBe(false);
  });

  it("is on AC on desktops, servers and virtual machines", () => {
    expect(onBatteryFromSupplies([])).toBe(false);
    // only a wireless mouse's battery
    expect(onBatteryFromSupplies([{ name: "hidpp_battery_0", type: "Battery" }])).toBe(false);
    // a mains supply without a battery
    expect(onBatteryFromSupplies([{ name: "AC", type: "Mains", online: "0" }])).toBe(false);
  });

  describe("reading the directory", () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("reads each supply's type and online files", () => {
      dir = mkdtempSync(join(tmpdir(), "pv-power-"));
      for (const [name, type, online] of [
        ["AC", "Mains", "0"],
        ["BAT0", "Battery", undefined],
      ] as const) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, "type"), `${type}\n`);
        if (online !== undefined) writeFileSync(join(dir, name, "online"), `${online}\n`);
      }
      mkdirSync(join(dir, "broken")); // no type file: left out
      const supplies = readPowerSupplies(dir);
      expect(supplies.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "AC", type: "Mains\n", online: "0\n" },
        { name: "BAT0", type: "Battery\n" },
      ]);
      expect(onBatteryFromSupplies(supplies)).toBe(true);
      expect(readPowerSupplies(join(dir, "missing"))).toEqual([]);
    });
  });

  it("counts other platforms as AC", async () => {
    expect(await onBattery("win32")).toBe(false);
    expect(await onBattery("freebsd")).toBe(false);
  });
});

// With fake timers: each poll happens when the test moves the clock, not when the machine gets to it.
describe("watching the battery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("checks at once and every interval, and reports each change, starting from AC", async () => {
    const answers = [false, true, true, false];
    const changes: boolean[] = [];
    let calls = 0;
    const w = watchBattery(
      async () => answers[Math.min(calls++, answers.length - 1)],
      (b) => changes.push(b),
      30_000,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect([calls, changes]).toEqual([1, []]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect([calls, changes]).toEqual([2, [true]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect([calls, changes]).toEqual([4, [true, false]]);
    w.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(4); // stopped
  });

  it("does not start a check while one is running", async () => {
    let calls = 0;
    let finish: (b: boolean) => void = () => {};
    const w = watchBattery(
      () => {
        calls++;
        return new Promise<boolean>((r) => (finish = r));
      },
      () => {},
      1000,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    finish(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    w.stop();
  });

  it("counts a failing check as AC", async () => {
    const changes: boolean[] = [];
    const w = watchBattery(
      () => Promise.reject(new Error("no pmset")),
      (b) => changes.push(b),
      30_000,
    );
    await vi.advanceTimersByTimeAsync(90_000);
    w.stop();
    expect(changes).toEqual([]);
  });
});
