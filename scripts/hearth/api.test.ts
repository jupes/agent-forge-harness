import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import type { WorktreeEntry } from "../../types/beads";
import type {
  CodexChatForkCapture,
  CodexChatForkSourceSeal,
} from "../../types/codex-chat-fork";
import type { CodexChatOwnedRecord } from "../../types/codex-owned-chat";
import type {
  EventsPage,
  LedgerEvent,
  LedgerEventInput,
  LedgerEventOf,
  OperatorEnvelope,
  QueueEntry,
  QueueState,
  Reservation,
  RunDetail,
  SessionSummary,
  SmithsView,
} from "../../types/hearth";
import type { OwnedSessionRecord } from "../../types/owned-session";
import type { SmithConfigEditRequest } from "../../types/smith-config-edit";
import type { SmithRoutingEditRequest } from "../../types/smith-routing-edit";
import { type LoadedConfig, loadConfig } from "../config/load";
import { smithCreateInputHash } from "../config/smith-create-journal-protocol";
import {
  smithConfigCreateReceiptSchema,
  smithConfigCreateRequestSchema,
  smithConfigPreviewSchema,
} from "../config/smith-create-protocol";
import { createSmithCreateService } from "../config/smith-create-service";
import { smithEditInputHash } from "../config/smith-edit-journal-protocol";
import {
  smithConfigEditPreviewSchema,
  smithConfigEditReceiptSchema,
} from "../config/smith-edit-protocol";
import { createSmithEditService } from "../config/smith-edit-service";
import {
  smithRoutingEditInputHash,
  smithRoutingEditReceiptSchema,
} from "../config/smith-routing-edit-journal-protocol";
import { smithRoutingEditPreviewSchema } from "../config/smith-routing-edit-protocol";
import { createSmithRoutingEditService } from "../config/smith-routing-edit-service";
import {
  type ConfigWriteTransaction,
  type PreparedConfigTransaction,
  readConfigTransactionSources,
} from "../config/transaction";
import { createConversationStore } from "../conversations/store";
import { runCouncilCli } from "../council/cli";
import type { CommandResult, CommandRunner } from "../council/pr-source";
import type { CouncilPreview } from "../council/service";
import { REVIEW_NOTE_LIMIT } from "../dashboard/forge-run-model";
import { hashText } from "../hash-text";
import { createRestartIdentityJournal } from "../identities/restart-index";
import { createKeeperProposalStore } from "../keeper/proposal-store";
import { keeperSessionStartReceiptSchema } from "../keeper/session-start-protocol";
import { keeperShiftStartRequestSchema } from "../keeper/shift-start-protocol";
import { type AppendResult, appendEvent } from "../ledger/append";
import { setSessionModel } from "../ledger/session-models";
import { workspaceKey } from "../projects/scope";
import { createProjectStore, projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { providerLoginFile } from "../providers/login";
import { queueTracker } from "../scheduler/queue-fixture";
import {
  readShiftRecord,
  SHIFTS_DIR,
  writeShiftRecord,
} from "../scheduler/shift-store";
import type { GitRun } from "../scheduler/worktrees";
import { serializeClaudeLaunch } from "../sessions/claude-launch";
import { createCodexChatForkJournal } from "../sessions/codex-chat-fork-journal";
import {
  CODEX_CHAT_FORK_PROTOCOL_VERSION,
  codexChatForkCaptureHash,
  codexChatForkOriginalHash,
  codexChatForkOriginalHashInput,
} from "../sessions/codex-chat-fork-protocol";
import { ownedCodingPageSchema } from "../sessions/codex-owned-journal";
import { canonicalOwnedSessionStart } from "../sessions/codex-owned-protocol";
import {
  sessionStartIdentityPageSchema,
  sessionStartIdentityReplySchema,
} from "../sessions/identity-protocol";
import { sessionLibraryReadSchema } from "../sessions/library-protocol";
import { canonicalSessionInput } from "../sessions/preparation";
import { sessionPreviewReceiptSchema } from "../sessions/protocol";
import { createSessionRegistry } from "../sessions/registry";
import { APPRENTICE_VERIFICATION } from "../smith-verification";
import type { ActionContext, ActionRoute, ApiRoute } from "./api";
import { sessionsPath, tokenPath } from "./home";
import { createSessionStore, sessionCookieName } from "./launch";
import {
  HEALTH_ROUTE,
  OPERATOR_HEADER,
  SESSION_KEY_HEADER,
  SURFACE_HEADER,
} from "./paths";
import {
  FIXTURE_CHAT_DECISION,
  FIXTURE_CHAT_SESSION,
  seedChatDecision,
  seedForkableCodexChatSource,
} from "./routes/codex-chat-fixture";
import { desktopControlRoutes } from "./routes/desktop-control";
import type { BdResult } from "./routes/dev-api";
import {
  FIXTURE_KEEPER_DECISION,
  FIXTURE_KEEPER_PROPOSAL_SOURCE,
  seedKeeperProposalSource,
} from "./routes/keeper-proposal-fixture";
import {
  FIXTURE_KEEPER_SESSION_HISTORY,
  FIXTURE_KEEPER_SESSION_PROPOSAL,
  FIXTURE_KEEPER_SESSION_REQUEST,
  seedKeeperSessionStartHistory,
  seedKeeperSessionStartSource,
} from "./routes/keeper-session-start-fixture";
import {
  FIXTURE_KEEPER_SHIFT_HISTORY,
  FIXTURE_KEEPER_SHIFT_HISTORY_REQUEST,
  FIXTURE_KEEPER_SHIFT_PROPOSAL,
  FIXTURE_KEEPER_SHIFT_REQUEST,
  keeperShiftStartFixture,
  seedKeeperShiftStartHistory,
  seedKeeperShiftStartSource,
} from "./routes/keeper-shift-start-fixture";
import { seedProjectBeadWriteFixture } from "./routes/project-bead-write-fixture";
import {
  FIXTURE_SHIFT_ATTEMPT_SESSION_ID,
  FIXTURE_SHIFT_ID,
  FIXTURE_SHIFT_START,
  seedProjectShift,
  seedProjectShiftAttempt,
} from "./routes/project-shift-fixture";
import {
  FIXTURE_OWNED_SESSION_ID,
  FIXTURE_OWNED_STOP_ID,
  FIXTURE_SESSION_PROMPT,
  FIXTURE_SESSION_SEND,
  FIXTURE_SESSION_START,
  FIXTURE_SESSION_STOP,
  fixtureSessionGit,
  seedOwnedSession,
  sessionStartFixture,
  waitOwnedTurn,
} from "./routes/session-fixture";
import {
  FIXTURE_WORKTREE_REQUEST,
  seedSessionWorktreeFixture,
  sessionWorktreeFixtureRequest,
} from "./routes/session-worktree-fixture";
import {
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "./testing";
import { readToken, writeOwnerOnly } from "./token";
import { validateOperatorEnvelope } from "./validate";

const open: TestHearth[] = [];
const FIXTURE_IDENTITY_REQUEST = "42f1676b-7a85-43a2-a694-e0908bb32dab";
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

async function start(options: TestHearthOptions = {}): Promise<TestHearth> {
  const hearth = await startTestHearth(options);
  open.push(hearth);
  writeOwnerOnly(
    projectCatalogPath(hearth.home),
    JSON.stringify(projectCatalogFixture(hearth.workspace)),
  );
  seedSessionWorktreeFixture(hearth);
  writeOwnerOnly(
    providerLoginFile(hearth.home, hearth.root),
    JSON.stringify({
      version: 1,
      records: [
        {
          provider: "claude",
          requestId: "7b5b2b32-4bcc-4a1c-92c8-61dd39234d82",
          phase: "closed",
          startedAt: "2026-10-23T00:00:00Z",
          endedAt: "2026-10-23T00:00:01Z",
          exitCode: 0,
          stopped: false,
          timedOut: false,
        },
      ],
    }),
  );
  return hearth;
}

/** The answer's envelope, after checking it is one. */
async function envelope<T = unknown>(
  response: Response,
): Promise<OperatorEnvelope<T>> {
  const body: unknown = await response.json();
  const checked = validateOperatorEnvelope(body);
  if (!checked.ok) throw new Error(`not an envelope: ${checked.error}`);
  // justification: the guard above proved the envelope; `T` is the caller's claim about `data`.
  return checked.value as OperatorEnvelope<T>;
}

const RUN_STATE = JSON.stringify({
  schemaVersion: 2,
  slug: "demo",
  feature: "Demo run",
  epic: "alpha-epic",
  phase: "research",
  completed: ["research"],
  artifacts: { research: "plans/research/demo.md" },
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const API_SMITH_CREATE_ID = "dc9078cf-6200-4fed-aeb8-2be646ee7953";
const API_SMITH_CREATE_RESERVE_ID = "dc9078cf-6200-4fed-aeb8-2be646ee7954";
const API_SMITH_CREATE_RETIRE_ID = "dc9078cf-6200-4fed-aeb8-2be646ee7955";
const API_SMITH_CREATE_REVISION = {
  version: 1 as const,
  user: "0".repeat(64),
  workspace: "0".repeat(64),
};
const API_CODEX_CHAT_FORK_ID = "80e40be9-e811-47c3-a71d-b988e67178a0";
const API_CODEX_CHAT_FORK_CONTROL_CHILD_ID =
  "session-80e40be9-e811-47c3-a71d-b988e6717801";
const API_CODEX_CHAT_FORK_CONTROL_CHILD_REQUEST_ID =
  "80e40be9-e811-47c3-a71d-b988e6717802";
const API_CODEX_CHAT_FORK_CHILD_ID = API_CODEX_CHAT_FORK_CONTROL_CHILD_ID;
const API_CODEX_CHAT_FORK_CHILD_REQUEST_ID =
  API_CODEX_CHAT_FORK_CONTROL_CHILD_REQUEST_ID;
const API_CODEX_CHAT_FORK_CONTROL_DECISION_ID =
  "80e40be9-e811-47c3-a71d-b988e6717803";
const API_CODEX_CHAT_FORK_CONTROL_STOP_ID =
  "80e40be9-e811-47c3-a71d-b988e6717804";
const API_CODEX_CHAT_FORK_RESERVE_ID = "808b8f84-1f86-44bf-9cf4-518c58b59a11";
const API_CODEX_CHAT_FORK_RETIRE_ID = "808b8f84-1f86-44bf-9cf4-518c58b59a12";
const API_CODEX_CHAT_FORK_SOURCE = {
  sessionId: "session-4b092165-2bc0-49e2-ae10-bf0b2f77c0ce",
  requestId: "22b8c0af-0446-4c9a-9c0a-3b7d6f23f5e1",
  turnRequestId: "4ca96cdd-aab5-48e1-bde2-6f158f0b53bb",
  approvalId: "11cc8647-32c5-4278-85c6-a43fe9019842",
  threadId: "0199a213-81c0-7800-8aa1-bbab2a035a61",
  turnId: "0199a213-81c0-7800-8aa1-bbab2a035a62",
};
// Central control-route rows use their own source transcript. Earlier Fork
// actions in the shared API inventory leave state for their own parent/turn.
const API_CODEX_CHAT_FORK_CONTROL_SOURCE = {
  sessionId: "session-71e40be9-e811-47c3-a71d-b988e6717810",
  requestId: "71e40be9-e811-47c3-a71d-b988e6717811",
  turnRequestId: "71e40be9-e811-47c3-a71d-b988e6717812",
  approvalId: "71e40be9-e811-47c3-a71d-b988e6717813",
  threadId: "0199a213-81c0-7800-8aa1-bbab2a035a80",
  turnId: "0199a213-81c0-7800-8aa1-bbab2a035a81",
};
const API_CODEX_CHAT_FORK_RESERVE_SOURCE = {
  sessionId: "session-4b092165-2bc0-49e2-ae10-bf0b2f77c0cf",
  requestId: "22b8c0af-0446-4c9a-9c0a-3b7d6f23f5f2",
  turnRequestId: "4ca96cdd-aab5-48e1-bde2-6f158f0b53bd",
  approvalId: "11cc8647-32c5-4278-85c6-a43fe9019843",
  threadId: "0199a213-81c0-7800-8aa1-bbab2a035a63",
  turnId: "0199a213-81c0-7800-8aa1-bbab2a035a64",
};
const API_IDENTITY_START = {
  requestId: FIXTURE_IDENTITY_REQUEST,
  smith: "claude-journeyman",
  repository: "/api-identity-fixture",
  worktree: "/api-identity-fixture",
  launch: {
    mode: "chat" as const,
    model: "sonnet",
    prompt: "API identity fixture",
  },
};
const API_SMITH_CREATE_SMITH = {
  name: "api-route-smith",
  provider: "custom",
  model: "fixture-model",
  effort: "high",
  enabled: true,
  tags: ["fixture"],
};
const API_SMITH_CREATE_RESERVE_SMITH = {
  ...API_SMITH_CREATE_SMITH,
  name: "api-route-reserve-smith",
};
const API_SMITH_CREATE_RETIRE_SMITH = {
  ...API_SMITH_CREATE_SMITH,
  name: "api-route-retire-smith",
};
const API_SMITH_EDIT_ID = "122d0b56-96f3-4818-8789-6ab562c092e8";
const API_SMITH_EDIT_SMITH = {
  name: "claude-master",
  provider: "claude",
  model: "api-edit-model",
  effort: "high",
  enabled: false,
  tags: ["rank:master", "api-edit"],
};
const API_SMITH_EDIT_ACTION_SMITH = {
  name: "api-edit-action-fixture",
  provider: "claude",
  model: "api-edit-model",
  effort: "high",
  enabled: false,
  tags: ["api-edit-fixture"],
};
const API_SMITH_ROUTING_EDIT_ID = "4ba29c22-8414-4bd6-9d4d-2d0591d5d0a0";
const API_SMITH_ROUTING_EDIT_ORIGINAL_ID =
  "4ba29c22-8414-4bd6-9d4d-2d0591d5d0a1";
const API_SMITH_ROUTING_EDIT_CHANGE = {
  kind: "default" as const,
  smith: "claude-apprentice",
};

function seedSmithEditActionTarget(h: TestHearth): void {
  const directory = join(h.configHome, ".agent-forge");
  mkdirSync(directory, { recursive: true });
  writeOwnerOnly(
    join(directory, "config.toml"),
    `[smiths.${API_SMITH_EDIT_ACTION_SMITH.name}]\nprovider = "claude"\nmodel = "api-edit-original-model"\neffort = "high"\nenabled = true\ntags = ["api-edit-fixture"]\n`,
  );
}

function seedSmithRoutingEditActionTarget(h: TestHearth): void {
  writeFileSync(
    join(h.root, "agent-forge.toml"),
    '[workflow]\ndefault_crew = "claude-master"\n[benches]\nlow = ["claude-master:1"]\nmedium = ["claude-apprentice:1"]\n',
  );
}

async function seedSmithRoutingEditOriginal(h: TestHearth): Promise<void> {
  const service = createSmithRoutingEditService(
    {
      options: {
        harnessRoot: h.root,
        home: h.configHome,
        env: {},
      },
    },
    { profileHome: h.home, coordinationRoot: h.home },
  );
  const preview = service.preview({
    target: "workspace",
    change: API_SMITH_ROUTING_EDIT_CHANGE,
  });
  await service.edit({
    requestId: API_SMITH_ROUTING_EDIT_ORIGINAL_ID,
    target: "workspace",
    change: API_SMITH_ROUTING_EDIT_CHANGE,
    expectedRevision: {
      ...preview.expectedRevision,
      workspace: "0".repeat(64),
    },
  });
}

async function seedSmithCreateOriginal(h: TestHearth): Promise<void> {
  const service = createSmithCreateService(
    {
      options: {
        harnessRoot: h.root,
        home: h.configHome,
        env: {},
      },
    },
    { profileHome: h.home, coordinationRoot: h.home },
  );
  const preview = service.preview({
    target: "workspace",
    smith: API_SMITH_CREATE_SMITH,
  });
  await service.reserveIdentity({
    requestId: API_SMITH_CREATE_ID,
    target: "workspace",
    smith: API_SMITH_CREATE_SMITH,
    expectedRevision: preview.expectedRevision,
  });
}

async function seedSmithEditOriginal(h: TestHearth): Promise<void> {
  const noPublish: NonNullable<
    Parameters<typeof createSmithEditService>[1]
  >["withTransaction"] = async <T>(
    context: PreparedConfigTransaction,
    work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
  ): Promise<T> => {
    const found = readConfigTransactionSources(context),
      transaction: ConfigWriteTransaction = {
        sources: found.sources,
        revision: found.revision,
        publish() {
          throw new Error("the read fixture must refuse before publication");
        },
      };
    return work(transaction) as T;
  };
  const service = createSmithEditService(
    {
      options: {
        harnessRoot: h.root,
        home: h.configHome,
        env: {},
      },
    },
    {
      profileHome: h.home,
      coordinationRoot: h.home,
      withTransaction: noPublish,
    },
  );
  const preview = service.preview({
    target: "workspace",
    name: API_SMITH_EDIT_SMITH.name,
    smith: API_SMITH_EDIT_SMITH,
  });
  await service.edit({
    requestId: API_SMITH_EDIT_ID,
    target: "workspace",
    name: API_SMITH_EDIT_SMITH.name,
    smith: API_SMITH_EDIT_SMITH,
    expectedRevision: {
      ...preview.expectedRevision,
      workspace: "0".repeat(64),
    },
  });
}

const key = (route: ApiRoute): string => `${route.method} ${route.path}`;

/** The common read matrix needs a real-shaped fixed record, independently of project membership. */
function seedSmithVerificationRead(h: TestHearth): void {
  const previous = h.bd.answer;
  h.bd.answer = (args) =>
    args.length === 4 &&
    args[0] === "--readonly" &&
    args[1] === "show" &&
    args[2] === APPRENTICE_VERIFICATION &&
    args[3] === "--json"
      ? {
          status: 0,
          stdout: JSON.stringify([
            {
              id: APPRENTICE_VERIFICATION,
              title: "Owner verification",
              status: "open",
              priority: 2,
            },
          ]),
          stderr: "",
        }
      : previous?.(args);
}

test("an effect receives its actual persisted operator audit id; HTTP input cannot choose that trace", async () => {
  let calls = 0;
  const row: ActionRoute<null> = {
    kind: "action",
    method: "POST",
    path: "/audit-trace-fixture",
    action: "fixture.audit.trace",
    validate: () => ({ ok: true, value: null }),
    subject: () => ({ target: "trace-fixture" }),
    effect: (_input, context?: { auditEventId: number }) => {
      calls++;
      return {
        status: 200,
        data: { auditEventId: context?.auditEventId ?? null },
      };
    },
  };
  const h = await start({ api: { decorate: (routes) => [...routes, row] } });
  const response = await post(h, row.path, { auditEventId: 999_999 });
  expect(response.status).toBe(200);
  const result = await envelope<{ auditEventId: number | null }>(response);
  const audit = h.events(["operator.action"]).at(-1);
  expect(audit?.payload).toMatchObject({
    action: row.action,
    target: "trace-fixture",
  });
  expect(result.data?.auditEventId).toBe(audit?.id);
  expect(calls).toBe(1);
  expect((await post(h, row.path, {}, h.headers(null))).status).toBe(403);
  expect(calls).toBe(1);
});

test("desktop recovery's action row refuses invalid input and failed audits before restart", async () => {
  let effects = 0;
  const decorate = (routes: readonly ApiRoute[]) => [
    ...routes,
    ...desktopControlRoutes(async () => {
      effects++;
      return { status: 200, data: { restarted: true } };
    }),
  ];
  const h = await start({ api: { decorate } });
  for (const body of [{ command: "anything" }, [], null]) {
    const response = await post(h, "/desktop/restart", body);
    expect(response.status).toBe(400);
  }
  expect((await post(h, "/desktop/restart?root=elsewhere", {})).status).toBe(
    400,
  );
  expect(effects).toBe(0);
  expect((await post(h, "/desktop/restart", {})).status).toBe(200);
  expect(effects).toBe(1);
  expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
    action: "desktop.hearth.restart",
  });
  const blocked = await start({
    api: {
      decorate,
      appendEvent: () => ({ ok: false, error: "read-only ledger" }),
    },
  });
  expect((await post(blocked, "/desktop/restart", {})).status).toBe(503);
  expect(effects).toBe(1);
});

/** The table's action rows. An empty table must fail a test that iterates it, not pass it. */
function actionRows(h: TestHearth): ActionRoute[] {
  const rows = h.hearth.routes.filter(
    (route): route is ActionRoute => route.kind === "action",
  );
  if (rows.length === 0) throw new Error("the table has no action rows");
  return rows;
}

function post(
  h: TestHearth,
  path: string,
  body: unknown,
  headers: Record<string, string> = h.headers(h.hearth.token),
): Promise<Response> {
  return fetch(`${h.api}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * What the hearth's token file holds against the token the test sends: the
 * hearth honours its token only while the file still holds it (bu05).
 */
function tokenFileState(h: TestHearth): string {
  const file = tokenPath(h.home, h.root);
  if (!existsSync(h.home)) return "the hearth's home is gone";
  if (!existsSync(file)) return "the token file is missing";
  const held = readToken(file);
  if (held === null) return "the token file is empty or unreadable";
  return held === h.hearth.token
    ? "the token file holds the token sent"
    : "the token file holds another token";
}

/** A read of a stored council run: it needs the operator token. */
function readRuns(h: TestHearth, path = ""): Promise<Response> {
  return fetch(`${h.api}/council-api/runs${path}`, {
    headers: { [OPERATOR_HEADER]: h.hearth.token },
  });
}

/**
 * Wait until the hearth reports the run as ended. A read that is refused
 * throws with the status and the answer's body, so a failure says which
 * refusal it was (agent-forge-harness-bu05).
 */
async function councilRunFinished(h: TestHearth, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await readRuns(h, `/${runId}`);
    if (response.status !== 200)
      throw new Error(
        `council run ${runId} could not be read: ${response.status} ${await response.text()}; ${tokenFileState(h)}`,
      );
    const job = (await response.json()) as { data?: { status?: string } };
    if (job.data?.status !== "running" && job.data?.status !== "cancelling")
      return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`council run ${runId} did not finish`);
}

interface ActionFixture {
  /** A request the row accepts, and the status its effect answers. */
  valid: {
    path: string;
    body: unknown;
    status: number;
    target?: string;
    audit?: Record<string, string>;
    ok?: boolean;
    error?: string | null;
  };
  /** A request the row's validator refuses. */
  invalid: { path: string; body: unknown };
  /**
   * The events the valid request leaves after its audit row, in order: what a
   * row records once its effect succeeded. Declared here, on the test's side,
   * so a row that starts recording something else fails the suite.
   */
  outcome?:
    | Array<Pick<LedgerEvent, "kind" | "payload">>
    | ((h: TestHearth) => Array<Pick<LedgerEvent, "kind" | "payload">>);
  /** Await a background fixture's terminal metadata before comparing its exact event sequence. */
  settled?(h: TestHearth): Promise<void>;
  /** Additional existing operator rows intentionally reached through a reviewed dispatch. */
  effects?: string[];
  /** What the valid request needs to exist first. */
  prepare?(h: TestHearth): Promise<void>;
  /** The effect itself, not its status: what the valid request must have changed. */
  happened(h: TestHearth, answer: unknown): Promise<void>;
}

function projectBeadFixture(
  action: "create" | "claim" | "comment" | "close" | "propose",
): ActionFixture {
  const id =
    action === "create"
      ? "alpha-epic"
      : action === "propose"
        ? "alpha-propose"
        : "alpha-task";
  const path = `/projects/${FIXTURE_PROJECT_ID}/beads${action === "create" ? "" : `/${id}/${action}`}`;
  const body =
    action === "create"
      ? { title: "Fixture project bead", parent: id }
      : action === "comment"
        ? { text: COMMENT }
        : action === "close"
          ? { reason: CLOSE_REASON }
          : {};
  const carried =
    action === "create"
      ? "Fixture project bead"
      : action === "comment"
        ? COMMENT
        : action === "close"
          ? CLOSE_REASON
          : null;
  return {
    valid: {
      path,
      body,
      status: action === "create" || action === "comment" ? 201 : 200,
      target: id,
    },
    invalid: { path, body: { unexpected: true } },
    prepare: async (h) => {
      seedProjectBeadWriteFixture(h);
    },
    outcome: [
      {
        kind: "bead.transitioned",
        payload:
          action === "propose"
            ? { from: null, to: "proposed", reason: "propose:operator" }
            : {
                action,
                ...(carried !== null
                  ? { hash: hashText(carried), length: carried.length }
                  : {}),
              },
      },
    ],
    happened: async (h, data) => {
      expect(data).toMatchObject({
        id: action === "create" ? "alpha-epic.1" : id,
        action,
        recorded: true,
      });
      const calls = h.bd.calls.filter((args) =>
        ["create", "update", "comments", "close"].includes(args[0] ?? ""),
      );
      expect(calls.at(-1)?.[0]).toBe(
        action === "create"
          ? "create"
          : action === "comment"
            ? "comments"
            : action === "close"
              ? "close"
              : "update",
      );
    },
  };
}

function projectQueueFixture(
  action: "approve" | "queue" | "pause" | "resume" | "reassign",
): ActionFixture {
  const id = "alpha-task";
  const path = `/projects/${FIXTURE_PROJECT_ID}/beads/${id}/${action}`;
  const from =
    action === "approve"
      ? "proposed"
      : action === "queue"
        ? "approved"
        : action === "resume"
          ? "paused"
          : "queued";
  const to =
    action === "approve"
      ? "approved"
      : action === "pause"
        ? "paused"
        : "queued";
  return {
    valid: {
      path,
      body: action === "reassign" ? { smith: "claude-master" } : {},
      status: 200,
      target: action === "reassign" ? "claude-master" : id,
    },
    invalid: { path, body: { unexpected: true } },
    prepare: async (h) => {
      seedProjectBeadWriteFixture(h);
      const bead = h.bd.issues.get(id);
      if (!bead) throw Error("Missing scoped queue fixture");
      bead.labels?.push(`queue:${from}`);
      bead.metadata = {
        queue_state: from,
        ...(action === "resume" ? { queue_resume: "running" } : {}),
      };
    },
    outcome: [
      {
        kind: "bead.transitioned",
        payload:
          action === "reassign"
            ? { action, smith: "claude-master" }
            : { from, to, reason: `${action}:operator` },
      },
    ],
    happened: async (h, data) => {
      expect(data).toEqual(
        action === "reassign"
          ? { id, state: from, smith: "claude-master", recorded: true }
          : { id, action, from, to, recorded: true },
      );
      expect(
        h.bd.issues.get(id)?.metadata?.[
          action === "reassign" ? "smith" : "queue_state"
        ],
      ).toBe(action === "reassign" ? "claude-master" : to);
    },
  };
}

interface Job {
  runId: string;
  status: string;
}

/** A council run that is still going when the next request arrives. */
async function runningRun(h: TestHearth, runId: string): Promise<void> {
  const started = await post(h, "/council/runs", text(runId));
  if (started.status !== 202) throw new Error(`could not start ${runId}`);
}

async function runStatus(h: TestHearth, runId: string): Promise<string> {
  const response = await readRuns(h, `/${runId}`);
  return ((await response.json()) as { data?: Job }).data?.status ?? "";
}

/** The start really started a run: the service reports it as running or completed. */
const started =
  (runId: string) =>
  async (h: TestHearth): Promise<void> => {
    expect(["running", "completed"]).toContain(await runStatus(h, runId));
  };

/** The cancel really cancelled: the run was still going, and it ends cancelled, not completed. */
const cancelled =
  (runId: string) =>
  async (h: TestHearth, answer: unknown): Promise<void> => {
    expect(["cancelling", "cancelled"]).toContain((answer as Job).status);
    await councilRunFinished(h, runId);
    expect(await runStatus(h, runId)).toBe("cancelled");
  };

const text = (runId: string): Record<string, unknown> => ({
  sourceType: "text",
  source: "Evaluate this plan and record any missing evidence.",
  runId,
});

/**
 * What the two read-only reads of a bead source print for one invented bead,
 * and, when a comment names a pull request, the origin; `undefined` for any
 * other command, which the test hearth then refuses.
 */
function beadReads(id: string, comments: string[] = []): CommandRunner {
  return async (command) => {
    const line = command.join(" ");
    const printed = (value: unknown): CommandResult => ({
      exitCode: 0,
      stdout: JSON.stringify(value),
      stderr: "",
    });
    if (line === `bd --readonly show ${id} --json`)
      return printed([
        {
          id,
          title: "Teach the kiln to report its temperature",
          acceptance_criteria: "[ ] The reading is in Celsius.",
          status: "in_progress",
          priority: 2,
          issue_type: "task",
        },
      ]);
    if (line === `bd --readonly comments ${id} --json`)
      return printed(
        comments.map((text, index) => ({
          issue_id: id,
          text,
          created_at: `2031-01-0${index + 1}T10:00:00Z`,
        })),
      );
    if (line === "git remote get-url origin")
      return {
        exitCode: 0,
        stdout: "https://github.com/demo-org/kiln-works.git\n",
        stderr: "",
      };
    return { exitCode: 2, stdout: "", stderr: `not arranged: ${line}` };
  };
}

/** The ids of the council runs the hearth lists, sorted. */
async function runIds(h: TestHearth): Promise<string[]> {
  const runs = await readRuns(h);
  return ((await envelope<Array<{ runId: string }>>(runs)).data ?? [])
    .map((run) => run.runId)
    .sort();
}

/** The run ids listed before the preview fixture's request. */
let previewRunsBefore: string[] = [];

/** The council events of one run, once its end is recorded. */
async function councilEventsOf(
  h: TestHearth,
  runId: string,
): Promise<LedgerEvent[]> {
  const ofRun = (): LedgerEvent[] =>
    h
      .events(["council.run.started", "council.run.finished"])
      .filter(
        (event) =>
          (event.kind === "council.run.started" ||
            event.kind === "council.run.finished") &&
          event.payload.councilRunId === runId,
      );
  for (
    let i = 0;
    i < 400 && !ofRun().some((event) => event.kind === "council.run.finished");
    i++
  )
    await new Promise((done) => setTimeout(done, 25));
  return ofRun();
}

async function finishedRun(h: TestHearth, runId: string): Promise<void> {
  const started = await post(h, "/council/runs", text(runId));
  if (started.status !== 202) throw new Error(`could not start ${runId}`);
  await councilRunFinished(h, runId);
}

const REVIEW = { issueId: "demo-1", decision: "approve", note: "" };

const COMMENT = "worklog: fixture comment";
const CLOSE_REASON = "Verified by the fixture";

/**
 * Put one bead in a queue state the queue wrote, in the hearth's stand-in for
 * bd. Only the queue's own two calls are answered by it; every other call
 * still reaches the stand-in.
 */
function queued(
  h: TestHearth,
  id: string,
  state: string,
  resume?: string,
): Promise<void> {
  const tracker = queueTracker([
    {
      id,
      labels: [`queue:${state}`],
      metadata: {
        queue_state: state,
        ...(resume !== undefined ? { queue_resume: resume } : {}),
      },
    },
  ]);
  h.bd.answer = (args) => tracker.answer(args);
  return Promise.resolve();
}

/** A queue move's fixture: the bead starts in `from`, and one read and one write take it to `to`. */
function queueMove(
  action: string,
  from: QueueState,
  to: QueueState,
  change: string[],
  resume?: QueueState,
): ActionFixture {
  const id = `demo-${action}`;
  return {
    valid: {
      path: `/queue/${id}/${action}`,
      body: {},
      status: 200,
      target: id,
    },
    // An id that would be read as an option if it ever reached bd.
    invalid: { path: `/queue/-rf/${action}`, body: {} },
    prepare: (h) => queued(h, id, from, resume),
    outcome: [
      {
        kind: "bead.transitioned",
        payload: { from, to, reason: `${action}:operator` },
      },
    ],
    happened: async (h, data) => {
      expect(data).toEqual({ id, action, from, to, recorded: true });
      expect(h.bd.calls.slice(-2)).toEqual([
        ["show", "--readonly", "--json", "--", id],
        ["update", ...change, "--json", "--", id],
      ]);
    },
  };
}

function keeperProposalFixture(dismiss: boolean): ActionFixture {
  const suffix = dismiss ? "dismiss" : "approve",
    proposalId = `proposal-${FIXTURE_KEEPER_PROPOSAL_SOURCE}-${dismiss ? 1 : 0}`;
  const valid: ActionFixture["valid"] = {
    path: `/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${suffix}`,
    body: {},
    status: 200,
    target: proposalId,
  };
  const text = `design: ${FIXTURE_KEEPER_DECISION}`;
  return {
    valid,
    invalid: {
      path: valid.path,
      body: {
        id: proposalId,
        sourceHash: "a".repeat(64),
        requestId: "invalid",
        expectedRevision: 0,
      },
    },
    prepare: async (h) => {
      const sources = await seedKeeperProposalSource(h),
        source = sources[dismiss ? 1 : 0];
      if (!source) throw new Error("Missing proposal fixture source");
      valid.body = {
        id: source.id,
        sourceHash: source.sourceHash,
        requestId: `8b77d65d-18f9-4a15-ab82-8f48dfab6b0${dismiss ? 2 : 1}`,
        expectedRevision: (
          await createKeeperProposalStore(h.home).read(FIXTURE_PROJECT_ID)
        ).revision,
        ...(dismiss ? {} : { draft: source.draft }),
      };
    },
    effects: dismiss ? [] : ["POST /beads/:id/comment"],
    outcome: dismiss
      ? []
      : [
          {
            kind: "operator.action",
            payload: {
              action: "bead.comment",
              surface: "api",
              target: "alpha-epic",
            },
          },
          {
            kind: "bead.transitioned",
            payload: {
              action: "comment",
              hash: hashText(text),
              length: text.length,
            },
          },
        ],
    happened: async (h, data) => {
      expect(data).toMatchObject({
        projectId: FIXTURE_PROJECT_ID,
        record: {
          id: proposalId,
          phase: dismiss ? "dismissed" : "done",
          pending: false,
        },
      });
      expect(
        (
          await createKeeperProposalStore(h.home).read(FIXTURE_PROJECT_ID)
        ).records.some((record) => record.id === proposalId),
      ).toBe(true);
    },
  };
}

function ownedSessionFixture(
  operation: "start" | "send" | "stop",
  originalStartId = FIXTURE_SESSION_START,
): ActionFixture {
  const projectPath = `/projects/${FIXTURE_PROJECT_ID}/sessions`;
  const id =
    operation === "stop" ? FIXTURE_OWNED_STOP_ID : FIXTURE_OWNED_SESSION_ID;
  const requestId =
    operation === "start"
      ? originalStartId
      : operation === "stop"
        ? FIXTURE_SESSION_STOP
        : FIXTURE_SESSION_SEND;
  const path =
    operation === "start"
      ? projectPath
      : `${projectPath}/${id}/${operation === "stop" ? "stop" : "turns"}`;
  const valid: ActionFixture["valid"] = {
    path,
    body:
      operation === "stop"
        ? { requestId }
        : operation === "send"
          ? {
              requestId,
              expectedRevision: 0,
              text: FIXTURE_SESSION_PROMPT,
              about: [],
            }
          : {
              requestId,
              smith: "claude-journeyman",
              repository: "/fixture",
              worktree: "/fixture",
              launch: {
                mode: "chat",
                model: "sonnet",
                prompt: FIXTURE_SESSION_PROMPT,
              },
            },
    status: operation === "stop" ? 200 : 202,
    target: operation === "start" ? FIXTURE_PROJECT_ID : id,
  };
  const selected = (h: TestHearth): OwnedSessionRecord => {
    const record = createSessionRegistry(h.home)
      .list(FIXTURE_PROJECT_ID)
      .find((item) =>
        operation === "start" ? item.requestId === requestId : item.id === id,
      );
    if (!record) throw new Error("Missing owned session fixture");
    return record;
  };
  const state = (h: TestHearth) => {
    const session = selected(h);
    return createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: session.id,
    }).read(FIXTURE_PROJECT_ID);
  };
  return {
    valid,
    invalid: { path, body: { requestId: "invalid" } },
    prepare: async (h) => {
      if (operation === "start") valid.body = sessionStartFixture(h, requestId);
      else {
        await seedOwnedSession(h, operation === "stop");
        if (operation === "send")
          valid.body = {
            requestId,
            expectedRevision: state(h).revision,
            text: FIXTURE_SESSION_PROMPT,
            about: [],
          };
      }
    },
    settled: async (h) => {
      await waitOwnedTurn(h, selected(h), requestId);
      await Bun.sleep(0);
    },
    outcome: (h) => {
      const saved = state(h),
        turn = saved.turns.find((item) => item.requestId === requestId);
      if (!turn) throw new Error("Missing owned fixture turn");
      const events: Array<Pick<LedgerEvent, "kind" | "payload">> = [];
      if (operation === "start")
        events.push({
          kind: "session.started",
          payload: {
            source: "desktop",
            kind: "headless",
            worktree: h.workspace,
          },
        });
      if (operation !== "stop") {
        const user = saved.frames.find(
          (frame) => frame.turnId === requestId && frame.event.kind === "user",
        )?.event;
        if (user?.kind !== "user" || !user.session)
          throw new Error("Missing prepared fixture launch");
        const stdin = serializeClaudeLaunch(
          user.session.launch,
          user.session.capabilities,
        ).stdin;
        events.push({
          kind: "prompt.submitted",
          payload: { hash: hashText(stdin), length: stdin.length },
        });
      }
      events.push({
        kind: "session.ended",
        payload: {
          reason: turn.phase,
          durationMs: Math.max(
            0,
            Date.parse(turn.updatedAt) - Date.parse(turn.createdAt),
          ),
        },
      });
      return events;
    },
    happened: async (h) => {
      expect(
        state(h).turns.find((item) => item.requestId === requestId)?.phase,
      ).toBe(operation === "stop" ? "cancelled" : "completed");
    },
  };
}

/** One entry per action row of the table; a row with none fails the suite. */
const ACTIONS: Record<string, ActionFixture> = {
  "POST /config/smiths/preview": {
    valid: {
      path: "/config/smiths/preview",
      body: { target: "workspace", smith: API_SMITH_CREATE_SMITH },
      status: 200,
      target: "workspace",
    },
    invalid: {
      path: "/config/smiths/preview",
      body: {
        target: "workspace",
        smith: API_SMITH_CREATE_SMITH,
        path: "arbitrary",
      },
    },
    happened: async (_h, answer) => {
      expect(smithConfigPreviewSchema.safeParse(answer).success).toBe(true);
    },
  },
  "POST /config/smiths/creates/reserve": {
    valid: {
      path: "/config/smiths/creates/reserve",
      body: {
        requestId: API_SMITH_CREATE_RESERVE_ID,
        target: "workspace",
        smith: API_SMITH_CREATE_RESERVE_SMITH,
        expectedRevision: API_SMITH_CREATE_REVISION,
      },
      status: 200,
      target: "workspace",
      audit: {
        family: "smith-config-create",
        requestId: API_SMITH_CREATE_RESERVE_ID,
        inputHash: smithCreateInputHash({
          requestId: API_SMITH_CREATE_RESERVE_ID,
          target: "workspace",
          smith: API_SMITH_CREATE_RESERVE_SMITH,
          expectedRevision: API_SMITH_CREATE_REVISION,
        }),
      },
    },
    invalid: {
      path: "/config/smiths/creates/reserve",
      body: { requestId: "invalid" },
    },
    prepare: async (h) => {
      const preview = await post(h, "/config/smiths/preview", {
        target: "workspace",
        smith: API_SMITH_CREATE_RESERVE_SMITH,
      });
      const checked = smithConfigPreviewSchema.parse(
        (await envelope(preview)).data,
      );
      const request = {
        requestId: API_SMITH_CREATE_RESERVE_ID,
        target: "workspace" as const,
        smith: API_SMITH_CREATE_RESERVE_SMITH,
        expectedRevision: checked.expectedRevision,
      };
      const fixture = ACTIONS["POST /config/smiths/creates/reserve"]!;
      fixture.valid.body = request;
      fixture.valid.audit = {
        family: "smith-config-create",
        requestId: request.requestId,
        inputHash: smithCreateInputHash(request),
      };
    },
    settled: async (h) => {
      const service = createSmithCreateService(
        { options: { harnessRoot: h.root, home: h.configHome, env: {} } },
        { profileHome: h.home, coordinationRoot: h.home },
      );
      const request = smithConfigCreateRequestSchema.parse(
        ACTIONS["POST /config/smiths/creates/reserve"]!.valid.body,
      );
      await service.retireReserved(
        request.requestId,
        smithCreateInputHash(request),
      );
    },
    happened: async (_h, answer) => {
      expect(smithConfigCreateReceiptSchema.parse(answer).result).toMatchObject(
        {
          phase: "held",
          stage: "reserved",
        },
      );
    },
  },
  "POST /config/smiths/creates/:requestId/retire": {
    valid: {
      path: `/config/smiths/creates/${API_SMITH_CREATE_RETIRE_ID}/retire`,
      body: { inputHash: "0".repeat(64) },
      status: 200,
      audit: {
        family: "smith-config-create",
        requestId: API_SMITH_CREATE_RETIRE_ID,
        inputHash: "0".repeat(64),
      },
    },
    invalid: {
      path: "/config/smiths/creates/not-a-uuid/retire",
      body: { inputHash: "0".repeat(64) },
    },
    prepare: async (h) => {
      const preview = await post(h, "/config/smiths/preview", {
        target: "workspace",
        smith: API_SMITH_CREATE_RETIRE_SMITH,
      });
      const checked = smithConfigPreviewSchema.parse(
        (await envelope(preview)).data,
      );
      const request = {
        requestId: API_SMITH_CREATE_RETIRE_ID,
        target: "workspace" as const,
        smith: API_SMITH_CREATE_RETIRE_SMITH,
        expectedRevision: checked.expectedRevision,
      };
      const service = createSmithCreateService(
        { options: { harnessRoot: h.root, home: h.configHome, env: {} } },
        { profileHome: h.home, coordinationRoot: h.home },
      );
      await service.reserveIdentity(request);
      const inputHash = smithCreateInputHash(request),
        fixture = ACTIONS["POST /config/smiths/creates/:requestId/retire"]!;
      fixture.valid.body = { inputHash };
      fixture.valid.audit = {
        family: "smith-config-create",
        requestId: request.requestId,
        inputHash,
      };
    },
    happened: async (_h, answer) => {
      expect(smithConfigCreateReceiptSchema.parse(answer).result).toMatchObject(
        {
          phase: "refused",
          reason: "cancelled-before-attempt",
        },
      );
    },
  },
  "POST /config/smiths/creates": {
    valid: {
      path: "/config/smiths/creates",
      body: {},
      status: 200,
      target: "workspace",
    },
    invalid: {
      path: "/config/smiths/creates",
      body: { requestId: "invalid" },
    },
    prepare: async (h) => {
      const preview = await post(h, "/config/smiths/preview", {
        target: "workspace",
        smith: API_SMITH_CREATE_SMITH,
      });
      const checked = smithConfigPreviewSchema.parse(
        (await envelope(preview)).data,
      );
      const request = {
        requestId: API_SMITH_CREATE_ID,
        target: "workspace",
        smith: API_SMITH_CREATE_SMITH,
        expectedRevision: checked.expectedRevision,
      };
      const fixture = ACTIONS["POST /config/smiths/creates"]!;
      fixture.valid.body = request;
      fixture.valid.audit = {
        family: "smith-config-create",
        requestId: request.requestId,
        inputHash: smithCreateInputHash(request),
      };
    },
    happened: async (_h, answer) => {
      expect(smithConfigCreateReceiptSchema.parse(answer).result.phase).toBe(
        "confirmed",
      );
    },
  },
  "POST /config/smiths/edits/preview": {
    valid: {
      path: "/config/smiths/edits/preview",
      body: {
        target: "user",
        name: API_SMITH_EDIT_ACTION_SMITH.name,
        smith: API_SMITH_EDIT_ACTION_SMITH,
      },
      status: 200,
      target: "user",
      audit: { family: "smith-config-edit" },
    },
    invalid: {
      path: "/config/smiths/edits/preview",
      body: {
        target: "user",
        name: API_SMITH_EDIT_ACTION_SMITH.name,
        smith: API_SMITH_EDIT_ACTION_SMITH,
        path: "arbitrary",
      },
    },
    prepare: async (h) => seedSmithEditActionTarget(h),
    happened: async (_h, answer) => {
      expect(smithConfigEditPreviewSchema.safeParse(answer).success).toBe(true);
    },
  },
  "POST /config/smiths/edits": {
    valid: {
      path: "/config/smiths/edits",
      body: {
        requestId: API_SMITH_EDIT_ID,
        target: "user",
        name: API_SMITH_EDIT_ACTION_SMITH.name,
        smith: API_SMITH_EDIT_ACTION_SMITH,
        expectedRevision: {
          version: 1,
          user: "a".repeat(64),
          workspace: "b".repeat(64),
        },
      },
      status: 200,
      target: "user",
      audit: {
        family: "smith-config-edit",
        requestId: API_SMITH_EDIT_ID,
        inputHash: smithEditInputHash({
          requestId: API_SMITH_EDIT_ID,
          target: "user",
          name: API_SMITH_EDIT_ACTION_SMITH.name,
          smith: API_SMITH_EDIT_ACTION_SMITH,
          expectedRevision: {
            version: 1,
            user: "a".repeat(64),
            workspace: "b".repeat(64),
          },
        }),
      },
    },
    invalid: {
      path: "/config/smiths/edits",
      body: { requestId: "invalid" },
    },
    prepare: async (h) => {
      seedSmithEditActionTarget(h);
      const checked = createSmithEditService(
        {
          options: {
            harnessRoot: h.root,
            home: h.configHome,
            env: {},
          },
        },
        { profileHome: h.home, coordinationRoot: h.home },
      ).preview({
        target: "user",
        name: API_SMITH_EDIT_ACTION_SMITH.name,
        smith: API_SMITH_EDIT_ACTION_SMITH,
      });
      const request: SmithConfigEditRequest = {
        requestId: API_SMITH_EDIT_ID,
        target: "user",
        name: API_SMITH_EDIT_ACTION_SMITH.name,
        smith: API_SMITH_EDIT_ACTION_SMITH,
        expectedRevision: checked.expectedRevision,
      };
      ACTIONS["POST /config/smiths/edits"]!.valid.body = request;
      ACTIONS["POST /config/smiths/edits"]!.valid.audit = {
        family: "smith-config-edit",
        requestId: request.requestId,
        inputHash: smithEditInputHash(request),
      };
    },
    happened: async (_h, answer) => {
      expect(smithConfigEditReceiptSchema.parse(answer).result.phase).toBe(
        "confirmed",
      );
    },
  },
  "POST /config/smiths/routing-edits/preview": {
    valid: {
      path: "/config/smiths/routing-edits/preview",
      body: {
        target: "workspace",
        change: API_SMITH_ROUTING_EDIT_CHANGE,
      },
      status: 200,
      target: "workspace",
      audit: {
        family: "smith-routing-edit",
        changeKind: "default",
        selector: "workflow.default_crew",
      },
    },
    invalid: {
      path: "/config/smiths/routing-edits/preview",
      body: {
        target: "workspace",
        change: API_SMITH_ROUTING_EDIT_CHANGE,
        path: "arbitrary",
      },
    },
    prepare: async (h) => seedSmithRoutingEditActionTarget(h),
    happened: async (h, answer) => {
      expect(smithRoutingEditPreviewSchema.safeParse(answer).success).toBe(
        true,
      );
      rmSync(join(h.root, "agent-forge.toml"), { force: true });
    },
  },
  "POST /config/smiths/routing-edits": {
    valid: {
      path: "/config/smiths/routing-edits",
      body: {
        requestId: API_SMITH_ROUTING_EDIT_ID,
        target: "workspace",
        change: API_SMITH_ROUTING_EDIT_CHANGE,
        expectedRevision: {
          version: 1,
          user: "a".repeat(64),
          workspace: "b".repeat(64),
        },
      },
      status: 200,
      target: "workspace",
      audit: {
        family: "smith-routing-edit",
        requestId: API_SMITH_ROUTING_EDIT_ID,
        inputHash: "0".repeat(64),
        changeKind: "default",
        selector: "workflow.default_crew",
      },
    },
    invalid: {
      path: "/config/smiths/routing-edits",
      body: { requestId: "invalid" },
    },
    prepare: async (h) => {
      seedSmithRoutingEditActionTarget(h);
      const service = createSmithRoutingEditService(
        {
          options: {
            harnessRoot: h.root,
            home: h.configHome,
            env: {},
          },
        },
        { profileHome: h.home, coordinationRoot: h.home },
      );
      const preview = service.preview({
        target: "workspace",
        change: API_SMITH_ROUTING_EDIT_CHANGE,
      });
      const request: SmithRoutingEditRequest = {
        requestId: API_SMITH_ROUTING_EDIT_ID,
        target: "workspace",
        change: API_SMITH_ROUTING_EDIT_CHANGE,
        expectedRevision: preview.expectedRevision,
      };
      ACTIONS["POST /config/smiths/routing-edits"]!.valid.body = request;
      ACTIONS["POST /config/smiths/routing-edits"]!.valid.audit = {
        family: "smith-routing-edit",
        requestId: request.requestId,
        inputHash: smithRoutingEditInputHash(request),
        changeKind: "default",
        selector: "workflow.default_crew",
      };
    },
    happened: async (h, answer) => {
      expect(smithRoutingEditReceiptSchema.parse(answer).result.phase).toBe(
        "confirmed",
      );
      rmSync(join(h.root, "agent-forge.toml"), { force: true });
    },
  },
  "POST /projects/:id/sessions/:sessionId/forks": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_SOURCE.sessionId}/forks`,
      body: {
        requestId: API_CODEX_CHAT_FORK_ID,
        throughTurnRequestId: API_CODEX_CHAT_FORK_SOURCE.turnRequestId,
      },
      status: 200,
      target: `codex-chat-fork:${FIXTURE_PROJECT_ID}:${API_CODEX_CHAT_FORK_SOURCE.sessionId}`,
      audit: {},
    },
    invalid: {
      path: "/projects/not-a-project/sessions/not-a-session/forks",
      body: {
        requestId: API_CODEX_CHAT_FORK_ID,
        throughTurnRequestId: API_CODEX_CHAT_FORK_SOURCE.turnRequestId,
      },
    },
    prepare: async (h) => {
      const source = await seedForkableCodexChatSource(
        h,
        API_CODEX_CHAT_FORK_SOURCE,
      );
      const hash = codexChatForkOriginalHash(
        codexChatForkOriginalHashInput({
          projectId: source.projectId,
          workspaceKey: source.workspace,
          parentSessionId: source.parentSessionId,
          throughTurnRequestId: source.throughTurnRequestId,
          requestId: API_CODEX_CHAT_FORK_ID,
          protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
        }),
      );
      Object.assign(
        ACTIONS["POST /projects/:id/sessions/:sessionId/forks"]!.valid,
        {
          path: `/projects/${source.projectId}/sessions/${source.parentSessionId}/forks`,
          body: {
            requestId: API_CODEX_CHAT_FORK_ID,
            throughTurnRequestId: source.throughTurnRequestId,
          },
          status: 200,
          target: `codex-chat-fork:${source.projectId}:${source.parentSessionId}`,
          audit: {
            family: "codex-chat-fork",
            requestId: API_CODEX_CHAT_FORK_ID,
            inputHash: hash,
          },
        },
      );
    },
    happened: async (_h, answer) => {
      expect(answer).toMatchObject({ state: "held" });
      expect(answer).not.toHaveProperty("sourceSeal");
      expect(answer).not.toHaveProperty("parentNativeThreadId");
      expect(answer).not.toHaveProperty("prompt");
    },
  },
  "POST /projects/:id/sessions/:sessionId/fork-reservations": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_RESERVE_SOURCE.sessionId}/fork-reservations`,
      body: {
        requestId: API_CODEX_CHAT_FORK_RESERVE_ID,
        throughTurnRequestId: API_CODEX_CHAT_FORK_RESERVE_SOURCE.turnRequestId,
      },
      status: 200,
      target: `codex-chat-fork:${FIXTURE_PROJECT_ID}:${API_CODEX_CHAT_FORK_RESERVE_SOURCE.sessionId}`,
      audit: {},
    },
    invalid: {
      path: "/projects/not-a-project/sessions/not-a-session/fork-reservations",
      body: {
        requestId: API_CODEX_CHAT_FORK_RESERVE_ID,
        throughTurnRequestId: API_CODEX_CHAT_FORK_RESERVE_SOURCE.turnRequestId,
      },
    },
    prepare: async (h) => {
      const source = await seedForkableCodexChatSource(
          h,
          API_CODEX_CHAT_FORK_RESERVE_SOURCE,
        ),
        hash = codexChatForkOriginalHash(
          codexChatForkOriginalHashInput({
            projectId: source.projectId,
            workspaceKey: source.workspace,
            parentSessionId: source.parentSessionId,
            throughTurnRequestId: source.throughTurnRequestId,
            requestId: API_CODEX_CHAT_FORK_RESERVE_ID,
            protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
          }),
        );
      Object.assign(
        ACTIONS["POST /projects/:id/sessions/:sessionId/fork-reservations"]!
          .valid,
        {
          path: `/projects/${source.projectId}/sessions/${source.parentSessionId}/fork-reservations`,
          body: {
            requestId: API_CODEX_CHAT_FORK_RESERVE_ID,
            throughTurnRequestId: source.throughTurnRequestId,
          },
          target: `codex-chat-fork:${source.projectId}:${source.parentSessionId}`,
          audit: {
            family: "codex-chat-fork",
            requestId: API_CODEX_CHAT_FORK_RESERVE_ID,
            inputHash: hash,
          },
        },
      );
    },
    happened: async (_h, answer) => {
      expect(answer).toMatchObject({
        family: "codex-chat-fork",
        requestId: API_CODEX_CHAT_FORK_RESERVE_ID,
        state: "reserved",
      });
      expect(answer).not.toHaveProperty("sourceSeal");
      expect(answer).not.toHaveProperty("prompt");
    },
  },
  "POST /projects/:id/sessions/:sessionId/fork-reservations/:requestId/retire":
    {
      valid: {
        path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_CHAT_SESSION}/fork-reservations/${API_CODEX_CHAT_FORK_RETIRE_ID}/retire`,
        body: { requestHash: "d".repeat(64) },
        status: 200,
        target: `codex-chat-fork:${FIXTURE_PROJECT_ID}:${FIXTURE_CHAT_SESSION}`,
        audit: {
          family: "codex-chat-fork",
          requestId: API_CODEX_CHAT_FORK_RETIRE_ID,
          inputHash: "d".repeat(64),
        },
      },
      invalid: {
        path: "/projects/not-a-project/sessions/not-a-session/fork-reservations/not-a-uuid/retire",
        body: { requestHash: "invalid" },
      },
      prepare: async (h) => {
        const journal = createCodexChatForkJournal({
            root: h.root,
            home: h.home,
          }),
          original = await journal.reserve(
            FIXTURE_PROJECT_ID,
            FIXTURE_CHAT_SESSION,
            {
              requestId: API_CODEX_CHAT_FORK_RETIRE_ID,
              throughTurnRequestId: FIXTURE_CHAT_DECISION.turnRequestId,
            },
            {
              parentRequestHash: "a".repeat(64),
              parentTurnHash: "b".repeat(64),
              parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
              throughNativeTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
              sourceSettingsHash: "c".repeat(64),
            },
            "preflight-v1",
          );
        Object.assign(
          ACTIONS[
            "POST /projects/:id/sessions/:sessionId/fork-reservations/:requestId/retire"
          ]!.valid,
          {
            body: { requestHash: original.requestHash },
            audit: {
              family: "codex-chat-fork",
              requestId: API_CODEX_CHAT_FORK_RETIRE_ID,
              inputHash: original.requestHash,
            },
          },
        );
      },
      happened: async (_h, answer) => {
        expect(answer).toMatchObject({
          requestId: API_CODEX_CHAT_FORK_RETIRE_ID,
          state: "retired",
          retiredReason: "verified-not-sent",
        });
        expect(answer).not.toHaveProperty("sourceSeal");
        expect(answer).not.toHaveProperty("prompt");
      },
    },
  "POST /providers/:provider/sign-in": {
    valid: {
      path: "/providers/claude/sign-in",
      body: { requestId: "f43b9a50-c1c9-441c-86ab-a150ad1775d8" },
      status: 200,
      target: "claude",
    },
    invalid: {
      path: "/providers/claude/sign-in",
      body: {
        requestId: "f43b9a50-c1c9-441c-86ab-a150ad1775d8",
        command: "arbitrary",
      },
    },
    happened: async (h) => {
      const response = await get(
        h,
        "/providers/claude/sign-in/f43b9a50-c1c9-441c-86ab-a150ad1775d8",
        h.headers(h.hearth.token),
      );
      expect((await envelope<{ phase: string }>(response)).data?.phase).toBe(
        "running",
      );
    },
  },
  "POST /providers/:provider/sign-in/:requestId/stop": {
    valid: {
      path: "/providers/codex/sign-in/b6d6d91f-670f-425f-880a-ce511ff55cfa/stop",
      body: {},
      status: 200,
      target: "codex",
    },
    invalid: {
      path: "/providers/codex/sign-in/b6d6d91f-670f-425f-880a-ce511ff55cfa/stop",
      body: { command: "arbitrary" },
    },
    prepare: async (h) => {
      const response = await post(h, "/providers/codex/sign-in", {
        requestId: "b6d6d91f-670f-425f-880a-ce511ff55cfa",
      });
      expect(response.status).toBe(200);
    },
    happened: async (h) => {
      const response = await get(
        h,
        "/providers/codex/sign-in/b6d6d91f-670f-425f-880a-ce511ff55cfa",
        h.headers(h.hearth.token),
      );
      expect(
        (await envelope<{ phase: string; stopped: boolean }>(response)).data,
      ).toMatchObject({ phase: "closed", stopped: true });
    },
  },
  "POST /providers/:provider/doctor": {
    valid: {
      path: "/providers/claude/doctor",
      body: {},
      status: 200,
      target: "claude",
    },
    invalid: { path: "/providers/claude/doctor", body: { task: true } },
    happened: async (h) => {
      expect(
        h
          .events(["operator.action"])
          .some(
            (event) =>
              event.kind === "operator.action" &&
              event.payload.action === "provider.doctor",
          ),
      ).toBe(true);
    },
  },
  "POST /projects/:id/keeper/proposals/:proposalId/session-start": (() => {
    const owned = ownedSessionFixture("start", FIXTURE_KEEPER_SESSION_REQUEST);
    const valid: ActionFixture["valid"] = {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${FIXTURE_KEEPER_SESSION_PROPOSAL}/session-start`,
      body: {},
      status: 200,
      target: FIXTURE_KEEPER_SESSION_PROPOSAL,
    };
    return {
      valid,
      invalid: { path: valid.path, body: { sourceHash: "invalid" } },
      prepare: async (h: TestHearth) => {
        const source = await seedKeeperSessionStartSource(h);
        valid.body = {
          sourceHash: source.sourceHash,
          expectedRevision: (
            await createKeeperProposalStore(h.home).read(FIXTURE_PROJECT_ID)
          ).revision,
          start: sessionStartFixture(h, FIXTURE_KEEPER_SESSION_REQUEST),
        };
      },
      ...(owned.settled ? { settled: owned.settled } : {}),
      ...(owned.outcome ? { outcome: owned.outcome } : {}),
      happened: async (h: TestHearth, answer: unknown) => {
        const checked = keeperSessionStartReceiptSchema.parse(answer);
        expect(checked.record.id).toBe(FIXTURE_KEEPER_SESSION_PROPOSAL);
        expect(checked.session).not.toBeNull();
        expect(checked.receipt).not.toBeNull();
        await owned.happened(h, {
          session: checked.session,
          receipt: checked.receipt,
        });
      },
    };
  })(),
  "POST /projects/:id/keeper/proposals/:proposalId/shift-start": (() => {
    const valid: ActionFixture["valid"] = {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${FIXTURE_KEEPER_SHIFT_PROPOSAL}/shift-start`,
      body: {},
      status: 200,
      target: FIXTURE_KEEPER_SHIFT_PROPOSAL,
    };
    return {
      valid,
      invalid: { path: valid.path, body: { sourceHash: "invalid" } },
      prepare: async (h: TestHearth) => {
        const proposal = (await seedKeeperShiftStartSource(h))[0];
        if (!proposal) throw new Error("Missing fixture Keeper Shift proposal");
        const { revision } = await createKeeperProposalStore(h.home).read(
          FIXTURE_PROJECT_ID,
        );
        const collision = (
          await createKeeperProposalStore(h.home).read(FIXTURE_PROJECT_ID)
        ).records.find(
          (record) =>
            record.id === proposal.id ||
            record.requestId === FIXTURE_KEEPER_SHIFT_REQUEST,
        );
        if (collision)
          throw new Error(
            `Keeper Shift API fixture collided with ${collision.id}/${collision.requestId}`,
          );
        valid.target = proposal.id;
        valid.path = `/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${proposal.id}/shift-start`;
        valid.body = keeperShiftStartFixture(
          proposal.sourceHash,
          FIXTURE_KEEPER_SHIFT_REQUEST,
          revision,
        );
        if (!keeperShiftStartRequestSchema.safeParse(valid.body).success)
          throw new Error("Invalid fixture Keeper Shift request");
      },
      happened: async (h: TestHearth) => {
        expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
          action: "keeper.proposal.shift.start",
          target: valid.target,
        });
        const original = await createKeeperProposalStore(h.home).readShiftStart(
          FIXTURE_PROJECT_ID,
          valid.target ?? FIXTURE_KEEPER_SHIFT_PROPOSAL,
        );
        expect(original?.intent.original).toEqual(
          keeperShiftStartRequestSchema.parse(valid.body),
        );
      },
    };
  })(),
  "POST /projects/:id/sessions/preview": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/preview`,
      body: {},
      status: 200,
      target: FIXTURE_PROJECT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/preview`,
      body: { requestId: "invalid" },
    },
    prepare: async (h) => {
      ACTIONS["POST /projects/:id/sessions/preview"]!.valid.body =
        sessionStartFixture(h);
    },
    happened: async (h, answer) => {
      const parsed = sessionPreviewReceiptSchema.parse(answer);
      expect(parsed.snapshot.cwd).toBe(h.workspace);
      expect(parsed.snapshot.launch.prompt).toBe(FIXTURE_SESSION_PROMPT);
    },
  },
  "POST /projects/:id/session-worktrees": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/session-worktrees`,
      body: {
        requestId: FIXTURE_WORKTREE_REQUEST,
        repository: "/fixture",
        baseRef: "HEAD",
        branch: "feat/worktree-fixture",
      },
      status: 200,
      target: FIXTURE_PROJECT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/session-worktrees`,
      body: { requestId: "invalid" },
    },
    prepare: async (h) => {
      const fixture = ACTIONS["POST /projects/:id/session-worktrees"];
      if (fixture) fixture.valid.body = sessionWorktreeFixtureRequest(h);
    },
    happened: async (_h, data) => {
      expect(data).toMatchObject({
        projectId: FIXTURE_PROJECT_ID,
        requestId: FIXTURE_WORKTREE_REQUEST,
        state: "created",
        branch: "feat/worktree-fixture",
      });
    },
  },
  "POST /projects/:id/sessions": ownedSessionFixture("start"),
  "POST /projects/:id/session-start-identities": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/session-start-identities`,
      body: API_IDENTITY_START,
      status: 200,
      target: "",
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/session-start-identities`,
      body: { requestId: "invalid" },
    },
    prepare: async (h) => {
      const input = sessionStartFixture(h, FIXTURE_IDENTITY_REQUEST);
      ACTIONS["POST /projects/:id/session-start-identities"]!.valid.body =
        input;
      ACTIONS["POST /projects/:id/session-start-identities"]!.valid.target =
        `owned-session-start:${FIXTURE_PROJECT_ID}:${input.requestId}:${createHash("sha256").update(canonicalOwnedSessionStart(input)).digest("hex")}`;
    },
    happened: async (_h, data) => {
      expect(data).toMatchObject({
        version: 1,
        identity: { state: "reserved" },
      });
      expect(JSON.stringify(data)).not.toContain(FIXTURE_SESSION_PROMPT);
    },
  },
  "POST /projects/:id/session-start-identities/:requestId/retire": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/session-start-identities/18da5c95-3218-439c-a33d-e5662465f505/retire`,
      body: { requestHash: "0".repeat(64) },
      status: 200,
      target: `owned-session-start:${FIXTURE_PROJECT_ID}:18da5c95-3218-439c-a33d-e5662465f505:${"0".repeat(64)}`,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/session-start-identities/not-a-uuid/retire`,
      body: { requestHash: "invalid" },
    },
    prepare: async (h) => {
      const input = sessionStartFixture(h, FIXTURE_IDENTITY_REQUEST);
      const requestHash = createHash("sha256")
        .update(canonicalOwnedSessionStart(input))
        .digest("hex");
      const reserve = await post(
        h,
        `/projects/${FIXTURE_PROJECT_ID}/session-start-identities`,
        input,
      );
      expect(reserve.status).toBe(200);
      const fixture =
        ACTIONS[
          "POST /projects/:id/session-start-identities/:requestId/retire"
        ]!;
      fixture.valid.path = `/projects/${FIXTURE_PROJECT_ID}/session-start-identities/${input.requestId}/retire`;
      fixture.valid.body = { requestHash };
      fixture.valid.target = `owned-session-start:${FIXTURE_PROJECT_ID}:${input.requestId}:${requestHash}`;
    },
    happened: async (_h, data) => {
      expect(data).toMatchObject({
        version: 1,
        identity: { state: "retired" },
      });
    },
  },
  "POST /projects/:id/sessions/:sessionId/turns": ownedSessionFixture("send"),
  "POST /projects/:id/sessions/:sessionId/fork-turns": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_CHAT_SESSION}/fork-turns`,
      body: {
        requestId: "d9b25b82-188c-49b9-92b0-46b02647a9ab",
        expectedRevision: 0,
        text: "Central route fixture child request",
        about: [],
      },
      status: 409,
      ok: false,
      error:
        "Only a verified Codex Fork child accepts this continuation action.",
      target: `codex-chat-fork-child:${FIXTURE_PROJECT_ID}:${FIXTURE_CHAT_SESSION}`,
      audit: {
        family: "codex-chat-fork",
        requestId: "d9b25b82-188c-49b9-92b0-46b02647a9ab",
        inputHash: createHash("sha256")
          .update(
            canonicalSessionInput({
              requestId: "d9b25b82-188c-49b9-92b0-46b02647a9ab",
              expectedRevision: 0,
              text: "Central route fixture child request",
              about: [],
            }),
          )
          .digest("hex"),
      },
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_CHAT_SESSION}/fork-turns`,
      body: {
        requestId: "d9b25b82-188c-49b9-92b0-46b02647a9ab",
        expectedRevision: 0,
        text: "Central route fixture child request",
        about: [],
        sourceSettings: { serviceTier: "caller-controlled" },
      },
    },
    prepare: async (h) => {
      await seedChatDecision(h);
    },
    happened: async (_h, data) => expect(data).toBeNull(),
  },
  "POST /projects/:id/sessions/:sessionId/fork-approval-decisions": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_CONTROL_CHILD_ID}/fork-approval-decisions`,
      body: {
        requestId: API_CODEX_CHAT_FORK_CONTROL_DECISION_ID,
        turnRequestId: API_CODEX_CHAT_FORK_CONTROL_CHILD_REQUEST_ID,
        approvalId: "80e40be9-e811-47c3-a71d-b988e6717805",
        decision: "accept",
      },
      status: 409,
      ok: false,
      error: "The live approval has no matching private Fork-child turn.",
      target: `codex-chat-fork-child:${FIXTURE_PROJECT_ID}:${API_CODEX_CHAT_FORK_CONTROL_CHILD_ID}`,
      audit: {
        family: "codex-chat-fork-approval",
        requestId: API_CODEX_CHAT_FORK_CONTROL_DECISION_ID,
        inputHash: createHash("sha256")
          .update(
            JSON.stringify({
              requestId: API_CODEX_CHAT_FORK_CONTROL_DECISION_ID,
              turnRequestId: API_CODEX_CHAT_FORK_CONTROL_CHILD_REQUEST_ID,
              approvalId: "80e40be9-e811-47c3-a71d-b988e6717805",
              decision: "accept",
            }),
          )
          .digest("hex"),
      },
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_CONTROL_CHILD_ID}/fork-approval-decisions`,
      body: { requestId: "invalid" },
    },
    prepare: seedForkReadChild,
    happened: async (_h, answer) => expect(answer).toBeNull(),
  },
  "POST /projects/:id/sessions/:sessionId/fork-stop": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_CONTROL_CHILD_ID}/fork-stop`,
      body: { requestId: API_CODEX_CHAT_FORK_CONTROL_CHILD_REQUEST_ID },
      status: 409,
      ok: false,
      error: "The requested Stop has no matching private Fork-child turn.",
      target: `codex-chat-fork-child:${FIXTURE_PROJECT_ID}:${API_CODEX_CHAT_FORK_CONTROL_CHILD_ID}`,
      audit: {
        family: "codex-chat-fork-stop",
        requestId: API_CODEX_CHAT_FORK_CONTROL_CHILD_REQUEST_ID,
        inputHash: createHash("sha256")
          .update(
            JSON.stringify({
              requestId: API_CODEX_CHAT_FORK_CONTROL_CHILD_REQUEST_ID,
            }),
          )
          .digest("hex"),
      },
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_CONTROL_CHILD_ID}/fork-stop`,
      body: { requestId: "invalid" },
    },
    prepare: seedForkReadChild,
    happened: async (_h, answer) => expect(answer).toBeNull(),
  },
  "POST /projects/:id/sessions/:sessionId/stop": ownedSessionFixture("stop"),
  "POST /projects/:id/sessions/:sessionId/approval-decisions": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_CHAT_SESSION}/approval-decisions`,
      body: FIXTURE_CHAT_DECISION,
      status: 200,
      target: FIXTURE_CHAT_SESSION,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_CHAT_SESSION}/approval-decisions`,
      body: { ...FIXTURE_CHAT_DECISION, nativeRequestId: 1 },
    },
    prepare: async (h) => {
      await seedChatDecision(h);
    },
    happened: async (_h, data) => {
      expect(data).toMatchObject({
        ...FIXTURE_CHAT_DECISION,
        state: "recorded",
      });
    },
  },
  "POST /projects/:id/sessions/:sessionId/archive": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_OWNED_SESSION_ID}/archive`,
      body: {
        requestId: "28641f36-7cfe-4d6d-b1aa-f8102d6f4a0d",
        expectedRevision: 0,
        archived: true,
      },
      status: 200,
      target: FIXTURE_OWNED_SESSION_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_OWNED_SESSION_ID}/archive`,
      body: { requestId: "invalid", archived: true },
    },
    prepare: async (h) => {
      await seedOwnedSession(h);
    },
    happened: async (_h, answer) => {
      const parsed = sessionLibraryReadSchema.safeParse(answer);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.entry.archived).toBe(true);
        expect(parsed.data.receipt?.outcome).toBe("applied");
      }
    },
  },
  "POST /projects/:id/keeper/continuations": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/continuations`,
      body: {
        requestId: "8b77d65d-18f9-4a15-ab82-8f48dfab6b09",
        expectedRevision: 0,
        mode: "switch",
        smith: "claude-master",
        summary: "",
      },
      status: 200,
      target: FIXTURE_PROJECT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/continuations`,
      body: {
        requestId: "invalid",
        mode: "switch",
        smith: "claude-master",
        summary: "",
      },
    },
    prepare: async (h) => {
      const fixture = ACTIONS["POST /projects/:id/keeper/continuations"];
      if (fixture)
        fixture.valid.body = {
          requestId: "8b77d65d-18f9-4a15-ab82-8f48dfab6b09",
          expectedRevision: createConversationStore(h.home).read(
            FIXTURE_PROJECT_ID,
          ).revision,
          mode: "switch",
          smith: "claude-master",
          summary: "Reviewed fixture context",
        };
    },
    effects: [],
    happened: async (h) => {
      expect(
        createConversationStore(h.home).read(FIXTURE_PROJECT_ID).keeperRecovery
          ?.smith,
      ).toBe("claude-master");
    },
  },
  "POST /projects/:id/keeper/proposals/approve": keeperProposalFixture(false),
  "POST /projects/:id/keeper/proposals/dismiss": keeperProposalFixture(true),
  "POST /projects/:id/keeper/briefs": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/briefs`,
      body: {
        requestId: "9b77d65d-18f9-4a15-ab82-8f48dfab6b02",
        expectedRevision: 0,
      },
      status: 202,
      target: FIXTURE_PROJECT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/briefs`,
      body: { requestId: "not-a-request", expectedRevision: 0 },
    },
    prepare: async (h) => {
      const fixture = ACTIONS["POST /projects/:id/keeper/briefs"];
      if (fixture)
        fixture.valid.body = {
          requestId: "9b77d65d-18f9-4a15-ab82-8f48dfab6b02",
          expectedRevision: createConversationStore(h.home).read(
            FIXTURE_PROJECT_ID,
          ).revision,
        };
    },
    happened: async (h) => {
      const state = createConversationStore(h.home).read(FIXTURE_PROJECT_ID);
      expect(
        state.frames.some(
          (frame) =>
            frame.event.kind === "user" &&
            frame.event.brief?.projectId === FIXTURE_PROJECT_ID,
        ),
      ).toBe(true);
    },
  },
  "POST /projects/:id/keeper/turns": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/turns`,
      body: {
        requestId: "9b77d65d-18f9-4a15-ab82-8f48dfab6b01",
        expectedRevision: 0,
        text: "Fixture question",
        about: [],
      },
      status: 202,
      target: FIXTURE_PROJECT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/turns`,
      body: {
        requestId: "not-a-request",
        expectedRevision: 0,
        text: "Question",
        about: [],
      },
    },
    happened: async (h) => {
      const store = createConversationStore(h.home);
      for (
        let attempt = 0;
        attempt < 100 &&
        store.read(FIXTURE_PROJECT_ID).turns[0]?.phase === "running";
        attempt++
      )
        await Bun.sleep(5);
      expect(store.read(FIXTURE_PROJECT_ID).turns[0]?.phase).toBe("completed");
      expect(
        store
          .read(FIXTURE_PROJECT_ID)
          .frames.filter((frame) => frame.event.kind === "user"),
      ).toHaveLength(1);
    },
  },
  "POST /projects/:id/keeper/stop": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/stop`,
      body: { requestId: "3a533435-5025-43d5-8c6d-7e90482c8ed8" },
      status: 200,
      target: FIXTURE_PROJECT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/keeper/stop`,
      body: { requestId: "not-a-request" },
    },
    prepare: async (h) => {
      const store = createConversationStore(h.home);
      await store.accept(FIXTURE_PROJECT_ID, {
        requestId: "3a533435-5025-43d5-8c6d-7e90482c8ed8",
        expectedRevision: store.read(FIXTURE_PROJECT_ID).revision,
        text: "Unissued fixture turn",
        about: [],
      });
    },
    happened: async (h) => {
      expect(
        createConversationStore(h.home).read(FIXTURE_PROJECT_ID).turns.at(-1)
          ?.phase,
      ).toBe("cancelled");
    },
  },
  "POST /projects/:id/preferences": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/preferences`,
      body: { revision: 1, pinned: true },
      status: 200,
      target: FIXTURE_PROJECT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/preferences`,
      body: { revision: 1, pinned: "yes" },
    },
    prepare: async (h) => {
      writeOwnerOnly(
        projectCatalogPath(h.home),
        JSON.stringify(projectCatalogFixture(h.workspace)),
      );
    },
    happened: async (h) => {
      expect(createProjectStore(h.home).read()).toMatchObject({
        revision: 2,
        projects: [{ id: FIXTURE_PROJECT_ID, pinned: true }],
      });
    },
  },
  // A child that inherited its parent's label: in no state, so propose takes it in.
  "POST /queue/:id/propose": {
    valid: {
      path: "/queue/demo-propose/propose",
      body: {},
      status: 200,
      target: "demo-propose",
    },
    invalid: { path: "/queue/-rf/propose", body: {} },
    prepare: (h) => {
      const tracker = queueTracker([
        { id: "demo-propose", labels: ["queue:queued"] },
      ]);
      h.bd.answer = (args) => tracker.answer(args);
      return Promise.resolve();
    },
    outcome: [
      {
        kind: "bead.transitioned",
        payload: { from: null, to: "proposed", reason: "propose:operator" },
      },
    ],
    happened: async (h, data) => {
      expect(data).toEqual({
        id: "demo-propose",
        action: "propose",
        from: null,
        to: "proposed",
        recorded: true,
      });
      expect(h.bd.calls.slice(-2)).toEqual([
        ["show", "--readonly", "--json", "--", "demo-propose"],
        [
          "update",
          "--remove-label=queue:queued",
          "--add-label=queue:proposed",
          "--set-metadata=queue_state=proposed",
          "--json",
          "--",
          "demo-propose",
        ],
      ]);
    },
  },
  "POST /queue/:id/approve": queueMove("approve", "proposed", "approved", [
    "--remove-label=queue:proposed",
    "--add-label=queue:approved",
    "--set-metadata=queue_state=approved",
  ]),
  "POST /queue/:id/queue": queueMove("queue", "approved", "queued", [
    "--remove-label=queue:approved",
    "--add-label=queue:queued",
    "--set-metadata=queue_state=queued",
  ]),
  "POST /queue/:id/pause": queueMove("pause", "queued", "paused", [
    "--remove-label=queue:queued",
    "--add-label=queue:paused",
    "--set-metadata=queue_state=paused",
    "--set-metadata=queue_resume=queued",
  ]),
  "POST /queue/:id/resume": queueMove(
    "resume",
    "paused",
    "queued",
    [
      "--remove-label=queue:paused",
      "--add-label=queue:queued",
      "--set-metadata=queue_state=queued",
      "--unset-metadata=queue_resume",
    ],
    "queued",
  ),
  "POST /queue/:id/reassign": {
    valid: {
      path: "/queue/demo-reassign/reassign",
      body: { smith: "claude-master" },
      status: 200,
      // The bead is the row's subject; what the action names is the smith.
      target: "claude-master",
    },
    invalid: {
      path: "/queue/demo-reassign/reassign",
      body: { smith: "nobody" },
    },
    prepare: (h) => queued(h, "demo-reassign", "queued"),
    // It moves no state: its outcome is a tracker write, with no from or to.
    outcome: [
      {
        kind: "bead.transitioned",
        payload: { action: "reassign", smith: "claude-master" },
      },
    ],
    happened: async (h, data) => {
      expect(data).toEqual({
        id: "demo-reassign",
        state: "queued",
        smith: "claude-master",
        recorded: true,
      });
      expect(h.bd.calls.slice(-2)).toEqual([
        ["show", "--readonly", "--json", "--", "demo-reassign"],
        [
          "update",
          "--set-metadata=smith=claude-master",
          "--json",
          "--",
          "demo-reassign",
        ],
      ]);
    },
  },
  // The test hearth's launcher starts nothing and mints its ids in order: the
  // first start in a hearth names the first id.
  "POST /shifts": {
    valid: {
      path: "/shifts",
      body: { for: "30m", concurrency: 1 },
      status: 202,
      target: "shift-20261015-120000-0001",
    },
    invalid: { path: "/shifts", body: { filter: { epic: "demo-epic" } } },
    // The shift records shift.started itself, once it runs; the row only starts it.
    outcome: [],
    happened: async (h, data) => {
      expect(data).toMatchObject({
        shiftId: "shift-20261015-120000-0001",
        state: "starting",
      });
      expect(h.shifts.launches.at(-1)?.spec.argv.slice(2)).toEqual([
        "run",
        "--id",
        "shift-20261015-120000-0001",
        "--for",
        "30m",
        "--concurrency",
        "1",
      ]);
    },
  },
  "POST /projects/:id/shifts": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/shifts`,
      body: FIXTURE_SHIFT_START,
      status: 202,
      target: FIXTURE_SHIFT_START.requestId,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/shifts`,
      body: { ...FIXTURE_SHIFT_START, workspace: "/other" },
    },
    prepare: (h) => seedProjectShift(h),
    outcome: [],
    happened: async (h, data) => {
      expect(data).toMatchObject({
        intent: { shiftId: FIXTURE_SHIFT_ID, request: FIXTURE_SHIFT_START },
        observation: { phase: "reserved", actual: null },
      });
      expect(
        h.shifts.launches.filter((launch) =>
          launch.spec.argv.includes(FIXTURE_SHIFT_ID),
        ),
      ).toEqual([]);
    },
  },
  "POST /projects/:id/shifts/:shiftId/stop": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/shifts/${FIXTURE_SHIFT_ID}/stop`,
      body: {},
      status: 200,
      target: FIXTURE_SHIFT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/shifts/shift-1/stop`,
      body: {},
    },
    prepare: (h) => seedProjectShift(h, "live"),
    outcome: [],
    happened: async (h, data) => {
      expect(data).toMatchObject({
        observation: { shiftId: FIXTURE_SHIFT_ID, phase: "stopping" },
      });
      expect(
        existsSync(join(h.home, SHIFTS_DIR, `${FIXTURE_SHIFT_ID}.stop`)),
      ).toBe(true);
    },
  },
  "POST /projects/:id/shifts/:shiftId/recover": {
    valid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/shifts/${FIXTURE_SHIFT_ID}/recover`,
      body: {},
      status: 200,
      target: FIXTURE_SHIFT_ID,
    },
    invalid: {
      path: `/projects/${FIXTURE_PROJECT_ID}/shifts/shift-1/recover`,
      body: {},
    },
    prepare: (h) => seedProjectShift(h, "dead"),
    outcome: [
      {
        kind: "shift.stopped",
        payload: { shiftId: FIXTURE_SHIFT_ID, reason: "recovered" },
      },
    ],
    happened: async (_h, data) => {
      expect(data).toMatchObject({
        observation: { shiftId: FIXTURE_SHIFT_ID, phase: "stopped" },
      });
    },
  },
  "POST /shifts/:id/stop": {
    valid: {
      path: "/shifts/shift-20261014-120000-f1a0/stop",
      body: {},
      status: 200,
      target: "shift-20261014-120000-f1a0",
    },
    invalid: { path: "/shifts/shift-1/stop", body: {} },
    // A running shift of this hearth's workspace, as the shift writes it.
    prepare: async (h) => {
      writeShiftRecord(join(h.home, SHIFTS_DIR), {
        shiftId: "shift-20261014-120000-f1a0",
        pid: process.pid,
        workspace: h.workspace,
        startedAt: "2026-10-14T12:00:00.000Z",
        deadline: "2026-10-14T14:00:00.000Z",
        state: "running",
        options: {
          concurrency: 2,
          forMs: 7_200_000,
          maxBeads: 4,
          maxUsd: 10,
          repairs: 3,
        },
        spentUsd: 0,
        unpriced: 0,
        beads: [],
      });
    },
    // The shift records shift.stopped itself; the row only asks.
    outcome: [],
    happened: async (h, data) => {
      expect(data).toEqual({
        shiftId: "shift-20261014-120000-f1a0",
        already: false,
      });
      expect(
        existsSync(join(h.home, SHIFTS_DIR, "shift-20261014-120000-f1a0.stop")),
      ).toBe(true);
    },
  },
  "POST /shifts/:id/recover": {
    valid: {
      path: "/shifts/shift-20261015-090000-f1a1/recover",
      body: {},
      status: 200,
      target: "shift-20261015-090000-f1a1",
    },
    invalid: { path: "/shifts/shift-1/recover", body: {} },
    // A shift of this hearth's workspace whose process ended (no process has
    // that pid) while it held nothing: recovering it closes it.
    prepare: async (h) => {
      writeShiftRecord(join(h.home, SHIFTS_DIR), {
        shiftId: "shift-20261015-090000-f1a1",
        pid: 2_000_000_000,
        workspace: workspaceKey(h.workspace),
        startedAt: "2026-10-15T09:00:00.000Z",
        deadline: "2026-10-15T11:00:00.000Z",
        state: "running",
        options: {
          concurrency: 2,
          forMs: 7_200_000,
          maxBeads: 4,
          maxUsd: 10,
          repairs: 3,
        },
        spentUsd: 0,
        unpriced: 0,
        beads: [],
      });
    },
    outcome: [
      {
        kind: "shift.stopped",
        payload: { shiftId: "shift-20261015-090000-f1a1", reason: "recovered" },
      },
    ],
    happened: async (h, data) => {
      expect(data).toMatchObject({
        shiftId: "shift-20261015-090000-f1a1",
        complete: true,
        beads: [],
        reservations: [],
      });
      expect(
        readShiftRecord(join(h.home, SHIFTS_DIR), "shift-20261015-090000-f1a1"),
      ).toMatchObject({ state: "stopped", reason: "recovered" });
    },
  },
  "POST /beads": {
    valid: {
      path: "/beads",
      body: { title: "Fixture bead", parent: "demo-epic" },
      status: 201,
      // The new id does not exist when the audit row is written: it names the parent.
      target: "demo-epic",
    },
    invalid: { path: "/beads", body: { title: "" } },
    outcome: [
      {
        kind: "bead.transitioned",
        payload: {
          action: "create",
          hash: hashText("Fixture bead"),
          length: 12,
        },
      },
    ],
    // One call, as an argument array: the type and priority defaulted, never `--repo`.
    happened: async (h) => {
      expect(h.bd.calls.at(-1)).toEqual([
        "create",
        "--title=Fixture bead",
        "--type=task",
        "--priority=2",
        "--parent=demo-epic",
        "--json",
      ]);
    },
  },
  "POST /projects/:id/beads": projectBeadFixture("create"),
  "POST /projects/:id/beads/:beadId/claim": projectBeadFixture("claim"),
  "POST /projects/:id/beads/:beadId/comment": projectBeadFixture("comment"),
  "POST /projects/:id/beads/:beadId/close": projectBeadFixture("close"),
  "POST /projects/:id/beads/:beadId/propose": projectBeadFixture("propose"),
  "POST /projects/:id/beads/:beadId/approve": projectQueueFixture("approve"),
  "POST /projects/:id/beads/:beadId/queue": projectQueueFixture("queue"),
  "POST /projects/:id/beads/:beadId/pause": projectQueueFixture("pause"),
  "POST /projects/:id/beads/:beadId/resume": projectQueueFixture("resume"),
  "POST /projects/:id/beads/:beadId/reassign": projectQueueFixture("reassign"),
  "POST /beads/:id/claim": {
    valid: {
      path: "/beads/demo-task/claim",
      body: {},
      status: 200,
      target: "demo-task",
    },
    // An id that would be read as an option if it ever reached bd.
    invalid: { path: "/beads/-rf/claim", body: {} },
    outcome: [{ kind: "bead.transitioned", payload: { action: "claim" } }],
    happened: async (h) => {
      expect(h.bd.calls.at(-1)).toEqual([
        "update",
        "--claim",
        "--json",
        "--",
        "demo-task",
      ]);
    },
  },
  "POST /beads/:id/comment": {
    valid: {
      path: "/beads/demo-task/comment",
      body: { text: COMMENT },
      status: 201,
      target: "demo-task",
    },
    invalid: { path: "/beads/demo-task/comment", body: { text: "  " } },
    outcome: [
      {
        kind: "bead.transitioned",
        payload: {
          action: "comment",
          hash: hashText(COMMENT),
          length: COMMENT.length,
        },
      },
    ],
    happened: async (h) => {
      expect(h.bd.calls.at(-1)).toEqual([
        "comments",
        "add",
        "--json",
        "--",
        "demo-task",
        COMMENT,
      ]);
    },
  },
  "POST /beads/:id/close": {
    valid: {
      path: "/beads/demo-task/close",
      body: { reason: CLOSE_REASON },
      status: 200,
      target: "demo-task",
    },
    invalid: { path: "/beads/demo-task/close", body: {} },
    outcome: [
      {
        kind: "bead.transitioned",
        payload: {
          action: "close",
          hash: hashText(CLOSE_REASON),
          length: CLOSE_REASON.length,
        },
      },
    ],
    happened: async (h) => {
      expect(h.bd.calls.at(-1)).toEqual([
        "close",
        `--reason=${CLOSE_REASON}`,
        "--json",
        "--",
        "demo-task",
      ]);
    },
  },
  "POST /council/runs": {
    valid: {
      path: "/council/runs",
      body: text("fixture-a"),
      status: 202,
      target: "fixture-a",
    },
    invalid: {
      path: "/council/runs",
      body: { sourceType: "nope", source: "x" },
    },
    happened: started("fixture-a"),
  },
  "POST /council/preview": {
    valid: {
      path: "/council/preview",
      body: { sourceType: "bead", source: "demo-preview" },
      status: 200,
      target: "demo-preview",
    },
    invalid: {
      path: "/council/preview",
      body: { sourceType: "bead", source: "not a bead id" },
    },
    prepare: async (h) => {
      h.commands.answer = beadReads("demo-preview");
      previewRunsBefore = await runIds(h);
    },
    // It reads and lists; it starts nothing, so it records nothing more.
    happened: async (h, data) => {
      const preview = data as CouncilPreview;
      expect(preview.source.locator).toBe("demo-preview");
      expect(preview.listing[0]).toStartWith("E1 acceptance criteria: ");
      expect(
        h.commands.calls.map(({ command }) => command.slice(0, 3).join(" ")),
      ).toEqual(["bd --readonly show", "bd --readonly comments"]);
      expect(await runIds(h)).toEqual(previewRunsBefore);
    },
  },
  "POST /council/runs/:id/cancel": {
    prepare: (h) => runningRun(h, "to-cancel-a"),
    happened: cancelled("to-cancel-a"),
    valid: {
      path: "/council/runs/to-cancel-a/cancel",
      body: {},
      status: 200,
      target: "to-cancel-a",
    },
    invalid: { path: "/council/runs/con/cancel", body: {} },
  },
  "POST /council-api/runs": {
    valid: {
      path: "/council-api/runs",
      body: text("fixture-b"),
      status: 202,
      target: "fixture-b",
    },
    invalid: { path: "/council-api/runs", body: { sourceType: "text" } },
    happened: started("fixture-b"),
  },
  "POST /council-api/runs/:id/cancel": {
    prepare: (h) => runningRun(h, "to-cancel-b"),
    happened: cancelled("to-cancel-b"),
    valid: {
      path: "/council-api/runs/to-cancel-b/cancel",
      body: {},
      status: 200,
      target: "to-cancel-b",
    },
    invalid: { path: "/council-api/runs/trailing./cancel", body: {} },
  },
  "POST /dev-api/forge-run/review": {
    valid: {
      path: "/dev-api/forge-run/review",
      body: REVIEW,
      status: 200,
      target: "demo-1",
    },
    invalid: {
      path: "/dev-api/forge-run/review",
      body: { issueId: "../x", decision: "approve" },
    },
    // The review reached Beads through the hearth's own runner: the status
    // check, then the comment, each as an argument array.
    happened: async (h) => {
      expect(h.bd.calls.slice(-2)).toEqual([
        ["show", "demo-1", "--json"],
        [
          "comments",
          "add",
          "demo-1",
          "review: checkpoint APPROVED via Forge run dashboard",
        ],
      ]);
    },
  },
};

/** A concrete path per read row; a row with none fails the suite. */
const READS: Record<string, string> = {
  "GET /projects/:id/session-start-identities": `/projects/${FIXTURE_PROJECT_ID}/session-start-identities`,
  "GET /projects/:id/codex-chat-forks/:requestId": `/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${API_CODEX_CHAT_FORK_ID}`,
  "GET /projects/:id/codex-chat-forks/:requestId/context": `/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${API_CODEX_CHAT_FORK_CHILD_REQUEST_ID}/context`,
  "GET /projects/:id/session-operation-identities": `/projects/${FIXTURE_PROJECT_ID}/session-operation-identities`,
  "GET /projects/:id/runs": `/projects/${FIXTURE_PROJECT_ID}/runs`,
  "GET /projects/:id/runs/:slug": `/projects/${FIXTURE_PROJECT_ID}/runs/demo`,
  "GET /projects/:id/shifts": `/projects/${FIXTURE_PROJECT_ID}/shifts`,
  "GET /projects/:id/shifts/requests/:requestId": `/projects/${FIXTURE_PROJECT_ID}/shifts/requests/${FIXTURE_SHIFT_START.requestId}`,
  "GET /projects/:id/shifts/requests/:requestId/attempts": `/projects/${FIXTURE_PROJECT_ID}/shifts/requests/${FIXTURE_SHIFT_START.requestId}/attempts`,
  "GET /projects/:id/shifts/requests/:requestId/attempts/:sessionId": `/projects/${FIXTURE_PROJECT_ID}/shifts/requests/${FIXTURE_SHIFT_START.requestId}/attempts/${FIXTURE_SHIFT_ATTEMPT_SESSION_ID}`,
  "GET /providers/sign-in": "/providers/sign-in",
  "GET /providers/:provider/sign-in/:requestId":
    "/providers/claude/sign-in/7b5b2b32-4bcc-4a1c-92c8-61dd39234d82",
  "GET /providers/readiness": "/providers/readiness",
  "GET /projects/:id/beads": `/projects/${FIXTURE_PROJECT_ID}/beads`,
  "GET /projects/:id/workbench": `/projects/${FIXTURE_PROJECT_ID}/workbench`,
  "GET /projects/:id/shifts/options": `/projects/${FIXTURE_PROJECT_ID}/shifts/options`,
  "GET /projects/:id/keeper/proposals/:proposalId/session-start": `/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${FIXTURE_KEEPER_SESSION_HISTORY}/session-start`,
  "GET /projects/:id/keeper/proposals/:proposalId/shift-start/:requestId": `/projects/${FIXTURE_PROJECT_ID}/keeper/proposals/${FIXTURE_KEEPER_SHIFT_HISTORY}/shift-start/${FIXTURE_KEEPER_SHIFT_HISTORY_REQUEST}`,
  "GET /projects/:id/session-worktrees/:requestId": `/projects/${FIXTURE_PROJECT_ID}/session-worktrees/${FIXTURE_WORKTREE_REQUEST}`,
  "GET /projects/:id/sessions": `/projects/${FIXTURE_PROJECT_ID}/sessions`,
  "GET /projects/:id/session-observations": `/projects/${FIXTURE_PROJECT_ID}/session-observations`,
  "GET /projects/:id/session-observations/:sessionId": `/projects/${FIXTURE_PROJECT_ID}/session-observations/${FIXTURE_OWNED_SESSION_ID}`,
  "GET /projects/:id/activity": `/projects/${FIXTURE_PROJECT_ID}/activity`,
  "GET /projects/:id/activity/:eventId": `/projects/${FIXTURE_PROJECT_ID}/activity/1`,
  "GET /projects/:id/sessions/:sessionId": `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_OWNED_SESSION_ID}`,
  "GET /projects/:id/sessions/:sessionId/fork-turns": `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_CHILD_ID}/fork-turns`,
  "GET /projects/:id/sessions/:sessionId/fork-review": `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_SOURCE.sessionId}/fork-review?throughTurnRequestId=${API_CODEX_CHAT_FORK_SOURCE.turnRequestId}`,
  "GET /projects/:id/sessions/:sessionId/fork-approvals": `/projects/${FIXTURE_PROJECT_ID}/sessions/${API_CODEX_CHAT_FORK_CONTROL_CHILD_ID}/fork-approvals`,
  "GET /projects/:id/sessions/:sessionId/approvals": `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_CHAT_SESSION}/approvals`,
  "GET /projects/:id/session-library": `/projects/${FIXTURE_PROJECT_ID}/session-library`,
  "GET /projects/:id/sessions/:sessionId/archive": `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_OWNED_SESSION_ID}/archive`,
  "GET /projects/:id/sessions/:sessionId/export": `/projects/${FIXTURE_PROJECT_ID}/sessions/${FIXTURE_OWNED_SESSION_ID}/export`,
  "GET /projects": "/projects",
  "GET /projects/summary": "/projects/summary",
  "GET /projects/:id/overview":
    "/projects/project-a5832fa0-7a21-403b-8184-44892f0d8d86/overview",
  "GET /projects/:id/keeper": `/projects/${FIXTURE_PROJECT_ID}/keeper`,
  "GET /projects/:id/keeper/briefs": `/projects/${FIXTURE_PROJECT_ID}/keeper/briefs`,
  "GET /projects/:id/keeper/recovery": `/projects/${FIXTURE_PROJECT_ID}/keeper/recovery`,
  "GET /projects/:id/keeper/proposals": `/projects/${FIXTURE_PROJECT_ID}/keeper/proposals`,
  "GET /projects/:id/keeper/read": `/projects/${FIXTURE_PROJECT_ID}/keeper/read?kind=beads`,
  "GET /sessions": "/sessions",
  "GET /runs": "/runs",
  "GET /runs/:slug": "/runs/demo",
  "GET /events": "/events",
  "GET /queue": "/queue",
  "GET /reservations": "/reservations",
  "GET /worktrees": "/worktrees",
  "GET /eligibility": "/eligibility",
  "GET /smiths": "/smiths",
  "GET /smiths/verification": "/smiths/verification",
  "GET /smiths/creates": "/smiths/creates",
  "GET /smiths/creates/:requestId": `/smiths/creates/${API_SMITH_CREATE_ID}`,
  "GET /smiths/edits/:requestId": `/smiths/edits/${API_SMITH_EDIT_ID}`,
  "GET /smiths/routing-edits/:requestId": `/smiths/routing-edits/${API_SMITH_ROUTING_EDIT_ORIGINAL_ID}`,
  "GET /config": "/config",
  "GET /beads/options": "/beads/options",
  "GET /beads/counts": "/beads/counts",
  "GET /scoreboard": "/scoreboard",
  "GET /shifts": "/shifts",
};

async function seedForkReadOriginal(h: TestHearth): Promise<void> {
  const journal = createCodexChatForkJournal({ root: h.root, home: h.home });
  const original = await journal.reserve(
    FIXTURE_PROJECT_ID,
    FIXTURE_CHAT_SESSION,
    {
      requestId: API_CODEX_CHAT_FORK_ID,
      throughTurnRequestId: FIXTURE_CHAT_DECISION.turnRequestId,
    },
    {
      parentRequestHash: "a".repeat(64),
      parentTurnHash: "b".repeat(64),
      parentNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      throughNativeTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
      sourceSettingsHash: "c".repeat(64),
    },
  );
  expect({ state: original.state, requestId: original.requestId }).toEqual({
    state: "reserved",
    requestId: API_CODEX_CHAT_FORK_ID,
  });
}

/** The source-review read row addresses this exact completed parent/turn pair. */
async function seedForkReadSourceReview(h: TestHearth): Promise<void> {
  await seedForkableCodexChatSource(h, API_CODEX_CHAT_FORK_SOURCE);
}

/** A bounded linked child transcript fixture for the protected child-only read row. */
const seededForkReadChildren = new WeakSet<TestHearth>();

async function seedForkReadChild(h: TestHearth): Promise<void> {
  if (seededForkReadChildren.has(h)) return;
  const source = await seedForkableCodexChatSource(
      h,
      API_CODEX_CHAT_FORK_CONTROL_SOURCE,
    ),
    registry = createSessionRegistry(h.home, "codex", "chat"),
    parent = registry.read(source.projectId, source.parentSessionId),
    parentState = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: source.projectId,
      sessionId: source.parentSessionId,
    }).read(source.projectId),
    selected = parentState.turns.find(
      (turn) => turn.requestId === source.throughTurnRequestId,
    );
  if (!selected || parentState.binding?.provider !== "codex")
    throw new Error(
      "Missing source-valid parent for the Fork-child read fixture",
    );
  const sourceSeal: CodexChatForkSourceSeal = {
      parentRequestHash: parent.requestHash,
      parentTurnHash: selected.hash,
      parentNativeThreadId: parentState.binding.sessionId,
      throughNativeTurnId: API_CODEX_CHAT_FORK_CONTROL_SOURCE.turnId,
      sourceSettingsHash: "c".repeat(64),
    },
    journal = createCodexChatForkJournal({
      root: h.root,
      home: h.home,
      createChildAppSessionId: () => API_CODEX_CHAT_FORK_CONTROL_CHILD_ID,
    }),
    reserved = await journal.reserve(
      source.projectId,
      source.parentSessionId,
      {
        requestId: API_CODEX_CHAT_FORK_CONTROL_CHILD_REQUEST_ID,
        throughTurnRequestId: source.throughTurnRequestId,
      },
      sourceSeal,
      "direct-v1",
    ),
    reservedRef = {
      projectId: reserved.projectId,
      workspaceKey: reserved.workspaceKey,
      requestId: reserved.requestId,
      requestHash: reserved.requestHash,
      parentSessionId: reserved.parentSessionId,
      throughTurnRequestId: reserved.throughTurnRequestId,
      protocolVersion: reserved.protocolVersion,
      childAppSessionId: reserved.childAppSessionId,
      reservationKind: reserved.reservationKind,
      sourceSeal: reserved.sourceSeal,
    },
    attempt = await journal.markAttempted(reservedRef);
  if (attempt.record.state !== "attempted" || !attempt.mayDispatch)
    throw new Error("Could not seed a new Fork-child read original");
  const capture: CodexChatForkCapture = {
      parentNativeThreadId: sourceSeal.parentNativeThreadId,
      childNativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a75",
      throughNativeTurnId: sourceSeal.throughNativeTurnId,
      protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
    },
    captured = await journal.capture(reservedRef, capture);
  if (captured.state !== "captured")
    throw new Error("Could not seed a captured Fork-child read original");
  const origin = {
      kind: "codex-chat-fork" as const,
      projectId: source.projectId,
      parentSessionId: source.parentSessionId,
      throughTurnRequestId: source.throughTurnRequestId,
      parentTurnHash: selected.hash,
      parentNativeThreadId: capture.parentNativeThreadId,
      throughNativeTurnId: capture.throughNativeTurnId,
      childNativeThreadId: capture.childNativeThreadId,
      captureHash: codexChatForkCaptureHash(capture),
      protocolVersion: CODEX_CHAT_FORK_PROTOCOL_VERSION,
    },
    child: CodexChatOwnedRecord = {
      ...parent,
      id: captured.childAppSessionId,
      requestId: captured.requestId,
      requestHash: captured.requestHash,
      createdAt: captured.createdAt,
      origin,
    },
    childStore = createConversationStore(h.home, undefined, {
      kind: "session",
      projectId: source.projectId,
      sessionId: child.id,
    });
  await registry.adoptForkChild(child, parent, captured, async () => {
    await childStore.bootstrapCodexForkChild(
      source.projectId,
      capture.childNativeThreadId,
      capture.protocolVersion,
    );
  });
  const linked = await journal.markLinked(reservedRef, {
    childAppSessionId: child.id,
    childRequestId: child.requestId,
    childRequestHash: child.requestHash,
    captureHash: origin.captureHash,
  });
  if (linked.state !== "linked")
    throw new Error("Could not seed the linked Fork-child read original");
  seededForkReadChildren.add(h);
}

function fixture(route: ApiRoute): ActionFixture {
  const found = ACTIONS[key(route)];
  if (!found) throw new Error(`no fixture for action row ${key(route)}`);
  return found;
}

interface Probe {
  row: string;
  /** What the validator handed the effect. */
  input: unknown;
  /** The audit rows in the ledger at the moment the effect was called. */
  audit: LedgerEventOf<"operator.action">[];
}

/** A hearth whose every action row reports when its effect is called, and what the ledger held then. */
async function probed(
  options: TestHearthOptions = {},
): Promise<{ h: TestHearth; probes: Probe[] }> {
  const probes: Probe[] = [];
  let h: TestHearth | undefined;
  const audit = (): LedgerEventOf<"operator.action">[] =>
    (h?.events(["operator.action"]) ?? []).filter(
      (event): event is LedgerEventOf<"operator.action"> =>
        event.kind === "operator.action",
    );
  h = await start({
    ...options,
    api: {
      ...options.api,
      git: options.api?.git ?? fixtureSessionGit,
      decorate: (routes) =>
        routes.map((route) =>
          route.kind !== "action"
            ? route
            : {
                ...route,
                effect: (input: unknown, context?: ActionContext) => {
                  probes.push({ row: key(route), input, audit: audit() });
                  return route.effect(input, context);
                },
              },
        ),
    },
  });
  return { h, probes };
}

function snapshot(h: TestHearth): number[] {
  return h.events().map((event) => event.id);
}

function activityReadMembership(h: TestHearth): void {
  const previous = h.bd.answer;
  h.bd.answer = (args) =>
    previous?.(args) ??
    (args[0] === "export"
      ? {
          status: 0,
          stdout: JSON.stringify({
            id: "alpha-epic",
            title: "Activity fixture",
            status: "open",
            issue_type: "epic",
            labels: ["project:alpha"],
          }),
          stderr: "",
        }
      : undefined);
}

/** A real metadata row for the selected-event read, never synthesized by the handler. */
function seedActivityReadFixture(h: TestHearth): LedgerEvent[] {
  activityReadMembership(h);
  expect(
    h.append({
      kind: "tool.called",
      sessionId: FIXTURE_OWNED_SESSION_ID,
      payload: { tool: "Read", argsHash: "fixture-activity-hash" },
    }),
  ).toBe(1);
  return h.events();
}

describe("the operator API on a hearth", () => {
  test("GET /runs answers the envelope with the runs of the hearth's root", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    const response = await fetch(`${h.api}/runs`, { headers: h.headers() });
    expect(response.status).toBe(200);
    const body = await envelope<Array<{ slug: string }>>(response);
    expect(body.ok).toBe(true);
    expect(body.data?.map((run) => run.slug)).toEqual(["demo"]);
  });

  test("GET /worktrees answers every worktree git lists for the hearth's root, and is not a stream collection", async () => {
    let root = "";
    const git: GitRun = (args) => {
      const top = root.replaceAll("\\", "/");
      if (args[0] === "rev-parse")
        return { status: 0, stdout: `${top}\n`, stderr: "" };
      if (args[0] === "worktree")
        return {
          status: 0,
          stdout: [
            `worktree ${top}`,
            "HEAD aaa",
            "branch refs/heads/master",
            "",
            `worktree ${top}/.claude/worktrees/app`,
            "HEAD bbb",
            "branch refs/heads/claude/app",
            "",
            "",
          ].join("\0"),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "" };
    };
    const h = await start({ api: { git } });
    root = h.root;
    const response = await fetch(`${h.api}/worktrees`, {
      headers: h.headers(),
    });
    expect(response.status).toBe(200);
    const body = await envelope<WorktreeEntry[]>(response);
    expect(body.data?.map((entry) => [entry.kind, entry.branch])).toEqual([
      ["main", "master"],
      ["claude", "claude/app"],
    ]);
    const row = h.hearth.routes.find(
      (route) => key(route) === "GET /worktrees",
    );
    expect(
      row?.kind === "read" ? row.collection : "not a read",
    ).toBeUndefined();
  });

  test("GET /worktrees answers 502 when git cannot list them", async () => {
    const hung: GitRun = () => ({ status: null, stdout: "", stderr: "" });
    const h = await start({ api: { git: hung } });
    const response = await fetch(`${h.api}/worktrees`, {
      headers: h.headers(),
    });
    expect(response.status).toBe(502);
    expect((await envelope(response)).ok).toBe(false);
  });
});

describe("the route table", () => {
  test("every row has a fixture here, and every fixture a row", async () => {
    const h = await start();
    const rows = h.hearth.routes;
    expect(
      rows
        .filter((route) => route.kind === "action")
        .map(key)
        .sort(),
    ).toEqual(Object.keys(ACTIONS).sort());
    expect(
      rows
        .filter((route) => route.kind === "read")
        .map(key)
        .sort(),
    ).toEqual(Object.keys(READS).sort());
    // One ledger feed and a separate private conversation body feed.
    expect(rows.filter((route) => route.kind === "stream").map(key)).toEqual([
      "GET /stream",
      "GET /projects/:id/keeper/events",
      "GET /projects/:id/sessions/:sessionId/events",
      "GET /projects/:id/shifts/requests/:requestId/attempts/:sessionId/events",
    ]);
    expect(rows.length).toBe(
      Object.keys(ACTIONS).length + Object.keys(READS).length + 4,
    );
  });
});

describe("every action row (iterating the table)", () => {
  test("with the token, from the hearth's own origin: one operator.action is appended, then the effect runs", async () => {
    const { h, probes } = await probed();
    const rows = actionRows(h);
    let progress: { row: number; action: string; stage: string } = {
      row: 0,
      action: "setup",
      stage: "start",
    };
    const diagnostic = setTimeout(() => {
      console.error(
        `[api-action-inventory] ${JSON.stringify({ event: "slow", ...progress })}`,
      );
    }, 10_000);
    try {
      for (const [index, row] of rows.entries()) {
        progress = { row: index + 1, action: row.action, stage: "prepare" };
        const {
          valid,
          prepare,
          happened,
          outcome = [],
          effects = [],
          settled,
        } = fixture(row);
        await prepare?.(h);
        const before = snapshot(h);
        const seen = probes.length;

        progress.stage = "post";
        const response = await post(h, valid.path, valid.body);
        progress.stage = "read-response";
        const body = await envelope(response);
        expect({
          row: key(row),
          status: response.status,
          ok: body.ok,
          error: body.error,
        }).toEqual({
          row: key(row),
          status: valid.status,
          ok: valid.ok ?? true,
          error: valid.error ?? null,
        });
        progress.stage = "settled";
        await settled?.(h);

        // This row's audit row first, then exactly the events its fixture says
        // a successful effect leaves: for most rows, none.
        const added = h.events().filter((event) => !before.includes(event.id));
        expect(
          added.map((event) => ({
            row: key(row),
            kind: event.kind,
            payload: event.payload,
          })),
        ).toEqual([
          {
            row: key(row),
            kind: "operator.action",
            payload: {
              action: row.action,
              surface: "api",
              ...(valid.target === undefined ? {} : { target: valid.target }),
              ...valid.audit,
            },
          },
          ...(typeof outcome === "function" ? outcome(h) : outcome).map(
            (event) => ({ row: key(row), ...event }),
          ),
        ]);

        // The effect ran once, and that row was already stored when it started.
        const calls = probes.slice(seen);
        expect(calls.map((call) => call.row)).toEqual([key(row), ...effects]);
        expect(calls[0]?.audit.at(-1)?.id).toBe(added[0]?.id);

        progress.stage = "happened";
        await happened(h, body.data);
        if (row.action === "council.run.start" && valid.target !== undefined) {
          progress.stage = "council-run-finished";
          await councilRunFinished(h, valid.target);
        }
      }
    } finally {
      clearTimeout(diagnostic);
    }
  }, 30_000);

  test("without the token, or with a wrong one: 403, nothing appended, the effect not called", async () => {
    const { h, probes } = await probed();
    const token = h.hearth.token;
    const wrong: Array<[string, string | null]> = [
      ["no header", null],
      ["an empty value", ""],
      ["another token of the same length", "0".repeat(token.length)],
      ["a prefix", token.slice(0, -1)],
      ["a longer value", `${token}0`],
      ["the token in upper case", token.toUpperCase()],
      // Whitespace around a header value is not part of it (HTTP strips it in
      // transit), so that case belongs to tokenMatches' own test, not here.
      ["the token as a bearer value", `Bearer ${token}`],
      [
        "the token twice in one line, as fetch folds a repeat",
        `${token}, ${token}`,
      ],
      ["a wrong value folded before the token", `wrong, ${token}`],
    ];
    for (const row of actionRows(h)) {
      const { valid } = fixture(row);
      for (const [label, value] of wrong) {
        const before = snapshot(h);
        const response = await post(h, valid.path, valid.body, {
          ...h.headers(),
          ...(value === null ? {} : { [OPERATOR_HEADER]: value }),
        });
        const body = await envelope(response);
        expect({
          row: key(row),
          label,
          status: response.status,
          ok: body.ok,
          added: snapshot(h).length - before.length,
        }).toEqual({ row: key(row), label, status: 403, ok: false, added: 0 });
      }
    }
    expect(probes).toEqual([]);
  });

  test("with the token but not from the hearth's own origin: 403, nothing appended, the effect not called", async () => {
    const { h, probes } = await probed();
    const token = { [OPERATOR_HEADER]: h.hearth.token };
    const json = { "Content-Type": "application/json" };
    const origins: Array<[string, Record<string, string>]> = [
      ["no declaration at all", {}],
      ["a foreign Origin", { Origin: "https://evil.example" }],
      ["another loopback port as Origin", { Origin: "http://127.0.0.1:1" }],
      ["Sec-Fetch-Site: same-site", { "Sec-Fetch-Site": "same-site" }],
      ["Sec-Fetch-Site: cross-site", { "Sec-Fetch-Site": "cross-site" }],
      ["Sec-Fetch-Site: none", { "Sec-Fetch-Site": "none" }],
      ["a non-loopback Host", { Origin: h.hearth.url, Host: "evil.example" }],
    ];
    for (const row of actionRows(h)) {
      const { valid } = fixture(row);
      for (const [label, declared] of origins) {
        const before = snapshot(h);
        const response = await post(h, valid.path, valid.body, {
          ...json,
          ...token,
          ...declared,
        });
        const body = await envelope(response);
        expect({
          row: key(row),
          label,
          status: response.status,
          ok: body.ok,
          added: snapshot(h).length - before.length,
        }).toEqual({ row: key(row), label, status: 403, ok: false, added: 0 });
      }
    }
    expect(probes).toEqual([]);
  });

  test("a request the row's validator refuses: 400, nothing appended, the effect not called", async () => {
    const { h, probes } = await probed();
    for (const row of actionRows(h)) {
      const { invalid, valid } = fixture(row);
      const cases: Array<[string, string, unknown, Record<string, string>]> = [
        ["the row's invalid fixture", invalid.path, invalid.body, {}],
        ["malformed JSON", valid.path, "{broken", {}],
        [
          "not JSON at all",
          valid.path,
          valid.body,
          { "Content-Type": "text/plain" },
        ],
        [
          "an undeclared surface",
          valid.path,
          valid.body,
          { [SURFACE_HEADER]: "robot" },
        ],
      ];
      for (const [label, path, body, extra] of cases) {
        const before = snapshot(h);
        const response = await post(h, path, body, {
          ...h.headers(h.hearth.token),
          ...extra,
        });
        const answer = await envelope(response);
        expect({
          row: key(row),
          label,
          status: response.status,
          ok: answer.ok,
          added: snapshot(h).length - before.length,
        }).toEqual({ row: key(row), label, status: 400, ok: false, added: 0 });
      }
    }
    expect(probes).toEqual([]);
    // The wording the dashboard already shows for a broken body is kept.
    const broken = await post(h, "/council-api/runs", "{broken");
    expect((await envelope(broken)).error).toContain("valid JSON");
  });

  test("a declared surface is stored on the audit row", async () => {
    const { h } = await probed();
    for (const surface of ["ui", "cli", "mcp", "api"]) {
      const response = await post(h, "/dev-api/forge-run/review", REVIEW, {
        ...h.headers(h.hearth.token),
        [SURFACE_HEADER]: surface,
      });
      expect(response.status).toBe(200);
      expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
        surface,
      });
    }
  });

  const refusals: Array<[string, () => AppendResult]> = [
    ["refuses", () => ({ ok: false, error: "the ledger is read-only" })],
    ["reports a duplicate", () => ({ ok: true, duplicate: true, ulid: "x" })],
    [
      "answers ok with no row id",
      // justification: a result the ledger's type does not allow; the runner must not trust the shape.
      () => ({ ok: true, id: undefined, ulid: "x" }) as unknown as AppendResult,
    ],
    [
      "answers ok as a word, not as true",
      // justification: as above.
      () => ({ ok: "true", id: 1, ulid: "x" }) as unknown as AppendResult,
    ],
    [
      "answers ok with an id that is no row id",
      () => ({ ok: true, id: Number.NaN, ulid: "x" }),
    ],
    ["answers ok with a negative id", () => ({ ok: true, id: -1, ulid: "x" })],
    [
      "answers nothing at all",
      // justification: as above — a broken appender, not a typed one.
      () => null as unknown as AppendResult,
    ],
    [
      "throws",
      () => {
        throw new Error("ledger offline");
      },
    ],
  ];
  for (const [label, appendEvent] of refusals) {
    test(`when the audit append ${label}: 503 and the effect is not called`, async () => {
      const { h, probes } = await probed({ api: { appendEvent } });
      for (const row of actionRows(h)) {
        const { valid, prepare } = fixture(row);
        if (row.action === "session.preview") {
          // This builder uses only the current hearth's fixed workspace value;
          // it needs neither an audited preview nor any provider/filesystem work.
          valid.body = sessionStartFixture(h);
        } else if (row.action === "smith.config.create") {
          // This action only needs a schema-valid revision to reach the audit
          // boundary. Do not depend on the aggregate success loop's preview,
          // which is intentionally unavailable when the audit appender refuses.
          valid.body = {
            requestId: API_SMITH_CREATE_ID,
            target: "workspace",
            smith: API_SMITH_CREATE_SMITH,
            expectedRevision: {
              version: 1,
              user: "a".repeat(64),
              workspace: "b".repeat(64),
            },
          };
        } else if (row.path.includes("/keeper/proposals/")) {
          // Keeper proposal validation reads the durable source and revision
          // before reaching the audit boundary, so seed that inert fixture.
          await prepare?.(h);
        }
        const response = await post(h, valid.path, valid.body);
        const body = await envelope(response);
        expect({ row: key(row), status: response.status, ok: body.ok }).toEqual(
          {
            row: key(row),
            status: 503,
            ok: false,
          },
        );
        expect(body.error).toContain("nothing was done");
      }
      expect(probes).toEqual([]);
      // Nothing reached the real effects either: no run or shift was started, bd was not called.
      const runs = await readRuns(h);
      expect((await envelope<unknown[]>(runs)).data).toEqual([]);
      expect(h.bd.calls).toEqual([]);
      expect(h.shifts.launches).toEqual([]);
    });
  }

  test("a busy ledger is retried before the action is refused", async () => {
    let calls = 0;
    const { h, probes } = await probed({
      api: {
        appendEvent: () => {
          calls++;
          return calls < 3
            ? { ok: false, error: "database is locked" }
            : { ok: true, id: 7, ulid: "01J" };
        },
      },
    });
    const response = await post(h, "/dev-api/forge-run/review", REVIEW);
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(probes.length).toBe(1);

    calls = -100;
    const refused = await post(h, "/dev-api/forge-run/review", REVIEW);
    expect(refused.status).toBe(503);
    expect(calls).toBe(-97);
    expect(probes.length).toBe(1);
  });
});

/**
 * How long a locked ledger may hold the hearth: loose enough for a loaded
 * machine (de16: a 1.5 s bound on each answer failed under parallel load),
 * well under what a hearth that waits on the lock takes. Without its zero
 * first-open wait (`LEDGER_FIRST_OPEN_WAIT_MS`) an action took 12 to 20 s, and
 * a read row 3 to 6 s; the read limit is for each row that reads the ledger,
 * summed over the whole matrix.
 */
const ACTION_LOCKED_LIMIT_MS = 6_000;
const READ_LOCKED_LIMIT_MS = 1_500;

/** Hold the write lock on `file` from another connection until `release` is called. */
function holdWriteLock(file: string): { release(): void } {
  const holder = new Database(file, { create: true });
  holder.exec("BEGIN EXCLUSIVE");
  return {
    release() {
      holder.exec("ROLLBACK");
      holder.close();
    },
  };
}

describe("an action while another connection holds the write lock on the hearth's ledger file", () => {
  /**
   * Both answers must arrive before the caller releases the write lock, and
   * within `ACTION_LOCKED_LIMIT_MS`.
   */
  async function actionAndGetWhileLocked(h: TestHearth): Promise<void> {
    const sent = performance.now();
    const [response, health] = await Promise.all([
      post(h, "/dev-api/forge-run/review", REVIEW),
      fetch(`${h.hearth.url}${HEALTH_ROUTE}`),
    ]);
    expect(performance.now() - sent).toBeLessThan(ACTION_LOCKED_LIMIT_MS);
    expect(response.status).toBe(503);
    const body = await envelope(response);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("locked");
    expect(health.status).toBe(200);
    await health.body?.cancel();
  }

  test("on a new ledger file the hearth has not opened: refuses the action and answers health while locked; released, the action succeeds", async () => {
    const { h, probes } = await probed();
    // Nothing has opened the hearth's ledger: the file does not exist yet.
    expect(existsSync(h.ledger)).toBe(false);
    const lock = holdWriteLock(h.ledger);
    try {
      await actionAndGetWhileLocked(h);
      expect(probes).toEqual([]);
    } finally {
      lock.release();
    }
    // Released, the same action is recorded and done.
    expect((await post(h, "/dev-api/forge-run/review", REVIEW)).status).toBe(
      200,
    );
    expect(probes.length).toBe(1);
  }, 60_000);

  test("on a ledger file the hearth has opened before: refuses the action and answers health while locked; released, the action succeeds", async () => {
    const { h, probes } = await probed();
    // The first action opens the ledger and records its audit row.
    expect((await post(h, "/dev-api/forge-run/review", REVIEW)).status).toBe(
      200,
    );
    expect(probes.length).toBe(1);
    const lock = holdWriteLock(h.ledger);
    try {
      await actionAndGetWhileLocked(h);
      expect(probes.length).toBe(1);
    } finally {
      lock.release();
    }
    expect((await post(h, "/dev-api/forge-run/review", REVIEW)).status).toBe(
      200,
    );
    expect(probes.length).toBe(2);
  }, 60_000);
});

describe("a read row or the stream while another connection holds the write lock on a new ledger file the hearth has not opened", () => {
  /** The rows that read the ledger, by name, and the status each answers while it cannot be opened. */
  const LEDGER_ROWS: ReadonlyArray<[string, number]> = [
    ["GET /eligibility", 502],
    ["GET /events", 500],
    ["GET /projects/:id/activity", 503],
    ["GET /projects/:id/activity/:eventId", 503],
    ["GET /projects/:id/session-observations/:sessionId", 503],
    ["GET /reservations", 500],
    ["GET /runs/:slug", 500],
    ["GET /scoreboard", 500],
    ["GET /sessions", 500],
    ["GET /stream", 503],
  ];

  /** The status and whether the answer was an `ok` envelope (including an open stream). */
  async function answered(
    response: Response,
  ): Promise<{ status: number; ok: boolean; error: string | null }> {
    if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      return { status: response.status, ok: true, error: null };
    }
    const body = await envelope(response);
    return {
      status: response.status,
      ok: body.ok,
      error:
        typeof body.error === "string"
          ? body.error.replace(/[^\x20-\x7e]/g, "?").slice(0, 160)
          : null,
    };
  }

  test("every read row and the stream answer while locked, ledger readers refuse with an error envelope, and health answers; released, every row answers 200", async () => {
    // The worktree row's git is a stand-in listing the root alone: this test
    // is about the ledger, and a real git on a loaded machine can fail it.
    const forkReadGit =
      (worktreePath: () => string): GitRun =>
      (args) => {
        const top = worktreePath().replaceAll("\\", "/");
        if (args[0] === "rev-parse")
          return { status: 0, stdout: `${top}\n`, stderr: "" };
        if (args[0] === "worktree")
          return {
            status: 0,
            stdout: [`worktree ${top}`, "HEAD aaa", "branch refs/heads/master"]
              .concat("", "")
              .join("\0"),
            stderr: "",
          };
        return { status: 1, stdout: "", stderr: "" };
      };
    // Scope validation for this read consults projectSnapshotReader, which
    // opens the Hearth ledger. Validate the child GET on a separate unlocked
    // Hearth so the locked matrix below still starts with a cold ledger.
    let baselineWorkspace = "";
    const baselineHearth = await start({
      api: { git: forkReadGit(() => baselineWorkspace) },
    });
    baselineWorkspace = baselineHearth.workspace;
    await seedForkReadChild(baselineHearth);
    const forkChildPath =
      READS["GET /projects/:id/sessions/:sessionId/fork-turns"];
    if (forkChildPath === undefined)
      throw new Error("the Fork-child read row has no fixture path");
    const baselineResponse = await get(
      baselineHearth,
      forkChildPath,
      baselineHearth.headers(baselineHearth.hearth.token),
    );
    const baselineBody = await envelope<unknown>(baselineResponse);
    const baselinePage = baselineBody.ok
      ? ownedCodingPageSchema.safeParse(baselineBody.data)
      : null;
    expect({
      status: baselineResponse.status,
      ok: baselineBody.ok,
      page: baselinePage?.success
        ? {
            projectId: baselinePage.data.projectId,
            conversationId: baselinePage.data.conversationId,
          }
        : null,
    }).toEqual({
      status: 200,
      ok: true,
      page: {
        projectId: FIXTURE_PROJECT_ID,
        conversationId: API_CODEX_CHAT_FORK_CONTROL_CHILD_ID,
      },
    });
    expect(existsSync(baselineHearth.ledger)).toBe(true);
    // The validator intentionally compares canonical workspace spellings.
    // A Git inventory recorded through a directory alias must not be confused
    // with the canonical path persisted in the owned child metadata.
    const worktreeAlias = join(baselineHearth.configHome, "root-alias");
    symlinkSync(
      baselineHearth.root,
      worktreeAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      const aliasFacade = { ...baselineHearth, root: worktreeAlias };
      expect(aliasFacade.workspace).toBe(baselineHearth.workspace);
      // The facade's root is an alias, while its workspace and the saved child
      // metadata remain canonical. The adapter reports the canonical workspace.
      baselineWorkspace = aliasFacade.workspace;
      const aliasedFacadeResponse = await get(
        baselineHearth,
        forkChildPath,
        baselineHearth.headers(baselineHearth.hearth.token),
      );
      expect(aliasedFacadeResponse.status).toBe(200);
      // An inventory that actually reports the alias remains out of registry.
      baselineWorkspace = worktreeAlias;
      const aliasResponse = await get(
        baselineHearth,
        forkChildPath,
        baselineHearth.headers(baselineHearth.hearth.token),
      );
      const aliasBody = await envelope<unknown>(aliasResponse);
      expect({
        status: aliasResponse.status,
        ok: aliasBody.ok,
        error: aliasBody.error,
      }).toEqual({
        status: 409,
        ok: false,
        error:
          "The selected worktree is not in this repository's current Git registry. No new turn was accepted.",
      });
    } finally {
      baselineWorkspace = baselineHearth.workspace;
      rmSync(worktreeAlias);
    }
    const canonicalResponse = await get(
      baselineHearth,
      forkChildPath,
      baselineHearth.headers(baselineHearth.hearth.token),
    );
    expect(canonicalResponse.status).toBe(200);

    let workspace = "";
    const git: GitRun = (args) => {
      const top = workspace.replaceAll("\\", "/");
      if (args[0] === "rev-parse")
        return { status: 0, stdout: `${top}\n`, stderr: "" };
      if (args[0] === "worktree")
        return {
          status: 0,
          stdout: [`worktree ${top}`, "HEAD aaa", "branch refs/heads/master"]
            .concat("", "")
            .join("\0"),
          stderr: "",
        };
      return { status: 1, stdout: "", stderr: "" };
    };
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
      api: { git },
    });
    workspace = h.workspace;
    await seedOwnedSession(h);
    await seedChatDecision(h);
    await seedProjectShift(h);
    await seedProjectShiftAttempt(h);
    seedProjectBeadWriteFixture(h);
    await seedKeeperSessionStartHistory(h);
    await seedKeeperShiftStartHistory(h);
    seedSmithVerificationRead(h);
    activityReadMembership(h);
    await seedSmithCreateOriginal(h);
    await seedSmithEditOriginal(h);
    await seedSmithRoutingEditOriginal(h);
    // Seed the private Fork journal without an audited HTTP action, which
    // would open the otherwise-cold ledger before this lock assertion.
    await seedForkReadChild(h);
    await seedForkReadSourceReview(h);
    await seedForkReadOriginal(h);
    const rows = h.hearth.routes.filter(
      (route) => route.kind === "read" || route.kind === "stream",
    );
    const pathOf = (row: ApiRoute): string => {
      if (row.kind === "stream")
        return row.path
          .replace(":id", FIXTURE_PROJECT_ID)
          .replace(":requestId", FIXTURE_SHIFT_START.requestId)
          .replace(
            ":sessionId",
            row.path.includes("/shifts/")
              ? FIXTURE_SHIFT_ATTEMPT_SESSION_ID
              : FIXTURE_OWNED_SESSION_ID,
          );
      const path = READS[key(row)];
      if (path === undefined)
        throw new Error(`no fixture for read row ${key(row)}`);
      return path;
    };
    if (!rows.some((row) => row.kind === "stream"))
      throw new Error("the table has no stream row");
    // Nothing has opened the hearth's ledger: the file does not exist yet.
    expect(existsSync(h.ledger)).toBe(false);

    const lock = holdWriteLock(h.ledger);
    const measured: Array<{
      row: string;
      status: number;
      ok: boolean;
      error: string | null;
    }> = [];
    try {
      const sent = performance.now();
      for (const row of rows) {
        const [response, health] = await Promise.all([
          get(
            h,
            pathOf(row),
            h.headers(row.operatorOnly ? h.hearth.token : undefined),
          ).then(answered),
          fetch(`${h.hearth.url}${HEALTH_ROUTE}`),
        ]);
        expect({ row: key(row), health: health.status }).toEqual({
          row: key(row),
          health: 200,
        });
        await health.body?.cancel();
        measured.push({ row: key(row), ...response });
      }
      expect(performance.now() - sent).toBeLessThan(
        LEDGER_ROWS.length * READ_LOCKED_LIMIT_MS,
      );
      // Check locked responses before release; an early release must not
      // turn these error envelopes into successful reads.
      expect(
        measured
          .filter((m) => m.status !== 200 || !m.ok)
          .map((m) => ({
            row: m.row,
            status: m.status,
            ok: m.ok,
            ...(m.row === "GET /projects/:id/sessions/:sessionId/fork-turns"
              ? { error: m.error }
              : {}),
          }))
          .sort((a, b) => a.row.localeCompare(b.row)),
      ).toEqual(
        LEDGER_ROWS.map(([row, status]) => ({ row, status, ok: false })),
      );
    } finally {
      lock.release();
    }

    // Released, the next read opens the file and every row answers.
    for (const row of rows) {
      // Earlier served ledger reads retain the cold-open oracle; only this
      // selected-event row needs an existing metadata fixture.
      if (key(row) === "GET /projects/:id/activity/:eventId")
        seedActivityReadFixture(h);
      const response = await answered(
        await get(
          h,
          pathOf(row),
          h.headers(row.operatorOnly ? h.hearth.token : undefined),
        ),
      );
      expect({ row: key(row), status: response.status }).toEqual({
        row: key(row),
        status: 200,
      });
    }
  }, 120_000);
});

describe("the operator token", () => {
  test("is honoured only while the token file still holds it; the token route then answers 503", async () => {
    const { h, probes } = await probed();
    const file = tokenPath(h.home, h.root);
    const minted = h.hearth.token;
    // A page's dashboard session (x1gs.3.31), planted in the store so it
    // records nothing: the token route's answers below are about the file.
    const session = createSessionStore(sessionsPath(h.home, h.root)).create();
    const cookie = `${sessionCookieName(h.home, h.root)}=${session.value}`;
    const states: Array<[string, () => void, string[]]> = [
      [
        "rewritten to another value",
        () => writeFileSync(file, "f".repeat(64)),
        [minted, "f".repeat(64)],
      ],
      ["emptied", () => writeFileSync(file, ""), [minted, ""]],
      ["deleted", () => rmSync(file, { force: true }), [minted]],
    ];
    for (const [label, change, presented] of states) {
      change();
      for (const row of actionRows(h)) {
        const { valid } = fixture(row);
        for (const value of presented) {
          const response = await post(h, valid.path, valid.body, {
            ...h.headers(),
            [OPERATOR_HEADER]: value,
          });
          expect({ row: key(row), label, status: response.status }).toEqual({
            row: key(row),
            label,
            status: 403,
          });
        }
      }
      const served = await fetch(`${h.api}/token`, {
        headers: {
          ...h.headers(),
          Cookie: cookie,
          [SESSION_KEY_HEADER]: session.key,
        },
      });
      expect({ label, status: served.status }).toEqual({ label, status: 503 });
    }
    expect(probes).toEqual([]);
    expect(h.events()).toEqual([]);

    // Put back, the minted token works again: the rule is about agreement, not history.
    writeFileSync(file, `${minted}\n`);
    expect((await post(h, "/dev-api/forge-run/review", REVIEW)).status).toBe(
      200,
    );
  });
});

/** Send a request with exactly these header lines, and read the status line and body. */
function raw(
  h: TestHearth,
  method: string,
  path: string,
  headerLines: string[],
  body = "",
): Promise<{ status: number; body: string }> {
  return rawRequest(
    h,
    [
      `${method} /__agent-forge${path} HTTP/1.1`,
      ...headerLines,
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
}

/** Send exactly these bytes, and read the status line and the body of the answer. */
function rawRequest(
  h: TestHearth,
  bytes: string,
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const socket = connect(h.hearth.port, "127.0.0.1", () => {
      socket.write(bytes);
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("error", fail);
    socket.on("close", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0);
      done({ status, body: received.slice(received.indexOf("\r\n\r\n") + 4) });
    });
  });
}

describe("repeated security headers (raw socket: fetch folds a repeat into one line)", () => {
  test("a request that sends the token, the surface, Origin, Sec-Fetch-Site or Host twice is 403 and writes nothing", async () => {
    const { h, probes } = await probed();
    const host = `Host: 127.0.0.1:${h.hearth.port}`;
    const origin = `Origin: ${h.hearth.url}`;
    const json = "Content-Type: application/json";
    const token = `X-Agent-Forge-Operator: ${h.hearth.token}`;
    const body = JSON.stringify(REVIEW);
    const path = "/dev-api/forge-run/review";

    // The same request with each header once is accepted, so the refusals below are about the repeat.
    const once = await raw(h, "POST", path, [host, origin, json, token], body);
    expect(once.status).toBe(200);
    const before = snapshot(h);
    const seen = probes.length;

    const repeats: Array<[string, string[]]> = [
      [
        "a wrong token then the right one",
        [host, origin, json, "X-Agent-Forge-Operator: wrong", token],
      ],
      [
        "the right token then a wrong one",
        [host, origin, json, token, "X-Agent-Forge-Operator: wrong"],
      ],
      [
        "the token twice in other letter case",
        [host, origin, json, token, token.replace("X-Agent", "x-agent")],
      ],
      [
        "two surfaces",
        [
          host,
          origin,
          json,
          token,
          "X-Agent-Forge-Surface: ui",
          "X-Agent-Forge-Surface: api",
        ],
      ],
      [
        "a foreign Origin then the hearth's",
        [host, "Origin: https://evil.example", origin, json, token],
      ],
      [
        "the hearth's Origin then a foreign one",
        [host, origin, "Origin: https://evil.example", json, token],
      ],
      [
        "cross-site then same-origin fetch metadata",
        [
          host,
          "Sec-Fetch-Site: cross-site",
          "Sec-Fetch-Site: same-origin",
          json,
          token,
        ],
      ],
      [
        "a foreign Host then the hearth's",
        ["Host: evil.example", host, origin, json, token],
      ],
    ];
    for (const [label, lines] of repeats) {
      const answer = await raw(h, "POST", path, lines, body);
      expect({ label, status: answer.status }).toEqual({ label, status: 403 });
      expect(validateOperatorEnvelope(JSON.parse(answer.body)).ok).toBe(true);
    }
    expect(snapshot(h)).toEqual(before);
    expect(probes.length).toBe(seen);
  });
});

describe("a stored council run of a bead", () => {
  test("is not returned to a loopback request without the operator token, with or without the hearth's own origin; with the token it is, the bead's criterion and comment included", async () => {
    const h = await start();
    // A bead run stored in the hearth's runs directory, made by the CLI with
    // an invented bead: no tracker is read, and the simulated profile calls no model.
    const bead = "demo-harness-ab12.3";
    const criterion = "[ ] The kiln reports its temperature in Celsius.";
    const comment = "worklog: the kiln sensor is wired.";
    const runner: CommandRunner = async (command) => {
      const line = command.join(" ");
      const answer = (value: unknown) => ({
        exitCode: 0,
        stdout: JSON.stringify(value),
        stderr: "",
      });
      if (line === `bd --readonly show ${bead} --json`)
        return answer([
          {
            id: bead,
            title: "Teach the kiln to report its temperature",
            acceptance_criteria: criterion,
            status: "in_progress",
            priority: 2,
            issue_type: "task",
          },
        ]);
      if (line === `bd --readonly comments ${bead} --json`)
        return answer([
          {
            issue_id: bead,
            text: comment,
            created_at: "2031-01-03T10:00:00Z",
          },
        ]);
      throw new Error(`unexpected command: ${line}`);
    };
    const code = await runCouncilCli(
      [
        "bead",
        bead,
        "--run-id",
        "stored-bead-run",
        "--runs-dir",
        join(h.root, "council-runs"),
      ],
      {
        cwd: h.root,
        readStdin: async () => "",
        stdout: () => {},
        stderr: () => {},
        runCommand: runner,
      },
    );
    expect(code).toBe(0);

    const refusal = {
      ok: false,
      data: null,
      error:
        "Reading a stored council run needs the operator token of this control plane",
    };
    for (const path of [
      "/council-api/runs",
      "/council-api/runs/stored-bead-run",
      "/council-api/runs/stored-bead-run/events",
    ])
      for (const headers of [{}, { Origin: h.hearth.url }]) {
        const response = await fetch(`${h.api}${path}`, { headers });
        const body = await response.text();
        expect({ path, headers, status: response.status }).toEqual({
          path,
          headers,
          status: 403,
        });
        expect(JSON.parse(body)).toEqual(refusal);
        expect(body).not.toContain("Celsius");
        expect(body).not.toContain("sensor is wired");
      }

    const read = await readRuns(h, "/stored-bead-run");
    expect(read.status).toBe(200);
    const text = await read.text();
    expect(text).toContain("Celsius");
    expect(text).toContain("sensor is wired");
  }, 30_000);
});

describe("the paths that existed before the table", () => {
  test("keep their answers: a service refusal is 400 after an audit row; with the operator token the list and the stream answer as before; the 405 is unchanged", async () => {
    const { h, probes } = await probed();
    await finishedRun(h, "kept");

    const duplicate = await post(h, "/council-api/runs", text("kept"));
    expect(duplicate.status).toBe(400);
    expect((await envelope(duplicate)).ok).toBe(false);

    const unknown = await post(h, "/council-api/runs/never-started/cancel", {});
    expect(unknown.status).toBe(400);
    expect((await envelope(unknown)).ok).toBe(false);

    // Both were authorised and well-formed, so both were audited and attempted.
    expect(h.events(["operator.action"]).map((event) => event.payload)).toEqual(
      [
        { action: "council.run.start", surface: "api", target: "kept" },
        { action: "council.run.start", surface: "api", target: "kept" },
        {
          action: "council.run.cancel",
          surface: "api",
          target: "never-started",
        },
      ],
    );
    expect(probes.length).toBe(3);

    const list = await readRuns(h);
    expect(list.status).toBe(200);
    expect(
      (await envelope<Array<{ runId: string }>>(list)).data?.map(
        (job) => job.runId,
      ),
    ).toEqual(["kept"]);

    const stream = await readRuns(h, "/kept/events");
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(await stream.text()).toContain('"status":"completed"');

    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await fetch(`${h.api}/dev-api/forge-run/review`, {
        method,
        headers: h.headers(h.hearth.token),
      });
      expect({ method, status: response.status }).toEqual({
        method,
        status: 405,
      });
    }
  }, 20_000);

  test("a table path asked with a method no handler serves is 405 with Allow; the section 6 actions that are not mounted are not there, and neither is a queue action the operator API does not offer", async () => {
    const { h, probes } = await probed();
    const wrongMethod = await fetch(`${h.api}/council/runs`, {
      headers: h.headers(),
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect((await envelope(wrongMethod)).ok).toBe(false);

    const posted = await post(h, "/runs", {});
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");

    // The shifts are listed and started at one path, and nothing else is served there.
    const removeShifts = await fetch(`${h.api}/shifts`, {
      method: "DELETE",
      headers: h.headers(h.hearth.token),
    });
    expect(removeShifts.status).toBe(405);
    expect(removeShifts.headers.get("allow")).toBe("GET, POST");

    const unmounted = [
      // The scheduler's moves are not the operator API's.
      "/queue/demo-1/start",
      "/queue/demo-1/submit",
      "/queue/demo-1/complete",
      "/queue/demo-1/rework",
      "/queue/demo-1/release",
      "/queue/demo-1/halt",
      "/queue/demo-1",
      "/runs/demo/replan",
    ];
    for (const path of unmounted) {
      const response = await post(h, path, {});
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect((await envelope(response)).ok).toBe(false);
    }
    expect(h.events()).toEqual([]);
    expect(probes).toEqual([]);
  });
});

describe("request bounds", () => {
  test("a body over the row's cap, and an id shaped like a secret, are 400 and write nothing", async () => {
    const { h, probes } = await probed();
    // Valid in every other respect: only its size can be the reason it is refused.
    const big = await post(h, "/dev-api/forge-run/review", {
      ...REVIEW,
      padding: "x".repeat(20_000),
    });
    expect(big.status).toBe(400);
    expect((await envelope(big)).error).toContain("exceeds");

    // The same body with no Content-Length (chunked): the cap is then found
    // while reading, and the answer must still be the 400 envelope.
    const payload = JSON.stringify({ ...REVIEW, padding: "x".repeat(20_000) });
    const chunks: string[] = [];
    for (let at = 0; at < payload.length; at += 4096) {
      const part = payload.slice(at, at + 4096);
      chunks.push(`${part.length.toString(16)}\r\n${part}\r\n`);
    }
    const chunked = await rawRequest(
      h,
      [
        "POST /__agent-forge/dev-api/forge-run/review HTTP/1.1",
        `Host: 127.0.0.1:${h.hearth.port}`,
        `Origin: ${h.hearth.url}`,
        "Content-Type: application/json",
        `X-Agent-Forge-Operator: ${h.hearth.token}`,
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        `${chunks.join("")}0\r\n\r\n`,
      ].join("\r\n"),
    );
    expect(chunked.status).toBe(400);
    expect(JSON.parse(chunked.body)).toMatchObject({
      ok: false,
      data: null,
      error: expect.stringContaining("exceeds"),
    });

    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    for (const [path, body] of [
      ["/council/runs", { ...text("ok-run"), beadId: secret }],
      ["/council/runs", text(secret)],
      ["/dev-api/forge-run/review", { ...REVIEW, issueId: secret }],
    ] as const) {
      const response = await post(h, path, body);
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
      expect(JSON.stringify(await response.json())).not.toContain(secret);
    }
    expect(h.events()).toEqual([]);
    expect(probes).toEqual([]);
  });

  test("a review note holding a NUL, or longer than the note limit, is 400: nothing is recorded and bd is not run", async () => {
    const { h, probes } = await probed();
    const NUL = String.fromCharCode(0);
    for (const note of [
      `before${NUL}after`,
      "x".repeat(REVIEW_NOTE_LIMIT + 1),
    ]) {
      const response = await post(h, "/dev-api/forge-run/review", {
        ...REVIEW,
        note,
      });
      expect(response.status).toBe(400);
      expect((await envelope(response)).ok).toBe(false);
    }
    expect(h.events()).toEqual([]);
    expect(h.bd.calls).toEqual([]);
    expect(probes).toEqual([]);
  });
});

/** What a raw client saw: the answer, and whether the hearth closed the connection. */
interface RawExchange {
  headers: string;
  /** 0 when no status line arrived. */
  status: number;
  body: string;
  /** When the status line arrived, from when the head was written; null when none did. */
  answeredMs: number | null;
  /** When the hearth closed the connection, from when the head was written; null when it was still open after `waitMs`. */
  closedMs: number | null;
}

/**
 * Write `head` (header lines, without the blank line) and then `body` over a
 * socket of its own, and read until the hearth closes the connection or
 * `waitMs` pass. The body may be less than the head declares: that request
 * then stalls.
 */
function rawExchange(
  h: TestHearth,
  head: string[],
  body: Buffer,
  waitMs: number,
): Promise<RawExchange> {
  return new Promise((done) => {
    let began = 0;
    let received = Buffer.alloc(0);
    let answeredMs: number | null = null;
    let closedMs: number | null = null;
    const socket = connect(h.hearth.port, "127.0.0.1", () => {
      began = performance.now();
      socket.write(`${head.join("\r\n")}\r\n\r\n`);
      if (body.byteLength > 0) socket.write(body);
    });
    let gaveUp = false;
    const giveUp = setTimeout(() => {
      gaveUp = true;
      socket.destroy();
    }, waitMs);
    socket.on("data", (chunk: Buffer) => {
      answeredMs ??= performance.now() - began;
      received = Buffer.concat([received, chunk]);
    });
    // Closed by the hearth: an end, or a close this client did not cause.
    const hearthClosed = (): void => {
      if (!gaveUp) closedMs ??= performance.now() - began;
    };
    socket.on("end", hearthClosed);
    // A reset while the body is still being written is an outcome, not a failure.
    socket.on("error", () => {});
    socket.on("close", () => {
      hearthClosed();
      clearTimeout(giveUp);
      const text = received.toString("utf8");
      done({
        headers: text.slice(0, text.indexOf("\r\n\r\n")),
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0),
        body: text.slice(text.indexOf("\r\n\r\n") + 4),
        answeredMs,
        closedMs,
      });
    });
  });
}

/** What a client that sends `Expect: 100-continue`, and writes its body only on `100 Continue`, was told. */
interface ExpectingExchange {
  /** The status line of each interim (1xx) answer, in order. */
  interim: string[];
  /** The final answer's status and body: 0 and "" when none came within the wait. */
  status: number;
  body: string;
  /** Whether the body was written, which this client does only after `100 Continue`. */
  bodySent: boolean;
}

/**
 * Send `head` with `Expect: 100-continue` and `Connection: close`, write
 * `body` only when the hearth answers `100 Continue`, and read up to the final
 * answer (framed by Content-Length, as the hearth frames every answer here).
 */
function expectingExchange(
  h: TestHearth,
  head: string[],
  body: Buffer,
  waitMs = 10_000,
): Promise<ExpectingExchange> {
  return new Promise((done) => {
    let received = Buffer.alloc(0);
    let bodySent = false;
    let settled = false;
    const interim: string[] = [];
    const socket = connect(h.hearth.port, "127.0.0.1", () => {
      socket.write(
        `${[...head, "Expect: 100-continue", "Connection: close"].join("\r\n")}\r\n\r\n`,
      );
    });
    const finish = (status: number, text: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(giveUp);
      socket.destroy();
      done({ interim, status, body: text, bodySent });
    };
    const giveUp = setTimeout(() => finish(0, ""), waitMs);
    socket.on("error", () => {});
    socket.on("close", () => finish(0, ""));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      for (;;) {
        const end = received.indexOf("\r\n\r\n");
        if (end === -1) return;
        const lines = received
          .subarray(0, end)
          .toString("latin1")
          .split("\r\n");
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "")?.[1]);
        if (status >= 100 && status < 200) {
          interim.push(lines[0] ?? "");
          received = received.subarray(end + 4);
          if (status === 100 && !bodySent) {
            bodySent = true;
            socket.write(body);
          }
          continue;
        }
        const declared = lines.find((line) => /^content-length:/i.test(line));
        const length = Number(declared?.slice(declared.indexOf(":") + 1) ?? 0);
        if (received.length < end + 4 + length) return;
        return finish(
          status,
          received.subarray(end + 4, end + 4 + length).toString("utf8"),
        );
      }
    });
  });
}

describe("request bodies (raw socket)", () => {
  const PATH = "/__agent-forge/dev-api/forge-run/review";
  /** Far past every row's cap, and past what was answered before when the hearth refused a body unread. */
  const LARGE = 8 * 1024 * 1024;

  function headLines(
    h: TestHearth,
    lines: { origin?: boolean; token?: string; framing: string },
  ): string[] {
    return [
      `POST ${PATH} HTTP/1.1`,
      `Host: 127.0.0.1:${h.hearth.port}`,
      ...(lines.origin === false ? [] : [`Origin: ${h.hearth.url}`]),
      "Content-Type: application/json",
      ...(lines.token !== undefined
        ? [`X-Agent-Forge-Operator: ${lines.token}`]
        : []),
      lines.framing,
    ];
  }

  test("an 8 MB body sent with Connection: close is answered with its refusal 5 times out of 5, when the request does not declare the hearth's origin (403), presents a wrong token (403) or declares a Content-Length over the row's cap (400); nothing is recorded", async () => {
    const { h, probes } = await probed();
    const cases: Array<[string, string[], number]> = [
      [
        "no declared origin",
        headLines(h, {
          origin: false,
          token: h.hearth.token,
          framing: `Content-Length: ${LARGE}`,
        }),
        403,
      ],
      [
        "a wrong token",
        headLines(h, { token: "wrong", framing: `Content-Length: ${LARGE}` }),
        403,
      ],
      [
        "a Content-Length over the cap",
        headLines(h, {
          token: h.hearth.token,
          framing: `Content-Length: ${LARGE}`,
        }),
        400,
      ],
    ];
    const body = Buffer.alloc(LARGE, 0x20);
    const answers: unknown[] = [];
    const expected: unknown[] = [];
    for (const [label, head, status] of cases) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const answer = await rawExchange(
          h,
          [...head, "Connection: close"],
          body,
          10_000,
        );
        answers.push({ label, attempt, status: answer.status });
        expected.push({ label, attempt, status });
      }
    }
    expect(answers).toEqual(expected);
    expect(h.events()).toEqual([]);
    expect(probes).toEqual([]);
  }, 60_000);

  test("an authorised request whose body stops arriving (Content-Length, chunked, and a chunked body already over the cap) is answered 408 at the body time limit and its connection closed; nothing is recorded", async () => {
    const { h, probes } = await probed({ api: { bodyTimeoutMs: 400 } });
    const overCap = "x".repeat(20_000);
    const cases: Array<[string, string, Buffer]> = [
      ["Content-Length", "Content-Length: 1000", Buffer.from('{"issueId":')],
      [
        "chunked",
        "Transfer-Encoding: chunked",
        Buffer.from('b\r\n{"issueId":\r\n'),
      ],
      [
        "chunked, over the cap",
        "Transfer-Encoding: chunked",
        Buffer.from(`${overCap.length.toString(16)}\r\n${overCap}\r\n`),
      ],
    ];
    const seen: unknown[] = [];
    const wanted: unknown[] = [];
    for (const [label, framing, sent] of cases) {
      const answer = await rawExchange(
        h,
        headLines(h, { token: h.hearth.token, framing }),
        sent,
        5_000,
      );
      seen.push({
        label,
        status: answer.status,
        timeLimit: (JSON.parse(answer.body || "{}") as { error?: string })
          .error,
        answeredInTime:
          answer.answeredMs !== null &&
          answer.answeredMs >= 300 &&
          answer.answeredMs < 2_000,
        closedByHearth: answer.closedMs !== null && answer.closedMs < 2_000,
      });
      wanted.push({
        label,
        status: 408,
        timeLimit: expect.stringContaining("did not arrive within 400 ms"),
        answeredInTime: true,
        closedByHearth: true,
      });
    }
    expect(seen).toEqual(wanted);
    expect(h.events()).toEqual([]);
    expect(probes).toEqual([]);
  }, 30_000);

  test("a request refused for its token is answered 403 once its body has been read, at once when no byte of the body has arrived, and its connection is closed at the body time limit when the body never ends", async () => {
    const { h, probes } = await probed({ api: { bodyTimeoutMs: 1_000 } });
    const head = headLines(h, {
      token: "wrong",
      framing: "Content-Length: 1000",
    });
    const cases: Array<[string, Buffer, "at once" | "at the time limit"]> = [
      // A client that holds its body back until it has heard nothing, as the MCP server does.
      ["no byte of the body sent", Buffer.alloc(0), "at once"],
      [
        "part of the body sent",
        Buffer.from('{"issueId":'),
        "at the time limit",
      ],
    ];
    const seen: unknown[] = [];
    const wanted: unknown[] = [];
    for (const [label, sent, when] of cases) {
      const answer = await rawExchange(h, head, sent, 5_000);
      const answeredMs = answer.answeredMs ?? Number.POSITIVE_INFINITY;
      seen.push({
        label,
        status: answer.status,
        answered:
          answeredMs < 500
            ? "at once"
            : answeredMs >= 900 && answeredMs < 3_000
              ? "at the time limit"
              : `after ${Math.round(answeredMs)} ms`,
        closedAtTheTimeLimit:
          answer.closedMs !== null &&
          answer.closedMs >= 900 &&
          answer.closedMs < 3_000,
      });
      wanted.push({
        label,
        status: 403,
        answered: when,
        closedAtTheTimeLimit: true,
      });
    }
    expect(seen).toEqual(wanted);
    expect(probes).toEqual([]);
  }, 30_000);

  test("a refused Expect body that was never requested skips the held-body wait and closes even a keep-alive connection", async () => {
    const { h, probes } = await probed({ api: { bodyTimeoutMs: 60_000 } });
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const answer = await rawExchange(
        h,
        [
          ...headLines(h, {
            token: "wrong",
            framing: "Content-Length: 2000000",
          }),
          "Expect: 100-continue",
          "Connection: keep-alive",
        ],
        Buffer.alloc(0),
        5_000,
      );
      // Observe scheduling, not elapsed wall time: an unasked body needs no wait.
      expect(timers.mock.calls.filter((call) => call[1] === 50)).toEqual([]);
      expect(timers.mock.calls.filter((call) => call[1] === 60_000)).toEqual(
        [],
      );
      expect(answer.status).toBe(403);
      expect(answer.headers).toMatch(/\r\nconnection: close(?:\r\n|$)/i);
      expect(answer.closedMs).not.toBeNull();
      expect(h.events()).toEqual([]);
      expect(probes).toEqual([]);
    } finally {
      timers.mockRestore();
    }
  }, 10_000);

  test("a request that says Expect: 100-continue is answered on its head, with no 100 Continue and its body never asked for, when it does not declare the hearth's origin, presents a wrong token, declares a Content-Length over the row's cap, is not JSON, comes from another origin or names no route; authorised, it is sent 100 Continue and its body is read and acted on", async () => {
    const { h, probes } = await probed();
    const body = Buffer.from(JSON.stringify(REVIEW));
    const framing = `Content-Length: ${body.byteLength}`;
    const authorised = headLines(h, { token: h.hearth.token, framing });
    const replaced = (from: string, to: string): string[] =>
      authorised.map((line) => (line === from ? to : line));
    const cases: Array<[string, string[], number]> = [
      [
        "no declared origin",
        headLines(h, { origin: false, token: h.hearth.token, framing }),
        403,
      ],
      ["a wrong token", headLines(h, { token: "wrong", framing }), 403],
      [
        "a Content-Length over the cap",
        headLines(h, {
          token: h.hearth.token,
          framing: `Content-Length: ${LARGE}`,
        }),
        400,
      ],
      [
        "not JSON",
        replaced("Content-Type: application/json", "Content-Type: text/plain"),
        400,
      ],
      [
        "another origin (the front door)",
        replaced(`Origin: ${h.hearth.url}`, "Origin: http://127.0.0.1:1"),
        403,
      ],
      [
        "no route",
        replaced(
          `POST ${PATH} HTTP/1.1`,
          "POST /__agent-forge/no-such-route HTTP/1.1",
        ),
        404,
      ],
    ];
    const seen: unknown[] = [];
    const wanted: unknown[] = [];
    for (const [label, head, status] of cases) {
      const answer = await expectingExchange(h, head, body);
      seen.push({
        label,
        status: answer.status,
        interim: answer.interim,
        bodySent: answer.bodySent,
      });
      wanted.push({ label, status, interim: [], bodySent: false });
    }
    expect(seen).toEqual(wanted);
    expect(h.events()).toEqual([]);
    expect(probes).toEqual([]);

    const accepted = await expectingExchange(h, authorised, body);
    expect({
      interim: accepted.interim,
      bodySent: accepted.bodySent,
      status: accepted.status,
    }).toEqual({
      interim: ["HTTP/1.1 100 Continue"],
      bodySent: true,
      status: 200,
    });
    expect(probes.map((probe) => probe.input)).toEqual([
      expect.objectContaining({ issueId: "demo-1" }),
    ]);
  }, 30_000);
});

function get(
  h: TestHearth,
  path: string,
  headers: Record<string, string> = h.headers(),
): Promise<Response> {
  return fetch(`${h.api}${path}`, { headers });
}

test("worktree receipt lookup requires operator authority and never writes an audit or repeats creation", async () => {
  const h = await start();
  const path = `/projects/${FIXTURE_PROJECT_ID}/session-worktrees/${FIXTURE_WORKTREE_REQUEST}`;
  for (const token of [null, "wrong-token"])
    expect((await get(h, path, h.headers(token))).status).toBe(403);
  const response = await get(h, path, h.headers(h.hearth.token));
  expect(response.status).toBe(200);
  expect((await envelope(response)).data).toMatchObject({
    state: "created",
    requestId: FIXTURE_WORKTREE_REQUEST,
  });
  expect(
    (await get(h, `${path}?retry=true`, h.headers(h.hearth.token))).status,
  ).toBe(400);
  expect(h.events()).toEqual([]);
});

/** Append to the hearth's ledger under another workspace: what a second checkout on this machine would write. */
function appendElsewhere(
  h: TestHearth,
  event: Omit<LedgerEventInput, "workspace">,
): void {
  // justification: the caller's kind and payload stay paired; only the workspace is added.
  const stored = appendEvent(
    { ...event, workspace: "c:/work/another-checkout" } as LedgerEventInput,
    { path: h.ledger },
  );
  if (!stored.ok) throw new Error(stored.error);
}

const TOOL = { tool: "Bash", argsHash: "sha256:ab12" };

describe("Session Start identity actions", () => {
  test("GET is read-only and retirement blocks a delayed Start", async () => {
    const h = await start({ api: { git: fixtureSessionGit } });
    const requestId = FIXTURE_IDENTITY_REQUEST;
    const input = sessionStartFixture(h, requestId);
    const path = `/projects/${FIXTURE_PROJECT_ID}/session-start-identities`;

    const beforeEmptyRead = h.events();
    const empty = await get(h, path, h.headers(h.hearth.token));
    expect(empty.status).toBe(200);
    expect(
      sessionStartIdentityPageSchema.parse((await envelope(empty)).data)
        .identities,
    ).toEqual([]);
    expect(h.events()).toEqual(beforeEmptyRead);

    const requestHash = createHash("sha256")
      .update(canonicalOwnedSessionStart(input))
      .digest("hex");
    const reserved = await post(h, path, input);
    const reservedBody = await envelope(reserved);
    expect({ status: reserved.status, error: reservedBody.error }).toEqual({
      status: 200,
      error: null,
    });
    expect(
      sessionStartIdentityReplySchema.parse(reservedBody.data).identity.state,
    ).toBe("reserved");
    expect(h.events().at(-1)?.payload).toMatchObject({
      action: "session.start.identity.reserve",
      target: `owned-session-start:${FIXTURE_PROJECT_ID}:${requestId}:${requestHash}`,
    });

    const journalEventBytes = () =>
      readdirSync(join(h.home, "restart-identities"))
        .filter((name) => /^event-\d{8}-[a-f0-9]{64}\.json$/.test(name))
        .sort()
        .map((name) => [
          name,
          readFileSync(join(h.home, "restart-identities", name)),
        ]);
    const beforeReadbackEvents = h.events();
    const beforeReadbackJournal = journalEventBytes();
    const readback = await get(h, path, h.headers(h.hearth.token));
    expect(
      sessionStartIdentityPageSchema.parse((await envelope(readback)).data)
        .identities[0]?.state,
    ).toBe("reserved");
    expect(h.events()).toEqual(beforeReadbackEvents);
    expect(journalEventBytes()).toEqual(beforeReadbackJournal);

    const retired = await post(h, `${path}/${requestId}/retire`, {
      requestHash,
    });
    expect(retired.status).toBe(200);
    expect(
      sessionStartIdentityReplySchema.parse((await envelope(retired)).data)
        .identity.state,
    ).toBe("retired");
    const delayedStart = await post(
      h,
      `/projects/${FIXTURE_PROJECT_ID}/sessions`,
      input,
    );
    expect(delayedStart.status).toBe(409);
    expect(createSessionRegistry(h.home).list(FIXTURE_PROJECT_ID)).toEqual([]);
    const finalPage = await get(h, path, h.headers(h.hearth.token));
    expect(
      sessionStartIdentityPageSchema.parse((await envelope(finalPage)).data)
        .identities[0]?.state,
    ).toBe("retired");
  });

  test("attempted and admitted identities cannot be retired", async () => {
    for (const [requestId, state] of [
      ["c9edb6ad-3810-480e-8c13-d6070588bc32", "attempted"],
      ["43bef9b6-b09b-4817-b64d-44d202b83e14", "admitted"],
    ] as const) {
      const h = await start({ api: { git: fixtureSessionGit } });
      const journal = createRestartIdentityJournal(h.home);
      const input = sessionStartFixture(h, requestId);
      const identity = {
        version: 1 as const,
        address: {
          family: "owned-session-start" as const,
          projectId: FIXTURE_PROJECT_ID,
        },
        workspace: h.workspace,
        requestId,
        requestHash: createHash("sha256")
          .update(canonicalOwnedSessionStart(input))
          .digest("hex"),
        provider: "claude" as const,
        mode: "chat" as const,
      };
      await journal.reserve(identity);
      await journal.beginAttempt(identity);
      if (state === "admitted") {
        await createRestartIdentityJournal(h.home, {
          verifyAdmission: async () => ({ verified: true }),
        }).admit(identity);
      }
      const response = await post(
        h,
        `/projects/${FIXTURE_PROJECT_ID}/session-start-identities/${requestId}/retire`,
        { requestHash: identity.requestHash },
      );
      const body = await envelope(response);
      expect({ status: response.status, error: body.error }).toEqual({
        status: 409,
        error: "Only an unattempted Session Start identity can be retired.",
      });
      expect(
        (
          await journal.lookup(
            { address: identity.address, workspace: identity.workspace },
            requestId,
          )
        )?.state,
      ).toBe(state);
    }
  });
});

describe("every read row (iterating the table)", () => {
  test("answers a valid envelope for its fixture path", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
      api: { git: fixtureSessionGit },
    });
    await seedOwnedSession(h);
    await seedChatDecision(h);
    await seedProjectShift(h);
    await seedProjectShiftAttempt(h);
    seedProjectBeadWriteFixture(h);
    seedActivityReadFixture(h);
    await seedKeeperSessionStartHistory(h);
    await seedKeeperShiftStartHistory(h);
    seedSmithVerificationRead(h);
    activityReadMembership(h);
    await seedSmithCreateOriginal(h);
    await seedSmithEditOriginal(h);
    await seedSmithRoutingEditOriginal(h);
    await seedForkReadChild(h);
    await seedForkReadSourceReview(h);
    await seedForkReadOriginal(h);
    const rows = h.hearth.routes.filter((route) => route.kind === "read");
    if (rows.length === 0) throw new Error("the table has no read rows");
    for (const row of rows) {
      const path = READS[key(row)];
      if (path === undefined)
        throw new Error(`no fixture for read row ${key(row)}`);
      const response = await get(
        h,
        path,
        h.headers(row.operatorOnly ? h.hearth.token : undefined),
      );
      const body = await envelope(response);
      expect({
        row: key(row),
        status: response.status,
        ok: body.ok,
        error: body.error,
      }).toEqual({
        row: key(row),
        status: 200,
        ok: true,
        error: null,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("refuses a request that does not declare the hearth's own origin, and appends nothing", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
      api: { git: fixtureSessionGit },
    });
    await seedOwnedSession(h);
    await seedChatDecision(h);
    await seedProjectShift(h);
    await seedProjectShiftAttempt(h);
    seedProjectBeadWriteFixture(h);
    const before = seedActivityReadFixture(h);
    await seedKeeperSessionStartHistory(h);
    await seedKeeperShiftStartHistory(h);
    seedSmithVerificationRead(h);
    activityReadMembership(h);
    await seedSmithCreateOriginal(h);
    await seedSmithEditOriginal(h);
    await seedSmithRoutingEditOriginal(h);
    await seedForkReadChild(h);
    await seedForkReadSourceReview(h);
    await seedForkReadOriginal(h);
    const rows = h.hearth.routes.filter((route) => route.kind === "read");
    if (rows.length === 0) throw new Error("the table has no read rows");
    const refused: Array<[string, Record<string, string>]> = [
      ["no declaration at all", {}],
      ["a foreign Origin", { Origin: "https://evil.example" }],
      ["another loopback port as Origin", { Origin: "http://127.0.0.1:1" }],
      ["Sec-Fetch-Site: same-site", { "Sec-Fetch-Site": "same-site" }],
      ["Sec-Fetch-Site: cross-site", { "Sec-Fetch-Site": "cross-site" }],
    ];
    for (const row of rows) {
      const path = READS[key(row)] ?? "";
      for (const [label, headers] of refused) {
        const response = await get(h, path, headers);
        expect({ row: key(row), label, status: response.status }).toEqual({
          row: key(row),
          label,
          status: 403,
        });
        expect((await envelope(response)).ok).toBe(false);
      }
      // A browser on the same origin sends no Origin on a GET; its fetch metadata is the declaration.
      const browser = await get(h, path, {
        "Sec-Fetch-Site": "same-origin",
        ...(row.operatorOnly ? { [OPERATOR_HEADER]: h.hearth.token } : {}),
      });
      expect({ row: key(row), status: browser.status }).toEqual({
        row: key(row),
        status: 200,
      });
    }
    expect(h.events()).toEqual(before);
    // The read rows run list/export and only the fixed readonly verification show, never a write.
    expect(
      h.bd.calls.every(
        (args) =>
          args[0] === "list" ||
          args[0] === "export" ||
          JSON.stringify(args) ===
            JSON.stringify([
              "--readonly",
              "show",
              APPRENTICE_VERIFICATION,
              "--json",
            ]),
      ),
    ).toBe(true);
    expect(h.bd.calls.filter((args) => args[0] === "--readonly")).toEqual([
      ["--readonly", "show", APPRENTICE_VERIFICATION, "--json"],
    ]);
  });
});

describe("reads over the ledger and run state", () => {
  test("/sessions and /reservations return what the ledger holds for this workspace, and nothing from another", async () => {
    const h = await start();
    h.append({
      kind: "session.started",
      sessionId: "s-1",
      payload: { kind: "interactive", worktree: "trees/a" },
    });
    h.append({
      kind: "tool.called",
      sessionId: "s-1",
      beadId: "b-1",
      payload: TOOL,
    });
    h.append({ kind: "session.started", sessionId: "s-2", payload: {} });
    h.append({ kind: "session.ended", sessionId: "s-2", payload: {} });
    h.append({
      kind: "reservation.acquired",
      beadId: "b-1",
      sessionId: "s-1",
      payload: { worktree: "trees/a", globs: ["scripts/**"] },
    });
    appendElsewhere(h, {
      kind: "session.started",
      sessionId: "other",
      payload: {},
    });
    appendElsewhere(h, {
      kind: "reservation.acquired",
      beadId: "b-9",
      payload: { worktree: "trees/z", globs: ["**"] },
    });

    const sessions = await envelope<SessionSummary[]>(
      await get(h, "/sessions"),
    );
    expect(sessions.data?.map((session) => session.sessionId)).toEqual([
      "s-1",
      "s-2",
    ]);
    expect(sessions.data?.[0]).toMatchObject({
      workspace: h.workspace,
      kind: "interactive",
      worktree: "trees/a",
      beadId: "b-1",
    });
    expect(sessions.data?.[1]).toHaveProperty("endedAt");

    const openOnly = await envelope<SessionSummary[]>(
      await get(h, "/sessions?open=1&limit=5"),
    );
    expect(openOnly.data?.map((session) => session.sessionId)).toEqual(["s-1"]);
    const one = await envelope<SessionSummary[]>(
      await get(h, "/sessions?limit=1"),
    );
    expect(one.data?.map((session) => session.sessionId)).toEqual(["s-1"]);

    const reservations = await envelope<Reservation[]>(
      await get(h, "/reservations"),
    );
    expect(reservations.data).toEqual([
      {
        beadId: "b-1",
        worktree: "trees/a",
        workspace: h.workspace,
        globs: ["scripts/**"],
        sessionId: "s-1",
        acquiredAt: expect.any(String),
      },
    ]);

    for (const bad of [
      "/sessions?limit=0",
      "/sessions?limit=501",
      "/sessions?limit=ten",
      "/sessions?open=yes",
      "/sessions?active=1",
      "/sessions?limit=1&limit=2",
      "/reservations?bead=b-1",
    ]) {
      const response = await get(h, bad);
      expect({ bad, status: response.status }).toEqual({ bad, status: 400 });
      expect((await envelope(response)).ok).toBe(false);
    }
  });

  test("/events applies each filter and pages by `after`; events of another workspace never appear", async () => {
    const h = await start();
    const first = h.append({
      kind: "tool.called",
      sessionId: "s-1",
      beadId: "b-1",
      runId: "r-1",
      ts: "2026-10-01T10:00:00.000Z",
      payload: TOOL,
    });
    h.append({
      kind: "gate.ran",
      sessionId: "s-1",
      ts: "2026-10-02T10:00:00.000Z",
      payload: { gate: "typecheck", passed: true },
    });
    h.append({
      kind: "tool.called",
      sessionId: "s-2",
      beadId: "b-2",
      ts: "2026-10-03T10:00:00.000Z",
      payload: TOOL,
    });
    appendElsewhere(h, {
      kind: "tool.called",
      sessionId: "s-1",
      beadId: "b-1",
      runId: "r-1",
      payload: TOOL,
    });
    const last = h.append({
      kind: "gate.ran",
      runId: "r-1",
      ts: "2026-10-04T10:00:00.000Z",
      payload: { gate: "lint", passed: false },
    });
    const [a, b, c, d] = [first, first + 1, first + 2, last];

    const ids = async (query: string): Promise<number[]> => {
      const response = await get(h, `/events${query}`);
      const body = await envelope<EventsPage>(response);
      if (!body.ok) throw new Error(`${query}: ${body.error}`);
      expect(
        body.data.events.every((event) => event.workspace === h.workspace),
      ).toBe(true);
      return body.data.events.map((event) => event.id);
    };
    expect(await ids("")).toEqual([a, b, c, d]);
    expect(await ids("?kind=gate.ran")).toEqual([b, d]);
    expect(await ids("?kind=gate.ran,tool.called")).toEqual([a, b, c, d]);
    expect(await ids("?run=r-1")).toEqual([a, d]);
    expect(await ids("?session=s-2")).toEqual([c]);
    // A bead brings the other events of a session that touched it; beadExact does not.
    expect(await ids("?bead=b-1")).toEqual([a, b]);
    expect(await ids("?bead=b-1&beadExact=1")).toEqual([a]);
    expect(await ids("?since=2026-10-03T00:00:00Z")).toEqual([c, d]);
    expect(await ids("?kind=tool.called&session=s-1")).toEqual([a]);

    const tail = await envelope<EventsPage>(await get(h, "/events?limit=2"));
    expect(tail.data).toMatchObject({ cursor: d, more: true });
    expect(tail.data?.events.map((event) => event.id)).toEqual([c, d]);

    const page = await envelope<EventsPage>(
      await get(h, `/events?after=${a}&limit=2`),
    );
    expect(page.data).toMatchObject({ cursor: c, more: true });
    expect(page.data?.events.map((event) => event.id)).toEqual([b, c]);
    const rest = await envelope<EventsPage>(
      await get(h, `/events?after=${c}&limit=2`),
    );
    expect(rest.data).toMatchObject({ cursor: d, more: false });
    // An empty page keeps the cursor it was given, so a poller does not go backwards.
    const empty = await envelope<EventsPage>(
      await get(h, `/events?after=${d}`),
    );
    expect(empty.data).toEqual({ events: [], cursor: d, more: false });
    expect(
      (await envelope<EventsPage>(await get(h, "/events?kind=shift.started")))
        .data,
    ).toEqual({ events: [], cursor: 0, more: false });
  });

  test("/events refuses anything outside its filters, and the ledger commands the audit CLI also has", async () => {
    const h = await start();
    h.append({ kind: "tool.called", payload: TOOL });
    const long = "x".repeat(201);
    const refused = [
      "?kinds=gate.ran",
      "?kind=gate.ran&kind=tool.called",
      "?backup=1",
      "?compact=1",
      "?all-workspaces=1",
      "?allWorkspaces=1",
      "?workspace=c:/work/another-checkout",
      "?bead=--backup",
      "?run=--compact",
      "?session=--all-workspaces",
      "?kind=not.a.kind",
      "?kind=",
      "?since=yesterday",
      "?since=2026-13-45T00:00:00Z",
      "?limit=0",
      "?limit=1001",
      "?limit=ten",
      "?limit=-1",
      "?after=-1",
      "?after=1.5",
      `?after=${"9".repeat(400)}`,
      "?bead=",
      `?bead=${long}`,
      `?run=${long}`,
      `?session=${long}`,
      "?beadExact=1",
      "?bead=b-1&beadExact=yes",
    ];
    for (const query of refused) {
      const response = await get(h, `/events${query}`);
      const body = await envelope(response);
      expect({ query, status: response.status, ok: body.ok }).toEqual({
        query,
        status: 400,
        ok: false,
      });
    }
    // Nothing was backed up, compacted or widened: the one event is still the only thing there.
    expect(h.events().length).toBe(1);
    expect(existsSync(join(h.home, "backups"))).toBe(false);
  });

  test("/runs/:slug returns the run, its state and its newest events; unknown is 404, not a slug is 400", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    const entered = h.append({
      kind: "run.phase.entered",
      runId: "demo",
      payload: { phase: "research" },
    });
    h.append({
      kind: "run.phase.entered",
      runId: "another",
      payload: { phase: "plan" },
    });
    // Another checkout on this machine has a run of the same name.
    appendElsewhere(h, {
      kind: "run.phase.entered",
      runId: "demo",
      payload: { phase: "ship" },
    });

    const response = await get(h, "/runs/demo");
    expect(response.status).toBe(200);
    const body = await envelope<RunDetail>(response);
    expect(body.data?.run).toMatchObject({
      slug: "demo",
      phase: "research",
      next: "plan",
      complete: false,
    });
    expect(body.data?.state).toMatchObject({
      slug: "demo",
      feature: "Demo run",
      completed: ["research"],
    });
    expect(body.data?.events).toMatchObject({ cursor: entered, more: false });
    expect(body.data?.events.events.map((event) => event.id)).toEqual([
      entered,
    ]);

    const unknown = await get(h, "/runs/never-ran");
    expect(unknown.status).toBe(404);
    expect((await envelope(unknown)).ok).toBe(false);

    for (const bad of [
      "/runs/has%20space",
      `/runs/${"a".repeat(81)}`,
      "/runs/-leading-dash",
      "/runs/demo?verbose=1",
      "/runs/%E0%A4%A",
    ]) {
      const refused = await get(h, bad);
      expect({ bad, status: refused.status }).toEqual({ bad, status: 400 });
      expect((await envelope(refused)).ok).toBe(false);
    }
  });

  test("/runs/:slug bounds the events it returns", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    for (let i = 0; i < 205; i++)
      h.append({
        kind: "gate.ran",
        runId: "demo",
        payload: { gate: "typecheck", passed: true },
      });
    const body = await envelope<RunDetail>(await get(h, "/runs/demo"));
    expect(body.data?.events.events.length).toBe(200);
    expect(body.data?.events.more).toBe(true);
  });

  test("/runs/:slug?events=N carries the run's newest N events; 0 carries none, and the run and its state are still answered", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        h.append({
          kind: "gate.ran",
          runId: "demo",
          payload: { gate: "typecheck", passed: true },
        }),
      );
    const read = async (query: string) => {
      const response = await get(h, `/runs/demo${query}`);
      const body = await envelope<RunDetail>(response);
      return {
        status: response.status,
        slug: body.data?.run.slug,
        feature: body.data?.state.feature,
        ids: body.data?.events.events.map((event) => event.id),
        cursor: body.data?.events.cursor,
        more: body.data?.events.more,
      };
    };
    const answered = { status: 200, slug: "demo", feature: "Demo run" };

    expect(await read("?events=2")).toEqual({
      ...answered,
      ids: ids.slice(-2),
      cursor: ids[4],
      more: true,
    });
    // None carried: the cursor is where a forward page starts, and `more` says the run has events.
    expect(await read("?events=0")).toEqual({
      ...answered,
      ids: [],
      cursor: 0,
      more: true,
    });
    expect(await read("?events=5")).toEqual({
      ...answered,
      ids,
      cursor: ids[4],
      more: false,
    });
    expect(await read("?events=200")).toEqual({
      ...answered,
      ids,
      cursor: ids[4],
      more: false,
    });
  });

  test("/runs/:slug refuses an events value that is not a whole number from 0 to 200, a repeated one, and any other parameter", async () => {
    const h = await start({
      files: { ".tmp/work/forge-runs/demo.json": RUN_STATE },
    });
    h.append({
      kind: "gate.ran",
      runId: "demo",
      payload: { gate: "typecheck", passed: true },
    });
    const range = "events: expected a whole number from 0 to 200";
    for (const [query, error] of [
      ["?events=201", range],
      ["?events=-1", range],
      ["?events=1.5", range],
      ["?events=ten", range],
      ["?events=", range],
      ["?events=1&events=2", "events: given more than once"],
      ["?event=1", "event: unknown parameter (expected events)"],
      ["?limit=5", "limit: unknown parameter (expected events)"],
    ] as const) {
      const response = await get(h, `/runs/demo${query}`);
      const body = await envelope(response);
      expect({ query, status: response.status, body }).toEqual({
        query,
        status: 400,
        body: { ok: false, data: null, error },
      });
    }
  });
});

const QUEUE_ARGS = [
  "list",
  "--readonly",
  "--flat",
  "--json",
  "--all",
  "--limit",
  "0",
  "--label-any",
  "queue:proposed,queue:approved,queue:queued,queue:running,queue:review,queue:done,queue:paused,queue:halted",
];

const BD_ISSUES = [
  {
    id: "b-1",
    title: "One",
    status: "open",
    priority: 2,
    issue_type: "task",
    labels: ["queue:approved", "command-center"],
    // The queue wrote this label: the issue's own metadata names the same state.
    metadata: { queue_state: "approved", smith: "claude-master" },
  },
  {
    id: "b-2",
    title: "Two",
    status: "closed",
    priority: 1,
    issue_type: "bug",
    labels: ["queue:done"],
    // Metadata that names another state backs nothing.
    metadata: { queue_state: "review" },
  },
  {
    id: "b-3",
    title: "Both",
    status: "in_progress",
    labels: ["queue:paused", "queue:running"],
  },
  // What a bd that ignores the label filter hands back: none of these is in the queue.
  { id: "b-4", title: "No queue label", status: "open", labels: ["privacy"] },
  {
    id: "b-5",
    title: "Not a queue state",
    status: "open",
    labels: ["queue:teleported", "queue:"],
  },
  { id: "b-6", title: "No labels at all", status: "open" },
];

const listed = (issues: unknown): BdResult => ({
  status: 0,
  stdout: JSON.stringify(issues),
  stderr: "",
});

describe("/eligibility", () => {
  test("answers which queued beads may start and why the others wait, read from bd; not a stream collection", async () => {
    const h = await start();
    const queued = (id: string, files: string) => ({
      id,
      title: id,
      status: "open",
      priority: 2,
      issue_type: "task",
      labels: ["queue:queued"],
      metadata: { queue_state: "queued" },
      description: `## Files\n${files}\n`,
    });
    h.bd.list = listed([queued("q-1", "src/**"), queued("q-2", "src/a.ts")]);
    const response = await get(h, "/eligibility");
    expect(response.status).toBe(200);
    const data = (
      await envelope<{
        eligible: Array<{ id: string }>;
        waiting: Array<{ id: string; waitsOn?: string }>;
      }>(response)
    ).data;
    expect(data?.eligible.map((e) => e.id)).toEqual(["q-1"]);
    expect(data?.waiting).toEqual([
      expect.objectContaining({ id: "q-2", waitsOn: "q-1" }),
    ]);
    const row = h.hearth.routes.find(
      (route) => key(route) === "GET /eligibility",
    );
    expect(
      row?.kind === "read" ? row.collection : "not a read",
    ).toBeUndefined();
  });

  test("a queued bead whose reservation a live shift's worktree still holds waits for that run, naming the shift (waitsOnShift), as the hearth's shift records say", async () => {
    const h = await start();
    const shiftId = "shift-20261015-120000-0e1a";
    writeShiftRecord(join(h.home, SHIFTS_DIR), {
      shiftId,
      pid: process.pid,
      workspace: h.workspace,
      startedAt: "2026-10-15T12:00:00.000Z",
      deadline: "2026-10-15T14:00:00.000Z",
      state: "running",
      options: {
        concurrency: 2,
        forMs: 7_200_000,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 0,
      },
      spentUsd: 0,
      unpriced: 0,
      beads: [],
    });
    const worktree = `${h.workspace}/trees/${shiftId}-1`;
    h.append({
      kind: "reservation.acquired",
      beadId: "q-1",
      payload: { worktree, globs: ["src/**"] },
    });
    h.bd.list = listed([
      {
        id: "q-1",
        title: "q-1",
        status: "open",
        priority: 2,
        issue_type: "task",
        labels: ["queue:queued"],
        metadata: { queue_state: "queued" },
        description: "## Files\nsrc/**\n",
      },
    ]);
    const response = await get(h, "/eligibility");
    expect(response.status).toBe(200);
    const data = (
      await envelope<{
        eligible: Array<{ id: string }>;
        waiting: Array<{ id: string; why: string; waitsOnShift?: string }>;
      }>(response)
    ).data;
    expect(data?.eligible).toEqual([]);
    expect(data?.waiting).toEqual([
      expect.objectContaining({ id: "q-1", waitsOnShift: shiftId }),
    ]);
    expect(data?.waiting[0]?.why).toBe(
      `its earlier run in ${worktree} (shift ${shiftId}) has not ended: it starts again once that run releases its reservation (if that shift is gone and its pid names another program now, bun run forge:reservations release q-1 ${worktree} frees it)`,
    );
  });

  test("answers 502 when bd fails, not an empty queue", async () => {
    const h = await start();
    h.bd.list = { status: 1, stdout: "", stderr: "Error: database is locked" };
    const response = await get(h, "/eligibility");
    expect(response.status).toBe(502);
    expect((await envelope(response)).error).toContain("database is locked");
  });
});

describe("/queue", () => {
  test("a paused entry says where it returns to, when its bead names a state it can return to", async () => {
    const h = await start();
    h.bd.list = listed([
      {
        id: "p-1",
        title: "Paused from queued",
        status: "open",
        labels: ["queue:paused"],
        metadata: { queue_state: "paused", queue_resume: "queued" },
      },
      {
        id: "p-2",
        title: "Paused from nowhere usable",
        status: "open",
        labels: ["queue:paused"],
        metadata: { queue_state: "paused", queue_resume: "done" },
      },
      {
        id: "p-3",
        title: "Queued, with a stray resume",
        status: "open",
        labels: ["queue:queued"],
        metadata: { queue_state: "queued", queue_resume: "approved" },
      },
      {
        id: "p-4",
        title: "Paused while running",
        status: "open",
        labels: ["queue:paused"],
        metadata: { queue_state: "paused", queue_resume: "running" },
      },
    ]);
    const entries = (await envelope<QueueEntry[]>(await get(h, "/queue"))).data;
    // A bead paused while running returns to queued, not to running.
    expect(entries?.map((e) => [e.beadId, e.resume ?? null])).toEqual([
      ["p-1", "queued"],
      ["p-2", null],
      ["p-3", null],
      ["p-4", "queued"],
    ]);
  });

  test("asks bd with one fixed argument array, and returns one entry per queue label a bead carries", async () => {
    const h = await start();
    h.bd.list = listed(BD_ISSUES);
    const response = await get(h, "/queue");
    expect(response.status).toBe(200);
    expect((await envelope<QueueEntry[]>(response)).data).toEqual([
      {
        beadId: "b-1",
        title: "One",
        state: "approved",
        status: "open",
        backed: true,
        // The bead's smith metadata, for the Workbench card.
        smith: "claude-master",
        priority: 2,
        type: "task",
      },
      {
        beadId: "b-2",
        title: "Two",
        state: "done",
        status: "closed",
        backed: false,
        priority: 1,
        type: "bug",
      },
      {
        beadId: "b-3",
        title: "Both",
        state: "running",
        status: "in_progress",
        backed: false,
      },
      {
        beadId: "b-3",
        title: "Both",
        state: "paused",
        status: "in_progress",
        backed: false,
      },
    ]);
    expect(h.bd.calls).toEqual([QUEUE_ARGS]);
  });

  test("filters by state, and refuses a state or a parameter it does not know without calling bd", async () => {
    const h = await start();
    h.bd.list = listed(BD_ISSUES);
    const some = await envelope<QueueEntry[]>(
      await get(h, "/queue?state=running,done"),
    );
    expect(some.data?.map((entry) => [entry.beadId, entry.state])).toEqual([
      ["b-2", "done"],
      ["b-3", "running"],
    ]);
    // The request never changes what bd is asked.
    expect(h.bd.calls).toEqual([QUEUE_ARGS]);

    for (const bad of [
      "?state=teleported",
      "?state=",
      "?state=running&state=done",
      "?label=privacy",
      "?state=running,--all",
      "?limit=5",
    ]) {
      const response = await get(h, `/queue${bad}`);
      expect({ bad, status: response.status }).toEqual({ bad, status: 400 });
      expect((await envelope(response)).ok).toBe(false);
    }
    expect(h.bd.calls.length).toBe(1);
  });

  test("a bd failure, or output that is not a list of issues, is 502", async () => {
    const h = await start();
    const failures: Array<[string, BdResult]> = [
      [
        "a non-zero exit",
        { status: 1, stdout: "", stderr: "Error: database is locked\n" },
      ],
      [
        "a process that could not start",
        { status: null, stdout: "", stderr: "spawn bd ENOENT" },
      ],
      [
        "output that is not JSON",
        { status: 0, stdout: "no issues found", stderr: "" },
      ],
      [
        "JSON that is not a list",
        { status: 0, stdout: '{"issues":[]}', stderr: "" },
      ],
      [
        "a list of things that are not issues",
        { status: 0, stdout: '[1,"two",null]', stderr: "" },
      ],
    ];
    for (const [label, result] of failures) {
      h.bd.list = result;
      const response = await get(h, "/queue");
      const body = await envelope(response);
      expect({ label, status: response.status, ok: body.ok }).toEqual({
        label,
        status: 502,
        ok: false,
      });
    }
    h.bd.list = {
      status: 1,
      stdout: "",
      stderr: "Error: database is locked\n",
    };
    expect((await envelope(await get(h, "/queue"))).error).toContain(
      "database is locked",
    );
  });

  test("runs one bd at a time: a request that arrives during a read shares the next one, never an older answer", async () => {
    const h = await start();
    const waiting: Array<(result: BdResult) => void> = [];
    h.bd.list = () => new Promise<BdResult>((resolve) => waiting.push(resolve));
    const until = async (count: number): Promise<void> => {
      for (let i = 0; i < 200 && waiting.length < count; i++)
        await new Promise((done) => setTimeout(done, 5));
      if (waiting.length < count)
        throw new Error(
          `bd was started ${waiting.length} time(s), expected ${count}`,
        );
    };
    const ids = async (response: Promise<Response>): Promise<string[]> =>
      (await envelope<QueueEntry[]>(await response)).data?.map(
        (entry) => entry.beadId,
      ) ?? [];

    const first = get(h, "/queue");
    await until(1);
    // Both arrive while the first read is still running.
    const second = get(h, "/queue");
    const third = get(h, "/queue");
    await new Promise((done) => setTimeout(done, 50));
    expect(waiting.length).toBe(1);

    waiting[0]?.(listed([BD_ISSUES[0]]));
    expect(await ids(first)).toEqual(["b-1"]);
    await until(2);
    waiting[1]?.(listed([BD_ISSUES[1]]));
    expect(await ids(second)).toEqual(["b-2"]);
    expect(await ids(third)).toEqual(["b-2"]);
    expect(h.bd.calls.length).toBe(2);
  });

  test("a bd that never answers is 502 within the timeout, and the next request starts a new one", async () => {
    const h = await start({ api: { bdTimeoutMs: 100 } });
    h.bd.list = () => new Promise<BdResult>(() => {});
    const began = performance.now();
    const response = await get(h, "/queue");
    expect(response.status).toBe(502);
    expect(performance.now() - began).toBeLessThan(2000);
    // The message names the limit bd was given, not the backstop a second after it.
    expect((await envelope(response)).error).toContain(
      "did not answer within its 100 ms limit",
    );

    h.bd.list = listed([BD_ISSUES[0]]);
    const next = await get(h, "/queue");
    expect(next.status).toBe(200);
    expect(h.bd.calls.length).toBe(2);
  });
});

describe("/smiths and /config", () => {
  const WORKSPACE_TOML = [
    "[workflow]",
    'default_crew = "claude-master"',
    "",
    "[smiths.claude-apprentice]",
    "enabled = false",
    "",
  ].join("\n");

  test("return what the config loader returns for the hearth's root, with provenance", async () => {
    const h = await start({ files: { "agent-forge.toml": WORKSPACE_TOML } });
    mkdirSync(join(h.configHome, ".agent-forge"), { recursive: true });
    writeFileSync(
      join(h.configHome, ".agent-forge", "config.toml"),
      '[smiths.claude-journeyman]\neffort = "high"\n',
    );
    const expected = loadConfig({
      harnessRoot: h.root,
      home: h.configHome,
      env: {},
    });

    const config = await envelope<LoadedConfig>(await get(h, "/config"));
    expect(config.data).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(config.data?.config.workflow.defaultCrew).toBe("claude-master");
    expect(config.data?.provenance["workflow.default_crew"]?.source).toBe(
      join(h.root, "agent-forge.toml"),
    );
    expect(
      config.data?.provenance["smiths.claude-journeyman.effort"]?.source,
    ).toBe(join(h.configHome, ".agent-forge", "config.toml"));
    expect(config.data?.provenance["smiths.claude-master.model"]?.source).toBe(
      "builtin",
    );
    expect(config.data?.files.length).toBe(2);

    const smiths = await envelope<SmithsView>(await get(h, "/smiths"));
    expect(smiths.data?.defaultSmith).toBe("claude-master");
    expect(smiths.data?.smiths).toEqual(Object.values(expected.config.smiths));
    expect(
      smiths.data?.smiths.find((smith) => smith.name === "claude-apprentice")
        ?.enabled,
    ).toBe(false);
    expect(
      smiths.data?.smiths.find((smith) => smith.name === "claude-journeyman")
        ?.effort,
    ).toBe("high");
    expect(smiths.data?.benches).toEqual(expected.config.benches);
  });

  test("do not read the hearth's own environment: AGENT_FORGE_SMITH there changes nothing", async () => {
    const before = process.env["AGENT_FORGE_SMITH"];
    process.env["AGENT_FORGE_SMITH"] = "claude-apprentice";
    try {
      const h = await start();
      const smiths = await envelope<SmithsView>(await get(h, "/smiths"));
      expect(smiths.data?.defaultSmith).toBe("claude-journeyman");
      const config = await envelope<LoadedConfig>(await get(h, "/config"));
      expect(config.data?.provenance["workflow.default_crew"]?.source).toBe(
        "builtin",
      );
      expect(config.data?.files).toEqual([]);
    } finally {
      if (before === undefined) delete process.env["AGENT_FORGE_SMITH"];
      else process.env["AGENT_FORGE_SMITH"] = before;
    }
  });

  test("a config file that cannot be loaded is an error envelope naming the file, on both routes", async () => {
    const h = await start({
      files: { "agent-forge.toml": '[workflow]\ndefault_crew = "nobody"\n' },
    });
    for (const path of ["/config", "/smiths"]) {
      const response = await get(h, path);
      const body = await envelope(response);
      expect({ path, status: response.status, ok: body.ok }).toEqual({
        path,
        status: 500,
        ok: false,
      });
      expect(body.error).toContain("agent-forge.toml");
      expect(body.error).toContain('unknown smith "nobody"');
    }
  });
});

describe("council runs started through the hearth", () => {
  /** The council events in the ledger, once the run has recorded its end. */
  async function councilEvents(
    h: TestHearth,
    runId: string,
  ): Promise<LedgerEvent[]> {
    const ofRun = (): LedgerEvent[] =>
      h
        .events(["council.run.started", "council.run.finished"])
        .filter(
          (event) =>
            (event.kind === "council.run.started" ||
              event.kind === "council.run.finished") &&
            event.payload.councilRunId === runId,
        );
    for (
      let i = 0;
      i < 400 &&
      !ofRun().some((event) => event.kind === "council.run.finished");
      i++
    )
      await new Promise((done) => setTimeout(done, 25));
    return ofRun();
  }

  test("a hearth given a council ledger records the start and the end, for the bead the request names and nobody it did not", async () => {
    // What a session-attached emitter would pick up: an agent's mirror file in
    // the checkout, and a bead and run in the environment. None of it belongs
    // to a run the operator started from the dashboard.
    const before = {
      bead: process.env["AGENT_FORGE_BEAD_ID"],
      run: process.env["FORGE_SLUG"],
    };
    process.env["AGENT_FORGE_BEAD_ID"] = "bead-from-the-environment";
    process.env["FORGE_SLUG"] = "run-from-the-environment";
    try {
      const h = await start({
        councilRuns: true,
        files: { ".agent-forge-session": "agent-session-in-this-checkout\n" },
      });
      setSessionModel(
        {
          sessionId: "agent-session-in-this-checkout",
          provider: "claude",
          model: "claude-opus-5-5",
        },
        { path: h.ledger },
      );

      const named = await post(h, "/council/runs", {
        ...text("with-bead"),
        beadId: "demo-7",
      });
      expect(named.status).toBe(202);
      const withBead = await councilEvents(h, "with-bead");
      const unnamed = await post(h, "/council-api/runs", text("no-bead"));
      expect(unnamed.status).toBe(202);
      const noBead = await councilEvents(h, "no-bead");

      expect(withBead.map((event) => event.kind)).toEqual([
        "council.run.started",
        "council.run.finished",
      ]);
      expect(noBead.map((event) => event.kind)).toEqual([
        "council.run.started",
        "council.run.finished",
      ]);
      for (const event of withBead) {
        expect(event.workspace).toBe(h.workspace);
        expect(event.beadId).toBe("demo-7");
      }
      for (const event of [...withBead, ...noBead]) {
        expect(event).not.toHaveProperty("sessionId");
        expect(event).not.toHaveProperty("executor");
        expect(event).not.toHaveProperty("runId");
      }
      for (const event of noBead) expect(event).not.toHaveProperty("beadId");
      expect(withBead[1]?.payload).toMatchObject({
        councilRunId: "with-bead",
        outcome: expect.any(String),
      });

      // The audit row names the same run, carries the same bead, and comes first.
      const audit = h.events(["operator.action"]);
      expect(audit.map((event) => [event.payload, event.beadId])).toEqual([
        [
          { action: "council.run.start", surface: "api", target: "with-bead" },
          "demo-7",
        ],
        [
          { action: "council.run.start", surface: "api", target: "no-bead" },
          undefined,
        ],
      ]);
      expect(audit[0]?.id).toBeLessThan(withBead[0]?.id ?? 0);
      expect(audit[1]?.id).toBeLessThan(noBead[0]?.id ?? 0);
    } finally {
      for (const [name, value] of [
        ["AGENT_FORGE_BEAD_ID", before.bead],
        ["FORGE_SLUG", before.run],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 30_000);

  test("a hearth given none (the default) records the operator's action and no council event", async () => {
    const h = await start();
    const response = await post(h, "/council/runs", {
      ...text("unrecorded"),
      beadId: "demo-7",
    });
    expect(response.status).toBe(202);
    await councilRunFinished(h, "unrecorded");
    await new Promise((done) => setTimeout(done, 100));
    expect(h.events().map((event) => event.kind)).toEqual(["operator.action"]);
  }, 20_000);

  test("a run id the caller did not give is minted before the audit row, so the row names the run that starts", async () => {
    const h = await start({ councilRuns: true });
    const response = await post(h, "/council/runs", {
      sourceType: "text",
      source: "Evaluate this plan and record any missing evidence.",
    });
    expect(response.status).toBe(202);
    const job = (await envelope<{ runId: string }>(response)).data;
    expect(job?.runId).toMatch(/^council-\d+-[0-9a-f]{8}$/);
    const [audit] = h.events(["operator.action"]);
    expect(audit?.payload).toMatchObject({ target: job?.runId });
    const events = await councilEvents(h, job?.runId ?? "");
    expect(events[0]?.payload).toMatchObject({ councilRunId: job?.runId });
  }, 20_000);

  test("a wait on a run the hearth refuses to read fails with the status and the refusal, not only the run id", async () => {
    const h = await start();
    await finishedRun(h, "refused-read");
    // With its token file gone the hearth honours no token, so the read is refused.
    rmSync(tokenPath(h.home, h.root));
    const failure = await councilRunFinished(h, "refused-read").then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : null),
    );
    expect(failure).toContain(
      "council run refused-read could not be read: 403",
    );
    expect(failure).toContain(
      "Reading a stored council run needs the operator token of this control plane",
    );
  }, 20_000);
});

describe("what travels from a request into an effect", () => {
  test("a council start hands the service only the fields it knows, whatever else the body holds", async () => {
    const { h, probes } = await probed();
    const response = await fetch(`${h.api}/council/runs`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      // Written out, so `__proto__` is a key of the JSON and not a prototype.
      body: `{"sourceType":"text","source":"Evaluate this.","runId":"only-known","beadId":"demo-7","maxUsd":1,"extra":"nope","nested":{"a":1},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
    });
    expect(response.status).toBe(202);
    const input = probes.at(-1)?.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual([
      "beadId",
      "maxUsd",
      "runId",
      "source",
      "sourceType",
    ]);
    expect(input).toEqual({
      sourceType: "text",
      source: "Evaluate this.",
      runId: "only-known",
      beadId: "demo-7",
      maxUsd: 1,
    });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    await councilRunFinished(h, "only-known");
  }, 20_000);

  test("the queue read gives bd its own time limit; the review's calls keep the runner's", async () => {
    const h = await start({ api: { bdTimeoutMs: 1234 } });
    expect((await get(h, "/queue")).status).toBe(200);
    expect((await post(h, "/dev-api/forge-run/review", REVIEW)).status).toBe(
      200,
    );
    expect(h.bd.calls.map((args) => args[0])).toEqual([
      "list",
      "show",
      "comments",
    ]);
    expect(h.bd.options).toEqual([{ timeoutMs: 1234 }, undefined, undefined]);
  });
});

describe("a bead as the source of a council run started through the hearth", () => {
  /**
   * A hearth whose council start effect only records what it is handed: a bead
   * source would otherwise read the tracker, which no test here may do.
   */
  async function recording(): Promise<{ h: TestHearth; handed: unknown[] }> {
    const handed: unknown[] = [];
    const h = await start({
      api: {
        decorate: (routes) =>
          routes.map((route) =>
            route.kind === "action" && route.action === "council.run.start"
              ? {
                  ...route,
                  effect: (input: unknown) => {
                    handed.push(input);
                    return { status: 202, data: { accepted: true } };
                  },
                }
              : route,
          ),
      },
    });
    return { h, handed };
  }

  test("an id that is not one, an id shaped like a secret, and a beadId that is not exactly the bead under review are refused before anything is recorded or started", async () => {
    const { h, handed } = await recording();
    const refused: Array<[Record<string, unknown>, string]> = [
      [
        { sourceType: "bead", source: "not a bead id" },
        "source must be a Beads issue id when the source is a bead",
      ],
      [
        { sourceType: "bead", source: "--help" },
        "source must be a Beads issue id when the source is a bead",
      ],
      ...[
        "demo-8",
        " demo-7 ",
        "demo-7\n",
        "DEMO-7",
        "demo-7.1",
        "demo",
        // An invisible character after the id, and a digit in its full-width form.
        `demo-7${String.fromCharCode(0x200b)}`,
        `demo-${String.fromCharCode(0xff17)}`,
      ].map((beadId): [Record<string, unknown>, string] => [
        { sourceType: "bead", source: "demo-7", beadId },
        "beadId must name the bead under review when the source is a bead",
      ]),
      [
        // Twenty characters shaped like an access key id are a valid id by form.
        { sourceType: "bead", source: ["AKIA", "ZQ9ZQ8ZQ7ZQ6ZQ5Z"].join("") },
        "beadId must be a Beads issue id",
      ],
    ];
    for (const [body, message] of refused) {
      const response = await post(h, "/council/runs", body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect((await envelope(response)).error).toBe(message);
    }
    expect(handed).toEqual([]);
    expect(h.events()).toEqual([]);
  });

  test("a bead job through the hearth's own effect and council ledger packs the bead with the hearth's command runner, runs only the two read-only reads, and records the audit row, the start and the end against the bead", async () => {
    const h = await start({ councilRuns: true });
    h.commands.answer = beadReads("demo-7", ["worklog: sensor wired."]);
    const response = await post(h, "/council/runs", {
      sourceType: "bead",
      source: "demo-7",
      runId: "bead-job",
    });
    expect(response.status).toBe(202);
    const recorded = await councilEventsOf(h, "bead-job");
    await councilRunFinished(h, "bead-job");
    const job = await envelope<{
      status: string;
      run?: { context: { source: { kind: string; locator: string } } };
    }>(await readRuns(h, "/bead-job"));
    expect(job.data?.status).toBe("completed");
    expect(job.data?.run?.context.source).toMatchObject({
      kind: "bead",
      locator: "demo-7",
    });
    expect(
      h.commands.calls.map(({ command }) => command.slice(0, 3).join(" ")),
    ).toEqual(["bd --readonly show", "bd --readonly comments"]);
    // The API's own bd is not the council's: the job's reads never reached it.
    // The one call it was given is the verdict posted back to the bead
    // (`routes/council-verdict.test.ts` holds what each end of a run posts).
    expect(h.bd.calls.map((call) => call.slice(0, 5))).toEqual([
      ["comments", "add", "--json", "--", "demo-7"],
    ]);
    const audit = h.events(["operator.action"]);
    expect(
      [...audit, ...recorded].map((event) => [event.kind, event.beadId]),
    ).toEqual([
      ["operator.action", "demo-7"],
      ["council.run.started", "demo-7"],
      ["council.run.finished", "demo-7"],
    ]);
  }, 20_000);

  test("a test hearth runs no command for the council that its test did not arrange: a bead job fails with the refusal, and no bd is started", async () => {
    const h = await start();
    const response = await post(h, "/council/runs", {
      sourceType: "bead",
      source: "demo-7",
      runId: "bead-refused",
    });
    expect(response.status).toBe(202);
    await councilRunFinished(h, "bead-refused");
    const job = await envelope<{ status: string; error?: string }>(
      await readRuns(h, "/bead-refused"),
    );
    expect(job.data?.status).toBe("failed");
    expect(job.data?.error).toContain("bd --readonly show failed");
    expect(
      h.commands.calls.map(({ command }) => command.slice(0, 3).join(" ")),
    ).toEqual(["bd --readonly show"]);
    expect(h.bd.calls).toEqual([]);
  }, 20_000);

  test("a hearth whose root is a linked worktree runs the council's bd in the main checkout, as its own bd runner does, and git in its root", async () => {
    const h = await start({ linkedWorktree: true });
    expect(h.main).toBeDefined();
    h.commands.answer = beadReads("demo-7", [
      "see https://github.com/demo-org/kiln-works/pull/12",
    ]);
    const response = await post(h, "/council/preview", {
      sourceType: "bead",
      source: "demo-7",
    });
    // The pull request itself is not arranged: its capture fails, which is a note.
    expect(response.status).toBe(200);
    const where = h.commands.calls.map(({ command, cwd }) => [
      command.slice(0, 2).join(" "),
      resolve(cwd),
    ]);
    // The bead's forge run is looked for in every worktree git lists
    // (x1gs.7.5): that listing is asked for in the root too.
    expect(where.slice(0, 4)).toEqual([
      ["bd --readonly", resolve(h.main ?? "")],
      ["bd --readonly", resolve(h.main ?? "")],
      ["git worktree", resolve(h.root)],
      ["git remote", resolve(h.root)],
    ]);
    for (const [command, cwd] of where.slice(4))
      expect({ command, cwd }).toEqual({ command, cwd: resolve(h.root) });
  }, 20_000);

  test("a preview answers what a run would send, audited against the bead, and refuses as a start refuses", async () => {
    const h = await start();
    h.commands.answer = beadReads("demo-7", ["worklog: sensor wired."]);
    const response = await post(h, "/council/preview", {
      sourceType: "bead",
      source: " demo-7\n",
      // A start's fields that do not change a pack are not refused, and not used.
      runId: "never-started",
      maxUsd: 1,
    });
    expect(response.status).toBe(200);
    const preview = (await envelope<CouncilPreview>(response)).data;
    expect(preview?.source).toEqual({
      kind: "bead",
      displayName: "demo-7: Teach the kiln to report its temperature",
      locator: "demo-7",
    });
    expect(preview?.listing).toEqual([
      expect.stringMatching(/^E1 acceptance criteria: \d+ bytes$/),
      expect.stringMatching(/^E2 latest comments: 1 comment, \d+ bytes$/),
      "description: none",
    ]);
    expect(
      h
        .events(["operator.action"])
        .map((event) => [event.payload, event.beadId]),
    ).toEqual([
      [
        { action: "council.run.preview", surface: "api", target: "demo-7" },
        "demo-7",
      ],
    ]);
    const runs = await readRuns(h);
    expect((await envelope<unknown[]>(runs)).data).toEqual([]);

    // A bd that refuses is the preview's answer, in the service's words.
    h.commands.answer = null;
    const refused = await post(h, "/council/preview", {
      sourceType: "bead",
      source: "demo-7",
    });
    expect(refused.status).toBe(400);
    expect((await envelope(refused)).error).toContain(
      "bd --readonly show failed",
    );
    for (const [body, message] of [
      [
        { sourceType: "bead", source: "demo-7", beadId: "demo-8" },
        "beadId must name the bead under review when the source is a bead",
      ],
      [{ sourceType: "nope", source: "x" }, "source must be a nonempty"],
    ] as const) {
      const answer = await post(h, "/council/preview", body);
      expect(answer.status).toBe(400);
      expect((await envelope(answer)).error).toContain(message);
    }
  }, 20_000);

  test("an accepted bead source is audited against its bead and handed to the route's effect with it, whether or not the caller repeated the id or wrote space around it", async () => {
    const { h, handed } = await recording();
    for (const [runId, body] of [
      ["bead-plain", { sourceType: "bead", source: "demo-7" }],
      [
        "bead-named",
        { sourceType: "bead", source: "demo-7", beadId: "demo-7" },
      ],
      ["bead-spaced", { sourceType: "bead", source: " demo-7\n" }],
      [
        "bead-spaced-named",
        { sourceType: "bead", source: " demo-7\n", beadId: "demo-7" },
      ],
    ] as const) {
      const response = await post(h, "/council-api/runs", { ...body, runId });
      expect({ runId, status: response.status }).toEqual({
        runId,
        status: 202,
      });
    }
    expect(handed).toEqual([
      {
        sourceType: "bead",
        source: "demo-7",
        runId: "bead-plain",
        beadId: "demo-7",
      },
      {
        sourceType: "bead",
        source: "demo-7",
        runId: "bead-named",
        beadId: "demo-7",
      },
      {
        sourceType: "bead",
        source: " demo-7\n",
        runId: "bead-spaced",
        beadId: "demo-7",
      },
      {
        sourceType: "bead",
        source: " demo-7\n",
        runId: "bead-spaced-named",
        beadId: "demo-7",
      },
    ]);
    const audits = h.events(["operator.action"]);
    expect(audits.map((event) => [event.payload, event.beadId])).toEqual([
      [
        expect.objectContaining({
          action: "council.run.start",
          target: "bead-plain",
        }),
        "demo-7",
      ],
      [
        expect.objectContaining({
          action: "council.run.start",
          target: "bead-named",
        }),
        "demo-7",
      ],
      [
        expect.objectContaining({
          action: "council.run.start",
          target: "bead-spaced",
        }),
        "demo-7",
      ],
      [
        expect.objectContaining({
          action: "council.run.start",
          target: "bead-spaced-named",
        }),
        "demo-7",
      ],
    ]);
  });
});
