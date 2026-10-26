import { createHash } from "node:crypto";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type {
  ConversationReceipt,
  ConversationState,
} from "../../types/conversation";
import { createConversationStore } from "../conversations/store";
import {
  attestEmptyInitialStart,
  type EmptyInitialStartProof,
} from "../identities/preaccept-not-sent-proof";
import type { RestartIdentityInput } from "../identities/restart-index";
import { workspaceKey } from "../projects/scope";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";
import { createSessionLibrary } from "./library";
import { createSessionRegistry } from "./registry";

export type VerifiedOriginalStart = {
  session: OwnedCodingSessionRecord;
  receipt: ConversationReceipt;
};

export type OriginalStartProofRead =
  | { kind: "missing"; emptySource: EmptyInitialStartProof }
  | { kind: "empty"; emptySource: EmptyInitialStartProof }
  | { kind: "invalid" }
  | { kind: "conflict" }
  | { kind: "verified"; value: VerifiedOriginalStart };

function sameRegistrySession(
  left: OwnedCodingSessionRecord,
  right: OwnedCodingSessionRecord,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.requestId === right.requestId &&
    left.requestHash === right.requestHash &&
    left.provider === right.provider &&
    left.mode === right.mode &&
    left.workspace === right.workspace &&
    left.repository === right.repository &&
    left.worktree === right.worktree &&
    left.beadId === right.beadId &&
    left.smith === right.smith &&
    left.requestedModel === right.requestedModel &&
    left.requestedEffort === right.requestedEffort &&
    left.createdAt === right.createdAt &&
    left.origin === right.origin &&
    ("route" in left ? left.route : undefined) ===
      ("route" in right ? right.route : undefined)
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function launchFromTranscript(
  session: OwnedCodingSessionRecord,
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  let snapshot: Record<string, unknown> | null = null;
  if (session.provider === "claude") snapshot = object(event.session);
  else if (session.provider === "codex")
    snapshot = object(
      session.mode === "chat" ? event.codexChat : event.codexTask,
    );
  else
    snapshot = object(
      session.mode === "chat" ? event.geminiChat : event.geminiTask,
    );
  const launch = object(snapshot?.launch);
  if (launch === null) return null;
  if (
    Object.hasOwn(launch, "resumeSessionId") ||
    (session.provider === "gemini" &&
      (Object.hasOwn(launch, "policyFiles") ||
        Object.hasOwn(launch, "includeDirectories")))
  )
    return null;
  const result = { ...launch };
  delete result.cwd;
  delete result.context;
  return result;
}

function matchesOriginalRequestHash(
  session: OwnedCodingSessionRecord,
  event: Record<string, unknown>,
  launch: Record<string, unknown>,
): boolean {
  if (typeof event.text !== "string" || launch.prompt !== event.text)
    return false;
  const about = Array.isArray(event.about) ? event.about : null;
  if (about === null) return false;
  const aboutVariants: Array<unknown[] | undefined> =
    about.length === 0 ? [undefined, []] : [about];

  for (const originalAbout of aboutVariants) {
    const candidate: Record<string, unknown> = {
      requestId: session.requestId,
      smith: session.smith,
      repository: session.repository,
      worktree: session.worktree,
      ...(session.beadId === undefined ? {} : { beadId: session.beadId }),
      ...(originalAbout === undefined ? {} : { about: originalAbout }),
      ...(session.provider === "claude" ? {} : { provider: session.provider }),
      launch,
    };
    try {
      const hash = createHash("sha256")
        .update(canonicalOwnedSessionStart(candidate))
        .digest("hex");
      if (hash === session.requestHash) return true;
    } catch {
      // An invalid or incomplete private snapshot is not Start identity proof.
    }
  }
  return false;
}

/** Reads the full registry and owner-checked private transcript; it has no provider capability. */
export function readVerifiedOriginalStart(options: {
  home: string;
  root: string;
  identity: RestartIdentityInput;
}): OriginalStartProofRead {
  let session: OwnedCodingSessionRecord | null;
  try {
    session = createSessionRegistry(options.home).lookupRequestId(
      options.identity.requestId,
    );
  } catch {
    return { kind: "invalid" };
  }
  if (session === null)
    return {
      kind: "missing",
      emptySource: attestEmptyInitialStart(options.identity),
    };
  if (
    session.origin !== undefined ||
    session.requestId !== options.identity.requestId
  )
    return { kind: "invalid" };
  if (
    session.projectId !== options.identity.address.projectId ||
    workspaceKey(session.workspace) !== options.identity.workspace
  )
    return { kind: "conflict" };
  if (
    session.requestHash !== options.identity.requestHash ||
    session.provider !== options.identity.provider ||
    session.mode !== options.identity.mode
  )
    return { kind: "invalid" };

  let privateState: ConversationState;
  try {
    privateState = createConversationStore(options.home, undefined, {
      kind: "session",
      projectId: session.projectId,
      sessionId: session.id,
    }).read(session.projectId);
  } catch {
    return { kind: "invalid" };
  }
  if (
    privateState.conversationId !== session.id ||
    privateState.projectId !== session.projectId
  )
    return { kind: "invalid" };
  if (
    privateState.revision === 0 &&
    privateState.binding === null &&
    privateState.keeperRecovery === undefined &&
    privateState.turns.length === 0 &&
    privateState.frames.length === 0
  )
    return {
      kind: "empty",
      emptySource: attestEmptyInitialStart(options.identity),
    };

  let transcript: ReturnType<
    ReturnType<typeof createSessionLibrary>["exportTranscript"]
  >;
  try {
    transcript = createSessionLibrary({
      home: options.home,
      root: options.root,
    }).exportTranscript(session.projectId, session.id);
  } catch {
    return { kind: "invalid" };
  }
  const firstFrame = transcript.conversation.frames[0];
  const firstTurn = transcript.conversation.turns[0];
  const privateFirstFrame = privateState.frames[0];
  const privateFirstTurn = privateState.turns[0];
  if (
    !sameRegistrySession(transcript.session, session) ||
    transcript.session.origin !== undefined ||
    transcript.session.id !== session.id ||
    transcript.session.projectId !== session.projectId ||
    transcript.session.requestId !== options.identity.requestId ||
    transcript.session.requestHash !== options.identity.requestHash ||
    !firstFrame ||
    firstFrame.seq !== 1 ||
    firstFrame.turnId !== options.identity.requestId ||
    firstFrame.event.kind !== "user" ||
    !firstTurn ||
    firstTurn.requestId !== options.identity.requestId ||
    !privateFirstFrame ||
    !privateFirstTurn ||
    privateState.conversationId !== transcript.conversation.conversationId ||
    privateState.revision !== transcript.conversation.revision ||
    JSON.stringify(privateFirstFrame) !== JSON.stringify(firstFrame) ||
    privateFirstTurn.requestId !== firstTurn.requestId ||
    privateFirstTurn.hash !== firstTurn.hash ||
    privateFirstTurn.phase !== firstTurn.phase ||
    privateFirstTurn.createdAt !== firstTurn.createdAt ||
    privateFirstTurn.updatedAt !== firstTurn.updatedAt ||
    privateFirstTurn.reason !== firstTurn.reason
  )
    return { kind: "invalid" };

  const event = firstFrame.event as unknown as Record<string, unknown>;
  const launch = launchFromTranscript(session, event);
  if (launch === null || !matchesOriginalRequestHash(session, event, launch))
    return { kind: "invalid" };

  return {
    kind: "verified",
    value: {
      session,
      receipt: {
        conversationId: transcript.conversation.conversationId,
        revision: transcript.conversation.revision,
        turn: privateFirstTurn,
      },
    },
  };
}
