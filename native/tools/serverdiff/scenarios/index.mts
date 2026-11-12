// Every scenario of the harness, in the order of the inventory (README.md, "Scenarios").
import { bulkScenarios } from "./bulk.mts";
import { corpusScenario } from "./corpus.mts";
import { siteEntries } from "./data.mts";
import type { Scenario } from "./dsl.mts";
import { flatScenarios } from "./flat.mts";
import { brokenScenarios, entryScenarios, eventsScenario, gateScenario, limitsScenario, migrationScenarios, minuteScenario, snapshotScenario, staticScenario } from "./server.mts";
import { spaceScenarios } from "./spaces.mts";

export interface BuildOptions {
  /** Real entries replayed by each bulk scenario. */
  bulk: number;
  /** Where the samples drawn from the snapshots are kept between runs; "" keeps nothing. */
  cacheDir: string;
}

export async function buildScenarios(o: BuildOptions): Promise<Scenario[]> {
  // a few small leading entries of the spaces, for the scenarios that only need some valid ones
  const some = [
    ...(await siteEntries("curved")).filter((e) => e.P <= 8).slice(0, 2),
    ...(await siteEntries("boundary")).filter((e) => e.P <= 8).slice(0, 2),
    ...(await siteEntries("torus")).filter((e) => e.P <= 8).slice(0, 2),
    ...(await siteEntries("balls")).filter((e) => e.P <= 8).slice(0, 2),
  ];
  return [
    ...flatScenarios(),
    corpusScenario(),
    ...(await spaceScenarios()),
    eventsScenario(),
    limitsScenario(some),
    snapshotScenario(some),
    gateScenario(some),
    staticScenario(),
    ...migrationScenarios(),
    ...brokenScenarios(),
    ...entryScenarios(),
    minuteScenario(),
    ...(await bulkScenarios(o)),
  ];
}
