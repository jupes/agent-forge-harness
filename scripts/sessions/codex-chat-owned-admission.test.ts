import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexChatStartRequest } from "../../types/codex-owned-chat";
import { createProjectStore } from "../projects/store";
import { scratchDirs } from "../test-scratch";
import { createCodexOwnedChatService } from "./codex-chat-owned-admission";
import { createCodexChatRuntime } from "./codex-chat-runtime";

const scratch = scratchDirs(),
  closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  scratch.cleanup();
});
async function fixture(mode = "normal") {
  const root = scratch.make("codex-chat-owned-"),
    home = join(root, "home"),
    configHome = join(root, "config");
  mkdirSync(join(root, ".git"));
  mkdirSync(configHome);
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass = ["CODEX_CHAT_MODE", "CODEX_CHAT_LOG"]\n',
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
  if (!project) throw Error("No planted project");
  const fake = join(import.meta.dir, "fixtures/codex-app-server-cli.ts"),
    log = join(root, "record.jsonl");
  const runtime = createCodexChatRuntime({
    root,
    home,
    configHome,
    command: [process.execPath, fake],
    syncCommand: [process.execPath, fake, "--sync"],
    environment: { ...process.env, CODEX_CHAT_MODE: mode, CODEX_CHAT_LOG: log },
    timeoutMs: 5000,
    approvalTimeoutMs: 3000,
  });
  const open = () => {
    const service = createCodexOwnedChatService({
      root,
      home,
      runtime,
      async validateScope(id, metadata) {
        if (
          id !== project.id ||
          metadata.repository !== root ||
          metadata.worktree !== root
        )
          throw Error("Foreign planted scope");
      },
    });
    closing.push(() => service.close());
    return service;
  };
  const request: CodexChatStartRequest = {
    provider: "codex",
    requestId: randomUUID(),
    smith: "codex-journeyman",
    repository: root,
    worktree: root,
    launch: {
      mode: "chat",
      model: "exact-model",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      prompt: "Private first turn",
      attachments: [{ kind: "text", name: "note", text: "Private context" }],
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
      throw Error("Invalid completed fake log");
    }
  };
  return { root, home, project, request, open, records };
}

test("owned Chat persists its private snapshot and resumes the exact native thread after service recreation", async () => {
  const f = await fixture();
  let service = f.open();
  const started = await service.start(f.project.id, f.request);
  await service.settled(f.project.id, started.session.id);
  let page = await service.read(f.project.id, started.session.id);
  expect(page.turns[0]?.phase).toBe("completed");
  expect(page.frames[0]?.event).toMatchObject({
    kind: "user",
    codexChat: {
      launch: {
        prompt: f.request.launch.prompt,
        attachments: f.request.launch.attachments,
      },
    },
  });
  expect(page.binding).toMatchObject({
    provider: "codex",
    sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  });
  await service.close();
  service = f.open();
  await service.start(f.project.id, f.request);
  await service.send(f.project.id, started.session.id, {
    requestId: randomUUID(),
    expectedRevision: page.revision,
    text: "Second explicit turn",
    about: [],
  });
  await service.settled(f.project.id, started.session.id);
  page = await service.read(f.project.id, started.session.id);
  expect(page.turns.map((turn) => turn.phase)).toEqual([
    "completed",
    "completed",
  ]);
  const calls = f.records().filter((row) => row.kind === "rpc");
  expect(calls.filter((row) => row.method === "turn/start")).toHaveLength(2);
  expect(calls.filter((row) => row.method === "thread/start")).toHaveLength(1);
  expect(
    calls.find((row) => row.method === "thread/resume")?.params,
  ).toMatchObject({ threadId: page.binding?.sessionId, excludeTurns: true });
  expect(page.frames.some((frame) => frame.event.kind === "model")).toBe(false);
});

test.each([
  "accept",
  "decline",
  "cancel",
] as const)("owned native %s records an immutable intent, and restart reconciliation cannot release a second reply", async (decision) => {
  const f = await fixture("approval-command");
  let service = f.open();
  const started = await service.start(f.project.id, f.request),
    sessionId = started.session.id;
  const deadline = Date.now() + 4000;
  while (!service.approvals(f.project.id, sessionId).pending.length) {
    if (Date.now() > deadline)
      throw Error("The native approval never became actionable");
    await Bun.sleep(20);
  }
  const pending = service.approvals(f.project.id, sessionId).pending[0];
  if (!pending) throw Error("Missing live native callback");
  const request = {
    requestId: randomUUID(),
    turnRequestId: pending.turnRequestId,
    approvalId: pending.approval.id,
    decision,
  };
  const receipt = await service.decide(f.project.id, sessionId, request);
  expect(receipt.state).toBe("recorded");
  await service.settled(f.project.id, sessionId);
  const page = await service.read(f.project.id, sessionId);
  expect(page.turns[0]?.phase).toBe(
    decision === "cancel" ? "failed" : "completed",
  );
  const events = page.frames.map((frame) => frame.event.kind);
  expect(events.indexOf("coding-chat-decision")).toBeGreaterThan(
    events.indexOf("identity"),
  );
  expect(
    page.frames.find((frame) => frame.event.kind === "coding-chat-decision")
      ?.event,
  ).toMatchObject({ receipt });
  expect(service.approvals(f.project.id, sessionId).pending).toEqual([]);
  const answers = f.records().filter((row) => row.kind === "answer");
  expect(answers).toHaveLength(1);
  expect(answers[0]?.result).toEqual({ decision });
  await service.close();
  service = f.open();
  expect(await service.decide(f.project.id, sessionId, request)).toEqual(
    receipt,
  );
  await expect(
    service.decide(f.project.id, sessionId, {
      ...request,
      requestId: randomUUID(),
    }),
  ).rejects.toThrow("recorded");
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(1);
});
