import { createRunHost } from "./run-host";
import type { HostReply, HostRequest } from "./run-host";

// Structural worker typing avoids importing DOM worker declarations into the window build.
const worker = globalThis as unknown as {
  postMessage(message: HostReply): void;
  addEventListener(type: "message", listener: (event: { data: HostRequest }) => void): void;
};
const host = createRunHost((reply) => worker.postMessage(reply));
worker.addEventListener("message", (event) => host.handle(event.data));
