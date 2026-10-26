import { expect, test } from "bun:test";
import {
  summarizeGeminiChatWitnessText,
  unavailableGeminiChatWitnessLog,
} from "./gemini-chat-witness-diagnostic";

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
