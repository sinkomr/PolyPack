import * as api from "./api";
import { REFRESH_MINUTES, holderHref, holderTotals, pRanges, pairHref, timeOfDay } from "./holder-model";
import { el, familyName } from "./shapes-ui";

const $ = (id: string) => document.getElementById(id)!;
const count = (n: number) => n.toLocaleString("en-US");

/** A message in place of the table; the name, if any, is only ever set as text. */
function say(text: string, link?: { text: string; href: string }): void {
  const note = $("note");
  note.textContent = text;
  if (link) {
    const a = el("a", link.text);
    a.href = link.href;
    note.append(" ", a);
  }
  $("asof").hidden = true;
  $("results").hidden = true;
}

async function load(): Promise<void> {
  const name = new URLSearchParams(location.search).get("name");
  if (!name) {
    say("No name given. Choose one on the", { text: "record holders page.", href: "/holders.html" });
    return;
  }
  // a name is only ever inserted as text
  $("title").textContent = `Records held by ${name}`;
  document.title = `PolyPack — Records held by ${name}`;
  const data = await api.getHolder(name);
  if (!data) return say("The server is not reachable.");
  if (data === "refused") return say("The server does not take this as a name.");
  if (data.site_bests === 0)
    return say(
      "This name leads no problem at the moment. Names are matched exactly, capitals included, and problems with a proven optimum are left out. See the",
      { text: "record holders.", href: "/holders.html" },
    );
  $("note").textContent = `${name} ${holderTotals(data, data.pairs.length)}`;
  const time = timeOfDay(data.computed_at);
  const asof = $("asof");
  asof.hidden = time === null;
  if (time !== null) asof.textContent = `As of ${time}. This list refreshes at most every ${REFRESH_MINUTES} minutes.`;
  // one fragment for any number of pairs, which is added to the page once
  const rows = document.createDocumentFragment();
  for (const p of data.pairs) {
    const tr = el("tr");
    const pair = el("td", "", "name");
    const link = el("a", familyName(p.N, p.M));
    link.href = pairHref(p.N, p.M);
    pair.append(link);
    tr.append(
      pair,
      el("td", count(p.P.length), "num"),
      el("td", count(p.records), "num"),
      el("td", count(p.beat_published), "num"),
      el("td", count(p.pending), "num"),
      el("td", pRanges(p.P), "ranges"),
    );
    rows.append(tr);
  }
  $("rows").replaceChildren(rows);
  $("results").hidden = false;
}

void load();
