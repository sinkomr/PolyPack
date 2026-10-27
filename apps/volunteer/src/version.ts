/** The client's version; test/options.test.ts checks that it matches package.json. */
export const VERSION = "0.2.0";

/** Sent as `software` with each submission, and as the User-Agent of every request. */
export const SOFTWARE = `polypack-volunteer/${VERSION}`;

/**
 * The version of the files in the state directory (state.json). 1 (no file): lengths in the units before 2026-10-27, disks
 * and balls of radius 1; 2: the units of the site since then, disks and balls of diameter 1 and circle and ball containers
 * scored by diameter. The first start with 0.2.0 converts what it can (src/state-units.ts) and sets 2.
 */
export const STATE_VERSION = 2;

/** What every submission says about its lengths; the server answers 426 to a disk or ball problem without it. */
export const UNITS = "diameter";

/** Where an out-of-date client is sent. */
export const UPGRADE_URL = "https://polypack.fly.dev/volunteer.html";
