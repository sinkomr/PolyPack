interface Port {
  onmessage: (() => void) | null;
  postMessage(value: number): void;
  close(): void;
}

// Structural types keep platform globals portable without DOM or Node declarations.
const runtime = globalThis as unknown as {
  performance: { now(): number };
  setTimeout(callback: () => void, milliseconds: number): unknown;
  MessageChannel?: new () => { port1: Port; port2: Port };
};
export const now = () => runtime.performance.now();
export const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => runtime.setTimeout(resolve, milliseconds));

export function yieldTask(): Promise<void> {
  if (!runtime.MessageChannel) return delay(0);
  return new Promise<void>((resolve) => {
    const channel = new runtime.MessageChannel!();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

export function createCheckpoint(intervalMs = 12): () => Promise<boolean> {
  let lastYield = now();
  return async () => {
    if (now() - lastYield >= intervalMs) {
      await yieldTask();
      lastYield = now();
    }
    return true;
  };
}
