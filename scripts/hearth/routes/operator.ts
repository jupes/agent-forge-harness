/**
 * The operator API's rows (`03-target-architecture.md` §6).
 *
 * Each effect calls code that already exists — the ledger's queries, the run
 * store, the config loader, the council service, `bd` — so the API is a way in
 * to them, not a second implementation. What a row must not decide for itself
 * (origin, token, audit, envelope) is in `../api.ts`.
 */

import { randomUUID } from "node:crypto";
import { assertCouncilRunId } from "../../council/artifacts";
import {
  type CouncilServiceInput,
  type createCouncilService,
  safeCouncilError,
} from "../../council/service";
import { reviewCommentFor } from "../../dashboard/forge-run-model";
import { listRuns } from "../../forge/runs-store";
import { redactSecrets } from "../../secret-patterns";
import type { ActionRoute, ApiRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { applyReview, type BdRunner } from "./dev-api";

type CouncilService = ReturnType<typeof createCouncilService>;

export interface OperatorDeps {
  /** The checkout this hearth serves: run state is read from it. */
  root: string;
  council: CouncilService;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
}

const fail = <T>(error: string): ValidationResult<T> => ({ ok: false, error });

/** A row that takes no query parameter refuses any. */
function noParameters(request: RouteRequest): ValidationResult<null> {
  const first = [...request.query.keys()][0];
  return first === undefined
    ? { ok: true, value: null }
    : fail(`${first}: this route takes no parameters`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const {
    sourceType,
    source,
    profile,
    maxUsd,
    maxBytes,
    redactSecrets: redact,
  } = body;
  if (
    (sourceType !== "file" &&
      sourceType !== "plan" &&
      sourceType !== "pr" &&
      sourceType !== "text") ||
    typeof source !== "string" ||
    !source.trim() ||
    Buffer.byteLength(source, "utf8") > 2_000_000
  )
    return fail("source must be a nonempty supported input of at most 2 MB");
  if (profile !== undefined && typeof profile !== "string")
    return fail("profile must be a path string");
  if (
    maxBytes !== undefined &&
    (typeof maxBytes !== "number" ||
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 2_000_000)
  )
    return fail("maxBytes must be between 1 and 2000000");
  if (
    maxUsd !== undefined &&
    (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd < 0)
  )
    return fail("maxUsd must be finite and nonnegative");
  if (redact !== undefined && typeof redact !== "boolean")
    return fail("redactSecrets must be a boolean");
  const beadId = body["beadId"];
  if (
    beadId !== undefined &&
    (typeof beadId !== "string" ||
      !BEAD_ID.test(beadId) ||
      looksLikeSecret(beadId))
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
  return {
    ok: true,
    value: {
      sourceType,
      source,
      runId: runId.value,
      ...(profile !== undefined ? { profile } : {}),
      ...(maxUsd !== undefined ? { maxUsd } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(redact !== undefined ? { redactSecrets: redact } : {}),
      ...(beadId !== undefined ? { beadId } : {}),
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

export function operatorRoutes(deps: OperatorDeps): ApiRoute[] {
  return [
    {
      kind: "read",
      method: "GET",
      path: "/runs",
      collection: "runs",
      validate: noParameters,
      read: () => ({ status: 200, data: listRuns(deps.root) }),
    },
    ...actions(deps),
  ];
}
