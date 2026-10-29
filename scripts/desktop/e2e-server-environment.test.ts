import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BD_STAND_IN_BIN,
  repositoryFixtureEnvironment,
  standInEnvironment,
} from "../../tests/e2e/servers";

let fixture: string | undefined;

afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
});

test("only the desktop onboarding fixture requires runner Git", () => {
  const environment = standInEnvironment();
  const path = Object.entries(environment).find(
    ([name]) => name.toUpperCase() === "PATH",
  )?.[1];

  expect(path).toBe(BD_STAND_IN_BIN);
  expect(environment).not.toHaveProperty("AGENT_FORGE_E2E_REPOSITORY_GIT");
  expect(() => repositoryFixtureEnvironment("")).toThrow(
    "The desktop onboarding fixture needs Git in the runner's PATH.",
  );

  fixture = mkdtempSync(join(tmpdir(), "agent-forge-git-env-"));
  const executable = join(
    fixture,
    process.platform === "win32" ? "git.exe" : "git",
  );
  writeFileSync(executable, "private fixture executable");
  expect(repositoryFixtureEnvironment(fixture)).toEqual({
    AGENT_FORGE_E2E_REPOSITORY_GIT: resolve(executable),
  });
});
