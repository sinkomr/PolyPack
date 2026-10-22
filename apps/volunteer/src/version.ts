/** The client's version; test/options.test.ts checks that it matches package.json. */
export const VERSION = "0.1.0";

/** Sent as `software` with each submission, and as the User-Agent of every request. */
export const SOFTWARE = `polypack-volunteer/${VERSION}`;
