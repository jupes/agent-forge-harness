import type { Page } from "@playwright/test";

/**
 * Fixture state for the Forge run and Repos & knowledge views.
 *
 * Both pages read machine-local files, so what they render varies by machine.
 * Route interception serves this instead wherever every panel must be
 * populated: the behavior specs, and the committed screenshots — which, in a
 * public repository, must not capture a real home directory or the list of
 * repositories someone has cloned.
 */

const ts = "2026-09-11T00:00:00.000Z";

/** The checkout the fixture dashboard serves; gate runs are scoped to it. */
const CHECKOUT = "/home/dev/agent-forge-harness/trees/a1b2c3";

const issue = (fields: Record<string, unknown>): Record<string, unknown> => ({
  createdAt: ts,
  updatedAt: ts,
  ...fields,
});

/**
 * One epic, two features, four checkpoints, one of them in progress. The ids
 * sort opposite to the dependency order, so ordering by id would be caught.
 */
export const BEADS = {
  version: "1.0.0",
  generatedAt: ts,
  comments: [],
  derived: {
    byStatus: { open: [], in_progress: [], closed: [], blocked: [] },
    byType: { epic: [], feature: [], task: [], bug: [], chore: [] },
    byRepo: {},
    ready: [],
    blocked: [],
    deps: [],
  },
  issues: [
    issue({
      id: "demo-epic",
      type: "epic",
      title: "Adopt a shared design system",
      status: "in_progress",
    }),
    issue({
      id: "demo-foundations",
      type: "feature",
      title: "Foundations",
      status: "in_progress",
      parent: "demo-epic",
    }),
    issue({
      id: "demo-pages",
      type: "feature",
      title: "Pages",
      status: "open",
      parent: "demo-epic",
    }),
    issue({
      id: "demo-migrate",
      type: "task",
      title: "Migrate the issue views",
      status: "open",
      parent: "demo-pages",
    }),
    issue({
      id: "demo-shell",
      type: "task",
      title: "Wire the application shell",
      status: "open",
      parent: "demo-pages",
    }),
    issue({
      id: "demo-primitives",
      type: "task",
      title: "Build the primitives",
      status: "in_progress",
      parent: "demo-foundations",
    }),
    issue({
      id: "demo-tokens",
      type: "task",
      title: "Write the design tokens",
      status: "closed",
      parent: "demo-foundations",
    }),
  ],
  deps: [
    { from: "demo-primitives", to: "demo-tokens", type: "blocks" },
    { from: "demo-shell", to: "demo-primitives", type: "blocks" },
    { from: "demo-migrate", to: "demo-shell", type: "blocks" },
  ],
};

export const FORGE = {
  ok: true,
  error: null,
  data: {
    slug: "design-system",
    feature: "Adopt a shared design system",
    epic: "demo-epic",
    updatedAt: ts,
    phases: [
      {
        id: "research",
        state: "complete",
        artifact: "plans/research/design-system.md",
        artifactMissing: false,
      },
      {
        id: "plan",
        state: "complete",
        artifact: "plans/drafts/design-system.md",
        artifactMissing: false,
      },
      {
        id: "implement",
        state: "active",
        artifact: null,
        artifactMissing: false,
      },
      {
        id: "ship",
        state: "locked",
        artifact: "reports/design-system-ship.md",
        artifactMissing: false,
      },
    ],
    gate: {
      event: "TaskCompleted",
      timestamp: ts,
      passed: false,
      checkout: CHECKOUT,
      branch: "feat/design-system",
      taskId: "demo-primitives",
      forgeSlug: "design-system",
      checks: [
        { name: "typecheck", passed: true, skipped: false, detail: null },
        {
          name: "lint",
          passed: false,
          skipped: false,
          detail: "Found 2 errors.",
        },
        {
          name: "tests",
          passed: true,
          skipped: true,
          detail: "no test files",
        },
        { name: "clean-tree", passed: true, skipped: false, detail: null },
        { name: "ac-verify", passed: true, skipped: false, detail: null },
      ],
    },
    gateScope: { checkout: CHECKOUT, slug: "design-system" },
  },
};

const repo = (
  name: string,
  defaultBranch: string,
  cloned: boolean,
  knowledgeAgeDays: number | null,
  freshness: string,
) => ({
  name,
  path: `repos/${name}`,
  url: `https://github.com/example/${name}.git`,
  defaultBranch,
  cloned,
  knowledgeFile:
    knowledgeAgeDays === null ? null : `knowledge/repos/${name}.yaml`,
  knowledgeAgeDays,
  freshness,
});

export const REPOS = {
  ok: true,
  error: null,
  data: {
    localStateFrom: null as string | null,
    repos: [
      repo("billing-api", "main", true, 3, "current"),
      repo("legacy-worker", "trunk", true, 45, "stale"),
      repo("mobile-app", "develop", true, 22, "aging"),
      repo("web-client", "master", false, null, "missing"),
    ],
    worktrees: [
      {
        id: "a1b2c3",
        branch: "feat/design-system",
        path: CHECKOUT,
        createdAt: "2026-09-09T22:00:00.000Z",
        pathExists: true,
      },
      {
        id: "d4e5f6",
        branch: "fix/stale-login-redirect",
        path: "/home/dev/agent-forge-harness/trees/d4e5f6",
        createdAt: "2026-08-01T00:00:00.000Z",
        pathExists: false,
      },
    ],
    conventions: {
      source: "knowledge/_shared.yaml",
      error: null,
      entries: [
        {
          key: "commit_format.pattern",
          value: "<type>(<scope>): <short description>",
        },
        { key: "commit_format.footer", value: "Refs: <TASK-ID>" },
        {
          key: "branch_naming.pattern",
          value: "<type>/<task-id>-<short-description>",
        },
        {
          key: "testing_standards.framework",
          value: "Bun test runner (bun test)",
        },
      ],
    },
  },
};

export interface ForgeRunStub {
  /** Replace checkpoint statuses, keyed by issue id. */
  statuses?: Record<string, string>;
  /** Replace the gate run; null means no run belongs to this checkout. */
  gate?: typeof FORGE.data.gate | null;
}

/**
 * Serve the Forge run fixtures. Returns the bodies of review POSTs, which are
 * always intercepted — a test never writes a real Beads comment.
 */
export async function stubForgeRun(
  page: Page,
  stub: ForgeRunStub = {},
): Promise<unknown[]> {
  const statuses = stub.statuses ?? {};
  const beads = {
    ...BEADS,
    issues: BEADS.issues.map((entry) => {
      const status = statuses[String(entry["id"])];
      return status ? { ...entry, status } : entry;
    }),
  };
  const forge = {
    ...FORGE,
    data: {
      ...FORGE.data,
      gate: stub.gate === undefined ? FORGE.data.gate : stub.gate,
    },
  };

  const posts: unknown[] = [];
  await page.route("**/data/beads.json", (route) =>
    route.fulfill({ json: beads }),
  );
  await page.route("**/__agent-forge/dev-api/forge-run", (route) =>
    route.fulfill({ json: forge }),
  );
  await page.route(
    "**/__agent-forge/dev-api/forge-run/review",
    async (route) => {
      posts.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, data: null, error: null } });
    },
  );
  return posts;
}

export async function stubRepos(
  page: Page,
  overrides: Partial<typeof REPOS.data> = {},
): Promise<void> {
  await page.route("**/__agent-forge/dev-api/repos-knowledge", (route) =>
    route.fulfill({ json: { ...REPOS, data: { ...REPOS.data, ...overrides } } }),
  );
}
