/**
 * Cost and gain of the solver's appended final polish inside a job: shrink_repair for `seconds`
 * CPU seconds, stage by stage.
 *   npx tsx apps/volunteer/scripts/bench-engine/polishcost.ts seconds N/M/P ...
 */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: cpuMs } });
const { run } = await import("@polypack/solver");
const seconds = Number(process.argv[2]);
for (const id of process.argv.slice(3)) {
  const [N, M, P] = id.split("/").map(Number);
  const r = await run({ N, M, P }, { method: "shrink_repair", seed: 1, budget: { time_s: seconds } });
  console.log(
    id,
    JSON.stringify(
      r.stages.map((s) => ({
        m: s.method,
        t: +s.wallTime.toFixed(2),
        e: s.evaluations,
        best: s.bestScore,
        term: s.termination,
      })),
    ),
  );
}
