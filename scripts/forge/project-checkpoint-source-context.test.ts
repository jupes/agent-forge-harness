import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectCheckpointReviewBinding } from "../../types/project-checkpoint-reviews";
import { createProjectCheckpointReviewRoutes } from "../hearth/routes/project-checkpoint-reviews";
import { writeOwnerOnly } from "../hearth/token";
import { withProjectAdmission } from "../projects/admission";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import { createProjectCheckpointReviewStore } from "./project-checkpoint-review-store";
import { createProjectCheckpointSourceContext } from "./project-checkpoint-source-context";

const owned: string[] = [];
afterEach(() => {
  for (const base of owned.splice(0)) {
    if (
      dirname(resolve(base)) !== resolve(tmpdir()) ||
      !basename(base).startsWith("checkpoint-context-")
    )
      throw Error("Unexpected cleanup root");
    rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
});
const stamp = "2026-11-11T20:00:00.000Z";
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "checkpoint-context-"));
  owned.push(base);
  const workspacePath = join(base, "workspace");
  const home = join(base, "home");
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  const projects = createProjectStore(home);
  const catalog = await projects.create(
    {
      slug: "context",
      name: "Context",
      description: "",
      icon: "C",
      workspaces: [
        {
          root: workspacePath,
          repositories: [workspacePath],
          epicIds: ["forge-context"],
        },
      ],
    },
    0,
  );
  const scope = {
    projectId: catalog.projects[0]!.id,
    workspacePath,
    runSlug: "context",
    beadId: "forge-context.1",
  };
  let binding: ProjectCheckpointReviewBinding = {
    ...scope,
    checkout: workspacePath,
    epicId: "forge-context",
    runUpdatedAt: stamp,
    catalogRevision: 1,
    scopeHash: "a".repeat(64),
  };
  let version = {
    kind: "committed-git-snapshot" as const,
    commit: "b".repeat(40),
    tree: "c".repeat(40),
  };
  let captures = 0;
  const resolveBase = async () => {
    const project = projects
      .read()
      .projects.find((item) => item.id === scope.projectId);
    if (!project || project.archived)
      throw Error("No current project authority");
    return structuredClone(binding);
  };
  const sourceOptions = {
    checkout: workspacePath,
    workspace: workspacePath,
    resolveCurrentAuthority: resolveBase,
    resolveAuthority: resolveBase,
    capture: {
      capture: async () => {
        captures++;
        return structuredClone(version);
      },
      close: async () => {},
    },
  };
  const context = createProjectCheckpointSourceContext(sourceOptions);
  const store = createProjectCheckpointReviewStore({
    home,
    withQueueLock,
    admit: (id, work) => withProjectAdmission(home, id, work),
    submission: { resolveSnapshot: context.snapshot },
  });
  const request = () => ({
    projectId: scope.projectId,
    runSlug: scope.runSlug,
    beadId: scope.beadId,
    expectedEpicId: binding.epicId,
    expectedRunUpdatedAt: binding.runUpdatedAt,
  });
  return {
    base,
    home,
    workspacePath,
    sourceOptions,
    scope,
    context,
    store,
    projects,
    request,
    captures: () => captures,
    binding: () => binding,
    version: () => version,
    changeBinding: () => {
      binding = { ...binding, scopeHash: "d".repeat(64) };
    },
    changeSource: () => {
      version = { ...version, commit: "e".repeat(40) };
    },
  };
}

test("only an explicit exact source publication supplies current Review authority", async () => {
  const f = await fixture();
  try {
    await expect(
      f.context.reviewAuthority(f.store, f.request()),
    ).rejects.toThrow();
    const checked = await f.context.snapshot(f.scope);
    expect(checked).toEqual({
      binding: f.binding(),
      sourceVersion: f.version(),
    });
    const original = {
      schemaVersion: 1 as const,
      kind: "publish" as const,
      requestId: randomUUID(),
      ...checked,
      expectedSubmissionGeneration: 0,
    };
    const applied = await f.store.publishSubmission(original, 1);
    const authority = await f.context.reviewAuthority(f.store, f.request());
    expect(authority.scopeHash).toBe(applied.record.receipt.reviewScopeHash!);
    expect(authority.scopeHash).not.toBe(checked.binding.scopeHash);
    f.changeSource();
    await expect(
      f.context.reviewAuthority(f.store, f.request()),
    ).rejects.toThrow();
    expect((await f.context.read(f.store, f.scope)).available).toBe(true);
  } finally {
    await f.context.close();
  }
});

function routeFixture(f: Awaited<ReturnType<typeof fixture>>) {
  return createProjectCheckpointReviewRoutes({
    home: f.home,
    workspace: f.workspacePath,
    appendEvent: () => ({ ok: true, id: 1, ulid: "inert-context" }),
    queueLock: withQueueLock,
    runBd: async () => ({ status: 1, stdout: "", stderr: "inert" }),
    resolveAuthority: f.sourceOptions.resolveAuthority,
    readScope: () => {
      if (
        !f.projects
          .read()
          .projects.some((item) => item.id === f.scope.projectId)
      )
        throw Error("Removed project");
      return f.scope;
    },
    source: f.sourceOptions,
  });
}
test("protected source rows use the existing owner and require an audited action", async () => {
  const f = await fixture();
  const routes = routeFixture(f);
  try {
    const path =
      "/projects/:id/runs/:slug/checkpoints/:beadId/source-submissions";
    const row = routes.actions.find((item) => item.path === path);
    expect(row).toBeDefined();
    if (!row) throw Error("Missing source publication action");
    const original = {
      schemaVersion: 1,
      kind: "publish",
      requestId: randomUUID(),
      ...(await f.context.snapshot(f.scope)),
      expectedSubmissionGeneration: 0,
    };
    const checked = row.validate({
      params: {
        id: f.scope.projectId,
        slug: f.scope.runSlug,
        beadId: f.scope.beadId,
      },
      query: new URLSearchParams(),
      headers: {},
      body: original,
    });
    if (!checked.ok) throw Error("Publication did not validate");
    expect(row.rejectDuplicateBodyKeys).toBe(true);
    expect((await row.effect(checked.value)).status).toBe(503);
    expect(f.store.submissionInventory(f.scope).items).toHaveLength(0);
    expect((await row.effect(checked.value, { auditEventId: 1 })).status).toBe(
      200,
    );
    expect(f.store.submissionInventory(f.scope).items).toHaveLength(1);
  } finally {
    await routes.close();
    await f.context.close();
  }
});

function sourceOriginal(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    schemaVersion: 1 as const,
    kind: "publish" as const,
    requestId: randomUUID(),
    binding: f.binding(),
    sourceVersion: f.version(),
    expectedSubmissionGeneration: 0,
  };
}
function inputFor(
  f: Awaited<ReturnType<typeof fixture>>,
  body: unknown,
  requestId?: string,
) {
  return {
    params: {
      id: f.scope.projectId,
      slug: f.scope.runSlug,
      beadId: f.scope.beadId,
      ...(requestId ? { requestId } : {}),
    },
    query: new URLSearchParams(),
    headers: {},
    body,
  };
}
async function effect(
  f: Awaited<ReturnType<typeof fixture>>,
  routes: ReturnType<typeof routeFixture>,
  suffix: string,
  body: unknown,
  auditEventId = 1,
) {
  const row = routes.actions.find((item) => item.path.endsWith(suffix));
  if (!row) throw Error("Missing action " + suffix);
  const checked = row.validate(inputFor(f, body));
  if (!checked.ok) throw Error("Invalid fixture action " + suffix);
  return row.effect(checked.value, { auditEventId });
}
test("retained source recovery and exact Withdraw survive archive and project removal", async () => {
  const f = await fixture(),
    routes = routeFixture(f);
  try {
    const original = sourceOriginal(f);
    expect(
      (await effect(f, routes, "/source-submissions", original)).status,
    ).toBe(200);
    const saved = f.store.submissionOriginal(f.scope, original.requestId)!;
    const archived = await f.projects.preferences(f.scope.projectId, 1, {
      archived: true,
    });
    await f.projects.deleteProject(
      f.scope.projectId,
      {
        requestId: randomUUID(),
        expectedRevision: archived.revision,
        confirmName: "Context",
      },
      async () => {},
    );
    const before = f.captures();
    const row = routes.reads.find((item) =>
      item.path.endsWith("/source-submissions/:requestId"),
    )!;
    const checked = row.validate(inputFor(f, null, original.requestId));
    if (!checked.ok) throw Error("Invalid exact read");
    expect((await row.read(checked.value)).status).toBe(200);
    const withdraw = {
      schemaVersion: 1,
      kind: "withdraw",
      requestId: randomUUID(),
      scope: f.scope,
      targetSubmissionRequestId: original.requestId,
      targetOriginalHash: saved.originalHash,
      expectedSubmissionGeneration: 1,
    };
    expect(
      (await effect(f, routes, "/source-submissions/withdraw", withdraw))
        .status,
    ).toBe(200);
    expect(
      (await effect(f, routes, "/source-submissions/withdraw", withdraw, 2))
        .status,
    ).toBe(200);
    expect(f.store.submissionInventory(f.scope).generation).toBe(2);
    expect(f.store.submissionInventory(f.scope).currentRequestId).toBeNull();
    expect(f.captures()).toBe(before);
    const absent = row.validate(inputFor(f, null, randomUUID()));
    if (!absent.ok) throw Error("Invalid absent read");
    expect((await row.read(absent.value)).status).toBe(404);
  } finally {
    await routes.close();
    await f.context.close();
  }
});
test("a positive legacy v1 journal resolves Review before any Git capture", async () => {
  const f = await fixture();
  try {
    const directory = join(f.home, "checkpoint-reviews");
    mkdirSync(directory, { recursive: true });
    const key = createHash("sha256")
      .update(JSON.stringify([workspaceKey(f.workspacePath), f.scope.beadId]))
      .digest("hex");
    writeOwnerOnly(
      join(directory, key + ".json"),
      JSON.stringify({ version: 1, activeRequestId: null, records: [] }),
    );
    f.sourceOptions.capture.capture = async () => {
      throw Error("Git must not run for verified legacy authority");
    };
    expect(await f.context.reviewAuthority(f.store, f.request())).toEqual(
      f.binding(),
    );
    expect(f.captures()).toBe(0);
  } finally {
    await f.context.close();
  }
});
test("source capture rechecks BASE and captures immutable scope before awaiting", async () => {
  const f = await fixture();
  try {
    f.sourceOptions.capture.capture = async () => {
      f.changeBinding();
      return f.version();
    };
    await expect(f.context.snapshot(f.scope)).rejects.toThrow(
      "checkpoint changed",
    );
    f.sourceOptions.capture.capture = async () => f.version();
    const scope = { ...f.scope };
    const pending = f.context.snapshot(scope);
    scope.beadId = "forge-context.2";
    expect((await pending).binding.beadId).toBe(f.scope.beadId);
    expect(() =>
      f.context.snapshot({ ...f.scope, workspacePath: join(f.base, "other") }),
    ).toThrow();
  } finally {
    await f.context.close();
  }
});
test("checked context reports unavailable without inventing source facts", async () => {
  const f = await fixture(),
    routes = routeFixture(f);
  try {
    f.sourceOptions.capture.capture = async () => {
      throw Error("private-path-and-diagnostics");
    };
    const row = routes.reads.find((item) =>
      item.path.endsWith("/source-context"),
    )!;
    const checked = row.validate(inputFor(f, null));
    if (!checked.ok) throw Error("Invalid checked context read");
    const result = await row.read(checked.value);
    expect(result.status).toBe(200);
    expect(result).toEqual({
      status: 200,
      data: {
        available: false,
        error:
          "The checkpoint source context is unavailable. Read saved source records before trying again.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-path");
  } finally {
    await routes.close();
    await f.context.close();
  }
});
test("source action validation rejects another route, workspace, kind, UUID and query", async () => {
  const f = await fixture(),
    routes = routeFixture(f);
  try {
    const row = routes.actions.find((item) =>
      item.path.endsWith("/source-submissions"),
    )!;
    const original = sourceOriginal(f);
    for (const body of [
      { ...original, requestId: "invalid" },
      { ...original, kind: "withdraw" },
      { ...original, unexpected: true },
      {
        ...original,
        binding: { ...original.binding, beadId: "forge-context.2" },
      },
      {
        ...original,
        binding: { ...original.binding, workspacePath: join(f.base, "other") },
      },
    ])
      expect(row.validate(inputFor(f, body)).ok).toBe(false);
    const queried = inputFor(f, original);
    queried.query.set("root", f.workspacePath);
    expect(row.validate(queried).ok).toBe(false);
    expect(f.captures()).toBe(0);
  } finally {
    await routes.close();
    await f.context.close();
  }
});
test("closing aborts capture, joins pending context, and refuses queued/new source work", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aborted = false;
  f.sourceOptions.capture.capture = async () => {
    entered();
    await held;
    return f.version();
  };
  f.sourceOptions.capture.close = async () => {
    aborted = true;
    release();
  };
  const pending = f.context.snapshot(f.scope);
  const observed = pending.then(
    () => "resolved",
    () => "rejected",
  );
  await began;
  await f.context.close();
  expect(await observed).toBe("rejected");
  expect(aborted).toBe(true);
  await expect(f.context.snapshot(f.scope)).rejects.toThrow();
  const routes = routeFixture(f);
  await routes.close();
  expect(
    (await effect(f, routes, "/source-submissions", sourceOriginal(f))).status,
  ).toBe(503);
  expect(f.store.submissionInventory(f.scope).items).toHaveLength(0);
});

test("new Review prepare requires the submitted fence and active Review blocks source changes", async () => {
  const f = await fixture(),
    routes = routeFixture(f);
  try {
    const original = sourceOriginal(f);
    await effect(f, routes, "/source-submissions", original);
    const saved = f.store.submissionOriginal(f.scope, original.requestId)!;
    const prepare = {
      requestId: randomUUID(),
      expectedEpicId: f.binding().epicId,
      expectedRunUpdatedAt: stamp,
      decision: "approve",
      note: "",
      expectedSubmissionScopeHash: f.binding().scopeHash,
    };
    expect((await effect(f, routes, "/reviews", prepare, 2)).status).toBe(409);
    expect(f.store.inventory(f.scope)).toHaveLength(0);
    expect(
      (
        await effect(
          f,
          routes,
          "/reviews",
          {
            ...prepare,
            expectedSubmissionScopeHash: saved.receipt.reviewScopeHash,
          },
          3,
        )
      ).status,
    ).toBe(200);
    expect(f.store.inventory(f.scope)).toHaveLength(1);
    const withdraw = {
      schemaVersion: 1,
      kind: "withdraw",
      requestId: randomUUID(),
      scope: f.scope,
      targetSubmissionRequestId: original.requestId,
      targetOriginalHash: saved.originalHash,
      expectedSubmissionGeneration: 1,
    };
    expect(
      (await effect(f, routes, "/source-submissions/withdraw", withdraw, 4))
        .status,
    ).toBe(409);
    expect(f.store.submissionInventory(f.scope).generation).toBe(1);
  } finally {
    await routes.close();
    await f.context.close();
  }
});
test("validated source originals are captured independently of later body mutation", async () => {
  const f = await fixture(),
    routes = routeFixture(f);
  try {
    const original = structuredClone(sourceOriginal(f));
    const expected = structuredClone(original);
    const row = routes.actions.find((item) =>
      item.path.endsWith("/source-submissions"),
    )!;
    const checked = row.validate(inputFor(f, original));
    if (!checked.ok) throw Error("Invalid original");
    original.sourceVersion.commit = "e".repeat(40);
    original.binding.scopeHash = "f".repeat(64);
    expect((await row.effect(checked.value, { auditEventId: 1 })).status).toBe(
      200,
    );
    expect(
      f.store.submissionOriginal(f.scope, original.requestId)!.original,
    ).toEqual(expected);
    expect((await row.effect(checked.value, { auditEventId: 2 })).status).toBe(
      200,
    );
    expect(f.store.submissionInventory(f.scope).generation).toBe(1);
  } finally {
    await routes.close();
    await f.context.close();
  }
});
