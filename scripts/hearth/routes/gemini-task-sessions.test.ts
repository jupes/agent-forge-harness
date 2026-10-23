import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GeminiTaskStartRequest } from "../../../types/gemini-owned-task";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { createGeminiTaskRuntime } from "../../sessions/gemini-task-runtime";
import { sessionRegistryFile } from "../../sessions/registry";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { fixtureSessionGit } from "./session-fixture";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0).reverse()) await h.close();
});
async function fixture() {
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
          expect(h.events(["operator.action"]).at(-1)).toMatchObject({
            payload: { action: "session.preview" },
          });
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
  return { h, request, post, records };
}

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
    { mode: "chat" },
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
