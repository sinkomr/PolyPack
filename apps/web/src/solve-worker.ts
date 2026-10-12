import { createSolveRuntime } from "./solve-runtime";
import type { SolveRequest, SolveResponse } from "./solve-protocol";

// Structural worker typing avoids importing DOM worker declarations into the window build.
const worker = globalThis as unknown as {
  postMessage(message: SolveResponse): void;
  addEventListener(type: "message", listener: (event: { data: SolveRequest }) => void): void;
};
const runtime = createSolveRuntime((message) => worker.postMessage(message));
worker.addEventListener("message", (event) => runtime.handle(event.data));
