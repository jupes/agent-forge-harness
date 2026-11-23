import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  emitCodexChatApprovalFailureFactsAndRethrow,
  readCodexChatFixtureLog,
  summarizeCodexChatApprovalFailureFacts,
  summarizeCodexChatFixtureText,
} from "./codex-chat-approval-failure-facts.test-utils";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("approval failure facts expose bounded categories and fixed event counts only", () => {
  const facts = summarizeCodexChatApprovalFailureFacts({
    events: [
      { kind: "process", pid: 9001, wrapperPid: 9002, smith: "private" },
      { kind: "approval-request", approval: { id: "secret-id" } },
      { kind: "untrusted-event", prompt: "private prompt" },
    ],
    outcome: {
      phase: "unknown",
      reason: "__proto__",
      exitCode: 7,
      stopped: false,
      timedOut: false,
      threadId: "private-thread",
    },
    fixture: summarizeCodexChatFixtureText(
      '{"kind":"answer","id":"private-rpc-id","result":{"decision":"decline"}}\n',
    ),
    ownedProcessAlive: false,
  });

  expect(facts.outcome).toEqual({
    state: "available",
    phase: "unknown",
    reason: "other",
    exit: "nonzero",
    stopped: false,
    timedOut: false,
  });
  expect(facts.events).toMatchObject({
    state: "available",
    count: 3,
    order: ["process", "approval-request", "other"],
    truncated: false,
    counts: { process: 1, "approval-request": 1, other: 1 },
  });
  expect(facts.fixture).toMatchObject({
    state: "ok",
    rows: 1,
    stages: { answer: 1 },
    answerIds: { string: 1 },
    decisions: { decline: 1 },
  });
  expect(JSON.stringify(facts)).not.toMatch(
    /9001|9002|private|secret-id|private-rpc-id|private-thread|prompt/,
  );
});

test("unavailable and oversized observations stay unknown instead of becoming zero", () => {
  const unavailable = summarizeCodexChatApprovalFailureFacts({
      events: null,
      outcome: null,
      fixture: {
        state: "unreadable",
        bytes: null,
        rows: null,
        stages: {
          process: null,
          initialize: null,
          threadStart: null,
          turnStart: null,
          answer: null,
          other: null,
        },
        answerIds: { string: null, number: null, other: null },
        decisions: { accept: null, decline: null, cancel: null, other: null },
      },
      ownedProcessAlive: null,
    }),
    oversized = summarizeCodexChatApprovalFailureFacts({
      events: Array.from({ length: 4097 }, () => ({ kind: "process" })),
      outcome: null,
      fixture: summarizeCodexChatFixtureText("", 8 * 1024 * 1024 + 1),
      ownedProcessAlive: null,
    });

  expect(unavailable.events).toMatchObject({
    state: "unavailable",
    count: null,
    order: null,
    counts: null,
  });
  expect(unavailable.outcome.phase).toBe("unavailable");
  expect(unavailable.fixture.stages.answer).toBeNull();
  expect(oversized.events.state).toBe("over-limit");
  expect(oversized.fixture.state).toBe("oversized");
});

test("fixture log reader reports bounded missing, valid, partial, and invalid facts", () => {
  const dir = scratch.make("codex-chat-approval-facts-"),
    absent = join(dir, "absent.jsonl"),
    log = join(dir, "fixture.jsonl");
  expect(readCodexChatFixtureLog(absent).state).toBe("missing");

  writeFileSync(log, '{"kind":"rpc","method":"initialize"}\n');
  expect(readCodexChatFixtureLog(log)).toMatchObject({
    state: "ok",
    rows: 1,
    stages: { initialize: 1 },
  });
  writeFileSync(log, '{"kind":"rpc"}');
  expect(readCodexChatFixtureLog(log).state).toBe("partial");
  writeFileSync(log, Buffer.from([0xff, 0x0a]));
  expect(readCodexChatFixtureLog(log).state).toBe("invalid-utf8");
});

test("best-effort observer preserves original errors and runs before cleanup", async () => {
  const original = new Error("assertion sentinel"),
    order: string[] = [];
  let caught: unknown;
  try {
    await emitCodexChatApprovalFailureFactsAndRethrow(
      original,
      async () => {
        order.push("collect");
        return { safe: true };
      },
      () => {
        order.push("write");
        throw new Error("writer failure");
      },
    );
  } catch (error) {
    caught = error;
    order.push("cleanup");
  }
  expect(caught).toBe(original);
  expect(order).toEqual(["collect", "write", "cleanup"]);
});

test("collector failure cannot replace the original assertion", async () => {
  const original = new Error("assertion sentinel");
  let caught: unknown,
    writes = 0;
  try {
    await emitCodexChatApprovalFailureFactsAndRethrow(
      original,
      async () => {
        throw new Error("observer failure");
      },
      () => {
        writes++;
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);
  expect(writes).toBe(0);
});

test("oversized serialized facts are replaced with a bounded marker", async () => {
  let line = "";
  await emitCodexChatApprovalFailureFactsAndRethrow(
    new Error("assertion sentinel"),
    async () => ({ payload: "x".repeat(9 * 1024) }),
    (value) => {
      line = value;
    },
  ).catch(() => undefined);
  expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(8 * 1024);
  expect(line).toContain('"observer":"facts-over-limit"');
  expect(line).not.toContain("xxxx");
});
