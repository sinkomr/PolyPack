import { isSpaceName, parseSpaceId } from "@polypack/spaces";
import { planarFactors, spacePlan } from "./units-migration";

/** Version of the API's conventions: 2 since the unit change (disk and ball pieces have diameter 1). */
export const CONVENTIONS_VERSION = 2;
/** The date the unit change was made (the first day of version 2). */
export const UNITS_DATE = "2026-10-27";
/** The first volunteer client that sends `units` and works in diameter units. */
export const VOLUNTEER_MIN_VERSION = "0.2.0";

export const UNITS_EXPLANATION =
  `Since ${UNITS_DATE} (API conventions version ${CONVENTIONS_VERSION}) disk and ball pieces have diameter 1 (radius 1/2), ` +
  "and a circle or ball container is scored by its diameter. A 2D disk configuration of the old units becomes the new one " +
  "by multiplying the x and y of every piece by 1/2 (disks in a polygon container: the score also halves; disks in a circle: " +
  "the score stays; polygons in a circle: the score doubles).";

/** The sentence an old client is answered with (426). */
export const UPGRADE_MESSAGE =
  `${UNITS_EXPLANATION} This request is from a client that still works in the old units: update the PolyPack volunteer client to ` +
  `${VOLUNTEER_MIN_VERSION} or later (https://polypack.fly.dev/volunteer.html), or, for your own client, convert as described and send ` +
  `"units": "diameter" with every submission to a problem with disk or ball pieces or a circle or ball container.`;

export const UNITS_MISSING_MESSAGE =
  `this problem has disk or ball pieces or a circle or ball container, and the units changed on ${UNITS_DATE}: ` +
  `send "units": "diameter" to confirm the configuration is in the new units (disk and ball pieces of diameter 1; circle and ball ` +
  `containers scored by their diameter). ${UNITS_EXPLANATION} The volunteer client ${VOLUNTEER_MIN_VERSION} or later does this.`;

/** The version of a `polypack-volunteer/<version>` User-Agent as [major, minor, patch], or null for any other client. */
export function volunteerVersion(userAgent: string | undefined): [number, number, number] | null {
  const m = /polypack-volunteer\/(\d+)\.(\d+)(?:\.(\d+))?/i.exec(userAgent ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** True for a volunteer client older than VOLUNTEER_MIN_VERSION. */
export function isOldVolunteer(userAgent: string | undefined): boolean {
  const v = volunteerVersion(userAgent);
  if (!v) return false;
  const min = VOLUNTEER_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] < min[i];
  return false;
}

/** True when a 2D problem has disk pieces or a circle container. */
export function planarAffected(N: number, M: number): boolean {
  return planarFactors(N, M) !== null;
}

/** True when a problem of a space has disk or ball pieces or a circle or ball container (curved disks at K != 0 included). */
export function spaceAffected(space: string, id: string): boolean {
  if (!isSpaceName(space)) return false;
  return spacePlan(space, id) !== null;
}

/** True for an id of /api/spaces/... in the path of a space problem that the unit change did not touch. */
export function spacePathUnaffected(path: string): boolean {
  const m = /^\/api\/spaces\/([a-z]+)\/problems\/(.+)$/.exec(path);
  if (!m || !isSpaceName(m[1])) return false;
  let id: string;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return false;
  }
  return typeof parseSpaceId(m[1], id) !== "string" && !spaceAffected(m[1], id);
}

/** What a request from an old volunteer may still read: the index, the health check and the snapshot. */
export function oldClientMayRead(method: string, path: string): boolean {
  if (path === "/api" || path === "/api/health" || path === "/api/snapshot" || path.startsWith("/api/snapshot/")) return true;
  const planar = /^\/api\/(?:problems|leaderboard)\/(\d+)\/(\d+)\/\d+$/.exec(path);
  if (method === "GET" && planar) return !planarAffected(Number(planar[1]), Number(planar[2]));
  return method === "GET" && spacePathUnaffected(path);
}
