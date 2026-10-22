import {
  AtlasResponse,
  HoldersResponse,
  LeaderboardEntry,
  LeaderboardEvent,
  LiteratureRecord,
  PackingConfig,
  ProblemInfo,
  SubmitResponse,
} from "@polypack/geometry";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export const getProblem = (N: number, M: number, P: number) => getJson<ProblemInfo>(`/api/problems/${N}/${M}/${P}`);

export const getLeaderboard = (N: number, M: number, P: number) =>
  getJson<{ entries: LeaderboardEntry[]; total: number }>(`/api/leaderboard/${N}/${M}/${P}`);

export const getSubmission = (id: number) => getJson<PackingConfig & { score: number }>(`/api/submissions/${id}`);

export interface RecordsResponse {
  N: number;
  M: number;
  /** Published values without their coordinates; `has_coordinates` says whether /api/atlas can draw them. */
  literature: (Omit<LiteratureRecord, "pieces"> & { has_coordinates?: boolean })[];
  /** Best listed entry per P. It may be pending verification. */
  site: (LeaderboardEntry & { P: number })[];
  /** For each P whose best entry is pending: the best entry that is not, when there is one. */
  site_verified?: (LeaderboardEntry & { P: number })[];
}
export const getRecords = (N: number, M: number) => getJson<RecordsResponse>(`/api/records?N=${N}&M=${M}`);

/** Every name that leads a problem, with how many it leads and how many of those are records. */
export const getHolders = () => getJson<HoldersResponse>("/api/holders");

/** Drawable packings for P in [from, to]; `next` in the answer says where a shortened answer stopped. */
export const getAtlas = (N: number, M: number, from: number, to: number) =>
  getJson<AtlasResponse>(`/api/atlas?N=${N}&M=${M}&from=${from}&to=${to}`);

/** POST /api/submit: a configuration with its name, note and how it was found (see submissionFields). */
export async function submit(
  config: PackingConfig & Record<string, unknown>,
): Promise<SubmitResponse | { error: string }> {
  try {
    const r = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    const body = await r.json();
    if (!r.ok && !("valid" in body)) return { error: body.error ?? `server answered ${r.status}` };
    return body as SubmitResponse;
  } catch {
    return { error: "the server could not be reached" };
  }
}

/**
 * POST /api/submit, answered with its HTTP status: 200 for a valid entry, 409 for a closed problem,
 * 429 when the address sent too many, 400/413/422 for a refused body. `status` is null when the
 * server could not be reached, and `body` null when its answer was not JSON.
 */
export async function postSubmission(body: Record<string, unknown>): Promise<{ status: number | null; body: unknown }> {
  let r: Response;
  try {
    r = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: null, body: null };
  }
  try {
    return { status: r.status, body: await r.json() };
  } catch {
    return { status: r.status, body: null };
  }
}

/**
 * Live leaderboard updates. Server-sent events are the primary channel. While the event stream
 * is not open, `poll` is called every 10 s as the fallback.
 */
export function subscribe(onEvent: (e: LeaderboardEvent) => void, poll: () => void): () => boolean {
  let source: EventSource | null = null;
  try {
    source = new EventSource("/api/events");
    source.addEventListener("leaderboard", (e) => onEvent(JSON.parse((e as MessageEvent).data)));
  } catch {
    source = null;
  }
  const isLive = () => !!source && source.readyState === EventSource.OPEN;
  setInterval(() => {
    if (!isLive()) poll();
  }, 10000);
  return isLive;
}
