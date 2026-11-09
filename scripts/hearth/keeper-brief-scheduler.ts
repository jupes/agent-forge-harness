import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConversationState } from "../../types/conversation";
import type {
  KeeperBriefIntent,
  KeeperBriefIntentMetadata,
  KeeperSchedulePhase,
  KeeperScheduleStatus,
} from "../../types/keeper-brief";
import type { ScheduledKeeperBriefControls } from "../conversations/service";
import {
  ConversationError,
  createConversationStore,
} from "../conversations/store";
import {
  keeperBriefIntentMetadataSchema,
  keeperScheduleStatusSchema,
  MAX_KEEPER_BRIEF_INTENT_BYTES,
  MAX_KEEPER_BRIEF_INTENT_HISTORY,
} from "../keeper/brief-protocol";
import { keeperScheduleWindow } from "../keeper/brief-schedule";
import { effectiveKeeperVisibility } from "../projects/project-keeper-protocol";
import { workspaceKey } from "../projects/scope";
import { createProjectStore, isProjectId } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import { ensurePrivateHome, MAX_SESSION_TRANSCRIPT_BYTES } from "./home-guard";

export interface KeeperScheduleClock {
  now(): number;
  setTimer(run: () => void, delayMs: number): () => void;
}
interface Options {
  home: string;
  workspace: string;
  clock?: KeeperScheduleClock | undefined;
  reserveScheduledKeeperBrief(
    id: string,
    nowMs: number,
    controls: ScheduledKeeperBriefControls,
  ): Promise<KeeperBriefIntentMetadata | null>;
}
interface Attempt {
  generation: string;
  high: number;
  preparing: boolean;
  attempt: KeeperScheduleStatus["attempt"];
  problem: string | null;
  checkProblem: string | null;
  capacity: boolean;
}
const held = (phase: string) =>
  ["accepted", "running", "cancelling", "unknown"].includes(phase);
const terminal = (phase: string) =>
  ["completed", "failed", "cancelled"].includes(phase);
const metadata = (row: KeeperBriefIntent): KeeperBriefIntentMetadata =>
  keeperBriefIntentMetadataSchema.parse(
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => !["text", "about", "snapshot"].includes(key),
      ),
    ),
  );

/** A clock owns wakeups; only the existing service owns source originals. Construction starts nothing. */
export function createKeeperBriefScheduler(options: Options) {
  const nativeNow = Date.now,
    nativeSet = setTimeout,
    nativeClear = clearTimeout;
  const clock: KeeperScheduleClock = options.clock ?? {
    now: nativeNow,
    setTimer(run, delay) {
      const timer = nativeSet(run, delay);
      return () => nativeClear(timer);
    },
  };
  const reserve = options.reserveScheduledKeeperBrief;
  const entries = new Map<string, Attempt>();
  let owner: KeeperScheduleStatus["owner"] = "idle",
    epoch = 0,
    cursor: string | null = null;
  let cancelTimer: (() => void) | undefined,
    job: Promise<void> | undefined,
    closing: Promise<void> | undefined;
  let ownerProblem: string | null = null;
  const now = () => {
    const value = clock.now();
    if (!Number.isSafeInteger(value) || new Date(value).getTime() !== value)
      throw new ConversationError(
        503,
        "The Keeper scheduling clock is unavailable.",
      );
    return value;
  };
  const view = (id: string) => {
    if (!isProjectId(id))
      throw new ConversationError(400, "Expected a project id.");
    const instant = now(),
      catalog = createProjectStore(options.home).read();
    const project = catalog.projects.find((row) => row.id === id);
    if (!project)
      throw new ConversationError(
        404,
        "This project is no longer in the catalog.",
      );
    if (
      !project.workspaces.some(
        (scope) => workspaceKey(scope.root) === workspaceKey(options.workspace),
      )
    )
      throw new ConversationError(
        409,
        "This hearth does not serve this project's workspace.",
      );
    let state: ConversationState | null = null;
    try {
      state = createConversationStore(options.home).read(id);
    } catch {
      /* Invalid state holds preparation. */
    }
    const fresh = createProjectStore(options.home).read();
    if (
      fresh.revision !== catalog.revision ||
      !isDeepStrictEqual(
        fresh.projects.find((row) => row.id === id),
        project,
      )
    )
      throw new ConversationError(
        409,
        "Keeper schedule settings changed during this read. Check current state again.",
      );
    const schedule = project.keeperSchedule ?? null;
    const generation = schedule?.kind === "daily" ? schedule.generation : null;
    const cached = entries.get(id),
      entry = cached?.generation === generation ? cached : undefined;
    const active = state?.keeperBriefIntents?.active ?? null,
      history = state?.keeperBriefIntents?.history ?? [];
    const activeTerminal =
      active?.state === "admitted" &&
      Boolean(
        state?.turns.some(
          (turn) => turn.requestId === active.requestId && terminal(turn.phase),
        ),
      );
    const foreign = Boolean(
      active &&
        !activeTerminal &&
        workspaceKey(active.origin.workspace) !==
          workspaceKey(options.workspace),
    );
    const rows = [...(active ? [active] : []), ...history];
    let consumed = -Infinity,
      consumedRow: KeeperBriefIntent | null = null;
    for (const row of rows) {
      if (
        row.origin.kind === "scheduled" &&
        row.origin.scheduleGeneration === generation &&
        workspaceKey(row.origin.workspace) ===
          workspaceKey(options.workspace) &&
        Date.parse(row.origin.dueAt) > consumed
      ) {
        consumed = Date.parse(row.origin.dueAt);
        consumedRow = row;
      }
    }
    const ticketRow = foreign
      ? null
      : active &&
          workspaceKey(active.origin.workspace) ===
            workspaceKey(options.workspace)
        ? active
        : consumedRow;
    const window = schedule
      ? keeperScheduleWindow(schedule, instant)
      : { latestDueAt: null, nextDueAt: null };
    const horizon = Math.max(instant, consumed, entry?.high ?? -Infinity);
    const nextDueAt = schedule
      ? keeperScheduleWindow(schedule, horizon).nextDueAt
      : null;
    const capacity = Boolean(
      state &&
        ((activeTerminal &&
          history.length >= MAX_KEEPER_BRIEF_INTENT_HISTORY) ||
          Buffer.byteLength(JSON.stringify(state)) >=
            MAX_SESSION_TRANSCRIPT_BYTES ||
          (state.keeperBriefIntents &&
            Buffer.byteLength(JSON.stringify(state.keeperBriefIntents)) >=
              MAX_KEEPER_BRIEF_INTENT_BYTES)),
    );
    let phase: KeeperSchedulePhase = "waiting",
      reason: string | null = null;
    if (owner === "closed") {
      phase = "unavailable";
      reason =
        "This scheduling owner has stopped. Saved originals remain available.";
    } else if (!state) {
      phase = "unavailable";
      reason =
        "Saved Keeper state could not be verified. No source was prepared.";
    } else if (foreign) {
      phase = "blocked-existing-work";
      reason =
        "An unresolved original belongs to another served workspace. Its identity has been kept.";
    } else if (!schedule || schedule.kind === "off") {
      phase = "off";
      reason = "Automatic source preparation is off.";
    } else if (
      project.archived ||
      effectiveKeeperVisibility(project).value !== "project-metadata"
    ) {
      phase = "policy-paused";
      reason =
        "Current project policy does not permit scheduled source preparation. Saved originals remain readable.";
    } else if (
      active?.state === "reserved" &&
      active.origin.kind === "scheduled" &&
      active.origin.scheduleGeneration === generation
    ) {
      phase = "ready-for-review";
      reason =
        "A saved scheduled source is available for review. Sending still requires the current admission checks.";
    } else if (
      (active && !activeTerminal) ||
      state.turns.some((turn) => held(turn.phase))
    ) {
      phase = "blocked-existing-work";
      reason =
        "Resolve the existing original or turn before another scheduled source is prepared.";
    } else if (capacity) {
      phase = "capacity-paused";
      reason =
        "Saved Keeper storage has reached an existing capacity limit. Every original has been kept.";
    } else if (entry?.preparing) {
      phase = "preparing";
      reason =
        "Preparing bounded sources for review; no model or approval is being started.";
    } else if (window.latestDueAt && consumed >= Date.parse(window.latestDueAt))
      reason =
        "This scheduled occurrence was already prepared. Its exact original has been kept.";
    else if (
      entry?.problem &&
      window.latestDueAt &&
      entry.high >= Date.parse(window.latestDueAt)
    ) {
      phase = entry.capacity ? "capacity-paused" : "unavailable";
      reason = entry.problem;
    } else if (entry?.checkProblem) {
      phase = "unavailable";
      reason = entry.checkProblem;
    } else if (ownerProblem) {
      phase = "unavailable";
      reason = ownerProblem;
    } else if (
      entry &&
      Number.isFinite(entry.high) &&
      entry.high >=
        (window.latestDueAt ? Date.parse(window.latestDueAt) : -Infinity)
    )
      reason =
        "Waiting for UTC time to pass the latest attempted scheduled slot; earlier slots will not be repeated.";
    else
      reason =
        owner === "idle"
          ? "Scheduling starts after this hearth finishes acquiring its root."
          : "Waiting for the next eligible UTC slot or bounded preparation tick.";
    const parsed = keeperScheduleStatusSchema.safeParse({
      projectId: id,
      workspace: options.workspace,
      conversationId: "keeper-" + id,
      catalogRevision: catalog.revision,
      schedule,
      asOf: new Date(instant).toISOString(),
      owner,
      phase,
      reason,
      latestDueAt: window.latestDueAt,
      nextDueAt,
      attempt: entry?.attempt ?? null,
      ticket: ticketRow ? metadata(ticketRow) : null,
    });
    if (!parsed.success)
      throw new ConversationError(
        503,
        "The schedule status could not be verified within its supported bound.",
      );
    return { status: parsed.data, consumed, high: entry?.high ?? -Infinity };
  };
  const current = (mine: number) => owner === "active" && epoch === mine;
  const execute = async (mine: number) => {
    const catalog = createProjectStore(options.home).read();
    for (const [id, entry] of entries) {
      const schedule = catalog.projects.find(
        (project) => project.id === id,
      )?.keeperSchedule;
      if (
        schedule?.kind !== "daily" ||
        schedule.generation !== entry.generation
      )
        entries.delete(id);
    }
    ownerProblem = null;
    const index = catalog.projects.findIndex(
      (project) => project.id === cursor,
    );
    for (
      let step = 1;
      step <= catalog.projects.length && current(mine);
      step++
    ) {
      const project =
        catalog.projects[(index + step) % catalog.projects.length];
      if (!project) continue;
      cursor = project.id;
      const schedule = project.keeperSchedule;
      if (
        schedule?.kind !== "daily" ||
        project.archived ||
        effectiveKeeperVisibility(project).value !== "project-metadata" ||
        !project.workspaces.some(
          (scope) =>
            workspaceKey(scope.root) === workspaceKey(options.workspace),
        )
      )
        continue;
      // Recheck recoverable selection/configuration failures only on a bounded tick.
      const previous = entries.get(project.id);
      if (previous?.generation === schedule.generation)
        previous.checkProblem = null;
      let observed: ReturnType<typeof view>;
      try {
        observed = view(project.id);
      } catch {
        continue;
      }
      const due = observed.status.latestDueAt;
      if (
        observed.status.phase !== "waiting" ||
        !due ||
        Date.parse(due) <= Math.max(observed.consumed, observed.high)
      )
        continue;
      let entry = entries.get(project.id);
      if (!entry || entry.generation !== schedule.generation) {
        entry = {
          generation: schedule.generation,
          high: -Infinity,
          preparing: false,
          attempt: null,
          problem: null,
          checkProblem: null,
          capacity: false,
        };
        entries.set(project.id, entry);
      }
      const owned = entry;
      let reachedSource = false;
      ensurePrivateHome(options.home);
      try {
        const locked = await withQueueLock(
          join(options.home, "keeper-brief-preparation.lock.db"),
          async () => {
            if (!current(mine)) return;
            const fresh = view(project.id);
            if (
              fresh.status.phase !== "waiting" ||
              fresh.status.schedule?.kind !== "daily" ||
              fresh.status.schedule.generation !== owned.generation
            )
              return;
            await reserve(project.id, now(), {
              isCurrent: () =>
                current(mine) && entries.get(project.id) === owned,
              beforeSource(origin) {
                const instant = Date.parse(origin.dueAt);
                if (
                  !current(mine) ||
                  origin.projectId !== project.id ||
                  origin.scheduleGeneration !== owned.generation ||
                  workspaceKey(origin.workspace) !==
                    workspaceKey(options.workspace) ||
                  instant <= Math.max(owned.high, fresh.consumed)
                )
                  throw new ConversationError(
                    409,
                    "This scheduled occurrence no longer belongs to the current preparation owner.",
                  );
                reachedSource = true;
                owned.checkProblem = null;
                owned.high = instant;
                owned.preparing = true;
                owned.problem = null;
                owned.capacity = false;
                owned.attempt = {
                  dueAt: origin.dueAt,
                  startedAt: new Date(now()).toISOString(),
                  problem: null,
                };
              },
            });
          },
          { waitMs: 100 },
        );
        if (!locked.ok && locked.reason === "unusable" && current(mine))
          ownerProblem =
            "The scheduled preparation resource lock is unavailable. No source was prepared.";
      } catch (error) {
        if (current(mine) && !reachedSource) {
          owned.checkProblem =
            "The scheduled source could not be checked under the current Keeper configuration. Check its Smith and settings; the next bounded tick can check again. No new source attempt was consumed.";
        } else if (current(mine) && reachedSource && owned.attempt) {
          owned.capacity =
            error instanceof Error && /full|capacity/.test(error.message);
          owned.problem = owned.capacity
            ? "A saved-storage capacity or validation limit paused preparation. All originals have been kept."
            : "The scheduled source could not be prepared. This owner will not repeat the same occurrence; saved originals have been kept.";
          owned.attempt = { ...owned.attempt, problem: owned.problem };
        }
      } finally {
        owned.preparing = false;
      }
      return;
    }
  };
  const arm = () => {
    if (owner === "active")
      cancelTimer = clock.setTimer(() => {
        cancelTimer = undefined;
        wake();
      }, 60_000);
  };
  const wake = () => {
    if (owner !== "active" || job) return;
    const mine = epoch;
    const pending = execute(mine)
      .catch(() => {
        if (current(mine))
          ownerProblem =
            "Scheduling state could not be verified. Saved originals have been kept.";
      })
      .finally(() => {
        if (job === pending) job = undefined;
        if (current(mine)) {
          try {
            arm();
          } catch {
            ownerProblem = "The scheduling timer is unavailable.";
            deactivate();
          }
        }
      });
    job = pending;
  };
  const deactivate = () => {
    if (owner === "closed") return;
    owner = "closed";
    epoch++;
    const cancel = cancelTimer;
    cancelTimer = undefined;
    try {
      cancel?.();
    } catch {
      ownerProblem = "The stopped scheduling timer could not be canceled.";
    }
  };
  return {
    start() {
      if (owner !== "idle") return;
      owner = "active";
      epoch++;
      wake();
    },
    deactivate,
    close() {
      deactivate();
      closing ??= job ?? Promise.resolve();
      return closing;
    },
    settled() {
      return job ?? Promise.resolve();
    },
    status(id: string): KeeperScheduleStatus {
      return view(id).status;
    },
  };
}
