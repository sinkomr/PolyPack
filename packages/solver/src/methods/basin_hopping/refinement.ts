import { enclose, MAX_COORD, type PackingConfig } from "@polypack/geometry";
import type { MethodContext } from "../../framework";
import { lbfgs } from "../penalty/lbfgs";
import { createPenaltyObjective, packState, unpackState } from "../penalty/objective";
import { restore } from "../penalty/restoration";

/** Near wall alignment, tiny angular errors can converge much more slowly than
 * translations. Try a restricted penalty solve, retaining the unrestricted best.
 * No packing template or published score is used. */
export async function refineAligned(ctx: MethodContext, start: PackingConfig, tolerance: number): Promise<void> {
  if (start.N === 0 || start.M === 0 || tolerance === 0 || ctx.shouldStop()) return;
  const container = enclose(start.N, start.pieces, start.M, start.container_phi);
  const period = (2 * Math.PI) / start.N;
  const c = Math.cos(container.phi);
  const s = Math.sin(container.phi);
  const pieces = start.pieces.map((p) => {
    const theta = p.theta - container.phi;
    let target = theta;
    let error = Infinity;
    for (let j = 0; j < start.M; j++) {
      // Piece face and vertex normals aligned with each container wall normal.
      for (const phase of [-Math.PI - Math.PI / start.N, -Math.PI]) {
        const base = phase + (2 * Math.PI * j) / start.M;
        const aligned = base + Math.round((theta - base) / period) * period;
        if (Math.abs(theta - aligned) < error) {
          error = Math.abs(theta - aligned);
          target = aligned;
        }
      }
    }
    const dx = p.x - container.cx;
    const dy = p.y - container.cy;
    return { x: c * dx + s * dy, y: -s * dx + c * dy, theta: target, error };
  });
  if (pieces.some((p) => p.error > tolerance || Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD)) return;
  const template: PackingConfig = {
    ...start,
    container_phi: 0,
    pieces: pieces.map(({ error: _error, ...pose }) => pose),
  };
  let x = packState({ config: template, container: enclose(start.N, template.pieces, start.M, 0) });
  const multipliers = new Map<number, number>();
  let weight = 100;
  const submit = async (values: readonly number[]) => {
    if (ctx.shouldStop()) return false;
    const config = restore(unpackState(template, values).config, "separate", ctx.shouldStop, ctx.random);
    return !!config && (await ctx.evaluate(config, { autoOrient: false })) !== undefined;
  };
  for (let outer = 0; outer < 20; outer++) {
    if (ctx.shouldStop() || !(await ctx.checkpoint())) return;
    const objective = createPenaltyObjective(template, weight, multipliers, true, ctx.shouldStop, true);
    const restricted = (values: readonly number[]) => {
      const result = objective.evaluate(values);
      for (let i = 0; i < start.P; i++) result.gradient[3 * i + 2] = 0;
      result.gradient[result.gradient.length - 1] = 0;
      return result;
    };
    const result = await lbfgs(restricted, x, {
      iterations: 200,
      memory: 12,
      tolerance: 1e-11,
      shouldStop: ctx.shouldStop,
      checkpoint: ctx.checkpoint,
      onIteration: submit,
    });
    if (result.status === "stopped" || result.status === "nonfinite") return;
    x = result.x;
    if (!(await submit(x))) return;
    objective.updateMultipliers(x);
    weight = Math.min(1e10, weight * 4);
  }
}
