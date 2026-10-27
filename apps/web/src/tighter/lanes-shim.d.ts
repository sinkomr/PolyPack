import type { SpaceRunRequest, SpaceRunState, SpaceStartAnswer, SpaceStartRequest } from "./space-run-types";

/**
 * Lane's space methods as lane C1 adds them (lanes.ts: openSpace, spaceStart), declared here so that
 * main.ts compiles before the merge. Delete this file once lanes.ts has them.
 */
declare module "./lanes" {
  interface Lane {
    openSpace(
      request: SpaceRunRequest,
    ): Promise<{ ok: true; params: Record<string, unknown>; state: SpaceRunState } | { ok: false; message: string }>;
    spaceStart(request: SpaceStartRequest): Promise<SpaceStartAnswer>;
  }
}
