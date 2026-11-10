import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { lockPath, tokenPath } from "../hearth/home";
import { appHearthSettingsRead } from "../hearth/routes/app-hearth";
import { createHearth } from "../hearth/server-runtime";
import { startTestHearth } from "../hearth/testing";
import { closeLedger } from "../ledger/db";
import { appHearthSettingsSchema } from "./app-hearth-protocol";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!basename(root).startsWith("forge-hearth-settings-"))
      throw Error("Unexpected fixture root");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-hearth-settings-"));
  roots.push(root);
  const ledger = join(root, "ledger.db");
  const configHome = join(root, "user");
  mkdirSync(join(configHome, ".agent-forge"), { recursive: true });
  return {
    root,
    ledger,
    configHome,
    deps: {
      root,
      workspace: root,
      ledgerPath: ledger,
      configHome,
      runBd: async () => {
        throw Error("Diagnostics must never query the tracker");
      },
    },
  };
}
async function snapshot(deps: Parameters<typeof appHearthSettingsRead>[0]) {
  const reply = await appHearthSettingsRead(deps).read(null);
  if (!("data" in reply)) throw Error("Missing diagnostics");
  return appHearthSettingsSchema.parse(reply.data);
}

test("Hearth Settings reports the bound runtime and existing ledger through the protected read route", async () => {
  const h = await startTestHearth();
  try {
    // Arrange an actual ledger; the diagnostics read itself must never create one.
    h.append({
      kind: "operator.action",
      payload: { action: "test.diagnostics", surface: "ui" },
    });
    const before = readFileSync(h.ledger);
    const response = await fetch(`${h.api}/app-settings/hearth`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(200);
    const answer: unknown = await response.json();
    if (
      answer === null ||
      typeof answer !== "object" ||
      !("ok" in answer) ||
      answer.ok !== true ||
      !("data" in answer)
    )
      throw Error("Diagnostics envelope unavailable");
    const data = appHearthSettingsSchema.parse(answer.data);
    expect(data).toMatchObject({
      version: 1,
      port: h.hearth.port,
      ledger: { path: h.ledger, database: { state: "available" } },
      upkeep: {
        backupKeepDays: 14,
        retentionDays: 90,
        backupTrigger: "session-start-if-due",
        compactionTrigger: "manual",
      },
      execution: { state: "available", names: [] },
    });
    expect(readFileSync(h.ledger)).toEqual(before);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const events = h.events();
    for (const token of [null, "wrong-token"]) {
      expect(
        (
          await fetch(`${h.api}/app-settings/hearth`, {
            headers: h.headers(token),
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await fetch(`${h.api}/app-settings/hearth?path=/other`, {
          headers: h.headers(h.hearth.token),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${h.api}/app-settings/hearth`, {
          headers: {
            ...h.headers(h.hearth.token),
            Origin: "http://127.0.0.1:1",
          },
        })
      ).status,
    ).toBe(403);
    expect(h.events()).toEqual(events);
    expect(h.bd.calls).toEqual([]);
  } finally {
    await h.close();
  }
});

test("diagnostics distinguish absent and unknown files without opening a database or performing upkeep", async () => {
  const f = fixture();
  expect((await snapshot(f.deps)).ledger).toEqual({
    path: f.ledger,
    database: { state: "missing" },
    wal: { state: "missing" },
    sharedMemory: { state: "missing" },
  });
  expect(existsSync(f.ledger)).toBe(false);
  writeFileSync(f.ledger, "not a database");
  writeFileSync(f.ledger + "-wal", "wal");
  mkdirSync(f.ledger + "-shm");
  const data = await snapshot({ ...f.deps, runtimePort: () => 32123 });
  expect(data.port).toBe(32123);
  expect(data.ledger).toEqual({
    path: f.ledger,
    database: { state: "available", bytes: 14 },
    wal: { state: "available", bytes: 3 },
    sharedMemory: { state: "unknown" },
  });
  expect(readFileSync(f.ledger, "utf8")).toBe("not a database");
  expect(existsSync(join(f.root, "backups"))).toBe(false);
  expect(
    (
      await snapshot({
        ...f.deps,
        runtimePort: () => {
          throw Error("not listening");
        },
      })
    ).port,
  ).toBeNull();
});

test("execution settings return only bounded configured names and suppress malformed config and error text", async () => {
  const f = fixture();
  const config = join(f.configHome, ".agent-forge", "config.toml");
  writeFileSync(
    config,
    '[execution.env]\npass = ["Z_EXTRA", "A_EXTRA", "Z_EXTRA"]\n',
  );
  expect((await snapshot(f.deps)).execution).toEqual({
    state: "available",
    names: ["A_EXTRA", "Z_EXTRA"],
  });
  // Preserve the existing secure workspace configuration precedence.
  writeFileSync(
    join(f.root, "agent-forge.toml"),
    '[execution.env]\npass = ["WORKSPACE_ALLOWED"]\n',
  );
  expect((await snapshot(f.deps)).execution).toEqual({
    state: "available",
    names: ["WORKSPACE_ALLOWED"],
  });
  for (const pass of [
    ["SECRET=value"],
    ["Bad Name"],
    ["x".repeat(129)],
    Array.from({ length: 257 }, (_, i) => "V" + i),
  ]) {
    writeFileSync(
      join(f.root, "agent-forge.toml"),
      "[execution.env]\npass = " + JSON.stringify(pass) + "\n",
    );
    const data = await snapshot(f.deps);
    expect(data.execution).toEqual({ state: "unavailable" });
    expect(JSON.stringify(data)).not.toContain("SECRET=value");
  }
  writeFileSync(
    join(f.root, "agent-forge.toml"),
    'broken = "PRIVATE_INVALID_CONFIG',
  );
  expect((await snapshot(f.deps)).execution).toEqual({ state: "unavailable" });
});

test("nightly backup is activated only after listening and owner admission, exposed by protected reads, and fenced before close", async () => {
  const f = fixture();
  mkdirSync(join(f.root, ".git"));
  const home = join(f.root, "hearth-home");
  let now = Date.parse("2026-11-10T23:59:59Z");
  let pending = 0;
  let wake = () => {};
  const clock = {
    now: () => now,
    setTimer(run: () => void) {
      expect(existsSync(lockPath(home, f.root))).toBe(true);
      expect(existsSync(tokenPath(home, f.root))).toBe(true);
      pending++;
      wake = run;
      return () => {
        pending--;
      };
    },
  };
  const hearth = await createHearth({
    root: f.root,
    home,
    environment: {},
    onListening() {
      expect(pending).toBe(0);
      expect(existsSync(tokenPath(home, f.root))).toBe(false);
    },
    api: {
      ledgerPath: f.ledger,
      configHome: f.configHome,
      ledgerBackupClock: clock,
      runBd: f.deps.runBd,
    },
  });
  if (hearth.kind !== "started") throw Error("Expected owned Hearth");
  const read = async () => {
    const response = await fetch(
      hearth.url + "/__agent-forge/app-settings/hearth",
      {
        headers: { Origin: hearth.url, "X-Agent-Forge-Operator": hearth.token },
      },
    );
    expect(response.status).toBe(200);
    const answer: unknown = await response.json();
    if (
      !answer ||
      typeof answer !== "object" ||
      !("ok" in answer) ||
      answer.ok !== true ||
      !("data" in answer)
    )
      throw Error("Missing backup diagnostic envelope");
    return appHearthSettingsSchema.parse(answer.data).upkeep.nightlyBackup;
  };
  try {
    expect(pending).toBe(1);
    expect((await read())?.lastAttempt).toBeNull();
    expect(existsSync(join(f.root, "backups"))).toBe(false);
    const reused = await createHearth({
      root: f.root,
      home,
      environment: {},
      api: {
        ledgerBackupClock: {
          now: () => now,
          setTimer() {
            throw Error("Reused Hearth must not schedule a backup");
          },
        },
      },
    });
    expect(reused.kind).toBe("reused");
    expect(pending).toBe(1);
    now = Date.parse("2026-11-11T00:00:00Z");
    pending--; // The fake timer has fired and is no longer pending.
    wake();
    expect(pending).toBe(1);
    expect(await read()).toEqual({
      phase: "scheduled",
      nextAttemptAt: "2026-11-12T00:00:00.000Z",
      lastAttempt: {
        startedAt: "2026-11-11T00:00:00.000Z",
        outcome: "completed",
      },
    });
    expect(existsSync(join(f.root, "backups", "ledger-2026-11-11.db"))).toBe(
      true,
    );
  } finally {
    await hearth.close();
    closeLedger(f.ledger);
  }
  expect(pending).toBe(0);
  now = Date.parse("2026-11-12T00:00:00Z");
  wake();
  expect(pending).toBe(0);
  expect(existsSync(join(f.root, "backups", "ledger-2026-11-12.db"))).toBe(
    false,
  );
});

test("a listener-start failure leaves no nightly backup timer, token, lock or snapshot", async () => {
  const f = fixture();
  mkdirSync(join(f.root, ".git"));
  const home = join(f.root, "failed-hearth");
  let timers = 0;
  await expect(
    createHearth({
      root: f.root,
      home,
      environment: {},
      onListening() {
        throw Error("intentional start failure");
      },
      api: {
        ledgerPath: f.ledger,
        configHome: f.configHome,
        ledgerBackupClock: {
          now: Date.now,
          setTimer() {
            timers++;
            return () => {
              timers--;
            };
          },
        },
      },
    }),
  ).rejects.toThrow("intentional start failure");
  expect(timers).toBe(0);
  expect(existsSync(lockPath(home, f.root))).toBe(false);
  expect(existsSync(tokenPath(home, f.root))).toBe(false);
  expect(existsSync(join(f.root, "backups"))).toBe(false);
});
