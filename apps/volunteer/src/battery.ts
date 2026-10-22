/**
 * Whether the machine runs on battery power, so that the client can pause there. The parsers are
 * pure and tested on real-looking outputs; the readers around them never throw, and anything they
 * cannot tell (an unknown platform, a missing command or file) counts as AC power.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * macOS `pmset -g batt` output, whose first line names the power source:
 *
 *   Now drawing from 'Battery Power'
 *    -InternalBattery-0 (id=23330915)	87%; discharging; 5:12 remaining present: true
 *
 * True on 'Battery Power', and on 'UPS Power' (a desktop on its UPS during a power cut);
 * false on 'AC Power' and on anything unrecognised.
 */
export function onBatteryFromPmset(output: string): boolean {
  const source = /Now drawing from '([^']+)'/.exec(output)?.[1];
  return source === "Battery Power" || source === "UPS Power";
}

/** One entry of /sys/class/power_supply: the contents of its `type` and, if present, `online`. */
export interface PowerSupply {
  name: string;
  type: string;
  online?: string;
}

/**
 * Linux power supplies. External supplies (type Mains, USB, USB_C, Wireless and so on) have an
 * `online` file: 1 (or 2, for a programmable USB supply) while they power the machine. The machine
 * is on battery when it has a battery and external supplies, none of them online. Without any
 * external supply listed (most desktops, servers and virtual machines) it counts as on AC: a
 * battery alone may be a wireless mouse's, which also appears here.
 */
export function onBatteryFromSupplies(supplies: readonly PowerSupply[]): boolean {
  const external = supplies.filter((s) => s.type.trim() !== "Battery" && s.online !== undefined);
  const battery = supplies.some((s) => s.type.trim() === "Battery");
  if (!battery || external.length === 0) return false;
  return !external.some((s) => Number(s.online!.trim()) > 0);
}

/** Reads /sys/class/power_supply; an empty list when it cannot. */
export function readPowerSupplies(dir = "/sys/class/power_supply"): PowerSupply[] {
  const out: PowerSupply[] = [];
  try {
    for (const name of readdirSync(dir)) {
      try {
        const type = readFileSync(join(dir, name, "type"), "utf8");
        const onlinePath = join(dir, name, "online");
        out.push({ name, type, ...(existsSync(onlinePath) ? { online: readFileSync(onlinePath, "utf8") } : {}) });
      } catch {
        // an entry without a readable type tells nothing
      }
    }
  } catch {
    // no such directory
  }
  return out;
}

function pmset(): Promise<string> {
  return new Promise((resolve) => {
    execFile("pmset", ["-g", "batt"], { timeout: 5000 }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

/** True when the machine is known to run on battery power. Never rejects. */
export async function onBattery(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform === "darwin") return onBatteryFromPmset(await pmset());
    if (platform === "linux") return onBatteryFromSupplies(readPowerSupplies());
  } catch {
    // fall through: unknown counts as AC
  }
  return false;
}

/**
 * Calls `check` now and every `intervalMs`, and `onChange` whenever the answer differs from the
 * previous one (the first answer is compared with AC power). Checks never overlap.
 */
export function watchBattery(
  check: () => Promise<boolean>,
  onChange: (onBattery: boolean) => void,
  intervalMs = 30_000,
): { stop(): void } {
  let state = false;
  let busy = false;
  let stopped = false;
  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const now = await check().catch(() => false);
      if (!stopped && now !== state) {
        state = now;
        onChange(now);
      }
    } finally {
      busy = false;
    }
  };
  void poll();
  const timer = setInterval(poll, intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
