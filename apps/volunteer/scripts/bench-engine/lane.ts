/**
 * One lane of the multi-lane benchmark: a worker thread that runs jobs with inlineRunJob, its clock
 * being this thread's CPU time (process.threadCpuUsage), so a job's time budget is CPU seconds of
 * its own lane whatever the machine's load.
 */
import { parentPort } from "node:worker_threads";

const cpuMs = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};
Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: cpuMs } });
const { inlineRunJob } = await import("../../src/engine/inline");

parentPort!.on("message", async (m: { id: number; job: Parameters<typeof inlineRunJob>[0] }) => {
  const result = await inlineRunJob(m.job, { aborted: false, paused: false });
  parentPort!.postMessage({ id: m.id, result, cpu: cpuMs() / 1000 });
});
