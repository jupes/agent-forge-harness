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
import { sessionTranscriptExportSchema } from "../../sessions/library-protocol";
import { sessionRegistryFile } from "../../sessions/registry";
import { scratchDirs } from "../../test-scratch";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
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
        prepare(input) {
          const action = h.events(["operator.action"]).at(-1);
          expect(
            action?.kind === "operator.action" &&
              [
                "session.preview",
                "session.start",
                "session.turn.send",
              ].includes(action.payload.action),
          ).toBe(true);
          return selected().prepare(input);
        },
        async run(...args) {
          const result = await selected().run(...args);
          if (holdRuntimeResult) await runtimeGate;
          return result;
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
  ) =>
    fetch(`${h.api}${path}${suffix}`, {
      method: "POST",
      headers: h.headers(token),
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
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
  const list = await data(await f.get(""));
  expect(Array.isArray(list)).toBe(true);
  if (!Array.isArray(list) || !list[0])
    throw Error("No protected original receipt metadata");
  const original = ownedCodingSessionSchema.parse(list[0]);
  const records = JSON.stringify(f.records());
  f.release();
  const retry = await f.post("", f.request);
  expect(retry.status).toBe(202);
  const accepted = ownedCodingStartReceiptSchema.parse(await data(retry));
  expect(accepted.session.id).toBe(original.id);
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
