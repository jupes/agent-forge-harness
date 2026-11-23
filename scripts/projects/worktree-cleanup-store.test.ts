import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { scratchDirs } from "../test-scratch";
import { canonicalTrustedDirectory } from "../trusted-directory";
import {
  type CleanupRequest,
  canonicalCleanupRequest,
} from "./worktree-cleanup-protocol";
import {
  readWorktreeCleanupInventory,
  withWorktreeCleanupLease,
} from "./worktree-cleanup-store";

const scratch = scratchDirs();
const stamp = "2026-11-07T00:00:00.000Z";
afterEach(() => {
  closeLedger();
  scratch.cleanup();
});

function auditedOriginal(
  home: string,
  projectId: string,
  request: CleanupRequest,
) {
  const requestHash = createHash("sha256")
    .update(canonicalCleanupRequest(projectId, request))
    .digest("hex");
  const audit = appendEvent(
    {
      kind: "operator.action",
      workspace: request.repository,
      beadId: request.expectedRecord.beadId,
      payload: {
        action: "project.worktree.cleanup",
        surface: "ui",
        target: projectId,
        family: "project-worktree-cleanup",
        requestId: request.requestId,
        inputHash: requestHash,
      },
    },
    { path: join(home, "ledger.db"), now: () => new Date(stamp) },
  );
  if (!audit.ok || !("id" in audit)) throw Error("Expected a stored audit");
  return {
    version: 1 as const,
    projectId,
    request,
    requestHash,
    createdAt: stamp,
    audit: { eventId: audit.id, ulid: audit.ulid, ts: stamp },
  };
}

function fixture() {
  const home = canonicalTrustedDirectory(scratch.make("cleanup-store-"));
  ensurePrivateHome(home);
  const repository = join(home, "repo");
  ensurePrivateHome(repository);
  const projectId = "project-a1000000-0000-4000-8000-000000000001";
  const id = "shift-20261107-170000-0001-1";
  const request: CleanupRequest = {
    requestId: "a1000000-0000-4000-8000-000000000002",
    repository,
    expectedCatalogRevision: 1,
    expectedRecord: {
      id,
      path: join(repository, "trees", id),
      branch: "shift/shift-20261107-170000-0001/forge-test.1",
      createdAt: stamp,
      beadId: "forge-test.1",
    },
    expectedHead: "a".repeat(40),
  };
  const original = auditedOriginal(home, projectId, request);
  const row = {
    original,
    phase: "unknown" as const,
    attemptedAt: stamp,
    endedAt: null,
    reason: "The prior cleanup outcome is unconfirmed.",
    outcome: null,
  };
  const namespace = join(home, "project-worktree-cleanup");
  ensurePrivateHome(namespace);
  const file = join(namespace, "operations.json");
  const seed = (value: unknown) =>
    writeOwnerOnly(file, JSON.stringify({ version: 1, records: [value] }));
  return { home, file, row, seed };
}

test("terminal cleanup originals remain readable without unresolved ownership", () => {
  const f = fixture();
  f.seed(f.row);
  expect(readWorktreeCleanupInventory(f.home)).toEqual([f.row]);
  const terminal = {
    ...f.row,
    phase: "refused" as const,
    attemptedAt: null,
    endedAt: stamp,
    reason: "No primitive invocation was admitted.",
  };
  f.seed(terminal);
  const bytes = readFileSync(f.file, "utf8");
  expect(readWorktreeCleanupInventory(f.home)).toEqual([terminal]);
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
});

test("confirmed cleanup originals require direct reviewed success evidence", () => {
  const f = fixture();
  const confirmed = {
    ...f.row,
    phase: "confirmed" as const,
    endedAt: "2026-11-07T00:00:01.000Z",
    reason: null,
    outcome: "reviewed-remove-returned-ok" as const,
  };
  f.seed(confirmed);
  expect(readWorktreeCleanupInventory(f.home)).toEqual([confirmed]);
  for (const invalid of [
    {
      ...confirmed,
      original: {
        ...confirmed.original,
        audit: { ...confirmed.original.audit, ulid: "8" + "0".repeat(25) },
      },
    },
    { ...confirmed, attemptedAt: null },
    { ...confirmed, endedAt: null },
    { ...confirmed, endedAt: "2026-11-06T23:59:59.000Z" },
    { ...confirmed, reason: "Unconfirmed" },
    { ...confirmed, outcome: null },
    { ...confirmed, outcome: "unverified" },
  ]) {
    f.seed(invalid);
    expect(() => readWorktreeCleanupInventory(f.home)).toThrow();
  }
  const otherPhases = [
    f.row,
    { ...f.row, phase: "reserved" as const, attemptedAt: null, reason: null },
    { ...f.row, phase: "attempted" as const, reason: null },
    { ...f.row, phase: "refused" as const, attemptedAt: null, endedAt: stamp },
  ];
  for (const row of otherPhases) {
    f.seed(row);
    expect(readWorktreeCleanupInventory(f.home)).toEqual([row]);
    f.seed({ ...row, outcome: confirmed.outcome });
    expect(() => readWorktreeCleanupInventory(f.home)).toThrow();
  }
});

test("cleanup lease initializes protected empty history before its callback", async () => {
  const home = canonicalTrustedDirectory(scratch.make("cleanup-initialize-"));
  ensurePrivateHome(home);
  const namespace = join(home, "project-worktree-cleanup");
  const file = join(namespace, "operations.json");
  expect(readWorktreeCleanupInventory(home)).toEqual([]);
  expect(existsSync(namespace)).toBe(false);
  const value = await withWorktreeCleanupLease(home, async () => {
    expect(readWorktreeCleanupInventory(home)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe('{"version":1,"records":[]}');
    expect(existsSync(join(namespace, "write.lock.db"))).toBe(true);
    return "leased";
  });
  expect(value).toBe("leased");
  expect(readWorktreeCleanupInventory(home)).toEqual([]);
});

test.each([
  "missing initialized history",
  "initializer crash gap",
  "corrupt history",
  "linked namespace",
  "hardlinked lease",
  "nonfile lease",
])("cleanup lease refuses %s before its callback", async (kind) => {
  const f = fixture();
  const namespace = join(f.home, "project-worktree-cleanup");
  const lock = join(namespace, "write.lock.db");
  const retained = join(f.home, "retained");
  if (kind !== "initializer crash gap") f.seed(f.row);
  if (kind === "missing initialized history") rmSync(f.file);
  if (kind === "corrupt history") writeOwnerOnly(f.file, "{corrupt");
  if (kind === "linked namespace") {
    renameSync(namespace, retained);
    symlinkSync(
      retained,
      namespace,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  if (kind === "hardlinked lease") {
    writeOwnerOnly(retained, "retained lease target");
    linkSync(retained, lock);
  }
  if (kind === "nonfile lease") mkdirSync(lock);
  let callbacks = 0;
  await expect(
    withWorktreeCleanupLease(f.home, async () => {
      callbacks++;
    }),
  ).rejects.toThrow();
  expect(callbacks).toBe(0);
  if (kind === "hardlinked lease")
    expect(readFileSync(retained, "utf8")).toBe("retained lease target");
});

test.each([
  "write",
  "readback",
] as const)("cleanup initialization retains unknown evidence after %s failure", async (failure) => {
  const home = canonicalTrustedDirectory(scratch.make("cleanup-init-fault-"));
  ensurePrivateHome(home);
  let callbacks = 0,
    writes = 0;
  await expect(
    withWorktreeCleanupLease(
      home,
      async () => {
        callbacks++;
      },
      {
        persist: (file: string, content: string) => {
          writes++;
          if (failure === "write") throw Error("Initialization write failed");
          writeOwnerOnly(file, content);
          rmSync(file);
        },
      },
    ),
  ).rejects.toThrow();
  expect({ callbacks, writes }).toEqual({ callbacks: 0, writes: 1 });
  expect(() => readWorktreeCleanupInventory(home)).toThrow();
  await expect(
    withWorktreeCleanupLease(home, async () => {
      callbacks++;
    }),
  ).rejects.toThrow();
  expect(callbacks).toBe(0);
});

test("racing cleanup initialization retains the incomplete winner's namespace", async () => {
  const home = canonicalTrustedDirectory(scratch.make("cleanup-init-race-"));
  ensurePrivateHome(home);
  let racer = Promise.resolve(true),
    racingCallbacks = 0;
  await withWorktreeCleanupLease(home, async () => "initialized", {
    persist: (file, content) => {
      racer = withWorktreeCleanupLease(home, async () => {
        racingCallbacks++;
      }).then(
        () => true,
        () => false,
      );
      writeOwnerOnly(file, content);
    },
  });
  expect(await racer).toBe(false);
  expect(racingCallbacks).toBe(0);
  expect(readWorktreeCleanupInventory(home)).toEqual([]);
});

async function contendedLease(change: "settled" | "history") {
  const f = fixture();
  f.seed(f.row);
  let release = () => {},
    signal = () => {},
    callbacks = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const holder = withWorktreeCleanupLease(f.home, async () => {
    signal();
    await gate;
    if (change === "history") rmSync(f.file);
  }).then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
  await Promise.race([ready, holder]);
  const contender = withWorktreeCleanupLease(f.home, async () => {
    callbacks++;
  }).then(
    () => true,
    () => false,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const blocked = callbacks === 0;
  release();
  const [held, admitted] = await Promise.all([holder, contender]);
  expect({ held, blocked, admitted, callbacks }).toEqual({
    held: { ok: true },
    blocked: true,
    admitted: change === "settled",
    callbacks: change === "settled" ? 1 : 0,
  });
}
test.each(["settled", "history"] as const)(
  "cleanup contenders recheck %s history after waiting",
  contendedLease,
);
test("cleanup contenders reject namespace replacement after waiting", async () => {
  const f = fixture();
  f.seed(f.row);
  const directory = join(f.home, "project-worktree-cleanup");
  const external = new Database(join(directory, "write.lock.db"), {
    create: true,
  });
  let callbacks = 0;
  let contender: Promise<void>;
  try {
    external.exec("BEGIN EXCLUSIVE");
    contender = withWorktreeCleanupLease(f.home, async () => {
      callbacks++;
    });
  } finally {
    external.close();
  }
  renameSync(directory, join(f.home, "retained"));
  ensurePrivateHome(directory);
  writeOwnerOnly(f.file, '{"version":1,"records":[]}');
  await expect(contender).rejects.toThrow("identity changed");
  expect(callbacks).toBe(0);
});

test("cleanup callback failure releases its lease for safe reopening", async () => {
  const f = fixture();
  f.seed(f.row);
  await expect(
    withWorktreeCleanupLease(f.home, async () => {
      throw Error("Callback failed");
    }),
  ).rejects.toThrow("Callback failed");
  expect(
    await withWorktreeCleanupLease(f.home, async () =>
      readWorktreeCleanupInventory(f.home),
    ),
  ).toEqual([f.row]);
});

test("cleanup lease snapshots cannot alter or outlive their ownership", async () => {
  const f = fixture();
  f.seed(f.row);
  const bytes = readFileSync(f.file, "utf8");
  let escaped: () => ReturnType<typeof readWorktreeCleanupInventory> = () => {
    throw Error("Scope not captured");
  };
  await withWorktreeCleanupLease(f.home, async (scope) => {
    expect(Object.isFrozen(scope)).toBe(true);
    escaped = scope.read;
    const copy = scope.read();
    const row = copy[0];
    if (!row) throw Error("Expected complete cleanup original");
    row.original.request.expectedRecord.branch = "changed";
    row.original.audit.eventId = 999;
    row.phase = "reserved";
    expect(scope.read()).toEqual([f.row]);
    expect(readFileSync(f.file, "utf8")).toBe(bytes);
  });
  expect(escaped).toThrow("lease");
  await expect(
    withWorktreeCleanupLease(f.home, async (scope) => {
      escaped = scope.read;
      throw Error("Callback failed");
    }),
  ).rejects.toThrow("Callback failed");
  expect(escaped).toThrow("lease");
  expect(readWorktreeCleanupInventory(f.home)).toEqual([f.row]);
});

test("cleanup raw inventory preserves global native originals and rejects duplicate UUIDs", () => {
  const f = fixture();
  const request = f.row.original.request;
  const project = "project-b1000000-0000-4000-8000-000000000001";
  const other = (repository: string, requestId: string) => ({
    ...f.row,
    original: auditedOriginal(f.home, project, {
      ...request,
      repository,
      requestId,
      expectedRecord: {
        ...request.expectedRecord,
        path: join(repository, "trees", request.expectedRecord.id),
      },
    }),
  });
  const literalRoot = request.repository + String.fromCharCode(92) + "literal";
  const literal = other(literalRoot, "a1000000-0000-4000-8000-000000000003");
  const nested = other(
    request.repository + "/literal",
    "a1000000-0000-4000-8000-000000000004",
  );
  const write = (records: unknown[]) =>
    writeOwnerOnly(f.file, JSON.stringify({ version: 1, records }));
  write([f.row, literal, nested]);
  expect(readWorktreeCleanupInventory(f.home)).toEqual([
    f.row,
    literal,
    nested,
  ]);
  write([f.row, other(literalRoot, request.requestId)]);
  const bytes = readFileSync(f.file, "utf8");
  expect(() => readWorktreeCleanupInventory(f.home)).toThrow();
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
});

test("cleanup lease publishes durable monotone originals through its scoped writer", async () => {
  const f = fixture();
  writeOwnerOnly(f.file, '{"version":1,"records":[]}');
  const reserved = {
    ...f.row,
    phase: "reserved" as const,
    attemptedAt: null,
    reason: null,
  };
  let escaped = (_record: unknown): void => {
    throw Error("Writer not captured");
  };
  await withWorktreeCleanupLease(f.home, async (scope) => {
    escaped = scope.write;
    const copy = structuredClone(reserved);
    scope.write(copy);
    copy.original.audit.eventId = 999;
    expect(scope.read()).toEqual([reserved]);
    const attempted = {
      ...reserved,
      phase: "attempted" as const,
      attemptedAt: stamp,
    };
    scope.write(attempted);
    const confirmed = {
      ...attempted,
      phase: "confirmed" as const,
      endedAt: stamp,
      outcome: "reviewed-remove-returned-ok" as const,
    };
    scope.write(confirmed);
    expect(readWorktreeCleanupInventory(f.home)).toEqual([confirmed]);
  });
  expect(() => escaped(reserved)).toThrow("lease");
  expect(readWorktreeCleanupInventory(f.home)[0]?.phase).toBe("confirmed");
});

const reservedRow = (f: ReturnType<typeof fixture>) => ({
  ...f.row,
  phase: "reserved" as const,
  attemptedAt: null,
  reason: null,
});

test("cleanup publication preserves original audit and monotone phase evidence", async () => {
  const f = fixture(),
    reserved = reservedRow(f);
  const attempted = { ...reserved, phase: "attempted", attemptedAt: stamp };
  const confirmed = {
    ...attempted,
    phase: "confirmed",
    endedAt: stamp,
    outcome: "reviewed-remove-returned-ok",
  };
  const changed = auditedOriginal(f.home, reserved.original.projectId, {
    ...reserved.original.request,
    expectedHead: "b".repeat(40),
  });
  const cases: [unknown[], unknown][] = [
    [[reserved], { ...reserved, original: changed }],
    [
      [reserved],
      {
        ...reserved,
        original: {
          ...reserved.original,
          audit: { ...reserved.original.audit, eventId: 999 },
        },
      },
    ],
    [[reserved], confirmed],
    [[attempted], { ...attempted, attemptedAt: "2026-11-07T00:00:01.000Z" }],
    [[confirmed], attempted],
    [[f.row], reserved],
    [[], attempted],
    [[], confirmed],
    [[], f.row],
  ];
  for (const [records, next] of cases) {
    writeOwnerOnly(f.file, JSON.stringify({ version: 1, records }));
    const bytes = readFileSync(f.file, "utf8");
    await withWorktreeCleanupLease(f.home, async (scope) => {
      expect(() => scope.write(next)).toThrow();
      expect(() => scope.read()).toThrow("unavailable");
    });
    expect(readFileSync(f.file, "utf8")).toBe(bytes);
  }
});

test("cleanup publication retains global native ownership until terminal evidence", async () => {
  const f = fixture(),
    reserved = reservedRow(f),
    base = reserved.original;
  const otherProject = "project-b1000000-0000-4000-8000-000000000001";
  const at = (repository: string, id: string, foreign: boolean) => ({
    ...reserved,
    original: auditedOriginal(f.home, foreign ? otherProject : base.projectId, {
      ...base.request,
      repository,
      requestId: foreign
        ? "a1000000-0000-4000-8000-000000000009"
        : base.request.requestId,
      expectedRecord: {
        ...base.request.expectedRecord,
        id,
        path: join(repository, "trees", id),
      },
    }),
  });
  const next = at(
    base.request.repository,
    base.request.expectedRecord.id,
    true,
  );
  for (const phase of [
    "reserved",
    "attempted",
    "unknown",
    "confirmed",
    "refused",
  ]) {
    const row = {
      ...f.row,
      phase,
      attemptedAt: phase === "reserved" || phase === "refused" ? null : stamp,
      endedAt: phase === "confirmed" || phase === "refused" ? stamp : null,
      reason:
        phase === "unknown" || phase === "refused" ? "Retained evidence" : null,
      outcome: phase === "confirmed" ? "reviewed-remove-returned-ok" : null,
    };
    f.seed(row);
    await withWorktreeCleanupLease(f.home, async (scope) => {
      if (phase === "confirmed" || phase === "refused") {
        scope.write(next);
        expect(scope.read()).toHaveLength(2);
      } else expect(() => scope.write(next)).toThrow("retains this target");
    });
  }
  const root = base.request.repository,
    id = base.request.expectedRecord.id;
  const nativeCases: [string, string, string][] = [
    [root, root, id.toUpperCase()],
    [root + String.fromCharCode(92) + "sibling", root + "/sibling", id],
  ];
  for (const [beforeRoot, nextRoot, nextId] of nativeCases) {
    const old = { ...f.row, original: at(beforeRoot, id, false).original };
    f.seed(old);
    await withWorktreeCleanupLease(f.home, async (scope) => {
      const publish = () => scope.write(at(nextRoot, nextId, true));
      if (process.platform === "win32")
        expect(publish).toThrow("retains this target");
      else {
        publish();
        expect(scope.read()).toHaveLength(2);
      }
    });
  }
});

test.each([
  "throw",
  "write then throw",
  "readback loss",
  "history loss",
  "history changed",
  "getter reentry",
  "persist reentry",
])("cleanup writer poisons caught %s failures without stale overwrite", async (failure) => {
  const f = fixture(),
    reserved = reservedRow(f);
  writeOwnerOnly(f.file, '{"version":1,"records":[]}');
  let writes = 0,
    denied = false,
    reenter = () => {};
  const recurse = () => {
    try {
      reenter();
    } catch {
      denied = true;
    }
  };
  await withWorktreeCleanupLease(
    f.home,
    async (scope) => {
      reenter = () => scope.write(reserved);
      if (failure === "history loss") rmSync(f.file);
      if (failure === "history changed") f.seed(f.row);
      const input = {
        ...reserved,
        get original() {
          if (failure === "getter reentry") recurse();
          return reserved.original;
        },
      };
      expect(() => scope.write(input)).toThrow();
      const bytes = existsSync(f.file) ? readFileSync(f.file, "utf8") : null;
      expect(() => scope.read()).toThrow("unavailable");
      expect(reenter).toThrow("unavailable");
      expect(existsSync(f.file) ? readFileSync(f.file, "utf8") : null).toBe(
        bytes,
      );
    },
    {
      persistJournal: (file, content) => {
        writes++;
        if (failure === "throw") throw Error("Writer failed");
        if (failure === "persist reentry") recurse();
        writeOwnerOnly(file, content);
        if (failure === "readback loss") rmSync(file);
        if (failure === "write then throw") throw Error("Writer response lost");
      },
    },
  );
  expect(writes).toBe(
    ["history loss", "history changed", "getter reentry"].includes(failure)
      ? 0
      : 1,
  );
  if (failure.endsWith("reentry")) expect(denied).toBe(true);
});

test("cleanup writer cannot escape callback failure", async () => {
  const f = fixture(),
    reserved = reservedRow(f);
  writeOwnerOnly(f.file, '{"version":1,"records":[]}');
  let escaped: (input: unknown) => void = () => {};
  await expect(
    withWorktreeCleanupLease(f.home, async (scope) => {
      escaped = scope.write;
      throw Error("Callback failed");
    }),
  ).rejects.toThrow("Callback failed");
  expect(() => escaped(reserved)).toThrow("lease");
  expect(readWorktreeCleanupInventory(f.home)).toEqual([]);
});

test("cleanup history capacity and byte ceilings preserve complete evidence", async () => {
  const f = fixture(),
    reserved = reservedRow(f),
    base = reserved.original;
  const records = Array.from({ length: 1000 }, (_, index) => ({
    ...reserved,
    phase: "refused",
    endedAt: stamp,
    reason: "No effect",
    original: auditedOriginal(f.home, base.projectId, {
      ...base.request,
      requestId:
        "a1000000-0000-4000-8000-" + String(index + 10).padStart(12, "0"),
    }),
  }));
  writeOwnerOnly(f.file, JSON.stringify({ version: 1, records }));
  expect(readWorktreeCleanupInventory(f.home)).toHaveLength(1000);
  await withWorktreeCleanupLease(f.home, async (scope) => {
    expect(() => scope.write(reserved)).toThrow();
  });
  expect(readWorktreeCleanupInventory(f.home)).toHaveLength(1000);
  writeOwnerOnly(
    f.file,
    '{"version":1,"records":[]}' + " ".repeat(2 * 1024 * 1024),
  );
  expect(() => readWorktreeCleanupInventory(f.home)).toThrow();
});
