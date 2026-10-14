/**
 * Fixture for the isolation guard's own test (`test-isolation.test.ts`): a
 * test file that starts children with only PATH in their environment, one
 * through `Bun.spawn` and one through `node:child_process`, and runs a ledger
 * emitter in each. Not named `*.test.ts`, so the suite does not run it; the
 * guard's test hands it to the guard's re-run by path.
 *
 * Bun's spawn on Windows copies this process's USERPROFILE into a child's
 * environment that has none (a POSIX spawn copies nothing), so this process's
 * home variables are cleared while a child starts: the child then has no home
 * variable and no `AGENT_FORGE_HOME` on either platform.
 *
 * Nothing here may reach the real ledger. A child is started only when this
 * process's Agent Forge home is inside the temp directory, as it is in the
 * guard's re-run, and the emitter (`append-in-home.ts`) writes only when the
 * home it resolves is that one.
 */

import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "os";
import { join, resolve, sep } from "path";

const EMITTER = join(import.meta.dir, "append-in-home.ts");

/** The Agent Forge home this process has, or null when it is not in the temp directory. */
function scratchHome(): string | null {
  const home = resolve(homedir(), ".agent-forge");
  if (home.startsWith(resolve(tmpdir()) + sep)) return home;
  console.log(`no child started: ${home} is not in the temp directory`);
  return null;
}

/** Runs `start` with this process's home variables cleared, and puts them back. */
function withoutHomeVariables<T>(start: () => T): T {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  try {
    return start();
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value !== undefined) process.env[key] = value;
  }
}

test("a child started through Bun.spawn with only PATH in its environment runs a ledger emitter", async () => {
  const home = scratchHome();
  if (home === null) return;
  const child = withoutHomeVariables(() =>
    Bun.spawn([process.execPath, EMITTER, home, "home-less-bun-spawn"], {
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  console.log(
    `Bun.spawn emitter exited ${await child.exited}: ${stdout}${stderr}`,
  );
});

test("a child started through node:child_process with only PATH in its environment runs a ledger emitter", () => {
  const home = scratchHome();
  if (home === null) return;
  const child = withoutHomeVariables(() =>
    spawnSync(process.execPath, [EMITTER, home, "home-less-child-process"], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    }),
  );
  console.log(
    `child_process emitter exited ${child.status}: ${child.stdout}${child.stderr}`,
  );
});
