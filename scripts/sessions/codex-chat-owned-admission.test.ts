import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedSessionLifecycle } from "../../apps/desktop/src/session-activity";
import type { CodexChatStartRequest } from "../../types/codex-owned-chat";
import { conversationFile } from "../conversations/paths";
import { createProjectStore } from "../projects/store";
import { scratchDirs } from "../test-scratch";
import { createCodexOwnedChatService } from "./codex-chat-owned-admission";
import { createCodexChatRuntime } from "./codex-chat-runtime";
import { createSessionLibrary } from "./library";
import { sessionTranscriptExportSchema } from "./library-protocol";
import { sessionRegistryFile } from "./registry";

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
  return { root, home, project, request, open, records, runtime };
}

test("owned Chat persists its private snapshot and resumes the exact native thread after service recreation", async () => {
  const f = await fixture();
  let service = f.open();
  const started = await service.start(f.project.id, f.request);
  await service.settled(f.project.id, started.session.id);
  let page = await service.read(f.project.id, started.session.id);
  expect(page.turns[0]?.phase).toBe("completed");
  expect(
    page.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome",
    )?.event,
  ).toMatchObject({
    kind: "coding-chat",
    provider: "codex",
    event: {
      kind: "outcome",
      outcome: {
        phase: "completed",
        exitCode: 0,
        stopped: false,
        timedOut: false,
        threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
        observedModel: null,
      },
    },
  });
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
  const path = conversationFile(f.home, f.project.id, {
      kind: "session",
      projectId: f.project.id,
      sessionId: started.session.id,
    }),
    before = readFileSync(path),
    registryBefore = readFileSync(sessionRegistryFile(f.home));
  const library = createSessionLibrary({ root: f.root, home: f.home });
  const exported = library.exportTranscript(f.project.id, started.session.id);
  expect(sessionTranscriptExportSchema.safeParse(exported).success).toBe(true);
  expect(exported.session).toMatchObject({ provider: "codex", mode: "chat" });
  expect(exported.conversation.turns).toHaveLength(2);
  expect(
    exported.conversation.frames
      .filter((frame) => frame.event.kind === "user")
      .map((frame) => frame.event),
  ).toMatchObject([
    { codexChat: { launch: { prompt: f.request.launch.prompt } } },
    { codexChat: { launch: { prompt: "Second explicit turn" } } },
  ]);
  const archived = await library.archive(f.project.id, started.session.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  });
  expect(archived.receipt?.outcome).toBe("applied");
  expect(
    (
      await library.archive(f.project.id, started.session.id, {
        requestId: randomUUID(),
        expectedRevision: archived.entry.revision,
        archived: false,
      })
    ).entry.archived,
  ).toBe(false);
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(sessionRegistryFile(f.home))).toEqual(registryBefore);
});

test("a later Chat turn cannot replace the original captured canonical directory identity", async () => {
  const f = await fixture(),
    service = f.open(),
    started = await service.start(f.project.id, f.request);
  await service.settled(f.project.id, started.session.id);
  const page = await service.read(f.project.id, started.session.id),
    prepare = f.runtime.prepare;
  const changed = spyOn(f.runtime, "prepare").mockImplementation(
    async (input) => ({
      ...(await prepare(input)),
      canonicalCwd: `${f.root}-retargeted`,
    }),
  );
  try {
    await expect(
      service.send(f.project.id, started.session.id, {
        requestId: randomUUID(),
        expectedRevision: page.revision,
        text: "Second turn",
        about: [],
      }),
    ).rejects.toThrow("changed");
    expect(
      f.records().filter((row) => row.method === "turn/start"),
    ).toHaveLength(1);
    expect(
      (await service.read(f.project.id, started.session.id)).turns,
    ).toHaveLength(1);
  } finally {
    changed.mockRestore();
  }
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
  while (!(await service.approvals(f.project.id, sessionId)).pending.length) {
    if (Date.now() > deadline)
      throw Error("The native approval never became actionable");
    await Bun.sleep(20);
  }
  const pending = (await service.approvals(f.project.id, sessionId)).pending[0];
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
  expect((await service.approvals(f.project.id, sessionId)).pending).toEqual(
    [],
  );
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

test.each([
  "deadline",
  "Stop",
] as const)("owned native Chat %s retains actual terminal facts and dead helper evidence after reopening without another prompt", async (action) => {
  const f = await fixture("hang");
  let service = f.open();
  const started = await service.start(f.project.id, f.request),
    sessionId = started.session.id;
  let tree: Record<string, unknown> | undefined;
  const deadline = Date.now() + 4000;
  while (!(tree = f.records().find((row) => row.kind === "tree"))) {
    if (Date.now() > deadline)
      throw Error("Native Chat did not reach its held live turn");
    await Bun.sleep(10);
  }
  const pid = tree.pid,
    childPid = tree.childPid;
  expect(typeof pid).toBe("number");
  expect(typeof childPid).toBe("number");
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  if (action === "Stop")
    await service.stop(f.project.id, sessionId, f.request.requestId);
  await service.settled(f.project.id, sessionId);
  await service.close();
  service = f.open();
  const saved = await service.read(f.project.id, sessionId);
  const report = saved.frames.find(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "outcome",
  )?.event;
  expect(report).toMatchObject({
    kind: "coding-chat",
    provider: "codex",
    event: {
      kind: "outcome",
      outcome: {
        timedOut: action === "deadline",
        stopped: true,
        observedModel: null,
      },
    },
  });
  expect(
    ownedSessionLifecycle(saved, {
      mode: "chat",
      loaded: true,
      live: false,
      stopping: false,
      feedInterrupted: false,
      readError: "",
    }).state,
  ).toBe(action === "deadline" ? "timed-out" : "stopped");
  const alive = (value: unknown) => {
    if (typeof value !== "number") throw Error("Missing witnessed PID");
    try {
      if (
        process.platform === "linux" &&
        /\) Z(?: |$)/.test(readFileSync(`/proc/${value}/stat`, "utf8"))
      )
        return false;
      process.kill(value, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive(pid)).toBe(false);
  expect(alive(childPid)).toBe(false);
  const calls = f.records().filter((row) => row.method === "turn/start").length;
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    calls,
  );
  expect(
    createSessionLibrary({ root: f.root, home: f.home })
      .exportTranscript(f.project.id, sessionId)
      .conversation.frames.some(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "outcome",
      ),
  ).toBe(true);
});
