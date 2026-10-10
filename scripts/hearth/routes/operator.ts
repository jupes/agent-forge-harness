/**
 * The operator API's table (`03-target-architecture.md` §6): the read rows
 * (`operator-reads.ts`), the stream, and the actions.
 *
 * Each effect calls code that already exists — the ledger's queries, the run
 * store, the config loader, the council service, `bd` — so the API is a way in
 * to them, not a second implementation. What a row must not decide for itself
 * (origin, token, audit, envelope) is in `../api.ts`.
 */

import { randomUUID } from "node:crypto";
import type { OperatorEnvelope } from "../../../types/hearth";
import { assertCouncilRunId } from "../../council/artifacts";
import {
  assertCouncilInput,
  type CouncilServiceInput,
  type createCouncilService,
  safeCouncilError,
} from "../../council/service";
import { reviewCommentFor } from "../../dashboard/forge-run-model";
import { latestEventId, queryEvents } from "../../ledger/query";
import { redactSecrets } from "../../secret-patterns";
import {
  type ActionRoute,
  type ApiRoute,
  type ReadRoute,
  type RouteReply,
  type RouteRequest,
  type StreamRoute,
  safeMessage,
} from "../api";
import { createLedgerStream } from "../stream";
import type { ValidationResult } from "../validate";
import { applyReview } from "./dev-api";
import {
  fail,
  isRecord,
  ledgerReads,
  noParameters,
  type ReadDeps,
  workspaceReads,
} from "./operator-reads";

type CouncilService = ReturnType<typeof createCouncilService>;

export interface OperatorDeps extends ReadDeps {
  council: CouncilService;
  /** How often an open stream looks for new events, and how often it sends a keepalive. */
  streamPollMs?: number | undefined;
  streamKeepaliveMs?: number | undefined;
}

const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/**
 * An id is stored on the audit row exactly as given, and the ledger refuses a
 * row whose id its secret scanner would change. Refusing here turns that into
 * a 400 for the caller instead of an action that could not be recorded.
 */
function looksLikeSecret(value: string): boolean {
  return redactSecrets(value).redactions.length > 0;
}

function councilRunId(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return fail("runId must be a string");
  try {
    assertCouncilRunId(value);
  } catch (error) {
    return fail(safeCouncilError(error));
  }
  return looksLikeSecret(value)
    ? fail("runId must not look like a secret")
    : { ok: true, value };
}

type CouncilStart = CouncilServiceInput & { runId: string };

/**
 * The council service's own input, checked before anything is recorded. The
 * run id is settled here — the caller's, or a new one in the service's format —
 * so the audit row can name the run it starts.
 */
function councilStart(request: RouteRequest): ValidationResult<CouncilStart> {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const body = request.body;
  if (!isRecord(body)) return fail("Expected a JSON object");
  // justification: `assertCouncilInput` is the check that makes the body a CouncilServiceInput.
  const input = body as unknown as CouncilServiceInput;
  try {
    assertCouncilInput(input);
  } catch (error) {
    return fail(safeCouncilError(error));
  }
  // Stricter than the service on the two ids, because both go on the audit row.
  if (
    input.beadId !== undefined &&
    (!BEAD_ID.test(input.beadId) || looksLikeSecret(input.beadId))
  )
    return fail("beadId must be a Beads issue id");
  const runId =
    body["runId"] === undefined
      ? ({
          ok: true,
          value: `council-${Date.now()}-${randomUUID().slice(0, 8)}`,
        } as const)
      : councilRunId(body["runId"]);
  if (!runId.ok) return runId;
  // Only the fields the service knows: nothing else in the body travels on.
  return {
    ok: true,
    value: {
      sourceType: input.sourceType,
      source: input.source,
      runId: runId.value,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}),
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      ...(input.redactSecrets !== undefined
        ? { redactSecrets: input.redactSecrets }
        : {}),
      ...(input.beadId !== undefined ? { beadId: input.beadId } : {}),
    },
  };
}

function councilCancel(request: RouteRequest): ValidationResult<string> {
  const parameters = noParameters(request);
  return parameters.ok ? councilRunId(request.params["id"]) : parameters;
}

interface Review {
  issueId: string;
  /** The request as sent: `applyReview` reads it again, against Beads. */
  input: unknown;
}

function review(request: RouteRequest): ValidationResult<Review> {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const comment = reviewCommentFor(request.body);
  if (!comment.ok) return fail(comment.error);
  return looksLikeSecret(comment.issueId)
    ? fail("issueId must be a Beads issue id")
    : { ok: true, value: { issueId: comment.issueId, input: request.body } };
}

/** The council service refuses by throwing; its routes have always answered that with 400. */
function councilReply(status: number, call: () => unknown): RouteReply {
  try {
    return { status, data: call() };
  } catch (error) {
    return { status: 400, error: safeCouncilError(error) };
  }
}

/**
 * The actions. Each council action is mounted twice: at the path §6 names,
 * and at the path the dashboard has always posted to.
 */
function actions(deps: OperatorDeps): ApiRoute[] {
  const start: Omit<ActionRoute<CouncilStart>, "path"> = {
    kind: "action",
    method: "POST",
    action: "council.run.start",
    maxBodyBytes: 2_100_000,
    validate: councilStart,
    subject: (input) => ({
      target: input.runId,
      ...(input.beadId !== undefined ? { beadId: input.beadId } : {}),
    }),
    effect: (input) => councilReply(202, () => deps.council.start(input)),
  };
  const cancel: Omit<ActionRoute<string>, "path"> = {
    kind: "action",
    method: "POST",
    action: "council.run.cancel",
    validate: councilCancel,
    subject: (runId) => ({ target: runId }),
    effect: (runId) => councilReply(200, () => deps.council.cancel(runId)),
  };
  const recordReview: ActionRoute<Review> = {
    kind: "action",
    method: "POST",
    path: "/dev-api/forge-run/review",
    action: "checkpoint.review",
    validate: review,
    subject: (input) => ({ target: input.issueId, beadId: input.issueId }),
    effect: async (input) => {
      const reply = await applyReview(input.input, deps.runBd);
      return reply.body.ok
        ? { status: reply.status, data: reply.body.data }
        : { status: reply.status, error: reply.body.error ?? "Review failed" };
    },
  };
  return [
    { ...start, path: "/council/runs" },
    { ...cancel, path: "/council/runs/:id/cancel" },
    { ...start, path: "/council-api/runs" },
    { ...cancel, path: "/council-api/runs/:id/cancel" },
    recordReview,
  ];
}

/** An absent `Last-Event-ID`, or the ledger id it names. */
function lastEventId(request: RouteRequest): ValidationResult<number | null> {
  const given = noParameters(request);
  if (!given.ok) return given;
  const header = request.headers["last-event-id"];
  // An empty id is "no id" to an event source, the same as not sending one.
  if (header === undefined || header === "") return { ok: true, value: null };
  return typeof header === "string" && /^\d{1,15}$/.test(header)
    ? { ok: true, value: Number(header) }
    : fail("Last-Event-ID: expected a ledger event id");
}

const NO_REQUEST: RouteRequest = {
  params: {},
  query: new URLSearchParams(),
  headers: {},
  body: undefined,
};

/** What a collection row answers when asked with no parameters, as its envelope. */
async function collectionEnvelope(row: ReadRoute): Promise<OperatorEnvelope> {
  let reply: RouteReply;
  try {
    const input = row.validate(NO_REQUEST);
    reply = input.ok
      ? await row.read(input.value)
      : { status: 400, error: input.error };
  } catch (error) {
    reply = { status: 500, error: safeMessage(error) };
  }
  return "error" in reply
    ? { ok: false, data: null, error: reply.error }
    : { ok: true, data: reply.data, error: null };
}

export interface OperatorTable {
  routes: ApiRoute[];
  /** End what the table holds open (the event streams). */
  close(): void;
}

export function operatorRoutes(deps: OperatorDeps): OperatorTable {
  const { sessions, runs, run, events, reservations } = ledgerReads(deps);
  const { queue, smiths, config } = workspaceReads(deps);
  // In the order section 6 lists them.
  const reads: ReadRoute[] = [
    sessions,
    runs,
    run,
    events,
    queue,
    reservations,
    smiths,
    config,
  ];

  const ledger = { path: deps.ledgerPath };
  const { workspace } = deps;
  const live = createLedgerStream({
    cursor: () => latestEventId({ workspace }, ledger),
    // Every collection row, whatever a later bead adds to the table.
    collections: async () => {
      const rows = reads.filter((row) => row.collection !== undefined);
      const envelopes = await Promise.all(rows.map(collectionEnvelope));
      return Object.fromEntries(
        rows.map((row, index) => [row.collection ?? "", envelopes[index]]),
      );
    },
    eventsAfter: (afterId, limit) =>
      queryEvents({ workspace, afterId, limit }, ledger),
    pollMs: deps.streamPollMs,
    keepaliveMs: deps.streamKeepaliveMs,
  });
  const stream: StreamRoute<number | null> = {
    kind: "stream",
    method: "GET",
    path: "/stream",
    validate: lastEventId,
    open: (resumeAfter, req, res) => live.open(req, res, resumeAfter),
  };

  return {
    routes: [...reads, stream, ...actions(deps)],
    close: () => live.close(),
  };
}
