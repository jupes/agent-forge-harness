/**
 * The operator API's rows (`03-target-architecture.md` §6).
 *
 * Each effect calls code that already exists — the ledger's queries, the run
 * store, the config loader, the council service, `bd` — so the API is a way in
 * to them, not a second implementation. What a row must not decide for itself
 * (origin, token, audit, envelope) is in `../api.ts`.
 */

import { randomUUID } from "node:crypto";
import {
  type EventsPage,
  type OperatorEnvelope,
  QUEUE_STATES,
  type QueueEntry,
  type QueueState,
  type RunDetail,
  type SmithsView,
} from "../../../types/hearth";
import { type LoadedConfig, loadConfig } from "../../config/load";
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
  latestEventId,
  listSessions,
  queryEventPage,
  queryEvents,
} from "../../ledger/query";
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
import { isQueueState, type ValidationResult } from "../validate";
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
  /** How long a queue read may take; defaults to `BD_QUEUE_TIMEOUT_MS`. */
  bdTimeoutMs?: number | undefined;
  /** The OS home the machine config file is read from; defaults to the real one. */
  configHome?: string | undefined;
  /** How often an open stream looks for new events, and how often it sends a keepalive. */
  streamPollMs?: number | undefined;
  streamKeepaliveMs?: number | undefined;
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
function ledgerReads(deps: OperatorDeps) {
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
  const runs: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/runs",
    collection: "runs",
    validate: noParameters,
    read: () => ({ status: 200, data: listRuns(deps.root) }),
  };
  const reservations: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/reservations",
    collection: "reservations",
    validate: noParameters,
    read: () => ({
      status: 200,
      data: activeReservations({ workspace }, ledger),
    }),
  };
  return { sessions, runs, run, events, reservations };
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

/** How long a queue read may take before it is reported as failed. */
export const BD_QUEUE_TIMEOUT_MS = 15_000;

const QUEUE_LABEL = "queue:";

/**
 * What `bd` is asked for the queue: always exactly this, whatever the request.
 *
 * `--label-any` with every state spelled out, because bd 1.1.0 silently
 * ignores `--label-pattern` and `--label-regex` and returns every issue.
 * `--all`, because `bd list` hides closed issues and a `done` bead is closed.
 * `--readonly`, because this route only reads.
 */
export const QUEUE_LIST_ARGS: readonly string[] = [
  "list",
  "--readonly",
  "--flat",
  "--json",
  "--all",
  "--limit",
  "0",
  "--label-any",
  QUEUE_STATES.map((state) => `${QUEUE_LABEL}${state}`).join(","),
];

/**
 * One call at a time, and at most one waiting: a caller that arrives while a
 * call is running shares the next call, so it never receives an answer that
 * was read before it asked.
 */
function coalesced<T>(start: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  let next: Promise<T> | null = null;
  const launch = (): Promise<T> => {
    const call = start().finally(() => {
      if (running === call) running = null;
    });
    running = call;
    return call;
  };
  return () => {
    if (running === null) return launch();
    next ??= running
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        next = null;
        return launch();
      });
    return next;
  };
}

function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not answer within ${ms} ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type QueueRead =
  | { ok: true; entries: QueueEntry[] }
  | { ok: false; error: string };

/**
 * The beads that carry a `queue:<state>` label, one entry per such label. The
 * result is filtered on each issue's own labels: whatever the CLI returned, an
 * issue with no queue label is not in the queue. A bead with two queue labels
 * appears twice — which one should win is the state machine's rule to make.
 */
function queueEntries(stdout: string): QueueRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "bd list did not print JSON" };
  }
  if (!Array.isArray(parsed))
    return { ok: false, error: "bd list did not print a list of issues" };
  const entries: QueueEntry[] = [];
  for (const issue of parsed) {
    if (!isRecord(issue) || typeof issue["id"] !== "string")
      return {
        ok: false,
        error: "bd list printed something that is not an issue",
      };
    const labels = Array.isArray(issue["labels"]) ? issue["labels"] : [];
    for (const state of QUEUE_STATES) {
      if (!labels.includes(`${QUEUE_LABEL}${state}`)) continue;
      entries.push({
        beadId: issue["id"],
        title: typeof issue["title"] === "string" ? issue["title"] : "",
        state,
        status: typeof issue["status"] === "string" ? issue["status"] : "",
        ...(typeof issue["priority"] === "number"
          ? { priority: issue["priority"] }
          : {}),
        ...(typeof issue["issue_type"] === "string"
          ? { type: issue["issue_type"] }
          : {}),
      });
    }
  }
  return { ok: true, entries };
}

function queueStates(
  request: RouteRequest,
): ValidationResult<readonly QueueState[] | null> {
  const given = parameters(request, ["state"]);
  if (!given.ok) return given;
  const text = given.value.get("state");
  if (text === undefined) return { ok: true, value: null };
  const states: QueueState[] = [];
  for (const name of text.split(",")) {
    if (!isQueueState(name))
      return fail(`state: expected one of ${QUEUE_STATES.join(", ")}`);
    states.push(name);
  }
  return { ok: true, value: states };
}

/** The reads that do not come from the ledger: the queue (Beads) and the config files. */
function workspaceReads(deps: OperatorDeps) {
  const timeout = deps.bdTimeoutMs ?? BD_QUEUE_TIMEOUT_MS;
  const readQueue = coalesced(async (): Promise<QueueRead> => {
    const result = await withTimeout(
      Promise.resolve(deps.runBd([...QUEUE_LIST_ARGS])),
      timeout,
      "bd list",
    );
    if (result.status !== 0)
      return {
        ok: false,
        error: `bd list failed: ${result.stderr.trim().slice(0, 500) || `exit ${result.status}`}`,
      };
    return queueEntries(result.stdout);
  });
  const queue: ReadRoute<readonly QueueState[] | null> = {
    kind: "read",
    method: "GET",
    path: "/queue",
    collection: "queue",
    validate: queueStates,
    read: async (states) => {
      let read: QueueRead;
      try {
        read = await readQueue();
      } catch (error) {
        read = { ok: false, error: safeMessage(error) };
      }
      if (!read.ok) return { status: 502, error: safeMessage(read.error) };
      return {
        status: 200,
        data:
          states === null
            ? read.entries
            : read.entries.filter((entry) => states.includes(entry.state)),
      };
    },
  };

  /**
   * The files `forge:config show` reads in this checkout, and nothing from the
   * environment: the hearth's was fixed when it started and is not the
   * operator's shell.
   */
  const config = (): LoadedConfig =>
    loadConfig({
      harnessRoot: deps.root,
      env: {},
      ...(deps.configHome !== undefined ? { home: deps.configHome } : {}),
    });
  const configured =
    (view: (loaded: LoadedConfig) => unknown) => (): RouteReply => {
      try {
        return { status: 200, data: view(config()) };
      } catch (error) {
        return { status: 500, error: safeMessage(error) };
      }
    };
  const smiths: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/smiths",
    collection: "smiths",
    validate: noParameters,
    read: configured(
      ({ config: loaded }): SmithsView => ({
        smiths: Object.values(loaded.smiths),
        benches: loaded.benches,
        defaultSmith: loaded.workflow.defaultCrew,
      }),
    ),
  };
  const whole: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/config",
    collection: "config",
    validate: noParameters,
    read: configured((loaded) => loaded),
  };
  return { queue, smiths, config: whole };
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
