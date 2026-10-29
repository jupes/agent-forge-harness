import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  liveChildCount,
  SupervisorOwnershipRefusalError,
} from "../executors/supervisor";
import { scratchDirs } from "../test-scratch";
import { createProviderInspector } from "./inspect";

const scratch = scratchDirs();
const visibilityObservation = z
  .object({
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    args: z.array(z.string()),
    consoleWindowVisible: z.boolean().nullable(),
  })
  .strict();
afterEach(() => scratch.cleanup());

async function expectPidExited(pid: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error(
    `Provider fixture process ${pid} remained alive after inspection.`,
  );
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("fixed version and authentication probes request hidden child windows", async () => {
  const launches: {
    command: readonly string[];
    windowsHide: boolean | undefined;
  }[] = [];
  const inspector = createProviderInspector({
    root: "/fixture",
    home: "/private-fixture",
    environment: {},
    which: (binary) => `/fixture/${binary}`,
    run: async (command, _env, launchOptions?: { windowsHide: true }) => {
      launches.push({ command, windowsHide: launchOptions?.windowsHide });
      return command.includes("--version")
        ? { exitCode: 0, stdout: "Claude Code 2.1.293", valid: true }
        : {
            exitCode: 1,
            stdout: '{"authMethod":"none","loggedIn":false}',
            valid: true,
          };
    },
  });

  const inspected = await inspector.inspect("claude", []);

  expect(inspected.installation.versionOk).toBe(true);
  expect(inspected.authentication.mode).toBe("signed-out");
  expect(
    launches.map(({ command, windowsHide }) => ({
      command,
      windowsHide,
    })),
  ).toEqual([
    { command: ["/fixture/claude", "--version"], windowsHide: true },
    { command: ["/fixture/claude", "auth", "status"], windowsHide: true },
  ]);
});

test("inspection runs only fixed version/status commands with filtered environment; CLI success alone does not authenticate", async () => {
  const calls: { command: readonly string[]; env: Record<string, string> }[] =
    [];
  const inspector = createProviderInspector({
    root: "/fixture",
    home: "/private-fixture",
    environment: {
      PATH: "/fixture",
      ANTHROPIC_API_KEY: "private-key",
      UNRELATED_SECRET: "discard",
      AGENT_FORGE_OPERATOR_TOKEN: "discard",
      TEST_OPERATOR_SECRET: "prefix-private-operator-suffix",
    },
    which: (binary) => `/fixture/${binary}`,
    operatorToken: () => "private-operator",
    run: async (command, env) => {
      calls.push({ command, env });
      return command.includes("--version")
        ? { exitCode: 0, stdout: "fixture 2.1.293", valid: true }
        : { exitCode: 1, stdout: "unsupported command", valid: true };
    },
    now: () => Date.parse("2026-10-23T06:40:00Z"),
  });
  const found = await inspector.inspect("claude", [
    "ANTHROPIC_API_KEY",
    "AGENT_FORGE_OPERATOR_TOKEN",
    "TEST_OPERATOR_SECRET",
  ]);
  expect(found.installation.versionOk).toBe(true);
  expect(found.installation.version).toBe("2.1.293");
  expect(found.authentication.mode).toBe("unknown");
  expect(calls.map((call) => call.command)).toEqual([
    ["/fixture/claude", "--version"],
    ["/fixture/claude", "auth", "status"],
  ]);
  expect(calls[0]?.env["ANTHROPIC_API_KEY"]).toBe("private-key");
  expect(calls[0]?.env["UNRELATED_SECRET"]).toBeUndefined();
  expect(calls[0]?.env["AGENT_FORGE_OPERATOR_TOKEN"]).toBeUndefined();
  expect(calls[0]?.env["TEST_OPERATOR_SECRET"]).toBeUndefined();
  expect(JSON.stringify(found)).not.toContain("private-key");
});

test("not found, old/unsupported and failed status stay separate; deferred OpenRouter never gains an invented adapter", async () => {
  const calls: string[][] = [];
  const inspector = createProviderInspector({
    root: "/fixture",
    home: "/private-fixture",
    environment: {},
    which: (binary) => (binary === "gemini" ? null : `/fixture/${binary}`),
    run: async (command) => {
      calls.push([...command]);
      return { exitCode: 0, stdout: "fixture 0.1.0", valid: true };
    },
  });
  const missing = await inspector.inspect("gemini", []);
  expect(missing.installation.found).toBe(false);
  expect(missing.authentication.mode).toBe("unknown");
  const old = await inspector.inspect("claude", []);
  expect(old.installation.compatibility).toBe("too-old");
  expect(old.authentication.mode).toBe("unknown");
  const deferred = await inspector.inspect("openrouter", []);
  expect(deferred.adapter.supported).toBe(false);
  expect(deferred.signIn.command).toBeNull();
  expect(deferred.adapter.reason).toContain("OpenCode/ACP");
  expect(
    calls.some(
      (command) => command.includes("auth") || command.includes("login"),
    ),
  ).toBe(false);
});

test("actual supervised status fixture bounds output and time, strips private fields and leaves no live child", async () => {
  const root = scratch.make("provider-status-");
  const before = liveChildCount();
  for (const mode of ["normal", "signed-out", "overflow", "hang"]) {
    const inspector = createProviderInspector({
      root,
      home: root,
      environment: { ...process.env, READINESS_FIXTURE: mode },
      commands: {
        claude: [
          process.execPath,
          join(import.meta.dir, "fixtures/status-cli.ts"),
        ],
      },
      timeoutMs: 2000,
    });
    const report = await inspector.inspect("claude", ["READINESS_FIXTURE"]);
    expect(report.installation.versionOk).toBe(true);
    expect(report.authentication.mode).toBe(
      mode === "normal"
        ? "api-key"
        : mode === "signed-out"
          ? "signed-out"
          : "unknown",
    );
    expect(JSON.stringify(report)).not.toContain(
      "fixture-secret-never-forward",
    );
    expect(JSON.stringify(report)).not.toContain("private@example.test");
    expect(liveChildCount()).toBe(before);
  }
});

test("owned readiness helpers settle before the inspection result returns", async () => {
  const root = scratch.make("provider-owned-readiness-");
  const record = join(root, "probes.jsonl");
  const before = liveChildCount();
  const inspector = createProviderInspector({
    root,
    home: root,
    environment: {
      ...process.env,
      READINESS_FIXTURE: "owned-helper",
      READINESS_FIXTURE_HELPER_DIR: root,
      READINESS_FIXTURE_REQUIRE_EOF: "1",
      READINESS_FIXTURE_RECORD: record,
    },
    commands: {
      claude: [
        process.execPath,
        join(import.meta.dir, "fixtures/status-cli.ts"),
      ],
    },
  });
  try {
    const report = await inspector.inspect("claude", [
      "READINESS_FIXTURE",
      "READINESS_FIXTURE_HELPER_DIR",
      "READINESS_FIXTURE_REQUIRE_EOF",
      "READINESS_FIXTURE_RECORD",
    ]);
    const ready = join(root, "status.ready");
    const helperPid = existsSync(ready)
      ? Number(readFileSync(ready, "utf8"))
      : 0;
    const helperAliveAtReturn =
      Number.isSafeInteger(helperPid) && helperPid > 0
        ? pidIsAlive(helperPid)
        : null;
    expect(report.installation.versionOk).toBe(true);
    expect(report.installation.version).toBe("2.1.293");
    expect(report.authentication.mode).toBe("api-key");
    const probes = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return visibilityObservation.parse(JSON.parse(line));
        } catch {
          throw Error("The readiness fixture wrote an invalid probe record.");
        }
      });
    expect(probes.map(({ args }) => args)).toEqual([
      ["--version"],
      ["auth", "status"],
    ]);
    expect(existsSync(ready)).toBe(true);
    expect(Number.isSafeInteger(helperPid) && helperPid > 0).toBe(true);
    expect(liveChildCount()).toBe(before);
    expect(helperAliveAtReturn).toBe(false);
  } finally {
    const ready = join(root, "status.ready");
    let pid = 0,
      releaseNeeded = false;
    if (existsSync(ready)) {
      pid = Number(readFileSync(ready, "utf8"));
      releaseNeeded = Number.isSafeInteger(pid) && pid > 0 && pidIsAlive(pid);
    }
    writeFileSync(join(root, "status.release"), "release");
    if (Number.isSafeInteger(pid) && pid > 0) {
      await expectPidExited(pid);
      if (releaseNeeded)
        expect(existsSync(join(root, "status.exited"))).toBe(true);
    }
  }
});

test("typed ownership refusal escapes readiness inspection before probe execution", async () => {
  const root = scratch.make("provider-refused-readiness-");
  const record = join(root, "probes.jsonl");
  const before = liveChildCount();
  const guardedPids: number[] = [];
  const inspector = createProviderInspector({
    root,
    home: root,
    environment: {
      ...process.env,
      READINESS_FIXTURE_RECORD: record,
    },
    commands: {
      claude: [
        process.execPath,
        join(import.meta.dir, "fixtures/status-cli.ts"),
      ],
    },
    interactiveGuard(pid) {
      guardedPids.push(pid);
      return null;
    },
  });
  let report: Awaited<ReturnType<typeof inspector.inspect>> | undefined;
  let refusal: unknown;
  try {
    report = await inspector.inspect("claude", ["READINESS_FIXTURE_RECORD"]);
  } catch (error) {
    refusal = error;
  }
  expect(guardedPids).toHaveLength(1);
  const pid = guardedPids[0] ?? 0;
  expect(pid).toBeGreaterThan(0);
  await expectPidExited(pid);
  expect(liveChildCount()).toBe(before);
  expect(existsSync(record)).toBe(false);
  if (report) {
    expect(report.installation.found).toBe(true);
    expect(report.installation.versionOk).toBe(false);
    expect(report.installation.reason).toBe(
      "The bounded version check failed. Authentication was not checked.",
    );
    expect(report.authentication.mode).toBe("unknown");
  }
  expect({
    typed: refusal instanceof SupervisorOwnershipRefusalError,
    message: refusal instanceof Error ? refusal.message : undefined,
  }).toEqual({
    typed: true,
    message: "Interactive child ownership could not be established.",
  });
});

test("actual inspector probes stay bounded and do not show native console windows", async () => {
  const root = scratch.make("provider-hidden-status-");
  const record = join(root, "observations.jsonl");
  const before = liveChildCount();
  const inspector = createProviderInspector({
    root,
    home: root,
    environment: {
      ...process.env,
      READINESS_FIXTURE: "visibility",
      READINESS_FIXTURE_RECORD: record,
    },
    commands: {
      claude: [
        process.execPath,
        join(import.meta.dir, "fixtures/status-cli.ts"),
      ],
    },
    timeoutMs: 2000,
  });

  const report = await inspector.inspect("claude", [
    "READINESS_FIXTURE",
    "READINESS_FIXTURE_RECORD",
  ]);

  expect(report.installation.versionOk).toBe(true);
  expect(report.installation.version).toBe("2.1.293");
  expect(report.authentication.mode).toBe("signed-out");
  expect(liveChildCount()).toBe(before);

  const observations = readFileSync(record, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return visibilityObservation.parse(JSON.parse(line));
      } catch {
        throw Error("The status fixture wrote an invalid observation.");
      }
    });
  expect(observations).toHaveLength(2);
  expect(observations.map(({ args }) => args)).toEqual([
    ["--version"],
    ["auth", "status"],
  ]);
  expect(new Set(observations.map(({ pid }) => pid)).size).toBe(2);
  for (const { pid } of observations) await expectPidExited(pid);
  expect(
    observations.map(({ consoleWindowVisible }) => consoleWindowVisible),
  ).toEqual(
    Array.from({ length: 2 }, () =>
      process.platform === "win32" ? false : null,
    ),
  );
});
