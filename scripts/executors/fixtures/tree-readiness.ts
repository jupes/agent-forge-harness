import type { Stats } from "node:fs";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

function matches(marker: string, expected: Buffer): boolean {
  let before: Stats;
  try {
    before = lstatSync(marker);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64)
    throw Error("Invalid tree readiness marker");
  const fd = openSync(marker, "r");
  try {
    const current = fstatSync(fd);
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size > 64
    )
      throw Error("Changed tree readiness marker");
    const bytes = Buffer.alloc(65);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 64) throw Error("Oversized tree readiness marker");
    return expected.equals(bytes.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

export async function waitForTreeReadiness(
  marker: string,
  expected: string,
  isAlive: () => boolean = () => true,
  timeoutMs = 5000,
): Promise<void> {
  const expectedBytes = Buffer.from(expected);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000 ||
    expectedBytes.length < 1 ||
    expectedBytes.length > 64
  )
    throw Error("Invalid tree readiness bound");
  const deadline = performance.now() + timeoutMs;
  while (true) {
    if (performance.now() >= deadline)
      throw Error(
        "Tree readiness marker was not acknowledged within its bound",
      );
    if (!isAlive())
      throw Error("Tree readiness child exited before acknowledgement");
    if (matches(marker, expectedBytes)) {
      if (performance.now() >= deadline)
        throw Error(
          "Tree readiness marker was not acknowledged within its bound",
        );
      if (!isAlive())
        throw Error("Tree readiness child exited before acknowledgement");
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw Error(
        "Tree readiness marker was not acknowledged within its bound",
      );
    await Bun.sleep(Math.min(10, remaining));
  }
}
