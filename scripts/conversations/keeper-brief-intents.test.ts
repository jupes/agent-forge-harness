import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationState } from "../../types/conversation";
import type {
  KeeperBriefIntent,
  KeeperBriefOriginBinding,
  KeeperBriefSelection,
  KeeperBriefSnapshot,
  KeeperScheduledBriefOriginBinding,
} from "../../types/keeper-brief";
import type { KeeperVisibility } from "../../types/projects";
import { writeOwnerOnly } from "../hearth/token";
import { MAX_KEEPER_BRIEF_INTENT_HISTORY } from "../keeper/brief-protocol";
import { keeperReadiness } from "../keeper/readiness";
import type { KeeperRuntime } from "../keeper/recovery-runtime";
import { resolveCheckout } from "../ledger/workspace";
import { withProjectAdmission } from "../projects/admission";
import { createProjectStore, projectCatalogPath } from "../projects/store";
import { projectFixture } from "../projects/testing";
import { withQueueLock } from "../scheduler/queue-lock";
import { ownedCodingStateSchema } from "../sessions/codex-owned-journal";
import { conversationPage } from "./page";
import { conversationFile, conversationWriteLockFile } from "./paths";
import { conversationPageSchema, stateSchema } from "./protocol";
import { createConversationService } from "./service";
import { ConversationError, createConversationStore } from "./store";
import type { ConversationTransport } from "./transport";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const homeForTest = () => {
  const home = mkdtempSync(join(tmpdir(), "forge-brief-intent-"));
  homes.push(home);
  return home;
};

function snapshot(projectId: string, asOf: string): KeeperBriefSnapshot {
  return {
    version: 1,
    projectId,
    projectName: "Fixture project",
    workspace: "/served",
    catalogRevision: 4,
    asOf,
    since: asOf,
    scope: {
      label: "project:fixture",
      epicIds: [],
      epicCount: 0,
      repositoryCount: 1,
    },
    observed: {
      beads: 0,
      queue: 0,
      sessions: 0,
      runs: 0,
      activity: 0,
    },
    complete: true,
    limitations: [],
    facts: [],
  };
}

const selectedSmith: KeeperBriefSelection = {
  name: "claude-master",
  provider: "claude",
  model: "sonnet-fixture",
  effort: "high",
  enabled: true,
  tags: [],
};

function origin(
  projectId: string,
  workspace = "/served",
  catalogRevision = 4,
): KeeperBriefOriginBinding {
  return { kind: "overview", projectId, workspace, catalogRevision };
}

function reserveInput(
  projectId: string,
  asOf: string,
  updates: Partial<{
    expectedRevision: number;
    origin: KeeperBriefOriginBinding;
    selection: KeeperBriefSelection;
    text: string;
    snapshot: KeeperBriefSnapshot;
  }> = {},
) {
  const scope = updates.origin ?? origin(projectId);
  return {
    expectedRevision: updates.expectedRevision ?? 0,
    origin: scope,
    selection: updates.selection ?? selectedSmith,
    text: updates.text ?? "Build the reviewed brief using this exact prompt.",
    about: [],
    snapshot: updates.snapshot ?? snapshot(projectId, asOf),
  };
}

test("canonical brief reservation survives a lost reply and store recreation without changing conversation revision", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const firstStore = createConversationStore(home);

  // Treat the reserve response as lost: only a newly created store may recover it.
  await firstStore.reserveKeeperBrief(projectId, {
    expectedRevision: 0,
    origin: origin(projectId),
    selection: selectedSmith,
    text: "Build the first exact review prompt.",
    about: [],
    snapshot: snapshot(projectId, "2026-10-29T12:00:00.000Z"),
  });
  expect(firstStore.read(projectId).revision).toBe(0);

  const reopenedStore = createConversationStore(home);
  const recovered = reopenedStore.discoverKeeperBrief(projectId);
  expect(recovered).not.toBeNull();
  if (!recovered)
    throw new Error("The canonical reservation was not recovered.");
  expect(
    reopenedStore.readKeeperBriefIntent(projectId, recovered.requestId),
  ).toEqual(recovered);

  const retried = await reopenedStore.reserveKeeperBrief(projectId, {
    expectedRevision: 0,
    origin: origin(projectId),
    selection: selectedSmith,
    text: "Prompt text after an application upgrade.",
    about: [],
    snapshot: snapshot(projectId, "2026-10-29T12:01:00.000Z"),
  });
  expect(retried).toEqual(recovered);
  expect(recovered?.text).toBe("Build the first exact review prompt.");
  expect(recovered?.snapshot.asOf).toBe("2026-10-29T12:00:00.000Z");
  expect(reopenedStore.read(projectId).revision).toBe(0);
  expect(reopenedStore.read(projectId).turns).toEqual([]);
  expect(reopenedStore.read(projectId).frames).toEqual([]);
});

test("onboarding originals retain legacy scope bindings and fail closed if a new scope hash is tampered", async () => {
  const oldHome = homeForTest();
  const oldProject = `project-${randomUUID()}`;
  const oldStore = createConversationStore(oldHome);
  const oldOrigin = {
    kind: "onboarding",
    projectId: oldProject,
    workspace: "/served",
    catalogRevision: 4,
    projectCreate: {
      requestId: randomUUID(),
      hash: "a".repeat(64),
      revision: 3,
    },
  } satisfies KeeperBriefOriginBinding;
  await oldStore.reserveKeeperBrief(
    oldProject,
    reserveInput(oldProject, "2026-10-29T12:00:00.000Z", {
      origin: oldOrigin,
    }),
  );
  const oldIntent = oldStore.discoverKeeperBrief(oldProject);
  if (!oldIntent) throw new Error("Missing legacy onboarding brief original");
  expect(
    createConversationStore(oldHome).readKeeperBriefIntent(
      oldProject,
      oldIntent.requestId,
    )?.origin,
  ).toEqual(oldOrigin);

  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  await store.reserveKeeperBrief(
    projectId,
    reserveInput(projectId, "2026-10-29T12:00:00.000Z", {
      origin: {
        ...oldOrigin,
        projectId,
        projectCreate: {
          ...oldOrigin.projectCreate,
          requestId: randomUUID(),
          scopeHash: "b".repeat(64),
        },
      },
    }),
  );
  const path = conversationFile(home, projectId);
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Malformed persisted onboarding original fixture");
  }
  const state = stateSchema.parse(decoded);
  const original = state.keeperBriefIntents?.active;
  if (!original || original.origin.kind !== "onboarding")
    throw new Error("Missing onboarding brief original");
  original.origin.projectCreate.scopeHash = "c".repeat(64);
  writeOwnerOnly(path, JSON.stringify(state));
  expect(() => createConversationStore(home).read(projectId)).toThrow();
});

test("matching reservations converge while changed scope, selection, stale revision and foreign snapshots conflict", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const otherProject = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const [first, second] = await Promise.all([
    store.reserveKeeperBrief(
      projectId,
      reserveInput(projectId, "2026-10-29T12:00:00.000Z"),
    ),
    store.reserveKeeperBrief(
      projectId,
      reserveInput(projectId, "2026-10-29T12:01:00.000Z", {
        text: "A newer generated prompt must not replace the original.",
      }),
    ),
  ]);
  expect(second).toEqual(first);
  expect(first.intentHash).not.toBe(first.preparedTurnHash);
  await expect(
    store.reserveKeeperBrief(
      projectId,
      reserveInput(projectId, "2026-10-29T12:02:00.000Z", {
        selection: { ...selectedSmith, model: "new-model" },
      }),
    ),
  ).rejects.toThrow("already reserved or unresolved");
  await expect(
    store.reserveKeeperBrief(
      projectId,
      reserveInput(projectId, "2026-10-29T12:02:00.000Z", {
        origin: origin(projectId, "/other"),
        snapshot: {
          ...snapshot(projectId, "2026-10-29T12:02:00.000Z"),
          workspace: "/other",
        },
      }),
    ),
  ).rejects.toThrow("already reserved or unresolved");
  await expect(
    store.reserveKeeperBrief(
      projectId,
      reserveInput(projectId, "2026-10-29T12:02:00.000Z", {
        snapshot: snapshot(otherProject, "2026-10-29T12:02:00.000Z"),
      }),
    ),
  ).rejects.toThrow("trusted scope");
  expect(store.discoverKeeperBrief(projectId)).toEqual(first);

  await store.retireKeeperBrief(projectId, {
    requestId: first.requestId,
    intentHash: first.intentHash,
  });
  await store.accept(projectId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "A normal legacy turn changes the conversation revision.",
    about: [],
  });
  await expect(
    store.reserveKeeperBrief(
      projectId,
      reserveInput(projectId, "2026-10-29T12:03:00.000Z"),
    ),
  ).rejects.toThrow("conversation changed");
});

test("only the exact canonical ticket admits its frozen frame and replay never creates another turn", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const intent = await store.reserveKeeperBrief(
    projectId,
    reserveInput(projectId, "2026-10-29T12:00:00.000Z", {
      text: "The original generated prompt is frozen.",
    }),
  );
  const legacyRequest = {
    requestId: intent.requestId,
    expectedRevision: intent.expectedRevision,
    text: intent.text,
    about: intent.about,
    brief: intent.snapshot,
  };
  await expect(store.accept(projectId, legacyRequest)).rejects.toThrow(
    "canonical Keeper brief original",
  );
  await expect(
    store.accept(projectId, {
      ...legacyRequest,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow("must be admitted by its exact ticket");

  const ticket = {
    requestId: intent.requestId,
    expectedRevision: intent.expectedRevision,
    intentHash: intent.intentHash,
  };
  const admitted = await store.acceptKeeperBrief(projectId, ticket);
  expect(admitted.created).toBe(true);
  expect(admitted.receipt.revision).toBe(1);
  expect(admitted.receipt.turn.hash).toBe(intent.preparedTurnHash);
  const afterAdmission = store.read(projectId);
  expect(afterAdmission.keeperBriefIntents?.active?.state).toBe("admitted");
  expect(afterAdmission.frames[0]?.event).toEqual({
    kind: "user",
    text: intent.text,
    about: intent.about,
    brief: intent.snapshot,
  });
  await expect(store.accept(projectId, legacyRequest)).rejects.toThrow(
    "canonical Keeper brief original",
  );
  const replay = await store.acceptKeeperBrief(projectId, ticket);
  expect(replay.created).toBe(false);
  expect(replay.receipt.turn).toEqual(admitted.receipt.turn);
  expect(store.read(projectId).turns).toHaveLength(1);
  expect(store.read(projectId).frames).toHaveLength(1);

  const owner = randomUUID();
  await store.start(projectId, intent.requestId, owner);
  await store.recover(projectId);
  expect(store.read(projectId).turns[0]?.phase).toBe("unknown");
  expect((await store.acceptKeeperBrief(projectId, ticket)).created).toBe(
    false,
  );
  await expect(
    store.retireKeeperBrief(projectId, {
      requestId: intent.requestId,
      intentHash: intent.intentHash,
    }),
  ).rejects.toThrow("Only the exact unadmitted");
  await expect(
    store.reserveKeeperBrief(
      projectId,
      reserveInput(projectId, "2026-10-29T12:02:00.000Z", {
        expectedRevision: store.read(projectId).revision,
      }),
    ),
  ).rejects.toThrow("already reserved or unresolved");
});

test("reserved originals can be retired but admitted or unknown tickets cannot", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const intent = await store.reserveKeeperBrief(
    projectId,
    reserveInput(projectId, "2026-10-29T12:00:00.000Z"),
  );
  await expect(
    store.acceptKeeperBrief(
      projectId,
      {
        requestId: intent.requestId,
        expectedRevision: intent.expectedRevision,
        intentHash: intent.intentHash,
      },
      () => false,
    ),
  ).rejects.toThrow("no longer active");
  expect(store.read(projectId).revision).toBe(0);
  const retired = await store.retireKeeperBrief(projectId, {
    requestId: intent.requestId,
    intentHash: intent.intentHash,
  });
  expect(retired.state).toBe("retired");
  expect(store.read(projectId).revision).toBe(0);
  expect(store.discoverKeeperBrief(projectId)).toBeNull();
  expect(store.readKeeperBriefIntent(projectId, intent.requestId)).toEqual(
    retired,
  );
  await expect(
    store.acceptKeeperBrief(projectId, {
      requestId: intent.requestId,
      expectedRevision: intent.expectedRevision,
      intentHash: intent.intentHash,
    }),
  ).rejects.toThrow("explicitly retired");
  await expect(
    store.retireKeeperBrief(projectId, {
      requestId: intent.requestId,
      intentHash: intent.intentHash,
    }),
  ).rejects.toThrow("Only the exact unadmitted");
});

test("a terminal admitted original moves to bounded history before the next reservation", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const first = await store.reserveKeeperBrief(
    projectId,
    reserveInput(projectId, "2026-10-29T12:00:00.000Z"),
  );
  await store.acceptKeeperBrief(projectId, {
    requestId: first.requestId,
    expectedRevision: first.expectedRevision,
    intentHash: first.intentHash,
  });
  const owner = randomUUID();
  await store.start(projectId, first.requestId, owner);
  await store.finish(projectId, first.requestId, owner, "failed", "fixture");

  const second = await store.reserveKeeperBrief(
    projectId,
    reserveInput(projectId, "2026-10-29T12:01:00.000Z", {
      expectedRevision: store.read(projectId).revision,
    }),
  );
  expect(second.requestId).not.toBe(first.requestId);
  expect(store.discoverKeeperBrief(projectId)).toEqual(second);
  expect(store.readKeeperBriefIntent(projectId, first.requestId)).toEqual({
    ...first,
    state: "admitted",
  });
});

test("legacy version-one conversations without a brief-intent field remain readable", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  await store.accept(projectId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "A legacy conversation turn.",
    about: [],
  });
  const reopened = createConversationStore(home).read(projectId);
  expect(reopened.version).toBe(1);
  expect(reopened.turns).toHaveLength(1);
  expect(reopened).not.toHaveProperty("keeperBriefIntents");
});

test("private canonical originals are excluded from public and owned pages and tampering fails closed", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const intent = await store.reserveKeeperBrief(
    projectId,
    reserveInput(projectId, "2026-10-29T12:00:00.000Z"),
  );
  const state = store.read(projectId);
  const page = conversationPage(state, {}, false);
  expect(page).not.toHaveProperty("keeperBriefIntents");
  expect(conversationPageSchema.safeParse(page).success).toBe(true);
  expect(
    conversationPageSchema.safeParse({
      ...page,
      keeperBriefIntents: state.keeperBriefIntents,
    }).success,
  ).toBe(false);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(false);

  const file = join(home, "conversations", `keeper-${projectId}.json`);
  let saved: ConversationState;
  try {
    saved = stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new Error("The saved conversation did not match its strict schema.");
  }
  const active = saved.keeperBriefIntents?.active;
  if (!active) throw new Error("The canonical original was not persisted.");
  active.snapshot.scope.label = "tampered";
  writeOwnerOnly(file, JSON.stringify(saved));
  expect(() => store.read(projectId)).toThrow("saved conversation is invalid");
  expect(readFileSync(file, "utf8")).toContain(intent.intentHash);
  active.snapshot.scope.label = intent.snapshot.scope.label;
  active.selection.model = "tampered-model";
  writeOwnerOnly(file, JSON.stringify(saved));
  expect(() => store.discoverKeeperBrief(projectId)).toThrow(
    "saved conversation is invalid",
  );
});

test("private brief original bytes and linked conversation storage stay bounded and protected", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const longText = "é".repeat(16_000);
  let refused = false;
  for (let index = 0; index < 12; index++) {
    try {
      const intent = await store.reserveKeeperBrief(
        projectId,
        reserveInput(
          projectId,
          `2026-10-29T12:${String(index).padStart(2, "0")}:00.000Z`,
          { text: longText },
        ),
      );
      await store.retireKeeperBrief(projectId, {
        requestId: intent.requestId,
        intentHash: intent.intentHash,
      });
    } catch (error) {
      expect(error).toHaveProperty("status", 503);
      refused = true;
      break;
    }
  }
  expect(refused).toBe(true);

  const external = homeForTest();
  const linkedHome = homeForTest();
  const linkedProject = `project-${randomUUID()}`;
  await createConversationStore(external).reserveKeeperBrief(
    linkedProject,
    reserveInput(linkedProject, "2026-10-29T12:00:00.000Z"),
  );
  symlinkSync(
    join(external, "conversations"),
    join(linkedHome, "conversations"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() => createConversationStore(linkedHome).read(linkedProject)).toThrow(
    "linked",
  );
});

test("full private history refuses retirement without losing canonical UUID fences", async () => {
  const home = homeForTest();
  const projectId = `project-${randomUUID()}`;
  const store = createConversationStore(home);
  const saved: KeeperBriefIntent[] = [];
  for (let index = 0; index < MAX_KEEPER_BRIEF_INTENT_HISTORY; index++) {
    const intent = await store.reserveKeeperBrief(
      projectId,
      reserveInput(
        projectId,
        `2026-10-29T12:${String(index).padStart(2, "0")}:00.000Z`,
      ),
    );
    saved.push(
      await store.retireKeeperBrief(projectId, {
        requestId: intent.requestId,
        intentHash: intent.intentHash,
      }),
    );
  }
  const active = await store.reserveKeeperBrief(
    projectId,
    reserveInput(projectId, "2026-10-29T13:00:00.000Z"),
  );
  await expect(
    store.retireKeeperBrief(projectId, {
      requestId: active.requestId,
      intentHash: active.intentHash,
    }),
  ).rejects.toThrow("history is full");
  expect(store.discoverKeeperBrief(projectId)).toEqual(active);
  for (const original of saved)
    expect(store.readKeeperBriefIntent(projectId, original.requestId)).toEqual(
      original,
    );
  const firstSaved = saved[0];
  if (!firstSaved) throw new Error("The first canonical original was lost.");
  await expect(
    store.accept(projectId, {
      requestId: firstSaved.requestId,
      expectedRevision: 0,
      text: firstSaved.text,
      about: firstSaved.about,
      brief: firstSaved.snapshot,
    }),
  ).rejects.toThrow("canonical Keeper brief original");
});

function visibilityBriefGate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release: () => release() };
}

async function visibilityBriefService(
  mode?: KeeperVisibility,
  hooks: { readiness?: () => Promise<void>; run?: () => Promise<void> } = {},
) {
  const home = homeForTest(),
    root = homeForTest();
  mkdirSync(join(root, ".git"));
  const workspace = resolveCheckout(root).workspace,
    project = projectFixture(workspace);
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify({ version: 1, revision: 1, projects: [project] }),
  );
  const projects = createProjectStore(home),
    store = createConversationStore(home);
  if (mode) await projects.updateKeeperVisibility(project.id, 1, mode);
  const calls = { runs: 0 },
    finished = visibilityBriefGate();
  const transport: ConversationTransport = {
    provider: "claude",
    async run(_request, sink) {
      calls.runs++;
      await sink({
        kind: "identity",
        provider: "claude",
        sessionId: "visibility-brief-fixture",
        version: "fixture",
      });
      await hooks.run?.();
      return { phase: "completed", reason: null };
    },
  };
  const runtime: KeeperRuntime = {
    catalog: () => ({
      defaultSmith: selectedSmith.name,
      smiths: [selectedSmith],
    }),
    transport: () => transport,
    async readiness() {
      await hooks.readiness?.();
      return keeperReadiness({ adapter: true, checked: true });
    },
  };
  const service = createConversationService({
    home,
    root,
    transport,
    keeperRuntime: runtime,
    // Isolated stand-in producer: no metadata source is read by this admission test.
    prepareBrief: async (id) => ({
      ...snapshot(id, project.createdAt),
      projectName: project.name,
      workspace,
      catalogRevision: projects.read().revision,
      scope: {
        label: "project:alpha",
        epicIds: [],
        epicCount: 0,
        repositoryCount: 1,
      },
    }),
    onChange(update) {
      if (update.phase === "completed") finished.release();
    },
  });
  try {
    const saved = await service.reserveKeeperBrief(project.id, {
      expectedRevision: 0,
      origin: { kind: "overview" },
    });
    const ticket = {
      requestId: saved.requestId,
      expectedRevision: saved.expectedRevision,
      intentHash: saved.intentHash,
    };
    const original = store.readKeeperBriefIntent(project.id, ticket.requestId);
    if (!original) throw Error("Missing canonical stand-in original");
    return {
      home,
      id: project.id,
      projects,
      store,
      service,
      ticket,
      original,
      calls,
      finished,
    };
  } catch (error) {
    await service.close();
    throw error;
  }
}

test("Keeper visibility fences a matching-current-revision reserved original while allowing metadata controls", async () => {
  const modes: Array<KeeperVisibility | undefined> = [
    undefined,
    "project-metadata",
    "conversation-only",
  ];
  for (const mode of modes) {
    const f = await visibilityBriefService(mode);
    try {
      expect(f.original.origin.catalogRevision).toBe(
        f.projects.read().revision,
      );
      expect(f.original.snapshot.catalogRevision).toBe(
        f.projects.read().revision,
      );
      const result = await f.service
        .commitKeeperBrief(f.id, f.ticket)
        .catch((error: unknown) => error);
      if (mode === "conversation-only") {
        expect({
          status: result instanceof ConversationError ? result.status : null,
          runs: f.calls.runs,
          turns: f.store.read(f.id).turns.length,
        }).toEqual({ status: 409, runs: 0, turns: 0 });
        expect(
          createConversationStore(f.home).readKeeperBriefIntent(
            f.id,
            f.ticket.requestId,
          ),
        ).toEqual(f.original);
        expect(
          f.service.readKeeperBriefIntent(f.id, f.ticket.requestId),
        ).toEqual(f.original);
      } else {
        expect(result).toMatchObject({
          turn: { requestId: f.ticket.requestId },
        });
        expect(f.calls.runs).toBe(1);
      }
    } finally {
      await f.service.close();
    }
  }
});

test("Keeper visibility downgrade during reached readiness preserves the reviewed unadmitted original", async () => {
  const entered = visibilityBriefGate(),
    held = visibilityBriefGate();
  const f = await visibilityBriefService(undefined, {
    readiness: async () => {
      entered.release();
      await held.wait;
    },
  });
  const committing = f.service
    .commitKeeperBrief(f.id, f.ticket)
    .catch((error: unknown) => error);
  try {
    await entered.wait;
    await f.projects.updateKeeperVisibility(
      f.id,
      f.projects.read().revision,
      "conversation-only",
    );
    held.release();
    const failure = await committing;
    expect(failure).toBeInstanceOf(ConversationError);
    expect(failure).toMatchObject({ status: 409 });
    expect(f.calls.runs).toBe(0);
    expect(f.store.read(f.id).turns).toEqual([]);
    expect(f.service.readKeeperBriefIntent(f.id, f.ticket.requestId)).toEqual(
      f.original,
    );
  } finally {
    held.release();
    await committing;
    await f.service.close();
  }
});

test("Keeper visibility changes preserve already admitted work and exact replay without a second run", async () => {
  const entered = visibilityBriefGate(),
    held = visibilityBriefGate();
  const f = await visibilityBriefService(undefined, {
    run: async () => {
      entered.release();
      await held.wait;
    },
  });
  try {
    const admitted = await f.service.commitKeeperBrief(f.id, f.ticket);
    await entered.wait;
    await f.projects.updateKeeperVisibility(
      f.id,
      f.projects.read().revision,
      "conversation-only",
    );
    const replay = await f.service.commitKeeperBrief(f.id, f.ticket);
    expect(replay.turn.requestId).toBe(admitted.turn.requestId);
    expect(replay.turn.hash).toBe(f.original.preparedTurnHash);
    expect(f.store.read(f.id).turns).toHaveLength(1);
    expect(f.calls.runs).toBe(1);
    held.release();
    await f.finished.wait;
    const terminal = await f.service.commitKeeperBrief(f.id, f.ticket);
    expect(terminal.turn.phase).toBe("completed");
    expect(terminal.turn.hash).toBe(f.original.preparedTurnHash);
    expect(
      f.service.readKeeperBriefIntent(f.id, f.ticket.requestId)?.snapshot,
    ).toEqual(f.original.snapshot);
    expect(f.calls.runs).toBe(1);
  } finally {
    held.release();
    await f.service.close();
  }
});

async function scheduledBriefFixture(
  hooks: {
    prepare?: () => Promise<void>;
    checked?: () => void;
    run?: () => Promise<void>;
    unserved?: boolean;
  } = {},
) {
  const home = homeForTest(),
    root = homeForTest();
  mkdirSync(join(root, ".git"));
  const workspace = resolveCheckout(root).workspace;
  const project = projectFixture(hooks.unserved ? home : workspace);
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify({ version: 1, revision: 1, projects: [project] }),
  );
  let at = "2026-11-08T09:31:00.000Z",
    owns = true,
    sourceReturned = false;
  const projects = createProjectStore(
    home,
    () => new Date("2026-11-08T09:00:00.000Z"),
  );
  await projects.updateKeeperSchedule(project.id, 1, {
    kind: "daily",
    atUtc: "09:30",
  });
  const store = createConversationStore(home),
    calls = { loads: 0, attempts: 0, probes: 0, runs: 0 };
  const transport: ConversationTransport = {
    provider: "claude",
    async run(_request, sink) {
      calls.runs++;
      await sink({
        kind: "identity",
        provider: "claude",
        sessionId: "scheduled-brief-fixture",
        version: "fixture",
      });
      await hooks.run?.();
      return { phase: "completed", reason: null };
    },
  };
  const runtime: KeeperRuntime = {
    catalog: () => ({
      defaultSmith: selectedSmith.name,
      smiths: [selectedSmith],
    }),
    transport: () => transport,
    async readiness() {
      calls.probes++;
      return keeperReadiness({ adapter: true, checked: true });
    },
  };
  const options = {
    home,
    root,
    transport,
    keeperRuntime: runtime,
    async prepareBrief(id: string) {
      calls.loads++;
      const value = {
        ...snapshot(id, at),
        projectName: project.name,
        workspace,
        catalogRevision: projects.read().revision,
      };
      await hooks.prepare?.();
      sourceReturned = true;
      return value;
    },
  };
  const services: Array<ReturnType<typeof createConversationService>> = [];
  const create = () => {
    const service = createConversationService(options);
    services.push(service);
    return service;
  };
  const service = create();
  const controls = {
    isCurrent: () => {
      if (sourceReturned) hooks.checked?.();
      return owns;
    },
    beforeSource: () => {
      calls.attempts++;
      sourceReturned = false;
    },
  };
  return {
    home,
    project,
    projects,
    store,
    service,
    calls,
    controls,
    setAt: (value: string) => {
      at = value;
    },
    disown: () => {
      owns = false;
    },
    reopen: create,
    reserve: (target = service) =>
      target.reserveScheduledKeeperBrief(project.id, Date.parse(at), controls),
    close: async () => {
      for (const target of services) await target.close();
    },
  };
}

test("Keeper schedule reserves exact sources once across retirement, catalog changes and restart", async () => {
  const f = await scheduledBriefFixture();
  try {
    const [a, b] = await Promise.all([f.reserve(), f.reserve()]);
    if (!a || !b) throw Error("Missing scheduled source original");
    expect(a).toEqual(b);
    expect(f.calls).toEqual({ loads: 1, attempts: 1, probes: 0, runs: 0 });
    const original = f.store.readKeeperBriefIntent(f.project.id, a.requestId);
    if (!original || original.origin.kind !== "scheduled")
      throw Error("Missing scheduled origin");
    expect(original.origin).toMatchObject({
      kind: "scheduled",
      projectId: f.project.id,
      dueAt: "2026-11-08T09:30:00.000Z",
    });
    expect(original.snapshot.catalogRevision).toBe(
      original.origin.catalogRevision,
    );
    expect(f.store.read(f.project.id)).toMatchObject({
      revision: 0,
      turns: [],
      frames: [],
    });
    await f.projects.preferences(f.project.id, f.projects.read().revision, {
      pinned: true,
    });
    expect(await f.reserve()).toEqual(a);
    await f.service.close();
    expect(await f.reserve(f.reopen())).toEqual(a);
    const retired = await f.store.retireKeeperBrief(f.project.id, {
      requestId: a.requestId,
      intentHash: a.intentHash,
    });
    expect((await f.reserve(f.reopen()))?.requestId).toBe(a.requestId);
    expect(
      createConversationStore(f.home).readKeeperBriefIntent(
        f.project.id,
        a.requestId,
      ),
    ).toEqual(retired);
    expect(retired).toEqual({ ...original, state: "retired" });
    expect(f.calls).toEqual({ loads: 1, attempts: 1, probes: 0, runs: 0 });
  } finally {
    await f.close();
  }
});

test("Keeper schedule Store dedup uses trusted workspace identity without rewriting original bytes", async () => {
  const home = homeForTest(),
    id = "project-" + randomUUID();
  const store = createConversationStore(home);
  const origin: KeeperScheduledBriefOriginBinding = {
    kind: "scheduled",
    projectId: id,
    workspace: "C:/Work/Repo",
    catalogRevision: 4,
    scheduleGeneration: randomUUID(),
    dueAt: "2026-11-08T09:30:00.000Z",
  };
  const input = {
    ...reserveInput(id, origin.dueAt),
    origin,
    snapshot: { ...snapshot(id, origin.dueAt), workspace: origin.workspace },
  };
  const original = await store.reserveKeeperBrief(id, input);
  const alias = {
    ...origin,
    workspace: "c:\\WORK\\repo\\",
    catalogRevision: 5,
  };
  const retried = await store.reserveKeeperBrief(id, {
    ...input,
    origin: alias,
    snapshot: {
      ...input.snapshot,
      workspace: alias.workspace,
      catalogRevision: 5,
    },
  });
  expect(retried).toEqual(original);
  expect(store.findScheduledKeeperBrief(id, alias)).toEqual(original);
  expect(original.origin.workspace).toBe("C:/Work/Repo");
  expect(
    createConversationStore(home).readKeeperBriefIntent(id, original.requestId),
  ).toEqual(original);
});

test("Keeper schedule denies before source reads and keeps ordinary manual review behavior", async () => {
  for (const mode of [
    "off",
    "early",
    "visibility",
    "archive",
    "selection",
    "owner",
    "scope",
  ]) {
    const f = await scheduledBriefFixture({ unserved: mode === "scope" });
    try {
      if (mode === "off")
        await f.projects.updateKeeperSchedule(f.project.id, 2, { kind: "off" });
      if (mode === "early") f.setAt("2026-11-08T09:29:00.000Z");
      if (mode === "visibility")
        await f.projects.updateKeeperVisibility(
          f.project.id,
          2,
          "conversation-only",
        );
      if (mode === "archive")
        await f.projects.preferences(f.project.id, 2, { archived: true });
      if (mode === "selection")
        await f.projects.updateKeeper(
          f.project.id,
          2,
          { keeperSmith: "missing" },
          () => {},
        );
      if (mode === "owner") f.disown();
      const result: unknown = await f
        .reserve()
        .catch((error: unknown) => error);
      if (mode === "off" || mode === "early") expect(result).toBeNull();
      else
        expect(result).toMatchObject({ status: mode === "owner" ? 503 : 409 });
      expect(f.calls).toEqual({ loads: 0, attempts: 0, probes: 0, runs: 0 });
      expect(f.store.discoverKeeperBrief(f.project.id)).toBeNull();
    } finally {
      await f.close();
    }
  }
  const f = await scheduledBriefFixture();
  try {
    const manual = await f.service.reserveKeeperBrief(f.project.id, {
      expectedRevision: 0,
      origin: { kind: "overview" },
    });
    expect(manual.origin.kind).toBe("overview");
    await expect(f.reserve()).rejects.toMatchObject({ status: 409 });
    expect(f.calls).toEqual({ loads: 1, attempts: 0, probes: 0, runs: 0 });
  } finally {
    await f.close();
  }
});

test("Keeper schedule held sources reject current policy, conversation and owner drift", async () => {
  for (const mode of [
    "visibility",
    "schedule",
    "selection",
    "conversation",
    "owner",
    "close",
  ]) {
    const entered = visibilityBriefGate(),
      release = visibilityBriefGate();
    const f = await scheduledBriefFixture({
      prepare: async () => {
        entered.release();
        await release.wait;
      },
    });
    const pending = f.reserve().catch((error: unknown) => error);
    let closing: Promise<void> | undefined;
    try {
      await entered.wait;
      if (mode === "visibility")
        await f.projects.updateKeeperVisibility(
          f.project.id,
          2,
          "conversation-only",
        );
      if (mode === "schedule")
        await f.projects.updateKeeperSchedule(f.project.id, 2, {
          kind: "daily",
          atUtc: "10:00",
        });
      if (mode === "selection")
        await f.projects.updateKeeper(
          f.project.id,
          2,
          { keeperSmith: "missing" },
          () => {},
        );
      if (mode === "conversation")
        await f.store.accept(f.project.id, {
          requestId: randomUUID(),
          expectedRevision: 0,
          text: "Concurrent stored turn",
          about: [],
        });
      if (mode === "owner") f.disown();
      if (mode === "close") closing = f.service.close();
      release.release();
      const result: unknown = await pending;
      expect(result).toMatchObject({ status: mode === "close" ? 503 : 409 });
      expect(f.store.discoverKeeperBrief(f.project.id)).toBeNull();
      expect(f.calls).toEqual({ loads: 1, attempts: 1, probes: 0, runs: 0 });
    } finally {
      release.release();
      await pending;
      await closing;
      await f.close();
    }
  }
});

test("Keeper schedule final locked publication observes a real policy save queued first", async () => {
  const holding = visibilityBriefGate(),
    release = visibilityBriefGate(),
    postSource = visibilityBriefGate();
  const f = await scheduledBriefFixture({
    checked: () => postSource.release(),
  });
  const blocker = withProjectAdmission(f.home, f.project.id, async () => {
    holding.release();
    await release.wait;
  });
  let changing: Promise<unknown> | undefined,
    pending: Promise<unknown> | undefined;
  try {
    await holding.wait;
    changing = f.projects.updateKeeperVisibility(
      f.project.id,
      2,
      "conversation-only",
    );
    pending = f.reserve().catch((error: unknown) => error);
    await postSource.wait;
    release.release();
    await changing;
    expect(await pending).toMatchObject({ status: 409 });
    expect(f.store.discoverKeeperBrief(f.project.id)).toBeNull();
    expect(f.calls).toEqual({ loads: 1, attempts: 1, probes: 0, runs: 0 });
  } finally {
    release.release();
    await blocker;
    await changing;
    await pending;
    await f.close();
  }
});

test("Keeper schedule queued conversation publication cannot survive close", async () => {
  const holding = visibilityBriefGate(),
    release = visibilityBriefGate(),
    postSource = visibilityBriefGate();
  const f = await scheduledBriefFixture({
    checked: () => postSource.release(),
  });
  const blocker = withQueueLock(
    conversationWriteLockFile(f.home, f.project.id),
    async () => {
      holding.release();
      await release.wait;
    },
  );
  let pending: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    await holding.wait;
    pending = f.reserve().catch((error: unknown) => error);
    await postSource.wait;
    closing = f.service.close();
    release.release();
    expect(await pending).toMatchObject({ status: 409 });
    expect(f.store.discoverKeeperBrief(f.project.id)).toBeNull();
    expect(f.calls.runs).toBe(0);
  } finally {
    release.release();
    await blocker;
    await pending;
    await closing;
    await f.close();
  }
});

test("Keeper schedule manual Send is deliberate once and admitted replay survives off", async () => {
  const f = await scheduledBriefFixture();
  try {
    const original = await f.reserve();
    if (!original) throw Error("Missing exact scheduled source");
    expect(f.calls).toEqual({ loads: 1, attempts: 1, probes: 0, runs: 0 });
    const ticket = {
      requestId: original.requestId,
      expectedRevision: original.expectedRevision,
      intentHash: original.intentHash,
    };
    const admitted = await f.service.commitKeeperBrief(f.project.id, ticket);
    await f.service.settled(f.project.id);
    await f.projects.updateKeeperSchedule(f.project.id, 2, { kind: "off" });
    const replay = await f.service.commitKeeperBrief(f.project.id, ticket);
    expect(replay.turn.requestId).toBe(admitted.turn.requestId);
    expect(replay.turn.hash).toBe(original.preparedTurnHash);
    expect(f.store.read(f.project.id).turns).toHaveLength(1);
    expect(f.calls).toEqual({ loads: 1, attempts: 1, probes: 1, runs: 1 });
    expect(await f.reserve()).toBeNull();
  } finally {
    await f.close();
  }
});

test("Keeper schedule stale reserved generation stays readable without model admission", async () => {
  const f = await scheduledBriefFixture();
  try {
    const original = await f.reserve();
    if (!original) throw Error("Missing scheduled original");
    const ticket = {
      requestId: original.requestId,
      expectedRevision: original.expectedRevision,
      intentHash: original.intentHash,
    };
    await f.projects.updateKeeperSchedule(f.project.id, 2, { kind: "off" });
    await expect(
      f.service.commitKeeperBrief(f.project.id, ticket),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.store.readKeeperBriefIntent(f.project.id, ticket.requestId),
    ).toMatchObject(original);
    expect(f.calls.runs).toBe(0);
  } finally {
    await f.close();
  }
});

test("Keeper schedule full immutable history pauses before another source without losing originals", async () => {
  const f = await scheduledBriefFixture(),
    originals: KeeperBriefIntent[] = [];
  try {
    for (let index = 0; index <= MAX_KEEPER_BRIEF_INTENT_HISTORY; index++) {
      f.setAt(
        new Date(
          Date.parse("2026-11-08T09:31:00.000Z") + index * 86_400_000,
        ).toISOString(),
      );
      const saved = await f.reserve();
      if (!saved) throw Error("Missing bounded history original");
      const original = f.store.readKeeperBriefIntent(
        f.project.id,
        saved.requestId,
      );
      if (!original) throw Error("Missing retained source");
      originals.push(original);
      const ticket = {
        requestId: saved.requestId,
        expectedRevision: saved.expectedRevision,
        intentHash: saved.intentHash,
      };
      if (index < MAX_KEEPER_BRIEF_INTENT_HISTORY)
        await f.store.retireKeeperBrief(f.project.id, {
          requestId: ticket.requestId,
          intentHash: ticket.intentHash,
        });
      else {
        const owner = randomUUID();
        await f.store.acceptKeeperBrief(f.project.id, ticket);
        await f.store.start(f.project.id, saved.requestId, owner);
        await f.store.finish(
          f.project.id,
          saved.requestId,
          owner,
          "failed",
          "Fixture terminal original",
        );
      }
    }
    const before = f.store.read(f.project.id),
      calls = { ...f.calls };
    f.setAt("2026-12-20T09:31:00.000Z");
    await expect(f.reserve()).rejects.toMatchObject({ status: 409 });
    expect(f.store.read(f.project.id)).toEqual(before);
    expect(f.calls).toEqual(calls);
    for (const original of originals)
      expect(
        f.store.readKeeperBriefIntent(f.project.id, original.requestId)
          ?.intentHash,
      ).toBe(original.intentHash);
    expect(f.calls.runs).toBe(0);
  } finally {
    await f.close();
  }
});
