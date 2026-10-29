import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  KeeperBriefIntent,
  KeeperBriefOriginBinding,
  KeeperBriefSelection,
  KeeperBriefSnapshot,
} from "../../types/keeper-brief";
import type { ConversationState } from "../../types/conversation";
import { ownedCodingStateSchema } from "../sessions/codex-owned-journal";
import { writeOwnerOnly } from "../hearth/token";
import { conversationPage } from "./page";
import {
  conversationPageSchema,
  stateSchema,
} from "./protocol";
import { MAX_KEEPER_BRIEF_INTENT_HISTORY } from "../keeper/brief-protocol";
import { createConversationStore } from "./store";

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
    snapshot:
      updates.snapshot ?? snapshot(projectId, asOf),
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
  if (!recovered) throw new Error("The canonical reservation was not recovered.");
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
  expect((await store.acceptKeeperBrief(projectId, ticket)).created).toBe(false);
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
  if (!active)
    throw new Error("The canonical original was not persisted.");
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
  expect(() =>
    createConversationStore(linkedHome).read(linkedProject),
  ).toThrow("linked");
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
    expect(
      store.readKeeperBriefIntent(projectId, original.requestId),
    ).toEqual(original);
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
