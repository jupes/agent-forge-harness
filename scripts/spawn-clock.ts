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
 */

/**
 * Moves Bun's synchronous-spawn clock to now, by starting and waiting for a
 * trivial child with no time limit: `bun --version`, about 20 ms on Windows.
 * Call it straight before a timed synchronous spawn so that spawn is given
 * its whole limit. Nothing to do under Node, whose timers are not affected.
 */
export function resetSpawnClock(): void {
  if (typeof Bun === "undefined") return;
  Bun.spawnSync([process.execPath, "--version"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
}
