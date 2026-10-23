import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildChildEnv } from "../executors/env";
import { ensurePrivateHome } from "../hearth/home-guard";
import { FIXTURE_PROJECT_ID } from "../projects/testing";
import { scratchDirs } from "../test-scratch";
import {
  executeOriginalProjectShift,
  parseProjectShiftExecutionArgs,
} from "./execution";
import { projectShiftReceiptSchema } from "./protocol";
import {
  createProjectShiftRegistry,
  projectShiftRegistryFile,
} from "./registry";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
const request = {
  requestId: "b14cc7eb-3231-4930-a288-d411c5ee0426",
  expectedCatalogRevision: 1,
  options: {
    for: "2h",
    concurrency: 2,
    maxBeads: 4,
    maxUsd: 10,
    repairs: 3,
    base: "master",
  },
};
async function fixture() {
  const root = scratch.make("project-shift-execution-"),
    home = join(root, "home");
  mkdirSync(join(root, ".git"));
  ensurePrivateHome(home);
  const registry = createProjectShiftRegistry({ root, home });
  const saved = await registry.reserve(
    FIXTURE_PROJECT_ID,
    request,
    async () => ({ shiftId: "shift-20261023-063000-0001" }),
  );
  return {
    root,
    home,
    registry,
    intent: saved.intent,
    projectId: FIXTURE_PROJECT_ID,
    requestId: request.requestId,
  };
}
test("the compiled child entry accepts only an existing project and original UUID, never paths, bounds, provider flags or credentials", () => {
  expect(
    parseProjectShiftExecutionArgs([FIXTURE_PROJECT_ID, request.requestId]),
  ).toEqual({ projectId: FIXTURE_PROJECT_ID, requestId: request.requestId });
  for (const args of [
    [],
    [FIXTURE_PROJECT_ID],
    [FIXTURE_PROJECT_ID, request.requestId, "--root", "/other"],
    ["--project", FIXTURE_PROJECT_ID],
    [FIXTURE_PROJECT_ID, "../outside"],
  ])
    expect(() => parseProjectShiftExecutionArgs(args)).toThrow();
});
test("execution claims once before mutable preparation, so a failed or lost child result is read without another engine entry", async () => {
  const f = await fixture();
  await f.registry.markAttempted(
    f.projectId,
    f.requestId,
    f.intent.requestHash,
  );
  let prepared = 0,
    ran = 0;
  const runtime = {
    attended: true as const,
    prepare: async () => {
      prepared++;
    },
    run: async () => {
      ran++;
      throw Error("PRIVATE-EXECUTION-RESULT");
    },
  };
  const values = await Promise.all([
    executeOriginalProjectShift({ ...f, runtime }),
    executeOriginalProjectShift({ ...f, runtime }),
  ]);
  expect(prepared).toBe(1);
  expect(ran).toBe(1);
  expect(values.every((value) => value.observation.phase === "unknown")).toBe(
    true,
  );
  expect(JSON.stringify(values)).not.toContain("PRIVATE");
  expect(
    f.registry.read(f.projectId, f.requestId).executionStartedAt,
  ).toBeTruthy();
  await executeOriginalProjectShift({
    ...f,
    runtime: {
      ...runtime,
      prepare: async () => {
        throw Error("mutable config unavailable");
      },
    },
  });
  expect(ran).toBe(1);
});
test("a raw reservation or unavailable attended adapter cannot enter the engine and preserves the original bytes", async () => {
  const f = await fixture(),
    file = projectShiftRegistryFile(f.home),
    before = readFileSync(file, "utf8");
  let ran = 0;
  const runtime = {
    attended: true as const,
    prepare: async () => {},
    run: async () => {
      ran++;
    },
  };
  await expect(
    executeOriginalProjectShift({ ...f, runtime }),
  ).rejects.toMatchObject({ status: 409 });
  expect(readFileSync(file, "utf8")).toBe(before);
  await f.registry.markAttempted(
    f.projectId,
    f.requestId,
    f.intent.requestHash,
  );
  const attempted = readFileSync(file, "utf8");
  await expect(executeOriginalProjectShift(f)).rejects.toMatchObject({
    status: 503,
  });
  expect(readFileSync(file, "utf8")).toBe(attempted);
  expect(ran).toBe(0);
});

test("the actual source child claims its original once and retains an unknown receipt when mutable preparation refuses", async () => {
  const f = await fixture();
  await f.registry.markAttempted(
    f.projectId,
    f.requestId,
    f.intent.requestHash,
  );
  const file = projectShiftRegistryFile(f.home),
    before = f.registry.read(f.projectId, f.requestId);
  const command = [
    process.execPath,
    join(import.meta.dir, "execution-entry.ts"),
    f.projectId,
    f.requestId,
  ];
  const options = {
    cwd: f.root,
    env: {
      ...buildChildEnv(process.env, []),
      AGENT_FORGE_HOME: f.home,
      HOME: f.root,
      USERPROFILE: f.root,
    },
    stdin: "ignore" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  };
  const child = Bun.spawn(command, options);
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(0);
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw Error("Invalid child observation envelope");
    }
    expect(value).toMatchObject({ ok: true, error: null });
    if (!value || typeof value !== "object" || !("data" in value))
      throw Error("Missing original child receipt");
    const receipt = projectShiftReceiptSchema.parse(value.data),
      original = f.registry.read(f.projectId, f.requestId);
    expect(original.executionStartedAt).toBeTruthy();
    expect({ ...original, executionStartedAt: null }).toEqual({
      ...before,
      executionStartedAt: null,
    });
    expect(receipt.intent).toEqual(original);
    expect(receipt.observation.phase).toBe("unknown");
    expect(existsSync(join(f.home, "shifts"))).toBe(false);
    expect(existsSync(join(f.home, "sessions"))).toBe(false);
    const after = readFileSync(file, "utf8"),
      repeated = Bun.spawnSync(command, { ...options, timeout: 5000 });
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stderr.toString()).toBe("");
    let repeatedValue: unknown;
    try {
      repeatedValue = JSON.parse(repeated.stdout.toString());
    } catch {
      throw Error("Invalid repeated child observation envelope");
    }
    expect(repeatedValue).toMatchObject({ ok: true, error: null });
    expect(readFileSync(file, "utf8")).toBe(after);
    expect(existsSync(join(f.home, "shifts"))).toBe(false);
    expect(existsSync(join(f.home, "sessions"))).toBe(false);
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
}, 15_000);
