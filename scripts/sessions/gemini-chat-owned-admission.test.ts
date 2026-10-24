import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ownedSessionControls } from "../../apps/desktop/src/session-controls";
import { ConversationError } from "../conversations/error";
import { conversationFile } from "../conversations/paths";
import { eventSchema } from "../conversations/protocol";
import { createConversationStore } from "../conversations/store";
import { createProjectStore } from "../projects/store";
import { scratchDirs } from "../test-scratch";
import {
  ownedCodingPageSchema,
  ownedCodingStateSchema,
} from "./codex-owned-journal";
import { geminiChatApprovalPageSchema } from "./gemini-chat-owned-protocol";
import { createGeminiChatRuntime } from "./gemini-chat-runtime";
import { createSessionLibrary } from "./library";
import { sessionTranscriptExportSchema } from "./library-protocol";
import { createOwnedCodingSessionService } from "./owned-coding-service";

const scratch = scratchDirs(),
  binaries = scratchDirs(),
  closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  scratch.cleanup();
});
afterAll(() => binaries.cleanup());
let command: string;
beforeAll(async () => {
  command = join(
    binaries.make("gemini-owned-chat-binary-"),
    process.platform === "win32" ? "fixture.exe" : "fixture",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      join(import.meta.dir, "fixtures/gemini-chat-runtime-compiled.ts"),
      "--compile",
      "--outfile",
      command,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const stderr = await new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw Error(stderr);
  } finally {
    clearTimeout(timer);
  }
}, 25_000);
async function fixture(mode = "normal") {
  const root = realpathSync.native(scratch.make("gemini-owned-chat-")),
    home = join(root, "home"),
    configHome = join(root, "config"),
    log = join(root, "record.json");
  mkdirSync(join(root, ".git"));
  mkdirSync(configHome);
  writeFileSync(
    join(root, "agent-forge.toml"),
    '[execution.env]\npass = ["GEMINI_CHAT_LOG", "GEMINI_CHAT_MODE"]\n[smiths.gemini-example]\nprovider = "gemini"\nmodel = "exact-model"\neffort = "default"\nenabled = true\n',
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
  const geminiChatRuntime = createGeminiChatRuntime({
    root,
    home,
    configHome,
    command: [command],
    environment: {
      ...process.env,
      GEMINI_CHAT_LOG: log,
      GEMINI_CHAT_MODE: mode,
    },
    timeoutMs: 5000,
    cancellationTimeoutMs: 500,
  });
  const scope: { allowed: boolean; gate: Promise<void> | null; calls: number } =
    { allowed: true, gate: null, calls: 0 };
  const open = () => {
    const service = createOwnedCodingSessionService({
      root,
      home,
      geminiChatRuntime,
      runtime: {
        provider: "claude",
        async check() {
          throw Error("No Claude");
        },
        async prepare() {
          throw Error("No Claude");
        },
        async run() {
          throw Error("No Claude");
        },
      },
      async validateScope(id, metadata) {
        scope.calls++;
        await scope.gate;
        if (
          !scope.allowed ||
          id !== project.id ||
          metadata.repository !== root ||
          metadata.worktree !== root
        )
          throw new ConversationError(409, "Foreign or archived planted scope");
      },
    });
    closing.push(() => service.close());
    return service;
  };
  const records = (): Record<string, unknown>[] => {
    if (!existsSync(log)) return [];
    try {
      return JSON.parse(readFileSync(log, "utf8"));
    } catch {
      throw Error("Invalid whole fixture log");
    }
  };
  return {
    root,
    home,
    project,
    open,
    records,
    log,
    scope,
    request: {
      provider: "gemini" as const,
      requestId: randomUUID(),
      smith: "gemini-example",
      repository: root,
      worktree: root,
      launch: {
        route: "gemini-cli" as const,
        mode: "chat" as const,
        prompt: "Private first turn",
        attachments: [
          { kind: "text" as const, name: "note", text: "Private attachment" },
        ],
      },
    },
  };
}

test("actual compiled ACP Start and recreated explicit second turn retain exact identity and native-session replay scope", async () => {
  const f = await fixture();
  let service = f.open();
  const started = await service.start(f.project.id, f.request);
  await service.settled(f.project.id, started.session.id);
  let page = await service.read(f.project.id, started.session.id);
  expect(page.turns[0]?.phase).toBe("completed");
  expect(page.binding).toEqual({
    provider: "gemini",
    sessionId: "11111111-1111-4111-8111-111111111111",
    version: "0.65.0",
  });
  await service.close();
  service = f.open();
  expect((await service.start(f.project.id, f.request)).session.id).toBe(
    started.session.id,
  );
  const second = {
    requestId: randomUUID(),
    expectedRevision: page.revision,
    text: "Private second turn",
    about: [],
  };
  await service.send(f.project.id, started.session.id, second);
  await service.settled(f.project.id, started.session.id);
  page = await service.read(f.project.id, started.session.id);
  expect(page.turns.map((turn) => turn.phase)).toEqual([
    "completed",
    "completed",
  ]);
  const replay = page.frames.filter(
    (frame) =>
      frame.turnId === second.requestId &&
      frame.event.kind === "coding-gemini-chat" &&
      frame.event.event.kind === "text",
  );
  expect(replay.length).toBeGreaterThan(0);
  for (const frame of replay)
    if (
      frame.event.kind === "coding-gemini-chat" &&
      frame.event.event.kind === "text"
    )
      expect(frame.event.event).toMatchObject({
        scope: "native-session",
        requestId: null,
      });
  expect(
    page.frames.filter(
      (frame) =>
        frame.turnId === second.requestId && frame.event.kind === "text",
    ),
  ).toEqual([]);
  expect(f.records().filter((row) => row.kind === "start")).toHaveLength(2);
  const library = createSessionLibrary({ root: f.root, home: f.home });
  const exported = library.exportTranscript(f.project.id, started.session.id);
  expect(sessionTranscriptExportSchema.safeParse(exported).success).toBe(true);
  expect(exported.conversation.turns).toHaveLength(2);
  expect(JSON.stringify(exported)).toContain("Historical before load reply");
  expect(JSON.stringify(exported)).toContain("Private second turn");
  const state = createConversationStore(f.home, undefined, {
    kind: "session",
    projectId: f.project.id,
    sessionId: started.session.id,
  }).read(f.project.id);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  for (const frame of replay) {
    expect(eventSchema.safeParse(frame.event).success).toBe(false);
    expect(
      ownedCodingPageSchema.safeParse(
        await service.read(f.project.id, started.session.id, {
          after: frame.seq - 1,
          limit: 1,
        }),
      ).success,
    ).toBe(true);
    const altered = structuredClone(state),
      target = altered.frames.find((item) => item.seq === frame.seq);
    if (
      target?.event.kind === "coding-gemini-chat" &&
      target.event.event.kind === "text"
    ) {
      target.event.event.scope = "turn";
      target.event.event.requestId = second.requestId;
    }
    expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
  }
  const changedSelection = structuredClone(state),
    secondUser = changedSelection.frames.find(
      (frame) =>
        frame.turnId === second.requestId && frame.event.kind === "user",
    );
  if (secondUser?.event.kind !== "user" || !secondUser.event.geminiChat)
    throw Error("Missing saved second selection");
  secondUser.event.geminiChat.launch.sandbox = true;
  expect(ownedCodingStateSchema.safeParse(changedSelection).success).toBe(
    false,
  );
  const archived = await library.archive(f.project.id, started.session.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  });
  expect(archived.receipt?.outcome).toBe("applied");
  expect(
    library.exportTranscript(f.project.id, started.session.id).conversation
      .turns,
  ).toHaveLength(2);
});

function alive(pid: number) {
  try {
    if (
      process.platform === "linux" &&
      /\) Z(?: |$)/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    )
      return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Stop withdraws a held permission read and confirms the actual native provider and helper have ended", async () => {
  const f = await fixture("permission-tree"),
    service = f.open();
  const started = await service.start(f.project.id, f.request),
    id = started.session.id;
  const offers = await until(
    async () =>
      geminiChatApprovalPageSchema.parse(
        await service.approvals(f.project.id, id),
      ),
    (value) => value.pending.length > 0,
  );
  const provider = f.records().find((row) => row.kind === "start")?.pid,
    helper = f.records().find((row) => row.kind === "helper")?.pid;
  if (typeof provider !== "number" || typeof helper !== "number")
    throw Error("Missing actual native helper witness");
  expect(alive(provider)).toBe(true);
  expect(alive(helper)).toBe(true);
  let release: () => void = () => {};
  f.scope.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = f.scope.calls,
    held = service.approvals(f.project.id, id);
  try {
    await until(
      async () => f.scope.calls,
      (value) => value > before,
    );
    await service.stop(f.project.id, id, f.request.requestId);
    await service.settled(f.project.id, id);
    expect(alive(provider)).toBe(false);
    expect(alive(helper)).toBe(false);
    release();
    expect((await held).pending).toEqual([]);
    const offered = offers.pending[0];
    if (!offered) throw Error("Missing captured permission");
    f.scope.gate = null;
    await expect(
      service.decide(f.project.id, id, {
        requestId: randomUUID(),
        turnRequestId: f.request.requestId,
        approvalId: offered.approval.id,
        optionId: "once",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const page = await service.read(f.project.id, id);
    expect(page.turns[0]?.phase).toBe("cancelled");
    expect(
      page.frames.some(
        ({ event }) =>
          event.kind === "coding-gemini-chat" &&
          event.event.kind === "result" &&
          event.event.stopReason === "cancelled",
      ),
    ).toBe(true);
  } finally {
    release();
    f.scope.gate = null;
    await held.catch(() => {});
  }
});

test("a resumed native capability refusal cannot silently start a fresh session or replay the previous prompt", async () => {
  const f = await fixture(),
    service = f.open();
  const started = await service.start(f.project.id, f.request),
    id = started.session.id;
  await service.settled(f.project.id, id);
  const first = await service.read(f.project.id, id);
  writeFileSync(`${f.log}.control`, JSON.stringify({ mode: "no-load" }));
  await service.send(f.project.id, id, {
    requestId: randomUUID(),
    expectedRevision: first.revision,
    text: "Explicit second prompt",
    about: [],
  });
  await service.settled(f.project.id, id);
  const page = await service.read(f.project.id, id);
  expect(page.turns[1]?.phase).toBe("unknown");
  expect(page.binding).toEqual(first.binding);
  expect(
    f
      .records()
      .filter(
        (row) =>
          row.kind === "wire" &&
          JSON.stringify(row).includes('"method":"session/prompt"'),
      ),
  ).toHaveLength(1);
  const recorded = JSON.stringify(f.records());
  expect((await service.start(f.project.id, f.request)).session.id).toBe(id);
  expect(JSON.stringify(f.records())).toBe(recorded);
  await expect(
    service.send(f.project.id, id, {
      requestId: randomUUID(),
      expectedRevision: page.revision,
      text: "Must stay held",
      about: [],
    }),
  ).rejects.toMatchObject({ status: 409 });
  // A fresh explicit attempt may recheck read-only capability evidence, but cannot dispatch.
  expect(f.records().filter((row) => row.kind === "start")).toHaveLength(2);
  expect(
    f
      .records()
      .filter(
        (row) =>
          row.kind === "wire" &&
          JSON.stringify(row).includes('"method":"session/prompt"'),
      ),
  ).toHaveLength(1);
});

async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= end)
      throw Error("The inert native witness did not arrive.");
    await Bun.sleep(10);
  }
}

test("opaque native once permission persists original intent before one callback and exact retry survives recreation", async () => {
  const f = await fixture("permission");
  let service = f.open();
  const started = await service.start(f.project.id, f.request),
    sessionId = started.session.id;
  const raw = await until(
    async () =>
      geminiChatApprovalPageSchema.parse(
        await service.approvals(f.project.id, sessionId),
      ),
    (value) => value.pending.length > 0,
  );
  const page = geminiChatApprovalPageSchema.parse(raw),
    offered = page.pending[0];
  if (!offered) throw Error("No inert permission offer");
  const controls = ownedSessionControls({
    record: started.session,
    page: await service.read(f.project.id, sessionId),
    loaded: true,
    live: true,
    pending: false,
    stopping: false,
  });
  expect(controls.commandPreview).toBeNull();
  expect([
    controls.resume.available,
    controls.stop.available,
    controls.permissions.available,
  ]).toEqual([false, false, false]);
  expect(controls.resume.reason).toContain("Gemini ACP Chat");
  expect(offered.approval.options.map((item) => item.kind)).toEqual([
    "allow_once",
    "reject_once",
  ]);
  expect(JSON.stringify(page)).not.toContain('"rpcId"');
  expect(JSON.stringify(page)).not.toContain('"processId"');
  const decision = {
    requestId: randomUUID(),
    turnRequestId: f.request.requestId,
    approvalId: offered.approval.id,
    optionId: "once",
  };
  await expect(
    service.decide(f.project.id, sessionId, {
      ...decision,
      optionId: "always",
    }),
  ).rejects.toMatchObject({ status: 409 });
  const recorded = await service.decide(f.project.id, sessionId, decision);
  expect(recorded.state).toBe("recorded");
  await service.settled(f.project.id, sessionId);
  const saved = await service.read(f.project.id, sessionId);
  expect(saved.turns[0]?.phase).toBe("completed");
  const intent = saved.frames.findIndex(
    ({ event }) => event.kind === "coding-gemini-chat-decision",
  );
  const callback = saved.frames.findIndex(
    ({ event }) =>
      event.kind === "coding-gemini-chat" &&
      event.event.kind === "permission-intent",
  );
  expect(intent).toBeGreaterThan(0);
  expect(callback).toBeGreaterThan(intent);
  expect((await service.approvals(f.project.id, sessionId)).pending).toEqual(
    [],
  );
  await service.close();
  service = f.open();
  expect(await service.decide(f.project.id, sessionId, decision)).toEqual(
    recorded,
  );
  expect(
    (await service.approvals(f.project.id, sessionId, decision.requestId))
      .receipt,
  ).toEqual(recorded);
  await expect(
    service.decide(f.project.id, sessionId, { ...decision, optionId: "deny" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    f
      .records()
      .filter(
        (row) =>
          row.kind === "wire" &&
          JSON.stringify(row).includes('"id":41') &&
          JSON.stringify(row).includes('"result"'),
      ),
  ).toHaveLength(1);
  expect(
    sessionTranscriptExportSchema.safeParse(
      createSessionLibrary({ root: f.root, home: f.home }).exportTranscript(
        f.project.id,
        sessionId,
      ),
    ).success,
  ).toBe(true);
  const store = createConversationStore(f.home, undefined, {
      kind: "session",
      projectId: f.project.id,
      sessionId,
    }),
    path = conversationFile(f.home, f.project.id, {
      kind: "session",
      projectId: f.project.id,
      sessionId,
    });
  const original = readFileSync(path, "utf8"),
    altered = store.read(f.project.id),
    changed = altered.frames.find(
      ({ event }) => event.kind === "coding-gemini-chat-decision",
    );
  if (changed?.event.kind !== "coding-gemini-chat-decision")
    throw Error("Missing actual saved intent");
  changed.event.requestHash = "f".repeat(64);
  const corrupt = JSON.stringify(altered);
  writeFileSync(path, corrupt);
  try {
    expect(() => store.read(f.project.id)).toThrow("invalid");
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  } finally {
    writeFileSync(path, original);
  }
});
