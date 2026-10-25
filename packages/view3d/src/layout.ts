/**
 * Small multiples: n square tiles in a W x H box, as large as they can be. Each tile has a strip
 * of `label` pixels on top for its title and a square below for the drawing. The grid is centred.
 */

export interface Tile {
  /** The whole tile, title strip included, in CSS pixels from the box's top left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The square drawing area below the title. */
  view: { x: number; y: number; size: number };
}

export interface GridLayout {
  cols: number;
  rows: number;
  /** Side of each tile's square drawing area. */
  size: number;
  tiles: Tile[];
}

export function gridLayout(n: number, W: number, H: number, opts: { gap?: number; label?: number } = {}): GridLayout {
  const gap = opts.gap ?? 8;
  const label = opts.label ?? 0;
  let best = { cols: 1, rows: n, size: -Infinity };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    // a full last row only: 8 as 3 x 3 wastes a tile, but it may still be the largest
    const tw = (W - gap * (cols - 1)) / cols;
    const th = (H - gap * (rows - 1)) / rows - label;
    const size = Math.min(tw, th);
    // prefer the larger tile; on a tie, fewer empty tiles, then more columns
    const empty = cols * rows - n;
    const bestEmpty = best.cols * best.rows - n;
    if (size > best.size + 0.5 || (Math.abs(size - best.size) <= 0.5 && empty < bestEmpty)) best = { cols, rows, size };
  }
  const size = Math.max(1, Math.floor(best.size));
  const { cols, rows } = best;
  const gridW = cols * size + gap * (cols - 1);
  const gridH = rows * (size + label) + gap * (rows - 1);
  const x0 = Math.max(0, (W - gridW) / 2);
  const y0 = Math.max(0, (H - gridH) / 2);
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    // centre a short last row
    const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
    const shift = ((cols - inRow) * (size + gap)) / 2;
    const x = Math.round(x0 + shift + c * (size + gap));
    const y = Math.round(y0 + r * (size + label + gap));
    tiles.push({ x, y, w: size, h: size + label, view: { x, y: y + label, size } });
  }
  return { cols, rows, size, tiles };
}
