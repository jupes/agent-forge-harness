/**
 * What `bd` prints for a write to the tracker, in one place.
 *
 * Test support, not a second `bd`: the hermetic hearth's recorder
 * (`testing.ts`), the browser suite's stand-in (`tests/e2e/bd-stand-in.ts`)
 * and the tests of the write routes all build their answers here, so the
 * three cannot drift apart. The shapes are those of bd 1.1.0 with `--json`:
 *
 * - `create` prints the issue as an object;
 * - `update --claim` and `close` print a one-element array;
 * - `comments add` prints the comment;
 * - a refusal exits 1, and says why on stderr (`create`, `update`) or as
 *   `{ "error": … }` on stdout with nothing on stderr (`close`, `comments`).
 *
 * Times are built when the answer is, at whole seconds, as bd prints them: a
 * canned `closed_at` would always be older than the call it answers.
 */

import type { BdResult } from "./routes/dev-api";

/** An issue as bd prints one. */
export interface BdIssue {
  id: string;
  title: string;
  issue_type: string;
  priority: number;
  status: string;
  assignee?: string;
  labels?: string[];
  close_reason?: string;
  closed_at?: string;
  created_at: string;
  updated_at: string;
}

/** A write as the routes send it to bd. */
export type BdWrite =
  | {
      verb: "create";
      title: string;
      type: string;
      priority: string;
      parent?: string;
      description?: string;
      acceptance?: string;
    }
  | { verb: "claim"; id: string }
  | { verb: "comment"; id: string; text: string }
  | { verb: "close"; id: string; reason: string };

/** The time as bd prints it: UTC, whole seconds. */
export function bdTime(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/**
 * Split an argument array the way bd's own parser does: `--name=value` and
 * `--name` are options until a bare `--`; everything else is positional. A
 * text that looks like an option and comes before the `--` is therefore read
 * as an option, which is the mistake the routes must not make.
 */
export function splitArgs(args: readonly string[]): {
  options: Map<string, string | true>;
  positionals: string[];
} {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  let literal = false;
  for (const arg of args) {
    if (literal) positionals.push(arg);
    else if (arg === "--") literal = true;
    else if (arg.startsWith("--")) {
      const mark = arg.indexOf("=");
      if (mark === -1) options.set(arg.slice(2), true);
      else options.set(arg.slice(2, mark), arg.slice(mark + 1));
    } else positionals.push(arg);
  }
  return { options, positionals };
}

/** The write an argument array asks for, when it is one of the four the routes make with `--json`. */
export function readWrite(args: readonly string[]): BdWrite | null {
  const { options, positionals } = splitArgs(args);
  if (options.get("json") !== true) return null;
  const text = (name: string): string | undefined => {
    const value = options.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const [command, second, third, fourth] = positionals;
  if (command === "create") {
    const title = text("title");
    if (title === undefined) return null;
    const parent = text("parent");
    const description = text("description");
    const acceptance = text("acceptance");
    return {
      verb: "create",
      title,
      type: text("type") ?? "task",
      priority: text("priority") ?? "2",
      ...(parent !== undefined ? { parent } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(acceptance !== undefined ? { acceptance } : {}),
    };
  }
  if (command === "update" && options.get("claim") === true && second)
    return { verb: "claim", id: second };
  if (command === "comments" && second === "add" && third && fourth)
    return { verb: "comment", id: third, text: fourth };
  if (command === "close" && second) {
    const reason = text("reason");
    return reason === undefined ? null : { verb: "close", id: second, reason };
  }
  return null;
}

const printed = (value: unknown): BdResult => ({
  status: 0,
  stdout: `${JSON.stringify(value, null, 2)}\n`,
  stderr: "",
});

export const bdAnswers = {
  created: (issue: BdIssue): BdResult => printed(issue),
  claimed: (issue: BdIssue): BdResult => printed([issue]),
  closed: (issue: BdIssue): BdResult => printed([issue]),
  commented: (comment: {
    id: string;
    issueId: string;
    author: string;
    text: string;
    createdAt: string;
  }): BdResult =>
    printed({
      author: comment.author,
      created_at: comment.createdAt,
      id: comment.id,
      issue_id: comment.issueId,
      schema_version: 1,
      text: comment.text,
    }),
  /** How `create` and `update --claim` refuse: `Error: …` on stderr. */
  refusedOnStderr: (message: string): BdResult => ({
    status: 1,
    stdout: "",
    stderr: `Error: ${message}\n`,
  }),
  /**
   * How `close` and `comments add` refuse under `--json`: the error on stdout
   * and nothing on stderr, so the runner fills stderr with its own line, which
   * repeats every argument.
   */
  refusedOnStdout: (message: string, args: readonly string[]): BdResult => ({
    status: 1,
    stdout: `${JSON.stringify({ error: message, schema_version: 1 }, null, 2)}\n`,
    stderr: `Command failed: bd ${args.join(" ")}`,
  }),
  /** A call the runner killed at its limit: no status, and the runner's own line. */
  notFinished: (args: readonly string[]): BdResult => ({
    status: null,
    stdout: "",
    stderr: `Command failed: bd ${args.join(" ")}`,
  }),
  /** What bd prints, exiting 0, when a text it took for an option was `--help`. */
  help: (): BdResult => ({
    status: 0,
    stdout:
      "Add a comment to an issue.\n\nUsage:\n  bd comments add [issue-id] [text] [flags]\n",
    stderr: "",
  }),
};
