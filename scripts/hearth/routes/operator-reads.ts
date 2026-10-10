/**
 * The operator API's read rows: what a `GET` answers, and how its query is
 * checked. `operator.ts` puts them in the table beside the actions and the
 * stream.
 *
 * Two kinds. The ledger reads (sessions, runs, events, reservations) are
 * scoped to the hearth's own workspace and take the audit CLI's filters by
 * the audit CLI's rules. The workspace reads come from outside the ledger:
 * the queue from Beads, smiths and config from the config files.
 */

import {
  type EventsPage,
  QUEUE_STATES,
  type QueueEntry,
  type QueueState,
  type RunDetail,
  type SmithsView,
} from "../../../types/hearth";
import { type LoadedConfig, loadConfig } from "../../config/load";
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
import {
  type ReadRoute,
  type RouteReply,
  type RouteRequest,
  safeMessage,
} from "../api";
import { isQueueState, type ValidationResult } from "../validate";
import type { BdRunner } from "./dev-api";

/** What the read rows are built from. */
export interface ReadDeps {
  /** The checkout this hearth serves: run state and config are read from it. */
  root: string;
  /** The ledger's name for that checkout; every ledger read is scoped to it. */
  workspace: string;
  ledgerPath: string;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
  /** How long a queue read may take; defaults to `BD_QUEUE_TIMEOUT_MS`. */
  bdTimeoutMs?: number | undefined;
  /** The OS home the machine config file is read from; defaults to the real one. */
  configHome?: string | undefined;
}

export const fail = <T>(error: string): ValidationResult<T> => ({
  ok: false,
  error,
});

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
export function noParameters(request: RouteRequest): ValidationResult<null> {
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
export function ledgerReads(deps: ReadDeps) {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
export function workspaceReads(deps: ReadDeps) {
  const timeout = deps.bdTimeoutMs ?? BD_QUEUE_TIMEOUT_MS;
  const readQueue = coalesced(async (): Promise<QueueRead> => {
    // The runner kills its own process at the limit. The wait here is one
    // second longer and only ends a runner that never answers at all, so the
    // next read cannot start while this one's process is still alive.
    const result = await withTimeout(
      Promise.resolve(deps.runBd([...QUEUE_LIST_ARGS], { timeoutMs: timeout })),
      timeout + 1000,
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
