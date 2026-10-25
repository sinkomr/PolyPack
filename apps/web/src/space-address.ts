/**
 * The board's address of a problem in one of the other spaces: "#space=<problem id>", such as
 * "#space=sphere/0/12" or "#space=curved/-1/3/4/5", or "#space=<space>" for a space at the problem
 * the board starts it with (space/model.ts DEFAULT_PROBLEM). No imports, so that the default board
 * can read it without loading the spaces. (The spaces page keeps its own "#space=torus&family=hex"
 * state on /spaces.html.)
 */

/** The spaces the board can switch to, in the order of its menu. */
export const BOARD_SPACES = ["surface", "curved", "sphere", "torus"] as const;
export type BoardSpace = (typeof BOARD_SPACES)[number];

export const isBoardSpace = (v: unknown): v is BoardSpace =>
  typeof v === "string" && (BOARD_SPACES as readonly string[]).includes(v);

/** The space and problem id an address names, or null when it names none. The id is not checked here. */
export function parseSpaceAddress(hash: string): { space: BoardSpace; id: string | null } | null {
  const m = /^#space=([^&]*)/.exec(hash);
  if (!m) return null;
  let value: string;
  try {
    value = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const head = value.split("/", 1)[0];
  if (!isBoardSpace(head)) return null;
  return { space: head, id: value.length > head.length ? value : null };
}

/** The address of a problem, or of a space when no id is given. Ids keep their slashes. */
export function spaceAddress(space: BoardSpace, id?: string | null): string {
  return `#space=${id ?? space}`;
}
