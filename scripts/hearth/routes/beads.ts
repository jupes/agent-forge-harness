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

/** Half of a surrogate pair: it cannot reach `bd` as it was sent. */
const LONE_SURROGATE = /\p{Cs}/u;
/** Any control character but newline and tab. */
const CONTROL_IN_A_TEXT = /[^\P{Cc}\n\t]/u;
/** What a one-line title may not hold: a control character, a line or paragraph separator, a bidirectional control. */
const NOT_IN_A_TITLE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

/** The body, when it is an object that holds nothing but the fields its row takes. */
function fields(
  request: RouteRequest,
  allowed: readonly string[],
): ValidationResult<Record<string, unknown>> {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const body = request.body;
  if (!isRecord(body)) return fail("Expected a JSON object");
  // Nothing rides along: a field the row does not take is refused, not ignored.
  return Object.keys(body).every((key) => allowed.includes(key))
    ? { ok: true, value: body }
    : fail(
        allowed.length === 0
          ? "Expected an empty object: this action takes no fields"
          : `Unknown field: this action takes only ${allowed.join(", ")}`,
      );
}

/**
 * A text as it will be handed to `bd`: as given, once CR LF is LF. Absent, or
 * nothing but whitespace, is no text: `undefined`.
 */
function textOf(
  name: string,
  value: unknown,
  limit: number,
): ValidationResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return fail(`${name}: expected text`);
  if (LONE_SURROGATE.test(value))
    return fail(`${name}: holds half of a surrogate pair`);
  const text = value.replace(/\r\n?/g, "\n");
  if (CONTROL_IN_A_TEXT.test(text))
    return fail(
      `${name}: control characters other than newline and tab are not accepted`,
    );
  if (text.trim().length === 0) return { ok: true, value: undefined };
  return text.length > limit
    ? fail(`${name}: at most ${limit} characters`)
    : { ok: true, value: text };
}

function titleOf(value: unknown): ValidationResult<string> {
  if (typeof value !== "string" || LONE_SURROGATE.test(value))
    return fail("title: a bead needs a title, as text");
  const title = value.trim();
  if (title.length === 0) return fail("title: a bead needs a title");
  if (NOT_IN_A_TITLE.test(title))
    return fail(
      "title: one line, with no control or bidirectional-control characters",
    );
  return title.length > BEAD_TEXT_LIMITS.title
    ? fail(`title: at most ${BEAD_TEXT_LIMITS.title} characters`)
    : { ok: true, value: title };
}

interface CreateInput {
  title: string;
  type: string;
  /** The digit bd takes: `0` \u2026 `4`. */
  priority: string;
  parent?: string;
  description?: string;
  acceptance?: string;
}

const CREATE_FIELDS = [
  "title",
  "type",
  "priority",
  "parent",
  "description",
  "acceptance",
];

function createInput(request: RouteRequest): ValidationResult<CreateInput> {
  const given = fields(request, CREATE_FIELDS);
  if (!given.ok) return given;
  const body = given.value;
  const title = titleOf(body["title"]);
  if (!title.ok) return title;
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
  const description = textOf(
    "description",
    body["description"],
    BEAD_TEXT_LIMITS.description,
  );
  if (!description.ok) return description;
  // `bd create --description=-` means "read the description from standard
  // input". The runner leaves stdin open, so that call would wait for the
  // runner's limit and then create the issue without its description.
  if (description.value === "-")
    return fail(
      'description: a description of exactly "-" is read by bd as "take it from standard input"; say more than that',
    );
  const acceptance = textOf(
    "acceptance",
    body["acceptance"],
    BEAD_TEXT_LIMITS.acceptance,
  );
  if (!acceptance.ok) return acceptance;
  return {
    ok: true,
    value: {
      title: title.value,
      type: String(type),
      priority: String(priority).slice(1),
      ...(parent !== undefined ? { parent } : {}),
      ...(description.value !== undefined
        ? { description: description.value }
        : {}),
      ...(acceptance.value !== undefined
        ? { acceptance: acceptance.value }
        : {}),
    },
  };
}

/** The bead a path names, when the body holds nothing but `allowed`. */
function namedBead(
  request: RouteRequest,
  allowed: readonly string[],
): ValidationResult<{ id: string; body: Record<string, unknown> }> {
  const given = fields(request, allowed);
  if (!given.ok) return given;
  const id = request.params["id"];
  return beadId(id)
    ? { ok: true, value: { id, body: given.value } }
    : fail("id: expected a Beads issue id");
}

/** A claim: the bead, and a body with nothing in it. */
function claimInput(request: RouteRequest): ValidationResult<string> {
  const named = namedBead(request, []);
  return named.ok ? { ok: true, value: named.value.id } : named;
}

/** A bead and the one text a write to it carries. */
interface Worded {
  id: string;
  text: string;
}

/** The bead a path names and the text the body carries under `key`, which must say something. */
const worded =
  (key: "text" | "reason", limit: number) =>
  (request: RouteRequest): ValidationResult<Worded> => {
    const named = namedBead(request, [key]);
    if (!named.ok) return named;
    const text = textOf(key, named.value.body[key], limit);
    if (!text.ok) return text;
    return text.value === undefined
      ? fail(`${key}: must say something`)
      : { ok: true, value: { id: named.value.id, text: text.value } };
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

/** bd prints whole seconds, so a close timed up to this long before the call began is this call's. */
const CLOSE_TIME_SLACK_MS = 2000;

/**
 * The issue `bd close --json` printed, when this call closed it.
 *
 * Closing an issue that is already closed exits 0 too: bd prints the issue and
 * keeps the first reason and the first closing time. So a close is this call's
 * only when the reason printed is the one that was sent and the closing time
 * is not from before the call began.
 */
const closed =
  (reason: string) =>
  (stdout: string, began: number): Confirmed | Conflict | null => {
    const printed = oneIssue(stdout);
    if (printed === null || printed.issue["status"] !== "closed") return null;
    const closedAt = Date.parse(String(printed.issue["closed_at"] ?? ""));
    const earlier =
      printed.issue["close_reason"] !== reason ||
      (!Number.isNaN(closedAt) && closedAt < began - CLOSE_TIME_SLACK_MS);
    return earlier
      ? {
          conflict: `${printed.id} was already closed; nothing was changed, and the reason it was closed with stands`,
        }
      : described(printed.issue, printed.id);
  };

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

/** A write that was asked for but had already been done: nothing changed. */
interface Conflict {
  conflict: string;
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
  /** How to see whether the write happened, for an answer that cannot say. */
  check: string;
  confirm(stdout: string, began: number): Confirmed | Conflict | null;
}

/**
 * Why bd refused, in bd's own words. With `--json` some commands print the
 * error on stdout and nothing on stderr; the runner then fills stderr with its
 * own line, `Command failed: bd <every argument>`, which repeats the text that
 * was sent and is never passed on.
 */
function refusal(result: BdResult): string {
  const printed = parsed(result.stdout);
  if (isRecord(printed) && typeof printed["error"] === "string")
    return printed["error"].trim() || `exit ${result.status}`;
  const said = result.stderr.trim();
  return said.length > 0 && !said.startsWith("Command failed:")
    ? said.replace(/^Error:\s*/, "")
    : `exit ${result.status}`;
}

/** Whether a call with no exit status never became a process at all. */
function neverStarted(result: BdResult): boolean {
  return (
    !result.stderr.startsWith("Command failed:") &&
    /ENOENT|Executable not found/.test(result.stderr)
  );
}

/** A busy ledger is tried this many times, this far apart, before the answer says "not recorded". */
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_MS = 25;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export function beadRoutes(deps: BeadDeps): ApiRoute[] {
  /** Append the outcome event. Null when the ledger stored it, else why not. */
  async function record(
    action: BeadWrite,
    id: string,
    text?: string,
  ): Promise<string | null> {
    const event: LedgerEventInput = {
      kind: "bead.transitioned",
      workspace: deps.workspace,
      beadId: id,
      // Metadata only: what was done, and a hash and length of the one text it
      // carried. The text itself goes to bd and nowhere else.
      payload: {
        action,
        ...(text !== undefined
          ? { hash: hashText(text), length: text.length }
          : {}),
      },
    };
    for (let attempt = 1; ; attempt++) {
      let result: unknown;
      try {
        result = deps.appendEvent(event);
      } catch (error) {
        return safeMessage(error);
      }
      if (!isRecord(result)) return "the ledger did not answer";
      if (result["ok"] === true)
        return typeof result["id"] === "number" && result["id"] > 0
          ? null
          : "the ledger stored no row";
      const reason =
        typeof result["error"] === "string"
          ? result["error"]
          : "the ledger refused";
      if (!/busy|locked/i.test(reason) || attempt >= RECORD_ATTEMPTS)
        return safeMessage(reason);
      await sleep(RECORD_RETRY_MS);
    }
  }

  /**
   * One call to bd, never repeated, and one of five answers. None of them is a
   * 403: the page posts an action again after a 403, which is safe only while a
   * 403 always means "refused before anything was done".
   */
  async function write(spec: Write): Promise<RouteReply> {
    const began = Date.now();
    // 504 is the one status that means "the outcome is not known".
    const unknown = (what: string): RouteReply => ({
      status: 504,
      error: `bd ${spec.command} ${what} Check with \`${spec.check}\` before trying again.`,
    });
    let result: BdResult;
    try {
      result = await deps.runBd(spec.args);
    } catch {
      // The runner rejects for an argument it cannot pass on. Its message
      // repeats that argument, so it is not passed on either.
      return unknown(
        "did not finish: it could not be run. The change may still have been made.",
      );
    }
    if (result.status === null)
      return neverStarted(result)
        ? {
            status: 502,
            error:
              "bd could not be started (is it installed, and on the PATH of this control plane?). Nothing was changed.",
          }
        : unknown(
            "did not finish within its time limit. The change may still have been made.",
          );
    if (result.status !== 0)
      return {
        status: 502,
        error: safeMessage(`bd ${spec.command} failed: ${refusal(result)}`),
      };
    const confirmed = spec.confirm(result.stdout, began);
    if (confirmed === null)
      return unknown(
        "exited 0 but did not confirm the change. It may have been made.",
      );
    if ("conflict" in confirmed)
      return { status: 409, error: confirmed.conflict };
    const unrecorded = await record(spec.action, confirmed.id, spec.text);
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
    // A create at its limits is about 18,700 bytes in three-byte characters and
    // 24,700 when made of CR LF pairs: over the table's default of 16,000.
    maxBodyBytes: 32_000,
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
        // A create that did not answer left no id to look up.
        check: "bd list",
        confirm: created,
      }),
  };

  const subjectOf = (id: string) => ({ target: id, beadId: id });

  const claim: ActionRoute<string> = {
    kind: "action",
    method: "POST",
    path: "/beads/:id/claim",
    action: "bead.claim",
    validate: claimInput,
    subject: subjectOf,
    effect: (id) =>
      write({
        action: "claim",
        command: "update --claim",
        args: ["update", "--claim", "--json", "--", id],
        status: 200,
        check: `bd show ${id}`,
        confirm: claimed,
      }),
  };

  const comment: ActionRoute<Worded> = {
    kind: "action",
    method: "POST",
    path: "/beads/:id/comment",
    action: "bead.comment",
    validate: worded("text", BEAD_TEXT_LIMITS.comment),
    subject: (input) => subjectOf(input.id),
    effect: ({ id, text }) =>
      write({
        action: "comment",
        command: "comments add",
        // Both positionals after the terminator: a text that looks like an option stays a text.
        args: ["comments", "add", "--json", "--", id, text],
        text,
        status: 201,
        check: `bd show ${id}`,
        confirm: commented,
      }),
  };

  const close: ActionRoute<Worded> = {
    kind: "action",
    method: "POST",
    path: "/beads/:id/close",
    action: "bead.close",
    // This project never closes an issue without saying why.
    validate: worded("reason", BEAD_TEXT_LIMITS.reason),
    subject: (input) => subjectOf(input.id),
    effect: ({ id, text }) =>
      write({
        action: "close",
        command: "close",
        args: ["close", `--reason=${text}`, "--json", "--", id],
        text,
        status: 200,
        check: `bd show ${id}`,
        confirm: closed(text),
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
