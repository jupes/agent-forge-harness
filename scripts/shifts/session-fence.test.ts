import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createOwnedSessionService,
  type SessionRuntime,
} from "../sessions/admission";
import { createCodexOwnedTaskService } from "../sessions/codex-owned-admission";
import {
  createOwnedCodingSessionService,
  unavailableCodexTaskRuntime,
} from "../sessions/owned-coding-service";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../sessions/registry";
import { scratchDirs } from "../test-scratch";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const projectId = "project-05f27fd0-011b-4e0c-bb01-0da9104b1439";
const requestId = "2230bb02-1119-4c69-adad-c44116b375c1";
const origin = {
  kind: "shift",
  projectId,
  originalRequestId: requestId,
  shiftId: "shift-20261023-080000-1234",
  runId: "bounded-run-1",
  beadId: "bounded-task-1",
  attempt: 1,
} as const;

async function fixture() {
  const root = realpathSync.native(
    scratch.make("shift generic session fence "),
  );
  mkdirSync(join(root, ".git"));
  const home = join(root, "home");
  const metadata = {
    mode: "task",
    provider: "claude",
    workspace: root,
    repository: root,
    worktree: root,
    beadId: origin.beadId,
    smith: "claude-journeyman",
    requestedModel: "claude-sonnet-5-5",
    requestedEffort: "medium",
    origin,
  } as const;
  const claude = await createSessionRegistry(home).reserve(
    projectId,
    requestId,
    "a".repeat(64),
    () => metadata,
  );
  const codex = await createSessionRegistry(home, "codex").reserve(
    projectId,
    "76c12d8a-a41c-41a3-a383-aac004d332e4",
    "b".repeat(64),
    () => ({ ...metadata, provider: "codex" }),
  );
  let calls = 0;
  const runtime: SessionRuntime = {
    provider: "claude",
    async prepare() {
      calls++;
      throw Error("Unexpected ordinary preparation");
    },
    async run() {
      calls++;
      throw Error("Unexpected ordinary dispatch");
    },
  };
  const options = {
    root,
    home,
    runtime,
    async validateScope() {
      calls++;
    },
  };
  return { root, home, claude, codex, options, calls: () => calls };
}

test("managed shift origins remain owned metadata but are excluded from ordinary coding controls", async () => {
  const f = await fixture();
  const service = createOwnedCodingSessionService(f.options);
  const claude = createOwnedSessionService(f.options);
  const codex = createCodexOwnedTaskService({
    ...f.options,
    runtime: unavailableCodexTaskRuntime,
  });
  try {
    expect(createSessionRegistry(f.home).listAll(projectId)).toHaveLength(2);
    expect(service.list(projectId)).toEqual([]);
    expect(claude.list(projectId)).toEqual([]);
    expect(codex.list(projectId)).toEqual([]);
  } finally {
    await Promise.all([service.close(), claude.close(), codex.close()]);
  }
});

test("generic private reads and Stop cannot create a service or stop marker for a managed shift attempt", async () => {
  const f = await fixture();
  const service = createOwnedCodingSessionService(f.options);
  const claude = createOwnedSessionService(f.options);
  const codex = createCodexOwnedTaskService({
    ...f.options,
    runtime: unavailableCodexTaskRuntime,
  });
  const bytes = readFileSync(sessionRegistryFile(f.home), "utf8");
  try {
    for (const [selected, row] of [
      [service, f.claude],
      [service, f.codex],
      [claude, f.claude],
      [codex, f.codex],
    ] as const) {
      for (const action of [
        () => selected.read(projectId, row.id),
        () => selected.stop(projectId, row.id, row.requestId),
        () => selected.settled(projectId, row.id),
        () =>
          selected.send(projectId, row.id, {
            requestId,
            expectedRevision: 0,
            text: "No ordinary turn",
            about: [],
          }),
      ])
        await expect(
          Promise.resolve().then(async () => {
            await action();
          }),
        ).rejects.toThrow("shift");
    }
    expect(f.calls()).toBe(0);
    expect(readFileSync(sessionRegistryFile(f.home), "utf8")).toBe(bytes);
    expect(createSessionRegistry(f.home).listAll(projectId)).toHaveLength(2);
  } finally {
    await Promise.all([service.close(), claude.close(), codex.close()]);
  }
});
