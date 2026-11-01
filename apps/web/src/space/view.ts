/**
 * A drawing of a space packing with its own small toolbar: the ways to draw it (globe or map,
 * solid or net, ...), a button that resets the view, and keyboard turning (arrow keys, Shift for
 * larger steps) where the view turns. It redraws when its box changes size or the colour scheme
 * changes. Used by the board's space mode, and meant for any page that shows such a packing.
 *
 * The 2D kinds and 3D in 3D (render/polyhedra.ts and render/balls.ts, three.js) draw with a SpaceRenderer (render/*.ts)
 * under the toolbar built here. 3D on 4D (boundary) draws with the three.js views of
 * packages/view3d, which bring their own toolbar and controls (render/boundary.ts).
 */
import type { SpaceConfig } from "@polypack/spaces";
import type { SearchProblem } from "@polypack/spaces/search";
import { mountBoundaryView } from "./render/boundary";
import type { SpaceRenderer } from "./render/common";
import { curvedRenderer } from "./render/curved";
import { ballsRenderer } from "./render/balls";
import { polyhedraRenderer } from "./render/polyhedra";
import { sphereRenderer } from "./render/sphere";
import { surfaceRenderer } from "./render/surface";
import { torusRenderer } from "./render/torus";

/** The problems drawn by a SpaceRenderer: the 2D kinds and 3D in 3D. */
export type FlatDrawnProblem = Exclude<SearchProblem, { space: "boundary" } | { space: "ndim" }>;

/** The renderer of a problem's space. */
export function createRenderer(p: FlatDrawnProblem): SpaceRenderer {
  switch (p.space) {
    case "surface":
      return surfaceRenderer(p.solid, p.N, p.P, p.mode);
    case "curved":
      return curvedRenderer(p.K, p.N, p.M, p.P);
    case "sphere":
      return sphereRenderer(p.N, p.P);
    case "torus":
      return torusRenderer(p);
    case "polyhedra":
      return polyhedraRenderer(p.code, p.P);
    case "balls":
      return ballsRenderer(p.code, p.P);
  }
}

export interface SpaceView {
  /** The renderer of the 2D kinds and 3D in 3D; absent for 3D on 4D, whose views bring their own. */
  readonly renderer?: SpaceRenderer;
  /** Draws a configuration of the problem; null clears the drawing. */
  show(config: SpaceConfig | null): void;
  /**
   * True when this view can draw another problem's configurations as well (3D on 4D: the same
   * polytope and piece), so that the page keeps it, with the user's view, for that problem.
   */
  canShow?(p: SearchProblem): boolean;
  destroy(): void;
}

const STEP = (5 * Math.PI) / 180;

/**
 * Mounts a drawing of problem `p` into `host` (emptied first): a toolbar and the drawing below it.
 * `label` names the toolbar for screen readers.
 */
export function mountSpaceView(host: HTMLElement, p: SearchProblem, label = "Drawing"): SpaceView {
  if (p.space === "boundary") return mountBoundaryView(host, p, label);
  if (p.space === "ndim") throw new Error("the board does not draw the nD spaces yet");
  const renderer = createRenderer(p);
  const root = document.createElement("div");
  root.className = "space-view";
  const tools = document.createElement("div");
  tools.className = "toolbar space-tools";
  tools.setAttribute("role", "toolbar");
  tools.setAttribute("aria-label", label);
  const box = document.createElement("div");
  box.className = "space-draw";
  box.append(renderer.element);
  const buttons = renderer.views.map((v) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = v.label;
    b.dataset.view = v.key;
    b.addEventListener("click", () => {
      renderer.setView(v.key);
      sync();
    });
    return b;
  });
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset view";
  reset.addEventListener("click", () => renderer.reset());
  // said only where it is true: a view that turns, with a packing in it
  const hint = document.createElement("span");
  hint.className = "space-hint";
  hint.textContent = "Drag to turn";
  tools.append(...buttons, reset, hint);
  root.append(tools, box);
  host.replaceChildren(root);
  let shown = false;

  function sync() {
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.view === renderer.view));
    // an empty drawing does not turn, and takes no focus
    const turns = shown && renderer.canTurn();
    reset.hidden = !turns;
    hint.hidden = !turns;
    // only a view that turns takes the keyboard
    if (turns) {
      box.tabIndex = 0;
      box.setAttribute("role", "application");
    } else {
      box.removeAttribute("tabindex");
      box.setAttribute("role", "img");
    }
    box.setAttribute(
      "aria-label",
      shown ? renderer.describe() + (turns ? " Drag it or use the arrow keys to turn it." : "") : "No packing to draw.",
    );
  }

  box.addEventListener("keydown", (e) => {
    if (!shown || !renderer.canTurn()) return;
    const k = e.shiftKey ? 3 * STEP : STEP;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-k, 0],
      ArrowRight: [k, 0],
      ArrowUp: [0, -k],
      ArrowDown: [0, k],
    };
    if (d[e.key]) {
      e.preventDefault();
      renderer.turn(...d[e.key]);
    } else if (e.key === "Home" || e.key === "0") {
      e.preventDefault();
      renderer.reset();
    }
  });
  const resize = new ResizeObserver(() => renderer.redraw());
  resize.observe(box);
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const recolour = () => renderer.redraw();
  scheme.addEventListener("change", recolour);
  sync();

  return {
    renderer,
    show(config) {
      shown = config !== null;
      if (config) renderer.draw(config);
      renderer.element.style.visibility = shown ? "" : "hidden";
      sync();
    },
    destroy() {
      resize.disconnect();
      scheme.removeEventListener("change", recolour);
      renderer.destroy();
      root.remove();
    },
  };
}
