import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import { BUILTIN_SMITHS } from "../config/defaults";
import { createConversationStore } from "../conversations/store";
import { claudeAdapter } from "../executors/claude";
import { createCodexAdapter } from "../executors/codex";
import { buildChildEnv } from "../executors/env";
import { createSessionRegistry } from "../sessions/registry";
import { scratchDirs } from "../test-scratch";
import { createShiftAttemptCapture } from "./attempt-capture";
import { projectShiftRequestHash } from "./registry";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function fixture(provider: "claude" | "codex" = "claude") {
  const root = realpathSync.native(scratch.make("attended-private-capture-"));
  mkdirSync(join(root, ".git"));
  const home = join(root, "home"),
    projectId = "project-05f27fd0-011b-4e0c-bb01-0da9104b1439";
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
    workspace: root,
    request,
    requestHash: projectShiftRequestHash(projectId, root, request),
    shiftId: "shift-20261023-080000-1234",
    createdAt: "2026-10-23T08:00:00.000Z",
    attemptedAt: "2026-10-23T08:00:01.000Z",
    executionStartedAt: "2026-10-23T08:00:02.000Z",
  };
  const executable = join(
    root,
    `${provider}${process.platform === "win32" ? ".exe" : ""}`,
  );
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      join(
        import.meta.dir,
        provider === "claude"
          ? "../sessions/fixtures/compiled-coding-cli.ts"
          : "../sessions/fixtures/compiled-codex-task-runtime-cli.ts",
      ),
      "--outfile",
      executable,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 30000 },
  );
  if (built.exitCode !== 0)
    throw Error("Could not compile the inert private provider fixture");
  const smith = BUILTIN_SMITHS[`${provider}-journeyman`];
  if (!smith) throw Error("Fixture smith missing");
  return {
    root,
    home,
    intent,
    executable,
    smith,
    record: join(root, "fixture.json"),
  };
}

test("a real supervised attempt persists its original input, process, private activity and confirmed terminal result", async () => {
  const f = fixture(),
    events = [];
  const capture = createShiftAttemptCapture({
    home: f.home,
    intent: f.intent,
    attempt: 1,
    prepare: async () => ({ version: "2.1.296" }),
    validate: async () => {},
  });
  const handle = await claudeAdapter.spawn({
    beadId: "bounded-task-1",
    runId: "bounded-run-1",
    workspace: f.root,
    worktree: f.root,
    smith: f.smith,
    prompt: "  private attended prompt 🌱\n",
    command: [f.executable],
    timeoutMs: 5000,
    env: {
      ...buildChildEnv(process.env, []),
      CODING_FIXTURE_MODE: "rich",
      CODING_FIXTURE_RECORD: f.record,
    },
    privateCapture: capture,
  });
  try {
    for await (const event of handle.events) events.push(event);
    expect(await handle.done).toMatchObject({ exitCode: 0 });
    expect((await handle.done).privateCaptureFailed).toBeUndefined();
    const record = createSessionRegistry(f.home).listAll(f.intent.projectId)[0];
    if (!record) throw Error("No private attempt was indexed");
    const state = createConversationStore(f.home, undefined, {
      kind: "session",
      projectId: f.intent.projectId,
      sessionId: record.id,
    }).read(f.intent.projectId);
    expect(state.turns[0]?.phase).toBe("completed");
    let wire: unknown;
    try {
      wire = JSON.parse(readFileSync(f.record, "utf8"));
    } catch {
      throw Error("The compiled fake did not publish its actual input");
    }
    const actual = z
      .object({
        argv: z.array(z.string()),
        stdin: z.string(),
        cwd: z.string(),
        pid: z.number(),
      })
      .parse(wire);
    expect(state.frames[0]?.event).toMatchObject({
      kind: "user",
      text: actual.stdin,
      shift: {
        command: [f.executable, ...actual.argv],
        stdin: actual.stdin,
        cwd: actual.cwd,
        attempt: 1,
      },
    });
    expect(state.frames[1]?.event).toMatchObject({ kind: "process" });
    if (state.frames[1]?.event.kind !== "process")
      throw Error("No private process frame");
    expect(state.frames[1].event.pid).not.toBe(handle.pid);
    expect(state.binding).toMatchObject({
      provider: "claude",
      version: "2.1.296",
    });
    expect(
      state.frames.some(
        (frame) =>
          frame.event.kind === "coding-activity" &&
          frame.event.activity.kind === "reasoning",
      ),
    ).toBe(true);
    expect(state.frames.at(-1)?.event).toMatchObject({
      kind: "coding-outcome",
      code: "completed",
      exitCode: 0,
    });
    expect(JSON.stringify(events)).not.toContain("Private reported reasoning");
    expect(JSON.stringify(events)).not.toContain("private attended prompt");
  } finally {
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 40000);

test("provider refusal remains a failed original, while malformed or contradictory completion stops private capture", async () => {
  for (const mode of ["provider-error", "malformed", "exit-after-result"]) {
    const f = fixture();
    const handle = await claudeAdapter.spawn({
      beadId: "bounded-task-1",
      runId: "bounded-run-1",
      workspace: f.root,
      worktree: f.root,
      smith: f.smith,
      prompt: "Private failure attempt",
      command: [f.executable],
      timeoutMs: 5000,
      env: { ...buildChildEnv(process.env, []), CODING_FIXTURE_MODE: mode },
      privateCapture: createShiftAttemptCapture({
        home: f.home,
        intent: f.intent,
        attempt: 1,
        prepare: async () => ({ version: "2.1.296" }),
        validate: async () => {},
      }),
    });
    try {
      const result = await handle.done;
      expect(result.privateCaptureFailed).toBe(
        mode === "provider-error" ? undefined : true,
      );
      const record = createSessionRegistry(f.home).listAll(
        f.intent.projectId,
      )[0];
      if (!record) throw Error("Failed original attempt missing");
      const state = createConversationStore(f.home, undefined, {
        kind: "session",
        projectId: f.intent.projectId,
        sessionId: record.id,
      }).read(f.intent.projectId);
      expect(state.turns[0]?.phase).toBe(
        mode === "provider-error" ? "failed" : "unknown",
      );
      if (mode === "provider-error")
        expect(state.frames.at(-1)?.event).toMatchObject({
          kind: "coding-outcome",
          code: "provider-error",
        });
    } finally {
      await handle.stop("fixture cleanup");
      await handle.done;
    }
  }
}, 40000);

test("exit zero without a verified terminal private result is fatal to the shift", async () => {
  const f = fixture();
  const handle = await claudeAdapter.spawn({
    beadId: "bounded-task-1",
    runId: "bounded-run-1",
    workspace: f.root,
    worktree: f.root,
    smith: f.smith,
    prompt: "Private unknown attempt",
    command: [f.executable],
    timeoutMs: 5000,
    env: {
      ...buildChildEnv(process.env, []),
      CODING_FIXTURE_MODE: "missing-result",
    },
    privateCapture: createShiftAttemptCapture({
      home: f.home,
      intent: f.intent,
      attempt: 1,
      prepare: async () => ({ version: "2.1.296" }),
      validate: async () => {},
    }),
  });
  try {
    expect(await handle.done).toMatchObject({
      exitCode: 0,
      privateCaptureFailed: true,
    });
    const record = createSessionRegistry(f.home).listAll(f.intent.projectId)[0];
    if (!record) throw Error("Original private attempt missing");
    expect(
      createConversationStore(f.home, undefined, {
        kind: "session",
        projectId: f.intent.projectId,
        sessionId: record.id,
      }).read(f.intent.projectId).turns[0]?.phase,
    ).toBe("unknown");
  } finally {
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 40000);

test("Codex uses the same private attempt owner and exact versioned activity without an inferred model", async () => {
  const f = fixture("codex");
  const adapter = createCodexAdapter({
    approvalPolicy: "never",
    prepare: async () => {},
  });
  const handle = await adapter.spawn({
    beadId: "bounded-task-1",
    runId: "bounded-run-1",
    workspace: f.root,
    worktree: f.root,
    smith: f.smith,
    prompt: "Private Codex shift attempt",
    command: [f.executable],
    timeoutMs: 5000,
    env: {
      ...buildChildEnv(process.env, []),
      CODEX_RUNTIME_LOG: f.record,
      CODEX_RUNTIME_MODE: "rich",
    },
    privateCapture: createShiftAttemptCapture({
      home: f.home,
      intent: f.intent,
      attempt: 1,
      prepare: async () => ({ version: "0.163.0-alpha.10.2" }),
      validate: async () => {},
    }),
  });
  try {
    expect((await handle.done).privateCaptureFailed).toBeUndefined();
    const record = createSessionRegistry(f.home).listAll(f.intent.projectId)[0];
    if (!record) throw Error("No original Codex attempt");
    const state = createConversationStore(f.home, undefined, {
      kind: "session",
      projectId: f.intent.projectId,
      sessionId: record.id,
    }).read(f.intent.projectId);
    expect(state.turns[0]?.phase).toBe("completed");
    expect(state.binding).toMatchObject({
      provider: "codex",
      version: "0.163.0-alpha.10.2",
    });
    const user = state.frames[0]?.event;
    if (user?.kind !== "user" || !user.shift)
      throw Error("Codex original input is missing");
    expect(user.shift.command).toContain('approval_policy="never"');
    expect(
      state.frames.filter(
        (frame) =>
          frame.event.kind === "text" &&
          frame.event.text === "Runtime private reply 🌱",
      ),
    ).toHaveLength(1);
    expect(state.frames.some((frame) => frame.event.kind === "model")).toBe(
      false,
    );
    expect(
      state.frames.some(
        (frame) =>
          frame.event.kind === "coding-activity" &&
          frame.event.activity.kind === "command",
      ),
    ).toBe(true);
    expect(state.frames.at(-1)?.event).toMatchObject({
      kind: "coding-outcome",
      provider: "codex",
      code: "completed",
    });
  } finally {
    await handle.stop("fixture cleanup");
    await handle.done;
  }
}, 40000);
