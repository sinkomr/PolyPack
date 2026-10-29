import { isSpaceName } from "@polypack/spaces";
import { planarFactors, spacePlan } from "./units-migration";

/** Version of the API's conventions: 2 since the unit change (disk and ball pieces have diameter 1). */
export const CONVENTIONS_VERSION = 2;
/** The date the unit change was made (the first day of version 2). */
export const UNITS_DATE = "2026-10-27";
/**
 * The oldest volunteer client the server answers: 0.3.0 draws its problems itself, at random (2026-10-29), where 0.2.x read
 * the work lists that were removed then; 0.2.0 was the first to send `units` and work in diameter units.
 */
export const VOLUNTEER_MIN_VERSION = "0.3.0";

export const UNITS_EXPLANATION =
  `Since ${UNITS_DATE} (API conventions version ${CONVENTIONS_VERSION}) disk and ball pieces have diameter 1 (radius 1/2), ` +
  "and a circle or ball container is scored by its diameter. A 2D disk configuration of the old units becomes the new one " +
  "by multiplying the x and y of every piece by 1/2 (disks in a polygon container: the score also halves; disks in a circle: " +
  "the score stays; polygons in a circle: the score doubles).";

/** The sentence an old volunteer client is answered with (426). */
export const UPGRADE_MESSAGE =
  "This volunteer client is out of date. Since 2026-10-29 the client draws each problem at random itself, and the work " +
  "lists that earlier versions read (/api/targets and /api/spaces/targets) were removed; versions before 0.2.0 also work " +
  `in the units before ${UNITS_DATE}, with disks and balls of radius 1. Update the PolyPack volunteer client to ` +
  `${VOLUNTEER_MIN_VERSION} or later: https://polypack.fly.dev/volunteer.html`;

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

/** What a request from an old volunteer may still read: the API page, the health check and the snapshot. */
export function oldClientMayRead(method: string, path: string): boolean {
  if (method !== "GET") return false;
  return path === "/api" || path === "/api/health" || path === "/api/snapshot" || path.startsWith("/api/snapshot/");
}
