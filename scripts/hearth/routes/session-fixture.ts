import { randomUUID } from "node:crypto";
import type { ConversationPhase } from "../../../types/conversation";
import type { OwnedSessionRecord } from "../../../types/owned-session";
import type { SessionTurnSnapshot } from "../../../types/session-turn";
import { createConversationStore } from "../../conversations/store";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import type { GitRun } from "../../scheduler/worktrees";
import type { SessionRuntime } from "../../sessions/admission";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../../sessions/registry";
import type { TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

export const FIXTURE_OWNED_SESSION_ID =
  "session-2d5ed741-5528-424c-a927-263348778dad";
export const FIXTURE_OWNED_STOP_ID =
  "session-9850366a-7edc-461c-a09f-cbd2f7928d61";
export const FIXTURE_SESSION_START = "18da5c95-3218-439c-a33d-e5662465f505";
export const FIXTURE_SESSION_SEND = "7581102c-331c-449a-905e-9eef632f9ff3";
export const FIXTURE_SESSION_STOP = "d1795991-294a-4fd2-8d15-5939195232e8";
export const FIXTURE_SESSION_PROMPT = "Private coding fixture request";
export const FIXTURE_SESSION_REPLY = "Fixture coding reply.";
export const fixtureSessionFlags = [
  "--print",
  "--input-format",
  "--output-format",
  "--verbose",
  "--include-partial-messages",
  "--model",
  "--permission-mode",
  "--permission-prompts",
  "--allowedTools",
  "--resume",
];

/** Trusted fake only: no executable, credential, provider or network is used. */
export function fakeSessionRuntime() {
  const prepared: SessionTurnSnapshot[] = [];
  const runs: Array<Parameters<SessionRuntime["run"]>[0]> = [];
  const runtime: SessionRuntime = {
    provider: "claude",
    async prepare(input) {
      const snapshot: SessionTurnSnapshot = {
        version: 1,
        provider: "claude",
        smith: input.smith,
        cwd: input.cwd,
        launch: structuredClone(input.launch),
        capabilities: { version: "2.1.296", flags: fixtureSessionFlags },
      };
      prepared.push(snapshot);
      return snapshot;
    },
    async run(request, persist, signal) {
      runs.push(request);
      await persist({
        kind: "process",
        pid: 2_000_000_000,
        smith: request.input.session?.smith ?? "fixture",
        requestedModel: request.input.session?.launch.model ?? "fixture",
        requestedEffort: request.input.session?.launch.effort ?? "default",
      });
      await persist({
        kind: "identity",
        provider: "claude",
        sessionId: request.resume?.sessionId ?? randomUUID(),
        version: "2.1.296",
      });
      await persist({ kind: "model", model: "fixture-coding-model" });
      await persist({ kind: "text", text: FIXTURE_SESSION_REPLY });
      if (request.input.text === "Wait for Stop") {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return { phase: "completed", reason: null };
    },
  };
  return { runtime, prepared, runs };
}

export const fixtureSessionGit: GitRun = (args, cwd) => {
  const root = cwd.replaceAll("\\", "/");
  if (args[0] === "rev-parse")
    return { status: 0, stdout: `${root}\n`, stderr: "" };
  if (args[0] === "worktree")
    return {
      status: 0,
      stdout: [
        `worktree ${root}`,
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "",
      ].join("\0"),
      stderr: "",
    };
  return { status: 1, stdout: "", stderr: "Unarranged fixture git command" };
};

export function sessionStartFixture(
  h: TestHearth,
  requestId = FIXTURE_SESSION_START,
) {
  return {
    requestId,
    smith: "claude-journeyman",
    repository: h.workspace,
    worktree: h.workspace,
    launch: {
      mode: "chat" as const,
      model: "sonnet",
      prompt: FIXTURE_SESSION_PROMPT,
    },
  };
}

/** Plant private historical state without an operator action or a ledger append. */
export async function seedOwnedSession(h: TestHearth, stop = false) {
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const id = stop ? FIXTURE_OWNED_STOP_ID : FIXTURE_OWNED_SESSION_ID;
  const registry = createSessionRegistry(h.home);
  let record = registry.list(FIXTURE_PROJECT_ID).find((item) => item.id === id);
  if (!record) {
    record = {
      projectId: FIXTURE_PROJECT_ID,
      id,
      requestId: stop ? FIXTURE_SESSION_STOP : randomUUID(),
      requestHash: (stop ? "b" : "a").repeat(64),
      createdAt: "2026-10-23T03:00:00.000Z",
      mode: "chat",
      provider: "claude",
      workspace: h.workspace,
      repository: h.workspace,
      worktree: h.workspace,
      smith: "claude-journeyman",
      requestedModel: "sonnet",
      requestedEffort: null,
    };
    writeOwnerOnly(
      sessionRegistryFile(h.home),
      JSON.stringify({
        version: 1,
        records: [...registry.list(FIXTURE_PROJECT_ID), record],
      }),
    );
  }
  const store = createConversationStore(h.home, undefined, {
    kind: "session",
    projectId: FIXTURE_PROJECT_ID,
    sessionId: id,
  });
  if (!store.read(FIXTURE_PROJECT_ID).turns.length) {
    const requestId = record.requestId;
    await store.accept(FIXTURE_PROJECT_ID, {
      requestId,
      expectedRevision: 0,
      text: "Historical private fixture",
      about: [],
      session: {
        version: 1,
        provider: "claude",
        smith: record.smith,
        cwd: h.workspace,
        launch: {
          mode: "chat",
          model: "sonnet",
          prompt: "Historical private fixture",
          context: {
            projectId: FIXTURE_PROJECT_ID,
            repository: h.workspace,
            worktree: h.workspace,
            about: [],
          },
        },
        capabilities: { version: "2.1.296", flags: fixtureSessionFlags },
      },
    });
    if (!stop) {
      const owner = randomUUID();
      await store.start(FIXTURE_PROJECT_ID, requestId, owner);
      await store.append(FIXTURE_PROJECT_ID, requestId, owner, {
        kind: "identity",
        provider: "claude",
        sessionId: randomUUID(),
        version: "2.1.296",
      });
      await store.finish(
        FIXTURE_PROJECT_ID,
        requestId,
        owner,
        "completed",
        null,
      );
    }
  }
  return record;
}

export async function waitOwnedTurn(
  h: TestHearth,
  session: OwnedSessionRecord,
  requestId: string,
  terminal: ConversationPhase[] = [
    "completed",
    "cancelled",
    "failed",
    "unknown",
  ],
) {
  const store = createConversationStore(h.home, undefined, {
    kind: "session",
    projectId: session.projectId,
    sessionId: session.id,
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const turn = store
      .read(session.projectId)
      .turns.find((item) => item.requestId === requestId);
    if (turn && terminal.includes(turn.phase)) return turn;
    if (Date.now() >= deadline)
      throw new Error("The fixture owned turn did not settle.");
    await Bun.sleep(5);
  }
}
