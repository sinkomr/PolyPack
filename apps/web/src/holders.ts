import * as api from "./api";
import { el } from "./shapes-ui";

const $ = (id: string) => document.getElementById(id)!;
const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

async function load(): Promise<void> {
  const data = await api.getHolders();
  const tbody = $("rows");
  tbody.replaceChildren();
  if (!data) {
    $("note").textContent = "The server is not reachable.";
    return;
  }
  const { holders } = data;
  const leads = holders.reduce((n, h) => n + h.site_bests, 0);
  const records = holders.reduce((n, h) => n + h.records, 0);
  $("note").textContent = holders.length
    ? `${plural(holders.length, "name leads", "names lead")} ${plural(leads, "problem", "problems")}; ${count(records)} of these ${records === 1 ? "is a record" : "are records"}.`
    : "No entries yet.";
  let place = 0;
  holders.forEach((h, i) => {
    // the server sorts by records, then site bests; names equal in both share a place
    const before = holders[i - 1];
    if (!before || before.records !== h.records || before.site_bests !== h.site_bests) place = i + 1;
    const tr = el("tr");
    tr.append(
      el("td", String(place), "num"),
      // a name is only ever inserted as text
      el("td", h.name, "name"),
      el("td", count(h.records), "num"),
      el("td", count(h.beat_published), "num"),
      el("td", count(h.site_bests), "num"),
      el("td", count(h.pending), "num"),
    );
    tbody.append(tr);
  });
}

load();
