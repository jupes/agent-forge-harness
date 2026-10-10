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
 *   closed issue; and leaves an already closed issue as it was, exiting 0;
 * - answers `list` with an empty list, and exits 2 for anything else.
 *
 * Both files live in the directory `BD_STAND_IN_STATE` names: the run's own
 * home. Nothing here reads or writes a tracker.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type BdIssue,
  bdAnswers,
  bdTime,
  readWrite,
} from "../../scripts/hearth/bd-answers";

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

const issuesFile = join(state, "issues.json");
const issues: Record<string, BdIssue> = existsSync(issuesFile)
  ? (JSON.parse(readFileSync(issuesFile, "utf8")) as Record<string, BdIssue>)
  : {};
const save = (issue: BdIssue): BdIssue => {
  issues[issue.id] = issue;
  writeFileSync(issuesFile, JSON.stringify(issues, null, 2));
  return issue;
};
const unknown = (id: string): string =>
  `resolving ${id}: no issue found matching "${id}"`;

function answer(): Printed {
  if (args[0] === "list") return { status: 0, stdout: "[]\n", stderr: "" };
  const write = readWrite(args);
  if (write === null)
    return {
      status: 2,
      stdout: "",
      stderr: `bd stand-in: unsupported: ${JSON.stringify(args)}\n`,
    };
  const now = bdTime();

  if (write.verb === "create") {
    if (write.parent !== undefined && issues[write.parent] === undefined)
      return bdAnswers.refusedOnStderr(
        `parent issue ${write.parent} not found`,
      );
    const prefix = write.parent === undefined ? "e2e-" : `${write.parent}.`;
    const siblings = Object.keys(issues).filter(
      (id) => id.startsWith(prefix) && !id.slice(prefix.length).includes("."),
    ).length;
    return bdAnswers.created(
      save({
        id: `${prefix}${siblings + 1}`,
        title: write.title,
        issue_type: write.type,
        priority: Number(write.priority),
        status: "open",
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
  if (write.verb === "comment")
    return bdAnswers.commented({
      id: `comment-${Date.now()}`,
      issueId: issue.id,
      author: "operator",
      text: write.text,
      createdAt: new Date().toISOString(),
    });
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

const printed = answer();
process.stdout.write(printed.stdout);
process.stderr.write(printed.stderr);
process.exit(printed.status ?? 1);
