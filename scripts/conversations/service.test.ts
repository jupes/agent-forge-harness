import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectStore } from "../projects/store";
import { createConversationService } from "./service";
import { createConversationStore } from "./store";
import type { ConversationTransport, ConversationUpdate } from "./transport";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "forge-conversation-service-"));
  const home = join(base, "home");
  const root = join(base, "checkout");
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
      workspaces: [{ root, repositories: [root], epicIds: ["alpha-epic"] }],
    },
    0,
  );
  const projectId = catalog.projects[0]?.id;
  if (!projectId) throw new Error("Missing fixture project");
  return { home, root, projectId };
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error("Conversation did not reach the expected state");
    await Bun.sleep(5);
  }
}

test("two service instances share one dispatch lease and duplicate requests do not start another provider", async () => {
  const { home, root, projectId } = await fixture();
  const calls: Array<string | null> = [];
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updates: ConversationUpdate[] = [];
  const transport: ConversationTransport = {
    provider: "claude",
    async run(request, sink, signal) {
      calls.push(request.resume?.sessionId ?? null);
      await sink({
        kind: "identity",
        provider: "claude",
        sessionId: "actual-provider-session",
        version: "fixture-1",
      });
      await sink({ kind: "text", text: "Private partial answer" });
      await Promise.race([
        waiting,
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      return { phase: "completed", reason: null };
    },
  };
  const first = createConversationService({
    home,
    root,
    transport,
    onChange: (update) => {
      updates.push(update);
    },
  });
  const second = createConversationService({ home, root, transport });
  cleanup.push(
    () => first.close(),
    () => second.close(),
  );
  const request = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "Private prompt",
    about: [],
  };
  const accepted = await first.send(projectId, request);
  expect(accepted.turn.phase).toBe("running");
  await until(async () =>
    (await second.read(projectId)).frames.some(
      (frame) => frame.event.kind === "text",
    ),
  );
  expect((await second.read(projectId)).turns.at(-1)?.phase).toBe("running");
  expect((await second.send(projectId, request)).turn.requestId).toBe(
    request.requestId,
  );
  const competing = second.send(projectId, {
    ...request,
    requestId: randomUUID(),
  });
  // Handle the expected rejection without waiting for admission to settle.
  const refused = competing.then(
    () => null,
    (error) => error,
  );
  await Bun.sleep(0);
  expect((await second.read(projectId)).controllable).toBe(false);
  await expect(second.stop(projectId, request.requestId)).rejects.toThrow(
    "does not own",
  );
  expect(await refused).toBeInstanceOf(Error);
  expect(calls).toEqual([null]);
  release();
  await first.settled(projectId);
  const page = await second.read(projectId, {
    after: 1,
    limit: 1,
    requestId: request.requestId,
  });
  expect(page.frames).toHaveLength(1);
  expect(page.more).toBe(true);
  expect(page.request?.phase).toBe("completed");
  expect(JSON.stringify(updates)).not.toContain("Private");
  const continued = await second.send(projectId, {
    ...request,
    requestId: randomUUID(),
    expectedRevision: page.revision,
  });
  await second.settled(projectId);
  expect(continued.turn.requestId).not.toBe(request.requestId);
  expect(calls).toEqual([null, "actual-provider-session"]);
});

test("a live foreign process keeps its lease; killing it preserves partial output and never replays delivery", async () => {
  const { home, root, projectId } = await fixture();
  const requestId = randomUUID();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "lease-holder.ts"),
      home,
      root,
      projectId,
      requestId,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  cleanup.push(async () => {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
  });
  const store = createConversationStore(home);
  await until(async () =>
    store.read(projectId).frames.some((frame) => frame.event.kind === "text"),
  );
  let localStarts = 0;
  const local = createConversationService({
    home,
    root,
    transport: {
      provider: "claude",
      async run() {
        localStarts++;
        return { phase: "completed", reason: null };
      },
    },
  });
  cleanup.push(() => local.close());
  expect((await local.read(projectId)).turns.at(-1)?.phase).toBe("running");
  await expect(
    local.send(projectId, {
      requestId: randomUUID(),
      expectedRevision: store.read(projectId).revision,
      text: "Competing turn",
      about: [],
    }),
  ).rejects.toThrow("Another hearth");
  expect(localStarts).toBe(0);
  child.kill("SIGKILL");
  await child.exited;
  const recovered = await local.read(projectId, { requestId });
  expect(recovered.request?.phase).toBe("unknown");
  expect(store.read(projectId).turns.at(-1)?.phase).toBe("running"); // GET only derives the interrupted view.
  expect(recovered.frames.at(-1)?.event).toEqual({
    kind: "text",
    text: "Partial output from the other process",
  });
  await expect(
    local.send(projectId, {
      requestId: randomUUID(),
      expectedRevision: recovered.revision,
      text: "Must not replay",
      about: [],
    }),
  ).rejects.toThrow("outcome is unknown");
  expect(localStarts).toBe(0);
});

test("stop stays pending until transport termination and a late success settles as cancelled", async () => {
  const { home, root, projectId } = await fixture();
  let terminate = () => {};
  const termination = new Promise<void>((resolve) => {
    terminate = resolve;
  });
  const service = createConversationService({
    home,
    root,
    transport: {
      provider: "claude",
      async run(_request, persist) {
        await persist({
          kind: "identity",
          provider: "claude",
          sessionId: "fixture-cancelled",
          version: "fixture-1",
        });
        await persist({ kind: "text", text: "Keep this partial answer" });
        await termination;
        return { phase: "completed", reason: null };
      },
    },
  });
  cleanup.push(async () => {
    terminate();
    await service.close();
  });
  const requestId = randomUUID();
  await service.send(projectId, {
    requestId,
    expectedRevision: 0,
    text: "Question",
    about: [],
  });
  await until(async () =>
    (await service.read(projectId)).frames.some(
      (frame) => frame.event.kind === "text",
    ),
  );
  expect((await service.stop(projectId, requestId)).turn.phase).toBe(
    "cancelling",
  );
  await expect(
    service.send(projectId, {
      requestId: randomUUID(),
      expectedRevision: (await service.read(projectId)).revision,
      text: "Another turn",
      about: [],
    }),
  ).rejects.toThrow();
  terminate();
  await service.settled(projectId);
  const ended = await service.read(projectId, { requestId });
  expect(ended.request?.phase).toBe("cancelled");
  expect(ended.frames.at(-1)?.event).toEqual({
    kind: "text",
    text: "Keep this partial answer",
  });
});

test("simultaneous copies of one send share the admitted request and start once", async () => {
  const { home, root, projectId } = await fixture();
  let starts = 0;
  const service = createConversationService({
    home,
    root,
    transport: {
      provider: "claude",
      async run(_request, persist) {
        starts++;
        await persist({
          kind: "identity",
          provider: "claude",
          sessionId: "fixture-concurrent",
          version: "fixture-1",
        });
        return { phase: "completed", reason: null };
      },
    },
  });
  cleanup.push(() => service.close());
  const input = {
    requestId: randomUUID(),
    expectedRevision: 0,
    text: "One approved turn",
    about: [],
  };
  const copies = await Promise.all([
    service.send(projectId, input),
    service.send(projectId, input),
  ]);
  expect(copies.map((copy) => copy.turn.requestId)).toEqual([
    input.requestId,
    input.requestId,
  ]);
  await service.settled(projectId);
  expect(starts).toBe(1);
  expect((await service.read(projectId)).turns).toHaveLength(1);
});

test("completion without this turn's identity stays unknown and closing during preflight cannot dispatch", async () => {
  const { home, root, projectId } = await fixture();
  const service = createConversationService({
    home,
    root,
    transport: {
      provider: "claude",
      async run() {
        return { phase: "completed", reason: null };
      },
    },
  });
  cleanup.push(() => service.close());
  const requestId = randomUUID();
  await service.send(projectId, {
    requestId,
    expectedRevision: 0,
    text: "No identity was observed",
    about: [],
  });
  await service.settled(projectId);
  expect((await service.read(projectId, { requestId })).request?.phase).toBe(
    "unknown",
  );

  const next = await fixture();
  let ready = () => {};
  const preflight = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let starts = 0;
  const closing = createConversationService({
    ...next,
    transport: {
      provider: "claude",
      async check() {
        await preflight;
      },
      async run() {
        starts++;
        return { phase: "completed", reason: null };
      },
    },
  });
  cleanup.push(() => closing.close());
  const pending = closing
    .send(next.projectId, {
      requestId: randomUUID(),
      expectedRevision: 0,
      text: "Closing before dispatch",
      about: [],
    })
    .then(
      () => null,
      (error) => error,
    );
  await closing.close();
  ready();
  expect(await pending).toBeInstanceOf(Error);
  expect(starts).toBe(0);
  expect(createConversationStore(next.home).read(next.projectId).turns).toEqual(
    [],
  );
});
