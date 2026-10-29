import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { createConversationStore } from "../conversations/store";
import {
  KeeperSelectionMismatchError,
  type ConversationTransport,
} from "../conversations/transport";
import { liveChildCount } from "../executors/supervisor";
import { startTestHearth, type TestHearth } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { projectCatalogPath } from "../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
  projectFixture,
} from "../projects/testing";
import { createClaudeConversationTransport } from "./claude-transport";

const open: TestHearth[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});
const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
const parseFixture = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Malformed fake CLI recording");
  }
};
async function until(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Keeper fixture deadline");
    await delay();
  }
}

async function fixture(mode = "normal", timeoutMs = 12_000) {
  let provider: ConversationTransport;
  const h = await startTestHearth({
    api: {
      conversationTransport: {
        provider: "claude",
        check: (request) => provider.check?.(request) ?? Promise.resolve(),
        run: (...args) => provider.run(...args),
      },
    },
  });
  open.push(h);
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  writeFileSync(
    join(h.root, "agent-forge.toml"),
    '[execution.env]\npass = ["KEEPER_FIXTURE_RECORD", "KEEPER_FIXTURE_MODE", "TEST_OPERATOR_SECRET"]\n',
  );
  h.bd.answer = (args) =>
    args[0] === "export"
      ? {
          status: 0,
          stdout:
            JSON.stringify({
              id: "alpha-epic",
              title: "Scoped Alpha",
              issue_type: "epic",
              status: "open",
              labels: ["project:alpha"],
            }) +
            "\n" +
            JSON.stringify({
              id: "foreign",
              title: "FOREIGN_SECRET",
              issue_type: "epic",
              status: "open",
              labels: ["project:beta"],
            }),
          stderr: "",
        }
      : undefined;
  const recordFile = join(h.root, "record.json");
  provider = createClaudeConversationTransport({
    root: h.root,
    home: h.home,
    configHome: h.configHome,
    origin: () => h.hearth.url,
    operatorToken: () => h.hearth.token,
    readerCommand: [process.execPath, join(import.meta.dir, "reader-entry.ts")],
    command: [
      process.execPath,
      join(import.meta.dir, "fixtures", "claude-conversation.ts"),
    ],
    environment: {
      ...process.env,
      KEEPER_FIXTURE_RECORD: recordFile,
      KEEPER_FIXTURE_MODE: mode,
      TEST_OPERATOR_SECRET: h.hearth.token,
    },
    timeoutMs,
  });
  const store = createConversationStore(h.home);
  const path = h.api + `/projects/${FIXTURE_PROJECT_ID}/keeper`;
  const send = (text = 'Private "question" & $literal\nsecond line 🌱') =>
    fetch(path + "/turns", {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: store.read(FIXTURE_PROJECT_ID).revision,
        text,
        about: [],
      }),
    });
  return { h, store, send, recordFile, path, provider };
}

test("a real fake CLI resumes exact identity and streams private text and scoped reads without operator authority", async () => {
  const baseline = liveChildCount();
  const f = await fixture();
  expect((await f.send()).status).toBe(202);
  await until(
    () => f.store.read(FIXTURE_PROJECT_ID).turns[0]?.phase === "completed",
  );
  const first = f.store.read(FIXTURE_PROJECT_ID);
  expect(
    first.frames
      .flatMap((frame) =>
        frame.event.kind === "text" ? [frame.event.text] : [],
      )
      .join(""),
  ).toBe("Scoped reply 🌱");
  expect(
    first.frames.some(
      (frame) =>
        frame.event.kind === "read" &&
        frame.event.ids.includes("alpha-epic") &&
        !frame.event.ids.includes("foreign"),
    ),
  ).toBe(true);
  expect(
    first.frames.some(
      (frame) =>
        frame.event.kind === "model" &&
        frame.event.model === "fixture-observed-model",
    ),
  ).toBe(true);
  const recorded = parseFixture(readFileSync(f.recordFile, "utf8"));
  expect(recorded).toMatchObject({
    operatorSecretPresent: false,
    home: f.h.home,
    adapter: "1",
    tools: ["mcp__keeper__read_project"],
  });
  expect(JSON.stringify(recorded)).not.toContain(f.h.hearth.token);
  if (
    typeof recorded !== "object" ||
    recorded === null ||
    !("prompt" in recorded) ||
    typeof recorded.prompt !== "string"
  )
    throw new Error("Missing recorded prompt");
  expect(parseFixture(recorded.prompt)).toHaveProperty(
    "message",
    'Private "question" & $literal\nsecond line 🌱',
  );
  expect(recorded).toHaveProperty(
    "args",
    expect.not.arrayContaining([expect.stringContaining("Private")]),
  );
  expect(recorded).toHaveProperty(
    "args",
    expect.arrayContaining([
      "--tools",
      "",
      "--restricted",
      "--allowedTools",
      "mcp__keeper__read_project",
      "--permission-mode",
      "manual",
      "--permission-prompts",
      "none",
      "--strict-mcp-config",
    ]),
  );
  expect(JSON.stringify(recorded)).not.toContain("bypassPermissions");
  expect(JSON.stringify(recorded)).not.toContain("FOREIGN_SECRET");
  expect((await f.send("Continue after restart")).status).toBe(202);
  await until(
    () => f.store.read(FIXTURE_PROJECT_ID).turns[1]?.phase === "completed",
  );
  const resumed = parseFixture(readFileSync(f.recordFile, "utf8"));
  expect(resumed).toHaveProperty(
    "args",
    expect.arrayContaining(["--resume", first.binding?.sessionId]),
  );
  expect(JSON.stringify(f.h.events())).not.toContain("Scoped reply");
  expect(JSON.stringify(f.h.events())).not.toContain("Private");
  expect(
    f.h
      .events(["operator.action"])
      .every(
        (row) =>
          row.kind === "operator.action" &&
          row.payload.action === "keeper.turn.send",
      ),
  ).toBe(true);
  expect(liveChildCount()).toBe(baseline);
}, 40_000);

test("unsupported installed capabilities refuse admission without a provider turn", async () => {
  const f = await fixture("legacy");
  expect((await f.send()).status).toBe(503);
  expect(f.store.read(FIXTURE_PROJECT_ID).turns).toEqual([]);
  expect(existsSync(f.recordFile)).toBe(false);
}, 25_000);

test("a frozen Keeper selection mismatch is typed and refuses before either capability probes or dispatch", async () => {
  const baseline = liveChildCount();
  const f = await fixture();
  const { config } = loadConfig({
    harnessRoot: f.h.root,
    home: f.h.configHome,
    env: {},
  });
  const smith = config.smiths[config.workflow.defaultCrew];
  if (!smith) throw new Error("Missing fixture Keeper smith");
  const expectedSmith = { ...smith, model: `${smith.model}-reviewed` };
  const request = {
    project: projectFixture(f.h.workspace),
    root: f.h.root,
    resume: null,
    smith: smith.name,
    expectedSmith,
  };
  if (!f.provider.check) throw new Error("Missing Claude capability check");
  await expect(f.provider.check(request)).rejects.toBeInstanceOf(
    KeeperSelectionMismatchError,
  );
  await expect(
    f.provider.run(
      {
        ...request,
        input: {
          requestId: randomUUID(),
          expectedRevision: 0,
          text: "Reviewed original",
          about: [],
        },
      },
      async () => {},
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(KeeperSelectionMismatchError);
  expect(liveChildCount()).toBe(baseline);
  expect(existsSync(f.recordFile)).toBe(false);
}, 25_000);

test("Stop waits for the supervised CLI and reader to end and preserves the partial reply", async () => {
  const baseline = liveChildCount();
  const f = await fixture("hang");
  expect((await f.send()).status).toBe(202);
  await until(() =>
    f.store
      .read(FIXTURE_PROJECT_ID)
      .frames.some((frame) => frame.event.kind === "text"),
  );
  const state = f.store.read(FIXTURE_PROJECT_ID);
  const record = parseFixture(readFileSync(f.recordFile, "utf8"));
  expect(
    typeof record === "object" && record !== null && "readerPid" in record,
  ).toBe(true);
  const response = await fetch(f.path + "/stop", {
    method: "POST",
    headers: f.h.headers(f.h.hearth.token),
    body: JSON.stringify({ requestId: state.turns[0]?.requestId }),
  });
  expect(response.status).toBe(200);
  await until(
    () => f.store.read(FIXTURE_PROJECT_ID).turns[0]?.phase === "cancelled",
  );
  expect(liveChildCount()).toBe(baseline);
  if (
    typeof record === "object" &&
    record !== null &&
    "readerPid" in record &&
    typeof record.readerPid === "number"
  ) {
    const pid = record.readerPid;
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  }
  expect(
    f.store
      .read(FIXTURE_PROJECT_ID)
      .frames.some((frame) => frame.event.kind === "text"),
  ).toBe(true);
}, 30_000);

test.each([
  "missing-terminal",
  "bad-identity",
  "bad-tool",
  "overflow",
])("%s never claims completion or resends a turn", async (mode) => {
  const baseline = liveChildCount();
  const f = await fixture(mode);
  expect((await f.send()).status).toBe(202);
  await until(
    () => f.store.read(FIXTURE_PROJECT_ID).turns[0]?.phase === "unknown",
  );
  expect(f.store.read(FIXTURE_PROJECT_ID).turns).toHaveLength(1);
  expect((await f.send("Another prompt")).status).toBe(409);
  expect(liveChildCount()).toBe(baseline);
}, 30_000);

test("a time limit ends the process tree, keeps partial text and leaves completion unknown", async () => {
  const baseline = liveChildCount();
  const f = await fixture("hang", 3_500);
  expect((await f.send()).status).toBe(202);
  await until(
    () => f.store.read(FIXTURE_PROJECT_ID).turns[0]?.phase === "unknown",
  );
  const state = f.store.read(FIXTURE_PROJECT_ID);
  expect(state.frames.some((frame) => frame.event.kind === "text")).toBe(true);
  expect(state.turns[0]?.reason).toContain("time limit");
  expect(liveChildCount()).toBe(baseline);
}, 30_000);

test("an unavailable configured smith and an unverified resume id are refused before admission", async () => {
  const f = await fixture();
  await expect(
    f.provider.check?.({
      root: f.h.root,
      project: projectFixture(f.h.workspace),
      resume: {
        provider: "claude",
        sessionId: "../credentials",
        version: "fixture",
      },
    }),
  ).rejects.toThrow("resume identity");
  writeFileSync(
    join(f.h.root, "agent-forge.toml"),
    '[workflow]\ndefault_crew = "codex-journeyman"\n',
  );
  expect((await f.send()).status).toBe(503);
  expect(f.store.read(FIXTURE_PROJECT_ID).turns).toEqual([]);
  expect(existsSync(f.recordFile)).toBe(false);
}, 25_000);

test("a failed private transcript write stops dispatch and never reports successful completion", async () => {
  const baseline = liveChildCount();
  const f = await fixture("hang");
  const result = await f.provider.run(
    {
      root: f.h.root,
      project: projectFixture(f.h.workspace),
      resume: null,
      input: {
        requestId: randomUUID(),
        expectedRevision: 0,
        text: "Private write failure",
        about: [],
      },
    },
    async () => {
      throw new Error("PRIVATE_STORAGE_FAILURE");
    },
    new AbortController().signal,
  );
  expect(result.phase).toBe("unknown");
  expect(result.reason).not.toContain("PRIVATE_STORAGE_FAILURE");
  expect(liveChildCount()).toBe(baseline);
}, 25_000);
