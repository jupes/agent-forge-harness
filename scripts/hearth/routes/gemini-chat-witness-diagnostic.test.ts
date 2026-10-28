import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitGeminiChatWitnessFailureFactsAndRethrow,
  projectGeminiChatFailureFacts,
  readGeminiChatWitnessLog,
  summarizeGeminiChatWitnessText,
  unavailableGeminiChatWitnessLog,
} from "./gemini-chat-witness-diagnostic.test-utils";
import { geminiChatPrivateFrameSchema } from "../../sessions/gemini-chat-owned-journal";

test("exact-turn failure projection retains safe Gemini runtime outcome facts only", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const otherRequestId = "22222222-2222-4222-8222-222222222222";
  const targetTurn = {
    requestId,
    phase: "failed",
    reason: "PRIVATE original turn reason",
  };
  const otherTurn = {
    requestId: otherRequestId,
    phase: "unknown",
    reason: "PRIVATE other turn reason",
  };
  const processFrame = geminiChatPrivateFrameSchema.parse({
    kind: "coding-gemini-chat",
    provider: "gemini",
    version: "0.65.0",
    event: {
      kind: "process",
      pid: 23456,
      bootstrapPid: 12345,
      smith: "gemini-example",
      requestId,
    },
  });
  const outcomeFrame = geminiChatPrivateFrameSchema.parse({
    kind: "coding-gemini-chat",
    provider: "gemini",
    version: "0.65.0",
    event: {
      kind: "outcome",
      outcome: {
        phase: "failed",
        reason: "PRIVATE runtime reason",
        sessionId: null,
        stopReason: null,
        usage: null,
      },
      exitCode: 1,
      stopped: false,
      timedOut: true,
      stderr: { text: "PRIVATE runtime stderr", truncated: false },
    },
  });
  const unrelatedOutcome = geminiChatPrivateFrameSchema.parse({
    kind: "coding-gemini-chat",
    provider: "gemini",
    version: "0.65.0",
    event: {
      kind: "outcome",
      outcome: {
        phase: "unknown",
        reason: "PRIVATE unrelated runtime reason",
        sessionId: null,
        stopReason: null,
        usage: null,
      },
      exitCode: null,
      stopped: true,
      timedOut: false,
      stderr: { text: "PRIVATE unrelated runtime stderr", truncated: false },
    },
  });
  const page = {
    request: targetTurn,
    turns: [targetTurn, otherTurn],
    frames: [
      { turnId: requestId, event: processFrame },
      { turnId: requestId, event: outcomeFrame },
      { turnId: otherRequestId, event: unrelatedOutcome },
    ],
  };
  const projection = projectGeminiChatFailureFacts(page, requestId);

  expect(projection.original).toEqual({ phase: "failed", reason: "present" });
  const serialized = JSON.stringify(projection);
  for (const value of [
    requestId,
    otherRequestId,
    "23456",
    "12345",
    "PRIVATE original turn reason",
    "PRIVATE other turn reason",
    "PRIVATE runtime reason",
    "PRIVATE runtime stderr",
    "PRIVATE unrelated runtime reason",
    "PRIVATE unrelated runtime stderr",
  ])
    expect(serialized).not.toContain(value);
  expect(projection).toMatchObject({
    runtime: {
      processRecord: "observed",
      outcome: "observed",
      phase: "failed",
      exitCode: "nonzero",
      stopped: false,
      timedOut: true,
      nativeError: "not-observed",
      nativeResult: "not-observed",
    },
  });
});

test("runtime projection distinguishes terminal outcomes and keeps absent or ambiguous facts unknown", () => {
  const requestId = "33333333-3333-4333-8333-333333333333";
  const otherRequestId = "44444444-4444-4444-8444-444444444444";
  const target = { requestId, phase: "failed", reason: null };
  const other = { requestId: otherRequestId, phase: "failed", reason: null };
  const runtimeFrame = (turnId: string, event: unknown) => ({
    turnId,
    event: geminiChatPrivateFrameSchema.parse({
      kind: "coding-gemini-chat",
      provider: "gemini",
      version: "0.65.0",
      event,
    }),
  });
  const outcome = (
    phase: "completed" | "failed" | "unknown",
    exitCode: number | null,
    stopped: boolean,
    timedOut: boolean,
  ) => ({
    kind: "outcome",
    outcome: {
      phase,
      reason: "PRIVATE outcome reason",
      sessionId:
        phase === "completed"
          ? "55555555-5555-4555-8555-555555555555"
          : null,
      stopReason: phase === "completed" ? "end_turn" : null,
      usage: null,
    },
    exitCode,
    stopped,
    timedOut,
    stderr: { text: "PRIVATE stderr", truncated: false },
  });
  const process = {
    kind: "process",
    pid: 23456,
    bootstrapPid: 12345,
    smith: "private-smith-name",
    requestId,
  };
  const project = (frames: ReturnType<typeof runtimeFrame>[]) =>
    projectGeminiChatFailureFacts(
      { request: target, turns: [target, other], frames },
      requestId,
    ).runtime;

  expect(
    project([
      runtimeFrame(requestId, process),
      runtimeFrame(requestId, outcome("completed", 0, false, false)),
      runtimeFrame(requestId, {
        kind: "result",
        requestId,
        stopReason: "end_turn",
        usage: null,
      }),
    ]),
  ).toMatchObject({
    processRecord: "observed",
    outcome: "observed",
    phase: "completed",
    exitCode: "zero",
    stopped: false,
    timedOut: false,
    nativeResult: "observed",
  });

  expect(
    project([runtimeFrame(requestId, outcome("failed", 7, false, false))]),
  ).toMatchObject({
    phase: "failed",
    exitCode: "nonzero",
    stopped: false,
    timedOut: false,
  });
  expect(
    project([runtimeFrame(requestId, outcome("failed", null, false, true))]),
  ).toMatchObject({
    phase: "failed",
    exitCode: "null",
    stopped: false,
    timedOut: true,
  });
  expect(
    project([runtimeFrame(requestId, outcome("unknown", null, true, false))]),
  ).toMatchObject({
    phase: "unknown",
    exitCode: "null",
    stopped: true,
    timedOut: false,
  });
  expect(
    project([runtimeFrame(requestId, outcome("unknown", null, false, false))]),
  ).toMatchObject({ phase: "unknown", outcome: "observed" });

  const missing = project([]);
  expect(missing).toEqual({
    processRecord: "not-in-page",
    outcome: "not-in-page",
    phase: "not-observed",
    exitCode: null,
    stopped: null,
    timedOut: null,
    nativeError: "not-observed",
    nativeResult: "not-observed",
  });
  expect(
    project([runtimeFrame(otherRequestId, outcome("failed", 8, false, false))]),
  ).toEqual(missing);

  const ambiguous = project([
    runtimeFrame(requestId, outcome("failed", 1, false, false)),
    runtimeFrame(requestId, outcome("failed", 2, false, false)),
  ]);
  expect(ambiguous).toMatchObject({
    outcome: "invalid",
    phase: "not-observed",
    exitCode: null,
    stopped: null,
    timedOut: null,
  });

  const malformed = project([
    {
      turnId: requestId,
      event: {
        kind: "coding-gemini-chat",
        provider: "gemini",
        version: "0.65.0",
        event: {
          kind: "outcome",
          outcome: { phase: "private-phase" },
        },
      },
    },
  ]);
  expect(malformed).toMatchObject({
    outcome: "invalid",
    phase: "not-observed",
    exitCode: null,
  });

  const privateProjection = project([
      runtimeFrame(requestId, process),
      runtimeFrame(requestId, outcome("failed", 3, false, false)),
      runtimeFrame(requestId, {
        kind: "error",
        requestId,
        code: 1,
        message: { text: "PRIVATE native error", truncated: false },
      }),
    ]);
  expect(privateProjection.nativeError).toBe("observed");
  const serialized = JSON.stringify(privateProjection);
  for (const value of [
    requestId,
    "23456",
    "12345",
    "private-smith-name",
    "PRIVATE outcome reason",
    "PRIVATE stderr",
    "PRIVATE native error",
  ])
    expect(serialized).not.toContain(value);
});

test("bounded Gemini witness summaries expose counts and a marker bit only", () => {
  const privateValues = [
    "PRIVATE-ACP-PROMPT",
    "PRIVATE-ACP-CONTEXT",
    "C:\\private\\fixture\\gemini-acp.json",
    "operator-token-secret",
    "S-1-5-21-private",
    "Synthetic authentication required",
  ];
  const summary = summarizeGeminiChatWitnessText(
    JSON.stringify([
      { kind: "start", argv: privateValues, pid: 123456 },
      {
        kind: "wire",
        value: {
          method: "session/prompt",
          params: { prompt: privateValues[0], attachments: privateValues },
        },
      },
      { kind: "wire", value: { method: "initialize", params: privateValues } },
      { kind: "wire", value: { method: "private/new-operation" } },
    ]),
  );

  expect(summary).toMatchObject({
    state: "ok",
    rows: 4,
    kinds: { start: 1, wire: 3, other: 0 },
    methods: { sessionPrompt: 1, initialize: 1, other: 1 },
    promptMarkerMatched: true,
  });
  const serialized = JSON.stringify(summary);
  for (const value of privateValues) expect(serialized).not.toContain(value);
  expect(serialized).not.toContain("123456");
  expect(serialized).not.toContain("private/new-operation");
});

test("only the matching session/prompt wire row can set the marker bit", () => {
  const initializeOnly = summarizeGeminiChatWitnessText(
    JSON.stringify([
      {
        kind: "wire",
        value: { method: "initialize", params: "PRIVATE-ACP-PROMPT" },
      },
    ]),
  );
  const prompt = summarizeGeminiChatWitnessText(
    JSON.stringify([
      {
        kind: "wire",
        value: { method: "session/prompt", params: "PRIVATE-ACP-PROMPT" },
      },
    ]),
  );

  expect(initializeOnly.promptMarkerMatched).toBe(false);
  expect(prompt.promptMarkerMatched).toBe(true);
});

test("witness summaries distinguish missing, unreadable, partial, invalid and oversized evidence", () => {
  expect(unavailableGeminiChatWitnessLog("missing")).toMatchObject({
    state: "missing",
    reason: "absent",
    bytes: null,
    rows: null,
    promptMarkerMatched: false,
  });
  expect(unavailableGeminiChatWitnessLog("unreadable")).toMatchObject({
    state: "unreadable",
    reason: "read-failed",
    bytes: null,
    rows: null,
  });
  expect(summarizeGeminiChatWitnessText('[{"kind":"wire"}', 17)).toMatchObject({
    state: "partial",
    reason: "incomplete-json",
    bytes: 17,
  });
  expect(summarizeGeminiChatWitnessText("not-json]", 9)).toMatchObject({
    state: "invalid",
    reason: "invalid-json",
  });
  expect(summarizeGeminiChatWitnessText("[]", 256 * 1024 + 1)).toMatchObject({
    state: "invalid",
    reason: "over-limit",
    rows: null,
  });
  expect(
    summarizeGeminiChatWitnessText(
      JSON.stringify(Array.from({ length: 257 }, () => ({ kind: "wire" }))),
    ),
  ).toMatchObject({ state: "invalid", reason: "too-many-rows", rows: null });
});

test("unknown operations count without exposing their raw value", () => {
  const summary = summarizeGeminiChatWitnessText(
    JSON.stringify([{ kind: "wire", value: "private raw input" }]),
  );
  expect(summary).toMatchObject({
    state: "ok",
    rows: 1,
    methods: { other: 1 },
  });
  expect(JSON.stringify(summary)).not.toContain("private raw input");
  expect(summarizeGeminiChatWitnessText("[1]")).toMatchObject({
    state: "invalid",
    reason: "wrong-shape",
    rows: null,
  });
});

test("bounded file reads classify missing, invalid UTF-8, oversized and valid snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "gemini-chat-witness-"));
  try {
    const missing = readGeminiChatWitnessLog(join(root, "missing.json"));
    const invalidPath = join(root, "invalid.json");
    writeFileSync(invalidPath, Buffer.from([0xff, 0xfe]));
    const invalid = readGeminiChatWitnessLog(invalidPath);
    const oversizedPath = join(root, "oversized.json");
    writeFileSync(oversizedPath, Buffer.alloc(256 * 1024 + 1, 0x20));
    const oversized = readGeminiChatWitnessLog(oversizedPath);
    const validPath = join(root, "valid.json");
    writeFileSync(
      validPath,
      JSON.stringify([{ kind: "wire", value: { method: "session/prompt" } }]),
    );
    const valid = readGeminiChatWitnessLog(validPath);

    expect(missing).toMatchObject({ state: "missing", reason: "absent" });
    expect(invalid).toMatchObject({ state: "invalid", reason: "invalid-utf8" });
    expect(oversized).toMatchObject({
      state: "invalid",
      reason: "over-limit",
      bytes: 256 * 1024 + 1,
    });
    expect(valid).toMatchObject({
      state: "ok",
      rows: 1,
      methods: { sessionPrompt: 1 },
    });
    for (const summary of [missing, invalid, oversized, valid])
      expect(JSON.stringify(summary)).not.toContain(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure observer emits before cleanup and preserves the original error through observer failures", async () => {
  const order: string[] = [],
    original = new Error("The protected inert witness did not arrive");
  let observed: unknown;
  try {
    await emitGeminiChatWitnessFailureFactsAndRethrow(
      original,
      async () => {
        order.push("read-facts");
        return { log: { state: "partial" }, original: { phase: "running" } };
      },
      () => {
        order.push("emit-snapshot");
      },
    );
  } catch (error) {
    observed = error;
    order.push("catch-original");
  }
  order.push("cleanup");
  expect(observed).toBe(original);
  expect(order).toEqual([
    "read-facts",
    "emit-snapshot",
    "catch-original",
    "cleanup",
  ]);

  observed = undefined;
  try {
    await emitGeminiChatWitnessFailureFactsAndRethrow(
      original,
      async () => ({ log: { state: "ok" } }),
      () => {
        throw new Error("private stderr failure");
      },
    );
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(original);

  let overLimitLine = "";
  observed = undefined;
  try {
    await emitGeminiChatWitnessFailureFactsAndRethrow(
      original,
      async () => ({ private: "x".repeat(9 * 1024) }),
      (line) => {
        overLimitLine = line;
      },
    );
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(original);
  expect(overLimitLine).toContain("facts-over-limit");
  expect(overLimitLine).not.toContain("x".repeat(100));
  expect(Buffer.byteLength(overLimitLine)).toBeLessThan(200);

  const readFailure = new Error("private path and raw cause");
  observed = undefined;
  try {
    await emitGeminiChatWitnessFailureFactsAndRethrow(
      original,
      async () => {
        throw readFailure;
      },
      () => undefined,
    );
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(original);
});
