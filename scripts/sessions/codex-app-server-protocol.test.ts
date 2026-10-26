import { expect, test } from "bun:test";
import type {
  CodexChatCapabilities,
  CodexChatEvent,
  CodexChatLaunch,
  CodexChatTurnPlan,
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
function stream(
  selected: CodexChatLaunch = launch,
  serviceTier?: unknown,
  onThreadEvents?: (events: CodexChatEvent[]) => void,
) {
  const decoder = createCodexChatStream({
    launch: selected,
    version: capabilities.version,
    resumeThreadId: threadId,
  });
  const threadResult = decoder.thread({
    thread: {
      id: threadId,
      sessionId: threadId,
      forkedFromId: null,
      parentThreadId: null,
      status: { type: "idle" },
    },
    model: selected.model,
    modelProvider: "openai",
    ...(serviceTier === undefined ? {} : { serviceTier }),
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
  onThreadEvents?.(threadResult.events);
  decoder.armTurn();
  decoder.turn({ turn: { id: turnId, status: "inProgress" } });
  return decoder;
}

test("native Start/Resume tier evidence distinguishes omission, null, string and malformed values", () => {
  const capture = (tier?: unknown) => {
    let events: CodexChatEvent[] = [];
    stream(launch, tier, (received) => (events = received));
    return events.find((event) => event.kind === "configuration");
  };
  const absent = capture();
  expect(absent).toBeDefined();
  if (absent?.kind !== "configuration") throw Error("Missing config event");
  expect(Object.hasOwn(absent, "serviceTier")).toBe(false);

  const knownNull = capture(null);
  expect(knownNull).toMatchObject({ kind: "configuration", serviceTier: null });
  const knownValue = capture("priority");
  expect(knownValue).toMatchObject({
    kind: "configuration",
    serviceTier: "priority",
  });

  for (const invalid of [false, "x".repeat(129)])
    expect(() => capture(invalid)).toThrow();
});
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
const reasoningItem = (overrides: Record<string, unknown> = {}) => ({
  type: "reasoning",
  id: "native-summary",
  summary: [],
  content: ["RAW_SENTINEL"],
  ...overrides,
});
const mcpToolCallItem = (overrides: Record<string, unknown> = {}) => ({
  type: "mcpToolCall",
  id: "native-mcp-call",
  server: "local-server",
  tool: "search_files",
  status: "inProgress",
  arguments: { query: "literal <script> prompt" },
  appContext: {
    connectorId: "connector-secret",
    linkId: null,
    resourceUri: "file:///private/resource",
    appName: "Private app hint",
    actionName: "Private action hint",
  },
  mcpAppResourceUri: "file:///private/legacy-resource",
  mcpAppUi: {
    resourceUri: "file:///private/ui-resource",
    preferredModelDisplayMode: "inline",
  },
  pluginId: "private-plugin-id",
  readOnlyHint: true,
  result: null,
  error: null,
  durationMs: null,
  ...overrides,
});
const webSearchItem = (overrides: Record<string, unknown> = {}) => ({
  type: "webSearch",
  id: "native-web-search",
  query: "literal <script> query",
  action: {
    type: "search",
    query: "literal <script> query",
    queries: null,
  },
  results: [{ title: "Literal title", url: "https://example.invalid/path" }],
  ...overrides,
});
const summaryFrame = (method: string, extra: Record<string, unknown> = {}) =>
  notify(method, { threadId, turnId, itemId: "native-summary", ...extra });

test("native MCP tool calls preserve literal snapshots and separate item and turn closure", () => {
  const decoder = stream(),
    started = decoder.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: mcpToolCallItem(),
      }),
    );
  expect(started.events).toHaveLength(1);
  expect(started.events[0]).toMatchObject({
    kind: "mcp-tool-call",
    source: "item/started",
    threadId,
    turnId,
    itemId: "native-mcp-call",
    status: "inProgress",
    arguments: {
      json: '{"query":"literal <script> prompt"}',
      truncated: false,
    },
    result: null,
    error: null,
    durationMs: null,
    partial: true,
    closure: "open",
    turnStatus: null,
  });
  const completedItem = mcpToolCallItem({
    status: "completed",
    result: {
      content: [{ type: "text", text: "Returned <script> as text" }],
      structuredContent: { matches: 2 },
      _meta: { private: "omit this" },
    },
    durationMs: 27,
  });
  const completed = decoder.accept(
    notify("item/completed", { threadId, turnId, item: completedItem }),
  );
  expect(completed.events[0]).toMatchObject({
    source: "item/completed",
    status: "completed",
    result: {
      content: {
        json: '[{"type":"text","text":"Returned <script> as text"}]',
        truncated: false,
      },
      structuredContent: { json: '{"matches":2}', truncated: false },
    },
    error: null,
    durationMs: 27,
    partial: false,
    closure: "item-ended",
    turnStatus: null,
  });
  expect(JSON.stringify(completed.events)).not.toContain("private-resource");
  expect(JSON.stringify(completed.events)).not.toContain("private-plugin-id");
  expect(JSON.stringify(completed.events)).not.toContain("omit this");
  expect(
    decoder.accept(
      notify("item/completed", { threadId, turnId, item: completedItem }),
    ).events,
  ).toEqual([]);
  const ended = decoder.accept(
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "completed",
        error: null,
        items: [completedItem],
      },
    }),
  );
  expect(ended.events[0]).toMatchObject({
    source: "turn/completed",
    closure: "turn-ended",
    turnStatus: "completed",
    partial: false,
  });
  const partial = stream().accept(
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "interrupted",
        error: null,
        items: [
          mcpToolCallItem({
            result: {
              content: [],
              structuredContent: null,
              _meta: null,
            },
            error: { message: "Native error <literal>" },
          }),
        ],
      },
    }),
  );
  expect(partial.events[0]).toMatchObject({
    status: "inProgress",
    result: {
      content: { json: "[]", truncated: false },
      structuredContent: null,
    },
    error: { text: "Native error <literal>", truncated: false },
    partial: true,
    closure: "turn-ended",
    turnStatus: "interrupted",
  });
});

test("native MCP tool calls refuse identity changes, malformed lifecycle and post-terminal snapshots", () => {
  const decoder = stream(),
    started = mcpToolCallItem();
  decoder.accept(notify("item/started", { threadId, turnId, item: started }));
  for (const change of [
    { server: "different-server" },
    { tool: "different-tool" },
    { arguments: { query: "changed" } },
    { type: "commandExecution" },
  ])
    expect(() =>
      decoder.accept(
        notify("item/completed", {
          threadId,
          turnId,
          item: mcpToolCallItem({ ...change, status: "completed" }),
        }),
      ),
    ).toThrow();
  expect(() =>
    decoder.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: mcpToolCallItem({ status: "completed" }),
      }),
    ),
  ).toThrow();
  const complete = mcpToolCallItem({
    status: "failed",
    error: { message: "reported failure" },
  });
  decoder.accept(
    notify("item/completed", { threadId, turnId, item: complete }),
  );
  expect(() =>
    decoder.accept(
      notify("item/completed", {
        threadId,
        turnId,
        item: mcpToolCallItem({
          status: "failed",
          error: { message: "changed failure" },
        }),
      }),
    ),
  ).toThrow();
  decoder.accept(
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", error: null, items: [complete] },
    }),
  );
  expect(() =>
    decoder.accept(
      notify("item/completed", { threadId, turnId, item: complete }),
    ),
  ).toThrow();
});

test("native MCP tool calls refuse foreign thread and turn identities", () => {
  for (const change of [{ threadId: turnId }, { turnId: threadId }])
    expect(() =>
      stream().accept(
        notify("item/started", {
          threadId,
          turnId,
          ...change,
          item: mcpToolCallItem(),
        }),
      ),
    ).toThrow();
});

test("native web-search snapshots retain bounded literal action/results and exact item/turn closure", () => {
  const decoder = stream(),
    started = decoder.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: webSearchItem({ action: null, results: null }),
      }),
    );
  expect(started.events[0]).toMatchObject({
    kind: "web-search",
    source: "item/started",
    threadId,
    turnId,
    itemId: "native-web-search",
    query: { text: "literal <script> query", truncated: false },
    action: null,
    results: null,
    partial: true,
    closure: "open",
    turnStatus: null,
  });
  expect(started.events[0]).not.toHaveProperty("status");
  expect(started.events[0]).not.toHaveProperty("durationMs");
  const completedItem = webSearchItem({
    results: [
      {
        title: "Literal <script> result",
        url: "https://example.invalid/result",
      },
    ],
  });
  const completed = decoder.accept(
    notify("item/completed", { threadId, turnId, item: completedItem }),
  );
  expect(completed.events[0]).toMatchObject({
    source: "item/completed",
    action: {
      json: '{"type":"search","query":"literal <script> query","queries":null}',
      truncated: false,
    },
    results: {
      json: '[{"title":"Literal <script> result","url":"https://example.invalid/result"}]',
      truncated: false,
    },
    partial: false,
    closure: "item-ended",
    turnStatus: null,
  });
  expect(
    decoder.accept(
      notify("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: "interrupted",
          error: null,
          items: [completedItem],
        },
      }),
    ).events[0],
  ).toMatchObject({
    source: "turn/completed",
    partial: true,
    closure: "turn-ended",
    turnStatus: "interrupted",
  });
});

test("native web-search action uses the pinned discriminated union and identity fences", () => {
  for (const action of [
    { type: "search", query: null, queries: [] },
    { type: "openPage", url: "" },
    { type: "findInPage", url: "https://example.invalid", pattern: null },
    { type: "findInPage", url: null, pattern: "" },
    { type: "other" },
  ]) {
    const parsed = stream().accept(
      notify("item/started", {
        threadId,
        turnId,
        item: webSearchItem({ action }),
      }),
    ).events[0];
    expect(parsed).toMatchObject({
      kind: "web-search",
      action: { json: JSON.stringify(action), truncated: false },
    });
  }
  for (const invalid of [
    {
      action: { type: "search", query: "x", queries: null, url: "unexpected" },
    },
    { action: { type: "openPage" } },
    { action: { type: "findInPage", url: null } },
    { action: { type: "open_page", url: "https://example.invalid" } },
    {
      action: {
        type: "find_in_page",
        url: "https://example.invalid",
        pattern: "docs",
      },
    },
    { action: { type: "search", query: "x" } },
    { action: { type: "invented", query: "x" } },
  ])
    expect(() =>
      stream().accept(
        notify("item/started", {
          threadId,
          turnId,
          item: webSearchItem(invalid),
        }),
      ),
    ).toThrow();
  for (const change of [{ threadId: turnId }, { turnId: threadId }])
    expect(() =>
      stream().accept(
        notify("item/started", {
          threadId,
          turnId,
          ...change,
          item: webSearchItem(),
        }),
      ),
    ).toThrow();
});

test("native web-search text and JSON share one UTF-8 report budget with truthful zero-retained clipping", () => {
  const event = stream().accept(
    notify("item/started", {
      threadId,
      turnId,
      item: webSearchItem({
        query: "q".repeat(16_384),
        action: { type: "other" },
        results: [],
      }),
    }),
  ).events[0];
  if (event?.kind !== "web-search")
    throw Error("Missing native web-search report");
  expect(event.query).toEqual({ text: "q".repeat(16_384), truncated: false });
  expect(event.action).toEqual({ json: "", truncated: true });
  expect(event.results).toEqual({ json: "", truncated: true });
});

test("native file changes retain distinct full replacement snapshots, exact statuses and one matching final closure", () => {
  const decoder = stream();
  const changes = [
    {
      path: "new.txt",
      kind: { type: "add" },
      diff: "+new <script>literal</script>",
    },
    { path: "old.txt", kind: { type: "delete" }, diff: "-old" },
    {
      path: "from.txt",
      kind: { type: "update", move_path: "../native-display-only/to.txt" },
      diff: "",
    },
  ];
  const item = {
    type: "fileChange",
    id: "native-files",
    status: "inProgress",
    changes,
  };
  const report = (source: string, value = item) =>
    decoder.accept(notify(source, { threadId, turnId, item: value })).events;
  const started = report("item/started");
  expect(started).toEqual([
    {
      kind: "file-change",
      source: "item/started",
      threadId,
      turnId,
      itemId: "native-files",
      status: "inProgress",
      closure: "open",
      turnStatus: null,
      partial: true,
      truncated: false,
      changes: [
        {
          path: { text: "new.txt", truncated: false },
          kind: { type: "add" },
          diff: { text: "+new <script>literal</script>", truncated: false },
        },
        {
          path: { text: "old.txt", truncated: false },
          kind: { type: "delete" },
          diff: { text: "-old", truncated: false },
        },
        {
          path: { text: "from.txt", truncated: false },
          kind: {
            type: "update",
            move_path: {
              text: "../native-display-only/to.txt",
              truncated: false,
            },
          },
          diff: { text: "", truncated: false },
        },
      ],
    },
  ]);
  const first = started[0];
  if (first?.kind !== "file-change")
    throw Error("Missing native file snapshot");
  expect(report("item/started")).toEqual([]);
  const update = () =>
    decoder.accept(
      notify("item/fileChange/patchUpdated", {
        threadId,
        turnId,
        itemId: item.id,
        changes: [],
      }),
    ).events;
  expect(update()).toEqual([
    { ...first, source: "item/fileChange/patchUpdated", changes: [] },
  ]);
  expect(update()).toEqual([]);
  expect(decoder.state().terminal).toBeNull();
  const final = { ...item, changes: [], status: "declined" };
  const completed = report("item/completed", final);
  expect(completed).toEqual([
    {
      ...first,
      source: "item/completed",
      changes: [],
      status: "declined",
      closure: "item-ended",
      partial: false,
    },
  ]);
  const closed = completed[0];
  if (closed?.kind !== "file-change")
    throw Error("Missing closed file snapshot");
  expect(report("item/completed", final)).toEqual([]);
  const ended = decoder.accept(
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "failed", error: {}, items: [final] },
    }),
  ).events;
  expect(ended).toEqual([
    {
      ...closed,
      source: "turn/completed",
      closure: "turn-ended",
      turnStatus: "failed",
      partial: true,
    },
  ]);
  expect(decoder.state().terminal).toBe("failed");
});

test("file-change wire rejects malformed kinds, missing native bodies, foreign identities and any completed-item reopening", () => {
  const original = {
    type: "fileChange",
    id: "native-files",
    status: "inProgress",
    changes: [
      { path: "a", kind: { type: "update", move_path: null }, diff: "native" },
    ],
  };
  const send = (
    decoder: ReturnType<typeof stream>,
    item: unknown,
    method = "item/started",
  ) => decoder.accept(notify(method, { threadId, turnId, item }));
  for (const item of [
    {
      ...original,
      changes: [{ path: "a", kind: { type: "rename" }, diff: "" }],
    },
    {
      ...original,
      changes: [{ path: "a", kind: { type: "update" }, diff: "" }],
    },
    { ...original, changes: [{ path: "a", kind: { type: "add" } }] },
    {
      ...original,
      changes: [{ path: "", kind: { type: "delete" }, diff: "" }],
    },
    {
      ...original,
      changes: [
        { path: "a", kind: { type: "add" }, diff: "", raw: "unrecognized" },
      ],
    },
    { ...original, status: "applied" },
    { ...original, status: "completed" },
  ])
    expect(() => send(stream(), item)).toThrow();
  const patch = { threadId, turnId, itemId: original.id, changes: [] };
  expect(() =>
    stream().accept(notify("item/fileChange/patchUpdated", patch)),
  ).toThrow("active known");
  for (const change of [
    { threadId: "0199a213-81c0-7800-8aa1-bbab2a035a55" },
    { turnId: "0199a213-81c0-7800-8aa1-bbab2a035a55" },
    { status: "completed" },
    { itemId: "unknown" },
  ]) {
    const decoder = stream();
    send(decoder, original);
    expect(() =>
      decoder.accept(
        notify("item/fileChange/patchUpdated", { ...patch, ...change }),
      ),
    ).toThrow();
  }
  const decoder = stream();
  send(decoder, original);
  expect(() => send(decoder, commandItem({ id: original.id }))).toThrow(
    "identity",
  );
  const completed = { ...original, status: "failed" };
  send(decoder, completed, "item/completed");
  expect(() =>
    decoder.accept(notify("item/fileChange/patchUpdated", patch)),
  ).toThrow("active known");
  expect(() => send(decoder, original)).toThrow("completed");
  expect(() =>
    send(decoder, { ...completed, changes: [] }, "item/completed"),
  ).toThrow("completed");
  expect(() =>
    decoder.accept(
      notify("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: "completed",
          error: null,
          items: [{ ...completed, changes: [] }],
        },
      }),
    ),
  ).toThrow("completed");
});

test("file replacement snapshots retain UTF-8 prefixes and explicit truncation; empty strings and all native patch statuses remain distinct", () => {
  const item = {
    type: "fileChange",
    id: "native-files",
    status: "inProgress",
    changes: [{ path: "x", kind: { type: "add" }, diff: "🌱".repeat(5000) }],
  };
  const decoder = stream();
  const report = decoder.accept(
    notify("item/started", { threadId, turnId, item }),
  ).events[0];
  if (report?.kind !== "file-change")
    throw Error("Missing bounded native file snapshot");
  expect(report.truncated).toBe(true);
  expect(report.changes[0]?.diff).toEqual({
    text: "🌱".repeat(4095),
    truncated: true,
  });
  const snapshot = (diff: string) =>
    decoder.accept(
      notify("item/fileChange/patchUpdated", {
        threadId,
        turnId,
        itemId: item.id,
        changes: [{ path: "x", kind: { type: "add" }, diff }],
      }),
    ).events;
  for (const text of ["A", "B", "A", ""]) {
    const event = snapshot(text)[0];
    if (event?.kind !== "file-change")
      throw Error("Missing distinct replacement snapshot");
    expect(event.changes[0]?.diff).toEqual({ text, truncated: false });
  }
  expect(
    decoder.accept(
      notify("item/fileChange/outputDelta", {
        threadId,
        turnId,
        itemId: item.id,
        delta: "DEPRECATED NOT RETAINED",
      }),
    ).events,
  ).toEqual([]);
  const many = stream().accept(
    notify("item/started", {
      threadId,
      turnId,
      item: {
        ...item,
        changes: Array.from({ length: 129 }, () => ({
          path: "x",
          kind: { type: "add" },
          diff: "",
        })),
      },
    }),
  ).events[0];
  if (many?.kind !== "file-change")
    throw Error("Missing item-limited file snapshot");
  expect(many.changes).toHaveLength(128);
  expect(many.truncated).toBe(true);
  for (const status of ["completed", "failed", "declined"] as const) {
    const ended = stream().accept(
      notify("item/completed", {
        threadId,
        turnId,
        item: { ...item, status, changes: [] },
      }),
    ).events[0];
    expect(ended).toMatchObject({
      status,
      partial: false,
      closure: "item-ended",
      turnStatus: null,
    });
  }
  const final = stream().accept(
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "completed",
        error: null,
        items: [{ ...item, changes: [] }],
      },
    }),
  ).events[0];
  expect(final).toMatchObject({
    status: "inProgress",
    partial: true,
    closure: "turn-ended",
    turnStatus: "completed",
  });
});

test("file snapshots share the existing private event, aggregate and native item bounds with other rich reports", () => {
  const file = {
    type: "fileChange",
    id: "native-files",
    status: "inProgress",
    changes: [
      { path: "x", kind: { type: "add" }, diff: "\u0001".repeat(16_383) },
    ],
  };
  expect(() =>
    stream().accept(notify("item/started", { threadId, turnId, item: file })),
  ).toThrow("private event bound");
  const decoder = stream();
  let retainedBytes = 0,
    refusal = "";
  for (let index = 0; index < 140; index++) {
    try {
      const events =
        index % 2 === 0
          ? decoder.accept(
              notify("item/started", {
                threadId,
                turnId,
                item: {
                  ...file,
                  id: `file-${index}`,
                  changes: [
                    {
                      path: "x",
                      kind: { type: "add" },
                      diff: "y".repeat(16_383),
                    },
                  ],
                },
              }),
            ).events
          : decoder.accept(
              notify("turn/plan/updated", {
                threadId,
                turnId,
                explanation: "z".repeat(16_384),
                plan: [],
              }),
            ).events;
      for (const event of events)
        retainedBytes += new TextEncoder().encode(
          JSON.stringify(event),
        ).byteLength;
    } catch (error) {
      refusal = error instanceof Error ? error.message : "unexpected";
      break;
    }
  }
  expect(refusal).toContain("private report bound");
  expect(retainedBytes).toBeGreaterThan(1_048_576);
  expect(retainedBytes).toBeLessThanOrEqual(2_097_152);
  const limited = stream();
  for (let index = 0; index < 256; index++)
    limited.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: { ...file, id: `file-${index}`, changes: [] },
      }),
    );
  expect(() =>
    limited.accept(
      notify("item/started", { threadId, turnId, item: commandItem() }),
    ),
  ).toThrow("items");
});

test("turn plans retain mutable and repeated native replacement snapshots without creating items or turn completion", () => {
  const decoder = stream(),
    first = {
      threadId,
      turnId,
      explanation: null,
      plan: [{ step: "Original step", status: "completed" }],
    },
    update = (value: unknown) =>
      decoder.accept(notify("turn/plan/updated", value)).events;
  const expected: CodexChatTurnPlan = {
    kind: "turn-plan",
    source: "turn/plan/updated",
    threadId,
    turnId,
    explanation: null,
    plan: [
      {
        step: { text: "Original step", truncated: false },
        status: "completed",
      },
    ],
    truncated: false,
  };
  expect(update(first)).toEqual([expected]);
  expect(update(first)).toEqual([expected]);
  expect(decoder.state().terminal).toBeNull();
  const changed = update({
    ...first,
    explanation: "A revised plan",
    plan: [
      { step: "Changed step", status: "pending" },
      { step: "Additional step", status: "inProgress" },
    ],
  });
  expect(changed[0]).toMatchObject({
    explanation: { text: "A revised plan" },
    plan: [
      { step: { text: "Changed step" }, status: "pending" },
      { status: "inProgress" },
    ],
  });
  expect(update({ ...first, explanation: "", plan: [] })).toEqual([
    { ...expected, explanation: { text: "", truncated: false }, plan: [] },
  ]);
  expect(expected).not.toHaveProperty("itemId");
  expect(
    decoder.accept(
      notify("item/plan/delta", {
        threadId,
        turnId,
        itemId: "unreported-plan-item",
        delta: "Experimental independent text",
      }),
    ).events,
  ).toEqual([]);
  expect(
    decoder.accept(
      notify("turn/diff/updated", {
        threadId,
        turnId,
        diff: "Separate unreported diff",
      }),
    ).events,
  ).toEqual([]);
});

test("turn plans refuse missing or foreign native scope, malformed statuses and post-terminal reports", () => {
  const decoder = stream(),
    valid = {
      threadId,
      turnId,
      explanation: null,
      plan: [{ step: "Supplied", status: "pending" }],
    };
  for (const change of [
    { threadId: turnId },
    { turnId: threadId },
    { threadId: undefined },
    { turnId: undefined },
    { explanation: undefined },
    { explanation: 3 },
    { plan: null },
    { plan: [{ step: "bad", status: "in-progress" }] },
    { plan: [{ step: 7, status: "pending" }] },
  ])
    expect(() =>
      decoder.accept(notify("turn/plan/updated", { ...valid, ...change })),
    ).toThrow();
  decoder.accept(
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "completed", error: null, items: [] },
    }),
  );
  expect(() => decoder.accept(notify("turn/plan/updated", valid))).toThrow(
    "terminal",
  );
});

test("turn plans clip combined UTF-8 explanation and steps and share the command and summary budget", () => {
  const decoder = stream(),
    report = decoder.accept(
      notify("turn/plan/updated", {
        threadId,
        turnId,
        explanation: "🌱".repeat(4095),
        plan: [{ step: "🌱more", status: "completed" }],
      }),
    ).events[0];
  expect(report).toMatchObject({
    kind: "turn-plan",
    explanation: { truncated: false },
    plan: [{ step: { text: "🌱", truncated: true }, status: "completed" }],
    truncated: true,
  });
  const list = decoder.accept(
    notify("turn/plan/updated", {
      threadId,
      turnId,
      explanation: null,
      plan: Array.from({ length: 129 }, () => ({
        step: "x",
        status: "pending",
      })),
    }),
  ).events[0];
  if (list?.kind !== "turn-plan") throw Error("Missing bounded native plan");
  expect(list.plan).toHaveLength(128);
  expect(list.truncated).toBe(true);
  const combined = stream();
  for (let index = 0; index < 20; index++)
    combined.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: commandItem({
          id: `budget-command-${index}`,
          command: "x".repeat(16_384),
          aggregatedOutput: "y".repeat(16_384),
        }),
      }),
    );
  for (let index = 0; index < 40; index++)
    combined.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: reasoningItem({
          id: `budget-summary-${index}`,
          summary: ["z".repeat(16_384)],
        }),
      }),
    );
  let accepted = 0;
  for (; accepted < 100; accepted++) {
    try {
      combined.accept(
        notify("turn/plan/updated", {
          threadId,
          turnId,
          explanation: null,
          plan: [{ step: "p".repeat(16_384), status: "completed" }],
        }),
      );
    } catch (cause) {
      expect(String(cause)).toContain("private report bound");
      break;
    }
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(100);
});

test("explicit reasoning summaries preserve independent indexed streams and snapshots without inventing an unannounced prefix", () => {
  const decoder = stream(),
    started = notify("item/started", {
      threadId,
      turnId,
      item: reasoningItem(),
    });
  expect(decoder.accept(started).events[0]).toMatchObject({
    kind: "reasoning-summary",
    update: { kind: "snapshot", summary: [], closure: "open" },
    partial: true,
  });
  expect(decoder.accept(started).events).toEqual([]);
  const part = summaryFrame("item/reasoning/summaryPartAdded", {
    summaryIndex: 0,
  });
  expect(decoder.accept(part).events[0]).toMatchObject({
    update: { kind: "part-added", summaryIndex: 0 },
  });
  expect(decoder.accept(part).events).toEqual([]);
  expect(
    decoder.accept(
      summaryFrame("item/reasoning/summaryTextDelta", {
        summaryIndex: 0,
        delta: "Announced visible summary",
      }),
    ).events[0],
  ).toMatchObject({
    update: { kind: "delta", summaryIndex: 0, prefixMissing: false },
  });
  expect(
    decoder.accept(
      summaryFrame("item/reasoning/summaryTextDelta", {
        summaryIndex: 1,
        delta: "Unannounced suffix",
      }),
    ).events[0],
  ).toMatchObject({ update: { summaryIndex: 1, prefixMissing: true } });
  decoder.accept(
    summaryFrame("item/reasoning/summaryPartAdded", { summaryIndex: 1 }),
  );
  expect(
    decoder.accept(
      summaryFrame("item/reasoning/summaryTextDelta", {
        summaryIndex: 1,
        delta: " still incomplete",
      }),
    ).events[0],
  ).toMatchObject({ update: { prefixMissing: true } });
  const completed = notify("item/completed", {
    threadId,
    turnId,
    item: reasoningItem({ summary: ["Different final summary snapshot"] }),
  });
  const report = decoder.accept(completed).events[0];
  expect(report).toMatchObject({
    source: "item/completed",
    update: {
      summary: [{ text: "Different final summary snapshot", truncated: false }],
      closure: "item-ended",
    },
    partial: false,
  });
  expect(JSON.stringify(report)).not.toContain("RAW_SENTINEL");
  expect(decoder.accept(completed).events).toEqual([]);
  const ended = decoder.accept(
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "interrupted",
        error: null,
        items: [
          reasoningItem({ summary: ["Different final summary snapshot"] }),
        ],
      },
    }),
  );
  expect(ended.events[0]).toMatchObject({
    source: "turn/completed",
    update: { closure: "turn-ended", turnStatus: "interrupted" },
  });
  const finalOnly = stream().accept(
    notify("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "interrupted",
        error: null,
        items: [reasoningItem({ summary: ["Saved at interruption"] })],
      },
    }),
  );
  expect(finalOnly.events[0]).toMatchObject({
    partial: true,
    update: { closure: "turn-ended", turnStatus: "interrupted" },
  });
});

test("the native decoder shares its existing 256 item limit across messages, commands, summaries and MCP calls", () => {
  for (const lastItem of [
    reasoningItem({ id: "last-reasoning" }),
    mcpToolCallItem({ id: "last-mcp" }),
    webSearchItem({ id: "last-web-search" }),
  ]) {
    const decoder = stream();
    for (let index = 0; index < 255; index++)
      decoder.accept(
        notify("item/started", {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: `message-${index}`,
            text: "Visible text",
          },
        }),
      );
    expect(
      decoder.accept(
        notify("item/started", { threadId, turnId, item: lastItem }),
      ).events,
    ).toHaveLength(1);
    expect(() =>
      decoder.accept(
        notify("item/started", {
          threadId,
          turnId,
          item: commandItem(),
        }),
      ),
    ).toThrow("bound");
  }
});

test("native MCP fields share one UTF-8 report budget and the existing rich-event aggregate", () => {
  const clipped = stream().accept(
    notify("item/started", {
      threadId,
      turnId,
      item: mcpToolCallItem({
        server: "s".repeat(16_383),
        tool: "🌱",
        arguments: { query: "bounded" },
        result: {
          content: [{ text: "returned" }],
          structuredContent: { total: 1 },
          _meta: null,
        },
        error: { message: "reported" },
      }),
    }),
  ).events[0];
  if (clipped?.kind !== "mcp-tool-call")
    throw Error("Missing native MCP report");
  const retained = [
    clipped.server.text,
    clipped.tool.text,
    clipped.arguments.json,
    clipped.result?.content.json ?? "",
    clipped.result?.structuredContent?.json ?? "",
    clipped.error?.text ?? "",
  ].join("");
  expect(new TextEncoder().encode(retained).byteLength).toBe(16_384);
  expect(clipped.server.truncated).toBe(false);
  expect(clipped.tool).toEqual({ text: "", truncated: true });
  expect(clipped.arguments.truncated).toBe(true);
  expect(clipped.result?.content.truncated).toBe(true);
  expect(clipped.result?.structuredContent?.truncated).toBe(true);
  expect(clipped.error?.truncated).toBe(true);

  const pressured = stream();
  let accepted = 0;
  expect(() => {
    for (let index = 0; index < 160; index++) {
      pressured.accept(
        notify("item/started", {
          threadId,
          turnId,
          item: mcpToolCallItem({
            id: `bounded-mcp-${index}`,
            server: "s".repeat(16_384),
          }),
        }),
      );
      accepted++;
    }
  }).toThrow("private report bound");
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(160);
});

test("commands, file changes and MCP calls consume the same native rich-report aggregate", () => {
  const decoder = stream();
  for (let index = 0; index < 40; index++)
    decoder.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: commandItem({
          id: `mixed-command-${index}`,
          command: "x".repeat(16_384),
          aggregatedOutput: "y".repeat(16_384),
        }),
      }),
    );
  for (let index = 0; index < 40; index++)
    decoder.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: {
          type: "fileChange",
          id: `mixed-files-${index}`,
          status: "inProgress",
          changes: [
            {
              path: `file-${index}.txt`,
              kind: { type: "add" },
              diff: "z".repeat(16_384),
            },
          ],
        },
      }),
    );
  let mcpCalls = 0;
  expect(() => {
    for (let index = 0; index < 100; index++) {
      decoder.accept(
        notify("item/started", {
          threadId,
          turnId,
          item: mcpToolCallItem({
            id: `mixed-mcp-${index}`,
            server: "m".repeat(16_384),
          }),
        }),
      );
      mcpCalls++;
    }
  }).toThrow("private report bound");
  expect(mcpCalls).toBeGreaterThan(0);
  expect(mcpCalls).toBeLessThan(100);
});

test("reasoning summaries refuse foreign or malformed parts and closed content while raw content cannot create summary facts", () => {
  const decoder = stream();
  expect(() =>
    decoder.accept(
      summaryFrame("item/reasoning/summaryTextDelta", {
        summaryIndex: 0,
        delta: "unknown",
      }),
    ),
  ).toThrow("known reasoning item");
  decoder.accept(
    notify("item/started", { threadId, turnId, item: reasoningItem() }),
  );
  for (const change of [
    { threadId: turnId },
    { turnId: threadId },
    { itemId: "unknown" },
    { summaryIndex: -1 },
    { summaryIndex: 128 },
    { summaryIndex: 0.5 },
    { summaryIndex: undefined, contentIndex: 0 },
    { delta: 123 },
  ])
    expect(() =>
      decoder.accept(
        summaryFrame("item/reasoning/summaryTextDelta", {
          summaryIndex: 0,
          delta: "visible",
          ...change,
        }),
      ),
    ).toThrow();
  for (const method of [
    "item/reasoning/textDelta",
    "rawResponseItem/completed",
  ])
    expect(
      decoder.accept(
        summaryFrame(method, {
          contentIndex: 0,
          delta: "RAW_SENTINEL",
          item: { type: "reasoning", encrypted_content: "RAW_SENTINEL" },
        }),
      ).events,
    ).toEqual([]);
  expect(() =>
    decoder.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: reasoningItem({ summary: [123] }),
      }),
    ),
  ).toThrow();
  const completed = notify("item/completed", {
    threadId,
    turnId,
    item: reasoningItem({ summary: ["final"] }),
  });
  decoder.accept(completed);
  expect(() =>
    decoder.accept(
      summaryFrame("item/reasoning/summaryTextDelta", {
        summaryIndex: 0,
        delta: "late",
      }),
    ),
  ).toThrow("known reasoning item");
  expect(() =>
    decoder.accept(
      notify("item/completed", {
        threadId,
        turnId,
        item: reasoningItem({ summary: ["conflicting final"] }),
      }),
    ),
  ).toThrow("final report");
  decoder.accept(
    notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "completed", items: [], error: null },
    }),
  );
  expect(() =>
    decoder.accept(
      summaryFrame("item/reasoning/summaryPartAdded", { summaryIndex: 0 }),
    ),
  ).toThrow("terminal");
});

test("reasoning streams clip per item on UTF-8 boundaries without repairing gaps or mixing interleaved items", () => {
  const decoder = stream();
  for (const id of ["native-summary", "other-summary"])
    decoder.accept(
      notify("item/started", { threadId, turnId, item: reasoningItem({ id }) }),
    );
  decoder.accept(
    summaryFrame("item/reasoning/summaryPartAdded", { summaryIndex: 0 }),
  );
  const output = (delta: string, extra: Record<string, unknown> = {}) =>
    decoder.accept(
      summaryFrame("item/reasoning/summaryTextDelta", {
        summaryIndex: 0,
        delta,
        ...extra,
      }),
    ).events;
  expect(output("🌱".repeat(4095))[0]).toMatchObject({
    update: { content: { text: "🌱".repeat(4095), truncated: false } },
  });
  expect(output("\0🌱")[0]).toMatchObject({
    update: { content: { text: "�", truncated: true } },
  });
  expect(output("cannot resume")).toEqual([]);
  expect(
    output("Independent other item", { itemId: "other-summary" })[0],
  ).toMatchObject({
    itemId: "other-summary",
    update: {
      content: { text: "Independent other item", truncated: false },
      prefixMissing: true,
    },
  });
  expect(output("", { summaryIndex: 1 })).toEqual([]);
  decoder.accept(
    summaryFrame("item/reasoning/summaryPartAdded", { summaryIndex: 1 }),
  );
  expect(output("x", { summaryIndex: 1 })[0]).toMatchObject({
    update: { prefixMissing: false, content: { text: "x", truncated: false } },
  });
  const list = stream().accept(
    notify("item/completed", {
      threadId,
      turnId,
      item: reasoningItem({ summary: Array.from({ length: 129 }, () => "x") }),
    }),
  );
  expect(list.events[0]).toMatchObject({ update: { truncated: true } });
  if (
    list.events[0]?.kind !== "reasoning-summary" ||
    list.events[0].update.kind !== "snapshot"
  )
    throw Error("Missing bounded summary snapshot");
  expect(list.events[0].update.summary).toHaveLength(128);
  expect(list.events[0].update.summary[0]).toEqual({
    text: "x",
    truncated: false,
  });
});

test("native summaries and commands consume one shared rich-report budget", () => {
  const decoder = stream();
  for (let index = 0; index < 40; index++)
    decoder.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: commandItem({
          id: `command-${index}`,
          command: "x".repeat(16_384),
          aggregatedOutput: "y".repeat(16_384),
        }),
      }),
    );
  let summaries = 0;
  expect(() => {
    for (let index = 0; index < 64; index++) {
      decoder.accept(
        notify("item/completed", {
          threadId,
          turnId,
          item: reasoningItem({
            id: `summary-${index}`,
            summary: ["z".repeat(16_384)],
          }),
        }),
      );
      summaries++;
    }
  }).toThrow("private report bound");
  expect(summaries).toBeGreaterThan(0);
  expect(summaries).toBeLessThan(64);
});

test("native web-search reports consume the existing mixed-family rich-report budget", () => {
  const decoder = stream();
  for (let index = 0; index < 40; index++)
    decoder.accept(
      notify("item/started", {
        threadId,
        turnId,
        item: commandItem({
          id: `budget-command-${index}`,
          command: "x".repeat(16_384),
          aggregatedOutput: "y".repeat(16_384),
        }),
      }),
    );
  let searches = 0;
  expect(() => {
    for (let index = 0; index < 128; index++) {
      decoder.accept(
        notify("item/started", {
          threadId,
          turnId,
          item: webSearchItem({
            id: `budget-search-${index}`,
            query: "q".repeat(16_384),
            action: null,
            results: null,
          }),
        }),
      );
      searches++;
    }
  }).toThrow("private report bound");
  expect(searches).toBeGreaterThan(0);
  expect(searches).toBeLessThan(128);
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
  const interrupted = stream();
  expect(
    interrupted.accept(
      notify("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status: "interrupted",
          error: null,
          items: [
            commandItem({ aggregatedOutput: "Reported unfinished aggregate" }),
          ],
        },
      }),
    ).events[0],
  ).toMatchObject({
    source: "turn/completed",
    status: "inProgress",
    partial: true,
    output: { text: "Reported unfinished aggregate", truncated: false },
  });
  expect(() =>
    interrupted.accept(
      notify("item/commandExecution/outputDelta", {
        threadId,
        turnId,
        itemId: "native-command",
        delta: "too late",
      }),
    ),
  ).toThrow("terminal");
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
          : { status: "inProgress", changes: [] }),
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
