import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectStore } from "../projects/store";
import { conversationFile } from "./paths";
import { createConversationService } from "./service";
import { parseConversationSend } from "./store";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
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

test("an owned session prepares and privately freezes its exact launch once; retries reconcile before mutable preparation", async () => {
  const base = mkdtempSync(join(tmpdir(), "forge prepared session "));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home"),
    root = join(base, "repo");
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
  const address = {
    kind: "session" as const,
    projectId: project.id,
    sessionId: `session-${randomUUID()}`,
  };
  let preparations = 0,
    runs = 0,
    unavailable = false;
  const service = createConversationService({
    home,
    root,
    address,
    async prepareSession({ input }) {
      preparations++;
      if (unavailable) throw new Error("Current config is unavailable");
      return {
        version: 1 as const,
        provider: "claude" as const,
        smith: "coding",
        cwd: root,
        launch: {
          mode: "chat" as const,
          model: "sonnet",
          prompt: input.text,
          attachments: input.attachments,
        },
        capabilities: { version: "2.1.296", flags },
      };
    },
    transport: {
      provider: "claude",
      async run(request, persist) {
        runs++;
        expect(request.input.session?.launch.prompt).toBe(
          "  exact private prompt\n",
        );
        await persist({
          kind: "identity",
          provider: "claude",
          sessionId: "c9ae9bf0-a0b4-49b0-9744-3062a8f541fd",
          version: "2.1.296",
        });
        await persist({ kind: "text", text: "Reply" });
        return { phase: "completed", reason: null };
      },
    },
  });
  cleanup.push(() => service.close());
  const input = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "  exact private prompt\n",
    about: [],
    attachments: [
      {
        kind: "text" as const,
        name: "context.txt",
        text: "Private attached text",
      },
    ],
  };
  await service.send(project.id, input);
  await service.settled(project.id);
  expect(preparations).toBe(1);
  expect(runs).toBe(1);
  const saved = await service.read(project.id);
  expect(saved.frames[0]?.event).toMatchObject({
    kind: "user",
    text: input.text,
    session: { launch: { prompt: input.text } },
  });
  expect(
    readFileSync(conversationFile(home, project.id, address), "utf8"),
  ).toContain("exact private prompt");
  unavailable = true;
  expect((await service.send(project.id, input)).turn.phase).toBe("completed");
  expect(preparations).toBe(1);
  expect(runs).toBe(1);
  await expect(
    service.send(project.id, { ...input, text: "changed" }),
  ).rejects.toThrow("different content");
  await expect(
    service.send(project.id, { ...input, attachments: [] }),
  ).rejects.toThrow("different content");
  expect(() =>
    parseConversationSend({ ...input, session: saved.frames[0]?.event }),
  ).toThrow();
});
