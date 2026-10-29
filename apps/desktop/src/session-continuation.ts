import { originalSessionLaunchMatches } from "../../../scripts/sessions/library-protocol";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type {
  ConversationPage,
  ConversationState,
} from "../../../types/conversation";
import type { SessionStartIdentityPage } from "../../../types/session-start-identities";
import type { SessionComposerDraft } from "./session-composer";

export const CONTINUATION_SUMMARY_LIMIT = 4_000;

export interface ContinuationIdentityState {
  page: SessionStartIdentityPage | null;
  loading: boolean;
  generation: number | null;
  startIdentity: { requestId: string } | null;
  pendingStart: boolean;
  starting: boolean;
  startIdentityError: string;
  legacyIdentityError: string;
  legacyIdentityUnavailable: boolean;
  inspection: { state: "loading" | "unavailable" | "verified" } | null;
}

export interface ClaudeContinuationSourceState {
  projectId: string;
  workspace: string | null;
  writable: boolean;
  archived: boolean;
  record: OwnedCodingSessionRecord | null;
  page: ConversationPage | null;
  loaded: boolean;
  live: boolean;
  feedInterrupted: boolean;
  readError: string;
  stopping: boolean;
  stopPosting: boolean;
  stopUnknown: boolean;
  pending: boolean;
  posting: boolean;
  identity: ContinuationIdentityState;
}

function currentTargetIdentity(
  projectId: string,
  workspace: string | null,
  identity: ContinuationIdentityState,
): boolean {
  const page = identity.page;
  return (
    !!workspace &&
    !!page &&
    page.version === 1 &&
    page.scope.family === "owned-session-start" &&
    page.scope.projectId === projectId &&
    page.scope.workspace === workspace &&
    !identity.loading &&
    identity.generation !== null &&
    !identity.startIdentity &&
    !identity.pendingStart &&
    !identity.starting &&
    !identity.startIdentityError &&
    !identity.legacyIdentityError &&
    !identity.legacyIdentityUnavailable &&
    identity.inspection?.state !== "loading" &&
    identity.inspection?.state !== "unavailable" &&
    !page.identities.some((item) =>
      ["reserved", "attempted", "not-sent"].includes(item.state),
    )
  );
}

function matchingOriginal(
  record: OwnedCodingSessionRecord,
  page: ConversationPage,
): boolean {
  const state: ConversationState = {
    version: page.version,
    projectId: page.projectId,
    conversationId: page.conversationId,
    revision: page.revision,
    binding: page.binding,
    turns: page.turns,
    frames: page.frames,
  };
  if (!originalSessionLaunchMatches(record, state)) return false;
  const original = page.frames[0];
  return (
    original?.seq === 1 &&
    original.turnId === record.requestId &&
    original.event.kind === "user" &&
    original.event.session?.launch.mode === "chat" &&
    original.event.session.launch.prompt === original.event.text
  );
}

export function canContinueClaudeRateLimit(
  source: ClaudeContinuationSourceState,
): boolean {
  const { record, page } = source;
  if (
    !source.writable ||
    source.archived ||
    !source.workspace ||
    !record ||
    record.projectId !== source.projectId ||
    record.workspace !== source.workspace ||
    record.provider !== "claude" ||
    record.mode !== "chat" ||
    record.origin !== undefined ||
    !page ||
    page.projectId !== source.projectId ||
    page.conversationId !== record.id ||
    page.more ||
    page.request !== null ||
    !source.loaded ||
    !source.live ||
    source.feedInterrupted ||
    source.readError ||
    source.stopping ||
    source.stopPosting ||
    source.stopUnknown ||
    source.pending ||
    source.posting ||
    !currentTargetIdentity(source.projectId, source.workspace, source.identity)
  )
    return false;

  const latest = page.turns.at(-1),
    binding = page.binding;
  if (
    !latest ||
    latest.phase !== "failed" ||
    page.turns.some((turn) =>
      ["accepted", "running", "cancelling", "unknown"].includes(turn.phase),
    ) ||
    !binding ||
    binding.provider !== "claude" ||
    !binding.sessionId ||
    !matchingOriginal(record, page)
  )
    return false;

  const snapshot = page.frames[0];
  if (
    snapshot?.event.kind !== "user" ||
    snapshot.event.session?.capabilities.version !== binding.version
  )
    return false;

  const outcome = [...page.frames]
    .reverse()
    .find(
      (frame) =>
        frame.turnId === latest.requestId &&
        frame.event.kind === "coding-outcome",
    )?.event;
  return (
    outcome?.kind === "coding-outcome" &&
    outcome.provider === "claude" &&
    outcome.version === binding.version &&
    outcome.code === "rate-limited" &&
    !outcome.stopped &&
    !outcome.timedOut
  );
}

export function continuationDraftIsDirty(
  draft: Pick<SessionComposerDraft, "prompt" | "attachments" | "about">,
): boolean {
  return (
    !!draft.prompt.trim() ||
    draft.attachments.length > 0 ||
    draft.about.length > 0
  );
}

export function validContinuationSummary(value: string): boolean {
  return (
    value.trim().length > 0 && value.trim().length <= CONTINUATION_SUMMARY_LIMIT
  );
}

export function continuationDraftFingerprint(
  draft: Pick<SessionComposerDraft, "prompt" | "attachments" | "about">,
): string {
  return JSON.stringify({
    prompt: draft.prompt,
    attachments: draft.attachments,
    about: draft.about,
  });
}
