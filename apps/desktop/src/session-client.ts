import { z } from "zod";
import type { ActionOutcome } from "../../../docs/js/action-outcome";
import { REAL_TIMERS, type Timers } from "../../../docs/js/hearth-read";
import type { StreamTransport } from "../../../docs/js/use-stream";
import { conversationReceiptSchema } from "../../../scripts/conversations/protocol";
import { ownedCodingPageSchema } from "../../../scripts/sessions/codex-owned-journal";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "../../../scripts/sessions/codex-owned-protocol";
import {
  ownedCodingSessionSchema,
  ownedCodingStartReceiptSchema,
} from "../../../scripts/sessions/codex-owned-wire-protocol";
import { sessionStartReceiptSchema } from "../../../scripts/sessions/protocol";
import type {
  OwnedCodingSessionRecord as OwnedSessionRecord,
  OwnedSessionStartInput,
  OwnedSessionStartRequest as SessionStartRequest,
} from "../../../types/codex-owned-task";
import type {
  ConversationObject,
  ConversationPage,
  ConversationReceipt,
  ConversationTurn,
} from "../../../types/conversation";
import type { SessionAttachment } from "../../../types/session-launch";
import type { SessionStartRequest as ClaudeSessionStartRequest } from "../../../types/session-requests";
import type {
  SessionStartIdentityMetadata,
  SessionStartIdentityPage,
} from "../../../types/session-start-identities";
import type { SessionMessage } from "../../../types/session-turn";
import type { SessionWorktreeRequest } from "../../../types/session-worktrees";
import {
  type CodexChatComposerDraft,
  newCodexChatDraft,
} from "./codex-chat-composer";
import {
  type CodexTaskComposerDraft,
  newCodexTaskDraft,
} from "./codex-session-composer";
import {
  type GeminiChatComposerDraft,
  newGeminiChatDraft,
} from "./gemini-chat-composer";
import {
  type GeminiTaskComposerDraft,
  newGeminiTaskDraft,
} from "./gemini-task-composer";
import {
  newSessionDraft,
  type SessionComposerDraft,
  validateSessionAttachments,
} from "./session-composer";
import type {
  SessionStartIdentities,
  SessionStartIdentity,
} from "./session-start-identities";
import { sessionStartHash } from "./session-start-identities";
import type {
  SessionStartIdentityServer,
  VerifiedSessionIdentityScope,
} from "./session-start-identity-server";
import { createSessionWorktreeClient } from "./session-worktree-client";

const listSchema = z.array(ownedCodingSessionSchema).max(1000);
const active = (phase: string) =>
  ["accepted", "running", "cancelling"].includes(phase);
const held = (turn: ConversationTurn) =>
  active(turn.phase) || turn.phase === "unknown";
const freezeDeep = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
};
const startProvider = (input: SessionStartRequest) =>
  "provider" in input ? input.provider : "claude";
const sameStart = (record: OwnedSessionRecord, input: SessionStartRequest) =>
  record.provider === ("provider" in input ? input.provider : "claude") &&
  record.requestId === input.requestId &&
  record.smith === input.smith &&
  record.repository === input.repository &&
  record.worktree === input.worktree &&
  record.mode === input.launch.mode &&
  record.requestedModel === (input.launch.model ?? null) &&
  record.requestedEffort ===
    ("effort" in input.launch ? (input.launch.effort ?? null) : null) &&
  record.beadId === input.beadId;
export interface SessionProjectView {
  records: OwnedSessionRecord[];
  loaded: boolean;
  loading: boolean;
  error: string;
  composer: SessionComposerDraft;
  composerProvider: "claude" | "codex" | "gemini";
  codexMode: "task" | "chat";
  codexComposer: CodexTaskComposerDraft;
  codexChatComposer: CodexChatComposerDraft;
  geminiComposer: GeminiTaskComposerDraft;
  geminiMode: "task" | "chat";
  geminiChatComposer: GeminiChatComposerDraft;
  pendingStart: SessionStartRequest | null;
  startIdentity: SessionStartIdentity | null;
  startIdentityError: string;
  identityPage: SessionStartIdentityPage | null;
  identityLoading: boolean;
  identityGeneration: number | null;
  legacyIdentityHint: SessionStartIdentity | null;
  legacyIdentityError: string;
  legacyIdentityUnavailable: boolean;
  identityInspection: {
    requestId: string;
    state: "loading" | "unavailable" | "verified";
    sessionId: string | null;
  } | null;
  starting: boolean;
  notice: string;
  lastStarted: string | null;
}
export interface OwnedSessionView {
  projectId: string;
  id: string;
  page: ConversationPage | null;
  loaded: boolean;
  live: boolean;
  feedInterrupted: boolean;
  readError: string;
  draft: string;
  attachments: SessionAttachment[];
  about: ConversationObject[];
  pending: SessionMessage | null;
  posting: boolean;
  stopping: string | null;
  stopPosting: boolean;
  stopUnknown: boolean;
  notice: string;
  receiptRevision: number;
}

/** App-root owner of frozen Start/turn identities; navigation controls observers only. */
export function createSessionsClient(deps: {
  canWrite(): boolean;
  requestId(): string;
  identities?: SessionStartIdentities;
  identityServer?: SessionStartIdentityServer;
  identityScope?(): VerifiedSessionIdentityScope | null;
  legacyHint?(projectId: string): SessionStartIdentity | null;
  list(projectId: string): Promise<unknown>;
  read(
    projectId: string,
    sessionId: string,
    query: { after: number; requestId?: string },
  ): Promise<unknown>;
  post(
    projectId: string,
    sessionId: string | null,
    action: "start" | "turns" | "stop",
    body: SessionStartRequest | SessionMessage | { requestId: string },
  ): Promise<ActionOutcome & { notSent?: true }>;
  stream(projectId: string, sessionId: string): StreamTransport;
  timers?: Timers;
  createWorktree?(
    projectId: string,
    input: SessionWorktreeRequest,
  ): Promise<ActionOutcome>;
  readWorktree?(projectId: string, requestId: string): Promise<unknown>;
}) {
  const projects = new Map<string, SessionProjectView>(),
    sessions = new Map<string, OwnedSessionView>(),
    listeners = new Set<() => void>();
  const reads = new Map<string, { work: Promise<void>; again: boolean }>();
  const identityReads = new Map<
    string,
    { work: Promise<void>; again: boolean; controller: AbortController }
  >();
  const identityMutations = new Set<string>();
  const timers = deps.timers ?? REAL_TIMERS;
  let selected: OwnedSessionView | null = null,
    connection: { close(): void } | null = null,
    timer: unknown = null,
    cancelSavedRead: (() => void) | null = null,
    generation = 0,
    disposed = false;
  const project = (id: string): SessionProjectView => {
    let value = projects.get(id);
    if (!value) {
      value = {
        records: [],
        loaded: false,
        loading: false,
        error: "",
        composer: newSessionDraft(),
        composerProvider: "claude",
        codexMode: "task",
        codexComposer: newCodexTaskDraft(),
        codexChatComposer: newCodexChatDraft(),
        geminiComposer: newGeminiTaskDraft(),
        geminiMode: "task",
        geminiChatComposer: newGeminiChatDraft(),
        pendingStart: null,
        startIdentity: null,
        startIdentityError: "",
        identityPage: null,
        identityLoading: false,
        identityGeneration: null,
        legacyIdentityHint: null,
        legacyIdentityError: "",
        legacyIdentityUnavailable: false,
        identityInspection: null,
        starting: false,
        notice: "",
        lastStarted: null,
      };
      projects.set(id, value);
      if (!deps.identityServer) hydrateStart(id, value);
      else if (deps.legacyHint) {
        try {
          value.legacyIdentityHint = deps.legacyHint(id);
        } catch {
          value.legacyIdentityUnavailable = true;
          value.legacyIdentityError =
            "A previous Start identity hint could not be verified. Starting another session is blocked.";
        }
      }
    }
    return value;
  };
  const session = (projectId: string, id: string): OwnedSessionView => {
    const key = `${projectId}:${id}`;
    let value = sessions.get(key);
    if (!value) {
      value = {
        projectId,
        id,
        page: null,
        loaded: false,
        live: false,
        feedInterrupted: false,
        readError: "",
        draft: "",
        attachments: [],
        about: [],
        pending: null,
        posting: false,
        stopping: null,
        stopPosting: false,
        stopUnknown: false,
        notice: "",
        receiptRevision: 0,
      };
      sessions.set(key, value);
    }
    return value;
  };
  const tell = () => {
    if (!disposed) for (const listener of [...listeners]) listener();
  };
  function hydrateStart(projectId: string, entry: SessionProjectView) {
    if (!deps.identities) return;
    try {
      // A failed durable release stays latched until protected admission (or a
      // proven unsent attempt) retries that release; absence alone is no proof.
      if (entry.startIdentityError && entry.startIdentity) return;
      entry.startIdentity = deps.identities.read(projectId);
      entry.startIdentityError = "";
      if (entry.startIdentity && !entry.pendingStart)
        entry.notice =
          "An original Start identity is saved. Check its protected admission before starting another session; its private input is not stored in this browser.";
    } catch {
      entry.startIdentityError =
        "Original Start identities could not be verified. Saved data was kept; starting another session is blocked.";
      entry.notice = entry.startIdentityError;
    }
  }
  const metadataProjection = (
    projectId: string,
    identity: SessionStartIdentityMetadata,
  ): SessionStartIdentity => ({
    projectId,
    requestId: identity.requestId,
    requestHash: identity.requestHash,
    provider: identity.provider,
  });
  const currentIdentityPage = (projectId: string) =>
    projects.get(projectId)?.identityPage ?? null;
  const readIdentityPage = async (projectId: string): Promise<void> => {
    if (!deps.identityServer || !deps.identityScope || disposed) return;
    const scope = deps.identityScope();
    if (!scope || scope.projectId !== projectId) return;
    const existing = identityReads.get(projectId);
    if (existing) {
      existing.again = true;
      return existing.work;
    }
    const read = {
      work: Promise.resolve(),
      again: false,
      controller: new AbortController(),
    };
    identityReads.set(projectId, read);
    const entry = project(projectId);
    entry.identityLoading = true;
    entry.identityInspection = null;
    entry.startIdentityError = "";
    tell();
    read.work = (async () => {
      try {
        const page = await deps.identityServer!.list(
          scope,
          read.controller.signal,
        );
        if (
          disposed ||
          read.controller.signal.aborted ||
          identityReads.get(projectId) !== read ||
          deps.identityScope?.()?.generation !== scope.generation
        )
          return;
        entry.identityPage = page;
        entry.identityGeneration = scope.generation;
        const hint = entry.legacyIdentityHint;
        const hintMatchesServer = hint
          ? page.identities.some(
              (identity) =>
                identity.requestId === hint.requestId &&
                identity.requestHash === hint.requestHash &&
                identity.provider === hint.provider,
            )
          : true;
        entry.legacyIdentityError = entry.legacyIdentityUnavailable
          ? "A previous Start identity hint could not be verified. Starting another session is blocked."
          : hintMatchesServer
            ? ""
            : "A previous local Start hint has no matching server identity. Review it before creating another session.";
        const unresolved = page.identities.filter((identity) =>
          ["reserved", "attempted", "not-sent"].includes(identity.state),
        );
        entry.startIdentity = unresolved[0]
          ? metadataProjection(projectId, unresolved[0])
          : null;
        entry.startIdentityError = entry.legacyIdentityError;
        if (entry.startIdentity && !entry.pendingStart)
          entry.notice =
            "An original Start is still held by the server. Check its protected admission before creating another session.";
      } catch {
        if (!disposed && identityReads.get(projectId) === read) {
          entry.identityPage = null;
          entry.identityGeneration = null;
          entry.startIdentityError =
            "Original Start identities could not be verified. Starting another session is blocked.";
        }
      } finally {
        if (identityReads.get(projectId) === read) {
          identityReads.delete(projectId);
          entry.identityLoading = false;
          tell();
          if (read.again && !disposed) void readIdentityPage(projectId);
        }
      }
    })();
    return read.work;
  };
  const makeStartRequest = (
    input: OwnedSessionStartInput,
    requestId: string,
  ): SessionStartRequest =>
    freezeDeep(
      parseOwnedSessionStart(
        structuredClone({ ...input, requestId }),
      ) as SessionStartRequest,
    );
  const inspectIdentity = async (
    projectId: string,
    requestId: string,
  ): Promise<boolean> => {
    const entry = project(projectId),
      scope = deps.identityScope?.(),
      page = entry.identityPage,
      identity = page?.identities.find((row) => row.requestId === requestId);
    if (
      !deps.identityServer ||
      !scope ||
      scope.projectId !== projectId ||
      !page ||
      entry.identityGeneration !== scope.generation ||
      !identity ||
      !["attempted", "admitted"].includes(identity.state)
    )
      return false;
    entry.identityInspection = {
      requestId,
      state: "loading",
      sessionId: null,
    };
    tell();
    try {
      await refresh(projectId);
      if (
        disposed ||
        deps.identityScope?.()?.generation !== scope.generation ||
        entry.identityPage !== page
      )
        return false;
      const record = entry.records.find(
        (candidate) =>
          candidate.projectId === projectId &&
          candidate.requestId === identity.requestId &&
          candidate.requestHash === identity.requestHash &&
          candidate.provider === identity.provider &&
          candidate.mode === identity.mode &&
          candidate.origin === undefined,
      );
      if (!record || entry.error) throw Error("Original session unavailable");
      const observed = session(projectId, record.id);
      if (
        observed.loaded &&
        observed.page?.conversationId === record.id &&
        [
          ...observed.page.turns,
          ...(observed.page.request ? [observed.page.request] : []),
        ].some(
          (turn) =>
            turn.requestId === requestId && turn.hash === identity.requestHash,
        )
      ) {
        entry.identityInspection = {
          requestId,
          state: "verified",
          sessionId: record.id,
        };
        tell();
        return true;
      }
      const raw = await deps.read(projectId, record.id, {
        after: 0,
        requestId: identity.requestId,
      });
      if (
        disposed ||
        deps.identityScope?.()?.generation !== scope.generation ||
        entry.identityPage !== page
      )
        return false;
      if (!apply(session(projectId, record.id), raw))
        throw Error("Original session could not be verified");
      const verifiedPage = session(projectId, record.id).page;
      if (
        !verifiedPage ||
        ![
          ...verifiedPage.turns,
          ...(verifiedPage.request ? [verifiedPage.request] : []),
        ].some(
          (turn) =>
            turn.requestId === requestId && turn.hash === identity.requestHash,
        )
      )
        throw Error("Original request identity did not match");
      entry.identityInspection = {
        requestId,
        state: "verified",
        sessionId: record.id,
      };
      tell();
      return true;
    } catch {
      if (!disposed && entry.identityPage === page) {
        entry.identityInspection = {
          requestId,
          state: "unavailable",
          sessionId: null,
        };
        entry.notice =
          "The original session could not be verified. Its Start identity remains held.";
        tell();
      }
      return false;
    }
  };
  const disconnect = () => {
    connection?.close();
    connection = null;
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const confirm = (entry: OwnedSessionView, turn: ConversationTurn) => {
    if (entry.pending?.requestId === turn.requestId) {
      if (entry.draft === entry.pending.text) entry.draft = "";
      if (
        JSON.stringify(entry.attachments) ===
        JSON.stringify(entry.pending.attachments ?? [])
      )
        entry.attachments = [];
      if (JSON.stringify(entry.about) === JSON.stringify(entry.pending.about))
        entry.about = [];
      entry.pending = null;
      entry.notice = "The original message is recorded in this session.";
    }
    if (entry.stopping === turn.requestId && !active(turn.phase)) {
      entry.stopping = null;
      entry.stopUnknown = false;
      entry.notice =
        turn.phase === "cancelled" ? "Stop confirmed." : "The turn has ended.";
    }
    const view = project(entry.projectId);
    if (
      (view.pendingStart?.requestId ?? view.startIdentity?.requestId) ===
      turn.requestId
    ) {
      const record = view.records.find(
        (item) => item.id === entry.id && item.requestId === turn.requestId,
      );
      const identity = view.startIdentity;
      if (
        record &&
        (!identity ||
          (record.requestHash === identity.requestHash &&
            record.provider === identity.provider))
      ) {
        if (view.pendingStart) {
          view.composer = {
            ...view.composer,
            ...(view.composer.prompt === view.pendingStart.launch.prompt
              ? { prompt: "" }
              : {}),
            ...(JSON.stringify(view.composer.attachments) ===
            JSON.stringify(view.pendingStart.launch.attachments ?? [])
              ? { attachments: [] }
              : {}),
            ...(JSON.stringify(view.composer.about) ===
            JSON.stringify(view.pendingStart.about ?? [])
              ? { about: [] }
              : {}),
          };
        }
        view.pendingStart = null;
        view.lastStarted = record.id;
        view.notice =
          "The original Start is recorded. The session is available.";
        if (identity && deps.identities)
          void deps.identities
            .release(identity)
            .then(() => {
              if (view.startIdentity?.requestId === identity.requestId) {
                view.startIdentity = null;
                view.startIdentityError = "";
              }
              tell();
            })
            .catch(() => {
              view.startIdentityError =
                "The confirmed original Start identity could not be cleared durably. Check it again before starting another session.";
              view.notice = view.startIdentityError;
              tell();
            });
      }
    }
  };
  const apply = (
    entry: OwnedSessionView,
    raw: unknown,
    live = false,
  ): boolean => {
    const parsed = ownedCodingPageSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.projectId !== entry.projectId ||
      parsed.data.conversationId !== entry.id
    ) {
      entry.live = false;
      entry.feedInterrupted = true;
      entry.readError =
        "The saved session update could not be verified. Earlier private activity was kept. Reload to check it again.";
      entry.notice =
        "The session update could not be verified. Reload the saved conversation; partial text has been kept.";
      if (selected === entry) {
        cancelSavedRead?.();
        generation++;
        disconnect();
      }
      tell();
      return false;
    }
    const page = parsed.data;
    if (entry.page && page.revision < entry.page.revision) return true;
    if (!live && selected !== entry) {
      for (const turn of [
        ...page.turns,
        ...(page.request ? [page.request] : []),
      ])
        confirm(entry, turn);
      tell();
      return true;
    }
    const frames = [...(entry.page?.frames ?? [])],
      known = new Map(frames.map((frame) => [frame.seq, frame]));
    let cursor = frames.at(-1)?.seq ?? 0;
    for (const frame of page.frames) {
      const previous = known.get(frame.seq);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(frame))
          return apply(entry, null);
        continue;
      }
      if (frame.seq !== cursor + 1) return apply(entry, null);
      frames.push(frame);
      cursor = frame.seq;
    }
    if (
      page.nextCursor > cursor ||
      page.lastSequence < cursor ||
      page.more !== page.nextCursor < page.lastSequence ||
      frames.length > 20_000 ||
      new TextEncoder().encode(JSON.stringify(frames)).byteLength >
        8 * 1024 * 1024
    )
      return apply(entry, null);
    entry.page = {
      ...page,
      frames,
      nextCursor: cursor,
      more: cursor < page.lastSequence,
    };
    entry.loaded = !entry.page.more;
    entry.readError = "";
    if (live) {
      entry.live = true;
      entry.feedInterrupted = false;
    }
    for (const turn of [...page.turns, ...(page.request ? [page.request] : [])])
      confirm(entry, turn);
    tell();
    return true;
  };
  const check = async (projectId: string, id: string) => {
    const entry = session(projectId, id),
      original = entry.pending?.requestId ?? entry.stopping;
    try {
      apply(
        entry,
        await deps.read(projectId, id, {
          after: entry.page?.nextCursor ?? 0,
          ...(original ? { requestId: original } : {}),
        }),
      );
    } catch {
      entry.notice =
        "The original request could not be checked. Keep its identity and check again before retrying.";
      tell();
    }
  };
  const refresh = (projectId: string): Promise<void> => {
    const running = reads.get(projectId);
    if (running) {
      running.again = true;
      return running.work;
    }
    const entry = project(projectId),
      read = { work: Promise.resolve(), again: false };
    reads.set(projectId, read);
    if (!deps.identityServer) hydrateStart(projectId, entry);
    entry.loading = true;
    tell();
    read.work = (async () => {
      try {
        const parsed = listSchema.safeParse(await deps.list(projectId));
        if (disposed) return;
        if (
          !parsed.success ||
          parsed.data.some((item) => item.projectId !== projectId) ||
          new Set(parsed.data.map((item) => item.id)).size !==
            parsed.data.length
        )
          throw new Error("Unverified session list");
        entry.records = parsed.data;
        entry.loaded = true;
        entry.error = "";
        if (entry.pendingStart) {
          const record = entry.records.find(
            (item) => item.requestId === entry.pendingStart?.requestId,
          );
          if (record) {
            if (!sameStart(record, entry.pendingStart))
              throw new Error("Start metadata changed");
            const page = await deps.read(projectId, record.id, {
              after: 0,
              requestId: record.requestId,
            });
            apply(session(projectId, record.id), page);
          }
        }
      } catch {
        if (!disposed)
          entry.error =
            "Sessions could not be verified. The last confirmed list and original Start request have been kept.";
      } finally {
        reads.delete(projectId);
        entry.loading = false;
        tell();
        if (read.again && !disposed) void refresh(projectId);
      }
    })();
    return read.work;
  };
  const postStart = async (projectId: string, retry: boolean) => {
    const entry = project(projectId),
      input = entry.pendingStart;
    if (!input || entry.starting || disposed || !deps.canWrite()) return;
    entry.starting = true;
    entry.notice = "Starting the original session request…";
    tell();
    let outcome: ActionOutcome & { notSent?: true };
    try {
      outcome = await deps.post(
        projectId,
        null,
        "start",
        structuredClone(input),
      );
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The Start outcome is unknown. Check the original request before starting again.",
      };
    }
    if (disposed) return;
    entry.starting = false;
    if (
      outcome.state === "done" &&
      entry.pendingStart?.requestId === input.requestId
    ) {
      const parsed = ownedCodingStartReceiptSchema.safeParse(outcome.data);
      if (
        parsed.success &&
        parsed.data.session.projectId === projectId &&
        sameStart(parsed.data.session, input) &&
        parsed.data.receipt.conversationId === parsed.data.session.id &&
        parsed.data.receipt.turn.requestId === input.requestId
      ) {
        entry.records = [
          ...entry.records.filter(
            (record) => record.id !== parsed.data.session.id,
          ),
          parsed.data.session,
        ];
        const view = session(projectId, parsed.data.session.id);
        view.receiptRevision = Math.max(
          view.receiptRevision,
          parsed.data.receipt.revision,
        );
        confirm(view, parsed.data.receipt.turn);
      } else
        entry.notice =
          "The Start receipt could not be verified. Check the original request.";
    } else if (
      outcome.state !== "done" &&
      entry.pendingStart?.requestId === input.requestId
    ) {
      entry.notice = outcome.message;
      if (
        outcome.state === "refused" &&
        !retry &&
        outcome.notSent &&
        entry.startIdentity &&
        deps.identities
      ) {
        try {
          await deps.identities.release(entry.startIdentity);
          entry.startIdentity = null;
          entry.pendingStart = null;
        } catch {
          entry.startIdentityError =
            "The unsent original Start identity could not be cleared durably. Check it before starting another session.";
          entry.notice = entry.startIdentityError;
        }
      }
    }
    tell();
    await refresh(projectId);
  };
  const postMessage = async (entry: OwnedSessionView, retry: boolean) => {
    const input = entry.pending;
    if (!input || entry.posting || disposed || !deps.canWrite()) return;
    entry.posting = true;
    entry.notice = "Sending the original message…";
    tell();
    let outcome: ActionOutcome;
    try {
      outcome = await deps.post(
        entry.projectId,
        entry.id,
        "turns",
        structuredClone(input),
      );
    } catch {
      outcome = {
        state: "unknown",
        message:
          "Message delivery is unknown. Check the original message before trying again.",
      };
    }
    entry.posting = false;
    if (disposed) return;
    if (
      outcome.state === "done" &&
      entry.pending?.requestId === input.requestId
    ) {
      const parsed = conversationReceiptSchema.safeParse(outcome.data);
      if (
        parsed.success &&
        parsed.data.conversationId === entry.id &&
        parsed.data.turn.requestId === input.requestId
      ) {
        entry.receiptRevision = Math.max(
          entry.receiptRevision,
          parsed.data.revision,
        );
        confirm(entry, parsed.data.turn);
      } else
        entry.notice =
          "The message receipt could not be verified. Check the original request.";
    } else if (
      outcome.state !== "done" &&
      entry.pending?.requestId === input.requestId
    ) {
      entry.notice = outcome.message;
      if (outcome.state === "refused" && !retry) entry.pending = null;
    }
    tell();
    await check(entry.projectId, entry.id);
  };
  const client = {
    worktrees: createSessionWorktreeClient({
      canWrite: deps.canWrite,
      requestId: deps.requestId,
      post: (projectId, input) =>
        deps.createWorktree?.(projectId, input) ??
        Promise.resolve({
          state: "refused",
          message: "Worktree creation is unavailable.",
        }),
      read: (projectId, requestId) =>
        deps.readWorktree?.(projectId, requestId) ??
        Promise.reject(new Error("Worktree lookup unavailable")),
      changed: tell,
    }),
    project,
    session,
    refresh,
    refreshIdentities(projectId?: string) {
      if (deps.identityServer) {
        const reads: Promise<void>[] = [];
        for (const id of projectId ? [projectId] : projects.keys()) {
          if (identityMutations.has(id)) {
            const pending = identityReads.get(id);
            if (pending) pending.again = true;
            continue;
          }
          reads.push(readIdentityPage(id));
        }
        return Promise.all(reads).then(() => undefined);
      }
      for (const [id, entry] of projects) hydrateStart(id, entry);
      tell();
    },
    inspectIdentity,
    async retireIdentity(
      projectId: string,
      requestId: string,
    ): Promise<boolean> {
      if (!deps.identityServer) return false;
      const entry = project(projectId),
        scope = deps.identityScope?.(),
        page = entry.identityPage,
        reserved = page?.identities.find(
          (identity) =>
            identity.requestId === requestId && identity.state === "reserved",
        );
      if (
        !scope ||
        scope.projectId !== projectId ||
        !page ||
        entry.identityGeneration !== scope.generation ||
        entry.identityLoading ||
        !reserved ||
        identityMutations.has(projectId)
      )
        return false;
      identityMutations.add(projectId);
      entry.identityPage = null;
      entry.identityGeneration = null;
      entry.starting = true;
      entry.startIdentityError = "";
      tell();
      let retired = false;
      try {
        const result = await deps.identityServer.retire(scope, reserved);
        if (
          disposed ||
          deps.identityScope?.()?.generation !== scope.generation ||
          result.identity.requestId !== requestId ||
          result.identity.requestHash !== reserved.requestHash ||
          result.identity.state !== "retired"
        )
          return false;
        retired = true;
      } catch {
        if (!disposed)
          entry.startIdentityError =
            "The server could not confirm retirement. The original identity remains held.";
      } finally {
        entry.starting = false;
        identityMutations.delete(projectId);
        if (!disposed) await readIdentityPage(projectId);
      }
      return (
        retired &&
        entry.identityGeneration === scope.generation &&
        currentIdentityPage(projectId)?.identities.some(
          (identity) =>
            identity.requestId === requestId && identity.state === "retired",
        ) === true
      );
    },
    async resumeStart(
      projectId: string,
      input: OwnedSessionStartInput,
    ): Promise<void> {
      if (!deps.identityServer) return;
      const entry = project(projectId),
        scope = deps.identityScope?.(),
        page = entry.identityPage,
        candidates =
          page?.identities.filter((identity) =>
            ["reserved", "not-sent"].includes(identity.state),
          ) ?? [];
      if (
        !scope ||
        scope.projectId !== projectId ||
        !page ||
        entry.identityGeneration !== scope.generation ||
        entry.identityLoading ||
        candidates.length !== 1 ||
        entry.legacyIdentityError ||
        entry.starting ||
        entry.pendingStart ||
        identityMutations.has(projectId) ||
        !deps.canWrite()
      )
        return;
      const original = candidates[0];
      if (!original) return;
      const request = makeStartRequest(input, original.requestId);
      identityMutations.add(projectId);
      entry.starting = true;
      entry.startIdentityError = "";
      entry.notice = "Verifying the re-entered original Start request…";
      tell();
      try {
        const requestHash = await sessionStartHash(request);
        const currentScope = deps.identityScope?.();
        if (
          disposed ||
          !currentScope ||
          currentScope.generation !== scope.generation ||
          entry.identityPage !== page ||
          requestHash !== original.requestHash ||
          entry.identityLoading
        ) {
          entry.notice =
            "The re-entered request does not match the held original, or its scope changed. Nothing was sent.";
          return;
        }
        entry.pendingStart = request;
        const reserved = await deps.identityServer!.reserve(scope, request);
        if (
          disposed ||
          deps.identityScope?.()?.generation !== scope.generation ||
          reserved.identity.state !== original.state ||
          reserved.identity.requestId !== original.requestId ||
          reserved.identity.requestHash !== original.requestHash ||
          reserved.requestHash !== original.requestHash ||
          reserved.identity.provider !== original.provider ||
          reserved.identity.mode !== original.mode ||
          canonicalOwnedSessionStart(reserved.request) !==
            canonicalOwnedSessionStart(request)
        ) {
          entry.identityPage = null;
          entry.identityGeneration = null;
          entry.notice =
            "The server could not confirm the exact original Start. Nothing was sent again.";
          return;
        }
        entry.startIdentity = metadataProjection(projectId, reserved.identity);
        entry.pendingStart = reserved.request as SessionStartRequest;
        entry.identityPage = null;
        entry.identityGeneration = null;
        entry.starting = false;
        await postStart(projectId, true);
      } catch {
        if (!disposed) {
          entry.identityPage = null;
          entry.identityGeneration = null;
          entry.startIdentityError =
            "The original Start could not be verified. No request was sent again.";
        }
      } finally {
        entry.starting = false;
        identityMutations.delete(projectId);
        tell();
        if (!disposed) await readIdentityPage(projectId);
      }
    },
    check,
    /** The proposal bridge already verified the full original body/hash; never dispatch here. */
    adoptStartReceipt(
      projectId: string,
      input: ClaudeSessionStartRequest,
      raw: unknown,
    ) {
      const parsed = sessionStartReceiptSchema.safeParse(raw);
      if (
        disposed ||
        !parsed.success ||
        parsed.data.session.origin !== undefined ||
        parsed.data.session.projectId !== projectId ||
        !sameStart(parsed.data.session, input) ||
        parsed.data.receipt.conversationId !== parsed.data.session.id ||
        parsed.data.receipt.turn.requestId !== input.requestId
      )
        return false;
      const entry = project(projectId),
        accepted = parsed.data;
      entry.records = [
        ...entry.records.filter((record) => record.id !== accepted.session.id),
        accepted.session,
      ];
      const observed = session(projectId, accepted.session.id);
      observed.receiptRevision = Math.max(
        observed.receiptRevision,
        accepted.receipt.revision,
      );
      tell();
      return true;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    editComposer(projectId: string, update: Partial<SessionComposerDraft>) {
      project(projectId).composer = {
        ...project(projectId).composer,
        ...update,
      };
      tell();
    },
    chooseComposerProvider(
      projectId: string,
      provider: "claude" | "codex" | "gemini",
    ) {
      project(projectId).composerProvider = provider;
      tell();
    },
    chooseCodexMode(projectId: string, mode: "task" | "chat") {
      project(projectId).codexMode = mode;
      tell();
    },
    editCodexChatComposer(
      projectId: string,
      update: Partial<CodexChatComposerDraft>,
    ) {
      project(projectId).codexChatComposer = {
        ...project(projectId).codexChatComposer,
        ...update,
      };
      tell();
    },
    editCodexComposer(
      projectId: string,
      update: Partial<CodexTaskComposerDraft>,
    ) {
      project(projectId).codexComposer = {
        ...project(projectId).codexComposer,
        ...update,
      };
      tell();
    },
    editGeminiComposer(
      projectId: string,
      update: Partial<GeminiTaskComposerDraft>,
    ) {
      project(projectId).geminiComposer = {
        ...project(projectId).geminiComposer,
        ...update,
      };
      tell();
    },
    chooseGeminiMode(projectId: string, mode: "task" | "chat") {
      project(projectId).geminiMode = mode;
      tell();
    },
    editGeminiChatComposer(
      projectId: string,
      update: Partial<GeminiChatComposerDraft>,
    ) {
      project(projectId).geminiChatComposer = {
        ...project(projectId).geminiChatComposer,
        ...update,
      };
      tell();
    },
    draft(projectId: string, id: string, text: string) {
      session(projectId, id).draft = text;
      tell();
    },
    editMessage(
      projectId: string,
      id: string,
      update: {
        attachments?: SessionAttachment[];
        about?: ConversationObject[];
      },
    ) {
      if (update.attachments) validateSessionAttachments(update.attachments);
      Object.assign(session(projectId, id), structuredClone(update));
      tell();
    },
    async start(projectId: string, input: OwnedSessionStartInput) {
      const entry = project(projectId);
      if (disposed || entry.pendingStart || entry.starting || !deps.canWrite())
        return;
      if (deps.identityServer) {
        const scope = deps.identityScope?.();
        if (
          !scope ||
          scope.projectId !== projectId ||
          !entry.identityPage ||
          entry.identityGeneration !== scope.generation ||
          entry.identityPage.scope.projectId !== projectId ||
          entry.identityLoading ||
          entry.startIdentityError ||
          entry.legacyIdentityError ||
          entry.identityPage.identities.some((identity) =>
            ["reserved", "attempted", "not-sent"].includes(identity.state),
          )
        ) {
          entry.startIdentityError ||=
            "The server identity page is not ready. Check it before starting a session.";
          tell();
          return;
        }
        let request: SessionStartRequest;
        try {
          request = makeStartRequest(input, deps.requestId());
        } catch {
          entry.startIdentityError =
            "The original Start request could not be verified. Nothing was sent.";
          tell();
          return;
        }
        entry.pendingStart = request;
        entry.starting = true;
        entry.startIdentityError = "";
        identityMutations.add(projectId);
        tell();
        try {
          try {
            const reserved = await deps.identityServer.reserve(scope, request);
            if (
              disposed ||
              deps.identityScope?.()?.generation !== scope.generation
            )
              return;
            entry.identityPage = null;
            entry.identityGeneration = null;
            entry.startIdentity = metadataProjection(
              projectId,
              reserved.identity,
            );
            if (
              reserved.identity.state !== "reserved" ||
              reserved.identity.requestId !== request.requestId ||
              reserved.identity.requestHash !== reserved.requestHash ||
              reserved.identity.provider !== startProvider(request) ||
              reserved.identity.mode !== request.launch.mode ||
              reserved.request.requestId !== request.requestId ||
              canonicalOwnedSessionStart(reserved.request) !==
                canonicalOwnedSessionStart(request)
            ) {
              entry.notice =
                "The original Start remains held. Check its protected server state before continuing.";
              return;
            }
            entry.pendingStart = reserved.request as SessionStartRequest;
          } catch {
            if (!disposed) {
              entry.startIdentityError =
                "The server could not verify this Start identity. No second request was sent.";
              entry.notice = entry.startIdentityError;
            }
            return;
          } finally {
            entry.starting = false;
            tell();
          }
          if (disposed) return;
          await postStart(projectId, false);
        } finally {
          identityMutations.delete(projectId);
          if (!disposed) await readIdentityPage(projectId);
        }
        return;
      }
      if (!deps.identities) return;
      entry.starting = true;
      tell();
      try {
        const held = await deps.identities.reserve(
          projectId,
          input,
          deps.requestId,
        );
        entry.startIdentity = held.identity;
        entry.startIdentityError = "";
        if (!held.created || !held.request) {
          entry.notice =
            "The original Start is still held. Check its protected admission before starting another session.";
          return;
        }
        entry.pendingStart = held.request;
      } catch {
        entry.startIdentityError =
          "The original Start identity could not be saved and verified. No request was sent. Saved identities were kept.";
        entry.notice = entry.startIdentityError;
        return;
      } finally {
        entry.starting = false;
        tell();
      }
      if (disposed) return;
      await postStart(projectId, false);
    },
    async retryStart(projectId: string) {
      if (!deps.identityServer) return postStart(projectId, true);
      const entry = project(projectId),
        scope = deps.identityScope?.(),
        request = entry.pendingStart;
      if (
        !scope ||
        scope.projectId !== projectId ||
        !request ||
        entry.starting ||
        disposed ||
        !deps.canWrite()
      )
        return;
      identityMutations.add(projectId);
      entry.starting = true;
      entry.startIdentityError = "";
      tell();
      try {
        const page = await deps.identityServer!.list(scope);
        if (disposed || deps.identityScope?.()?.generation !== scope.generation)
          return;
        const current = page.identities.find(
          (identity) => identity.requestId === request.requestId,
        );
        const currentHash = await sessionStartHash(request);
        if (disposed || deps.identityScope?.()?.generation !== scope.generation)
          return;
        if (
          !current ||
          !["reserved", "not-sent"].includes(current.state) ||
          entry.startIdentity?.requestId !== current.requestId ||
          entry.startIdentity.requestHash !== current.requestHash ||
          entry.startIdentity.provider !== current.provider ||
          current.provider !== startProvider(request) ||
          current.mode !== request.launch.mode ||
          currentHash !== current.requestHash
        ) {
          entry.identityPage = page;
          entry.identityGeneration = scope.generation;
          entry.startIdentity = current
            ? metadataProjection(projectId, current)
            : null;
          entry.notice =
            "The original Start is still held. Check its current server state; it was not sent again.";
          return;
        }
        const reserved = await deps.identityServer!.reserve(scope, request);
        if (
          disposed ||
          deps.identityScope?.()?.generation !== scope.generation ||
          reserved.identity.state !== current.state ||
          reserved.requestHash !== current.requestHash ||
          reserved.identity.requestId !== request.requestId ||
          reserved.identity.requestHash !== reserved.requestHash ||
          reserved.identity.provider !== startProvider(request) ||
          reserved.identity.mode !== request.launch.mode ||
          reserved.request.requestId !== request.requestId ||
          canonicalOwnedSessionStart(reserved.request) !==
            canonicalOwnedSessionStart(request)
        ) {
          entry.identityPage = null;
          entry.identityGeneration = null;
          entry.notice =
            "The original Start identity could not be revalidated. It was not sent again.";
          return;
        }
        entry.startIdentity = metadataProjection(projectId, reserved.identity);
        entry.pendingStart = reserved.request as SessionStartRequest;
        entry.identityPage = null;
        entry.identityGeneration = null;
        entry.starting = false;
        await postStart(projectId, true);
      } catch {
        if (!disposed) {
          entry.identityPage = null;
          entry.identityGeneration = null;
          entry.startIdentityError =
            "The original Start state could not be verified. It was not sent again.";
        }
      } finally {
        entry.starting = false;
        identityMutations.delete(projectId);
        tell();
        if (!disposed) await readIdentityPage(projectId);
      }
    },
    identityScopeChanged() {
      for (const [id, read] of identityReads) {
        read.controller.abort();
        identityReads.delete(id);
        const entry = projects.get(id);
        if (entry) {
          entry.identityPage = null;
          entry.identityGeneration = null;
          entry.identityLoading = false;
          entry.identityInspection = null;
        }
      }
      tell();
    },
    canSend(projectId: string, id: string) {
      const entry = session(projectId, id),
        record = project(projectId).records.find((item) => item.id === id);
      return (
        !disposed &&
        deps.canWrite() &&
        record?.mode === "chat" &&
        !!entry.page?.binding &&
        entry.loaded &&
        entry.live &&
        !!entry.draft.trim() &&
        entry.draft.length <= 16_384 &&
        !entry.pending &&
        !entry.posting &&
        !entry.stopping &&
        !entry.stopPosting &&
        (entry.page?.revision ?? -1) >= entry.receiptRevision &&
        !entry.page?.turns.some(held)
      );
    },
    async send(projectId: string, id: string) {
      const entry = session(projectId, id);
      if (!client.canSend(projectId, id)) return;
      entry.pending = {
        requestId: deps.requestId(),
        expectedRevision: entry.page?.revision ?? 0,
        text: entry.draft,
        about: structuredClone(entry.about),
        attachments: structuredClone(entry.attachments),
      };
      await postMessage(entry, false);
    },
    retryMessage: (projectId: string, id: string) =>
      postMessage(session(projectId, id), true),
    async stop(projectId: string, id: string, retry = false) {
      const entry = session(projectId, id),
        current = entry.page?.turns.find((turn) => active(turn.phase));
      const requestId = retry ? entry.stopping : current?.requestId;
      if (
        !requestId ||
        entry.stopPosting ||
        !entry.page?.controllable ||
        !deps.canWrite() ||
        (!retry && entry.stopping)
      )
        return;
      entry.stopping = requestId;
      entry.stopPosting = true;
      entry.notice = "Stopping… waiting for the provider process to end.";
      tell();
      let outcome: ActionOutcome;
      try {
        outcome = await deps.post(projectId, id, "stop", { requestId });
      } catch {
        outcome = {
          state: "unknown",
          message: "Stop outcome is unknown. Check the original turn.",
        };
      }
      entry.stopPosting = false;
      if (disposed) return;
      if (outcome.state !== "done" && entry.stopping === requestId) {
        entry.notice = outcome.message;
        entry.stopUnknown = true;
      } else if (outcome.state === "done" && entry.stopping === requestId) {
        const receipt = conversationReceiptSchema.safeParse(outcome.data);
        if (
          !receipt.success ||
          receipt.data.conversationId !== id ||
          receipt.data.turn.requestId !== requestId
        ) {
          entry.stopUnknown = true;
          entry.notice =
            "The Stop receipt could not be verified. Check the original turn.";
        }
      }
      tell();
      await check(projectId, id);
    },
    activate(projectId: string | null, id: string | null) {
      if (selected?.projectId === projectId && selected?.id === id) return;
      generation++;
      cancelSavedRead?.();
      cancelSavedRead = null;
      disconnect();
      if (selected) {
        selected.page = null;
        selected.loaded = false;
        selected.live = false;
        selected.feedInterrupted = false;
        selected.readError = "";
      }
      selected = projectId && id ? session(projectId, id) : null;
      tell();
      if (!selected || disposed) return;
      const entry = selected,
        epoch = generation;
      let failures = 0;
      let fallbackUsed = false;
      let savedRead: { cancelled: boolean; timer: unknown } | null = null;
      const current = () =>
        !disposed && generation === epoch && selected === entry;
      cancelSavedRead = () => {
        if (!savedRead) return;
        savedRead.cancelled = true;
        timers.clear(savedRead.timer);
        savedRead = null;
      };
      const readSaved = () => {
        if (!current() || entry.live || fallbackUsed) return;
        fallbackUsed = true;
        const attempt: { cancelled: boolean; timer: unknown } = {
          cancelled: false,
          timer: null,
        };
        savedRead = attempt;
        const valid = () => current() && !attempt.cancelled && !entry.live;
        attempt.timer = timers.set(() => {
          if (!valid()) return;
          attempt.cancelled = true;
          entry.readError =
            "The saved conversation read reached its time limit. Earlier private activity was kept. Reload to check it again.";
          tell();
        }, 5000);
        void (async () => {
          try {
            for (let pages = 0; pages < 200 && valid(); pages++) {
              const after = entry.page?.nextCursor ?? 0;
              const original = entry.pending?.requestId ?? entry.stopping;
              const raw = await deps.read(entry.projectId, entry.id, {
                after,
                ...(original ? { requestId: original } : {}),
              });
              if (!valid()) return;
              if (!apply(entry, raw)) return;
              if (!entry.page?.more) return;
              if (entry.page.nextCursor <= after)
                throw Error("Saved cursor did not advance");
            }
            if (valid()) throw Error("Saved page limit reached");
          } catch {
            if (valid()) {
              entry.readError =
                "The saved conversation could not be fully read within its safety limits. Earlier private activity was kept. Reload to check it again.";
              tell();
            }
          } finally {
            timers.clear(attempt.timer);
            if (savedRead === attempt) savedRead = null;
          }
        })();
      };
      const open = () => {
        if (!current()) return;
        const deadline = (ms: number) => {
          if (timer !== null) timers.clear(timer);
          timer = timers.set(fail, ms);
        };
        deadline(20_000);
        connection = deps.stream(entry.projectId, entry.id)(
          entry.page?.nextCursor ?? 0,
          {
            onOpen() {
              if (current()) deadline(45_000);
            },
            onActivity() {
              if (current()) deadline(45_000);
            },
            onMessage(message) {
              if (!current()) return;
              if (message.event !== "conversation") {
                apply(entry, null);
                return;
              }
              let value: unknown;
              try {
                value = JSON.parse(message.data);
              } catch {
                apply(entry, null);
                return;
              }
              if (apply(entry, value, true)) {
                fallbackUsed = false;
                cancelSavedRead?.();
              }
            },
            onEnd() {
              fail();
            },
          },
        );
      };
      const fail = () => {
        if (!current()) return;
        disconnect();
        entry.live = false;
        entry.feedInterrupted = true;
        failures++;
        entry.notice =
          failures >= 6
            ? "Session updates are unavailable. Reload the saved conversation."
            : "Session updates were interrupted. Reconnecting to the saved cursor…";
        tell();
        readSaved();
        if (failures < 6)
          timer = timers.set(open, Math.min(8_000, 500 * 2 ** (failures - 1)));
      };
      open();
    },
    reload(projectId: string, id: string) {
      if (selected?.projectId === projectId && selected.id === id) {
        client.activate(null, null);
        client.activate(projectId, id);
      }
    },
    dispose() {
      cancelSavedRead?.();
      cancelSavedRead = null;
      disposed = true;
      generation++;
      for (const read of identityReads.values()) read.controller.abort();
      identityReads.clear();
      disconnect();
      listeners.clear();
    },
  };
  return client;
}
export type SessionsClient = ReturnType<typeof createSessionsClient>;
