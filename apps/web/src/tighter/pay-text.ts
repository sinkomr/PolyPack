import type { BonusKind, Points } from "./points";
import { FIRST_BONUS, LEAD_BONUS } from "./points";

/**
 * Plain words for what a problem's pay is made of (the board's score box and the Last step's More
 * detail). Pure functions: the numbers come from points.ts and game.ts, nothing here prices a payment.
 */

const grouped = (n: number) => Math.round(n).toLocaleString("en-US");
/** A multiplier to at most two decimals, without trailing zeros past one ("2", "2.1", "1.05"). */
export function factor(x: number): string {
  const t = x.toFixed(2).replace(/0$/, "");
  return t.endsWith(".0") ? t.slice(0, -2) : t;
}
/** Shape weight and cost factor always show one decimal at least ("1.0", "2.1", "0.45"). */
const factorOne = (x: number) => {
  const t = factor(x);
  return t.includes(".") ? t : `${t}.0`;
};

export interface MultiplierParts {
  /** Shape weight w and cost factor k (points.ts). */
  shape: number;
  cost: number;
  /** 2^resets. */
  standing: number;
  /** 1 plus the collections bonus. */
  collections: number;
  /** The product of the finished cycle rules' rewards that apply. */
  rules: number;
}

/** The product the game applies to an improvement: shape and cost are inside the improvement, the rest is the multiplier. */
export const multiplierOf = (m: MultiplierParts): number => m.standing * m.collections * m.rules;

/** "Pays × 1.0 shape × 2.1 cost × 2 standing": shape and cost always, the others only when they are not 1. */
export function multiplierRow(m: MultiplierParts): string {
  const parts = [`× ${factorOne(m.shape)} shape`, `× ${factorOne(m.cost)} cost`];
  if (m.standing !== 1) parts.push(`× ${factor(m.standing)} standing`);
  if (m.collections !== 1) parts.push(`× ${factor(m.collections)} collections`);
  if (m.rules !== 1) parts.push(`× ${factor(m.rules)} rules`);
  return `Pays ${parts.join(" ")}`;
}

/** The longer sentence behind the row, for its tooltip. */
export function multiplierTitle(): string {
  return (
    "What each point of improvement on this problem is worth. Shape is how distinct the pieces and container are, " +
    "cost is how slow one evaluation is next to a typical problem, standing doubles with each reset, " +
    "collections is your collections bonus, and rules are the rewards of the cycle rules you finished."
  );
}

/** The bonus row: what the next payment can add, or that it is spent this cycle. */
export function bonusRow(kind: BonusKind | null, spent: boolean): string {
  if (spent) return "Bonus paid this cycle";
  if (kind === "first") return `${grouped(FIRST_BONUS)} RP bonus for the first record`;
  if (kind === "lead") return `${grouped(LEAD_BONUS)} RP bonus if you take the lead`;
  return "No bonus on this problem";
}

/** What kind of bonus a problem would pay next, from what the board knows about it. */
export function bonusKindOf(p: { hasRecord: boolean }): BonusKind {
  return p.hasRecord ? "lead" : "first";
}

export interface Shares {
  step: number;
  size: number;
  gap: number;
}

/** The share of the improvement that came from each term (fractions that add up to 1), or null when it paid no improvement. */
export function improvementShares(p: Pick<Points, "nibble" | "size" | "gap" | "improvement">): Shares | null {
  if (!(p.improvement > 0)) return null;
  const parts = { step: Math.max(0, p.nibble), size: Math.max(0, p.size), gap: Math.max(0, p.gap) };
  const sum = parts.step + parts.size + parts.gap;
  if (!(sum > 0)) return null;
  return { step: parts.step / sum, size: parts.size / sum, gap: parts.gap / sum };
}

const pct = (x: number) => (x > 0 && x < 0.005 ? "under 1 %" : `${Math.round(x * 100)} %`);

/** "gap 80 %, size 17 %, step 3 %", the largest first. */
export function sharesText(s: Shares): string {
  return (Object.entries(s) as [keyof Shares, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([name, x]) => `${name} ${pct(x)}`)
    .join(", ");
}

/** The sentences of a payment's More detail. */
export function payDetail(
  p: Pick<Points, "nibble" | "size" | "gap" | "improvement" | "bonus" | "bonusRp"> & { multiplier?: number },
): string[] {
  const out: string[] = [];
  const shares = improvementShares(p);
  const bonus =
    p.bonus === "first"
      ? `a ${grouped(p.bonusRp)} RP bonus for the first record`
      : p.bonus === "lead"
        ? `a ${grouped(p.bonusRp)} RP bonus for taking the lead`
        : "";
  if (shares) {
    out.push(`The improvement came from ${sharesText(shares)}.`);
    out.push(
      "Step is the size of this one step as a relative cut. Size is how much smaller the side got. Gap is how much closer the side got to the area bound.",
    );
    if (p.multiplier !== undefined && p.multiplier !== 1)
      out.push(`The improvement was multiplied by ${factor(p.multiplier)}.`);
    if (bonus) out.push(`The payment also included ${bonus}. The bonus is not multiplied.`);
  } else if (bonus) {
    out.push(`This payment is only ${bonus}. The first record pays no improvement.`);
  }
  return out;
}
