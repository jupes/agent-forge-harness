/**
 * The Beads write rows of the operator API: create, claim, comment, close.
 *
 * Each action is one `bd` call, made through the hearth's runner with an
 * argument array. Every value travels as `--flag=value` and every positional
 * comes after `--`, because `bd` reads a positional that looks like an option
 * as one: `bd comments add <id> --help` prints help, exits 0 and adds nothing.
 *
 * Exit 0 is therefore not taken as success. A write is confirmed by what `bd`
 * printed, and the bead that was written is the one it printed. Only then is
 * `bead.transitioned` appended, with the action and a hash and length of the
 * text the write carried — never the text.
 *
 * What a row must not decide for itself (origin, token, body size, the audit
 * row, the envelope) is in `../api.ts`.
 */

import type {
  BeadOptions,
  BeadPriorityOption,
  BeadWrite,
  BeadWriteResult,
  LedgerEventInput,
} from "../../../types/hearth";
import { hashText } from "../../hash-text";
import type { AppendResult } from "../../ledger/append";
import { parseBeadsIssueId } from "../../run-correlation";
import {
  type ActionRoute,
  type ApiRoute,
  type ReadRoute,
  type RouteReply,
  type RouteRequest,
  safeMessage,
} from "../api";
import type { ValidationResult } from "../validate";
import type { BdResult, BdRunner } from "./dev-api";
import {
  fail,
  isRecord,
  looksLikeSecret,
  noParameters,
} from "./operator-reads";

export interface BeadDeps {
  /** The workspace the outcome events are recorded under. */
  workspace: string;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
  /** The ledger's `appendEvent`, bound to this hearth's ledger. */
  appendEvent(event: LedgerEventInput): AppendResult;
}

/** The issue types a bead can be created as. */
export const BEAD_TYPES = ["task", "feature", "bug", "chore", "epic"] as const;

/**
 * The priority rubric, as `.claude/skills/beads-priority-assignment/SKILL.md`
 * has it: one option per value bd takes. A test reads that table and fails
 * when this differs from it.
 */
export const BEAD_PRIORITIES: readonly BeadPriorityOption[] = [
  {
    value: "P0",
    tier: "critical",
    meaning:
      "Drop other work: production down, active exploit, data loss, irreversible customer harm",
  },
  {
    value: "P1",
    tier: "high",
    meaning:
      "Urgent: broken main path, release blocker, failing CI on default branch, severe bug with weak workaround",
  },
  {
    value: "P2",
    tier: "medium",
    meaning:
      "Default scheduled work: most features, typical bugs, refactors with agreed dates",
  },
  {
    value: "P3",
    tier: "low",
    meaning:
      "Backlog: polish, nice-to-have, cleanup, research spikes with no near deadline",
  },
  {
    value: "P4",
    tier: "low",
    meaning:
      "Backlog: polish, nice-to-have, cleanup, research spikes with no near deadline",
  },
];

/** What the rubric says to use when it gives no signal. */
export const DEFAULT_BEAD_PRIORITY = "P2";

/** The longest text each field takes, in UTF-16 units: what fits on a `bd` command line. */
export const BEAD_TEXT_LIMITS = {
  title: 200,
  description: 4000,
  acceptance: 2000,
  comment: 4000,
  reason: 1000,
} as const;

/** A string that is a Beads id exactly as given, and that the ledger would store. */
function beadId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    parseBeadsIssueId(value) === value &&
    !looksLikeSecret(value)
  );
}

interface CreateInput {
  title: string;
  type: string;
  /** The digit bd takes: `0` … `4`. */
  priority: string;
  parent?: string;
  description?: string;
  acceptance?: string;
}

function createInput(request: RouteRequest): ValidationResult<CreateInput> {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const body = request.body;
  if (!isRecord(body)) return fail("Expected a JSON object");
  const title = typeof body["title"] === "string" ? body["title"].trim() : "";
  if (title.length === 0) return fail("title: a bead needs a title");
  // Absent means the default; a key that is present must be right, null included.
  const type = body["type"] === undefined ? "task" : body["type"];
  if (!BEAD_TYPES.some((known) => known === type))
    return fail(`type: expected one of ${BEAD_TYPES.join(", ")}`);
  const priority =
    body["priority"] === undefined ? DEFAULT_BEAD_PRIORITY : body["priority"];
  if (!BEAD_PRIORITIES.some((option) => option.value === priority))
    return fail(
      `priority: expected one of ${BEAD_PRIORITIES.map((option) => option.value).join(", ")}`,
    );
  const parent = body["parent"];
  if (parent !== undefined && !beadId(parent))
    return fail("parent: expected a Beads issue id");
  const optional = (name: string): string | undefined => {
    const value = body[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const description = optional("description");
  const acceptance = optional("acceptance");
  return {
    ok: true,
    value: {
      title,
      type: String(type),
      priority: String(priority).slice(1),
      ...(parent !== undefined ? { parent } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(acceptance !== undefined ? { acceptance } : {}),
    },
  };
}

/** The bead a path names, and nothing else in the request. */
function namedBead(request: RouteRequest): ValidationResult<string> {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const id = request.params["id"];
  if (!beadId(id)) return fail("id: expected a Beads issue id");
  return isRecord(request.body)
    ? { ok: true, value: id }
    : fail("Expected a JSON object");
}

/** A bead and the one text a write to it carries. */
interface Worded {
  id: string;
  text: string;
}

/** The bead a path names and the text the body carries under `key`, which must not be empty. */
const worded =
  (key: string) =>
  (request: RouteRequest): ValidationResult<Worded> => {
    const id = namedBead(request);
    if (!id.ok) return id;
    // justification: `namedBead` returned ok only for a body that is a record.
    const text = (request.body as Record<string, unknown>)[key];
    return typeof text === "string" && text.trim().length > 0
      ? { ok: true, value: { id: id.value, text } }
      : fail(`${key}: must say something`);
  };

/** What `bd` printed, once it is known to describe the write that was asked for. */
type Confirmed = Omit<BeadWriteResult, "action" | "recorded" | "recordError">;

function parsed(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/** The issue `bd create --json` printed, when it printed one with a usable id. */
function created(stdout: string): Confirmed | null {
  const issue = parsed(stdout);
  if (!isRecord(issue) || !beadId(issue["id"])) return null;
  const labels = strings(issue["labels"]);
  return {
    id: issue["id"],
    ...(typeof issue["status"] === "string" ? { status: issue["status"] } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
}

/**
 * The one issue `bd update --json` or `bd close --json` printed, with the id
 * it printed. That id, not the one the request gave, names the bead that was
 * written: given part of an id, bd acts on the issue it resolves it to.
 */
function oneIssue(
  stdout: string,
): { id: string; issue: Record<string, unknown> } | null {
  const issues = parsed(stdout);
  if (!Array.isArray(issues) || issues.length !== 1) return null;
  const [issue] = issues;
  return isRecord(issue) && beadId(issue["id"])
    ? { id: issue["id"], issue }
    : null;
}

/** What an issue bd printed says about the bead, in the answer's terms. */
function described(issue: Record<string, unknown>, id: string): Confirmed {
  const labels = strings(issue["labels"]);
  const text = (name: string): string | undefined =>
    typeof issue[name] === "string" ? issue[name] : undefined;
  const status = text("status");
  const assignee = text("assignee");
  const updatedAt = text("updated_at");
  return {
    id,
    ...(status !== undefined ? { status } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/** The issue `bd update --claim --json` printed, when it is now in progress. */
function claimed(stdout: string): Confirmed | null {
  const printed = oneIssue(stdout);
  return printed !== null && printed.issue["status"] === "in_progress"
    ? described(printed.issue, printed.id)
    : null;
}

/** The issue `bd close --json` printed, when it is now closed. */
function closed(stdout: string): Confirmed | null {
  const printed = oneIssue(stdout);
  return printed !== null && printed.issue["status"] === "closed"
    ? described(printed.issue, printed.id)
    : null;
}

/** The comment `bd comments add --json` printed, on the issue it names. */
function commented(stdout: string): Confirmed | null {
  const comment = parsed(stdout);
  if (!isRecord(comment) || !beadId(comment["issue_id"])) return null;
  const { id: commentId, author, created_at: createdAt } = comment;
  return {
    id: comment["issue_id"],
    ...(typeof commentId === "string" &&
    typeof author === "string" &&
    typeof createdAt === "string"
      ? { comment: { id: commentId, author, createdAt } }
      : {}),
  };
}

/** What a write is, for the one helper that carries it out. */
interface Write {
  action: BeadWrite;
  /** The bd command, for messages: `create`, `update --claim`, … */
  command: string;
  args: string[];
  /** The one text the write carries; its hash and length go on the outcome event. */
  text?: string;
  status: 200 | 201;
  confirm(stdout: string): Confirmed | null;
}

export function beadRoutes(deps: BeadDeps): ApiRoute[] {
  /** Append the outcome event. Null when the ledger stored it, else why not. */
  function record(action: BeadWrite, id: string, text?: string): string | null {
    let result: unknown;
    try {
      result = deps.appendEvent({
        kind: "bead.transitioned",
        workspace: deps.workspace,
        beadId: id,
        payload: {
          action,
          ...(text !== undefined
            ? { hash: hashText(text), length: text.length }
            : {}),
        },
      });
    } catch (error) {
      return safeMessage(error);
    }
    if (!isRecord(result)) return "the ledger did not answer";
    if (result["ok"] === true)
      return typeof result["id"] === "number" && result["id"] > 0
        ? null
        : "the ledger stored no row";
    return safeMessage(
      typeof result["error"] === "string"
        ? result["error"]
        : "the ledger refused",
    );
  }

  async function write(spec: Write): Promise<RouteReply> {
    const result: BdResult = await deps.runBd(spec.args);
    if (result.status !== 0)
      return {
        status: 502,
        error: safeMessage(`bd ${spec.command} failed: exit ${result.status}`),
      };
    const confirmed = spec.confirm(result.stdout);
    if (confirmed === null)
      return {
        status: 504,
        error: `bd ${spec.command} exited 0 but did not confirm the write`,
      };
    const unrecorded = record(spec.action, confirmed.id, spec.text);
    const data: BeadWriteResult = {
      ...confirmed,
      action: spec.action,
      recorded: unrecorded === null,
      ...(unrecorded !== null ? { recordError: unrecorded } : {}),
    };
    return { status: spec.status, data };
  }

  const create: ActionRoute<CreateInput> = {
    kind: "action",
    method: "POST",
    path: "/beads",
    action: "bead.create",
    validate: createInput,
    // The new id does not exist yet: the attempt is recorded against the parent.
    subject: (input) =>
      input.parent !== undefined
        ? { target: input.parent, beadId: input.parent }
        : {},
    effect: (input) =>
      write({
        action: "create",
        command: "create",
        args: [
          "create",
          `--title=${input.title}`,
          `--type=${input.type}`,
          `--priority=${input.priority}`,
          ...(input.parent !== undefined ? [`--parent=${input.parent}`] : []),
          ...(input.description !== undefined
            ? [`--description=${input.description}`]
            : []),
          ...(input.acceptance !== undefined
            ? [`--acceptance=${input.acceptance}`]
            : []),
          "--json",
        ],
        text: input.title,
        status: 201,
        confirm: created,
      }),
  };

  const subjectOf = (id: string) => ({ target: id, beadId: id });

  const claim: ActionRoute<string> = {
    kind: "action",
    method: "POST",
    path: "/beads/:id/claim",
    action: "bead.claim",
    validate: namedBead,
    subject: subjectOf,
    effect: (id) =>
      write({
        action: "claim",
        command: "update --claim",
        args: ["update", "--claim", "--json", "--", id],
        status: 200,
        confirm: claimed,
      }),
  };

  const comment: ActionRoute<Worded> = {
    kind: "action",
    method: "POST",
    path: "/beads/:id/comment",
    action: "bead.comment",
    validate: worded("text"),
    subject: (input) => subjectOf(input.id),
    effect: ({ id, text }) =>
      write({
        action: "comment",
        command: "comments add",
        // Both positionals after the terminator: a text that looks like an option stays a text.
        args: ["comments", "add", "--json", "--", id, text],
        text,
        status: 201,
        confirm: commented,
      }),
  };

  const close: ActionRoute<Worded> = {
    kind: "action",
    method: "POST",
    path: "/beads/:id/close",
    action: "bead.close",
    // This project never closes an issue without saying why.
    validate: worded("reason"),
    subject: (input) => subjectOf(input.id),
    effect: ({ id, text }) =>
      write({
        action: "close",
        command: "close",
        args: ["close", `--reason=${text}`, "--json", "--", id],
        text,
        status: 200,
        confirm: closed,
      }),
  };

  /** What a create may say: the page builds its form from this, and learns from it that a hearth is there. */
  const options: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/beads/options",
    validate: noParameters,
    read: () => {
      const data: BeadOptions = {
        types: [...BEAD_TYPES],
        priorities: [...BEAD_PRIORITIES],
        defaultPriority: DEFAULT_BEAD_PRIORITY,
        limits: { ...BEAD_TEXT_LIMITS },
      };
      return { status: 200, data };
    },
  };

  return [options, create, claim, comment, close];
}
