import type {
  ProviderAuthentication,
  ProviderInstallation,
  ProviderReadiness,
  ReadinessProvider,
} from "../../types/provider-readiness";
import { buildChildEnv } from "../executors/env";
import { ADAPTERS } from "../executors/registry";
import {
  type InteractiveSuperviseOptions,
  SupervisorOwnershipRefusalError,
  supervise,
} from "../executors/supervisor";
import {
  parseClaudeAuthentication,
  parseCodexAuthentication,
} from "./readiness";

const definitions = {
  claude: {
    binary: "claude",
    name: "Claude",
    status: ["auth", "status"],
    login: "claude auth login",
    verified: [2, 1, 293],
  },
  codex: {
    binary: "codex",
    name: "Codex",
    status: ["login", "status"],
    login: "codex login",
    verified: [0, 163, 0],
  },
  gemini: {
    binary: "gemini",
    name: "Gemini",
    status: null,
    login: null,
    verified: null,
  },
  grok: {
    binary: "grok",
    name: "Grok",
    status: null,
    login: null,
    verified: null,
  },
  openrouter: {
    binary: "opencode",
    name: "OpenRouter",
    status: null,
    login: null,
    verified: null,
  },
} as const;
export interface ProbeResult {
  exitCode: number;
  stdout: string;
  valid: boolean;
}
export interface ProviderInspection
  extends Pick<
    ProviderReadiness,
    | "provider"
    | "name"
    | "installation"
    | "authentication"
    | "adapter"
    | "signIn"
  > {}
export interface ProviderInspector {
  inspect(
    provider: ReadinessProvider,
    envPass: readonly string[],
  ): Promise<ProviderInspection>;
}

/** Bounded non-generating probes. No prompt, task, credential-file or account API. */
export function createProviderInspector(options: {
  root: string;
  home: string;
  environment?: Record<string, string | undefined>;
  which?: (binary: string) => string | null;
  /** Trusted fixture seam. No command or path is accepted from an HTTP caller. */
  commands?: Partial<Record<ReadinessProvider, readonly string[]>>;
  now?: () => number;
  timeoutMs?: number;
  operatorToken?: () => string | null;
  /** Trusted fixture seam for a pre-grant ownership refusal; never request controlled. */
  interactiveGuard?: InteractiveSuperviseOptions["interactiveGuard"];
  run?: (
    command: readonly string[],
    env: Record<string, string>,
    launchOptions?: { windowsHide: true },
  ) => Promise<ProbeResult>;
}): ProviderInspector {
  const now = options.now ?? Date.now;
  const run =
    options.run ??
    (async (command, env, launchOptions) => {
      let stdout = "",
        valid = true;
      try {
        const child = supervise({
          command: [...command],
          cwd: options.root,
          env,
          stdinMode: "interactive",
          timeoutMs: options.timeoutMs ?? 3000,
          maxLineBytes: 65_536,
          ...(options.interactiveGuard
            ? { interactiveGuard: options.interactiveGuard }
            : {}),
          ...launchOptions,
          onLine(line) {
            if (stdout.length + line.length > 131_072) {
              valid = false;
              return;
            }
            stdout += `${line}\n`;
          },
          onOutputError() {
            valid = false;
          },
        });
        void child.end().catch(() => undefined);
        const result = await child.done;
        return {
          exitCode: result.exitCode ?? -1,
          stdout: valid ? stdout : "",
          valid: valid && !result.timedOut && !result.stopped,
        };
      } catch (error) {
        if (error instanceof SupervisorOwnershipRefusalError) throw error;
        return { exitCode: -1, stdout: "", valid: false };
      }
    });
  return {
    async inspect(provider, envPass) {
      const definition = definitions[provider];
      const checkedAt = new Date(now()).toISOString();
      const command = options.commands?.[provider];
      const path =
        command?.[0] ?? (options.which ?? Bun.which)(definition.binary);
      const supported = ADAPTERS[provider] !== undefined;
      const installation: ProviderInstallation = {
        found: path !== null,
        versionOk: false,
        version: null,
        path,
        checkedAt,
        compatibility: "unknown",
        reason: path === null ? "CLI not found on PATH." : null,
      };
      let authentication: ProviderAuthentication = {
        mode: "unknown",
        source: "unavailable",
        observedAt: null,
        reason:
          "No supported authentication status report is available. No task was run.",
      };
      const result: ProviderInspection = {
        provider,
        name: definition.name,
        installation,
        authentication,
        adapter: {
          supported,
          reason: supported
            ? null
            : provider === "openrouter"
              ? "The OpenCode/ACP route is deferred. No desktop session adapter is available."
              : "The desktop session adapter has not been delivered.",
        },
        signIn: {
          nativeAvailable: false,
          command: definition.login,
          reason:
            definition.login === null
              ? "The sign-in route awaits this provider's verified adapter."
              : null,
        },
      };
      if (path === null) return result;
      const env = buildChildEnv(options.environment ?? process.env, envPass);
      const operatorToken = options.operatorToken?.() ?? null;
      for (const key of Object.keys(env))
        if (
          /^agent_forge_/i.test(key) ||
          key.toLowerCase() === "forge_slug" ||
          (operatorToken !== null &&
            operatorToken.length > 0 &&
            env[key]?.includes(operatorToken))
        )
          delete env[key];
      env["AGENT_FORGE_ADAPTER"] = "1";
      env["AGENT_FORGE_HOME"] = options.home;
      const version = await run([...(command ?? [path]), "--version"], env, {
        windowsHide: true,
      });
      installation.versionOk = version.valid && version.exitCode === 0;
      installation.version = version.valid
        ? (version.stdout.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0] ??
          null)
        : null;
      if (!installation.versionOk) {
        installation.reason =
          "The bounded version check failed. Authentication was not checked.";
        return result;
      }
      const numbers = installation.version
        ?.split(/[.-]/)
        .slice(0, 3)
        .map(Number);
      if (numbers && definition.verified) {
        const old = numbers.some(
          (value, index) =>
            value !== definition.verified?.[index] &&
            numbers
              .slice(0, index)
              .every(
                (prior, before) => prior === definition.verified?.[before],
              ) &&
            value < (definition.verified[index] ?? 0),
        );
        installation.compatibility = old ? "too-old" : "supported";
        if (old) {
          installation.reason = `Below the status interface verified with ${definition.verified.join(".")}. Update before relying on this report.`;
          return result;
        }
      }
      if (
        definition.status &&
        supported &&
        installation.compatibility === "supported"
      ) {
        const status = await run(
          [...(command ?? [path]), ...definition.status],
          env,
          { windowsHide: true },
        );
        if (status.valid)
          authentication =
            provider === "claude"
              ? parseClaudeAuthentication(
                  status.stdout,
                  status.exitCode,
                  checkedAt,
                )
              : parseCodexAuthentication(status.exitCode, checkedAt);
        result.authentication = authentication;
      }
      result.signIn.nativeAvailable =
        supported &&
        installation.compatibility === "supported" &&
        definition.login !== null &&
        process.platform === "win32" &&
        process.arch === "x64" &&
        /\.exe$/i.test(path);
      if (definition.login && !result.signIn.nativeAvailable)
        result.signIn.reason =
          "Opening the vendor console requires a verified native Windows x64 executable. Use the vendor command in your terminal, then run doctor.";
      return result;
    },
  };
}
