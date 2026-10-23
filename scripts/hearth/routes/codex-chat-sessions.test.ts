import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CodexChatDecisionRequest,
  CodexChatStartRequest,
} from "../../../types/codex-owned-chat";
import { projectCatalogPath } from "../../projects/store";
import {
  FIXTURE_PROJECT_ID,
  projectCatalogFixture,
} from "../../projects/testing";
import { createCodexChatRuntime } from "../../sessions/codex-chat-runtime";
import { ownedCodingPageSchema } from "../../sessions/codex-owned-journal";
import { ownedCodingStartReceiptSchema } from "../../sessions/codex-owned-wire-protocol";
import { startTestHearth, type TestHearth } from "../testing";
import { writeOwnerOnly } from "../token";
import { fixtureSessionGit } from "./session-fixture";

const opened: TestHearth[] = [],
  releaseHeld: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseHeld.splice(0)) release();
  for (const h of opened.splice(0).reverse()) await h.close();
});
async function fixture(mode = "approval-command", holdDecision = false) {
  let h: TestHearth,
    actual: ReturnType<typeof createCodexChatRuntime> | undefined;
  const selected = () => {
    if (!actual) throw Error("No planted native Chat runtime");
    return actual;
  };
  let release: () => void = () => {},
    held = false;
  const answerGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  releaseHeld.push(release);
  h = await startTestHearth({
    files: {
      "agent-forge.toml":
        '[execution.env]\npass = ["CODEX_CHAT_LOG", "CODEX_CHAT_MODE"]\n',
    },
    api: {
      git: fixtureSessionGit,
      codexChatRuntime: {
        check: (input) => selected().check(input),
        prepare: (input) => {
          const event = h.events(["operator.action"]).at(-1);
          expect(
            event?.kind === "operator.action" &&
              ["session.start", "session.turn.send"].includes(
                event.payload.action,
              ),
          ).toBe(true);
          return selected().prepare(input);
        },
        run: (input, persist, signal, callbacks) =>
          selected().run(input, persist, signal, callbacks),
      },
      decorate: (routes) =>
        routes.map((route) =>
          route.kind === "action" && route.action === "session.approval.decide"
            ? {
                ...route,
                effect: async (input, context) => {
                  const result = await route.effect(input, context);
                  if (holdDecision && !held && result.status === 200) {
                    held = true;
                    await answerGate;
                  }
                  return result;
                },
              }
            : route,
        ),
    },
  });
  opened.push(h);
  const command = join(
    h.root,
    process.platform === "win32" ? "inert-codex.exe" : "inert-codex",
  );
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(import.meta.dir, "../../sessions/fixtures/codex-app-server-cli.ts"),
      "--compile",
      "--outfile",
      command,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  if (built.exitCode !== 0)
    throw Error("Could not compile the inert Chat provider");
  const log = join(h.root, "codex-chat.jsonl");
  actual = createCodexChatRuntime({
    root: h.root,
    home: h.home,
    configHome: h.configHome,
    command: [command],
    syncCommand: [command, "--sync"],
    environment: { ...process.env, CODEX_CHAT_LOG: log, CODEX_CHAT_MODE: mode },
    timeoutMs: 8000,
    approvalTimeoutMs: 6000,
  });
  writeOwnerOnly(
    projectCatalogPath(h.home),
    JSON.stringify(projectCatalogFixture(h.workspace)),
  );
  const request: CodexChatStartRequest = {
    provider: "codex",
    requestId: randomUUID(),
    smith: "codex-journeyman",
    repository: h.workspace,
    worktree: h.workspace,
    launch: {
      mode: "chat",
      model: "exact-model",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      prompt: "PRIVATE-CHAT-PROMPT",
      attachments: [
        { kind: "text", name: "context.txt", text: "PRIVATE-CHAT-CONTEXT" },
      ],
    },
  };
  const path = `/projects/${FIXTURE_PROJECT_ID}/sessions`;
  const post = (
    suffix: string,
    body: unknown,
    headers = h.headers(h.hearth.token),
    signal?: AbortSignal,
  ) =>
    fetch(`${h.api}${path}${suffix}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  const get = async (suffix: string) =>
    (
      await (
        await fetch(`${h.api}${path}${suffix}`, {
          headers: h.headers(h.hearth.token),
        })
      ).json()
    ).data;
  const page = async (id: string) =>
    ownedCodingPageSchema.parse(await get(`/${id}`));
  const waitApproval = async (id: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const data = await get(`/${id}/approvals`);
      if (data.pending.length) return data.pending[0];
      if (Date.now() > deadline)
        throw Error("Native approval never became actionable");
      await Bun.sleep(20);
    }
  };
  const settle = async (id: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const data = await page(id);
      if (
        data.turns.every(
          (turn) => !["accepted", "running", "cancelling"].includes(turn.phase),
        )
      )
        return data;
      if (Date.now() > deadline) throw Error("Owned Chat did not settle");
      await Bun.sleep(20);
    }
  };
  const records = (): Record<string, unknown>[] => {
    if (!existsSync(log)) return [];
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw Error("Invalid completed native fixture recording");
    }
  };
  return {
    h,
    request,
    post,
    get,
    page,
    waitApproval,
    settle,
    records,
    release,
    held: () => held,
  };
}

test("protected HTTP Chat with a compiled native provider preserves two turns and reconciles a lost decision answer without another effect", async () => {
  const f = await fixture("approval-command", true);
  expect((await f.post("", f.request, f.h.headers(null))).status).toBe(403);
  expect(f.records()).toEqual([]);
  const response = await f.post("", f.request),
    started = ownedCodingStartReceiptSchema.parse((await response.json()).data);
  expect(response.status).toBe(202);
  const id = started.session.id,
    pending = await f.waitApproval(id);
  expect(pending.actionable).toBe(true);
  expect(pending.approval).not.toHaveProperty("nativeRequestId");
  expect(
    (
      await fetch(
        `${f.h.api}/projects/${FIXTURE_PROJECT_ID}/sessions/${id}/approvals`,
        { headers: f.h.headers(null) },
      )
    ).status,
  ).toBe(403);
  const request: CodexChatDecisionRequest = {
    requestId: randomUUID(),
    approvalId: pending.approval.id,
    turnRequestId: pending.turnRequestId,
    decision: "accept",
  };
  const before = f.h.events(["operator.action"]).length;
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        ...request,
        nativeRequestId: 1,
      })
    ).status,
  ).toBe(400);
  expect(f.h.events(["operator.action"])).toHaveLength(before);
  const abort = new AbortController(),
    held = f
      .post(
        `/${id}/approval-decisions`,
        request,
        f.h.headers(f.h.hearth.token),
        abort.signal,
      )
      .catch(() => null);
  const deadline = Date.now() + 4000;
  while (!f.held()) {
    if (Date.now() > deadline)
      throw Error("Decision response was not held after admission");
    await Bun.sleep(20);
  }
  const original = await f.get(
    `/${id}/approvals?requestId=${request.requestId}`,
  );
  expect(original.pending).toEqual([]);
  expect(original.receipt.state).toBe("recorded");
  abort.abort();
  f.release();
  await held;
  const retried = await f.post(`/${id}/approval-decisions`, request);
  expect(retried.status).toBe(200);
  expect((await retried.json()).data).toEqual(original.receipt);
  let page = await f.settle(id);
  expect(page.turns[0]?.phase).toBe("completed");
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(1);
  const secondId = randomUUID();
  expect(
    (
      await f.post(`/${id}/turns`, {
        requestId: secondId,
        expectedRevision: page.revision,
        text: "PRIVATE-CHAT-SECOND",
        about: [],
      })
    ).status,
  ).toBe(202);
  const second = await f.waitApproval(id);
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        requestId: randomUUID(),
        approvalId: second.approval.id,
        turnRequestId: secondId,
        decision: "decline",
      })
    ).status,
  ).toBe(200);
  page = await f.settle(id);
  expect(page.turns.map((turn) => turn.phase)).toEqual([
    "completed",
    "completed",
  ]);
  expect(
    f.records().filter((row) => row.method === "thread/resume"),
  ).toHaveLength(1);
  expect(f.records().filter((row) => row.kind === "answer")).toHaveLength(2);
  expect(JSON.stringify(f.h.events())).not.toContain("PRIVATE-CHAT");
  expect(JSON.stringify(f.h.events())).not.toContain("nativeRequestId");
  expect(JSON.stringify(await f.get(""))).not.toContain("PRIVATE-CHAT");
});

test("Stop invalidates a protected native approval and confirms cleanup of the actual compiled provider tree", async () => {
  const f = await fixture("approval-never");
  const response = await f.post("", f.request),
    started = ownedCodingStartReceiptSchema.parse((await response.json()).data),
    id = started.session.id;
  const pending = await f.waitApproval(id);
  expect(
    (await f.post(`/${id}/stop`, { requestId: f.request.requestId })).status,
  ).toBe(200);
  const page = await f.settle(id);
  expect(page.turns[0]?.phase).toBe("cancelled");
  expect((await f.get(`/${id}/approvals`)).pending).toEqual([]);
  expect(
    (
      await f.post(`/${id}/approval-decisions`, {
        requestId: randomUUID(),
        approvalId: pending.approval.id,
        turnRequestId: pending.turnRequestId,
        decision: "accept",
      })
    ).status,
  ).toBe(409);
  const tree = f.records().find((row) => row.kind === "tree");
  if (typeof tree?.pid !== "number" || typeof tree.childPid !== "number")
    throw Error("No actual native fixture tree");
  for (const pid of [tree.pid, tree.childPid])
    expect(() => process.kill(pid, 0)).toThrow();
  expect(f.records().filter((row) => row.kind === "answer")).toEqual([]);
});
