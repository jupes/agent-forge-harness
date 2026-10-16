/**
 * Preloaded by `bun test` (see `bunfig.toml`).
 *
 * The hearth's tests talk to a hearth on `127.0.0.1` with `fetch`. Under Bun,
 * a process started with `HTTP_PROXY` set and no `NO_PROXY` entry of
 * `127.0.0.1` or `*` sends those requests, operator tokens included, to that
 * proxy, and nothing this process does after it has started changes that
 * (`loopbackProxyVariable` in `loopback.ts`). So such a run is refused here,
 * before any test runs, with what to set instead. The proxy's value is not
 * printed: it can carry a password.
 *
 * A hearth refuses a home others can write (`home-guard.ts`), and a test's
 * home is a temp directory. On Windows the OS temp folder can let others
 * write what is created in it (this machine's grants a sandbox's group
 * Modify), so every temp directory a test makes there is made in a folder of
 * this run's own instead, readable and writable by this user only: `TEMP` and
 * `TMP` name it, which `os.tmpdir()` reads on each call. A child process gets
 * it only when its environment is built from `process.env`. On POSIX a
 * `mkdtemp` directory is 0700 already.
 */

import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeOwnerOnly } from "./acl-windows";
import { loopbackProxyVariable } from "./loopback";

const variable = loopbackProxyVariable(process.env, "bun");
if (variable !== null) {
  process.stderr.write(
    `bun test was started with ${variable} set and no NO_PROXY entry of 127.0.0.1 or *. ` +
      "Under Bun, fetch then sends the hearth tests' requests for 127.0.0.1, operator tokens included, to that proxy, " +
      "and nothing done after start-up changes it. " +
      `Start the run with NO_PROXY=127.0.0.1 (added to any entries it already has), or without ${variable}.\n`,
  );
  process.exit(1);
}

/** Names the run's own temp folder, so that a `bun test` this run starts keeps it rather than making another inside it. */
const OWN_TEMP = "AGENT_FORGE_TEST_TEMP";

if (process.platform === "win32" && process.env[OWN_TEMP] === undefined) {
  const own = mkdtempSync(join(tmpdir(), "agent-forge tests "));
  makeOwnerOnly(own, "directory");
  process.env["TEMP"] = own;
  process.env["TMP"] = own;
  process.env[OWN_TEMP] = own;
  afterAll(() => {
    try {
      rmSync(own, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A file still held open on Windows: the OS temp folder reclaims it.
    }
  });
}
