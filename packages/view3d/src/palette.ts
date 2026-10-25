/**
 * Colours and names. Pieces take the hues the site's other space drawings use (137.5 degrees
 * apart, so that neighbours in the list differ). Cells get their own palette, used for the tint of
 * every face glued to them: on a polytope whose cells are the faces of a cube-like frame (normals
 * +-e_i, the tesseract), the two cells of an axis share a hue family, the - cell darker; other
 * polytopes get evenly spread hues.
 */
import type { Polytope } from "@polypack/boundary";

const AXES = "xyzw";

/** The hue of piece i, in degrees. */
export const pieceHue = (i: number): number => (i * 137.508) % 360;

/** The fill of piece i as a CSS colour. */
export function pieceColor(i: number, dark: boolean): string {
  const h = pieceHue(i).toFixed(1);
  return dark ? `hsl(${h}, 50%, 56%)` : `hsl(${h}, 58%, 60%)`;
}

/** The outline of piece i: darker than the fill on light pages, lighter on dark ones. */
export function pieceEdgeColor(i: number, dark: boolean): string {
  const h = pieceHue(i).toFixed(1);
  return dark ? `hsl(${h}, 60%, 80%)` : `hsl(${h}, 55%, 26%)`;
}

/** The cut faces of piece i (where it meets a cell face): a paler fill. */
export function pieceCutColor(i: number, dark: boolean): string {
  const h = pieceHue(i).toFixed(1);
  return dark ? `hsl(${h}, 45%, 70%)` : `hsl(${h}, 60%, 78%)`;
}

/** The axis and sign of a cell whose outward normal is +-e_i, or null. */
export function cellAxis(normal: readonly number[]): { axis: number; sign: 1 | -1 } | null {
  let axis = -1;
  for (let i = 0; i < normal.length; i++) {
    if (Math.abs(Math.abs(normal[i]) - 1) < 1e-9) axis = i;
    else if (Math.abs(normal[i]) > 1e-9) return null;
  }
  return axis < 0 ? null : { axis, sign: normal[axis] > 0 ? 1 : -1 };
}

/** Short names of the cells: "-x", "+w" on the tesseract (with a true minus sign), else "cell 3". */
export function cellNames(poly: Polytope): string[] {
  return poly.cells.map((c, i) => {
    const ax = cellAxis(c.normal);
    if (!ax || poly.d > AXES.length) return `cell ${i}`;
    return `${ax.sign > 0 ? "+" : "−"}${AXES[ax.axis]}`;
  });
}

/** The name of ambient axis k. */
export const axisName = (k: number): string => (k < AXES.length ? AXES[k] : `x${k + 1}`);

const FAMILY = [8, 140, 212, 282];

/** One colour per cell, as CSS. */
export function cellColors(poly: Polytope, dark: boolean): string[] {
  const axes = poly.cells.map((c) => cellAxis(c.normal));
  if (axes.every((a) => a !== null) && poly.d <= FAMILY.length) {
    return axes.map((a) => {
      const h = FAMILY[a!.axis] + (a!.sign > 0 ? 14 : -14);
      if (dark) return a!.sign > 0 ? `hsl(${h}, 70%, 72%)` : `hsl(${h}, 60%, 52%)`;
      return a!.sign > 0 ? `hsl(${h}, 75%, 58%)` : `hsl(${h}, 65%, 36%)`;
    });
  }
  return poly.cells.map((_, i) => {
    const h = ((i * 360) / poly.cells.length + 20) % 360;
    return dark ? `hsl(${h}, 55%, 62%)` : `hsl(${h}, 60%, 45%)`;
  });
}

/** The page colours the view reads, with fallbacks for a page without the site's stylesheet. */
export interface Theme {
  dark: boolean;
  bg: string;
  panel: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
}

export const LIGHT: Theme = {
  dark: false,
  bg: "#f6f7f9",
  panel: "#ffffff",
  text: "#1a1d21",
  muted: "#56606b",
  border: "#c9ced6",
  accent: "#0b5fd1",
};

export const DARK: Theme = {
  dark: true,
  bg: "#14171b",
  panel: "#1d2127",
  text: "#e8ebef",
  muted: "#a3acb8",
  border: "#3a414b",
  accent: "#6aa9ff",
};

/** A coordinate for the labels: three decimals (positions, not scores), with a true minus sign. */
export function fmt(v: number): string {
  const r = Math.abs(v) < 5e-4 ? 0 : v;
  return r.toFixed(3).replace("-", "\u2212");
}
