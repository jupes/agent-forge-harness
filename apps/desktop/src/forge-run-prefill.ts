import type { ConversationObject } from "../../../types/conversation";
import { newCodexChatDraft } from "./codex-chat-composer";
import { newCodexTaskDraft } from "./codex-session-composer";
import { newGeminiChatDraft } from "./gemini-chat-composer";
import { newGeminiTaskDraft } from "./gemini-task-composer";
import type { SessionProjectView } from "./session-client";
import type { SessionComposerDraft } from "./session-composer";
import { newSessionDraft } from "./session-composer";
import type { VerifiedSessionIdentityScope } from "./session-start-identity-server";

export type ForgeRunMode = "full" | "mini";
export type ForgeRunSource =
  | { kind: "text"; text: string }
  | { kind: "bead"; id: string; title: string };

export interface ForgeRunPrefill {
  prompt: string;
  beadId: string;
  about: ConversationObject[];
}

export function forgeRunComposerPatch(
  prefill: ForgeRunPrefill,
): Partial<SessionComposerDraft> {
  return {
    prompt: prefill.prompt,
    attachments: [],
    about: structuredClone(prefill.about),
    beadId: prefill.beadId,
  };
}

/** Only prompt text is produced; this never constructs provider argv or environment. */
export function forgeRunPrefill(
  mode: ForgeRunMode,
  source: ForgeRunSource,
): ForgeRunPrefill {
  const input = source.kind === "text" ? source.text : source.id;
  if (!input.trim()) throw Error("Enter feature text or choose a scoped bead.");
  if (/--(?:full|mini|smith)(?![\w-])/i.test(input))
    throw Error(
      "Remove --full, --mini, or --smith from the input; choose the route above instead.",
    );
  return {
    prompt: `/forgemaster --${mode} ${input}`,
    beadId: source.kind === "bead" ? source.id : "",
    about: source.kind === "bead" ? [{ kind: "bead", id: source.id }] : [],
  };
}

/** Volatile snapshot of all provider drafts and the shared Start identity guard. */
export interface ForgeRunDraftSnapshot {
  composerProvider: SessionProjectView["composerProvider"];
  composer: SessionProjectView["composer"];
  codexMode: SessionProjectView["codexMode"];
  codexComposer: SessionProjectView["codexComposer"];
  codexChatComposer: SessionProjectView["codexChatComposer"];
  geminiMode: SessionProjectView["geminiMode"];
  geminiComposer: SessionProjectView["geminiComposer"];
  geminiChatComposer: SessionProjectView["geminiChatComposer"];
  pendingStart: SessionProjectView["pendingStart"];
  startIdentity: SessionProjectView["startIdentity"];
  startIdentityError: string;
  identityPage: SessionProjectView["identityPage"];
  identityLoading: boolean;
  identityGeneration: number | null;
  legacyIdentityHint: SessionProjectView["legacyIdentityHint"];
  legacyIdentityError: string;
  legacyIdentityUnavailable: boolean;
  identityInspection: SessionProjectView["identityInspection"];
  starting: boolean;
}

export function captureForgeRunDraft(
  view: SessionProjectView,
): ForgeRunDraftSnapshot {
  return structuredClone({
    composerProvider: view.composerProvider,
    composer: view.composer,
    codexMode: view.codexMode,
    codexComposer: view.codexComposer,
    codexChatComposer: view.codexChatComposer,
    geminiMode: view.geminiMode,
    geminiComposer: view.geminiComposer,
    geminiChatComposer: view.geminiChatComposer,
    pendingStart: view.pendingStart,
    startIdentity: view.startIdentity,
    startIdentityError: view.startIdentityError,
    identityPage: view.identityPage,
    identityLoading: view.identityLoading,
    identityGeneration: view.identityGeneration,
    legacyIdentityHint: view.legacyIdentityHint,
    legacyIdentityError: view.legacyIdentityError,
    legacyIdentityUnavailable: view.legacyIdentityUnavailable,
    identityInspection: view.identityInspection,
    starting: view.starting,
  });
}

export function forgeRunDraftMatches(
  expected: ForgeRunDraftSnapshot,
  current: SessionProjectView,
): boolean {
  return (
    JSON.stringify(expected) === JSON.stringify(captureForgeRunDraft(current))
  );
}

export function forgeRunDraftIsPristine(
  snapshot: ForgeRunDraftSnapshot,
): boolean {
  return (
    snapshot.composerProvider === "claude" &&
    JSON.stringify(snapshot.composer) === JSON.stringify(newSessionDraft()) &&
    snapshot.codexMode === "task" &&
    JSON.stringify(snapshot.codexComposer) ===
      JSON.stringify(newCodexTaskDraft()) &&
    JSON.stringify(snapshot.codexChatComposer) ===
      JSON.stringify(newCodexChatDraft()) &&
    snapshot.geminiMode === "task" &&
    JSON.stringify(snapshot.geminiComposer) ===
      JSON.stringify(newGeminiTaskDraft()) &&
    JSON.stringify(snapshot.geminiChatComposer) ===
      JSON.stringify(newGeminiChatDraft())
  );
}

export function forgeRunPreparationHold(
  view: SessionProjectView,
  currentScope: VerifiedSessionIdentityScope | null,
): string | null {
  if (view.identityLoading)
    return "Wait for the current session identity read to finish.";
  if (
    !view.identityPage ||
    !currentScope ||
    view.identityGeneration !== currentScope.generation ||
    view.identityPage.scope.projectId !== currentScope.projectId ||
    view.identityPage.scope.workspace !== currentScope.workspace
  )
    return "The current session identity scope is not verified. Retry the read before changing a draft.";
  if (
    view.pendingStart ||
    view.startIdentity ||
    view.starting ||
    view.startIdentityError ||
    view.legacyIdentityHint ||
    view.legacyIdentityError ||
    view.legacyIdentityUnavailable ||
    view.identityInspection?.state === "loading" ||
    view.identityInspection?.state === "unavailable" ||
    view.identityPage.identities.some((identity) =>
      ["reserved", "attempted", "not-sent"].includes(identity.state),
    )
  )
    return "An original session request is unresolved. Review it before changing a draft or provider.";
  return null;
}
