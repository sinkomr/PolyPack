import * as api from "./api";
import {
  HOLDER_SORT_DEFAULT,
  type PlacedHolder,
  holderHref,
  isHolderSortKey,
  nextHolderSort,
  placeHolders,
  sortHolders,
} from "./holder-model";
import { el } from "./shapes-ui";

const $ = (id: string) => document.getElementById(id)!;
const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** The names in the order of the server, each with its place; empty until the list has arrived. */
let placed: PlacedHolder[] = [];
let sort = HOLDER_SORT_DEFAULT;

function row(h: PlacedHolder): HTMLTableRowElement {
  const tr = el("tr");
  // a name is only ever inserted as text
  const name = el("td", "", "name");
  const link = el("a", h.name);
  link.href = holderHref(h.name);
  name.append(link);
  tr.append(
    el("td", String(h.place), "num"),
    name,
    el("td", count(h.records), "num"),
    el("td", count(h.peak), "num"),
    el("td", count(h.beat_published), "num"),
    el("td", count(h.site_bests), "num"),
    el("td", count(h.pending), "num"),
  );
  return tr;
}

/** The rows in the order of the sort, and the sorted column marked on its heading alone. */
function draw(): void {
  $("rows").replaceChildren(...sortHolders(placed, sort).map(row));
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-sort]")) {
    const th = button.closest("th");
    if (button.dataset.sort === sort.key) th?.setAttribute("aria-sort", sort.descending ? "descending" : "ascending");
    else th?.removeAttribute("aria-sort");
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-sort]")) {
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    if (!isHolderSortKey(key)) return;
    sort = nextHolderSort(sort, key);
    draw();
  });
}

async function load(): Promise<void> {
  const data = await api.getHolders();
  if (!data) {
    placed = [];
    draw();
    $("note").textContent = "The server is not reachable.";
    return;
  }
  const { holders } = data;
  // names at zero stay in the table, at the bottom; the note counts the names that lead something
  const leading = holders.filter((h) => h.site_bests > 0).length;
  const leads = holders.reduce((n, h) => n + h.site_bests, 0);
  const records = holders.reduce((n, h) => n + h.records, 0);
  $("note").textContent = holders.length
    ? `${plural(leading, "name leads", "names lead")} ${plural(leads, "problem", "problems")}; ${count(records)} of these ${records === 1 ? "is a record" : "are records"}.`
    : "No entries yet.";
  // the server sorts by records, then site bests
  placed = placeHolders(holders);
  draw();
}

load();
