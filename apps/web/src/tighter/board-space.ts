import type { SpaceConfig } from "@polypack/spaces";
import type { SpaceKey } from "./frontier";

/**
 * The board of a space problem: the site's own drawing of its packing (space/view.ts), without the
 * drawing's toolbar. Everything that holds the spaces' geometry (the drawing, three.js for 3D in 3D,
 * the problem's parser) is loaded by dynamic import when the first space problem is shown, so the
 * polygon page does not carry it. Nothing this module imports at load time reaches it.
 */

export interface SpaceBoard {
  /** Draws a configuration (null clears the drawing). Cheap to call on every board update. */
  show(config: SpaceConfig | null): void;
  destroy(): void;
}

/**
 * The word for a space problem's score, after the drawing's own labels (space/model.ts scoreLabel).
 * Kept here, free of imports, because the score box asks for it before the drawing is loaded.
 */
export function spaceScoreWord(p: Pick<SpaceKey, "family" | "id">): string {
  switch (p.family) {
    case "surface":
      return "Edge s";
    case "sphere":
      return "Radius ρ";
    case "torus":
      return p.id.split("/")[1] === "free" ? "Cell size" : "Side L";
    case "curved":
      // curved/<K>/<N>/<M>/<P>: M = 0 is a circle container
      return p.id.split("/")[3] === "0" ? "Radius r" : "Side s";
    case "balls":
      return "Container size";
    default:
      return "Scale s";
  }
}

/**
 * What the score box shows of a space problem: the score's word, the server's lower bound (null
 * when it gave none) and the gap of the best score to it, s / bound - 1. The box leaves density
 * out, for the spaces' pieces are not one shape with an area.
 */
export function spaceScoreBox(
  p: Pick<SpaceKey, "family" | "id"> & { bound: number | null },
  best: number | null,
): { label: string; bound: number | null; gap: number | null } {
  const bound = p.bound !== null && p.bound > 0 ? p.bound : null;
  return { label: spaceScoreWord(p), bound, gap: bound !== null && best !== null ? best / bound - 1 : null };
}

/** Mounts the drawing of `problem` in `host` (emptied first); `show` draws once the drawing has loaded. */
export function mountSpaceBoard(host: HTMLElement, problem: SpaceKey & { board?: SpaceConfig | null }): SpaceBoard {
  let dead = false;
  let view: { show(config: SpaceConfig | null): void; destroy(): void } | null = null;
  // what was asked last, and what the drawing shows: the scene is redrawn only for a new configuration
  let wanted: SpaceConfig | null = problem.board ?? null;
  let drawn: SpaceConfig | null | undefined;
  const draw = () => {
    if (!view || drawn === wanted) return;
    drawn = wanted;
    view.show(wanted);
  };
  host.classList.add("t-space-board");
  void (async () => {
    try {
      const [{ mountSpaceView }, { parseSearchProblem }] = await Promise.all([
        import("../space/view"),
        import("@polypack/spaces/search"),
      ]);
      if (dead) return;
      const search = parseSearchProblem(problem.id);
      if (!search) return;
      view = mountSpaceView(host, search, "Packing");
      draw();
    } catch {
      // the drawing could not be loaded: the board stays empty, the score box still works
    }
  })();
  return {
    show(config) {
      wanted = config;
      draw();
    },
    destroy() {
      dead = true;
      view?.destroy();
      view = null;
      host.replaceChildren();
      host.classList.remove("t-space-board");
    },
  };
}
