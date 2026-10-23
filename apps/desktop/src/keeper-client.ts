import type { ActionOutcome } from "../../../docs/js/action-outcome";
import { REAL_TIMERS, type Timers } from "../../../docs/js/hearth-read";
import type { StreamTransport } from "../../../docs/js/use-stream";
import {
  conversationPageSchema,
  conversationReceiptSchema,
} from "../../../scripts/conversations/protocol";
import {
  KEEPER_BRIEF_REQUEST,
  parseKeeperBrief,
} from "../../../scripts/keeper/brief-model";
import { briefsSchema } from "../../../scripts/keeper/brief-protocol";
import { KEEPER_OBJECT_READS } from "../../../scripts/keeper/objects";
import type {
  ConversationObject,
  ConversationPage,
  ConversationSend,
  ConversationTurn,
} from "../../../types/conversation";
import type { KeeperReadQuery } from "../../../types/keeper";
import type { KeeperBriefs } from "../../../types/keeper-brief";
import type { KeeperContinuationRequest } from "../../../types/keeper-recovery";
import { type KeeperAbout, keeperObjects } from "./keeper-context";
import { createKeeperRecoveryClient } from "./keeper-recovery-client";
import { type KeeperSessionSelection, keeperSession } from "./keeper-session";

export interface KeeperView {
  projectId: string;
  draft: string;
  about: KeeperAbout[];
  page: ConversationPage | null;
  loaded: boolean;
  live: boolean;
  pending: ConversationSend | null;
  pendingKind: "turns" | "briefs";
  posting: boolean;
  stopping: string | null;
  stopPosting: boolean;
  stopUnknown: boolean;
  notice: string;
  admitted: ConversationTurn | null;
  receiptRevision: number;
  briefs: KeeperBriefs | null;
  briefsError: string | null;
  briefsLoading: boolean;
}
interface Deps {
  stream(projectId: string): StreamTransport;
  read(
    projectId: string,
    query: { after: number; requestId?: string },
  ): Promise<unknown>;
  post(
    projectId: string,
    action: "turns" | "stop" | "briefs" | "continuations",
    body:
      | ConversationSend
      | KeeperContinuationRequest
      | { requestId: string; expectedRevision?: number },
  ): Promise<ActionOutcome>;
  requestId(): string;
  canWrite(): boolean;
  readBriefs?: ((projectId: string) => Promise<unknown>) | undefined;
  readRecovery?:
    | ((projectId: string, requestId?: string) => Promise<unknown>)
    | undefined;
  readObjects?:
    | ((projectId: string, query: KeeperReadQuery) => Promise<unknown>)
    | undefined;
  timers?: Timers;
  now?: () => number;
}
const active = (phase: string) =>
  ["accepted", "running", "cancelling"].includes(phase);
const held = (turn: ConversationTurn) =>
  active(turn.phase) || turn.phase === "unknown";

/** One app-root owner: full page and drawer are observers of this same client. */
export function createKeeperClient(deps: Deps) {
  const entries = new Map<string, KeeperView>();
  const listeners = new Set<() => void>();
  const briefReads = new Map<
    string,
    { promise: Promise<void>; again: boolean }
  >();
  const briefKeys = new Map<string, string>();
  const recoveryKeys = new Map<string, string>();
  const timers = deps.timers ?? REAL_TIMERS;
  const now = deps.now ?? Date.now;
  let selected: string | null = null;
  let generation = 0;
  let connection: { close(): void } | null = null;
  let timer: unknown = null;
  let disposed = false;
  const get = (projectId: string): KeeperView => {
    let entry = entries.get(projectId);
    if (!entry) {
      entry = {
        projectId,
        draft: "",
        about: [],
        page: null,
        loaded: false,
        live: false,
        pending: null,
        pendingKind: "turns",
        posting: false,
        stopping: null,
        stopPosting: false,
        stopUnknown: false,
        notice: "",
        admitted: null,
        receiptRevision: 0,
        briefs: null,
        briefsError: null,
        briefsLoading: false,
      };
      entries.set(projectId, entry);
    }
    return entry;
  };
  const tell = () => {
    for (const listener of [...listeners]) listener();
  };
  const recovery: ReturnType<typeof createKeeperRecoveryClient> | null =
    deps.readRecovery
      ? createKeeperRecoveryClient({
          read: (id, requestId) =>
            deps.readRecovery?.(id, requestId) ??
            Promise.reject(new Error("Recovery unavailable")),
          post: (id, input) => deps.post(id, "continuations", input),
          requestId: deps.requestId,
          canChange: (id) => canStart(id, true),
          revision: (id) => get(id).page?.revision ?? 0,
          changed: tell,
          confirmed: (id) => {
            void check(id);
          },
        })
      : null;
  const loadBriefs = (projectId: string, force = false): Promise<void> => {
    if (disposed || !deps.readBriefs) return Promise.resolve();
    const entry = get(projectId);
    const running = briefReads.get(projectId);
    if (running) {
      running.again ||= force;
      return running.promise;
    }
    if (entry.briefs && !force) return Promise.resolve();
    const read = { promise: Promise.resolve(), again: false };
    briefReads.set(projectId, read);
    entry.briefsLoading = true;
    entry.briefsError = null;
    tell();
    read.promise = (async () => {
      try {
        const result = briefsSchema.safeParse(
          await deps.readBriefs?.(projectId),
        );
        if (disposed) return;
        if (
          !result.success ||
          result.data.projectId !== projectId ||
          [result.data.latest, ...result.data.earlier].some(
            (brief) =>
              brief &&
              (brief.snapshot.projectId !== projectId ||
                !parseKeeperBrief(
                  JSON.stringify(brief.content),
                  brief.snapshot,
                )),
          )
        )
          throw new Error("Invalid brief projection");
        if (!entry.briefs || result.data.revision >= entry.briefs.revision)
          entry.briefs = result.data;
      } catch {
        if (!disposed)
          entry.briefsError =
            "The brief read could not be verified. The last confirmed brief has been kept.";
      } finally {
        briefReads.delete(projectId);
        entry.briefsLoading = false;
        if (!disposed) {
          tell();
          if (read.again) void loadBriefs(projectId, true);
        }
      }
    })();
    return read.promise;
  };
  const cancelTimer = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const disconnect = () => {
    cancelTimer();
    connection?.close();
    connection = null;
  };
  const freeze = (entry: KeeperView) => {
    if (selected === entry.projectId) {
      generation++;
      disconnect();
    }
    entry.live = false;
    entry.notice =
      "The conversation update could not be verified. Reload the conversation; saved partial text has been kept.";
    tell();
  };
  const confirm = (entry: KeeperView, turn: ConversationTurn) => {
    if (entry.pending?.requestId === turn.requestId) {
      if (entry.pendingKind === "turns") {
        if (
          entry.about.length === entry.pending.about.length &&
          entry.about.every(
            (ref, index) =>
              ref.kind === entry.pending?.about[index]?.kind &&
              ref.id === entry.pending?.about[index]?.id,
          )
        )
          entry.about = [];
        if (entry.draft.trim() === entry.pending.text) entry.draft = "";
      }
      entry.pending = null;
      entry.admitted = turn;
      entry.notice = "The original request is recorded in this conversation.";
    }
    if (entry.admitted?.requestId === turn.requestId) entry.admitted = turn;
    if (entry.stopping === turn.requestId && !active(turn.phase)) {
      entry.stopping = null;
      entry.stopUnknown = false;
      entry.notice =
        turn.phase === "cancelled"
          ? "Stop confirmed."
          : turn.phase === "unknown"
            ? "The turn's completion is unknown."
            : "The turn has ended.";
    }
  };
  const apply = (
    entry: KeeperView,
    raw: unknown,
    fromStream = true,
  ): boolean => {
    const parsed = conversationPageSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.projectId !== entry.projectId ||
      parsed.data.conversationId !== `keeper-${entry.projectId}`
    ) {
      freeze(entry);
      return false;
    }
    const page = parsed.data;
    if (entry.page && page.revision < entry.page.revision) return true;
    const frames = [...(entry.page?.frames ?? [])];
    const known = new Map(frames.map((frame) => [frame.seq, frame]));
    let cursor = frames.at(-1)?.seq ?? 0;
    for (const frame of page.frames) {
      const prior = known.get(frame.seq);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(frame)) {
          freeze(entry);
          return false;
        }
        continue;
      }
      if (frame.seq !== cursor + 1) {
        freeze(entry);
        return false;
      }
      frames.push(frame);
      known.set(frame.seq, frame);
      cursor = frame.seq;
    }
    if (
      page.nextCursor > cursor ||
      page.lastSequence < cursor ||
      page.more !== page.nextCursor < page.lastSequence ||
      frames.length > 20_000 ||
      serializedBytes(frames) > 8 * 1024 * 1024
    ) {
      freeze(entry);
      return false;
    }
    const more = cursor < page.lastSequence;
    entry.page = { ...page, frames, nextCursor: cursor, more };
    const recoveryKey = `${page.keeperRecovery?.generation ?? 0}:${[...frames].reverse().find((frame) => frame.event.kind === "process")?.seq ?? 0}`;
    if (recoveryKeys.get(entry.projectId) !== recoveryKey) {
      recoveryKeys.set(entry.projectId, recoveryKey);
      void recovery?.read(entry.projectId);
    }
    entry.loaded = !more;
    if (fromStream) entry.live = true;
    for (const turn of [...page.turns, ...(page.request ? [page.request] : [])])
      confirm(entry, turn);
    const briefIds = new Set(
      frames
        .filter((frame) => frame.event.kind === "user" && frame.event.brief)
        .map((frame) => frame.turnId),
    );
    const briefKey = page.turns
      .filter((turn) => briefIds.has(turn.requestId))
      .map((turn) => `${turn.requestId}:${turn.phase}`)
      .join("|");
    if (briefKeys.get(entry.projectId) !== briefKey) {
      briefKeys.set(entry.projectId, briefKey);
      void loadBriefs(entry.projectId, true);
    }
    tell();
    return true;
  };
  const connect = (projectId: string) => {
    const epoch = ++generation;
    const entry = get(projectId);
    let failures = 0;
    const current = () =>
      !disposed && epoch === generation && selected === projectId;
    const fail = () => {
      if (!current()) return;
      disconnect();
      entry.live = false;
      failures++;
      entry.notice =
        failures >= 6
          ? "Conversation live updates are unavailable. Reload the conversation to check again."
          : "Conversation updates were interrupted. Reconnecting to the saved cursor…";
      tell();
      if (failures < 6)
        timer = timers.set(open, Math.min(8_000, 500 * 2 ** (failures - 1)));
    };
    const deadline = (ms: number) => {
      cancelTimer();
      timer = timers.set(fail, ms);
    };
    const open = () => {
      if (!current()) return;
      const openedAt = now();
      deadline(20_000);
      connection = deps.stream(projectId)(entry.page?.frames.at(-1)?.seq ?? 0, {
        onOpen() {
          if (current()) deadline(45_000);
        },
        onActivity() {
          if (current()) deadline(45_000);
        },
        onMessage(message) {
          if (!current()) return;
          if (message.event !== "conversation") {
            freeze(entry);
            return;
          }
          let value: unknown;
          try {
            value = JSON.parse(message.data);
          } catch {
            freeze(entry);
            return;
          }
          if (apply(entry, value) && now() - openedAt >= 5_000) failures = 0;
        },
        onEnd() {
          fail();
        },
      });
    };
    open();
  };
  const check = async (projectId: string) => {
    const entry = get(projectId);
    const requestId = entry.pending?.requestId ?? entry.stopping ?? undefined;
    try {
      const value = await deps.read(projectId, {
        after: entry.page?.frames.at(-1)?.seq ?? 0,
        ...(requestId ? { requestId } : {}),
      });
      if (!disposed && apply(entry, value, false) && entry.pending)
        entry.notice =
          "The original request is not confirmed yet. Check again or retry that same request; a new message is held.";
    } catch {
      entry.notice =
        "The conversation could not be checked. The original request is still held.";
    }
    tell();
  };
  const postTurn = async (
    entry: KeeperView,
    input: ConversationSend,
    previouslyUnknown: boolean,
  ) => {
    entry.posting = true;
    tell();
    let outcome: ActionOutcome;
    try {
      outcome = await deps.post(
        entry.projectId,
        entry.pendingKind,
        entry.pendingKind === "briefs"
          ? {
              requestId: input.requestId,
              expectedRevision: input.expectedRevision,
            }
          : input,
      );
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The send response was lost. Check the original request before sending again.",
      };
    }
    entry.posting = false;
    if (entry.pending?.requestId !== input.requestId) {
      tell();
      return;
    }
    if (outcome.state === "done") {
      const result = conversationReceiptSchema.safeParse(outcome.data);
      if (
        result.success &&
        result.data.conversationId === `keeper-${entry.projectId}` &&
        result.data.turn.requestId === input.requestId
      ) {
        entry.receiptRevision = Math.max(
          entry.receiptRevision,
          result.data.revision,
        );
        confirm(entry, result.data.turn);
      } else
        entry.notice =
          "The send receipt could not be verified. Check the original request.";
    } else {
      entry.notice = outcome.message;
      if (outcome.state === "refused" && !previouslyUnknown)
        entry.pending = null;
    }
    tell();
    if (entry.pending && selected === entry.projectId)
      await check(entry.projectId);
  };
  const canStart = (projectId: string, changing = false): boolean => {
    const entry = get(projectId);
    return (
      !disposed &&
      deps.canWrite() &&
      entry.live &&
      entry.loaded &&
      (entry.page?.revision ?? -1) >= entry.receiptRevision &&
      !entry.pending &&
      !entry.posting &&
      !entry.stopping &&
      !entry.stopPosting &&
      !entry.page?.turns.some(held) &&
      !(entry.admitted && held(entry.admitted)) &&
      (changing || !recovery || recovery.canStart(projectId))
    );
  };
  const canSend = (projectId: string) => {
    const entry = get(projectId);
    return (
      canStart(projectId) &&
      entry.about.every((ref) => ref.status === "ready") &&
      Boolean(entry.draft.trim()) &&
      entry.draft.trim().length <= 16_384
    );
  };
  const client = {
    get,
    recovery,
    canSend,
    loadBriefs,
    canRefreshBrief: canStart,
    async refreshBrief(projectId: string) {
      if (!canStart(projectId)) return;
      const entry = get(projectId);
      entry.pendingKind = "briefs";
      entry.pending = {
        requestId: deps.requestId(),
        expectedRevision: entry.page?.revision ?? 0,
        text: KEEPER_BRIEF_REQUEST,
        about: [],
      };
      await postTurn(entry, entry.pending, false);
    },
    check,
    async objects(
      projectId: string,
      kind: ConversationObject["kind"],
      id?: string,
    ) {
      if (!deps.readObjects) throw new Error("Object context is unavailable.");
      return keeperObjects(
        projectId,
        kind,
        await deps.readObjects(projectId, {
          kind: KEEPER_OBJECT_READS[kind],
          ...(id !== undefined ? { id } : { limit: 100 }),
        }),
        id,
      );
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate(projectId: string | null) {
      if (disposed || selected === projectId) return;
      generation++;
      disconnect();
      if (selected) {
        recovery?.release(selected);
        recoveryKeys.delete(selected);
        const old = get(selected);
        old.page = null;
        old.loaded = false;
        old.live = false;
      }
      selected = projectId;
      if (projectId) {
        connect(projectId);
      }
      tell();
    },
    reload(projectId: string) {
      if (disposed || selected !== projectId) return;
      generation++;
      disconnect();
      const entry = get(projectId);
      entry.page = null;
      entry.loaded = false;
      entry.live = false;
      entry.notice = "";
      connect(projectId);
      tell();
    },
    draft(projectId: string, text: string) {
      get(projectId).draft = text;
      tell();
    },
    async attach(projectId: string, object: ConversationObject, retry = false) {
      if (disposed) return;
      const entry = get(projectId);
      const existing = entry.about.find(
        (ref) => ref.kind === object.kind && ref.id === object.id,
      );
      if ((existing && !retry) || (!existing && entry.about.length >= 16))
        return;
      const ref: KeeperAbout = {
        ...object,
        status: "loading",
        title: object.id,
        source: null,
        asOf: null,
        complete: false,
        reason: null,
      };
      entry.about = [...entry.about.filter((item) => item !== existing), ref];
      tell();
      try {
        if (!deps.readObjects)
          throw new Error("Object context is unavailable.");
        const raw = await deps.readObjects(projectId, {
          kind: KEEPER_OBJECT_READS[object.kind],
          id: object.id,
        });
        const result = keeperObjects(projectId, object.kind, raw, object.id);
        if (disposed || !entry.about.includes(ref)) return;
        Object.assign(ref, {
          status: "ready",
          title: result.items[0]?.title ?? ref.id,
          source: result.source,
          asOf: result.asOf,
          complete: result.complete,
          reason: result.reason,
        });
      } catch {
        if (disposed || !entry.about.includes(ref)) return;
        ref.status = "error";
        ref.reason =
          "This object could not be confirmed in this project's scope. Retry or remove it before sending.";
      }
      tell();
    },
    removeAbout(projectId: string, object: ConversationObject) {
      const entry = get(projectId);
      entry.about = entry.about.filter(
        (ref) => ref.kind !== object.kind || ref.id !== object.id,
      );
      tell();
    },
    async send(projectId: string) {
      if (!canSend(projectId)) return;
      const entry = get(projectId);
      const input: ConversationSend = {
        requestId: deps.requestId(),
        expectedRevision: entry.page?.revision ?? 0,
        text: entry.draft.trim(),
        about: entry.about.map(({ kind, id }) => ({ kind, id })),
      };
      entry.pending = input;
      entry.pendingKind = "turns";
      await postTurn(entry, input, false);
    },
    async retryOriginal(projectId: string) {
      const entry = get(projectId);
      if (!disposed && deps.canWrite() && entry.pending && !entry.posting)
        await postTurn(entry, entry.pending, true);
    },
    async stop(projectId: string, retry = false) {
      const entry = get(projectId);
      const turn = entry.page?.turns.find((turn) => active(turn.phase));
      if (
        disposed ||
        !deps.canWrite() ||
        !entry.page?.controllable ||
        !turn ||
        entry.stopPosting ||
        (entry.stopping &&
          !(retry && entry.stopUnknown && entry.stopping === turn.requestId))
      )
        return;
      entry.stopping = turn.requestId;
      entry.stopPosting = true;
      entry.stopUnknown = false;
      tell();
      let outcome: ActionOutcome;
      try {
        outcome = await deps.post(projectId, "stop", {
          requestId: turn.requestId,
        });
      } catch {
        outcome = {
          state: "unknown",
          message:
            "The stop response was lost. Check the turn's recorded state.",
        };
      }
      entry.stopPosting = false;
      // Streamed terminal state may already have confirmed the stop while HTTP was returning.
      if (entry.stopping !== turn.requestId) {
        tell();
        return;
      }
      if (outcome.state === "done") {
        const result = conversationReceiptSchema.safeParse(outcome.data);
        if (
          result.success &&
          result.data.conversationId === `keeper-${projectId}` &&
          result.data.turn.requestId === turn.requestId
        ) {
          entry.receiptRevision = Math.max(
            entry.receiptRevision,
            result.data.revision,
          );
          confirm(entry, result.data.turn);
          if (active(result.data.turn.phase))
            entry.notice = "Stop requested. Waiting for the turn to end.";
        } else {
          entry.stopUnknown = true;
          entry.notice =
            "The stop receipt could not be verified. Check the turn's state.";
        }
      } else {
        entry.notice = outcome.message;
        entry.stopUnknown = outcome.state === "unknown";
        if (outcome.state === "refused") entry.stopping = null;
      }
      tell();
    },
    async stopSession(
      projectId: string,
      selectedSession: KeeperSessionSelection,
      retry = false,
    ): Promise<void> {
      const entry = get(projectId),
        session = keeperSession(projectId, entry.page);
      if (
        !session ||
        session.sessionId !== selectedSession.sessionId ||
        session.requestId !== selectedSession.requestId ||
        (!session.canStop &&
          !(
            retry &&
            entry.stopUnknown &&
            session.phase === "cancelling" &&
            entry.page?.controllable
          ))
      ) {
        entry.notice =
          "The selected session no longer controls that original turn. Read the current session before stopping anything.";
        tell();
        return;
      }
      await client.stop(projectId, retry);
    },
    dispose() {
      recovery?.dispose();
      disposed = true;
      generation++;
      disconnect();
      listeners.clear();
    },
  };
  return client;
}

// TextEncoder is available in the browser; this module imports no Node or ledger runtime.
function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export type KeeperClient = ReturnType<typeof createKeeperClient>;
