/**
 * The approval queue: one table of legal moves, and the one function that
 * makes a move.
 *
 * A bead's queue state is one `queue:<state>` label on the bead, and Beads is
 * where it lives: nothing here keeps a second copy. A move validates the id,
 * takes the queue lock, reads the bead with `bd show`, checks the table,
 * writes the label with one `bd update` (an argument array, every value as
 * `--flag=value`, the id after `--`), confirms the write from what `bd`
 * printed, and only then appends `bead.transitioned` with `from` and `to`.
 * Beads `status` is read once (a closed bead is not started) and never
 * written. Nothing here starts work.
 *
 * A label counts as a state only when the queue wrote it: every write also
 * sets metadata `queue_state` to the same state, and `bd create --parent`
 * copies a parent's labels onto a child but not its metadata. A label with no
 * such backing was inherited or added by hand, and the only move it takes is
 * `propose`. The backing is trusted as written: a `queue_state` or
 * `queue_resume` set by hand with `bd update --set-metadata` is read as the
 * queue's own.
 *
 * What is not covered:
 * - A writer that does not take this lock (a hand edit with `bd`, a process
 *   given another lock file, another machine) is found only when it leaves a
 *   second queue label on the bead. One that makes the same move at the same
 *   time leaves exactly the target, so neither writer can tell; when both
 *   are this module (two lock files), the move is recorded twice.
 * - A process that ends between the `bd update` and the append leaves the
 *   move (or the reassign) made on the bead with no `bead.transitioned` for it.
 */

import {
  BENCH_NAMES,
  type BenchName,
  type LedgerEventInput,
  QUEUE_ACTIONS,
  QUEUE_ACTORS,
  QUEUE_LABEL_PREFIX,
  QUEUE_RESUME_KEY,
  QUEUE_STATE_KEY,
  QUEUE_STATES,
  type QueueAction,
  type QueueActor,
  type QueueEntry,
  type QueueMoveResult,
  type QueueReassignResult,
  type QueueState,
} from "../../types/hearth";
import type { ForgeConfig } from "../config/load";
import { type Resolution, resolveSmith } from "../config/resolve";
import { safeMessage } from "../hearth/api";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import {
  isBeadId,
  neverStarted,
  parsed,
  refusal,
  storeEvent,
} from "../hearth/tracker-write";
import type { AppendResult } from "../ledger/append";
import { withQueueLock } from "./queue-lock";
import {
  decide,
  PAUSABLE,
  type QueuePosition,
  REASSIGNABLE,
} from "./queue-table";

export {
  actionFor,
  type Decision,
  decide,
  legalMoves,
  QUEUE_TABLE,
  type QueuePosition,
  type QueueRule,
} from "./queue-table";

// ── Reading a bead ──────────────────────────────────────────────────────────

/** What a bead's labels and metadata say about its place in the queue. */
export type QueueStanding =
  | { kind: "none" }
  | { kind: "state"; state: QueueState; resume?: QueueState }
  /** One queue label, a state, that the queue did not write. */
  | { kind: "unbacked"; label: QueueState }
  /** Two queue labels, or one that is not a state. */
  | { kind: "broken"; labels: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateNamed(value: unknown): QueueState | undefined {
  return QUEUE_STATES.find((state) => state === value);
}

function textLabels(labels: unknown): string[] {
  return Array.isArray(labels)
    ? labels.filter((label): label is string => typeof label === "string")
    : [];
}

/**
 * Where a bead stands, from the labels and metadata `bd` printed for it: the
 * issue's own, top-level ones. (`bd show` of a child also prints its parent's
 * metadata, under `dependencies`; that is not the child's.)
 */
export function queueStateOf(bead: {
  labels?: unknown;
  metadata?: unknown;
}): QueueStanding {
  const labels = textLabels(bead.labels)
    .filter((label) => label.startsWith(QUEUE_LABEL_PREFIX))
    .sort();
  if (labels.length === 0) return { kind: "none" };
  const state =
    labels.length === 1
      ? stateNamed(labels[0]?.slice(QUEUE_LABEL_PREFIX.length))
      : undefined;
  if (state === undefined) return { kind: "broken", labels };
  const metadata = isRecord(bead.metadata) ? bead.metadata : {};
  if (metadata[QUEUE_STATE_KEY] !== state)
    return { kind: "unbacked", label: state };
  const resume = PAUSABLE.find((to) => to === metadata[QUEUE_RESUME_KEY]);
  return {
    kind: "state",
    state,
    ...(state === "paused" && resume !== undefined ? { resume } : {}),
  };
}

// ── Bench selection ─────────────────────────────────────────────────────────

const COMPLEXITY_PREFIX = "complexity:";

/** The bead's one `complexity:low|medium|high` label; none is fine, two or an unknown one is not. */
export function complexityOf(
  labels: readonly string[],
): { ok: true; complexity?: BenchName } | { ok: false; error: string } {
  const found = labels.filter((label) => label.startsWith(COMPLEXITY_PREFIX));
  if (found.length === 0) return { ok: true };
  const complexity = BENCH_NAMES.find(
    (name) => `${COMPLEXITY_PREFIX}${name}` === found[0],
  );
  return found.length === 1 && complexity !== undefined
    ? { ok: true, complexity }
    : {
        ok: false,
        error: `expected one of ${BENCH_NAMES.map((name) => `${COMPLEXITY_PREFIX}${name}`).join(", ")}, found ${found.join(", ")}`,
      };
}

/**
 * The smith a bead's work goes to: the smith recorded on the bead (`reassign`
 * writes it as metadata `smith`), else the bench of its complexity label,
 * else the default the config defines. Pure: it reads nothing but its
 * arguments, and the same bead gets the same smith every time.
 */
export function smithFor(
  config: ForgeConfig,
  bead: { id: string; labels: readonly string[]; metadata?: unknown },
): Resolution {
  const complexity = complexityOf(bead.labels);
  if (!complexity.ok) return complexity;
  const preferred = isRecord(bead.metadata)
    ? bead.metadata["smith"]
    : undefined;
  return resolveSmith(config, {
    beadSmith:
      typeof preferred === "string" && preferred !== "" ? preferred : undefined,
    complexity: complexity.complexity,
    seed: bead.id,
  });
}

/** What a smith's name may be when it is written to a bead and to an audit row. */
const SMITH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whether `name` is a configured, enabled smith that can be recorded on a bead. */
export function checkSmith(
  config: ForgeConfig,
  name: unknown,
): { ok: true; smith: string } | { ok: false; error: string } {
  if (typeof name !== "string" || !SMITH_NAME.test(name))
    return {
      ok: false,
      error: "smith: expected the name of a configured smith",
    };
  if (!Object.hasOwn(config.smiths, name))
    return { ok: false, error: `smith: unknown smith "${name}"` };
  return config.smiths[name]?.enabled === true
    ? { ok: true, smith: name }
    : { ok: false, error: `smith: smith "${name}" is disabled` };
}

// ── What a shift may pick ───────────────────────────────────────────────────

const label = (state: QueueState): string => `${QUEUE_LABEL_PREFIX}${state}`;

/**
 * The `bd list` arguments that print exactly the beads a shift may pick: in
 * `queued`, by the queue's own writing, in no other queue state, not closed
 * (`bd list` hides closed issues unless told otherwise).
 *
 * `bd list --label queue:queued` alone prints those and two kinds more, both
 * made outside this module and both refused by `start`: a bead whose label
 * was inherited from its parent or added by hand, and a bead that carries a
 * second queue label.
 */
export const QUEUED_EXACT_ARGS: readonly string[] = [
  "list",
  "--readonly",
  "--flat",
  "--json",
  "--limit",
  "0",
  "--label",
  label("queued"),
  "--metadata-field",
  `${QUEUE_STATE_KEY}=queued`,
  "--exclude-label",
  QUEUE_STATES.filter((state) => state !== "queued")
    .map(label)
    .join(","),
];

/**
 * The same set, from the whole answer of `GET /queue` (not one filtered by
 * `?state=`: a bead's other entry would be missing).
 */
export function pickable(entries: readonly QueueEntry[]): QueueEntry[] {
  const count = new Map<string, number>();
  for (const entry of entries)
    count.set(entry.beadId, (count.get(entry.beadId) ?? 0) + 1);
  return entries.filter(
    (entry) =>
      entry.state === "queued" &&
      entry.backed === true &&
      entry.status !== "closed" &&
      count.get(entry.beadId) === 1,
  );
}

// ── Moving a bead ───────────────────────────────────────────────────────────

export interface QueueDeps {
  /** The workspace the transition events are recorded under. */
  workspace: string;
  /** Runs `bd` in the checkout that holds the tracker: an argument array, no shell. */
  runBd: BdRunner;
  /** The ledger's `appendEvent`, bound to a ledger. */
  appendEvent(event: LedgerEventInput): AppendResult;
  /** The queue lock's file: every process that moves beads of one tracker must be given the same one. */
  lockFile: string;
  /** How long a move waits for the lock; 10 s by default. */
  lockWaitMs?: number | undefined;
}

/**
 * Why a move was not made.
 *
 * - `invalid`: the request itself; `bd` was not called.
 * - `not-found`: no bead has exactly this id.
 * - `refused`: the table, or a bead that is in no state. Nothing was written.
 * - `busy`: the lock could not be had in time. Nothing was written.
 * - `failed`: `bd` or the lock refused. Nothing was written.
 * - `conflict`: the write was made and another writer's label is on the bead too.
 * - `unknown`: the outcome is not known; the message says how to check.
 */
export type QueueFailure =
  | "invalid"
  | "not-found"
  | "refused"
  | "busy"
  | "failed"
  | "conflict"
  | "unknown";

export type QueueOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: QueueFailure; error: string };

export interface Queue {
  /** Take `action` on the bead as `by`. One read, at most one write, never repeated. */
  move(
    id: string,
    action: QueueAction,
    by: QueueActor,
  ): Promise<QueueOutcome<QueueMoveResult>>;
  /**
   * Record `smith` as the bead's smith. It moves no state; once `bd`
   * confirmed the write it appends `bead.transitioned` `{ action: "reassign" }`.
   */
  reassign(
    id: string,
    smith: string,
    config: ForgeConfig,
  ): Promise<QueueOutcome<QueueReassignResult>>;
}

const no = <T>(kind: QueueFailure, error: string): QueueOutcome<T> => ({
  ok: false,
  kind,
  error: safeMessage(error),
});

/** How to take a bead out of the queue by hand, so that it can be proposed again. */
function repair(id: string, labels: readonly string[]): string {
  return `bd update ${id} ${labels.map((each) => `--remove-label=${each}`).join(" ")} --unset-metadata=${QUEUE_STATE_KEY} --unset-metadata=${QUEUE_RESUME_KEY}`;
}

/** The one issue `bd` printed, when it is the bead that was asked for. */
function printedBead(
  stdout: string,
  id: string,
): Record<string, unknown> | { other: string | null } {
  const issues = parsed(stdout);
  if (!Array.isArray(issues) || issues.length !== 1) return { other: null };
  const [issue] = issues;
  if (!isRecord(issue) || typeof issue["id"] !== "string")
    return { other: null };
  if (issue["id"] === id) return issue;
  return { other: isBeadId(issue["id"]) ? issue["id"] : null };
}

export function createQueue(deps: QueueDeps): Queue {
  const lockOptions =
    deps.lockWaitMs !== undefined ? { waitMs: deps.lockWaitMs } : {};

  /** Run `work` under the queue lock; a lock that cannot be had is an answer, and `work` was not called. */
  async function locked<T>(
    work: () => Promise<QueueOutcome<T>>,
  ): Promise<QueueOutcome<T>> {
    const held = await withQueueLock(deps.lockFile, work, lockOptions);
    if (held.ok) return held.value;
    return no(held.reason === "busy" ? "busy" : "failed", held.error);
  }

  /** The bead as `bd show` prints it. Whatever the answer, a read changes nothing. */
  async function read(
    id: string,
  ): Promise<QueueOutcome<Record<string, unknown>>> {
    let result: BdResult;
    try {
      result = await deps.runBd(["show", "--readonly", "--json", "--", id]);
    } catch {
      // The runner's own message repeats its arguments; it is not passed on.
      return no("failed", "bd show could not be run. Nothing was changed.");
    }
    if (result.status === null)
      return no(
        "failed",
        neverStarted(result)
          ? "bd could not be started (is it installed, and on the PATH of this process?). Nothing was changed."
          : "bd show did not finish within its time limit. Nothing was changed.",
      );
    if (result.status !== 0) {
      const why = refusal(result);
      return /no issues? found/i.test(why)
        ? no("not-found", `No bead has the id ${id}.`)
        : no("failed", `bd show failed: ${why}. Nothing was changed.`);
    }
    const bead = printedBead(result.stdout, id);
    if (!("other" in bead)) return { ok: true, value: bead };
    return no(
      "not-found",
      typeof bead.other === "string"
        ? `No bead has exactly the id ${id} (bd resolves it to ${bead.other}; give the whole id).`
        : `No bead has the id ${id}.`,
    );
  }

  /**
   * One `bd update`, never repeated. The answer is the bead as `bd` printed
   * it after the write; a write that cannot be confirmed is `unknown`.
   */
  async function write(
    id: string,
    changes: string[],
  ): Promise<QueueOutcome<Record<string, unknown>>> {
    const unknown = (what: string): QueueOutcome<Record<string, unknown>> =>
      no(
        "unknown",
        `bd update ${what} Check with \`bd show ${id}\` before trying again.`,
      );
    let result: BdResult;
    try {
      result = await deps.runBd(["update", ...changes, "--json", "--", id]);
    } catch {
      return unknown(
        "did not finish: it could not be run. The change may still have been made.",
      );
    }
    if (result.status === null)
      return neverStarted(result)
        ? no(
            "failed",
            "bd could not be started (is it installed, and on the PATH of this process?). Nothing was changed.",
          )
        : unknown(
            "did not finish within its time limit. The change may still have been made.",
          );
    if (result.status !== 0)
      return no(
        "failed",
        `bd update failed: ${refusal(result)}. Nothing was changed.`,
      );
    const bead = printedBead(result.stdout, id);
    return "other" in bead
      ? unknown(
          "exited 0 but did not confirm the change. It may have been made.",
        )
      : { ok: true, value: bead };
  }

  async function moveLocked(
    id: string,
    action: QueueAction,
    by: QueueActor,
  ): Promise<QueueOutcome<QueueMoveResult>> {
    const shown = await read(id);
    if (!shown.ok) return shown;
    const standing = queueStateOf(shown.value);

    if (standing.kind === "broken")
      return no(
        "refused",
        `${id} carries ${standing.labels.join(" and ")}: a bead is in the queue with exactly one queue label that names a state, so no move is made. Take it out by hand and propose it again: ${repair(id, standing.labels)}`,
      );
    if (standing.kind === "unbacked" && action !== "propose")
      return no(
        "refused",
        `${id} carries ${label(standing.label)}, but the queue did not write it (it was inherited from a parent bead, or added by hand): "${action}" is not a move from there. The only move is propose, which puts it in the queue as proposed.`,
      );

    // An unbacked label is not a state: the bead enters the queue from outside it.
    const position: QueuePosition =
      standing.kind === "state"
        ? { state: standing.state, resume: standing.resume }
        : { state: null };
    const from = position.state;
    const decision = decide(position, action, by);
    if (!decision.ok) {
      const stuck =
        from === "paused" && position.resume === undefined
          ? ` Repair it by hand: bd update ${id} --set-metadata=${QUEUE_RESUME_KEY}=<state>, or take it out of the queue and propose it again: ${repair(id, [label("paused")])}`
          : "";
      return no("refused", `${id} ${decision.error}${stuck}`);
    }
    const to = decision.to;
    if (action === "start" && shown.value["status"] === "closed")
      return no(
        "refused",
        `${id} is ${from === null ? "not in the queue" : label(from)} and its Beads status is closed: a closed bead is not started.`,
      );

    // The label the bead carries now, which the write replaces. Never the one
    // it adds: bd adds before it removes, and would leave the bead with none.
    const old =
      standing.kind === "unbacked" ? standing.label : (from ?? undefined);
    const written = await write(id, [
      ...(old !== undefined && old !== to
        ? [`--remove-label=${label(old)}`]
        : []),
      `--add-label=${label(to)}`,
      `--set-metadata=${QUEUE_STATE_KEY}=${to}`,
      ...(action === "pause"
        ? [`--set-metadata=${QUEUE_RESUME_KEY}=${from}`]
        : []),
      ...(action === "resume" ? [`--unset-metadata=${QUEUE_RESUME_KEY}`] : []),
    ]);
    if (!written.ok) return written;

    const after = queueStateOf(written.value);
    if (after.kind === "broken" && after.labels.includes(label(to)))
      return no(
        "conflict",
        `${id} now carries ${after.labels.join(" and ")}: something outside the queue changed its labels while this "${action}" was being made. The move is not recorded and no further change was made. Take the bead out of the queue by hand and propose it again: ${repair(id, after.labels)}`,
      );
    if (after.kind !== "state" || after.state !== to)
      return no(
        "unknown",
        `bd update exited 0 but ${id} is not confirmed as ${label(to)}. Check with \`bd show ${id}\` before trying again.`,
      );

    // Inside the lock, so that two moves of one bead reach the ledger in the order they were made.
    const unrecorded = await storeEvent(deps.appendEvent, {
      kind: "bead.transitioned",
      workspace: deps.workspace,
      beadId: id,
      // Metadata only: two states and two fixed words.
      payload: { from, to, reason: `${action}:${by}` },
    });
    return {
      ok: true,
      value: {
        id,
        action,
        from,
        to,
        recorded: unrecorded === null,
        ...(unrecorded !== null ? { recordError: unrecorded } : {}),
      },
    };
  }

  async function reassignLocked(
    id: string,
    smith: string,
  ): Promise<QueueOutcome<QueueReassignResult>> {
    const shown = await read(id);
    if (!shown.ok) return shown;
    const standing = queueStateOf(shown.value);
    if (standing.kind !== "state")
      return no(
        "refused",
        `${id} is not in a queue state the queue wrote: a smith is assigned to a bead that is in the queue.`,
      );
    if (!REASSIGNABLE.includes(standing.state))
      return no(
        "refused",
        `${id} is ${label(standing.state)}: a smith is assigned before the work starts or after it stopped (${REASSIGNABLE.join(", ")}).`,
      );
    const written = await write(id, [`--set-metadata=smith=${smith}`]);
    if (!written.ok) return written;
    const metadata = written.value["metadata"];
    if (!isRecord(metadata) || metadata["smith"] !== smith)
      return no(
        "unknown",
        `bd update exited 0 but ${id} is not confirmed as assigned to ${smith}. Check with \`bd show ${id}\` before trying again.`,
      );

    // After the write, so that a reader that reads the queue again on this
    // event finds the smith. A tracker write: the state did not move.
    const unrecorded = await storeEvent(deps.appendEvent, {
      kind: "bead.transitioned",
      workspace: deps.workspace,
      beadId: id,
      payload: { action: "reassign" },
    });
    return {
      ok: true,
      value: {
        id,
        state: standing.state,
        smith,
        recorded: unrecorded === null,
        ...(unrecorded !== null ? { recordError: unrecorded } : {}),
      },
    };
  }

  return {
    async move(id, action, by) {
      if (!isBeadId(id)) return no("invalid", "id: expected a Beads issue id");
      if (!QUEUE_ACTIONS.some((known) => known === action))
        return no(
          "invalid",
          `action: expected one of ${QUEUE_ACTIONS.join(", ")}`,
        );
      if (!QUEUE_ACTORS.some((known) => known === by))
        return no("invalid", `by: expected one of ${QUEUE_ACTORS.join(", ")}`);
      return locked(() => moveLocked(id, action, by));
    },
    async reassign(id, smith, config) {
      if (!isBeadId(id)) return no("invalid", "id: expected a Beads issue id");
      const checked = checkSmith(config, smith);
      if (!checked.ok) return no("invalid", checked.error);
      return locked(() => reassignLocked(id, checked.smith));
    },
  };
}
