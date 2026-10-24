import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GeminiTaskCapabilities } from "../../types/gemini-task";
import { loadConfig } from "../config/load";
import { buildChildEnv } from "../executors/env";
import { supervise } from "../executors/supervisor";
import { resolveGeminiCommand } from "./gemini-command";
import { geminiTaskCapabilitiesSchema } from "./gemini-task";

export interface GeminiNativeOptions {
  root: string;
  home: string;
  configHome?: string;
  /** Trusted installed/compiled fixture prefix only, never public request data. */
  command?: readonly string[];
  environment?: Record<string, string | undefined>;
  operatorToken?: () => string | null;
}

/** Shared read-only native command evidence. Task and ACP retain separate launch and wire semantics. */
export function createGeminiNativeAccess(
  options: GeminiNativeOptions,
  unavailable: (reason: string) => Error,
) {
  const canonical = (path: string, kind: "file" | "directory"): string => {
    try {
      if (!isAbsolute(path)) throw Error();
      const value = realpathSync.native(path),
        info = statSync(value);
      if (kind === "directory" ? !info.isDirectory() : !info.isFile())
        throw Error();
      return process.platform === "win32" ? value.toLowerCase() : value;
    } catch {
      throw unavailable(
        "A prepared Gemini path is unavailable or has changed.",
      );
    }
  };

  const rootPath = options.root,
    root = canonical(rootPath, "directory"),
    home = options.home;
  const commandOverride = options.command ? [...options.command] : null;
  const environment = { ...(options.environment ?? process.env) };

  const ready = (smith: string) => {
    let loaded: ReturnType<typeof loadConfig>;
    try {
      loaded = loadConfig({
        harnessRoot: rootPath,
        env: {},
        ...(options.configHome ? { home: options.configHome } : {}),
      });
    } catch {
      throw unavailable("The Gemini smith configuration could not be read.");
    }
    const selected = loaded.config.smiths[smith];
    if (!selected?.enabled || selected.provider !== "gemini")
      throw unavailable("The selected smith is not an enabled Gemini smith.");
    const env = buildChildEnv(environment, loaded.config.execution.envPass),
      token = options.operatorToken?.() ?? null;
    for (const [name, value] of Object.entries(env))
      if (
        /^agent_forge_/i.test(name) ||
        /^(forge_slug|node_options|node_path|bun_options)$/i.test(name) ||
        (token && value.includes(token))
      )
        delete env[name];
    env["AGENT_FORGE_ADAPTER"] = "1";
    env["AGENT_FORGE_HOME"] = home;
    let command = commandOverride
      ? [...commandOverride]
      : resolveGeminiCommand();
    if (
      !command.length ||
      command.length > 16 ||
      command.some(
        (word) => !word || word.length > 4096 || /[\p{Cc}\p{Cs}]/u.test(word),
      )
    )
      throw unavailable("The native Gemini command is invalid.");
    const executable = command[0] ? Bun.which(command[0]) : null;
    if (
      !executable ||
      (process.platform === "win32" && !/\.exe$/i.test(executable))
    )
      throw unavailable("A native Gemini executable is unavailable.");
    command = [canonical(executable, "file"), ...command.slice(1)];
    return { env, command };
  };
  const inspect = async (
    runtime: ReturnType<typeof ready>,
    signal?: AbortSignal,
  ): Promise<GeminiTaskCapabilities> => {
    const probe = async (args: string[]) => {
      if (signal?.aborted) throw unavailable("Gemini preparation was stopped.");
      let text = "",
        invalid = false;
      const child = supervise({
        command: [...runtime.command, ...args],
        cwd: rootPath,
        env: runtime.env,
        stdinMode: "interactive",
        timeoutMs: 5000,
        maxLineBytes: 65_536,
        onOutputError: () => {
          invalid = true;
        },
        onLine: (line) => {
          text += `${line}\n`;
          if (Buffer.byteLength(text) > 131_072) throw Error("Probe overflow");
        },
      });
      const stop = () => {
        void child.stop("Gemini capability probe stopped");
      };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        await child.end();
        const exit = await child.done;
        if (invalid || exit.exitCode !== 0 || exit.stopped || exit.timedOut)
          throw unavailable("The Gemini read-only capability check failed.");
        return text;
      } catch {
        throw unavailable("The Gemini read-only capability check failed.");
      } finally {
        signal?.removeEventListener("abort", stop);
        await child.done;
      }
    };
    const versionText = await probe(["--version"]),
      version = /^\s*(?:gemini(?:-cli)?\s+)?(\d+\.\d+\.\d+)\s*$/.exec(
        versionText,
      )?.[1];
    if (version !== "0.65.0")
      throw unavailable(
        "Gemini CLI does not report the verified 0.65.0 protocol version.",
      );
    const help = await probe(["--help"]);
    return geminiTaskCapabilitiesSchema.parse({
      version,
      flags: [
        ...new Set(
          [...help.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)\b/g)].map(
            (match) => match[1],
          ),
        ),
      ],
    });
  };

  return { root, canonical, ready, inspect };
}
