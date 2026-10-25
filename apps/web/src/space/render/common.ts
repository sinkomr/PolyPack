/**
 * What the drawings of the spaces share: the renderer contract, the piece colours (one hue per
 * piece, as in the standalone viewers) and canvas sizing. The drawings read the page's colours
 * (style.css) at every draw, so they follow the light and dark schemes.
 */
import type { SpaceConfig } from "@polypack/spaces";

export interface SpaceRenderer {
  /** The drawing: a canvas or an svg element that fills its box. */
  readonly element: HTMLElement | SVGSVGElement;
  /** The ways it can draw, the default first. */
  readonly views: readonly { key: string; label: string }[];
  readonly view: string;
  setView(key: string): void;
  /** Draws a configuration of the renderer's problem. */
  draw(config: SpaceConfig): void;
  /** Draws again (a resize, another colour scheme). */
  redraw(): void;
  /** True when the current view can be turned (drag, or turn()). */
  canTurn(): boolean;
  /** Turns the view by about dx to the right and dy down, in radians. */
  turn(dx: number, dy: number): void;
  /** Back to the first view's starting angle. */
  reset(): void;
  /** What is drawn, in a sentence for screen readers. */
  describe(): string;
  destroy(): void;
  /**
   * True when the drawing holds resources worth releasing while the board shows another kind (a WebGL
   * context and its buffers): the mode then destroys it on leaving and makes it again on return.
   */
  readonly releaseOnLeave?: boolean;
}

export const isDark = (): boolean => matchMedia("(prefers-color-scheme: dark)").matches;

/** A page colour (a custom property of style.css). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The fill of piece i: hues 137.5° apart, so that neighbours in the list differ. */
export function pieceFill(i: number, alpha = 1): string {
  const h = ((i * 137.508) % 360).toFixed(1);
  return isDark() ? `hsl(${h} 45% 52% / ${alpha})` : `hsl(${h} 55% 62% / ${alpha})`;
}

/** Sizes a canvas to its box at the device's pixel ratio; returns its context in CSS pixels and the box. */
export function fitCanvas(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, cv.clientWidth);
  const h = Math.max(1, cv.clientHeight);
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Pointer drags on an element, reported as moves in CSS pixels. */
export function onDrag(el: Element, move: (dx: number, dy: number) => void): () => void {
  let last: [number, number] | null = null;
  const down = (e: Event) => {
    const p = e as PointerEvent;
    last = [p.clientX, p.clientY];
    (el as HTMLElement).setPointerCapture?.(p.pointerId);
  };
  const moved = (e: Event) => {
    const p = e as PointerEvent;
    if (!last) return;
    const dx = p.clientX - last[0];
    const dy = p.clientY - last[1];
    last = [p.clientX, p.clientY];
    if (dx || dy) move(dx, dy);
  };
  const up = () => (last = null);
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", moved);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", moved);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
}

/** "12 disks", "1 square", "5 7-gons". */
export function piecesText(N: number, P: number): string {
  const names: Record<number, string> = {
    0: "disk",
    3: "triangle",
    4: "square",
    5: "pentagon",
    6: "hexagon",
    7: "heptagon",
    8: "octagon",
  };
  const one = names[N] ?? `${N}-gon`;
  return `${P} ${P === 1 ? one : `${one}s`}`;
}

export const SVG_NS = "http://www.w3.org/2000/svg";
