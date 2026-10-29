import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { buildChildEnv } from "../executors/env";
import type { InteractiveSupervised } from "../executors/supervisor";
import { supervise } from "../executors/supervisor";
import { writeOwnerOnly } from "../hearth/token";
import { resolveCheckout } from "../ledger/workspace";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  type ApprovedRepository,
  approvedRepositoryRegistrySchema,
  approvedRepositorySchema,
  projectRepositoryNameSchema,
  type RepositoryClone,
  type RepositorySelection,
  repositoryCloneSchema,
  repositorySelectionSchema,
} from "./repository-onboarding-protocol";
import { workspaceKey } from "./scope";

export type {
  ApprovedRepository,
  RepositoryClone,
  RepositorySelection,
} from "./repository-onboarding-protocol";
export {
  approvedRepositoryRegistrySchema,
  approvedRepositorySchema,
  projectRepositoryNameSchema,
  repositoryCloneSchema,
  repositorySelectionSchema,
} from "./repository-onboarding-protocol";

const repositoryName = projectRepositoryNameSchema;
export interface RepositoryCommandResult {
  exitCode: number;
  stdout: string;
}
export type RepositoryCommand = (
  command: readonly string[],
  cwd: string,
) => Promise<RepositoryCommandResult>;
export interface RepositoryOnboardingOptions {
  home: string;
  workspace: string;
  registryRoot: string;
  legacyRegistryRoot?: string;
  pickerCommand?: readonly string[];
  runGit?: RepositoryCommand;
  runPicker?: RepositoryCommand;
  allowLocalFixtureUrls?: boolean;
  now?: () => Date;
}

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_NATIVE_OUTPUT_BYTES = 4096;
const PICKER_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 10_000;
const MAX_CLONE_OUTPUT_BYTES = 64 * 1024;
const MAX_VERIFY_OUTPUT_BYTES = 4096;
class InvalidGitRepository extends Error {}

function checkedId(value: string): string {
  if (!requestId.safeParse(value).success)
    throw new Error("Invalid repository operation id.");
  return value;
}
function checkedName(value: string): string {
  const checked = repositoryName.safeParse(value);
  if (!checked.success) throw new Error("Choose a valid repository name.");
  return checked.data;
}
function checkedHttpsUrl(
  value: string,
  allowLocalFixtureUrls: boolean,
): string {
  if (value.length > 2048 || /[\p{Cc}\p{Cs}]/u.test(value))
    throw new Error("Enter a valid HTTPS repository URL.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Enter a valid HTTPS repository URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port && parsed.port !== "443") ||
    (!allowLocalFixtureUrls &&
      (!parsed.hostname.includes(".") || parsed.hostname === "localhost"))
  )
    throw new Error(
      "Use an HTTPS repository URL without credentials or query data.",
    );
  return parsed.href;
}
function canonicalGitRoot(path: string): string {
  if (path.length > 1024)
    throw new Error("The selected repository path is too long.");
  const canonical = realpathSync.native(path);
  const directory = lstatSync(canonical);
  const git = lstatSync(join(canonical, ".git"));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    git.isSymbolicLink() ||
    (!git.isDirectory() && !git.isFile())
  )
    throw new Error("Choose the root folder of a Git repository.");
  const checkout = resolveCheckout(canonical);
  if (resolve(checkout.worktree) !== resolve(canonical))
    throw new Error("Choose the canonical root of a Git repository.");
  return canonical;
}
async function runCommand(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<RepositoryCommandResult> {
  if (
    !command.length ||
    command.some((part) => !part || part.includes("\0") || part.length > 8192)
  )
    throw new Error("Repository command unavailable.");
  const lines: string[] = [];
  let bytes = 0;
  let oversized = false;
  let handle: InteractiveSupervised | undefined;
  try {
    handle = supervise({
      command: [...command],
      cwd,
      env: {
        ...buildChildEnv(process.env, []),
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdinMode: "interactive",
      timeoutMs,
      windowsHide: true,
      maxLineBytes: 4096,
      onLine(line) {
        bytes += Buffer.byteLength(line, "utf8") + 1;
        if (bytes > maxOutputBytes) {
          oversized = true;
          void handle
            ?.stop("repository output exceeded its limit")
            .catch(() => undefined);
        } else lines.push(line);
      },
      onOutputError() {
        oversized = true;
        void handle
          ?.stop("repository output exceeded its line limit")
          .catch(() => undefined);
      },
    });
  } catch {
    throw new Error("Repository command could not be supervised.");
  }
  if (!handle) throw new Error("Repository command could not be supervised.");
  const done = handle.done;
  void done.catch(() => undefined);
  void handle.end().catch(() => undefined);
  try {
    const result = await done;
    if (result.ownedTreeReleased !== true)
      throw new Error("Repository process cleanup was not confirmed.");
    if (result.timedOut || result.stopped)
      throw new Error(
        "Repository operation timed out; check its saved status.",
      );
    if (oversized)
      throw new Error("Repository command output exceeded its limit.");
    return { exitCode: result.exitCode, stdout: lines.join("\n") };
  } catch {
    await handle.stop("repository operation cleanup").catch(() => undefined);
    await done.catch(() => undefined);
    throw new Error(
      "Repository operation did not complete with confirmed cleanup.",
    );
  }
}
function writeAtomic(file: string, value: unknown): void {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content, "utf8") > MAX_RECORD_BYTES)
    throw new Error("Repository operation record exceeded its limit.");
  mkdirSync(join(file, ".."), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    writeOwnerOnly(temporary, content);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
function readRecord<T>(
  file: string,
  schema: z.ZodType<T>,
  home: string,
): T | null {
  const parent = dirname(file);
  const relativeParent = relative(home, parent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${sep}`) ||
    isAbsolute(relativeParent)
  )
    throw new Error("The saved repository operation is unavailable.");
  const directories = [home];
  let current = home;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, segment);
    directories.push(current);
  }
  const directoryStats: Array<{ path: string; dev: number; ino: number }> = [];
  const verifyDirectories = () => {
    for (const directory of directoryStats) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(directory.path);
      } catch {
        throw new Error("The saved repository operation is unavailable.");
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.dev !== directory.dev ||
        stat.ino !== directory.ino
      )
        throw new Error("The saved repository operation is unavailable.");
    }
  };
  for (const directory of directories) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        verifyDirectories();
        return null;
      }
      throw new Error("The saved repository operation is unavailable.");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("The saved repository operation is unavailable.");
    directoryStats.push({ path: directory, dev: stat.dev, ino: stat.ino });
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      verifyDirectories();
      return null;
    }
    throw new Error("The saved repository operation is unavailable.");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECORD_BYTES)
    throw new Error("The saved repository operation is unavailable.");
  try {
    const content = readFileSync(file, "utf8");
    const afterRead = lstatSync(file);
    if (
      afterRead.isSymbolicLink() ||
      !afterRead.isFile() ||
      afterRead.dev !== stat.dev ||
      afterRead.ino !== stat.ino ||
      afterRead.size !== stat.size ||
      afterRead.mtimeMs !== stat.mtimeMs
    )
      throw new Error();
    verifyDirectories();
    const parsed = schema.safeParse(JSON.parse(content));
    if (!parsed.success) throw new Error();
    return parsed.data;
  } catch {
    throw new Error("The saved repository operation is unavailable.");
  }
}

export function createRepositoryOnboarding(
  options: RepositoryOnboardingOptions,
) {
  const home = resolve(options.home);
  const registryRoot = resolve(options.registryRoot);
  const workspace = resolveCheckout(options.workspace).workspace;
  const trustedWorkspaceKey = workspaceKey(workspace);
  const records = join(home, "project-repository-onboarding");
  const lockFile = join(records, "transaction.lock.db");
  const selectionPath = (id: string) =>
    join(records, "selections", checkedId(id) + ".json");
  const clonePath = (id: string) =>
    join(records, "clones", checkedId(id) + ".json");
  const manifestFile = join(registryRoot, "approved-repositories.json");
  const now = options.now ?? (() => new Date());
  const command =
    options.runGit ??
    ((argv, cwd) =>
      runCommand(argv, cwd, CLONE_TIMEOUT_MS, MAX_CLONE_OUTPUT_BYTES));
  const verifyCommand =
    options.runGit ??
    ((argv, cwd) =>
      runCommand(argv, cwd, VERIFY_TIMEOUT_MS, MAX_VERIFY_OUTPUT_BYTES));
  const picker =
    options.runPicker ??
    ((argv, cwd) =>
      runCommand(argv, cwd, PICKER_TIMEOUT_MS, MAX_NATIVE_OUTPUT_BYTES));
  function ensureRecordDirectory(kind: "selections" | "clones"): string {
    mkdirSync(home, { recursive: true });
    const homeStat = lstatSync(home);
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory())
      throw new Error("Repository operation storage is unavailable.");
    try {
      mkdirSync(records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("Repository operation storage is unavailable.");
    }
    const rootStat = lstatSync(records);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw new Error("Repository operation storage is unavailable.");
    const directory = join(records, kind);
    try {
      mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("Repository operation storage is unavailable.");
    }
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Repository operation storage is unavailable.");
    return directory;
  }
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    ensureRecordDirectory("selections");
    ensureRecordDirectory("clones");
    try {
      const stat = lstatSync(lockFile);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Repository operation lock is unavailable.");
    }
    const result = await withQueueLock(lockFile, work, { waitMs: 120_000 });
    if (!result.ok)
      throw new Error(
        "Repository onboarding is busy or unavailable; nothing was repeated.",
      );
    return result.value;
  }
  function checkRegistryDirectories(create: boolean): void {
    let homeStat: ReturnType<typeof lstatSync>;
    try {
      homeStat = lstatSync(home);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return;
      throw new Error("Repository registry is unavailable.");
    }
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory())
      throw new Error("Repository registry is unavailable.");
    const pathFromHome = relative(home, registryRoot);
    if (
      !pathFromHome ||
      pathFromHome === ".." ||
      pathFromHome.startsWith(`..${sep}`) ||
      isAbsolute(pathFromHome)
    )
      throw new Error("Repository registry is outside the hearth home.");
    let current = home;
    for (const segment of pathFromHome.split(sep)) {
      current = join(current, segment);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw new Error("Repository registry is unavailable.");
        }
        try {
          mkdirSync(current);
          stat = lstatSync(current);
        } catch {
          throw new Error("Repository registry is unavailable.");
        }
      }
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Repository registry is unavailable.");
    }
  }
  function ensureRegistryDirectories(): void {
    checkRegistryDirectories(true);
  }
  function ensureCloneDirectories(): void {
    ensureRegistryDirectories();
    const repos = join(registryRoot, "repos");
    try {
      mkdirSync(repos);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("Repository registry is unavailable.");
    }
    const stat = lstatSync(repos);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Repository registry is unavailable.");
  }
  function checkedWorkspace<T extends { workspaceKey: string }>(record: T): T {
    if (record.workspaceKey !== trustedWorkspaceKey)
      throw new Error(
        "The saved repository operation belongs to another workspace.",
      );
    return record;
  }
  async function verifyGitRoot(path: string): Promise<string> {
    let canonical: string;
    try {
      canonical = canonicalGitRoot(path);
    } catch {
      throw new InvalidGitRepository();
    }
    const result = await verifyCommand(
      ["git", "-C", canonical, "rev-parse", "--show-toplevel"],
      options.workspace,
    );
    if (
      result.exitCode !== 0 ||
      result.stdout.length > MAX_VERIFY_OUTPUT_BYTES ||
      result.stdout.includes("\n")
    )
      throw new InvalidGitRepository();
    let reported: string;
    try {
      reported = realpathSync.native(result.stdout.trim());
    } catch {
      throw new InvalidGitRepository();
    }
    if (
      !result.stdout.trim() ||
      workspaceKey(reported) !== workspaceKey(canonical)
    )
      throw new InvalidGitRepository();
    return canonical;
  }
  function assertCloneNameAvailable(name: string, requestId: string): void {
    const directory = ensureRecordDirectory("clones");
    const savedNames = readdirSync(directory);
    if (savedNames.length > 128)
      throw new Error("The saved repository operation limit was reached.");
    for (const entry of savedNames) {
      if (!entry.endsWith(".json"))
        throw new Error("The saved repository operations are unavailable.");
      const saved = readRecord(
        join(directory, entry),
        repositoryCloneSchema,
        home,
      );
      if (!saved)
        throw new Error("The saved repository operations are unavailable.");
      checkedWorkspace(saved);
      if (
        saved.requestId !== requestId &&
        saved.name.toLowerCase() === name.toLowerCase()
      )
        throw new Error(
          "This repository name is already reserved by another saved request.",
        );
    }
  }

  function readRegistry(): z.infer<typeof approvedRepositoryRegistrySchema> {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(manifestFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, repositories: [] };
      throw new Error("The approved repository registry is unavailable.");
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECORD_BYTES)
      throw new Error("The approved repository registry is unavailable.");
    try {
      const content = readFileSync(manifestFile, "utf8");
      const afterRead = lstatSync(manifestFile);
      if (
        afterRead.isSymbolicLink() ||
        !afterRead.isFile() ||
        afterRead.dev !== stat.dev ||
        afterRead.ino !== stat.ino ||
        afterRead.size !== stat.size ||
        afterRead.mtimeMs !== stat.mtimeMs
      )
        throw new Error();
      const parsed = approvedRepositoryRegistrySchema.safeParse(
        JSON.parse(content),
      );
      if (!parsed.success) throw new Error();
      return parsed.data;
    } catch {
      throw new Error("The approved repository registry is unavailable.");
    }
  }
  function writeRegistry(
    registry: z.infer<typeof approvedRepositoryRegistrySchema>,
  ): void {
    writeAtomic(manifestFile, approvedRepositoryRegistrySchema.parse(registry));
  }
  function approvedRepositories(): ApprovedRepository[] {
    checkRegistryDirectories(false);
    return readRegistry().repositories;
  }
  function legacyRepositories(): Array<{ name: string; path: string | null }> {
    const file = join(
      options.legacyRegistryRoot ?? options.workspace,
      "repos",
      "repos.json",
    );
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("The existing repository registry is unavailable.");
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECORD_BYTES)
      throw new Error("The existing repository registry is unavailable.");
    let parsed: unknown;
    try {
      const text = readFileSync(file, "utf8");
      const afterRead = lstatSync(file);
      if (
        afterRead.isSymbolicLink() ||
        !afterRead.isFile() ||
        afterRead.dev !== stat.dev ||
        afterRead.ino !== stat.ino ||
        afterRead.size !== stat.size ||
        afterRead.mtimeMs !== stat.mtimeMs
      )
        throw new Error();
      parsed = JSON.parse(text);
    } catch {
      throw new Error("The existing repository registry is unavailable.");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => key !== "repos") ||
      !Array.isArray((parsed as { repos?: unknown }).repos)
    )
      throw new Error("The existing repository registry is unavailable.");
    const entries = (parsed as { repos: unknown[] }).repos;
    if (entries.length > 128)
      throw new Error("The existing repository registry is unavailable.");
    return entries.map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("The existing repository registry is unavailable.");
      const row = value as Record<string, unknown>;
      if (
        typeof row.name !== "string" ||
        !repositoryName.safeParse(row.name).success ||
        Object.keys(row).some(
          (key) => !["name", "url", "defaultBranch", "archived"].includes(key),
        )
      )
        throw new Error("The existing repository registry is unavailable.");
      const path = join(
        options.legacyRegistryRoot ?? options.workspace,
        "repos",
        row.name,
      );
      try {
        const directory = lstatSync(path);
        const git = lstatSync(join(path, ".git"));
        return {
          name: row.name,
          path:
            directory.isDirectory() &&
            !directory.isSymbolicLink() &&
            !git.isSymbolicLink() &&
            (git.isDirectory() || git.isFile())
              ? resolveCheckout(path).worktree
              : null,
        };
      } catch {
        return { name: row.name, path: null };
      }
    });
  }
  function registerVerified(
    nameInput: string,
    path: string,
    idInput: string,
    source: "folder" | "clone",
  ): ApprovedRepository {
    const name = checkedName(nameInput);
    const id = checkedId(idInput);
    if (workspaceKey(path) === trustedWorkspaceKey)
      throw new Error("The served workspace is already available.");
    ensureRegistryDirectories();
    const registry = readRegistry();
    const key = workspaceKey(path);
    const legacy = legacyRepositories();
    assertCloneNameAvailable(name, id);
    if (legacy.some((row) => row.name.toLowerCase() === name.toLowerCase()))
      throw new Error("A repository with this name is already registered.");
    if (
      legacy.some((row) => row.path !== null && workspaceKey(row.path) === key)
    )
      throw new Error("This canonical repository is already registered.");
    const sameId = registry.repositories.find(
      (row) => row.originalRequestId === id,
    );
    if (sameId) {
      if (
        sameId.name === name &&
        sameId.path === path &&
        sameId.source === source
      )
        return sameId;
      throw new Error(
        "This repository operation is already bound to another choice.",
      );
    }
    if (
      registry.repositories.some(
        (row) => row.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error("A repository with this name is already registered.");
    if (registry.repositories.some((row) => row.key === key))
      throw new Error("This canonical repository is already registered.");
    const entry: ApprovedRepository = {
      name,
      path,
      key,
      originalRequestId: id,
      source,
    };
    writeRegistry({
      version: 1,
      repositories: [...registry.repositories, entry],
    });
    return entry;
  }
  async function register(
    nameInput: string,
    pathInput: string,
    idInput: string,
    source: "folder" | "clone",
  ): Promise<ApprovedRepository> {
    return registerVerified(
      nameInput,
      await verifyGitRoot(pathInput),
      idInput,
      source,
    );
  }

  async function selectFolder(idInput: string): Promise<RepositorySelection> {
    const id = checkedId(idInput);
    const file = selectionPath(id);
    return locked(async () => {
      const previous = readRecord(file, repositorySelectionSchema, home);
      if (previous) return checkedWorkspace(previous);
      const prepared: RepositorySelection = {
        version: 1,
        workspaceKey: trustedWorkspaceKey,
        requestId: id,
        state: "unknown",
        path: null,
        createdAt: now().toISOString(),
      };
      writeAtomic(file, prepared);
      if (!options.pickerCommand?.length) return prepared;
      try {
        const result = await picker(options.pickerCommand, options.workspace);
        if (Buffer.byteLength(result.stdout, "utf8") > MAX_NATIVE_OUTPUT_BYTES)
          throw new Error();
        const reply = z
          .object({
            ok: z.boolean(),
            data: z
              .object({ path: z.string().max(1024).nullable() })
              .strict()
              .nullable(),
            error: z.string().max(100).nullable(),
          })
          .strict()
          .parse(JSON.parse(result.stdout));
        if (
          !reply.ok ||
          result.exitCode !== 0 ||
          reply.data === null ||
          reply.error !== null
        )
          throw new Error();
        const selected = reply.data.path;
        let saved: RepositorySelection;
        if (selected === null)
          saved = repositorySelectionSchema.parse({
            ...prepared,
            state: "cancelled",
            path: null,
          });
        else {
          try {
            saved = repositorySelectionSchema.parse({
              ...prepared,
              state: "selected",
              path: await verifyGitRoot(selected),
            });
          } catch (error) {
            if (!(error instanceof InvalidGitRepository)) throw error;
            saved = repositorySelectionSchema.parse({
              ...prepared,
              state: "rejected",
              path: null,
            });
          }
        }
        writeAtomic(file, saved);
        return saved;
      } catch {
        const unknown = repositorySelectionSchema.parse({
          ...prepared,
          state: "unknown",
        });
        writeAtomic(file, unknown);
        return unknown;
      }
    });
  }
  function getSelection(id: string): RepositorySelection | null {
    const record = readRecord(
      selectionPath(id),
      repositorySelectionSchema,
      home,
    );
    return record === null ? null : checkedWorkspace(record);
  }
  async function registerSelection(
    idInput: string,
    name: string,
  ): Promise<ApprovedRepository> {
    const id = checkedId(idInput);
    return locked(async () => {
      const selection = getSelection(id);
      if (
        !selection ||
        selection.state !== "selected" ||
        selection.path === null
      )
        throw new Error(
          "The selected repository is not confirmed. Nothing was registered.",
        );
      return await register(name, selection.path, id, "folder");
    });
  }

  async function reserveClone(
    idInput: string,
    nameInput: string,
    urlInput: string,
  ): Promise<RepositoryClone> {
    const id = checkedId(idInput);
    const name = checkedName(nameInput);
    const url = checkedHttpsUrl(
      urlInput,
      options.allowLocalFixtureUrls === true,
    );
    const file = clonePath(id);
    return locked(async () => {
      const previous = readRecord(file, repositoryCloneSchema, home);
      if (previous) {
        checkedWorkspace(previous);
        if (previous.name !== name || previous.url !== url)
          throw new Error(
            "This clone request id is already bound to another original.",
          );
        return previous;
      }
      checkRegistryDirectories(false);
      const registry = readRegistry();
      const legacy = legacyRepositories();
      if (
        registry.repositories.some(
          (row) => row.name.toLowerCase() === name.toLowerCase(),
        ) ||
        legacy.some((row) => row.name.toLowerCase() === name.toLowerCase())
      )
        throw new Error("A repository with this name is already registered.");
      assertCloneNameAvailable(name, id);
      const path = join(registryRoot, "repos", name);
      try {
        lstatSync(path);
        throw new Error(
          "Clone destination already exists; nothing was overwritten.",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const operation = repositoryCloneSchema.parse({
        version: 1,
        workspaceKey: trustedWorkspaceKey,
        requestId: id,
        name,
        url,
        state: "reserved",
        path,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      });
      writeAtomic(file, operation);
      return operation;
    });
  }
  async function clone(idInput: string): Promise<RepositoryClone> {
    const id = checkedId(idInput);
    const file = clonePath(id);
    return locked(async () => {
      const current = readRecord(file, repositoryCloneSchema, home);
      if (!current)
        throw new Error("The exact clone review could not be recovered.");
      checkedWorkspace(current);
      if (current.state !== "reserved") return current;
      let running: RepositoryClone | null = null;
      try {
        ensureCloneDirectories();
        try {
          lstatSync(current.path);
          throw new Error(
            "Clone destination already exists; nothing was overwritten.",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        running = repositoryCloneSchema.parse({
          ...current,
          state: "running",
          updatedAt: now().toISOString(),
        });
        writeAtomic(file, running);
        const result = await command(
          [
            "git",
            "-c",
            "credential.interactive=never",
            "clone",
            "--quiet",
            "--",
            current.url,
            current.path,
          ],
          options.workspace,
        );
        if (result.exitCode !== 0) {
          const failed = repositoryCloneSchema.parse({
            ...running,
            state: "failed",
            updatedAt: now().toISOString(),
          });
          writeAtomic(file, failed);
          return failed;
        }
        let verifiedPath: string;
        try {
          verifiedPath = await verifyGitRoot(current.path);
        } catch {
          const failed = repositoryCloneSchema.parse({
            ...running,
            state: "failed",
            updatedAt: now().toISOString(),
          });
          writeAtomic(file, failed);
          return failed;
        }
        const completed = repositoryCloneSchema.parse({
          ...running,
          state: "clone-complete",
          updatedAt: now().toISOString(),
        });
        writeAtomic(file, completed);
        try {
          registerVerified(
            current.name,
            verifiedPath,
            current.requestId,
            "clone",
          );
          const registered = repositoryCloneSchema.parse({
            ...completed,
            state: "registered",
            updatedAt: now().toISOString(),
          });
          writeAtomic(file, registered);
          return registered;
        } catch {
          return completed;
        }
      } catch {
        if (running === null)
          return repositoryCloneSchema.parse({
            ...current,
            state: "unknown",
            updatedAt: now().toISOString(),
          });
        const unknown = repositoryCloneSchema.parse({
          ...running,
          state: "unknown",
          updatedAt: now().toISOString(),
        });
        try {
          writeAtomic(file, unknown);
        } catch {
          /* Preserve the last durable original. */
        }
        return unknown;
      }
    });
  }
  async function registerClone(idInput: string): Promise<RepositoryClone> {
    const id = checkedId(idInput);
    return locked(async () => {
      const file = clonePath(id);
      const current = readRecord(file, repositoryCloneSchema, home);
      if (!current)
        throw new Error("The exact clone review could not be recovered.");
      checkedWorkspace(current);
      if (current.state === "registered") return current;
      if (current.state !== "clone-complete")
        throw new Error("Only a confirmed completed clone can be registered.");
      const path = await verifyGitRoot(current.path);
      registerVerified(current.name, path, current.requestId, "clone");
      const registered = repositoryCloneSchema.parse({
        ...current,
        state: "registered",
        updatedAt: now().toISOString(),
      });
      writeAtomic(file, registered);
      return registered;
    });
  }
  function getClone(id: string): RepositoryClone | null {
    const record = readRecord(clonePath(id), repositoryCloneSchema, home);
    return record === null ? null : checkedWorkspace(record);
  }

  return {
    approvedRepositories,
    selectFolder,
    getSelection,
    registerSelection,
    reserveClone,
    clone,
    registerClone,
    getClone,
  };
}
