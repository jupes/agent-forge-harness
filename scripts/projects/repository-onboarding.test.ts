import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { createRepositoryOnboarding } from "./repository-onboarding";
import { workspaceKey } from "./scope";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "af-repository-onboarding-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const registryRoot = join(home, "project-create-registry");
  const external = join(root, "external-repository");
  const gitConfig = join(root, "gitconfig");
  writeFileSync(gitConfig, "");
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  initGit(workspace, false, gitEnv);
  initGit(external, false, gitEnv);
  return { root, workspace, home, registryRoot, external, gitEnv };
}
function initGit(path: string, bare = false, env?: NodeJS.ProcessEnv): void {
  mkdirSync(path, { recursive: true });
  const result = Bun.spawnSync(
    ["git", "init", ...(bare ? ["--bare"] : []), "--quiet", path],
    { stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env }) },
  );
  if (result.exitCode !== 0)
    throw new Error("Could not prepare the inert Git fixture.");
}
async function fixtureGit(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string }> {
  const result = Bun.spawnSync([...command], {
    stdout: "pipe",
    stderr: "ignore",
    env,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8").trim(),
  };
}
const id = "d134a802-6d1c-47c4-a001-3f5f83d38d33";

test("missing readback does not create repository operation storage", () => {
  const paths = fixture();
  const service = createRepositoryOnboarding(paths);
  expect(service.getSelection(id)).toBeNull();
  expect(service.getClone(id)).toBeNull();
  expect(service.approvedRepositories()).toEqual([]);
  expect(existsSync(paths.home)).toBe(false);
});

test("folder selection is durably recoverable and registration uses only its selected identity", async () => {
  const paths = fixture();
  let pickerCalls = 0;
  const service = createRepositoryOnboarding({
    ...paths,
    pickerCommand: ["native-helper", "--choose-project-repository"],
    runPicker: async () => {
      pickerCalls++;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { path: paths.external },
          error: null,
        }),
      };
    },
  });
  const selected = await service.selectFolder(id);
  expect(selected).toMatchObject({ state: "selected", path: paths.external });
  expect(await service.selectFolder(id)).toEqual(selected);
  expect(pickerCalls).toBe(1);
  expect(service.getSelection(id)).toEqual(selected);
  const registered = await service.registerSelection(id, "external-repo");
  expect(registered).toMatchObject({
    name: "external-repo",
    path: paths.external,
    originalRequestId: id,
    source: "folder",
  });
  expect(service.approvedRepositories()).toEqual([registered]);
});

test("a Windows-namespaced picker path verifies and registers the same Git checkout", async () => {
  const paths = fixture();
  const namespacedPath = toNamespacedPath(paths.external);
  const service = createRepositoryOnboarding({
    ...paths,
    pickerCommand: ["native-helper", "--choose-project-repository"],
    runPicker: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        data: { path: namespacedPath },
        error: null,
      }),
    }),
    runGit: (command) => fixtureGit(command, paths.gitEnv),
  });

  const selected = await service.selectFolder(id);
  expect(selected.state).toBe("selected");
  if (selected.path === null)
    throw new Error("The namespaced Git root was not selected.");
  expect(workspaceKey(realpathSync.native(selected.path))).toBe(
    workspaceKey(realpathSync.native(paths.external)),
  );

  const registered = await service.registerSelection(id, "namespaced-repo");
  expect(registered).toMatchObject({
    name: "namespaced-repo",
    source: "folder",
    originalRequestId: id,
  });
  expect(workspaceKey(realpathSync.native(registered.path))).toBe(
    workspaceKey(realpathSync.native(paths.external)),
  );
  expect(service.approvedRepositories()).toEqual([registered]);
});

test("picker cancellation and invalid selection never register a folder", async () => {
  const paths = fixture();
  const cancelled = createRepositoryOnboarding({
    ...paths,
    pickerCommand: ["native-helper"],
    runPicker: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, data: { path: null }, error: null }),
    }),
  });
  expect((await cancelled.selectFolder(id)).state).toBe("cancelled");
  await expect(cancelled.registerSelection(id, "cancelled")).rejects.toThrow();
  const invalid = createRepositoryOnboarding({
    ...paths,
    pickerCommand: ["native-helper"],
    runPicker: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        data: { path: paths.root },
        error: null,
      }),
    }),
  });
  expect(
    (await invalid.selectFolder("a134a802-6d1c-47c4-a001-3f5f83d38d33")).state,
  ).toBe("rejected");
  expect(invalid.approvedRepositories()).toEqual([]);

  const emptyGit = join(paths.root, "empty-git-marker");
  mkdirSync(join(emptyGit, ".git"), { recursive: true });
  let pickerCalls = 0;
  const emptyMarker = createRepositoryOnboarding({
    ...paths,
    pickerCommand: ["native-helper"],
    runPicker: async () => {
      pickerCalls++;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          data: { path: pickerCalls === 1 ? emptyGit : paths.external },
          error: null,
        }),
      };
    },
  });
  expect(
    (await emptyMarker.selectFolder("b134a802-6d1c-47c4-a001-3f5f83d38d33"))
      .state,
  ).toBe("rejected");
  expect(
    (await emptyMarker.selectFolder("c134a802-6d1c-47c4-a001-3f5f83d38d33"))
      .state,
  ).toBe("selected");
  expect(pickerCalls).toBe(2);
  expect(emptyMarker.approvedRepositories()).toEqual([]);
});

test("corrupt saved outcomes are preserved and request identities stay bound to their workspace", async () => {
  const paths = fixture();
  const record = join(
    paths.home,
    "project-repository-onboarding",
    "selections",
    `${id}.json`,
  );
  mkdirSync(join(paths.home, "project-repository-onboarding", "selections"), {
    recursive: true,
  });
  writeFileSync(record, "{ incomplete");
  let pickerCalls = 0;
  const service = createRepositoryOnboarding({
    ...paths,
    pickerCommand: ["native-helper"],
    runPicker: async () => {
      pickerCalls++;
      return { exitCode: 0, stdout: "{}" };
    },
  });
  await expect(service.selectFolder(id)).rejects.toThrow();
  expect(readFileSync(record, "utf8")).toBe("{ incomplete");
  expect(pickerCalls).toBe(0);

  rmSync(record);
  const first = await service.selectFolder(id);
  expect(first.state).toBe("unknown");
  const otherWorkspace = join(paths.root, "other-workspace");
  initGit(otherWorkspace, false, paths.gitEnv);
  const other = createRepositoryOnboarding({
    ...paths,
    workspace: otherWorkspace,
    pickerCommand: ["native-helper"],
  });
  await expect(other.selectFolder(id)).rejects.toThrow();
});

test("readback refuses a linked operation-record parent without changing its target", async () => {
  const paths = fixture();
  const service = createRepositoryOnboarding({
    ...paths,
    pickerCommand: ["native-helper"],
    runPicker: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, data: { path: null }, error: null }),
    }),
  });
  const saved = await service.selectFolder(id);
  const selections = join(
    paths.home,
    "project-repository-onboarding",
    "selections",
  );
  const target = join(paths.root, "saved-selections-target");
  renameSync(selections, target);
  symlinkSync(target, selections, "junction");
  try {
    expect(() => service.getSelection(id)).toThrow();
    expect(readFileSync(join(target, `${id}.json`), "utf8")).toContain(
      '"state":"cancelled"',
    );
  } finally {
    rmSync(selections);
  }
  expect(saved.state).toBe("cancelled");
});

test("clone review is inert; explicit clone runs once and duplicate effects recover the saved receipt", async () => {
  const paths = fixture();
  const commands: string[][] = [];
  const service = createRepositoryOnboarding({
    ...paths,
    allowLocalFixtureUrls: true,
    runGit: async (command) => {
      if (command.includes("rev-parse"))
        return fixtureGit(command, paths.gitEnv);
      commands.push([...command]);
      initGit(command.at(-1)!, false, paths.gitEnv);
      return { exitCode: 0, stdout: "" };
    },
  });
  const review = await service.reserveClone(
    id,
    "cloned-repo",
    "https://example.invalid/repo.git",
  );
  expect(review.state).toBe("reserved");
  expect(commands).toEqual([]);
  expect(
    await service.reserveClone(
      id,
      "cloned-repo",
      "https://example.invalid/repo.git",
    ),
  ).toEqual(review);
  const cloned = await service.clone(id);
  expect(cloned.state).toBe("registered");
  expect(commands).toEqual([
    [
      "git",
      "-c",
      "credential.interactive=never",
      "clone",
      "--quiet",
      "--",
      "https://example.invalid/repo.git",
      join(paths.registryRoot, "repos", "cloned-repo"),
    ],
  ]);
  expect(await service.clone(id)).toEqual(cloned);
  expect(commands).toHaveLength(1);
  expect(service.approvedRepositories()).toHaveLength(1);
});

test("a completed clone can be registered after a recoverable registration conflict without cloning again", async () => {
  const paths = fixture();
  const legacyRepos = join(paths.workspace, "repos");
  mkdirSync(legacyRepos, { recursive: true });
  writeFileSync(join(legacyRepos, "repos.json"), JSON.stringify({ repos: [] }));
  let commands = 0;
  const service = createRepositoryOnboarding({
    ...paths,
    runGit: async (command) => {
      if (command.includes("rev-parse"))
        return fixtureGit(command, paths.gitEnv);
      commands++;
      initGit(command.at(-1)!, false, paths.gitEnv);
      writeFileSync(
        join(legacyRepos, "repos.json"),
        JSON.stringify({ repos: [{ name: "recovered-clone" }] }),
      );
      return { exitCode: 0, stdout: "" };
    },
  });
  await service.reserveClone(
    id,
    "recovered-clone",
    "https://example.com/repo.git",
  );
  const completed = await service.clone(id);
  expect(completed.state).toBe("clone-complete");
  expect(commands).toBe(1);
  writeFileSync(join(legacyRepos, "repos.json"), JSON.stringify({ repos: [] }));
  expect((await service.registerClone(id)).state).toBe("registered");
  expect((await service.registerClone(id)).state).toBe("registered");
  expect(commands).toBe(1);
});

test("a definitive clone failure preserves its partial destination and cannot launch again", async () => {
  const paths = fixture();
  const destination = join(paths.registryRoot, "repos", "failed-clone");
  const marker = join(destination, "partial-clone-marker");
  let cloneCalls = 0;
  const service = createRepositoryOnboarding({
    ...paths,
    runGit: async (command) => {
      if (command.includes("rev-parse"))
        return fixtureGit(command, paths.gitEnv);
      cloneCalls++;
      mkdirSync(destination, { recursive: true });
      writeFileSync(marker, "preserve this partial destination");
      return { exitCode: 128, stdout: "" };
    },
  });
  await service.reserveClone(
    id,
    "failed-clone",
    "https://example.com/repo.git",
  );

  const failed = await service.clone(id);
  expect(failed.state).toBe("failed");
  expect(service.getClone(id)).toEqual(failed);
  expect((await service.clone(id)).state).toBe("failed");
  expect(cloneCalls).toBe(1);
  expect(readFileSync(marker, "utf8")).toBe(
    "preserve this partial destination",
  );
  expect(service.approvedRepositories()).toEqual([]);
});

test("unknown clone outcomes stay held and reject credential-bearing or query URLs", async () => {
  const paths = fixture();
  let calls = 0;
  const service = createRepositoryOnboarding({
    ...paths,
    allowLocalFixtureUrls: true,
    runGit: async () => {
      calls++;
      throw new Error("private process detail");
    },
  });
  for (const url of [
    "https://user:secret@example.invalid/repo.git",
    "https://example.invalid/repo.git?token=secret",
    "http://example.invalid/repo.git",
  ])
    expect(() => service.reserveClone(id, "repo", url)).toThrow();
  await service.reserveClone(id, "repo", "https://example.invalid/repo.git");
  expect((await service.clone(id)).state).toBe("unknown");
  expect((await service.clone(id)).state).toBe("unknown");
  expect(calls).toBe(1);
  expect(service.approvedRepositories()).toEqual([]);
});
