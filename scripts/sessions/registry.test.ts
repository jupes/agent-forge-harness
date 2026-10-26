import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OwnedSessionMetadata,
  OwnedSessionRecord,
} from "../../types/owned-session";
import { assertOwnerOnly } from "../hearth/acl-windows";
import { writeOwnerOnly } from "../hearth/token";
import {
  createSessionRegistry,
  MAX_OWNED_SESSIONS,
  MAX_SESSION_REGISTRY_BYTES,
  sessionRegistryFile,
} from "./registry";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

test("separate processes share one reservation lock and only one prepares the exact Start", async () => {
  const { home, projectId, metadata, registry } = fixture();
  const requestId = randomUUID(),
    requestHash = "f".repeat(64);
  const script = `
    import {createSessionRegistry} from ${JSON.stringify(join(import.meta.dir, "registry.ts"))};
    let prepared = false;
    const record = await createSessionRegistry(${JSON.stringify(home)}).reserve(
      ${JSON.stringify(projectId)},${JSON.stringify(requestId)},${JSON.stringify(requestHash)},
      async () => {
        prepared = true;
        await Bun.sleep(100);
        return ${JSON.stringify(metadata)};
      },
    );
    console.log(JSON.stringify({record,prepared}));
  `;
  const children = Array.from({ length: 3 }, () =>
    Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    }),
  );
  const outcomes = await Promise.all(
    children.map(async (child) => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      let value: { record: OwnedSessionRecord; prepared: boolean };
      try {
        value = JSON.parse(stdout);
      } catch {
        throw Error("Invalid registry child result");
      }
      return value;
    }),
  );
  expect(outcomes.filter((outcome) => outcome.prepared)).toHaveLength(1);
  expect(new Set(outcomes.map((outcome) => outcome.record.id)).size).toBe(1);
  expect(registry.list(projectId)).toEqual([outcomes[0]!.record]);
}, 15_000);

test("concurrent exact Starts reserve one identity and changed or foreign requests cannot prepare a second one", async () => {
  const { home, projectId, metadata, registry } = fixture();
  const requestId = randomUUID(),
    requestHash = "a".repeat(64);
  let calls = 0,
    entered = () => {},
    release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepare = async () => {
    calls++;
    entered();
    await gate;
    return metadata;
  };
  const first = registry.reserve(projectId, requestId, requestHash, prepare);
  await started;
  expect(registry.list(projectId)).toEqual([]);
  const second = createSessionRegistry(home).reserve(
    projectId,
    requestId,
    requestHash,
    prepare,
  );
  release();
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b);
  expect(calls).toBe(1);
  const forbidden = async () => {
    calls++;
    return metadata;
  };
  await expect(
    registry.reserve(projectId, requestId, "b".repeat(64), forbidden),
  ).rejects.toMatchObject({ status: 409 });
  const foreign = `project-${randomUUID()}`;
  await expect(
    registry.reserve(foreign, requestId, requestHash, forbidden),
  ).rejects.toMatchObject({ status: 409 });
  expect(() => registry.read(foreign, a.id)).toThrow("different project");
  expect(calls).toBe(1);
  expect(registry.list(projectId)).toEqual([a]);
  expect(registry.list(foreign)).toEqual([]);
});

test("refused preparation leaves no reservation and independent Starts retain only their own metadata", async () => {
  const { home, projectId, metadata, registry } = fixture();
  const requestId = randomUUID(),
    requestHash = "c".repeat(64);
  await expect(
    registry.reserve(projectId, requestId, requestHash, async () => {
      throw new Error("Scope validation refused the Start");
    }),
  ).rejects.toThrow("Scope validation refused");
  expect(registry.list(projectId)).toEqual([]);
  expect(existsSync(sessionRegistryFile(home))).toBe(false);
  const first = await registry.reserve(
    projectId,
    requestId,
    requestHash,
    async () => metadata,
  );
  const { beadId: _bead, ...withoutBead } = metadata;
  const second = await registry.reserve(
    projectId,
    randomUUID(),
    "d".repeat(64),
    async () => ({ ...withoutBead, mode: "task", requestedEffort: null }),
  );
  const foreign = `project-${randomUUID()}`;
  const other = await registry.reserve(
    foreign,
    randomUUID(),
    "e".repeat(64),
    async () => metadata,
  );
  expect(second.id).not.toBe(first.id);
  expect(second.mode).toBe("task");
  expect(second.requestedEffort).toBeNull();
  expect(second.beadId).toBeUndefined();
  expect(registry.list(projectId)).toEqual([first, second]);
  expect(registry.list(foreign)).toEqual([other]);
  expect(() => registry.read(projectId, `session-${randomUUID()}`)).toThrow(
    "not in the registry",
  );
  let saved: { version: number; records: Record<string, unknown>[] };
  try {
    saved = JSON.parse(readFileSync(sessionRegistryFile(home), "utf8"));
  } catch {
    throw new Error("Invalid saved registry");
  }
  expect(Object.keys(saved)).toEqual(["version", "records"]);
  expect(Object.keys(saved.records[0]!).sort()).toEqual(
    [
      "beadId",
      "createdAt",
      "id",
      "mode",
      "projectId",
      "provider",
      "repository",
      "requestHash",
      "requestId",
      "requestedEffort",
      "requestedModel",
      "smith",
      "workspace",
      "worktree",
    ].sort(),
  );
  if (process.platform === "win32")
    expect(() =>
      assertOwnerOnly(sessionRegistryFile(home), "file"),
    ).not.toThrow();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "forge owned session registry "));
  homes.push(home);
  const projectId = `project-${randomUUID()}`;
  const metadata: OwnedSessionMetadata = {
    mode: "chat",
    provider: "claude",
    workspace: join(home, "workspace"),
    repository: join(home, "workspace", "repo"),
    worktree: join(home, "workspace", "tree"),
    beadId: "alpha-1",
    smith: "claude-journeyman",
    requestedModel: "claude-sonnet-5-5",
    requestedEffort: "high",
  };
  return { home, projectId, metadata, registry: createSessionRegistry(home) };
}

test("a reserved Start retains its metadata and stable session address after recreation without preparing again", async () => {
  const { home, projectId, metadata, registry } = fixture();
  const requestId = randomUUID(),
    requestHash = "a".repeat(64);
  expect(registry.list(projectId)).toEqual([]);
  const created = await registry.reserve(
    projectId,
    requestId,
    requestHash,
    async () => metadata,
  );
  expect(created).toMatchObject({
    ...metadata,
    projectId,
    requestId,
    requestHash,
  });
  expect(created.id).toMatch(/^session-[0-9a-f-]{36}$/);
  expect(Number.isFinite(Date.parse(created.createdAt))).toBe(true);
  const reopened = createSessionRegistry(home);
  expect(reopened.read(projectId, created.id)).toEqual(created);
  expect(reopened.list(projectId)).toEqual([created]);
  expect(
    await reopened.reserve(projectId, requestId, requestHash, async () => {
      throw new Error("Current mutable configuration is unavailable");
    }),
  ).toEqual(created);
});

test("request UUID lookup sees the full registry regardless of provider filter", async () => {
  const { home, projectId, metadata, registry } = fixture();
  const requestId = randomUUID();
  const record = await registry.reserve(
    projectId,
    requestId,
    "d".repeat(64),
    async () => metadata,
  );

  expect(
    createSessionRegistry(home, "codex").lookupRequestId(requestId),
  ).toEqual(record);
  expect(
    createSessionRegistry(home, "codex").lookupRequestId(randomUUID()),
  ).toBeNull();
});

test("invalid addresses, hashes and metadata are refused without admitting private launch bodies", async () => {
  const { home, projectId, metadata, registry } = fixture();
  let calls = 0;
  const prepare = async () => {
    calls++;
    return metadata;
  };
  for (const [project, request, hash] of [
    ["../foreign", randomUUID(), "a".repeat(64)],
    [projectId, "latest", "a".repeat(64)],
    [projectId, randomUUID(), "not-a-hash"],
  ])
    await expect(
      registry.reserve(project!, request!, hash!, prepare),
    ).rejects.toMatchObject({ status: 400 });
  expect(calls).toBe(0);
  for (const invalid of [
    { ...metadata, mode: "shell" },
    { ...metadata, provider: "codex" },
    { ...metadata, workspace: "relative/workspace" },
    ...(process.platform === "win32"
      ? [{ ...metadata, workspace: "\\implicit-drive" }]
      : []),
    { ...metadata, repository: metadata.repository + "/../other" },
    { ...metadata, worktree: "C:/private\npath" },
    { ...metadata, beadId: "../bead" },
    { ...metadata, requestedModel: "--permission-mode" },
    { ...metadata, requestedEffort: "unsupported" },
    { ...metadata, smith: "" },
    {
      ...metadata,
      prompt: "Private launch body must remain outside the registry",
    },
    { ...metadata, argv: ["--print"] },
    { ...metadata, stdin: "Private serialized request" },
    { ...metadata, createdAt: "forged" },
  ])
    await expect(
      Reflect.apply(registry.reserve, registry, [
        projectId,
        randomUUID(),
        "a".repeat(64),
        async () => invalid,
      ]),
    ).rejects.toMatchObject({ status: 400 });
  expect(() => registry.read(projectId, "../escape")).toThrow("session id");
  expect(() => registry.list("../project")).toThrow("project id");
  expect(registry.list(projectId)).toEqual([]);
  expect(existsSync(sessionRegistryFile(home))).toBe(false);
});

test("corrupt, future, duplicate and private-body-bearing registries are preserved before any preparation", async () => {
  const { home, projectId, metadata, registry } = fixture();
  const record = await registry.reserve(
    projectId,
    randomUUID(),
    "a".repeat(64),
    async () => metadata,
  );
  const file = sessionRegistryFile(home);
  for (const content of [
    "{",
    JSON.stringify({ version: 2, records: [record] }),
    JSON.stringify({ version: 1, records: [record, record] }),
    JSON.stringify({
      version: 1,
      records: [record, { ...record, id: `session-${randomUUID()}` }],
    }),
    JSON.stringify({
      version: 1,
      records: [{ ...record, prompt: "Saved private body" }],
    }),
    JSON.stringify({
      version: 1,
      records: [{ ...record, worktree: "relative" }],
    }),
    " ".repeat(MAX_SESSION_REGISTRY_BYTES + 1),
  ]) {
    writeOwnerOnly(file, content);
    let prepared = false;
    expect(() => registry.list(projectId)).toThrow();
    await expect(
      registry.reserve(projectId, randomUUID(), "b".repeat(64), async () => {
        prepared = true;
        return metadata;
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(prepared).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(content);
  }
});

test("the registry refuses linked directories, registry files and locks without altering their targets", async () => {
  const external = fixture(),
    record = await external.registry.reserve(
      external.projectId,
      randomUUID(),
      "a".repeat(64),
      async () => external.metadata,
    );
  const externalFile = sessionRegistryFile(external.home),
    original = readFileSync(externalFile, "utf8");
  const linkedDirectory = fixture();
  symlinkSync(
    join(external.home, "sessions"),
    join(linkedDirectory.home, "sessions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() => linkedDirectory.registry.list(external.projectId)).toThrow(
    "linked",
  );
  await expect(
    linkedDirectory.registry.reserve(
      external.projectId,
      randomUUID(),
      "b".repeat(64),
      async () => external.metadata,
    ),
  ).rejects.toThrow("linked");
  const linkedFile = fixture();
  writeOwnerOnly(sessionRegistryFile(linkedFile.home), "temporary");
  rmSync(sessionRegistryFile(linkedFile.home));
  symlinkSync(
    process.platform === "win32"
      ? join(external.home, "sessions")
      : externalFile,
    sessionRegistryFile(linkedFile.home),
    process.platform === "win32" ? "junction" : "file",
  );
  expect(() => linkedFile.registry.list(record.projectId)).toThrow();
  await expect(
    linkedFile.registry.reserve(
      record.projectId,
      randomUUID(),
      "b".repeat(64),
      async () => external.metadata,
    ),
  ).rejects.toThrow();
  const linkedLock = fixture();
  const lock = join(linkedLock.home, "sessions", "registry.lock.db");
  writeOwnerOnly(lock, "temporary");
  rmSync(lock);
  symlinkSync(
    process.platform === "win32"
      ? join(external.home, "sessions")
      : externalFile,
    lock,
    process.platform === "win32" ? "junction" : "file",
  );
  await expect(
    linkedLock.registry.reserve(
      record.projectId,
      randomUUID(),
      "c".repeat(64),
      async () => external.metadata,
    ),
  ).rejects.toThrow("linked");
  expect(readFileSync(externalFile, "utf8")).toBe(original);
});

test("full row and byte limits preserve every original Start identity instead of evicting records", async () => {
  const { home, projectId, metadata, registry } = fixture();
  const first = await registry.reserve(
      projectId,
      randomUUID(),
      "a".repeat(64),
      async () => metadata,
    ),
    file = sessionRegistryFile(home);
  const records = Array.from({ length: MAX_OWNED_SESSIONS }, (_, index) =>
    index === 0
      ? first
      : { ...first, id: `session-${randomUUID()}`, requestId: randomUUID() },
  );
  const content = JSON.stringify({ version: 1, records });
  writeOwnerOnly(file, content);
  let calls = 0;
  await expect(
    registry.reserve(projectId, randomUUID(), "b".repeat(64), async () => {
      calls++;
      return metadata;
    }),
  ).rejects.toThrow("full");
  expect(calls).toBe(0);
  expect(
    await registry.reserve(
      projectId,
      first.requestId,
      first.requestHash,
      async () => {
        throw Error("No revalidation");
      },
    ),
  ).toEqual(first);
  expect(registry.list(projectId)).toHaveLength(MAX_OWNED_SESSIONS);
  expect(readFileSync(file, "utf8")).toBe(content);

  const largeMetadata = {
    ...metadata,
    workspace: join(home, "w".repeat(850)),
    repository: join(home, "r".repeat(850)),
    worktree: join(home, "t".repeat(850)),
  };
  const large = { ...first, ...largeMetadata };
  const largeRecords = [large];
  for (;;) {
    const next = {
      ...large,
      id: `session-${randomUUID()}`,
      requestId: randomUUID(),
    };
    if (
      Buffer.byteLength(
        JSON.stringify({ version: 1, records: [...largeRecords, next] }),
      ) > MAX_SESSION_REGISTRY_BYTES
    )
      break;
    largeRecords.push(next);
  }
  const largeContent = JSON.stringify({ version: 1, records: largeRecords });
  writeOwnerOnly(file, largeContent);
  await expect(
    registry.reserve(
      projectId,
      randomUUID(),
      "c".repeat(64),
      async () => largeMetadata,
    ),
  ).rejects.toThrow("full");
  expect(readFileSync(file, "utf8")).toBe(largeContent);
  expect(registry.list(projectId)).toHaveLength(largeRecords.length);
});
