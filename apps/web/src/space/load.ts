/**
 * The space API calls of the board: a space's catalogue, one problem with its configurations, and
 * a submission. Answers are read as untrusted input (model.ts readSpaceProblem).
 */
import type {
  SpaceConfig,
  SpaceDomainInfo,
  SpaceName,
  SpaceProblemSummary,
  SpaceRecordsResponse,
  SpacesResponse,
} from "@polypack/spaces";
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

let spacesInfo: Promise<SpacesResponse | null> | null = null;

/**
 * The domain of a space as GET /api/spaces describes it (packages/spaces domain.ts), null for a space whose problems
 * are its records, or "error" when the answer cannot be read (it is asked again next time).
 */
export async function loadSpaceDomain(space: SpaceName): Promise<SpaceDomainInfo | null | "error"> {
  spacesInfo ??= fetch("/api/spaces")
    .then((r) => (r.ok ? (r.json() as Promise<SpacesResponse>) : null))
    .catch(() => null);
  const body = await spacesInfo;
  if (!body || !Array.isArray(body.spaces)) {
    spacesInfo = null;
    return "error";
  }
  const d = body.spaces.find((s) => s?.space === space)?.domain;
  // what the picker needs: an id pattern and fields with values or a range
  if (!d || typeof d.id !== "string" || !Array.isArray(d.fields)) return null;
  const fields = d.fields.filter(
    (f) =>
      typeof f?.key === "string" &&
      typeof f.label === "string" &&
      (Array.isArray(f.values)
        ? f.values.every((v: unknown) => typeof v === "string")
        : Number.isInteger(f.min) && Number.isInteger(f.max) && f.max! - f.min! <= 10000),
  );
  return fields.length === d.fields.length ? { ...d, fields } : null;
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
    units: "diameter",
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
  return { ...submitAnswer(r.status, answer, p.space), status: r.status };
}
