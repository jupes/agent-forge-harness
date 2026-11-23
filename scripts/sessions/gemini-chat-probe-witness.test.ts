import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  heldHelpEntry,
  probeFailureMetadata,
  publishHelpEntry,
  publishProbeFailure,
  readProbeFailure,
} from "./fixtures/gemini-chat-probe-witness";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("held help readiness never opens the aggregate recording while version publication is pending", async () => {
  const log = "owned-fixture/record.json",
    nonce = randomUUID(),
    otherNonce = randomUUID(),
    reads: string[] = [],
    files = new Map<string, string>([
      [log, JSON.stringify([{ kind: "version" }, { kind: "help" }])],
      [
        `${log}.help-ready-${otherNonce}`,
        JSON.stringify({ kind: "help", nonce: otherNonce, pid: 123 }),
      ],
    ]);
  let finishOriginal = () => {},
    versionPending = true,
    settled = false;
  const original = new Promise<void>((resolve) => {
    finishOriginal = resolve;
  });
  const waiting = heldHelpEntry(log, nonce, original, (path) => {
    reads.push(path);
    // A controlled fixture boundary, not evidence of the hosted OS errno.
    if (path === log && versionPending)
      throw Error("Aggregate recording opened during version publication");
    return files.get(path);
  }).then(
    (entry) => {
      settled = true;
      return entry;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  void waiting.catch(() => undefined);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(reads).not.toContain(log);
    versionPending = false;
    files.set(
      `${log}.help-ready-${nonce}`,
      JSON.stringify({ kind: "help", nonce, pid: 456 }),
    );
    expect(await waiting).toEqual({ pid: 456 });
    expect(reads.every((path) => path === `${log}.help-ready-${nonce}`)).toBe(
      true,
    );
    expect(files.get(log)).toBe(
      JSON.stringify([{ kind: "version" }, { kind: "help" }]),
    );
  } finally {
    finishOriginal();
    await waiting.catch(() => undefined);
  }
});

test("the help-entry witness ignores another nonce and retains the exact owned process", async () => {
  const nonce = randomUUID();
  let text = JSON.stringify({ kind: "help", nonce: randomUUID(), pid: 123 }),
    settled = false,
    finishOriginal = () => {};
  const original = new Promise<void>((resolve) => {
    finishOriginal = resolve;
  });
  const waiting = heldHelpEntry(
    "owned-fixture/record.json",
    nonce,
    original,
    () => text,
  ).then((entry) => {
    settled = true;
    return entry;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    text = JSON.stringify({ kind: "help", nonce, pid: 456 });
    expect(await waiting).toEqual({ pid: 456 });
  } finally {
    finishOriginal();
    await waiting;
  }
});

test("early run refusal and completion cancel the marker waiter without another read", async () => {
  const failure = new Error("fixture capability probe refused");
  let reads = 0;
  const read = () => {
    reads++;
    return undefined;
  };
  await expect(
    heldHelpEntry(
      "owned-fixture/record.json",
      randomUUID(),
      Promise.reject(failure),
      read,
    ),
  ).rejects.toBe(failure);
  await expect(
    heldHelpEntry(
      "owned-fixture/record.json",
      randomUUID(),
      Promise.resolve(),
      read,
    ),
  ).rejects.toThrow(
    "The original run settled before its held help-probe entry",
  );
  const ended = reads;
  await Bun.sleep(20);
  expect(reads).toBe(ended);
});

test.each([
  0,
  -1,
  1.5,
  "456",
])("the matching help witness rejects invalid process identity %s", async (pid) => {
  const nonce = randomUUID();
  await expect(
    heldHelpEntry(
      "owned-fixture/record.json",
      nonce,
      new Promise(() => {}),
      () => JSON.stringify({ kind: "help", nonce, pid }),
    ),
  ).rejects.toThrow("Invalid owned help-probe process witness");
});

test("probe failure context retains only bounded stage and error code", () => {
  expect(
    probeFailureMetadata("version", {
      code: "EPERM",
      message: "Synthetic private body/path",
      path: "DO_NOT_REPORT",
    }),
  ).toEqual({ stage: "version", code: "EPERM" });
  expect(
    probeFailureMetadata("help", { code: "DO_NOT_REPORT".repeat(20) }),
  ).toEqual({ stage: "help", code: "UNKNOWN" });
  expect(probeFailureMetadata("help", Error("Synthetic private body"))).toEqual(
    { stage: "help", code: "UNKNOWN" },
  );
});

test("one complete nonce witness is immutable and never replaces the aggregate recording", async () => {
  const log = join(scratch.make("gemini-probe-witness-"), "record.json"),
    nonce = randomUUID(),
    before = JSON.stringify([{ kind: "version" }, { kind: "help" }]),
    path = `${log}.help-ready-${nonce}`;
  writeFileSync(log, before);
  publishHelpEntry(log, nonce, 456);
  const bytes = readFileSync(path, "utf8");
  expect(bytes).toBe(JSON.stringify({ kind: "help", nonce, pid: 456 }));
  expect(await heldHelpEntry(log, nonce, new Promise(() => {}))).toEqual({
    pid: 456,
  });
  expect(() => publishHelpEntry(log, nonce, 789)).toThrow("already exists");
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(readFileSync(log, "utf8")).toBe(before);
  expect(existsSync(`${log}.help-ready-${randomUUID()}`)).toBe(false);
});

test("failure-only fixture context preserves its first bounded stage without private content", () => {
  const log = join(scratch.make("gemini-probe-diagnostic-"), "record.json"),
    nonce = randomUUID();
  expect(readProbeFailure(log, nonce)).toEqual({
    stage: "unknown",
    code: "UNRECORDED",
  });
  publishProbeFailure(log, nonce, "version", {
    code: "EPERM",
    message: "DO_NOT_REPORT",
  });
  publishProbeFailure(log, nonce, "help", Error("DO_NOT_REPORT"));
  expect(readProbeFailure(log, nonce)).toEqual({
    stage: "version",
    code: "EPERM",
  });
  expect(readFileSync(`${log}.probe-failure-${nonce}`, "utf8")).toBe(
    JSON.stringify({ stage: "version", code: "EPERM" }),
  );
});
