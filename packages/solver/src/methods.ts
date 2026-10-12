import type { MethodDefinition } from "./framework";
import { polish } from "./polish";

export const identityMethod: MethodDefinition = {
  name: "identity",
  schema: {
    type: "object",
    title: "Identity",
    description: "Evaluate a starting configuration without searching.",
    properties: {
      iterations: {
        type: "integer",
        minimum: 1,
        default: 1,
        description: "Number of repeated assessments of the start.",
      },
    },
    additionalProperties: false,
  },
  defaults: { iterations: 1 },
  doc: "docs/methods/identity.md",
  async execute(context) {
    if (!context.start) return;
    for (let i = 0; i < (context.params.iterations as number); i++) {
      if (context.shouldStop()) {
        await context.checkpoint();
        break;
      }
      if (!(await context.evaluate(context.start))) break;
    }
  },
};

export const polishMethod: MethodDefinition = {
  name: "polish",
  schema: {
    type: "object",
    title: "Contact polish",
    description: "Tighten a contact graph with float64 SQP and Newton refinement.",
    properties: {
      maxIterations: {
        type: "integer",
        minimum: 0,
        maximum: 300,
        default: 300,
        description: "Maximum outer iterations; convergence or stalled steps stop earlier.",
      },
      contactTolerance: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.05,
        description: "Maximum gap in piece units for selecting near contacts.",
      },
      iterations: {
        type: "integer",
        minimum: 0,
        maximum: 300,
        description: "Legacy iteration cap; use maxIterations in new callers.",
      },
    },
    additionalProperties: false,
  },
  defaults: { maxIterations: 300, contactTolerance: 0.05 },
  doc: "docs/methods/polish.md",
  async execute(context) {
    if (!context.start) return;
    await polish(context.start, {
      maxIterations: context.params.maxIterations as number,
      contactTolerance: context.params.contactTolerance as number,
      shouldStop: context.shouldStop,
      checkpoint: context.checkpoint,
      evaluate: context.evaluate,
      initialEvaluation: context.initialEvaluation,
    });
  },
};
