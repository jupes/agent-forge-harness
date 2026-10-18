/**
 * A synchronous spawn with a time limit, under Bun 1.3.10, is not given that
 * limit. Its timer starts from a clock that last moved when the process's
 * previous synchronous spawn ended, so the child is killed (ETIMEDOUT from
 * `spawnSync` and `execFileSync`, SIGTERM from `Bun.spawnSync`) after about
 * the limit less the time since then, idle or busy: with a 2 s limit, after a
 * gap of 0.5 s, 1 s, 1.5 s or 1.8 s a child that needs 1.5 s was killed at
 * about 1.5 s, 1 s, 0.5 s and 0.2 s; after a gap past the limit, at once.
 * Measured on Windows; a child spawned without a time limit moves the clock
 * all the same, and a spawn that fails to start does not.
 *
 * The clock starts falling behind again as soon as the reset's child ends:
 * any work, or any wait, between the reset and the timed spawn comes off the
 * limit (a reset, then 1 s idle or busy, then a 2 s-limit spawn: killed at
 * about 1 s). Call it straight before the timed spawn, with nothing between.
 */

/**
 * Bun >=1.4.2 refreshes this clock upstream (oven-sh/bun#33935). Keep this
 * compatibility guard for older local runtimes; the pinned runtime does no
 * work here. A prerelease is not assumed fixed by the semver range.
 *
 * On older Bun, moves the clock to now by starting and waiting for a
 * trivial child with no time limit: `bun --version`, about 20 ms on Windows.
 *
 * `BUN_BE_BUN=1` makes that child Bun itself also when this process is an
 * executable made by `bun build --compile`, whose `process.execPath` is the
 * executable: without it the child runs the executable's own entrypoint.
 *
 * A child that cannot be started (no executable at `process.execPath`) is
 * not an error here: the timed spawn after it still runs, with whatever
 * limit the clock leaves it. Under Node, which has no `Bun.spawnSync`, this
 * does nothing.
 */
export function resetSpawnClock(): void {
  if (typeof Bun === "undefined") return;
  if (Bun.semver.satisfies(Bun.version, ">=1.4.2")) return;
  try {
    Bun.spawnSync([process.execPath, "--version"], {
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
  } catch {
    // Nothing moved the clock; the caller's spawn runs regardless.
  }
}
