/**
 * An in-memory tracker for the queue's tests and the browser suite's `bd`
 * stand-in: it answers the calls the queue, its reads and eligibility make
 * (`show --readonly --json -- <id…>`, an `update` of labels or metadata, and
 * the `list` shapes of `GET /queue` and of what a shift may pick) the way bd
 * 1.1.0 does, and nothing else.
 *
 * Test support, not a second `bd`. The answers are built by
 * `../hearth/bd-answers.ts`, and `queue-bd.test.ts` compares this fixture with
 * a real `bd` when it is given a scratch tracker. What was measured and is
 * kept here: labels are added before they are removed (so removing the label
 * being added leaves none), a remove of an absent label is silent, `labels`
 * and `metadata` are absent when empty, and a child's `show` prints its
 * parent's metadata under `dependencies`, never at the top level.
 */

import { type BdIssue, bdAnswers, bdTime } from "../hearth/bd-answers";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";

export interface TrackedBead {
  id: string;
  title?: string;
  status?: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
  /** When the bead is a child: its parent's id and metadata, as `show` prints them. */
  parent?: { id: string; metadata?: Record<string, unknown> };
  description?: string;
  /** Defaults to 2, as bd prints a bead created without one. */
  priority?: number;
  /** Defaults to `task`. */
  issueType?: string;
  /** The beads that block this one (`blocks` edges). */
  blockedBy?: string[];
}

export interface QueueTracker {
  beads: Map<string, TrackedBead>;
  /** Every argument array the tracker was called with. */
  calls: string[][];
  /** The `update` calls only. */
  updates(): string[][];
  /**
   * Answer a call yourself (a refusal, a call that never finishes, help
   * text): return a result to use it, or nothing to let the tracker answer.
   */
  intercept: ((args: string[]) => BdResult | undefined) | null;
  /** Runs after an `update` was read and before it is applied: another writer getting in between. */
  beforeUpdate: ((bead: TrackedBead) => void) | null;
  /** The answer to a call the queue makes, or undefined for any other call. */
  answer(args: string[]): BdResult | undefined;
  run: BdRunner;
}

interface Update {
  id: string;
  add: string[];
  remove: string[];
  set: Array<[string, string]>;
  unset: string[];
}

/** The `update` an argument array asks for, when it changes labels or metadata with `--json`. */
function readUpdate(args: readonly string[]): Update | null {
  if (args[0] !== "update") return null;
  const update: Update = { id: "", add: [], remove: [], set: [], unset: [] };
  let json = false;
  let literal = false;
  const positionals: string[] = [];
  for (const arg of args.slice(1)) {
    if (literal) positionals.push(arg);
    else if (arg === "--") literal = true;
    else if (arg === "--json") json = true;
    else if (arg.startsWith("--add-label=")) update.add.push(arg.slice(12));
    else if (arg.startsWith("--remove-label="))
      update.remove.push(arg.slice(15));
    else if (arg.startsWith("--set-metadata=")) {
      const pair = arg.slice(15);
      const mark = pair.indexOf("=");
      update.set.push([pair.slice(0, mark), pair.slice(mark + 1)]);
    } else if (arg.startsWith("--unset-metadata="))
      update.unset.push(arg.slice(17));
    // Anything else (`--claim`, a bare positional before `--`) is not this tracker's call.
    else return null;
  }
  const changes =
    update.add.length +
    update.remove.length +
    update.set.length +
    update.unset.length;
  if (!json || positionals.length !== 1 || changes === 0) return null;
  update.id = positionals[0] ?? "";
  return update;
}

function printedIssue(
  bead: TrackedBead,
  shown: boolean,
  listed = false,
): BdIssue {
  const labels = [...(bead.labels ?? [])].sort();
  const metadata = bead.metadata ?? {};
  const now = bdTime();
  return {
    id: bead.id,
    title: bead.title ?? "",
    issue_type: bead.issueType ?? "task",
    priority: bead.priority ?? 2,
    ...(bead.description !== undefined
      ? { description: bead.description }
      : {}),
    status: bead.status ?? "open",
    created_at: now,
    updated_at: now,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    // A list row prints its blocking edges in bd's list form; `show` prints its parent.
    ...(listed && (bead.blockedBy ?? []).length > 0
      ? {
          dependencies: (bead.blockedBy ?? []).map((blocker) => ({
            issue_id: bead.id,
            depends_on_id: blocker,
            type: "blocks",
          })),
        }
      : {}),
    ...(shown && bead.parent
      ? {
          dependencies: [
            {
              id: bead.parent.id,
              dependency_type: "parent-child",
              ...(bead.parent.metadata
                ? { metadata: bead.parent.metadata }
                : {}),
            },
          ],
        }
      : {}),
  };
}

/** A list flag that takes a value, and the ones the answer does not depend on. */
const LIST_VALUED = new Set([
  "--label-any",
  "--label",
  "--metadata-field",
  "--exclude-label",
  "--limit",
]);
const LIST_IGNORED = new Set(["--readonly", "--flat", "--json"]);

/**
 * The answer to a `list` of the shapes the hearth and eligibility send
 * (`QUEUE_LIST_ARGS`, `QUEUED_EXACT_ARGS`, the latter with `--ready`), or
 * undefined for any other list. Labels are matched literally, as bd does;
 * `--ready` keeps open beads whose blockers are all closed.
 */
export function answerQueueList(
  args: readonly string[],
  beads: readonly TrackedBead[],
): BdResult | undefined {
  if (args[0] !== "list") return undefined;
  let all = false;
  let ready = false;
  let filtered = false;
  const anyOf: string[] = [];
  const allOf: string[] = [];
  const none: string[] = [];
  const fields: Array<[string, string]> = [];
  for (let i = 1; i < args.length; i++) {
    const flag = args[i] as string;
    if (LIST_IGNORED.has(flag)) continue;
    if (flag === "--all") {
      all = true;
      continue;
    }
    if (flag === "--ready") {
      ready = true;
      continue;
    }
    if (!LIST_VALUED.has(flag)) return undefined;
    const value = args[++i];
    if (value === undefined) return undefined;
    if (flag === "--limit") continue;
    filtered = true;
    if (flag === "--label-any") anyOf.push(...value.split(","));
    else if (flag === "--label") allOf.push(value);
    else if (flag === "--exclude-label") none.push(...value.split(","));
    else {
      const mark = value.indexOf("=");
      fields.push([value.slice(0, mark), value.slice(mark + 1)]);
    }
  }
  // A list with no queue filter is not one of the queue's.
  if (!filtered) return undefined;
  const byId = new Map(beads.map((bead) => [bead.id, bead]));
  const rows = beads.filter((bead) => {
    const labels = bead.labels ?? [];
    const status = bead.status ?? "open";
    if (!all && status === "closed") return false;
    if (anyOf.length > 0 && !anyOf.some((label) => labels.includes(label)))
      return false;
    if (!allOf.every((label) => labels.includes(label))) return false;
    if (none.some((label) => labels.includes(label))) return false;
    if (!fields.every(([key, value]) => bead.metadata?.[key] === value))
      return false;
    if (
      ready &&
      (status !== "open" ||
        (bead.blockedBy ?? []).some(
          (blocker) => (byId.get(blocker)?.status ?? "open") !== "closed",
        ))
    )
      return false;
    return true;
  });
  return {
    status: 0,
    stdout: `${JSON.stringify(
      rows.map((bead) => printedIssue(bead, false, true)),
      null,
      2,
    )}\n`,
    stderr: "",
  };
}

export function queueTracker(beads: TrackedBead[] = []): QueueTracker {
  const tracker: QueueTracker = {
    beads: new Map(beads.map((bead) => [bead.id, structuredClone(bead)])),
    calls: [],
    updates: () => tracker.calls.filter((args) => args[0] === "update"),
    intercept: null,
    beforeUpdate: null,
    answer(args) {
      const isShow =
        args.length >= 5 &&
        args[0] === "show" &&
        args[1] === "--readonly" &&
        args[2] === "--json" &&
        args[3] === "--";
      const update = isShow ? null : readUpdate(args);
      if (!isShow && update === null) return undefined;
      tracker.calls.push(args);
      const given = tracker.intercept?.(args);
      if (given !== undefined) return given;
      if (isShow) {
        const ids = args.slice(4);
        if (ids.length === 1) {
          const bead = tracker.beads.get(ids[0] ?? "");
          return bead
            ? bdAnswers.shown(printedIssue(bead, true))
            : bdAnswers.notShown(ids[0] ?? "");
        }
        // Several ids: the ones that exist, or, when none does, the error.
        const found = ids
          .map((id) => tracker.beads.get(id))
          .filter((bead): bead is TrackedBead => bead !== undefined);
        if (found.length === 0) return bdAnswers.notShown(ids.join(", "));
        return {
          status: 0,
          stdout: `${JSON.stringify(
            found.map((bead) => printedIssue(bead, true)),
            null,
            2,
          )}\n`,
          stderr: "",
        };
      }
      if (update === null) return undefined;
      const bead = tracker.beads.get(update.id);
      if (!bead) return bdAnswers.notResolved(update.id);
      tracker.beforeUpdate?.(bead);
      // bd adds before it removes.
      const labels = new Set([...(bead.labels ?? []), ...update.add]);
      for (const label of update.remove) labels.delete(label);
      bead.labels = [...labels];
      const metadata = { ...(bead.metadata ?? {}) };
      for (const [key, value] of update.set) metadata[key] = value;
      for (const key of update.unset) delete metadata[key];
      bead.metadata = metadata;
      return bdAnswers.updated(printedIssue(bead, false));
    },
    run: async (args) =>
      tracker.answer(args) ?? {
        status: 1,
        stdout: "",
        stderr: `Error: the queue tracker does not answer: ${args[0] ?? ""}\n`,
      },
  };
  return tracker;
}
