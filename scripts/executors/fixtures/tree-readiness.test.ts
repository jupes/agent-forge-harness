import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../../test-scratch";
import { waitForTreeReadiness } from "./tree-readiness";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("owned tree readiness stays pending until the exact child acknowledgement", async () => {
  const marker = join(scratch.make("tree readiness "), "ready");
  writeFileSync(marker, "not-ready");
  let completed = false;
  const pending = waitForTreeReadiness(marker, "ready", () => true, 500).then(
    () => {
      completed = true;
    },
  );
  try {
    await Bun.sleep(20);
    expect(completed).toBe(false);
    writeFileSync(marker, "ready");
    await pending;
    expect(completed).toBe(true);
  } finally {
    writeFileSync(marker, "ready");
    await pending.catch(() => undefined);
  }
});

test("a readiness marker published after the bound cannot turn a timeout into success", async () => {
  const marker = join(scratch.make("late tree readiness "), "ready");
  const pending = waitForTreeReadiness(marker, "ready", () => true, 10).then(
    () => "ready",
    () => "refused",
  );
  const unblock = performance.now() + 30;
  while (performance.now() < unblock) {
    /* Delay the observation past its bound. */
  }
  writeFileSync(marker, "ready");
  expect(await pending).toBe("refused");
});

test("readiness rejects an exited child even when its marker exists", async () => {
  const marker = join(scratch.make("exited tree child "), "ready");
  writeFileSync(marker, "ready");
  await expect(
    waitForTreeReadiness(marker, "ready", () => false),
  ).rejects.toThrow("child exited");
});

test("readiness accepts an exact 64-byte regular marker", async () => {
  const marker = join(scratch.make("bounded tree marker "), "ready");
  writeFileSync(marker, "r".repeat(64));
  await expect(
    waitForTreeReadiness(marker, "r".repeat(64)),
  ).resolves.toBeUndefined();
});

test("directory and oversized readiness markers are refused", async () => {
  const dir = scratch.make("invalid tree marker "),
    marker = join(dir, "ready");
  mkdirSync(marker);
  await expect(waitForTreeReadiness(marker, "ready")).rejects.toThrow(
    "Invalid tree readiness marker",
  );
  const oversized = join(dir, "oversized");
  writeFileSync(oversized, "r".repeat(65));
  await expect(waitForTreeReadiness(oversized, "ready")).rejects.toThrow(
    "Invalid tree readiness marker",
  );
});

test.skipIf(process.platform === "win32")(
  "a linked readiness marker is refused",
  async () => {
    const dir = scratch.make("linked tree marker "),
      target = join(dir, "target"),
      marker = join(dir, "ready");
    writeFileSync(target, "ready");
    symlinkSync(target, marker);
    await expect(waitForTreeReadiness(marker, "ready")).rejects.toThrow(
      "Invalid tree readiness marker",
    );
  },
);

test("missing and incorrect readiness markers exhaust their bounded wait", async () => {
  const marker = join(scratch.make("missing tree marker "), "ready");
  await expect(
    waitForTreeReadiness(marker, "ready", () => true, 20),
  ).rejects.toThrow("within its bound");
  writeFileSync(marker, "not-ready");
  await expect(
    waitForTreeReadiness(marker, "ready", () => true, 20),
  ).rejects.toThrow("within its bound");
});

test("invalid readiness bounds refuse before observing a file", async () => {
  const marker = join(scratch.make("tree marker bounds "), "ready");
  for (const bound of [0, 5001])
    await expect(
      waitForTreeReadiness(marker, "ready", () => true, bound),
    ).rejects.toThrow("Invalid tree readiness bound");
  for (const expected of ["", "r".repeat(65)])
    await expect(waitForTreeReadiness(marker, expected)).rejects.toThrow(
      "Invalid tree readiness bound",
    );
});
