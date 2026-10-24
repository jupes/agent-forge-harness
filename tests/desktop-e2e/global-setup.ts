import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import baseSetup from "../e2e/global-setup";
import { BD_STAND_IN_BIN, bunPath, HEARTH_HOME } from "../e2e/servers";

/** The desktop alone needs a provider stand-in. Its hearth can find no real provider. */
export default async function setup(): Promise<void> {
  await baseSetup();
  const geminiConfig = join(
    HEARTH_HOME,
    "gemini-native-fixture",
    ".agent-forge",
  );
  mkdirSync(geminiConfig, { recursive: true });
  writeFileSync(
    join(geminiConfig, "config.toml"),
    '[smiths.gemini-example]\nprovider = "gemini"\nmodel = "configured-example"\neffort = "default"\nenabled = true\n',
  );
  const gemini = join(
    BD_STAND_IN_BIN,
    process.platform === "win32" ? "gemini.exe" : "gemini",
  );
  const geminiBuilt = spawnSync(
    bunPath(),
    [
      "build",
      "--compile",
      resolve("tests/desktop-e2e/gemini-cli-stand-in.ts"),
      "--outfile",
      gemini,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (geminiBuilt.status !== 0)
    throw Error(`Gemini inert fixture did not compile: ${geminiBuilt.stderr}`);
  const geminiProbe = spawnSync(gemini, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (geminiProbe.status !== 0 || geminiProbe.stdout.trim() !== "0.65.0")
    throw Error("The compiled Gemini fixture did not identify itself.");
  const geminiChatBuilt = spawnSync(
    bunPath(),
    [
      "build",
      "--compile",
      resolve("tests/desktop-e2e/gemini-chat-cli-stand-in.ts"),
      "--outfile",
      join(
        BD_STAND_IN_BIN,
        process.platform === "win32" ? "gemini-chat.exe" : "gemini-chat",
      ),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (geminiChatBuilt.status !== 0)
    throw Error(
      `Gemini ACP fixture did not compile: ${geminiChatBuilt.stderr}`,
    );
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
  const chatBuilt = spawnSync(
    bunPath(),
    [
      "build",
      "--compile",
      resolve("tests/desktop-e2e/codex-chat-cli-stand-in.ts"),
      "--outfile",
      join(
        BD_STAND_IN_BIN,
        process.platform === "win32" ? "codex-chat.exe" : "codex-chat",
      ),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (chatBuilt.status !== 0)
    throw Error(`Codex Chat stand-in did not compile: ${chatBuilt.stderr}`);
  const loginBuilt = spawnSync(
    bunPath(),
    [
      "build",
      "--compile",
      resolve("tests/desktop-e2e/provider-login-cli.ts"),
      "--outfile",
      join(
        BD_STAND_IN_BIN,
        process.platform === "win32" ? "provider-login.exe" : "provider-login",
      ),
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  if (loginBuilt.status !== 0)
    throw Error(`Provider login fixture did not compile: ${loginBuilt.stderr}`);
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
  const codexStatus = spawnSync(codex, ["login", "status"], {
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  if (
    codexStatus.status !== 0 ||
    codexStatus.stdout.trim() !== "Logged in using fixture credentials"
  )
    throw Error("The compiled Codex status probe must not start a Task.");
}
