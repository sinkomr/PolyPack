import { PackingConfig, parseConfig } from "@polypack/geometry";
import { BOARD_UNITS, boardFromOldUnits } from "./board-units";

// Share links carry the whole configuration in the URL fragment as base64url JSON:
//   #c=<base64url({N, M, P, phi, p: [x0, y0, theta0, x1, ...], u: "diameter"})>
// A link without `u` was made before 2026-10-27, when disks had radius 1: it is converted when read (board-units.ts).
// The fragment never reaches the server, and numbers keep full double precision.

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

export function encodeShare(c: PackingConfig): string {
  const p: number[] = [];
  for (const q of c.pieces) p.push(q.x, q.y, q.theta);
  return "c=" + toBase64Url(JSON.stringify({ N: c.N, M: c.M, P: c.P, phi: c.container_phi, p, u: BOARD_UNITS }));
}

export function decodeShare(hash: string): PackingConfig | null {
  const m = /(?:^|[#&])c=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const o = JSON.parse(fromBase64Url(m[1]));
    const pieces = [];
    for (let i = 0; i + 2 < o.p.length; i += 3) pieces.push({ x: o.p[i], y: o.p[i + 1], theta: o.p[i + 2] });
    const r = parseConfig({ N: o.N, M: o.M, P: o.P, pieces, container_phi: o.phi });
    if (!r.ok) return null;
    return o.u === BOARD_UNITS ? r.config : boardFromOldUnits(r.config);
  } catch {
    return null;
  }
}
