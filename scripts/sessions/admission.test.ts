import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEventInput } from "../../types/hearth";
import { createOwnedSessionLedger } from "../hearth/routes/session-ledger";
import { createProjectStore } from "../projects/store";
import { createOwnedSessionService } from "./admission";
import { serializeClaudeLaunch } from "./claude-launch";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("concurrent explicit Start and a lost-response retry resolve to one private session and one provider turn", async () => {
  const base = mkdtempSync(join(tmpdir(), "forge session admission "));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "repo"),
    home = join(base, "home");
  mkdirSync(join(root, ".git"), { recursive: true });
  const project = (
    await createProjectStore(home).create(
      {
        slug: "alpha",
        name: "Alpha",
        description: "",
        icon: "A",
        workspaces: [{ root, repositories: [root], epicIds: ["alpha-1"] }],
      },
      0,
    )
  ).projects[0]!;
  let runs = 0,
    checks = 0,
    valid = true,
    mutatePreparation = false;
  const events: LedgerEventInput[] = [];
  const recordMetadata = createOwnedSessionLedger(home, {
    appendEvent(event) {
      events.push(event);
      return { ok: true, id: events.length, ulid: "fixture" };
    },
  });
  const flags = [
    "--print",
    "--input-format",
    "--output-format",
    "--verbose",
    "--include-partial-messages",
    "--model",
    "--permission-mode",
    "--permission-prompts",
    "--allowedTools",
    "--resume",
  ];
  const service = createOwnedSessionService({
    root,
    home,
    onChange: recordMetadata,
    async validateScope() {
      checks++;
      if (!valid) throw Error("Current scope unavailable");
    },
    runtime: {
      provider: "claude",
      async prepare({ smith, cwd, launch }) {
        return {
          version: 1,
          provider: "claude",
          smith,
          cwd,
          launch: mutatePreparation
            ? { ...launch, model: "unreviewed" }
            : launch,
          capabilities: { version: "2.1.296", flags },
        };
      },
      async run(request, persist) {
        runs++;
        await persist({
          kind: "process",
          pid: 4242,
          smith: "coding",
          requestedModel: "sonnet",
          requestedEffort: "default",
        });
        await persist({
          kind: "model",
          model: "actual-observed-model",
        });
        await persist({
          kind: "identity",
          provider: "claude",
          sessionId: "6427faae-19c8-454d-84ce-c4ea55288cc9",
          version: "2.1.296",
        });
        await persist({ kind: "text", text: `Reply ${request.input.text}` });
        return { phase: "completed", reason: null };
      },
    },
  });
  cleanup.push(() => service.close());
  const request = {
    requestId: randomUUID(),
    smith: "coding",
    repository: root,
    worktree: root,
    about: [{ kind: "bead" as const, id: "alpha-1" }],
    launch: {
      mode: "chat" as const,
      model: "sonnet",
      prompt: "  Private first turn\n",
      attachments: [
        {
          kind: "text" as const,
          name: "context.txt",
          text: "Private attachment body",
        },
      ],
    },
  };
  const [a, b] = await Promise.all([
    service.start(project.id, request),
    service.start(project.id, request),
  ]);
  expect(a.session.id).toBe(b.session.id);
  await service.settled(project.id, a.session.id);
  expect(runs).toBe(1);
  valid = false;
  const before = checks;
  const retry = await service.start(project.id, request);
  expect(retry.receipt.turn.phase).toBe("completed");
  expect(checks).toBe(before);
  expect(runs).toBe(1);
  await expect(
    service.start(project.id, {
      ...request,
      launch: { ...request.launch, prompt: "changed" },
    }),
  ).rejects.toThrow("different content");
  const page = await service.read(project.id, a.session.id);
  expect(page.frames[0]?.event).toMatchObject({
    kind: "user",
    text: request.launch.prompt,
    session: { launch: { prompt: request.launch.prompt } },
  });
  const user = page.frames[0]?.event;
  if (user?.kind !== "user" || !user.session)
    throw Error("Missing private launch");
  const stdin = serializeClaudeLaunch(
    user.session.launch,
    user.session.capabilities,
  ).stdin;
  const promptEvent = events.find((event) => event.kind === "prompt.submitted");
  expect(promptEvent?.payload).toEqual({
    hash: createHash("sha256").update(stdin).digest("hex"),
    length: stdin.length,
  });
  expect(events.map((event) => event.kind)).toEqual([
    "session.started",
    "prompt.submitted",
    "session.ended",
  ]);
  expect(events.every((event) => event.sessionId === a.session.id)).toBe(true);
  expect(events.at(-1)?.executor?.sessionId).toBe(
    "6427faae-19c8-454d-84ce-c4ea55288cc9",
  );
  expect(JSON.stringify(events)).not.toContain("Private first turn");
  expect(JSON.stringify(events)).not.toContain("Private attachment body");
  valid = true;
  mutatePreparation = true;
  await expect(
    service.start(project.id, { ...request, requestId: randomUUID() }),
  ).rejects.toThrow("reviewed session options");
  expect(runs).toBe(1);
});
