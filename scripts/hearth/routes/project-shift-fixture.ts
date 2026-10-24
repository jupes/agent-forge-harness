import { join } from "node:path";
import { createConversationStore } from "../../conversations/store";
import type { PrivateExecInput } from "../../executors/private-capture";
import { FIXTURE_PROJECT_ID } from "../../projects/testing";
import { SHIFTS_DIR, writeShiftRecord } from "../../scheduler/shift-store";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../../sessions/registry";
import {
  prepareShiftTurnSnapshot,
  shiftAttemptHash,
  shiftAttemptOrigin,
  shiftAttemptRequestId,
} from "../../shifts/attempt-identity";
import { createProjectShiftRegistry } from "../../shifts/registry";
import type { TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";

export const FIXTURE_SHIFT_ID = "shift-20261023-063000-0001";
export const FIXTURE_SHIFT_ATTEMPT_SESSION_ID =
  "session-2a60106d-f166-4930-a9d0-0b0f52b1bf3c";
export const FIXTURE_SHIFT_START = {
  requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
  expectedCatalogRevision: 1,
  options: {
    for: "2h",
    concurrency: 2,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 3,
    base: "master",
  },
};
/** Private fake original only; no engine, process, Git or tracker write. */
export async function seedProjectShift(
  h: TestHearth,
  actual?: "live" | "dead",
) {
  const { intent } = await createProjectShiftRegistry({
    home: h.home,
    root: h.root,
  }).reserve(FIXTURE_PROJECT_ID, FIXTURE_SHIFT_START, async () => ({
    shiftId: FIXTURE_SHIFT_ID,
  }));
  if (actual) {
    const startedAt = new Date(Date.parse(intent.createdAt) + 1);
    writeShiftRecord(join(h.home, SHIFTS_DIR), {
      shiftId: FIXTURE_SHIFT_ID,
      workspace: h.workspace,
      pid: actual === "live" ? process.pid : 2_000_000_000,
      state: "running",
      startedAt: startedAt.toISOString(),
      deadline: new Date(startedAt.getTime() + 7_200_000).toISOString(),
      options: {
        concurrency: 2,
        forMs: 7_200_000,
        maxBeads: 4,
        maxUsd: 10,
        repairs: 3,
        base: "master",
      },
      spentUsd: 0,
      unpriced: 0,
      admitted: 0,
      beads: [],
    });
  }
}

/** One historical private attempt, no CLI, engine, lease owner or ledger effect. */
export async function seedProjectShiftAttempt(h: TestHearth) {
  await seedProjectShift(h);
  const originals = createProjectShiftRegistry({ home: h.home, root: h.root });
  const saved = originals.read(
    FIXTURE_PROJECT_ID,
    FIXTURE_SHIFT_START.requestId,
  );
  await originals.markAttempted(
    FIXTURE_PROJECT_ID,
    FIXTURE_SHIFT_START.requestId,
    saved.requestHash,
  );
  const { intent } = await originals.claimExecution(
    FIXTURE_PROJECT_ID,
    FIXTURE_SHIFT_START.requestId,
    saved.requestHash,
  );
  const registry = createSessionRegistry(h.home),
    existing = registry.listAll(FIXTURE_PROJECT_ID);
  const input: PrivateExecInput = {
    provider: "claude",
    beadId: "alpha-work",
    runId: "fixture-shift-run",
    workspace: h.workspace,
    cwd: h.workspace,
    smith: {
      name: "claude-journeyman",
      provider: "claude",
      model: "exact-fixture-model",
      effort: "medium",
      enabled: true,
      tags: [],
    },
    command: ["/fixture/claude", "-p"],
    stdin: "Historical private shift attempt",
    timeoutMs: 1000,
  };
  const requestId = shiftAttemptRequestId(intent, input, 1),
    version = "2.1.296";
  if (
    !existing.some((record) => record.id === FIXTURE_SHIFT_ATTEMPT_SESSION_ID)
  )
    writeOwnerOnly(
      sessionRegistryFile(h.home),
      JSON.stringify({
        version: 1,
        records: [
          ...existing,
          {
            projectId: FIXTURE_PROJECT_ID,
            id: FIXTURE_SHIFT_ATTEMPT_SESSION_ID,
            requestId,
            requestHash: shiftAttemptHash(intent, input, 1, version),
            createdAt: intent.createdAt,
            mode: "task",
            provider: "claude",
            workspace: h.workspace,
            repository: h.workspace,
            worktree: h.workspace,
            beadId: input.beadId,
            smith: input.smith.name,
            requestedModel: input.smith.model,
            requestedEffort: input.smith.effort,
            origin: shiftAttemptOrigin(intent, input, 1),
          },
        ],
      }),
    );
  const store = createConversationStore(h.home, undefined, {
    kind: "session",
    projectId: FIXTURE_PROJECT_ID,
    sessionId: FIXTURE_SHIFT_ATTEMPT_SESSION_ID,
  });
  if (!store.read(FIXTURE_PROJECT_ID).turns.length) {
    await store.accept(FIXTURE_PROJECT_ID, {
      requestId,
      expectedRevision: 0,
      text: input.stdin,
      about: [
        { kind: "bead", id: input.beadId },
        { kind: "run", id: input.runId ?? "" },
      ],
      shift: prepareShiftTurnSnapshot(
        intent,
        input,
        1,
        version,
        FIXTURE_SHIFT_ATTEMPT_SESSION_ID,
      ),
    });
    const owner = "f46f398d-a89f-40c8-889c-6ea8bdc43b89";
    await store.start(FIXTURE_PROJECT_ID, requestId, owner);
    await store.finish(
      FIXTURE_PROJECT_ID,
      requestId,
      owner,
      "failed",
      "Historical fixture: no provider was dispatched.",
    );
  }
}
