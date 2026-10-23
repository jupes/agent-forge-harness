import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import baseSetup from "../e2e/global-setup";
import { BD_STAND_IN_BIN, bunPath, HEARTH_HOME } from "../e2e/servers";

/** The desktop alone needs a provider stand-in. Its hearth can find no real provider. */
export default async function setup(): Promise<void> {
  await baseSetup();
  const program = join(
    BD_STAND_IN_BIN,
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  const built = spawnSync(
    bunPath(),
    [
      "build",
      "--compile",
      resolve("tests/desktop-e2e/keeper-cli-stand-in.ts"),
      "--outfile",
      program,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (built.status !== 0)
    throw new Error(`Keeper stand-in did not compile: ${built.stderr}`);
  const probe = spawnSync(program, ["--version"], {
    env: { ...process.env, AGENT_FORGE_HOME: HEARTH_HOME },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.status !== 0 || !probe.stdout.includes("Claude Code fixture"))
    throw new Error("The compiled Keeper stand-in did not identify itself.");
  const codex = join(
    BD_STAND_IN_BIN,
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  const codexBuilt = spawnSync(
    bunPath(),
    [
      "build",
      "--compile",
      resolve("tests/desktop-e2e/codex-cli-stand-in.ts"),
      "--outfile",
      codex,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (codexBuilt.status !== 0)
    throw Error(`Codex stand-in did not compile: ${codexBuilt.stderr}`);
  const codexProbe = spawnSync(codex, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (
    codexProbe.status !== 0 ||
    !codexProbe.stdout.includes("codex-cli 0.163.0-alpha.10.2")
  )
    throw Error(
      `The compiled Codex stand-in did not identify itself (status ${codexProbe.status}): ${codexProbe.stderr || codexProbe.error?.message || codexProbe.stdout}`,
    );
}
