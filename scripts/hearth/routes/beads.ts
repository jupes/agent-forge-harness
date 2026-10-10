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

const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"] as const;
const DEFAULT_PRIORITY = "P2";

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
  const type = body["type"] ?? "task";
  if (!BEAD_TYPES.some((known) => known === type))
    return fail(`type: expected one of ${BEAD_TYPES.join(", ")}`);
  const priority = body["priority"] ?? DEFAULT_PRIORITY;
  if (!PRIORITIES.some((known) => known === priority))
    return fail(`priority: expected one of ${PRIORITIES.join(", ")}`);
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

/** What `bd` printed, once it is known to describe the write that was asked for. */
interface Confirmed {
  id: string;
  status?: string;
  labels?: string[];
}

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

  return [create];
}
