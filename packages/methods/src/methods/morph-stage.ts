/**
 * The pieces of a shape continuation (docs/methods/dimensions/morph.md): its schedule of shapes,
 * and the homothety that carries an arrangement to the first contact of a new shape.
 */
import type { KernelState, SpaceKernel } from "../kernel";

/** Energy at or below which a state counts as free of overlap (relax's default target). */
const CLEAR = 1e-20;
/** Homothety factors tried while bracketing first contact, and bisection steps after it (relative precision 2^-20 of the bracket). */
const BRACKET_TRIES = 24;
const BISECTIONS = 20;

/**
 * Base stages t_j = t0 + (1 - t0) (j / (stages - 1))^spacing, j = 0 ... stages - 1, from t0 to
 * exactly 1: the last stage is the true shape, written literally so that rounding cannot leave
 * the last stage slightly soft.
 */
export function morphSchedule(t0: number, stages: number, spacing: number): number[] {
  const out = Array.from({ length: stages }, (_, j) => t0 + (1 - t0) * (j / (stages - 1)) ** spacing);
  out[stages - 1] = 1;
  return out;
}

/**
 * Scales the arrangement about the container (setSize keeps the normalized arrangement) to the
 * first contact of its current shape: apart when its pieces overlap, together when none touch.
 * The kernel's energy is zero exactly when the state is free of overlap by its model, and growing
 * a free state keeps it free (the kernel rule), so a bisection between an overlapping and a free
 * size finds the contact. A state that no factor up to 1.25^24 (about 200) frees, such as one
 * with coincident pieces, is left unchanged for the local solve. About 25 to 45 energy evaluations.
 */
export function toContact(k: SpaceKernel, s: KernelState): void {
  const size0 = s.size;
  const at = (size: number) => {
    k.setSize(s, size);
    return k.energy(s);
  };
  // `free` is a size without overlap, `tight` one with
  let free = NaN;
  let tight = NaN;
  if (k.energy(s) > CLEAR) {
    tight = size0;
    for (let i = 1; i <= BRACKET_TRIES && Number.isNaN(free); i++) {
      const size = size0 * 1.25 ** i;
      if (at(size) <= CLEAR) free = size;
      else tight = size;
    }
  } else {
    free = size0;
    for (let i = 1; i <= BRACKET_TRIES && Number.isNaN(tight); i++) {
      const size = size0 * 0.8 ** i;
      if (at(size) > CLEAR) tight = size;
      else free = size;
    }
  }
  if (Number.isNaN(free) || Number.isNaN(tight)) {
    k.setSize(s, Number.isNaN(free) ? size0 : free);
    return;
  }
  for (let i = 0; i < BISECTIONS; i++) {
    const mid = (free + tight) / 2;
    if (at(mid) <= CLEAR) free = mid;
    else tight = mid;
  }
  k.setSize(s, free);
}
