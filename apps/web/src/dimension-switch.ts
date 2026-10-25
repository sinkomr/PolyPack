/**
 * The Dimension and Kind menus of the board's Problem section, built from the table in
 * dimension-table.ts. Dimension lists every dimension; one with no available family is shown
 * disabled, as "coming soon". Kind lists the families of the chosen dimension.
 *
 * Flat (2D in 2D) is the polygon board as it always was. Another kind loads the space mode
 * (space/mode.ts) with a dynamic import, so that the polygon board does not load the spaces' code
 * until it is wanted. The address "#space=<id>" (space-address.ts) opens a space problem directly;
 * any other address (a polygon link such as #p=, or none, as after Back) shows the polygon board.
 *
 * The board's <main> carries data-space while a space is shown (the CSS hides the polygon board's
 * parts) and data-dimension always, so that a dimension's mode can adapt the layout.
 */
import { DIMENSIONS, type FamilyTarget, availableFamilies, isAvailable, whereIs } from "./dimension-table";
import { type BoardSpace, isBoardSpace, parseSpaceAddress } from "./space-address";

interface SpaceModeApi {
  enter(space: BoardSpace, id: string | null): Promise<void>;
  leave(): void;
  setPolygonHeld(held: boolean): void;
}

/** What the polygon board's optimizer does while another kind is shown. */
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
  const dimensionSelect = document.getElementById("dimension-select") as HTMLSelectElement;
  const kindSelect = document.getElementById("kind-select") as HTMLSelectElement;
  const layout = dimensionSelect.closest("main") as HTMLElement;
  let mode: Promise<SpaceModeApi> | null = null;
  let current: BoardSpace | null = null;
  let polygonShown = true;
  /** The polygon board's address (#p=..., #c=... or none) when a space was chosen, given back on return. */
  let polygonHash = "";
  /** True while the polygon board's run is paused because a space is shown. */
  let held = false;
  /** The kind last shown in each dimension, so that choosing the dimension again returns to it. */
  const lastKind = new Map<string, FamilyTarget>();
  /** The dimension whose kinds the Kind menu lists. */
  let kindsOf = "";

  for (const d of DIMENSIONS) {
    const open = isAvailable(d);
    const option = new Option(open ? d.label : `${d.label} (coming soon)`, d.id);
    option.disabled = !open;
    dimensionSelect.add(option);
  }

  /** Both menus name the kind shown; the Kind menu lists its dimension's families. */
  function showMenus(target: FamilyTarget): void {
    const where = whereIs(target);
    if (!where) return;
    const { dimension } = where;
    dimensionSelect.value = dimension.id;
    if (kindsOf !== dimension.id) {
      kindsOf = dimension.id;
      kindSelect.replaceChildren(
        ...dimension.families.map((f) => {
          const option = new Option(f.available ? f.name : `${f.name} (coming soon)`, f.space);
          option.disabled = !f.available;
          return option;
        }),
      );
    }
    kindSelect.value = target;
    layout.dataset.dimension = dimension.id;
    lastKind.set(dimension.id, target);
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
    showMenus(space);
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
    showMenus("polygon");
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

  function choose(target: string): void {
    if (isBoardSpace(target)) void toSpace(target, null);
    else toPolygon(true);
  }

  dimensionSelect.addEventListener("change", () => {
    const dimension = DIMENSIONS.find((d) => d.id === dimensionSelect.value);
    // a disabled dimension cannot be chosen; this keeps the menus right if one ever is
    const first = dimension ? availableFamilies(dimension)[0] : undefined;
    if (!dimension || !first) return showMenus(current ?? "polygon");
    choose(lastKind.get(dimension.id) ?? first.space);
  });
  kindSelect.addEventListener("change", () => choose(kindSelect.value));
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
  } else showMenus("polygon");
}
