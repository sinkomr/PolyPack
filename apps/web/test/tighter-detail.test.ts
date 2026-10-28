import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detailLabel, moreDetail } from "../src/tighter/detail";
import { mechanicsModel } from "../src/tighter/mechanics";
import { renderHow } from "../src/tighter/how";
import { UPGRADES } from "../src/tighter/upgrades";
import { HELP } from "../src/tighter/help";
import { readFileSync } from "node:fs";

/** A just-enough DOM for detail.ts and how.ts (the tests run in Node). */
class Fake {
  children: Fake[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  dataset: Record<string, string> = {};
  className = "";
  id = "";
  type = "";
  open = false;
  isConnected = false;
  parent: Fake | null = null;
  private text = "";
  constructor(readonly tagName: string) {}
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(t: string) {
    this.text = t;
    this.children = [];
  }
  append(...n: Fake[]) {
    for (const c of n) {
      c.parent = this;
      c.setConnected(this.isConnected);
      this.children.push(c);
    }
  }
  replaceChildren(...n: Fake[]) {
    this.children = [];
    this.text = "";
    this.append(...n);
  }
  setConnected(v: boolean) {
    this.isConnected = v;
    this.children.forEach((c) => c.setConnected(v));
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  fire(t: string, e: unknown = { target: this }) {
    this.listeners[t]?.forEach((f) => f(e));
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.fire("close");
  }
  focus() {
    focused = this;
  }
  all(): Fake[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}
let focused: Fake | null = null;
// detail.ts keeps one dialog for the page, so the tests share one body and clear what they add
const body = new Fake("body");
body.isConnected = true;

beforeEach(() => {
  focused = null;
  body.children = body.children.filter((c) => c.tagName === "dialog");
  vi.stubGlobal("document", {
    createElement: (t: string) => new Fake(t),
    body,
    querySelectorAll: () => body.all().filter((n) => n.tagName === "button" && n.className.includes("t-more-detail")),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("renderHow (the More detail content)", () => {
  it("shows the plain paragraphs only, never formulas, variables or the note", () => {
    const box = renderHow({
      text: ["One.", "Two."],
      math: ["<var>x</var> = 1"],
      vars: [["<var>x</var>", "a number"]],
      note: "N.",
    }) as unknown as Fake;
    expect(box.children.map((c) => c.textContent)).toEqual(["One.", "Two."]);
    expect(box.textContent).not.toMatch(/=|a number|N\./);
  });
});

describe("the More detail button", () => {
  const how = { text: "Plain words.", math: ["<var>x</var> = 2"] };
  const dialogOf = () => body.children.find((c) => c.tagName === "dialog")!;

  it("is a named button that says what it explains and that it opens a dialog", () => {
    const b = moreDetail(how, "Sharper clicks") as unknown as Fake;
    expect(b.tagName).toBe("button");
    expect(b.type).toBe("button");
    expect(b.textContent).toBe("More detail");
    expect(b.getAttribute("aria-label")).toBe(detailLabel("Sharper clicks"));
    expect(b.getAttribute("aria-label")).toContain("Sharper clicks");
    expect(b.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("opens a modal with the text and no formulas, named by its heading and with a Close button", () => {
    const b = moreDetail(how, "Sharper clicks") as unknown as Fake;
    body.append(b);
    b.fire("click");
    const d = dialogOf();
    expect(d.open).toBe(true);
    expect(d.getAttribute("aria-labelledby")).toBe("t-detail-heading");
    const all = d.all();
    expect(all.find((n) => n.id === "t-detail-heading")!.textContent).toBe("Sharper clicks");
    expect(d.textContent).toContain("Plain words.");
    expect(d.textContent).not.toContain("= 2");
    expect(all.some((n) => n.tagName === "button" && n.textContent === "Close")).toBe(true);
  });

  it("closes on a press outside the box or on Close, and gives focus back to its button", () => {
    const b = moreDetail(how, "Sharper clicks") as unknown as Fake;
    body.append(b);
    b.fire("click");
    const d = dialogOf();
    d.fire("click", { target: d.children[1] });
    expect(d.open).toBe(true);
    d.fire("click", { target: d });
    expect(d.open).toBe(false);
    expect(focused).toBe(b);
    focused = null;
    b.fire("click");
    d.all()
      .find((n) => n.textContent === "Close")!
      .fire("click");
    expect(d.open).toBe(false);
    expect(focused).toBe(b);
  });

  it("returns focus to the replacement button if a rebuild replaced the opener", () => {
    const b = moreDetail(how, "Sharper clicks") as unknown as Fake;
    body.append(b);
    b.fire("click");
    body.children = body.children.filter((c) => c !== b);
    b.isConnected = false;
    const b2 = moreDetail(how, "Sharper clicks") as unknown as Fake;
    body.append(b2);
    dialogOf().close();
    expect(focused).toBe(b2);
  });
});

describe("the Mechanics page", () => {
  const model = mechanicsModel();
  const entries = model.flatMap((g) => g.entries);

  it("lists every upgrade once, under its shop row, with its exact How", () => {
    for (const u of UPGRADES) {
      const hits = entries.filter((e) => e.id === u.id);
      expect(hits.length, u.id).toBe(1);
      expect(hits[0].hows).toEqual([u.how]);
    }
  });

  it("holds every upgrade's formulas and every help section's formulas", () => {
    const math = entries.flatMap((e) => e.hows.flatMap((h) => h.math ?? []));
    for (const u of UPGRADES) for (const line of u.how.math ?? []) expect(math, u.id).toContain(line);
    for (const [id, h] of Object.entries(HELP))
      for (const how of Array.isArray(h) ? h : [h]) for (const line of how.math ?? []) expect(math, id).toContain(line);
    expect(math.length).toBeGreaterThan(50);
  });
});

describe("the cards and the page", () => {
  const shop = readFileSync(new URL("../src/tighter/shop.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../tighter.html", import.meta.url), "utf8");

  it("render no formulas on a card: the shop and Runs panel never use the full renderer", () => {
    const runs = readFileSync(new URL("../src/tighter/runs-ui.ts", import.meta.url), "utf8");
    expect(shop).not.toMatch(/renderMechanic|\.math\b/);
    expect(runs).not.toMatch(/renderMechanic|\.math\b/);
    expect(shop).toContain("moreDetail(");
  });

  it("has a Mechanics button beside Settings and a labelled dialog with a Close button", () => {
    expect(html).toMatch(/id="t-open-mechanics"[^>]*>Mechanics</);
    expect(html).toMatch(/<dialog id="t-mechanics"[^>]*aria-labelledby="t-mechanics-heading"/);
    expect(html).toMatch(/id="t-mechanics-close"[^>]*aria-label=/);
  });
});
