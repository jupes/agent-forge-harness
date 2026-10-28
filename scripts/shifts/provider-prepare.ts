import { isAbsolute } from "node:path";
import { loadConfig } from "../config/load";
import { buildChildEnv } from "../executors/env";
import {
  PrivateCaptureError,
  type PrivateExecInput,
} from "../executors/private-capture";
import { supervise } from "../executors/supervisor";

const flags = {
  claude: [
    "--print",
    "--output-format",
    "--verbose",
    "--model",
    "--effort",
    "--permission-mode",
    "--allowedTools",
  ],
  codex: ["--json", "--sandbox", "--model", "--cd", "--config"],
} as const;
const floors = { claude: [2, 1, 293], codex: [0, 163, 0] } as const;

export type ShiftProviderPrepareFailurePhase =
  | "input-check"
  | "smith-config-check"
  | "executable-check"
  | "codex-policy-check"
  | "probe-environment"
  | "version-probe"
  | "version-parse"
  | "version-floor"
  | "help-probe"
  | "help-flags";

/** Fresh non-generating CLI evidence only. No prompt, authentication query or credential read. */
export function createShiftProviderPreparer(options: {
  root: string;
  configHome?: string;
  environment?: Record<string, string | undefined>;
  probeTimeoutMs?: number;
  onFailure?: (phase: ShiftProviderPrepareFailurePhase) => void;
}) {
  const timeoutMs = options.probeTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000)
    throw new PrivateCaptureError();
  return async (
    input: PrivateExecInput,
    signal: AbortSignal,
  ): Promise<{ version: string }> => {
    let failurePhase: ShiftProviderPrepareFailurePhase = "input-check";
    try {
      failurePhase = "input-check";
      if (
        signal.aborted ||
        (input.provider !== "claude" && input.provider !== "codex")
      )
        throw new PrivateCaptureError();
      const provider = input.provider === "claude" ? "claude" : "codex";
      failurePhase = "smith-config-check";
      const loaded = loadConfig({
        harnessRoot: options.root,
        env: {},
        ...(options.configHome ? { home: options.configHome } : {}),
      });
      const smith = loaded.config.smiths[input.smith.name];
      if (
        !smith?.enabled ||
        !input.smith.enabled ||
        smith.provider !== provider ||
        input.smith.provider !== provider ||
        smith.model !== input.smith.model ||
        smith.effort !== input.smith.effort
      )
        throw new PrivateCaptureError();
      failurePhase = "executable-check";
      const executable = input.command[0];
      if (
        !executable ||
        !isAbsolute(executable) ||
        !Bun.which(executable) ||
        (process.platform === "win32" && !/\.exe$/i.test(executable))
      )
        throw new PrivateCaptureError();
      failurePhase = "codex-policy-check";
      if (provider === "codex") {
        const policies = input.command.filter((word) =>
          /^approval_policy\s*=/.test(word),
        );
        const index = input.command.indexOf('approval_policy="never"');
        if (
          policies.length !== 1 ||
          index < 1 ||
          input.command[index - 1] !== "--config"
        )
          throw new PrivateCaptureError();
      }
      failurePhase = "probe-environment";
      const env = buildChildEnv(
        options.environment ?? process.env,
        loaded.config.execution.envPass,
      );
      for (const key of Object.keys(env))
        if (/^agent_forge_/i.test(key) || /^forge_slug$/i.test(key))
          delete env[key];
      const probe = async (args: string[]) => {
        if (signal.aborted) throw new PrivateCaptureError();
        let text = "",
          size = 0,
          valid = true;
        const child = supervise({
          command: [executable, ...args],
          cwd: options.root,
          env,
          stdin: "",
          timeoutMs,
          maxLineBytes: 65_536,
          onOutputError() {
            valid = false;
          },
          onLine(line) {
            size += Buffer.byteLength(line) + 1;
            if (size > 131_072) {
              valid = false;
              throw new PrivateCaptureError();
            }
            text += `${line}\n`;
          },
        });
        const stop = () => {
          void child.stop("Private capability preparation stopped");
        };
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
        try {
          const result = await child.done;
          if (
            !valid ||
            signal.aborted ||
            result.exitCode !== 0 ||
            result.stopped ||
            result.timedOut
          )
            throw new PrivateCaptureError();
          return text;
        } finally {
          signal.removeEventListener("abort", stop);
          await child.done;
        }
      };
      failurePhase = "version-probe";
      const output = await probe(["--version"]);
      failurePhase = "version-parse";
      const version = (
        provider === "claude"
          ? /^(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)(?:\s|$)/
          : /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)(?:\s|$)/
      ).exec(output)?.[1];
      if (!version) throw new PrivateCaptureError();
      failurePhase = "version-floor";
      const numbers = version.split(/[.-]/).slice(0, 3).map(Number),
        floor = floors[provider];
      const comparison = numbers.reduce(
        (prior, n, index) => prior || n - (floor[index] ?? 0),
        0,
      );
      if (comparison < 0) throw new PrivateCaptureError();
      failurePhase = "help-probe";
      const help = await probe(
        provider === "codex" ? ["exec", "--help"] : ["--help"],
      );
      failurePhase = "help-flags";
      const available = new Set(
        [...help.matchAll(/(?:^|\s)(--[A-Za-z][A-Za-z0-9-]*)\b/g)].map(
          (match) => match[1],
        ),
      );
      if (!flags[provider].every((flag) => available.has(flag)))
        throw new PrivateCaptureError();
      return { version };
    } catch {
      try {
        options.onFailure?.(failurePhase);
      } catch {
        // Failure observation must not alter the private refusal.
      }
      throw new PrivateCaptureError();
    }
  };
}
