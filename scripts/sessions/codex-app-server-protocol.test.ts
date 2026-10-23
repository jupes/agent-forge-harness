import { expect, test } from "bun:test";
import type {
  CodexChatCapabilities,
  CodexChatLaunch,
} from "../../types/codex-chat";
import {
  codexChatLaunchSchema,
  createCodexChatStream,
  nativeRequestKey,
  parseCodexAppServerFrame,
  serializeCodexChat,
} from "./codex-app-server-protocol";

const capabilities: CodexChatCapabilities = {
  version: "0.163.0-alpha.10.2",
  flags: ["--stdio"],
  modelEfforts: [
    {
      model: "exact-model",
      efforts: ["high"],
      source: "model/list",
      cliVersion: "0.163.0-alpha.10.2",
      asOf: "2026-10-23T00:00:00.000Z",
    },
  ],
};
const launch: CodexChatLaunch = {
  mode: "chat",
  cwd: "C:/private/worktree",
  model: "exact-model",
  effort: "high",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  prompt: "Private 🌱 $(literal)",
  attachments: [{ kind: "text", name: "private.txt", text: "attachment body" }],
  context: {
    projectId: "project-a",
    repository: "C:/private/repo",
    worktree: "C:/private/worktree",
    about: [],
  },
};
test("Chat serialization keeps all prompt, context and attachment bodies in private protocol input", () => {
  const serialized = serializeCodexChat(launch, capabilities);
  expect(serialized.argv).toEqual(["app-server", "--stdio"]);
  expect(serialized.equivalentCommand).toBe("& 'codex' 'app-server' '--stdio'");
  expect(serialized.stdinNote).toContain("handshake");
  expect(serialized.input.text).toContain(launch.prompt);
  expect(serialized.input.text).toContain("attachment body");
  expect(serialized.thread).toEqual({
    model: launch.model,
    cwd: launch.cwd,
    sandbox: launch.sandbox,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    environments: [],
  });
  expect(serialized.effort).toBe("high");
  expect(JSON.stringify(serialized.argv)).not.toContain("private");
});

test("unsupported effort, wire versions and broad launch options refuse without substitution", () => {
  expect(() =>
    serializeCodexChat(launch, { ...capabilities, modelEfforts: [] }),
  ).toThrow("effort");
  expect(() =>
    serializeCodexChat(launch, { ...capabilities, version: "0.164.0" }),
  ).toThrow("protocol");
  expect(() =>
    serializeCodexChat(launch, { ...capabilities, flags: [] }),
  ).toThrow("--stdio");
  expect(() =>
    codexChatLaunchSchema.parse({ ...launch, sandbox: "danger-full-access" }),
  ).toThrow();
  expect(() =>
    codexChatLaunchSchema.parse({ ...launch, image: "C:/caller/image.png" }),
  ).toThrow();
});

const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const turnId = "0199a213-81c0-7800-8aa1-bbab2a035a54";
function stream(selected: CodexChatLaunch = launch) {
  const decoder = createCodexChatStream({
    launch: selected,
    version: capabilities.version,
    resumeThreadId: threadId,
  });
  decoder.thread({
    thread: {
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      parentThreadId: null,
      status: { type: "idle" },
    },
    model: selected.model,
    modelProvider: "openai",
    cwd: selected.cwd,
    approvalPolicy: selected.approvalPolicy,
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [selected.cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    reasoningEffort: "medium",
  });
  decoder.armTurn();
  decoder.turn({ turn: { id: turnId, status: "inProgress" } });
  return decoder;
}
const notify = (method: string, params: unknown) =>
  parseCodexAppServerFrame(JSON.stringify({ method, params }));
test("native Chat partial and completed messages deduplicate while tool output stays out of main text", () => {
  const decoder = stream();
  expect(
    decoder.accept(
      notify("item/agentMessage/delta", {
        threadId,
        turnId,
        itemId: "message-a",
        delta: "Hello",
      }),
    ).events,
  ).toEqual([{ kind: "text", itemId: "message-a", text: "Hello" }]);
  const completed = notify("item/completed", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: "message-a", text: "Hello world" },
    completedAtMs: 1,
  });
  expect(decoder.accept(completed).events).toEqual([
    { kind: "text", itemId: "message-a", text: " world" },
  ]);
  expect(decoder.accept(completed).events).toEqual([]);
  expect(
    decoder.accept(
      notify("item/commandExecution/outputDelta", {
        threadId,
        turnId,
        itemId: "tool-a",
        delta: "tool body",
      }),
    ).events,
  ).toEqual([]);
  decoder.accept(
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "completed", items: [], error: null },
    }),
  );
  expect(decoder.state().terminal).toBe("completed");
});
test("foreign native identity and malformed or oversized frames refuse", () => {
  const decoder = stream();
  expect(() =>
    decoder.accept(
      notify("item/agentMessage/delta", {
        threadId: turnId,
        turnId,
        itemId: "a",
        delta: "foreign",
      }),
    ),
  ).toThrow("identity");
  expect(() => parseCodexAppServerFrame("{")).toThrow("malformed");
  expect(() => parseCodexAppServerFrame(" ".repeat(1_048_577))).toThrow(
    "bound",
  );
});

function approval(
  decoder: ReturnType<typeof stream>,
  method: "commandExecution" | "fileChange" = "commandExecution",
  overrides: Record<string, unknown> = {},
) {
  decoder.accept(
    notify("item/started", {
      threadId,
      turnId,
      item: { type: method, id: "approval-item" },
    }),
  );
  return decoder.accept(
    parseCodexAppServerFrame(
      JSON.stringify({
        id: 1,
        method: `item/${method}/requestApproval`,
        params: {
          threadId,
          turnId,
          itemId: "approval-item",
          startedAtMs: 1,
          ...(method === "commandExecution"
            ? {
                kind: "command",
                environmentId: null,
                approvalId: "native-approval-a",
                command: "echo private-command",
                cwd: launch.cwd,
                availableDecisions: ["accept", "acceptForSession", "decline"],
              }
            : {}),
          ...overrides,
        },
      }),
    ),
  );
}

test("native approvals preserve typed identity and offer only one-request decisions", () => {
  const decoded = approval(stream());
  expect(decoded.approvals).toEqual([
    {
      nativeRequestId: 1,
      nativeApprovalId: "native-approval-a",
      threadId,
      turnId,
      itemId: "approval-item",
      kind: "command",
      command: "echo private-command",
      cwd: launch.cwd,
      reason: null,
      availableDecisions: ["accept", "decline"],
    },
  ]);
  expect(nativeRequestKey(1)).not.toBe(nativeRequestKey("1"));
  expect(
    approval(stream(), "fileChange").approvals[0]?.availableDecisions,
  ).toEqual(["accept", "decline", "cancel"]);
});

test("native approval requests cannot widen policy, scope, grants or item identity", () => {
  for (const overrides of [
    { kind: "writeStdin" },
    { environmentId: "remote-environment" },
    { networkApprovalContext: {} },
    { additionalPermissions: {} },
    { availableDecisions: ["acceptForSession"] },
    { turnId: threadId },
    { itemId: "unknown-item" },
  ]) {
    expect(() => approval(stream(), "commandExecution", overrides)).toThrow();
  }
  expect(() =>
    approval(stream(), "fileChange", { grantRoot: launch.cwd }),
  ).toThrow("session-wide");
  expect(() =>
    approval(stream({ ...launch, approvalPolicy: "never" })),
  ).toThrow("allowed live turn");
});

test("conflicting message prefixes, late item content and item or stream pressure refuse", () => {
  const decoder = stream();
  decoder.accept(
    notify("item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: "message-a",
      delta: "original",
    }),
  );
  expect(() =>
    decoder.accept(
      notify("item/completed", {
        threadId,
        turnId,
        item: { type: "agentMessage", id: "message-a", text: "replaced" },
      }),
    ),
  ).toThrow("prefix");
  const completed = stream();
  completed.accept(
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "completed", items: [], error: null },
    }),
  );
  expect(() =>
    completed.accept(
      notify("item/completed", {
        threadId,
        turnId,
        item: { type: "agentMessage", id: "late-message", text: "late" },
      }),
    ),
  ).toThrow("terminal");
  const items = stream();
  for (let index = 0; index < 256; index++) {
    items.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: { type: "commandExecution", id: `tool-${index}` },
      }),
    );
  }
  expect(() => approval(items)).toThrow("bound");
  const frames = stream();
  for (let index = 0; index < 4096; index++) {
    frames.accept(notify("future/notification", {}));
  }
  expect(() => frames.accept(notify("future/notification", {}))).toThrow(
    "bound",
  );
});
