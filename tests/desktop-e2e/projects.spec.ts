import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { smithsViewSchema } from "../../apps/desktop/src/smiths-protocol";
import { conversationPageSchema } from "../../scripts/conversations/protocol";
import { OPERATOR_HEADER, SURFACE_HEADER } from "../../scripts/hearth/paths";
import {
  briefRefreshSchema,
  briefsSchema,
} from "../../scripts/keeper/brief-protocol";
import { keeperRecoveryPageSchema } from "../../scripts/keeper/recovery-protocol";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import {
  projectCreateOptionsSchema,
  projectScopePreviewSchema,
} from "../../scripts/projects/create-options-protocol";
import {
  projectCreateDiscoverySchema,
  projectCreateIdentitySchema,
} from "../../scripts/projects/create-protocol";
import { projectFixture } from "../../scripts/projects/testing";
import type { EventsPage, LedgerEventOf } from "../../types/hearth";
import type { ProjectCatalog } from "../../types/projects";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";

const catalogFile = join(HEARTH_HOME, "projects", "catalog.json");
const keeperFixtureModeFile = join(HEARTH_HOME, "keeper-fixture-mode.json");
const keeperFixtureStartsFile = join(
  HEARTH_HOME,
  "keeper-fixture-starts.jsonl",
);
const repositoryOnboardingFixtures = join(
  HEARTH_HOME,
  "repository-onboarding-fixtures",
);
const repositoryPickerControl = join(
  repositoryOnboardingFixtures,
  "picker-selection.json",
);
const repositoryCloneCalls = join(
  repositoryOnboardingFixtures,
  "clone-calls.jsonl",
);
const selectedFolder = join(repositoryOnboardingFixtures, "selected-folder");
const emptyGitMarker = join(repositoryOnboardingFixtures, "empty-git-marker");
const fixtureCloneUrl = "https://fixture.invalid/repository.git";
const workspace = resolveCheckout(process.cwd()).workspace;
const onboardingRepository = resolveCheckout(
  join(HEARTH_HOME, "project-create-registry", "repos", "onboarding-fixture"),
).worktree;
const alpha = projectFixture(workspace);
const beta = projectFixture(workspace, {
  id: "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
  slug: "beta",
  name: "Beta",
  workspaces: [
    { root: workspace, repositories: [workspace], epicIds: ["beta-epic"] },
  ],
});
const catalog: ProjectCatalog = {
  version: 1,
  revision: 1,
  projects: [alpha, beta],
};

test.beforeEach(() => {
  for (const path of [repositoryPickerControl, repositoryCloneCalls]) {
    try {
      rmSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  mkdirSync(join(HEARTH_HOME, "projects"), { recursive: true });
  writeFileSync(catalogFile, JSON.stringify(catalog));
  withStateLock(BD_STAND_IN_STATE, () =>
    writeState(
      BD_STAND_IN_STATE,
      Object.fromEntries(
        [alpha, beta].map((project) => [
          `${project.slug}-epic`,
          {
            id: `${project.slug}-epic`,
            title: `${project.name} epic`,
            issue_type: "epic",
            status: "open",
            priority: 2,
            created_at: project.createdAt,
            updated_at: project.updatedAt,
            labels: [`project:${project.slug}`],
          },
        ]),
      ),
    ),
  );
});

async function reserveFromProjectFlow(
  page: import("@playwright/test").Page,
  input: { slug: string; name: string },
) {
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const token = await pageToken(page);
  const headers = {
    "Content-Type": "application/json",
    [OPERATOR_HEADER]: token,
    [SURFACE_HEADER]: "ui",
  };
  const source = await page.evaluate(
    async ({ headers }) => {
      const [optionsResponse, smithsResponse, catalogResponse] =
        await Promise.all([
          fetch("/__agent-forge/projects/create-options", { headers }),
          fetch("/__agent-forge/smiths", { headers }),
          fetch("/__agent-forge/projects", { headers }),
        ]);
      return {
        optionsStatus: optionsResponse.status,
        options: await optionsResponse.json(),
        smithsStatus: smithsResponse.status,
        smiths: await smithsResponse.json(),
        catalogStatus: catalogResponse.status,
        catalog: await catalogResponse.json(),
      };
    },
    { headers },
  );
  expect(source.optionsStatus).toBe(200);
  expect(source.smithsStatus).toBe(200);
  expect(source.catalogStatus).toBe(200);
  const trusted = projectCreateOptionsSchema.parse(source.options.data);
  const configured = smithsViewSchema.parse(source.smiths.data);
  const catalogValue = source.catalog.data as ProjectCatalog;
  const repositoryIndex = trusted.repositories.findIndex((row) => row.served);
  const epic = trusted.epics[0];
  const keeper = configured.smiths.find((row) => row.enabled);
  expect(repositoryIndex).toBeGreaterThanOrEqual(0);
  expect(epic).toBeDefined();
  expect(keeper).toBeDefined();

  await dialog.getByRole("textbox", { name: "Project name" }).fill(input.name);
  await dialog.getByRole("textbox", { name: "Project slug" }).fill(input.slug);
  await dialog
    .getByRole("textbox", { name: "Project description" })
    .fill(`Reviewed original for ${input.slug}.`);
  await dialog.getByRole("textbox", { name: "Project icon" }).fill("P");
  const keeperSelect = dialog.getByRole("combobox", { name: "Project Keeper" });
  await expect(keeperSelect).toHaveValue("");
  await keeperSelect.selectOption(keeper!.name);
  await dialog
    .getByRole("combobox", { name: "Project color" })
    .selectOption("green");
  await dialog
    .locator("fieldset")
    .nth(0)
    .getByRole("checkbox")
    .nth(repositoryIndex)
    .check();
  await dialog
    .getByRole("group", { name: "Epics", exact: true })
    .getByRole("checkbox")
    .first()
    .check();

  await dialog
    .getByRole("button", { name: "Review trusted project scope" })
    .click();
  await expect(
    dialog.getByText("This exact original is reviewed", { exact: false }),
  ).toBeVisible();
  const reviewed = dialog.locator("dl.af-project-create-original");
  await expect(
    reviewed
      .getByText("Workspace", { exact: true })
      .locator("xpath=following-sibling::dd[1]"),
  ).toHaveText(trusted.workspace.path);
  await expect(
    reviewed
      .getByText("Repositories", { exact: true })
      .locator("xpath=following-sibling::dd[1]"),
  ).toHaveText(trusted.repositories[repositoryIndex]!.path);
  const original = {
    slug: input.slug,
    name: input.name,
    description: `Reviewed original for ${input.slug}.`,
    icon: "P",
    keeperSmith: keeper!.name,
    color: "green" as const,
    workspaces: [
      {
        root: trusted.workspace.path,
        repositories: [trusted.repositories[repositoryIndex]!.path],
        epicIds: [epic!.id],
      },
    ],
  };
  const beforeWrites = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch(
        "/__agent-forge/projects/create-reservations",
        { headers },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(beforeWrites.status).toBe(200);
  expect(beforeWrites.body.data.operations).toEqual([]);

  await dialog
    .getByRole("button", { name: "Reserve reviewed original" })
    .click();
  const reviewButton = page.getByRole("button", {
    name: "Review reserved project",
    exact: true,
  });
  await expect(reviewButton).toBeVisible();
  const discovery = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch(
        "/__agent-forge/projects/create-reservations",
        { headers },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(discovery.status).toBe(200);
  const discoveryPage = projectCreateDiscoverySchema.parse(discovery.body.data);
  expect(discoveryPage.operations).toHaveLength(1);
  const reservedRow = discoveryPage.operations[0]!;
  expect(reservedRow.state).toBe("reserved");
  const identityRead = await page.evaluate(
    async ({ headers, requestId }) => {
      const response = await fetch(
        `/__agent-forge/projects/create-reservations/${requestId}`,
        { headers },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers, requestId: reservedRow!.requestId },
  );
  expect(identityRead.status).toBe(200);
  const identity = projectCreateIdentitySchema.parse(identityRead.body.data);
  expect(identity).toMatchObject({ state: "reserved", original });
  expect(identity.baseRevision).toBe(catalogValue.revision);
  return {
    requestId: identity.requestId,
    requestHash: identity.requestHash,
    original,
  };
}

function setRepositoryPickerPath(path: string | null): void {
  writeFileSync(repositoryPickerControl, JSON.stringify({ path }));
}

function localCloneCount(): number {
  if (!existsSync(repositoryCloneCalls)) return 0;
  return readFileSync(repositoryCloneCalls, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean).length;
}

async function commitProjectFromOriginal(
  page: import("@playwright/test").Page,
  input: { slug: string; name: string },
) {
  await openSettled(page, "/index.html#/desktop/projects");
  const saved = await reserveFromProjectFlow(page, input);
  const reviewButton = page.getByRole("button", {
    name: "Review reserved project",
    exact: true,
  });
  await expect(reviewButton).toBeVisible();
  await reviewButton.click();
  const review = page.getByRole("dialog");
  await expect(
    review.getByText(saved.requestHash, { exact: true }),
  ).toBeVisible();
  const commitResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/__agent-forge/projects/create-reservations/${saved.requestId}/commit` &&
      response.request().method() === "POST",
  );
  await review
    .getByRole("button", { name: "Create project from this original" })
    .click();
  const response = await commitResponse;
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL(/\/project\/project-[0-9a-f-]{36}\/overview$/);
  const projectId = /\/project\/(project-[0-9a-f-]{36})\/overview$/.exec(
    new URL(page.url()).hash,
  )?.[1];
  expect(projectId).toBeDefined();
  const identityRead = await protectedRead(
    page,
    `/__agent-forge/projects/create-reservations/${saved.requestId}`,
  );
  expect(identityRead.status).toBe(200);
  expect(identityRead.body).toMatchObject({ ok: true, error: null });
  const identity = projectCreateIdentitySchema.parse(
    (identityRead.body as { data: unknown }).data,
  );
  expect(identity).toMatchObject({
    requestId: saved.requestId,
    requestHash: saved.requestHash,
    original: saved.original,
    state: "created",
    projectId,
  });
  await expect(page.locator(".af-desktop-project-name")).toHaveText(
    saved.original.name,
  );
  return {
    saved,
    projectId: projectId!,
    createdRevision: identity.createdRevision!,
  };
}

function keeperFixtureStarts(): number {
  try {
    return readFileSync(keeperFixtureStartsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

function setKeeperFixtureMode(mode: "normal" | "brief" | "legacy") {
  writeFileSync(keeperFixtureModeFile, JSON.stringify(mode));
}

function expectedProjectCreatePosts(requestId: string): string[] {
  return [
    "/__agent-forge/projects/create-reservations",
    `/__agent-forge/projects/create-reservations/${requestId}/commit`,
  ];
}

async function protectedRead(
  page: import("@playwright/test").Page,
  path: string,
) {
  const token = await pageToken(page);
  return page.evaluate(
    async ({ path, token, operatorHeader, surfaceHeader }) => {
      const response = await fetch(path, {
        headers: {
          [operatorHeader]: token,
          [surfaceHeader]: "ui",
        },
      });
      return { status: response.status, body: await response.json() };
    },
    {
      path,
      token,
      operatorHeader: OPERATOR_HEADER,
      surfaceHeader: SURFACE_HEADER,
    },
  );
}

test("a reviewed project is created from its saved original and opens Overview", async ({
  page,
}) => {
  const mutations: Array<{ path: string; body: unknown }> = [];
  let sessionStartPosts = 0;
  let commitRequestSeen = false;
  let summaryRequests = 0;
  let releaseSummary!: () => void;
  const summaryRelease = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  await page.route("**/__agent-forge/projects/summary", async (route) => {
    if (!commitRequestSeen) {
      await route.continue();
      return;
    }
    summaryRequests += 1;
    await summaryRelease;
    await route.continue();
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith(`/commit`) && request.method() === "POST")
      commitRequestSeen = true;
    if (request.method() !== "POST") return;
    if (path.endsWith("/session-start-identities")) sessionStartPosts++;
    if (path.startsWith("/__agent-forge/projects/create-reservations"))
      mutations.push({ path, body: request.postDataJSON() });
  });
  await openSettled(page, "/index.html#/desktop/projects");
  const saved = await reserveFromProjectFlow(page, {
    slug: "reviewed-project-flow",
    name: "Reviewed project flow",
  });
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({
    path: "/__agent-forge/projects/create-reservations",
    body: {
      requestId: saved.requestId,
      original: saved.original,
    },
  });
  expect(sessionStartPosts).toBe(0);

  await page
    .getByRole("button", { name: "Review reserved project", exact: true })
    .click();
  const review = page.getByRole("dialog");
  await expect(
    review.getByText(saved.requestId, { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByText(saved.requestHash, { exact: true }),
  ).toBeVisible();
  const summaryBeforeCommit = await page.evaluate(async () => {
    const response = await fetch("/__agent-forge/projects/summary", {
      cache: "no-store",
    });
    const body: unknown = await response.json();
    return { status: response.status, body };
  });
  expect(summaryBeforeCommit.status).toBe(200);
  expect(
    (
      summaryBeforeCommit.body as {
        data: { catalog: { projects: ProjectCatalog["projects"] } };
      }
    ).data.catalog.projects.some(
      (project) => project.slug === saved.original.slug,
    ),
  ).toBe(false);
  let createdProjectId = "";
  try {
    const commitReply = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/__agent-forge/projects/create-reservations/${saved.requestId}/commit`,
    );
    await review
      .getByRole("button", { name: "Create project from this original" })
      .click();
    const commitResponse = await commitReply;
    expect(commitResponse.status()).toBe(200);
    const receiptRead = await protectedRead(
      page,
      `/__agent-forge/projects/create-reservations/${saved.requestId}`,
    );
    expect(receiptRead.status).toBe(200);
    expect(receiptRead.body).toMatchObject({ ok: true, error: null });
    const receipt = projectCreateIdentitySchema.parse(
      (receiptRead.body as { data: unknown }).data,
    );
    expect(receipt).toMatchObject({
      requestId: saved.requestId,
      requestHash: saved.requestHash,
      original: saved.original,
      state: "created",
    });
    expect(receipt.projectId).not.toBeNull();
    createdProjectId = receipt.projectId!;
    await expect.poll(() => summaryRequests).toBeGreaterThan(0);
    expect(new URL(page.url()).hash).toContain("/desktop/projects");
  } finally {
    releaseSummary();
  }
  await expect(page).toHaveURL(
    new RegExp(`/project/${createdProjectId}/overview$`),
  );
  await expect(page.locator(".af-desktop-project-name")).toHaveText(
    saved.original.name,
  );
  expect(mutations.map((item) => item.path)).toEqual([
    "/__agent-forge/projects/create-reservations",
    `/__agent-forge/projects/create-reservations/${saved.requestId}/commit`,
  ]);
  expect(mutations[1]?.body).toMatchObject({
    requestHash: saved.requestHash,
    reviewedScopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(sessionStartPosts).toBe(0);

  const token = await pageToken(page);
  const headers = {
    [OPERATOR_HEADER]: token,
    [SURFACE_HEADER]: "ui",
  };
  const readback = await page.evaluate(
    async ({ headers, requestId }) => {
      const [identityResponse, catalogResponse] = await Promise.all([
        fetch(`/__agent-forge/projects/create-reservations/${requestId}`, {
          headers,
        }),
        fetch("/__agent-forge/projects", { headers }),
      ]);
      return {
        identityStatus: identityResponse.status,
        identity: await identityResponse.json(),
        catalogStatus: catalogResponse.status,
        catalog: await catalogResponse.json(),
      };
    },
    { headers, requestId: saved.requestId },
  );
  expect(readback.identityStatus).toBe(200);
  expect(readback.catalogStatus).toBe(200);
  expect(
    projectCreateIdentitySchema.parse(readback.identity.data),
  ).toMatchObject({
    requestId: saved.requestId,
    requestHash: saved.requestHash,
    original: saved.original,
    state: "created",
    projectId: createdProjectId,
  });
  expect(readback.catalog.data.projects).toContainEqual(
    expect.objectContaining({
      id: createdProjectId,
      slug: saved.original.slug,
    }),
  );
});

test("a created project gets its first Keeper brief only after explicit Refresh", async ({
  page,
}) => {
  setKeeperFixtureMode("brief");
  const startsBefore = keeperFixtureStarts();
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      posts.push(new URL(request.url()).pathname);
  });

  try {
    const { saved, projectId, createdRevision } =
      await commitProjectFromOriginal(page, {
        slug: "first-brief-explicit",
        name: "First brief explicit",
      });
    const panel = page.getByRole("region", {
      name: "Keeper brief",
      exact: true,
    });
    await expect(panel).toContainText("No confirmed brief yet");
    await expect(
      panel.getByRole("button", { name: "Refresh brief" }),
    ).toBeEnabled();
    await expect.poll(() => keeperFixtureStarts()).toBe(startsBefore);

    const createPosts = expectedProjectCreatePosts(saved.requestId);
    expect(posts).toEqual(createPosts);
    await reloadSettled(page);
    await expect(page.locator(".af-desktop-project-name")).toHaveText(
      saved.original.name,
    );
    await expect(panel).toContainText("No confirmed brief yet");
    await expect.poll(() => keeperFixtureStarts()).toBe(startsBefore);
    expect(posts).toEqual(createPosts);

    const token = await pageToken(page);
    const headers = {
      [OPERATOR_HEADER]: token,
      [SURFACE_HEADER]: "ui",
    };
    const initialReads = await page.evaluate(
      async ({ projectId, headers }) => {
        const [conversation, briefs, audit] = await Promise.all([
          fetch(
            `/__agent-forge/projects/${projectId}/keeper?after=0&limit=100`,
            { headers },
          ),
          fetch(`/__agent-forge/projects/${projectId}/keeper/briefs`, {
            headers,
          }),
          fetch("/__agent-forge/events?kind=operator.action&limit=100", {
            headers,
          }),
        ]);
        return {
          conversation: {
            status: conversation.status,
            body: await conversation.json(),
          },
          briefs: { status: briefs.status, body: await briefs.json() },
          audit: { status: audit.status, body: await audit.json() },
        };
      },
      { projectId, headers },
    );
    const {
      conversation: conversationRead,
      briefs: briefsRead,
      audit: auditRead,
    } = initialReads;
    expect(conversationRead.status).toBe(200);
    expect(briefsRead.status).toBe(200);
    expect(auditRead.status).toBe(200);
    expect(conversationRead.body).toMatchObject({
      ok: true,
      error: null,
    });
    expect(briefsRead.body).toMatchObject({ ok: true, error: null });
    expect(auditRead.body).toMatchObject({ ok: true, error: null });
    const conversationPage = conversationPageSchema.parse(
      (conversationRead.body as { data: unknown }).data,
    );
    expect(conversationPage.projectId).toBe(projectId);
    const emptyBriefs = briefsSchema.parse(
      (briefsRead.body as { data: unknown }).data,
    );
    expect(emptyBriefs).toMatchObject({ projectId, latest: null });
    const auditBefore = (auditRead.body as { data: EventsPage }).data;

    const refreshResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/__agent-forge/projects/${projectId}/keeper/briefs` &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Refresh brief" }).click();
    const response = await refreshResponse;
    expect(response.status()).toBe(202);
    const refreshBody = briefRefreshSchema.parse(
      response.request().postDataJSON(),
    );
    expect(refreshBody.expectedRevision).toBe(conversationPage.revision);
    expect(response.request().postDataJSON()).toMatchObject({
      requestId: refreshBody.requestId,
      expectedRevision: conversationPage.revision,
    });
    expect(posts).toEqual([
      ...createPosts,
      `/__agent-forge/projects/${projectId}/keeper/briefs`,
    ]);

    const card = panel.getByRole("article", {
      name: "Keeper brief card",
      exact: true,
    });
    await expect(card).toContainText(saved.original.name);
    await expect(card).toContainText("Moving");
    await expect.poll(() => keeperFixtureStarts()).toBe(startsBefore + 1);

    const finalReads = await page.evaluate(
      async ({ projectId, requestId, after, headers }) => {
        const [briefs, conversation, audit] = await Promise.all([
          fetch(`/__agent-forge/projects/${projectId}/keeper/briefs`, {
            headers,
          }),
          fetch(
            `/__agent-forge/projects/${projectId}/keeper?after=0&limit=100&requestId=${requestId}`,
            { headers },
          ),
          fetch(
            `/__agent-forge/events?kind=operator.action&after=${after}&limit=100`,
            { headers },
          ),
        ]);
        return {
          briefs: { status: briefs.status, body: await briefs.json() },
          conversation: {
            status: conversation.status,
            body: await conversation.json(),
          },
          audit: { status: audit.status, body: await audit.json() },
        };
      },
      {
        projectId,
        requestId: refreshBody.requestId,
        after: auditBefore.cursor,
        headers,
      },
    );
    const {
      briefs: savedBriefRead,
      conversation: savedConversationRead,
      audit: auditAfterRead,
    } = finalReads;
    expect(savedBriefRead.status).toBe(200);
    expect(savedConversationRead.status).toBe(200);
    expect(auditAfterRead.status).toBe(200);
    expect(savedBriefRead.body).toMatchObject({ ok: true, error: null });
    expect(savedConversationRead.body).toMatchObject({
      ok: true,
      error: null,
    });
    expect(auditAfterRead.body).toMatchObject({ ok: true, error: null });
    const savedBriefs = briefsSchema.parse(
      (savedBriefRead.body as { data: unknown }).data,
    );
    expect(savedBriefs.projectId).toBe(projectId);
    expect(savedBriefs.latest?.requestId).toBe(refreshBody.requestId);
    expect(savedBriefs.latest?.snapshot).toMatchObject({
      projectId,
      projectName: saved.original.name,
      workspace: saved.original.workspaces[0]!.root,
      catalogRevision: createdRevision,
      scope: {
        label: `project:${saved.original.slug}`,
        epicIds: saved.original.workspaces[0]!.epicIds,
        epicCount: saved.original.workspaces[0]!.epicIds.length,
        repositoryCount: saved.original.workspaces[0]!.repositories.length,
      },
    });
    expect(savedBriefs.refresh).toMatchObject({
      requestId: refreshBody.requestId,
      phase: "completed",
    });
    const savedConversation = conversationPageSchema.parse(
      (savedConversationRead.body as { data: unknown }).data,
    );
    expect(
      savedConversation.turns.find(
        (turn) => turn.requestId === refreshBody.requestId,
      )?.phase,
    ).toBe("completed");
    const auditPage = (auditAfterRead.body as { data: EventsPage }).data;
    const auditEvents = auditPage.events;
    expect(auditPage.more).toBe(false);
    expect(auditEvents).toHaveLength(1);
    const refreshAudits = auditEvents.filter(
      (event): event is LedgerEventOf<"operator.action"> =>
        event.kind === "operator.action" &&
        event.payload.action === "keeper.brief.refresh",
    );
    expect(refreshAudits).toHaveLength(1);
    expect(refreshAudits[0]?.payload).toMatchObject({
      action: "keeper.brief.refresh",
      surface: "ui",
      target: projectId,
    });
    expect(posts).toEqual([
      ...createPosts,
      `/__agent-forge/projects/${projectId}/keeper/briefs`,
    ]);
    expect(keeperFixtureStarts()).toBe(startsBefore + 1);
  } finally {
    setKeeperFixtureMode("normal");
  }
});

test("a new project's legacy Keeper capability stays unavailable without fallback or a turn", async ({
  page,
}) => {
  setKeeperFixtureMode("legacy");
  const startsBefore = keeperFixtureStarts();
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      posts.push(new URL(request.url()).pathname);
  });

  try {
    const { saved, projectId } = await commitProjectFromOriginal(page, {
      slug: "legacy-keeper-capability",
      name: "Legacy Keeper capability",
    });
    const createPosts = expectedProjectCreatePosts(saved.requestId);
    const panel = page.getByRole("region", {
      name: "Keeper brief",
      exact: true,
    });
    const unavailable = panel.locator(
      '.af-brief-availability[data-readiness="unavailable"]',
    );
    await expect(unavailable).toContainText("Brief refresh is unavailable.");
    await expect(unavailable).toContainText(
      "The Keeper adapter capability check could not be verified. Recheck before sending.",
    );
    await expect(
      panel.getByRole("button", { name: "Refresh brief" }),
    ).toBeDisabled();
    await expect(page.locator(".af-desktop-project-name")).toHaveText(
      saved.original.name,
    );

    const recoveryRead = await protectedRead(
      page,
      `/__agent-forge/projects/${projectId}/keeper/recovery`,
    );
    expect(recoveryRead.status).toBe(200);
    expect(recoveryRead.body).toMatchObject({ ok: true, error: null });
    const recovery = keeperRecoveryPageSchema.parse(
      (recoveryRead.body as { data: unknown }).data,
    );
    expect(recovery.projectId).toBe(projectId);
    expect(recovery.selectedSmith).toBe(saved.original.keeperSmith);
    const selected = recovery.choices.find(
      (choice) => choice.smith.name === saved.original.keeperSmith,
    );
    expect(selected).toBeDefined();
    expect(selected?.readiness).toMatchObject({
      connection: "unknown",
      allowance: "unreported",
      canStart: false,
      reason:
        "The Keeper adapter capability check could not be verified. Recheck before sending.",
    });
    expect(posts).toEqual(createPosts);
    expect(keeperFixtureStarts()).toBe(startsBefore);
  } finally {
    setKeeperFixtureMode("normal");
  }
});

test("a lost commit reply reloads the same created original without replay", async ({
  page,
}) => {
  const mutations: Array<{ path: string; body: unknown }> = [];
  let commitEffectReached!: () => void;
  let releaseCommitReply!: () => void;
  const effectReached = new Promise<void>((resolve) => {
    commitEffectReached = resolve;
  });
  const commitReplyRelease = new Promise<void>((resolve) => {
    releaseCommitReply = resolve;
  });
  const commitPathPattern = "**/create-reservations/*/commit";
  const loseCommitReply = async (route: import("@playwright/test").Route) => {
    await route.fetch();
    commitEffectReached();
    await commitReplyRelease;
    await route.abort("failed").catch(() => undefined);
  };
  await page.route(commitPathPattern, loseCommitReply);
  let recoveryOriginalReads = 0;
  let countRecoveryReads = false;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "GET" &&
      /^\/__agent-forge\/projects\/create-reservations\/[0-9a-f-]+$/.test(
        path,
      ) &&
      countRecoveryReads
    )
      recoveryOriginalReads += 1;
    if (request.method() !== "POST") return;
    if (path.startsWith("/__agent-forge/projects/create-reservations"))
      mutations.push({ path, body: request.postDataJSON() });
  });

  await openSettled(page, "/index.html#/desktop/projects");
  const saved = await reserveFromProjectFlow(page, {
    slug: "lost-commit-reply-project",
    name: "Lost commit reply project",
  });
  await page
    .getByRole("button", { name: "Review reserved project", exact: true })
    .click();
  const review = page.getByRole("dialog");
  const click = review
    .getByRole("button", { name: "Create project from this original" })
    .click()
    .catch(() => undefined);
  const recoveryPath = `/__agent-forge/projects/create-reservations/${saved.requestId}`;
  const recoveryCaptureKey = `__projectCreateRecovery_${saved.requestId.replaceAll(
    "-",
    "",
  )}`;
  const recoveryCaptureId = `${Date.now()}-${Math.random()}`;
  try {
    await effectReached;
    const token = await pageToken(page);
    const verifiedBeforeReload = await page.evaluate(
      async ({ token, requestId }) => {
        const response = await fetch(
          `/__agent-forge/projects/create-reservations/${requestId}`,
          {
            headers: {
              ["X-Agent-Forge-Operator"]: token,
              ["X-Agent-Forge-Surface"]: "ui",
            },
          },
        );
        return { status: response.status, body: await response.json() };
      },
      { token, requestId: saved.requestId },
    );
    expect(verifiedBeforeReload.status).toBe(200);
    const createdBeforeReload = projectCreateIdentitySchema.parse(
      verifiedBeforeReload.body.data,
    );
    expect(createdBeforeReload).toMatchObject({
      requestId: saved.requestId,
      requestHash: saved.requestHash,
      original: saved.original,
      state: "created",
    });
    expect(createdBeforeReload.projectId).not.toBeNull();

    countRecoveryReads = true;
    await page.addInitScript(
      ({ key, captureId, exactPath, maxBytes }) => {
        const target = window as unknown as Record<string, unknown>;
        target[key] = null;
        const originalFetch = window.fetch.bind(window);
        let captured = false;
        const wrappedFetch = async (
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> => {
          let requestUrl: URL | null = null;
          let method = init?.method;
          try {
            if (input instanceof Request) {
              requestUrl = new URL(input.url);
              method ??= input.method;
            } else {
              requestUrl = new URL(String(input), window.location.href);
            }
          } catch {
            return originalFetch(input, init);
          }
          method ??= "GET";
          if (
            captured ||
            requestUrl.pathname !== exactPath ||
            method.toUpperCase() !== "GET"
          )
            return originalFetch(input, init);

          captured = true;
          let response: Response;
          try {
            response = await originalFetch(input, init);
          } catch (error) {
            target[key] = {
              captureId,
              status: null,
              bodyText: null,
              origin: requestUrl.origin,
              pathname: requestUrl.pathname,
              responseOrigin: null,
              responsePathname: null,
              method,
              sameOrigin: requestUrl.origin === window.location.origin,
              captureError: "fetch_failed",
            };
            throw error;
          }

          const sameOrigin = requestUrl.origin === window.location.origin;
          let responseUrl: URL | null = null;
          try {
            responseUrl = new URL(response.url);
          } catch {
            // A missing or malformed final URL is recorded as a fixed mismatch.
          }
          const responseMatches =
            responseUrl?.origin === window.location.origin &&
            responseUrl.pathname === exactPath;
          let bodyText: string | null = null;
          let captureError: string | null = !sameOrigin
            ? "foreign_origin"
            : !responseMatches
              ? "response_url_mismatch"
              : null;
          if (sameOrigin) {
            try {
              const reader = response.clone().body?.getReader();
              if (!reader) {
                captureError = "body_unavailable";
              } else {
                const chunks: Uint8Array[] = [];
                let byteLength = 0;
                while (true) {
                  const part = await reader.read();
                  if (part.done) break;
                  byteLength += part.value.byteLength;
                  if (byteLength > maxBytes) {
                    captureError = "body_too_large";
                    void reader.cancel().catch(() => undefined);
                    reader.releaseLock();
                    break;
                  }
                  chunks.push(part.value);
                }
                if (captureError === null) {
                  const bytes = new Uint8Array(byteLength);
                  let offset = 0;
                  for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                  }
                  bodyText = new TextDecoder("utf-8", { fatal: true }).decode(
                    bytes,
                  );
                }
              }
            } catch {
              captureError = "body_read_failed";
            }
          }
          target[key] = {
            captureId,
            status: response.status,
            bodyText,
            origin: requestUrl.origin,
            pathname: requestUrl.pathname,
            responseOrigin: responseUrl?.origin ?? null,
            responsePathname: responseUrl?.pathname ?? null,
            method,
            sameOrigin,
            captureError,
          };
          return response;
        };
        Object.defineProperty(window, "fetch", {
          configurable: true,
          value: wrappedFetch,
          writable: true,
        });
      },
      {
        key: recoveryCaptureKey,
        captureId: recoveryCaptureId,
        exactPath: recoveryPath,
        maxBytes: 64 * 1024,
      },
    );
    await page.reload();
    releaseCommitReply();
    await click;
    await expect
      .poll(() =>
        page.evaluate(
          (key) => (window as unknown as Record<string, unknown>)[key] !== null,
          recoveryCaptureKey,
        ),
      )
      .toBe(true);
    const recoveredRead = (await page.evaluate((key) => {
      const value = (window as unknown as Record<string, unknown>)[key];
      return typeof value === "object" && value !== null ? value : null;
    }, recoveryCaptureKey)) as {
      captureId: string;
      status: number | null;
      bodyText: string | null;
      origin: string;
      pathname: string;
      responseOrigin: string | null;
      responsePathname: string | null;
      method: string;
      sameOrigin: boolean;
      captureError: string | null;
    } | null;
    expect(recoveredRead).not.toBeNull();
    if (!recoveredRead) throw Error("The recovery read was not captured.");
    expect(recoveredRead.captureError).toBeNull();
    expect(recoveredRead.captureId).toBe(recoveryCaptureId);
    expect(recoveredRead.pathname).toBe(recoveryPath);
    expect(recoveredRead.method).toBe("GET");
    expect(recoveredRead.origin).toBe(new URL(page.url()).origin);
    expect(recoveredRead.responseOrigin).toBe(new URL(page.url()).origin);
    expect(recoveredRead.responsePathname).toBe(recoveryPath);
    expect(recoveredRead.sameOrigin).toBe(true);
    expect(recoveredRead.status).toBe(200);
    if (recoveredRead.bodyText === null)
      throw Error("The recovered project original envelope was unavailable.");
    let recoveredBody: unknown;
    try {
      recoveredBody = JSON.parse(recoveredRead.bodyText);
    } catch {
      throw Error("The recovered project original was not valid JSON.");
    }
    if (
      typeof recoveredBody !== "object" ||
      recoveredBody === null ||
      !("data" in recoveredBody)
    )
      throw Error("The recovered project original envelope was unavailable.");
    const recoveredIdentity = projectCreateIdentitySchema.parse(
      recoveredBody.data,
    );
    expect(recoveredIdentity).toMatchObject({
      requestId: saved.requestId,
      requestHash: saved.requestHash,
      original: saved.original,
      state: "created",
    });
    expect(recoveredIdentity.projectId).toBe(createdBeforeReload.projectId);
    await expect(
      page.getByRole("link", { name: saved.original.name, exact: true }),
    ).toBeVisible();
    expect(recoveryOriginalReads).toBe(1);
    expect(mutations.map((item) => item.path)).toEqual([
      "/__agent-forge/projects/create-reservations",
      `/__agent-forge/projects/create-reservations/${saved.requestId}/commit`,
    ]);
    expect(mutations[1]?.body).toMatchObject({
      requestHash: saved.requestHash,
      reviewedScopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  } finally {
    releaseCommitReply();
    await click;
    await page.unroute(commitPathPattern, loseCommitReply);
  }
});

test("retirement is explicit and a tombstone readback unlocks a fresh review", async ({
  page,
}) => {
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      mutations.push(new URL(request.url()).pathname);
  });
  await openSettled(page, "/index.html#/desktop/projects");
  const saved = await reserveFromProjectFlow(page, {
    slug: "retired-project-flow",
    name: "Retired project flow",
  });
  await page
    .getByRole("button", { name: "Review reserved project", exact: true })
    .click();
  const review = page.getByRole("dialog");
  await review
    .getByRole("button", { name: "Retire reserved original" })
    .click();
  const confirmation = review.getByRole("alertdialog", {
    name: "Confirm project retirement",
  });
  await expect(confirmation).toContainText(saved.requestId);
  await confirmation
    .getByRole("button", { name: "Confirm retirement" })
    .click();
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeEnabled();
  const token = await pageToken(page);
  const retired = await page.evaluate(
    async ({ token, requestId }) => {
      const response = await fetch(
        `/__agent-forge/projects/create-reservations/${requestId}`,
        {
          headers: {
            ["X-Agent-Forge-Operator"]: token,
            ["X-Agent-Forge-Surface"]: "ui",
          },
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { token, requestId: saved.requestId },
  );
  expect(retired.status).toBe(200);
  expect(projectCreateIdentitySchema.parse(retired.body.data)).toMatchObject({
    requestId: saved.requestId,
    requestHash: saved.requestHash,
    original: saved.original,
    state: "retired-before-create",
    projectId: null,
  });
  expect(mutations).toEqual([
    "/__agent-forge/projects/create-reservations",
    `/__agent-forge/projects/create-reservations/${saved.requestId}/retire`,
  ]);
});

test("Add Folder keeps cancellation inert and permits a new picker after an invalid Git root", async ({
  page,
}) => {
  const folderRegistrations: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      /\/repository-selections\/[^/]+\/register$/.test(pathname)
    )
      folderRegistrations.push(pathname);
  });
  await openSettled(page, "/index.html#/desktop/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a project" });
  await expect(dialog).toBeVisible();

  await dialog
    .getByRole("button", { name: "Add a folder…", exact: true })
    .click();
  await expect(
    dialog.getByText("Folder selection cancelled. Nothing was registered.", {
      exact: true,
    }),
  ).toBeVisible();

  setRepositoryPickerPath(emptyGitMarker);
  await dialog
    .getByRole("button", { name: "Add a folder…", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "The selected folder was not confirmed as a Git repository root. You may choose another folder.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Choose another folder…", exact: true }),
  ).toBeEnabled();

  setRepositoryPickerPath(selectedFolder);
  await dialog
    .getByRole("button", { name: "Choose another folder…", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Folder repository name" }),
  ).toHaveValue("selected-folder");
  await expect(dialog.getByText(selectedFolder, { exact: true })).toBeVisible();
  const token = await pageToken(page);
  const headers = {
    "Content-Type": "application/json",
    [OPERATOR_HEADER]: token,
    [SURFACE_HEADER]: "ui",
  };
  const options = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/projects/create-options", {
        headers,
      });
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(options.status).toBe(200);
  const optionsData = projectCreateOptionsSchema.parse(options.body.data);
  expect(
    optionsData.repositories.some((row) => row.name === "selected-folder"),
  ).toBe(false);
  expect(folderRegistrations).toEqual([]);
});

test("Add Folder and a reviewed local clone feed a fresh two-repository project scope after a lost clone reply", async ({
  page,
}) => {
  setRepositoryPickerPath(selectedFolder);
  let lostCloneReplies = 0;
  const folderRegistrations: string[] = [];
  const clonePosts: string[] = [];
  const projectReservations: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      /\/repository-selections\/[^/]+\/register$/.test(pathname)
    )
      folderRegistrations.push(pathname);
    if (
      request.method() === "POST" &&
      /\/repository-clone-reservations\/[^/]+\/clone$/.test(pathname)
    )
      clonePosts.push(pathname);
    if (
      request.method() === "POST" &&
      pathname.endsWith("/projects/create-reservations")
    )
      projectReservations.push(pathname);
  });
  await openSettled(page, "/index.html#/desktop/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create a project" });
  await expect(dialog).toBeVisible();

  await dialog
    .getByRole("button", { name: "Add a folder…", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Folder repository name" })
    .fill("selected-folder");
  await dialog
    .getByRole("button", { name: "Review folder registration", exact: true })
    .click();
  const screenshotDir = process.env["SHOT_DIR"];
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await dialog.screenshot({
      path: join(screenshotDir, "repository-folder-review.png"),
    });
  }
  await dialog
    .getByRole("button", { name: "Register reviewed folder", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "Repository registered. Choose it in the reviewed project scope.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: /selected-folder/ }),
  ).toBeVisible();
  expect(folderRegistrations).toHaveLength(1);

  await dialog
    .getByRole("textbox", { name: "Repository clone URL" })
    .fill(fixtureCloneUrl);
  await dialog
    .getByRole("textbox", { name: "Clone repository name" })
    .fill("cloned-folder");
  await dialog
    .getByRole("button", { name: "Review clone destination", exact: true })
    .click();
  await expect(dialog.getByText("Clone status", { exact: true })).toBeVisible();
  expect(localCloneCount()).toBe(0);
  await page.route(
    "**/repository-clone-reservations/*/clone",
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      lostCloneReplies++;
      await route.abort("failed");
    },
  );
  await dialog
    .getByRole("button", { name: "Clone reviewed repository", exact: true })
    .click();
  await expect(
    dialog.getByText(
      "Clone completed and the trusted repository choices were refreshed.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Review another clone", exact: true }),
  ).toBeVisible();
  expect(lostCloneReplies).toBe(1);
  expect(folderRegistrations).toHaveLength(1);
  expect(clonePosts).toHaveLength(1);
  expect(localCloneCount()).toBe(1);
  await page.unroute("**/repository-clone-reservations/*/clone");

  await reloadSettled(page);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const freshDialog = page.getByRole("dialog", { name: "Create a project" });
  await expect(
    freshDialog.getByRole("checkbox", { name: /selected-folder/ }),
  ).toBeVisible();
  await expect(
    freshDialog.getByRole("checkbox", { name: /cloned-folder/ }),
  ).toBeVisible();
  await freshDialog
    .getByRole("textbox", { name: "Project name" })
    .fill("Two repository project");
  await freshDialog
    .getByRole("textbox", { name: "Project slug" })
    .fill("two-repository-project");
  await freshDialog
    .getByRole("textbox", { name: "Project description" })
    .fill("Reviewed external repository scope.");
  await freshDialog.getByRole("textbox", { name: "Project icon" }).fill("T");
  const freshToken = await pageToken(page);
  const freshHeaders = {
    "Content-Type": "application/json",
    [OPERATOR_HEADER]: freshToken,
    [SURFACE_HEADER]: "ui",
  };
  const keeperResponse = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/smiths", {
        headers,
      });
      return { status: response.status, body: await response.json() };
    },
    { headers: freshHeaders },
  );
  expect(keeperResponse.status).toBe(200);
  const keeper = smithsViewSchema
    .parse(keeperResponse.body.data)
    .smiths.find((row) => row.enabled);
  if (!keeper)
    throw new Error("No enabled Keeper is available for the review.");
  await freshDialog
    .getByRole("combobox", { name: "Project Keeper" })
    .selectOption(keeper.name);
  await freshDialog
    .getByRole("combobox", { name: "Project color" })
    .selectOption("green");
  const repositories = freshDialog.locator("fieldset").first();
  await repositories.getByRole("checkbox", { name: /selected-folder/ }).check();
  await repositories.getByRole("checkbox", { name: /cloned-folder/ }).check();
  await freshDialog
    .getByRole("group", { name: "Epics", exact: true })
    .getByRole("checkbox")
    .first()
    .check();
  await freshDialog
    .getByRole("button", { name: "Review trusted project scope", exact: true })
    .click();
  const reviewDialog = page.getByRole("dialog", {
    name: "Review project original",
    exact: true,
  });
  await expect(
    reviewDialog.getByText("This exact original is reviewed", { exact: false }),
  ).toBeVisible();
  const reviewed = reviewDialog.locator("dl.af-project-create-original");
  const repositoriesText = reviewed
    .getByText("Repositories", { exact: true })
    .locator("xpath=following-sibling::dd[1]");
  await expect(repositoriesText).toContainText("selected-folder");
  await expect(repositoriesText).toContainText("cloned-folder");
  if (screenshotDir) {
    await reviewDialog.screenshot({
      path: join(screenshotDir, "two-repository-project-review.png"),
    });
  }
  expect(localCloneCount()).toBe(1);
  expect(clonePosts).toHaveLength(1);
  expect(projectReservations).toEqual([]);
});

test("Projects offers the explicit New project flow", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (
      path.includes("/projects/create-reservations") ||
      path.endsWith("/session-start-identities")
    )
      writes.push(path);
  });

  await openSettled(page, "/index.html#/desktop/projects");
  const create = page.getByRole("button", {
    name: "New project",
    exact: true,
  });
  await expect(create).toBeEnabled();
  await create.focus();
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Create a project" });
  const close = dialog.getByRole("button", { name: "Close dialog" });
  const reviewScope = dialog.getByRole("button", {
    name: "Review trusted project scope",
  });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(reviewScope).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  const name = dialog.getByRole("textbox", { name: "Project name" });
  await expect(name).toBeFocused();
  await page.keyboard.type("Keyboard project draft");
  await expect(name).toHaveValue("Keyboard project draft");
  await expect(name).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  await expect(name).toHaveValue("Keyboard project draft");
  expect(writes).toEqual([]);
});

test("Projects remains rendered while trusted workspace scope hydrates", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      /\/__agent-forge\/projects\/create-(?:reservations|commit|retire)/.test(
        request.url(),
      )
    )
      writes.push(request.method());
  });

  await openSettled(page, "/index.html#/desktop/projects");
  const create = page.getByRole("button", {
    name: "New project",
    exact: true,
  });
  await expect(create).toBeEnabled();

  expect(pageErrors).toEqual([]);
  expect(writes).toEqual([]);
});

test("reload recovers a reserved original with protected reads only", async ({
  page,
}) => {
  const requestId = randomUUID();
  const slug = "recoverable-onboarding-project";
  const name = "Recoverable onboarding project";
  await openSettled(page, "/index.html#/desktop/projects");
  const token = await pageToken(page);
  const headers = {
    "Content-Type": "application/json",
    [OPERATOR_HEADER]: token,
    [SURFACE_HEADER]: "ui",
  };
  const source = await page.evaluate(
    async ({ headers }) => {
      const [optionsResponse, smithsResponse] = await Promise.all([
        fetch("/__agent-forge/projects/create-options", { headers }),
        fetch("/__agent-forge/smiths", { headers }),
      ]);
      return {
        optionsStatus: optionsResponse.status,
        options: await optionsResponse.json(),
        smithsStatus: smithsResponse.status,
        smiths: await smithsResponse.json(),
      };
    },
    { headers },
  );
  expect(source.optionsStatus).toBe(200);
  expect(source.smithsStatus).toBe(200);
  const options = projectCreateOptionsSchema.parse(source.options.data);
  const smiths = smithsViewSchema.parse(source.smiths.data);
  const keeperSmith = smiths.smiths.find((smith) => smith.enabled);
  const epic = options.epics.find((candidate) => candidate.id === "alpha-epic");
  const repository = options.repositories.find((candidate) => candidate.served);
  expect(keeperSmith).toBeDefined();
  expect(epic).toBeDefined();
  expect(repository).toBeDefined();

  const original = {
    slug,
    name,
    description:
      "The saved original must remain available for explicit review.",
    icon: "P",
    keeperSmith: keeperSmith!.name,
    workspaces: [
      {
        root: options.workspace.path,
        repositories: [repository!.path],
        epicIds: [epic!.id],
      },
    ],
  };
  const previewQuery = new URLSearchParams({ slug, epicId: epic!.id });
  const previewResult = await page.evaluate(
    async ({ headers, query }) => {
      const response = await fetch(
        `/__agent-forge/projects/create-scope-preview?${query}`,
        { headers },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers, query: previewQuery.toString() },
  );
  expect(previewResult.status).toBe(200);
  const preview = projectScopePreviewSchema.parse(previewResult.body.data);
  const reservation = {
    requestId,
    expectedCatalogRevision: catalog.revision,
    original,
  };
  const reserved = await page.evaluate(
    async ({ headers, reservation }) => {
      const response = await fetch(
        "/__agent-forge/projects/create-reservations",
        {
          method: "POST",
          headers,
          body: JSON.stringify(reservation),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers, reservation },
  );
  expect(reserved.status).toBe(201);
  const identity = projectCreateIdentitySchema.parse(reserved.body.data);
  expect(identity).toMatchObject({
    requestId,
    baseRevision: catalog.revision,
    original,
    scopeHash: preview.scopeHash,
    state: "reserved",
  });

  const createWrites: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/__agent-forge/projects/create-"))
      createWrites.push(path);
  });
  await reloadSettled(page);
  const review = page.getByRole("button", {
    name: "Review reserved project",
    exact: true,
  });
  await expect(review).toBeEnabled();
  await review.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  const recovered = await page.evaluate(
    async ({ headers, requestId }) => {
      const response = await fetch(
        `/__agent-forge/projects/create-reservations/${requestId}`,
        { headers },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers, requestId },
  );
  expect(recovered.status).toBe(200);
  expect(projectCreateIdentitySchema.parse(recovered.body.data)).toEqual(
    identity,
  );
  expect(createWrites).toEqual([]);
});

test("a protected project reservation stays private until a separate create action", async ({
  page,
}) => {
  const epicId = "onboarding-private-epic";
  const privateSlug = "uncommitted-private-draft";
  const privateName = "Private onboarding draft — must not appear in Projects";
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    state[epicId] = {
      id: epicId,
      title: "Private onboarding epic",
      issue_type: "epic",
      status: "open",
      priority: 2,
      created_at: "2026-10-27T00:00:00.000Z",
      updated_at: "2026-10-27T00:00:00.000Z",
      labels: [`project:${privateSlug}`],
    };
    writeState(BD_STAND_IN_STATE, state);
  });

  const original = {
    slug: privateSlug,
    name: privateName,
    description: "This reserved original is private until an explicit create.",
    icon: "P",
    workspaces: [
      {
        root: workspace,
        repositories: [workspace, onboardingRepository],
        epicIds: [epicId],
      },
    ],
  };
  const postedPaths: string[] = [];
  let identityPosts = 0;
  let originalReads = 0;
  const requestId = "ab847e06-4f01-4dd3-a425-47bf9053e006";
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.pathname.endsWith("/session-start-identities")
    )
      identityPosts++;
    if (
      request.method() === "GET" &&
      url.pathname ===
        `/__agent-forge/projects/create-reservations/${requestId}`
    )
      originalReads++;
    if (
      request.method() === "POST" &&
      url.pathname.includes("/projects/create-reservations")
    )
      postedPaths.push(url.pathname);
  });

  await openSettled(page, "/index.html#/desktop/projects");
  const token = await pageToken(page);
  const headers = {
    "Content-Type": "application/json",
    [OPERATOR_HEADER]: token,
    [SURFACE_HEADER]: "ui",
  };
  const before = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/projects", { headers });
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(before.status).toBe(200);
  expect(before.body).toMatchObject({
    ok: true,
    data: { revision: 1, projects: [{ slug: "alpha" }, { slug: "beta" }] },
  });
  const catalogBefore = before.body.data as ProjectCatalog;

  const optionsResponse = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/projects/create-options", {
        headers,
      });
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(optionsResponse.status).toBe(200);
  expect(optionsResponse.body).toMatchObject({ ok: true, error: null });
  const options = projectCreateOptionsSchema.parse(optionsResponse.body.data);
  expect(options.complete).toBe(true);
  expect(options.workspace.path).toBe(workspace);
  expect(
    options.repositories.find((repository) => repository.served),
  ).toMatchObject({
    path: workspace,
    key: options.workspace.key,
    served: true,
  });
  expect(options.repositories).toContainEqual({
    path: onboardingRepository,
    key: expect.any(String),
    name: "onboarding-fixture",
    served: false,
  });
  expect(options.epics.find((epic) => epic.id === epicId)).toMatchObject({
    id: epicId,
    title: "Private onboarding epic",
  });

  const previewResponse = await page.evaluate(
    async ({ headers, slug, epicId }) => {
      const query = new URLSearchParams({ slug, epicId });
      const response = await fetch(
        `/__agent-forge/projects/create-scope-preview?${query}`,
        { headers },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers, slug: privateSlug, epicId },
  );
  expect(previewResponse.status).toBe(200);
  expect(previewResponse.body).toMatchObject({ ok: true, error: null });
  const preview = projectScopePreviewSchema.parse(previewResponse.body.data);
  expect(preview).toMatchObject({
    complete: true,
    workspaceKey: options.workspace.key,
    slug: privateSlug,
    epicIds: [epicId],
  });
  expect(preview.scopeCount).toBeGreaterThanOrEqual(0);
  expect(postedPaths).toEqual([]);
  expect(identityPosts).toBe(0);

  const catalogAfterRead = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/projects", { headers });
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(catalogAfterRead).toEqual({
    status: 200,
    body: { ok: true, data: catalogBefore, error: null },
  });
  expect(postedPaths).toEqual([]);
  expect(identityPosts).toBe(0);

  const reserve = await page.evaluate(
    async ({ headers, requestId, original, revision }) => {
      const response = await fetch(
        "/__agent-forge/projects/create-reservations",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            requestId,
            expectedCatalogRevision: revision,
            original,
          }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    {
      headers,
      requestId,
      original,
      revision: catalogBefore.revision,
    },
  );
  expect(reserve.status).toBe(201);
  expect(reserve.body).toMatchObject({
    ok: true,
    data: {
      requestId,
      state: "reserved",
      original,
      scopeCount: preview.scopeCount,
      scopeHash: preview.scopeHash,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(reserve.body.data.scopeCount).toBe(preview.scopeCount);
  expect(reserve.body.data.scopeHash).toBe(preview.scopeHash);
  const requestHash = reserve.body.data.requestHash as string;

  const catalogAfterReservation = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/projects", { headers });
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(catalogAfterReservation.status).toBe(200);
  expect(catalogAfterReservation.body).toMatchObject({ ok: true, error: null });
  expect(identityPosts).toBe(0);

  const recovered = await page.evaluate(
    async ({ headers, requestId }) => {
      const response = await fetch(
        `/__agent-forge/projects/create-reservations/${requestId}`,
        { headers },
      );
      return { status: response.status, body: await response.json() };
    },
    { headers, requestId },
  );
  expect(recovered.status).toBe(200);
  expect(recovered.body).toMatchObject({
    ok: true,
    data: { requestId, requestHash, state: "reserved", original },
  });

  const publicCatalog = await page.evaluate(
    async ({ headers }) => {
      const response = await fetch("/__agent-forge/projects", { headers });
      return { status: response.status, body: await response.json() };
    },
    { headers },
  );
  expect(publicCatalog).toEqual({
    status: 200,
    body: {
      ok: true,
      data: catalogAfterReservation.body.data,
      error: null,
    },
  });
  expect(JSON.stringify(publicCatalog.body)).not.toContain(privateName);
  expect(JSON.stringify(publicCatalog.body)).not.toContain(privateSlug);

  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeEnabled();
  const readsBeforeReload = originalReads;
  await reloadSettled(page);
  await expect(
    page.getByRole("article", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Project cards" })
      .getByRole("article", { name: privateName, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeDisabled();
  expect(originalReads).toBeGreaterThan(readsBeforeReload);
  await page
    .getByRole("button", { name: "Review reserved project", exact: true })
    .click();
  const reviewTrigger = page.getByRole("button", {
    name: "Review reserved project",
    exact: true,
  });
  const reviewDialog = page.getByRole("dialog", {
    name: "Review saved project original",
  });
  const reviewClose = reviewDialog.getByRole("button", {
    name: "Close dialog",
  });
  await expect(reviewDialog).toBeVisible();
  await expect(reviewClose).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("project-create-reserved-review.png"),
  });
  await expect(reviewDialog).toContainText(privateName);
  await expect(reviewDialog).toContainText(requestId);
  await expect(reviewDialog).toContainText(requestHash);
  await expect(
    reviewDialog.getByText("reserved", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reviewDialog).not.toBeVisible();
  await expect(reviewTrigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(reviewDialog).toBeVisible();
  await expect(reviewClose).toBeFocused();
  expect(postedPaths).toEqual(["/__agent-forge/projects/create-reservations"]);
  expect(identityPosts).toBe(0);
  expect(catalogBefore.projects.map(({ id, slug }) => ({ id, slug }))).toEqual([
    { id: alpha.id, slug: alpha.slug },
    { id: beta.id, slug: beta.slug },
  ]);
});

test("projects persist pin/archive through the real hearth, filter and switch without stale selection", async ({
  page,
}) => {
  await page.goto("/index.html#/desktop/projects");
  await expect(
    page.getByRole("button", { name: "Pin Alpha", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Pin Alpha", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unpin Alpha", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.screenshot({ path: test.info().outputPath("projects-home.png") });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Unpin Alpha", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Archive Alpha", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Show", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("combobox", { name: "Show", exact: true })
    .selectOption("archived");
  await expect(
    page.getByRole("article", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Show", exact: true })
    .selectOption("all");
  await page.getByRole("link", { name: "Open Alpha", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/project/${alpha.id}/overview$`));
  await page.goto(
    `/index.html#/desktop/projects?project=${alpha.id}&selectionKind=bead&selectionId=old-selection`,
  );
  await page.getByRole("link", { name: "Open Beta", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/project/${beta.id}/overview$`));
  await expect(page.locator(".af-desktop-project-name")).toHaveText("Beta");
  let persisted: ProjectCatalog;
  try {
    persisted = JSON.parse(readFileSync(catalogFile, "utf8"));
  } catch {
    throw new Error("Fixture catalog is not readable JSON");
  }
  expect(persisted.projects[0]).toMatchObject({ pinned: true, archived: true });
});

test("an unanswered preference is held across navigation until an explicit check", async ({
  page,
}) => {
  let posts = 0;
  await page.route("**/projects/*/preferences", async (route) => {
    posts++;
    await route.abort("failed");
  });
  await page.goto("/index.html#/desktop/projects");
  await page.getByRole("button", { name: "Pin Alpha", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "The preference may have changed" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pin Alpha", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Open Beta", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check project preferences" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check project preferences" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "checked against the hearth" }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test("first-run, corrupt store and filtered-empty states stay distinct", async ({
  page,
}) => {
  writeFileSync(catalogFile, "{");
  await page.goto("/index.html#/desktop/projects");
  await expect(
    page.getByText("Projects could not be loaded", { exact: true }),
  ).toBeVisible();
  writeFileSync(
    catalogFile,
    JSON.stringify({ version: 1, revision: 0, projects: [] }),
  );
  await page.getByRole("button", { name: "Refresh projects" }).click();
  await expect(
    page.getByText("Welcome to Agent Forge", { exact: true }),
  ).toBeVisible();
  writeFileSync(catalogFile, JSON.stringify(catalog));
  await page.getByRole("button", { name: "Refresh projects" }).click();
  await page.getByLabel("Find projects").fill("No match");
  await expect(
    page.getByText("No matching projects", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Skip provider setup", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Find projects").fill("");
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.getByRole("link", { name: "Open Alpha", exact: true }).focus();
  expect(
    await page
      .getByRole("link", { name: "Open Alpha", exact: true })
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/project/${alpha.id}/overview$`));
});

test("project color IDs keep their paired tile styles after reload without a write", async ({
  page,
}) => {
  const projects = [
    alpha,
    projectFixture(workspace, { ...beta, color: "default" }),
    projectFixture(workspace, {
      id: "project-c5832fa0-7a21-403b-8184-44892f0d8d86",
      slug: "green",
      name: "Green",
      color: "green",
    }),
    projectFixture(workspace, {
      id: "project-d5832fa0-7a21-403b-8184-44892f0d8d86",
      slug: "blue",
      name: "Blue",
      color: "blue",
    }),
  ];
  writeFileSync(
    catalogFile,
    JSON.stringify({ version: 1, revision: 4, projects }),
  );
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/__agent-forge/projects")) posts.push(path);
  });

  await openSettled(page, "/index.html#/desktop/projects");
  const styles = async () => {
    const result: Record<string, { background: string; foreground: string }> =
      {};
    for (const name of ["Alpha", "Beta", "Green", "Blue"]) {
      const tile = page
        .getByRole("article", { name, exact: true })
        .locator(".af-project-tile");
      await expect(tile).toBeVisible();
      result[name] = await tile.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, foreground: style.color };
      });
    }
    return result;
  };
  const beforeReload = await styles();
  expect(beforeReload).toEqual({
    Alpha: {
      background: "rgb(53, 57, 78)",
      foreground: "rgb(233, 233, 237)",
    },
    Beta: {
      background: "rgb(53, 57, 78)",
      foreground: "rgb(233, 233, 237)",
    },
    Green: {
      background: "rgb(220, 241, 230)",
      foreground: "rgb(31, 107, 74)",
    },
    Blue: {
      background: "rgb(219, 229, 255)",
      foreground: "rgb(53, 88, 196)",
    },
  });

  await reloadSettled(page);
  expect(await styles()).toEqual(beforeReload);
  await page
    .locator(".af-projects-grid")
    .screenshot({ path: test.info().outputPath("project-colors.png") });
  expect(posts).toEqual([]);
});

test("a pending post cannot be unlocked by checking early or double clicking", async ({
  page,
}) => {
  let posts = 0;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/projects/*/preferences", async (route) => {
    posts++;
    await held;
    await route.continue();
  });
  await page.goto("/index.html#/desktop/projects");
  const pin = page.getByRole("button", { name: "Pin Alpha", exact: true });
  await expect(pin).toBeEnabled();
  await pin.evaluate((element) => {
    if (!(element instanceof HTMLButtonElement))
      throw new Error("Expected a button");
    element.click();
    element.click();
  });
  await expect(
    page.getByText("Saving project preferences…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check project preferences" }),
  ).toHaveCount(0);
  await expect(pin).toBeDisabled();
  release();
  await expect(
    page.getByRole("button", { name: "Unpin Alpha", exact: true }),
  ).toBeEnabled();
  expect(posts).toBe(1);
});

test("scoped queue counts do not leak and a failed refresh retains labelled last-known cards", async ({
  page,
}) => {
  withStateLock(BD_STAND_IN_STATE, () => {
    const state = readState(BD_STAND_IN_STATE);
    const item = state["alpha-epic"];
    if (!item) throw new Error("Missing fixture epic");
    state["alpha-epic"] = {
      ...item,
      labels: [...(item.labels ?? []), "queue:proposed"],
      metadata: { queue_state: "proposed" },
    };
    writeState(BD_STAND_IN_STATE, state);
  });
  await page.goto("/index.html#/desktop/projects");
  const a = page.getByRole("article", { name: "Alpha", exact: true });
  const b = page.getByRole("article", { name: "Beta", exact: true });
  await expect(a.locator('[data-state="proposed"]')).toHaveText("Proposed 1");
  await expect(b.locator('[data-state="proposed"]')).toHaveText("Proposed 0");
  await page.route("**/projects/summary", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "Fixture hearth unavailable",
      }),
    }),
  );
  await page.getByRole("button", { name: "Refresh projects" }).click();
  await expect(
    page.getByText(/Refresh failed: Fixture hearth unavailable/),
  ).toBeVisible();
  await expect(a.locator('[data-state="proposed"]')).toHaveText("Proposed 1");
  await expect(page.locator(".af-projects-home")).toHaveAttribute(
    "data-last-known",
    "true",
  );
});

test("empty Projects can skip optional provider setup into the guarded create dialog", async ({
  page,
}) => {
  writeFileSync(
    catalogFile,
    JSON.stringify({ version: 1, revision: 1, projects: [] }),
  );
  const effects: string[] = [];
  const keeperStartsBefore = keeperFixtureStarts();
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith("/__agent-forge/providers/") ||
      path.startsWith("/__agent-forge/projects/")
    )
      effects.push(path);
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSettled(page, "/index.html#/desktop/projects");
  await expect(
    page.getByText("Welcome to Agent Forge", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Checking saved project creations…", { exact: true }),
  ).toHaveCount(0);

  const skip = page.getByRole("button", {
    name: "Skip provider setup",
    exact: true,
  });
  await expect(skip).toBeVisible();
  await expect(skip).toBeEnabled();
  const skipBox = await skip.boundingBox();
  expect(skipBox?.height ?? 0).toBeGreaterThanOrEqual(24);
  await page.screenshot({
    path: test.info().outputPath("onboarding-first-project.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);

  let skipReceivedFocus = false;
  for (let tab = 0; tab < 40 && !skipReceivedFocus; tab++) {
    await page.keyboard.press("Tab");
    skipReceivedFocus = await skip.evaluate(
      (element) => element === document.activeElement,
    );
  }
  expect(skipReceivedFocus).toBe(true);
  expect(
    await skip.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  await page.keyboard.press("Enter");
  const createDialog = page.getByRole("dialog", { name: "Create a project" });
  await expect(createDialog).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.screenshot({
    path: test.info().outputPath("onboarding-empty-projects.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .press("Enter");
  await expect(createDialog).toBeHidden();
  await expect(skip).toBeFocused();
  expect(effects).toEqual([]);
  expect(keeperFixtureStarts()).toBe(keeperStartsBefore);
});

test("empty Projects keep provider setup skippable disabled without a trusted workspace", async ({
  page,
}) => {
  writeFileSync(
    catalogFile,
    JSON.stringify({ version: 1, revision: 1, projects: [] }),
  );
  await page.route("**/providers/readiness", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "Fixture readiness unavailable",
      }),
    }),
  );
  const effects: string[] = [];
  const keeperStartsBefore = keeperFixtureStarts();
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith("/__agent-forge/providers/") ||
      path.startsWith("/__agent-forge/projects/")
    )
      effects.push(path);
  });

  await openSettled(page, "/index.html#/desktop/projects");
  await expect(
    page.getByText("Welcome to Agent Forge", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No readiness report. Provider status is unknown.", {
      exact: true,
    }),
  ).toBeVisible();
  const skip = page.getByRole("button", {
    name: "Skip provider setup",
    exact: true,
  });
  await expect(skip).toBeVisible();
  await expect(skip).toBeDisabled();
  expect(effects).toEqual([]);
  expect(keeperFixtureStarts()).toBe(keeperStartsBefore);
});

test("empty Projects keep a reserved original reviewable without enabling Skip", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/desktop/projects");
  const saved = await reserveFromProjectFlow(page, {
    slug: "held-onboarding-project",
    name: "Held onboarding project",
  });
  const effects: string[] = [];
  const keeperStartsBefore = keeperFixtureStarts();
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (
      path.startsWith("/__agent-forge/projects/create-reservations") ||
      path.startsWith("/__agent-forge/keeper/") ||
      path.startsWith("/__agent-forge/providers/")
    )
      effects.push(path);
  });
  writeFileSync(
    catalogFile,
    JSON.stringify({ version: 1, revision: catalog.revision, projects: [] }),
  );

  await page.getByRole("button", { name: "Refresh projects" }).click();
  await expect(
    page.getByText("Welcome to Agent Forge", { exact: true }),
  ).toBeVisible();
  const skip = page.getByRole("button", {
    name: "Skip provider setup",
    exact: true,
  });
  await expect(skip).toBeDisabled();
  const reviewButton = page.getByRole("button", {
    name: "Review reserved project",
    exact: true,
  });
  await expect(reviewButton).toBeVisible();
  await reviewButton.click();
  const reviewDialog = page.getByRole("dialog", {
    name: "Review saved project original",
  });
  await expect(reviewDialog).toBeVisible();
  await expect(reviewDialog).toContainText(saved.original.name);
  await expect(reviewDialog).toContainText(saved.requestId);
  await expect(reviewDialog).toContainText(saved.requestHash);
  await page.keyboard.press("Escape");
  await expect(reviewDialog).not.toBeVisible();
  expect(effects).toEqual([]);
  expect(keeperFixtureStarts()).toBe(keeperStartsBefore);
});

test("empty Projects label a provider snapshot as last-known after readiness refresh fails", async ({
  page,
}) => {
  writeFileSync(
    catalogFile,
    JSON.stringify({ version: 1, revision: 1, projects: [] }),
  );
  let readinessReads = 0;
  await page.route("**/providers/readiness", async (route) => {
    readinessReads++;
    if (readinessReads === 1) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        data: null,
        error: "Fixture readiness unavailable",
      }),
    });
  });

  const firstRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/providers/readiness") &&
      response.status() === 200,
  );
  await openSettled(page, "/index.html#/desktop/projects");
  expect((await firstRead).status()).toBe(200);
  await expect(
    page.getByRole("region", { name: "Provider readiness snapshot" }),
  ).toBeVisible();
  await expect(
    page.getByText("Provider report", { exact: false }),
  ).toBeVisible();

  const failedRefresh = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/providers/readiness") &&
      response.status() === 503,
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await failedRefresh;
  await expect(
    page.getByText("Last-known provider report", { exact: false }),
  ).toBeVisible();
  const providerRows = page
    .getByRole("region", { name: "Provider readiness snapshot" })
    .getByRole("listitem");
  const providerCount = await providerRows.count();
  expect(providerCount).toBeGreaterThan(0);
  for (let index = 0; index < providerCount; index++) {
    await expect(
      providerRows
        .nth(index)
        .getByText("Last-known observation; recheck before relying on it.", {
          exact: true,
        }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Skip provider setup", exact: true }),
  ).toBeEnabled();
});
