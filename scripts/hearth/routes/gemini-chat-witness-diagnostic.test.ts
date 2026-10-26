import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitGeminiChatWitnessFailureFactsAndRethrow,
  readGeminiChatWitnessLog,
  summarizeGeminiChatWitnessText,
  unavailableGeminiChatWitnessLog,
} from "./gemini-chat-witness-diagnostic.test-utils";

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
