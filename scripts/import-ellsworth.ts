// Imports squares-in-squares values from David Ellsworth's page (the continuation of Friedman's)
// into data/sources/ellsworth.json.
//
// Usage: npx tsx scripts/import-ellsworth.ts <saved copy of squares_in_squares.html> <access date>
//   page: https://kingbird.myphotos.cc/packing/squares_in_squares.html
//
// The page shows n unit squares in the smallest known square of side s: the site's units.
import { readFileSync, writeFileSync } from "node:fs";
import { LiteratureRecord, RecordStatus } from "@polypack/geometry";

const [file, accessed] = process.argv.slice(2);
if (!file || !/^\d{4}-\d\d-\d\d$/.test(accessed ?? "")) {
  console.error("usage: import-ellsworth.ts <page.html> <YYYY-MM-DD access date>");
  process.exit(1);
}
const PAGE = "https://kingbird.myphotos.cc/packing/squares_in_squares.html";
const BASE = "https://kingbird.myphotos.cc/packing/";
/** The page states that the trivial packing is the best known for every n up to this not pictured. */
const TRIVIAL_LIMIT = 324;
const MAX_P = 500;

const html = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
if (!/n\$ unit squares packed inside the smallest known square \(of side length \$s\$\)/.test(html)) {
  throw new Error("units sentence not found; the page layout has changed");
}
if (!new RegExp(`For the \\$n ≤ ${TRIVIAL_LIMIT}\\$ not pictured, the trivial packing`).test(html)) {
  throw new Error("statement about unpictured n not found; the page has changed");
}
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const records = new Map<number, LiteratureRecord>();
const skipped: string[] = [];
/** Every n that has a picture, read or not; these never get the trivial value filled in. */
const pictured = new Set<number>();
const boxes = html.matchAll(/<div class="box"><font size="\+3">([\s\S]*?)<br>[\s\S]*?src="([^"]+)"[\s\S]*?<font size="\+1">([\s\S]*?)<\/font><\/div><\/div>/g);
for (const [, label, picture, captionHtml] of boxes) {
  const ns = label.split(",").map((t) => Number(t.trim()));
  if (ns.some((n) => !Number.isInteger(n) || n < 1)) {
    skipped.push(`label "${label}" not understood`);
    continue;
  }
  for (const n of ns) pictured.add(n);
  // decimal values are written as \Nn{...} or "$s = 8.79...$"; integers as "$s = 3$"
  const decimal = /\\Nn\{(\d+\.\d+)\}/.exec(captionHtml) ?? /\$s = (\d+\.\d+)\$/.exec(captionHtml);
  const integer = /\$s = (\d+)\$/.exec(captionHtml);
  const digits = decimal?.[1] ?? integer?.[1];
  if (!digits) {
    skipped.push(`n = ${label}: no readable value`);
    continue;
  }
  const caption = text(captionHtml.replace(/\$[^$]*\$/g, (m) => (m.includes("Nn{") || /^\$s = [\d.]+\$$/.test(m) ? `s = ${digits}` : " ")));
  let status: RecordStatus = "best_known";
  let note: string | undefined;
  // The full stop after an initial ("Proved by F. Fodor in 2003.") does not end the claim; see import-friedman.ts.
  const proved = /\bProved by\b(?:[^.]|(?<=(?<!\p{L})\p{Lu})\.)*?\b(\d{4})\b/u.exec(caption);
  if (/\bTrivial\b/.test(caption)) status = "proven";
  else if (proved) {
    status = Number(proved[1]) >= 2023 ? "proven_unrefereed" : "proven";
    if (status === "proven_unrefereed") note = "Recent proof; whether it has been peer reviewed was not checked.";
  } else if (/\bprove[dn]\b/i.test(caption)) {
    // a proof claim must never be dropped silently
    skipped.push(`n = ${label}: proof claim not understood, entry kept as best_known: "${caption.slice(0, 90)}"`);
  }
  if (ns.length > 1) {
    note = [note, `The source gives one picture and caption for n = ${label.trim()}; the smaller n is the picture with a square removed.`]
      .filter(Boolean)
      .join(" ");
  }
  for (const P of ns) {
    if (P > MAX_P) continue;
    records.set(P, {
      N: 4,
      M: 4,
      P,
      value: Number(digits),
      display: digits,
      display_precision: decimal ? digits.split(".")[1].length : 12,
      status,
      source_name: "David Ellsworth, Squares in Squares (continuing Erich Friedman's page)",
      source_url: PAGE,
      picture_url: BASE + picture,
      accessed,
      citation: caption,
      conversion_note: "None needed: the source uses the container side s for unit squares, as this site does.",
      ...(note ? { note } : {}),
    });
  }
}
for (let P = 1; P <= Math.min(TRIVIAL_LIMIT, MAX_P); P++) {
  if (pictured.has(P)) continue;
  const k = Math.ceil(Math.sqrt(P));
  records.set(P, {
    N: 4,
    M: 4,
    P,
    value: k,
    display: String(k),
    display_precision: 12,
    status: "best_known",
    source_name: "David Ellsworth, Squares in Squares (continuing Erich Friedman's page)",
    source_url: PAGE,
    accessed,
    citation: `"For the n ≤ ${TRIVIAL_LIMIT} not pictured, the trivial packing (with no tilted squares) is the best known packing."`,
    conversion_note: `The source does not print a value for this n. s = ceil(sqrt(n)) = ${k} follows from its statement about the trivial packing.`,
  });
}
const out = [...records.values()].sort((a, b) => a.P - b.P);
writeFileSync("data/sources/ellsworth.json", JSON.stringify({ records: out, skipped }, null, 1) + "\n");
console.log(`${out.length} records; skipped: ${JSON.stringify(skipped)}`);
