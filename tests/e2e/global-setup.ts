import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BD_STAND_IN_BIN,
  BD_STAND_IN_SOURCE,
  BD_STAND_IN_STATE,
  bunPath,
} from "./servers";

/**
 * Build the stand-in for `bd` before any test runs.
 *
 * The suite's servers are already up when this runs (Playwright starts them
 * first), with a PATH that names the directory built here. Nothing has asked
 * for `bd` yet: a hearth looks for it only when a request needs it. Until this
 * has run, the hearth finds no `bd` at all, which is the safe way to be early.
 *
 * It is compiled, not left as a script: a hearth runs `bd` by name with an
 * argument array, and only a real program of that name receives the arguments
 * exactly as they were given. Built once per run, into the run's home; the
 * teardown removes it.
 *
 * A build that fails, or a program that does not answer, stops the run: the
 * tests must not start against a `bd` nobody checked.
 */
export default function globalSetup(): void {
  mkdirSync(BD_STAND_IN_BIN, { recursive: true });
  mkdirSync(BD_STAND_IN_STATE, { recursive: true });
  const program = join(
    BD_STAND_IN_BIN,
    process.platform === "win32" ? "bd.exe" : "bd",
  );
  const built = spawnSync(
    bunPath(),
    ["build", "--compile", BD_STAND_IN_SOURCE, "--outfile", program],
    { encoding: "utf8" },
  );
  if (built.status !== 0 || !existsSync(program))
    throw new Error(
      `The stand-in for bd could not be built (exit ${built.status}):\n${built.stdout}\n${built.stderr}`,
    );

  const asked = spawnSync(program, ["list", "--json"], {
    encoding: "utf8",
    env: { ...process.env, BD_STAND_IN_STATE },
  });
  if (asked.status !== 0 || asked.stdout.trim() !== "[]")
    throw new Error(
      `The stand-in for bd was built but does not answer (exit ${asked.status}): ${asked.stdout}${asked.stderr}`,
    );
}
