import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { validatePrBody } from "../pr-body";

const MAX_BODY_BYTES = 1_000_000;
const unavailable = "The retained shift PR body could not be verified.";

/** Compiled-safe canonical validation, confined to the exact shift's retained body directory. */
export function createShiftPrBodyCheck(bodyDirectory: string) {
  const root = resolve(bodyDirectory);
  return async (file: string): Promise<string | null> => {
    let fd: number | undefined;
    try {
      const path = resolve(file),
        inside = relative(root, path),
        parts = inside.split(/[\\/]/);
      if (
        isAbsolute(inside) ||
        parts.length !== 2 ||
        parts.some((part) => !part || part === ".." || part === ".") ||
        parts[1] !== "pr-body.md"
      )
        return unavailable;
      for (const folder of [root, join(root, parts[0] ?? "")]) {
        const info = lstatSync(folder);
        if (!info.isDirectory() || info.isSymbolicLink()) return unavailable;
      }
      const named = lstatSync(path);
      if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        named.size > MAX_BODY_BYTES
      )
        return unavailable;
      fd = openSync(path, "r");
      const opened = fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.dev !== named.dev ||
        opened.ino !== named.ino ||
        opened.nlink !== 1 ||
        opened.size > MAX_BODY_BYTES
      )
        return unavailable;
      const bytes = Buffer.alloc(MAX_BODY_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const next = readSync(fd, bytes, length, bytes.length - length, null);
        if (!next) break;
        length += next;
      }
      if (length > MAX_BODY_BYTES) return unavailable;
      const checked = validatePrBody(
        bytes.subarray(0, length).toString("utf8"),
      );
      return checked.ok ? null : `pr:check: ${checked.error}`;
    } catch {
      return unavailable;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
}
