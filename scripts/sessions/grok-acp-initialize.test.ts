import { expect, test } from "bun:test";
import { decodeAcpServerFrame, type AcpRpcId } from "./acp-wire";
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

function pending(requestId: AcpRpcId = "init-1"): GrokConnectionState {
  return { kind: "initialize-pending", requestId };
}

function decoded(result: unknown, id: AcpRpcId = "init-1") {
  return decodeAcpServerFrame(
    JSON.stringify({ jsonrpc: "2.0", id, result }),
  );
}

function initializedState(frame = decoded({ protocolVersion: 1 })) {
  return reduceGrokInitialize(pending(), frame);
}

test("legal omitted initialize inventory and capabilities default to unknown/unsupported", () => {
  expect(initializedState()).toEqual({
    kind: "initialized",
    authMethods: [],
    defaultAuthMethodId: null,
    capabilities: {
      loadSession: false,
      promptImage: false,
      promptAudio: false,
      embeddedContext: false,
      mcpHttp: false,
      mcpSse: false,
    },
    authentication: "unknown",
    identity: "unverified",
  });
});

test("explicit malformed initialize protocol, capability, or inventory fields fail closed", () => {
  for (const result of [
    {},
    { protocolVersion: "1" },
    { protocolVersion: 1, agentCapabilities: { loadSession: "yes" } },
    { protocolVersion: 1, agentCapabilities: { promptCapabilities: null } },
    { protocolVersion: 1, authMethods: "grok.com" },
    {
      protocolVersion: 1,
      authMethods: [{ id: "method", name: "Method", type: "unsupported" }],
    },
    { protocolVersion: 1, authMethods: [{ id: "bad\u0000id", name: "Method" }] },
  ]) {
    expect(reduceGrokInitialize(pending(), decoded(result))).toEqual({
      kind: "failed-closed",
      reason: "invalid-initialize-result",
    });
  }
});

test("initialize IDs compare by exact JSON-RPC type and value", () => {
  expect(
    reduceGrokInitialize(pending(1), decoded({ protocolVersion: 1 }, "1")),
  ).toEqual({ kind: "failed-closed", reason: "mismatched-response" });
  expect(
    reduceGrokInitialize(pending(1), decoded({ protocolVersion: 1 }, 1)).kind,
  ).toBe("initialized");
});

test("error and unsolicited server frames fail closed during initialize", () => {
  const error = decodeAcpServerFrame(
    '{"jsonrpc":"2.0","id":"init-1","error":{"code":-32000,"message":"private"}}',
  );
  const update = decodeAcpServerFrame(
    '{"jsonrpc":"2.0","method":"session/update","params":{}}',
  );
  expect(reduceGrokInitialize(pending(), error)).toEqual({
    kind: "failed-closed",
    reason: "invalid-initialize-result",
  });
  expect(reduceGrokInitialize(pending(), update)).toEqual({
    kind: "failed-closed",
    reason: "mismatched-response",
  });
});

test("unsupported protocol versions fail closed", () => {
  expect(
    reduceGrokInitialize(pending(), decoded({ protocolVersion: 2 })),
  ).toEqual({ kind: "failed-closed", reason: "unsupported-version" });
});

test("initialized and failed-closed states absorb late frames by identity", () => {
  const ready = initializedState();
  const failed: GrokConnectionState = {
    kind: "failed-closed",
    reason: "unsupported-version",
  };
  const late = decoded({ protocolVersion: 1, authMethods: [{ id: "other", name: "Other" }] });
  expect(reduceGrokInitialize(ready, late)).toBe(ready);
  expect(reduceGrokInitialize(failed, late)).toBe(failed);
});

test("auth inventory is bounded, deduplicated, normalized, and never authenticates", () => {
  const methods = [
    { id: "one", name: "One" },
    { id: "one", name: "Duplicate" },
  ];
  expect(
    reduceGrokInitialize(pending(), decoded({ protocolVersion: 1, authMethods: methods })),
  ).toEqual({ kind: "failed-closed", reason: "invalid-initialize-result" });

  const tooMany = Array.from({ length: 65 }, (_, index) => ({
    id: `id-${index}`,
    name: "method",
  }));
  expect(
    reduceGrokInitialize(pending(), decoded({ protocolVersion: 1, authMethods: tooMany })),
  ).toEqual({ kind: "failed-closed", reason: "invalid-initialize-result" });

  const result = reduceGrokInitialize(
    pending(),
    decoded({
      protocolVersion: 1,
      authMethods: [
        {
          id: "grok.com",
          name: "Grok account",
          description: null,
          type: "terminal",
          args: ["private-arg"],
          env: { API_KEY: "private-value" },
        },
      ],
    }),
  );
  expect(result).toMatchObject({
    kind: "initialized",
    authMethods: [
      {
        id: "grok.com",
        name: "Grok account",
        type: "terminal",
      },
    ],
    authentication: "unknown",
    identity: "unverified",
  });
  expect(JSON.stringify(result)).not.toContain("private-arg");
  expect(JSON.stringify(result)).not.toContain("private-value");
});

test("auth inventory field limits accept the boundary and reject oversized values", () => {
  const boundary = reduceGrokInitialize(
    pending(),
    decoded({
      protocolVersion: 1,
      authMethods: [
        {
          id: "i".repeat(200),
          name: "n".repeat(500),
          description: "d".repeat(2_000),
        },
      ],
    }),
  );
  expect(boundary.kind).toBe("initialized");

  const oversized = reduceGrokInitialize(
    pending(),
    decoded({
      protocolVersion: 1,
      authMethods: [{ id: "i".repeat(201), name: "method" }],
    }),
  );
  expect(oversized).toEqual({
    kind: "failed-closed",
    reason: "invalid-initialize-result",
  });

  for (const method of [
    { id: "method", name: "n".repeat(501) },
    { id: "method", name: "Method", description: "d".repeat(2_001) },
  ]) {
    expect(
      reduceGrokInitialize(
        pending(),
        decoded({ protocolVersion: 1, authMethods: [method] }),
      ),
    ).toEqual({
      kind: "failed-closed",
      reason: "invalid-initialize-result",
    });
  }
});

test("known capabilities and matching default auth ID are normalized without raw metadata", () => {
  const result = reduceGrokInitialize(
    pending(),
    decoded({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
          futureCapability: true,
        },
        mcpCapabilities: { http: true, sse: false, futureTransport: true },
        futureCapability: true,
      },
      agentInfo: { name: "Grok", version: "untrusted" },
      authMethods: [
        {
          id: "xai.api_key",
          name: "API key",
          description: null,
          args: ["secret"],
        },
      ],
      _meta: {
        defaultAuthMethodId: "xai.api_key",
        agentId: "process-claim",
        environment: { API_KEY: "secret" },
      },
    }),
  );
  expect(result).toEqual({
    kind: "initialized",
    authMethods: [{ id: "xai.api_key", name: "API key", type: "agent" }],
    defaultAuthMethodId: "xai.api_key",
    capabilities: {
      loadSession: true,
      promptImage: true,
      promptAudio: false,
      embeddedContext: true,
      mcpHttp: true,
      mcpSse: false,
    },
    authentication: "unknown",
    identity: "unverified",
  });
  expect(
    reduceGrokInitialize(
      pending(),
      decoded({
        protocolVersion: 1,
        authMethods: [{ id: "xai.api_key", name: "API key" }],
        _meta: { defaultAuthMethodId: "unadvertised" },
      }),
    ),
  ).toMatchObject({ kind: "initialized", defaultAuthMethodId: null });
});
