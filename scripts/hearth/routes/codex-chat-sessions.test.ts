import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  CodexChatDecisionRequest,
  CodexChatStartRequest,
} from "../../../types/codex-owned-chat";
import { conversationFile } from "../../conversations/paths";
import { createConversationStore } from "../../conversations/store";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { codexChatApprovalPageSchema } from "../../sessions/codex-chat-owned-protocol";
import { codexChatPreviewReceiptSchema } from "../../sessions/codex-chat-preview-protocol";
import { createCodexChatRuntime } from "../../sessions/codex-chat-runtime";
import { ownedCodingPageSchema } from "../../sessions/codex-owned-journal";
import { ownedCodingStartReceiptSchema } from "../../sessions/codex-owned-wire-protocol";
import {
  codexChatForkIdentityMetadataSchema,
  sessionOperationIdentityPageSchema,
} from "../../sessions/session-operation-identities-protocol";
import { expectStartIdentityState } from "../../sessions/session-start-identity-test-witness";
import { scratchDirs } from "../../test-scratch";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { fixtureSessionGit } from "./session-fixture";

const opened: TestHearth[] = [],
  releaseHeld: Array<() => void> = [];
const binaries = scratchDirs();
let command: string;
beforeAll(() => {
  const folder = binaries.make("codex-chat-http-binary-");
  command = join(
    folder,
    process.platform === "win32" ? "inert-codex.exe" : "inert-codex",
  );
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(import.meta.dir, "../../sessions/fixtures/codex-app-server-cli.ts"),
      "--compile",
      "--outfile",
      command,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  if (built.exitCode !== 0)
    throw Error("Could not compile the inert Chat provider");
}, 35_000);
afterAll(() => binaries.cleanup());
function alive(pid: number) {
  try {
    if (
      process.platform === "linux" &&
      /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    )
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
afterEach(async () => {
  for (const release of releaseHeld.splice(0)) release();
  for (const h of opened.splice(0).reverse()) await h.close();
});
async function fixture(
  mode = "approval-command",
  holdDecision = false,
  holdForkReply = false,
  approvalPolicy: "never" | "on-request" = "on-request",
) {
  let h: TestHearth,
    actual: ReturnType<typeof createCodexChatRuntime> | undefined;
  let activeStartInput: unknown;
  const selected = () => {
    if (!actual) throw Error("No planted native Chat runtime");
    return actual;
  };
  let release: () => void = () => {},
    held = false;
  let releaseForkReply: () => void = () => {},
    markForkEffectReached: () => void = () => {},
    markForkReplyReleased: () => void = () => {},
    forkReplyHeld = false;
  const answerGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const forkReplyGate = new Promise<void>((resolve) => {
    releaseForkReply = resolve;
  });
  const forkEffectReached = new Promise<void>((resolve) => {
    markForkEffectReached = resolve;
  });
  const forkReplyReleased = new Promise<void>((resolve) => {
    markForkReplyReleased = resolve;
  });
  releaseHeld.push(release);
  releaseHeld.push(releaseForkReply);
  h = await startTestHearth({
    files: {
      "agent-forge.toml":
        '[execution.env]\npass = ["CODEX_CHAT_LOG", "CODEX_CHAT_MODE"]\n',
    },
    api: {
      git: fixtureSessionGit,
      codexChatRuntime: {
        async check(input) {
          const event = h.events(["operator.action"]).at(-1);
          if (
            activeStartInput !== undefined &&
            event?.kind === "operator.action" &&
            event.payload.action === "session.start"
          )
            await expectStartIdentityState(
              h.home,
              FIXTURE_PROJECT_ID,
              h.workspace,
              activeStartInput,
              "attempted",
            );
          return selected().check(input);
        },
        async prepare(input) {
          const event = h.events(["operator.action"]).at(-1);
          expect(
            event?.kind === "operator.action" &&
              [
                "session.start",
                "session.turn.send",
                "session.fork.turn",
                "session.preview",
              ].includes(event.payload.action),
          ).toBe(true);
          if (
            activeStartInput !== undefined &&
            event?.kind === "operator.action" &&
            event.payload.action === "session.start"
          )
            await expectStartIdentityState(
              h.home,
              FIXTURE_PROJECT_ID,
              h.workspace,
              activeStartInput,
              "attempted",
            );
          return selected().prepare(input);
        },
        fork: (input) => selected().fork(input),
        run: (input, persist, signal, callbacks) =>
          selected().run(input, persist, signal, callbacks),
      },
      decorate: (routes) =>
        routes.map((route) =>
          route.kind === "action" && route.action === "session.fork"
            ? {
                ...route,
                effect: async (input, context) => {
                  const result = await route.effect(input, context);
                  if (
                    holdForkReply &&
                    !forkReplyHeld &&
                    result.status === 200
                  ) {
                    forkReplyHeld = true;
                    markForkEffectReached();
                    await forkReplyGate;
                    markForkReplyReleased();
                  }
                  return result;
                },
              }
            : route.kind === "action" &&
                route.action === "session.approval.decide"
              ? {
                  ...route,
                  effect: async (input, context) => {
                    const result = await route.effect(input, context);
                    if (holdDecision && !held && result.status === 200) {
                      held = true;
                      await answerGate;
                    }
                    return result;
                  },
                }
              : route,
        ),
    },
  });
  opened.push(h);
  const log = join(h.root, "codex-chat.jsonl");
  actual = createCodexChatRuntime({
    root: h.root,
    home: h.home,
    configHome: h.configHome,
    command: [command],
    syncCommand: [command, "--sync"],
    environment: { ...process.env, CODEX_CHAT_LOG: log, CODEX_CHAT_MODE: mode },
    ...(mode === "fork-service-tier-priority"
      ? {
          modelEfforts: [
            {
              model: "exact-model",
              efforts: ["medium"],
              source: "model/list",
              cliVersion: "0.163.0-alpha.10.2",
              asOf: "2026-10-23T00:00:00.000Z",
            },
          ],
        }
      : {}),
    timeoutMs: mode === "fork-child-lost-turn-reply" ? 2_000 : 8_000,
    approvalTimeoutMs: 6000,
  });
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const request: CodexChatStartRequest = {
    provider: "codex",
    requestId: randomUUID(),
    smith: "codex-journeyman",
    repository: h.workspace,
    worktree: h.workspace,
    launch: {
      mode: "chat",
      model: "exact-model",
      sandbox: "workspace-write",
      approvalPolicy,
      prompt: "PRIVATE-CHAT-PROMPT",
      attachments: [
        { kind: "text", name: "context.txt", text: "PRIVATE-CHAT-CONTEXT" },
      ],
    },
  };
  activeStartInput = request;
  const path = `/projects/${FIXTURE_PROJECT_ID}/sessions`;
  const post = (
    suffix: string,
    body: unknown,
    headers = h.headers(h.hearth.token),
    signal?: AbortSignal,
  ) =>
    fetch(`${h.api}${path}${suffix}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  const get = async (suffix: string) => {
    const response = await fetch(`${h.api}${path}${suffix}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(200);
    return (await response.json()).data;
  };
  const page = async (id: string) =>
    ownedCodingPageSchema.parse(await get(`/${id}`));
  const forkPage = async (id: string) => {
    const response = await fetch(`${h.api}${path}/${id}/fork-turns`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(200);
    return ownedCodingPageSchema.parse((await response.json()).data);
  };
  const waitApproval = async (id: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const data = codexChatApprovalPageSchema.parse(
        await get(`/${id}/approvals`),
      );
      const pending = data.pending[0];
      if (pending) return pending;
      if (Date.now() > deadline)
        throw Error("Native approval never became actionable");
      await Bun.sleep(20);
    }
  };
  const settle = async (id: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const data = await page(id);
      if (
        data.turns.every(
          (turn) => !["accepted", "running", "cancelling"].includes(turn.phase),
        )
      )
        return data;
      if (Date.now() > deadline) throw Error("Owned Chat did not settle");
      await Bun.sleep(20);
    }
  };
  const settleFork = async (id: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const data = await forkPage(id);
      if (
        data.turns.every(
          (turn) => !["accepted", "running", "cancelling"].includes(turn.phase),
        )
      )
        return data;
      if (Date.now() > deadline)
        throw Error("The owned Fork-child turn did not settle");
      await Bun.sleep(20);
    }
  };
  const records = (): Record<string, unknown>[] => {
    if (!existsSync(log)) return [];
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw Error("Invalid completed native fixture recording");
    }
  };
  return {
    h,
    request,
    post,
    get,
    page,
    forkPage,
    waitApproval,
    settle,
    settleFork,
    records,
    release,
    held: () => held,
    forkEffectReached,
    releaseForkReply,
    forkReplyReleased,
  };
}

test("an explicit Chat preview checks native capabilities without starting a conversation, sync or session reservation", async () => {
  const f = await fixture();
  const response = await f.post("/preview", f.request);
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  expect(codexChatPreviewReceiptSchema.safeParse(envelope.data).success).toBe(
    true,
  );
  expect(envelope.data).toMatchObject({
    provider: "codex",
    mode: "chat",
    projectId: FIXTURE_PROJECT_ID,
    requestId: f.request.requestId,
    snapshot: {
      smith: f.request.smith,
      cwd: f.request.worktree,
      launch: { mode: "chat", approvalPolicy: "on-request" },
    },
    serialized: { argv: ["app-server", "--stdio"] },
  });
  expect(envelope.data.serialized.input.text).toContain("PRIVATE-CHAT-PROMPT");
  expect(envelope.data.serialized.input.text).toContain("PRIVATE-CHAT-CONTEXT");
  expect(envelope.data.serialized.equivalentCommand).not.toContain("PRIVATE-");
  expect(envelope.data.serialized.stdinNote).toContain("handshake");
  expect(f.records().map((record) => record.kind)).toEqual(["version", "help"]);
  expect(await f.get("")).toEqual([]);
  expect(
    f.h
      .events(["operator.action"])
      .map((event) =>
        event.kind === "operator.action" ? event.payload.action : null,
      ),
  ).toEqual(["session.preview"]);
});

test("protected HTTP Chat with a compiled native provider preserves two turns and reconciles a lost decision answer without another effect", async () => {
  const f = await fixture("approval-command", true);
  expect((await f.post("", f.request, f.h.headers(null))).status).toBe(403);
  expect(f.records()).toEqual([]);
  const response = await f.post("", f.request),
    started = ownedCodingStartReceiptSchema.parse((await response.json()).data);
  expect(response.status).toBe(202);
  await expectStartIdentityState(
    f.h.home,
    FIXTURE_PROJECT_ID,
    f.h.workspace,
    f.request,
    "admitted",
  );
  const id = started.session.id,
    pending = await f.waitApproval(id);
  expect(pending.actionable).toBe(true);
  const beforeDuplicateStart = JSON.stringify(f.records());
  const duplicateStart = await f.post("", f.request);
  expect(duplicateStart.status).toBe(202);
  expect(
    ownedCodingStartReceiptSchema.parse((await duplicateStart.json()).data)
      .session.id,
  ).toBe(started.session.id);
  expect(JSON.stringify(f.records())).toBe(beforeDuplicateStart);
  await expectStartIdentityState(
    f.h.home,
    FIXTURE_PROJECT_ID,
    f.h.workspace,
    f.request,
    "admitted",
  );
  expect(pending.approval).not.toHaveProperty("nativeRequestId");
  expect(
    (
      await fetch(
        `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${id}/approvals`,
        { headers: f.h.headers(null) },
      )
    ).status,
  ).toBe(403);
  const request: CodexChatDecisionRequest = {
    requestId: randomUUID(),
    approvalId: pending.approval.id,
    turnRequestId: pending.turnRequestId,
    decision: "accept",
  };
  const before = f.h.events(["operator.action"]).length;
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        ...request,
        nativeRequestId: 1,
      })
    ).status,
  ).toBe(400);
  expect(f.h.events(["operator.action"])).toHaveLength(before);
  const abort = new AbortController(),
    held = f
      .post(
        `/${id}/approval-decisions`,
        request,
        f.h.headers(f.h.hearth.token),
        abort.signal,
      )
      .catch(() => null);
  const deadline = Date.now() + 4000;
  while (!f.held()) {
    if (Date.now() > deadline)
      throw Error("Decision response was not held after admission");
    await Bun.sleep(20);
  }
  const original = await f.get(
    `/${id}/approvals?requestId=${request.requestId}`,
  );
  expect(original.pending).toEqual([]);
  expect(original.receipt.state).toBe("recorded");
  abort.abort();
  f.release();
  await held;
  const retried = await f.post(`/${id}/approval-decisions`, request);
  expect(retried.status).toBe(200);
  expect((await retried.json()).data).toEqual(original.receipt);
  let page = await f.settle(id);
  expect(page.turns[0]?.phase).toBe("completed");
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(1);
  const secondId = randomUUID();
  expect(
    (
      await f.post(`/${id}/turns`, {
        requestId: secondId,
        expectedRevision: page.revision,
        text: "PRIVATE-CHAT-SECOND",
        about: [],
      })
    ).status,
  ).toBe(202);
  const second = await f.waitApproval(id);
  // A historical receipt lookup must never smuggle a different current callback
  // past fresh scope validation, even while the original receipt stays readable.
  const archivedCatalog = projectCatalogFixture(f.h.workspace),
    selectedProject = archivedCatalog.projects[0];
  if (!selectedProject) throw Error("No planted project");
  selectedProject.archived = true;
  writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(archivedCatalog));
  const receiptOnly = codexChatApprovalPageSchema.parse(
    await f.get(`/${id}/approvals?requestId=${request.requestId}`),
  );
  expect(receiptOnly).toEqual({ pending: [], receipt: original.receipt });
  expect(
    codexChatApprovalPageSchema.parse(
      await f.get(`/${id}/approvals?requestId=${randomUUID()}`),
    ),
  ).toEqual({ pending: [], receipt: null });
  expect(
    (
      await fetch(
        `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${id}/approvals`,
        { headers: f.h.headers(f.h.hearth.token) },
      )
    ).status,
  ).toBe(409);
  expect((await f.post(`/${id}/approval-decisions`, request)).status).toBe(200);
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(1);
  selectedProject.archived = false;
  writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(archivedCatalog));
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        requestId: randomUUID(),
        approvalId: second.approval.id,
        turnRequestId: secondId,
        decision: "decline",
      })
    ).status,
  ).toBe(200);
  page = await f.settle(id);
  expect(page.turns.map((turn) => turn.phase)).toEqual([
    "completed",
    "completed",
  ]);
  expect(
    f.records().filter((row) => row.method === "thread/resume"),
  ).toHaveLength(1);
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(2);
  expect(JSON.stringify(f.h.events())).not.toContain("PRIVATE-CHAT");
  expect(JSON.stringify(f.h.events())).not.toContain("nativeRequestId");
  expect(JSON.stringify(await f.get(""))).not.toContain("PRIVATE-CHAT");
});

test("Stop invalidates a protected native approval and confirms cleanup of the actual compiled provider tree", async () => {
  const f = await fixture("approval-never");
  const response = await f.post("", f.request);
  expect(response.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await response.json()).data,
    ),
    id = started.session.id;
  const pending = await f.waitApproval(id);
  expect(
    (await f.post(`/${id}/stop`, { requestId: f.request.requestId })).status,
  ).toBe(200);
  const page = await f.settle(id);
  expect(page.turns[0]?.phase).toBe("cancelled");
  expect((await f.get(`/${id}/approvals`)).pending).toEqual([]);
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        requestId: randomUUID(),
        approvalId: pending.approval.id,
        turnRequestId: pending.turnRequestId,
        decision: "accept",
      })
    ).status,
  ).toBe(409);
  const tree = f.records().find((row) => row.kind === "tree");
  if (typeof tree?.pid !== "number" || typeof tree.childPid !== "number")
    throw Error("No actual native fixture tree");
  const pids = [tree.pid, tree.childPid],
    deadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(10);
  expect(pids.map(alive)).toEqual([false, false]);
  expect(f.records().filter((row) => row.kind === "answer")).toEqual([]);
});

test("file Allow stays unavailable without actual diffs, current/foreign scope refuses effects, and explicit native cancel is preserved", async () => {
  const f = await fixture("approval-file"),
    response = await f.post("", f.request),
    started = ownedCodingStartReceiptSchema.parse((await response.json()).data),
    id = started.session.id;
  const pending = await f.waitApproval(id);
  expect(pending.approval.availableDecisions).toEqual(["decline", "cancel"]);
  expect(pending.detailsUnavailableReason).toBe(
    "Actual file-change details are unavailable. Allow is disabled.",
  );
  const request: CodexChatDecisionRequest = {
    requestId: randomUUID(),
    approvalId: pending.approval.id,
    turnRequestId: pending.turnRequestId,
    decision: "accept",
  };
  expect((await f.post(`/${id}/approval-decisions`, request)).status).toBe(409);
  expect(f.records().filter((row) => row.kind === "answer")).toEqual([]);
  const foreign = await fetch(
    `${f.h.api}/projects/project-${randomUUID()}/sessions/${id}/approval-decisions`,
    {
      method: "POST",
      headers: f.h.headers(f.h.hearth.token),
      body: JSON.stringify({ ...request, decision: "decline" }),
    },
  );
  expect(foreign.status).toBe(409);
  const catalog = projectCatalogFixture(f.h.workspace),
    project = catalog.projects[0];
  if (!project) throw Error("No planted project");
  project.archived = true;
  writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(catalog));
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        ...request,
        decision: "decline",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await fetch(
        `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${id}/approvals`,
        { headers: f.h.headers(f.h.hearth.token) },
      )
    ).status,
  ).toBe(409);
  expect(f.records().filter((row) => row.kind === "answer")).toEqual([]);
  project.archived = false;
  writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(catalog));
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        ...request,
        decision: "cancel",
      })
    ).status,
  ).toBe(200);
  const page = await f.settle(id);
  expect(page.turns[0]?.phase).toBe("failed");
  expect(
    f
      .records()
      .filter((row) => row.kind === "answer")
      .map((row) => row.result),
  ).toEqual([{ decision: "cancel" }]);
  expect((await f.get(`/${id}/approvals`)).pending).toEqual([]);
});

test("a linked Codex Fork child accepts a turn through its dedicated action", async () => {
  for (const [mode, expectedTier] of [
    ["fork-service-tier-null", null],
    ["fork-service-tier-priority", "priority"],
  ] as const) {
    const f = await fixture(mode, false, false, "never"),
      start = await f.post("", f.request);
    expect(start.status).toBe(202);
    const started = ownedCodingStartReceiptSchema.parse(
        (await start.json()).data,
      ),
      parentSessionId = started.session.id,
      completed = await f.settle(parentSessionId),
      selectedTurn = completed.turns.find(
        (turn) => turn.requestId === f.request.requestId,
      );
    if (!selectedTurn)
      throw Error("The never-policy Fork source turn did not settle");

    const forkRequest = {
        requestId: randomUUID(),
        throughTurnRequestId: selectedTurn.requestId,
      },
      forkResponse = await f.post(`/${parentSessionId}/forks`, forkRequest),
      forkEnvelope = await forkResponse.json();
    expect(forkResponse.status).toBe(200);
    expect(forkEnvelope.data.state).toBe("linked");
    const childSessionId = forkEnvelope.data.childSessionId;
    if (typeof childSessionId !== "string")
      throw Error("The native Fork child was not linked to an app session");
    const unauthenticatedRead = await fetch(
      `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${childSessionId}/fork-turns`,
    );
    expect(unauthenticatedRead.status).toBe(403);

    const childTurnInput = {
      requestId: randomUUID(),
      expectedRevision: 0,
      text: "A new child-authored request.",
      about: [],
    };
    for (const collidingId of [forkRequest.requestId, selectedTurn.requestId])
      expect(
        (
          await f.post(`/${childSessionId}/fork-turns`, {
            ...childTurnInput,
            requestId: collidingId,
          })
        ).status,
      ).toBe(409);
    const contenders = [
        childTurnInput,
        {
          requestId: randomUUID(),
          expectedRevision: 0,
          text: "A competing child-authored request.",
          about: [],
        },
      ],
      outcomes = await Promise.all(
        contenders.map((input) =>
          f.post(`/${childSessionId}/fork-turns`, input),
        ),
      );
    expect(outcomes.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);
    const winnerIndex = outcomes.findIndex(
        (response) => response.status === 202,
      ),
      winner = contenders[winnerIndex];
    if (!winner) throw Error("No Fork-child turn won the admission race");
    const childPage = await f.settleFork(childSessionId);
    expect((await f.post(`/${childSessionId}/fork-turns`, winner)).status).toBe(
      202,
    );
    expect(
      (
        await f.post(`/${childSessionId}/fork-turns`, {
          ...winner,
          text: "Conflicting replay content.",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.post(`/${childSessionId}/fork-turns`, {
          requestId: randomUUID(),
          expectedRevision: 0,
          text: "A stale revision must not dispatch.",
          about: [],
        })
      ).status,
    ).toBe(409);
    const refreshedChildPage = await f.forkPage(childSessionId),
      records = f.records(),
      resumes = records.filter((row) => row.method === "thread/resume"),
      starts = records.filter((row) => row.method === "thread/start"),
      turns = records.filter((row) => row.method === "turn/start");
    expect(childPage.turns.map((turn) => turn.phase)).toEqual(["completed"]);
    expect(refreshedChildPage.turns).toHaveLength(1);
    expect(JSON.stringify(refreshedChildPage)).not.toContain(
      "PRIVATE-CHAT-PROMPT",
    );
    expect(JSON.stringify(refreshedChildPage)).not.toContain(
      "PRIVATE-CHAT-CONTEXT",
    );
    for (const privateSourceField of [
      "sourceSeal",
      "parentNativeThreadId",
      "throughNativeTurnId",
      "captureHash",
    ])
      expect(JSON.stringify(refreshedChildPage)).not.toContain(
        privateSourceField,
      );
    expect(starts).toHaveLength(1);
    expect(records.filter((row) => row.method === "thread/fork")).toHaveLength(
      1,
    );
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.params).toMatchObject({
      threadId: "0199a213-81c0-7800-8aa1-bbab2a035a55",
      excludeTurns: true,
      modelProvider: "openai",
      serviceTier: expectedTier,
    });
    expect(turns).toHaveLength(2);
    const childTurnRpc = (turns[1]?.params ?? {}) as Record<string, unknown>;
    expect(childTurnRpc).toMatchObject({
      threadId: "0199a213-81c0-7800-8aa1-bbab2a035a55",
      ...(mode === "fork-service-tier-priority" ? { effort: "medium" } : {}),
    });
    expect(JSON.stringify(childTurnRpc.input)).toContain(winner.text);
    expect(JSON.stringify(childTurnRpc.input)).not.toContain(
      f.request.launch.prompt,
    );
  }
});

test("Fork children with on-request policy refuse before accepting a turn", async () => {
  const f = await fixture("fork-service-tier-null"),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    completed = await f.settle(started.session.id),
    selectedTurn = completed.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn) throw Error("The parent source turn did not settle");
  const fork = await f.post(`/${started.session.id}/forks`, {
      requestId: randomUUID(),
      throughTurnRequestId: selectedTurn.requestId,
    }),
    forkData = (await fork.json()).data;
  expect(fork.status).toBe(200);
  const childId = forkData.childSessionId;
  if (typeof childId !== "string") throw Error("The child was not linked");
  const refusal = await f.post(`/${childId}/fork-turns`, {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "This must not be accepted without Fork approval controls.",
    about: [],
  });
  expect(refusal.status).toBe(409);
  expect(f.records().filter((row) => row.method === "thread/resume")).toEqual(
    [],
  );
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
});

test("a lost Fork-child turn reply stays unknown after parent activity and never replays", async () => {
  const f = await fixture("fork-child-lost-turn-reply", false, false, "never"),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    parentSessionId = started.session.id,
    initialParent = await f.settle(parentSessionId),
    parentNativeThreadId = initialParent.binding?.sessionId,
    selectedTurn = initialParent.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn || !parentNativeThreadId)
    throw Error("The completed Fork parent did not retain its source identity");

  const forkRequest = {
      requestId: randomUUID(),
      throughTurnRequestId: selectedTurn.requestId,
    },
    forkResponse = await f.post(`/${parentSessionId}/forks`, forkRequest),
    forkEnvelope = await forkResponse.json();
  expect(forkResponse.status).toBe(200);
  const childSessionId = forkEnvelope.data.childSessionId;
  if (typeof childSessionId !== "string")
    throw Error("The native Fork child was not linked");

  const laterParentInput = {
      requestId: randomUUID(),
      expectedRevision: initialParent.revision,
      text: "A later parent turn must not replace the captured child prefix.",
      about: [],
    },
    laterParentTurn = await f.post(
      `/${parentSessionId}/turns`,
      laterParentInput,
    );
  expect(laterParentTurn.status).toBe(202);
  const parentAfterLaterTurn = await f.settle(parentSessionId);
  expect(parentAfterLaterTurn.turns).toHaveLength(2);
  expect(parentAfterLaterTurn.turns).toContainEqual(
    expect.objectContaining({
      requestId: laterParentInput.requestId,
      phase: "completed",
    }),
  );
  const parentEffectRows = () =>
    f
      .records()
      .filter(
        (row) =>
          (row.method === "thread/resume" || row.method === "turn/start") &&
          (row.params as Record<string, unknown> | undefined)?.threadId ===
            parentNativeThreadId,
      );
  const parentEffectsBeforeChild = parentEffectRows(),
    parentResumesBeforeChild = parentEffectsBeforeChild.filter(
      (row) => row.method === "thread/resume",
    ).length,
    parentTurnsBeforeChild = parentEffectsBeforeChild.filter(
      (row) => row.method === "turn/start",
    ).length;

  const childInput = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "The child dispatch reply will be lost after native acceptance.",
    about: [],
  };
  expect(
    (await f.post(`/${childSessionId}/fork-turns`, childInput)).status,
  ).toBe(202);
  const childAfterLoss = await f.settleFork(childSessionId),
    originalChildTurn = childAfterLoss.turns.find(
      (turn) => turn.requestId === childInput.requestId,
    );
  expect(originalChildTurn?.phase).toBe("unknown");
  const childEffectRows = () =>
    f
      .records()
      .filter(
        (row) =>
          (row.method === "thread/resume" || row.method === "turn/start") &&
          (row.params as Record<string, unknown> | undefined)?.threadId ===
            "0199a213-81c0-7800-8aa1-bbab2a035a55",
      );
  expect(
    f.records().filter((row) => row.kind === "child-turn-effect"),
  ).toHaveLength(1);
  expect(
    childEffectRows().filter((row) => row.method === "thread/resume"),
  ).toHaveLength(1);
  expect(
    childEffectRows().filter((row) => row.method === "turn/start"),
  ).toHaveLength(1);
  const childTurnRpc = childEffectRows().find(
    (row) => row.method === "turn/start",
  );
  expect(childTurnRpc?.params).toMatchObject({
    threadId: "0199a213-81c0-7800-8aa1-bbab2a035a55",
  });
  expect(JSON.stringify(childTurnRpc?.params)).toContain(childInput.text);
  expect(JSON.stringify(childTurnRpc?.params)).not.toContain(
    f.request.launch.prompt,
  );

  const duplicate = await f.post(`/${childSessionId}/fork-turns`, childInput),
    duplicateEnvelope = await duplicate.json();
  expect(duplicate.status).toBe(202);
  expect(duplicateEnvelope.data.turn).toMatchObject({
    requestId: childInput.requestId,
    phase: "unknown",
  });
  const beforeReadRecords = f.records(),
    beforeReadAudit = f.h.events(["operator.action"]),
    afterDuplicate = await f.forkPage(childSessionId);
  expect(afterDuplicate.turns).toHaveLength(1);
  expect(afterDuplicate.turns[0]).toMatchObject({
    requestId: childInput.requestId,
    phase: "unknown",
  });
  expect(f.records()).toEqual(beforeReadRecords);
  expect(f.h.events(["operator.action"])).toEqual(beforeReadAudit);
  const ordinaryRead = await fetch(
    `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${childSessionId}`,
    { headers: f.h.headers(f.h.hearth.token) },
  );
  expect(ordinaryRead.status).toBe(409);
  const anotherTurn = await f.post(`/${childSessionId}/fork-turns`, {
    requestId: randomUUID(),
    expectedRevision: childAfterLoss.revision,
    text: "A new identity cannot replace the unknown child outcome.",
    about: [],
  });
  expect(anotherTurn.status).toBe(409);
  expect(
    childEffectRows().filter((row) => row.method === "thread/resume"),
  ).toHaveLength(1);
  expect(
    childEffectRows().filter((row) => row.method === "turn/start"),
  ).toHaveLength(1);
  const parentTurnRows = f
    .records()
    .filter(
      (row) =>
        row.method === "turn/start" &&
        (row.params as Record<string, unknown> | undefined)?.threadId ===
          parentNativeThreadId,
    );
  expect(parentTurnRows).toHaveLength(2);
  expect(
    parentEffectRows().filter((row) => row.method === "thread/resume"),
  ).toHaveLength(parentResumesBeforeChild);
  expect(
    parentEffectRows().filter((row) => row.method === "turn/start"),
  ).toHaveLength(parentTurnsBeforeChild);
  expect(
    f.records().filter((row) => row.method === "thread/fork"),
  ).toHaveLength(1);
}, 20_000);

test("a linked child transcript remains readable when parent history is unavailable but continuation refuses", async () => {
  const f = await fixture("fork-service-tier-null", false, false, "never"),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    parentSessionId = started.session.id,
    parentPage = await f.settle(parentSessionId),
    selectedTurn = parentPage.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn)
    throw Error("The parent did not retain a completed Fork source turn");
  const forkRequest = {
      requestId: randomUUID(),
      throughTurnRequestId: selectedTurn.requestId,
    },
    forkResponse = await f.post(`/${parentSessionId}/forks`, forkRequest),
    forkEnvelope = await forkResponse.json();
  expect(forkResponse.status).toBe(200);
  const childSessionId = forkEnvelope.data.childSessionId;
  if (typeof childSessionId !== "string")
    throw Error("The native Fork child was not linked");

  const childInput = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "A completed child-owned turn remains readable.",
    about: [],
  };
  expect(
    (await f.post(`/${childSessionId}/fork-turns`, childInput)).status,
  ).toBe(202);
  const savedChild = await f.settleFork(childSessionId);
  expect(savedChild.turns).toMatchObject([
    { requestId: childInput.requestId, phase: "completed" },
  ]);

  rmSync(
    conversationFile(f.h.home, FIXTURE_PROJECT_ID, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: parentSessionId,
    }),
    { force: true },
  );
  const recordsBeforeRead = f.records(),
    auditBeforeRead = f.h.events(["operator.action"]),
    rereadChild = await f.forkPage(childSessionId);
  expect(rereadChild.turns).toMatchObject([
    { requestId: childInput.requestId, phase: "completed" },
  ]);
  expect(JSON.stringify(rereadChild)).not.toContain("PRIVATE-CHAT-PROMPT");
  expect(f.records()).toEqual(recordsBeforeRead);
  expect(f.h.events(["operator.action"])).toEqual(auditBeforeRead);
  const unavailableContextResponse = await fetch(
      `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${forkRequest.requestId}/context`,
      { headers: f.h.headers(f.h.hearth.token) },
    ),
    unavailableContext = await unavailableContextResponse.json();
  expect(unavailableContextResponse.status).toBe(200);
  expect(unavailableContext.data).toMatchObject({
    available: false,
    requestId: forkRequest.requestId,
    state: "linked",
    reason: "source-unavailable",
    source: null,
  });
  expect(f.records()).toEqual(recordsBeforeRead);
  expect(f.h.events(["operator.action"])).toEqual(auditBeforeRead);

  const childNativeThreadId = "0199a213-81c0-7800-8aa1-bbab2a035a55",
    childEffects = () =>
      f
        .records()
        .filter(
          (row) =>
            (row.method === "thread/resume" || row.method === "turn/start") &&
            (row.params as Record<string, unknown> | undefined)?.threadId ===
              childNativeThreadId,
        ),
    newTurn = await f.post(`/${childSessionId}/fork-turns`, {
      requestId: randomUUID(),
      expectedRevision: rereadChild.revision,
      text: "This must refuse without the sealed parent source.",
      about: [],
    });
  expect(newTurn.status).toBe(409);
  expect(
    childEffects().filter((row) => row.method === "thread/resume"),
  ).toHaveLength(1);
  expect(
    childEffects().filter((row) => row.method === "turn/start"),
  ).toHaveLength(1);
  expect(
    f.records().filter((row) => row.method === "thread/fork"),
  ).toHaveLength(1);
}, 20_000);

test("preflight Fork reservation is durably discoverable without creating a native child", async () => {
  const f = await fixture("fork-service-tier-null"),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    parentSessionId = started.session.id,
    completed = await f.settle(parentSessionId),
    selectedTurn = completed.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn) throw Error("The source-valid parent turn did not settle");

  const request = {
      requestId: randomUUID(),
      throughTurnRequestId: selectedTurn.requestId,
    },
    response = await f.post(`/${parentSessionId}/fork-reservations`, request),
    envelope = await response.json();
  expect(response.status).toBe(200);
  expect(envelope).toMatchObject({
    ok: true,
    data: {
      family: "codex-chat-fork",
      requestId: request.requestId,
      parentSessionId,
      throughTurnRequestId: selectedTurn.requestId,
      state: "reserved",
    },
  });
  expect(f.records().filter((row) => row.method === "thread/fork")).toEqual([]);
  expect(
    f.records().filter((row) => row.method === "thread/start"),
  ).toHaveLength(1);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  const operationsResponse = await fetch(
      `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/session-operation-identities`,
      { headers: f.h.headers(f.h.hearth.token) },
    ),
    operationsEnvelope = await operationsResponse.json(),
    operations = sessionOperationIdentityPageSchema.parse(
      operationsEnvelope.data,
    );
  expect(operationsResponse.status).toBe(200);
  expect(operations.operations).toContainEqual(
    expect.objectContaining({
      family: "codex-chat-fork",
      requestId: request.requestId,
      parentSessionId,
      throughTurnRequestId: selectedTurn.requestId,
      state: "reserved",
    }),
  );

  const requestHash = envelope.data.requestHash;
  expect(typeof requestHash).toBe("string");
  const audit = f.h.events(["operator.action"]).at(-1);
  expect(audit?.kind).toBe("operator.action");
  if (audit?.kind !== "operator.action")
    throw Error("The Fork reservation did not have an operator audit row");
  expect(audit.payload).toMatchObject({
    action: "session.fork.reserve",
    family: "codex-chat-fork",
    requestId: request.requestId,
    inputHash: requestHash,
  });
  expect(JSON.stringify(audit.payload)).not.toContain("PRIVATE-CHAT");

  const wrongRetirement = await f.post(
    `/${parentSessionId}/fork-reservations/${request.requestId}/retire`,
    { requestHash: "a".repeat(64) },
  );
  expect(wrongRetirement.status).toBe(409);
  expect(f.records().filter((row) => row.method === "thread/fork")).toEqual([]);

  const duplicateResponse = await f.post(
      `/${parentSessionId}/fork-reservations`,
      request,
    ),
    duplicate = await duplicateResponse.json();
  expect(duplicateResponse.status).toBe(200);
  expect(duplicate.data.requestHash).toBe(requestHash);
  expect(
    f
      .records()
      .filter((row) => row.kind === "rpc" && row.method === "thread/fork"),
  ).toEqual([]);

  const laterTurnId = randomUUID(),
    laterTurn = await f.post(`/${parentSessionId}/turns`, {
      requestId: laterTurnId,
      expectedRevision: completed.revision,
      text: "A later parent turn makes this source stale.",
      about: [],
    });
  expect(laterTurn.status).toBe(202);

  const retiredResponse = await f.post(
      `/${parentSessionId}/fork-reservations/${request.requestId}/retire`,
      { requestHash },
    ),
    retired = await retiredResponse.json();
  expect(retiredResponse.status).toBe(200);
  expect(retired.data).toMatchObject({
    requestId: request.requestId,
    requestHash,
    state: "retired",
    retiredReason: "verified-not-sent",
  });
  const recovered = await fetch(
      `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${request.requestId}`,
      { headers: f.h.headers(f.h.hearth.token) },
    ),
    recoveredBody = await recovered.json();
  expect(recovered.status).toBe(200);
  expect(recoveredBody.data).toMatchObject({
    requestId: request.requestId,
    requestHash,
    state: "retired",
    retiredReason: "verified-not-sent",
  });

  const lateFork = await f.post(`/${parentSessionId}/forks`, request),
    lateForkBody = await lateFork.json();
  expect(lateFork.status).toBe(200);
  expect(lateForkBody.data).toMatchObject({
    requestId: request.requestId,
    requestHash,
    state: "retired",
    retiredReason: "verified-not-sent",
  });
  expect(f.records().filter((row) => row.method === "thread/fork")).toEqual([]);
});

test("protected Fork routes publish one audited native Fork and recover its exact metadata-only original", async () => {
  const f = await fixture("fork-service-tier-null"),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    parentSessionId = started.session.id;
  const completed = await f.settle(parentSessionId),
    parentNativeThreadId = completed.binding?.sessionId,
    selectedTurn = completed.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn || !parentNativeThreadId)
    throw Error(
      "The completed parent turn was not saved with its native thread",
    );

  const request = {
      requestId: randomUUID(),
      throughTurnRequestId: selectedTurn.requestId,
    },
    route = `/${parentSessionId}/forks`,
    originalPath = `/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${request.requestId}`,
    operationsPath = `/projects/${FIXTURE_PROJECT_ID}/session-operation-identities`,
    beforeAudit = f.h.events(["operator.action"]).length;
  expect((await f.post(route, request, f.h.headers(null))).status).toBe(403);
  expect(
    (await f.post(route, { ...request, prompt: "must not be accepted" }))
      .status,
  ).toBe(400);
  expect(f.h.events(["operator.action"])).toHaveLength(beforeAudit);
  expect(f.records().filter((row) => row.method === "thread/fork")).toEqual([]);

  const first = await f.post(route, request);
  expect(first.status).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.ok).toBe(true);
  expect(firstBody.data.state).toBe("linked");
  expect(typeof firstBody.data.childSessionId).toBe("string");
  expect(
    f.records().filter((row) => row.method === "thread/fork"),
  ).toHaveLength(1);
  expect(
    f.records().filter((row) => row.method === "thread/start"),
  ).toHaveLength(1);
  const parentTurns = f
    .records()
    .filter((row) => row.kind === "rpc" && row.method === "turn/start");
  expect(parentTurns).toHaveLength(1);
  expect(parentTurns[0]?.params).toMatchObject({
    threadId: parentNativeThreadId,
  });
  const audit = f.h.events(["operator.action"]).at(-1);
  expect(audit?.kind).toBe("operator.action");
  if (audit?.kind !== "operator.action")
    throw Error("The Fork action did not have an operator audit row");
  expect(audit.payload).toMatchObject({
    action: "session.fork",
    family: "codex-chat-fork",
    requestId: request.requestId,
  });
  expect(audit.payload.target).toContain(parentSessionId);
  expect(audit.payload.inputHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(audit.payload)).not.toContain("PRIVATE-CHAT");

  const originalUrl = `${f.h.api}${originalPath}`;
  expect((await fetch(originalUrl)).status).toBe(403);
  const originalResponse = await fetch(originalUrl, {
      headers: f.h.headers(f.h.hearth.token),
    }),
    originalEnvelope = await originalResponse.json(),
    original = codexChatForkIdentityMetadataSchema.parse(originalEnvelope.data),
    originalText = JSON.stringify(originalEnvelope);
  expect(originalResponse.status).toBe(200);
  expect(original).toMatchObject({
    family: "codex-chat-fork",
    requestId: request.requestId,
    parentSessionId,
    throughTurnRequestId: selectedTurn.requestId,
    state: "linked",
    childSessionId: firstBody.data.childSessionId,
  });
  for (const privateValue of [
    "PRIVATE-CHAT-PROMPT",
    "PRIVATE-CHAT-CONTEXT",
    "sourceSeal",
    "parentNativeThreadId",
    "childNativeThreadId",
    "prepared",
  ])
    expect(originalText).not.toContain(privateValue);

  const linkedContextResponse = await fetch(`${originalUrl}/context?limit=1`, {
      headers: f.h.headers(f.h.hearth.token),
    }),
    linkedContext = await linkedContextResponse.json();
  expect(linkedContextResponse.status).toBe(200);
  expect(linkedContext.data).toMatchObject({
    available: true,
    requestId: request.requestId,
    requestHash: original.requestHash,
    state: "linked",
  });
  expect(linkedContext.data.source.requestId).toBe(request.requestId);
  expect(JSON.stringify(linkedContext)).not.toContain("sourceSeal");
  expect(JSON.stringify(linkedContext)).not.toContain("parentNativeThreadId");

  const aggregateResponse = await fetch(`${f.h.api}${operationsPath}`, {
      headers: f.h.headers(f.h.hearth.token),
    }),
    aggregateEnvelope = await aggregateResponse.json(),
    aggregate = sessionOperationIdentityPageSchema.parse(
      aggregateEnvelope.data,
    ),
    aggregateText = JSON.stringify(aggregate);
  expect(aggregateResponse.status).toBe(200);
  expect(aggregateEnvelope.ok).toBe(true);
  expect(aggregate.operations).toContainEqual(
    expect.objectContaining({
      family: "codex-chat-fork",
      requestId: request.requestId,
      state: "linked",
      parentSessionId,
      throughTurnRequestId: selectedTurn.requestId,
      childSessionId: firstBody.data.childSessionId,
    }),
  );
  expect(aggregateText).not.toContain("PRIVATE-CHAT-PROMPT");

  const duplicate = await f.post(route, request);
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).data).toEqual(firstBody.data);
  expect(
    f.records().filter((row) => row.method === "thread/fork"),
  ).toHaveLength(1);
  expect(f.h.events(["operator.action"])).toHaveLength(beforeAudit + 2);
  expect(
    (
      await f.post(route, {
        ...request,
        throughTurnRequestId: randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    f.records().filter((row) => row.method === "thread/fork"),
  ).toHaveLength(1);
});

test("Fork review GET projects the explicitly selected completed parent turn without effects", async () => {
  const f = await fixture("fork-service-tier-null", false, false, "never"),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    parentSessionId = started.session.id,
    completed = await f.settle(parentSessionId),
    selectedTurn = completed.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn || !completed.binding)
    throw Error(
      "The selected source turn did not complete in the inert fixture",
    );

  const requestPath = `/projects/${FIXTURE_PROJECT_ID}/sessions/${parentSessionId}/fork-review`,
    beforeRecords = f.records(),
    beforeAudit = f.h.events(["operator.action"]),
    unauthorized = await fetch(
      `${f.h.api}${requestPath}?throughTurnRequestId=${selectedTurn.requestId}`,
    ),
    duplicateQuery = await fetch(
      `${f.h.api}${requestPath}?throughTurnRequestId=${selectedTurn.requestId}&throughTurnRequestId=${selectedTurn.requestId}`,
      { headers: f.h.headers(f.h.hearth.token) },
    ),
    unknownQuery = await fetch(
      `${f.h.api}${requestPath}?throughTurnRequestId=${selectedTurn.requestId}&nativeThreadId=forbidden`,
      { headers: f.h.headers(f.h.hearth.token) },
    ),
    invalidCursor = await fetch(
      `${f.h.api}${requestPath}?throughTurnRequestId=${selectedTurn.requestId}&after=999999999`,
      { headers: f.h.headers(f.h.hearth.token) },
    ),
    response = await fetch(
      `${f.h.api}${requestPath}?throughTurnRequestId=${selectedTurn.requestId}&limit=1`,
      { headers: f.h.headers(f.h.hearth.token) },
    );
  expect(unauthorized.status).toBe(403);
  expect(duplicateQuery.status).toBe(400);
  expect(unknownQuery.status).toBe(400);
  expect(invalidCursor.status).toBe(400);
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.ok).toBe(true);
  expect(envelope.data).toMatchObject({
    requestId: null,
    throughTurnRequestId: selectedTurn.requestId,
    complete: false,
  });
  expect(JSON.stringify(envelope.data)).not.toContain("sourceSeal");
  expect(JSON.stringify(envelope.data)).not.toContain("prepared");
  expect(JSON.stringify(envelope.data)).not.toContain("PRIVATE-CHAT-CONTEXT");
  expect(JSON.stringify(envelope.data)).not.toContain(
    completed.binding.sessionId,
  );
  expect(envelope.data.frames).toHaveLength(1);
  expect(typeof envelope.data.nextCursor).toBe("number");
  const reviewedFrames = [...envelope.data.frames];
  let reviewPage = envelope.data,
    pageCount = 1;
  while (!reviewPage.complete && pageCount < 40) {
    const next = await fetch(
        `${f.h.api}${requestPath}?throughTurnRequestId=${selectedTurn.requestId}&after=${reviewPage.nextCursor}&limit=1`,
        { headers: f.h.headers(f.h.hearth.token) },
      ),
      nextEnvelope = await next.json();
    expect(next.status).toBe(200);
    expect(nextEnvelope.data.frames[0]?.seq).toBeGreaterThan(
      reviewedFrames.at(-1)?.seq,
    );
    reviewedFrames.push(...nextEnvelope.data.frames);
    reviewPage = nextEnvelope.data;
    pageCount++;
  }
  expect(reviewPage.complete).toBe(true);
  expect(new Set(reviewedFrames.map((frame) => frame.seq)).size).toBe(
    reviewedFrames.length,
  );
  expect(reviewedFrames.map((frame) => frame.text).join(" ")).toContain(
    "Hello world",
  );
  expect(f.records()).toEqual(beforeRecords);
  expect(f.h.events(["operator.action"])).toEqual(beforeAudit);
  expect(f.records().filter((row) => row.method === "thread/fork")).toEqual([]);
});

test("Fork review bounds the selected historical prefix instead of later parent activity", async () => {
  const f = await fixture("fork-service-tier-null", false, false, "never"),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    parentSessionId = started.session.id,
    completed = await f.settle(parentSessionId),
    selectedTurn = completed.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn)
    throw Error("The selected source turn did not complete in the fixture");

  const store = createConversationStore(f.h.home, undefined, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: parentSessionId,
    }),
    state = store.read(FIXTURE_PROJECT_ID),
    laterTurnId = randomUUID(),
    at = new Date().toISOString();
  state.turns.push({
    requestId: laterTurnId,
    hash: "d".repeat(64),
    phase: "completed",
    createdAt: at,
    updatedAt: at,
    reason: null,
    owner: null,
  });
  const firstSequence = state.frames.length + 1;
  state.frames.push(
    ...Array.from({ length: 2_001 }, (_, index) => ({
      seq: firstSequence + index,
      turnId: laterTurnId,
      at,
      event: {
        kind: "text" as const,
        text: "Later parent activity is outside the selected boundary.",
        messageId: `later-${index}`,
      },
    })),
  );
  state.revision++;
  writeOwnerOnly(
    conversationFile(f.h.home, FIXTURE_PROJECT_ID, {
      kind: "session",
      projectId: FIXTURE_PROJECT_ID,
      sessionId: parentSessionId,
    }),
    `${JSON.stringify(state)}\n`,
  );

  const beforeRecords = f.records(),
    beforeAudit = f.h.events(["operator.action"]),
    response = await fetch(
      `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${parentSessionId}/fork-review?throughTurnRequestId=${selectedTurn.requestId}&limit=1`,
      { headers: f.h.headers(f.h.hearth.token) },
    ),
    envelope = await response.json();
  expect(response.status).toBe(200);
  expect(envelope.data).toMatchObject({
    throughTurnRequestId: selectedTurn.requestId,
    complete: false,
    frames: [{ turnId: f.request.requestId }],
  });
  expect(JSON.stringify(envelope.data)).not.toContain(
    "Later parent activity is outside the selected boundary.",
  );
  expect(f.records()).toEqual(beforeRecords);
  expect(f.h.events(["operator.action"])).toEqual(beforeAudit);
});

test("Fork original context GET correlates a durable reservation without changing its identity", async () => {
  const f = await fixture("fork-service-tier-null", false, false, "never"),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    parentSessionId = started.session.id,
    completed = await f.settle(parentSessionId),
    selectedTurn = completed.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn)
    throw Error("The source-valid parent turn did not complete");

  const request = {
      requestId: randomUUID(),
      throughTurnRequestId: selectedTurn.requestId,
    },
    reserve = await f.post(`/${parentSessionId}/fork-reservations`, request),
    reservation = await reserve.json();
  expect(reserve.status).toBe(200);
  expect(reservation.data.state).toBe("reserved");
  expect(reservation.data.requestId).toBe(request.requestId);
  const requestHash = reservation.data.requestHash;
  if (typeof requestHash !== "string")
    throw Error("The durable reservation did not return its canonical hash");
  const missingOriginal = await fetch(
    `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${randomUUID()}/context`,
    { headers: f.h.headers(f.h.hearth.token) },
  );
  expect(missingOriginal.status).toBe(404);

  const originalResponse = await fetch(
      `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${request.requestId}`,
      { headers: f.h.headers(f.h.hearth.token) },
    ),
    original = await originalResponse.json();
  expect(originalResponse.status).toBe(200);
  expect(original.data).toMatchObject({
    requestId: request.requestId,
    requestHash,
    parentSessionId,
    throughTurnRequestId: selectedTurn.requestId,
    state: "reserved",
  });

  const beforeRecords = f.records(),
    beforeAudit = f.h.events(["operator.action"]),
    contextResponse = await fetch(
      `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${request.requestId}/context?limit=1`,
      { headers: f.h.headers(f.h.hearth.token) },
    );
  expect(contextResponse.status).toBe(200);
  const context = await contextResponse.json();
  expect(context.ok).toBe(true);
  expect(JSON.stringify(context.data)).toContain(selectedTurn.requestId);
  expect(JSON.stringify(context.data)).not.toContain("sourceSeal");
  expect(context.data).toMatchObject({
    requestId: request.requestId,
    requestHash,
    parentSessionId,
    throughTurnRequestId: selectedTurn.requestId,
  });
  expect(context.data.source).toMatchObject({
    requestId: request.requestId,
    complete: false,
  });
  expect(context.data.source.frames).toHaveLength(1);
  const contextFrames = [...context.data.source.frames];
  let contextPage = context.data.source,
    contextPageCount = 1;
  while (!contextPage.complete && contextPageCount < 40) {
    const contextNextResponse = await fetch(
        `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${request.requestId}/context?after=${contextPage.nextCursor}&limit=1`,
        { headers: f.h.headers(f.h.hearth.token) },
      ),
      contextNext = await contextNextResponse.json();
    expect(contextNextResponse.status).toBe(200);
    expect(contextNext.data.source.frames[0]?.seq).toBeGreaterThan(
      contextFrames.at(-1)?.seq,
    );
    contextFrames.push(...contextNext.data.source.frames);
    contextPage = contextNext.data.source;
    contextPageCount++;
  }
  expect(contextPage.complete).toBe(true);
  expect(new Set(contextFrames.map((frame) => frame.seq)).size).toBe(
    contextFrames.length,
  );
  expect(JSON.stringify(context.data)).not.toContain("parentNativeThreadId");
  expect(JSON.stringify(context.data)).not.toContain("prepared");
  expect(f.records()).toEqual(beforeRecords);
  expect(f.h.events(["operator.action"])).toEqual(beforeAudit);
  expect(f.records().filter((row) => row.method === "thread/fork")).toEqual([]);
});

test("a lost Fork reply is recovered by exact original GET without repeating the native effect", async () => {
  const f = await fixture("fork-service-tier-null", false, true),
    start = await f.post("", f.request);
  expect(start.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      (await start.json()).data,
    ),
    parentSessionId = started.session.id,
    completed = await f.settle(parentSessionId),
    parentNativeThreadId = completed.binding?.sessionId,
    selectedTurn = completed.turns.find(
      (turn) => turn.requestId === f.request.requestId,
    );
  if (!selectedTurn || !parentNativeThreadId)
    throw Error(
      "The completed parent turn was not saved with its native thread",
    );

  const request = {
      requestId: randomUUID(),
      throughTurnRequestId: selectedTurn.requestId,
    },
    route = `/${parentSessionId}/forks`,
    originalUrl = `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/codex-chat-forks/${request.requestId}`,
    controller = new AbortController();
  const lostReply = f.post(
    route,
    request,
    f.h.headers(f.h.hearth.token),
    controller.signal,
  );
  void lostReply.catch(() => {});
  let reachedEffect = false,
    effectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      f.forkEffectReached,
      new Promise<never>((_resolve, reject) => {
        effectTimer = setTimeout(
          () =>
            reject(Error("Fork effect did not reach the held reply boundary")),
          5_000,
        );
      }),
    ]);
    reachedEffect = true;
    expect(
      f.records().filter((row) => row.method === "thread/fork"),
    ).toHaveLength(1);
    controller.abort();
    await expect(lostReply).rejects.toThrow();
  } finally {
    if (effectTimer !== undefined) clearTimeout(effectTimer);
    controller.abort();
    f.releaseForkReply();
  }
  if (reachedEffect) await f.forkReplyReleased;

  const recovered = await fetch(originalUrl, {
      headers: f.h.headers(f.h.hearth.token),
    }),
    recoveredEnvelope = await recovered.json(),
    original = codexChatForkIdentityMetadataSchema.parse(
      recoveredEnvelope.data,
    );
  expect(recovered.status).toBe(200);
  expect(recovered.headers.get("cache-control")).toBe("no-store");
  expect(original).toMatchObject({
    family: "codex-chat-fork",
    requestId: request.requestId,
    parentSessionId,
    throughTurnRequestId: selectedTurn.requestId,
    state: "linked",
  });

  const duplicate = await f.post(route, request);
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).data).toMatchObject({
    requestId: request.requestId,
    state: "linked",
    childSessionId: original.childSessionId,
  });
  expect(
    f.records().filter((row) => row.method === "thread/fork"),
  ).toHaveLength(1);
  expect(
    f.records().filter((row) => row.method === "thread/start"),
  ).toHaveLength(1);
  const parentTurns = f
    .records()
    .filter((row) => row.kind === "rpc" && row.method === "turn/start");
  expect(parentTurns).toHaveLength(1);
  expect(parentTurns[0]?.params).toMatchObject({
    threadId: parentNativeThreadId,
  });
});
