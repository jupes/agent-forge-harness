import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { ConversationPage } from "../../types/conversation";
import { fixtureSessionGit } from "../hearth/routes/session-fixture";
import { startTestHearth, type TestHearth } from "../hearth/testing";
import { writeOwnerOnly } from "../hearth/token";
import { projectCatalogPath } from "../projects/store";
import { FIXTURE_PROJECT_ID, projectCatalogFixture } from "../projects/testing";
import { latestClaudeAccountReports } from "./claude-account";
import { createClaudeSessionTransport } from "./claude-transport";
import { ownedCodingPageSchema } from "./codex-owned-journal";
import { ownedCodingStartReceiptSchema } from "./codex-owned-wire-protocol";
import { createCodexTaskRuntime } from "./codex-task-runtime";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0).reverse()) await h.close();
});
async function payload<T>(
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const value: unknown = await response.json();
  return z
    .object({ ok: z.literal(true), data: schema, error: z.null() })
    .parse(value).data;
}
function compile(root: string, name: string) {
  const output = join(
    root,
    `${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(import.meta.dir, `fixtures/compiled-${name}.ts`),
      "--compile",
      "--outfile",
      output,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  if (result.exitCode !== 0)
    throw Error(
      `Could not compile the isolated fake CLI: ${result.stderr.toString()}`,
    );
  return output;
}
test("real hearth and compiled fake providers retain private activity through protected reads without ledger/list disclosure or duplicate dispatch", async () => {
  let claude: ReturnType<typeof createClaudeSessionTransport> | undefined;
  let codex: ReturnType<typeof createCodexTaskRuntime> | undefined;
  const getClaude = () => {
    if (!claude) throw Error("Fixture Claude runtime not initialized");
    return claude;
  };
  const getCodex = () => {
    if (!codex) throw Error("Fixture Codex runtime not initialized");
    return codex;
  };
  const h = await startTestHearth({
    files: {
      "agent-forge.toml":
        '[execution.env]\npass = ["CODING_FIXTURE_MODE", "CODING_FIXTURE_RECORD", "CODEX_RUNTIME_MODE", "CODEX_RUNTIME_LOG"]\n',
    },
    api: {
      git: fixtureSessionGit,
      sessionRuntime: {
        provider: "claude",
        prepare: (input) => getClaude().prepare(input),
        run: (...args) => getClaude().run(...args),
      },
      codexTaskRuntime: {
        check: (input) => getCodex().check(input),
        prepare: (input) => getCodex().prepare(input),
        run: (...args) => getCodex().run(...args),
      },
    },
  });
  opened.push(h);
  const claudeCommand = compile(h.root, "coding-cli"),
    codexCommand = compile(h.root, "codex-task-runtime-cli");
  claude = createClaudeSessionTransport({
    root: h.root,
    home: h.home,
    configHome: h.configHome,
    command: [claudeCommand],
    environment: {
      ...process.env,
      CODING_FIXTURE_MODE: "rich",
      CODING_FIXTURE_RECORD: join(h.root, "claude-record.json"),
    },
    timeoutMs: 5000,
  });
  codex = createCodexTaskRuntime({
    root: h.root,
    home: h.home,
    configHome: h.configHome,
    command: [codexCommand],
    syncCommand: [codexCommand, "--sync"],
    environment: {
      ...process.env,
      CODEX_RUNTIME_MODE: "rich",
      CODEX_RUNTIME_LOG: join(h.root, "codex-record.jsonl"),
    },
    timeoutMs: 5000,
  });
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const path = `${h.api}/projects/${FIXTURE_PROJECT_ID}/sessions`;
  const headers = h.headers(h.hearth.token);
  for (const provider of ["claude", "codex"] as const) {
    const request = {
      requestId: randomUUID(),
      smith: `${provider}-journeyman`,
      repository: h.workspace,
      worktree: h.workspace,
      ...(provider === "codex"
        ? {
            provider: "codex",
            launch: {
              mode: "task",
              model: "gpt-example-exact",
              prompt: "Private activity launch",
              sandbox: "read-only",
              approvalPolicy: "never",
            },
          }
        : {
            launch: {
              mode: "task",
              model: "sonnet",
              prompt: "Private activity launch",
            },
          }),
    };
    const started = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(started.status, await started.clone().text()).toBe(202);
    const receipt = await payload(started, ownedCodingStartReceiptSchema);
    let page: ConversationPage | null = null;
    const deadline = Date.now() + 5000;
    do {
      const response = await fetch(`${path}/${receipt.session.id}`, {
        headers,
      });
      expect(response.status).toBe(200);
      page = await payload(response, ownedCodingPageSchema);
      if (
        page.turns.some(
          (turn) =>
            turn.requestId === request.requestId &&
            !["accepted", "running", "cancelling"].includes(turn.phase),
        )
      )
        break;
      if (Date.now() > deadline)
        throw Error("Private activity fixture did not settle");
      await Bun.sleep(20);
    } while (Date.now() <= deadline);
    if (!page) throw Error("Missing protected private activity page");
    expect(
      page.turns[0]?.phase,
      JSON.stringify({
        provider,
        binding: page.binding,
        turn: page.turns[0],
        outcomes: page.frames.filter(
          (frame) => frame.event.kind === "coding-outcome",
        ),
        kinds: page.frames.map((frame) => frame.event.kind),
      }),
    ).toBe("completed");
    const activity = page.frames.filter(
      (frame) => frame.event.kind === "coding-activity",
    );
    expect(activity.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(activity)).toContain("Private command output");
    expect(page.frames.at(-1)?.event).toMatchObject({
      kind: "coding-outcome",
      provider,
      code: "completed",
      exitCode: 0,
      timedOut: false,
      stopped: false,
    });
    if (provider === "claude") {
      expect(JSON.stringify(activity)).toContain("Private structured result");
      expect(JSON.stringify(activity)).toContain("Private old");
      expect(JSON.stringify(activity)).not.toContain("opaque-never");
      const account = latestClaudeAccountReports(page.frames);
      expect(account.authSource?.report.apiKeySource).toBe("none");
      expect(account.usage?.report.rate_limits?.limits?.[0]?.percent).toBe(75);
    } else expect(JSON.stringify(activity)).not.toContain('"additions"');
    const repeated = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    expect(repeated.status).toBe(202);
    const duplicate = await payload(repeated, ownedCodingStartReceiptSchema);
    expect(duplicate.session.id).toBe(receipt.session.id);
    const unauthorized = await fetch(`${path}/${receipt.session.id}`, {
      headers: h.headers(),
    });
    expect(unauthorized.status).not.toBe(200);
    expect(await unauthorized.text()).not.toContain("Private command output");
  }
  const list = await (await fetch(path, { headers })).text();
  const events = JSON.stringify(h.events());
  for (const sentinel of [
    "Private command output",
    "Private reported reasoning",
    "Private tool result",
    "Private structured result",
    "Private old",
    "Private activity launch",
  ]) {
    expect(list).not.toContain(sentinel);
    expect(events).not.toContain(sentinel);
  }
  const log = (await Bun.file(join(h.root, "codex-record.jsonl")).text())
    .trim()
    .split("\n");
  let starts = 0;
  for (const line of log) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw Error("Malformed fixture log");
    }
    if (z.object({ kind: z.literal("task") }).safeParse(record).success)
      starts++;
  }
  expect(starts).toBe(1);
  expect(
    h.bd.calls.filter((args) =>
      ["create", "update", "close", "comments"].includes(args[0] ?? ""),
    ).length,
  ).toBe(0);
}, 30_000);
