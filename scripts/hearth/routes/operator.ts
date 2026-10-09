/**
 * The operator API's rows (`03-target-architecture.md` §6).
 *
 * Each effect calls code that already exists — the ledger's queries, the run
 * store, the config loader, the council service, `bd` — so the API is a way in
 * to them, not a second implementation. What a row must not decide for itself
 * (origin, token, audit, envelope) is in `../api.ts`.
 */

import { randomUUID } from "node:crypto";
import type { EventsPage, RunDetail } from "../../../types/hearth";
import { assertCouncilRunId } from "../../council/artifacts";
import {
  type CouncilServiceInput,
  type createCouncilService,
  safeCouncilError,
} from "../../council/service";
import { reviewCommentFor } from "../../dashboard/forge-run-model";
import { isValidSlug, summarizeRun } from "../../forge/runs";
import { listRuns, readRunState } from "../../forge/runs-store";
import { parseAuditArgs } from "../../ledger/audit-cli";
import {
  activeReservations,
  type EventFilter,
  type EventPage,
  listSessions,
  queryEventPage,
} from "../../ledger/query";
import { redactSecrets } from "../../secret-patterns";
import type {
  ActionRoute,
  ApiRoute,
  ReadRoute,
  RouteReply,
  RouteRequest,
} from "../api";
import type { ValidationResult } from "../validate";
import { applyReview, type BdRunner } from "./dev-api";

type CouncilService = ReturnType<typeof createCouncilService>;

export interface OperatorDeps {
  /** The checkout this hearth serves: run state is read from it. */
  root: string;
  /** The ledger's name for that checkout; every ledger read is scoped to it. */
  workspace: string;
  ledgerPath: string;
  council: CouncilService;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
}

const fail = <T>(error: string): ValidationResult<T> => ({ ok: false, error });

/**
 * The request's query parameters, when every one of them is in `allowed` and
 * none is repeated. A misspelt filter must be a refusal, never a wider answer.
 */
function parameters(
  request: RouteRequest,
  allowed: readonly string[],
): ValidationResult<Map<string, string>> {
  const found = new Map<string, string>();
  for (const [name, value] of request.query) {
    if (!allowed.includes(name))
      return fail(
        allowed.length === 0
          ? `${name}: this route takes no parameters`
          : `${name}: unknown parameter (expected ${allowed.join(", ")})`,
      );
    if (found.has(name)) return fail(`${name}: given more than once`);
    found.set(name, value);
  }
  return { ok: true, value: found };
}

/** A row that takes no query parameter refuses any. */
function noParameters(request: RouteRequest): ValidationResult<null> {
  const checked = parameters(request, []);
  return checked.ok ? { ok: true, value: null } : checked;
}

/** A whole number in a range, written in plain digits. */
function integer(
  name: string,
  text: string | undefined,
  range: { min: number; max: number; fallback: number },
): ValidationResult<number> {
  if (text === undefined) return { ok: true, value: range.fallback };
  const value = /^\d{1,15}$/.test(text) ? Number(text) : Number.NaN;
  return value >= range.min && value <= range.max
    ? { ok: true, value }
    : fail(
        `${name}: expected a whole number from ${range.min} to ${range.max}`,
      );
}

function flag(
  name: string,
  text: string | undefined,
): ValidationResult<boolean> {
  if (text === undefined || text === "0") return { ok: true, value: false };
  return text === "1"
    ? { ok: true, value: true }
    : fail(`${name}: expected 0 or 1`);
}

interface SessionsQuery {
  open: boolean;
  limit: number;
}

function sessionsQuery(request: RouteRequest): ValidationResult<SessionsQuery> {
  const given = parameters(request, ["open", "limit"]);
  if (!given.ok) return given;
  const open = flag("open", given.value.get("open"));
  if (!open.ok) return open;
  const limit = integer("limit", given.value.get("limit"), {
    min: 1,
    max: 500,
    fallback: 100,
  });
  return limit.ok
    ? { ok: true, value: { open: open.value, limit: limit.value } }
    : limit;
}

/** How many events `/events` returns when the request does not say, and at most. */
const EVENTS_DEFAULT_LIMIT = 200;
const EVENTS_MAX_LIMIT = 1000;
/** How many of a run's newest events `/runs/:slug` carries; the rest are paged through `/events?run=`. */
const RUN_EVENTS = 200;
const MAX_ID_LENGTH = 200;

/** The `/events` parameters and the `forge:audit` flag each one is. Nothing else reaches the parser. */
const EVENT_FLAGS: ReadonlyArray<[string, string]> = [
  ["bead", "--bead"],
  ["run", "--run"],
  ["session", "--session"],
  ["since", "--since"],
  ["kind", "--kind"],
  ["after", "--after-id"],
  ["limit", "--limit"],
];

type EventsQuery = Omit<EventFilter, "workspace"> & { limit: number };

/**
 * The filters of `forge:audit`, by the rules of `forge:audit`: the request's
 * parameters become that command's flags and its own parser judges them. Only
 * the flags listed above can be produced, so the command's other switches
 * (backup, compaction, every workspace) cannot be reached from a request, and
 * a result that is not a plain scoped query is refused regardless.
 */
function eventsQuery(request: RouteRequest): ValidationResult<EventsQuery> {
  const given = parameters(request, [
    ...EVENT_FLAGS.map(([name]) => name),
    "beadExact",
  ]);
  if (!given.ok) return given;
  const argv: string[] = [];
  for (const [name, option] of EVENT_FLAGS) {
    const value = given.value.get(name);
    if (value === undefined) continue;
    if (value.length === 0 || value.length > MAX_ID_LENGTH)
      return fail(`${name}: expected 1 to ${MAX_ID_LENGTH} characters`);
    if ((name === "after" || name === "limit") && !/^\d{1,15}$/.test(value))
      return fail(`${name}: expected a whole number`);
    argv.push(option, value);
  }
  const exact = flag("beadExact", given.value.get("beadExact"));
  if (!exact.ok) return exact;
  if (given.value.has("beadExact") && !given.value.has("bead"))
    return fail("beadExact: needs bead");
  if (exact.value) argv.push("--bead-exact");

  const parsed = parseAuditArgs(argv);
  // The parser names its own flags; a request never sent one.
  if (!parsed.ok)
    return fail(
      parsed.error.replace(/^--after-id/, "after").replace(/^--/, ""),
    );
  if (parsed.value.command !== "query" || parsed.value.allWorkspaces)
    return fail("Only a query of this workspace can be asked for");
  const limit = parsed.value.filter.limit ?? EVENTS_DEFAULT_LIMIT;
  if (limit > EVENTS_MAX_LIMIT)
    return fail(`limit: expected a whole number from 1 to ${EVENTS_MAX_LIMIT}`);
  return { ok: true, value: { ...parsed.value.filter, limit } };
}

function runSlug(request: RouteRequest): ValidationResult<string> {
  const given = noParameters(request);
  if (!given.ok) return given;
  const slug = request.params["slug"] ?? "";
  return isValidSlug(slug)
    ? { ok: true, value: slug }
    : fail("slug: not a forge run slug");
}

/** A page of events as the API answers it. */
function eventsPage(page: EventPage, after: number | undefined): EventsPage {
  return {
    events: page.events,
    cursor: page.events.at(-1)?.id ?? after ?? 0,
    more: page.more,
  };
}

/** The reads over the ledger and the run state. */
function ledgerReads(deps: OperatorDeps): ApiRoute[] {
  const ledger = { path: deps.ledgerPath };
  const { workspace } = deps;
  const sessions: ReadRoute<SessionsQuery> = {
    kind: "read",
    method: "GET",
    path: "/sessions",
    collection: "sessions",
    validate: sessionsQuery,
    read: (query) => ({
      status: 200,
      data: listSessions({ workspace, ...query }, ledger),
    }),
  };
  const run: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/runs/:slug",
    validate: runSlug,
    read: (slug) => {
      const state = readRunState(slug, deps.root);
      if (state === null)
        return {
          status: 404,
          error: `No forge run named "${slug}" in this checkout`,
        };
      const detail: RunDetail = {
        run: summarizeRun(state),
        state,
        events: eventsPage(
          queryEventPage({ workspace, runId: slug, limit: RUN_EVENTS }, ledger),
          undefined,
        ),
      };
      return { status: 200, data: detail };
    },
  };
  const events: ReadRoute<EventsQuery> = {
    kind: "read",
    method: "GET",
    path: "/events",
    validate: eventsQuery,
    read: (filter) => ({
      status: 200,
      data: eventsPage(
        queryEventPage({ ...filter, workspace }, ledger),
        filter.afterId,
      ),
    }),
  };
  return [
    sessions,
    {
      kind: "read",
      method: "GET",
      path: "/runs",
      collection: "runs",
      validate: noParameters,
      read: () => ({ status: 200, data: listRuns(deps.root) }),
    },
    run,
    events,
    {
      kind: "read",
      method: "GET",
      path: "/reservations",
      collection: "reservations",
      validate: noParameters,
      read: () => ({
        status: 200,
        data: activeReservations({ workspace }, ledger),
      }),
    },
  ];
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
  return [...ledgerReads(deps), ...actions(deps)];
}
