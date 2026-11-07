import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { resolveCheckout } from "../ledger/workspace";
import { runOptions } from "../scheduler/shift-cli-runtime";
import {
  createProjectShiftRegistry,
  projectShiftFlags,
} from "../shifts/registry";
import { withProjectAdmission } from "./admission";
import { readProjectLifecycleInventory } from "./lifecycle-inventory";
import { createProjectStore } from "./store";

test("a stopped Shift must settle every owned attempt and malformed evidence remains unknown without PID probes", async () => {
  const base = mkdtempSync(join(tmpdir(), "forge-project-shift-inventory-")),
    home = join(base, "home"),
    root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  try {
    const store = createProjectStore(home),
      created = await store.create(
        {
          slug: "shift",
          name: "Shift",
          description: "",
          icon: "S",
          workspaces: [{ root, repositories: [root], epicIds: ["alpha-epic"] }],
        },
        0,
      ),
      project = created.projects[0]!;
    const request = {
        requestId: "70000000-0000-4000-8000-000000000001",
        expectedCatalogRevision: 1,
        options: {
          for: "2h",
          concurrency: 1,
          maxBeads: 1,
          maxUsd: 5,
          repairs: 1,
          base: "master",
        },
      },
      registry = createProjectShiftRegistry({ home, root });
    const { intent } = await registry.reserve(
      project.id,
      request,
      async () => ({ shiftId: "shift-20261106-170000-0001" }),
    );
    await store.preferences(project.id, 1, { archived: true });
    project.archived = true;
    expect(readProjectLifecycleInventory(home, root, project).state).toBe(
      "active",
    );
    const parsed = runOptions(projectShiftFlags(request));
    if (!parsed.ok || parsed.value.forMs === undefined)
      throw Error("Expected an explicit reviewed Shift deadline");
    const directory = join(home, "shifts"),
      file = join(directory, `${intent.shiftId}.json`);
    ensurePrivateHome(directory);
    const record = {
      shiftId: intent.shiftId,
      workspace: intent.workspace,
      pid: 1,
      state: "stopped",
      startedAt: intent.createdAt,
      deadline: new Date(
        Date.parse(intent.createdAt) + parsed.value.forMs,
      ).toISOString(),
      endedAt: new Date(Date.parse(intent.createdAt) + 1000).toISOString(),
      options: parsed.value,
      spentUsd: 0,
      unpriced: 0,
      beads: [{ outcome: "running", attempts: 1 }],
    };
    writeOwnerOnly(file, JSON.stringify(record));
    expect(readProjectLifecycleInventory(home, root, project).state).toBe(
      "active",
    );
    writeOwnerOnly(file, JSON.stringify({ ...record, beads: [] }));
    expect(readProjectLifecycleInventory(home, root, project)).toEqual({
      state: "eligible",
      reasons: [],
    });
    writeOwnerOnly(file, "{corrupt");
    expect(readProjectLifecycleInventory(home, root, project).state).toBe(
      "unknown",
    );
    expect(readFileSync(file, "utf8")).toBe("{corrupt");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deletion preserves immutable creation originals and exact created replays return Gone without recreating", async () => {
  const base = mkdtempSync(join(tmpdir(), "forge-project-deleted-original-")),
    home = join(base, "home"),
    root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  try {
    const canonicalRoot = resolveCheckout(root).workspace;
    const store = createProjectStore(home),
      original = {
        slug: "created",
        name: "Created",
        description: "",
        icon: "C",
        workspaces: [
          {
            root: canonicalRoot,
            repositories: [canonicalRoot],
            epicIds: ["alpha-epic"],
          },
        ],
      },
      scope = { hash: "a".repeat(64), count: 0 };
    const reservation = {
      requestId: "60000000-0000-4000-8000-000000000001",
      original,
      expectedCatalogRevision: 0,
      preflightScope: scope,
      validateScope: async () => scope,
    };
    const reserved = await store.reserveCreate(reservation),
      commit = {
        requestId: reservation.requestId,
        requestHash: reserved.operation.requestHash,
        reviewedScopeHash: scope.hash,
        preflightScope: scope,
        validateScope: async () => scope,
      };
    const created = await store.commitCreate(commit),
      id = created.catalog.projects[0]!.id;
    await store.preferences(id, 1, { archived: true });
    await store.deleteProject(
      id,
      {
        requestId: "60000000-0000-4000-8000-000000000002",
        expectedRevision: 2,
        confirmName: original.name,
      },
      async () => {},
    );
    expect(store.readCreate(reservation.requestId)).toEqual(created.operation);
    await expect(store.reserveCreate(reservation)).rejects.toMatchObject({
      status: 410,
    });
    await expect(store.commitCreate(commit)).rejects.toMatchObject({
      status: 410,
    });
    expect(store.read().projects).toEqual([]);
    expect(store.read().revision).toBe(3);
    expect(store.readCreate(reservation.requestId)).toEqual(created.operation);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("project deletion requires archive and inactive proof, retains external data, and recovers its exact receipt", async () => {
  const base = mkdtempSync(join(tmpdir(), "forge-project-lifecycle-")),
    home = join(base, "home"),
    root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(
    join(root, "keep.txt"),
    "Retain repositories and provider history",
  );
  try {
    const store = createProjectStore(home),
      input = {
        slug: "alpha",
        name: "Alpha",
        description: "",
        icon: "A",
        workspaces: [{ root, repositories: [root], epicIds: ["alpha-epic"] }],
      };
    const created = await store.create(input, 0),
      id = created.projects[0]!.id;
    const original = {
      requestId: "10000000-0000-4000-8000-000000000001",
      expectedRevision: 1,
      confirmName: "Alpha",
    };
    await expect(
      store.deleteProject(id, original, async () => {}),
    ).rejects.toMatchObject({ status: 409 });
    const archived = await store.preferences(id, 1, { archived: true }),
      reviewed = { ...original, expectedRevision: archived.revision };
    await expect(
      store.deleteProject(id, reviewed, async () => {
        throw Error("Work is active or unknown");
      }),
    ).rejects.toThrow("active or unknown");
    expect(store.read()).toEqual(archived);
    const deleted = await store.deleteProject(id, reviewed, async () => {});
    expect(deleted.receipt).toMatchObject({
      projectId: id,
      requestId: original.requestId,
      name: "Alpha",
      deletedRevision: 3,
    });
    expect(deleted.catalog.projects).toEqual([]);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe(
      "Retain repositories and provider history",
    );
    const restarted = createProjectStore(home);
    const replay = await restarted.deleteProject(id, reviewed, async () => {
      throw Error("A confirmed replay must not recheck work");
    });
    expect(replay).toEqual(deleted);
    expect(restarted.readDeletion(id, original.requestId)).toEqual(
      deleted.receipt,
    );
    await expect(
      restarted.deleteProject(
        id,
        { ...reviewed, confirmName: "Changed" },
        async () => {},
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(restarted.create(input, 3)).rejects.toThrow("slug");
    await expect(
      restarted.reserveCreate({
        requestId: "10000000-0000-4000-8000-000000000002",
        expectedCatalogRevision: 3,
        original: input,
        preflightScope: { hash: "a".repeat(64), count: 0 },
        validateScope: async () => ({ hash: "a".repeat(64), count: 0 }),
      }),
    ).rejects.toThrow("slug");
    const another = await restarted.create({ ...input, slug: "beta" }, 3);
    const updated = await restarted.updateGeneral(another.projects[0]!.id, 4, {
      name: "Beta",
      description: "",
      icon: "B",
    });
    expect(updated.deletedProjects).toEqual(deleted.catalog.deletedProjects);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("complete lifecycle reads distinguish safely empty, active, settled and unreadable ownership without changing journals", async () => {
  const base = mkdtempSync(join(tmpdir(), "forge-project-inventory-")),
    home = join(base, "home"),
    root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  try {
    const projects = createProjectStore(home),
      catalog = await projects.create(
        {
          slug: "alpha",
          name: "Alpha",
          description: "",
          icon: "A",
          workspaces: [{ root, repositories: [root], epicIds: ["alpha-epic"] }],
        },
        0,
      ),
      project = catalog.projects[0]!;
    await projects.preferences(project.id, 1, { archived: true });
    project.archived = true;
    expect(readProjectLifecycleInventory(home, root, project)).toEqual({
      state: "eligible",
      reasons: [],
    });
    const conversations = createConversationStore(home),
      requestId = "20000000-0000-4000-8000-000000000001",
      owner = "20000000-0000-4000-8000-000000000002";
    await conversations.accept(project.id, {
      requestId,
      expectedRevision: 0,
      text: "Keep my history",
      about: [],
    });
    expect(readProjectLifecycleInventory(home, root, project).state).toBe(
      "active",
    );
    await conversations.start(project.id, requestId, owner);
    await conversations.append(project.id, requestId, owner, {
      kind: "identity",
      provider: "claude",
      sessionId: "fixture-settled",
      version: "fixture-1",
    });
    await conversations.finish(project.id, requestId, owner, "completed", null);
    const file = conversationFile(home, project.id),
      before = readFileSync(file, "utf8");
    expect(readProjectLifecycleInventory(home, root, project)).toEqual({
      state: "eligible",
      reasons: [],
    });
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(file, "{invalid");
    expect(readProjectLifecycleInventory(home, root, project).state).toBe(
      "unknown",
    );
    const wrongScope = JSON.parse(before);
    wrongScope.projectId = "project-10000000-0000-4000-8000-000000000099";
    writeFileSync(file, JSON.stringify(wrongScope));
    expect(readProjectLifecycleInventory(home, root, project).state).toBe(
      "unknown",
    );
    writeFileSync(file, "{invalid");
    await expect(
      projects.deleteProject(
        project.id,
        {
          requestId: "20000000-0000-4000-8000-000000000003",
          expectedRevision: 2,
          confirmName: project.name,
        },
        async () => {
          const state = readProjectLifecycleInventory(home, root, project);
          if (state.state !== "eligible") throw Error("Unverified ownership");
        },
      ),
    ).rejects.toThrow("Unverified ownership");
    expect(readFileSync(file, "utf8")).toBe("{invalid");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("archive serializes with primary admission, and removed projects cannot publish new owners", async () => {
  const base = mkdtempSync(join(tmpdir(), "forge-project-admission-")),
    home = join(base, "home"),
    root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
  try {
    const projects = createProjectStore(home),
      catalog = await projects.create(
        {
          slug: "alpha",
          name: "Alpha",
          description: "",
          icon: "A",
          workspaces: [{ root, repositories: [root], epicIds: ["alpha-epic"] }],
        },
        0,
      ),
      project = catalog.projects[0]!;
    let release!: () => void,
      entered!: () => void,
      published = 0;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      entry = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const reservation = withProjectAdmission(home, project.id, async () => {
      entered();
      await gate;
      published++;
    });
    await entry;
    let archived = false;
    const archive = projects
      .preferences(project.id, 1, { archived: true })
      .then(() => {
        archived = true;
      });
    await Promise.resolve();
    expect(archived).toBe(false);
    release();
    await reservation;
    await archive;
    expect(published).toBe(1);
    await expect(
      withProjectAdmission(home, project.id, () => {
        published++;
      }),
    ).rejects.toMatchObject({ status: 409 });
    await projects.deleteProject(
      project.id,
      {
        requestId: "30000000-0000-4000-8000-000000000003",
        expectedRevision: 2,
        confirmName: project.name,
      },
      async () => {},
    );
    await expect(
      withProjectAdmission(home, project.id, () => {
        published++;
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(published).toBe(1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
