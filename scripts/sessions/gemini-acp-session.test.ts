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
