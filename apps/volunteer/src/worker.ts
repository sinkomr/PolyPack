/**
 * The search threads' side of the worker pool (pool.ts). A thread runs one job at a time with the
 * engine's inlineRunJob: the pool sends {type: "run"}, and the thread answers {type: "result"}
 * when the job ends. "pause", "resume" and "abort" set the flags of the running job's control,
 * which the solver polls about every 12 ms of its work; messages for another job are ignored.
 *
 * In the single-file bundle a thread runs the bundle itself, told apart from the main program by
 * its workerData (see cli.ts); in development it runs a bundle of worker-entry.ts (see
 * bundle.ts).
 */
import os from "node:os";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { inlineRunJob } from "./engine/inline";
import type { Control, Job, JobResult } from "./types";

export const WORKER_ROLE = "polypack-volunteer-search";

export interface WorkerData {
  role: typeof WORKER_ROLE;
  priority: "low" | "normal";
}

export type ToWorker = { type: "run"; id: number; job: Job } | { type: "pause" | "resume" | "abort"; id: number };

export interface FromWorker {
  type: "result";
  id: number;
  result: JobResult;
}

/** True in a search thread of the pool. */
export function isSearchThread(): boolean {
  return !isMainThread && (workerData as Partial<WorkerData> | null)?.role === WORKER_ROLE;
}

/** Serves jobs on this thread until the pool terminates it. */
export function runSearchThread(): void {
  const port = parentPort;
  if (!port) throw new Error("runSearchThread must run in a worker thread");
  const data = workerData as WorkerData;
  if (data.priority === "low") {
    try {
      // pid 0 is the calling thread on Linux, where each thread has its own nice value; on macOS
      // and Windows it is the whole process, which only lowers the idle main thread as well
      os.setPriority(0, os.constants.priority.PRIORITY_LOW);
    } catch {
      // not permitted here: run at the normal priority
    }
  }
  let current: { id: number; control: Control } | null = null;
  port.on("message", async (m: ToWorker) => {
    if (m.type === "run") {
      const control: Control = { aborted: false, paused: false };
      current = { id: m.id, control };
      const result = await inlineRunJob(m.job, control);
      current = null;
      port.postMessage({ type: "result", id: m.id, result } satisfies FromWorker);
      return;
    }
    if (!current || current.id !== m.id) return;
    if (m.type === "abort") current.control.aborted = true;
    else current.control.paused = m.type === "pause";
  });
}
