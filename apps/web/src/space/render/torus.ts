/**
 * Drawing of a packing on a flat torus (torus/<family>/<N>/<P>), ported from
 * packages/torus/viz/build.ts. Two drawings of the same packing:
 *  - "Tiled plane": copies of the fundamental cell around the central one, which is outlined;
 *    every lattice translate of a piece has the piece's colour;
 *  - "One cell": the fundamental cell alone; the parts of pieces that leave it come back on the
 *    opposite side (drawn lighter), and arrows mark which sides are glued.
 * Centres are reduced to the cell first (fractional coordinates in [0, 1)).
 */
import { circumradius } from "@polypack/geometry";
import type { SpaceConfig } from "@polypack/spaces";
import { type SearchProblem, torusPackingOf } from "@polypack/spaces/search";
import { SVG_NS, type SpaceRenderer, isDark, piecesText } from "./common";

type V2 = readonly [number, number];

/** Drawings made, for clip path ids that differ between drawings on one page. */
let drawings = 0;

const add = (a: V2, B: readonly [V2, V2], m: number, n: number): [number, number] => [
  a[0] + m * B[0][0] + n * B[1][0],
  a[1] + m * B[0][1] + n * B[1][1],
];

/** The parallelogram {s b1 + t b2 : s, t in [s0, s1]} as an SVG path (y flipped). */
function para(B: readonly [V2, V2], s0: number, s1: number): string {
  const c = (
    [
      [s0, s0],
      [s1, s0],
      [s1, s1],
      [s0, s1],
    ] as V2[]
  ).map(([s, t]) => {
    const p = add([0, 0], B, s, t);
    return p[0].toFixed(4) + "," + (-p[1]).toFixed(4);
  });
  return "M" + c.join("L") + "Z";
}

export function torusRenderer(problem: SearchProblem & { space: "torus" }): SpaceRenderer {
  const { N, P, family } = problem;
  const R = N === 0 ? 1 : circumradius(N);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const clipId = `torus-clip-${++drawings}`;
  let view = "tile";
  let packing: ReturnType<typeof torusPackingOf> | null = null;
  let score = 0;

  // one hue per orbit; ghosts (outside the cell in the one-cell view) lighter
  const fill = (i: number, ghost: boolean) => {
    const h = ((i * 360) / P + 20) % 360;
    const l = isDark() ? (ghost ? 30 : 48) : ghost ? 78 : 58;
    return `hsl(${h.toFixed(1)} 62% ${l}% / ${ghost ? 0.55 : 0.92})`;
  };
  const piece = (x: number, y: number, th: number, color: string, sw: string) => {
    if (N === 0)
      return `<circle cx="${x.toFixed(4)}" cy="${(-y).toFixed(4)}" r="1" fill="${color}" stroke="var(--panel)" stroke-width="${sw}"/>`;
    const pts: string[] = [];
    for (let k = 0; k < N; k++) {
      const a = th + Math.PI / 2 + (2 * Math.PI * k) / N;
      pts.push((x + R * Math.cos(a)).toFixed(4) + "," + (-(y + R * Math.sin(a))).toFixed(4));
    }
    return `<polygon points="${pts.join(" ")}" fill="${color}" stroke="var(--panel)" stroke-width="${sw}"/>`;
  };

  function redraw() {
    if (!packing) {
      svg.replaceChildren();
      return;
    }
    const B: readonly [V2, V2] = [packing.lattice.b1, packing.lattice.b2];
    const tile = view === "tile";
    const cc = (
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ] as V2[]
    ).map(([s, t]) => add([0, 0], B, s, t));
    let x0 = Math.min(...cc.map((c) => c[0]));
    let x1 = Math.max(...cc.map((c) => c[0]));
    let y0 = Math.min(...cc.map((c) => c[1]));
    let y1 = Math.max(...cc.map((c) => c[1]));
    // tiled: a rectangular window around the cell; one cell: the cell itself
    const grow = tile ? Math.max(1.6 * R, 0.45 * Math.max(x1 - x0, y1 - y0)) : 0;
    x0 -= grow;
    x1 += grow;
    y0 -= grow;
    y1 += grow;
    const pad = tile ? 0 : R * 0.15 + 0.3;
    const vb = [x0 - pad, -y1 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
    const sw = (vb[2] / 600).toFixed(4);
    const clip = tile
      ? `M${x0.toFixed(4)},${(-y1).toFixed(4)}H${x1.toFixed(4)}V${(-y0).toFixed(4)}H${x0.toFixed(4)}Z`
      : para(B, 0, 1);
    let s = `<defs><clipPath id="${clipId}"><path d="${clip}"/></clipPath></defs>`;
    const det = B[0][0] * B[1][1] - B[0][1] * B[1][0];
    const cen = packing.poses.map((q): [V2, number] => {
      let a = (q.x * B[1][1] - q.y * B[1][0]) / det;
      let b = (B[0][0] * q.y - B[0][1] * q.x) / det;
      a -= Math.floor(a);
      b -= Math.floor(b);
      return [add([0, 0], B, a, b), q.theta];
    });
    // every lattice translate whose bounding disk meets the window
    const K =
      2 +
      Math.ceil(
        Math.max(x1 - x0, y1 - y0) / Math.min(Math.abs(det) / Math.hypot(...B[0]), Math.abs(det) / Math.hypot(...B[1])),
      );
    const hit = (p: V2) => p[0] + R > x0 && p[0] - R < x1 && p[1] + R > y0 && p[1] - R < y1;
    let body = "";
    let cells = "";
    const span = [Math.abs(B[0][0]) + Math.abs(B[1][0]), Math.abs(B[0][1]) + Math.abs(B[1][1])];
    for (let m = -K; m <= K; m++)
      for (let n = -K; n <= K; n++) {
        const central = m === 0 && n === 0;
        cen.forEach(([c, t], i) => {
          const p = add(c, B, m, n);
          if (hit(p)) body += piece(p[0], p[1], t, fill(i, !tile && !central), sw);
        });
        const o = add([0, 0], B, m, n);
        if (
          tile &&
          !central &&
          o[0] + span[0] > x0 - 1 &&
          o[0] - span[0] < x1 + 1 &&
          o[1] + span[1] > y0 - 1 &&
          o[1] - span[1] < y1 + 1
        )
          cells += `<path d="${para(B, 0, 1)}" transform="translate(${o[0].toFixed(4)} ${(-o[1]).toFixed(4)})" fill="none" stroke="var(--text)" stroke-opacity="0.3" stroke-width="${sw}"/>`;
      }
    s += `<g clip-path="url(#${clipId})">${body}${cells}</g>`;
    s += `<path d="${para(B, 0, 1)}" fill="none" stroke="var(--text)" stroke-width="${(3 * Number(sw)).toFixed(4)}"/>`;
    if (!tile) {
      // one arrow on the b1 sides, two on the b2 sides: opposite sides are glued
      const h = 0.12 * Math.min(Math.hypot(...B[0]), Math.hypot(...B[1]));
      const arrow = (p0: V2, v: V2, k: number) => {
        let out = "";
        const len = Math.hypot(v[0], v[1]);
        const ux = v[0] / len;
        const uy = v[1] / len;
        for (let q = 0; q < k; q++) {
          const f = 0.5 + (q - (k - 1) / 2) * 0.05;
          const x = p0[0] + f * v[0];
          const y = p0[1] + f * v[1];
          out += `<path d="M${(x - h * ux - h * 0.6 * uy).toFixed(4)},${(-(y - h * uy + h * 0.6 * ux)).toFixed(4)}L${x.toFixed(4)},${(-y).toFixed(4)}L${(x - h * ux + h * 0.6 * uy).toFixed(4)},${(-(y - h * uy - h * 0.6 * ux)).toFixed(4)}" fill="none" stroke="var(--accent)" stroke-width="${(3 * Number(sw)).toFixed(4)}"/>`;
        }
        return out;
      };
      s += arrow([0, 0], B[0], 1) + arrow(B[1], B[0], 1) + arrow([0, 0], B[1], 2) + arrow(B[0], B[1], 2);
    }
    svg.setAttribute("viewBox", vb.map((v) => v.toFixed(4)).join(" "));
    // only numbers and fixed strings go into the markup
    svg.innerHTML = s;
  }

  return {
    element: svg,
    views: [
      { key: "tile", label: "Tiled plane" },
      { key: "cell", label: "One cell" },
    ],
    get view() {
      return view;
    },
    setView(key) {
      view = key === "cell" ? "cell" : "tile";
      redraw();
    },
    draw(c: SpaceConfig) {
      packing = torusPackingOf(problem, c);
      const l = packing.lattice;
      score =
        family === "free" ? Math.sqrt(Math.abs(l.b1[0] * l.b2[1] - l.b1[1] * l.b2[0])) : Math.hypot(l.b1[0], l.b1[1]);
      redraw();
    },
    redraw,
    canTurn: () => false,
    turn() {},
    reset() {},
    describe() {
      if (!packing) return "No packing to draw.";
      const torus =
        family === "sq"
          ? "a square torus of side"
          : family === "hex"
            ? "a hexagonal torus of side"
            : "a torus of cell √area";
      return `${piecesText(N, P)} on ${torus} ${score.toFixed(6)}, ${view === "tile" ? "drawn as the tiled plane" : "drawn as one cell"}.`;
    },
    destroy() {
      svg.remove();
    },
  };
}
