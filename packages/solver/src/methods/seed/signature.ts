import type { PackingConfig } from "@polypack/geometry";
import type { MethodContext } from "../../framework";

/** Rigid motions preserve the score and multiset of pairwise centre distances. */
export async function congruenceSignature(
  ctx: MethodContext,
  config: PackingConfig,
  score: number,
): Promise<string | undefined> {
  const distances: number[] = [];
  let scanned = 0;
  for (let i = 0; i < config.P; i++) {
    for (let j = 0; j < i; j++) {
      if (scanned++ % 1024 === 0 && !(await ctx.checkpoint())) return undefined;
      const a = config.pieces[i];
      const b = config.pieces[j];
      distances.push(Math.round(Math.hypot(a.x - b.x, a.y - b.y) / 1e-7));
    }
  }
  distances.sort((a, b) => a - b);
  // Two hashes keep large-P signatures compact without keeping 125,000 numbers
  // for every pool member. This is a practical congruence filter, not a proof
  // against homometric point sets or hash collisions.
  let first = 2166136261;
  let second = 5381;
  for (const value of distances) {
    first = Math.imul(first ^ value, 16777619);
    first = Math.imul(first ^ Math.floor(value / 4294967296), 16777619);
    second = Math.imul(second ^ value, 65599);
    second = Math.imul(second ^ Math.floor(value / 4294967296), 65599);
  }
  return `${Math.round(score / 1e-7)}:${first >>> 0}:${second >>> 0}`;
}
