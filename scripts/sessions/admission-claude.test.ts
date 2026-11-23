import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProjectStore } from "../projects/store";
import { scratchDirs } from "../test-scratch";
import { createOwnedSessionService } from "./admission";
import { createClaudeSessionTransport } from "./claude-transport";

const scratch = scratchDirs();
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0).reverse()) await stop();
  scratch.cleanup();
});
async function fixture(mode = "normal") {
  const root = scratch.make("admission-coding-");
  const home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(join(root, ".git"));
  mkdirSync(configHome);
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[workflow]\ndefault_crew = "claude-master"\n[execution.env]\npass = ["CODING_FIXTURE_MODE", "CODING_FIXTURE_RECORD"]\n',
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
  if (!project) throw new Error("Missing planted project");
  const recordFile = join(root, "record.json");
  const runtime = createClaudeSessionTransport({
    root,
    home,
    configHome,
    command: [
      process.execPath,
      join(import.meta.dir, "fixtures/coding-cli.ts"),
    ],
    environment: {
      ...process.env,
      CODING_FIXTURE_MODE: mode,
      CODING_FIXTURE_RECORD: recordFile,
    },
    timeoutMs: 5000,
  });
  const open = () => {
    const service = createOwnedSessionService({
      root,
      home,
      runtime,
      async validateScope(projectId, metadata) {
        if (
          projectId !== project.id ||
          metadata.repository !== root ||
          metadata.worktree !== root
        )
          throw new Error("Foreign fixture scope");
      },
    });
    close.push(() => service.close());
    return service;
  };
  const request = (kind: "task" | "chat") => ({
    requestId: randomUUID(),
    smith: "claude-journeyman",
    repository: root,
    worktree: root,
    launch: {
      mode: kind,
      model: "claude-sonnet-5-5",
      prompt: `Private ${kind} question 🌱`,
      attachments: [
        {
          kind: "text" as const,
          name: "context.txt",
          text: "Private attached body",
        },
      ],
    },
  });
  const recording = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(recordFile, "utf8"));
    } catch {
      throw new Error("Invalid admission fake recording");
    }
  };
  return { root, home, project, recordFile, recording, open, request };
}

test("actual coding Start persists a private identity and Chat resumes it after service recreation; Task remains one turn", async () => {
  const f = await fixture();
  let service = f.open();
  const start = f.request("chat");
  const admitted = await service.start(f.project.id, start);
  await service.settled(f.project.id, admitted.session.id);
  const first = await service.read(f.project.id, admitted.session.id);
  expect(first.turns[0]?.phase).toBe("completed");
  expect(first.binding?.provider).toBe("claude");
  expect(first.binding?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.frames[0]?.event).toMatchObject({
    kind: "user",
    text: start.launch.prompt,
    session: {
      smith: start.smith,
      launch: { attachments: start.launch.attachments },
    },
  });
  expect(
    first.frames
      .filter((frame) => frame.event.kind === "text")
      .map((frame) => (frame.event.kind === "text" ? frame.event.text : ""))
      .join(""),
  ).toBe("Coding reply 🌱!");
  const originalRecord = readFileSync(f.recordFile, "utf8");
  await service.close();
  service = f.open();
  expect(
    (await service.read(f.project.id, admitted.session.id)).binding,
  ).toEqual(first.binding);
  expect((await service.start(f.project.id, start)).receipt.turn.phase).toBe(
    "completed",
  );
  expect(readFileSync(f.recordFile, "utf8")).toBe(originalRecord);
  const second = await service.send(f.project.id, admitted.session.id, {
    requestId: randomUUID(),
    expectedRevision: first.revision,
    text: "Second explicit Chat turn",
    about: [],
  });
  await service.settled(f.project.id, admitted.session.id);
  const continued = await service.read(f.project.id, admitted.session.id);
  expect(continued.request).toBeNull();
  expect(
    continued.turns.find((turn) => turn.requestId === second.turn.requestId)
      ?.phase,
  ).toBe("completed");
  expect(continued.binding).toEqual(first.binding);
  expect(f.recording().argv).toEqual(
    expect.arrayContaining(["--resume", first.binding?.sessionId]),
  );
  expect(String(f.recording().stdin)).not.toContain("Private attached body");
  const taskStart = f.request("task");
  const task = await service.start(f.project.id, taskStart);
  await service.settled(f.project.id, task.session.id);
  const taskPage = await service.read(f.project.id, task.session.id);
  expect(taskPage.turns[0]?.phase).toBe("completed");
  expect(taskPage.binding?.sessionId).not.toBe(first.binding?.sessionId);
  const taskRecord = readFileSync(f.recordFile, "utf8");
  await expect(
    service.send(f.project.id, task.session.id, {
      requestId: randomUUID(),
      expectedRevision: taskPage.revision,
      text: "Forbidden second Task turn",
      about: [],
    }),
  ).rejects.toThrow("Task");
  expect(
    (await service.start(f.project.id, taskStart)).receipt.turn.phase,
  ).toBe("completed");
  expect(readFileSync(f.recordFile, "utf8")).toBe(taskRecord);
}, 15_000);

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Admission coding fixture deadline");
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

test("admission Stop confirms cancellation only after the actual fake provider tree has ended", async () => {
  const f = await fixture("hang-tree");
  const service = f.open(),
    start = f.request("chat");
  const admitted = await service.start(f.project.id, start);
  await until(() => existsSync(f.recordFile));
  const { pid, childPid } = f.recording();
  if (typeof pid !== "number" || typeof childPid !== "number")
    throw new Error("Missing fake tree identity");
  expect(running(pid)).toBe(true);
  const pending = await service.stop(
    f.project.id,
    admitted.session.id,
    start.requestId,
  );
  expect(pending.turn.phase).toBe("cancelling");
  await service.settled(f.project.id, admitted.session.id);
  const stopped = await service.read(f.project.id, admitted.session.id, {
    requestId: start.requestId,
  });
  expect(stopped.request?.phase).toBe("cancelled");
  await until(() => !running(pid) && !running(childPid));
  expect(running(pid) || running(childPid)).toBe(false);
}, 15_000);
