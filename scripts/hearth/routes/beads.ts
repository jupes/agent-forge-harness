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

import {
  BENCH_NAMES,
  type BeadOptions,
  type BeadPriorityOption,
  type BeadWrite,
  type BeadWriteResult,
  type LedgerEventInput,
} from "../../../types/hearth";
import { hashText } from "../../hash-text";
import type { AppendResult } from "../../ledger/append";
import { parseFileMap } from "../../scheduler/filemap";
import {
  type ActionRoute,
  type ApiRoute,
  type ReadRoute,
  type RouteReply,
  type RouteRequest,
  safeMessage,
} from "../api";
import {
  isBeadId as beadId,
  neverStarted,
  parsed,
  refusal,
  storeEvent,
} from "../tracker-write";
import type { ValidationResult } from "../validate";
import type { BdResult, BdRunner } from "./dev-api";
import {
  fail,
  bodyFields as fields,
  isRecord,
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
  labels: 30,
  label: 100,
  fileMap: 100,
} as const;

/** Half of a surrogate pair: it cannot reach `bd` as it was sent. */
const LONE_SURROGATE = /\p{Cs}/u;
/** Any control character but newline and tab. */
const CONTROL_IN_A_TEXT = /[^\P{Cc}\n\t]/u;
/** What a one-line title may not hold: a control character, a line or paragraph separator, a bidirectional control. */
const NOT_IN_A_TITLE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

/**
 * What draws nothing: whitespace, the format characters (a zero-width space, a
 * word joiner), the other characters Unicode marks as default-ignorable (a
 * Hangul filler, a variation selector, the combining grapheme joiner) and the
 * braille blank (U+2800).
 */
const NOTHING_TO_READ = /[\s\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** Whether a text holds anything a reader would see. */
function saysSomething(text: string): boolean {
  return text.replace(NOTHING_TO_READ, "").length > 0;
}

/** What bd itself accepts for a title: 500 bytes. */
const BD_TITLE_BYTES = 500;

/**
 * A text as it will be handed to `bd`: as given, once CR LF is LF. Absent, or
 * one that says nothing, is no text: `undefined`.
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
  if (!saysSomething(text)) return { ok: true, value: undefined };
  return text.length > limit
    ? fail(`${name}: at most ${limit} characters`)
    : { ok: true, value: text };
}

function titleOf(value: unknown): ValidationResult<string> {
  if (typeof value !== "string" || LONE_SURROGATE.test(value))
    return fail("title: a bead needs a title, as text");
  const title = value.trim();
  if (!saysSomething(title)) return fail("title: a bead needs a title");
  if (NOT_IN_A_TITLE.test(title))
    return fail(
      "title: one line, with no control or bidirectional-control characters",
    );
  if (title.length > BEAD_TEXT_LIMITS.title)
    return fail(`title: at most ${BEAD_TEXT_LIMITS.title} characters`);
  // bd counts a title in bytes and refuses one over its own limit; so does this.
  return Buffer.byteLength(title, "utf8") > BD_TITLE_BYTES
    ? fail(`title: at most ${BD_TITLE_BYTES} bytes, which is bd's own limit`)
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
  /** Present means an explicit label set, without implicit parent labels. */
  labels?: string[];
  rich: boolean;
}

const CREATE_FIELDS = [
  "title",
  "type",
  "priority",
  "parent",
  "description",
  "acceptance",
  "labels",
  "complexity",
  "fileMap",
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
  let description = textOf(
    "description",
    body["description"],
    BEAD_TEXT_LIMITS.description,
  );
  if (!description.ok) return description;
  // `bd create --description=-` means "read the description from standard
  // input". The runner ends stdin at once, so that call would create the
  // issue without its description.
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
  const rich = ["labels", "complexity", "fileMap"].some((key) => key in body);
  let labels: string[] | undefined;
  if (body["labels"] !== undefined) {
    const raw = body["labels"];
    if (
      !Array.isArray(raw) ||
      raw.length > BEAD_TEXT_LIMITS.labels ||
      !raw.every(
        (label) =>
          typeof label === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(label) &&
          !label.startsWith("queue:") &&
          !label.startsWith("complexity:"),
      )
    )
      return fail(
        "labels: at most30 bounded labels; queue and complexity use their own controls",
      );
    labels = [...new Set(raw)];
  }
  const complexity = body["complexity"];
  if (complexity !== undefined) {
    const known = BENCH_NAMES.find((item) => item === complexity);
    if (!known) return fail(`complexity: expected ${BENCH_NAMES.join(", ")}`);
    labels = [...(labels ?? []), `complexity:${known}`];
  }
  const fileMap = body["fileMap"];
  if (fileMap !== undefined) {
    if (
      !Array.isArray(fileMap) ||
      fileMap.length > BEAD_TEXT_LIMITS.fileMap ||
      !fileMap.every(
        (line) =>
          typeof line === "string" &&
          line.length > 0 &&
          line.length <= 200 &&
          !/[\r\n]/.test(line),
      )
    )
      return fail(
        "fileMap: at most100 relative globs, one per line and at most200 characters each",
      );
    if (fileMap.length) {
      const current = parseFileMap(description.value ?? "");
      if (current.ok || current.reason !== "missing")
        return fail(
          "fileMap: the description already contains a Files section; edit it in one place",
        );
      const declared = parseFileMap(`## Files\n${fileMap.join("\n")}`);
      if (!declared.ok) return fail(`fileMap: ${declared.error}`);
      description = textOf(
        "description with fileMap",
        `${description.value ? `${description.value}\n\n` : ""}## Files\n${declared.globs.join("\n")}`,
        BEAD_TEXT_LIMITS.description,
      );
      if (!description.ok) return description;
    }
  }
  return {
    ok: true,
    value: {
      title: title.value,
      type: String(type),
      priority: String(priority).slice(1),
      rich,
      ...(labels !== undefined ? { labels } : {}),
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

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/**
 * The issue `bd create --json` printed, when it printed one with a usable id
 * and the description that was sent (none, when none was: bd prints none).
 *
 * bd can make the issue without it and exit 0: `--description=-` reads the
 * description from standard input, which the runner ends at once. That issue
 * exists, so it is named, and the create is not confirmed.
 */
const created =
  (input: CreateInput) =>
  (stdout: string): Confirmed | Unconfirmed | null => {
    const issue = parsed(stdout);
    if (!isRecord(issue) || !beadId(issue["id"])) return null;
    if (issue["description"] !== input.description)
      return {
        unconfirmed: `made ${issue["id"]}, but the description it printed is not the one that was sent. Check with \`bd show ${issue["id"]}\` before trying again.`,
      };
    if (input.rich) {
      const printedLabels = issue["labels"] ?? [];
      const expectedLabels = [...(input.labels ?? [])].sort();
      if (
        issue["title"] !== input.title ||
        issue["issue_type"] !== input.type ||
        issue["priority"] !== Number(input.priority) ||
        issue["acceptance_criteria"] !== input.acceptance ||
        (input.labels !== undefined &&
          (!Array.isArray(printedLabels) ||
            JSON.stringify([...printedLabels].sort()) !==
              JSON.stringify(expectedLabels)))
      )
        return {
          unconfirmed: `made ${issue["id"]}, but its printed fields do not match the reviewed create. Check with \`bd show ${issue["id"]}\` before trying again.`,
        };
    }
    const labels = strings(issue["labels"]);
    return {
      id: issue["id"],
      ...(typeof issue["status"] === "string"
        ? { status: issue["status"] }
        : {}),
      ...(labels !== undefined ? { labels } : {}),
    };
  };

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

/**
 * bd times an issue to the second, on the clock this control plane shares with
 * its tracker: a change timed up to this long before a call began is that
 * call's.
 */
const BD_TIME_SLACK_MS = 2000;

/** Whether the time bd printed under `key` is from before the call began. A time that is absent says nothing. */
function fromBefore(
  issue: Record<string, unknown>,
  key: string,
  began: number,
): boolean {
  const at = Date.parse(String(issue[key] ?? ""));
  return !Number.isNaN(at) && at < began - BD_TIME_SLACK_MS;
}

/**
 * The issue `bd update --claim --json` printed, when this call claimed it.
 *
 * A claim of an issue the same actor already holds exits 0 too: bd prints the
 * issue as it was. Its last change is then from before the call began, and
 * nothing was claimed by this call.
 *
 * The last change is `updated_at`, which any change moves: a claim made within
 * two seconds of the issue's last change (the claim before it, or an edit) is
 * answered and recorded as this call's. `started_at` cannot be read instead:
 * bd writes it only while it is empty, so a bead released and claimed again
 * prints the time of its first claim, and that claim, which did change the
 * bead, would be answered 409.
 */
function claimed(stdout: string, began: number): Confirmed | Conflict | null {
  const printed = oneIssue(stdout);
  if (printed === null || printed.issue["status"] !== "in_progress")
    return null;
  return fromBefore(printed.issue, "updated_at", began)
    ? { conflict: `${printed.id} was already claimed; nothing was changed` }
    : described(printed.issue, printed.id);
}

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
    const earlier =
      printed.issue["close_reason"] !== reason ||
      fromBefore(printed.issue, "closed_at", began);
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

/** A write bd made, but not as it was asked for: what it made, and how to check it. */
interface Unconfirmed {
  unconfirmed: string;
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
  confirm(
    stdout: string,
    began: number,
  ): Confirmed | Conflict | Unconfirmed | null;
}

/** Append the outcome event. Null when the ledger stored it, else why not. */
async function record(
  deps: BeadDeps,
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
  return storeEvent(deps.appendEvent, event);
}

/**
 * One call to bd, never repeated, and one of five answers. None of them is a
 * 403: the page posts an action again after a 403, which is safe only while a
 * 403 always means "refused before anything was done".
 */
async function write(deps: BeadDeps, spec: Write): Promise<RouteReply> {
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
    // `bdRunner` never rejects; a runner that throws is an outcome nobody
    // knows, and what it threw can repeat an argument, so it is not passed on.
    return unknown(
      "did not finish: it could not be run. The change may still have been made.",
    );
  }
  // No exit status: a call killed at the runner's limit, and one the runtime
  // could not spawn for a reason other than a missing program (its working
  // directory gone), look alike here, so the answer gives both.
  if (result.status === null)
    return neverStarted(result)
      ? {
          status: 502,
          error:
            "bd could not be started (is it installed, and on the PATH of this control plane?). Nothing was changed.",
        }
      : unknown(
          "did not finish: it was stopped before it answered, or it never started. The change may still have been made.",
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
  if ("unconfirmed" in confirmed)
    return {
      status: 504,
      error: `bd ${spec.command} ${confirmed.unconfirmed}`,
    };
  const unrecorded = await record(deps, spec.action, confirmed.id, spec.text);
  const data: BeadWriteResult = {
    ...confirmed,
    action: spec.action,
    recorded: unrecorded === null,
    ...(unrecorded !== null ? { recordError: unrecorded } : {}),
  };
  return { status: spec.status, data };
}

/**
 * A comment on a bead: the comment row's write, for the hearth's own use too
 * (a council run's verdict, `council-verdict.ts`). One `bd comments add`, both
 * positionals after the terminator, so a text that looks like an option stays
 * a text; never repeated; `bead.transitioned` once bd's answer confirms it.
 * The id and the text are the caller's to have checked.
 */
export function commentOnBead(
  deps: BeadDeps,
  id: string,
  text: string,
): Promise<RouteReply> {
  return write(deps, {
    action: "comment",
    command: "comments add",
    args: ["comments", "add", "--json", "--", id, text],
    text,
    status: 201,
    check: `bd show ${id}`,
    confirm: commented,
  });
}

export function beadRoutes(deps: BeadDeps): ApiRoute[] {
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
      write(deps, {
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
          ...(input.labels !== undefined
            ? [
                "--no-inherit-labels",
                ...(input.labels.length
                  ? [`--labels=${input.labels.join(",")}`]
                  : []),
              ]
            : []),
          "--json",
        ],
        text: input.title,
        status: 201,
        // A create that did not answer left no id to look up.
        check: "bd list",
        confirm: created(input),
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
      write(deps, {
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
    effect: ({ id, text }) => commentOnBead(deps, id, text),
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
      write(deps, {
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
        complexities: [...BENCH_NAMES],
      };
      return { status: 200, data };
    },
  };

  return [options, create, claim, comment, close];
}
