import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationPage } from "../../../types/conversation";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { ownedCodingPageSchema } from "../../sessions/codex-owned-journal";
import { serializeCodexTask } from "../../sessions/codex-task";
import { createCodexTaskRuntime } from "../../sessions/codex-task-runtime";
import { createSessionRegistry } from "../../sessions/registry";
import { expectStartIdentityState } from "../../sessions/session-start-identity-test-witness";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { fixtureSessionGit } from "./session-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
async function fixture() {
  let h: TestHearth,
    actual: ReturnType<typeof createCodexTaskRuntime> | null = null,
    activeStartInput: unknown;
  let probes = 0;
  const selected = () =>
    (actual ??= createCodexTaskRuntime({
      root: h.root,
      home: h.home,
      configHome: h.configHome,
      command: [
        process.execPath,
        join(
          import.meta.dir,
          "../../sessions/fixtures/codex-task-runtime-cli.ts",
        ),
      ],
      syncCommand: [
        process.execPath,
        join(
          import.meta.dir,
          "../../sessions/fixtures/codex-task-runtime-cli.ts",
        ),
        "--sync",
      ],
      environment: {
        ...process.env,
        CODEX_RUNTIME_LOG: join(h.root, "codex.jsonl"),
      },
      timeoutMs: 5000,
    }));
  h = await startTestHearth({
    files: {
      "agent-forge.toml": '[execution.env]\npass = ["CODEX_RUNTIME_LOG"]\n',
    },
    api: {
      git: fixtureSessionGit,
      codexTaskRuntime: {
        async check(input) {
          const audit = h.events(["operator.action"]).at(-1);
          if (
            activeStartInput !== undefined &&
            audit?.kind === "operator.action" &&
            audit.payload.action === "session.start"
          )
            await expectStartIdentityState(
              h.home,
              FIXTURE_PROJECT_ID,
              h.workspace,
              activeStartInput,
              "attempted",
            );
          return selected().check(input);
        },
        async prepare(input) {
          probes++;
          const audit = h.events(["operator.action"]).at(-1);
          expect(
            audit?.kind === "operator.action" ? audit.payload.action : null,
          ).toMatch(/^session\.(preview|start)$/);
          if (
            activeStartInput !== undefined &&
            audit?.kind === "operator.action" &&
            audit.payload.action === "session.start"
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
        run: (snapshot, persist, signal) =>
          selected().run(snapshot, persist, signal),
      },
    },
  });
  opened.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const input = {
    provider: "codex",
    requestId: randomUUID(),
    smith: "codex-journeyman",
    repository: h.workspace,
    worktree: h.workspace,
    launch: {
      mode: "task",
      model: "gpt-example-exact",
      sandbox: "read-only",
      approvalPolicy: "never",
      prompt: "  PRIVATE-CODEX-PROMPT\n",
      attachments: [
        { kind: "text", name: "note.txt", text: "PRIVATE-CODEX-ATTACHMENT" },
      ],
    },
  };
  activeStartInput = input;
  const post = (
    suffix: string,
    body: unknown,
    headers = h.headers(h.hearth.token),
  ) =>
    fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions${suffix}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return { h, input, post, probes: () => probes };
}

test("audited Codex Preview and Start use the real fake runtime, private journal and shared original UUID with metadata-only Activity", async () => {
  const f = await fixture(),
    { h, input } = f;
  const preview = await f.post("/preview", input),
    reviewed = await preview.json();
  expect(preview.status).toBe(200);
  expect(reviewed.ok).toBe(true);
  expect(reviewed.data.provider).toBe("codex");
  expect(reviewed.data.serialized).toEqual(
    serializeCodexTask(
      reviewed.data.snapshot.launch,
      reviewed.data.snapshot.capabilities,
    ),
  );
  expect(existsSync(join(h.home, "sessions"))).toBe(false);
  const started = await f.post("", input),
    answer = await started.json();
  expect(started.status).toBe(202);
  expect(answer.data.session.provider).toBe("codex");
  await expectStartIdentityState(
    h.home,
    FIXTURE_PROJECT_ID,
    h.workspace,
    input,
    "admitted",
  );
  const id = answer.data.session.id,
    path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${id}`;
  let page: ConversationPage;
  const deadline = Date.now() + 5000;
  do {
    page = ownedCodingPageSchema.parse(
      (await (await fetch(path, { headers: h.headers(h.hearth.token) })).json())
        .data,
    );
    if (Date.now() > deadline) throw Error("Fake Codex Task did not settle");
    if (page.turns[0]?.phase !== "completed") await Bun.sleep(20);
  } while (page.turns[0]?.phase !== "completed");
  expect(page.binding?.provider).toBe("codex");
  expect(page.frames[0]?.event).toMatchObject({
    codexTask: { launch: { prompt: input.launch.prompt } },
  });
  expect(
    page.frames.some(
      (frame: { event: { kind: string } }) =>
        frame.event.kind === "coding-usage",
    ),
  ).toBe(true);
  const before = readFileSync(join(h.root, "codex.jsonl"), "utf8");
  expect((await f.post("", input)).status).toBe(202);
  expect(readFileSync(join(h.root, "codex.jsonl"), "utf8")).toBe(before);
  await expectStartIdentityState(
    h.home,
    FIXTURE_PROJECT_ID,
    h.workspace,
    input,
    "admitted",
  );
  const listed = await (
    await fetch(`${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions`, {
      headers: h.headers(h.hearth.token),
    })
  ).json();
  expect(listed.data).toHaveLength(1);
  expect(listed.data[0].provider).toBe("codex");
  expect(JSON.stringify(listed)).not.toContain("PRIVATE-CODEX");
  expect(JSON.stringify(h.events())).not.toContain("PRIVATE-CODEX");
  expect(
    createSessionRegistry(h.home, "codex").list(FIXTURE_PROJECT_ID),
  ).toHaveLength(1);
  expect(
    (
      await f.post(`/${id}/turns`, {
        requestId: randomUUID(),
        expectedRevision: page.revision,
        text: "Next",
        about: [],
      })
    ).status,
  ).toBe(409);
});

test("Codex authority and current scope refusals never start probes, sync or a provider", async () => {
  const f = await fixture();
  expect((await f.post("", f.input, f.h.headers(null))).status).toBe(403);
  expect(
    (await f.post("", { ...f.input, repository: `${f.h.workspace}-foreign` }))
      .status,
  ).toBe(409);
  expect((await f.post("", { ...f.input, provider: "Codex" })).status).toBe(
    400,
  );
  const catalog = projectCatalogFixture(f.h.workspace);
  if (!catalog.projects[0]) throw Error("Missing project");
  catalog.projects[0].archived = true;
  writeOwnerOnly(projectCatalogPath(f.h.home), JSON.stringify(catalog));
  expect((await f.post("", f.input)).status).toBe(409);
  expect(f.probes()).toBe(0);
  expect(existsSync(join(f.h.root, "codex.jsonl"))).toBe(false);
});
