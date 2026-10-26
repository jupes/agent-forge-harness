import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedCodexChat } from "../../types/codex-chat";
import type { PreparedCodexTask } from "../../types/codex-task-runtime";
import type {
  ConversationEvent,
  ConversationState,
} from "../../types/conversation";
import type { PreparedGeminiChat } from "../../types/gemini-chat-runtime";
import type { PreparedGeminiTask } from "../../types/gemini-task-runtime";
import type { SessionTurnSnapshot } from "../../types/session-turn";
import type { ConversationError } from "../conversations/error";
import { conversationFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import { writeOwnerOnly } from "../hearth/token";
import { createRestartIdentityJournal } from "../identities/restart-index";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { preparedCodexChatSchema } from "./codex-app-server-protocol";
import { codexChatLaunchFromStart } from "./codex-chat-owned-preparation";
import { codexTaskLaunchFromStart } from "./codex-owned-preparation";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";
import { preparedCodexTaskSchema } from "./codex-task-runtime-protocol";
import { geminiChatLaunchFromStart } from "./gemini-chat-owned-preparation";
import { preparedGeminiChatSchema } from "./gemini-chat-runtime-protocol";
import { geminiTaskLaunchFromStart } from "./gemini-owned-preparation";
import { preparedGeminiTaskSchema } from "./gemini-task-runtime-protocol";
import { createSessionLibrary } from "./library";
import { createOwnedCodingSessionService } from "./owned-coding-service";
import { sessionRegistryFile } from "./registry";
import { readVerifiedOriginalStart } from "./restart-identity-proof";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

async function fixture() {
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), "forge restart proof matrix ")),
  );
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home"),
    root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
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
  if (!project) throw Error("Missing proof matrix project");
  return { home, root, project };
}

type ProofSource = {
  home: string;
  root: string;
  projectId: string;
  request: Record<string, unknown>;
  session: Record<string, unknown>;
  event: ConversationEvent;
  provider: "claude" | "codex" | "gemini";
  mode: "task" | "chat";
  forbiddenFields: string[];
};

function startIdentity(source: ProofSource) {
  return {
    version: 1 as const,
    address: {
      family: "owned-session-start" as const,
      projectId: source.projectId,
    },
    workspace: workspaceKey(resolveCheckout(source.root).workspace),
    requestId: source.request["requestId"] as string,
    requestHash: createHash("sha256")
      .update(canonicalOwnedSessionStart(source.request))
      .digest("hex"),
    provider: source.provider,
    mode: source.mode,
  };
}

function writeSource(source: ProofSource) {
  const identity = startIdentity(source),
    requestId = identity.requestId,
    sessionId = source.session["id"] as string,
    now = "2026-01-02T03:04:05.000Z",
    turnHash = createHash("sha256")
      .update(
        JSON.stringify({
          text: (source.event as Extract<ConversationEvent, { kind: "user" }>)
            .text,
          about: (source.event as Extract<ConversationEvent, { kind: "user" }>)
            .about,
          ...(source.event.kind === "user" && source.event.session
            ? { session: source.event.session }
            : {}),
          ...(source.event.kind === "user" && source.event.codexTask
            ? { codexTask: source.event.codexTask }
            : {}),
          ...(source.event.kind === "user" && source.event.codexChat
            ? { codexChat: source.event.codexChat }
            : {}),
          ...(source.event.kind === "user" && source.event.geminiTask
            ? { geminiTask: source.event.geminiTask }
            : {}),
          ...(source.event.kind === "user" && source.event.geminiChat
            ? { geminiChat: source.event.geminiChat }
            : {}),
        }),
      )
      .digest("hex");
  const registryDirectory = join(source.home, "sessions");
  mkdirSync(join(source.home, "conversations"), { recursive: true });
  mkdirSync(registryDirectory, { recursive: true });
  writeOwnerOnly(
    sessionRegistryFile(source.home),
    JSON.stringify({ version: 1, records: [source.session] }),
  );
  const state: ConversationState = {
    version: 1,
    projectId: source.projectId,
    conversationId: sessionId,
    revision: 2,
    binding: {
      provider: source.provider,
      sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      version: source.provider === "gemini" ? "0.65.0" : "1.0.0",
    },
    turns: [
      {
        requestId,
        hash: turnHash,
        phase: "completed",
        createdAt: now,
        updatedAt: now,
        reason: null,
        owner: null,
      },
    ],
    frames: [
      { seq: 1, turnId: requestId, at: now, event: source.event },
      {
        seq: 2,
        turnId: requestId,
        at: now,
        event: {
          kind: "identity",
          provider: source.provider,
          sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
          version: source.provider === "gemini" ? "0.65.0" : "1.0.0",
        },
      },
    ],
  };
  const address = {
    kind: "session" as const,
    projectId: source.projectId,
    sessionId,
  };
  writeOwnerOnly(
    conversationFile(source.home, source.projectId, address),
    JSON.stringify(state),
  );
  return identity;
}

function makeMetadata(
  source: Pick<ProofSource, "provider" | "mode" | "projectId" | "root">,
  request: Record<string, unknown>,
  requestHash: string,
) {
  const launch = request["launch"] as Record<string, unknown>;
  const session = {
    provider: source.provider,
    mode: source.mode,
    ...(source.provider === "gemini" ? { route: "gemini-cli" } : {}),
    workspace: resolveCheckout(source.root).workspace,
    repository: source.root,
    worktree: source.root,
    smith: request["smith"],
    requestedModel: launch["model"] ?? "sonnet",
    requestedEffort: launch["effort"] ?? null,
    projectId: source.projectId,
    id: `session-${request["requestId"] as string}`,
    requestId: request["requestId"],
    requestHash,
    createdAt: "2026-01-02T03:04:05.000Z",
  };
  return session;
}

function mutateFirstUser(
  source: ProofSource,
  mutate: (event: Extract<ConversationEvent, { kind: "user" }>) => void,
) {
  const address = {
    kind: "session" as const,
    projectId: source.projectId,
    sessionId: source.session["id"] as string,
  };
  const state = createConversationStore(source.home, undefined, address).read(
    source.projectId,
  );
  const first = state.frames[0]?.event;
  if (first?.kind !== "user") throw Error("Missing seeded private first turn");
  mutate(first);
  const turn = state.turns[0];
  if (!turn) throw Error("Missing seeded private turn row");
  turn.hash = createHash("sha256")
    .update(
      JSON.stringify({
        text: first.text,
        about: first.about,
        ...(first.brief ? { brief: first.brief } : {}),
        ...(first.session ? { session: first.session } : {}),
        ...(first.codexTask ? { codexTask: first.codexTask } : {}),
        ...(first.codexChat ? { codexChat: first.codexChat } : {}),
        ...(first.geminiTask ? { geminiTask: first.geminiTask } : {}),
        ...(first.geminiChat ? { geminiChat: first.geminiChat } : {}),
      }),
    )
    .digest("hex");
  writeOwnerOnly(
    conversationFile(source.home, source.projectId, address),
    JSON.stringify(state),
  );
}

function expectInvalid(
  source: ProofSource,
  identity: ReturnType<typeof startIdentity>,
) {
  expect(
    readVerifiedOriginalStart({
      home: source.home,
      root: source.root,
      identity,
    }).kind,
  ).toBe("invalid");
}

test("restart proof keeps exact launch presence and binds all five provider modes to the original user text", async () => {
  const f = await fixture();
  const common = {
    smith: "coding",
    repository: f.root,
    worktree: f.root,
  };
  const uuid = () => randomUUID();
  const cases: ProofSource[] = [];

  const claudeRequest = {
    ...common,
    requestId: uuid(),
    launch: {
      mode: "chat" as const,
      model: "sonnet",
      prompt: "Claude prompt",
      attachments: [],
    },
  };
  const claudeLaunch = {
    ...claudeRequest.launch,
    context: {
      projectId: f.project.id,
      repository: f.root,
      worktree: f.root,
      about: [],
    },
  };
  const claudeSnapshot: SessionTurnSnapshot = {
    version: 1,
    provider: "claude",
    smith: common.smith,
    cwd: f.root,
    launch: claudeLaunch,
    capabilities: {
      version: "2.1.296",
      flags: [
        "--print",
        "--input-format",
        "--output-format",
        "--verbose",
        "--include-partial-messages",
        "--model",
        "--permission-mode",
        "--permission-prompts",
        "--allowedTools",
        "--resume",
        "--json-schema",
      ],
    },
  };
  const claudeHash = createHash("sha256")
    .update(canonicalOwnedSessionStart(claudeRequest))
    .digest("hex");
  const claudeSession = makeMetadata(
    { provider: "claude", mode: "chat", projectId: f.project.id, root: f.root },
    claudeRequest,
    claudeHash,
  );
  cases.push({
    home: f.home,
    root: f.root,
    projectId: f.project.id,
    request: claudeRequest,
    session: claudeSession,
    provider: "claude",
    mode: "chat",
    event: {
      kind: "user",
      text: claudeRequest.launch.prompt,
      about: [],
      session: claudeSnapshot,
    },
    forbiddenFields: ["resumeSessionId"],
  });

  const codexTaskRequest = {
    ...common,
    requestId: uuid(),
    provider: "codex" as const,
    launch: {
      mode: "task" as const,
      model: "gpt-test",
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
      prompt: "Codex Task prompt",
      attachments: [],
    },
  };
  const codexTaskLaunch = codexTaskLaunchFromStart(
    f.project.id,
    codexTaskRequest,
  );
  const codexTaskSnapshot = preparedCodexTaskSchema.parse({
    version: 1,
    provider: "codex",
    smith: common.smith,
    cwd: f.root,
    canonicalCwd: f.root,
    launch: codexTaskLaunch,
    capabilities: {
      version: "0.163.0-alpha.10.2",
      flags: ["--json", "--color", "--sandbox", "--model", "--cd", "--config"],
    },
  }) satisfies PreparedCodexTask;
  const codexTaskHash = createHash("sha256")
    .update(canonicalOwnedSessionStart(codexTaskRequest))
    .digest("hex");
  cases.push({
    home: f.home,
    root: f.root,
    projectId: f.project.id,
    request: codexTaskRequest,
    session: makeMetadata(
      {
        provider: "codex",
        mode: "task",
        projectId: f.project.id,
        root: f.root,
      },
      codexTaskRequest,
      codexTaskHash,
    ),
    provider: "codex",
    mode: "task",
    event: {
      kind: "user",
      text: codexTaskRequest.launch.prompt,
      about: [],
      codexTask: codexTaskSnapshot,
    },
    forbiddenFields: [],
  });

  const codexChatRequest = {
    ...common,
    requestId: uuid(),
    provider: "codex" as const,
    launch: {
      mode: "chat" as const,
      model: "gpt-test",
      sandbox: "workspace-write" as const,
      approvalPolicy: "on-request" as const,
      prompt: "Codex Chat prompt",
      attachments: [],
    },
  };
  const codexChatLaunch = codexChatLaunchFromStart(
    f.project.id,
    codexChatRequest,
  );
  const codexChatSnapshot = preparedCodexChatSchema.parse({
    version: 1,
    provider: "codex",
    smith: common.smith,
    cwd: f.root,
    canonicalCwd: f.root,
    launch: codexChatLaunch,
    capabilities: {
      version: "0.163.0-alpha.10.2",
      flags: ["--stdio"],
    },
  }) satisfies PreparedCodexChat;
  const codexChatHash = createHash("sha256")
    .update(canonicalOwnedSessionStart(codexChatRequest))
    .digest("hex");
  cases.push({
    home: f.home,
    root: f.root,
    projectId: f.project.id,
    request: codexChatRequest,
    session: makeMetadata(
      {
        provider: "codex",
        mode: "chat",
        projectId: f.project.id,
        root: f.root,
      },
      codexChatRequest,
      codexChatHash,
    ),
    provider: "codex",
    mode: "chat",
    event: {
      kind: "user",
      text: codexChatRequest.launch.prompt,
      about: [],
      codexChat: codexChatSnapshot,
    },
    forbiddenFields: [],
  });

  const geminiTaskRequest = {
    ...common,
    requestId: uuid(),
    provider: "gemini" as const,
    launch: {
      route: "gemini-cli" as const,
      mode: "task" as const,
      model: "gemini-test",
      prompt: "Gemini Task prompt",
      attachments: [],
    },
  };
  const geminiTaskLaunch = geminiTaskLaunchFromStart(
    f.project.id,
    geminiTaskRequest,
  );
  const geminiTaskSnapshot = preparedGeminiTaskSchema.parse({
    version: 1,
    provider: "gemini",
    smith: common.smith,
    canonicalRoot: f.root,
    canonicalCwd: f.root,
    command: [join(f.root, "gemini-test.exe")],
    paths: [f.root, f.root],
    launch: geminiTaskLaunch,
    capabilities: {
      version: "0.65.0",
      flags: ["--output-format", "--model"],
    },
  }) satisfies PreparedGeminiTask;
  const geminiTaskHash = createHash("sha256")
    .update(canonicalOwnedSessionStart(geminiTaskRequest))
    .digest("hex");
  cases.push({
    home: f.home,
    root: f.root,
    projectId: f.project.id,
    request: geminiTaskRequest,
    session: makeMetadata(
      {
        provider: "gemini",
        mode: "task",
        projectId: f.project.id,
        root: f.root,
      },
      geminiTaskRequest,
      geminiTaskHash,
    ),
    provider: "gemini",
    mode: "task",
    event: {
      kind: "user",
      text: geminiTaskRequest.launch.prompt,
      about: [],
      geminiTask: geminiTaskSnapshot,
    },
    forbiddenFields: ["policyFiles", "includeDirectories"],
  });

  const geminiChatRequest = {
    ...common,
    requestId: uuid(),
    provider: "gemini" as const,
    launch: {
      route: "gemini-cli" as const,
      mode: "chat" as const,
      model: "gemini-test",
      prompt: "Gemini Chat prompt",
      attachments: [],
    },
  };
  const geminiChatLaunch = geminiChatLaunchFromStart(
    f.project.id,
    geminiChatRequest,
  );
  const geminiChatSnapshot = preparedGeminiChatSchema.parse({
    version: 1,
    provider: "gemini",
    smith: common.smith,
    canonicalRoot: f.root,
    canonicalCwd: f.root,
    command: [join(f.root, "gemini-test.exe")],
    paths: [f.root, f.root],
    launch: geminiChatLaunch,
    capabilities: { version: "0.65.0", flags: ["--acp", "--model"] },
  }) satisfies PreparedGeminiChat;
  const geminiChatHash = createHash("sha256")
    .update(canonicalOwnedSessionStart(geminiChatRequest))
    .digest("hex");
  cases.push({
    home: f.home,
    root: f.root,
    projectId: f.project.id,
    request: geminiChatRequest,
    session: makeMetadata(
      {
        provider: "gemini",
        mode: "chat",
        projectId: f.project.id,
        root: f.root,
      },
      geminiChatRequest,
      geminiChatHash,
    ),
    provider: "gemini",
    mode: "chat",
    event: {
      kind: "user",
      text: geminiChatRequest.launch.prompt,
      about: [],
      geminiChat: geminiChatSnapshot,
    },
    forbiddenFields: ["policyFiles", "includeDirectories"],
  });

  for (const source of cases) {
    const identity = writeSource(source);
    const proof = readVerifiedOriginalStart({
      home: source.home,
      root: source.root,
      identity,
    });
    expect(proof.kind, `${source.provider}/${source.mode} proof`).toBe(
      "verified",
    );
    expect(
      createSessionLibrary({
        home: source.home,
        root: source.root,
      }).exportTranscript(source.projectId, source.session["id"] as string)
        .conversation.frames[0]?.event.kind,
    ).toBe("user");

    mutateFirstUser(source, (event) => {
      event.text = "altered first turn text";
    });
    expectInvalid(source, identity);
    writeSource(source);

    mutateFirstUser(source, (event) => {
      const snapshot =
        event[
          source.provider === "claude"
            ? "session"
            : source.provider === "codex"
              ? source.mode === "chat"
                ? "codexChat"
                : "codexTask"
              : source.mode === "chat"
                ? "geminiChat"
                : "geminiTask"
        ];
      if (!snapshot)
        throw Error("Missing provider snapshot for attachment mutation");
      const launch = snapshot.launch as unknown as Record<string, unknown>;
      if (!Array.isArray(launch["attachments"]))
        throw Error(
          "Exact-presence case did not persist an empty attachment array",
        );
      delete launch["attachments"];
    });
    expectInvalid(source, identity);
    writeSource(source);

    for (const field of source.forbiddenFields) {
      mutateFirstUser(source, (event) => {
        const key =
          source.provider === "claude"
            ? "session"
            : source.provider === "gemini"
              ? source.mode === "chat"
                ? "geminiChat"
                : "geminiTask"
              : "codexTask";
        const snapshot = event[key];
        if (!snapshot) throw Error(`Missing provider snapshot for ${field}`);
        const launch = snapshot.launch as unknown as Record<string, unknown>;
        launch[field] = field === "resumeSessionId" ? randomUUID() : [f.root];
      });
      expectInvalid(source, identity);
      writeSource(source);
    }
  }

  const legacy = cases.find(
    (source) => source.provider === "claude" && source.mode === "chat",
  );
  if (!legacy) throw Error("Missing Claude Chat proof fixture");
  const identity = writeSource(legacy);
  const journal = createRestartIdentityJournal(legacy.home);
  await journal.reserve(identity);
  const eventBytes = () =>
    readdirSync(join(legacy.home, "restart-identities"))
      .filter((name) => /^event-\d{8}-[a-f0-9]{64}\.json$/.test(name))
      .sort()
      .map((name) => [
        name,
        readFileSync(join(legacy.home, "restart-identities", name)),
      ]);
  const beforeRetire = eventBytes();
  let providerCalls = 0;
  const service = createOwnedCodingSessionService({
    home: legacy.home,
    root: legacy.root,
    runtime: {
      provider: "claude",
      async prepare() {
        providerCalls++;
        throw Error("identity reconciliation must not prepare a provider");
      },
      async run() {
        providerCalls++;
        throw Error("identity reconciliation must not dispatch a provider");
      },
    },
    async validateScope() {},
  });
  await expect(
    service.retireIdentity(
      legacy.projectId,
      identity.requestId,
      identity.requestHash,
    ),
  ).rejects.toMatchObject({
    status: 409,
    message: "A verified original Session Start cannot be retired.",
  } satisfies Partial<ConversationError>);
  expect(eventBytes()).toEqual(beforeRetire);
  expect(
    await journal.lookup(
      { address: identity.address, workspace: identity.workspace },
      identity.requestId,
    ),
  ).toMatchObject({ state: "reserved" });
  await expect(
    service.start(randomUUID(), legacy.request),
  ).rejects.toMatchObject({ status: 409 } satisfies Partial<ConversationError>);
  expect(providerCalls).toBe(0);
  expect(eventBytes()).toEqual(beforeRetire);
  await service.close();
});
