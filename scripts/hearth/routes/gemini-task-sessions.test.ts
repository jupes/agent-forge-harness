import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationPage } from "../../../types/conversation";
import type { GeminiTaskStartRequest } from "../../../types/gemini-owned-task";
import { liveChildCount } from "../../executors/supervisor";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { ownedCodingPageSchema } from "../../sessions/codex-owned-journal";
import { createGeminiOwnedTaskService } from "../../sessions/gemini-owned-admission";
import { createGeminiTaskRuntime } from "../../sessions/gemini-task-runtime";
import { sessionRegistryFile } from "../../sessions/registry";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { fixtureSessionGit } from "./session-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0).reverse()) await h.close();
});
async function fixture(mode = "normal") {
  let actual: ReturnType<typeof createGeminiTaskRuntime> | undefined;
  const selected = () => {
    if (!actual) throw Error("No planted native Gemini Task runtime");
    return actual;
  };
  const h = await startTestHearth({
    files: {
      "agent-forge.toml":
        '[execution.env]\npass = ["GEMINI_RUNTIME_LOG"]\n[smiths.gemini-example]\nprovider = "gemini"\nmodel = "exact-model"\neffort = "default"\nenabled = true\n',
    },
    api: {
      git: fixtureSessionGit,
      geminiTaskRuntime: {
        check: (input) => selected().check(input),
        prepare: (input) => {
          const action = h.events(["operator.action"]).at(-1);
          expect(["session.preview", "session.start"]).toContain(
            action?.kind === "operator.action"
              ? action.payload.action
              : "missing audit",
          );
          return selected().prepare(input);
        },
        run: (...args) => selected().run(...args),
      },
    },
  });
  opened.push(h);
  const command = join(
      h.root,
      process.platform === "win32" ? "inert-gemini.exe" : "inert-gemini",
    ),
    log = join(h.root, "native.jsonl");
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(
        import.meta.dir,
        "../../sessions/fixtures/gemini-task-runtime-compiled.ts",
      ),
      "--compile",
      "--outfile",
      command,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  if (built.exitCode !== 0)
    throw Error("Inert Gemini fixture compilation failed");
  actual = createGeminiTaskRuntime({
    root: h.root,
    home: h.home,
    configHome: h.configHome,
    command: [command],
    environment: { ...process.env, GEMINI_RUNTIME_LOG: log },
    timeoutMs: 5000,
  });
  writeFileSync(`${log}.control`, JSON.stringify({ mode }));
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const request: GeminiTaskStartRequest = {
    provider: "gemini",
    requestId: randomUUID(),
    smith: "gemini-example",
    repository: h.workspace,
    worktree: h.workspace,
    launch: {
      route: "gemini-cli",
      mode: "task",
      prompt: "PRIVATE-GEMINI-TASK-PROMPT",
      attachments: [
        { kind: "text", name: "note", text: "PRIVATE-GEMINI-INLINE-CONTEXT" },
      ],
    },
  };
  const post = (input: unknown, authenticated = true) =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/preview`, {
      method: "POST",
      headers: h.headers(authenticated ? h.hearth.token : undefined),
      body: JSON.stringify(input),
    });
  const records = (): Record<string, unknown>[] => {
    if (!existsSync(log)) return [];
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw Error("Invalid inert Gemini recording");
    }
  };
  const start = (input: unknown) =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(input),
    });
  return { h, request, post, start, records };
}

test("owned Gemini Task admits once, retains exact native private history, and exports the complete original", async () => {
  const f = await fixture();
  const started = await f.start(f.request);
  expect(started.status).toBe(202);
  const accepted = await started.json();
  expect(accepted).toMatchObject({
    ok: true,
    data: {
      session: {
        provider: "gemini",
        route: "gemini-cli",
        mode: "task",
        requestedModel: null,
        requestedEffort: null,
      },
    },
  });
  const sessionId: string = accepted.data.session.id;
  const url = `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${sessionId}`;
  let page: ConversationPage;
  const deadline = Date.now() + 10_000;
  do {
    const response = await fetch(url, {
      headers: f.h.headers(f.h.hearth.token),
    });
    expect(response.status).toBe(200);
    page = ownedCodingPageSchema.parse((await response.json()).data);
    if (!["accepted", "running"].includes(page.turns[0]?.phase ?? "")) break;
    if (Date.now() > deadline)
      throw Error("The admitted inert Gemini Task did not settle");
    await Bun.sleep(20);
  } while (["accepted", "running"].includes(page.turns[0]?.phase ?? ""));
  expect(page.turns[0]?.phase).toBe("completed");
  expect(page.binding).toMatchObject({ provider: "gemini", version: "0.65.0" });
  expect(page.frames[0]?.event).toMatchObject({
    kind: "user",
    text: f.request.launch.prompt,
    geminiTask: {
      provider: "gemini",
      launch: { attachments: f.request.launch.attachments },
    },
  });
  expect(page.frames).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "coding-gemini-task",
          event: expect.objectContaining({ kind: "usage" }),
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          kind: "coding-gemini-task",
          event: expect.objectContaining({
            kind: "outcome",
            outcome: expect.objectContaining({ phase: "completed" }),
          }),
        }),
      }),
    ]),
  );
  const originalRecords = JSON.stringify(f.records());
  expect((await f.start(f.request)).status).toBe(202);
  expect(JSON.stringify(f.records())).toBe(originalRecords);
  const recreated = createGeminiOwnedTaskService({
    root: f.h.root,
    home: f.h.home,
    runtime: {
      async check() {
        throw Error("An original retry must not recheck native capability");
      },
      async prepare() {
        throw Error("An original retry must not replace private preparation");
      },
      async run() {
        throw Error("An original retry must not repeat native dispatch");
      },
    },
    async validateScope() {
      throw Error(
        "An original retry reconciles saved intent before mutable scope",
      );
    },
  });
  try {
    expect(
      (await recreated.start(FIXTURE_PROJECT_ID, f.request)).receipt.turn.phase,
    ).toBe("completed");
  } finally {
    await recreated.close();
  }
  expect(
    (
      await f.start({
        ...f.request,
        launch: { ...f.request.launch, prompt: "Changed" },
      })
    ).status,
  ).toBe(409);
  const exported = await fetch(`${url}/export`, {
    headers: f.h.headers(f.h.hearth.token),
  });
  expect(exported.status).toBe(200);
  const transcript = await exported.json();
  expect(transcript.data).toMatchObject({
    complete: true,
    session: { provider: "gemini" },
    conversation: { frames: page.frames },
  });
  expect(f.records().filter((row) => row.kind === "task")).toHaveLength(1);
  const archiveRequest = {
    requestId: randomUUID(),
    expectedRevision: 0,
    archived: true,
  };
  const archived = await fetch(`${url}/archive`, {
    method: "POST",
    headers: f.h.headers(f.h.hearth.token),
    body: JSON.stringify(archiveRequest),
  });
  expect(archived.status).toBe(200);
  expect((await archived.json()).data.receipt).toMatchObject({
    outcome: "applied",
    archived: true,
  });
  expect(
    (await fetch(`${url}/export`, { headers: f.h.headers(f.h.hearth.token) }))
      .status,
  ).toBe(200);
  expect(f.records().filter((row) => row.kind === "task")).toHaveLength(1);
  expect(JSON.stringify(f.h.events())).not.toContain("PRIVATE-GEMINI");
}, 20_000);

async function settledPage(h: TestHearth, sessionId: string) {
  const deadline = Date.now() + 10_000;
  let page: ConversationPage;
  do {
    const reply = await fetch(
      `${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${sessionId}`,
      { headers: h.headers(h.hearth.token) },
    );
    expect(reply.status).toBe(200);
    page = ownedCodingPageSchema.parse((await reply.json()).data);
    if (
      !["accepted", "running", "cancelling"].includes(
        page.turns[0]?.phase ?? "",
      )
    )
      return page;
    if (Date.now() > deadline)
      throw Error("The inert owned Gemini Task did not settle");
    await Bun.sleep(20);
  } while (Date.now() <= deadline);
  throw Error("The inert owned Gemini Task deadline expired");
}

test.each([
  "denied",
  "provider-error",
  "malformed",
  "missing-result",
])("owned Gemini Task preserves native %s facts and never resends an uncertain original", async (mode) => {
  const f = await fixture(mode);
  const started = await f.start(f.request);
  expect(started.status).toBe(202);
  const sessionId: string = (await started.json()).data.session.id;
  const page = await settledPage(f.h, sessionId);
  expect(page.turns[0]?.phase).toBe(
    mode === "provider-error"
      ? "failed"
      : mode === "denied"
        ? "completed"
        : "unknown",
  );
  if (mode === "denied")
    expect(page.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            kind: "coding-gemini-task",
            event: expect.objectContaining({
              kind: "tool",
              state: "failed",
              error: expect.objectContaining({ type: "policy_violation" }),
            }),
          }),
        }),
      ]),
    );
  if (mode === "provider-error")
    expect(page.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            kind: "coding-gemini-task",
            event: expect.objectContaining({
              kind: "notice",
              severity: "error",
            }),
          }),
        }),
      ]),
    );
  const native = JSON.stringify(f.records());
  expect((await f.start(f.request)).status).toBe(202);
  expect(JSON.stringify(f.records())).toBe(native);
  expect(JSON.stringify(f.h.events())).not.toContain("Private reply");
}, 20_000);

test("owned Gemini Stop waits for the actual native provider and helper tree before confirming cancellation", async () => {
  const baseline = liveChildCount(),
    f = await fixture("hang-tree");
  const started = await f.start(f.request);
  expect(started.status).toBe(202);
  const sessionId: string = (await started.json()).data.session.id;
  const deadline = Date.now() + 5000;
  while (!f.records().some((row) => row.kind === "task")) {
    if (Date.now() > deadline)
      throw Error("The inert native Gemini tree did not start");
    await Bun.sleep(20);
  }
  const task = f.records().find((row) => row.kind === "task");
  const pid = task?.pid,
    helperPid = task?.childPid;
  expect(typeof pid).toBe("number");
  expect(typeof helperPid).toBe("number");
  if (typeof pid !== "number" || typeof helperPid !== "number")
    throw Error("Missing inert provider identity");
  const stopped = await fetch(
    `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${sessionId}/stop`,
    {
      method: "POST",
      headers: f.h.headers(f.h.hearth.token),
      body: JSON.stringify({ requestId: f.request.requestId }),
    },
  );
  expect(stopped.status).toBe(200);
  const page = await settledPage(f.h, sessionId);
  expect(page.turns[0]?.phase).toBe("cancelled");
  expect(liveChildCount()).toBe(baseline);
  for (const actualPid of [pid, helperPid]) {
    expect(() => process.kill(actualPid, 0)).toThrow();
  }
  const original = JSON.stringify(f.records());
  expect((await f.start(f.request)).status).toBe(202);
  expect(JSON.stringify(f.records())).toBe(original);
}, 20_000);

test("protected Gemini preview audits before actual read-only native probes and reserves no session", async () => {
  const f = await fixture();
  expect((await f.post(f.request, false)).status).toBe(403);
  expect(f.records()).toEqual([]);
  const reply = await f.post(f.request);
  expect(reply.status).toBe(200);
  const envelope = await reply.json();
  expect(envelope).toMatchObject({
    ok: true,
    data: {
      provider: "gemini",
      projectId: FIXTURE_PROJECT_ID,
      requestId: f.request.requestId,
    },
  });
  expect(envelope.data.serialized.stdin).toContain(f.request.launch.prompt);
  expect(envelope.data.serialized.stdin).toContain(
    "PRIVATE-GEMINI-INLINE-CONTEXT",
  );
  expect(envelope.data.serialized.equivalentCommand).not.toContain(
    "PRIVATE-GEMINI",
  );
  expect(f.records().map((row) => row.kind)).toEqual(["version", "help"]);
  expect(existsSync(sessionRegistryFile(f.h.home))).toBe(false);
  expect(JSON.stringify(f.h.events(["operator.action"]))).not.toContain(
    "PRIVATE-GEMINI",
  );
});

test("unsupported public Gemini authority and foreign scope refuse before native preparation", async () => {
  const f = await fixture();
  for (const change of [
    { command: ["gemini"] },
    { cwd: f.h.root },
    { route: "antigravity" },
    { token: "synthetic-private" },
  ])
    expect(
      (
        await f.post({
          ...f.request,
          launch: { ...f.request.launch, ...change },
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await f.post({
        ...f.request,
        repository: join(f.h.root, "foreign"),
        worktree: join(f.h.root, "foreign"),
      })
    ).status,
  ).toBe(409);
  expect(f.records()).toEqual([]);
  expect(existsSync(sessionRegistryFile(f.h.home))).toBe(false);
});
