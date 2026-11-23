import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type {
  ConversationPage,
  ConversationReceipt,
} from "../../../types/conversation";
import type { OwnedSessionRecord } from "../../../types/owned-session";
import type { SessionStartReceipt } from "../../../types/session-requests";
import { createConversationStore } from "../../conversations/store";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import {
  launchWindowsConsole,
  type NativeConsoleLaunchOptions,
} from "../../providers/native-console";
import type { SessionRuntime } from "../../sessions/admission";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../../sessions/registry";
import { expectStartIdentityState } from "../../sessions/session-start-identity-test-witness";
import { scratchDirs } from "../../test-scratch";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import {
  FIXTURE_SESSION_PROMPT,
  FIXTURE_SESSION_REPLY,
  fakeSessionRuntime,
  fixtureSessionFlags,
  fixtureSessionGit,
  sessionStartFixture,
  waitOwnedTurn,
} from "./session-fixture";

const opened: TestHearth[] = [];
const terminalBinaries = scratchDirs();
let terminalFixtureExecutable: string | undefined;

beforeAll(async () => {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.env["AGENT_FORGE_RUN_VISIBLE_TERMINAL_FIXTURE"] !== "1"
  )
    return;
  const directory = terminalBinaries.make("claude-terminal-stand-in-"),
    executable = join(directory, "claude-terminal.exe"),
    source = join(
      import.meta.dir,
      "../../providers/fixtures/claude-terminal-stand-in.ts",
    ),
    build = Bun.spawn(
      [process.execPath, "build", "--compile", source, "--outfile", executable],
      { stdout: "ignore", stderr: "pipe", windowsHide: true },
    ),
    timer = setTimeout(() => build.kill(), 60_000);
  try {
    const stderr = await new Response(build.stderr).text();
    if ((await build.exited) !== 0)
      throw Error(
        `The inert terminal fixture did not compile: ${stderr.slice(-2000)}`,
      );
    terminalFixtureExecutable = executable;
  } finally {
    clearTimeout(timer);
  }
}, 65_000);
afterAll(() => terminalBinaries.cleanup());

test("a same-project session from another workspace stays private and cannot be sent to or stopped through this hearth", async () => {
  const fake = fakeSessionRuntime(),
    h = await startTestHearth({
      api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
    });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const request = sessionStartFixture(h, randomUUID()),
    path = `/projects/${FIXTURE_PROJECT_ID}/sessions`;
  const started = await fetch(`${h.api}${path}`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify(request),
  });
  expect(started.status).toBe(202);
  const current: { data: SessionStartReceipt } = await started.json();
  await waitOwnedTurn(h, current.data.session, request.requestId);
  const foreign: OwnedSessionRecord = {
    ...current.data.session,
    id: `session-${randomUUID()}`,
    requestId: randomUUID(),
    requestHash: "f".repeat(64),
    workspace: `${h.workspace}-foreign`,
    repository: `${h.workspace}-foreign`,
    worktree: `${h.workspace}-foreign`,
  };
  writeOwnerOnly(
    sessionRegistryFile(h.home),
    JSON.stringify({
      version: 1,
      records: [
        ...createSessionRegistry(h.home).list(FIXTURE_PROJECT_ID),
        foreign,
      ],
    }),
  );
  const foreignStore = createConversationStore(h.home, undefined, {
    kind: "session",
    projectId: FIXTURE_PROJECT_ID,
    sessionId: foreign.id,
  });
  await foreignStore.accept(FIXTURE_PROJECT_ID, {
    requestId: foreign.requestId,
    expectedRevision: 0,
    text: "Private foreign workspace sentinel",
    about: [],
  });
  const before = foreignStore.read(FIXTURE_PROJECT_ID);
  const listed = await (
    await fetch(`${h.api}${path}`, { headers: h.headers(h.hearth.token) })
  ).text();
  expect(listed).toContain(current.data.session.id);
  expect(listed).not.toContain(foreign.id);
  for (const suffix of ["", "/events"]) {
    const response = await fetch(`${h.api}${path}/${foreign.id}${suffix}`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).not.toContain(
      "Private foreign workspace sentinel",
    );
  }
  for (const [suffix, body] of [
    [
      "turns",
      {
        requestId: randomUUID(),
        expectedRevision: 1,
        text: "Do not dispatch",
        about: [],
      },
    ],
    ["stop", { requestId: foreign.requestId }],
  ] as const) {
    expect(
      (
        await fetch(`${h.api}${path}/${foreign.id}/${suffix}`, {
          method: "POST",
          headers: h.headers(h.hearth.token),
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(409);
  }
  expect(foreignStore.read(FIXTURE_PROJECT_ID)).toEqual(before);
  expect(fake.runs).toHaveLength(1);
});
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

test.skipIf(
  process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.env["AGENT_FORGE_RUN_VISIBLE_TERMINAL_FIXTURE"] !== "1",
)(
  "a reviewed Claude terminal opens visibly, resumes the exact identity and settles on hearth close",
  async () => {
    const nativeSessionId = randomUUID(),
      launches: NativeConsoleLaunchOptions[] = [];
    let child: ReturnType<typeof launchWindowsConsole> | undefined;
    let providerTurns = 0;
    const runtime: SessionRuntime = {
      provider: "claude",
      async prepare(input) {
        return {
          version: 1,
          provider: "claude",
          smith: input.smith,
          cwd: input.cwd,
          launch: structuredClone(input.launch),
          capabilities: {
            version: "2.1.296",
            flags: [...fixtureSessionFlags, "--permission-mode"],
          },
        };
      },
      async run(_request, persist) {
        providerTurns++;
        await persist({
          kind: "identity",
          provider: "claude",
          sessionId: nativeSessionId,
          version: "2.1.296",
        });
        await persist({ kind: "text", text: FIXTURE_SESSION_REPLY });
        return { phase: "completed", reason: null };
      },
    };
    const h = await startTestHearth({
      api: {
        sessionRuntime: runtime,
        git: fixtureSessionGit,
        sessionTerminalEnvironment: {
          SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
          TEMP: process.env["TEMP"],
          TMP: process.env["TMP"],
        },
        providerInspector: {
          async inspect(provider) {
            return {
              provider,
              name: "Claude fixture",
              installation: {
                found: true,
                versionOk: true,
                version: "2.1.296",
                path: terminalFixtureExecutable ?? null,
                checkedAt: new Date().toISOString(),
                compatibility: "supported",
                reason: null,
              },
              authentication: {
                mode: "unknown",
                source: "unavailable",
                observedAt: null,
                reason: null,
              },
              adapter: { supported: true, reason: null },
              signIn: { command: null, reason: null, nativeAvailable: true },
            };
          },
        },
        sessionTerminalLauncher(options) {
          launches.push(options);
          child = launchWindowsConsole({
            ...options,
            env: {
              ...options.env,
              CLAUDE_TERMINAL_FIXTURE_RECORD: join(
                options.cwd,
                "terminal-record.json",
              ),
              CLAUDE_TERMINAL_FIXTURE_HOLD: "1",
            },
          });
          return child;
        },
      },
    });
    opened.push(h);
    writeOwnerOnly(
      projectCatalogPath(h.home),
      JSON.stringify(projectCatalogFixture(h.workspace)),
    );
    const base = `/projects/${FIXTURE_PROJECT_ID}/sessions`,
      startRequest = sessionStartFixture(h, randomUUID()),
      started = await fetch(`${h.api}${base}`, {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: JSON.stringify(startRequest),
      });
    expect(started.status).toBe(202);
    const startedBody: { data: SessionStartReceipt } = await started.json();
    await waitOwnedTurn(h, startedBody.data.session, startRequest.requestId);
    const terminalPath = `${base}/${startedBody.data.session.id}/terminal-handoff`,
      requestId = randomUUID(),
      open = () =>
        fetch(`${h.api}${terminalPath}`, {
          method: "POST",
          headers: h.headers(h.hearth.token),
          body: JSON.stringify({ requestId }),
        });
    const openResponse = await open();
    expect(openResponse.status).toBe(200);
    const openReceipt: { data: { phase: string; requestId: string } } =
      await openResponse.json();
    expect(openReceipt.data).toMatchObject({ requestId, phase: "opened" });
    expect(launches).toHaveLength(1);
    const launch = launches[0];
    if (!launch) throw new Error("The reviewed terminal was not launched.");
    expect(launch.command[0]).toBe(terminalFixtureExecutable);
    expect(launch.command).toContain(nativeSessionId);
    expect(launch.command).not.toContain(FIXTURE_SESSION_PROMPT);
    expect(launch.lifetime).toEqual({ kind: "managed" });
    expect(Object.hasOwn(launch, "stdin")).toBe(false);
    expect(providerTurns).toBe(1);
    expect((await open()).status).toBe(200);
    const status: { data: { attempt: { phase: string; requestId: string } } } =
      await (
        await fetch(`${h.api}${terminalPath}`, {
          headers: h.headers(h.hearth.token),
        })
      ).json();
    expect(status.data.attempt.requestId).toBe(requestId);
    expect(["opened", "closed"]).toContain(status.data.attempt.phase);
    expect(launches).toHaveLength(1);
    const pageResponse = await fetch(
      `${h.api}${base}/${startedBody.data.session.id}`,
      {
        headers: h.headers(h.hearth.token),
      },
    );
    const page: ConversationPage = (await pageResponse.json()).data;
    const send = await fetch(
      `${h.api}${base}/${startedBody.data.session.id}/turns`,
      {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: JSON.stringify({
          requestId: randomUUID(),
          expectedRevision: page.revision,
          text: "This app send must stay held while the terminal is open.",
          about: [],
        }),
      },
    );
    expect(send.status).toBe(409);
    expect(launches).toHaveLength(1);
    expect(providerTurns).toBe(1);
    const recordPath = join(h.root, "terminal-record.json"),
      deadline = Date.now() + 5000;
    while (!existsSync(recordPath) && Date.now() < deadline)
      await Bun.sleep(10);
    expect(existsSync(recordPath)).toBe(true);
    let nativeRecord: unknown;
    try {
      nativeRecord = JSON.parse(readFileSync(recordPath, "utf8"));
    } catch {
      throw new Error(
        "The inert native Claude-resume fixture record is invalid.",
      );
    }
    if (
      !nativeRecord ||
      typeof nativeRecord !== "object" ||
      !("args" in nativeRecord) ||
      !Array.isArray(nativeRecord.args) ||
      !("cwd" in nativeRecord) ||
      typeof nativeRecord.cwd !== "string"
    )
      throw new Error(
        "The inert native Claude-resume fixture record is incomplete.",
      );
    expect(nativeRecord.args).toEqual(launch.command.slice(1));
    expect(nativeRecord.args).toContain(nativeSessionId);
    expect(nativeRecord.args).not.toContain(FIXTURE_SESSION_PROMPT);
    expect(realpathSync.native(nativeRecord.cwd).toLowerCase()).toBe(
      realpathSync.native(h.workspace).toLowerCase(),
    );
    expect(nativeRecord).toMatchObject({ hasConsole: true });
    expect(child).toBeDefined();
    expect(child && process.kill(child.pid, 0)).toBe(true);
    try {
      await h.hearth.close();
      expect(await child?.done).toMatchObject({
        stopped: true,
        timedOut: false,
      });
      const handoffDir = join(
        h.home,
        "session-terminal-handoffs",
        readdirSync(join(h.home, "session-terminal-handoffs"))[0] ?? "",
      );
      const journal: { attempts: Array<{ requestId: string; phase: string }> } =
        JSON.parse(readFileSync(join(handoffDir, "attempts.json"), "utf8"));
      expect(journal.attempts.at(-1)).toMatchObject({
        requestId,
        phase: "closed",
      });
    } finally {
      const index = opened.indexOf(h);
      if (index >= 0) opened.splice(index, 1);
      await h.close();
    }
  },
);

test("owned session routes require operator authority, preserve exact Start retries and keep private bodies out of list/activity", async () => {
  const fake = fakeSessionRuntime();
  let activeStartInput: unknown;
  const h = await startTestHearth({
    api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
  });
  opened.push(h);
  const originalPrepare = fake.runtime.prepare;
  fake.runtime.prepare = async (input) => {
    if (activeStartInput !== undefined)
      await expectStartIdentityState(
        h.home,
        FIXTURE_PROJECT_ID,
        h.workspace,
        activeStartInput,
        "attempted",
      );
    return originalPrepare(input);
  };
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const path = `/projects/${FIXTURE_PROJECT_ID}/sessions`;
  const request = sessionStartFixture(h);
  activeStartInput = request;
  const post = (
    suffix: string,
    body: unknown,
    token: string | null = h.hearth.token,
  ) =>
    fetch(`${h.api}${path}${suffix}`, {
      method: "POST",
      headers: h.headers(token),
      body: JSON.stringify(body),
    });
  expect((await fetch(`${h.api}${path}`)).status).toBe(403);
  expect((await post("", request, null)).status).toBe(403);
  expect(fake.runs).toHaveLength(0);
  const response = await post("", request);
  if (response.status !== 202)
    throw new Error(
      `Start fixture refused: ${response.status} ${await response.text()}`,
    );
  const body: { data: SessionStartReceipt } = await response.json();
  await expectStartIdentityState(
    h.home,
    FIXTURE_PROJECT_ID,
    h.workspace,
    request,
    "admitted",
  );
  await waitOwnedTurn(h, body.data.session, request.requestId);
  expect(fake.runs).toHaveLength(1);
  const retry = await post("", request);
  expect(retry.status).toBe(202);
  const original: { data: SessionStartReceipt } = await retry.json();
  expect(original.data.session.id).toBe(body.data.session.id);
  expect(fake.runs).toHaveLength(1);
  await expectStartIdentityState(
    h.home,
    FIXTURE_PROJECT_ID,
    h.workspace,
    request,
    "admitted",
  );
  expect(
    (
      await post("", {
        ...request,
        launch: { ...request.launch, prompt: "Changed" },
      })
    ).status,
  ).toBe(409);
  const list = await fetch(`${h.api}${path}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(list.status).toBe(200);
  const listed = await list.text();
  expect(listed).toContain(body.data.session.id);
  expect(listed).not.toContain(request.launch.prompt);
  expect(listed).not.toContain(FIXTURE_SESSION_REPLY);
  const page = await fetch(`${h.api}${path}/${body.data.session.id}`, {
    headers: h.headers(h.hearth.token),
  });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(FIXTURE_SESSION_REPLY);
  fake.runtime.check = async () => {
    throw new Error("Provider temporarily unavailable");
  };
  fake.runtime.prepare = async () => {
    throw new Error("Provider temporarily unavailable");
  };
  expect(
    (await fetch(`${h.api}${path}`, { headers: h.headers(h.hearth.token) }))
      .status,
  ).toBe(200);
  expect(
    (
      await fetch(`${h.api}${path}/${body.data.session.id}`, {
        headers: h.headers(h.hearth.token),
      })
    ).status,
  ).toBe(200);
  expect(fake.runs).toHaveLength(1);
  const events = JSON.stringify(h.events());
  expect(events).not.toContain(request.launch.prompt);
  expect(events).not.toContain(FIXTURE_SESSION_REPLY);
  const foreign = `project-${randomUUID()}`;
  expect(
    (
      await fetch(
        `${h.api}/projects/${foreign}/sessions/${body.data.session.id}`,
        { headers: h.headers(h.hearth.token) },
      )
    ).status,
  ).toBe(404);
});

test("strict session queries and forbidden prepared launch fields refuse before admission", async () => {
  const fake = fakeSessionRuntime(),
    h = await startTestHearth({
      api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
    });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const path = `/projects/${FIXTURE_PROJECT_ID}/sessions`,
    request = sessionStartFixture(h);
  const post = (suffix: string, body: unknown) =>
    fetch(`${h.api}${path}${suffix}`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(body),
    });
  for (const body of [
    {
      ...request,
      launch: { ...request.launch, resumeSessionId: randomUUID() },
    },
    {
      ...request,
      launch: { ...request.launch, context: { projectId: FIXTURE_PROJECT_ID } },
    },
    { ...request, snapshot: { argv: ["--print"] } },
    {
      ...request,
      launch: { ...request.launch, permissionMode: "bypassPermissions" },
    },
  ])
    expect((await post("", body)).status).toBe(400);
  expect((await post("?extra=1", request)).status).toBe(400);
  const id = `session-${randomUUID()}`;
  for (const query of [
    "?after=-1",
    "?after=1&after=2",
    "?limit=101",
    "?requestId=latest",
    "?extra=1",
  ])
    expect(
      (
        await fetch(`${h.api}${path}/${id}${query}`, {
          headers: h.headers(h.hearth.token),
        })
      ).status,
    ).toBe(400);
  expect(
    (
      await post(`/${id}/turns`, {
        requestId: randomUUID(),
        expectedRevision: 0,
        text: "Question",
        about: [],
        session: { argv: ["--print"] },
      })
    ).status,
  ).toBe(400);
  expect(
    (await post(`/${id}/stop?extra=1`, { requestId: randomUUID() })).status,
  ).toBe(400);
  expect(fake.prepared).toHaveLength(0);
  expect(fake.runs).toHaveLength(0);
  expect(h.events()).toEqual([]);
});

test("private session replay refuses foreign observers and closing an observer does not Stop its owned process", async () => {
  const fake = fakeSessionRuntime(),
    h = await startTestHearth({
      api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
    });
  opened.push(h);
  const catalog = projectCatalogFixture(h.workspace),
    foreign = `project-${randomUUID()}`;
  catalog.projects.push({ ...catalog.projects[0]!, id: foreign, slug: "beta" });
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
  const path = `/projects/${FIXTURE_PROJECT_ID}/sessions`,
    request = sessionStartFixture(h, randomUUID());
  request.launch.prompt = "Wait for Stop";
  const start = await fetch(`${h.api}${path}`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify(request),
  });
  expect(start.status).toBe(202);
  const body: { data: SessionStartReceipt } = await start.json();
  await waitOwnedTurn(h, body.data.session, request.requestId, ["running"]);
  const detail = `${path}/${body.data.session.id}`;
  expect((await fetch(`${h.api}${detail}/events`)).status).toBe(403);
  for (const suffix of ["", "/events"]) {
    const response = await fetch(
      `${h.api}/projects/${foreign}/sessions/${body.data.session.id}${suffix}`,
      { headers: h.headers(h.hearth.token) },
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).not.toContain(FIXTURE_SESSION_REPLY);
  }
  expect(
    (
      await fetch(`${h.api}${detail}/events`, {
        headers: { ...h.headers(h.hearth.token), "Last-Event-ID": "999999" },
      })
    ).status,
  ).toBe(409);
  const controller = new AbortController();
  const response = await fetch(`${h.api}${detail}/events`, {
    headers: h.headers(h.hearth.token),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes(FIXTURE_SESSION_REPLY)) {
      const chunk = await reader.read();
      if (chunk.done)
        throw Error("Owned replay ended before its private response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain(body.data.session.id);
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  const active: { data: ConversationPage } = await (
    await fetch(`${h.api}${detail}`, { headers: h.headers(h.hearth.token) })
  ).json();
  expect(active.data.controllable).toBe(true);
  expect(active.data.turns[0]?.phase).toBe("running");
  const stop = await fetch(`${h.api}${detail}/stop`, {
    method: "POST",
    headers: h.headers(h.hearth.token),
    body: JSON.stringify({ requestId: request.requestId }),
  });
  expect(stop.status).toBe(200);
  const stopped: { data: ConversationReceipt } = await stop.json();
  expect(["cancelling", "cancelled"]).toContain(stopped.data.turn.phase);
  expect(
    (await waitOwnedTurn(h, body.data.session, request.requestId)).phase,
  ).toBe("cancelled");
  expect(fake.runs).toHaveLength(1);
});
