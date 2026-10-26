/**
 * The Problem set menu of the board's Problem section, built from the table in dimension-table.ts:
 * one option per family, grouped by dimension (an <optgroup> per dimension). A family that is not
 * available yet is listed, disabled, as "coming soon".
 *
 * Flat (2D in 2D) is the polygon board as it always was. Another family loads the space mode
 * (space/mode.ts) with a dynamic import, so that the polygon board does not load the spaces' code
 * until it is wanted. The address "#space=<id>" (space-address.ts) opens a space problem directly;
 * any other address (a polygon link such as #p=, or none, as after Back) shows the polygon board.
 *
 * The board's <main> carries data-space while a space is shown (the CSS hides the polygon board's
 * parts) and data-dimension always, so that a dimension's mode can adapt the layout.
 */
import { type FamilyTarget, menuGroups, whereIs } from "./dimension-table";
import { type BoardSpace, isBoardSpace, parseSpaceAddress } from "./space-address";

interface SpaceModeApi {
  enter(space: BoardSpace, id: string | null): Promise<void>;
  leave(): void;
  setPolygonHeld(held: boolean): void;
}

/** What the polygon board's optimizer does while another family is shown. */
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
export function initDimensionSwitch(
  showPolygon: () => void,
  say: (message: string) => void,
  run: PolygonRunHooks = { hold: () => false, release: () => {} },
): void {
  const select = document.getElementById("family-select") as HTMLSelectElement;
  const layout = select.closest("main") as HTMLElement;
  let mode: Promise<SpaceModeApi> | null = null;
  let current: BoardSpace | null = null;
  let polygonShown = true;
  /** The polygon board's address (#p=..., #c=... or none) when a space was chosen, given back on return. */
  let polygonHash = "";
  /** True while the polygon board's run is paused because a space is shown. */
  let held = false;

  for (const g of menuGroups()) {
    const group = document.createElement("optgroup");
    group.label = g.label;
    for (const o of g.options) {
      const option = new Option(o.text, o.value);
      option.disabled = o.disabled;
      group.append(option);
    }
    select.append(group);
  }

  /** The menu names the family shown, and <main> its dimension. */
  function showMenu(target: FamilyTarget): void {
    const where = whereIs(target);
    if (!where) return;
    select.value = target;
    layout.dataset.dimension = where.dimension.id;
  }

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
    stage.setAttribute("aria-label", "Workspace");
    const text = document.createElement("p");
    text.className = "space-busy";
    text.setAttribute("role", "status");
    text.textContent = "Loading…";
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
    showMenu(space);
    layout.dataset.space = space;
    placeholder();
    try {
      const m = await load();
      m.setPolygonHeld(held);
      if (current === space) await m.enter(space, id);
    } catch (error) {
      toPolygon(true);
      layout.querySelector(".space-placeholder")?.remove();
      const name = whereIs(space)?.family.name ?? space;
      say(`${name} could not be loaded: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  function toPolygon(clearAddress: boolean): void {
    showMenu("polygon");
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
    // a family that is not available cannot be chosen; this keeps the menu right if one ever is
    if (!whereIs(select.value)) return showMenu(current ?? "polygon");
    if (isBoardSpace(select.value)) void toSpace(select.value, null);
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
  } else showMenu("polygon");
}
