import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  const base = scratch.make("knowledge-service-"),
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
