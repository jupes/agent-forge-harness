import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Mode 0600 where the file system keeps POSIX modes; a no-op elsewhere. */
function ownerOnly(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort: filesystems without POSIX modes reject chmod.
  }
}

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
  ownerOnly(file);
  return token;
}

/**
 * Replace `file` with `content`, readable by this OS user only, as the token
 * file is: created with mode 0600 (on Windows the protection is the profile
 * directory's ACL). Written to a new file beside it and renamed over it, so a
 * reader sees the old content or the new, never part of either.
 */
export function writeOwnerOnly(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    ownerOnly(temp);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function readToken(file: string): string | null {
  try {
    const value = readFileSync(file, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether `presented` is the expected token.
 *
 * Both sides are hashed first, so the comparison takes the same time whatever
 * the presented value's length or content, and `timingSafeEqual` never sees
 * buffers of different lengths. Anything but a non-empty string on either side
 * is a refusal: no token minted yet, a header sent twice, a header not sent.
 */
export function tokenMatches(
  expected: string | null,
  presented: unknown,
): boolean {
  if (expected === null || expected.length === 0) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(presented));
}
