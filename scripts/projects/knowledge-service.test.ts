import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ConversationError } from "../conversations/error";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import type { GitRun } from "../scheduler/worktrees";
import { scratchDirs } from "../test-scratch";
import { publishKnowledgeCandidate } from "./knowledge-publication";
import { createKnowledgeService } from "./knowledge-service";
import { resolveKnowledgeTarget } from "./knowledge-source";
import {
  createKnowledgeStore,
  readKnowledgeInventory,
} from "./knowledge-store";
import { readProjectLifecycleInventory } from "./lifecycle-inventory";
import { projectCatalogPath } from "./store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "./testing";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const smith = {
  name: "fixture",
  provider: "claude" as const,
  model: "model",
  effort: "high",
  enabled: true,
  tags: [],
};
const generated = {
  overview: {
    name: "alpha",
    description: "Observed bounded README",
    purpose: "tooling",
    tech_stack: {
      runtime: "bun",
      framework: "unknown",
      language: "typescript",
      key_libraries: [],
    },
  },
  architecture: {
    structure: "README.md",
    entry_points: [],
    key_components: [],
  },
  patterns: {
    error_handling: "unknown",
    state_management: "unknown",
    module_organization: "unknown",
    authentication: "unknown",
    testing: "unknown",
  },
  conventions: {
    commit_format: "unknown",
    branch_naming: "unknown",
    pr_requirements: [],
    coding_standards: [],
  },
  integration_points: { apis: [], shared_types: [], events: [] },
  key_files: [],
  recent_changes: [],
};
function fixture() {
  const base = realpathSync.native(scratch.make("knowledge-service-")),
    root = join(base, "alpha"),
    home = join(base, "home");
  mkdirSync(join(root, ".git"), { recursive: true });
  ensurePrivateHome(home);
  writeFileSync(join(root, "README.md"), "# Alpha\nObserved source.");
  writeOwnerOnly(
    projectCatalogPath(home),
    JSON.stringify(projectCatalogFixture(root)),
  );
  let commit = "a".repeat(40),
    calls = 0,
    afterGenerate = () => {};
  const git: GitRun = (args) => ({
    status: 0,
    stderr: "",
    stdout: args.includes("--git-common-dir")
      ? join(root, ".git")
      : args.includes("--show-toplevel")
        ? root
        : args.includes("HEAD")
          ? commit
          : args[0] === "ls-files"
            ? "README.md\0"
            : `${commit}\t2026-11-06T00:00:00+00:00\tInitial\n`,
  });
  const options = {
    root,
    home,
    git,
    smithName: () => "fixture",
    generator: {
      revalidate: () => {},
      prepare: async () => ({
        smith,
        version: "3.0.0",
        profileHash: "b".repeat(64),
      }),
      generate: async () => {
        calls++;
        afterGenerate();
        return generated;
      },
    },
  };
  const target = resolveKnowledgeTarget(root, git),
    service = createKnowledgeService(options),
    request = {
      requestId: "10000000-0000-4000-8000-000000000001",
      expectedRevision: 1,
      repositoryKey: target.repositoryKey,
    };
  return {
    root,
    home,
    options,
    target,
    service,
    request,
    calls: () => calls,
    editDuringGeneration(work: () => void) {
      afterGenerate = work;
    },
    advance() {
      commit = "c".repeat(40);
    },
  };
}

test("knowledge refresh publishes a full document once, retains exact replay after recreation and reads canonical age", async () => {
  const f = fixture();
  const receipt = await f.service.refresh(FIXTURE_PROJECT_ID, f.request);
  expect(receipt.state).toBe("confirmed");
  expect(f.calls()).toBe(1);
  const text = readFileSync(f.target.file, "utf8");
  expect(text).toContain("Bounded evidence");
  expect(text).toContain("integration_points:");
  const reopened = createKnowledgeService(f.options);
  expect(await reopened.refresh(FIXTURE_PROJECT_ID, f.request)).toEqual(
    receipt,
  );
  expect(reopened.receipt(FIXTURE_PROJECT_ID, f.request.requestId)).toEqual(
    receipt,
  );
  expect(f.calls()).toBe(1);
  expect(reopened.status(FIXTURE_PROJECT_ID).freshness).toBe("current");
  await expect(
    reopened.refresh(FIXTURE_PROJECT_ID, { ...f.request, expectedRevision: 2 }),
  ).rejects.toMatchObject({ status: 409 });
});

test("a changed source or editor holds the saved candidate without erasure, and retiring a never-published candidate allows a fresh reviewed operation", async () => {
  const f = fixture();
  f.editDuringGeneration(() =>
    writeFileSync(join(f.root, "README.md"), "changed source"),
  );
  expect((await f.service.refresh(FIXTURE_PROJECT_ID, f.request)).state).toBe(
    "candidate-saved",
  );
  expect(existsSync(f.target.file)).toBe(false);
  expect(f.calls()).toBe(1);
  await f.service.publish(FIXTURE_PROJECT_ID, f.request.requestId);
  expect(existsSync(f.target.file)).toBe(false);
  expect(f.calls()).toBe(1);
  await f.service.retire(FIXTURE_PROJECT_ID, f.request.requestId);
  f.editDuringGeneration(() => {});
  const next = {
    ...f.request,
    requestId: "10000000-0000-4000-8000-000000000002",
  };
  expect((await f.service.refresh(FIXTURE_PROJECT_ID, next)).state).toBe(
    "confirmed",
  );
  expect(f.calls()).toBe(2);
});

test("lost publication confirmation recovers exact requested bytes after HEAD changes without repeating the model or rename", async () => {
  const f = fixture();
  let writes = 0;
  const service = createKnowledgeService({
    ...f.options,
    publish: (...args: Parameters<typeof publishKnowledgeCandidate>) => {
      writes++;
      publishKnowledgeCandidate(...args);
      throw Error("lost confirmation");
    },
  });
  expect((await service.refresh(FIXTURE_PROJECT_ID, f.request)).state).toBe(
    "unknown",
  );
  expect(f.calls()).toBe(1);
  expect(writes).toBe(1);
  await expect(
    service.retire(FIXTURE_PROJECT_ID, f.request.requestId),
  ).rejects.toMatchObject({ status: 409 });
  f.advance();
  const reopened = createKnowledgeService(f.options);
  expect(
    (await reopened.publish(FIXTURE_PROJECT_ID, f.request.requestId)).state,
  ).toBe("confirmed");
  expect(f.calls()).toBe(1);
  expect(writes).toBe(1);
});

test("daily protection, archived projects and unscoped repositories refuse before generation", async () => {
  for (const patch of [
    { budgets: { shiftSpendCapUsd: null, dailyApiKeyCapUsd: 2 } },
    { archived: true },
    { workspaces: [] },
  ]) {
    const f = fixture(),
      catalog = projectCatalogFixture(f.root);
    Object.assign(catalog.projects[0] ?? {}, patch);
    writeOwnerOnly(projectCatalogPath(f.home), JSON.stringify(catalog));
    await expect(
      f.service.refresh(FIXTURE_PROJECT_ID, f.request),
    ).rejects.toThrow();
    expect(f.calls()).toBe(0);
    expect(existsSync(f.target.file)).toBe(false);
  }
});

test("an external output edit during generation is retained without publishing or repeating the model", async () => {
  const f = fixture();
  f.editDuringGeneration(() => {
    mkdirSync(join(f.root, "knowledge", "repos"), { recursive: true });
    writeFileSync(f.target.file, "editor: retained\n");
  });
  expect((await f.service.refresh(FIXTURE_PROJECT_ID, f.request)).state).toBe(
    "candidate-saved",
  );
  expect(readFileSync(f.target.file, "utf8")).toBe("editor: retained\n");
  await f.service.publish(FIXTURE_PROJECT_ID, f.request.requestId);
  expect(readFileSync(f.target.file, "utf8")).toBe("editor: retained\n");
  expect(f.calls()).toBe(1);
});

test("a held generation is one durable original, blocks duplicate fresh work and deletion, then settles without invented process evidence", async () => {
  const f = fixture();
  let enter = () => {},
    release = () => {},
    generatedCount = 0;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  const service = createKnowledgeService({
    ...f.options,
    generator: {
      ...f.options.generator,
      generate: async () => {
        generatedCount++;
        enter();
        await held;
        return generated;
      },
    },
  });
  const running = service.refresh(FIXTURE_PROJECT_ID, f.request);
  try {
    await entered;
    expect((await service.refresh(FIXTURE_PROJECT_ID, f.request)).state).toBe(
      "attempted",
    );
    await expect(
      service.refresh(FIXTURE_PROJECT_ID, {
        ...f.request,
        requestId: "10000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const project = projectCatalogFixture(f.root).projects[0];
    if (!project) throw Error("Fixture project absent");
    expect(
      readProjectLifecycleInventory(f.home, f.root, {
        ...project,
        archived: true,
      }).reasons.join(" "),
    ).toContain("knowledge");
    expect(generatedCount).toBe(1);
  } finally {
    release();
  }
  expect((await running).state).toBe("confirmed");
  const row = createKnowledgeStore(f.home).read(
    FIXTURE_PROJECT_ID,
    f.request.requestId,
  );
  expect(row?.attemptedAt).toBeString();
  expect(row?.candidateSavedAt).toBeString();
  expect(row?.publicationAttemptedAt).toBeString();
  expect(JSON.stringify(row)).not.toContain("ownedTreeReleased");
});

test("malformed ownership never becomes an empty inventory or fresh generation authority", async () => {
  const f = fixture(),
    file = join(f.home, "knowledge-refresh", "operations.json");
  writeOwnerOnly(
    file,
    '{"version":1,"records":[{"receipt":{"state":"confirmed"}}]}',
  );
  const before = readFileSync(file, "utf8");
  expect(() => readKnowledgeInventory(f.home)).toThrow();
  await expect(
    f.service.refresh(FIXTURE_PROJECT_ID, f.request),
  ).rejects.toThrow();
  expect(f.calls()).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(before);
  const project = projectCatalogFixture(f.root).projects[0];
  if (!project) throw Error("Fixture project absent");
  expect(
    readProjectLifecycleInventory(f.home, f.root, {
      ...project,
      archived: true,
    }).state,
  ).toBe("unknown");
});

test("a generator profile change while publication waits for the repository lock refuses its saved candidate", async () => {
  const f = fixture();
  let unlock = () => {},
    locked = () => {},
    prepared = () => {},
    valid = true,
    preparations = 0;
  const held = new Promise<void>((resolve) => {
      unlock = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      locked = resolve;
    }),
    checked = new Promise<void>((resolve) => {
      prepared = resolve;
    });
  const lock = withQueueLock(
    join(f.root, ".git", "agent-forge-knowledge.lock.db"),
    async () => {
      locked();
      await held;
    },
  );
  await entered;
  const service = createKnowledgeService({
    ...f.options,
    generator: {
      ...f.options.generator,
      prepare: async () => {
        preparations++;
        const ready = await f.options.generator.prepare();
        if (preparations === 2) prepared();
        return ready;
      },
      revalidate: () => {
        if (!valid) throw Error("profile changed");
      },
    },
  });
  const running = service.refresh(FIXTURE_PROJECT_ID, f.request);
  try {
    await checked;
    valid = false;
  } finally {
    unlock();
  }
  await lock;
  expect((await running).state).toBe("candidate-saved");
  expect(existsSync(f.target.file)).toBe(false);
  expect(f.calls()).toBe(1);
  expect(
    createKnowledgeStore(f.home).read(FIXTURE_PROJECT_ID, f.request.requestId)
      ?.publicationAttemptedAt,
  ).toBeNull();
});

test("a longest supported legacy extension key persists its bounded full metadata path with the confirmed candidate", async () => {
  const f = fixture(),
    key = "x".repeat(256);
  mkdirSync(join(f.root, "knowledge", "repos"), { recursive: true });
  writeFileSync(f.target.file, `overview:\n  ${key}: retained\n`);
  const receipt = await f.service.refresh(FIXTURE_PROJECT_ID, f.request);
  expect(receipt.state).toBe("confirmed");
  expect(receipt.retainedExtensions).toContain("overview." + key);
  expect(readFileSync(f.target.file, "utf8")).toContain("retained");
  expect(f.calls()).toBe(1);
});

test("a profile change after parent anchors are saved can retire the never-attempted publication while retaining its anchors", async () => {
  const f = fixture();
  let checks = 0;
  const service = createKnowledgeService({
    ...f.options,
    generator: {
      ...f.options.generator,
      revalidate: () => {
        if (++checks === 2) throw Error("profile changed after anchors");
      },
    },
  });
  expect((await service.refresh(FIXTURE_PROJECT_ID, f.request)).state).toBe(
    "candidate-saved",
  );
  const before = createKnowledgeStore(f.home).read(
    FIXTURE_PROJECT_ID,
    f.request.requestId,
  );
  expect(before?.publication).not.toBeNull();
  expect(before?.publicationAttemptedAt).toBeNull();
  expect(existsSync(f.target.file)).toBe(false);
  expect(
    (await service.retire(FIXTURE_PROJECT_ID, f.request.requestId)).state,
  ).toBe("failed");
  const after = createKnowledgeStore(f.home).read(
    FIXTURE_PROJECT_ID,
    f.request.requestId,
  );
  expect(after?.publication).toEqual(before?.publication);
  expect(after?.publicationAttemptedAt).toBeNull();
  expect(f.calls()).toBe(1);
});

test("an unavailable pre-reservation CLI profile is a known refusal without a saved generation owner", async () => {
  const f = fixture(),
    service = createKnowledgeService({
      ...f.options,
      generator: {
        ...f.options.generator,
        prepare: async () => {
          throw Error("unsupported CLI profile");
        },
      },
    });
  await expect(
    service.refresh(FIXTURE_PROJECT_ID, f.request),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    createKnowledgeStore(f.home).read(FIXTURE_PROJECT_ID, f.request.requestId),
  ).toBeUndefined();
  expect(f.calls()).toBe(0);
  expect(existsSync(f.target.file)).toBe(false);
});

test.each([
  2, 5,
])("a journal capacity refusal after durable reservation returns its saved receipt instead of nondelivery: write %s", async (failAt) => {
  const f = fixture(),
    actual = createKnowledgeStore(f.home);
  let writes = 0;
  const store: ReturnType<typeof createKnowledgeStore> = {
    ...actual,
    locked: (work) =>
      actual.locked((state, save) =>
        work(state, () => {
          if (++writes >= failAt)
            throw new ConversationError(
              409,
              "journal candidate capacity exhausted",
            );
          save();
        }),
      ),
  };
  const service = createKnowledgeService({ ...f.options, store });
  const receipt = await service.refresh(FIXTURE_PROJECT_ID, f.request);
  expect(receipt.state).toBe(failAt === 2 ? "reserved" : "candidate-saved");
  expect(actual.read(FIXTURE_PROJECT_ID, f.request.requestId)?.receipt).toEqual(
    receipt,
  );
  expect(f.calls()).toBe(failAt === 2 ? 0 : 1);
  expect(existsSync(f.target.file)).toBe(false);
  expect(await service.refresh(FIXTURE_PROJECT_ID, f.request)).toEqual(receipt);
  expect(f.calls()).toBe(failAt === 2 ? 0 : 1);
});

test("verified generation with an oversized document is a known failed refresh and never changes output or automatically repeats the model", async () => {
  const f = fixture();
  let oversized = true;
  const service = createKnowledgeService({
    ...f.options,
    generator: {
      ...f.options.generator,
      generate: async () => ({
        ...(await f.options.generator.generate()),
        overview: {
          ...generated.overview,
          description: oversized
            ? "line\n".repeat(500)
            : generated.overview.description,
        },
      }),
    },
  });
  const receipt = await service.refresh(FIXTURE_PROJECT_ID, f.request);
  expect(receipt.state).toBe("failed");
  expect(existsSync(f.target.file)).toBe(false);
  expect(f.calls()).toBe(1);
  const row = createKnowledgeStore(f.home).read(
    FIXTURE_PROJECT_ID,
    f.request.requestId,
  );
  expect(row?.generationVerifiedAt).toBeString();
  expect(row?.candidate).toBeNull();
  expect(row?.publicationAttemptedAt).toBeNull();
  expect(await service.refresh(FIXTURE_PROJECT_ID, f.request)).toEqual(receipt);
  expect(f.calls()).toBe(1);
  oversized = false;
  expect(
    (
      await service.refresh(FIXTURE_PROJECT_ID, {
        ...f.request,
        requestId: "10000000-0000-4000-8000-000000000002",
      })
    ).state,
  ).toBe("confirmed");
  expect(f.calls()).toBe(2);
});

test("completed generation without a saved candidate can be explicitly retired after recreation without rerunning its original", async () => {
  const f = fixture(),
    completed = createKnowledgeService({
      ...f.options,
      generator: {
        ...f.options.generator,
        generate: async () => ({
          ...(await f.options.generator.generate()),
          overview: {
            ...generated.overview,
            description: "line\n".repeat(500),
          },
        }),
      },
    });
  expect((await completed.refresh(FIXTURE_PROJECT_ID, f.request)).state).toBe(
    "failed",
  );
  // Retain the valid v1 crash-point shape after verified completion but before a candidate save.
  const store = createKnowledgeStore(f.home);
  await store.locked(async (state, save) => {
    const row = store.find(state, FIXTURE_PROJECT_ID, f.request.requestId);
    if (!row || row.generationVerifiedAt === null || row.candidate !== null)
      throw Error("Expected verified generation without candidate fixture");
    row.receipt.state = "attempted";
    row.receipt.message =
      "Generation completed before the candidate was saved.";
    save();
  });
  const file = join(f.home, "knowledge-refresh", "operations.json"),
    before = readFileSync(file, "utf8"),
    restored = createKnowledgeService(f.options);
  expect(await restored.refresh(FIXTURE_PROJECT_ID, f.request)).toMatchObject({
    requestId: f.request.requestId,
    state: "generation-completed",
    candidateHash: null,
  });
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(f.calls()).toBe(1);
  expect(existsSync(f.target.file)).toBe(false);
  const retired = await restored.retire(
    FIXTURE_PROJECT_ID,
    f.request.requestId,
  );
  expect(retired.state).toBe("failed");
  expect(await restored.refresh(FIXTURE_PROJECT_ID, f.request)).toEqual(
    retired,
  );
  expect(f.calls()).toBe(1);
  expect(existsSync(f.target.file)).toBe(false);
  expect(
    (
      await restored.refresh(FIXTURE_PROJECT_ID, {
        ...f.request,
        requestId: "10000000-0000-4000-8000-000000000002",
      })
    ).state,
  ).toBe("confirmed");
  expect(f.calls()).toBe(2);
});

test("candidate persistence cannot resurrect a completed generation retired while its caller was paused", async () => {
  const f = fixture(),
    actual = createKnowledgeStore(f.home);
  let enter = () => {},
    release = () => {},
    paused = false;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
  const store: ReturnType<typeof createKnowledgeStore> = {
    ...actual,
    locked: async (work) => {
      let completed = false;
      const result = await actual.locked((state, save) =>
        work(state, () => {
          save();
          completed = state.records.some(
            (row) =>
              row.original.request.requestId === f.request.requestId &&
              row.receipt.state === "generation-completed",
          );
        }),
      );
      if (completed && !paused) {
        paused = true;
        enter();
        await held;
      }
      return result;
    },
  };
  const running = createKnowledgeService({ ...f.options, store }).refresh(
      FIXTURE_PROJECT_ID,
      f.request,
    ),
    recovery = createKnowledgeService(f.options);
  try {
    await Promise.race([
      entered,
      running.then(() => {
        throw Error("Generation never reached its durable completed phase");
      }),
    ]);
    expect(
      recovery.receipt(FIXTURE_PROJECT_ID, f.request.requestId).state,
    ).toBe("generation-completed");
    expect(
      (await recovery.retire(FIXTURE_PROJECT_ID, f.request.requestId)).state,
    ).toBe("failed");
  } finally {
    release();
  }
  expect((await running).state).toBe("failed");
  const row = actual.read(FIXTURE_PROJECT_ID, f.request.requestId);
  expect(row?.candidate).toBeNull();
  expect(row?.publicationAttemptedAt).toBeNull();
  expect(existsSync(f.target.file)).toBe(false);
  expect(f.calls()).toBe(1);
});

test("private phase evidence rejects invented completion or publication while retaining held and failed legacy rows", async () => {
  const f = fixture();
  f.editDuringGeneration(() =>
    writeFileSync(join(f.root, "README.md"), "changed source"),
  );
  await f.service.refresh(FIXTURE_PROJECT_ID, f.request);
  const row = createKnowledgeStore(f.home).read(
    FIXTURE_PROJECT_ID,
    f.request.requestId,
  );
  if (!row?.candidate) throw Error("Expected saved candidate fixture");
  const empty = {
      ...row,
      candidate: null,
      candidateSavedAt: null,
      publication: null,
      publicationAttemptedAt: null,
      receipt: {
        ...row.receipt,
        state: "generation-completed",
        candidateHash: null,
      },
    },
    file = join(f.home, "knowledge-refresh", "operations.json");
  for (const valid of [
    empty,
    { ...empty, receipt: { ...empty.receipt, state: "attempted" } },
    { ...empty, receipt: { ...empty.receipt, state: "failed" } },
    { ...row, receipt: { ...row.receipt, state: "failed" } },
    { ...row, receipt: { ...row.receipt, state: "unknown" } },
  ]) {
    writeOwnerOnly(file, JSON.stringify({ version: 1, records: [valid] }));
    expect(readKnowledgeInventory(f.home)).toHaveLength(1);
  }
  for (const state of ["unknown", "attempted"]) {
    writeOwnerOnly(
      file,
      JSON.stringify({
        version: 1,
        records: [
          {
            ...empty,
            generationVerifiedAt: null,
            receipt: { ...empty.receipt, state },
          },
        ],
      }),
    );
    await expect(
      f.service.retire(FIXTURE_PROJECT_ID, f.request.requestId),
    ).rejects.toMatchObject({ status: 409 });
  }
  for (const invalid of [
    { ...empty, generationVerifiedAt: null },
    {
      ...row,
      publication: null,
      publicationAttemptedAt: new Date().toISOString(),
      receipt: { ...row.receipt, state: "unknown" },
    },
  ]) {
    const bytes = JSON.stringify({ version: 1, records: [invalid] });
    writeOwnerOnly(file, bytes);
    expect(() => readKnowledgeInventory(f.home)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(bytes);
  }
});
