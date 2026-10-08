import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Create a fresh per-boot operator token and write it to `file`.
 *
 * The file is created with mode 0600. Windows ignores POSIX modes, so there the
 * protection is the user profile directory's own ACL, not this call.
 */
export function createToken(file: string): string {
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort: filesystems without POSIX modes reject chmod.
  }
  return token;
}

export function readToken(file: string): string | null {
  try {
    const value = readFileSync(file, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
