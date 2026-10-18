import type { Container, PackingConfig } from "@polypack/geometry";
import type { Budget, MethodDefinition, Problem, ProgressFrame, Result, SketchFrame } from "@polypack/solver";

export type SolveMethod = Omit<MethodDefinition, "execute">;

export type SolveRequest =
  | {
      type: "run";
      id: number;
      problem: Problem;
      method: string;
      params: Record<string, unknown>;
      budget: Budget;
      seed: number;
      start?: PackingConfig;
    }
  | { type: "pause" | "resume" | "stop"; id: number };

export type SolveResponse =
  | { type: "ready"; methods: SolveMethod[] }
  | { type: "progress"; id: number; frame: ProgressFrame; preview?: PackingConfig; previewContainer?: Container }
  // A method's working state for display only: never scored or accepted, and possibly invalid.
  | { type: "sketch"; id: number; frame: SketchFrame }
  | { type: "control"; id: number; state: "paused" | "running" | "stopping" }
  | { type: "result"; id: number; result: Result }
  | { type: "error"; id: number; message: string };
