import { z } from "zod";
import type { ActionOutcome } from "../../../docs/js/action-outcome";
import { REAL_TIMERS, type Timers } from "../../../docs/js/hearth-read";
import type { StreamTransport } from "../../../docs/js/use-stream";
import {
  conversationPageSchema,
  conversationReceiptSchema,
} from "../../../scripts/conversations/protocol";
import {
  ownedSessionSchema,
  sessionStartReceiptSchema,
} from "../../../scripts/sessions/protocol";
import type {
  ConversationObject,
  ConversationPage,
  ConversationReceipt,
  ConversationTurn,
} from "../../../types/conversation";
import type { OwnedSessionRecord } from "../../../types/owned-session";
import type { SessionAttachment } from "../../../types/session-launch";
import type { SessionStartRequest } from "../../../types/session-requests";
import type { SessionMessage } from "../../../types/session-turn";
import type { SessionWorktreeRequest } from "../../../types/session-worktrees";
import {
  newSessionDraft,
  type SessionComposerDraft,
  validateSessionAttachments,
} from "./session-composer";
import { createSessionWorktreeClient } from "./session-worktree-client";

const listSchema = z.array(ownedSessionSchema).max(1000);
const active = (phase: string) =>
  ["accepted", "running", "cancelling"].includes(phase);
const held = (turn: ConversationTurn) =>
  active(turn.phase) || turn.phase === "unknown";
const sameStart = (record: OwnedSessionRecord, input: SessionStartRequest) =>
  record.requestId === input.requestId &&
  record.smith === input.smith &&
  record.repository === input.repository &&
  record.worktree === input.worktree &&
  record.mode === input.launch.mode &&
  record.requestedModel === input.launch.model &&
  record.requestedEffort === (input.launch.effort ?? null) &&
  record.beadId === input.beadId;
export interface SessionProjectView {
  records: OwnedSessionRecord[];
  loaded: boolean;
  loading: boolean;
  error: string;
  composer: SessionComposerDraft;
  pendingStart: SessionStartRequest | null;
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
  ): Promise<ActionOutcome>;
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
  const timers = deps.timers ?? REAL_TIMERS;
  let selected: OwnedSessionView | null = null,
    connection: { close(): void } | null = null,
    timer: unknown = null,
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
        pendingStart: null,
        starting: false,
        notice: "",
        lastStarted: null,
      };
      projects.set(id, value);
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
    if (view.pendingStart?.requestId === turn.requestId) {
      const record = view.records.find(
        (item) => item.id === entry.id && item.requestId === turn.requestId,
      );
      if (record) {
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
        view.pendingStart = null;
        view.lastStarted = record.id;
        view.notice =
          "The original Start is recorded. The session is available.";
      }
    }
  };
  const apply = (
    entry: OwnedSessionView,
    raw: unknown,
    live = false,
  ): boolean => {
    const parsed = conversationPageSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.projectId !== entry.projectId ||
      parsed.data.conversationId !== entry.id
    ) {
      entry.live = false;
      entry.notice =
        "The session update could not be verified. Reload the saved conversation; partial text has been kept.";
      if (selected === entry) {
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
    if (live) entry.live = true;
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
    let outcome: ActionOutcome;
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
      const parsed = sessionStartReceiptSchema.safeParse(outcome.data);
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
      if (outcome.state === "refused" && !retry) entry.pendingStart = null;
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
    check,
    /** The proposal bridge already verified the full original body/hash; never dispatch here. */
    adoptStartReceipt(
      projectId: string,
      input: SessionStartRequest,
      raw: unknown,
    ) {
      const parsed = sessionStartReceiptSchema.safeParse(raw);
      if (
        disposed ||
        !parsed.success ||
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
    async start(
      projectId: string,
      input: Omit<SessionStartRequest, "requestId">,
    ) {
      const entry = project(projectId);
      if (disposed || entry.pendingStart || entry.starting || !deps.canWrite())
        return;
      entry.pendingStart = structuredClone({
        ...input,
        requestId: deps.requestId(),
      });
      await postStart(projectId, false);
    },
    retryStart: (projectId: string) => postStart(projectId, true),
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
      disconnect();
      if (selected) {
        selected.page = null;
        selected.loaded = false;
        selected.live = false;
      }
      selected = projectId && id ? session(projectId, id) : null;
      tell();
      if (!selected || disposed) return;
      const entry = selected,
        epoch = generation;
      let failures = 0;
      const current = () =>
        !disposed && generation === epoch && selected === entry;
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
              apply(entry, value, true);
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
        failures++;
        entry.notice =
          failures >= 6
            ? "Session updates are unavailable. Reload the saved conversation."
            : "Session updates were interrupted. Reconnecting to the saved cursor…";
        tell();
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
      disposed = true;
      generation++;
      disconnect();
      listeners.clear();
    },
  };
  return client;
}
export type SessionsClient = ReturnType<typeof createSessionsClient>;
