import { SubmitResponse } from "@polypack/geometry";

/** Shown in place of the leaderboard and beside the disabled submit button of a closed problem. */
export const CLOSED_NOTE =
  "This problem is solved: its optimum is proven, so the leaderboard is closed. You can still play it.";

/** What the board says after the server stored a valid submission. */
export function acceptedMessage(r: SubmitResponse): string {
  const score = r.score!.toFixed(6);
  if (r.leader) {
    return (
      `✓ Accepted. Server score ${score}. This is now the best entry for this problem.` +
      (r.pending_verification ? " This beats the published value and is pending verification." : "")
    );
  }
  const best = r.leader_score === null ? "" : ` ${r.leader_score.toFixed(6)}`;
  return `✓ Valid, score ${score}, but it does not beat the current best${best} (an entry must improve on it; equal scores keep the earlier entry).`;
}

/** The line under the leaderboard: `total` submissions received, of which only the leader is shown. */
export function leaderboardNote(total: number, shown: number, open: boolean): string {
  if (!open) return CLOSED_NOTE;
  if (!shown) return "No entries yet. Yours could be the first.";
  return total === 1 ? "1 submission so far." : `${total} submissions in total; the earliest best one is shown.`;
}
