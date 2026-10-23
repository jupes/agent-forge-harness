import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Smith } from "../../types/hearth";
import { createConversationService } from "../conversations/service";
import { createConversationStore } from "../conversations/store";
import type { ConversationTransport } from "../conversations/transport";
import { createProjectStore } from "../projects/store";
import { keeperReadiness } from "./readiness";
import type { KeeperRuntime } from "./recovery-runtime";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "keeper-recovery-service-")),
    home = join(base, "home"),
    root = join(base, "root");
  mkdirSync(join(root, ".git"), { recursive: true });
  cleanup.push(async () => {
    rmSync(base, { recursive: true, force: true });
  });
  const catalog = await createProjectStore(home).create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [{ root, repositories: [root], epicIds: ["alpha"] }],
    },
    0,
  );
  const id = catalog.projects[0]?.id;
  if (!id) throw new Error("Missing fixture project");
  const smiths: Smith[] = [
    {
      name: "old",
      provider: "claude",
      model: "fixture",
      effort: "high",
      enabled: true,
      tags: [],
    },
    {
      name: "new",
      provider: "codex",
      model: "fixture",
      effort: "medium",
      enabled: true,
      tags: [],
    },
    {
      name: "disabled",
      provider: "claude",
      model: "fixture",
      effort: "high",
      enabled: false,
      tags: [],
    },
  ];
  const starts: {
    provider: string;
    resume: string | null;
    text: string;
    smith: string | undefined;
  }[] = [];
  let available = true,
    configuration = true;
  const adapter = (provider: "claude" | "codex"): ConversationTransport => ({
    provider,
    async run(request, persist) {
      starts.push({
        provider,
        resume: request.resume?.sessionId ?? null,
        text: request.input.text,
        smith: request.smith,
      });
      await persist({
        kind: "identity",
        provider,
        sessionId: request.resume?.sessionId ?? randomUUID(),
        version: "fixture",
      });
      await persist({ kind: "text", text: "Actual retained answer" });
      return { phase: "completed", reason: null };
    },
  });
  const claude = adapter("claude"),
    codex = adapter("codex");
  const runtime: KeeperRuntime = {
    catalog() {
      if (!configuration) throw new Error("Configuration unavailable");
      return { defaultSmith: "old", smiths };
    },
    transport(smith) {
      return smith.provider === "claude" ? claude : codex;
    },
    async readiness() {
      return keeperReadiness({
        adapter: true,
        checked: true,
        ...(available ? {} : { connection: "signed-out" }),
      });
    },
  };
  const service = createConversationService({
    home,
    root,
    transport: claude,
    keeperRuntime: runtime,
  });
  cleanup.push(() => service.close());
  const store = createConversationStore(home);
  const send = async (text: string) => {
    await service.send(id, {
      requestId: randomUUID(),
      expectedRevision: store.read(id).revision,
      text,
      about: [],
    });
    await service.settled(id);
  };
  return {
    home,
    root,
    id,
    service,
    store,
    starts,
    send,
    unavailable: () => {
      available = false;
    },
    removeConfig: () => {
      configuration = false;
    },
  };
}

test("explicit cross-provider continuation passes only the reviewed summary and never another provider's native id", async () => {
  const f = await fixture();
  await f.send("Original question");
  const before = f.store.read(f.id),
    oldBinding = before.binding;
  const input = {
    requestId: randomUUID(),
    expectedRevision: before.revision,
    mode: "switch" as const,
    smith: "new",
    summary: "Keep the operator-reviewed decision.",
  };
  const result = await f.service.continueKeeper(f.id, input);
  expect(result.previousBinding).toEqual(oldBinding);
  expect(result.resumed).toBe(false);
  expect(f.starts).toHaveLength(1);
  await f.send("Next question");
  expect(f.starts[1]).toMatchObject({
    provider: "codex",
    resume: null,
    smith: "new",
  });
  expect(f.starts[1]?.text).toContain(input.summary);
  expect(f.store.read(f.id).frames.slice(0, before.frames.length)).toEqual(
    before.frames,
  );
  const newBinding = f.store.read(f.id).binding?.sessionId;
  await f.send("Another question");
  expect(f.starts[2]).toMatchObject({
    provider: "codex",
    resume: newBinding,
    text: "Another question",
  });
  f.removeConfig();
  expect(await f.service.continueKeeper(f.id, input)).toEqual(result);
});

test("readiness is rechecked before a switch and refusal preserves selection, transcript and native identity", async () => {
  const f = await fixture();
  await f.send("Keep this context");
  expect((await f.service.recovery(f.id)).choices[1]?.readiness.canStart).toBe(
    true,
  );
  const before = f.store.read(f.id);
  f.unavailable();
  await expect(
    f.service.continueKeeper(f.id, {
      requestId: randomUUID(),
      expectedRevision: before.revision,
      mode: "switch",
      smith: "new",
      summary: "Reviewed",
    }),
  ).rejects.toThrow("signed out");
  expect(f.store.read(f.id)).toEqual(before);
  expect(f.starts).toHaveLength(1);
  await expect(
    f.service.send(f.id, {
      requestId: randomUUID(),
      expectedRevision: before.revision,
      text: "Do not start",
      about: [],
    }),
  ).rejects.toThrow("signed out");
  expect(f.starts).toHaveLength(1);
});

test("unknown and disabled smiths refuse without fallback, and Start fresh requires exact reviewed context", async () => {
  const f = await fixture();
  await f.send("Keep this context");
  const before = f.store.read(f.id);
  const input = {
    requestId: randomUUID(),
    expectedRevision: before.revision,
    mode: "fresh" as const,
    smith: "old",
    summary: "",
  };
  for (const smith of ["missing", "disabled"])
    await expect(
      f.service.continueKeeper(f.id, { ...input, smith }),
    ).rejects.toThrow("unknown or disabled");
  await expect(f.service.continueKeeper(f.id, input)).rejects.toThrow(
    "retain a summary",
  );
  expect(f.store.read(f.id)).toEqual(before);
  const completed = await f.service.continueKeeper(f.id, {
    ...input,
    summary: "This is the retained summary, exactly.",
  });
  expect(completed.summary).toBe("This is the retained summary, exactly.");
  expect(f.starts).toHaveLength(1);
});
