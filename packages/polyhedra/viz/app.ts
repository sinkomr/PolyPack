/**
 * The standalone viewer of the polyhedra records (viz/index.html, built by scripts/build-viz.ts). The page embeds
 * the records with display-precision poses as POLYHEDRA_DATA; drawing is src/draw.ts.
 */
import { DARK_PALETTE, LIGHT_PALETTE, createPolyhedraView } from "../src/draw";
import { POLYHEDRA_PROBLEMS, getProblem, wikiUrl } from "../src/problems";
import type { Pose } from "../src/geom";

interface VizRecord {
  /** P */
  n: number;
  s: number;
  d: string;
  /** volume bound */
  b: number;
  /** wiki value */
  w: number;
  f: string;
  /** certificate refined by */
  cr?: string;
  /** method, for PolyPack's own records */
  m?: string;
  src: string;
  lit: { v: number; s: string; u?: string; q?: number }[];
  /** flat poses, 7 numbers each */
  p: number[];
}

declare const POLYHEDRA_DATA: { generated: string; records: Record<string, VizRecord[]> };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const prob = $<HTMLSelectElement>("problem");
const nsel = $<HTMLSelectElement>("n");
const info = $<HTMLDivElement>("info");
const table = $<HTMLTableElement>("table");
const themeBtn = $<HTMLButtonElement>("theme");
const spinBtn = $<HTMLButtonElement>("spin");

const dark = () => {
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
};
const palette = () => (dark() ? DARK_PALETTE : LIGHT_PALETTE);
const view = createPolyhedraView($<HTMLCanvasElement>("cv"), { palette: palette(), spin: true });

const groups: Record<string, string> = { platonic: "Platonic", archimedean: "Archimedean", catalan: "Catalan", prisms: "Prisms and antiprisms" };
for (const fam of Object.keys(groups)) {
  const og = document.createElement("optgroup");
  og.label = groups[fam];
  for (const p of POLYHEDRA_PROBLEMS.filter((x) => x.family === fam && POLYHEDRA_DATA.records[x.code])) {
    const o = document.createElement("option");
    o.value = p.code;
    o.textContent = p.title;
    og.appendChild(o);
  }
  prob.appendChild(og);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (x: number) => x.toFixed(6);

function show(code: string, n: number, push = true) {
  const recs = POLYHEDRA_DATA.records[code] ?? [];
  const r = recs.find((x) => x.n === n) ?? recs[0];
  const problem = getProblem(code)!;
  if (!r) return;
  prob.value = code;
  nsel.innerHTML = recs.map((x) => `<option value="${x.n}"${x.n === r.n ? " selected" : ""}>${x.n}</option>`).join("");
  const pieces: Pose[] = [];
  for (let i = 0; i < r.p.length; i += 7) pieces.push(r.p.slice(i, i + 7) as Pose);
  view.setConfig(problem, { s: r.s, pieces });
  const better = r.s < r.w * (1 - 1e-6);
  const lit = r.lit
    .map((l) => `<li>${fmt(l.v)}${l.q ? ` (to ${l.q})` : ""}: ${l.u ? `<a href="${esc(l.u)}" rel="noopener">${esc(l.s)}</a>` : esc(l.s)}</li>`)
    .join("");
  info.innerHTML =
    `<div class="big">s = ${r.d}</div>` +
    `<p>${n} ${esc(problem.title.toLowerCase())}; certified at s = ${r.s}. Volume bound ${fmt(r.b)}.</p>` +
    `<p>Wiki: <a href="${wikiUrl(code, r.n)}" rel="noopener">${fmt(r.w)}</a>${better ? ' <span class="better">(beaten here)</span>' : ""}</p>` +
    `<p>Found by ${esc(r.f)}${r.cr ? `; certificate refined by ${esc(r.cr)}` : ""}.</p>` +
    (r.m ? `<p class="muted">${esc(r.m)}</p>` : "") +
    `<p class="muted">${esc(r.src)}</p>` +
    (lit ? `<p>Published values without coordinates:</p><ul class="notes">${lit}</ul>` : "");
  table.innerHTML =
    "<thead><tr><th>P</th><th>s</th><th>bound</th><th>wiki</th></tr></thead><tbody>" +
    recs
      .map(
        (x) =>
          `<tr data-n="${x.n}"${x.n === r.n ? ' class="sel"' : ""}><td>${x.n}</td><td>${x.d}</td><td>${fmt(x.b)}</td><td${x.s < x.w * (1 - 1e-6) ? ' class="better"' : ""}>${fmt(x.w)}</td></tr>`,
      )
      .join("") +
    "</tbody>";
  if (push) history.replaceState(null, "", `#${code}_n${String(r.n).padStart(2, "0")}`);
}

prob.onchange = () => show(prob.value, Number(nsel.value) || 2);
nsel.onchange = () => show(prob.value, Number(nsel.value));
table.onclick = (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-n]") as HTMLElement | null;
  if (tr) show(prob.value, Number(tr.dataset.n));
};
themeBtn.onclick = () => {
  const order = ["auto", "light", "dark"];
  const cur = document.documentElement.dataset.theme ?? "auto";
  const next = order[(order.indexOf(cur) + 1) % 3];
  if (next === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  themeBtn.textContent = `Theme: ${next}`;
  view.setPalette(palette());
};
let spinning = true;
spinBtn.onclick = () => {
  spinning = !spinning;
  spinBtn.setAttribute("aria-pressed", String(spinning));
  view.setSpin(spinning);
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => view.setPalette(palette()));

const m = /^#([a-z0-9]+)_n(\d+)$/.exec(location.hash);
show(m && POLYHEDRA_DATA.records[m[1]] ? m[1] : "cubincub", m ? Number(m[2]) : 11, false);
