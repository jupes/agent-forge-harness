import { existsSync, readFileSync } from "node:fs";
import { writeWhole } from "../../executors/fixtures/write-whole";

/** Inert native protocol stand-in. Never imports a provider SDK or forwards commands. */
export async function runGeminiChatFixture() {
  const argv = process.argv.slice(2);
  if (argv.includes("--helper")) {
    await new Promise(() => setInterval(() => {}, 1000));
    return;
  }
  const log = process.env.GEMINI_CHAT_LOG;
  let control: {
    mode?: string;
    version?: string;
    help?: string;
    replyText?: string;
    helpNonce?: string;
  } = {};
  if (log && existsSync(`${log}.control`)) {
    try {
      control = JSON.parse(readFileSync(`${log}.control`, "utf8"));
    } catch {
      throw Error("Invalid fixture control");
    }
  }
  const mode = control.mode ?? process.env.GEMINI_CHAT_MODE ?? "normal";
  const record = (value: unknown) => {
    if (!log) return;
    let prior: unknown[] = [];
    if (existsSync(log)) {
      try {
        prior = JSON.parse(readFileSync(log, "utf8"));
      } catch {
        throw Error("Invalid fixture recording");
      }
    }
    writeWhole(log, JSON.stringify([...prior, value]));
  };
  if (argv.includes("--version")) {
    record({ kind: "version" });
    console.log(control.version ?? "0.65.0");
    return;
  }
  if (argv.includes("--help")) {
    if (mode === "hold-help") {
      const nonce = control.helpNonce;
      if (
        !log ||
        typeof nonce !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          nonce,
        )
      )
        throw Error("Missing owned help-probe handshake");
      record({ kind: "help", nonce, pid: process.pid });
      // The existing supervised five-second probe owns this wait and its tree.
      const release = `${log}.help-release`;
      while (!existsSync(release) || readFileSync(release, "utf8") !== nonce)
        await Bun.sleep(10);
    } else record({ kind: "help" });
    console.log(
      control.help ??
        "--acp --model --approval-mode --sandbox --policy --include-directories",
    );
    return;
  }
  if (!argv.includes("--acp")) throw Error("Expected the native ACP mode");
  const native = "11111111-1111-4111-8111-111111111111";
  let promptId: string | number | null = null;
  let loaded = false;
  record({
    kind: "start",
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    allowed: process.env.TEST_ALLOWED,
    secretPresent: !!process.env.TEST_OPERATOR_SECRET,
    forged: !!process.env.AGENT_FORGE_FORGED,
    preload:
      !!process.env.NODE_OPTIONS ||
      !!process.env.NODE_PATH ||
      !!process.env.BUN_OPTIONS,
    adapter: process.env.AGENT_FORGE_ADAPTER,
    smith: process.env.AGENT_FORGE_SMITH,
  });
  const emit = (value: unknown) => console.log(JSON.stringify(value));
  const reply = (id: unknown, result: unknown) =>
    emit({ jsonrpc: "2.0", id, result });
  const update = (sessionUpdate: string, data: object) =>
    emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: native, update: { sessionUpdate, ...data } },
    });
  const complete = () => {
    update("usage_update", { used: 55, size: 1000 });
    reply(promptId, {
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
  };
  const handle = (raw: string) => {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw);
    } catch {
      throw Error("Invalid client fixture JSON");
    }
    record({ kind: "wire", value });
    const params = value.params;
    if (value.method === "initialize")
      reply(value.id, {
        protocolVersion: 1,
        agentInfo: { name: "gemini-cli", version: "0.65.0" },
        agentCapabilities: { loadSession: mode !== "no-load" },
      });
    else if (value.method === "session/new")
      reply(value.id, { sessionId: native });
    else if (value.method === "session/load") {
      if (
        !params ||
        typeof params !== "object" ||
        !("sessionId" in params) ||
        params.sessionId !== native
      )
        throw Error("Foreign native identity");
      loaded = true;
      update("agent_message_chunk", {
        content: { type: "text", text: "Historical before load reply" },
      });
      reply(value.id, {});
    } else if (value.method === "session/prompt") {
      if (typeof value.id !== "number" && typeof value.id !== "string")
        throw Error("Missing prompt identity");
      promptId = value.id;
      if (loaded)
        update("agent_message_chunk", {
          content: { type: "text", text: "Historical after new prompt" },
        });
      if (
        [
          "hang-tree",
          "ignore-cancel",
          "normal-orphan",
          "permission-tree",
        ].includes(mode)
      ) {
        const helper = Bun.spawn([process.execPath, "--helper"], {
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
          env: process.env,
        });
        record({ kind: "helper", pid: helper.pid });
      }
      update("agent_message_chunk", {
        content: {
          type: "text",
          text: control.replyText ?? "Private ACP reply 🌱",
        },
      });
      if (["hang-tree", "ignore-cancel"].includes(mode)) return;
      if (mode === "missing-result") process.exit(0);
      if (mode === "malformed") {
        console.log("{PRIVATE_INVALID");
        return;
      }
      if (mode === "overflow") {
        console.log("x".repeat(2_097_153));
        return;
      }
      if (mode === "exit-nine") {
        console.error("Synthetic private exit diagnostic");
        process.exit(9);
      }
      if (mode === "error") {
        emit({
          jsonrpc: "2.0",
          id: promptId,
          error: { code: -32000, message: "Synthetic authentication required" },
        });
        return;
      }
      if (mode.startsWith("permission")) {
        emit({
          jsonrpc: "2.0",
          id: 41,
          method: "session/request_permission",
          params: {
            sessionId: native,
            toolCall: {
              toolCallId: "tool-one",
              status: "pending",
              title: "Synthetic command",
              rawInput: { command: "echo private" },
            },
            options: [
              { optionId: "once", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Reject once", kind: "reject_once" },
              { optionId: "always", name: "Always", kind: "allow_always" },
            ],
          },
        });
        if (mode === "permission-resolved") {
          update("tool_call_update", {
            toolCallId: "tool-one",
            status: "failed",
          });
          complete();
        }
        if (mode === "permission-controlled") {
          const timer = setInterval(() => {
            if (!log || !existsSync(`${log}.settle`)) return;
            clearInterval(timer);
            update("tool_call_update", {
              toolCallId: "tool-one",
              status: "failed",
            });
            complete();
          }, 10);
        }
        return;
      }
      if (mode === "flood")
        for (let index = 0; index < 300; index++)
          update("agent_message_chunk", {
            content: { type: "text", text: "flood" },
          });
      complete();
      if (mode === "normal-orphan") process.exit(0);
    } else if (value.method === "session/cancel") {
      if (mode !== "ignore-cancel")
        reply(promptId, { stopReason: "cancelled" });
    } else if (value.id === 41 && "result" in value) {
      update("tool_call_update", {
        toolCallId: "tool-one",
        status: "completed",
      });
      complete();
      // This successful fixture leaves its helper for the held-tree owner to reap.
      // The helper must not keep the native provider alive after its actual result.
      if (mode === "permission-tree") process.exit(0);
    } else throw Error("Unsupported client fixture method");
  };
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) handle(line);
    }
  }
}
