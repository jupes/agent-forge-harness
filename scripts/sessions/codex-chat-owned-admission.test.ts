import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ownedSessionLifecycle } from "../../apps/desktop/src/session-activity";
import type {
  CodexChatCommand,
  CodexChatFileChange,
  CodexChatMcpToolCall,
  CodexChatReasoningSummary,
  CodexChatTurnPlan,
} from "../../types/codex-chat";
import type { CodexChatStartRequest } from "../../types/codex-owned-chat";
import type { ConversationFrame } from "../../types/conversation";
import { conversationFile } from "../conversations/paths";
import { eventSchema } from "../conversations/protocol";
import { createConversationStore } from "../conversations/store";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { scratchDirs } from "../test-scratch";
import { resolveCodexChatForkSource } from "./codex-chat-fork-source";
import { createCodexOwnedChatService } from "./codex-chat-owned-admission";
import { createCodexChatRuntime } from "./codex-chat-runtime";
import {
  ownedCodingEventSchema,
  ownedCodingPageSchema,
  ownedCodingStateSchema,
} from "./codex-owned-journal";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";
import { createSessionLibrary } from "./library";
import { sessionTranscriptExportSchema } from "./library-protocol";
import { createSessionRegistry, sessionRegistryFile } from "./registry";

const scratch = scratchDirs(),
  closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  scratch.cleanup();
});
async function fixture(mode = "normal", rpcTimeoutMs = 5000) {
  const root = scratch.make("codex-chat-owned-"),
    home = join(root, "home"),
    configHome = join(root, "config"),
    workspaceAlias = join(root, "workspace-alias");
  mkdirSync(join(root, ".git"));
  mkdirSync(configHome);
  if (mode === "canonical-cwd-ack")
    symlinkSync(
      root,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
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
    rpcTimeoutMs,
    approvalTimeoutMs: 3000,
    ...(mode === "canonical-cwd-ack"
      ? {
          modelEfforts: [
            {
              model: "exact-model",
              efforts: ["medium"],
              source: "model/list" as const,
              cliVersion: "0.163.0-alpha.10.2",
              asOf: "2026-10-23T00:00:00.000Z",
            },
          ],
        }
      : {}),
  });
  const open = () => {
    const service = createCodexOwnedChatService({
      root,
      home,
      runtime,
      async validateScope(id, metadata) {
        const selectedPath = (value: string) =>
          mode === "canonical-cwd-ack"
            ? realpathSync.native(value) === realpathSync.native(root)
            : value === root;
        if (
          id !== project.id ||
          !selectedPath(metadata.repository) ||
          !selectedPath(metadata.worktree)
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
  return {
    root,
    home,
    project,
    request,
    workspaceAlias,
    open,
    records,
    runtime,
  };
}

test("a canonical native Chat configuration persists without rewriting the aliased original launch", async () => {
  const f = await fixture("canonical-cwd-ack"),
    request = {
      ...f.request,
      repository: f.workspaceAlias,
      worktree: f.workspaceAlias,
      launch: { ...f.request.launch, effort: "medium" },
    },
    canonicalWorkspace = realpathSync.native(f.workspaceAlias),
    canonicalWorkspaceKey =
      process.platform === "win32"
        ? canonicalWorkspace.toLowerCase()
        : canonicalWorkspace,
    expectedHash = createHash("sha256")
      .update(canonicalOwnedSessionStart(request))
      .digest("hex"),
    service = f.open();
  expect(canonicalWorkspaceKey).toBe(
    process.platform === "win32"
      ? realpathSync.native(f.root).toLowerCase()
      : realpathSync.native(f.root),
  );
  expect(f.workspaceAlias).not.toBe(canonicalWorkspaceKey);

  const started = await service.start(f.project.id, request);
  await service.settled(f.project.id, started.session.id);
  expect(f.records()).toContainEqual({
    kind: "canonical-cwd-ack",
    requestedCwdWasAlias: true,
    acknowledgedCwdIsCanonical: true,
  });

  const registry = createSessionRegistry(f.home, "codex", "chat"),
    record = registry.read(f.project.id, started.session.id),
    address = {
      kind: "session" as const,
      projectId: f.project.id,
      sessionId: started.session.id,
    },
    state = createConversationStore(f.home, undefined, address).read(
      f.project.id,
    ),
    user = state.frames.find(
      (frame) =>
        frame.event.kind === "user" && frame.event.codexChat !== undefined,
    )?.event,
    configuration = state.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "configuration",
    )?.event;

  expect(record.requestId).toBe(request.requestId);
  expect(record.requestHash).toBe(expectedHash);
  expect(user).toMatchObject({
    kind: "user",
    codexChat: {
      canonicalCwd: canonicalWorkspaceKey,
      launch: {
        cwd: f.workspaceAlias,
        prompt: request.launch.prompt,
        attachments: request.launch.attachments,
      },
    },
  });
  expect(configuration).toMatchObject({
    kind: "coding-chat",
    provider: "codex",
    event: {
      kind: "configuration",
      cwd: canonicalWorkspaceKey,
      model: request.launch.model,
      effort: "medium",
    },
  });
  expect(configuration).toHaveProperty("event.serviceTier", null);
  if (
    configuration?.kind !== "coding-chat" ||
    configuration.event.kind !== "configuration"
  )
    throw Error("Missing persisted native configuration frame");
  const owner = createSessionRegistry(f.home, "codex", "chat").read(
      f.project.id,
      started.session.id,
    ),
    selectedNativeTurn = state.frames.find(
      (frame) =>
        frame.turnId === request.requestId &&
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "turn",
    );
  if (
    selectedNativeTurn?.event.kind !== "coding-chat" ||
    selectedNativeTurn.event.event.kind !== "turn"
  )
    throw Error("Missing captured native turn identity");
  const forkSource = resolveCodexChatForkSource({
    owner,
    state,
    projectId: f.project.id,
    conversationId: started.session.id,
    workspaceKey: workspaceKey(resolveCheckout(f.root).workspace),
    selectedTurnRequestId: request.requestId,
  });
  expect(configuration.event.cwd).toBe(canonicalWorkspaceKey);
  expect(user).toMatchObject({
    kind: "user",
    codexChat: { launch: { cwd: f.workspaceAlias } },
  });
  expect(forkSource).toMatchObject({
    eligible: true,
    selectedTurnRequestId: request.requestId,
    lastTurnId: selectedNativeTurn.event.event.turnId,
    sourceSettings: {
      modelProvider: configuration.event.modelProvider,
      serviceTier: null,
      reasoningEffort: "medium",
    },
  });
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);

  const configurationIndex = state.frames.findIndex(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "configuration",
  );
  for (const field of ["cwd", "model", "effort"] as const) {
    const altered = structuredClone(state),
      frame = altered.frames[configurationIndex];
    if (
      frame?.event.kind !== "coding-chat" ||
      frame.event.event.kind !== "configuration"
    )
      throw Error("Missing persisted native configuration frame");
    if (field === "cwd")
      frame.event.event.cwd = `${frame.event.event.cwd}/outside`;
    else if (field === "model") frame.event.event.model = "different-model";
    else frame.event.event.effort = "low";
    expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
  }

  const reopened = createConversationStore(f.home, undefined, address).read(
    f.project.id,
  );
  expect(ownedCodingStateSchema.safeParse(reopened).success).toBe(true);
  expect(
    reopened.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "configuration",
    )?.event,
  ).toEqual(configuration);
});

test("owned Chat durably binds one private generation before dispatch and release before outcome", async () => {
  const f = await fixture("normal");
  const readJournal = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw Error("The inert owned Chat journal could not be read.");
    }
  };
  let generationWasDurableBeforeRuntime = false;
  const runtimeRun = f.runtime.run.bind(f.runtime);
  f.runtime.run = async (input, persist, signal, callbacks) => {
    const owner = createSessionRegistry(f.home, "codex", "chat")
      .listAll(f.project.id)
      .find((record) => record.requestId === f.request.requestId);
    if (owner) {
      const journal = readJournal(
          conversationFile(f.home, f.project.id, {
            kind: "session",
            projectId: f.project.id,
            sessionId: owner.id,
          }),
        ),
        isRecord = (value: unknown): value is Record<string, unknown> =>
          typeof value === "object" && value !== null && !Array.isArray(value);
      if (isRecord(journal) && Array.isArray(journal.codexChatOwnerLifecycle))
        generationWasDurableBeforeRuntime =
          journal.codexChatOwnerLifecycle.some(
            (fact) =>
              isRecord(fact) &&
              fact.kind === "generation-started" &&
              fact.requestId === f.request.requestId &&
              typeof fact.afterSequence === "number" &&
              Array.isArray(journal.frames) &&
              fact.afterSequence === journal.frames.length,
          );
    }
    return runtimeRun(input, persist, signal, callbacks);
  };
  const service = f.open();
  const started = await service.start(f.project.id, f.request);
  await service.settled(f.project.id, started.session.id);
  const path = conversationFile(f.home, f.project.id, {
      kind: "session",
      projectId: f.project.id,
      sessionId: started.session.id,
    }),
    stored = readJournal(path);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    frames =
      isRecord(stored) && Array.isArray(stored.frames)
        ? stored.frames.flatMap((frame) =>
            isRecord(frame) &&
            typeof frame.seq === "number" &&
            isRecord(frame.event)
              ? [{ seq: frame.seq, event: frame.event }]
              : [],
          )
        : [],
    lifecycle =
      isRecord(stored) && Array.isArray(stored.codexChatOwnerLifecycle)
        ? stored.codexChatOwnerLifecycle.filter(isRecord)
        : [];

  expect(generationWasDurableBeforeRuntime).toBe(true);
  expect(lifecycle.map(({ kind }) => kind)).toEqual([
    "generation-started",
    "generation-released",
  ]);
  const generationStarted = lifecycle[0],
    generationReleased = lifecycle[1],
    nativeIdentity = frames.find(({ event }) => event.kind === "identity"),
    nativeTurn = frames.find(
      ({ event }) =>
        event.kind === "coding-chat" &&
        isRecord(event.event) &&
        event.event.kind === "turn",
    ),
    finalOutcome = frames.find(
      ({ event }) =>
        event.kind === "coding-chat" &&
        isRecord(event.event) &&
        event.event.kind === "outcome",
    );
  expect(generationStarted).toBeDefined();
  expect(generationReleased).toBeDefined();
  expect(nativeIdentity).toBeDefined();
  expect(nativeTurn).toBeDefined();
  expect(finalOutcome).toBeDefined();
  if (
    !generationStarted ||
    !generationReleased ||
    !nativeIdentity ||
    !nativeTurn ||
    !finalOutcome ||
    !isRecord(nativeTurn.event.event) ||
    !isRecord(finalOutcome.event.event)
  )
    throw Error("The inert owned Chat did not persist its lifecycle chain.");
  const generationId = generationStarted.generationId;
  expect(typeof generationId).toBe("string");
  if (typeof generationId !== "string")
    throw Error("The private owner generation identifier was missing.");
  expect(generationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(generationId).not.toBe(f.request.requestId);
  expect(generationId).not.toBe(nativeIdentity.event.sessionId);
  expect(generationId).not.toBe(nativeTurn.event.event.turnId);
  const processFrame = frames.find(
    ({ event }) =>
      event.kind === "coding-chat" &&
      isRecord(event.event) &&
      event.event.kind === "process",
  );
  expect(processFrame).toBeDefined();
  if (!processFrame) throw Error("The inert native process fact was missing.");
  expect(generationStarted.afterSequence).toBeLessThan(processFrame.seq);
  expect(generationReleased.afterSequence).toBeLessThan(finalOutcome.seq);
  expect(generationReleased).toMatchObject({
    kind: "generation-released",
    generationId,
    binding: {
      provider: "codex",
      sessionId: nativeIdentity.event.sessionId,
      version: nativeIdentity.event.version,
      turnId: nativeTurn.event.event.turnId,
    },
  });
  expect(finalOutcome.event.event).toMatchObject({
    kind: "outcome",
    outcome: { phase: "completed" },
  });
  if (!isRecord(stored) || !Array.isArray(stored.codexChatOwnerLifecycle))
    throw Error("The inert owned Chat lifecycle receipt was missing.");
  const legacyState = structuredClone(stored);
  if (!isRecord(legacyState)) throw Error("The legacy journal was invalid.");
  delete legacyState.codexChatOwnerLifecycle;
  expect(ownedCodingStateSchema.safeParse(legacyState).success).toBe(true);
  const mismatchedGeneration = structuredClone(stored);
  if (
    isRecord(mismatchedGeneration) &&
    Array.isArray(mismatchedGeneration.codexChatOwnerLifecycle)
  ) {
    const released = mismatchedGeneration.codexChatOwnerLifecycle.find(
      (fact) => isRecord(fact) && fact.kind === "generation-released",
    );
    if (isRecord(released)) released.generationId = randomUUID();
  }
  expect(ownedCodingStateSchema.safeParse(mismatchedGeneration).success).toBe(
    false,
  );
  const mismatchedTurn = structuredClone(stored);
  if (
    isRecord(mismatchedTurn) &&
    Array.isArray(mismatchedTurn.codexChatOwnerLifecycle)
  ) {
    const released = mismatchedTurn.codexChatOwnerLifecycle.find(
      (fact) => isRecord(fact) && fact.kind === "generation-released",
    );
    if (isRecord(released) && isRecord(released.binding))
      released.binding.turnId = randomUUID();
  }
  expect(ownedCodingStateSchema.safeParse(mismatchedTurn).success).toBe(false);
  const duplicateFact = structuredClone(stored);
  if (
    isRecord(duplicateFact) &&
    Array.isArray(duplicateFact.codexChatOwnerLifecycle)
  )
    duplicateFact.codexChatOwnerLifecycle.push(
      structuredClone(duplicateFact.codexChatOwnerLifecycle[0]),
    );
  expect(ownedCodingStateSchema.safeParse(duplicateFact).success).toBe(false);
  await service.close();
  const reopened = f.open(),
    publicPage = await reopened.read(f.project.id, started.session.id);
  const lastFrame = frames.at(-1);
  expect(lastFrame).toBeDefined();
  if (!lastFrame) throw Error("The inert owned Chat journal was empty.");
  expect(publicPage.lastSequence).toBe(lastFrame.seq);
  expect(JSON.stringify(publicPage)).not.toContain(generationId);
});

const heldSummaryUpdates: CodexChatReasoningSummary["update"][] = [
  {
    kind: "snapshot",
    summary: [],
    truncated: false,
    closure: "open",
    turnStatus: null,
  },
  { kind: "part-added", summaryIndex: 0 },
  {
    kind: "delta",
    summaryIndex: 0,
    content: { text: "Visible ", truncated: false },
    prefixMissing: false,
  },
  {
    kind: "delta",
    summaryIndex: 0,
    content: { text: "summary one.", truncated: false },
    prefixMissing: false,
  },
  { kind: "part-added", summaryIndex: 1 },
  {
    kind: "delta",
    summaryIndex: 1,
    content: { text: "Visible summary two.", truncated: false },
    prefixMissing: false,
  },
];

function nativeSummaries(
  frames: readonly ConversationFrame[],
): CodexChatReasoningSummary[] {
  return frames.flatMap((frame) =>
    frame.event.kind === "coding-chat" &&
    frame.event.event.kind === "reasoning-summary"
      ? [frame.event.event]
      : [],
  );
}

function heldSummaryFixtureReady(
  reports: readonly CodexChatReasoningSummary[],
): boolean {
  const first = reports[0];
  if (!first || reports.length !== heldSummaryUpdates.length) return false;
  return reports.every((report, index) => {
    const update = heldSummaryUpdates[index];
    return (
      update !== undefined &&
      report.partial &&
      report.threadId === first.threadId &&
      report.turnId === first.turnId &&
      report.itemId === first.itemId &&
      report.source ===
        (update.kind === "snapshot"
          ? "item/started"
          : update.kind === "part-added"
            ? "item/reasoning/summaryPartAdded"
            : "item/reasoning/summaryTextDelta") &&
      Bun.deepEquals(report.update, update, true)
    );
  });
}

test("the native summary Stop fixture witness rejects every incomplete prefix and mismatched report", () => {
  const reports: CodexChatReasoningSummary[] = heldSummaryUpdates.map(
    (update) => ({
      kind: "reasoning-summary",
      threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
      itemId: "reported-reasoning-a",
      partial: true,
      source:
        update.kind === "snapshot"
          ? "item/started"
          : update.kind === "part-added"
            ? "item/reasoning/summaryPartAdded"
            : "item/reasoning/summaryTextDelta",
      update: structuredClone(update),
    }),
  );
  for (let length = 0; length < reports.length; length++)
    expect(heldSummaryFixtureReady(reports.slice(0, length))).toBe(false);
  expect(
    reports.slice(0, 5).some((report) => report.update.kind === "delta"),
  ).toBe(true);
  expect(heldSummaryFixtureReady(reports)).toBe(true);
  for (const change of [
    { itemId: "foreign-item" },
    { turnId: randomUUID() },
    { threadId: randomUUID() },
    { partial: false },
  ]) {
    const changed = structuredClone(reports);
    Object.assign(changed[5] ?? {}, change);
    expect(heldSummaryFixtureReady(changed)).toBe(false);
  }
  const third = reports[3],
    fourth = reports[4];
  if (!third || !fourth) throw Error("Missing ordered fixture reports");
  const reordered = [
    ...reports.slice(0, 3),
    fourth,
    third,
    ...reports.slice(5),
  ];
  expect(heldSummaryFixtureReady(reordered)).toBe(false);
});

const heldFileChanges: CodexChatFileChange["changes"][] = [
  [
    {
      path: { text: "FILE_REPORT_MUST_NOT_CREATE.txt", truncated: false },
      kind: {
        type: "update",
        move_path: { text: "inert/<script>.ts", truncated: false },
      },
      diff: {
        text: "-old native line\n+<script>native patch stays text</script>",
        truncated: false,
      },
    },
    {
      path: { text: "empty-native.ts", truncated: false },
      kind: { type: "add" },
      diff: { text: "", truncated: false },
    },
  ],
  [
    {
      path: { text: "superseded.ts", truncated: false },
      kind: { type: "delete" },
      diff: { text: "-superseded", truncated: false },
    },
  ],
  [],
];
// The fourth report restores the first complete snapshot. A→B→empty→A is not a delta stream.
heldFileChanges.push(structuredClone(heldFileChanges[0] ?? []));
function nativeFiles(
  frames: readonly ConversationFrame[],
): CodexChatFileChange[] {
  return frames.flatMap((frame) =>
    frame.event.kind === "coding-chat" &&
    frame.event.event.kind === "file-change"
      ? [frame.event.event]
      : [],
  );
}
function heldFileFixtureReady(
  reports: readonly CodexChatFileChange[],
): boolean {
  return (
    reports.length === heldFileChanges.length &&
    reports.every(
      (report, index) =>
        report.kind === "file-change" &&
        report.source ===
          (index === 0 ? "item/started" : "item/fileChange/patchUpdated") &&
        report.threadId === "0199a213-81c0-7800-8aa1-bbab2a035a53" &&
        report.turnId === "0199a213-81c0-7800-8aa1-bbab2a035a54" &&
        report.itemId === "reported-files-a" &&
        report.status === "inProgress" &&
        report.partial &&
        report.closure === "open" &&
        report.turnStatus === null &&
        !report.truncated &&
        Bun.deepEquals(report.changes, heldFileChanges[index], true),
    )
  );
}

const heldMcpReports: CodexChatMcpToolCall[] = [
  {
    kind: "mcp-tool-call",
    source: "item/started",
    threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    itemId: "reported-mcp-main",
    server: { text: "fixture-mcp-server", truncated: false },
    tool: { text: "inspect_result", truncated: false },
    status: "inProgress",
    arguments: {
      json: '{"path":"FILE_MCP_MUST_NOT_CREATE.txt","query":"<script>MCP_ARGUMENT_LITERAL</script>"}',
      truncated: false,
    },
    result: null,
    error: null,
    durationMs: null,
    partial: true,
    closure: "open",
    turnStatus: null,
  },
  {
    kind: "mcp-tool-call",
    source: "item/completed",
    threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    itemId: "reported-mcp-main",
    server: { text: "fixture-mcp-server", truncated: false },
    tool: { text: "inspect_result", truncated: false },
    status: "completed",
    arguments: {
      json: '{"path":"FILE_MCP_MUST_NOT_CREATE.txt","query":"<script>MCP_ARGUMENT_LITERAL</script>"}',
      truncated: false,
    },
    result: {
      content: {
        json: '[{"type":"text","text":"<img>MCP_RESULT_LITERAL</img>"}]',
        truncated: false,
      },
      structuredContent: {
        json: '{"path":"file:///MCP_RESULT_URI_IS_LITERAL"}',
        truncated: false,
      },
    },
    error: null,
    durationMs: 27,
    partial: false,
    closure: "item-ended",
    turnStatus: null,
  },
  {
    kind: "mcp-tool-call",
    source: "item/started",
    threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    itemId: "reported-mcp-open",
    server: { text: "fixture-mcp-server", truncated: false },
    tool: { text: "inspect_while_turn_is_open", truncated: false },
    status: "inProgress",
    arguments: {
      json: JSON.stringify({ query: "y".repeat(40_000) }).slice(
        0,
        16_384 -
          new TextEncoder().encode(
            "fixture-mcp-serverinspect_while_turn_is_open",
          ).byteLength,
      ),
      truncated: true,
      omitted: "size",
    },
    result: null,
    error: null,
    durationMs: null,
    partial: true,
    closure: "open",
    turnStatus: null,
  },
];
function nativeMcpCalls(
  frames: readonly ConversationFrame[],
): CodexChatMcpToolCall[] {
  return frames.flatMap((frame) =>
    frame.event.kind === "coding-chat" &&
    frame.event.event.kind === "mcp-tool-call"
      ? [frame.event.event]
      : [],
  );
}
function heldMcpFixtureReady(
  reports: readonly CodexChatMcpToolCall[],
): boolean {
  const open = reports[2],
    argumentBytes =
      16_384 -
      new TextEncoder().encode("fixture-mcp-serverinspect_while_turn_is_open")
        .byteLength;
  return (
    reports.length === heldMcpReports.length &&
    Bun.deepEquals(reports[0], heldMcpReports[0], true) &&
    Bun.deepEquals(reports[1], heldMcpReports[1], true) &&
    open?.source === "item/started" &&
    open.threadId === heldMcpReports[2]?.threadId &&
    open.turnId === heldMcpReports[2]?.turnId &&
    open.itemId === heldMcpReports[2]?.itemId &&
    open.server.text === "fixture-mcp-server" &&
    open.tool.text === "inspect_while_turn_is_open" &&
    open.status === "inProgress" &&
    open.partial &&
    open.closure === "open" &&
    open.arguments.truncated &&
    open.arguments.omitted === "size" &&
    open.arguments.json ===
      JSON.stringify({ query: "y".repeat(40_000) }).slice(0, argumentBytes)
  );
}

test("the native MCP Stop witness requires the exact complete prefix and bounded open call", () => {
  for (let length = 0; length < heldMcpReports.length; length++)
    expect(heldMcpFixtureReady(heldMcpReports.slice(0, length))).toBe(false);
  expect(heldMcpFixtureReady(heldMcpReports)).toBe(true);
  for (const change of [
    { threadId: randomUUID() },
    { turnId: randomUUID() },
    { itemId: "foreign-call" },
    { closure: "item-ended" as const },
    {
      arguments: { json: "changed", truncated: true, omitted: "size" as const },
    },
  ]) {
    const changed = structuredClone(heldMcpReports);
    Object.assign(changed[2] ?? {}, change);
    expect(heldMcpFixtureReady(changed)).toBe(false);
  }
  const reordered = structuredClone(heldMcpReports);
  const first = reordered[0],
    second = reordered[1];
  if (!first || !second) throw Error("Missing native MCP fixture prefix");
  reordered[0] = second;
  reordered[1] = first;
  expect(heldMcpFixtureReady(reordered)).toBe(false);
});

test("the native file Stop witness refuses every incomplete or reordered prefix and mismatched full snapshot", () => {
  const reports: CodexChatFileChange[] = heldFileChanges.map(
    (changes, index) => ({
      kind: "file-change",
      source: index === 0 ? "item/started" : "item/fileChange/patchUpdated",
      threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
      itemId: "reported-files-a",
      status: "inProgress",
      changes: structuredClone(changes),
      partial: true,
      closure: "open",
      turnStatus: null,
      truncated: false,
    }),
  );
  for (let length = 0; length < reports.length; length++)
    expect(heldFileFixtureReady(reports.slice(0, length))).toBe(false);
  expect(heldFileFixtureReady(reports)).toBe(true);
  for (const delta of [
    { threadId: randomUUID() },
    { turnId: randomUUID() },
    { itemId: "foreign" },
    { partial: false },
    { changes: [] },
  ]) {
    const changed = structuredClone(reports);
    Object.assign(changed[3] ?? {}, delta);
    expect(heldFileFixtureReady(changed)).toBe(false);
  }
  const changed = structuredClone(reports),
    second = changed[1],
    third = changed[2];
  if (!second || !third) throw Error("Missing exact fixture prefix");
  changed[1] = third;
  changed[2] = second;
  expect(heldFileFixtureReady(changed)).toBe(false);
});

test("actual native file snapshots remain private and exact across whole/partial reads, export, recreation and original retry", async () => {
  const f = await fixture("file-changes");
  let service = f.open();
  const start = await service.start(f.project.id, f.request),
    sessionId = start.session.id;
  await service.settled(f.project.id, sessionId);
  const page = await service.read(f.project.id, sessionId),
    files = nativeFiles(page.frames);
  expect(page.turns[0]?.phase).toBe("completed");
  expect(files).toHaveLength(15);
  expect(heldFileFixtureReady(files.slice(0, 4))).toBe(true);
  const main = files.filter((report) => report.itemId === "reported-files-a");
  expect(
    main.map((report) => [report.source, report.status, report.closure]),
  ).toEqual([
    ["item/started", "inProgress", "open"],
    ["item/fileChange/patchUpdated", "inProgress", "open"],
    ["item/fileChange/patchUpdated", "inProgress", "open"],
    ["item/fileChange/patchUpdated", "inProgress", "open"],
    ["item/completed", "completed", "item-ended"],
    ["turn/completed", "completed", "turn-ended"],
  ]);
  expect(main[2]?.changes).toEqual([]);
  expect(main[5]?.changes).toEqual(heldFileChanges[0]);
  expect(
    files
      .filter((report) => report.source === "turn/completed")
      .map((report) => report.status),
  ).toEqual(["completed", "failed", "declined", "completed"]);
  expect(
    files.find((report) => report.itemId === "reported-files-clipped")
      ?.truncated,
  ).toBe(true);
  expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
  for (const frame of page.frames.filter(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "file-change",
  )) {
    const partial = await service.read(f.project.id, sessionId, {
      after: frame.seq - 1,
      limit: 1,
    });
    expect(partial.frames).toEqual([frame]);
    expect(ownedCodingPageSchema.safeParse(partial).success).toBe(true);
    expect(
      ownedCodingPageSchema.safeParse({
        ...partial,
        binding: {
          provider: "codex",
          sessionId: randomUUID(),
          version: "0.163.0-alpha.10.2",
        },
      }).success,
    ).toBe(false);
  }
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, sessionId);
  expect(sessionTranscriptExportSchema.safeParse(exported).success).toBe(true);
  expect(nativeFiles(exported.conversation.frames)).toEqual(files);
  expect(existsSync(join(f.root, "FILE_REPORT_MUST_NOT_CREATE.txt"))).toBe(
    false,
  );
  const storePath = conversationFile(f.home, f.project.id, {
      kind: "session",
      projectId: f.project.id,
      sessionId,
    }),
    bytes = readFileSync(storePath),
    registry = readFileSync(sessionRegistryFile(f.home));
  await service.close();
  service = f.open();
  expect((await service.read(f.project.id, sessionId)).frames).toEqual(
    page.frames,
  );
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(readFileSync(storePath)).toEqual(bytes);
  expect(readFileSync(sessionRegistryFile(f.home))).toEqual(registry);
});

test.each([
  "Stop",
  "deadline",
] as const)("actual %s retains the exact intended native file prefix and dead native/helper facts without replay", async (action) => {
  const f = await fixture("file-changes-held");
  let service = f.open();
  const start = await service.start(f.project.id, f.request),
    sessionId = start.session.id,
    deadline = Date.now() + 4000;
  let running = await service.read(f.project.id, sessionId),
    tree: Record<string, unknown> | undefined;
  while (
    !heldFileFixtureReady(nativeFiles(running.frames)) ||
    !(tree = f.records().find((row) => row.kind === "tree"))
  ) {
    if (Date.now() > deadline)
      throw Error(
        "The exact four native file reports and held helper did not reach private storage",
      );
    await Bun.sleep(20);
    running = await service.read(f.project.id, sessionId);
  }
  expect(running.turns[0]?.phase).toBe("running");
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  if (action === "Stop")
    await service.stop(f.project.id, sessionId, f.request.requestId);
  await service.settled(f.project.id, sessionId);
  await service.close();
  service = f.open();
  const page = await service.read(f.project.id, sessionId),
    files = nativeFiles(page.frames);
  expect(heldFileFixtureReady(files)).toBe(true);
  expect(files).toEqual(nativeFiles(running.frames));
  for (const pid of [tree.pid, tree.childPid]) {
    if (typeof pid !== "number")
      throw Error("Missing witnessed native fixture PID");
    const live = () => {
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
    };
    expect(live()).toBe(false);
  }
  expect(
    page.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome",
    )?.event,
  ).toMatchObject({
    event: {
      outcome: {
        // The native Chat runtime intentionally keeps a deadline uncertain;
        // this is independent of its fully captured partial file reports.
        phase: action === "deadline" ? "unknown" : "failed",
        reason:
          action === "deadline"
            ? "The Codex Chat turn exceeded its deadline."
            : "The Codex Chat turn was stopped.",
        threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
        turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
        timedOut: action === "deadline",
        stopped: true,
      },
    },
  });
  expect(
    nativeFiles(
      createSessionLibrary({ root: f.root, home: f.home }).exportTranscript(
        f.project.id,
        sessionId,
      ).conversation.frames,
    ),
  ).toEqual(files);
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(existsSync(join(f.root, "FILE_REPORT_MUST_NOT_CREATE.txt"))).toBe(
    false,
  );
});

test("actual inspectable native patches do not enable file Allow or expose a saved diff as approval authority", async () => {
  const f = await fixture("file-changes-approval"),
    service = f.open(),
    start = await service.start(f.project.id, f.request),
    sessionId = start.session.id,
    deadline = Date.now() + 4000;
  let offer = (await service.approvals(f.project.id, sessionId)).pending[0];
  while (!offer) {
    if (Date.now() > deadline)
      throw Error("Native file approval did not become available");
    await Bun.sleep(20);
    offer = (await service.approvals(f.project.id, sessionId)).pending[0];
  }
  expect(
    heldFileFixtureReady(
      nativeFiles((await service.read(f.project.id, sessionId)).frames),
    ),
  ).toBe(true);
  expect(offer.approval.availableDecisions).toEqual(["decline", "cancel"]);
  expect(offer.detailsUnavailableReason).toBe(
    "Actual file-change details are unavailable. Allow is disabled.",
  );
  expect(JSON.stringify(offer)).not.toContain("native patch stays text");
  const request = {
    requestId: randomUUID(),
    turnRequestId: offer.turnRequestId,
    approvalId: offer.approval.id,
    decision: "accept" as const,
  };
  await expect(
    service.decide(f.project.id, sessionId, request),
  ).rejects.toThrow();
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(0);
  await service.decide(f.project.id, sessionId, {
    ...request,
    decision: "decline",
  });
  await service.settled(f.project.id, sessionId);
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(1);
  expect(
    nativeFiles((await service.read(f.project.id, sessionId)).frames).find(
      (report) =>
        report.itemId === "reported-files-a" &&
        report.source === "turn/completed",
    )?.status,
  ).toBe("declined");
});

test("actual native mutable turn plans stay exact through private whole and partial reads, complete export, recreation and original retry", async () => {
  const f = await fixture("turn-plan");
  let service = f.open();
  const start = await service.start(f.project.id, f.request),
    sessionId = start.session.id;
  await service.settled(f.project.id, sessionId);
  const page = await service.read(f.project.id, sessionId),
    plans = page.frames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "turn-plan",
    ),
    first = plans[0];
  expect(plans).toHaveLength(3);
  expect(plans[0]?.event).toEqual(plans[1]?.event);
  expect(plans[2]?.event).not.toEqual(plans[0]?.event);
  expect(page.turns[0]?.phase).toBe("completed");
  if (
    first?.event.kind !== "coding-chat" ||
    first.event.event.kind !== "turn-plan"
  )
    throw Error("Missing actual native plan");
  const store = createConversationStore(f.home, undefined, {
      kind: "session",
      projectId: f.project.id,
      sessionId,
    }),
    state = store.read(f.project.id),
    path = conversationFile(f.home, f.project.id, {
      kind: "session",
      projectId: f.project.id,
      sessionId,
    }),
    before = readFileSync(path),
    registry = readFileSync(sessionRegistryFile(f.home));
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  for (const missing of ["user", "process", "native-turn"])
    expect(
      ownedCodingStateSchema.safeParse({
        ...state,
        frames: state.frames.filter((frame) =>
          missing === "native-turn"
            ? frame.event.kind !== "coding-chat" ||
              frame.event.event.kind !== "turn"
            : frame.event.kind !== missing,
        ),
      }).success,
    ).toBe(false);
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: state.frames.filter(
        (frame) => !plans.some((plan) => plan.seq === frame.seq),
      ),
    }).success,
  ).toBe(true); // Legacy turns did not capture additive plan reports.
  for (const change of [
    { threadId: randomUUID() },
    { turnId: randomUUID() },
    { itemId: "invented-item" },
    { source: "item/plan/delta" },
    { phase: "completed" },
  ]) {
    const altered = structuredClone(state),
      target = altered.frames.find((frame) => frame.seq === first.seq);
    if (
      target?.event.kind !== "coding-chat" ||
      target.event.event.kind !== "turn-plan"
    )
      throw Error("Missing copied native plan");
    Object.assign(target.event.event, change);
    expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
  }
  for (const change of [{ version: "other" }, { turnId: randomUUID() }]) {
    const altered = structuredClone(state),
      target = altered.frames.find((frame) => frame.seq === first.seq);
    if (!target) throw Error("Missing copied native plan");
    if ("version" in change) Object.assign(target.event, change);
    else Object.assign(target, change);
    expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
  }
  for (const frame of plans) {
    const partial = await service.read(f.project.id, sessionId, {
      after: frame.seq - 1,
    });
    expect(ownedCodingPageSchema.safeParse(partial).success).toBe(true);
    expect(partial.frames).toContainEqual(frame);
    expect(eventSchema.safeParse(frame.event).success).toBe(false);
    for (const binding of [
      null,
      {
        provider: "codex",
        sessionId: randomUUID(),
        version: "0.163.0-alpha.10.2",
      },
      {
        provider: "codex",
        sessionId: first.event.event.threadId,
        version: "other",
      },
    ])
      expect(
        ownedCodingPageSchema.safeParse({ ...partial, binding }).success,
      ).toBe(false);
  }
  const outcome = state.frames.findIndex(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "outcome",
  );
  expect(outcome).toBeGreaterThan(first.seq);
  const late = { ...first, seq: state.frames.length + 1 };
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [...state.frames, late],
    }).success,
  ).toBe(false);
  await expect(
    store.append(
      f.project.id,
      f.request.requestId,
      "former-owner",
      first.event,
    ),
  ).rejects.toThrow();
  expect(readFileSync(path)).toEqual(before);

  // Native final item snapshots close rich updates before the final runtime outcome.
  const prefix = state.frames.filter((frame) => frame.seq < first.seq),
    final: CodexChatReasoningSummary = {
      kind: "reasoning-summary",
      source: "turn/completed",
      threadId: first.event.event.threadId,
      turnId: first.event.event.turnId,
      itemId: "final-summary",
      partial: false,
      update: {
        kind: "snapshot",
        summary: [],
        truncated: false,
        closure: "turn-ended",
        turnStatus: "completed",
      },
    },
    report = (
      event: CodexChatCommand | CodexChatReasoningSummary | CodexChatTurnPlan,
      index: number,
    ): ConversationFrame => ({
      ...first,
      seq: prefix.length + index + 1,
      event: ownedCodingEventSchema.parse({
        kind: "coding-chat",
        provider: "codex",
        version: "0.163.0-alpha.10.2",
        event,
      }),
    });
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [...prefix, report(final, 0), report(first.event.event, 1)],
    }).success,
  ).toBe(false);
  const command: CodexChatCommand = {
      kind: "command",
      source: "item/completed",
      threadId: final.threadId,
      turnId: final.turnId,
      itemId: "budget-command",
      command: { text: "x".repeat(16_384), truncated: false },
      cwd: f.root,
      status: "completed",
      output: { text: "y".repeat(16_384), truncated: false },
      outputSource: "aggregate",
      exitCode: 0,
      durationMs: 0,
      partial: false,
    },
    summary: CodexChatReasoningSummary = {
      ...final,
      source: "item/completed",
      update: {
        kind: "snapshot",
        truncated: false,
        summary: [{ text: "z".repeat(16_384), truncated: false }],
        closure: "item-ended",
        turnStatus: null,
      },
    },
    plan: CodexChatTurnPlan = {
      ...first.event.event,
      explanation: { text: "p".repeat(16_384), truncated: false },
      plan: [],
    },
    commands = Array.from({ length: 20 }, (_, index) => ({
      ...command,
      itemId: `command-${index}`,
    })),
    summaries = Array.from({ length: 40 }, (_, index) => ({
      ...summary,
      itemId: `summary-${index}`,
    })),
    updates = Array.from({ length: 55 }, () => plan);
  const accepts = (
    events: Array<
      CodexChatCommand | CodexChatReasoningSummary | CodexChatTurnPlan
    >,
  ) =>
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [...prefix, ...events.map(report)],
    }).success;
  expect(accepts(commands)).toBe(true);
  expect(accepts(summaries)).toBe(true);
  expect(accepts(updates)).toBe(true);
  expect(accepts([...commands, ...summaries])).toBe(true);
  expect(accepts([...commands, ...summaries, ...updates])).toBe(false);
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, sessionId);
  expect(sessionTranscriptExportSchema.safeParse(exported).success).toBe(true);
  for (const frame of plans)
    expect(exported.conversation.frames).toContainEqual(frame);
  await service.close();
  service = f.open();
  expect((await service.read(f.project.id, sessionId)).frames).toEqual(
    page.frames,
  );
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(sessionRegistryFile(f.home))).toEqual(registry);
});

test.each([
  "Stop",
  "deadline",
])("actual %s retains a completed-step plan while deriving lifecycle only from the native runtime", async (action) => {
  const f = await fixture("turn-plan-held");
  let service = f.open();
  const start = await service.start(f.project.id, f.request),
    sessionId = start.session.id,
    deadline = Date.now() + 4000;
  let running = await service.read(f.project.id, sessionId);
  while (
    !running.frames.some(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "turn-plan" &&
        frame.event.event.plan.every((step) => step.status === "completed"),
    )
  ) {
    if (Date.now() > deadline)
      throw Error(
        "Native completed-step plan did not reach its private journal",
      );
    await Bun.sleep(20);
    running = await service.read(f.project.id, sessionId);
  }
  expect(running.turns[0]?.phase).toBe("running");
  expect(
    ownedSessionLifecycle(running, {
      mode: "chat",
      loaded: true,
      live: true,
      stopping: false,
      feedInterrupted: false,
      readError: "",
    }).state,
  ).toBe("running");
  if (action === "Stop")
    await service.stop(f.project.id, sessionId, f.request.requestId);
  await service.settled(f.project.id, sessionId);
  await service.close();
  service = f.open();
  const page = await service.read(f.project.id, sessionId),
    plans = page.frames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "turn-plan",
    );
  expect(plans).toHaveLength(3);
  expect(plans).toEqual(
    running.frames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "turn-plan",
    ),
  );
  expect(
    ownedSessionLifecycle(page, {
      mode: "chat",
      loaded: true,
      live: false,
      stopping: false,
      feedInterrupted: false,
      readError: "",
    }).state,
  ).toBe(action === "Stop" ? "stopped" : "timed-out");
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, sessionId);
  for (const frame of plans)
    expect(exported.conversation.frames).toContainEqual(frame);
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
});

test("actual explicit native summaries preserve private indexed facts and a shared command budget across reads, export and recreation", async () => {
  const f = await fixture("reasoning-summary");
  let service = f.open();
  const start = await service.start(f.project.id, f.request),
    sessionId = start.session.id;
  await service.settled(f.project.id, sessionId);
  const page = await service.read(f.project.id, sessionId);
  expect(page.turns[0]?.phase).toBe("completed");
  const summaries = page.frames.filter(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "reasoning-summary",
  );
  expect(summaries).toHaveLength(8);
  const first = summaries[0];
  if (
    first?.event.kind !== "coding-chat" ||
    first.event.event.kind !== "reasoning-summary"
  )
    throw Error("Missing actual summary fixture");
  const path = conversationFile(f.home, f.project.id, {
    kind: "session",
    projectId: f.project.id,
    sessionId,
  });
  const before = readFileSync(path),
    registry = readFileSync(sessionRegistryFile(f.home));
  expect(before.toString()).not.toContain("RAW_REASONING_MUST_NOT_PERSIST");
  const state = createConversationStore(f.home, undefined, {
    kind: "session",
    projectId: f.project.id,
    sessionId,
  }).read(f.project.id);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  // Older saved turns have no additive summaries, or no final-turn summary.
  // Their immutable user/command/outcome history remains valid unchanged.
  for (const omitAll of [true, false])
    expect(
      ownedCodingStateSchema.safeParse({
        ...state,
        frames: state.frames.filter(
          (frame) =>
            frame.event.kind !== "coding-chat" ||
            frame.event.event.kind !== "reasoning-summary" ||
            (!omitAll && frame.event.event.source !== "turn/completed"),
        ),
      }).success,
    ).toBe(true);
  for (const conflict of [false, true]) {
    const altered = structuredClone(state),
      index = altered.frames.findIndex(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "reasoning-summary" &&
          frame.event.event.source === "turn/completed",
      ),
      target = altered.frames[index];
    if (
      target?.event.kind !== "coding-chat" ||
      target.event.event.kind !== "reasoning-summary" ||
      target.event.event.update.kind !== "snapshot"
    )
      throw Error("Missing actual final summary");
    if (conflict)
      target.event.event.update.summary[0] = {
        text: "Conflicting final summary",
        truncated: false,
      };
    else {
      altered.frames.splice(index + 1, 0, structuredClone(target));
      for (const [position, frame] of altered.frames.entries())
        frame.seq = position + 1;
    }
    expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
  }
  for (const change of [
    { threadId: randomUUID() },
    { turnId: randomUUID() },
    { itemId: "foreign-item" },
    { source: "item/reasoning/textDelta" },
    { partial: false },
    { content: "RAW_REASONING_MUST_NOT_PERSIST" },
  ]) {
    const altered = structuredClone(state),
      target = altered.frames.find((frame) => frame.seq === first.seq);
    if (
      target?.event.kind !== "coding-chat" ||
      target.event.event.kind !== "reasoning-summary"
    )
      throw Error("Missing copied summary");
    Object.assign(target.event.event, change);
    expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
  }
  const delta = summaries.find(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "reasoning-summary" &&
      frame.event.event.update.kind === "delta",
  );
  if (!delta) throw Error("Missing actual indexed delta");
  const wrongIndex = structuredClone(state),
    changed = wrongIndex.frames.find((frame) => frame.seq === delta.seq);
  if (
    changed?.event.kind !== "coding-chat" ||
    changed.event.event.kind !== "reasoning-summary" ||
    changed.event.event.update.kind !== "delta"
  )
    throw Error("Missing copied indexed delta");
  changed.event.event.update.summaryIndex = 127;
  expect(ownedCodingStateSchema.safeParse(wrongIndex).success).toBe(false);
  for (const frame of summaries) {
    const partial = await service.read(f.project.id, sessionId, {
      after: frame.seq - 1,
    });
    expect(ownedCodingPageSchema.safeParse(partial).success).toBe(true);
    expect(partial.frames).toContainEqual(frame);
    expect(eventSchema.safeParse(frame.event).success).toBe(false);
    for (const binding of [
      null,
      {
        ...partial.binding,
        provider: "codex",
        sessionId: randomUUID(),
        version: "0.163.0-alpha.10.2",
      },
      {
        ...partial.binding,
        provider: "codex",
        sessionId: first.event.event.threadId,
        version: "other",
      },
    ])
      expect(
        ownedCodingPageSchema.safeParse({ ...partial, binding }).success,
      ).toBe(false);
  }
  const originalPrefix = state.frames.filter((frame) => frame.seq < first.seq);
  const command: CodexChatCommand = {
    kind: "command",
    source: "item/started",
    threadId: first.event.event.threadId,
    turnId: first.event.event.turnId,
    itemId: "budget",
    command: { text: "x".repeat(16_384), truncated: false },
    cwd: f.root,
    status: "inProgress",
    output: { text: "y".repeat(16_384), truncated: false },
    outputSource: "aggregate",
    exitCode: null,
    durationMs: null,
    partial: true,
  };
  const summary: CodexChatReasoningSummary = {
    ...first.event.event,
    source: "item/completed",
    partial: false,
    update: {
      kind: "snapshot",
      summary: [{ text: "z".repeat(16_384), truncated: false }],
      truncated: false,
      closure: "item-ended",
      turnStatus: null,
    },
  };
  const frame = (
    event: CodexChatCommand | CodexChatReasoningSummary,
    index: number,
  ): ConversationFrame => ({
    ...first,
    seq: originalPrefix.length + index + 1,
    event: ownedCodingEventSchema.parse({
      kind: "coding-chat",
      provider: "codex",
      version: "0.163.0-alpha.10.2",
      event,
    }),
  });
  const commands = Array.from({ length: 40 }, (_, index) =>
    frame({ ...command, itemId: `command-${index}` }, index),
  );
  const reports = Array.from({ length: 64 }, (_, index) =>
    frame({ ...summary, itemId: `summary-${index}` }, index),
  );
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [...originalPrefix, ...commands],
    }).success,
  ).toBe(true);
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [...originalPrefix, ...reports],
    }).success,
  ).toBe(true);
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [
        ...originalPrefix,
        ...commands,
        ...reports.map((item, index) => ({
          ...item,
          seq: originalPrefix.length + commands.length + index + 1,
        })),
      ],
    }).success,
  ).toBe(false);
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, sessionId);
  expect(sessionTranscriptExportSchema.safeParse(exported).success).toBe(true);
  expect(JSON.stringify(exported)).not.toContain(
    "RAW_REASONING_MUST_NOT_PERSIST",
  );
  for (const frame of summaries)
    expect(exported.conversation.frames).toContainEqual(frame);
  await service.close();
  service = f.open();
  expect((await service.read(f.project.id, sessionId)).frames).toEqual(
    page.frames,
  );
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(sessionRegistryFile(f.home))).toEqual(registry);
});

test.each([
  "reasoning-summary-completed-only",
  "reasoning-summary-interrupted",
])("actual %s snapshots preserve native closure without inventing earlier reasoning history", async (mode) => {
  const f = await fixture(mode),
    service = f.open();
  const started = await service.start(f.project.id, f.request),
    sessionId = started.session.id;
  await service.settled(f.project.id, sessionId);
  const page = await service.read(f.project.id, sessionId),
    interrupted = mode.endsWith("interrupted");
  expect(page.turns[0]?.phase).toBe(interrupted ? "failed" : "completed");
  const summary = [...page.frames]
    .reverse()
    .find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "reasoning-summary",
    );
  expect(summary?.event).toMatchObject({
    event: {
      partial: interrupted,
      update: {
        kind: "snapshot",
        closure: "turn-ended",
        turnStatus: interrupted ? "interrupted" : "completed",
      },
    },
  });
  const state = createConversationStore(f.home, undefined, {
    kind: "session",
    projectId: f.project.id,
    sessionId,
  }).read(f.project.id);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  if (interrupted) {
    const falseSuccess = structuredClone(state),
      outcome = falseSuccess.frames.find(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "outcome",
      );
    if (
      outcome?.event.kind !== "coding-chat" ||
      outcome.event.event.kind !== "outcome"
    )
      throw Error("Missing actual interrupted outcome");
    outcome.event.event.outcome.phase = "completed";
    outcome.event.event.outcome.reason = null;
    expect(ownedCodingStateSchema.safeParse(falseSuccess).success).toBe(false);
  }
  if (
    summary?.event.kind !== "coding-chat" ||
    summary.event.event.kind !== "reasoning-summary"
  )
    throw Error("Missing final summary snapshot");
  const prefix = state.frames.filter((frame) => frame.seq <= summary.seq),
    late = {
      ...summary,
      seq: summary.seq + 1,
      event: {
        ...summary.event,
        event: {
          ...summary.event.event,
          source: "item/reasoning/summaryTextDelta",
          partial: true,
          update: {
            kind: "delta",
            summaryIndex: 0,
            content: { text: "late", truncated: false },
            prefixMissing: true,
          },
        },
      },
    };
  expect(
    ownedCodingStateSchema.safeParse({ ...state, frames: [...prefix, late] })
      .success,
  ).toBe(false);
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, sessionId);
  expect(exported.conversation.frames).toContainEqual(summary);
  expect(JSON.stringify(exported)).not.toContain(
    "RAW_REASONING_MUST_NOT_PERSIST",
  );
});

test("actual native MCP snapshots remain private and exact across whole/partial reads, export, recreation and original retry", async () => {
  const f = await fixture("mcp-tool-calls");
  let service = f.open();
  const start = await service.start(f.project.id, f.request),
    sessionId = start.session.id;
  await service.settled(f.project.id, sessionId);
  const page = await service.read(f.project.id, sessionId),
    reports = nativeMcpCalls(page.frames),
    main = reports.filter((report) => report.itemId === "reported-mcp-main"),
    failed = reports.find((report) => report.itemId === "reported-mcp-failed"),
    empty = reports.find((report) => report.itemId === "reported-mcp-empty"),
    clipped = reports.find(
      (report) => report.itemId === "reported-mcp-clipped",
    );
  expect(page.turns[0]?.phase).toBe("completed");
  expect(reports).toHaveLength(9);
  expect(
    main.map((report) => [report.source, report.status, report.closure]),
  ).toEqual([
    ["item/started", "inProgress", "open"],
    ["item/completed", "completed", "item-ended"],
    ["turn/completed", "completed", "turn-ended"],
  ]);
  expect(main[0]?.result).toBeNull();
  expect(main[1]?.result).toEqual({
    content: {
      json: '[{"type":"text","text":"<img>MCP_RESULT_LITERAL</img>"}]',
      truncated: false,
    },
    structuredContent: {
      json: '{"path":"file:///MCP_RESULT_URI_IS_LITERAL"}',
      truncated: false,
    },
  });
  expect(failed).toMatchObject({
    status: "failed",
    result: null,
    error: { text: "MCP_ERROR_TEXT_SENTINEL", truncated: false },
    durationMs: 0,
    partial: false,
  });
  expect(empty).toMatchObject({
    status: "completed",
    arguments: { json: "null", truncated: false },
    result: {
      content: { json: "[]", truncated: false },
      structuredContent: null,
    },
  });
  expect(clipped?.arguments.truncated).toBe(true);
  expect(clipped?.arguments.omitted).toBe("size");
  expect(ownedCodingPageSchema.safeParse(page).success).toBe(true);
  for (const frame of page.frames.filter(
    (candidate) =>
      candidate.event.kind === "coding-chat" &&
      candidate.event.event.kind === "mcp-tool-call",
  )) {
    const partial = await service.read(f.project.id, sessionId, {
      after: frame.seq - 1,
      limit: 1,
    });
    expect(partial.frames).toEqual([frame]);
    expect(ownedCodingPageSchema.safeParse(partial).success).toBe(true);
    expect(eventSchema.safeParse(frame.event).success).toBe(false);
    expect(
      ownedCodingPageSchema.safeParse({
        ...partial,
        binding: {
          provider: "codex",
          sessionId: randomUUID(),
          version: "0.163.0-alpha.10.2",
        },
      }).success,
    ).toBe(false);
  }
  const privateJson = JSON.stringify(page.frames);
  for (const secret of [
    "MCP_HINT_",
    "MCP_META_MUST_NOT_PERSIST",
    "MCP_HINT_APP_MUST_NOT_PERSIST",
    "MCP_HINT_PLUGIN_MUST_NOT_PERSIST",
  ])
    expect(privateJson).not.toContain(secret);
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, sessionId);
  expect(sessionTranscriptExportSchema.safeParse(exported).success).toBe(true);
  expect(nativeMcpCalls(exported.conversation.frames)).toEqual(reports);
  expect(JSON.stringify(exported)).not.toContain("MCP_HINT_");
  expect(existsSync(join(f.root, "FILE_MCP_MUST_NOT_CREATE.txt"))).toBe(false);
  const storePath = conversationFile(f.home, f.project.id, {
      kind: "session",
      projectId: f.project.id,
      sessionId,
    }),
    bytes = readFileSync(storePath),
    registry = readFileSync(sessionRegistryFile(f.home));
  await service.close();
  service = f.open();
  expect((await service.read(f.project.id, sessionId)).frames).toEqual(
    page.frames,
  );
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(readFileSync(storePath)).toEqual(bytes);
  expect(readFileSync(sessionRegistryFile(f.home))).toEqual(registry);
});

test("actual native MCP Stop preserves the exact partial report prefix, export and retry without replay", async () => {
  const f = await fixture("mcp-tool-calls-held");
  let service = f.open();
  const start = await service.start(f.project.id, f.request),
    sessionId = start.session.id,
    deadline = Date.now() + 4000;
  let running = await service.read(f.project.id, sessionId),
    tree: Record<string, unknown> | undefined,
    reports = nativeMcpCalls(running.frames);
  while (
    !heldMcpFixtureReady(reports) ||
    !(tree = f.records().find((row) => row.kind === "tree"))
  ) {
    if (Date.now() > deadline)
      throw Error(
        "The exact native MCP prefix and held helper did not reach storage",
      );
    await Bun.sleep(20);
    running = await service.read(f.project.id, sessionId);
    reports = nativeMcpCalls(running.frames);
  }
  expect(running.turns[0]?.phase).toBe("running");
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  await service.stop(f.project.id, sessionId, f.request.requestId);
  await service.settled(f.project.id, sessionId);
  await service.close();
  service = f.open();
  const page = await service.read(f.project.id, sessionId),
    savedReports = nativeMcpCalls(page.frames);
  expect(heldMcpFixtureReady(savedReports)).toBe(true);
  expect(savedReports).toEqual(reports);
  expect(
    page.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome",
    )?.event,
  ).toMatchObject({
    event: {
      outcome: {
        phase: "failed",
        reason: "The Codex Chat turn was stopped.",
        threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
        turnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
        stopped: true,
        timedOut: false,
      },
    },
  });
  for (const pid of [tree.pid, tree.childPid]) {
    if (typeof pid !== "number")
      throw Error("Missing witnessed native fixture PID");
    const live = () => {
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
    };
    expect(live()).toBe(false);
  }
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, sessionId);
  expect(nativeMcpCalls(exported.conversation.frames)).toEqual(savedReports);
  const storePath = conversationFile(f.home, f.project.id, {
      kind: "session",
      projectId: f.project.id,
      sessionId,
    }),
    bytes = readFileSync(storePath);
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(readFileSync(storePath)).toEqual(bytes);
  expect(existsSync(join(f.root, "FILE_MCP_MUST_NOT_CREATE.txt"))).toBe(false);
});

test.each([
  "Stop",
  "deadline",
])("actual %s retains only partial native summaries and never resends them after reopening", async (action) => {
  const f = await fixture("reasoning-summary-held");
  const run = f.runtime.run.bind(f.runtime);
  let releaseFinalSave = () => {},
    heldFinalSave = false;
  const finalSave = new Promise<void>((resolve) => {
    releaseFinalSave = resolve;
  });
  const held =
    action === "Stop"
      ? spyOn(f.runtime, "run").mockImplementation(
          (input, persist, signal, callbacks) =>
            run(
              input,
              async (event) => {
                if (
                  event.kind === "reasoning-summary" &&
                  event.update.kind === "delta" &&
                  event.update.summaryIndex === 1
                ) {
                  heldFinalSave = true;
                  await finalSave;
                }
                await persist(event);
              },
              signal,
              callbacks,
            ),
        )
      : null;
  try {
    let service = f.open();
    const started = await service.start(f.project.id, f.request),
      sessionId = started.session.id;
    const deadline = Date.now() + 4000;
    let observedHeldPrefix = false;
    for (;;) {
      const reports = nativeSummaries(
        (await service.read(f.project.id, sessionId)).frames,
      );
      if (heldFinalSave && !observedHeldPrefix) {
        // FIFO private persistence has saved all five earlier reports. An ANY-delta
        // witness would allow Stop here while the sixth required report is absent.
        expect(reports).toHaveLength(5);
        expect(reports.some((report) => report.update.kind === "delta")).toBe(
          true,
        );
        expect(heldSummaryFixtureReady(reports)).toBe(false);
        observedHeldPrefix = true;
        releaseFinalSave();
      }
      if (heldSummaryFixtureReady(reports)) break;
      if (Date.now() > deadline)
        throw Error(
          "The complete native summary fixture did not reach its private journal",
        );
      await Bun.sleep(20);
    }
    if (action === "Stop") expect(observedHeldPrefix).toBe(true);
    if (action === "Stop")
      await service.stop(f.project.id, sessionId, f.request.requestId);
    await service.settled(f.project.id, sessionId);
    await service.close();
    service = f.open();
    const page = await service.read(f.project.id, sessionId);
    const summaries = page.frames.filter(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "reasoning-summary",
    );
    expect(summaries).toHaveLength(6);
    expect(
      summaries.every(
        (frame) =>
          frame.event.kind === "coding-chat" &&
          frame.event.event.kind === "reasoning-summary" &&
          frame.event.event.partial,
      ),
    ).toBe(true);
    expect(
      ownedSessionLifecycle(page, {
        mode: "chat",
        loaded: true,
        live: false,
        stopping: false,
        feedInterrupted: false,
        readError: "",
      }).state,
    ).toBe(action === "Stop" ? "stopped" : "timed-out");
    const exported = createSessionLibrary({
      root: f.root,
      home: f.home,
    }).exportTranscript(f.project.id, sessionId);
    for (const frame of summaries)
      expect(exported.conversation.frames).toContainEqual(frame);
    expect(JSON.stringify(exported)).not.toContain(
      "RAW_REASONING_MUST_NOT_PERSIST",
    );
    await service.start(f.project.id, f.request);
    expect(
      f.records().filter((row) => row.method === "turn/start"),
    ).toHaveLength(1);
  } finally {
    releaseFinalSave();
    held?.mockRestore();
  }
});

test("actual native command history stays exact across protected partial reads, export and recreation without replay", async () => {
  const f = await fixture("command-activity");
  let service = f.open();
  const started = await service.start(f.project.id, f.request),
    sessionId = started.session.id;
  await service.settled(f.project.id, sessionId);
  const page = await service.read(f.project.id, sessionId);
  expect(page.turns[0]?.phase).toBe("completed");
  const commands = page.frames.filter(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "command",
  );
  expect(commands).toHaveLength(3);
  const path = conversationFile(f.home, f.project.id, {
    kind: "session",
    projectId: f.project.id,
    sessionId,
  });
  const before = readFileSync(path),
    registry = readFileSync(sessionRegistryFile(f.home));
  const state = createConversationStore(f.home, undefined, {
    kind: "session",
    projectId: f.project.id,
    sessionId,
  }).read(f.project.id);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  const firstCommand = commands[0];
  if (
    firstCommand?.event.kind !== "coding-chat" ||
    firstCommand.event.event.kind !== "command"
  )
    throw Error("Missing correlated native command fixture");
  for (const change of [
    { threadId: randomUUID() },
    { turnId: randomUUID() },
    { itemId: "different-native-item" },
    { cwd: "changed report identity" },
    { source: "codex.item.started" },
    { partial: false },
  ]) {
    const altered = structuredClone(state);
    const target = altered.frames.find(
      (frame) => frame.seq === firstCommand.seq,
    );
    if (
      target?.event.kind !== "coding-chat" ||
      target.event.event.kind !== "command"
    )
      throw Error("Missing copied command");
    Object.assign(target.event.event, change);
    expect(ownedCodingStateSchema.safeParse(altered).success).toBe(false);
  }
  const beforeCommand = state.frames.filter(
    (frame) => frame.seq < firstCommand.seq,
  );
  expect(
    ownedCodingStateSchema.safeParse({ ...state, frames: beforeCommand })
      .success,
  ).toBe(true);
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [
        ...beforeCommand,
        {
          ...firstCommand,
          event: {
            kind: "coding-activity",
            provider: "codex",
            version: "0.163.0-alpha.10.2",
            id: "unsealed-command",
            source: "codex.item.started",
            partial: true,
            activity: {
              kind: "command",
              command: {
                text: "Generic command must remain refused",
                truncated: false,
              },
              state: "running",
            },
          },
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [
        ...state.frames,
        { ...firstCommand, seq: state.frames.length + 1 },
      ],
    }).success,
  ).toBe(false);
  for (const frame of commands) {
    const partial = await service.read(f.project.id, sessionId, {
      after: frame.seq - 1,
    });
    expect(ownedCodingPageSchema.safeParse(partial).success).toBe(true);
    expect(partial.frames).toContainEqual(frame);
    expect(eventSchema.safeParse(frame.event).success).toBe(false);
    expect(
      ownedCodingPageSchema.safeParse({
        ...partial,
        binding: partial.binding
          ? { ...partial.binding, sessionId: randomUUID() }
          : null,
      }).success,
    ).toBe(false);
    expect(
      ownedCodingPageSchema.safeParse({
        ...partial,
        binding: partial.binding
          ? { ...partial.binding, version: "0.164.0" }
          : null,
      }).success,
    ).toBe(false);
  }
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, sessionId);
  expect(sessionTranscriptExportSchema.safeParse(exported).success).toBe(true);
  for (const frame of commands)
    expect(exported.conversation.frames).toContainEqual(frame);
  await service.close();
  service = f.open();
  expect((await service.read(f.project.id, sessionId)).frames).toEqual(
    page.frames,
  );
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    1,
  );
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(sessionRegistryFile(f.home))).toEqual(registry);
});

test("an actual interrupted Chat retains an unfinished final command snapshot without reviving the ended turn", async () => {
  const f = await fixture("command-interrupted"),
    service = f.open();
  const start = await service.start(f.project.id, f.request);
  await service.settled(f.project.id, start.session.id);
  const page = await service.read(f.project.id, start.session.id);
  expect(page.turns[0]?.phase).toBe("failed");
  const final = page.frames.find(
    (frame) =>
      frame.event.kind === "coding-chat" &&
      frame.event.event.kind === "command" &&
      frame.event.event.source === "turn/completed",
  );
  expect(final?.event).toMatchObject({
    event: {
      source: "turn/completed",
      status: "inProgress",
      partial: true,
      outputSource: "aggregate",
      output: { text: "Partial aggregate at interruption", truncated: false },
      exitCode: null,
    },
  });
  expect(page.frames.at(-1)?.event).toMatchObject({
    event: {
      kind: "outcome",
      outcome: { phase: "failed", stopped: false, timedOut: false },
    },
  });
  if (
    final?.event.kind !== "coding-chat" ||
    final.event.event.kind !== "command"
  )
    throw Error("Missing actual final partial command");
  const state = createConversationStore(f.home, undefined, {
    kind: "session",
    projectId: f.project.id,
    sessionId: start.session.id,
  }).read(f.project.id);
  expect(ownedCodingStateSchema.safeParse(state).success).toBe(true);
  const finalIndex = state.frames.findIndex((frame) => frame.seq === final.seq);
  const late = {
    ...final,
    seq: final.seq + 1,
    event: {
      ...final.event,
      event: {
        ...final.event.event,
        source: "item/commandExecution/outputDelta",
        outputSource: "delta",
      },
    },
  };
  expect(
    ownedCodingStateSchema.safeParse({
      ...state,
      frames: [...state.frames.slice(0, finalIndex + 1), late],
    }).success,
  ).toBe(false);
  const exported = createSessionLibrary({
    root: f.root,
    home: f.home,
  }).exportTranscript(f.project.id, start.session.id);
  expect(exported.conversation.frames).toContainEqual(final);
  await service.close();
});

test("owned Chat persists its private snapshot and resumes the exact native thread after service recreation", async () => {
  const f = await fixture("service-tier-null");
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
  const secondRequestId = randomUUID();
  await service.send(f.project.id, started.session.id, {
    requestId: secondRequestId,
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
  const owner = createSessionRegistry(f.home, "codex", "chat").read(
      f.project.id,
      started.session.id,
    ),
    fullState = createConversationStore(f.home, undefined, {
      kind: "session",
      projectId: f.project.id,
      sessionId: started.session.id,
    }).read(f.project.id),
    resolveTurn = (requestId: string) =>
      resolveCodexChatForkSource({
        owner,
        state: fullState,
        projectId: f.project.id,
        conversationId: started.session.id,
        workspaceKey: workspaceKey(resolveCheckout(f.root).workspace),
        selectedTurnRequestId: requestId,
      });
  const firstSource = resolveTurn(f.request.requestId),
    secondSource = resolveTurn(secondRequestId);
  expect(firstSource).toMatchObject({
    eligible: true,
    selectedTurnRequestId: f.request.requestId,
    lastTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a54",
    sourceSettings: { serviceTier: null, reasoningEffort: null },
  });
  expect(secondSource).toMatchObject({
    eligible: true,
    selectedTurnRequestId: secondRequestId,
    lastTurnId: "0199a213-81c0-7800-8aa1-bbab2a035a55",
    sourceSettings: { serviceTier: null, reasoningEffort: null },
  });
  expect(firstSource.eligible && secondSource.eligible).toBe(true);
  if (!firstSource.eligible || !secondSource.eligible)
    throw Error("Actual owned turn evidence was not Fork-eligible.");
  expect(firstSource.lastTurnId).not.toBe(secondSource.lastTurnId);
  expect(fullState.turns.map((turn) => turn.requestId)).toEqual([
    f.request.requestId,
    secondRequestId,
  ]);
  expect(
    f.records().filter((row) => row.method === "thread/fork"),
  ).toHaveLength(0);
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    2,
  );
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

test("a real initialization failure remains readable after the process cursor without inventing native identity or replaying a prompt", async () => {
  const f = await fixture("hang-initialize", 1000);
  let service = f.open();
  const started = await service.start(f.project.id, f.request),
    sessionId = started.session.id;
  await service.settled(f.project.id, sessionId);
  const complete = await service.read(f.project.id, sessionId),
    terminal = complete.frames.find(
      (frame) =>
        frame.event.kind === "coding-chat" &&
        frame.event.event.kind === "outcome",
    );
  if (
    terminal?.event.kind !== "coding-chat" ||
    terminal.event.event.kind !== "outcome"
  )
    throw Error("Missing actual pre-identity terminal report");
  expect(complete.binding).toBeNull();
  expect(terminal.event.event.outcome).toMatchObject({
    phase: "unknown",
    threadId: null,
    turnId: null,
    usage: null,
    observedModel: null,
    stopped: true,
  });
  const partial = await service.read(f.project.id, sessionId, {
    after: terminal.seq - 1,
  });
  expect(partial.frames).toEqual([terminal]);
  expect(ownedCodingPageSchema.safeParse(partial).success).toBe(true);
  for (const change of [
    { threadId: randomUUID() },
    { turnId: randomUUID() },
    { usage: { lastResponse: {}, threadTotal: {} } },
    { phase: "completed", exitCode: 0 },
  ]) {
    const forged = {
      ...terminal,
      event: {
        ...terminal.event,
        event: {
          kind: "outcome",
          outcome: { ...terminal.event.event.outcome, ...change },
        },
      },
    };
    expect(
      ownedCodingPageSchema.safeParse({ ...partial, frames: [forged] }).success,
    ).toBe(false);
  }
  await service.close();
  service = f.open();
  expect(
    ownedCodingPageSchema.safeParse(
      await service.read(f.project.id, sessionId, {
        after: terminal.seq - 1,
      }),
    ).success,
  ).toBe(true);
  expect(
    createSessionLibrary({ root: f.root, home: f.home }).exportTranscript(
      f.project.id,
      sessionId,
    ).conversation.frames,
  ).toContainEqual(terminal);
  await service.start(f.project.id, f.request);
  expect(f.records().filter((row) => row.method === "initialize")).toHaveLength(
    1,
  );
  expect(f.records().filter((row) => row.method === "turn/start")).toHaveLength(
    0,
  );
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
