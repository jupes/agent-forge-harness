import { win32 } from "node:path";
import { z } from "zod";
import type { SessionTurnSnapshot } from "../../types/session-turn";
import { CLAUDE_ALLOWED_TOOLS } from "../executors/claude-tools";
import {
  claudeLaunchCapabilitiesSchema,
  claudeSessionLaunchSchema,
} from "./claude-launch";

const sessionId = z.uuid();
const safeExecutable = (value: string) =>
  win32.isAbsolute(value) && /\.exe$/i.test(value) && !value.includes("\0");

/** Build only a native interactive resume; private prompt and headless input are intentionally absent. */
export function serializeClaudeInteractiveResume(input: {
  executable: string;
  sessionId: string;
  snapshot: SessionTurnSnapshot;
}): string[] {
  const id = sessionId.safeParse(input.sessionId),
    capabilities = claudeLaunchCapabilitiesSchema.safeParse(
      input.snapshot.capabilities,
    ),
    launch = claudeSessionLaunchSchema.safeParse(input.snapshot.launch);
  if (
    !safeExecutable(input.executable) ||
    !id.success ||
    input.snapshot.version !== 1 ||
    input.snapshot.provider !== "claude" ||
    !capabilities.success ||
    !launch.success ||
    launch.data.mode !== "chat"
  )
    throw new Error("The saved Claude native identity is unavailable.");
  const flags = new Set(capabilities.data.flags),
    saved = launch.data;
  if (
    !flags.has("--resume") ||
    !flags.has("--model") ||
    !flags.has("--permission-mode") ||
    !flags.has("--allowedTools")
  )
    throw new Error("The saved Claude CLI capabilities cannot resume this Chat safely.");
  if (
    saved.maxBudgetUsd !== undefined ||
    saved.outputSchema !== undefined ||
    saved.resumeSessionId !== undefined
  )
    throw new Error("The saved Chat contains an unsupported terminal policy.");
  if (
    saved.effort !== undefined &&
    (!flags.has("--effort") ||
      !capabilities.data.modelEfforts?.[saved.model]?.includes(saved.effort))
  )
    throw new Error("The saved Claude CLI capabilities do not support this Chat effort.");
  const argv = [
    input.executable,
    "--resume",
    id.data,
    "--model",
    saved.model,
    "--permission-mode",
    saved.permissionMode ?? "acceptEdits",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS.join(","),
    ...(saved.effort ? ["--effort", saved.effort] : []),
  ];
  if (
    argv.length > 32 ||
    argv.some((value) => value.includes("\0") || value.length > 8192) ||
    argv.reduce((size, value) => size + value.length * 2 + 3, 1024) > 30_000
  )
    throw new Error("The interactive Claude command exceeds its safe bounds.");
  return argv;
}
