import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexTaskStartRequest } from "../../types/codex-owned-task";
import { liveChildCount } from "../executors/supervisor";
import { createProjectStore } from "../projects/store";
import { scratchDirs } from "../test-scratch";
import { createCodexOwnedTaskService } from "./codex-owned-admission";
import { createCodexTaskRuntime } from "./codex-task-runtime";

const scratch = scratchDirs();
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0).reverse()) await stop();
  scratch.cleanup();
});
async function fixture(mode = "normal") {
  const root = scratch.make("codex-owned-admission-");
  const home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(join(root, ".git"));
  mkdirSync(configHome);
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass = ["CODEX_RUNTIME_MODE", "CODEX_RUNTIME_LOG"]\n',
  );
  const project = (
    await createProjectStore(home).create(
      {
        slug: "alpha",
        name: "Alpha",
        description: "",
        icon: "A",
        workspaces: [{ root, repositories: [root], epicIds: ["alpha-1"] }],
      },
      0,
    )
  ).projects[0];
  if (!project) throw Error("Missing planted project");
  const log = join(root, "fake.jsonl");
  const fake = join(import.meta.dir, "fixtures/codex-task-runtime-cli.ts");
  const runtime = createCodexTaskRuntime({
    root,
    home,
    configHome,
    command: [process.execPath, fake],
    syncCommand: [process.execPath, fake, "--sync"],
    environment: {
      ...process.env,
      CODEX_RUNTIME_MODE: mode,
      CODEX_RUNTIME_LOG: log,
    },
    timeoutMs: 5000,
  });
  const open = () => {
    const service = createCodexOwnedTaskService({
      root,
      home,
      runtime,
      async validateScope(projectId, metadata) {
        if (
          projectId !== project.id ||
          metadata.repository !== root ||
          metadata.worktree !== root
        )
          throw Error("Foreign planted scope");
      },
    });
    close.push(() => service.close());
    return service;
  };
  const request: CodexTaskStartRequest = {
    provider: "codex",
    requestId: randomUUID(),
    smith: "codex-journeyman",
    repository: root,
    worktree: root,
    beadId: "alpha-1",
    launch: {
      mode: "task",
      model: "gpt-example-exact",
      sandbox: "read-only",
      approvalPolicy: "never",
      prompt: "  Private Codex question 🌱\n",
      attachments: [
        { kind: "text", name: "note.txt", text: "PRIVATE-ATTACHMENT" },
      ],
    },
  };
  const records = (): Record<string, unknown>[] => {
    if (!existsSync(log)) return [];
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw Error("Unreadable fake log");
    }
  };
  return { root, home, project, request, open, records };
}

test("Codex Task Start journals its exact private snapshot and confirmed identity, and exact retry after recreation never dispatches twice", async () => {
  const f = await fixture();
  let service = f.open();
  const started = await service.start(f.project.id, f.request);
  await service.settled(f.project.id, started.session.id);
  const page = await service.read(f.project.id, started.session.id);
  expect(page.turns[0]?.phase).toBe("completed");
  expect(started.session).toMatchObject({
    provider: "codex",
    mode: "task",
    requestedModel: f.request.launch.model,
    requestedEffort: null,
  });
  expect(page.binding).toMatchObject({
    provider: "codex",
    sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  });
  expect(page.frames[0]?.event).toMatchObject({
    kind: "user",
    text: f.request.launch.prompt,
    codexTask: {
      provider: "codex",
      launch: {
        prompt: f.request.launch.prompt,
        attachments: f.request.launch.attachments,
      },
    },
  });
  expect(
    page.frames
      .filter((frame) => frame.event.kind === "text")
      .map((frame) => (frame.event.kind === "text" ? frame.event.text : ""))
      .join(""),
  ).toBe("Runtime private reply 🌱");
  expect(
    page.frames.find((frame) => frame.event.kind === "coding-usage")?.event,
  ).toMatchObject({
    kind: "coding-usage",
    provider: "codex",
    usage: { inputTokens: 9, outputTokens: 6 },
  });
  expect(page.frames.some((frame) => frame.event.kind === "model")).toBe(false);
  const original = JSON.stringify(f.records());
  await service.close();
  service = f.open();
  expect(
    (await service.start(f.project.id, f.request)).receipt.turn.phase,
  ).toBe("completed");
  expect(JSON.stringify(f.records())).toBe(original);
  await expect(
    service.start(f.project.id, {
      ...f.request,
      launch: { ...f.request.launch, prompt: "Changed" },
    }),
  ).rejects.toThrow();
  await expect(
    service.send(f.project.id, started.session.id, {
      requestId: randomUUID(),
      expectedRevision: page.revision,
      text: "Another turn",
      about: [],
    }),
  ).rejects.toThrow("Task");
  expect(f.records().filter((record) => record.kind === "task")).toHaveLength(
    1,
  );
});

test("explicit Codex Task Stop settles only after the actual native fake tree is gone", async () => {
  const baseline = liveChildCount();
  const f = await fixture("hang-tree"),
    service = f.open();
  const started = await service.start(f.project.id, f.request);
  const deadline = Date.now() + 5000;
  while (!f.records().some((record) => record.kind === "task")) {
    if (Date.now() > deadline) throw Error("The fake Task did not start");
    await Bun.sleep(20);
  }
  await service.stop(f.project.id, started.session.id, f.request.requestId);
  await service.settled(f.project.id, started.session.id);
  expect(
    (await service.read(f.project.id, started.session.id)).turns[0]?.phase,
  ).toBe("cancelled");
  const record = f.records().find((row) => row.kind === "task");
  if (typeof record?.pid !== "number" || typeof record.childPid !== "number")
    throw Error("Missing actual tree");
  for (const pid of [record.pid, record.childPid])
    expect(() => process.kill(pid, 0)).toThrow();
  expect(liveChildCount()).toBe(baseline);
});
