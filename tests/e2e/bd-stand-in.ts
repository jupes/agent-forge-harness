/**
 * A recording stand-in for `bd`, for the browser suite and nothing else.
 *
 * Global setup compiles this file to a program named `bd` and the suite's
 * servers are started with a PATH that holds its directory, so the control
 * plane under test runs this instead of a tracker's CLI. It:
 *
 * - appends every argument array it is called with to `calls.jsonl`;
 * - keeps the issues it has created in `issues.json`;
 * - answers the four writes the Beads routes make in the shapes bd prints
 *   (`scripts/hearth/bd-answers.ts`, the same module the unit tests use);
 * - refuses what bd refuses: a parent or an id it does not know, a claim of a
 *   closed issue; and leaves an issue that is already closed, or already
 *   claimed, as it was, exiting 0;
 * - makes a child as `bd create --parent` does: every label of the parent, a
 *   `queue:` label included, and none of its metadata (`childOf`);
 * - answers the queue's calls as `scripts/scheduler/queue-fixture.ts` does
 *   (which `queue-bd.test.ts` compares with a real bd): `show` of one id or
 *   several, an `update` of labels or metadata, and the `list` shapes of
 *   `GET /queue` and of eligibility;
 * - answers `export` (the Beads counts read) with its issues, one line each;
 * - keeps what `comments add` writes, and answers the two reads of a
 *   council's bead source (`--readonly show <id> --json`, `--readonly
 *   comments <id> --json`) for an issue it knows: the issue, and the comments
 *   it keeps for it, oldest first, in the shape bd lists them;
 * - answers any other `list` with an empty list, and exits 2 for anything
 *   else.
 *
 * Its files live in the directory `BD_STAND_IN_STATE` names: the run's own
 * home. The issues and the comments are read and replaced through
 * `bd-stand-in-state.ts`, which the suite's helpers use too. Nothing here
 * reads or writes a tracker.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type BdIssue,
  bdAnswers,
  bdTime,
  readWrite,
} from "../../scripts/hearth/bd-answers";
import {
  answerQueueList,
  childOf,
  queueTracker,
  type TrackedBead,
} from "../../scripts/scheduler/queue-fixture";
import {
  readComments,
  readState,
  type StandInIssue,
  withStateLock,
  writeComments,
  writeState,
} from "./bd-stand-in-state";

interface Printed {
  status: number | null;
  stdout: string;
  stderr: string;
}

const args = process.argv.slice(2);
const state = process.env["BD_STAND_IN_STATE"];
if (!state) {
  process.stderr.write("bd stand-in: BD_STAND_IN_STATE is not set\n");
  process.exit(2);
}
mkdirSync(state, { recursive: true });
appendFileSync(join(state, "calls.jsonl"), `${JSON.stringify(args)}\n`);

/** The validated state directory, shared by the transaction below. */
const home: string = state;
function run(): Printed {
  const issues = readState(home);
  const save = (issue: BdIssue): BdIssue => {
    issues[issue.id] = issue;
    writeState(home, issues);
    return issue;
  };
  const unknown = (id: string): string =>
    `resolving ${id}: no issue found matching "${id}"`;

  /** An issue of the stand-in as the queue fixture keeps beads. */
  function asTracked(issue: StandInIssue): TrackedBead {
    return {
      id: issue.id,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      issueType: issue.issue_type,
      ...(issue.labels !== undefined ? { labels: [...issue.labels] } : {}),
      ...(issue.metadata !== undefined
        ? { metadata: { ...issue.metadata } }
        : {}),
      ...(issue.description !== undefined
        ? { description: issue.description }
        : {}),
      ...(issue.blockedBy !== undefined
        ? { blockedBy: [...issue.blockedBy] }
        : {}),
    };
  }

  /** The queue's calls, answered by the fixture over the stand-in's issues; undefined for any other call. */
  function answerQueue(): Printed | undefined {
    const beads = Object.values(issues).map(asTracked);
    const listed = answerQueueList(args, beads);
    if (listed !== undefined) return listed;
    const tracker = queueTracker(beads);
    const answered = tracker.answer(args);
    if (answered === undefined) return undefined;
    if (args[0] === "update" && answered.status === 0) {
      const changed = tracker.beads.get(args.at(-1) ?? "");
      const issue = changed ? issues[changed.id] : undefined;
      if (changed && issue) {
        const { labels: _labels, metadata: _metadata, ...rest } = issue;
        save({
          ...rest,
          ...(changed.labels && changed.labels.length > 0
            ? { labels: changed.labels }
            : {}),
          ...(changed.metadata && Object.keys(changed.metadata).length > 0
            ? { metadata: changed.metadata }
            : {}),
          updated_at: bdTime(),
        });
      }
    }
    return answered;
  }

  /**
   * `bd export`, as the Beads counts read asks for it: one line per issue in the
   * shape bd prints, with a `blocks` dependency for each bead that blocks it.
   */
  function answerExport(): Printed {
    const lines = Object.values(issues).map((issue) => {
      const { blockedBy, ...printed } = issue;
      return `${JSON.stringify({
        ...printed,
        dependencies: [
          ...(printed.dependencies ?? []),
          ...(blockedBy ?? []).map((blocker) => ({
            issue_id: issue.id,
            depends_on_id: blocker,
            type: "blocks",
          })),
        ],
      })}\n`;
    });
    return { status: 0, stdout: lines.join(""), stderr: "" };
  }

  /**
   * The two reads of a council's bead source, `bd --readonly show <id> --json`
   * and `bd --readonly comments <id> --json`: the issue as bd prints it (in an
   * array), and the comments `comments add` left on it, oldest first, as bd
   * lists them. An id it does not know is refused as bd refuses it. Undefined
   * for any other call.
   */
  function answerBeadSource(): Printed | undefined {
    const [readonly, verb, id, json, ...rest] = args;
    if (
      readonly !== "--readonly" ||
      (verb !== "show" && verb !== "comments") ||
      id === undefined ||
      json !== "--json" ||
      rest.length > 0
    )
      return undefined;
    const issue = issues[id];
    if (issue === undefined) return bdAnswers.refusedOnStderr(unknown(id));
    if (verb === "comments")
      return bdAnswers.listedComments(readComments(home)[id] ?? []);
    const { blockedBy: _blockedBy, ...printed } = issue;
    return { status: 0, stdout: `${JSON.stringify([printed])}\n`, stderr: "" };
  }

  function answer(): Printed {
    const queued = answerQueue();
    if (queued !== undefined) return queued;
    const read = answerBeadSource();
    if (read !== undefined) return read;
    if (args[0] === "list") return { status: 0, stdout: "[]\n", stderr: "" };
    if (args[0] === "export") return answerExport();
    const write = readWrite(args);
    if (write === null)
      return {
        status: 2,
        stdout: "",
        stderr: `bd stand-in: unsupported: ${JSON.stringify(args)}\n`,
      };
    const now = bdTime();

    if (write.verb === "create") {
      const parent =
        write.parent === undefined ? undefined : issues[write.parent];
      if (write.parent !== undefined && parent === undefined)
        return bdAnswers.refusedOnStderr(
          `parent issue ${write.parent} not found`,
        );
      const prefix = write.parent === undefined ? "e2e-" : `${write.parent}.`;
      const siblings = Object.keys(issues).filter(
        (id) => id.startsWith(prefix) && !id.slice(prefix.length).includes("."),
      ).length;
      const id = `${prefix}${siblings + 1}`;
      // bd create --parent copies every label of the parent, and none of its metadata.
      const labels =
        parent === undefined || write.noInheritLabels
          ? undefined
          : childOf(asTracked(parent), id).labels;
      return bdAnswers.created(
        save({
          id,
          title: write.title,
          issue_type: write.type,
          priority: Number(write.priority),
          status: "open",
          ...(write.description !== undefined
            ? { description: write.description }
            : {}),
          ...(write.acceptance !== undefined
            ? { acceptance_criteria: write.acceptance }
            : {}),
          ...(labels !== undefined || write.labels !== undefined
            ? {
                labels: [
                  ...new Set([...(labels ?? []), ...(write.labels ?? [])]),
                ].sort(),
              }
            : {}),
          ...(write.parent !== undefined
            ? {
                dependencies: [
                  {
                    issue_id: id,
                    depends_on_id: write.parent,
                    type: "parent-child",
                  },
                ],
              }
            : {}),
          created_at: now,
          updated_at: now,
        }),
      );
    }

    const issue = issues[write.id];
    if (write.verb === "claim") {
      if (issue === undefined)
        return bdAnswers.refusedOnStderr(unknown(write.id));
      if (issue.status === "closed")
        return bdAnswers.refusedOnStderr(
          `claiming ${write.id}: issue not claimable: status closed`,
        );
      // Claiming an issue this actor already holds changes nothing: bd prints it as it is.
      if (issue.status === "in_progress") return bdAnswers.claimed(issue);
      return bdAnswers.claimed(
        save({
          ...issue,
          status: "in_progress",
          assignee: "operator",
          updated_at: now,
        }),
      );
    }
    // `close` and `comments add` say why they refuse on stdout, with nothing on stderr.
    if (issue === undefined)
      return {
        ...bdAnswers.refusedOnStdout(unknown(write.id), args),
        stderr: "",
      };
    if (write.verb === "comment") {
      // Kept, so the comments read prints it back as bd does.
      const comment = {
        id: randomUUID(),
        issueId: issue.id,
        author: "operator",
        text: write.text,
        createdAt: new Date().toISOString(),
      };
      const comments = readComments(home);
      comments[issue.id] = [...(comments[issue.id] ?? []), comment];
      writeComments(home, comments);
      return bdAnswers.commented(comment);
    }
    // Closing a closed issue changes nothing: bd prints it as it is and exits 0.
    if (issue.status === "closed") return bdAnswers.closed(issue);
    return bdAnswers.closed(
      save({
        ...issue,
        status: "closed",
        close_reason: write.reason,
        closed_at: now,
        updated_at: now,
      }),
    );
  }

  return answer();
}
const printed = withStateLock(home, run);
process.stdout.write(printed.stdout);
process.stderr.write(printed.stderr);
process.exit(printed.status ?? 1);
