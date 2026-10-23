import { expect, test } from "bun:test";
import {
  ACP_WIRE_LIMITS,
  decodeAcpServerFrame,
  encodeAcpClientRequest,
  encodeAcpPermissionReply,
} from "./acp-wire";

test("closed ACP wire preserves exact native method, request identity and private UTF-8 text", () => {
  const text = 'Private "quotes"\n🌱 $(literal)';
  const actual = encodeAcpClientRequest({
    id: 7,
    method: "session/prompt",
    params: { sessionId: "native-session", prompt: [{ type: "text", text }] },
  });
  expect(actual.endsWith("\n")).toBe(true);
  expect(actual.split("\n")).toHaveLength(2);
  let parsed: unknown;
  try {
    parsed = JSON.parse(actual);
  } catch {
    throw Error("The encoded frame was not JSON");
  }
  expect(parsed).toEqual({
    jsonrpc: "2.0",
    id: 7,
    method: "session/prompt",
    params: { sessionId: "native-session", prompt: [{ type: "text", text }] },
  });
  expect(
    decodeAcpServerFrame(
      '{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}',
    ),
  ).toEqual({ jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } });
});

test("permission replies retain ACP's nested selected/cancelled shape and never become requests", () => {
  expect(
    encodeAcpPermissionReply("native-rpc", {
      outcome: "selected",
      optionId: "proceed_once",
    }),
  ).toBe(
    '{"jsonrpc":"2.0","id":"native-rpc","result":{"outcome":{"outcome":"selected","optionId":"proceed_once"}}}\n',
  );
  expect(encodeAcpPermissionReply(9, { outcome: "cancelled" })).toBe(
    '{"jsonrpc":"2.0","id":9,"result":{"outcome":{"outcome":"cancelled"}}}\n',
  );
});

test("server frames accept only the native direction and one response form without exposing private invalid data", () => {
  expect(
    decodeAcpServerFrame(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk"}}}',
    ),
  ).toMatchObject({ method: "session/update" });
  expect(
    decodeAcpServerFrame(
      '{"jsonrpc":"2.0","id":"permission","method":"session/request_permission","params":{"sessionId":"native"}}',
    ),
  ).toMatchObject({ id: "permission", method: "session/request_permission" });
  for (const frame of [
    '{"jsonrpc":"2.0","id":1,"method":"fs/read_text_file","params":{"path":"PRIVATE_INVALID"}}',
    '{"jsonrpc":"2.0","id":1,"method":"terminal/create","params":{}}',
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    '{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"PRIVATE_INVALID"}}',
    '{"jsonrpc":"2.0","id":null,"result":{}}',
    '{"jsonrpc":"2.0","id":1.5,"result":{}}',
    '{"jsonrpc":"1.0","id":1,"result":{}}',
    '[{"jsonrpc":"2.0","id":1,"result":{}}]',
    "{PRIVATE_INVALID",
  ]) {
    expect(() => decodeAcpServerFrame(frame)).toThrow(
      "private ACP wire protocol",
    );
    try {
      decodeAcpServerFrame(frame);
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_INVALID");
    }
  }
});

test("wire byte/depth/node bounds apply before semantic decoding, including ignored result metadata", () => {
  const prefix = '{"jsonrpc":"2.0","id":1,"result":';
  expect(() =>
    decodeAcpServerFrame(
      prefix + '"' + "🌱".repeat(ACP_WIRE_LIMITS.lineBytes / 4) + '"}',
    ),
  ).toThrow("private ACP wire protocol");
  expect(() =>
    decodeAcpServerFrame(prefix + "[".repeat(40) + "0" + "]".repeat(40) + "}"),
  ).toThrow("private ACP wire protocol");
  expect(() =>
    decodeAcpServerFrame(
      prefix +
        JSON.stringify(
          Array.from({ length: ACP_WIRE_LIMITS.nodes + 1 }, () => 0),
        ) +
        "}",
    ),
  ).toThrow("private ACP wire protocol");
});

test("outbound framing refuses delegated authority, malformed identities and oversized private inputs", () => {
  for (const input of [
    { id: 1, method: "authenticate", params: { methodId: "google" } },
    { id: 1, method: "session/fork", params: {} },
    { id: 1, method: "fs/write_text_file", params: {} },
    { id: 1, method: "terminal/create", params: {} },
    { id: null, method: "session/prompt", params: {} },
    { id: 1, method: "session/prompt", params: [] },
    { id: 1, method: "session/cancel", params: {} },
    { method: "session/prompt", params: {} },
    { id: 1, method: "session/prompt", params: {}, jsonrpc: "1.0" },
    { id: 1, method: "session/prompt", params: {}, secret: "invalid" },
    {
      id: 1,
      method: "session/prompt",
      params: { text: "x".repeat(ACP_WIRE_LIMITS.lineBytes) },
    },
  ])
    expect(() => encodeAcpClientRequest(input)).toThrow(
      "private ACP wire protocol",
    );
  expect(
    encodeAcpClientRequest({
      method: "session/cancel",
      params: { sessionId: "native" },
    }),
  ).toBe(
    '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"native"}}\n',
  );
});
