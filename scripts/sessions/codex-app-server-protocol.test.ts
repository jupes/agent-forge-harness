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
const commandItem = (overrides: Record<string, unknown> = {}) => ({
  type: "commandExecution",
  id: "native-command",
  command: "inert <script> command",
  cwd: launch.cwd,
  status: "inProgress",
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...overrides,
});

test("native command reports retain streamed versus aggregate output, exact duplicates and standalone declined completion", () => {
  const decoder = stream();
  const started = notify("item/started", {
    threadId,
    turnId,
    item: commandItem(),
    startedAtMs: 1,
  });
  expect(decoder.accept(started).events[0]).toMatchObject({
    kind: "command",
    source: "item/started",
    status: "inProgress",
    output: null,
    exitCode: null,
    partial: true,
  });
  expect(decoder.accept(started).events).toEqual([]);
  for (const delta of ["one\n", "two\n"])
    expect(
      decoder.accept(
        notify("item/commandExecution/outputDelta", {
          threadId,
          turnId,
          itemId: "native-command",
          delta,
        }),
      ).events[0],
    ).toMatchObject({
      output: { text: delta, truncated: false },
      outputSource: "delta",
      partial: true,
    });
  const completed = notify("item/completed", {
    threadId,
    turnId,
    item: commandItem({
      status: "completed",
      aggregatedOutput: "A distinct provider aggregate",
      exitCode: 0,
      durationMs: 0,
    }),
    completedAtMs: 2,
  });
  expect(decoder.accept(completed).events[0]).toMatchObject({
    source: "item/completed",
    output: { text: "A distinct provider aggregate", truncated: false },
    outputSource: "aggregate",
    status: "completed",
    exitCode: 0,
    durationMs: 0,
    partial: false,
  });
  expect(decoder.accept(completed).events).toEqual([]);
  const declined = stream().accept(
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "completed",
        error: null,
        items: [commandItem({ status: "declined" })],
      },
    }),
  );
  expect(declined.events).toHaveLength(1);
  expect(declined.events[0]).toMatchObject({
    source: "turn/completed",
    status: "declined",
    exitCode: null,
    output: null,
    partial: false,
  });
});

test("unknown, foreign, conflicting and post-completion command reports cannot gain a native item identity", () => {
  const output = (overrides: Record<string, unknown> = {}) =>
    notify("item/commandExecution/outputDelta", {
      threadId,
      turnId,
      itemId: "native-command",
      delta: "private output",
      ...overrides,
    });
  expect(() => stream().accept(output())).toThrow("command");
  const decoder = stream();
  decoder.accept(
    notify("item/started", { threadId, turnId, item: commandItem() }),
  );
  expect(() => decoder.accept(output({ threadId: turnId }))).toThrow(
    "identity",
  );
  expect(() => decoder.accept(output({ turnId: threadId }))).toThrow(
    "identity",
  );
  for (const change of [
    { command: "different command" },
    { cwd: "foreign reported metadata" },
    { status: "completed" },
    { aggregatedOutput: 123 },
    { exitCode: "0" },
  ])
    expect(() =>
      decoder.accept(
        notify("item/started", {
          threadId,
          turnId,
          item: commandItem(change),
        }),
      ),
    ).toThrow();
  decoder.accept(
    notify("item/completed", {
      threadId,
      turnId,
      item: commandItem({ status: "failed", exitCode: 1 }),
    }),
  );
  expect(() => decoder.accept(output())).toThrow("command");
  expect(() =>
    decoder.accept(
      notify("item/completed", {
        threadId,
        turnId,
        item: commandItem({ status: "failed", exitCode: 2 }),
      }),
    ),
  ).toThrow("completed");
  decoder.accept(
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", items: [], error: {} },
    }),
  );
  expect(() => decoder.accept(output())).toThrow("terminal");
});

test("cumulative native command output clips at a UTF-8 boundary and retains one explicit truncation report", () => {
  const decoder = stream();
  decoder.accept(
    notify("item/started", { threadId, turnId, item: commandItem() }),
  );
  const output = (delta: string) =>
    decoder.accept(
      notify("item/commandExecution/outputDelta", {
        threadId,
        turnId,
        itemId: "native-command",
        delta,
      }),
    ).events;
  const first = output("🌱".repeat(4095))[0];
  expect(first).toMatchObject({
    output: { text: "🌱".repeat(4095), truncated: false },
  });
  expect(output("\0🌱")[0]).toMatchObject({
    output: { text: "�", truncated: true },
  });
  expect(output("more")).toEqual([]);
  expect(
    decoder.accept(
      notify("item/completed", {
        threadId,
        turnId,
        item: commandItem({ status: "completed", aggregatedOutput: null }),
      }),
    ).events[0],
  ).toMatchObject({ output: null, status: "completed", exitCode: null });
});

test("native command report pressure refuses explicitly before exceeding the aggregate private budget", () => {
  const decoder = stream();
  let accepted = 0;
  expect(() => {
    for (let index = 0; index < 128; index++) {
      decoder.accept(
        notify("item/started", {
          threadId,
          turnId,
          item: commandItem({
            id: `bounded-command-${index}`,
            command: "x".repeat(16_384),
            aggregatedOutput: "y".repeat(16_384),
          }),
        }),
      );
      accepted++;
    }
  }).toThrow("private report bound");
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(64);
});
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
  expect(() =>
    decoder.accept(
      notify("item/commandExecution/outputDelta", {
        threadId,
        turnId,
        itemId: "tool-a",
        delta: "tool body",
      }),
    ),
  ).toThrow("command");
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
  expect(() =>
    decoder.accept(notify("thread/started", { thread: { id: turnId } })),
  ).toThrow("identity");
  expect(() => parseCodexAppServerFrame("{")).toThrow("malformed");
  expect(() => parseCodexAppServerFrame(" ".repeat(1_048_577))).toThrow(
    "bound",
  );
});

test("documented global warnings stay private while scoped foreign or malformed warnings refuse", () => {
  const beforeThread = createCodexChatStream({
    launch,
    version: capabilities.version,
    resumeThreadId: null,
  });
  expect(
    beforeThread.accept(
      notify("warning", { threadId: null, message: "private global warning" }),
    ),
  ).toEqual({ events: [], approvals: [], resolved: [] });
  const decoder = stream();
  expect(
    decoder.accept(
      notify("warning", { threadId, message: "private scoped warning" }),
    ).events,
  ).toEqual([]);
  expect(() =>
    decoder.accept(notify("warning", { threadId: turnId, message: "foreign" })),
  ).toThrow("identity");
  for (const params of [
    { threadId: null, message: 1 },
    { message: "missing scope field" },
    { threadId: null, message: "x".repeat(16_385) },
  ])
    expect(() => decoder.accept(notify("warning", params))).toThrow();
  expect(() =>
    decoder.accept(notify("future/notification", { threadId: null })),
  ).toThrow("identity");
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
      startedAtMs: 1,
      item: {
        type: method,
        id: "approval-item",
        ...(method === "commandExecution"
          ? {
              command: "echo private-command",
              cwd: launch.cwd,
              status: "inProgress",
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            }
          : {}),
      },
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
        item: {
          type: "commandExecution",
          id: `tool-${index}`,
          command: "inert command",
          cwd: launch.cwd,
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
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
