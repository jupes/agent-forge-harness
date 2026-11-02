import { expect, test } from "bun:test";
import type { ProjectsHome } from "../../../types/project-summary";
import type { ProjectRecord } from "../../../types/projects";
import {
  ProjectRepositoriesOwner,
  projectRepositoriesForSelection,
  validatedProjectRepositories,
} from "./project-repositories-client";

const project: ProjectRecord = {
  id: "project-alpha",
  slug: "alpha",
  name: "Alpha",
  description: "Fixture project",
  icon: "A",
  workspaces: [{ root: "C:/fixture", repositories: [], epicIds: [] }],
  pinned: false,
  archived: false,
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

const beta: ProjectRecord = {
  ...project,
  id: "project-beta",
  slug: "beta",
  name: "Beta",
};

const home = (
  revision: number,
  projects: ProjectRecord[] = [project],
): ProjectsHome => ({
  catalog: { version: 1, revision, projects },
  summaries: [],
  asOf: "2026-10-31T00:00:00.000Z",
});

const repositories = (projectId: string, catalogRevision: number) => ({
  projectId,
  catalogRevision,
  repositories: [
    {
      workspaceRoot: "C:/fixture",
      repositories: [
        {
          path: "C:/fixture",
          access: "served" as const,
          name: "fixture",
          worktrees: [
            {
              path: "C:/fixture/trees/example",
              kind: "trees" as const,
              branch: "fixture-branch",
              missing: false,
            },
          ],
        },
        { path: "C:/external", access: "unregistered" as const },
      ],
    },
  ],
});

test("strictly rejects malformed, private-extra, and wrong-project responses", () => {
  const valid = repositories("project-alpha", 4);
  expect(validatedProjectRepositories(valid, "project-alpha")).toEqual(valid);
  expect(() =>
    validatedProjectRepositories(
      { ...valid, privateRegistryPath: "C:/private" },
      "project-alpha",
    ),
  ).toThrow("malformed");
  expect(() =>
    validatedProjectRepositories(
      repositories("project-beta", 4),
      "project-alpha",
    ),
  ).toThrow("another project");
  const privateNested = {
    ...valid,
    repositories: valid.repositories.map((row) => ({
      ...row,
      repositories: row.repositories.map((member) =>
        member.access === "unregistered"
          ? { ...member, worktrees: [] }
          : member,
      ),
    })),
  };
  expect(() =>
    validatedProjectRepositories(privateNested, "project-alpha"),
  ).toThrow("malformed");
});

test("the current-project projection masks old data and errors synchronously", () => {
  const old = {
    key: '["project-alpha",4]',
    projectId: "project-alpha",
    requestedRevision: 4,
    phase: "ready" as const,
    data: repositories("project-alpha", 4),
    error: "Old project failure",
    responseRevision: 4,
  };
  const current = projectRepositoriesForSelection(old, "project-beta", 5);
  expect(current.phase).toBe("loading");
  expect(current.data).toBeNull();
  expect(current.error).toBeNull();
  expect(current.responseRevision).toBeNull();
  expect(current.projectId).toBe("project-beta");
});

test("late fulfillment from a previous project cannot replace the current read", async () => {
  const pending = new Map<string, (value: unknown) => void>();
  const owner = new ProjectRepositoriesOwner({
    read: (projectId) =>
      new Promise((resolve) => pending.set(projectId, resolve)),
  });
  owner.activate("project-alpha", 4);
  owner.activate("project-beta", 4);
  pending.get("project-beta")?.(repositories("project-beta", 4));
  await Promise.resolve();
  expect(owner.snapshot().phase).toBe("ready");
  pending.get("project-alpha")?.(repositories("project-alpha", 4));
  await Promise.resolve();
  expect(owner.snapshot().projectId).toBe("project-beta");
  expect(owner.snapshot().data?.projectId).toBe("project-beta");
});

test("a catalog mismatch reconciles explicitly before reading the refreshed key", async () => {
  let reads = 0;
  const owner = new ProjectRepositoriesOwner({
    read: async (projectId) => {
      reads++;
      return repositories(projectId, 5);
    },
  });
  owner.activate("project-alpha", 4);
  await Promise.resolve();
  expect(owner.snapshot().phase).toBe("catalog-mismatch");
  expect(reads).toBe(1);

  let refreshes = 0;
  await owner.reconcile(
    async () => {
      refreshes++;
      return home(5);
    },
    () => true,
  );
  expect(refreshes).toBe(1);
  expect(reads).toBe(1);
  expect(owner.snapshot().phase).toBe("catalog-mismatch");

  owner.activate("project-alpha", 5);
  await Promise.resolve();
  expect(owner.snapshot().phase).toBe("ready");
  expect(reads).toBe(2);
});

test("read failure waits for one explicit refresh", async () => {
  let reads = 0;
  const owner = new ProjectRepositoriesOwner({
    read: async (projectId) => {
      reads++;
      if (reads === 1) throw Error("Fixture unavailable");
      return repositories(projectId, 4);
    },
  });
  owner.activate("project-alpha", 4);
  await Promise.resolve();
  expect(owner.snapshot().phase).toBe("error");
  expect(reads).toBe(1);

  await owner.refresh("project-alpha", 4, () => true);
  expect(owner.snapshot().phase).toBe("ready");
  expect(reads).toBe(2);
});

test("late same-project revision reads cannot replace the latest revision", async () => {
  const pending: Array<(value: unknown) => void> = [];
  const owner = new ProjectRepositoriesOwner({
    read: () => new Promise((resolve) => pending.push(resolve)),
  });
  owner.activate("project-alpha", 4);
  owner.activate("project-alpha", 6);
  pending[1]?.(repositories("project-alpha", 6));
  await Promise.resolve();
  pending[0]?.(repositories("project-alpha", 4));
  await Promise.resolve();
  expect(owner.snapshot().requestedRevision).toBe(6);
  expect(owner.snapshot().data?.catalogRevision).toBe(6);
});

test("a pending reconciliation gates a switched and reactivated selection", async () => {
  let selected = {
    projectId: "project-alpha" as string | null,
    revision: 4 as number | null,
  };
  const reads: string[] = [];
  const owner = new ProjectRepositoriesOwner({
    read: (id) => {
      reads.push(id);
      return Promise.resolve(repositories(id, 5));
    },
  });
  const selection = () => selected;
  owner.activate("project-alpha", 4, selection);
  await Promise.resolve();
  let settle!: (value: ProjectsHome) => void;
  const refresh = owner.reconcile(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
    () => true,
  );
  selected = { projectId: null, revision: null };
  owner.activate(null, null, selection);
  selected = { projectId: "project-beta", revision: 5 };
  owner.activate("project-beta", 5, selection);
  expect(reads).toEqual(["project-alpha"]);
  settle(home(5, [project, beta]));
  await refresh;
  await Promise.resolve();
  expect(reads).toEqual(["project-alpha", "project-beta"]);
  expect(owner.snapshot().data?.projectId).toBe("project-beta");
});

test("catalog facts require one current project and cannot lower the response floor", async () => {
  let reads = 0;
  const owner = new ProjectRepositoriesOwner({
    read: async (id) => {
      reads++;
      return repositories(id, 6);
    },
  });
  owner.activate("project-alpha", 4);
  await Promise.resolve();
  await owner.reconcile(
    async () => home(5, [project, beta]),
    () => true,
  );
  owner.activate("project-beta", 5);
  expect(owner.snapshot().phase).toBe("catalog-mismatch");
  await owner.reconcile(
    async () => home(6, [beta, beta]),
    () => true,
  );
  expect(owner.snapshot().phase).toBe("catalog-mismatch");
  const invalidHome = {
    catalog: { version: 1, revision: -1, projects: [beta] },
  } as unknown as ProjectsHome;
  await owner.reconcile(
    async () => invalidHome,
    () => true,
  );
  expect(owner.snapshot().phase).toBe("catalog-mismatch");
  expect(reads).toBe(1);
  await owner.reconcile(
    async () => home(6, [project, beta]),
    () => true,
  );
  owner.activate("project-beta", 6);
  await Promise.resolve();
  owner.activate("project-alpha", 5);
  expect(owner.snapshot().phase).toBe("catalog-mismatch");
  expect(reads).toBe(2);
});

test("deactivation fences late repository reads without publishing after unmount", async () => {
  let active = true;
  let notifications = 0;
  let settle!: (value: unknown) => void;
  const owner = new ProjectRepositoriesOwner({
    read: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  });
  const selection = () =>
    active
      ? { projectId: "project-alpha", revision: 4 }
      : { projectId: null, revision: null };
  owner.subscribe(() => notifications++);
  owner.activate("project-alpha", 4, selection);
  const beforeUnmount = notifications;
  active = false;
  owner.deactivate();
  settle(repositories("project-alpha", 4));
  await Promise.resolve();
  expect(notifications).toBe(beforeUnmount);
  expect(owner.snapshot().data).toBeNull();
});
