/**
 * How often the page redraws from scheduled renders (lane progress, settles): at most one every
 * `gap` milliseconds, then on the next animation frame. Renders the player's actions ask for are
 * not held back; they only tell the pace that a render just happened.
 */
export interface RenderPace {
  /** Asks for a render soon; a request while one is waiting changes nothing. */
  request(): void;
  /** Tells the pace a render ran now, however it was started. */
  rendered(): void;
  /** Drops a waiting request (tests). */
  cancel(): void;
}

export interface RenderPaceDeps {
  now(): number;
  /** The animation frame: calls back once, returns a handle. */
  frame(cb: () => void): number;
  /** Calls back after ms milliseconds, returns a handle. */
  later(cb: () => void, ms: number): number;
  /** Runs the render. */
  render(): void;
  gap?: number;
}

/** Longest redraw rate from scheduled renders: 10 a second. */
export const RENDER_GAP_MS = 100;

export function renderPace(d: RenderPaceDeps): RenderPace {
  const gap = d.gap ?? RENDER_GAP_MS;
  let last = -Infinity;
  let waiting = false;
  let epoch = 0;
  const run = (at: number) => {
    if (at !== epoch) return;
    waiting = false;
    d.render();
    last = d.now();
  };
  return {
    request() {
      if (waiting) return;
      waiting = true;
      const at = epoch;
      const wait = last + gap - d.now();
      if (wait <= 0) d.frame(() => run(at));
      else d.later(() => d.frame(() => run(at)), wait);
    },
    rendered() {
      last = d.now();
    },
    cancel() {
      epoch++;
      waiting = false;
    },
  };
}
