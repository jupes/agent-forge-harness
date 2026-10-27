import { appendFileSync } from "node:fs";

/** Inert native-process app-server fixture. No provider, account, shell or network access. */
const argv = process.argv.slice(2),
  log = process.env.CODEX_CHAT_LOG;
const mode = process.env.CODEX_CHAT_MODE;
const serviceTierAwareMode =
    mode === "service-tier-null" ||
    mode === "fork-service-tier-null" ||
    mode === "fork-service-tier-priority" ||
    mode === "fork-child-lost-turn-reply",
  forkServiceTierResumeMode =
    mode === "fork-service-tier-null" ||
    mode === "fork-service-tier-priority" ||
    mode === "fork-child-lost-turn-reply",
  configuredServiceTier =
    mode === "fork-service-tier-priority" ? "priority" : null;
if (argv.includes("--child"))
  await new Promise(() => setInterval(() => {}, 1000));
const record = (value: unknown) => {
  if (log) appendFileSync(log, `${JSON.stringify(value)}\n`);
};
if (argv.includes("--version")) {
  record({ kind: "version" });
  await Bun.stdout.write("codex-cli 0.163.0-alpha.10.2\n");
  process.exit(0);
}
if (argv.includes("--help")) {
  record({ kind: "help" });
  await Bun.stdout.write(
    "Usage: codex app-server\n  --stdio\n  --listen <URL>\n",
  );
  process.exit(0);
}
if (argv.includes("--sync")) {
  record({ kind: "sync", cwd: process.cwd() });
  process.exit(0);
}
record({
  kind: "process",
  argv,
  cwd: process.cwd(),
  pid: process.pid,
  allowed: process.env.TEST_ALLOWED,
  secret: process.env.TEST_SECRET,
  forged: process.env.AGENT_FORGE_FORGED,
  slug: process.env.FORGE_SLUG,
});
let threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const firstTurnId = "0199a213-81c0-7800-8aa1-bbab2a035a54",
  resumedTurnId = "0199a213-81c0-7800-8aa1-bbab2a035a55";
let turnId = firstTurnId;
let model = "",
  cwd = "",
  resuming = false,
  sandbox = "workspace-write",
  approvalPolicy = "on-request";
const send = async (value: unknown) => {
  await Bun.stdout.write(`${JSON.stringify(value)}\n`);
};
const hangTree = () => {
  const child = Bun.spawn([process.execPath, import.meta.filename, "--child"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  record({ kind: "tree", pid: process.pid, childPid: child.pid });
  setInterval(() => {}, 1000);
};
const finish = async (extraItems: unknown[] = []) => {
  const scope = { threadId, turnId };
  await send({
    method: "item/agentMessage/delta",
    params: { ...scope, itemId: "message-a", delta: "Hello" },
  });
  const item = { type: "agentMessage", id: "message-a", text: "Hello world" };
  await send({
    method: "item/completed",
    params: { ...scope, item, completedAtMs: 1 },
  });
  await send({
    method: "item/completed",
    params: { ...scope, item, completedAtMs: 1 },
  });
  const usage = {
    inputTokens: 9,
    outputTokens: 6,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 1,
    totalTokens: 15,
  };
  const total = { ...usage, inputTokens: 19, totalTokens: 25 };
  if (mode === "scoped-usage" && resuming) {
    Object.assign(usage, {
      inputTokens: 0,
      outputTokens: 2,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 2,
    });
    Object.assign(total, { inputTokens: 42, outputTokens: 8, totalTokens: 50 });
  }
  await send({
    method: "thread/tokenUsage/updated",
    params: {
      ...scope,
      tokenUsage: {
        last: usage,
        total,
        modelContextWindow: 100,
      },
    },
  });
  await send({
    method: "turn/completed",
    params: {
      threadId,
      turn: {
        id: turnId,
        status: mode === "provider-error" ? "failed" : "completed",
        items: [...extraItems, item],
        error:
          mode === "provider-error"
            ? { message: "private-provider-error" }
            : null,
      },
    },
  });
  if (mode === "bad-exit") process.exit(7);
};
const reportedFileChanges = [
  {
    path: "FILE_REPORT_MUST_NOT_CREATE.txt",
    kind: { type: "update", move_path: "inert/<script>.ts" },
    diff: "-old native line\n+<script>native patch stays text</script>",
  },
  { path: "empty-native.ts", kind: { type: "add" }, diff: "" },
];
const mainFileItem = (status = "inProgress") => ({
  type: "fileChange",
  id: "reported-files-a",
  status,
  changes: reportedFileChanges,
});
const fileChangePrefix = async () => {
  const scope = { threadId, turnId },
    item = mainFileItem();
  await send({
    method: "item/started",
    params: { ...scope, item, startedAtMs: 1 },
  });
  for (const changes of [
    [{ path: "superseded.ts", kind: { type: "delete" }, diff: "-superseded" }],
    [],
    reportedFileChanges,
  ])
    await send({
      method: "item/fileChange/patchUpdated",
      params: { ...scope, itemId: item.id, changes },
    });
  record({
    kind: "file-prefix-published",
    threadId,
    turnId,
    itemId: item.id,
    count: 4,
  });
};
const finishFileChanges = async (status = "completed") => {
  const scope = { threadId, turnId },
    main = mainFileItem(status),
    others = [
      {
        type: "fileChange",
        id: "reported-files-failed",
        status: "failed",
        changes: [
          {
            path: "failed.ts",
            kind: { type: "delete" },
            diff: "-reported failed patch",
          },
        ],
      },
      {
        type: "fileChange",
        id: "reported-files-declined",
        status: "declined",
        changes: [
          {
            path: "declined.ts",
            kind: { type: "add" },
            diff: "+reported declined patch",
          },
        ],
      },
      {
        type: "fileChange",
        id: "reported-files-clipped",
        status: "completed",
        changes: [
          {
            path: "clipped.ts",
            kind: { type: "update", move_path: null },
            diff: `+retained native prefix\n${"x".repeat(20_000)}`,
          },
        ],
      },
    ];
  await send({
    method: "item/completed",
    params: { ...scope, item: main, completedAtMs: 2 },
  });
  for (const item of others) {
    await send({
      method: "item/started",
      params: {
        ...scope,
        item: { ...item, status: "inProgress" },
        startedAtMs: 1,
      },
    });
    await send({
      method: "item/completed",
      params: { ...scope, item, completedAtMs: 2 },
    });
  }
  await finish([main, ...others]);
};
const mcpMain = (status: "inProgress" | "completed" = "inProgress") => ({
  type: "mcpToolCall",
  id: "reported-mcp-main",
  server: "fixture-mcp-server",
  tool: "inspect_result",
  status,
  arguments: {
    path: "FILE_MCP_MUST_NOT_CREATE.txt",
    query: "<script>MCP_ARGUMENT_LITERAL</script>",
  },
  appContext: {
    connectorId: "MCP_HINT_CONNECTOR_MUST_NOT_PERSIST",
    linkId: null,
    resourceUri: "file:///MCP_HINT_CONTEXT_RESOURCE_MUST_NOT_PERSIST",
    appName: "MCP_HINT_APP_MUST_NOT_PERSIST",
    actionName: "MCP_HINT_ACTION_MUST_NOT_PERSIST",
  },
  mcpAppResourceUri: "file:///MCP_HINT_LEGACY_RESOURCE_MUST_NOT_PERSIST",
  mcpAppUi: {
    resourceUri: "file:///MCP_HINT_UI_RESOURCE_MUST_NOT_PERSIST",
    preferredModelDisplayMode: "inline",
  },
  pluginId: "MCP_HINT_PLUGIN_MUST_NOT_PERSIST",
  readOnlyHint: true,
  result:
    status === "inProgress"
      ? null
      : {
          content: [
            {
              type: "text",
              text: "<img>MCP_RESULT_LITERAL</img>",
            },
          ],
          structuredContent: { path: "file:///MCP_RESULT_URI_IS_LITERAL" },
          _meta: { private: "MCP_META_MUST_NOT_PERSIST" },
        },
  error: null,
  durationMs: status === "inProgress" ? null : 27,
});
const mcpOtherCalls = () => [
  {
    type: "mcpToolCall",
    id: "reported-mcp-failed",
    server: "fixture-mcp-server",
    tool: "report_failure",
    status: "failed",
    arguments: { query: "failure is separate from an absent result" },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: { message: "MCP_ERROR_TEXT_SENTINEL" },
    durationMs: 0,
  },
  {
    type: "mcpToolCall",
    id: "reported-mcp-empty",
    server: "fixture-mcp-server",
    tool: "report_empty",
    status: "completed",
    arguments: null,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: { content: [], structuredContent: null, _meta: null },
    error: null,
    durationMs: null,
  },
  {
    type: "mcpToolCall",
    id: "reported-mcp-clipped",
    server: "fixture-mcp-server",
    tool: "report_clipped",
    status: "completed",
    arguments: { query: "x".repeat(40_000) },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: null,
    durationMs: null,
  },
];
const finishMcpToolCalls = async () => {
  const scope = { threadId, turnId },
    started = mcpMain(),
    completed = mcpMain("completed"),
    others = mcpOtherCalls();
  await send({ method: "item/started", params: { ...scope, item: started } });
  await send({ method: "item/started", params: { ...scope, item: started } });
  await send({
    method: "item/completed",
    params: { ...scope, item: completed },
  });
  for (const item of others)
    await send({ method: "item/completed", params: { ...scope, item } });
  await finish([completed, ...others]);
};
const mcpCallPrefix = async () => {
  const scope = { threadId, turnId },
    started = mcpMain(),
    completed = mcpMain("completed"),
    open = {
      ...mcpMain(),
      id: "reported-mcp-open",
      tool: "inspect_while_turn_is_open",
      arguments: { query: "y".repeat(40_000) },
    };
  await send({ method: "item/started", params: { ...scope, item: started } });
  await send({
    method: "item/completed",
    params: { ...scope, item: completed },
  });
  await send({ method: "item/started", params: { ...scope, item: open } });
  record({
    kind: "mcp-prefix-published",
    threadId,
    turnId,
    itemIds: [started.id, open.id],
    count: 3,
  });
};
const webSearchMain = (
  query = "<script>WEB_SEARCH_QUERY_LITERAL</script>",
  id = "reported-web-search-main",
) => ({
  type: "webSearch",
  id,
  query,
  action: {
    type: "search",
    query: "WEB_SEARCH_ACTION_QUERY_LITERAL",
    queries: ["WEB_SEARCH_ACTION_QUERY_LITERAL"],
  },
  results: [
    {
      title: "<img>WEB_SEARCH_RESULT_LITERAL</img>",
      url: "https://fixture.invalid/WEB_SEARCH_URL_IS_LITERAL",
    },
  ],
});
const finishWebSearch = async () => {
  const scope = { threadId, turnId },
    main = webSearchMain(),
    empty = {
      type: "webSearch",
      id: "reported-web-search-empty",
      query: "",
      action: null,
      results: null,
    },
    absent = {
      type: "webSearch",
      id: "reported-web-search-absent",
      query: "WEB_SEARCH_NULL_RESULT_QUERY",
      action: null,
      results: null,
    },
    clipped = webSearchMain(
      `WEB_SEARCH_CLIPPED_QUERY_${"x".repeat(20_000)}`,
      "reported-web-search-clipped",
    ),
    emptyCompleted = { ...empty, results: [] },
    items = [
      { started: { ...main, action: null, results: null }, completed: main },
      { started: empty, completed: emptyCompleted },
      { started: absent, completed: absent },
      {
        started: { ...clipped, action: null, results: null },
        completed: clipped,
      },
    ];
  for (const pair of items) {
    await send({
      method: "item/started",
      params: { ...scope, item: pair.started },
    });
    await send({
      method: "item/completed",
      params: { ...scope, item: pair.completed },
    });
  }
  await finish([main, emptyCompleted, absent, clipped]);
};
const webSearchPrefix = async () => {
  const scope = { threadId, turnId },
    item = {
      type: "webSearch",
      id: "reported-web-search-main",
      query: "<script>WEB_SEARCH_QUERY_LITERAL</script>",
      action: null,
      results: null,
    };
  await send({
    method: "item/started",
    params: { ...scope, item },
  });
};
const reader = Bun.stdin.stream().getReader(),
  decoder = new TextDecoder();
let pending = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  pending += decoder.decode(value, { stream: true });
  if (pending.length > 4_194_304) process.exit(10);
  let newline = pending.indexOf("\n");
  while (newline >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.exit(11);
    }
    if (typeof parsed !== "object" || parsed === null) process.exit(12);
    if (!("method" in parsed)) {
      if (!("id" in parsed) || !("result" in parsed)) process.exit(12);
      record({ kind: "answer", id: parsed.id, result: parsed.result });
      await send({
        method: "serverRequest/resolved",
        params: { threadId, requestId: parsed.id },
      });
      if (
        typeof parsed.result === "object" &&
        parsed.result !== null &&
        "decision" in parsed.result &&
        parsed.result.decision === "cancel"
      ) {
        await send({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "interrupted", items: [], error: null },
          },
        });
      } else if (mode === "file-changes-approval")
        await finishFileChanges("declined");
      else await finish();
      newline = pending.indexOf("\n");
      continue;
    }
    const method = parsed.method;
    const params: Record<string, unknown> =
      "params" in parsed &&
      typeof parsed.params === "object" &&
      parsed.params !== null
        ? (parsed.params as Record<string, unknown>)
        : {};
    const id = "id" in parsed ? parsed.id : null;
    record({ kind: id === null ? "notification" : "rpc", method, params, id });
    if (method === "initialize" && mode === "hang-initialize") {
      hangTree();
    } else if (method === "initialize") {
      if (mode === "fork-initialize-failure")
        await send({
          id,
          error: { code: -32000, message: "Synthetic initialize refusal" },
        });
      else if (mode === "fork-server-request") {
        await Bun.stdout.write(
          `${JSON.stringify({
            id,
            result: {
              userAgent: "inert",
              codexHome: process.cwd(),
              platformFamily: "windows",
              platformOs: "windows",
            },
          })}\n${JSON.stringify({
            id: "unsupported-server-request",
            method: "item/commandExecution/requestApproval",
            params: { threadId },
          })}\n`,
        );
        await new Promise(() => {});
      } else {
        await send({
          id,
          result: {
            userAgent: "inert",
            codexHome: process.cwd(),
            platformFamily: "windows",
            platformOs: "windows",
          },
        });
        await send({
          method: "warning",
          params: { threadId: null, message: "Inert private global warning" },
        });
      }
    } else if (method === "thread/fork") {
      if (
        !mode?.startsWith("fork") ||
        !params ||
        typeof params !== "object" ||
        !("threadId" in params) ||
        params.threadId !== threadId ||
        !("lastTurnId" in params) ||
        typeof params.lastTurnId !== "string"
      )
        process.exit(14);
      const fork = params as Record<string, unknown>;
      if (mode === "fork-lost-response") {
        record({ kind: "fork-created-without-response", params });
        hangTree();
      }
      const forkCwd = typeof fork.cwd === "string" ? fork.cwd : "";
      const forkModel = typeof fork.model === "string" ? fork.model : "";
      const forkProvider =
        typeof fork.modelProvider === "string" ? fork.modelProvider : "";
      const forkTier = "serviceTier" in fork ? fork.serviceTier : null;
      const effort =
        fork.config &&
        typeof fork.config === "object" &&
        "model_reasoning_effort" in fork.config
          ? fork.config.model_reasoning_effort
          : null;
      const forkSandbox =
        fork.sandbox === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : {
              type: "workspaceWrite",
              writableRoots: [forkCwd],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            };
      const forkThread = {
        id: "0199a213-81c0-7800-8aa1-bbab2a035a55",
        environments: [],
        extra: null,
        sessionId: threadId,
        forkedFromId: threadId,
        parentThreadId: null,
        preview: "Inert synthetic fork preview",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        turns: [],
        modelProvider: forkProvider,
        model: forkModel,
        reasoningEffort: effort,
        createdAt: 1,
        updatedAt: 1,
        recencyAt: 1,
        status: { type: "idle" },
        path: null,
        cwd: forkCwd,
        cliVersion: "0.163.0-alpha.10.2",
        originator: "agent_forge",
        source: "appServer",
        canAcceptDirectInput: true,
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        daybreakEnabled: false,
      };
      const result = {
        thread: forkThread,
        model: forkModel,
        modelProvider: forkProvider,
        serviceTier: forkTier,
        disabledPluginIds: [],
        cwd: forkCwd,
        runtimeWorkspaceRoots: [forkCwd],
        instructionSources: [],
        approvalPolicy: fork.approvalPolicy,
        approvalsReviewer: fork.approvalsReviewer,
        sandbox: forkSandbox,
        activePermissionProfile: { id: ":workspace", extends: null },
        reasoningEffort: effort,
        multiAgentMode: "explicitRequestOnly",
      };
      if (mode === "fork-wrong-parent")
        (forkThread as Record<string, unknown>).forkedFromId =
          "0199a213-81c0-7800-8aa1-bbab2a035a56";
      if (mode === "fork-wrong-child")
        (forkThread as Record<string, unknown>).id = threadId;
      if (mode === "fork-wrong-config") {
        (forkThread as Record<string, unknown>).model = "different-model";
        (result as Record<string, unknown>).model = "different-model";
      }
      if (mode === "fork-active")
        (forkThread as Record<string, unknown>).status = {
          type: "active",
          activeFlags: [],
        };
      record({ kind: "fork-result", result });
      if (mode === "fork-lost-response") {
        // Deliberately retain an owned process tree after the synthetic native
        // effect so the runtime must report uncertainty and clean it up.
      } else if (mode === "fork-malformed")
        await send({ id, result: { ...result, unexpected: true } });
      else {
        if (mode === "fork-oversized")
          (forkThread as Record<string, unknown>).preview = "x".repeat(70_000);
        await send({ id, result });
        await send({
          method: "thread/started",
          params: { thread: forkThread },
        });
        if (mode === "fork-cleanup-failure") process.exit(17);
      }
    } else if (method === "thread/start" || method === "thread/resume") {
      resuming = method === "thread/resume";
      if (resuming && typeof params.threadId === "string")
        threadId = params.threadId;
      turnId = serviceTierAwareMode && resuming ? resumedTurnId : firstTurnId;
      if (
        !("model" in params) ||
        !("cwd" in params) ||
        typeof params.model !== "string" ||
        typeof params.cwd !== "string"
      )
        process.exit(13);
      if (
        forkServiceTierResumeMode &&
        resuming &&
        params.threadId === "0199a213-81c0-7800-8aa1-bbab2a035a55" &&
        (params.modelProvider !== "openai" ||
          !Object.hasOwn(params, "serviceTier") ||
          params.serviceTier !== configuredServiceTier)
      )
        process.exit(14);
      model = params.model;
      cwd = params.cwd;
      if ("sandbox" in params && typeof params.sandbox === "string")
        sandbox = params.sandbox;
      if (
        "approvalPolicy" in params &&
        typeof params.approvalPolicy === "string"
      )
        approvalPolicy = params.approvalPolicy;
      await send({
        id,
        result: {
          thread: {
            id:
              method === "thread/resume" && "threadId" in params
                ? params.threadId
                : threadId,
            sessionId: threadId,
            forkedFromId: null,
            parentThreadId: null,
            status: { type: "idle" },
          },
          model: mode === "settings-mismatch" ? "unrequested-model" : model,
          modelProvider: "openai",
          ...(serviceTierAwareMode
            ? { serviceTier: configuredServiceTier }
            : {}),
          cwd,
          approvalPolicy,
          approvalsReviewer: "user",
          sandbox:
            sandbox === "read-only"
              ? { type: "readOnly", networkAccess: false }
              : {
                  type: "workspaceWrite",
                  writableRoots: [cwd],
                  networkAccess: false,
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
          reasoningEffort:
            mode === "fork-service-tier-priority"
              ? "medium"
              : serviceTierAwareMode
                ? null
                : "medium",
        },
      });
      await send({
        method: "thread/started",
        params: {
          thread: {
            id: threadId,
            sessionId: threadId,
            forkedFromId: null,
            parentThreadId: null,
          },
        },
      });
    } else if (method === "turn/start") {
      await send({
        id,
        result: { turn: { id: turnId, status: "inProgress" } },
      });
      await send({
        method: "turn/started",
        params: { threadId, turn: { id: turnId, status: "inProgress" } },
      });
      if (mode === "fork-child-lost-turn-reply" && resuming) {
        record({ kind: "child-turn-effect", threadId, turnId });
        hangTree();
      } else if (mode === "hang" || mode === "hang-text") {
        hangTree();
        if (mode === "hang-text")
          await send({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId,
              itemId: "pending-text",
              delta: "private pending text",
            },
          });
      } else if (mode === "foreign" || mode === "malformed") {
        hangTree();
        if (mode === "foreign")
          await send({
            method: "item/agentMessage/delta",
            params: {
              threadId: turnId,
              turnId,
              itemId: "foreign",
              delta: "private foreign body",
            },
          });
        else await Bun.stdout.write("{\n");
      } else if (mode === "premature") {
        hangTree();
        process.exit(0);
      } else if (mode === "never-exit") {
        hangTree();
        await finish();
        record({ kind: "terminal-published", threadId, turnId });
      } else if (mode === "mcp-tool-calls") {
        await finishMcpToolCalls();
      } else if (mode === "mcp-tool-calls-held") {
        await mcpCallPrefix();
        hangTree();
      } else if (mode === "web-search") {
        await finishWebSearch();
      } else if (mode === "web-search-held") {
        await webSearchPrefix();
        hangTree();
      } else if (mode?.startsWith("file-changes")) {
        await fileChangePrefix();
        if (mode === "file-changes-held") hangTree();
        else if (mode === "file-changes-approval")
          await send({
            id: "file-review-a",
            method: "item/fileChange/requestApproval",
            params: {
              threadId,
              turnId,
              itemId: "reported-files-a",
              startedAtMs: 1,
              reason: "Inert native file review",
              grantRoot: null,
            },
          });
        else await finishFileChanges();
      } else if (mode === "turn-plan" || mode === "turn-plan-held") {
        const scope = { threadId, turnId },
          firstPlan = {
            ...scope,
            explanation: null,
            plan: [
              { step: "Inspect the supplied context", status: "inProgress" },
              { step: "Check the result", status: "pending" },
            ],
          };
        await send({ method: "turn/plan/updated", params: firstPlan });
        // Repeated identical native snapshots are still legitimate reports.
        await send({ method: "turn/plan/updated", params: firstPlan });
        await send({
          method: "turn/plan/updated",
          params: {
            ...scope,
            explanation: "The provider revised its supplied plan.",
            plan: [
              { step: "Inspect the supplied context", status: "completed" },
              {
                step: "Check the revised result",
                status: mode === "turn-plan-held" ? "completed" : "inProgress",
              },
            ],
          },
        });
        if (mode === "turn-plan-held") hangTree();
        else await finish();
      } else if (
        [
          "reasoning-summary",
          "reasoning-summary-held",
          "reasoning-summary-interrupted",
          "reasoning-summary-completed-only",
        ].includes(mode ?? "")
      ) {
        const scope = { threadId, turnId },
          item = {
            type: "reasoning",
            id: "reported-reasoning-a",
            summary: [],
            content: ["RAW_REASONING_MUST_NOT_PERSIST"],
          };
        if (mode !== "reasoning-summary-completed-only") {
          await send({
            method: "item/started",
            params: { ...scope, item, startedAtMs: 1 },
          });
          for (const [summaryIndex, deltas] of [
            [0, ["Visible ", "summary one."]],
            [1, ["Visible summary two."]],
          ] as const) {
            await send({
              method: "item/reasoning/summaryPartAdded",
              params: { ...scope, itemId: item.id, summaryIndex },
            });
            for (const delta of deltas)
              await send({
                method: "item/reasoning/summaryTextDelta",
                params: { ...scope, itemId: item.id, summaryIndex, delta },
              });
          }
          await send({
            method: "item/reasoning/textDelta",
            params: {
              ...scope,
              itemId: item.id,
              contentIndex: 0,
              delta: "RAW_REASONING_MUST_NOT_PERSIST",
            },
          });
          await send({
            method: "rawResponseItem/completed",
            params: {
              ...scope,
              item: {
                type: "reasoning",
                id: item.id,
                summary: [],
                encrypted_content: "RAW_REASONING_MUST_NOT_PERSIST",
              },
            },
          });
        }
        const finalItem = {
          ...item,
          summary: ["Visible summary one.", "Visible summary two."],
        };
        if (mode === "reasoning-summary-held") {
          hangTree();
        } else if (mode === "reasoning-summary-interrupted") {
          await send({
            method: "turn/completed",
            params: {
              threadId,
              turn: {
                id: turnId,
                status: "interrupted",
                items: [finalItem],
                error: null,
              },
            },
          });
        } else {
          await send({
            method: "item/completed",
            params: {
              ...scope,
              item: finalItem,
              completedAtMs: 2,
            },
          });
          await finish([finalItem]);
        }
      } else if (
        mode === "command-activity" ||
        mode === "command-interrupted" ||
        mode === "command-activity-held"
      ) {
        const scope = { threadId, turnId };
        const command = {
          type: "commandExecution",
          id: "reported-command-a",
          pluginId: null,
          scriptPath: null,
          command: "inert command <script> stays text",
          cwd,
          processId: null,
          source: "agent",
          commandActions: [],
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        };
        await send({
          method: "item/started",
          params: { ...scope, item: command, startedAtMs: 1 },
        });
        await send({
          method: "item/commandExecution/outputDelta",
          params: {
            ...scope,
            itemId: command.id,
            delta: "Reported line one\n",
          },
        });
        if (mode === "command-activity-held") {
          hangTree();
        } else if (mode === "command-interrupted") {
          await send({
            method: "turn/completed",
            params: {
              threadId,
              turn: {
                id: turnId,
                status: "interrupted",
                error: null,
                items: [
                  {
                    ...command,
                    aggregatedOutput: "Partial aggregate at interruption",
                  },
                ],
              },
            },
          });
        } else {
          await send({
            method: "item/completed",
            params: {
              ...scope,
              item: {
                ...command,
                status: "completed",
                aggregatedOutput: "Reported line one\nReported line two\n",
                exitCode: 0,
                durationMs: 12,
              },
              completedAtMs: 13,
            },
          });
          await finish();
        }
      } else if (mode === "burst") {
        hangTree();
        for (let index = 0; index < 400; index++)
          await send({
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId,
              itemId: "burst",
              delta: "x".repeat(4096),
            },
          });
      } else if (
        mode?.startsWith("approval-command") ||
        mode === "approval-conflict" ||
        mode === "approval-resolved" ||
        mode === "approval-stale" ||
        mode === "approval-never"
      ) {
        if (mode === "approval-never") hangTree();
        const started = {
          method: "item/started",
          params: {
            threadId,
            turnId,
            startedAtMs: 1,
            item: {
              type: "commandExecution",
              id: "command-a",
              command: "inert example",
              cwd,
              status: "inProgress",
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          },
        };
        await send(started);
        const request = {
          id: 1,
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            threadId,
            turnId,
            itemId: "command-a",
            startedAtMs: 1,
            environmentId: null,
            command: "inert example",
            cwd,
            availableDecisions: [
              "accept",
              "acceptForSession",
              "decline",
              "cancel",
            ],
          },
        };
        await send(request);
        if (mode === "approval-command-duplicate") await send(request);
        if (mode === "approval-conflict")
          await send({
            ...request,
            params: { ...request.params, command: "different intent" },
          });
        if (mode === "approval-resolved" || mode === "approval-stale") {
          await send({
            method: "serverRequest/resolved",
            params: { threadId, requestId: 1 },
          });
          if (mode === "approval-stale") await send(request);
          await finish();
        }
      } else if (mode === "approval-file") {
        await send({
          method: "item/started",
          params: {
            threadId,
            turnId,
            startedAtMs: 1,
            item: {
              type: "fileChange",
              id: "file-a",
              changes: [],
              status: "inProgress",
            },
          },
        });
        await send({
          id: "1",
          method: "item/fileChange/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "file-a",
            startedAtMs: 1,
            reason: "Inert file example",
            grantRoot: null,
          },
        });
      } else await finish();
    }
    newline = pending.indexOf("\n");
  }
}
