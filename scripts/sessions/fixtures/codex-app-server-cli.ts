import { appendFileSync } from "node:fs";

/** Inert native-process app-server fixture. No provider, account, shell or network access. */
const argv = process.argv.slice(2),
  log = process.env.CODEX_CHAT_LOG;
const mode = process.env.CODEX_CHAT_MODE;
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
const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53",
  turnId = "0199a213-81c0-7800-8aa1-bbab2a035a54";
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
const finish = async () => {
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
        items: [item],
        error:
          mode === "provider-error"
            ? { message: "private-provider-error" }
            : null,
      },
    },
  });
  if (mode === "bad-exit") process.exit(7);
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
      } else await finish();
      newline = pending.indexOf("\n");
      continue;
    }
    const method = parsed.method;
    const params =
      "params" in parsed &&
      typeof parsed.params === "object" &&
      parsed.params !== null
        ? parsed.params
        : {};
    const id = "id" in parsed ? parsed.id : null;
    record({ kind: "rpc", method, params, id });
    if (method === "initialize" && mode === "hang-initialize") {
      hangTree();
    } else if (method === "initialize") {
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
    } else if (method === "thread/start" || method === "thread/resume") {
      resuming = method === "thread/resume";
      if (
        !("model" in params) ||
        !("cwd" in params) ||
        typeof params.model !== "string" ||
        typeof params.cwd !== "string"
      )
        process.exit(13);
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
          reasoningEffort: "medium",
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
      if (mode === "hang" || mode === "hang-text") {
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
