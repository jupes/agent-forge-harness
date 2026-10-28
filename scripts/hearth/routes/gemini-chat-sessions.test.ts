import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GeminiChatStartRequest } from "../../../types/gemini-owned-chat";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { ownedCodingPageSchema } from "../../sessions/codex-owned-journal";
import {
  ownedCodingSessionSchema,
  ownedCodingStartReceiptSchema,
} from "../../sessions/codex-owned-wire-protocol";
import { geminiChatApprovalPageSchema } from "../../sessions/gemini-chat-owned-protocol";
import { geminiChatPreviewReceiptSchema } from "../../sessions/gemini-chat-preview-protocol";
import { createGeminiChatRuntime } from "../../sessions/gemini-chat-runtime";
import { sessionStartIdentityPageSchema } from "../../sessions/identity-protocol";
import { sessionTranscriptExportSchema } from "../../sessions/library-protocol";
import { sessionRegistryFile } from "../../sessions/registry";
import { expectStartIdentityState } from "../../sessions/session-start-identity-test-witness";
import { scratchDirs } from "../../test-scratch";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import {
  emitGeminiChatWitnessFailureFactsAndRethrow,
  projectGeminiChatFailureFacts,
  type RuntimeProjection,
  readGeminiChatWitnessLog,
} from "./gemini-chat-witness-diagnostic.test-utils";
import { fixtureSessionGit } from "./session-fixture";

const binaries = scratchDirs(),
  opened: TestHearth[] = [],
  releases: Array<() => void> = [];
let command: string;
beforeAll(() => {
  command = join(
    binaries.make("gemini-chat-http-binary-"),
    process.platform === "win32" ? "fixture.exe" : "fixture",
  );
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(
        import.meta.dir,
        "../../sessions/fixtures/gemini-chat-runtime-compiled.ts",
      ),
      "--compile",
      "--outfile",
      command,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
  );
  if (built.exitCode !== 0)
    throw Error(`Inert ACP build failed: ${built.stderr.toString()}`);
}, 25_000);
afterAll(() => binaries.cleanup());
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const h of opened.splice(0).reverse()) await h.close();
});

async function fixture(
  mode = "normal",
  hold: "start" | "decision" | null = null,
  holdRuntimeResult = false,
) {
  let actual: ReturnType<typeof createGeminiChatRuntime> | undefined,
    held = false,
    runtimeRunState: "not-entered" | "pending" | "settled" = "not-entered",
    activeStartInput: unknown,
    release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  let releaseRuntime: () => void = () => {};
  const runtimeGate = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  releases.push(releaseRuntime);
  const selected = () => {
    if (!actual) throw Error("No planted inert ACP runtime");
    return actual;
  };
  const h = await startTestHearth({
    files: {
      "agent-forge.toml":
        '[execution.env]\npass = ["GEMINI_CHAT_LOG", "GEMINI_CHAT_MODE"]\n[smiths.gemini-example]\nprovider = "gemini"\nmodel = "exact-model"\neffort = "default"\nenabled = true\n',
    },
    api: {
      git: fixtureSessionGit,
      geminiChatRuntime: {
        async prepare(input) {
          const action = h.events(["operator.action"]).at(-1);
          expect(
            action?.kind === "operator.action" &&
              [
                "session.preview",
                "session.start",
                "session.turn.send",
              ].includes(action.payload.action),
          ).toBe(true);
          if (
            activeStartInput !== undefined &&
            action?.kind === "operator.action" &&
            action.payload.action === "session.start"
          )
            await expectStartIdentityState(
              h.home,
              FIXTURE_PROJECT_ID,
              h.workspace,
              activeStartInput,
              "attempted",
            );
          return selected().prepare(input);
        },
        async run(...args) {
          runtimeRunState = "pending";
          try {
            const result = await selected().run(...args);
            if (holdRuntimeResult) await runtimeGate;
            return result;
          } finally {
            runtimeRunState = "settled";
          }
        },
      },
      decorate: (routes) =>
        routes.map((route) =>
          route.kind === "action" &&
          route.action ===
            (hold === "start" ? "session.start" : "session.approval.decide")
            ? {
                ...route,
                async effect(input, context) {
                  const result = await route.effect(input, context);
                  if (hold && !held && [200, 202].includes(result.status)) {
                    held = true;
                    await gate;
                  }
                  return result;
                },
              }
            : route,
        ),
    },
  });
  opened.push(h);
  const log = join(h.root, "gemini-acp.json");
  actual = createGeminiChatRuntime({
    root: h.root,
    home: h.home,
    configHome: h.configHome,
    command: [command],
    environment: {
      ...process.env,
      GEMINI_CHAT_LOG: log,
      GEMINI_CHAT_MODE: mode,
    },
    timeoutMs: 8000,
    cancellationTimeoutMs: 500,
  });
  const catalog = projectCatalogFixture(h.workspace);
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  const request: GeminiChatStartRequest = {
    provider: "gemini",
    requestId: randomUUID(),
    smith: "gemini-example",
    repository: h.workspace,
    worktree: h.workspace,
    launch: {
      route: "gemini-cli",
      mode: "chat",
      prompt: "PRIVATE-ACP-PROMPT",
      attachments: [
        { kind: "text", name: "note", text: "PRIVATE-ACP-CONTEXT" },
      ],
    },
  };
  const path = `/projects/${FIXTURE_PROJECT_ID}/sessions`;
  const post = (
    suffix: string,
    input: unknown,
    token: string | null = h.hearth.token,
    signal?: AbortSignal,
  ) => {
    if (suffix === "") activeStartInput = input;
    return fetch(`${h.api}${path}${suffix}`, {
      method: "POST",
      headers: h.headers(token),
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
  };
  const get = (suffix: string) =>
    fetch(`${h.api}${path}${suffix}`, { headers: h.headers(h.hearth.token) });
  const records = (): Record<string, unknown>[] => {
    if (!existsSync(log)) return [];
    try {
      return JSON.parse(readFileSync(log, "utf8"));
    } catch {
      throw Error("Invalid whole inert log");
    }
  };
  return {
    h,
    request,
    post,
    get,
    records,
    catalog,
    log,
    release,
    releaseRuntime,
    held: () => held,
    runtimeRunState: () => runtimeRunState,
  };
}
async function data(response: Response) {
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw Error(`Invalid HTTP envelope (${response.status})`);
  }
  expect(envelope).toMatchObject({ ok: true, error: null });
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("data" in envelope)
  )
    throw Error("Missing protected data");
  return envelope.data;
}
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  const end = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= end)
      throw Error("The protected inert witness did not arrive");
    await Bun.sleep(10);
  }
}

type ProtectedDiagnosticRead =
  | { state: "ok"; data: unknown }
  | {
      state:
        | "not-found"
        | "denied"
        | "unavailable"
        | "other"
        | "oversized"
        | "invalid";
    };

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function boundedProtectedRead(
  f: Awaited<ReturnType<typeof fixture>>,
  suffix: string,
  maximumBytes: number,
): Promise<ProtectedDiagnosticRead> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`${f.h.api}${suffix}`, {
      headers: f.h.headers(f.h.hearth.token),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        // A diagnostic body is never needed to classify a non-success status.
      }
      return {
        state:
          response.status === 404
            ? "not-found"
            : response.status === 401 || response.status === 403
              ? "denied"
              : response.status >= 500
                ? "unavailable"
                : "other",
      };
    }
    const text = await boundedResponseText(response, maximumBytes);
    if (text === null) return { state: "oversized" };
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      return { state: "invalid" };
    }
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("ok" in envelope) ||
      envelope.ok !== true ||
      !("error" in envelope) ||
      envelope.error !== null ||
      !("data" in envelope)
    )
      return { state: "invalid" };
    return { state: "ok", data: envelope.data };
  } catch {
    return { state: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

async function geminiChatWitnessFailureFacts(
  f: Awaited<ReturnType<typeof fixture>>,
  originalId: string | null,
) {
  const log = readGeminiChatWitnessLog(f.log);
  const [originalRead, identityRead] = await Promise.all([
    originalId === null
      ? Promise.resolve<ProtectedDiagnosticRead>({ state: "not-found" })
      : boundedProtectedRead(
          f,
          `/projects/${FIXTURE_PROJECT_ID}/sessions/${encodeURIComponent(originalId)}`,
          256 * 1024,
        ),
    boundedProtectedRead(
      f,
      `/projects/${FIXTURE_PROJECT_ID}/session-start-identities`,
      256 * 1024,
    ),
  ]);

  let original: {
    read: ProtectedDiagnosticRead["state"];
    phase: string;
    reason: "none" | "present" | "no-turn" | "invalid";
  } = { read: originalRead.state, phase: "unavailable", reason: "no-turn" };
  let runtime: RuntimeProjection = {
    processRecord: "not-in-page",
    outcome: "not-in-page",
    phase: "not-observed",
    exitCode: null,
    stopped: null,
    timedOut: null,
    nativeError: "not-observed" as const,
    nativeResult: "not-observed" as const,
  };
  if (originalRead.state === "ok") {
    const parsed = ownedCodingPageSchema.safeParse(originalRead.data);
    if (!parsed.success)
      original = { read: "invalid", phase: "unknown", reason: "invalid" };
    else {
      const projection = projectGeminiChatFailureFacts(
        parsed.data,
        f.request.requestId,
      );
      runtime = projection.runtime;
      original = {
        read: "ok",
        ...projection.original,
      };
    }
  }

  let identity: {
    read: ProtectedDiagnosticRead["state"];
    scope: "matching" | "mismatch" | "unavailable";
    state: string;
  } = {
    read: identityRead.state,
    scope: "unavailable",
    state: "unavailable",
  };
  if (identityRead.state === "ok") {
    const parsed = sessionStartIdentityPageSchema.safeParse(identityRead.data);
    if (!parsed.success) {
      identity = { read: "invalid", scope: "unavailable", state: "invalid" };
    } else {
      const scopeMatches =
        parsed.data.scope.projectId === FIXTURE_PROJECT_ID &&
        parsed.data.scope.workspace === f.h.workspace;
      const row = parsed.data.identities.find(
        (item) =>
          item.requestId === f.request.requestId &&
          item.provider === "gemini" &&
          item.mode === "chat",
      );
      identity = {
        read: "ok",
        scope: scopeMatches ? "matching" : "mismatch",
        state: scopeMatches ? (row?.state ?? "missing") : "scope-mismatch",
      };
    }
  }
  return {
    log,
    runtimeCall: f.runtimeRunState(),
    runtime,
    identity,
    original,
  };
}

test("protected audited Gemini Chat preview/Start/permission/export retains native scope and no private ledger bodies", async () => {
  const f = await fixture("permission");
  expect((await f.post("/preview", f.request, null)).status).toBe(403);
  expect((await f.post("", f.request, null)).status).toBe(403);
  expect(f.records()).toEqual([]);
  const preview = geminiChatPreviewReceiptSchema.parse(
    await data(await f.post("/preview", f.request)),
  );
  expect(preview.snapshot.launch.mode).toBe("chat");
  expect(preview.serialized.argv).toEqual(["--acp"]);
  expect(preview.serialized.stdin).toContain("PRIVATE-ACP-CONTEXT");
  expect(preview.serialized.equivalentCommand).not.toContain("PRIVATE-ACP");
  expect(f.records().map((row) => row.kind)).toEqual(["version", "help"]);
  expect(existsSync(sessionRegistryFile(f.h.home))).toBe(false);
  const changed = structuredClone(preview);
  changed.serialized.argv.push("--yolo");
  expect(geminiChatPreviewReceiptSchema.safeParse(changed).success).toBe(false);
  const startedResponse = await f.post("", f.request);
  expect(startedResponse.status).toBe(202);
  const started = ownedCodingStartReceiptSchema.parse(
      await data(startedResponse),
    ),
    id = started.session.id;
  await expectStartIdentityState(
    f.h.home,
    FIXTURE_PROJECT_ID,
    f.h.workspace,
    f.request,
    "admitted",
  );
  const page = await until(
    async () =>
      geminiChatApprovalPageSchema.parse(
        await data(await f.get(`/${id}/approvals`)),
      ),
    (value) => value.pending.length > 0,
  );
  const approval = page.pending[0];
  if (!approval) throw Error("Missing native offer");
  const decision = {
    requestId: randomUUID(),
    turnRequestId: f.request.requestId,
    approvalId: approval.approval.id,
    optionId: "deny",
  };
  expect(
    (await f.post(`/${id}/approval-decisions`, decision, null)).status,
  ).toBe(403);
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        ...decision,
        optionId: "always",
      })
    ).status,
  ).toBe(409);
  expect((await f.post(`/${id}/approval-decisions`, decision)).status).toBe(
    200,
  );
  const ended = await until(
    async () => ownedCodingPageSchema.parse(await data(await f.get(`/${id}`))),
    (value) => value.turns[0]?.phase === "completed",
  );
  expect(
    ended.frames.some(
      ({ event }) => event.kind === "coding-gemini-chat-decision",
    ),
  ).toBe(true);
  const exported = sessionTranscriptExportSchema.parse(
    await data(await f.get(`/${id}/export`)),
  );
  expect(exported.complete).toBe(true);
  expect(exported.session.mode).toBe("chat");
  expect(f.records().filter((row) => row.kind === "start")).toHaveLength(1);
  expect(JSON.stringify(f.h.events())).not.toContain("PRIVATE-ACP");
  expect(JSON.stringify(f.h.events())).not.toContain("Synthetic command");
});

test("current foreign repository/bead/archive scope refuses before native probes or original reservation", async () => {
  const f = await fixture();
  for (const change of [
    { repository: join(f.h.root, "foreign") },
    { worktree: join(f.h.root, "foreign") },
    { beadId: "foreign-1" },
  ])
    expect((await f.post("", { ...f.request, ...change })).status).toBe(409);
  const project = f.catalog.projects[0];
  if (!project) throw Error("Missing planted scope");
  project.archived = true;
  writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(f.catalog));
  expect((await f.post("/preview", f.request)).status).toBe(409);
  expect((await f.post("", f.request)).status).toBe(409);
  expect(f.records()).toEqual([]);
  expect(existsSync(sessionRegistryFile(f.h.home))).toBe(false);
});

test("lost accepted Start answer reconciles the same original without another provider or input", async () => {
  const f = await fixture("normal", "start"),
    abort = new AbortController();
  const missing = f
    .post("", f.request, f.h.hearth.token, abort.signal)
    .catch(() => null);
  await until(async () => f.held(), Boolean);
  abort.abort();
  await missing;
  await expectStartIdentityState(
    f.h.home,
    FIXTURE_PROJECT_ID,
    f.h.workspace,
    f.request,
    "admitted",
  );
  const list = await data(await f.get(""));
  expect(Array.isArray(list)).toBe(true);
  if (!Array.isArray(list) || !list[0])
    throw Error("No protected original receipt metadata");
  const original = ownedCodingSessionSchema.parse(list[0]);
  let beforeRetry: Record<string, unknown>[];
  try {
    beforeRetry = await until(
      async () => f.records(),
      (rows) =>
        rows.filter((row) => row.kind === "start").length === 1 &&
        rows.filter(
          (row) =>
            row.kind === "wire" &&
            JSON.stringify(row).includes('"method":"session/prompt"') &&
            JSON.stringify(row).includes("PRIVATE-ACP-PROMPT"),
        ).length === 1,
    );
  } catch (error) {
    await emitGeminiChatWitnessFailureFactsAndRethrow(
      error,
      async () => geminiChatWitnessFailureFacts(f, original.id),
      (line) => process.stderr.write(line),
    );
    throw error;
  }
  const records = JSON.stringify(beforeRetry);
  f.release();
  const retry = await f.post("", f.request);
  expect(retry.status).toBe(202);
  const accepted = ownedCodingStartReceiptSchema.parse(await data(retry));
  expect(accepted.session.id).toBe(original.id);
  expect(JSON.stringify(f.records())).toBe(records);
  await expectStartIdentityState(
    f.h.home,
    FIXTURE_PROJECT_ID,
    f.h.workspace,
    f.request,
    "admitted",
  );
  await until(
    async () =>
      ownedCodingPageSchema.parse(
        await data(await f.get(`/${accepted.session.id}`)),
      ),
    (value) => value.turns[0]?.phase === "completed",
  );
  expect(
    (
      await f.post("", {
        ...f.request,
        launch: { ...f.request.launch, prompt: "changed" },
      })
    ).status,
  ).toBe(409);
  expect(f.records().filter((row) => row.kind === "start")).toHaveLength(1);
  expect(records).not.toContain("changed");
});

test("lost decision answer reconciles recorded intent only after native completion and current scope changes", async () => {
  const f = await fixture("permission", "decision");
  const started = ownedCodingStartReceiptSchema.parse(
      await data(await f.post("", f.request)),
    ),
    id = started.session.id;
  const offers = await until(
    async () =>
      geminiChatApprovalPageSchema.parse(
        await data(await f.get(`/${id}/approvals`)),
      ),
    (value) => value.pending.length > 0,
  );
  const offered = offers.pending[0];
  if (!offered) throw Error("No actual offer");
  const decision = {
    requestId: randomUUID(),
    turnRequestId: f.request.requestId,
    approvalId: offered.approval.id,
    optionId: "once",
  };
  const abort = new AbortController(),
    missing = f
      .post(
        `/${id}/approval-decisions`,
        decision,
        f.h.hearth.token,
        abort.signal,
      )
      .catch(() => null);
  await until(async () => f.held(), Boolean);
  abort.abort();
  await missing;
  await until(
    async () => ownedCodingPageSchema.parse(await data(await f.get(`/${id}`))),
    (value) => value.turns[0]?.phase === "completed",
  );
  const project = f.catalog.projects[0];
  if (!project) throw Error("Missing planted project");
  project.archived = true;
  writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(f.catalog));
  const receipt = geminiChatApprovalPageSchema.parse(
    await data(await f.get(`/${id}/approvals?requestId=${decision.requestId}`)),
  );
  expect(receipt.pending).toEqual([]);
  expect(receipt.receipt).toMatchObject({ ...decision, state: "recorded" });
  f.release();
  expect((await f.post(`/${id}/approval-decisions`, decision)).status).toBe(
    200,
  );
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        ...decision,
        requestId: randomUUID(),
      })
    ).status,
  ).toBe(409);
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
});

test("native terminal resolution withdraws an old opaque offer even before generic turn completion", async () => {
  const f = await fixture("permission-controlled", null, true);
  const started = ownedCodingStartReceiptSchema.parse(
      await data(await f.post("", f.request)),
    ),
    id = started.session.id;
  const offers = await until(
    async () =>
      geminiChatApprovalPageSchema.parse(
        await data(await f.get(`/${id}/approvals`)),
      ),
    (value) => value.pending.length > 0,
  );
  const offered = offers.pending[0];
  if (!offered) throw Error("No native controlled offer");
  writeFileSync(`${f.log}.settle`, "settle");
  const privateEnded = await until(
    async () => ownedCodingPageSchema.parse(await data(await f.get(`/${id}`))),
    (value) =>
      value.frames.some(
        ({ event }) =>
          event.kind === "coding-gemini-chat" && event.event.kind === "outcome",
      ),
  );
  expect(privateEnded.turns[0]?.phase).toBe("running");
  await until(
    async () =>
      geminiChatApprovalPageSchema.parse(
        await data(await f.get(`/${id}/approvals`)),
      ),
    (value) => value.pending.length === 0,
  );
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        requestId: randomUUID(),
        turnRequestId: f.request.requestId,
        approvalId: offered.approval.id,
        optionId: "once",
      })
    ).status,
  ).toBe(409);
  expect(
    f
      .records()
      .some(
        (row) =>
          row.kind === "wire" &&
          JSON.stringify(row).includes('"id":41') &&
          JSON.stringify(row).includes('"result"'),
      ),
  ).toBe(false);
  f.releaseRuntime();
});
