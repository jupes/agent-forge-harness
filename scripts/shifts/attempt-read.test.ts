import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ConversationState } from "../../types/conversation";
import { conversationFile } from "../conversations/paths";
import type { PrivateExecInput } from "../executors/private-capture";
import { writeOwnerOnly } from "../hearth/token";
import { resolveCheckout } from "../ledger/workspace";
import {
  createSessionRegistry,
  sessionRegistryFile,
} from "../sessions/registry";
import { scratchDirs } from "../test-scratch";
import { openShiftAttempt } from "./attempt-owner";
import { createProjectShiftAttemptReader } from "./attempt-read";
import { createProjectShiftRegistry } from "./registry";

const scratch = scratchDirs();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  scratch.cleanup();
});
const projectId = "project-05f27fd0-011b-4e0c-bb01-0da9104b1439";

async function fixture(provider: "claude" | "codex" = "claude") {
  const root = scratch.make("shift private reader ");
  mkdirSync(join(root, ".git"));
  const workspace = resolveCheckout(root).workspace,
    home = join(root, "home");
  const originals = createProjectShiftRegistry({ root, home });
  const request = {
    requestId: "2230bb02-1119-4c69-adad-c44116b375c1",
    expectedCatalogRevision: 3,
    options: {
      for: "2h",
      concurrency: 2,
      maxBeads: 4,
      maxUsd: 5,
      repairs: 1,
      base: "main",
    },
  };
  const reserved = await originals.reserve(projectId, request, async () => ({
    shiftId: "shift-20261023-080000-1234",
  }));
  await originals.markAttempted(
    projectId,
    request.requestId,
    reserved.intent.requestHash,
  );
  const { intent } = await originals.claimExecution(
    projectId,
    request.requestId,
    reserved.intent.requestHash,
  );
  const input: PrivateExecInput = {
    provider,
    beadId: "bounded-task-1",
    runId: "bounded-run-1",
    workspace,
    cwd: workspace,
    smith: {
      name: `${provider}-journeyman`,
      provider,
      model: "exact-model",
      effort: "medium",
      enabled: true,
      tags: [],
    },
    command: [`/fixture/${provider}`, "-p"],
    stdin: "  private first input 🌱\n",
    timeoutMs: 1000,
  };
  const opened = await openShiftAttempt({
    home,
    intent,
    input,
    attempt: 1,
    signal: new AbortController().signal,
    prepare: async () => ({
      version: provider === "claude" ? "2.1.296" : "0.163.0",
    }),
    validate: async () => {},
  });
  let finished = false;
  cleanup.push(async () => {
    if (!finished)
      await opened.owner.finish({
        phase: "failed",
        reason: "No provider was dispatched.",
      });
  });
  const finish = async () => {
    await opened.owner.append({
      kind: "process",
      pid: 123,
      smith: input.smith.name,
      requestedModel: input.smith.model,
      requestedEffort: input.smith.effort,
    });
    await opened.owner.append({
      kind: "identity",
      provider,
      sessionId:
        provider === "claude"
          ? "fixture-native-session"
          : "0199a213-81c0-7800-8aa1-bbab2a035a53",
      version: opened.snapshot.cliVersion,
    });
    for (let i = 0; i < 4; i++)
      await opened.owner.append({ kind: "text", text: `private answer ${i}` });
    await opened.owner.append({
      kind: "coding-outcome",
      provider,
      version: opened.snapshot.cliVersion,
      code: "completed",
      exitCode: 0,
      timedOut: false,
      stopped: false,
      message: null,
      stderrTail: { text: "", truncated: false },
    });
    await opened.owner.finish({ phase: "completed", reason: null });
    finished = true;
  };
  return {
    root,
    home,
    request,
    intent,
    input,
    opened,
    finish,
    reader: createProjectShiftAttemptReader({ root, home }),
    file: conversationFile(home, projectId, opened.address),
  };
}

test("private shift pages verify the immutable original and actual attempt, paginate without dispatch and expose no generic controls", async () => {
  for (const provider of ["claude", "codex"] as const) {
    const f = await fixture(provider);
    await f.finish();
    const bytes = readFileSync(f.file, "utf8"),
      registry = readFileSync(sessionRegistryFile(f.home), "utf8");
    const index = f.reader.list(projectId, f.request.requestId);
    expect(index.items).toHaveLength(1);
    expect(index.items[0]).toMatchObject({
      phase: "unknown",
      controllable: false,
      session: {
        id: f.opened.record.id,
        origin: { kind: "shift", runId: f.input.runId },
      },
    });
    expect(JSON.stringify(index)).not.toContain(f.input.stdin);
    const first = await f.reader.read(
      projectId,
      f.request.requestId,
      f.opened.record.id,
      { limit: 1, requestId: f.opened.record.requestId },
    );
    expect(first.controllable).toBe(false);
    expect(first.more).toBe(true);
    expect(first.request?.phase).toBe("completed");
    expect(first.frames[0]?.event).toMatchObject({
      kind: "user",
      text: f.input.stdin,
      shift: f.opened.snapshot,
    });
    const remainder = await createProjectShiftAttemptReader({
      root: f.root,
      home: f.home,
    }).read(projectId, f.request.requestId, f.opened.record.id, {
      after: first.nextCursor,
      limit: 100,
    });
    expect(remainder.frames).toHaveLength(7);
    expect(remainder.more).toBe(false);
    expect(remainder.binding?.provider).toBe(provider);
    expect(readFileSync(f.file, "utf8")).toBe(bytes);
    expect(readFileSync(sessionRegistryFile(f.home), "utf8")).toBe(registry);
  }
});

test("a missing or corrupted journal keeps its index metadata unknown and refuses every private body page without changing bytes", async () => {
  const f = await fixture();
  await f.finish();
  const original = readFileSync(f.file, "utf8");
  let state: unknown;
  try {
    state = JSON.parse(original);
  } catch {
    throw Error("Invalid fixture");
  }
  const valid: ConversationState = (
    await import("../sessions/codex-owned-journal")
  ).ownedCodingStateSchema.parse(state);
  for (const change of [
    "missing-user",
    "input-hash",
    "registry-hash",
    "snapshot-command",
    "native-binding",
    "missing-process",
    "missing-terminal",
  ]) {
    const changed = structuredClone(valid);
    if (change === "missing-user") {
      changed.frames.shift();
      changed.frames.forEach((frame, i) => {
        frame.seq = i + 1;
      });
    } else if (change === "input-hash") {
      if (changed.turns[0]) changed.turns[0].hash = "c".repeat(64);
    } else if (change === "snapshot-command") {
      const user = changed.frames[0]?.event;
      if (user?.kind !== "user" || !user.shift) throw Error("No fixture user");
      user.shift.command.push("--forged");
      if (changed.turns[0])
        changed.turns[0].hash = createHash("sha256")
          .update(
            JSON.stringify({
              text: user.text,
              about: user.about,
              shift: user.shift,
            }),
          )
          .digest("hex");
    } else if (change === "native-binding") {
      if (changed.binding) changed.binding.version = "2.1.295";
    } else if (change === "missing-process") {
      changed.frames.splice(1, 1);
      changed.frames.forEach((frame, i) => {
        frame.seq = i + 1;
      });
    } else if (change === "missing-terminal") {
      changed.frames.pop();
    }
    const registryFile = sessionRegistryFile(f.home),
      registry = readFileSync(registryFile, "utf8");
    if (change === "registry-hash")
      writeOwnerOnly(
        registryFile,
        registry.replace(f.opened.record.requestHash, "d".repeat(64)),
      );
    writeOwnerOnly(f.file, JSON.stringify(changed));
    const bytes = readFileSync(f.file, "utf8");
    try {
      expect(
        f.reader.list(projectId, f.request.requestId).items[0]?.phase,
      ).toBe("unknown");
      await expect(
        f.reader.read(projectId, f.request.requestId, f.opened.record.id, {
          after: 3,
          limit: 1,
        }),
      ).rejects.toThrow("could not be verified");
      expect(readFileSync(f.file, "utf8")).toBe(bytes);
    } finally {
      writeOwnerOnly(f.file, original);
      writeOwnerOnly(registryFile, registry);
    }
  }
});

test("foreign original, workspace and invalid page queries refuse before private history is returned", async () => {
  const f = await fixture();
  await f.finish();
  const bytes = readFileSync(f.file, "utf8");
  await expect(
    f.reader.read(
      projectId,
      "76c12d8a-a41c-41a3-a383-aac004d332e4",
      f.opened.record.id,
    ),
  ).rejects.toThrow("not in the private registry");
  const foreign = scratch.make("foreign shift hearth ");
  mkdirSync(join(foreign, ".git"));
  await expect(
    createProjectShiftAttemptReader({ root: foreign, home: f.home }).read(
      projectId,
      f.request.requestId,
      f.opened.record.id,
    ),
  ).rejects.toThrow("different project or workspace");
  for (const query of [{ after: -1 }, { limit: 101 }, { limit: 0 }])
    await expect(
      f.reader.read(projectId, f.request.requestId, f.opened.record.id, query),
    ).rejects.toThrow("cursor");
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
  expect(createSessionRegistry(f.home).listAll(projectId)).toHaveLength(1);
});

test("an index reservation whose journal is absent never grants a body read or recreates that journal", async () => {
  const f = await fixture();
  await f.finish();
  const saved = `${f.file}.saved`;
  renameSync(f.file, saved);
  const bytes = readFileSync(saved, "utf8");
  try {
    expect(f.reader.list(projectId, f.request.requestId).items[0]?.phase).toBe(
      "unknown",
    );
    await expect(
      f.reader.read(projectId, f.request.requestId, f.opened.record.id),
    ).rejects.toThrow("could not be verified");
    expect(readFileSync(saved, "utf8")).toBe(bytes);
  } finally {
    renameSync(saved, f.file);
  }
});

test("a live attempt lease preserves observation while an abandoned running record projects unknown without changing history", async () => {
  const f = await fixture();
  const live = await f.reader.read(
    projectId,
    f.request.requestId,
    f.opened.record.id,
  );
  expect(live.turns[0]?.phase).toBe("running");
  expect(live.controllable).toBe(false);
  await f.finish();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(f.file, "utf8"));
  } catch {
    throw Error("Invalid fixture");
  }
  const state = (
    await import("../sessions/codex-owned-journal")
  ).ownedCodingStateSchema.parse(raw);
  if (state.turns[0]) state.turns[0].phase = "running";
  writeOwnerOnly(f.file, JSON.stringify(state));
  const bytes = readFileSync(f.file, "utf8");
  const page = await f.reader.read(
    projectId,
    f.request.requestId,
    f.opened.record.id,
  );
  expect(page.turns[0]?.phase).toBe("unknown");
  expect(page.turns[0]?.reason).toContain("not resent");
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
});
