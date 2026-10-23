import { win32 } from "node:path";
import { ConversationError } from "../conversations/error";
import { buildChildEnv } from "../executors/env";
import type { ProviderInspector } from "./inspect";
import type { LoginProvider } from "./login-protocol";

/** No caller command, cwd, environment, account field or credential enters this protocol. */
export function createNativeLoginPreparation(options: {
  root: string;
  inspector: ProviderInspector;
  environment?: Record<string, string | undefined>;
  operatorToken?: () => string | null;
}) {
  return async (provider: LoginProvider) => {
    const report = await options.inspector.inspect(provider, []),
      path = report.installation.path;
    if (
      !report.signIn.nativeAvailable ||
      !path ||
      !win32.isAbsolute(path) ||
      !/\.exe$/i.test(path) ||
      process.platform !== "win32" ||
      process.arch !== "x64"
    )
      throw new ConversationError(
        409,
        "A verified native vendor executable is unavailable. Use the displayed vendor sign-in command, then run doctor.",
      );
    const env = buildChildEnv(options.environment ?? process.env, []),
      token = options.operatorToken?.() ?? null;
    for (const [name, value] of Object.entries(env))
      if (/^AGENT_FORGE_/i.test(name) || (token && value.includes(token)))
        delete env[name];
    env["AGENT_FORGE_ADAPTER"] = "1";
    return {
      command: [
        path,
        ...(provider === "claude" ? ["auth", "login"] : ["login"]),
      ],
      cwd: options.root,
      env,
      timeoutMs: 900000,
    };
  };
}
