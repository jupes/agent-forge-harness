import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOwnTracker } from "./complete-tracker-descriptor";
import { completeTrackerFixture } from "./complete-tracker-fixture";
import { ownTrackerReader } from "./complete-tracker-reader";

const roots: string[] = [];
const identity = {
  database: "test_db",
  projectId: "11111111-1111-4111-8111-111111111111",
};
function home() {
  const root = mkdtempSync(join(tmpdir(), "complete-tracker-"));
  roots.push(root);
  mkdirSync(join(root, ".beads"));
  writeFileSync(
    join(root, ".beads/metadata.json"),
    JSON.stringify({
      backend: "dolt",
      dolt_mode: "server",
      dolt_database: identity.database,
      project_id: identity.projectId,
    }),
  );
  writeFileSync(
    join(root, ".beads/config.yaml"),
    "dolt.shared-server: true\nno-push: true\n",
  );
  writeFileSync(join(root, ".beads/dolt-server.port"), "3308\n");
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const result = () => ({
  exited: true,
  status: 0,
  stdout: completeTrackerFixture(identity, []),
});

test("an initialized own-root capability reaches the complete parser only after successful child exit", async () => {
  const root = home(),
    descriptor = captureOwnTracker(root);
  let calls = 0;
  const read = ownTrackerReader(root, async (value) => {
    calls++;
    expect(value).toEqual(descriptor);
    return result();
  });
  expect(await read()).toEqual({ identity, rows: [] });
  expect(calls).toBe(1);
});
test("unapproved or unsupported roots cannot invoke the child even when a fake child could return complete data", async () => {
  const root = home();
  writeFileSync(join(root, ".beads/redirect"), "elsewhere");
  let calls = 0;
  const read = ownTrackerReader(root, async () => {
    calls++;
    return result();
  });
  await expect(read()).rejects.toThrow(
    "Complete workspace tracker unavailable.",
  );
  expect(calls).toBe(0);
});
test("descriptor replacement before or during a held read permanently refuses that capability", async () => {
  const root = home();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const read = ownTrackerReader(root, async () => {
    calls++;
    await hold;
    return result();
  });
  const pending = read();
  writeFileSync(
    join(root, ".beads/config.yaml"),
    "dolt.shared-server: true\n# changed registration\n",
  );
  release();
  await expect(pending).rejects.toThrow(
    "Complete workspace tracker unavailable.",
  );
  writeFileSync(
    join(root, ".beads/config.yaml"),
    "dolt.shared-server: true\nno-push: true\n",
  );
  await expect(read()).rejects.toThrow();
  expect(calls).toBe(1);
});
for (const [name, change] of [
  ["not exited", () => ({ ...result(), exited: false })],
  ["failed exit", () => ({ ...result(), status: 1 })],
  ["partial JSON", () => ({ ...result(), stdout: "[" })],
  [
    "foreign identity",
    () => ({
      ...result(),
      stdout: completeTrackerFixture({ ...identity, database: "foreign" }, []),
    }),
  ],
] as const)
  test(`${name} cannot borrow a complete child payload`, async () => {
    const read = ownTrackerReader(home(), async () => change());
    await expect(read()).rejects.toThrow();
  });
test("overlapping reads share one child; a later refresh starts a fresh read", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const read = ownTrackerReader(home(), async () => {
    calls++;
    await hold;
    return result();
  });
  const one = read(),
    two = read();
  expect(calls).toBe(1);
  release();
  expect(await one).toEqual(await two);
  await read();
  expect(calls).toBe(2);
});
test("configuration admission never guesses server routes, credentials or ambient environment files", () => {
  for (const [file, body] of [
    ["config.yaml", "dolt.server-host: other\n"],
    [".env", "BEADS_DIR=other\n"],
    ["dolt-server.port", "0\n"],
    [
      "metadata.json",
      JSON.stringify({
        backend: "dolt",
        dolt_mode: "embedded",
        dolt_database: identity.database,
        project_id: identity.projectId,
      }),
    ],
  ]) {
    const root = home();
    writeFileSync(join(root, ".beads", file!), body!);
    expect(() => captureOwnTracker(root)).toThrow(
      "supported initialized own-workspace tracker is unavailable",
    );
  }
});
test("an injected child failure cannot expose command, tracker or SQL text", async () => {
  const read = ownTrackerReader(home(), async () => {
    throw Error("private database and SQL");
  });
  await expect(read()).rejects.toThrow(
    "Complete workspace tracker unavailable.",
  );
});
