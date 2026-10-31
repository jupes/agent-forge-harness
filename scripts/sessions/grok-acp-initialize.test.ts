import { expect, test } from "bun:test";
import { decodeAcpServerFrame } from "./acp-wire";
import {
  reduceGrokInitialize,
  type GrokConnectionState,
} from "./grok-acp-initialize";

test("a matched decoded Grok initialize response admits protocol readiness", () => {
  const pending: GrokConnectionState = {
    kind: "initialize-pending",
    requestId: "init-1",
  };
  const response = decodeAcpServerFrame(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "init-1",
      result: { protocolVersion: 1 },
    }),
  );

  const next = reduceGrokInitialize(pending, response);

  expect(next.kind).toBe("initialized");
});
