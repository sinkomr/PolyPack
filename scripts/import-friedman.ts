// Imports published values from Erich Friedman's Packing Center into data/sources/friedman.json.
//
// Usage: npx tsx scripts/import-friedman.ts <path to a clone of erich-friedman/erich-friedman.github.io> <access date>
//
// Each page lists "n unit <pieces> packed inside the smallest known <container>" with the
// container radius r or side s. Friedman's units are disks of radius 1 and polygons of side 1; the site's since
// 2026-10-27 are disks of DIAMETER 1 and circle containers scored by their diameter, so a value is converted
// exactly by scripts/units.ts (scoreFactor): disks in a circle unchanged, disks in a polygon halved, polygons in
// a circle doubled, polygons in polygons unchanged. The importer checks the page's own sentence for his units.
// Nothing is guessed: an entry whose number cannot be read is skipped and reported.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LiteratureRecord, RecordStatus, areaLowerBound } from "@polypack/geometry";
import { UNITS_HEADER, friedmanNote, scalePrinted, scoreFactor, sourceTolerance } from "./units";

const [repo, accessed] = process.argv.slice(2);
if (!repo || !/^\d{4}-\d\d-\d\d$/.test(accessed ?? "")) {
  console.error("usage: import-friedman.ts <clone path> <YYYY-MM-DD access date>");
  process.exit(1);
}

const SHAPES: Record<string, { sides: number; unit: RegExp }> = {
  cir: { sides: 0, unit: /unit circles/ },
  tri: { sides: 3, unit: /triangles with side 1|unit triangles/ },
  squ: { sides: 4, unit: /unit squares/ },
  pen: { sides: 5, unit: /unit pentagons/ },
  hex: { sides: 6, unit: /unit hexagons|hexagons with side 1/ },
  oct: { sides: 8, unit: /unit octagons/ },
};

const ENTITIES: Record<string, string> = { "&radic;": "√", "&nbsp;": " ", "&amp;": "&", "&pi;": "π", "&times;": "×", "&minus;": "−", "&ndash;": "–", "&deg;": "°" };
// Accented letters in people's names. Entity names are case-sensitive ("&ouml;" is ö, "&Ouml;" is Ö),
// so these are looked up as written, before the case-insensitive table above.
const LETTERS: Record<string, string> = {
  "&aacute;": "á", "&Aacute;": "Á", "&agrave;": "à", "&acirc;": "â", "&atilde;": "ã", "&auml;": "ä", "&Auml;": "Ä", "&aring;": "å", "&Aring;": "Å",
  "&aelig;": "æ", "&AElig;": "Æ", "&ccedil;": "ç", "&Ccedil;": "Ç", "&eacute;": "é", "&Eacute;": "É", "&egrave;": "è", "&ecirc;": "ê", "&euml;": "ë",
  "&iacute;": "í", "&Iacute;": "Í", "&igrave;": "ì", "&icirc;": "î", "&iuml;": "ï", "&ntilde;": "ñ", "&Ntilde;": "Ñ",
  "&oacute;": "ó", "&Oacute;": "Ó", "&ograve;": "ò", "&ocirc;": "ô", "&otilde;": "õ", "&ouml;": "ö", "&Ouml;": "Ö", "&oslash;": "ø", "&Oslash;": "Ø",
  "&uacute;": "ú", "&Uacute;": "Ú", "&ugrave;": "ù", "&ucirc;": "û", "&uuml;": "ü", "&Uuml;": "Ü", "&yacute;": "ý", "&szlig;": "ß",
};
const clean = (html: string) =>
  html
    .replace(/<sup>(.*?)<\/sup>/gi, "^$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, (e) => LETTERS[e] ?? ENTITIES[e.toLowerCase()] ?? e)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/[ \t]+/g, " ")
    // some pages write "ö" as "o" plus a combining diaeresis; store one form of each name (NFC)
    .normalize("NFC")
    .trim();

/**
 * "Proved by <who> in [<month>] <year>": the year decides between proven and proven_unrefereed.
 * The claim ends at the sentence's full stop, but the full stop after an initial does not end it:
 * "Proved by F. Fodor in 2003." was once read as ending at "F." and stored as best_known.
 */
const PROVED = /\b[Pp]rove[dn] by\b(?:[^.]|(?<=(?<!\p{L})\p{Lu})\.)*?\b(\d{4})\b/u;

/**
 * The pages are UTF-8, and people's names in them carry accents. A page is read as UTF-8 strictly;
 * only bytes that are not valid UTF-8 fall back to windows-1252, the usual encoding of older pages.
 * [Every page was once read as latin1, which stored "Östergård" and "Adrián" as mojibake.]
 */
const decode = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
};

const records: LiteratureRecord[] = [];
const skipped: string[] = [];

for (const [a, piece] of Object.entries(SHAPES)) {
  for (const [b, container] of Object.entries(SHAPES)) {
    const dir = `${a}in${b}`;
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(resolve(repo, "packing", dir, "index.html"));
    } catch {
      continue;
    }
    const html = decode(bytes);
    const url = `https://erich-friedman.github.io/packing/${dir}/`;
    const intro = clean(/The following[\s\S]*?(?=<p>|<hr>)/i.exec(html)?.[0] ?? "");
    const symbol = container.sides === 0 ? "r" : "s";
    const measure = container.sides === 0 ? /radius r/ : /side(?: length)? s/;
    if (!piece.unit.test(intro) || !measure.test(intro)) {
      skipped.push(`${dir}: page skipped, units sentence not recognised: "${intro.slice(0, 120)}"`);
      continue;
    }
    const title = clean(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? dir);

    for (const chunk of html.split(/<table/i).slice(1)) {
      const table = chunk.split(/<\/table/i)[0];
      // label: "<font size=+3>7." (or a range "2.-4."), with the picture that follows it
      const labels = [...table.matchAll(/<font size=\+3>\s*(\d+)(?:\.?\s*-\s*(\d+))?\.(?:\s|<br>|<\/font>)*(?:<img[^>]*src="([^"]+)"[^>]*>)?/gi)];
      // every large-font heading must have been understood as a label, or captions would shift
      const headings = table.match(/<font size=\+3>/gi)?.length ?? 0;
      if (headings !== labels.length) {
        skipped.push(`${dir}: a table with ${headings} headings, of which only ${labels.length} could be read as n`);
        continue;
      }
      if (!labels.length) continue;
      const hasValue = new RegExp(`(^|\\n)\\s*${symbol}\\s*=`);
      // Three layouts occur. The caption sits under its picture (with or without a font tag), or
      // all captions of a row sit in a second row of cells, in the same order as the pictures.
      const inline = labels.map((l, i) => clean(table.slice(l.index! + l[0].length, labels[i + 1]?.index ?? table.length)));
      let cells: string[];
      if (inline.every((t) => hasValue.test(t))) {
        cells = inline;
      } else {
        // second-row layout; blocks without "r =" or "s =" are footnotes, not captions
        cells = [...table.matchAll(/<font size=\+1>([\s\S]*?)(?=<td|<font size=\+3>|<\/tr|$)/gi)]
          .map((m) => clean(m[1]))
          .filter((t) => hasValue.test(t));
      }
      if (labels.length !== cells.length) {
        skipped.push(`${dir}: n = ${labels.map((l) => l[1]).join(", ")}: ${labels.length} pictures but ${cells.length} captions`);
        continue;
      }
      labels.forEach((label, i) => {
        const from = Number(label[1]);
        const to = label[2] ? Number(label[2]) : from;
        const text = cells[i];
        // some captions give a closed form on one line and the decimal on the next; take the last
        // line that ends in a number. "+" marks a truncated value; a trailing "*" is a footnote mark.
        const valueRe = /=\s*(\d*\.\d+|\d+)(\+?)(?:\^?\*)?\s*$/;
        const line = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => new RegExp(`^${symbol}\\s*=`).test(l) && valueRe.test(l))
          .pop();
        const m = line ? valueRe.exec(line) : null;
        if (!line || !m) {
          skipped.push(`${dir}: n = ${from}${to !== from ? "-" + to : ""}: no readable value in "${text.replace(/\n/g, " | ").slice(0, 90)}"`);
          return;
        }
        const digits = m[1].startsWith(".") ? "0" + m[1] : m[1];
        const truncated = m[2] === "+";
        const decimals = digits.includes(".") ? digits.split(".")[1].length : 0;
        const rest = text.replace(/\n/g, " ");
        let status: RecordStatus = "best_known";
        let note: string | undefined;
        const proved = PROVED.exec(rest);
        if (/\bTrivial\b/i.test(rest)) status = "proven";
        else if (proved) {
          // Friedman does not say whether a proof is refereed; recent ones are flagged for caution.
          status = Number(proved[1]) >= 2023 ? "proven_unrefereed" : "proven";
          if (status === "proven_unrefereed") note = "Recent proof; whether it has been peer reviewed was not checked.";
        } else if (/\bprove[dn]\b/i.test(rest)) {
          // a proof claim must never be dropped silently ("Improved" does not match: \b before "prove")
          skipped.push(`${dir}: n = ${from}${to !== from ? "-" + to : ""}: proof claim not understood, entry kept as best_known: "${rest.slice(0, 90)}"`);
        }
        for (let P = from; P <= to; P++) {
          const factor = scoreFactor(piece.sides, container.sides);
          const value = Number(digits) * factor;
          if (value < areaLowerBound(piece.sides, container.sides, P) - sourceTolerance(piece.sides, container.sides, decimals)) {
            skipped.push(`${dir}: n = ${P}: value ${digits} is below the area bound, so the page was misread`);
            continue;
          }
          // an exact value with no "+" (such as "r = 3") is trusted to double precision
          const printed = scalePrinted(digits + (truncated ? "+" : ""), truncated || decimals > 0 ? decimals : 12, factor);
          records.push({
            N: piece.sides,
            M: container.sides,
            P,
            value,
            display: printed.display,
            display_precision: printed.precision,
            status,
            source_name: `Erich Friedman, Packing Center: ${title}`,
            source_url: url,
            ...(label[3] ? { picture_url: url + label[3] } : {}),
            accessed,
            citation: text.replace(/\n/g, " ").replace(/\s+/g, " "),
            conversion_note: friedmanNote(piece.sides, container.sides) + (truncated ? " The source prints a truncated decimal (marked +), stored as printed." : ""),
            ...(note ? { note } : {}),
          });
        }
      });
    }
  }
}

records.sort((x, y) => x.N - y.N || x.M - y.M || x.P - y.P);
writeFileSync("data/sources/friedman.json", JSON.stringify({ ...UNITS_HEADER, records, skipped }, null, 1) + "\n");
const by: Record<string, number> = {};
for (const r of records) by[`${r.N}in${r.M}`] = (by[`${r.N}in${r.M}`] ?? 0) + 1;
console.log(`${records.length} records`, by);
console.log(`${skipped.length} skipped:\n` + skipped.join("\n"));
