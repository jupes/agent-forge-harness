import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
import { appendEvent } from "./append";
import { backupLedger, compact } from "./backup";
import { closeLedger } from "./db";
import { queryEvents } from "./query";

const temporary: string[] = [];

/** A ledger home of its own, under a path with a space. */
function tempHome(): { home: string; path: string; backups: string } {
  const home = mkdtempSync(join(tmpdir(), "ledger test "));
  temporary.push(home);
  return {
    home,
    path: join(home, "ledger.db"),
    backups: join(home, "backups"),
  };
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tool(extra: Partial<LedgerEventInput> = {}): LedgerEventInput {
  // justification: the spread only overrides correlation fields of a tool.called event.
  return {
    kind: "tool.called",
    workspace: "c:/work/harness",
    payload: { tool: "Bash", argsHash: "sha256:ab12" },
    ...extra,
  } as LedgerEventInput;
}

function countEvents(file: string): number {
  const db = new Database(file, { readonly: true });
  try {
    return (
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()
        ?.n ?? -1
    );
  } finally {
    db.close();
  }
}

const NOW = () => new Date("2026-10-07T10:00:00.000Z");

describe("backupLedger", () => {
  test("a backup is a readable ledger holding the same events", () => {
    const { path, backups } = tempHome();
    for (let i = 0; i < 3; i++) appendEvent(tool(), { path });

    const result = backupLedger({ path, now: NOW });
    expect(result.path).toBe(join(backups, "ledger-2026-10-07.db"));
    expect(result.pruned).toEqual([]);
    expect(countEvents(result.path)).toBe(3);

    const restored = queryEvents({}, { path: result.path });
    expect(restored.map((event) => event.ulid)).toEqual(
      queryEvents({}, { path }).map((event) => event.ulid),
    );
  });

  test("a second backup on the same day replaces the first", () => {
    const { path } = tempHome();
    appendEvent(tool(), { path });
    const first = backupLedger({ path, now: NOW });
    appendEvent(tool(), { path });
    const second = backupLedger({ path, now: NOW });
    expect(second.path).toBe(first.path);
    expect(countEvents(second.path)).toBe(2);
  });

  test("backups older than 14 days are pruned by their file-name date and today's is kept", () => {
    const { path, backups } = tempHome();
    appendEvent(tool(), { path });
    mkdirSync(backups, { recursive: true });
    const seeded = [
      "ledger-2026-09-01.db",
      "ledger-2026-09-22.db",
      "ledger-2026-09-23.db",
      "ledger-2026-10-06.db",
      "notes.txt",
      "ledger-not-a-date.db",
    ];
    for (const name of seeded) writeFileSync(join(backups, name), "old");

    const result = backupLedger({ path, now: NOW });
    expect(result.pruned.sort()).toEqual([
      join(backups, "ledger-2026-09-01.db"),
      join(backups, "ledger-2026-09-22.db"),
    ]);
    expect(readdirSync(backups).sort()).toEqual([
      "ledger-2026-09-23.db",
      "ledger-2026-10-06.db",
      "ledger-2026-10-07.db",
      "ledger-not-a-date.db",
      "notes.txt",
    ]);
  });

  test("a backup taken while another connection holds an uncommitted write contains exactly the committed events and passes the integrity check", () => {
    const { path } = tempHome();
    for (let i = 0; i < 5; i++) appendEvent(tool(), { path });

    const writer = new Database(path);
    let snapshot: string;
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer
        .query(
          "INSERT INTO events (ulid, ts, kind, workspace, payload) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "UNCOMMITTED",
          "2026-10-07T00:00:00.000Z",
          "tool.called",
          "w",
          "{}",
        );
      snapshot = backupLedger({ path, now: NOW }).path;
      writer.exec("COMMIT");
    } finally {
      writer.close();
    }

    expect(countEvents(snapshot)).toBe(5);
    expect(countEvents(path)).toBe(6);
    const db = new Database(snapshot, { readonly: true });
    try {
      expect(
        db
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get(),
      ).toEqual({ integrity_check: "ok" });
    } finally {
      db.close();
    }
  });
});

describe("compact", () => {
  test("compaction replaces events older than 90 days with per-day counts and keeps newer events", () => {
    const { path } = tempHome();
    const old = [
      tool({ ts: "2026-06-01T08:00:00.000Z" }),
      tool({ ts: "2026-06-01T23:59:59.000Z" }),
      tool({ ts: "2026-06-01T09:00:00.000Z", workspace: "c:/work/other" }),
      {
        kind: "gate.ran",
        workspace: "c:/work/harness",
        ts: "2026-06-02T00:00:00.000Z",
        payload: { gate: "lint", passed: true },
      } satisfies LedgerEventInput,
    ];
    const recent = [
      tool({ ts: "2026-07-09T10:00:00.000Z" }),
      tool({ ts: "2026-10-06T10:00:00.000Z" }),
    ];
    for (const event of [...old, ...recent]) appendEvent(event, { path });

    expect(compact({ path, now: NOW })).toEqual({ events: 4, days: 2 });

    expect(queryEvents({}, { path }).map((event) => event.ts)).toEqual([
      "2026-07-09T10:00:00.000Z",
      "2026-10-06T10:00:00.000Z",
    ]);
    const db = new Database(path, { readonly: true });
    try {
      expect(
        db
          .query(
            "SELECT day, workspace, kind, count FROM daily_summaries ORDER BY day, workspace, kind",
          )
          .all(),
      ).toEqual([
        {
          day: "2026-06-01",
          workspace: "c:/work/harness",
          kind: "tool.called",
          count: 2,
        },
        {
          day: "2026-06-01",
          workspace: "c:/work/other",
          kind: "tool.called",
          count: 1,
        },
        {
          day: "2026-06-02",
          workspace: "c:/work/harness",
          kind: "gate.ran",
          count: 1,
        },
      ]);
    } finally {
      db.close();
    }

    expect(compact({ path, now: NOW })).toEqual({ events: 0, days: 0 });
  });

  test("events compacted later for a day already summarised add to its count", () => {
    const { path } = tempHome();
    appendEvent(tool({ ts: "2026-06-01T08:00:00.000Z" }), { path });
    compact({ path, now: NOW });
    appendEvent(tool({ ts: "2026-06-01T09:00:00.000Z" }), { path });
    appendEvent(tool({ ts: "2026-06-01T10:00:00.000Z" }), { path });
    expect(compact({ path, now: NOW })).toEqual({ events: 2, days: 1 });

    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("SELECT count FROM daily_summaries").all()).toEqual([
        { count: 3 },
      ]);
    } finally {
      db.close();
    }
    expect(existsSync(path)).toBe(true);
  });
});
