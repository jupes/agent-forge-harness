import { REAL_TIMERS, type Timers } from "../../../docs/js/hearth-read";
import type { StreamTransport } from "../../../docs/js/use-stream";
import { workspaceKey } from "../../../scripts/projects/scope";
import {
  projectShiftAttemptPageSchema,
  projectShiftAttemptsPageSchema,
} from "../../../scripts/shifts/attempt-read-protocol";
import type { ConversationPage } from "../../../types/conversation";
import type { ProjectShiftAttemptsPage } from "../../../types/shift-attempts";
import type { ProjectShiftAttemptOrigin } from "../../../types/shift-origin";

export interface ShiftAttemptView {
  index: ProjectShiftAttemptsPage | null;
  selectedId: string | null;
  page: ConversationPage | null;
  loading: boolean;
  loaded: boolean;
  live: boolean;
  followLatest: boolean;
  error: string | null;
  notice: string;
}
export interface ShiftAttemptAddress {
  projectId: string;
  originalRequestId: string;
  shiftId: string;
  workspace: string;
  selectedSessionId?: string;
  expectedOrigin?: ProjectShiftAttemptOrigin;
}
export function shiftAttemptAddressKey(address: ShiftAttemptAddress): string {
  const origin = address.expectedOrigin;
  return JSON.stringify([
    address.projectId,
    address.originalRequestId,
    address.shiftId,
    workspaceKey(address.workspace),
    address.selectedSessionId ?? null,
    origin
      ? [
          origin.kind,
          origin.projectId,
          origin.originalRequestId,
          origin.shiftId,
          origin.runId,
          origin.beadId,
          origin.attempt,
        ]
      : null,
  ]);
}
/** Dedicated private observer. It has no action/Stop/send dependency or process-control authority. */
export function createShiftAttemptObserver(
  deps: ShiftAttemptAddress & {
    read(): Promise<unknown>;
    stream(sessionId: string): StreamTransport;
    changed(): void;
    timers?: Timers;
  },
) {
  const addressKey = shiftAttemptAddressKey(deps);
  const state: ShiftAttemptView = {
    index: null,
    selectedId: null,
    page: null,
    loading: false,
    loaded: false,
    live: false,
    followLatest: deps.selectedSessionId === undefined,
    error: null,
    notice: "",
  };
  const timers = deps.timers ?? REAL_TIMERS;
  let disposed = false,
    epoch = 0,
    failures = 0,
    timer: unknown = null,
    connection: { close(): void } | null = null;
  const changed = () => {
    if (!disposed) deps.changed();
  };
  const disconnect = () => {
    connection?.close();
    connection = null;
    if (timer !== null) timers.clear(timer);
    timer = null;
    state.live = false;
  };
  const selected = () =>
    state.index?.items.find((row) => row.session.id === state.selectedId)
      ?.session;
  const apply = (raw: unknown) => {
    const parsed = projectShiftAttemptPageSchema.safeParse(raw),
      session = selected();
    if (
      !parsed.success ||
      !session ||
      parsed.data.projectId !== deps.projectId ||
      parsed.data.conversationId !== session.id
    )
      throw Error("Foreign private attempt page");
    const page = parsed.data;
    if (state.page && page.revision < state.page.revision) return;
    const frames = [...(state.page?.frames ?? [])],
      known = new Map(frames.map((frame) => [frame.seq, frame]));
    let cursor = frames.at(-1)?.seq ?? 0;
    for (const frame of page.frames) {
      const previous = known.get(frame.seq);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(frame))
          throw Error("Changed private frame");
        continue;
      }
      if (frame.seq !== cursor + 1) throw Error("Private history gap");
      frames.push(frame);
      cursor = frame.seq;
    }
    const first = frames[0],
      user = first?.event,
      origin = session.origin;
    if (
      first?.seq !== 1 ||
      user?.kind !== "user" ||
      !user.shift ||
      !origin ||
      origin.kind !== "shift" ||
      user.session ||
      user.codexTask ||
      user.brief ||
      "codexChat" in user ||
      first.turnId !== session.requestId ||
      frames.some(
        (frame) =>
          frame.turnId !== session.requestId ||
          (frame.seq !== 1 && frame.event.kind === "user"),
      ) ||
      page.turns.length !== 1 ||
      page.turns.some((turn) => turn.requestId !== session.requestId) ||
      user.shift.projectId !== deps.projectId ||
      user.shift.originalRequestId !== deps.originalRequestId ||
      user.shift.shiftId !== deps.shiftId ||
      user.shift.conversationId !== session.id ||
      user.shift.turnId !== session.requestId ||
      user.shift.provider !== session.provider ||
      user.shift.runId !== origin.runId ||
      user.shift.beadId !== origin.beadId ||
      user.shift.attempt !== origin.attempt ||
      user.shift.smith !== session.smith ||
      user.shift.requestedModel !== session.requestedModel ||
      user.shift.requestedEffort !== session.requestedEffort ||
      user.text !== user.shift.stdin ||
      JSON.stringify(user.about) !==
        JSON.stringify([
          { kind: "bead", id: origin.beadId },
          { kind: "run", id: origin.runId },
        ]) ||
      workspaceKey(user.shift.workspace) !== workspaceKey(deps.workspace) ||
      workspaceKey(user.shift.cwd) !== workspaceKey(session.worktree) ||
      page.nextCursor > cursor ||
      page.lastSequence < cursor ||
      page.more !== page.nextCursor < page.lastSequence ||
      frames.length > 20_000 ||
      new TextEncoder().encode(JSON.stringify(frames)).byteLength >
        8 * 1024 * 1024
    )
      throw Error("Private attempt correlation failed");
    const snapshot = user.shift;
    const processes = frames.filter((frame) => frame.event.kind === "process");
    const identities = frames.filter(
      (frame) => frame.event.kind === "identity",
    );
    if (
      processes.length > 1 ||
      processes.some(
        ({ event }) =>
          event.kind !== "process" ||
          event.smith !== snapshot.smith ||
          event.requestedModel !== snapshot.requestedModel ||
          event.requestedEffort !== snapshot.requestedEffort,
      ) ||
      (page.binding
        ? (cursor === page.lastSequence &&
            (!processes.length || !identities.length)) ||
          page.binding.provider !== snapshot.provider ||
          page.binding.version !== snapshot.cliVersion ||
          identities.some(
            ({ event }) =>
              event.kind !== "identity" ||
              event.provider !== page.binding?.provider ||
              event.version !== page.binding?.version ||
              event.sessionId !== page.binding?.sessionId,
          )
        : identities.length > 0) ||
      frames.some(
        ({ event }) =>
          "provider" in event &&
          (event.provider !== snapshot.provider ||
            ("version" in event && event.version !== snapshot.cliVersion)),
      )
    )
      throw Error("Private provider binding mismatch");
    if (cursor === page.lastSequence && page.turns[0]?.phase === "completed") {
      const outcome = frames.at(-1)?.event;
      if (
        !page.binding ||
        outcome?.kind !== "coding-outcome" ||
        outcome.code !== "completed" ||
        outcome.exitCode !== 0
      )
        throw Error("Private completion was not confirmed");
    }
    state.page = {
      ...page,
      frames,
      nextCursor: cursor,
      more: cursor < page.lastSequence,
    };
    state.loaded = !state.page.more;
    state.live = true;
    state.error = null;
    state.notice = state.page.more
      ? "Reading the retained private history…"
      : "Private history verified against this original shift. Whole-shift controls remain above.";
    failures = 0;
    changed();
  };
  const open = () => {
    if (disposed || !state.selectedId) return;
    const currentEpoch = epoch;
    const current = () => !disposed && epoch === currentEpoch;
    const deadline = (ms: number) => {
      if (timer !== null) timers.clear(timer);
      timer = timers.set(fail, ms);
    };
    const fail = () => {
      if (!current()) return;
      epoch++;
      disconnect();
      failures++;
      state.notice =
        failures >= 6
          ? "Private attempt updates are unavailable. Reload to verify the saved history."
          : "Private updates were interrupted. Reconnecting by the saved cursor; no input is being sent.";
      changed();
      if (failures < 6)
        timer = timers.set(open, Math.min(8000, 500 * 2 ** (failures - 1)));
    };
    deadline(20_000);
    connection = deps.stream(state.selectedId)(state.page?.nextCursor ?? 0, {
      onOpen: () => {
        if (current()) deadline(45_000);
      },
      onActivity: () => {
        if (current()) deadline(45_000);
      },
      onMessage(message) {
        if (!current()) return;
        let raw: unknown;
        try {
          if (message.event !== "conversation")
            throw Error("Unexpected private feed");
          raw = JSON.parse(message.data);
          apply(raw);
        } catch {
          state.error =
            "This private attempt update could not be verified. The last verified text has been kept.";
          fail();
        }
      },
      onEnd: fail,
    });
  };
  const choose = (id: string, followLatest: boolean) => {
    if (
      disposed ||
      (deps.selectedSessionId !== undefined && id !== deps.selectedSessionId) ||
      !state.index?.items.some((row) => row.session.id === id)
    )
      return;
    state.followLatest = followLatest;
    if (state.selectedId === id) {
      if (connection === null && timer === null) open();
      changed();
      return;
    }
    epoch++;
    disconnect();
    failures = 0;
    state.selectedId = id;
    state.page = null;
    state.loaded = false;
    state.error = null;
    state.notice = "Verifying this attempt's private history…";
    changed();
    open();
  };
  return {
    get: () => state,
    forAddress: (address: ShiftAttemptAddress) =>
      !disposed && shiftAttemptAddressKey(address) === addressKey
        ? state
        : null,
    async refresh() {
      if (disposed || state.loading) return;
      state.loading = true;
      changed();
      try {
        const checked = projectShiftAttemptsPageSchema.safeParse(
          await deps.read(),
        );
        if (disposed) return;
        if (
          !checked.success ||
          checked.data.projectId !== deps.projectId ||
          checked.data.originalRequestId !== deps.originalRequestId ||
          checked.data.shiftId !== deps.shiftId ||
          checked.data.items.some(
            (row) =>
              workspaceKey(row.session.workspace) !==
                workspaceKey(deps.workspace) ||
              workspaceKey(row.session.repository) !==
                workspaceKey(deps.workspace),
          )
        )
          throw Error("Foreign attempt index");
        state.index = checked.data;
        state.error = null;
        if (deps.selectedSessionId !== undefined) {
          const exact = checked.data.items.find(
              (row) => row.session.id === deps.selectedSessionId,
            ),
            exactOrigin = exact?.session.origin;
          if (
            !exact ||
            exactOrigin?.kind !== "shift" ||
            (deps.expectedOrigin &&
              (
                [
                  "kind",
                  "projectId",
                  "originalRequestId",
                  "shiftId",
                  "runId",
                  "beadId",
                  "attempt",
                ] as const
              ).some((key) => exactOrigin[key] !== deps.expectedOrigin?.[key]))
          ) {
            epoch++;
            disconnect();
            state.error =
              "The selected attempt is unavailable in this original Shift. No other attempt was opened.";
            return;
          }
          choose(deps.selectedSessionId, false);
          return;
        }
        const latest = checked.data.items.at(-1)?.session.id;
        if (latest && (state.followLatest || state.selectedId === null))
          choose(latest, state.followLatest);
      } catch {
        if (!disposed) {
          epoch++;
          disconnect();
          state.error =
            "The private attempt index could not be verified. Metadata alone does not prove provider dispatch or completion.";
        }
      } finally {
        state.loading = false;
        changed();
      }
    },
    select: (id: string) => choose(id, false),
    followLatest() {
      if (deps.selectedSessionId !== undefined) return;
      const latest = state.index?.items.at(-1)?.session.id;
      if (latest) choose(latest, true);
    },
    reload() {
      if (disposed || !state.selectedId) return;
      epoch++;
      disconnect();
      state.page = null;
      state.loaded = false;
      failures = 0;
      state.error = null;
      changed();
      open();
    },
    close() {
      disposed = true;
      epoch++;
      disconnect();
      state.page = null;
    },
  };
}
export type ShiftAttemptObserver = ReturnType<
  typeof createShiftAttemptObserver
>;
