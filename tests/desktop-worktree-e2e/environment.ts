import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

// Imported before the ordinary Playwright config and its shared server constants.
process.env["PORT"] ??= "8891";
process.env["E2E_HEARTH_PORT"] ??= "8890";
export const FIXTURE_ROOT = (process.env[
  "AGENT_FORGE_WORKTREE_FIXTURE_ROOT"
] ||= mkdtempSync(join(tmpdir(), "agent-forge-desktop-worktree-")));
export const REPOSITORY = join(FIXTURE_ROOT, "repository");
/**
 * A dedicated OS home outside FIXTURE_ROOT. The Hearth's process-global config
 * transaction mutex is persistent, so fixture teardown must never remove it.
 */
export const EMPTY_HOME = (process.env["AGENT_FORGE_WORKTREE_OS_HOME"] ||=
  mkdtempSync(join(tmpdir(), "agent-forge-worktree-empty-home-")));
export const PLAN = join(FIXTURE_ROOT, "fixture-plan.json");
export const CALLS = join(FIXTURE_ROOT, "git-calls.jsonl");

export function checkedFixtureRoot() {
  const value = realpathSync.native(FIXTURE_ROOT);
  if (
    lstatSync(FIXTURE_ROOT).isSymbolicLink() ||
    realpathSync.native(dirname(value)) !== realpathSync.native(tmpdir()) ||
    !/^agent-forge-desktop-worktree-[a-zA-Z0-9]+$/.test(basename(value))
  )
    throw new Error(
      "The Git browser fixture is outside its owned temporary directory.",
    );
  return value;
}
export function checkedEmptyHome() {
  const value = realpathSync.native(EMPTY_HOME);
  if (
    lstatSync(EMPTY_HOME).isSymbolicLink() ||
    realpathSync.native(dirname(value)) !== realpathSync.native(tmpdir()) ||
    !/^agent-forge-worktree-empty-home-[a-zA-Z0-9]+$/.test(basename(value)) ||
    resolve(value) === resolve(checkedFixtureRoot())
  )
    throw new Error(
      "The OS home for temporary worktree tests must be a separate, owned temp directory.",
    );
  return value;
}
export function gitEnvironment(): NodeJS.ProcessEnv {
  const system = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        ["systemroot", "windir", "comspec", "temp", "tmp"].includes(
          key.toLowerCase(),
        ),
    ),
  );
  return {
    ...system,
    HOME: EMPTY_HOME,
    USERPROFILE: EMPTY_HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(EMPTY_HOME, "empty.gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_SSH_COMMAND: "",
    GIT_OPTIONAL_LOCKS: "0",
  };
}
function realGit(): string {
  const path =
    Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === "path",
    )?.[1] ?? "";
  for (const directory of path.split(delimiter)) {
    const file = join(
      directory,
      process.platform === "win32" ? "git.exe" : "git",
    );
    if (existsSync(file)) return realpathSync.native(file);
  }
  throw new Error(
    "The dedicated Git fixture requires an absolute local Git executable.",
  );
}
export function prepareRepository() {
  checkedFixtureRoot();
  if (existsSync(PLAN)) return;
  mkdirSync(REPOSITORY, { recursive: true });
  mkdirSync(EMPTY_HOME, { recursive: true });
  checkedEmptyHome();
  mkdirSync(join(EMPTY_HOME, "hooks"), { recursive: true });
  writeFileSync(join(EMPTY_HOME, "empty.gitconfig"), "");
  const git = realGit();
  const run = (args: string[]) => {
    const result = spawnSync(
      git,
      [
        "-c",
        `core.hooksPath=${join(EMPTY_HOME, "hooks")}`,
        "-c",
        "protocol.file.allow=never",
        "-c",
        "core.autocrlf=false",
        ...args,
      ],
      {
        cwd: REPOSITORY,
        env: gitEnvironment(),
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Temporary repository preparation failed: ${result.stderr}`,
      );
    return result.stdout.trim();
  };
  run(["init", "--quiet", "--initial-branch=fixture-base"]);
  writeFileSync(join(REPOSITORY, ".gitignore"), "trees/\n");
  writeFileSync(
    join(REPOSITORY, "README.md"),
    "Temporary session worktree browser fixture.\n",
  );
  run(["add", "--", ".gitignore", "README.md"]);
  run([
    "-c",
    "user.name=Browser fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Known fixture base",
  ]);
  const base = run(["rev-parse", "HEAD"]);
  writeFileSync(
    PLAN,
    JSON.stringify({
      root: realpathSync.native(REPOSITORY),
      git,
      base,
      emptyHome: EMPTY_HOME,
      calls: CALLS,
    }),
  );
  process.once("exit", removeRepository);
}
export function fixturePlan(): {
  root: string;
  git: string;
  base: string;
  emptyHome: string;
  calls: string;
} {
  checkedFixtureRoot();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(PLAN, "utf8"));
  } catch {
    throw new Error("The temporary Git fixture plan is unavailable.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("root" in value) ||
    !("git" in value) ||
    !("base" in value) ||
    !("emptyHome" in value) ||
    !("calls" in value) ||
    [value.root, value.git, value.base, value.emptyHome, value.calls].some(
      (item) => typeof item !== "string",
    )
  )
    throw new Error("The temporary Git fixture plan is invalid.");
  return value as ReturnType<typeof fixturePlan>;
}
export function removeRepository() {
  try {
    const target = checkedFixtureRoot();
    rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch {
    /* Windows may retain the server cwd until teardown; this generated temp directory is never reused. */
  }
  // EMPTY_HOME is intentionally retained: it may contain the persistent user-global config mutex.
}
