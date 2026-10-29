import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  projectCreateOptionsSchema,
  projectScopePreviewSchema,
} from "../projects/create-options-protocol";
import { workspaceKey } from "../projects/scope";
import { startTestHearth, type TestHearth } from "./testing";

const opened: TestHearth[] = [];
const FIXTURE_URL = "https://fixture.invalid/repository.git";
const PICK_ID = "d134a802-6d1c-47c4-a001-3f5f83d38d31";
const INVALID_ID = "d134a802-6d1c-47c4-a001-3f5f83d38d32";
const SERVED_ID = "d134a802-6d1c-47c4-a001-3f5f83d38d33";
const REGISTER_ID = "d134a802-6d1c-47c4-a001-3f5f83d38d34";
const CLONE_ID = "d134a802-6d1c-47c4-a001-3f5f83d38d35";
const EPIC_ID = "onboarding-epic";

afterEach(async () => {
  for (const h of opened.splice(0).reverse()) await h.close();
});

function initGit(path: string, env: NodeJS.ProcessEnv, bare = false): void {
  mkdirSync(path, { recursive: true });
  const args = ["git", "init", ...(bare ? ["--bare"] : []), "--quiet", path];
  const result = Bun.spawnSync(args, { stdout: "ignore", stderr: "pipe", env });
  if (result.exitCode !== 0)
    throw new Error("Could not prepare the private Git fixture.");
}

async function json<T = unknown>(response: Response): Promise<{ data: T }> {
  const value: unknown = await response.json();
  expect(value).toMatchObject({ ok: true, error: null });
  return value as { data: T };
}

test("protected repository onboarding recovers exact records and updates checked scope only after explicit effects", async () => {
  let selectedPath: string | null = null;
  let bareRepository = "";
  let fixtureGitEnv: NodeJS.ProcessEnv = process.env;
  let cloneCalls = 0;
  const h = await startTestHearth({
    projectRepositoryPickerCommand: ["fixed-fixture-picker"],
    api: {
      allowLocalRepositoryFixtureUrls: true,
      projectRepositoryRunPicker: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { path: selectedPath },
          error: null,
        }),
      }),
      projectRepositoryRunGit: async (command, cwd) => {
        const actual = [...command];
        if (actual.includes("clone")) {
          cloneCalls++;
          const sourceIndex = actual.length - 2;
          if (actual[sourceIndex] !== FIXTURE_URL)
            throw new Error("Unexpected fixture clone source.");
          actual[sourceIndex] = bareRepository;
        }
        const result = Bun.spawnSync(actual, {
          cwd,
          stdout: "pipe",
          stderr: "ignore",
          env: fixtureGitEnv,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString("utf8").trim(),
        };
      },
    },
  });
  opened.push(h);
  const fixtures = join(h.home, "repository-onboarding-fixtures");
  const external = join(fixtures, "selected-folder");
  const emptyMarker = join(fixtures, "empty-git-marker");
  bareRepository = join(fixtures, "clone-source.git");
  const gitConfig = join(fixtures, "gitconfig");
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(gitConfig, "");
  fixtureGitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  initGit(h.workspace, fixtureGitEnv);
  initGit(external, fixtureGitEnv);
  initGit(bareRepository, fixtureGitEnv, true);
  mkdirSync(join(emptyMarker, ".git"), { recursive: true });
  h.bd.issues.set(EPIC_ID, {
    id: EPIC_ID,
    title: "Onboarding epic",
    issue_type: "epic",
    priority: 2,
    status: "open",
    labels: ["project:onboarding-alpha"],
    created_at: "2026-10-26T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
  });
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout: [...h.bd.issues.values()]
            .map((issue) => JSON.stringify(issue))
            .join("\n"),
          stderr: "",
        }
      : undefined;
  const headers = h.headers(h.hearth.token);
  const post = (path: string, body: unknown) =>
    fetch(`${h.api}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const read = (path: string, authorized = true) =>
    fetch(`${h.api}${path}`, {
      headers: authorized ? headers : h.headers(),
    });

  selectedPath = null;
  const cancelled = await post("/projects/repository-selections", {
    requestId: PICK_ID,
  });
  expect(cancelled.status).toBe(200);
  expect((await json(cancelled)).data).toMatchObject({
    requestId: PICK_ID,
    state: "cancelled",
    path: null,
  });
  expect(
    (await json(await read(`/projects/repository-selections/${PICK_ID}`))).data,
  ).toMatchObject({
    requestId: PICK_ID,
    state: "cancelled",
    path: null,
  });
  const auditedPicks = h.events(["operator.action"]).length;
  expect(
    (await read(`/projects/repository-selections/${PICK_ID}`, false)).status,
  ).toBe(403);
  expect(h.events(["operator.action"])).toHaveLength(auditedPicks);
  expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
    action: "project.repository.pick",
    requestId: PICK_ID,
  });

  selectedPath = emptyMarker;
  const rejected = await post("/projects/repository-selections", {
    requestId: INVALID_ID,
  });
  expect(rejected.status).toBe(200);
  expect((await json(rejected)).data).toMatchObject({
    requestId: INVALID_ID,
    state: "rejected",
    path: null,
  });
  expect(
    (await json(await read(`/projects/repository-selections/${INVALID_ID}`)))
      .data,
  ).toMatchObject({
    requestId: INVALID_ID,
    state: "rejected",
    path: null,
  });
  const rejectedRegistration = await post(
    `/projects/repository-selections/${INVALID_ID}/register`,
    { name: "bad-folder" },
  );
  expect(rejectedRegistration.status).toBe(409);

  selectedPath = h.workspace;
  const servedSelection = await post("/projects/repository-selections", {
    requestId: SERVED_ID,
  });
  expect(servedSelection.status).toBe(200);
  const servedOutcome = (
    await json<{ state: string; path: string | null }>(servedSelection)
  ).data;
  expect(servedOutcome.state).toBe("selected");
  if (servedOutcome.path === null)
    throw new Error("The real served Git root was not selected.");
  expect(workspaceKey(servedOutcome.path)).toBe(workspaceKey(h.workspace));
  const duplicateServed = await post(
    `/projects/repository-selections/${SERVED_ID}/register`,
    { name: "served-workspace-copy" },
  );
  expect(duplicateServed.status).toBe(409);

  selectedPath = external;
  const selection = await post("/projects/repository-selections", {
    requestId: REGISTER_ID,
  });
  expect(selection.status).toBe(200);
  const selectedOutcome = (
    await json<{ requestId: string; state: string; path: string | null }>(
      selection,
    )
  ).data;
  expect(selectedOutcome).toMatchObject({
    requestId: REGISTER_ID,
    state: "selected",
  });
  if (selectedOutcome.path === null)
    throw new Error("The selected folder path was not saved.");
  expect(workspaceKey(selectedOutcome.path)).toBe(workspaceKey(external));
  expect(
    (await json(await read(`/projects/repository-selections/${REGISTER_ID}`)))
      .data,
  ).toEqual(selectedOutcome);
  const registration = await post(
    `/projects/repository-selections/${REGISTER_ID}/register`,
    { name: "selected-folder" },
  );
  expect(registration.status).toBe(200);
  const registeredFolder = (
    await json<{
      name: string;
      path: string;
      source: string;
      originalRequestId: string;
    }>(registration)
  ).data;
  expect(registeredFolder).toMatchObject({
    name: "selected-folder",
    source: "folder",
    originalRequestId: REGISTER_ID,
  });
  expect(workspaceKey(registeredFolder.path)).toBe(workspaceKey(external));
  expect(
    (await json(await read(`/projects/repository-selections/${REGISTER_ID}`)))
      .data,
  ).toMatchObject({
    requestId: REGISTER_ID,
    state: "selected",
    path: external,
  });
  expect(
    h
      .events(["operator.action"])
      .filter(
        (event) =>
          event.kind === "operator.action" &&
          event.payload.action === "project.repository.register",
      ),
  ).toHaveLength(1);

  const beforeClone = await read("/projects/create-options");
  const beforeCloneData = projectCreateOptionsSchema.parse(
    (await json(beforeClone)).data,
  );
  expect(beforeCloneData.repositories).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "selected-folder",
        key: workspaceKey(external),
        served: false,
      }),
    ]),
  );
  expect(beforeCloneData).not.toMatchObject({
    repositories: expect.arrayContaining([
      expect.objectContaining({ name: "served-workspace-copy" }),
    ]),
  });
  const reserved = await post("/projects/repository-clone-reservations", {
    requestId: CLONE_ID,
    name: "cloned-folder",
    url: FIXTURE_URL,
  });
  expect(reserved.status).toBe(200);
  expect((await json(reserved)).data).toMatchObject({
    requestId: CLONE_ID,
    state: "reserved",
    name: "cloned-folder",
  });
  expect(cloneCalls).toBe(0);

  // Discarding this reply models a reload after the one explicit clone effect.
  expect(
    (
      await post(
        `/projects/repository-clone-reservations/${CLONE_ID}/clone`,
        {},
      )
    ).status,
  ).toBe(200);
  const saved = await read(
    `/projects/repository-clone-reservations/${CLONE_ID}`,
  );
  const savedClone = (
    await json<{
      requestId: string;
      state: string;
      name: string;
      path: string;
    }>(saved)
  ).data;
  expect(savedClone).toMatchObject({
    requestId: CLONE_ID,
    state: "registered",
    name: "cloned-folder",
  });
  expect(workspaceKey(savedClone.path)).toBe(
    workspaceKey(
      join(h.home, "project-create-registry", "repos", "cloned-folder"),
    ),
  );
  expect(cloneCalls).toBe(1);
  expect(
    (
      await post(
        `/projects/repository-clone-reservations/${CLONE_ID}/clone`,
        {},
      )
    ).status,
  ).toBe(200);
  expect(cloneCalls).toBe(1);

  const optionsResponse = await read("/projects/create-options");
  const options = projectCreateOptionsSchema.parse(
    (await json(optionsResponse)).data,
  );
  expect(options.repositories).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "selected-folder",
        key: workspaceKey(external),
        served: false,
      }),
      expect.objectContaining({
        name: "cloned-folder",
        key: workspaceKey(
          join(h.home, "project-create-registry", "repos", "cloned-folder"),
        ),
        served: false,
      }),
    ]),
  );
  const query = new URLSearchParams({
    slug: "onboarding-alpha",
    epicId: EPIC_ID,
  });
  const previewResponse = await read(`/projects/create-scope-preview?${query}`);
  const preview = projectScopePreviewSchema.parse(
    (await json(previewResponse)).data,
  );
  expect(preview).toMatchObject({
    complete: true,
    slug: "onboarding-alpha",
    epicIds: [EPIC_ID],
  });
  const acceptedScope = await post("/projects/create-reservations", {
    requestId: "d134a802-6d1c-47c4-a001-3f5f83d38d36",
    expectedCatalogRevision: 0,
    original: {
      slug: "onboarding-alpha",
      name: "Onboarding Alpha",
      description: "Only the registered repositories are accepted.",
      icon: "A",
      keeperSmith: "fixture-keeper",
      color: "green",
      workspaces: [
        {
          root: options.workspace.path,
          repositories: [
            options.workspace.path,
            external,
            join(h.home, "project-create-registry", "repos", "cloned-folder"),
          ],
          epicIds: [EPIC_ID],
        },
      ],
    },
  });
  expect(acceptedScope.status).toBe(201);
  const refusedScope = await post("/projects/create-reservations", {
    requestId: "d134a802-6d1c-47c4-a001-3f5f83d38d37",
    expectedCatalogRevision: 0,
    original: {
      slug: "onboarding-untrusted",
      name: "Untrusted repository",
      description: "An unregistered repository must not pass checked scope.",
      icon: "A",
      keeperSmith: "fixture-keeper",
      color: "green",
      workspaces: [
        {
          root: options.workspace.path,
          repositories: [options.workspace.path, emptyMarker],
          epicIds: [EPIC_ID],
        },
      ],
    },
  });
  expect(refusedScope.status).toBe(400);
});
