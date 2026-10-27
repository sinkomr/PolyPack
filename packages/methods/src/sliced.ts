/** Drive identical validation work synchronously or in short, timed event-loop slices. */
export function runSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}
export async function runStepsAsync<T>(
  steps: Generator<void, T>,
  sliceMs = 8,
): Promise<
  T & {
    workMs: number;
    slices: number;
    longestSliceMs: number;
  }
> {
  const budget = Math.max(1, Math.min(25, sliceMs));
  let workMs = 0,
    slices = 0,
    longestSliceMs = 0;
  for (;;) {
    const start = performance.now();
    let step: IteratorResult<void, T>;
    do {
      step = steps.next();
    } while (!step.done && performance.now() - start < budget);
    const elapsed = performance.now() - start;
    workMs += elapsed;
    slices++;
    longestSliceMs = Math.max(longestSliceMs, elapsed);
    if (step.done) return { ...step.value, workMs, slices, longestSliceMs };
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
