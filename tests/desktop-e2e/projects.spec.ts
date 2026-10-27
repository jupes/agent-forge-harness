import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { smithsViewSchema } from "../../apps/desktop/src/smiths-protocol";
import { OPERATOR_HEADER, SURFACE_HEADER } from "../../scripts/hearth/paths";
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
import type { ProjectCatalog } from "../../types/projects";
import { readState, withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { openSettled, reloadSettled } from "../e2e/fixtures";
import { pageToken } from "../e2e/launch-link";
import { BD_STAND_IN_STATE, HEARTH_HOME } from "../e2e/servers";

const catalogFile = join(HEARTH_HOME, "projects", "catalog.json");
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
  await dialog.locator("fieldset").nth(1).getByRole("checkbox").first().check();

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
    const committed = projectCreateIdentitySchema.parse(
      (await commitResponse.json()).data.operation,
    );
    expect(committed.projectId).not.toBeNull();
    createdProjectId = committed.projectId!;
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
    const recoveryRead = page
      .waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            `/__agent-forge/projects/create-reservations/${saved.requestId}` &&
          response.request().method() === "GET",
      )
      .then(async (response) => ({
        status: response.status(),
        body: await response.json(),
      }));
    await page.reload();
    releaseCommitReply();
    await click;
    const recoveredRead = await recoveryRead;
    expect(recoveredRead.status).toBe(200);
    expect(
      projectCreateIdentitySchema.parse(recoveredRead.body.data),
    ).toMatchObject({
      requestId: saved.requestId,
      requestHash: saved.requestHash,
      original: saved.original,
      state: "created",
    });
    expect(
      projectCreateIdentitySchema.parse(recoveredRead.body.data).projectId,
    ).toBe(createdBeforeReload.projectId);
    await expect(
      page.getByRole("link", { name: saved.original.name, exact: true }),
    ).toBeVisible();
    expect(recoveryOriginalReads).toBeGreaterThan(0);
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
