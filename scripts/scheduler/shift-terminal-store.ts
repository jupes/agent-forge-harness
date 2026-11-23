import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { windowsDeleteAccessError } from "./shift-record-windows";
import { isShiftId, type ShiftRecord } from "./shift-store";

/** A new terminal-only allowance; no existing Stop, private-save or queue budget is extended. */
export const SHIFT_TERMINAL_PUBLICATION_MS = 250;
export const SHIFT_TERMINAL_PUBLICATION_ATTEMPTS = 6;
const RETRY_WAIT_MS = 25;
/** The existing protected Shift record reader refuses files beyond eight MiB. */
const MAX_RETRY_BYTES = 8 * 1024 * 1024;

interface FileSnapshot {
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  bytes: Buffer;
}

function snapshot(path: string): FileSnapshot | null {
  let fd: number | undefined;
  try {
    const named = lstatSync(path, { bigint: true });
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      named.ino === 0n ||
      named.size > BigInt(MAX_RETRY_BYTES)
    )
      return null;
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.size > BigInt(MAX_RETRY_BYTES)
    )
      return null;
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const got = readSync(fd, bytes, length, bytes.length - length, null);
      if (got === 0) break;
      length += got;
    }
    const after = fstatSync(fd, { bigint: true }),
      current = lstatSync(path, { bigint: true });
    if (
      length !== Number(opened.size) ||
      after.size !== opened.size ||
      after.nlink !== 1n ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      current.mtimeNs !== opened.mtimeNs ||
      current.ctimeNs !== opened.ctimeNs
    )
      return null;
    return {
      dev: opened.dev,
      ino: opened.ino,
      mtimeNs: opened.mtimeNs,
      ctimeNs: opened.ctimeNs,
      bytes: bytes.subarray(0, length),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameFile(
  path: string,
  expected: FileSnapshot,
  renamed = false,
): boolean {
  const actual = snapshot(path);
  return (
    actual !== null &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    (renamed ||
      (actual.mtimeNs === expected.mtimeNs &&
        actual.ctimeNs === expected.ctimeNs)) &&
    actual.bytes.equals(expected.bytes)
  );
}

function directoryIdentity(path: string): { dev: bigint; ino: bigint } | null {
  try {
    const info = lstatSync(path, { bigint: true });
    return info.isDirectory() && !info.isSymbolicLink() && info.ino !== 0n
      ? { dev: info.dev, ino: info.ino }
      : null;
  } catch {
    return null;
  }
}

function originalMatches(bytes: Buffer, record: ShiftRecord): boolean {
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) return false;
    const source: unknown = JSON.parse(text);
    if (!source || typeof source !== "object" || Array.isArray(source))
      return false;
    for (const key of [
      "shiftId",
      "pid",
      "workspace",
      "startedAt",
      "deadline",
      "options",
      "baseSha",
    ] as const)
      if (
        JSON.stringify(Reflect.get(source, key)) !== JSON.stringify(record[key])
      )
        return false;
    return "state" in source && source.state === "running";
  } catch {
    return false;
  }
}

/** Trusted dependencies for the terminal filesystem boundary, never request options. */
export interface ShiftTerminalPublicationDeps {
  platform: NodeJS.Platform;
  rename(from: string, to: string): void;
  deleteAccessError(path: string): number | null;
  now(): number;
  wait(ms: number): Promise<void>;
}

export function createShiftTerminalPublisher(
  supplied: Partial<ShiftTerminalPublicationDeps> = {},
): (dir: string, record: ShiftRecord) => Promise<void> {
  const deps: ShiftTerminalPublicationDeps = {
    platform: process.platform,
    rename: renameSync,
    deleteAccessError: windowsDeleteAccessError,
    now: () => performance.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...supplied,
  };
  return async (dir, record) => {
    if (!isShiftId(record.shiftId) || record.state !== "stopped")
      throw Error("Expected the original Shift's terminal record.");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${record.shiftId}.json`),
      draft = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`,
      folder = directoryIdentity(dir),
      original = snapshot(path),
      bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(draft, bytes, { flag: "wx" });
    const prepared = snapshot(draft),
      eligible =
        folder !== null &&
        original !== null &&
        originalMatches(original.bytes, record) &&
        prepared !== null &&
        prepared.bytes.equals(bytes);
    const unchanged = () => {
      const current = directoryIdentity(dir);
      if (
        !eligible ||
        !current ||
        current.dev !== folder.dev ||
        current.ino !== folder.ino ||
        !sameFile(path, original) ||
        !sameFile(draft, prepared)
      )
        throw Error(
          "The original Shift record or terminal draft changed; publication is unconfirmed.",
        );
    };
    const began = deps.now();
    let previous = began;
    const remaining = () => {
      const current = deps.now();
      if (!Number.isFinite(current) || current < previous)
        throw Error("The terminal publication deadline could not be verified.");
      previous = current;
      return SHIFT_TERMINAL_PUBLICATION_MS - (current - began);
    };
    let failure: unknown;
    for (
      let attempt = 0;
      attempt < SHIFT_TERMINAL_PUBLICATION_ATTEMPTS;
      attempt++
    ) {
      if (attempt > 0) {
        if (
          deps.platform !== "win32" ||
          !failure ||
          typeof failure !== "object" ||
          !("code" in failure) ||
          failure.code !== "EPERM"
        )
          throw failure;
        if (remaining() <= 0) throw failure;
        unchanged();
        if (remaining() <= 0 || deps.deleteAccessError(path) !== 32)
          throw failure;
        const left = remaining();
        if (left <= 0) throw failure;
        await deps.wait(Math.min(RETRY_WAIT_MS, left));
        if (remaining() <= 0) throw failure;
        unchanged();
      }
      if (!Number.isFinite(began) || remaining() <= 0)
        throw failure ?? Error("The terminal publication deadline expired.");
      try {
        deps.rename(draft, path);
      } catch (error) {
        failure = error;
        continue;
      }
      if (prepared && !sameFile(path, prepared, true))
        throw Error(
          "The published terminal Shift record could not be verified.",
        );
      return;
    }
    throw failure;
  };
}

/** Final engine publication only; ordinary/intermediate/recovery reports remain one-shot. */
export const publishShiftTerminalRecord = createShiftTerminalPublisher();
