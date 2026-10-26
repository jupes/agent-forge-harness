import { describe, expect, test } from "bun:test";
import {
  GEMINI_CHAT_FAILURE_FACTS_MAX_BYTES,
  normalizeGeminiChatFailureFacts,
  parseBoundedGeminiDiagnosticJson,
  withGeminiChatFailureFacts,
} from "../../tests/desktop-e2e/gemini-chat-failure-facts";

describe("Gemini Chat browser failure facts", () => {
  test("projects only bounded enums and counts, excluding private and unknown fields", () => {
    const privateValue = "private-prompt-path-token-id";
    const body = new TextEncoder().encode(
      JSON.stringify(
        normalizeGeminiChatFailureFacts({
          stateRead: "ok",
          callsRead: "ok",
          turnPhase: "unknown",
          turnReason:
            "The provider did not report a confirmed outcome. This turn was not resent.",
          hasBinding: true,
          nativeOutcomeCount: 1,
          approvalOffers: 1,
          permissionIntents: 1,
          outcome: {
            phase: "unknown",
            reason:
              "The Gemini Chat protocol, cancellation or private save was interrupted. The prompt was not resent.",
            stopReason: "end_turn",
            exitCode: 0,
            stopped: true,
            timedOut: false,
            stderr: privateValue,
            prompt: privateValue,
            path: privateValue,
            requestId: privateValue,
          },
          methodCounts: {
            initialize: 1,
            "session/new": 1,
            "session/prompt": 1,
            "session/cancel": 0,
            [privateValue]: privateValue,
          },
          permissionResponses: 1,
          providerAlive: false,
          helperAlive: false,
          path: privateValue,
          prompt: privateValue,
          token: privateValue,
        }),
      ),
    );
    expect(body.byteLength).toBeLessThanOrEqual(
      GEMINI_CHAT_FAILURE_FACTS_MAX_BYTES,
    );
    const text = new TextDecoder().decode(body);
    expect(text).not.toContain(privateValue);
    expect(text).toContain('"stopReason":"end_turn"');
    expect(text).toContain(
      '"reasonCategory":"protocol_or_private_save_interrupted"',
    );
    expect(text).toContain('"initialize":1');
  });

  test("caps hostile counts and rejects malformed or oversized source JSON", () => {
    const facts = normalizeGeminiChatFailureFacts({
      nativeOutcomeCount: Number.MAX_SAFE_INTEGER,
      methodCounts: { initialize: 99_999_999 },
    });
    expect(facts.nativeOutcomeCount).toBe(1_000_000);
    expect(facts.fixture.methodCounts.initialize).toBe(1_000_000);
    expect(parseBoundedGeminiDiagnosticJson('{"ok":true}', 32)).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(parseBoundedGeminiDiagnosticJson("x".repeat(33), 32)).toEqual({
      ok: false,
      reason: "oversize",
    });
    expect(parseBoundedGeminiDiagnosticJson("{", 32)).toEqual({
      ok: false,
      reason: "invalid",
    });
    for (const hostileReason of ["__proto__", "constructor", "toString"])
      expect(
        normalizeGeminiChatFailureFacts({ turnReason: hostileReason })
          .turnReasonCategory,
      ).toBe("other");
  });

  test("attaches before caller cleanup and preserves the original assertion error", async () => {
    const original = new Error("original assertion");
    const order: string[] = [];
    let caught: unknown;
    try {
      await withGeminiChatFailureFacts({
        async operation() {
          order.push("operation");
          throw original;
        },
        collect() {
          order.push("collect");
          return { stateRead: "ok", turnPhase: "unknown" };
        },
        async attach(body) {
          order.push("attach");
          expect(body.byteLength).toBeLessThanOrEqual(
            GEMINI_CHAT_FAILURE_FACTS_MAX_BYTES,
          );
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      order.push("cleanup");
    }
    expect(caught).toBe(original);
    expect(order).toEqual(["operation", "collect", "attach", "cleanup"]);
  });

  test("diagnostic read or attachment failure cannot replace the original error", async () => {
    const original = new Error("original assertion");
    let caught: unknown;
    try {
      await withGeminiChatFailureFacts({
        async operation() {
          throw original;
        },
        collect() {
          throw new Error("private source read detail");
        },
        async attach() {
          throw new Error("attachment detail");
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
  });
});
