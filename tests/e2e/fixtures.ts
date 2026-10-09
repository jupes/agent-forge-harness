import type { Page } from "@playwright/test";
import type {
  ForgeRunSnapshot,
  ForgeRunView,
  GateRun,
} from "../../scripts/dashboard/forge-run-model";
import type {
  RepoEntry,
  ReposKnowledge,
} from "../../scripts/dashboard/repos-knowledge-model";
import type { BeadsIssue, BeadsPayload, IssueStatus } from "../../types/beads";

/**
 * Fixture state for the Forge run and Repos & knowledge views.
 *
 * Both pages read machine-local files, so what they render varies by machine.
 * Route interception serves this instead wherever every panel must be
 * populated: the behavior specs, and the committed screenshots — which, in a
 * public repository, must not capture a real home directory or the list of
 * repositories someone has cloned.
 *
 * Every fixture is held to the type the real endpoint returns (`satisfies`).
 * When a model changes shape, `bun run typecheck` fails here — instead of the
 * page throwing on a stale stub and each test timing out on its first locator.
 */

const ts = "2026-09-11T00:00:00.000Z";

/** The checkout the fixture dashboard serves; gate runs are scoped to it. */
export const CHECKOUT = "/home/dev/agent-forge-harness/trees/a1b2c3";

const issue = (
  fields: Omit<BeadsIssue, "createdAt" | "updatedAt">,
): BeadsIssue => ({
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
} satisfies BeadsPayload;

const GATE: GateRun = {
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
};

/** One gated run, mid-implement. Runs are concurrent; the API returns a list. */
const RUN: ForgeRunView = {
  slug: "design-system",
  feature: "Adopt a shared design system",
  epic: "demo-epic",
  mode: "gated",
  complete: false,
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
  reviews: [],
  gate: GATE,
  gateScope: { checkout: CHECKOUT, slug: "design-system" },
};

export const FORGE = {
  ok: true,
  error: null,
  data: {
    runs: [RUN],
    selected: RUN.slug,
    checkout: CHECKOUT,
    gate: GATE,
  } satisfies ForgeRunSnapshot,
};

const repo = (
  name: string,
  defaultBranch: string,
  cloned: boolean,
  knowledgeAgeDays: number | null,
  freshness: RepoEntry["freshness"],
): RepoEntry => ({
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
    localStateFrom: null,
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
  } satisfies ReposKnowledge,
};

/**
 * Serve a Beads snapshot in place of `docs/data/beads.json`, which is
 * generated, gitignored data: a fresh checkout — CI included — has none.
 */
export async function stubSnapshot(
  page: Page,
  beads: BeadsPayload = BEADS,
): Promise<void> {
  await page.route("**/data/beads.json", (route) =>
    route.fulfill({ json: beads }),
  );
}

export interface ForgeRunStub {
  /** Replace checkpoint statuses, keyed by issue id. */
  statuses?: Record<string, IssueStatus>;
  /** Replace the gate run; null means no run belongs to this checkout. */
  gate?: GateRun | null;
  /** Serve a checkout with no forge run at all, as a fresh clone has. */
  empty?: boolean;
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
  const gate = stub.gate === undefined ? GATE : stub.gate;
  const data: ForgeRunSnapshot = stub.empty
    ? { runs: [], selected: null, checkout: CHECKOUT, gate }
    : { ...FORGE.data, runs: [{ ...RUN, gate }], gate };
  const forge = { ...FORGE, data };

  const posts: unknown[] = [];
  await stubSnapshot(page, {
    ...BEADS,
    issues: BEADS.issues.map((entry) => {
      const status = statuses[entry.id];
      return status ? { ...entry, status } : entry;
    }),
  });
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
  overrides: Partial<ReposKnowledge> = {},
): Promise<void> {
  await page.route("**/__agent-forge/dev-api/repos-knowledge", (route) =>
    route.fulfill({ json: { ...REPOS, data: { ...REPOS.data, ...overrides } } }),
  );
}
