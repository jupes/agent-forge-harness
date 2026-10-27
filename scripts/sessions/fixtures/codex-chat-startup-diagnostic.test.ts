import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CodexChatEvent } from "../../../types/codex-chat";
import { scratchDirs } from "../../test-scratch";
import {
  CODEX_CHAT_STARTUP_DIAGNOSTIC_MAX_BYTES,
  claimCodexChatStartupDiagnosticHost,
  createCodexChatStartupDiagnostic,
  writeFirstCodexChatStartupFailure,
} from "./codex-chat-startup-diagnostic";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const processEvent: CodexChatEvent = {
  kind: "process",
  pid: 101,
  wrapperPid: 100,
  smith: "fixture",
  requestedModel: "fixture-model",
  requestedEffort: null,
};
const phase = "provider-pid-waiting" as const;

test("startup diagnostic records only fixed phases and actual process persistence", async () => {
  let fact: unknown;
  const diagnostic = createCodexChatStartupDiagnostic({
    recordFailure(value) {
      fact = value;
    },
  });
  diagnostic.observeRuntimePhase("supervisor-returned", false);
  diagnostic.observeRuntimePhase(phase, false);
  const wrapped = diagnostic.wrapPersist(async () => undefined);
  await wrapped(processEvent);
  diagnostic.finish("unknown");

  expect(fact).toEqual({
    version: 1,
    target: "initial-host-first-run",
    outcome: "unknown",
    events: [
      { kind: "runtime", phase: "supervisor-returned", signalAborted: false },
      { kind: "runtime", phase, signalAborted: false },
      { kind: "process-event-persist", outcome: "entered" },
      { kind: "process-event-persist", outcome: "completed" },
    ],
    eventsCapped: false,
  });
  const serialized = JSON.stringify(fact);
  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
    CODEX_CHAT_STARTUP_DIAGNOSTIC_MAX_BYTES,
  );
  expect(serialized).not.toContain("fixture-model");
  expect(serialized).not.toContain('"pid"');
});

test("process persistence refusal preserves the exact rejection and is recorded once", async () => {
  const failure = new Error("private persistence detail");
  const facts: unknown[] = [];
  const diagnostic = createCodexChatStartupDiagnostic({
    recordFailure(fact) {
      facts.push(fact);
    },
  });
  const wrapped = diagnostic.wrapPersist(async () => {
    throw failure;
  });
  await expect(wrapped(processEvent)).rejects.toBe(failure);
  diagnostic.finish("threw");
  diagnostic.finish("unknown");

  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({
    outcome: "threw",
    events: [
      { kind: "process-event-persist", outcome: "entered" },
      { kind: "process-event-persist", outcome: "refused" },
    ],
  });
  expect(JSON.stringify(facts[0])).not.toContain("private persistence detail");
});

test("successful runs write nothing and diagnostic writer failures stay best effort", () => {
  let writes = 0;
  const successful = createCodexChatStartupDiagnostic({
    recordFailure() {
      writes++;
    },
  });
  successful.finish("completed");
  expect(writes).toBe(0);

  const throwingWriter = createCodexChatStartupDiagnostic({
    recordFailure() {
      writes++;
      throw new Error("fixture diagnostic unavailable");
    },
  });
  throwingWriter.observeRuntimePhase("provider-pid-wait-rejected", true);
  expect(() => throwingWriter.finish("unknown")).not.toThrow();
  expect(writes).toBe(1);
});

test("facts remain bounded when an observer reports more than the fixed event limit", () => {
  let fact: unknown;
  const diagnostic = createCodexChatStartupDiagnostic({
    recordFailure(value) {
      fact = value;
    },
  });
  for (let index = 0; index < 32; index++)
    diagnostic.observeRuntimePhase("provider-pid-waiting", false);
  diagnostic.finish("failed");

  expect(fact).toMatchObject({ eventsCapped: true });
  const serialized = JSON.stringify(fact);
  expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
    CODEX_CHAT_STARTUP_DIAGNOSTIC_MAX_BYTES,
  );
  expect((fact as { events: unknown[] }).events).toHaveLength(12);
});

test("failure file is first-write-only under an exclusive fixture lock", () => {
  const home = scratch.make("codex-chat-startup-fact-");
  mkdirSync(home);
  const first = {
    version: 1 as const,
    target: "initial-host-first-run" as const,
    outcome: "unknown" as const,
    events: [{ kind: "runtime" as const, phase, signalAborted: false }],
    eventsCapped: false,
  };
  const writes: string[] = [];
  const writeOwnerOnly = (path: string, content: string) => {
    writes.push(content);
    writeFileSync(path, content, { flag: "wx" });
  };
  writeFirstCodexChatStartupFailure({ home, fact: first, writeOwnerOnly });
  writeFirstCodexChatStartupFailure({
    home,
    fact: { ...first, outcome: "failed" },
    writeOwnerOnly,
  });

  const path = join(home, "codex-chat-private-startup-failure.json");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
  expect(existsSync(`${path}.lock`)).toBe(false);
});

test("a pre-existing lock or owner-only writer failure leaves evidence untouched", () => {
  const home = scratch.make("codex-chat-startup-lock-");
  mkdirSync(home);
  const fact = {
    version: 1 as const,
    target: "initial-host-first-run" as const,
    outcome: "unknown" as const,
    events: [],
    eventsCapped: false,
  };
  const path = join(home, "codex-chat-private-startup-failure.json");
  mkdirSync(`${path}.lock`);
  let calls = 0;
  const writeOwnerOnly = () => {
    calls++;
    throw new Error("write refusal");
  };
  expect(() =>
    writeFirstCodexChatStartupFailure({ home, fact, writeOwnerOnly }),
  ).not.toThrow();
  expect(calls).toBe(0);
  expect(existsSync(path)).toBe(false);

  // A lock-free but refused write is also best effort and leaves no partial fact.
  const lock = `${path}.lock`;
  rmSync(lock, { recursive: true });
  expect(() =>
    writeFirstCodexChatStartupFailure({ home, fact, writeOwnerOnly }),
  ).not.toThrow();
  expect(calls).toBe(1);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(lock)).toBe(false);
});

test("initial host claim is exclusive even when no prepare facts exist", () => {
  const home = scratch.make("codex-chat-startup-host-claim-");
  mkdirSync(home);
  expect(claimCodexChatStartupDiagnosticHost(home)).toBe(true);
  expect(claimCodexChatStartupDiagnosticHost(home)).toBe(false);
  expect(
    existsSync(join(home, "codex-chat-startup-diagnostic-initial-host.claim")),
  ).toBe(true);
});

test("per-run histories are isolated and late persistence cannot mutate a recorded fact", async () => {
  const facts: unknown[] = [];
  const first = createCodexChatStartupDiagnostic({
      recordFailure(fact) {
        facts.push(fact);
      },
    }),
    second = createCodexChatStartupDiagnostic({
      recordFailure(fact) {
        facts.push(fact);
      },
    });
  first.observeRuntimePhase("supervisor-returned", false);
  second.observeRuntimePhase("provider-pid-wait-rejected", true);

  let releasePersist!: () => void;
  const pending = first
    .wrapPersist(
      () =>
        new Promise<void>((resolve) => {
          releasePersist = resolve;
        }),
    )(processEvent);
  first.finish("unknown");
  second.finish("failed");
  releasePersist();
  await pending;

  expect(facts).toHaveLength(2);
  expect(facts[0]).toMatchObject({
    events: [
      { phase: "supervisor-returned" },
      { kind: "process-event-persist", outcome: "entered" },
    ],
  });
  expect(facts[1]).toMatchObject({
    events: [
      { phase: "provider-pid-wait-rejected", signalAborted: true },
    ],
  });
});
