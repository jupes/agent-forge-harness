/**
 * The entrypoint of an executable `spawn-clock.test.ts` makes with
 * `bun build --compile`, where `process.execPath` is this executable, not bun.
 *
 * Run with `--version` it is the entrypoint started again, which the reset
 * must never do: it notes that in `SPAWN_CLOCK_MARKER` and exits. Otherwise it
 * leaves a gap after a timed spawn, resets the clock and prints how a timed
 * child that needs 1 s of a 2 s limit ended.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resetSpawnClock } from "../spawn-clock";

if (process.argv.includes("--version")) {
  const marker = process.env["SPAWN_CLOCK_MARKER"];
  if (marker !== undefined) appendFileSync(marker, "entrypoint ran\n");
  process.exit(0);
}

/** This executable as Bun, running a child that is busy for `ms`, timed at 2 s. */
const busyChild = (ms: number) =>
  spawnSync(
    process.execPath,
    ["-e", `const t = Date.now() + ${ms}; while (Date.now() < t) {}`],
    {
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdio: "ignore",
      timeout: 2_000,
      windowsHide: true,
    },
  );

busyChild(10);
await Bun.sleep(1_500);
resetSpawnClock();
const result = busyChild(1_000);
console.log(
  JSON.stringify({
    status: result.status,
    error: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
  }),
);
