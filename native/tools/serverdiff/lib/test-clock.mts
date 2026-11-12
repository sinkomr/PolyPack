// The test clock of the reference server: every reading of the wall clock in the process
// (`Date.now()`, `new Date()`) is the system clock plus an offset that the harness sets
// (README.md, "The clock"). Imported first by ref-server.mts, before any module of the server,
// so that defaults such as `now = Date.now` already see it. Durations (`performance.now()`) and
// timers are not touched.
const RealDate = Date;
let offsetMs = 0;

export function setClockOffset(ms: number): void {
  offsetMs = ms;
}
export function clockOffset(): number {
  return offsetMs;
}

class TestDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offsetMs);
    else super(...(args as [number]));
  }
  static now(): number {
    return RealDate.now() + offsetMs;
  }
}
(globalThis as { Date: DateConstructor }).Date = TestDate as unknown as DateConstructor;
