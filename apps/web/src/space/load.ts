/**
 * The space API calls of the board: a space's catalogue, one problem with its configurations, and
 * a submission. Answers are read as untrusted input (model.ts readSpaceProblem).
 */
import type { SpaceConfig, SpaceName, SpaceProblemSummary, SpaceRecordsResponse } from "@polypack/spaces";
import { configUrl } from "../spaces-model";
import { type LoadedSpaceProblem, type SubmitAnswer, readSpaceProblem, submitAnswer } from "./model";

/** The problems of a space as GET /api/spaces/:space/records lists them, or null when they cannot be read. */
export async function listSpaceProblems(space: SpaceName): Promise<SpaceProblemSummary[] | null> {
  try {
    const r = await fetch(`/api/spaces/${encodeURIComponent(space)}/records`);
    if (!r.ok) return null;
    const body = (await r.json()) as SpaceRecordsResponse;
    return Array.isArray(body?.problems) ? body.problems.filter((p) => typeof p?.id === "string") : null;
  } catch {
    return null;
  }
}

/** One problem with its best configuration, or a sentence saying why it could not be loaded. */
export async function loadSpaceProblem(space: SpaceName, id: string): Promise<LoadedSpaceProblem | string> {
  let r: Response;
  try {
    r = await fetch(configUrl(space, id));
  } catch {
    return "The server is not reachable.";
  }
  if (r.status === 404) return `${id} is not in the catalogue of this kind.`;
  if (!r.ok) return `The server answered ${r.status}.`;
  try {
    return readSpaceProblem(space, id, await r.json());
  } catch {
    return "The server's answer is not JSON.";
  }
}

export interface SpaceSubmitFields {
  name: string;
  /** The submitter's own note, sent as agent_note. */
  note?: string;
  /** The search that found it, free text (at most 80 characters). */
  method?: string;
  seed?: number;
  /** The program that ran the search (at most 80 characters). */
  software?: string;
}

/** POST /api/spaces/submit, and what its answer means. */
export async function submitSpaceConfig(
  p: Pick<LoadedSpaceProblem, "space" | "id">,
  config: SpaceConfig,
  fields: SpaceSubmitFields,
): Promise<SubmitAnswer & { status: number | null }> {
  const body = {
    space: p.space,
    id: p.id,
    config,
    name: fields.name,
    ...(fields.note ? { agent_note: fields.note } : {}),
    ...(fields.software ? { software: fields.software } : {}),
    ...(fields.method ? { method: fields.method } : {}),
    ...(fields.seed !== undefined && Number.isSafeInteger(fields.seed) && fields.seed >= 0
      ? { seed: fields.seed }
      : {}),
  };
  let r: Response;
  try {
    r = await fetch("/api/spaces/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ...submitAnswer(null, null), status: null };
  }
  let answer: unknown = null;
  try {
    answer = await r.json();
  } catch {
    // an answer without JSON is described by its status
  }
  return { ...submitAnswer(r.status, answer), status: r.status };
}
