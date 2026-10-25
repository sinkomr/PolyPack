/**
 * The dimensions page: every dimension of dimension-table.ts with the kinds filed under it, then
 * the records of the kinds the API serves (GET /api/spaces; the API calls them spaces). Flat, the
 * classic board, has its records on the Records page; a kind that is not available yet is listed as
 * coming soon.
 */
import type { SpaceExhibit, SpaceInfo, SpaceName } from "@polypack/spaces";
import * as api from "./api";
import { safeHref } from "./atlas-model";
import { DIMENSIONS, type Dimension, type Family, familyOfSpace } from "./dimension-table";
import { el } from "./shapes-ui";
import { isBoardSpace, spaceAddress } from "./space-address";
import {
  ALL,
  PageState,
  SPACE_FIELDS,
  configUrl,
  day,
  downloadName,
  entriesText,
  fieldOf,
  fieldValues,
  filterProblems,
  ListedProblem,
  minus,
  parseHash,
  plainBoundLabel,
  problemStatus,
  round6,
  sentence,
  settleFilters,
  shownFields,
  siteBelowCertified,
  stateHash,
  statusLabel,
  summaryText,
} from "./spaces-model";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The kind's name on this page: the table's, or the server's title for a space the table does not know. */
const nameOf = (s: Pick<SpaceInfo, "space" | "title">) => familyOfSpace(s.space)?.family.name ?? s.title;
const shortOf = (s: Pick<SpaceInfo, "space" | "title">) => familyOfSpace(s.space)?.family.short ?? s.title;

/** The spaces with a records table, in the order of the dimensions. */
let spaces: SpaceInfo[] = [];
let state: PageState | null = null;
/** Records of each space, fetched once per visit. */
const records = new Map<SpaceName, ListedProblem[]>();

/** A link whose visible text is completed for screen readers ("Viewer" → "Viewer: Torus"). */
function link(href: string, text: string, hidden: string, external: boolean): HTMLAnchorElement {
  const a = el("a", text);
  a.href = href;
  if (external) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  a.append(el("span", hidden, "visually-hidden"));
  return a;
}

interface CardLinks {
  records?: string;
  board?: string;
  viewer?: string;
  docs?: string;
}

/** One card: name, summary, facts, and links to the records, the board, the viewer and the notes. */
function card(
  key: string,
  name: string,
  summary: string,
  facts: [string, string | HTMLElement][],
  links: CardLinks,
): HTMLLIElement {
  const li = el("li", "", "space-card");
  li.dataset.space = key;
  li.append(el("h4", name), el("p", summary));
  if (facts.length) {
    const dl = el("dl", "", "space-facts");
    for (const [k, v] of facts) dl.append(el("dt", k), typeof v === "string" ? el("dd", v) : v);
    li.append(dl);
  }
  const p = el("p", "", "space-links");
  if (links.records) p.append(link(links.records, "Records", `: ${name}`, false));
  if (links.board) p.append(link(links.board, "Board", `: ${name}`, false));
  // addresses from the server are followed only when they are http(s) or a path of this site
  const viewer = safeHref(links.viewer ?? "");
  if (viewer) p.append(link(viewer, "Viewer", `: ${name}`, false));
  const docs = safeHref(links.docs ?? "");
  if (docs) p.append(link(docs, "Notes", `: ${name} (GitHub)`, !docs.startsWith("/")));
  if (p.childElementCount) li.append(p);
  return li;
}

/** The card of a kind the server lists. */
function spaceCard(s: SpaceInfo): HTMLLIElement {
  const id = el("dd");
  id.append(el("code", s.problem_id));
  const listed = Object.hasOwn(SPACE_FIELDS, s.space);
  return card(
    s.space,
    nameOf(s),
    s.summary,
    [
      ["Score", s.score],
      ["Problems", s.problems.toLocaleString("en-US")],
      ["Problem id", id],
    ],
    {
      records: listed ? stateHash({ space: s.space, filters: {} }) : undefined,
      // a space the board can show opens there, at the problem the board starts that space with
      board: listed && isBoardSpace(s.space) ? `/${spaceAddress(s.space)}` : undefined,
      viewer: s.viewer,
      docs: s.docs,
    },
  );
}

/**
 * The card of a kind from the table alone: Flat, a kind that is coming soon, or one the server did
 * not list (it may be unreachable).
 */
function tableCard(f: Family): HTMLLIElement {
  if (f.space === "polygon")
    return card(
      "polygon",
      f.name,
      f.summary,
      [
        ["Score", "the container's side s, or its radius r for a disk; smaller is better"],
        ["Problem", "N, M, P: the sides of the piece and of the container (0 for a disk), and the number of pieces"],
      ],
      { records: "/browse.html", board: "/" },
    );
  if (f.available) return card(f.space, f.name, f.summary, [], { board: `/${spaceAddress(f.space)}` });
  const li = card(f.space, f.name, f.summary, [], {});
  li.classList.add("soon");
  return li;
}

/** One section per dimension, its kinds as cards; the server's spaces outside the table come last. */
function renderDimensions(list: SpaceInfo[]): void {
  const byName = new Map(list.map((s) => [s.space as string, s]));
  const section = (d: Pick<Dimension, "id" | "label" | "summary">, cards: HTMLLIElement[], soon: boolean) => {
    const s = el("section", "", "dimension");
    s.dataset.dimension = d.id;
    const title = el("h3", soon ? `${d.label} (coming soon)` : d.label, "section-title");
    title.id = `dimension-${d.id}`;
    s.setAttribute("aria-labelledby", title.id);
    const ul = el("ul", "", "space-cards");
    ul.append(...cards);
    s.append(title, el("p", d.summary, "note dimension-summary"), ul);
    return s;
  };
  const sections = DIMENSIONS.map((d) => {
    // a kind is shown from the server when the server lists it, even before the board can show it
    const cards = d.families.map((f) => {
      const s = byName.get(f.space);
      return s ? spaceCard(s) : tableCard(f);
    });
    const soon = d.families.every((f) => !f.available && !byName.has(f.space));
    return section(d, cards, soon);
  });
  const others = list.filter((s) => !familyOfSpace(s.space));
  if (others.length)
    sections.push(
      section(
        { id: "other", label: "Other", summary: "Kinds not yet filed under a dimension." },
        others.map(spaceCard),
        false,
      ),
    );
  $("dimension-groups").replaceChildren(...sections);
}

function renderExhibits(exhibits: SpaceExhibit[]): void {
  $("exhibits").hidden = !exhibits.length;
  $("exhibit-cards").replaceChildren(
    ...exhibits.map((x) => card(x.name, x.title, x.summary, [], { viewer: x.viewer, docs: x.docs })),
  );
}

function renderPicker(): void {
  const track = $("space-pick");
  track.replaceChildren();
  for (const s of spaces) {
    const label = el("label");
    const input = el("input");
    input.type = "radio";
    input.name = "space";
    input.value = s.space;
    input.addEventListener("change", () => {
      if (input.checked) void show({ space: s.space, filters: {} });
    });
    label.append(input, el("span", shortOf(s)));
    track.append(label);
  }
}

/** The space whose filters are shown; they are built again only for another space, so focus stays on a filter. */
let filtersOf: SpaceName | null = null;

function renderFilters(space: SpaceName, problems: ListedProblem[]): void {
  const box = $("space-filters");
  if (filtersOf === space) {
    for (const f of SPACE_FIELDS[space]) $<HTMLSelectElement>(`filter-${f.key}`).value = state!.filters[f.key];
    return;
  }
  filtersOf = space;
  box.replaceChildren();
  for (const f of SPACE_FIELDS[space]) {
    const id = `filter-${f.key}`;
    const label = el("label", f.label);
    label.htmlFor = id;
    // a label and its select wrap together on a narrow screen
    const pair = el("span", "", "filter");
    const select = el("select");
    select.id = id;
    select.add(new Option("All", ALL));
    for (const v of fieldValues(problems, f)) select.add(new Option(f.option(v), v));
    select.value = state!.filters[f.key];
    select.addEventListener("change", () => {
      void show({ space, filters: { ...state!.filters, [f.key]: select.value } });
    });
    pair.append(label, select);
    box.append(pair);
  }
}

/** A header cell with a second, smaller line saying what the column holds. */
function th(text: string, sub = ""): HTMLTableCellElement {
  const cell = el("th", text);
  cell.scope = "col";
  if (sub) cell.append(el("span", sub, "th-sub"));
  return cell;
}

function renderTable(space: SpaceName, problems: ListedProblem[]): void {
  const filters = state!.filters;
  const fields = shownFields(space, filters);
  const rows = filterProblems(space, problems, filters);
  const head = el("tr");
  head.append(
    ...fields.map((f) => th(f.label)),
    th("P"),
    th("Certified value", "proven valid by interval arithmetic"),
    th("Status"),
    th("Lower bound"),
    th("Site best", "site entry, checked by the server"),
    th("By"),
    th("Entries"),
    th("Configuration"),
    th("Board"),
  );
  $("space-head").replaceChildren(head);
  $("space-note").textContent = summaryText(rows);
  const tbody = $("space-rows");
  tbody.replaceChildren(
    ...rows.map((p) => {
      const tr = el("tr");
      tr.dataset.id = p.id;
      if (!p.accepts_submissions) tr.className = "closed";
      for (const f of fields) tr.append(el("td", f.cell(fieldOf(p, f))));
      tr.append(el("td", String(p.P), "num"));
      tr.append(el("td", p.certified ? p.certified.display : "—", "num"));
      tr.append(el("td", statusLabel(problemStatus(p)), "state"));
      const bound = el("td", p.bound ? minus(round6(p.bound.value)) : "—", "num");
      if (p.bound?.label) bound.append(el("span", plainBoundLabel(p.bound.label), "cell-why"));
      tr.append(bound);
      const site = el("td", p.site_best ? round6(p.site_best.score) : "—", "num");
      if (siteBelowCertified(p)) site.append(" ", el("span", "below certified", "badge"));
      tr.append(site);
      // a name is only ever inserted as text
      tr.append(el("td", p.site_best ? `${p.site_best.name}, ${day(p.site_best.created_at)}` : "—", "name"));
      const entries = entriesText(p);
      const open = el("td", entries.text);
      if (entries.why) {
        // reasons can be long (a proven optimum cites its proofs), so they open on demand
        const why = el("details", "", "cell-why");
        why.append(el("summary", "Why"), entries.why);
        open.append(why);
      }
      tr.append(open);
      const conf = el("td");
      if (p.certified || p.site_best) {
        const a = link(configUrl(space, p.id), "JSON", ` configuration of ${p.id}`, false);
        a.download = downloadName(p.id);
        conf.append(a);
      } else conf.textContent = "—";
      tr.append(conf);
      const board = el("td");
      if (isBoardSpace(space))
        board.append(link(`/${spaceAddress(space, p.id)}`, "Open on the board", `: ${p.id}`, false));
      tr.append(board);
      return tr;
    }),
  );
}

/** Shows a space's table with the given filters, fetching its records the first time. */
async function show(wish: PageState, focus = false): Promise<void> {
  const info = spaces.find((s) => s.space === wish.space)!;
  state = wish;
  for (const input of $("space-pick").querySelectorAll<HTMLInputElement>("input"))
    input.checked = input.value === wish.space;
  const viewer = safeHref(info.viewer);
  $("space-score").replaceChildren(`Score: ${sentence(info.score)}`);
  if (viewer) $("space-score").append(" ", link(viewer, "Open the viewer", ` of ${nameOf(info)}`, false), ".");
  if (focus) $("records-title").focus();
  let problems = records.get(wish.space);
  if (!problems) {
    $("space-note").textContent = "Loading the records…";
    $("space-filters").replaceChildren();
    filtersOf = null;
    $("space-head").replaceChildren();
    $("space-rows").replaceChildren();
    const data = await api.getSpaceRecords(wish.space);
    // another space was chosen while the answer was on its way; the newer request draws the table
    if (state !== wish) return;
    if (!data) {
      $("space-note").textContent = "The records of this kind could not be loaded.";
      return;
    }
    problems = data.problems;
    records.set(wish.space, problems);
  }
  state = { space: wish.space, filters: settleFilters(wish.space, problems, wish.filters) };
  history.replaceState(history.state, "", `${location.pathname}${location.search}${stateHash(state)}`);
  renderFilters(state.space, problems);
  renderTable(state.space, problems);
}

/** A hash typed by hand or followed from a card's Records link selects what it names. */
function followHash(focus: boolean): void {
  const wish = parseHash(
    location.hash,
    spaces.map((s) => s.space),
  );
  if (wish) void show(wish, focus);
}

/** The families in the order of the dimensions. */
const ORDER: string[] = DIMENSIONS.flatMap((d) => d.families.map((f) => f.space));

/** Position of a space in the table of dimensions; spaces the table does not know come last. */
function order(s: SpaceInfo): number {
  const i = ORDER.indexOf(s.space);
  return i < 0 ? ORDER.length : i;
}

async function start(): Promise<void> {
  const data = await api.getSpaces();
  if (!data) {
    // the dimensions and their kinds are known without the server; the server's cards are not
    renderDimensions([]);
    $("spaces-status").textContent = "The server is not reachable, so the records cannot be shown.";
    return;
  }
  const listed = [...data.spaces].sort((a, b) => order(a) - order(b));
  renderDimensions(listed);
  renderExhibits(data.exhibits);
  // a records table needs the space's filters; a space this page does not know yet gets only its card
  spaces = listed.filter((s) => Object.hasOwn(SPACE_FIELDS, s.space));
  if (!spaces.length) {
    $("spaces-status").textContent = "The server lists no records for these kinds.";
    return;
  }
  renderPicker();
  $("records").hidden = false;
  window.addEventListener("hashchange", () => followHash(true));
  followHash(/^#space=/.test(location.hash));
}

void start();
