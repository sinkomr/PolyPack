/**
 * The names entries may not carry, from native/server/data/names.json (its "about" says where each list comes from).
 * name_filter.rs is the same in the Rust server; both read the same file, in the same steps:
 *
 * 1. The name in compatibility form (NFKC), so that full-width and styled letters are plain ones.
 * 2. A run of digits or of the symbols @ $ ! between two ASCII letters stands for letters: 0 o, 1 i, 3 e, 4 a, 5 s,
 *    7 t, @ a, $ s, ! i (n1gger, a55hole). Anywhere else a digit stays a digit (TighterGamePlayer2717975).
 * 3. Words: a break wherever a lowercase ASCII letter is followed by an uppercase one (CockNballz), then the ASCII
 *    letters in lowercase, split at every other character. An entry of `words` or `more_words` that is not in
 *    `not_words`, made into words the same way, is refused when its words appear consecutively among the name's. An
 *    entry with no ASCII letter (an emoji) is refused wherever it appears in the name of step 1.
 * 4. Within: the ASCII letters of step 2 alone, in lowercase; an entry of `within` is refused wherever it appears in
 *    them (NIGGERKILLER, F.U.C.K).
 * 5. Removed: a name whose SHA-256 is in `removed` is refused as it is.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The name the store gives the entries of a removed name. */
export const ANONYMOUS = "Anonymous";

/** What a refused name is told; the same in both servers. */
export const NAME_REFUSED = "this name is not accepted here: choose another name";

interface NamesFile {
  words: string[];
  not_words: string[];
  more_words: string[];
  within: string[];
  removed: string[];
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

/** Step 2. */
function deleet(s: string): string {
  return s.replace(/(?<=[A-Za-z])[0-9@$!]+(?=[A-Za-z])/g, (run) => [...run].map((c) => LEET[c] ?? c).join(""));
}

/** Step 3, of a name already through steps 1 and 2. */
function words(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .split(/[^a-z]+/)
    .filter((w) => w !== "");
}

/** Step 4, of a name already through steps 1 and 2. */
function letters(s: string): string {
  return s.replace(/[^A-Za-z]/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** SHA-256 of a name's UTF-8 bytes, in hex. */
export function nameHash(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex");
}

/** The lists of names.json, ready to match against. */
export class NameFilter {
  private readonly phrases: string[][] = [];
  private readonly symbols: string[] = [];
  private readonly within: string[];
  private readonly removed: Set<string>;

  constructor(file: NamesFile) {
    const left = new Set(file.not_words);
    for (const entry of [...file.words, ...file.more_words]) {
      if (left.has(entry)) continue;
      const form = entry.normalize("NFKC");
      const w = words(deleet(form));
      if (w.length) this.phrases.push(w);
      else this.symbols.push(form);
    }
    this.within = file.within;
    this.removed = new Set(file.removed);
  }

  /** Whether a name (as stored: through sanitizeText) is one of the removed names. */
  isRemoved(name: string): boolean {
    return this.removed.has(nameHash(name));
  }

  /** Whether entries may not carry `name` (as stored: through sanitizeText). */
  refuses(name: string): boolean {
    if (this.isRemoved(name)) return true;
    const form = name.normalize("NFKC");
    if (this.symbols.some((s) => form.includes(s))) return true;
    const plain = deleet(form);
    const squashed = letters(plain);
    if (this.within.some((w) => squashed.includes(w))) return true;
    const w = words(plain);
    return this.phrases.some((p) => {
      for (let i = 0; i + p.length <= w.length; i++) if (p.every((x, j) => w[i + j] === x)) return true;
      return false;
    });
  }
}

let shared: NameFilter | undefined;

/** The filter of native/server/data/names.json, read once. */
export function nameFilter(): NameFilter {
  shared ??= new NameFilter(
    JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../native/server/data/names.json"), "utf8")) as NamesFile,
  );
  return shared;
}
