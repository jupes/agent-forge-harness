import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type {
  CodexChatLaunch,
  PreparedCodexChat,
} from "../../types/codex-chat";
import {
  buildCodexChatForkParams,
  parseCodexChatForkRuntimeInput,
  verifyCodexChatForkResponse,
} from "./codex-chat-fork-runtime-protocol";

const version = "0.163.0-alpha.10.2",
  parentThreadId = "0199a213-81c0-7800-8aa1-bbab2a035a51",
  childThreadId = "0199a213-81c0-7800-8aa1-bbab2a035a60",
  lastTurnId = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  workspace = resolve(process.cwd());

function prepared(
  overrides: Partial<PreparedCodexChat> = {},
): PreparedCodexChat {
  const launch = {
    mode: "chat" as const,
    cwd: workspace,
    model: "gpt-6.1-sol",
    sandbox: "workspace-write" as const,
    approvalPolicy: "on-request" as const,
    prompt: "private source prompt is never fork input",
    effort: "high",
  };
  return {
    version: 1,
    provider: "codex",
    smith: "codex",
    cwd: workspace,
    canonicalCwd: workspace,
    launch,
    capabilities: {
      version,
      flags: ["--stdio"],
      modelEfforts: [
        {
          model: launch.model,
          efforts: ["high", "medium"],
          source: "model/list",
          cliVersion: version,
          asOf: "2026-10-25T00:00:00.000Z",
        },
      ],
    },
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    prepared: prepared(),
    parent: { provider: "codex", threadId: parentThreadId, version },
    lastTurnId,
    sourceSettings: {
      modelProvider: "openai",
      serviceTier: null,
      reasoningEffort: "high",
    },
    ...overrides,
  };
}

function forkResponse(overrides: Record<string, unknown> = {}) {
  const cwd = workspace;
  return {
    thread: {
      id: childThreadId,
      environments: [],
      extra: null,
      // Native sessionId is thread-tree metadata, not the child identity.
      sessionId: parentThreadId,
      forkedFromId: parentThreadId,
      parentThreadId: null,
      preview: "private native history is not returned",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "legacy",
      turns: [],
      modelProvider: "openai",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      createdAt: 1,
      updatedAt: 1,
      recencyAt: null,
      status: { type: "idle" },
      path: "C:\\private\\native\\history.jsonl",
      cwd,
      cliVersion: version,
      originator: null,
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      daybreakEnabled: null,
    },
    model: "gpt-6.1-sol",
    modelProvider: "openai",
    serviceTier: null,
    disabledPluginIds: [],
    cwd,
    runtimeWorkspaceRoots: [cwd],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
    ...overrides,
  };
}

test("Fork input requires a native completed-turn UUID and complete saved settings", () => {
  expect(parseCodexChatForkRuntimeInput(input()).lastTurnId).toBe(lastTurnId);
  for (const invalid of [
    { ...input(), lastTurnId: null },
    { ...input(), lastTurnId: undefined },
    { ...input(), lastTurnId: "latest" },
    {
      ...input(),
      sourceSettings: { modelProvider: "openai", reasoningEffort: null },
    },
    {
      ...input(),
      sourceSettings: { modelProvider: "openai", serviceTier: null },
    },
  ])
    expect(() => parseCodexChatForkRuntimeInput(invalid)).toThrow();
});

test("Fork intent rejects renderer authority, unsupported version, and scope disagreement", () => {
  const base = input();
  expect(() =>
    parseCodexChatForkRuntimeInput({
      ...base,
      path: "C:\\attacker\\thread.jsonl",
    }),
  ).toThrow();
  expect(() =>
    parseCodexChatForkRuntimeInput({
      ...base,
      parent: { ...base.parent, version: "0.162.0" },
    }),
  ).toThrow();
  expect(() =>
    parseCodexChatForkRuntimeInput({
      ...base,
      prepared: prepared({
        launch: {
          ...prepared().launch,
          context: {
            projectId: "project-00000000-0000-4000-8000-000000000001",
            repository: "repo",
            worktree: join(workspace, "elsewhere"),
          },
        },
      }),
    }),
  ).toThrow();
});

test("Fork effort must agree with the source snapshot and exact model/version evidence", () => {
  expect(() =>
    parseCodexChatForkRuntimeInput({
      ...input(),
      sourceSettings: {
        modelProvider: "openai",
        serviceTier: null,
        reasoningEffort: "xhigh",
      },
    }),
  ).toThrow();
  expect(() =>
    parseCodexChatForkRuntimeInput({
      ...input(),
      prepared: prepared({
        capabilities: {
          version,
          flags: ["--stdio"],
          modelEfforts: [],
        },
      }),
    }),
  ).toThrow();
  expect(() =>
    parseCodexChatForkRuntimeInput({
      ...input(),
      prepared: prepared({
        launch: { ...prepared().launch, effort: "medium" },
      }),
    }),
  ).toThrow();
});

test("Fork request is a fixed one-shot payload with exact source and turn identity", () => {
  const parsed = parseCodexChatForkRuntimeInput(input());
  expect(buildCodexChatForkParams(parsed)).toEqual({
    threadId: parentThreadId,
    lastTurnId,
    model: "gpt-6.1-sol",
    modelProvider: "openai",
    serviceTier: null,
    cwd: workspace,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    config: { model_reasoning_effort: "high" },
    ephemeral: false,
    excludeTurns: true,
    deferGoalContinuation: true,
  });
});

test("a known null service tier is sent explicitly and null effort adds no config", () => {
  const launch: CodexChatLaunch = { ...prepared().launch };
  delete launch.effort;
  const noEffort = input({
    prepared: prepared({ launch }),
    sourceSettings: {
      modelProvider: "openai",
      serviceTier: null,
      reasoningEffort: null,
    },
  });
  const params = buildCodexChatForkParams(
    parseCodexChatForkRuntimeInput(noEffort),
  );
  expect(params.serviceTier).toBeNull();
  expect(params).not.toHaveProperty("config");
});

test("Fork response projects the actual child UUID and preserves native session-tree semantics", () => {
  const parsed = parseCodexChatForkRuntimeInput(input()),
    verified = verifyCodexChatForkResponse(forkResponse(), parsed);
  expect(verified).toEqual({
    parentThreadId,
    lastTurnId,
    threadId: childThreadId,
    forkedFromId: parentThreadId,
    cliVersion: version,
    status: "idle",
    canAcceptDirectInput: true,
    settings: {
      model: "gpt-6.1-sol",
      modelProvider: "openai",
      serviceTier: null,
      cwd: workspace,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      reasoningEffort: "high",
    },
    runtimeWorkspaceRoots: [workspace],
    writableRoots: [workspace],
  });
  expect(verified).not.toHaveProperty("preview");
  expect(verified).not.toHaveProperty("path");
  expect(verified).not.toHaveProperty("sessionId");
});

test("Fork response rejects wrong ancestry, identity, config, activity, turns, scope, and unknown fields", () => {
  const parsed = parseCodexChatForkRuntimeInput(input());
  const altered = [
    forkResponse({ thread: { ...forkResponse().thread, id: parentThreadId } }),
    forkResponse({
      thread: { ...forkResponse().thread, forkedFromId: childThreadId },
    }),
    forkResponse({
      thread: { ...forkResponse().thread, parentThreadId: parentThreadId },
    }),
    forkResponse({
      thread: { ...forkResponse().thread, cliVersion: "0.162.0" },
    }),
    forkResponse({
      thread: {
        ...forkResponse().thread,
        status: { type: "active", activeFlags: [] },
      },
    }),
    forkResponse({
      thread: { ...forkResponse().thread, canAcceptDirectInput: false },
    }),
    forkResponse({
      thread: { ...forkResponse().thread, turns: [{ id: lastTurnId }] },
    }),
    forkResponse({ model: "gpt-6-luna" }),
    forkResponse({ modelProvider: "other" }),
    forkResponse({ serviceTier: "priority" }),
    forkResponse({ cwd: join(workspace, "outside", "..", "..") }),
    forkResponse({ approvalsReviewer: "auto_review" }),
    forkResponse({ activePermissionProfile: { id: "unexpected" } }),
    forkResponse({ multiAgentMode: "auto" }),
    forkResponse({ runtimeWorkspaceRoots: [join(workspace, "..", "outside")] }),
    forkResponse({
      thread: {
        ...forkResponse().thread,
        preview: "x".repeat(1_048_576),
      },
    }),
    forkResponse({ extraNativeField: true }),
    forkResponse({
      thread: { ...forkResponse().thread, extraUnknownField: true },
    }),
  ];
  for (const response of altered)
    expect(() => verifyCodexChatForkResponse(response, parsed)).toThrow();
});
