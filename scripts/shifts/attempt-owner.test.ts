import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import type { PrivateExecInput } from "../executors/private-capture";
import { resolveCheckout } from "../ledger/workspace";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../sessions/registry";
import { scratchDirs } from "../test-scratch";
import {
  shiftAttemptHash,
  shiftAttemptOrigin,
  shiftAttemptRequestId,
} from "./attempt-identity";
import { openShiftAttempt } from "./attempt-owner";
import { projectShiftRequestHash } from "./registry";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function fixture() {
  const root = scratch.make("shift-owned-attempt-");
  mkdirSync(join(root, ".git"));
  const workspace = resolveCheckout(root).workspace;
  const home = join(root, "home"),
    controller = new AbortController();
  const projectId = "project-05f27fd0-011b-4e0c-bb01-0da9104b1439";
  const request = {
    requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
    expectedCatalogRevision: 3,
    options: {
      for: "2h",
      concurrency: 2,
      maxBeads: 4,
      maxUsd: 5,
      repairs: 1,
      base: "main",
    },
  };
  const intent: ProjectShiftIntent = {
    projectId,
    workspace,
    request,
    shiftId: "shift-20261023-080000-1234",
    requestHash: projectShiftRequestHash(projectId, workspace, request),
    createdAt: "2026-10-23T08:00:00.000Z",
    attemptedAt: "2026-10-23T08:00:01.000Z",
    executionStartedAt: "2026-10-23T08:00:02.000Z",
  };
  const input: PrivateExecInput = {
    provider: "claude",
    beadId: "bounded-task-1",
    runId: "bounded-run-1",
    workspace,
    cwd: workspace,
    smith: {
      name: "claude-journeyman",
      provider: "claude",
      model: "claude-sonnet-5-5",
      effort: "medium",
      enabled: true,
      tags: [],
    },
    command: ["/fixture/claude", "-p"],
    stdin: "  exact private attempt 🌱\n",
    timeoutMs: 1000,
  };
  let prepared = 0,
    validated = 0;
  const options = {
    home,
    intent,
    input,
    attempt: 1,
    signal: controller.signal,
    prepare: async () => {
      prepared++;
      return { version: "2.1.293" };
    },
    validate: async () => {
      validated++;
    },
  };
  return {
    home,
    intent,
    input,
    controller,
    options,
    prepared: () => prepared,
    validated: () => validated,
  };
}

test("a fresh shift attempt privately correlates its full actual input before returning its owned turn", async () => {
  const f = fixture(),
    opened = await openShiftAttempt(f.options);
  try {
    const registry = createSessionRegistry(f.home).listAll(f.intent.projectId);
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      id: opened.record.id,
      requestId: shiftAttemptRequestId(f.intent, f.input, 1),
      origin: { kind: "shift", beadId: f.input.beadId, attempt: 1 },
    });
    const state = createConversationStore(
      f.home,
      undefined,
      opened.address,
    ).read(f.intent.projectId);
    expect(state.frames[0]?.event).toMatchObject({
      kind: "user",
      text: f.input.stdin,
      shift: {
        conversationId: opened.record.id,
        turnId: registry[0]?.requestId,
        command: f.input.command,
        stdin: f.input.stdin,
      },
    });
    expect(state.turns[0]?.phase).toBe("running");
    expect(f.prepared()).toBe(1);
    expect(f.validated()).toBe(1);
    const file = conversationFile(f.home, f.intent.projectId, opened.address),
      bytes = readFileSync(file, "utf8");
    await expect(openShiftAttempt(f.options)).rejects.toThrow(
      "private provider transcript",
    );
    expect(f.prepared()).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  } finally {
    await opened.owner.finish({
      phase: "failed",
      reason: "No provider was dispatched.",
    });
  }
});

test("a reservation without its private journal stays unknown and is refused before mutable probes", async () => {
  const f = fixture(),
    registry = createSessionRegistry(f.home);
  const record = await registry.reserve(
    f.intent.projectId,
    shiftAttemptRequestId(f.intent, f.input, 1),
    shiftAttemptHash(f.intent, f.input, 1, "2.1.293"),
    () => ({
      provider: "claude",
      mode: "task",
      workspace: f.input.workspace,
      repository: f.input.workspace,
      worktree: f.input.cwd,
      beadId: f.input.beadId,
      smith: f.input.smith.name,
      requestedModel: f.input.smith.model,
      requestedEffort: "medium",
      origin: shiftAttemptOrigin(f.intent, f.input, 1),
    }),
  );
  const file = sessionRegistryFile(f.home),
    bytes = readFileSync(file, "utf8");
  await expect(openShiftAttempt(f.options)).rejects.toThrow(
    "private provider transcript",
  );
  expect(f.prepared()).toBe(0);
  expect(f.validated()).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(
    existsSync(
      conversationFile(f.home, f.intent.projectId, {
        kind: "session",
        projectId: f.intent.projectId,
        sessionId: record.id,
      }),
    ),
  ).toBe(false);
});

test("two concurrent claimants can hand off only one original private turn", async () => {
  const f = fixture(),
    results = await Promise.allSettled([
      openShiftAttempt(f.options),
      openShiftAttempt(f.options),
    ]);
  const admitted = results.filter((result) => result.status === "fulfilled");
  try {
    expect(admitted).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(f.validated()).toBe(1);
    expect(
      createSessionRegistry(f.home).listAll(f.intent.projectId),
    ).toHaveLength(1);
    for (const result of admitted) {
      const state = createConversationStore(
        f.home,
        undefined,
        result.value.address,
      ).read(f.intent.projectId);
      expect(state.frames).toHaveLength(1);
      expect(state.turns).toHaveLength(1);
    }
  } finally {
    for (const result of admitted)
      await result.value.owner.finish({
        phase: "failed",
        reason: "No provider was dispatched.",
      });
  }
});

test("Stop during a held scope check leaves no late registry reservation or private input", async () => {
  const f = fixture();
  let enter = () => {},
    release = () => {};
  const entered = new Promise<void>((done) => {
      enter = done;
    }),
    held = new Promise<void>((done) => {
      release = done;
    });
  const pending = openShiftAttempt({
    ...f.options,
    validate: async () => {
      enter();
      await held;
    },
  });
  await entered;
  f.controller.abort();
  release();
  await expect(pending).rejects.toThrow("private provider transcript");
  expect(
    createSessionRegistry(f.home).listAll(f.intent.projectId),
  ).toHaveLength(0);
  expect(existsSync(join(f.home, "conversations"))).toBe(false);
});

test("Stop releases the shared registry lock even when scope validation never settles", async () => {
  const f = fixture();
  let enter = () => {},
    release = () => {};
  const entered = new Promise<void>((done) => {
      enter = done;
    }),
    held = new Promise<void>((done) => {
      release = done;
    });
  const pending = openShiftAttempt({
    ...f.options,
    validate: async () => {
      enter();
      await held;
    },
  });
  const settled = pending.then(
    () => "admitted",
    () => "refused",
  );
  try {
    await entered;
    f.controller.abort();
    expect(
      await Promise.race([settled, Bun.sleep(500).then(() => "hung")]),
    ).toBe("refused");
    const independent = await openShiftAttempt({
      ...f.options,
      signal: new AbortController().signal,
      attempt: 2,
      validate: async () => {},
    });
    await independent.owner.finish({
      phase: "failed",
      reason: "No provider was dispatched.",
    });
    expect(
      createSessionRegistry(f.home).listAll(f.intent.projectId),
    ).toHaveLength(1);
  } finally {
    release();
    await settled;
  }
  const origin = createSessionRegistry(f.home).listAll(f.intent.projectId)[0]
    ?.origin;
  expect(origin?.kind === "shift" ? origin.attempt : null).toBe(2);
});

test("failed scope validation creates no reservation and another admitted attempt gets independent identity", async () => {
  const f = fixture();
  await expect(
    openShiftAttempt({
      ...f.options,
      validate: async () => {
        throw Error("private scope diagnostic");
      },
    }),
  ).rejects.toThrow("private provider transcript");
  expect(
    createSessionRegistry(f.home).listAll(f.intent.projectId),
  ).toHaveLength(0);
  const first = await openShiftAttempt(f.options),
    second = await openShiftAttempt({ ...f.options, attempt: 2 });
  try {
    expect(first.record.id).not.toBe(second.record.id);
    expect(first.snapshot.turnId).not.toBe(second.snapshot.turnId);
    expect(first.snapshot.attempt).toBe(1);
    expect(second.snapshot.attempt).toBe(2);
  } finally {
    await first.owner.finish({
      phase: "failed",
      reason: "No provider was dispatched.",
    });
    await second.owner.finish({
      phase: "failed",
      reason: "No provider was dispatched.",
    });
  }
});

test("Codex retains its own origin and the actual captured input is insulated from callback mutation", async () => {
  const f = fixture();
  f.input.provider = "codex";
  f.input.smith = {
    ...f.input.smith,
    provider: "codex",
    name: "codex-journeyman",
    model: "gpt-6",
    effort: "xhigh",
  };
  const original = structuredClone(f.input);
  const opened = await openShiftAttempt({
    ...f.options,
    prepare: async (input) => {
      input.stdin = "mutated probe";
      return { version: "0.163.0" };
    },
    validate: async (input) => {
      input.command.push("--changed");
    },
  });
  try {
    expect(opened.record).toMatchObject({
      provider: "codex",
      origin: { attempt: 1, beadId: original.beadId },
      requestedEffort: "xhigh",
    });
    expect(opened.snapshot).toMatchObject({
      stdin: original.stdin,
      command: original.command,
      cliVersion: "0.163.0",
      provider: "codex",
    });
    expect(f.input).toEqual(original);
  } finally {
    await opened.owner.finish({
      phase: "failed",
      reason: "No provider was dispatched.",
    });
  }
});
