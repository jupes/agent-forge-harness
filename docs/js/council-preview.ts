/**
 * What the council page shows before a run sends anything: the listing of a
 * preview (`POST /__agent-forge/council/preview`), and whether that preview is
 * of the draft as it now stands. Pure; `islands/CouncilIsland.tsx` makes the
 * request and `islands/CouncilSetup.tsx` draws it.
 */

import type { CouncilPreview } from "../../scripts/council/service";

export type CouncilPreviewState =
  | { status: "idle" }
  | { status: "loading"; key: string }
  | { status: "ready"; key: string; preview: CouncilPreview }
  | { status: "failed"; key: string; error: string };

/** The fields of a draft that change what a run would send. */
export type PreviewDraft = {
  sourceType: string;
  source: string;
  redactSecrets: boolean;
};

/** One draft's key: a preview made for another draft says nothing of this one. */
export function previewKey(draft: PreviewDraft): string {
  return JSON.stringify([
    draft.sourceType,
    draft.source.trim(),
    draft.redactSecrets,
  ]);
}

/**
 * Whether a source kind is shown before it is sent. A bead is read from the
 * tracker when the run starts, its text is private, and every provider of the
 * profile receives it: the operator sees what goes before anything does.
 */
export function needsPreview(sourceType: string): boolean {
  return sourceType === "bead";
}

/** The state as it bears on this draft: a preview of another draft is no preview. */
export function previewOf(
  state: CouncilPreviewState,
  draft: PreviewDraft,
): CouncilPreviewState {
  return state.status !== "idle" && state.key !== previewKey(draft)
    ? { status: "idle" }
    : state;
}

/** Whether the draft may be sent as far as the preview goes. */
export function previewAllowsSend(
  state: CouncilPreviewState,
  draft: PreviewDraft,
): boolean {
  return (
    !needsPreview(draft.sourceType) ||
    previewOf(state, draft).status === "ready"
  );
}
