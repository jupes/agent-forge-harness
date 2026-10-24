import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { bunFfi } from "../hearth/acl-windows";
import { scratchDirs } from "../test-scratch";
import { windowsDeleteAccessError } from "./shift-record-windows";
import { type ShiftRecord, writeShiftRecord } from "./shift-store";
import {
  createShiftTerminalPublisher,
  SHIFT_TERMINAL_PUBLICATION_ATTEMPTS,
  SHIFT_TERMINAL_PUBLICATION_MS,
} from "./shift-terminal-store";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const WINDOWS = process.platform === "win32" && process.arch === "x64";

function heldOriginal() {
  const root = scratch.make("shift-terminal-real-reader-"),
    dir = join(root, "shifts"),
    record: ShiftRecord = {
      shiftId: "shift-20261024-011521-868a",
      pid: process.pid,
      workspace: root,
      startedAt: "2026-10-24T01:15:21.871Z",
      deadline: "2026-10-24T01:16:21.871Z",
      state: "running",
      options: {
        concurrency: 1,
        forMs: 60000,
        maxBeads: 1,
        maxUsd: 1,
        repairs: 0,
      },
      spentUsd: 0,
      unpriced: 0,
      beads: [],
    },
    terminal: ShiftRecord = {
      ...record,
      state: "stopped",
      reason: "operator",
      endedAt: "2026-10-24T01:15:28.268Z",
    };
  writeShiftRecord(dir, record);
  const path = join(dir, `${record.shiftId}.json`),
    original = readFileSync(path),
    { dlopen, FFIType } = bunFfi(),
    library = dlopen("kernel32.dll", {
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.u64,
      },
      GetLastError: { args: [], returns: FFIType.u32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    });
  const api = library.symbols,
    wide = Buffer.from(`${path}\0`, "utf16le"),
    handle = BigInt(
      api.CreateFileW(
        wide,
        0x80000000, // GENERIC_READ.
        0x3, // Deliberately omit FILE_SHARE_DELETE, unlike the protected reader.
        null,
        3, // OPEN_EXISTING.
        0x80,
        null,
      ),
    );
  if (handle === 0n || handle === 0xffffffffffffffffn) {
    const error = api.GetLastError();
    library.close();
    throw Error(
      `The fixture's owned read handle could not be opened: ${error}`,
    );
  }
  let held = true;
  const release = () => {
    if (!held) return;
    if (api.CloseHandle(handle) === 0)
      throw Error("The fixture's owned read handle could not be closed.");
    held = false;
  };
  return {
    dir,
    path,
    original,
    terminal,
    release,
    close() {
      try {
        release();
      } finally {
        library.close();
      }
    },
  };
}

test.skipIf(!WINDOWS)(
  "actual Windows sharing violation releases before the same retained terminal draft is published",
  async () => {
    const f = heldOriginal(),
      probes: Array<number | null> = [],
      attempts: Array<{ path: string; ino: bigint; bytes: Buffer }> = [];
    const publish = createShiftTerminalPublisher({
      deleteAccessError(path) {
        const code = windowsDeleteAccessError(path);
        probes.push(code);
        return code;
      },
      async wait(ms) {
        expect(probes.at(-1)).toBe(32);
        expect(readFileSync(f.path)).toEqual(f.original);
        await Bun.sleep(ms);
        f.release();
      },
      rename(from, to) {
        attempts.push({
          path: from,
          ino: statSync(from, { bigint: true }).ino,
          bytes: readFileSync(from),
        });
        renameSync(from, to);
      },
    });
    try {
      await publish(f.dir, f.terminal);
      expect(probes).toEqual([32]);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(attempts[0]);
      const first = attempts[0];
      if (!first) throw Error("The retained terminal draft is missing.");
      expect(statSync(f.path, { bigint: true }).ino).toBe(first.ino);
      expect(readFileSync(f.path, "utf8")).toBe(
        `${JSON.stringify(f.terminal, null, 2)}\n`,
      );
      expect(readdirSync(f.dir)).toEqual([`${f.terminal.shiftId}.json`]);
    } finally {
      f.close();
    }
  },
);

test.skipIf(!WINDOWS)(
  "actual Windows reader held through the control allowance leaves an unconfirmed original and exact draft",
  async () => {
    const f = heldOriginal(),
      attempts: Array<{
        path: string;
        ino: bigint;
        bytes: Buffer;
        at: number;
      }> = [],
      probes: Array<number | null> = [];
    const publish = createShiftTerminalPublisher({
      deleteAccessError(path) {
        const code = windowsDeleteAccessError(path);
        probes.push(code);
        return code;
      },
      rename(from, to) {
        attempts.push({
          path: from,
          ino: statSync(from, { bigint: true }).ino,
          bytes: readFileSync(from),
          at: performance.now(),
        });
        renameSync(from, to);
      },
    });
    try {
      await expect(publish(f.dir, f.terminal)).rejects.toMatchObject({
        code: "EPERM",
        syscall: "rename",
      });
      const first = attempts[0];
      if (!first) throw Error("The terminal draft was not attempted.");
      expect(attempts.length).toBeLessThanOrEqual(
        SHIFT_TERMINAL_PUBLICATION_ATTEMPTS,
      );
      expect(
        attempts.every(
          (attempt) => attempt.at - first.at < SHIFT_TERMINAL_PUBLICATION_MS,
        ),
      ).toBe(true);
      expect(
        attempts.every(
          (attempt) =>
            attempt.path === first.path &&
            attempt.ino === first.ino &&
            attempt.bytes.equals(first.bytes),
        ),
      ).toBe(true);
      expect(probes.every((code) => code === 32)).toBe(true);
      expect(probes.length).toBeGreaterThanOrEqual(attempts.length - 1);
      expect(probes.length).toBeLessThanOrEqual(attempts.length);
      expect(readFileSync(f.path)).toEqual(f.original);
      expect(readFileSync(first.path, "utf8")).toBe(
        `${JSON.stringify(f.terminal, null, 2)}\n`,
      );
      expect(statSync(first.path, { bigint: true }).ino).toBe(first.ino);
    } finally {
      f.close();
    }
  },
);
