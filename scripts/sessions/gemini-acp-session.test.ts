import { expect, test } from "bun:test";
import type { GeminiAcpEvent } from "../../types/gemini-acp";
import { createGeminiAcpSession } from "./gemini-acp-session";

const native = "11111111-1111-4111-8111-111111111111";
const turn = "22222222-2222-4222-8222-222222222222";
const response = (id: number, result: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, result });
const initialized = response(1, {
  protocolVersion: 1,
  agentInfo: { name: "gemini-cli", version: "0.65.0" },
  agentCapabilities: { loadSession: true },
  authMethods: [{ id: "PRIVATE_AUTH_CONFIGURATION" }],
});
const update = (sessionUpdate: string, extra: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: native, update: { sessionUpdate, ...extra } },
  });

function ready() {
  const session = createGeminiAcpSession({ cwd: "C:/fixture/worktree" });
  session.start();
  session.read(initialized);
  session.read(response(2, { sessionId: native }));
  session.prompt({ requestId: turn, text: "Explicit original" });
  return session;
}
const permission = (rpcId: number = 44) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId,
    method: "session/request_permission",
    params: {
      sessionId: native,
      toolCall: {
        toolCallId: "tool-one",
        title: "Run command",
        status: "pending",
        rawInput: { command: "echo private" },
      },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "never", name: "Reject once", kind: "reject_once" },
        { optionId: "always", name: "Allow forever", kind: "allow_always" },
      ],
    },
  });

test("fresh ACP session uses only initialize/new then one explicit private prompt and native completion", () => {
  const session = createGeminiAcpSession({ cwd: "C:/fixture/worktree" });
  expect(session.start()).toBe(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"agent-forge-harness","version":"1"}}}\n',
  );
  const ready = session.read(initialized);
  expect(ready.events).toEqual([]);
  expect(ready.send).toEqual([
    '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"C:/fixture/worktree","mcpServers":[]}}\n',
  ]);
  expect(session.read(response(2, { sessionId: native })).events).toEqual([
    { kind: "identity", sessionId: native, resumed: false },
  ]);
  expect(session.prompt({ requestId: turn, text: "Private 🌱\nexact" })).toBe(
    `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"${native}","prompt":[{"type":"text","text":"Private 🌱\\nexact"}]}}\n`,
  );
  expect(
    session.read(
      update("agent_thought_chunk", {
        content: { type: "text", text: "PRIVATE_THOUGHT" },
      }),
    ).events,
  ).toEqual([]);
  expect(
    session.read(
      update("agent_message_chunk", {
        content: { type: "text", text: "Hello" },
      }),
    ).events,
  ).toEqual([
    {
      kind: "text",
      text: "Hello",
      role: "assistant",
      scope: "turn",
      requestId: turn,
    },
  ]);
  expect(
    session.read(update("usage_update", { used: 81, size: 1000 })).events,
  ).toEqual([{ kind: "context", usedTokens: 81, contextTokens: 1000 }]);
  expect(
    session.read(
      response(3, {
        stopReason: "end_turn",
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        _meta: {
          quota: { token_count: { input_tokens: 7, output_tokens: 3 } },
        },
      }),
    ).events,
  ).toEqual([
    {
      kind: "result",
      requestId: turn,
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    },
  ]);
  expect(() => session.prompt({ requestId: turn, text: "repeat" })).toThrow(
    "private Gemini ACP session",
  );
});

test("exact owned resume never assigns asynchronous historical replay to the newly accepted prompt", () => {
  const session = createGeminiAcpSession({
    cwd: "C:/fixture/worktree",
    resumeSessionId: native,
  });
  session.start();
  expect(session.read(initialized).send).toEqual([
    `{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"cwd":"C:/fixture/worktree","mcpServers":[],"sessionId":"${native}"}}\n`,
  ]);
  const history = update("agent_message_chunk", {
    content: { type: "text", text: "Old native answer" },
  });
  const expected: GeminiAcpEvent[] = [
    {
      kind: "text",
      text: "Old native answer",
      role: "assistant",
      scope: "native-session",
      requestId: null,
    },
  ];
  expect(session.read(history).events).toEqual(expected);
  expect(session.read(response(2, {})).events).toEqual([
    { kind: "identity", sessionId: native, resumed: true },
  ]);
  expect(session.read(history).events).toEqual(expected);
  session.prompt({ requestId: turn, text: "New original" });
  // Pinned native loadSession starts streamHistory without awaiting it. There is no history-complete marker.
  expect(session.read(history).events).toEqual(expected);
  expect(session.read(response(3, { stopReason: "end_turn" })).events).toEqual([
    { kind: "result", requestId: turn, stopReason: "end_turn", usage: null },
  ]);
});

test("only one offered once-only permission answer can belong to the live original prompt", () => {
  const session = ready();
  const offer = session.read(permission()).events;
  expect(offer).toMatchObject([
    {
      kind: "permission",
      rpcId: 44,
      requestId: turn,
      toolCallId: "tool-one",
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "never", name: "Reject once", kind: "reject_once" },
      ],
    },
  ]);
  expect(() =>
    session.answerPermission({
      rpcId: 44,
      requestId: turn,
      optionId: "always",
    }),
  ).toThrow("private Gemini ACP session");
  expect(() =>
    session.answerPermission({
      rpcId: 44,
      requestId: native,
      optionId: "once",
    }),
  ).toThrow("private Gemini ACP session");
  expect(
    session.answerPermission({ rpcId: 44, requestId: turn, optionId: "once" }),
  ).toBe(
    '{"jsonrpc":"2.0","id":44,"result":{"outcome":{"outcome":"selected","optionId":"once"}}}\n',
  );
  expect(() =>
    session.answerPermission({ rpcId: 44, requestId: turn, optionId: "once" }),
  ).toThrow("private Gemini ACP session");
  expect(
    session.read(
      update("tool_call_update", {
        toolCallId: "tool-one",
        status: "completed",
      }),
    ).events,
  ).toMatchObject([
    {
      kind: "tool",
      toolCallId: "tool-one",
      status: "completed",
      scope: "turn",
      requestId: turn,
    },
  ]);
  expect(
    session.read(response(3, { stopReason: "end_turn" })).events,
  ).toMatchObject([{ kind: "result", stopReason: "end_turn" }]);
});

test("Stop invalidates permission callbacks before native cancellation, and only its matching result acknowledges cancellation", () => {
  const session = ready();
  session.read(permission());
  expect(session.cancel(turn)).toBe(
    `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"${native}"}}\n`,
  );
  expect(() =>
    session.answerPermission({ rpcId: 44, requestId: turn, optionId: "once" }),
  ).toThrow("private Gemini ACP session");
  expect(() =>
    session.prompt({ requestId: native, text: "while cancelling" }),
  ).toThrow("private Gemini ACP session");
  expect(session.read(response(3, { stopReason: "cancelled" })).events).toEqual(
    [{ kind: "result", requestId: turn, stopReason: "cancelled", usage: null }],
  );
  expect(session.cancel(turn)).toBeNull();
  const wrongAck = ready();
  wrongAck.cancel(turn);
  expect(() => wrongAck.read(response(3, { stopReason: "end_turn" }))).toThrow(
    "private Gemini ACP session",
  );
});

test("native tool settlement invalidates a late permission choice and missing details never offer allow", () => {
  const session = ready();
  session.read(permission());
  session.read(
    update("tool_call_update", { toolCallId: "tool-one", status: "failed" }),
  );
  expect(() =>
    session.answerPermission({ rpcId: 44, requestId: turn, optionId: "once" }),
  ).toThrow("private Gemini ACP session");
  session.read(response(3, { stopReason: "end_turn" }));
  const missingDetails = ready();
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    id: 48,
    method: "session/request_permission",
    params: {
      sessionId: native,
      toolCall: { toolCallId: "tool-missing" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  expect(missingDetails.read(frame).events).toMatchObject([
    {
      kind: "permission",
      detailsComplete: false,
      options: [{ optionId: "reject", kind: "reject_once" }],
    },
  ]);
  expect(() =>
    missingDetails.answerPermission({
      rpcId: 48,
      requestId: turn,
      optionId: "allow",
    }),
  ).toThrow("private Gemini ACP session");
  expect(
    missingDetails.answerPermission({
      rpcId: 48,
      requestId: turn,
      optionId: null,
    }),
  ).toBe(
    '{"jsonrpc":"2.0","id":48,"result":{"outcome":{"outcome":"cancelled"}}}\n',
  );
});

test("native errors retain bounded private diagnostics without authenticating or starting a replacement prompt", () => {
  const session = ready();
  expect(
    session.read(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: -32000,
          message: "Authentication required.",
          data: { PRIVATE_DIAGNOSTIC: "not retained" },
        },
      }),
    ).events,
  ).toEqual([
    {
      kind: "error",
      requestId: turn,
      code: -32000,
      message: { text: "Authentication required.", truncated: false },
    },
  ]);
  expect(() =>
    session.prompt({ requestId: native, text: "automatic replacement" }),
  ).toThrow("private Gemini ACP session");
});

test("thought-tool details are not retained even when later partial updates omit their kind", () => {
  const session = ready();
  expect(
    session.read(
      update("tool_call", {
        toolCallId: "thought",
        kind: "think",
        status: "in_progress",
        rawInput: { PRIVATE_THOUGHT: "hidden" },
      }),
    ).events,
  ).toEqual([]);
  expect(
    session.read(
      update("tool_call_update", {
        toolCallId: "thought",
        status: "completed",
        rawOutput: "PRIVATE_THOUGHT",
      }),
    ).events,
  ).toEqual([]);
});

test("foreign identities, duplicate RPCs, unsupported versions and incomplete native turns fail closed", () => {
  for (const frame of [
    response(999, { stopReason: "end_turn" }),
    update("agent_message_chunk", {
      content: { type: "text", text: "bad\u0000text" },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: turn,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "foreign" },
        },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "fs/read_text_file",
      params: { path: "private" },
    }),
  ]) {
    const session = ready();
    expect(() => session.read(frame)).toThrow("private Gemini ACP session");
    expect(() =>
      session.prompt({ requestId: native, text: "after failure" }),
    ).toThrow("private Gemini ACP session");
  }
  const duplicated = ready();
  duplicated.read(permission());
  expect(() => duplicated.read(permission())).toThrow(
    "private Gemini ACP session",
  );
  const incomplete = ready();
  incomplete.read(permission());
  expect(() =>
    incomplete.read(response(3, { stopReason: "end_turn" })),
  ).toThrow("private Gemini ACP session");
  const unsupported = createGeminiAcpSession({ cwd: "C:/fixture/worktree" });
  unsupported.start();
  expect(() =>
    unsupported.read(
      response(1, {
        protocolVersion: 2,
        agentInfo: { name: "gemini-cli", version: "0.65.0" },
      }),
    ),
  ).toThrow("private Gemini ACP session");
});

test("a second explicit turn on the same live native session sends one new prompt without restarting or replaying", () => {
  const session = ready();
  session.read(response(3, { stopReason: "end_turn" }));
  expect(
    session.prompt({ requestId: native, text: "Second explicit original" }),
  ).toBe(
    `{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"${native}","prompt":[{"type":"text","text":"Second explicit original"}]}}\n`,
  );
  expect(
    session.read(
      update("agent_message_chunk", {
        content: { type: "text", text: "Second response" },
      }),
    ).events,
  ).toMatchObject([
    { kind: "text", scope: "turn", requestId: native, text: "Second response" },
  ]);
  expect(
    session.read(
      response(4, {
        stopReason: "max_tokens",
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          cachedReadTokens: 5,
          thoughtTokens: 2,
        },
      }),
    ).events,
  ).toEqual([
    {
      kind: "result",
      requestId: native,
      stopReason: "max_tokens",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cachedReadTokens: 5,
        thoughtTokens: 2,
      },
    },
  ]);
});

test("private text byte bounds include discarded thoughts and incomplete tool details cannot enable allow", () => {
  const session = ready();
  for (let index = 0; index < 2; index++)
    session.read(
      update("agent_thought_chunk", {
        content: { type: "text", text: "🌱".repeat(65_536) },
      }),
    );
  expect(() =>
    session.read(
      update("agent_message_chunk", {
        content: { type: "text", text: "one byte too many" },
      }),
    ),
  ).toThrow("private Gemini ACP session");
  const truncated = ready();
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    id: 48,
    method: "session/request_permission",
    params: {
      sessionId: native,
      toolCall: {
        toolCallId: "large",
        title: "Run",
        rawInput: { command: "x".repeat(40_000) },
      },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  expect(truncated.read(frame).events).toMatchObject([
    {
      kind: "permission",
      detailsComplete: false,
      detail: { truncated: true },
      options: [{ optionId: "no", kind: "reject_once" }],
    },
  ]);
  expect(() =>
    truncated.answerPermission({ rpcId: 48, requestId: turn, optionId: "yes" }),
  ).toThrow("private Gemini ACP session");
});
