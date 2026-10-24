/** Trusted descriptor-only byte bound. No path is reopened while reading. */
import { constants as bufferLimits } from "node:buffer";
import { readFileSync, readSync } from "node:fs";
import { configChanged, invalidConfigPath } from "./transaction-error";

export interface ConfigDescriptorReadIo {
  allocate(length: number): Buffer;
  read(fd: number, bytes: Buffer, offset: number, length: number): number;
  readAll(fd: number): Buffer;
}

const realIo: ConfigDescriptorReadIo = {
  allocate: (length) => Buffer.allocUnsafe(length),
  read: (fd, bytes, offset, length) =>
    readSync(fd, bytes, offset, length, null),
  readAll: (fd) => readFileSync(fd),
};

export function checkedConfigSourceLimit(
  value: number | undefined,
): number | undefined {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) ||
      value < 1 ||
      value >= bufferLimits.MAX_LENGTH)
  )
    invalidConfigPath(
      "Expected a positive supported configuration byte limit.",
    );
  return value;
}

export function readConfigDescriptor(
  fd: number,
  openedSize: bigint,
  maxSourceBytes: number | undefined,
  io: ConfigDescriptorReadIo = realIo,
): Buffer {
  const limit = checkedConfigSourceLimit(maxSourceBytes);
  // Undefined deliberately retains the scalar writer's existing read behavior.
  if (limit === undefined) return io.readAll(fd);
  const oversized = () =>
    invalidConfigPath("A configuration source exceeds its trusted byte limit.");
  if (openedSize < 0n) configChanged();
  if (openedSize > BigInt(limit)) oversized();
  // The extra byte detects growth without an unbounded read or another allocation.
  const bytes = io.allocate(limit + 1);
  let used = 0;
  while (used < bytes.length) {
    const length = bytes.length - used,
      count = io.read(fd, bytes, used, length);
    if (!Number.isSafeInteger(count) || count < 0 || count > length)
      configChanged();
    if (count === 0) {
      if (BigInt(used) !== openedSize) configChanged();
      return bytes.subarray(0, used);
    }
    used += count;
    if (used > limit) oversized();
  }
  return oversized();
}
