import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ConversationBinding,
  ConversationEvent,
} from "../../types/conversation";
import type { ClaudeSessionLaunch } from "../../types/session-launch";
import type { SessionTurnSnapshot } from "../../types/session-turn";
import { liveChildCount } from "../executors/supervisor";
import { projectFixture } from "../projects/testing";
import { scratchDirs } from "../test-scratch";
import { serializeClaudeLaunch } from "./claude-launch";
import { createClaudeSessionTransport } from "./claude-transport";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function fixture(mode = "normal", timeoutMs = 5000) {
  const root = scratch.make("coding-transport-");
  const home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(home);
  mkdirSync(configHome);
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[workflow]\ndefault_crew = "claude-master"\n[execution.env]\npass = ["CODING_FIXTURE_MODE", "CODING_FIXTURE_RECORD", "TEST_OPERATOR_SECRET", "AGENT_FORGE_FORGED", "FORGE_SLUG"]\n',
  );
  const recordFile = join(root, "record.json");
  const environment = {
    ...process.env,
    CODING_FIXTURE_MODE: mode,
    CODING_FIXTURE_RECORD: recordFile,
    TEST_OPERATOR_SECRET: "prefix-synthetic-operator-token-suffix",
    AGENT_FORGE_FORGED: "forged",
    FORGE_SLUG: "forged",
  };
  const transport = createClaudeSessionTransport({
    root,
    home,
    configHome,
    command: [
      process.execPath,
      join(import.meta.dir, "fixtures/coding-cli.ts"),
    ],
    environment,
    timeoutMs,
    operatorToken: () => "synthetic-operator-token",
    modelEfforts: { "claude-sonnet-5-5": ["high"] },
  });
  const project = projectFixture(root);
  const launch = (
    prompt: string,
    resume?: ConversationBinding,
  ): ClaudeSessionLaunch => ({
    mode: "chat",
    model: "claude-sonnet-5-5",
    effort: "high",
    prompt,
    context: {
      projectId: project.id,
      repository: root,
      worktree: root,
      beadId: "alpha-1",
      about: [],
    },
    ...(resume ? { resumeSessionId: resume.sessionId } : {}),
  });
  const prepare = (prompt: string, resume?: ConversationBinding) =>
    transport.prepare({
      smith: "claude-journeyman",
      cwd: root,
      launch: launch(prompt, resume),
    });
  const run = async (
    session: SessionTurnSnapshot,
    resume: ConversationBinding | null = null,
    signal = new AbortController().signal,
  ) => {
    const events: ConversationEvent[] = [];
    const result = await transport.run(
      {
        project,
        root,
        input: {
          requestId: randomUUID(),
          expectedRevision: 0,
          text: session.launch.prompt,
          about: [],
          session,
        },
        resume,
      },
      async (event) => {
        events.push(event);
      },
      signal,
    );
    return { result, events };
  };
  const recording = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(recordFile, "utf8"));
    } catch {
      throw new Error("Invalid coding fixture recording");
    }
  };
  return {
    root,
    home,
    project,
    environment,
    recordFile,
    recording,
    transport,
    prepare,
    run,
    launch,
  };
}

test("two explicit fake CLI turns use the immutable selected smith, exact resume, private stdin and filtered environment", async () => {
  const baseline = liveChildCount();
  const f = fixture();
  const snapshot = await f.prepare('Private "quotes" & $literal %PATH%\n🌱');
  expect(snapshot.smith).toBe("claude-journeyman");
  const first = await f.run(snapshot);
  expect(first.result.phase).toBe("completed");
  const binding = first.events.find((event) => event.kind === "identity");
  if (!binding || binding.kind !== "identity")
    throw new Error("Missing provider identity");
  expect(
    first.events
      .filter((event) => event.kind === "text")
      .map((event) => event.text)
      .join(""),
  ).toBe("Coding reply 🌱!");
  const serialized = serializeClaudeLaunch(
    snapshot.launch,
    snapshot.capabilities,
  );
  expect(f.recording()).toMatchObject({
    argv: serialized.argv,
    stdin: serialized.stdin,
    cwd: f.root,
    operatorSecret: false,
    forged: false,
    adapter: "1",
    smith: "claude-journeyman",
    bead: "alpha-1",
  });
  const second = await f.run(
    await f.prepare("Second explicit turn", binding),
    binding,
  );
  expect(second.result.phase).toBe("completed");
  expect(f.recording().argv).toEqual(
    expect.arrayContaining(["--resume", binding.sessionId]),
  );
  expect(second.events).toContainEqual(binding);
  expect(liveChildCount()).toBe(baseline);
});

test("capability, smith and effort failures refuse before a provider turn is started", async () => {
  const legacy = fixture("legacy");
  await expect(legacy.prepare("Not dispatched")).rejects.toThrow("capability");
  expect(existsSync(legacy.recordFile)).toBe(false);
  const f = fixture();
  await expect(
    f.transport.prepare({
      smith: "codex-journeyman",
      cwd: f.root,
      launch: f.launch("Wrong provider"),
    }),
  ).rejects.toThrow("enabled Claude");
  await expect(
    f.transport.prepare({
      smith: "claude-journeyman",
      cwd: f.root,
      launch: { ...f.launch("Unsupported effort"), effort: "max" },
    }),
  ).rejects.toThrow("effort");
  expect(existsSync(f.recordFile)).toBe(false);
});

test("snapshot text, project and resume mismatches refuse dispatch without modifying the saved launch", async () => {
  const f = fixture();
  const session = await f.prepare("Original prompt");
  const run = (
    text: string,
    project = f.project,
    resume: ConversationBinding | null = null,
  ) =>
    f.transport.run(
      {
        project,
        root: f.root,
        input: {
          requestId: randomUUID(),
          expectedRevision: 0,
          text,
          about: [],
          session,
        },
        resume,
      },
      async () => {},
      new AbortController().signal,
    );
  await expect(run("Changed prompt")).rejects.toThrow("does not match");
  await expect(
    run("Original prompt", { ...f.project, id: "project-other" }),
  ).rejects.toThrow("does not match");
  await expect(
    run("Original prompt", f.project, {
      provider: "claude",
      sessionId: "402b7361-efc4-4fe0-88dc-9ca7f96fe277",
      version: "2.1.296",
    }),
  ).rejects.toThrow("does not match");
  expect(session.launch.prompt).toBe("Original prompt");
  expect(existsSync(f.recordFile)).toBe(false);
});

test("foreign identity, malformed streams, missing results and exit failures never claim completion", async () => {
  const f = fixture();
  const first = await f.run(await f.prepare("First"));
  const binding = first.events.find((event) => event.kind === "identity");
  if (!binding || binding.kind !== "identity")
    throw new Error("Missing fixture binding");
  f.environment.CODING_FIXTURE_MODE = "foreign";
  const foreign = await f.run(await f.prepare("Second", binding), binding);
  expect(foreign.result.phase).toBe("unknown");
  expect(foreign.events.filter((event) => event.kind === "identity")).toEqual(
    [],
  );
  for (const mode of [
    "malformed",
    "overflow",
    "missing-result",
    "exit-after-result",
    "provider-error",
  ]) {
    const next = fixture(mode);
    const outcome = await next.run(await next.prepare("Private turn"));
    expect(outcome.result.phase).toBe(
      mode === "provider-error" ? "failed" : "unknown",
    );
  }
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Coding fixture deadline");
    await Bun.sleep(20);
  }
}
function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Stop and timeout settle only after the fake provider and its child are gone", async () => {
  const baseline = liveChildCount();
  for (const timeout of [false, true]) {
    const f = fixture("hang-tree", timeout ? 200 : 5000);
    const controller = new AbortController();
    const job = f.run(await f.prepare("Hang safely"), null, controller.signal);
    try {
      await until(() => existsSync(f.recordFile));
      if (!timeout) controller.abort();
      const outcome = await job;
      expect(outcome.result.phase).toBe(timeout ? "unknown" : "failed");
      const { pid, childPid } = f.recording();
      if (typeof pid !== "number" || typeof childPid !== "number")
        throw new Error("Missing fake process tree");
      await until(() => !running(pid) && !running(childPid));
      expect(running(pid) || running(childPid)).toBe(false);
    } finally {
      controller.abort();
      await job;
    }
  }
  expect(liveChildCount()).toBe(baseline);
}, 15_000);

test("a private transcript failure retains the accepted partials and stops supervision", async () => {
  const f = fixture();
  const session = await f.prepare("Store failure");
  const baseline = liveChildCount();
  const outcome = await f.transport.run(
    {
      project: f.project,
      root: f.root,
      input: {
        requestId: randomUUID(),
        expectedRevision: 0,
        text: session.launch.prompt,
        about: [],
        session,
      },
      resume: null,
    },
    async () => {
      throw new Error("synthetic private storage failure");
    },
    new AbortController().signal,
  );
  expect(outcome.phase).toBe("unknown");
  expect(outcome.reason).not.toContain("synthetic private storage failure");
  expect(liveChildCount()).toBe(baseline);
});
