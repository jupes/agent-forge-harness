import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectStore } from "../projects/store";
import { conversationFile, conversationLeaseFile } from "./paths";
import { createConversationService } from "./service";
import { createConversationStore } from "./store";
import type { ConversationTransport } from "./transport";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "forge owned conversations "));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home"),
    root = join(base, "checkout");
  mkdirSync(join(root, ".git"), { recursive: true });
  const catalog = await createProjectStore(home).create(
    {
      slug: "alpha",
      name: "Alpha",
      description: "",
      icon: "A",
      workspaces: [{ root, repositories: [root], epicIds: ["alpha-epic"] }],
    },
    0,
  );
  const projectId = catalog.projects[0]!.id;
  return { home, root, projectId };
}
const address = (projectId: string) => ({
  kind: "session" as const,
  projectId,
  sessionId: `session-${randomUUID()}`,
});
const turn = (expectedRevision = 0) => ({
  requestId: randomUUID(),
  expectedRevision,
  text: "Private owned-session message",
  about: [],
});

test("two owned sessions in one project have independent journals and provider leases, while Keeper retains its original file and identity", async () => {
  const { home, projectId } = await fixture(),
    a = address(projectId),
    b = address(projectId);
  const first = createConversationStore(home, undefined, a),
    second = createConversationStore(home, undefined, b),
    keeper = createConversationStore(home);
  const request = turn();
  await first.accept(projectId, request);
  expect(first.read(projectId).conversationId).toBe(a.sessionId);
  expect(second.read(projectId).conversationId).toBe(b.sessionId);
  expect(second.read(projectId).turns).toEqual([]);
  expect(keeper.read(projectId).turns).toEqual([]);
  expect(keeper.read(projectId).conversationId).toBe(`keeper-${projectId}`);
  expect(conversationFile(home, projectId)).toBe(
    join(home, "conversations", `keeper-${projectId}.json`),
  );
  expect(conversationFile(home, projectId, a)).not.toBe(
    conversationFile(home, projectId, b),
  );
  expect(conversationLeaseFile(home, projectId, a)).not.toBe(
    conversationLeaseFile(home, projectId, b),
  );
  expect(
    createConversationStore(home, undefined, a).read(projectId).turns[0]
      ?.requestId,
  ).toBe(request.requestId);
  const foreign = `project-${randomUUID()}`;
  await expect(
    createConversationStore(home, undefined, {
      ...a,
      projectId: foreign,
    }).accept(foreign, turn()),
  ).rejects.toThrow("invalid");
  expect(first.read(projectId).turns[0]?.requestId).toBe(request.requestId);
});

test("an owned address refuses foreign projects and malformed ids before any transcript operation", async () => {
  const { home, projectId } = await fixture(),
    a = address(projectId);
  const store = createConversationStore(home, undefined, a);
  expect(() => store.read(`project-${randomUUID()}`)).toThrow("project");
  expect(() =>
    createConversationStore(home, undefined, {
      ...a,
      sessionId: "../escape",
    }).read(projectId),
  ).toThrow("session");
  await expect(store.accept(`project-${randomUUID()}`, turn())).rejects.toThrow(
    "project",
  );
  expect(store.read(projectId).revision).toBe(0);
});

test("separate owned conversations use the same tested service lifecycle and resume only their own actual provider binding", async () => {
  const { home, root, projectId } = await fixture(),
    a = address(projectId),
    b = address(projectId);
  const calls: Array<{ owner: string; resume: string | null }> = [];
  const transport = (id: string): ConversationTransport => ({
    provider: "claude",
    async run(request, persist) {
      calls.push({ owner: id, resume: request.resume?.sessionId ?? null });
      await persist({
        kind: "identity",
        provider: "claude",
        sessionId: id,
        version: "fixture",
      });
      await persist({ kind: "text", text: `Reply for ${id}` });
      return { phase: "completed", reason: null };
    },
  });
  const first = createConversationService({
      home,
      root,
      address: a,
      transport: transport("actual-a"),
    }),
    second = createConversationService({
      home,
      root,
      address: b,
      transport: transport("actual-b"),
    });
  cleanup.push(
    () => first.close(),
    () => second.close(),
  );
  await Promise.all([
    first.send(projectId, turn()),
    second.send(projectId, turn()),
  ]);
  await Promise.all([first.settled(projectId), second.settled(projectId)]);
  const saved = await first.read(projectId);
  await first.send(projectId, turn(saved.revision));
  await first.settled(projectId);
  expect(calls.filter((call) => call.owner === "actual-a")).toEqual([
    { owner: "actual-a", resume: null },
    { owner: "actual-a", resume: "actual-a" },
  ]);
  expect(calls.filter((call) => call.owner === "actual-b")).toEqual([
    { owner: "actual-b", resume: null },
  ]);
  expect((await second.read(projectId)).turns).toHaveLength(1);
  expect((await first.read(projectId)).turns).toHaveLength(2);
  expect(createConversationStore(home).read(projectId).frames).toHaveLength(0);
});

test("copies of one owned session share its dispatch lease while a second session remains independent", async () => {
  const { home, root, projectId } = await fixture(),
    a = address(projectId),
    b = address(projectId);
  let starts = 0,
    signalReady = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const transport: ConversationTransport = {
    provider: "claude",
    async run(_request, persist, signal) {
      starts++;
      await persist({
        kind: "identity",
        provider: "claude",
        sessionId: `actual-${starts}`,
        version: "fixture",
      });
      await persist({ kind: "text", text: "Partial private response" });
      signalReady();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { phase: "completed", reason: null };
    },
  };
  const first = createConversationService({
      home,
      root,
      address: a,
      transport,
    }),
    copy = createConversationService({ home, root, address: a, transport }),
    independent = createConversationService({
      home,
      root,
      address: b,
      transport,
    });
  cleanup.push(
    () => first.close(),
    () => copy.close(),
    () => independent.close(),
  );
  const original = turn();
  await first.send(projectId, original);
  await ready;
  expect((await copy.read(projectId)).controllable).toBe(false);
  await expect(copy.stop(projectId, original.requestId)).rejects.toThrow(
    "does not own",
  );
  expect((await copy.send(projectId, original)).turn.requestId).toBe(
    original.requestId,
  );
  expect(starts).toBe(1);
  await independent.send(projectId, turn());
  await first.stop(projectId, original.requestId);
  await first.settled(projectId);
  expect((await copy.read(projectId)).turns[0]?.phase).toBe("cancelled");
  const other = await independent.read(projectId);
  expect(other.controllable).toBe(true);
  expect(other.turns[0]?.phase).toBe("running");
});
