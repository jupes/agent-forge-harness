import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import type { CodingActivityEvent } from "../../types/session-activity";
import { eventSchema } from "../conversations/protocol";
import {
  claudeCodingUsageSchema,
  codingActivitySchema,
  codingOutcomeSchema,
  reportedJson,
  reportedText,
  SESSION_ACTIVITY_LIMITS,
} from "./activity-protocol";
import { ownedCodingEventSchema } from "./codex-owned-journal";

const base = {
  kind: "coding-activity",
  provider: "claude",
  version: "2.1.296",
  id: "message:tool-1",
  source: "claude.assistant",
  partial: false,
} as const;
test("strict private activity accepts inert reported data without granting the Keeper codec new fields", () => {
  const value = {
    ...base,
    activity: {
      kind: "tool",
      toolId: "tool-1",
      name: "Bash",
      state: "running",
      input: reportedJson({ command: "echo private", approval: "allow once" }),
    },
  } satisfies CodingActivityEvent;
  expect(codingActivitySchema.parse(value)).toEqual(value);
  expect(ownedCodingEventSchema.safeParse(value).success).toBe(true);
  expect(eventSchema.safeParse(value).success).toBe(false);
  expect(
    codingActivitySchema.safeParse({ ...value, authority: "operator" }).success,
  ).toBe(false);
  expect(
    codingActivitySchema.safeParse({ ...value, provider: "codex" }).success,
  ).toBe(false);
});

test("Claude cache counters keep provider-specific names and cannot overwrite the existing Codex wire", () => {
  const usage = {
    kind: "coding-usage",
    provider: "claude",
    source: "claude.result",
    version: "2.1.296",
    usage: { cacheReadInputTokens: 12, cacheCreationInputTokens: 3 },
  };
  expect(claudeCodingUsageSchema.safeParse(usage).success).toBe(true);
  expect(
    claudeCodingUsageSchema.safeParse({
      ...usage,
      usage: { cachedInputTokens: 12 },
    }).success,
  ).toBe(false);
  const codex = {
    kind: "coding-usage",
    provider: "codex",
    source: "exec.turn.completed",
    version: "0.163.0",
    usage: { cachedInputTokens: 12, cacheWriteInputTokens: 3 },
  };
  expect(JSON.stringify(ownedCodingEventSchema.parse(codex))).toBe(
    JSON.stringify(codex),
  );
});

test("standalone activity codecs parse in a browser bundle with dynamic code generation forbidden", async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/activity-protocol.ts`],
    target: "browser",
    format: "cjs",
  });
  expect(bundle.success).toBe(true);
  const code = await bundle.outputs[0]?.text();
  if (!code) throw Error("Missing activity protocol bundle");
  expect(code).not.toMatch(/require\(["'](?:node:|bun:)/);
  const context = createContext(
    { window: {}, TextEncoder, module: { exports: {} } },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext(code, context);
  expect(
    runInContext(
      'module.exports.codingActivitySchema.safeParse({kind:"coding-activity",provider:"codex",version:"0.163.0",id:"r1",source:"codex.item.completed",partial:false,activity:{kind:"reasoning",content:{text:"summary",truncated:false},redacted:false}}).success',
      context,
    ),
  ).toBe(true);
});

test("UTF-8 clipping and nested JSON limits remain explicit and cannot emit a forged complete value", () => {
  const clipped = reportedText("🌱".repeat(SESSION_ACTIVITY_LIMITS.textBytes));
  expect(clipped.truncated).toBe(true);
  expect(new TextEncoder().encode(clipped.text).length).toBeLessThanOrEqual(
    SESSION_ACTIVITY_LIMITS.textBytes,
  );
  expect(clipped.text).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(reportedText("hello\0private")).toEqual({
    text: "hello�private",
    truncated: true,
  });
  expect(reportedText("\uD800")).toEqual({ text: "�", truncated: true });
  const nested = { child: {} };
  let cursor: { child?: unknown } = nested;
  for (let index = 0; index < SESSION_ACTIVITY_LIMITS.jsonDepth + 1; index++) {
    const next = {};
    cursor.child = next;
    cursor = next;
  }
  expect(reportedJson(nested)).toEqual({
    json: "",
    truncated: true,
    omitted: "depth",
  });
  const output = {
    ...base,
    source: "claude.result",
    activity: {
      kind: "structured-output",
      output: reportedJson({ actual: [1, "two"] }),
    },
  };
  expect(codingActivitySchema.safeParse(output).success).toBe(true);
  expect(
    codingActivitySchema.safeParse({
      ...output,
      activity: {
        kind: "structured-output",
        output: { json: "{", truncated: false },
      },
    }).success,
  ).toBe(false);
});

test("actual process evidence constrains outcomes and reported words cannot grant a typed limit or authentication claim", () => {
  const outcome = {
    kind: "coding-outcome",
    provider: "claude",
    version: "2.1.296",
    code: "timed-out",
    exitCode: null,
    timedOut: true,
    stopped: false,
    message: reportedText("Provider timed out"),
    stderrTail: reportedText(""),
  };
  expect(codingOutcomeSchema.safeParse(outcome).success).toBe(true);
  expect(eventSchema.safeParse(outcome).success).toBe(false);
  expect(
    codingOutcomeSchema.safeParse({
      ...outcome,
      code: "completed",
      exitCode: 0,
    }).success,
  ).toBe(false);
  expect(
    codingOutcomeSchema.safeParse({
      ...outcome,
      timedOut: false,
      code: "rate-limited",
      message: reportedText("limit reached"),
    }).success,
  ).toBe(false);
  expect(
    codingOutcomeSchema.safeParse({
      ...outcome,
      timedOut: false,
      code: "rate-limited",
      reportedCode: "rate_limit",
    }).success,
  ).toBe(true);
  expect(
    codingOutcomeSchema.safeParse({
      ...outcome,
      timedOut: false,
      code: "auth-error",
      reportedCode: "authentication_failed",
      resetAt: "Thursday at9",
    }).success,
  ).toBe(false);
});
