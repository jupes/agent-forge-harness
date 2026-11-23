import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { serializeClaudeLaunch } from "../../sessions/claude-launch";
import { createClaudeSessionTransport } from "../../sessions/claude-transport";
import { sessionPreviewReceiptSchema } from "../../sessions/protocol";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import {
  fakeSessionRuntime,
  fixtureSessionGit,
  sessionStartFixture,
} from "./session-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});

const path = `/projects/${FIXTURE_PROJECT_ID}/sessions/preview`;
const post = (
  h: TestHearth,
  input: unknown,
  headers = h.headers(h.hearth.token),
) =>
  fetch(`${h.api}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
const plant = (h: TestHearth, archived = false) => {
  const catalog = projectCatalogFixture(h.workspace);
  catalog.projects[0]!.archived = archived;
  writeOwnerOnly(projectCatalogPath(h.home), JSON.stringify(catalog));
};
const untouched = (h: TestHearth) => {
  expect(existsSync(join(h.home, "sessions"))).toBe(false);
  expect(existsSync(join(h.home, "conversations"))).toBe(false);
};

test("audited preview retains exact reviewed input and creates no registry, journal or provider turn", async () => {
  const fake = fakeSessionRuntime();
  let h: TestHearth;
  const prepare = fake.runtime.prepare;
  fake.runtime.prepare = async (input) => {
    expect(h.events(["operator.action"]).at(-1)?.payload).toMatchObject({
      action: "session.preview",
      target: FIXTURE_PROJECT_ID,
    });
    return prepare(input);
  };
  h = await startTestHearth({
    api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const input = {
    ...sessionStartFixture(h, randomUUID()),
    launch: {
      mode: "chat",
      model: "sonnet",
      prompt: "  Exact preview 🌱\n",
      attachments: [
        { kind: "text", name: "context.txt", text: "Private attachment\n" },
      ],
    },
  };
  const response = await fetch(
    `${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/preview`,
    {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify(input),
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(sessionPreviewReceiptSchema.safeParse(body.data).success).toBe(true);
  expect(body.data).toEqual({
    projectId: FIXTURE_PROJECT_ID,
    requestId: input.requestId,
    snapshot: fake.prepared[0],
    serialized: serializeClaudeLaunch(
      fake.prepared[0]!.launch,
      fake.prepared[0]!.capabilities,
    ),
  });
  expect(body.data.snapshot.launch).toEqual({
    ...input.launch,
    context: {
      projectId: FIXTURE_PROJECT_ID,
      repository: h.workspace,
      worktree: h.workspace,
      about: [],
    },
  });
  expect(fake.runs).toHaveLength(0);
  expect(existsSync(join(h.home, "sessions"))).toBe(false);
  expect(existsSync(join(h.home, "conversations"))).toBe(false);
  expect(h.events().map((event) => event.kind)).toEqual(["operator.action"]);
  expect(JSON.stringify(h.events())).not.toContain(input.launch.prompt);
  expect(JSON.stringify(h.events())).not.toContain("Private attachment");
});

test("preview checks no mutable scope or runtime before operator authority and a persisted audit", async () => {
  for (const auditAllowed of [true, false]) {
    const fake = fakeSessionRuntime();
    let scopeReads = 0;
    const h = await startTestHearth({
      api: {
        sessionRuntime: fake.runtime,
        git: (args, cwd) => {
          scopeReads++;
          return fixtureSessionGit(args, cwd);
        },
        ...(!auditAllowed
          ? {
              appendEvent: () => ({
                ok: false,
                error: "Fixture audit unavailable",
              }),
            }
          : {}),
      },
    });
    opened.push(h);
    plant(h);
    const initial = scopeReads,
      input = sessionStartFixture(h, randomUUID());
    for (const headers of [
      h.headers(null),
      { ...h.headers(h.hearth.token), origin: "https://foreign.example" },
    ])
      expect((await post(h, input, headers)).status).toBe(403);
    for (const invalid of [
      { ...input, launch: { ...input.launch, resumeSessionId: randomUUID() } },
      {
        ...input,
        launch: { ...input.launch, context: { projectId: FIXTURE_PROJECT_ID } },
      },
      { ...input, snapshot: {} },
    ])
      expect((await post(h, invalid)).status).toBe(400);
    if (!auditAllowed) expect((await post(h, input)).status).toBe(503);
    expect(scopeReads).toBe(initial);
    expect(fake.prepared).toHaveLength(0);
    expect(fake.runs).toHaveLength(0);
    untouched(h);
    expect(h.events(["operator.action"])).toHaveLength(0);
  }
});

test("preview refuses changed scope before preparation and rechecks scope changed during preparation", async () => {
  const fake = fakeSessionRuntime(),
    prepare = fake.runtime.prepare;
  let h: TestHearth;
  h = await startTestHearth({
    api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
  });
  opened.push(h);
  plant(h);
  const input = sessionStartFixture(h, randomUUID());
  expect(
    (await post(h, { ...input, worktree: `${h.workspace}-foreign` })).status,
  ).toBe(409);
  expect(fake.prepared).toHaveLength(0);
  fake.runtime.prepare = async (request) => {
    const snapshot = await prepare(request);
    plant(h, true);
    return snapshot;
  };
  expect((await post(h, input)).status).toBe(409);
  expect(fake.prepared).toHaveLength(1);
  expect(fake.runs).toHaveLength(0);
  untouched(h);
});

test("preview retains source smith/cwd/options and refuses unsupported capability evidence", async () => {
  const fake = fakeSessionRuntime(),
    prepare = fake.runtime.prepare;
  const h = await startTestHearth({
    api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
  });
  opened.push(h);
  plant(h);
  const input = sessionStartFixture(h, randomUUID());
  for (const change of [
    (snapshot: Awaited<ReturnType<typeof prepare>>) => {
      snapshot.smith = "different-source";
    },
    (snapshot: Awaited<ReturnType<typeof prepare>>) => {
      snapshot.cwd += "/foreign";
    },
    (snapshot: Awaited<ReturnType<typeof prepare>>) => {
      snapshot.launch.prompt = "Changed prompt";
    },
    (snapshot: Awaited<ReturnType<typeof prepare>>) => {
      snapshot.launch.context!.about = [{ kind: "event", id: "foreign" }];
    },
    (snapshot: Awaited<ReturnType<typeof prepare>>) => {
      snapshot.capabilities.flags = [];
    },
  ]) {
    fake.runtime.prepare = async (request) => {
      const snapshot = await prepare(request);
      change(snapshot);
      return snapshot;
    };
    expect((await post(h, input)).status).toBe(503);
  }
  fake.runtime.prepare = async (request) => {
    request.launch.prompt = "Mutated callback input";
    return prepare(request);
  };
  expect((await post(h, input)).status).toBe(503);
  expect(fake.runs).toHaveLength(0);
  untouched(h);
});

test("a disabled source smith refuses preview before any CLI probe or provider turn", async () => {
  const fake = fakeSessionRuntime();
  let h: TestHearth;
  fake.runtime.prepare = (input) =>
    createClaudeSessionTransport({
      root: h.root,
      home: h.home,
      configHome: h.configHome,
      command: ["must-not-be-resolved.exe"],
    }).prepare(input);
  h = await startTestHearth({
    api: { sessionRuntime: fake.runtime, git: fixtureSessionGit },
  });
  opened.push(h);
  plant(h);
  const response = await post(h, {
    ...sessionStartFixture(h, randomUUID()),
    smith: "unconfigured-source",
  });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("enabled Claude smith");
  expect(fake.prepared).toHaveLength(0);
  expect(fake.runs).toHaveLength(0);
  untouched(h);
});
