import { join } from "node:path";

const marker = "forge-shell-probe-ok";
const script = `printf '%s' '${marker}'\n`;

type Probe = (
  shell: string,
  script: string,
) => {
  exitCode: number;
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
      const result = Bun.spawnSync([shell], {
        stdin: new TextEncoder().encode(input),
        timeout: 2_000,
      });
      return { exitCode: result.exitCode, stdout: result.stdout.toString() };
    });
  for (const candidate of new Set(candidates)) {
    if (!candidate) continue;
    try {
      const result = probe(candidate, script);
      if (result.exitCode === 0 && result.stdout === marker) return candidate;
    } catch {
      // Missing executables and timed-out launchers are unavailable candidates.
    }
  }
  return null;
}
