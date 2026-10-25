import type { SpaceExhibit, SpaceInfo, SpaceName } from "@polypack/spaces";
import * as api from "./api";
import { safeHref } from "./atlas-model";
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

/** Short names for the space picker; the cards use the titles the server gives. */
const SHORT: Record<SpaceName, string> = { surface: "Surfaces", curved: "Curvature", sphere: "Sphere", torus: "Tori" };

/** The spaces with a records table. */
let spaces: SpaceInfo[] = [];
let state: PageState | null = null;
/** Records of each space, fetched once per visit. */
const records = new Map<SpaceName, ListedProblem[]>();

/** A link whose visible text is completed for screen readers ("Viewer" → "Viewer: Flat tori"). */
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

/** One card: title, summary, facts, and links to the viewer and the notes (and the records, for a space). */
function card(
  item: SpaceInfo | SpaceExhibit,
  key: string,
  facts: [string, string | HTMLElement][],
  recordsHref: string | null,
): HTMLLIElement {
  const li = el("li", "", "space-card");
  li.dataset.space = key;
  li.append(el("h4", item.title), el("p", item.summary));
  if (facts.length) {
    const dl = el("dl", "", "space-facts");
    for (const [k, v] of facts) dl.append(el("dt", k), typeof v === "string" ? el("dd", v) : v);
    li.append(dl);
  }
  const links = el("p", "", "space-links");
  if (recordsHref) links.append(link(recordsHref, "Records", `: ${item.title}`, false));
  // a space the board can show opens there, at the problem the board starts that space with
  if (recordsHref && isBoardSpace(key)) links.append(link(`/${spaceAddress(key)}`, "Board", `: ${item.title}`, false));
  // addresses from the server are followed only when they are http(s) or a path of this site
  const viewer = safeHref(item.viewer);
  if (viewer) links.append(link(viewer, "Viewer", `: ${item.title}`, false));
  const docs = safeHref(item.docs);
  if (docs) links.append(link(docs, "Notes", `: ${item.title} (GitHub)`, !docs.startsWith("/")));
  li.append(links);
  return li;
}

function renderCards(list: SpaceInfo[], exhibits: SpaceExhibit[]): void {
  $("space-cards").replaceChildren(
    ...list.map((s) => {
      const id = el("dd");
      id.append(el("code", s.problem_id));
      return card(
        s,
        s.space,
        [
          ["Score", s.score],
          ["Problems", s.problems.toLocaleString("en-US")],
          ["Problem id", id],
        ],
        stateHash({ space: s.space, filters: {} }),
      );
    }),
  );
  $("exhibits").hidden = !exhibits.length;
  $("exhibit-cards").replaceChildren(...exhibits.map((x) => card(x, x.name, [], null)));
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
    label.append(input, el("span", SHORT[s.space] ?? s.title));
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
  if (viewer) $("space-score").append(" ", link(viewer, "Open the viewer", ` of ${info.title}`, false), ".");
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
      $("space-note").textContent = "The records of this space could not be loaded.";
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

async function start(): Promise<void> {
  const data = await api.getSpaces();
  if (!data) {
    $("spaces-status").textContent = "The server is not reachable.";
    return;
  }
  renderCards(data.spaces, data.exhibits);
  // a records table needs the space's filters; a space this page does not know yet gets only its card
  spaces = data.spaces.filter((s) => Object.hasOwn(SPACE_FIELDS, s.space));
  if (!spaces.length) {
    $("spaces-status").textContent = "No spaces are listed.";
    return;
  }
  renderPicker();
  $("records").hidden = false;
  window.addEventListener("hashchange", () => followHash(true));
  followHash(/^#space=/.test(location.hash));
}

void start();
