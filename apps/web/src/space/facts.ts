/**
 * The values shown beside a space problem's drawing, in the dimensions page's words (spaces-model.ts):
 * "Certified value", "Status", "Lower bound", "Site best", "Entries", and for 3D on 4D "Without
 * folding" and "Folding gains". Pure and light, so that the board's space mode and the 3D on 4D
 * viewer show the same rows.
 */
import type { CertifiedStatus, SpaceName } from "@polypack/spaces";
import { type FoldExtra, foldGain, gainText, plainNofoldLabel } from "../boundary-model";
import { day, entriesText, plainBoundLabel, problemStatus, round6, statusLabel } from "../spaces-model";

/** One row of the values. A `details` note is long (a proof, a derivation): it opens on demand. */
export interface ProblemFact {
  label: string;
  value: string;
  note?: string;
  details?: boolean;
}

/** What the rows are read from: a problem as the server sends it, checked (model.ts LoadedSpaceProblem). */
export interface FactSource {
  space: SpaceName;
  certified: { score: number; display: string; status: CertifiedStatus } | null;
  status: CertifiedStatus | null;
  bound: { value: number; label: string } | null;
  site_best: { id: number; score: number; name: string; created_at: string } | null;
  /** The smaller of the certified value and the site best. */
  best_score: number | null;
  accepts_submissions: boolean;
  closed_reason: string | null;
  extra: FoldExtra | null;
}

/**
 * The rows of the values. A closed problem's reason is a long note. 3D on 4D adds the best edge
 * without folding (with how it is derived) and how much shorter the problem's best edge is.
 */
export function problemFacts(p: FactSource): ProblemFact[] {
  const entries = entriesText(p);
  const fold: ProblemFact[] = [];
  if (p.space === "boundary") {
    const nofold = p.extra?.nofold ?? null;
    fold.push(
      {
        label: "Without folding",
        value: nofold ? round6(nofold.value) : "—",
        ...(nofold?.label ? { note: plainNofoldLabel(nofold.label), details: true } : {}),
      },
      {
        label: "Folding gains",
        value: gainText(foldGain(p.best_score, nofold?.value)),
        ...(nofold && p.best_score !== null ? { note: "shorter edge than without folding" } : {}),
      },
    );
  }
  return [
    { label: "Certified value", value: p.certified ? p.certified.display : "—" },
    { label: "Status", value: statusLabel(problemStatus({ ...p, status: p.status ?? undefined })) },
    {
      label: "Lower bound",
      value: p.bound ? round6(p.bound.value).replace(/^-/, "−") : "—",
      ...(p.bound?.label ? { note: plainBoundLabel(p.bound.label) } : {}),
    },
    ...fold,
    {
      label: "Site best",
      value: p.site_best ? round6(p.site_best.score) : "—",
      ...(p.site_best ? { note: `${p.site_best.name}, ${day(p.site_best.created_at)}` } : {}),
    },
    { label: "Entries", value: entries.text, ...(entries.why ? { note: entries.why, details: true } : {}) },
  ];
}
