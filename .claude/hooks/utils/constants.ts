import { join } from "path";
import { mkdirSync } from "fs";

export const LOG_BASE_DIR = join(
  process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp",
  ".claude", "logs", "agent-forge"
);

export function ensureSessionLogDir(): string {
  const dir = join(LOG_BASE_DIR, new Date().toISOString().slice(0, 10));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSessionLogPath(): string {
  return join(ensureSessionLogDir(), "session.jsonl");
}

export function getQualityGateLogPath(): string {
  return join(ensureSessionLogDir(), "quality-gate.jsonl");
}
