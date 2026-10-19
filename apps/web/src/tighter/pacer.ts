/**
 * Submission pacing (design.md §9, as the owner's rule): at most one POST per problem a minute, and
 * at most 6 a minute per player. A problem never sent before goes at once (a first record); every
 * later POST for it waits for its minute, whatever the previous answer was (a refusal included) and
 * whether or not the problem is leaving the queue. A 429 from the server, or an unreachable
 * server, stops all sending for a while.
 *
 * Pure: every function takes the time and returns a new state.
 */
export const PROBLEM_INTERVAL_MS = 60_000;
export const PLAYER_PER_MINUTE = 6;
export const PLAYER_WINDOW_MS = 60_000;
/** Pause after a 429 ("too many submissions from this address; wait a minute"). */
export const RATE_LIMITED_BACKOFF_MS = 60_000;
/** Pause after the server could not be reached. */
export const OFFLINE_BACKOFF_MS = 30_000;

export interface PacerState {
  /** Times of the player's recent POSTs, oldest first; only the last minute matters. */
  sent: number[];
  /** Time of the last POST per problem key. */
  lastByProblem: Record<string, number>;
  /** No POST before this time. */
  pausedUntil: number;
}

export const newPacer = (): PacerState => ({ sent: [], lastByProblem: {}, pausedUntil: 0 });

/**
 * What the caller knows about a send. It orders the queue of sends (leaving problems and first
 * records go first) but exempts nothing from the minute: only a problem never POSTed goes at once.
 */
export interface SendKind {
  first?: boolean;
  leaving?: boolean;
}

/** Earliest time at which a POST for `key` is allowed; `now` or earlier means now. */
export function nextAllowedAt(state: PacerState, key: string, now: number, _kind: SendKind = {}): number {
  let t = Math.max(now, state.pausedUntil);
  const last = state.lastByProblem[key];
  if (last !== undefined) t = Math.max(t, last + PROBLEM_INTERVAL_MS);
  // the player's window: the (6th most recent send) + 1 minute
  const recent = state.sent.filter((s) => s > now - PLAYER_WINDOW_MS);
  if (recent.length >= PLAYER_PER_MINUTE) t = Math.max(t, recent[recent.length - PLAYER_PER_MINUTE] + PLAYER_WINDOW_MS);
  return t;
}

export function canSend(state: PacerState, key: string, now: number, kind: SendKind = {}): boolean {
  return nextAllowedAt(state, key, now, kind) <= now;
}

/** Records one POST for `key` at `now`. */
export function recordSend(state: PacerState, key: string, now: number): PacerState {
  return {
    sent: [...state.sent.filter((s) => s > now - PLAYER_WINDOW_MS), now],
    lastByProblem: { ...state.lastByProblem, [key]: now },
    pausedUntil: state.pausedUntil,
  };
}

/** No POST for `ms` from `now` (a 429, or the server unreachable). */
export function pause(state: PacerState, now: number, ms: number): PacerState {
  return { ...state, pausedUntil: Math.max(state.pausedUntil, now + ms) };
}

/** Number of POSTs in the minute before `now`. */
export function sentLastMinute(state: PacerState, now: number): number {
  return state.sent.filter((s) => s > now - PLAYER_WINDOW_MS).length;
}

/** Drops problems whose minute has passed, so that a save does not grow with every problem played. */
export function compact(state: PacerState, now: number): PacerState {
  const lastByProblem: Record<string, number> = {};
  for (const [k, t] of Object.entries(state.lastByProblem)) if (t > now - PROBLEM_INTERVAL_MS) lastByProblem[k] = t;
  return { sent: state.sent.filter((s) => s > now - PLAYER_WINDOW_MS), lastByProblem, pausedUntil: state.pausedUntil };
}
