import type { CertifiedValue, SiteBest, SpaceDomainField, SpaceInfo, SpaceName, SpaceTarget } from "@polypack/spaces";
import { DIMENSIONS, availableFamilies, familyOfSpace, isAvailable } from "./dimension-table";
import {
  ALL,
  FieldSpec,
  Filters,
  ListedProblem,
  SPACE_FIELDS,
  fieldOf,
  fieldValues,
  parseHash,
  minus,
  plainBoundLabel,
  problemStatus,
  round6,
  statusLabel,
  stateHash,
} from "./spaces-model";

/**
 * The pure parts of the Records page for the dimensions other than the classic board: tabs and
 * their addresses, the problem pickers, the series a chart draws (one problem family against P), and
 * how a chart is scaled and described. No DOM in here; spaces-model.ts holds what the dimensions page
 * shares with this page.
 */

// ---------- tabs ----------

/** The classic board's records page; every other kind's records are on RECORDS_PATH. */
export const POLYGON_RECORDS = "/browse.html";
export const RECORDS_PATH = "/records.html";

/** The address of a kind's records: Flat is the page of the polygons, the others a hash of this page. */
export const kindHref = (space: string): string =>
  space === "polygon" ? POLYGON_RECORDS : `${RECORDS_PATH}#space=${encodeURIComponent(space)}`;

export interface TabLink {
  text: string;
  href: string;
  current: boolean;
  /** True for a dimension no kind of which is available yet: shown, not linked. */
  soon?: boolean;
}

/**
 * The tabs of the Records page: a link per dimension (to its first available kind), and, under the
 * current dimension, a link per available kind when it has more than one. `current` is "polygon"
 * for the classic page, or the space of the page.
 */
export function tabModel(current: string): { dimensions: TabLink[]; kinds: TabLink[] } {
  const here = familyOfSpace(current)?.dimension.id;
  const dimensions = DIMENSIONS.map((d): TabLink => {
    const first = availableFamilies(d)[0];
    return {
      text: d.label,
      href: first ? kindHref(first.space) : "",
      current: d.id === here,
      ...(isAvailable(d) ? {} : { soon: true }),
    };
  });
  const dimension = DIMENSIONS.find((d) => d.id === here);
  const families = dimension ? availableFamilies(dimension) : [];
  const kinds =
    families.length > 1
      ? families.map((f) => ({ text: f.short, href: kindHref(f.space), current: f.space === current }))
      : [];
  return { dimensions, kinds };
}

// ---------- the address ----------

export interface RecordsState {
  space: SpaceName;
  /** One value for every field: the problem family the charts draw. */
  filters: Filters;
  /** The table lists every record of the kind, not only the problem family. */
  all: boolean;
}

/** "#space=torus&family=hex&N=0", and "&all=1" when the table lists every record of the kind. */
export function recordsHash(state: RecordsState): string {
  return `${stateHash(state)}${state.all ? "&all=1" : ""}`;
}

/** The state an address names (a hash of the dimensions page reads too), or null when no kind is offered. */
export function parseRecordsHash(hash: string, spaces: readonly SpaceName[]): RecordsState | null {
  const base = parseHash(hash, spaces);
  if (!base) return null;
  return { ...base, all: new URLSearchParams(hash.replace(/^#/, "")).get("all") === "1" };
}

// ---------- pickers ----------

export interface PickerOption {
  value: string;
  text: string;
  group?: string;
}

export interface Picker {
  spec: FieldSpec;
  options: PickerOption[];
}

/**
 * The picker of each field. A kind whose problems are given by a domain (most of them have no
 * record) offers every value the domain has, with the server's names and groups; the others offer
 * the values their records have.
 */
export function pickers(space: SpaceName, problems: readonly ListedProblem[], info?: SpaceInfo): Picker[] {
  const domain = new Map<string, SpaceDomainField>((info?.domain?.fields ?? []).map((f) => [f.key, f]));
  return SPACE_FIELDS[space].map((spec) => {
    const d = domain.get(spec.key);
    const values = d?.values ? [...d.values] : fieldValues(problems, spec);
    return {
      spec,
      options: values.map((value) => {
        const group = d?.groups?.[value] ?? spec.group?.(value);
        return {
          value,
          text: d?.titles?.[value] ?? spec.option(value),
          ...(group === undefined ? {} : { group }),
        };
      }),
    };
  });
}

/** True when the problem has a research record or a site entry: something a chart can show. */
export const hasValue = (p: Pick<ListedProblem, "best_score">): boolean => p.best_score !== null;

/**
 * One value for each picker: the wished one where the picker offers it; else the field's starting
 * value if records match the choices so far; else the first value with a record (or any value when none has).
 */
export function settleSeries(
  list: readonly Picker[],
  problems: readonly ListedProblem[],
  wished: Filters = {},
): Filters {
  const out: Filters = {};
  for (const { spec, options } of list) {
    const values = options.map((o) => o.value);
    const matching = (v: string) =>
      problems.some(
        (p) =>
          hasValue(p) &&
          fieldOf(p, spec) === v &&
          list.every((q) => !(q.spec.key in out) || fieldOf(p, q.spec) === out[q.spec.key]),
      );
    const wish = wished[spec.key];
    out[spec.key] =
      wish !== undefined && values.includes(wish)
        ? wish
        : values.includes(spec.start) && matching(spec.start)
          ? spec.start
          : (values.find(matching) ?? (values.includes(spec.start) ? spec.start : (values[0] ?? "")));
  }
  return out;
}

/** The problems of one family (every field chosen), sorted by P. */
export function seriesProblems(
  specs: readonly FieldSpec[],
  problems: readonly ListedProblem[],
  chosen: Filters,
): ListedProblem[] {
  return problems.filter((p) => specs.every((f) => fieldOf(p, f) === chosen[f.key])).sort((a, b) => a.P - b.P);
}

/** The family's name in a few words: "Cube, fold, square". */
export const seriesTitle = (specs: readonly FieldSpec[], chosen: Filters): string =>
  specs.map((f) => (f.key === "K" ? `K = ${f.cell(chosen[f.key] ?? "")}` : f.cell(chosen[f.key] ?? ""))).join(", ");

/** The hash that shows a problem's family. */
export const seriesHash = (space: SpaceName, specs: readonly FieldSpec[], p: ListedProblem): string =>
  recordsHash({ space, filters: Object.fromEntries(specs.map((f) => [f.key, fieldOf(p, f)])), all: false });

// ---------- sizes ----------

/** The range of P a family has in the kind's domain, or null when the kind has no domain. */
export function domainPRange(info?: SpaceInfo): [number, number] | null {
  const f = info?.domain?.fields.find((x) => x.key === "P");
  return f && typeof f.min === "number" && typeof f.max === "number" ? [f.min, f.max] : null;
}

/** How many problems a family has: its domain's range of P, else the problems it lists. */
export function seriesSize(info: SpaceInfo | undefined, listed: number): number {
  const r = domainPRange(info);
  return r ? r[1] - r[0] + 1 : listed;
}

const n = (v: number) => v.toLocaleString("en-US");

/**
 * The line under the pickers: the family's problems and how many have a record or an entry, then
 * the kind's records in all against its problems.
 */
export function seriesNote(
  info: SpaceInfo | undefined,
  series: readonly ListedProblem[],
  totalRecords: number,
  totalProblems: number,
): string {
  const size = seriesSize(info, series.length);
  const valued = series.filter(hasValue).length;
  const infeasible = series.filter((p) => problemStatus(p) === "infeasible").length;
  const parts = [
    valued
      ? `${n(valued)} of this family's ${n(size)} ${size === 1 ? "problem" : "problems"} ${valued === 1 ? "has" : "have"} a record or an entry`
      : `None of this family's ${n(size)} ${size === 1 ? "problem has" : "problems have"} a record or an entry yet`,
  ];
  if (infeasible) parts.push(`${n(infeasible)} ${infeasible === 1 ? "is" : "are"} proved to have no packing`);
  const all =
    totalProblems > totalRecords
      ? `${n(totalRecords)} of the kind's ${n(totalProblems)} problems have a research record.`
      : `The kind has ${n(totalRecords)} problems, all with a research record.`;
  return `${parts.join("; ")}. ${all}`;
}

// ---------- entries on problems without a record ----------

/**
 * Reads a paginated listing to its end: `page(after)` answers a page of rows and the `after` of the next page (null
 * on the last). Stops after `maxPages`, and on a page that fails (null), keeping what was read.
 */
export async function collectPages<T>(
  page: (after: string | undefined) => Promise<{ problems: T[]; next: string | null } | null>,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const got = await page(after);
    if (!got) break;
    out.push(...got.problems);
    if (got.next === null || got.next === after) break;
    after = got.next;
  }
  return out;
}

/** The redirect of a hash that names the polygons' problems, or a kind this page does not have, to browse.html. */
export const isPolygonHash = (hash: string, spaces: readonly string[]): boolean => {
  if (/^#\d+,\d+$/.test(hash)) return true;
  const named = new URLSearchParams(hash.replace(/^#/, "")).get("space");
  return named !== null && !spaces.includes(named);
};

// ---------- chart ----------

/** What a chart shows at one P. */
export interface ChartPoint {
  P: number;
  id: string;
  /** The smaller of the research record and the site entry. */
  record: number | null;
  certified: CertifiedValue | null;
  site: SiteBest | null;
  bound: number | null;
  boundLabel: string | null;
}

/** The points of a family: its problems with a record or an entry, by P. */
export function chartPoints(series: readonly ListedProblem[]): ChartPoint[] {
  return series
    .filter(hasValue)
    .sort((a, b) => a.P - b.P)
    .map((p) => ({
      P: p.P,
      id: p.id,
      record: p.best_score,
      certified: p.certified,
      site: p.site_best,
      bound: p.bound?.value ?? null,
      boundLabel: p.bound?.label ? plainBoundLabel(p.bound.label) : null,
    }));
}

export type ChartMode = "size" | "gap";

/** The value a mode plots for a score at a point: the score, or its distance above the bound. */
export const plotted = (mode: ChartMode, score: number, p: Pick<ChartPoint, "bound">): number | null =>
  mode === "size" ? score : p.bound === null ? null : score - p.bound;

export interface ChartScale {
  yMin: number;
  yMax: number;
  /** Decimals on the vertical axis. */
  digits: number;
}

/**
 * The vertical range that holds the records, the entries and the bounds in view (3% beyond them for
 * sizes; 4% of their spread for gaps), or null when there is nothing to plot.
 */
export function chartScale(points: readonly ChartPoint[], mode: ChartMode): ChartScale | null {
  const values = points.flatMap((p) =>
    [p.record, p.certified?.score ?? null, p.site?.score ?? null, p.bound]
      .filter((v): v is number => v !== null)
      .map((v) => plotted(mode, v, p))
      .filter((v): v is number => v !== null),
  );
  if (!values.length) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || 1) * 0.04;
  return mode === "size"
    ? { yMin: lo * 0.97, yMax: hi * 1.03, digits: 2 }
    : { yMin: lo - pad, yMax: hi + pad, digits: hi - lo + 2 * pad < 0.4 ? 3 : 2 };
}

/** Round values of P (1, 2 or 5 times a power of ten apart) to label, at most about 16 of them. */
export function pTicks(pMin: number, pMax: number): number[] {
  const raw = (pMax - pMin) / 16;
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const step = [1, 2, 5, 10].map((k) => k * pow).find((k) => k >= raw) ?? 10 * pow;
  const out: number[] = [];
  for (let p = Math.ceil(pMin / step) * step; p <= pMax; p += step) out.push(p);
  return out;
}

/** Short names of what each kind scores, for the vertical axis. */
export const SCORE_NAMES: Record<SpaceName, string> = {
  surface: "solid's scale s",
  curved: "container size",
  sphere: "sphere radius ρ",
  torus: "lattice size L",
  boundary: "polytope edge s",
  polyhedra: "container scale s",
  balls: "container size s",
};

const CERTIFIED: Record<string, string> = { best_known: "best known", proven: "proven optimal" };

/** The lines of the box that describes a point: a heading, then labelled values. */
export function pointLines(title: string, p: ChartPoint): { head: string; lines: [label: string, text: string][] } {
  const lines: [string, string][] = [];
  if (p.record !== null) lines.push(["record", round6(p.record)]);
  if (p.certified)
    lines.push([
      "research record",
      `${round6(p.certified.score)} (${CERTIFIED[p.certified.status] ?? p.certified.status})`,
    ]);
  if (p.site) lines.push(["site best", `${round6(p.site.score)} by ${p.site.name}`]);
  if (p.bound !== null) lines.push(["lower bound", `${round6(p.bound)}${p.boundLabel ? ` (${p.boundLabel})` : ""}`]);
  if (p.record !== null && p.bound !== null) lines.push(["gap", `${gapText(p.record, p.bound)} above the bound`]);
  return { head: `${title}, P = ${p.P}`, lines };
}

// ---------- table ----------

/** Who holds a problem's record, in words: the site entry that leads, else the research record. */
export function holderText(p: Pick<ListedProblem, "certified" | "site_best">): string {
  if (p.site_best && (!p.certified || p.site_best.score < p.certified.score)) return "Site entry";
  return p.certified ? "Research record" : "—";
}

/** The score of a row: the record's six decimals, or a dash. */
export const scoreText = (p: Pick<ListedProblem, "best_score">): string =>
  p.best_score === null ? "—" : round6(p.best_score);

/**
 * The gap of a row from the two values as shown: the record and the bound each rounded to 6 decimals, then
 * subtracted, so that the columns add up. A negative gap (a value rounded below its bound) takes a minus sign.
 */
export function gapText(record: number, bound: number): string {
  const micro = (v: number) => Math.round(Number(round6(v)) * 1e6);
  return minus(((micro(record) - micro(bound)) / 1e6).toFixed(6));
}

/** The status column: the research record's, or, for a problem that has only a site entry, that. */
export function statusText(
  p: Pick<ListedProblem, "status" | "certified" | "accepts_submissions" | "site_best">,
): string {
  const s = problemStatus(p);
  return s === "no_record" && p.site_best ? "site entry, no research record" : statusLabel(s);
}

/**
 * The range of P a chart is zoomed to after a request for [from, to] (null: every P) over the points spanning
 * `all`. The whole range again is no zoom; a range under two P wide is too little to draw, and the zoom stays as it is.
 */
export function nextZoom(
  current: { from: number; to: number } | null,
  all: readonly [number, number] | null,
  from: number | null,
  to?: number,
): { from: number; to: number } | null {
  if (from === null || to === undefined || !all) return null;
  const lo = Math.max(all[0], from);
  const hi = Math.min(all[1], to);
  if (lo <= all[0] && hi >= all[1]) return null;
  return hi - lo < 2 ? current : { from: lo, to: hi };
}
