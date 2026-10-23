/**
 * The operator API's table (`03-target-architecture.md` §6): the read rows
 * (`operator-reads.ts`), the stream, and the actions, with the tracker writes
 * (`beads.ts`) and the queue actions (`queue.ts`) in files of their own.
 *
 * Each effect calls code that already exists — the ledger's queries, the run
 * store, the config loader, the council service, `bd` — so the API is a way in
 * to them, not a second implementation. What a row must not decide for itself
 * (origin, token, audit, envelope) is in `../api.ts`.
 */

import { randomUUID } from "node:crypto";
import type { LedgerEventInput, OperatorEnvelope } from "../../../types/hearth";
import type { ConversationTransport } from "../../conversations/transport";
import { assertCouncilRunId } from "../../council/artifacts";
import {
  assertCouncilInput,
  type CouncilServiceInput,
  councilBeadId,
  type createCouncilService,
  safeCouncilError,
} from "../../council/service";
import { reviewCommentFor } from "../../dashboard/forge-run-model";
import type { KeeperOperatorPost } from "../../keeper/operator-post";
import type { AppendResult } from "../../ledger/append";
import { latestEventId, queryEvents } from "../../ledger/query";
import {
  type ActionRoute,
  type ApiRoute,
  type ReadRoute,
  type RouteReply,
  type RouteRequest,
  type StreamRoute,
  safeMessage,
} from "../api";
import type { ShiftStarts } from "../shift-launcher";
import { createLedgerStream } from "../stream";
import { isBeadId } from "../tracker-write";
import type { ValidationResult } from "../validate";
import { beadRoutes } from "./beads";
import { conversationRoutes } from "./conversations";
import { postCouncilVerdict } from "./council-verdict";
import { applyReview, localStateRoot } from "./dev-api";
import { createKeeperBriefPreparer } from "./keeper-briefs-source";
import { keeperProposalRoutes } from "./keeper-proposals";
import { keeperAboutValidator, keeperReadRoute } from "./keeper-read";
import {
  beadsReads,
  fail,
  hearthLedger,
  isRecord,
  ledgerReads,
  looksLikeSecret,
  noParameters,
  type ReadDeps,
  workspaceReads,
} from "./operator-reads";
import { projectOverviewRoute } from "./project-overview";
import {
  projectSnapshotReader,
  projectSummaryRoute,
} from "./project-summaries";
import { projectRoutes } from "./projects";
import { queueRoutes } from "./queue";
import { shiftRoutes } from "./shifts";

type CouncilService = ReturnType<typeof createCouncilService>;

export interface OperatorDeps extends ReadDeps {
  /** Machine-private home; the project catalog is shared above workspaces. */
  projectHome: string;
  conversationTransport?: ConversationTransport | undefined;
  keeperOperatorPost?: KeeperOperatorPost | undefined;
  council: CouncilService;
  /** The ledger's `appendEvent`, bound to this hearth's ledger: a row that records an outcome uses it. */
  appendEvent(event: LedgerEventInput): AppendResult;
  /** The queue lock's file: one for every process that moves beads of this tracker. */
  queueLockFile: string;
  /** Where shifts given this hearth's home keep their records and stop requests. */
  shiftsDir: string;
  /** The shifts this hearth starts (`POST /shifts`); the hearth closes them. */
  shiftStarts: ShiftStarts;
  /** How often an open stream looks for new events, and how often it sends a keepalive. */
  streamPollMs?: number | undefined;
  streamKeepaliveMs?: number | undefined;
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

/** What a preview packs from: the fields that change a pack, and the bead. */
type CouncilPreviewInput = Pick<
  CouncilServiceInput,
  "sourceType" | "source" | "maxBytes" | "redactSecrets" | "beadId"
>;

/**
 * The council service's own input, checked before anything is recorded, with
 * the bead the request is recorded against. Only the fields the service knows:
 * nothing else in the body travels on.
 */
function councilInput(request: RouteRequest): ValidationResult<{
  input: CouncilServiceInput;
  body: Record<string, unknown>;
}> {
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
  // The bead the run is recorded against: the one the caller named, or, for a
  // bead source, the bead under review. Stricter than the service on the two
  // ids, because both go on the audit row.
  const beadId = councilBeadId(input);
  if (beadId !== undefined && !isBeadId(beadId))
    return fail("beadId must be a Beads issue id");
  return {
    ok: true,
    value: {
      body,
      input: {
        sourceType: input.sourceType,
        source: input.source,
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
        ...(input.maxUsd !== undefined ? { maxUsd: input.maxUsd } : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
        ...(input.redactSecrets !== undefined
          ? { redactSecrets: input.redactSecrets }
          : {}),
        ...(beadId !== undefined ? { beadId } : {}),
      },
    },
  };
}

/**
 * A start: the service's input, and the run id settled here — the caller's, or
 * a new one in the service's format — so the audit row can name the run it
 * starts.
 */
function councilStart(request: RouteRequest): ValidationResult<CouncilStart> {
  const checked = councilInput(request);
  if (!checked.ok) return checked;
  const { body, input } = checked.value;
  const runId =
    body["runId"] === undefined
      ? ({
          ok: true,
          value: `council-${Date.now()}-${randomUUID().slice(0, 8)}`,
        } as const)
      : councilRunId(body["runId"]);
  if (!runId.ok) return runId;
  if (/^(PASS|FAIL|UNREADABLE)$/i.test(runId.value))
    return fail("runId must not be a council outcome word");
  return { ok: true, value: { ...input, runId: runId.value } };
}

/**
 * A preview: checked as a start is, so the page can send the same body, and
 * handed on with only what changes a pack. The profile, the ceiling and a run
 * id are a run's, and a preview starts none.
 */
function councilPreview(
  request: RouteRequest,
): ValidationResult<CouncilPreviewInput> {
  const checked = councilInput(request);
  if (!checked.ok) return checked;
  const { sourceType, source, maxBytes, redactSecrets, beadId } =
    checked.value.input;
  return {
    ok: true,
    value: {
      sourceType,
      source,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(redactSecrets !== undefined ? { redactSecrets } : {}),
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
  return !isBeadId(comment.issueId)
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
  const verdicts = {
    workspace: deps.workspace,
    runBd: deps.runBd,
    appendEvent: deps.appendEvent,
    council: deps.council,
  };
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
    // A run on a bead posts its verdict back to the bead when it completes
    // (`council-verdict.ts`); the answer does not wait for it.
    effect: (input) => {
      const reply = councilReply(202, () => deps.council.start(input));
      if (reply.status === 202)
        void postCouncilVerdict(verdicts, input, input.runId);
      return reply;
    },
  };
  // What a run would send, read now and listed part by part, with nothing
  // started. An action, though it changes nothing: a bead source reads private
  // text through `bd` (and a pull request through `gh`), so it is the
  // operator's to ask for, and it is audited against the bead.
  const preview: ActionRoute<CouncilPreviewInput> = {
    kind: "action",
    method: "POST",
    path: "/council/preview",
    action: "council.run.preview",
    maxBodyBytes: 2_100_000,
    validate: councilPreview,
    subject: (input) =>
      input.beadId !== undefined
        ? { target: input.beadId, beadId: input.beadId }
        : {},
    effect: async (input) => {
      try {
        return { status: 200, data: await deps.council.preview(input) };
      } catch (error) {
        return { status: 400, error: safeCouncilError(error) };
      }
    },
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
    preview,
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
  /** End event streams and stop the conversation processes this hearth owns. */
  close(): Promise<void>;
}

export function operatorRoutes(deps: OperatorDeps): OperatorTable {
  const { sessions, runs, run, events, reservations, scoreboard } =
    ledgerReads(deps);
  const { queue, smiths, config, worktrees, eligibility } =
    workspaceReads(deps);
  const { counts } = beadsReads(deps);
  const { projects, preferences } = projectRoutes(deps.projectHome);
  const projectSnapshot = projectSnapshotReader(deps.projectHome, deps);
  const conversations = conversationRoutes(
    deps.projectHome,
    deps.root,
    deps.conversationTransport,
    keeperAboutValidator(deps, projectSnapshot),
    createKeeperBriefPreparer(deps.projectHome, deps, projectSnapshot),
  );
  const proposals = keeperProposalRoutes(
    deps.projectHome,
    deps,
    projectSnapshot,
    deps.keeperOperatorPost,
  );
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
    worktrees,
    eligibility,
    counts,
    scoreboard,
    projects,
    projectSummaryRoute(deps.projectHome, deps, projectSnapshot),
    projectOverviewRoute(deps, projectSnapshot),
    keeperReadRoute(deps, projectSnapshot),
    conversations.read,
    conversations.briefs,
    proposals.read,
  ];

  // Opened with the hearth's first-open wait, as the read rows are.
  const ledger = (): { path: string } => hearthLedger(deps.ledgerPath);
  const { workspace } = deps;
  const live = createLedgerStream({
    cursor: () => latestEventId({ workspace }, ledger()),
    // Every collection row, whatever a later bead adds to the table.
    collections: async () => {
      const rows = reads.filter((row) => row.collection !== undefined);
      const envelopes = await Promise.all(rows.map(collectionEnvelope));
      return Object.fromEntries(
        rows.map((row, index) => [row.collection ?? "", envelopes[index]]),
      );
    },
    eventsAfter: (afterId, limit) =>
      queryEvents({ workspace, afterId, limit }, ledger()),
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
    routes: [
      ...reads,
      stream,
      conversations.events,
      ...actions(deps),
      preferences,
      conversations.send,
      conversations.refresh,
      proposals.approve,
      proposals.dismiss,
      conversations.stop,
      ...beadRoutes({
        workspace,
        runBd: deps.runBd,
        appendEvent: deps.appendEvent,
      }),
      ...queueRoutes({
        root: deps.root,
        workspace,
        runBd: deps.runBd,
        appendEvent: deps.appendEvent,
        lockFile: deps.queueLockFile,
        configHome: deps.configHome,
      }),
      ...shiftRoutes({
        workspace,
        shiftsDir: deps.shiftsDir,
        runBd: deps.runBd,
        ledgerPath: deps.ledgerPath,
        appendEvent: deps.appendEvent,
        lockFile: deps.queueLockFile,
        // A shift's worktrees are under the main checkout, as forge:shift makes them.
        mainCheckout: localStateRoot(deps.root),
        starts: deps.shiftStarts,
      }),
    ],
    close: async () => {
      live.close();
      await proposals.close();
      await conversations.close();
    },
  };
}
