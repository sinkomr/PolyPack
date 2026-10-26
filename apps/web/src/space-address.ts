/**
 * The board's address of a problem of a kind other than Flat: "#space=<problem id>", such as
 * "#space=sphere/0/12" or "#space=curved/-1/3/4/5", or "#space=<space>" for a space at the problem
 * the board starts it with (space/model.ts DEFAULT_PROBLEM). The API calls these families spaces,
 * and the address keeps that name, so that older links still work. No imports, so that the default
 * board can read it without loading the spaces. (The dimensions page keeps its own
 * "#space=torus&family=hex" state on /dimensions.html.)
 */

/**
 * The spaces the board can show. Its Problem set menu lists them by dimension (dimension-table.ts);
 * a family of the table can be made available only once its space is here.
 */
export const BOARD_SPACES = ["surface", "curved", "sphere", "torus", "boundary", "polyhedra"] as const;
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
