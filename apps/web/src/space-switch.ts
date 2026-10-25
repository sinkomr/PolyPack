/**
 * The Space menu of the board's Problem section. "Polygon in polygon" is the board as it always
 * was; another space loads the space mode (space/mode.ts) with a dynamic import, so that the
 * polygon board does not load the spaces' code until it is wanted. The address "#space=<id>"
 * (space-address.ts) opens a space problem directly; any other address (a polygon link such as
 * #p=, or none, as after Back) shows the polygon board.
 */
import { type BoardSpace, isBoardSpace, parseSpaceAddress } from "./space-address";

interface SpaceModeApi {
  enter(space: BoardSpace, id: string | null): Promise<void>;
  leave(): void;
  setPolygonHeld(held: boolean): void;
}

/** What the polygon board's optimizer does while a space is shown. */
export interface PolygonRunHooks {
  /** Pauses a running search; true when it did. */
  hold(): boolean;
  /** Resumes a search that hold() paused. */
  release(): void;
}

/**
 * `showPolygon` is called when the polygon board is shown for the first time after the page
 * opened on a space: its canvas had no size until then, so its view is fitted again.
 * `say` reports on the polygon board's status line.
 */
export function initSpaceSwitch(
  showPolygon: () => void,
  say: (message: string) => void,
  run: PolygonRunHooks = { hold: () => false, release: () => {} },
): void {
  const select = document.getElementById("space-select") as HTMLSelectElement;
  const layout = select.closest("main") as HTMLElement;
  let mode: Promise<SpaceModeApi> | null = null;
  let current: BoardSpace | null = null;
  let polygonShown = true;
  /** The polygon board's address (#p=..., #c=... or none) when a space was chosen, given back on return. */
  let polygonHash = "";
  /** True while the polygon board's run is paused because a space is shown. */
  let held = false;

  const load = () =>
    (mode ??= import("./space/mode").then(
      (m) => m.createSpaceMode(),
      (error: unknown) => {
        mode = null;
        throw error;
      },
    ));

  /** Until the space mode has built its own stage, the stage says that it is loading. */
  function placeholder(): void {
    if (layout.querySelector(".space-stage, .space-placeholder")) return;
    const stage = document.createElement("section");
    stage.className = "stage space-only space-placeholder";
    stage.setAttribute("aria-label", "Space workspace");
    const text = document.createElement("p");
    text.className = "space-busy";
    text.setAttribute("role", "status");
    text.textContent = "Loading the spaces…";
    stage.append(text);
    layout.prepend(stage);
  }

  async function toSpace(space: BoardSpace, id: string | null): Promise<void> {
    if (current === null) {
      if (!parseSpaceAddress(location.hash)) polygonHash = location.hash;
      // the board's own search waits while it is hidden, so that two searches do not compete unseen
      held = run.hold();
    }
    current = space;
    select.value = space;
    layout.dataset.space = space;
    placeholder();
    try {
      const m = await load();
      m.setPolygonHeld(held);
      if (current === space) await m.enter(space, id);
    } catch (error) {
      toPolygon(true);
      layout.querySelector(".space-placeholder")?.remove();
      say(`The spaces could not be loaded: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  function toPolygon(clearAddress: boolean): void {
    select.value = "";
    if (current === null) return;
    current = null;
    delete layout.dataset.space;
    void mode
      ?.then((m) => {
        m.leave();
        m.setPolygonHeld(false);
      })
      .catch(() => {});
    if (held) {
      held = false;
      run.release();
    }
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
    // a polygon link, or no address at all (Back from a space's address)
    else toPolygon(false);
  });
  const where = parseSpaceAddress(location.hash);
  if (where) {
    polygonShown = false;
    void toSpace(where.space, where.id);
  } else select.value = "";
}
