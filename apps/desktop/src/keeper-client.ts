import type { ActionOutcome } from "../../../docs/js/action-outcome";
import { REAL_TIMERS, type Timers } from "../../../docs/js/hearth-read";
import type { StreamTransport } from "../../../docs/js/use-stream";
import {
  conversationPageSchema,
  conversationReceiptSchema,
} from "../../../scripts/conversations/protocol";
import { parseKeeperBrief } from "../../../scripts/keeper/brief-model";
import {
  briefsSchema,
  keeperBriefIntentMetadataSchema,
  keeperBriefIntentOriginalSchema,
  keeperScheduleStatusSchema,
} from "../../../scripts/keeper/brief-protocol";
import type { KeeperScheduleSaved } from "../../../scripts/keeper/brief-schedule";
import { KEEPER_OBJECT_READS } from "../../../scripts/keeper/objects";
import { workspaceKey } from "../../../scripts/projects/scope";
import type {
  ConversationObject,
  ConversationPage,
  ConversationSend,
  ConversationTurn,
} from "../../../types/conversation";
import type { KeeperReadQuery } from "../../../types/keeper";
import type {
  KeeperBriefIntent,
  KeeperBriefIntentMetadata,
  KeeperBriefIntentReference,
  KeeperBriefIntentReserveRequest,
  KeeperBriefOriginRequest,
  KeeperBriefs,
  KeeperScheduleStatus,
} from "../../../types/keeper-brief";
import type { KeeperContinuationRequest } from "../../../types/keeper-recovery";
import { type KeeperAbout, keeperObjects } from "./keeper-context";
import { createKeeperRecoveryClient } from "./keeper-recovery-client";
import { type KeeperSessionSelection, keeperSession } from "./keeper-session";

export interface KeeperScheduleContext {
  projectId: string | null;
  workspace: string | null;
  catalogRevision: number | null;
  schedule: KeeperScheduleSaved | null;
  routeKey: string;
  ready: boolean;
  archived: boolean;
}
export interface KeeperScheduleSource {
  routeKey: string;
  status: string;
  foreground: boolean;
}
export interface KeeperView {
  projectId: string;
  schedule: KeeperScheduleStatus | null;
  scheduleCurrent: boolean;
  scheduleLoading: boolean;
  scheduleError: string | null;
  draft: string;
  about: KeeperAbout[];
  page: ConversationPage | null;
  loaded: boolean;
  live: boolean;
  pending: ConversationSend | null;
  pendingKind: "turns";
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
  briefIntent: KeeperBriefIntentMetadata | null;
  briefOriginal: KeeperBriefIntent | null;
  briefIntentState:
    | "idle"
    | "loading"
    | "reserving"
    | "reserved"
    | "admitted"
    | "unknown"
    | "retired"
    | "complete";
  briefIntentError: string | null;
}
interface Deps {
  readSchedule?:
    | ((projectId: string, signal: AbortSignal) => Promise<unknown>)
    | undefined;
  scheduleSource?: (() => KeeperScheduleSource) | undefined;
  stream(projectId: string): StreamTransport;
  read(
    projectId: string,
    query: { after: number; requestId?: string },
  ): Promise<unknown>;
  post(
    projectId: string,
    action:
      | "turns"
      | "stop"
      | "briefs"
      | "continuations"
      | "brief-intents/reserve"
      | "brief-intents/retire",
    body:
      | ConversationSend
      | KeeperContinuationRequest
      | { requestId: string; expectedRevision?: number }
      | KeeperBriefIntentReference
      | KeeperBriefIntentReserveRequest
      | { requestId: string; intentHash: string },
  ): Promise<ActionOutcome>;
  requestId(): string;
  canWrite(): boolean;
  readBriefs?: ((projectId: string) => Promise<unknown>) | undefined;
  readBriefIntent?:
    | ((projectId: string, requestId?: string) => Promise<unknown>)
    | undefined;
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
const keeperIntentIdentity = (
  intent: KeeperBriefIntent | KeeperBriefIntentMetadata,
) => ({
  version: intent.version,
  requestId: intent.requestId,
  projectId: intent.projectId,
  conversationId: intent.conversationId,
  expectedRevision: intent.expectedRevision,
  origin: intent.origin,
  selection: intent.selection,
  purpose: intent.purpose,
  intentHash: intent.intentHash,
  createdAt: intent.createdAt,
  preparedTurnHash: intent.preparedTurnHash,
});

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
        schedule: null,
        scheduleCurrent: false,
        scheduleLoading: false,
        scheduleError: "Schedule status is unavailable.",
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
        briefIntent: null,
        briefOriginal: null,
        briefIntentState: "idle",
        briefIntentError: null,
      };
      entries.set(projectId, entry);
    }
    return entry;
  };
  const tell = () => {
    for (const listener of [...listeners]) listener();
  };
  let scheduleContext: KeeperScheduleContext | null = null;
  let scheduleEpoch = 0,
    scheduleDirty = false,
    scheduleNeedsRead = false;
  let scheduleTimer: unknown = null;
  let scheduleRead: {
    epoch: number;
    id: string;
    again: boolean;
    abort: AbortController;
    promise: Promise<void>;
  } | null = null;
  let lastScheduleSource: KeeperScheduleSource | null = null;
  const sourceNow = () => {
    try {
      return deps.scheduleSource?.() ?? null;
    } catch {
      return null;
    }
  };
  const scheduleSafe = (id: string): boolean => {
    const source = sourceNow();
    return (
      !disposed &&
      selected === id &&
      scheduleContext?.projectId === id &&
      !!scheduleContext.workspace &&
      !!source &&
      source.status === "live" &&
      source.foreground &&
      source.routeKey === scheduleContext.routeKey
    );
  };
  const sameSchedule = (
    a: KeeperScheduleSaved | null,
    b: KeeperScheduleSaved | null,
  ): boolean =>
    a === null || b === null
      ? a === b
      : a.kind === "off" || b.kind === "off"
        ? a.kind === b.kind
        : a.atUtc === b.atUtc &&
          a.generation === b.generation &&
          a.activatedAt === b.activatedAt;
  const invalidateSchedule = () => {
    scheduleEpoch++;
    if (scheduleTimer !== null) timers.clear(scheduleTimer);
    scheduleTimer = null;
    scheduleRead?.abort.abort();
    scheduleRead = null;
    scheduleNeedsRead = true;
    scheduleDirty = true;
    for (const entry of entries.values()) {
      entry.scheduleCurrent = false;
      entry.scheduleLoading = false;
      if (entry.briefIntentState === "loading" && entry.briefIntent) {
        entry.briefIntentState = "unknown";
        entry.briefIntentError =
          "The read context changed. The exact original remains held.";
      }
    }
  };
  const sameIntent = (
    a: KeeperBriefIntentMetadata,
    b: KeeperBriefIntentMetadata,
  ) =>
    JSON.stringify(keeperIntentIdentity(a)) ===
    JSON.stringify(keeperIntentIdentity(b));
  const briefCompletion = (
    entry: KeeperView,
    metadata?: KeeperBriefIntentMetadata,
  ) => {
    const epoch = generation,
      token = scheduleEpoch,
      source = sourceNow();
    return () => {
      const current = sourceNow();
      return (
        !disposed &&
        epoch === generation &&
        token === scheduleEpoch &&
        (!metadata ||
          (!!entry.briefIntent && sameIntent(entry.briefIntent, metadata))) &&
        (metadata?.origin.kind !== "scheduled" ||
          scheduleSafe(entry.projectId)) &&
        (!deps.scheduleSource ||
          (!!current &&
            current.status === "live" &&
            current.foreground &&
            current.routeKey === source?.routeKey &&
            (!scheduleContext ||
              current.routeKey === scheduleContext.routeKey)))
      );
    };
  };
  const holdsBriefIdentity = (entry: KeeperView): boolean =>
    ["reserving", "unknown", "reserved", "admitted"].includes(
      entry.briefIntentState,
    ) ||
    (entry.briefIntentState === "loading" && entry.briefIntent !== null);
  const acceptIntent = (
    entry: KeeperView,
    incoming: KeeperBriefIntentMetadata,
  ): boolean => {
    if (
      entry.briefIntent &&
      holdsBriefIdentity(entry) &&
      !sameIntent(entry.briefIntent, incoming)
    ) {
      entry.briefIntentState = "unknown";
      entry.briefIntentError =
        "A different ticket was observed. The unresolved reviewed identity and original remain held; check that exact original.";
      return false;
    }
    if (!entry.briefIntent || !sameIntent(entry.briefIntent, incoming))
      entry.briefOriginal = null;
    entry.briefIntent = incoming;
    return true;
  };
  const scheduleTicket = (id: string): KeeperBriefIntentMetadata | null => {
    const entry = get(id);
    const workspace = scheduleContext?.workspace;
    if (!scheduleSafe(id) || !workspace) return null;
    const known = entry.briefIntent;
    if (
      known?.origin.kind === "scheduled" &&
      workspaceKey(known.origin.workspace) === workspaceKey(workspace)
    )
      return known;
    return entry.scheduleCurrent ? (entry.schedule?.ticket ?? null) : null;
  };
  const scheduledSendCurrent = (entry: KeeperView): boolean => {
    const status = entry.schedule,
      ticket = entry.briefIntent,
      context = scheduleContext;
    return (
      scheduleSafe(entry.projectId) &&
      !!context?.ready &&
      !context.archived &&
      entry.scheduleCurrent &&
      !entry.scheduleLoading &&
      status?.phase === "ready-for-review" &&
      status.schedule?.kind === "daily" &&
      !!status.ticket &&
      !!ticket &&
      ticket.state === "reserved" &&
      entry.briefOriginal?.state === "reserved" &&
      ticket.origin.kind === "scheduled" &&
      sameIntent(status.ticket, ticket) &&
      status.catalogRevision === context.catalogRevision &&
      ticket.origin.catalogRevision === context.catalogRevision &&
      ticket.origin.scheduleGeneration === status.schedule.generation
    );
  };
  const armSchedule = (id: string) => {
    if (scheduleSafe(id) && deps.readSchedule)
      scheduleTimer = timers.set(() => {
        scheduleTimer = null;
        void refreshSchedule(id);
      }, 60_000);
  };
  const refreshSchedule = (id: string): Promise<void> => {
    const reader = deps.readSchedule;
    if (
      !scheduleSafe(id) ||
      !reader ||
      !scheduleContext?.ready ||
      !scheduleContext.workspace
    )
      return Promise.resolve();
    if (scheduleRead?.epoch === scheduleEpoch && scheduleRead.id === id) {
      scheduleRead.again = true;
      return scheduleRead.promise;
    }
    if (scheduleTimer !== null) timers.clear(scheduleTimer);
    scheduleTimer = null;
    const entry = get(id),
      context = scheduleContext,
      workspace = scheduleContext.workspace;
    const read = {
      epoch: scheduleEpoch,
      id,
      again: false,
      abort: new AbortController(),
      promise: Promise.resolve(),
    };
    scheduleRead = read;
    entry.scheduleLoading = true;
    const current = () =>
      scheduleRead === read && read.epoch === scheduleEpoch && scheduleSafe(id);
    read.promise = (async () => {
      try {
        const parsed = keeperScheduleStatusSchema.safeParse(
          await reader(id, read.abort.signal),
        );
        if (!current()) return;
        if (
          !parsed.success ||
          parsed.data.projectId !== id ||
          parsed.data.conversationId !== "keeper-" + id ||
          workspaceKey(parsed.data.workspace) !== workspaceKey(workspace) ||
          parsed.data.catalogRevision !== context.catalogRevision ||
          !sameSchedule(parsed.data.schedule, context.schedule)
        )
          throw Error("Stale or mismatched schedule status");
        entry.schedule = parsed.data;
        entry.scheduleCurrent = true;
        entry.scheduleError = null;
        const priorState = entry.briefIntentState,
          priorTicket = entry.briefIntent;
        if (parsed.data.ticket && acceptIntent(entry, parsed.data.ticket)) {
          entry.briefIntentState =
            priorTicket &&
            sameIntent(priorTicket, parsed.data.ticket) &&
            [
              "loading",
              "reserving",
              "unknown",
              "admitted",
              "complete",
            ].includes(priorState)
              ? priorState
              : parsed.data.ticket.state === "reserved"
                ? "reserved"
                : parsed.data.ticket.state === "retired"
                  ? "retired"
                  : "admitted";
        }
      } catch {
        if (current()) {
          entry.scheduleCurrent = false;
          entry.scheduleError =
            "Schedule status could not be verified. Prior briefs and exact originals have been kept.";
        }
      } finally {
        if (scheduleRead === read) {
          scheduleRead = null;
          entry.scheduleLoading = false;
          if (!disposed) {
            tell();
            if (read.again && scheduleSafe(id)) void refreshSchedule(id);
            else armSchedule(id);
          }
        }
      }
    })();
    tell();
    return read.promise;
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
      invalidateSchedule();
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
    const visibleTurns = [
      ...page.turns,
      ...(page.request ? [page.request] : []),
    ];
    for (const turn of visibleTurns) confirm(entry, turn);
    if (entry.briefIntent?.state === "admitted") {
      const briefTurn = visibleTurns.find(
        (turn) => turn.requestId === entry.briefIntent?.requestId,
      );
      if (briefTurn)
        entry.briefIntentState =
          briefTurn.hash !== entry.briefIntent.preparedTurnHash ||
          briefTurn.phase === "unknown"
            ? "unknown"
            : active(briefTurn.phase)
              ? "admitted"
              : "complete";
    }
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
      invalidateSchedule();
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
  const intentReference = (
    metadata: KeeperBriefIntentMetadata,
  ): KeeperBriefIntentReference => ({
    requestId: metadata.requestId,
    expectedRevision: metadata.expectedRevision,
    intentHash: metadata.intentHash,
  });
  const readExactBriefIntent = async (
    projectId: string,
    entry: KeeperView,
    metadata: KeeperBriefIntentMetadata,
  ): Promise<boolean> => {
    if (!deps.readBriefIntent) return false;
    const complete = briefCompletion(entry, metadata);
    if (!complete()) return false;
    entry.briefIntentState = "loading";
    entry.briefIntentError = null;
    tell();
    try {
      const raw = await deps.readBriefIntent(projectId, metadata.requestId);
      if (!complete()) return false;
      const parsed = keeperBriefIntentOriginalSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.projectId !== projectId ||
        parsed.data.conversationId !== `keeper-${projectId}` ||
        parsed.data.requestId !== metadata.requestId ||
        JSON.stringify(keeperIntentIdentity(parsed.data)) !==
          JSON.stringify(keeperIntentIdentity(metadata))
      )
        throw new Error(
          "The exact saved Keeper original did not match its ticket.",
        );
      if (!acceptIntent(entry, { ...metadata, state: parsed.data.state }))
        return false;
      entry.briefOriginal = parsed.data;
      entry.briefIntentState =
        parsed.data.state === "reserved"
          ? "reserved"
          : parsed.data.state === "retired"
            ? "retired"
            : "admitted";
      tell();
      return true;
    } catch {
      if (complete()) {
        entry.briefIntentState = "unknown";
        entry.briefIntentError =
          "The exact saved original could not be verified. Its ticket remains held; do not create a replacement.";
        tell();
      }
      return false;
    }
  };
  const discoverBriefIntent = async (
    projectId: string,
    entry = get(projectId),
  ): Promise<KeeperBriefIntentMetadata | null> => {
    if (!deps.readBriefIntent) return null;
    const complete = briefCompletion(entry);
    if (!complete()) return null;
    if (entry.briefIntentState === "idle") {
      entry.briefIntentState = "loading";
      tell();
    }
    try {
      const raw = await deps.readBriefIntent(projectId);
      if (!complete()) return null;
      if (raw === null) {
        if (holdsBriefIdentity(entry)) {
          entry.briefIntentState = "unknown";
          entry.briefIntentError =
            "No current ticket could be verified. The prior identity remains held; do not start a replacement.";
        } else if (entry.briefIntentState !== "complete") {
          entry.briefIntent = null;
          entry.briefOriginal = null;
          entry.briefIntentState = "idle";
          entry.briefIntentError = null;
        }
        tell();
        return null;
      }
      const parsed = keeperBriefIntentMetadataSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.projectId !== projectId ||
        parsed.data.conversationId !== `keeper-${projectId}`
      )
        throw new Error("Invalid Keeper brief ticket metadata");
      if (!acceptIntent(entry, parsed.data)) {
        tell();
        return null;
      }
      entry.briefIntentError = null;
      entry.briefIntentState =
        parsed.data.state === "reserved"
          ? "reserved"
          : parsed.data.state === "retired"
            ? "retired"
            : "admitted";
      const turn = entry.page?.turns.find(
        (item) => item.requestId === parsed.data.requestId,
      );
      if (parsed.data.state === "admitted" && turn) {
        entry.briefIntentState =
          turn.hash !== parsed.data.preparedTurnHash || turn.phase === "unknown"
            ? "unknown"
            : active(turn.phase)
              ? "admitted"
              : "complete";
        if (turn.hash !== parsed.data.preparedTurnHash)
          entry.briefIntentError =
            "The admitted turn does not match the saved original hash. Its identity remains held.";
      }
      tell();
      return parsed.data;
    } catch {
      if (complete()) {
        entry.briefIntentState = "unknown";
        entry.briefIntentError =
          "The saved Keeper ticket could not be verified. Keep it held and check again; do not reserve a replacement.";
        tell();
      }
      return null;
    }
  };
  const checkBriefIntent = async (projectId: string) => {
    const entry = get(projectId);
    const metadata = await discoverBriefIntent(projectId, entry);
    if (!metadata || metadata.state !== "admitted") return;
    try {
      const value = await deps.read(projectId, {
        after: entry.page?.frames.at(-1)?.seq ?? 0,
        requestId: metadata.requestId,
      });
      if (disposed || !apply(entry, value, false)) return;
      const turn = [
        ...(entry.page?.turns ?? []),
        ...(entry.page?.request ? [entry.page.request] : []),
      ].find((item) => item.requestId === metadata.requestId);
      entry.briefIntentState =
        !turn ||
        turn.hash !== metadata.preparedTurnHash ||
        turn.phase === "unknown"
          ? "unknown"
          : active(turn.phase)
            ? "admitted"
            : "complete";
      entry.briefIntentError = !turn
        ? "The admitted ticket has no correlated conversation turn. Its identity remains held."
        : turn.hash !== metadata.preparedTurnHash
          ? "The admitted turn does not match the saved original hash. Its identity remains held."
          : turn.phase === "unknown"
            ? "The admitted turn outcome is unknown. Its identity remains held."
            : null;
      if (entry.briefIntentState === "complete")
        void loadBriefs(projectId, true);
    } catch {
      if (!disposed) {
        entry.briefIntentState = "unknown";
        entry.briefIntentError =
          "The conversation outcome could not be correlated. The admitted ticket remains held.";
      }
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
      outcome = await deps.post(entry.projectId, "turns", input);
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
    const briefHeld = [
      "loading",
      "reserving",
      "reserved",
      "admitted",
      "unknown",
    ].includes(entry.briefIntentState);
    return (
      !disposed &&
      entry.briefIntentState !== "loading" &&
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
      !briefHeld &&
      (changing || !recovery || recovery.canStart(projectId))
    );
  };
  const canReviewBrief = (projectId: string): boolean => {
    const entry = get(projectId);
    const hasTicket =
      entry.briefIntent !== null ||
      ["reserved", "admitted", "unknown", "retired"].includes(
        entry.briefIntentState,
      );
    if (hasTicket)
      return (
        (entry.briefIntent?.origin.kind !== "scheduled" ||
          scheduleTicket(projectId) !== null) &&
        !disposed &&
        !entry.posting &&
        !["loading", "reserving"].includes(entry.briefIntentState)
      );
    return (
      !disposed &&
      !["loading", "reserving"].includes(entry.briefIntentState) &&
      deps.canWrite() &&
      selected === projectId &&
      entry.live &&
      entry.loaded &&
      (entry.page?.revision ?? -1) >= entry.receiptRevision &&
      !entry.pending &&
      !entry.posting &&
      !entry.stopping &&
      !entry.stopPosting &&
      !entry.page?.turns.some(held) &&
      !(entry.admitted && held(entry.admitted))
    );
  };
  const canCommitBrief = (projectId: string): boolean => {
    const entry = get(projectId);
    return (
      !disposed &&
      deps.canWrite() &&
      selected === projectId &&
      entry.live &&
      entry.loaded &&
      entry.briefIntentState === "reserved" &&
      !!entry.briefIntent &&
      !!entry.briefOriginal &&
      (entry.briefIntent.origin.kind !== "scheduled" ||
        scheduledSendCurrent(entry)) &&
      !entry.posting &&
      !entry.pending &&
      !entry.page?.turns.some(held)
    );
  };
  const matchesBriefOrigin = (
    metadata: KeeperBriefIntentMetadata,
    origin: KeeperBriefOriginRequest,
  ): boolean =>
    origin.kind === "overview"
      ? metadata.origin.kind === "overview"
      : metadata.origin.kind === "onboarding" &&
        metadata.origin.projectCreate.requestId ===
          origin.projectCreateRequestId;
  const reserveBriefForReview = async (
    projectId: string,
    origin: KeeperBriefOriginRequest,
  ): Promise<void> => {
    const entry = get(projectId);
    if (!canReviewBrief(projectId)) return;
    if (entry.briefIntentState === "unknown") {
      await checkBriefIntent(projectId);
      return;
    }
    if (
      entry.briefIntentState === "complete" ||
      entry.briefIntentState === "retired"
    ) {
      entry.briefIntent = null;
      entry.briefOriginal = null;
      entry.briefIntentState = "idle";
    } else if (entry.briefIntent) {
      const metadata = entry.briefIntent;
      const read = await readExactBriefIntent(projectId, entry, metadata);
      if (read && metadata.state === "admitted")
        await checkBriefIntent(projectId);
      return;
    }
    if (!deps.canWrite() || entry.briefIntentState !== "idle") return;
    const expectedRevision = entry.page?.revision ?? 0;
    entry.briefIntentState = "reserving";
    entry.briefIntentError = null;
    tell();
    let outcome: ActionOutcome;
    try {
      const input: KeeperBriefIntentReserveRequest = {
        expectedRevision,
        origin,
      };
      outcome = await deps.post(projectId, "brief-intents/reserve", input);
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The reservation reply was lost. Check the saved original; do not create another.",
      };
    }
    if (disposed) return;
    if (outcome.state === "done") {
      const metadata = keeperBriefIntentMetadataSchema.safeParse(outcome.data);
      if (
        !metadata.success ||
        metadata.data.projectId !== projectId ||
        metadata.data.expectedRevision !== expectedRevision ||
        !matchesBriefOrigin(metadata.data, origin)
      ) {
        entry.briefIntentState = "unknown";
        entry.briefIntentError =
          "The reservation reply did not match this reviewed scope. Its identity remains held.";
        tell();
        await discoverBriefIntent(projectId, entry);
        return;
      }
      if (!acceptIntent(entry, metadata.data)) {
        tell();
        return;
      }
      entry.briefIntentState = metadata.data.state;
      tell();
      await readExactBriefIntent(projectId, entry, metadata.data);
      return;
    }
    if (outcome.state === "unknown") {
      entry.briefIntentState = "unknown";
      entry.briefIntentError = outcome.message;
      tell();
      const found = await discoverBriefIntent(projectId, entry);
      if (found && matchesBriefOrigin(found, origin))
        await readExactBriefIntent(projectId, entry, found);
      else {
        entry.briefIntentState = "unknown";
        entry.briefIntentError =
          "The reservation outcome remains unknown. No new ticket was created; check again later.";
        tell();
      }
      return;
    }
    entry.briefIntentState = "idle";
    entry.briefIntentError = outcome.message;
    tell();
    const found = await discoverBriefIntent(projectId, entry);
    if (found) await readExactBriefIntent(projectId, entry, found);
  };
  const commitReviewedBrief = async (projectId: string): Promise<boolean> => {
    const entry = get(projectId);
    const metadata = entry.briefIntent;
    if (!canCommitBrief(projectId) || !metadata || !entry.briefOriginal)
      return false;
    entry.posting = true;
    entry.briefIntentError = null;
    tell();
    let outcome: ActionOutcome;
    try {
      outcome = await deps.post(projectId, "briefs", intentReference(metadata));
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The commit reply was lost. Check this exact ticket; it will not be resent automatically.",
      };
    }
    entry.posting = false;
    if (disposed) return false;
    if (outcome.state === "done") {
      const receipt = conversationReceiptSchema.safeParse(outcome.data);
      if (
        !receipt.success ||
        receipt.data.conversationId !== `keeper-${projectId}` ||
        receipt.data.turn.requestId !== metadata.requestId ||
        receipt.data.turn.hash !== metadata.preparedTurnHash
      ) {
        entry.briefIntentState = "unknown";
        entry.briefIntentError =
          "The commit receipt could not be matched to the reviewed ticket. Its identity remains held.";
        tell();
        return false;
      }
      entry.receiptRevision = Math.max(
        entry.receiptRevision,
        receipt.data.revision,
      );
      entry.admitted = receipt.data.turn;
      entry.briefIntent = { ...metadata, state: "admitted" };
      entry.briefOriginal = { ...entry.briefOriginal, state: "admitted" };
      entry.briefIntentState = active(receipt.data.turn.phase)
        ? "admitted"
        : receipt.data.turn.phase === "unknown"
          ? "unknown"
          : "complete";
      tell();
      return true;
    }
    entry.briefIntentError = outcome.message;
    if (outcome.state === "unknown") entry.briefIntentState = "unknown";
    tell();
    return false;
  };
  const retireBriefIntent = async (projectId: string): Promise<boolean> => {
    const entry = get(projectId);
    const metadata = entry.briefIntent;
    if (
      !deps.canWrite() ||
      !metadata ||
      metadata.state !== "reserved" ||
      entry.briefIntentState !== "reserved" ||
      entry.posting
    )
      return false;
    entry.posting = true;
    entry.briefIntentError = null;
    tell();
    let outcome: ActionOutcome;
    try {
      outcome = await deps.post(projectId, "brief-intents/retire", {
        requestId: metadata.requestId,
        intentHash: metadata.intentHash,
      });
    } catch {
      outcome = {
        state: "unknown",
        message:
          "The retirement reply was lost. The saved original remains held; check it before continuing.",
      };
    }
    entry.posting = false;
    if (disposed) return false;
    if (outcome.state === "done") {
      const retired = keeperBriefIntentMetadataSchema.safeParse(outcome.data);
      if (
        retired.success &&
        retired.data.requestId === metadata.requestId &&
        retired.data.intentHash === metadata.intentHash &&
        retired.data.state === "retired"
      ) {
        entry.briefIntent = retired.data;
        if (entry.briefOriginal)
          entry.briefOriginal = { ...entry.briefOriginal, state: "retired" };
        entry.briefIntentState = "retired";
        tell();
        return true;
      }
      entry.briefIntentState = "unknown";
      entry.briefIntentError =
        "The retirement receipt did not match the reserved ticket. Check the exact original.";
    } else {
      entry.briefIntentError = outcome.message;
      if (outcome.state === "unknown") entry.briefIntentState = "unknown";
    }
    tell();
    return false;
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
    canRefreshBrief: canReviewBrief,
    canCommitBrief,
    async refreshBrief(projectId: string) {
      await reserveBriefForReview(projectId, { kind: "overview" });
    },
    adoptScheduleContext(context: KeeperScheduleContext | null) {
      if (disposed) return;
      const old = scheduleContext;
      if (
        old?.projectId === context?.projectId &&
        old?.workspace === context?.workspace &&
        old?.catalogRevision === context?.catalogRevision &&
        old?.routeKey === context?.routeKey &&
        old?.ready === context?.ready &&
        old?.archived === context?.archived &&
        sameSchedule(old?.schedule ?? null, context?.schedule ?? null)
      )
        return;
      scheduleContext = context
        ? {
            ...context,
            schedule: context.schedule ? { ...context.schedule } : null,
          }
        : null;
      invalidateSchedule();
    },
    scheduleSourceChanged(kind: "status" | "hash" | "foreground") {
      const next = sourceNow();
      if (
        disposed ||
        (kind === "status" &&
          next?.status === lastScheduleSource?.status &&
          next?.routeKey === lastScheduleSource?.routeKey &&
          next?.foreground === lastScheduleSource?.foreground)
      )
        return;
      lastScheduleSource = next ? { ...next } : null;
      invalidateSchedule();
    },
    flushSchedule() {
      if (disposed) return Promise.resolve();
      if (scheduleDirty) {
        scheduleDirty = false;
        tell();
      }
      if (!scheduleNeedsRead || !selected) return Promise.resolve();
      scheduleNeedsRead = false;
      return refreshSchedule(selected);
    },
    refreshSchedule,
    canReviewScheduledBrief: (id: string) => scheduleTicket(id) !== null,
    async reviewScheduledBrief(id: string) {
      const ticket = scheduleTicket(id),
        entry = get(id);
      if (
        !ticket ||
        entry.posting ||
        entry.briefIntentState === "reserving" ||
        !acceptIntent(entry, ticket)
      )
        return;
      await readExactBriefIntent(id, entry, ticket);
    },
    async reviewBrief(
      projectId: string,
      origin: KeeperBriefOriginRequest = { kind: "overview" },
    ) {
      await reserveBriefForReview(projectId, origin);
    },
    async commitBrief(projectId: string) {
      return commitReviewedBrief(projectId);
    },
    async retireBrief(projectId: string) {
      return retireBriefIntent(projectId);
    },
    async checkBriefIntent(projectId: string) {
      await checkBriefIntent(projectId);
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
      invalidateSchedule();
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
        void discoverBriefIntent(projectId);
      }
      tell();
    },
    reload(projectId: string) {
      if (disposed || selected !== projectId) return;
      generation++;
      invalidateSchedule();
      disconnect();
      const entry = get(projectId);
      entry.page = null;
      entry.loaded = false;
      entry.live = false;
      entry.notice = "";
      connect(projectId);
      void discoverBriefIntent(projectId);
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
      disposed = true;
      invalidateSchedule();
      recovery?.dispose();
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
