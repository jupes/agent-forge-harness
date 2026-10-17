import { join } from "node:path";
import { resetSpawnClock } from "./spawn-clock";

const marker = "forge-shell-probe-ok";
const script = `printf '%s' '${marker}'\n`;

/**
 * How long a candidate shell gets to run the probe. A cold WSL launcher took
 * 1.88 s once, so the limit leaves room well above that.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/** A probe that runs out of time reports `exitCode: null`, as `Bun.spawnSync` does. */
type Probe = (
  shell: string,
  script: string,
) => {
  exitCode: number | null;
  stdout: string;
};

/** Locate a shell that executes stdin, rather than merely an installed launcher. */
export function findUsableShell(
  name: "sh" | "bash",
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    which?: (name: string) => string | null;
    probe?: Probe;
  } = {},
): string | null {
  const env = options.env ?? process.env;
  const candidates = [(options.which ?? Bun.which)(name)];
  if ((options.platform ?? process.platform) === "win32") {
    for (const root of [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"),
    ]) {
      if (root) candidates.push(join(root, "Git", "bin", `${name}.exe`));
    }
  }
  const probe: Probe =
    options.probe ??
    ((shell, input) => {
      const stdin = new TextEncoder().encode(input);
      // Without this, Bun's timed synchronous spawn loses the time since the previous one ended.
      resetSpawnClock();
      const result = Bun.spawnSync([shell], {
        stdin,
        timeout: PROBE_TIMEOUT_MS,
      });
      return { exitCode: result.exitCode, stdout: result.stdout.toString() };
    });
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    try {
      const result = probe(candidate, script);
      if (result.exitCode === 0 && result.stdout === marker) return candidate;
    } catch {
      // A candidate that cannot be started is unavailable.
    }
  }
  return null;
}
