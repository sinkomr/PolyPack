import { evaluate, type PackingConfig } from "@polypack/geometry";
import { polish, run, seededRandom } from "@polypack/solver";
import { createCheckpoint } from "../packages/solver/src/runtime";

const squares = (expansion: number): PackingConfig => {
  const d = ((1 + Math.SQRT1_2) / 2) * expansion;
  return {
    N: 4,
    M: 4,
    P: 5,
    container_phi: 0,
    pieces: [
      { x: 0, y: 0, theta: 0 },
      ...[
        [-d, -d],
        [d, -d],
        [-d, d],
        [d, d],
      ].map(([x, y]) => ({ x, y, theta: Math.PI / 4 })),
    ],
  };
};
const circles = (expansion: number): PackingConfig => ({
  N: 0,
  M: 0,
  P: 7,
  container_phi: 0,
  pieces: [
    { x: 0, y: 0, theta: 0 },
    ...Array.from({ length: 6 }, (_, k) => ({
      x: 2 * expansion * Math.cos((k * Math.PI) / 3),
      y: 2 * expansion * Math.sin((k * Math.PI) / 3),
      theta: 0,
    })),
  ],
});
const jittered = squares(1.03);
const random = seededRandom(2);
const jitter = () => 0.02 * (random() - 0.5);
jittered.pieces = jittered.pieces.map((p) => ({ x: p.x + jitter(), y: p.y + jitter(), theta: p.theta + jitter() }));
const pair: PackingConfig = {
  N: 0,
  M: 0,
  P: 2,
  container_phi: 0,
  pieces: [
    { x: -5, y: 0, theta: 0 },
    { x: 5, y: 0, theta: 0 },
  ],
};
const knownAnswers = [];
for (const [name, config, target] of [
  ["five squares clean", squares(1.02), 2 + Math.SQRT1_2],
  ["five squares jittered", jittered, 2 + Math.SQRT1_2],
  ["seven circles clean", circles(1.02), 3],
  ["seven circles loose", circles(1.5), 3],
  ["two circles ten apart", pair, 2],
] as const) {
  let evaluations = 0;
  const began = performance.now();
  const best = await polish(config, {
    evaluate: async (candidate, opts) => {
      evaluations++;
      return evaluate(candidate, opts);
    },
  });
  const result = best ? evaluate(best, { autoOrient: true }) : undefined;
  knownAnswers.push({
    name,
    before: evaluate(config, { autoOrient: true }).score,
    after: result?.score,
    valid: result?.valid,
    target,
    error: result?.score === undefined || result.score === null ? null : result.score - target,
    evaluations,
    milliseconds: performance.now() - began,
  });
}
const identityStart: PackingConfig = {
  N: 4,
  M: 4,
  P: 30,
  container_phi: 0.1,
  pieces: Array.from({ length: 30 }, (_, i) => ({ x: 3 * (i % 6), y: 3 * Math.floor(i / 6), theta: 0.2 })),
};
const evals = 1000;
async function directIdentity() {
  const initial = evaluate(identityStart, { autoOrient: true });
  const config = { ...identityStart, container_phi: initial.container!.phi };
  const checkpoint = createCheckpoint();
  for (let i = 1; i < evals; i++) {
    await checkpoint();
    evaluate(config, { autoOrient: true });
  }
  evaluate(config, { autoOrient: true });
}
const timings = async (operation: () => Promise<unknown>) => {
  const began = performance.now();
  await operation();
  return performance.now() - began;
};
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const overhead = [];
for (const [name, direct, framework] of [
  [
    "polish: five squares expanded 1.03",
    () => polish(squares(1.03)),
    () => run(squares(1.03), { method: "polish", start: squares(1.03), budget: { evals: 100000 }, seed: 1 }),
  ],
  [
    "identity: N4 M4 P30, 1000 evaluations",
    directIdentity,
    () =>
      run(identityStart, {
        method: "identity",
        start: identityStart,
        params: { iterations: evals - 1 },
        budget: { evals },
        seed: 1,
        finalPolish: false,
      }),
  ],
] as const) {
  for (let i = 0; i < 4; i++) {
    await direct();
    await framework();
  }
  const directTimes: number[] = [],
    frameworkTimes: number[] = [];
  for (let i = 0; i < 11; i++) {
    if (i % 2) {
      frameworkTimes.push(await timings(framework));
      directTimes.push(await timings(direct));
    } else {
      directTimes.push(await timings(direct));
      frameworkTimes.push(await timings(framework));
    }
  }
  const baseline = median(directTimes),
    wrapped = median(frameworkTimes);
  overhead.push({
    name,
    samples: 11,
    warmups: 4,
    directMilliseconds: baseline,
    frameworkMilliseconds: wrapped,
    overheadPercent: (wrapped / baseline - 1) * 100,
    directSamples: directTimes,
    frameworkSamples: frameworkTimes,
  });
}
const big: PackingConfig = {
  ...identityStart,
  N: 0,
  M: 100,
  pieces: identityStart.pieces.map((p) => ({ ...p, theta: 0 })),
};
const began = performance.now();
evaluate(big, { autoOrient: true });
console.log(
  JSON.stringify(
    {
      node: process.version,
      knownAnswers,
      overhead,
      measurement:
        "Wall-clock medians of 11 alternating-order samples after four paired warmups. Identity baseline is a direct shared-geometry loop with identical start/final orientation scoring and elapsed-time yields, without candidate parsing, tracking, callbacks or automatic polish. Framework identity finalPolish=false isolates plumbing; polish runs its normal framework path. Local Node measurements, not browser benchmarks.",
      atomicScoreMilliseconds: performance.now() - began,
    },
    null,
    2,
  ),
);
