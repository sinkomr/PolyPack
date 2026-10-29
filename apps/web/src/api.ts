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
import type { SpaceName, SpaceRecordsResponse, SpaceSiteOnlyResponse, SpacesResponse } from "@polypack/spaces";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export const getProblem = (N: number, M: number, P: number) => getJson<ProblemInfo>(`/api/problems/${N}/${M}/${P}`);

/** One problem's leader in a /api/leaders answer: a polygon's site_best, or a space problem's best value (research: true for the research record). */
export interface LeaderValue {
  score: number;
  name: string;
  id: number | null;
  verification?: "none" | "confirmed" | "pending";
  research?: true;
}
export interface LeadersAnswer {
  /** By key: null when the problem has no leader (or is closed). A key that is absent was not answered. */
  leaders: Record<string, LeaderValue | null>;
  /** Keys the server did not know or could not read. */
  unknown: string[];
}
/** Most keys one /api/leaders request takes. */
export const LEADERS_MAX_KEYS = 200;

/** The leaders of up to 200 problems in one request ("N/M/P" or a space problem's id); null when it failed. */
export const getLeaders = (keys: readonly string[]) =>
  getJson<LeadersAnswer>(`/api/leaders?keys=${keys.map(encodeURIComponent).join(",")}`);

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

/** The spaces beside polygon-in-polygon packing (surfaces, curvature, sphere, tori) and their exhibits. */
export const getSpaces = () => getJson<SpacesResponse>("/api/spaces");

/** Every problem of one space, with its research value and site best, without configurations. */
export const getSpaceRecords = (space: SpaceName) =>
  getJson<SpaceRecordsResponse>(`/api/spaces/${encodeURIComponent(space)}/records`);

/** One page of a space's problems that have a site entry and no research record (see collectPages). */
export const getSpaceSiteOnly = (space: SpaceName, after?: string) =>
  getJson<SpaceSiteOnlyResponse>(
    `/api/spaces/${encodeURIComponent(space)}/site-only?limit=5000${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`,
  );

/** The units of everything the board sends (disk and ball pieces of diameter 1; circle and ball containers by diameter). */
export const SITE_UNITS = "diameter";

/** POST /api/submit: a configuration with its name, note and how it was found (see submissionFields). */
export async function submit(
  config: PackingConfig & Record<string, unknown>,
): Promise<SubmitResponse | { error: string }> {
  try {
    const r = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // the unit confirmation the server asks for on problems with disk or ball pieces or a circle or ball container
      body: JSON.stringify({ ...config, units: SITE_UNITS }),
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

/** Least time between two streams one LiveFeed opens: quick changes of what it follows coalesce. */
export const FOLLOW_GAP_MS = 1000;

/** EventSource.readyState of an open stream (the constant is not there outside a browser). */
const OPEN = 1;

/**
 * Live leaderboard updates for the problems a page shows (GET /api/events). Server-sent events are
 * the primary channel; while no stream is open, `poll` is called every 10 s as the fallback.
 *
 * `follow` says what to follow: "N/M/P" and "N/M/*" keys (see eventKeys), or null for every
 * problem. Following other keys opens a new stream in place of the old one, at most one every
 * FOLLOW_GAP_MS, and the latest wish wins; an event in between can be missed, so a page reads what
 * it shows again when it follows something new. An EventSource that reconnects by itself asks for
 * the same keys again. Following no keys at all closes the stream.
 */
export class LiveFeed {
  private source: EventSource | null = null;
  /** The address of the open stream, and of the one wanted ("" for none); undefined before the first follow. */
  private current: string | undefined;
  private wanted: string | undefined;
  private openedAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(
    private onEvent: (e: LeaderboardEvent) => void,
    poll: (() => void) | null = null,
    private open: (url: string) => EventSource = (url) => new EventSource(url),
    private now: () => number = () => Date.now(),
  ) {
    if (poll)
      this.poller = setInterval(() => {
        if (!this.isLive()) poll();
      }, 10_000);
  }

  /** Follows `keys` from now on, or every problem with null. */
  follow(keys: readonly string[] | null): void {
    this.wanted = keys === null ? "/api/events" : keys.length ? `/api/events?keys=${keys.join(",")}` : "";
    this.apply();
  }

  private apply(): void {
    if (this.wanted === undefined || this.wanted === this.current || this.timer) return;
    const wait = this.openedAt + FOLLOW_GAP_MS - this.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.apply();
      }, wait);
      return;
    }
    this.source?.close();
    this.source = null;
    this.current = this.wanted;
    if (!this.current) return;
    this.openedAt = this.now();
    try {
      this.source = this.open(this.current);
      this.source.addEventListener("leaderboard", (e) => {
        try {
          this.onEvent(JSON.parse((e as MessageEvent).data));
        } catch {
          // a malformed event is ignored
        }
      });
    } catch {
      this.source = null;
    }
  }

  isLive(): boolean {
    return !!this.source && this.source.readyState === OPEN;
  }

  /** Stops following anything, for good. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
    this.timer = this.poller = null;
    this.source?.close();
    this.source = null;
    this.current = this.wanted = undefined;
  }
}
