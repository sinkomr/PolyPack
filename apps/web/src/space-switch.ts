/**
 * The Space menu of the board's Problem section. "Polygon in polygon" is the board as it always
 * was; another space loads the space mode (space/mode.ts) with a dynamic import, so that the
 * polygon board does not load the spaces' code until it is wanted. The address "#space=<id>"
 * (space-address.ts) opens a space problem directly, and a polygon link (#p=, #c=, #s=) returns
 * to the polygon board.
 */
import { type BoardSpace, isBoardSpace, parseSpaceAddress } from "./space-address";

interface SpaceModeApi {
  enter(space: BoardSpace, id: string | null): Promise<void>;
  leave(): void;
}

/**
 * `showPolygon` is called when the polygon board is shown for the first time after the page
 * opened on a space: its canvas had no size until then, so its view is fitted again.
 * `say` reports on the polygon board's status line.
 */
export function initSpaceSwitch(showPolygon: () => void, say: (message: string) => void): void {
  const select = document.getElementById("space-select") as HTMLSelectElement;
  const layout = select.closest("main") as HTMLElement;
  let mode: Promise<SpaceModeApi> | null = null;
  let current: BoardSpace | null = null;
  let polygonShown = true;
  /** The polygon board's address (#p=..., #c=... or none) when a space was chosen, given back on return. */
  let polygonHash = "";

  const load = () =>
    (mode ??= import("./space/mode").then(
      (m) => m.createSpaceMode(),
      (error: unknown) => {
        mode = null;
        throw error;
      },
    ));

  async function toSpace(space: BoardSpace, id: string | null): Promise<void> {
    if (current === null && !parseSpaceAddress(location.hash)) polygonHash = location.hash;
    current = space;
    select.value = space;
    layout.dataset.space = space;
    try {
      const m = await load();
      if (current === space) await m.enter(space, id);
    } catch (error) {
      toPolygon(true);
      say(`The spaces could not be loaded: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  function toPolygon(clearAddress: boolean): void {
    select.value = "";
    if (current === null) return;
    current = null;
    delete layout.dataset.space;
    void mode?.then((m) => m.leave()).catch(() => {});
    if (clearAddress && parseSpaceAddress(location.hash))
      history.replaceState(history.state, "", `${location.pathname}${location.search}${polygonHash}`);
    if (!polygonShown) {
      polygonShown = true;
      showPolygon();
    }
  }

  select.addEventListener("change", () => {
    const v = select.value;
    if (isBoardSpace(v)) void toSpace(v, null);
    else toPolygon(true);
  });
  window.addEventListener("hashchange", () => {
    const where = parseSpaceAddress(location.hash);
    if (where) void toSpace(where.space, where.id);
    else if (current !== null && /^#(?:.*&)?(?:p|c|s)=/.test(location.hash)) toPolygon(false);
  });
  const where = parseSpaceAddress(location.hash);
  if (where) {
    polygonShown = false;
    void toSpace(where.space, where.id);
  } else select.value = "";
}
