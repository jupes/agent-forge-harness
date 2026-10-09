import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  closeLedger,
  isBusy,
  LEDGER_SCHEMA_VERSION,
  migrate,
  openLedger,
} from "./db";

const temporary: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger test "));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = join(import.meta.dir, "fixtures", "append-one.ts");

/** The parent's environment minus anything that names a live session or ledger. */
function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE_|AGENT_FORGE_|FORGE_)/.test(key)) continue;
    env[key] = value;
  }
  env.AGENT_FORGE_HOME = home;
  return env;
}

async function appendInChild(
  home: string,
  sessionId: string,
): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(["bun", "run", FIXTURE, sessionId], {
    env: childEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
}

function userVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version");
  return row.get()?.user_version ?? -1;
}

function insertRow(db: Database, ulid: string): void {
  db.query(
    "INSERT INTO events (ulid, ts, kind, workspace, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(ulid, "2026-10-07T00:00:00.000Z", "session.started", "w", "{}");
}

describe("openLedger", () => {
  test("opening an empty path creates the schema at the current version", () => {
    const path = join(tempHome(), "nested dir", "ledger.db");
    const db = openLedger(path);
    expect(userVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    insertRow(db, "U1");

    closeLedger(path);
    const reopened = openLedger(path);
    expect(userVersion(reopened)).toBe(LEDGER_SCHEMA_VERSION);
    const count = reopened
      .query<{ n: number }, []>("SELECT count(*) AS n FROM events")
      .get();
    expect(count?.n).toBe(1);
    const tables = reopened
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining(["daily_summaries", "events", "session_models"]),
    );
    const columns = reopened
      .query<{ name: string }, []>("PRAGMA table_info(events)")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("workspace");
  });

  test("two opens of the same path share one connection", () => {
    const home = tempHome();
    const path = join(home, "ledger.db");
    expect(openLedger(path)).toBe(openLedger(join(home, ".", "ledger.db")));
  });

  test("the ledger is in WAL mode after first open and a second connection runs with synchronous NORMAL", async () => {
    const home = tempHome();
    const db = openLedger(join(home, "ledger.db"));
    const mode = db
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get();
    expect(mode?.journal_mode).toBe("wal");

    const child = await appendInChild(home, "sess-child");
    expect(child.exitCode).toBe(0);
    const report = JSON.parse(child.stdout) as {
      pragma: { synchronous: number };
    };
    expect(report.pragma.synchronous).toBe(1);
  });

  // Pins that the migration reads the version itself rather than trusting what
  // the opener saw before it. It does not pin that the read comes after BEGIN
  // IMMEDIATE rather than just before it: telling those apart needs a second
  // connection to commit between two statements inside `migrate`, and there is
  // no seam for that.
  test("an opener that saw an empty file but lost the race to create the schema applies nothing once it holds the write lock", () => {
    const file = join(tempHome(), "ledger.db");
    const winner = new Database(file, { create: true });
    const loser = new Database(file, { create: true });
    try {
      // Both looked before either wrote, so both go on to migrate.
      expect(userVersion(winner)).toBe(0);
      expect(userVersion(loser)).toBe(0);

      migrate(winner);
      insertRow(winner, "U1");
      migrate(loser);

      expect(userVersion(loser)).toBe(LEDGER_SCHEMA_VERSION);
      const tables = loser
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'events'",
        )
        .get();
      expect(tables?.n).toBe(1);
      const rows = loser
        .query<{ n: number }, []>("SELECT count(*) AS n FROM events")
        .get();
      expect(rows?.n).toBe(1);
    } finally {
      winner.close();
      loser.close();
    }
  });

  test("an opener that reaches the migration while another connection holds the write lock gets a busy error and changes nothing", () => {
    const file = join(tempHome(), "ledger.db");
    const winner = new Database(file, { create: true });
    const loser = new Database(file, { create: true });
    try {
      migrate(winner);
      winner.exec("BEGIN IMMEDIATE");
      let thrown: unknown;
      try {
        migrate(loser);
      } catch (error) {
        thrown = error;
      }
      expect(isBusy(thrown)).toBe(true);
      winner.exec("COMMIT");
      // The failed attempt left no transaction open on the loser's connection.
      migrate(loser);
      expect(userVersion(loser)).toBe(LEDGER_SCHEMA_VERSION);
    } finally {
      winner.close();
      loser.close();
    }
  });

  test("several processes opening an empty ledger at once all succeed and the schema is created once", async () => {
    const home = tempHome();
    const children = await Promise.all(
      Array.from({ length: 6 }, (_, i) => appendInChild(home, `sess-${i}`)),
    );
    expect(children.map((child) => child.exitCode)).toEqual([0, 0, 0, 0, 0, 0]);

    const db = new Database(join(home, "ledger.db"), { readonly: true });
    try {
      expect(userVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
      const count = db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM events")
        .get();
      expect(count?.n).toBe(6);
    } finally {
      db.close();
    }
  }, 30_000);
});
