import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
import { validateLedgerEvent } from "../hearth/validate";
import { appendEvent } from "./append";
import { runAudit } from "./audit-cli";
import { closeLedger, openLedger } from "./db";
import { queryEvents } from "./query";
import { SUMMARY_CAP } from "./redact";

const temporary: string[] = [];

/** A ledger of its own, in a directory whose name contains a space. */
function tempLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger test "));
  temporary.push(dir);
  return join(dir, "ledger.db");
}

function dirnameOf(path: string): string {
  return join(path, "..");
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Stored rows read with a connection of the test's own, bypassing `queryEvents`. */
function rawRows(path: string): Array<Record<string, unknown>> {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<Record<string, unknown>, []>("SELECT * FROM events ORDER BY id")
      .all();
  } finally {
    db.close();
  }
}

const toolCall: LedgerEventInput = {
  kind: "tool.called",
  workspace: "c:/work/harness",
  sessionId: "sess-1",
  beadId: "bead-1",
  runId: "run-1",
  executor: { provider: "claude", model: "model-1", effort: "high" },
  payload: { tool: "Bash", argsHash: "sha256:ab12", durationMs: 12 },
};

describe("appendEvent", () => {
  test("an appended event is read back with the id, ulid and executor it was stored with", () => {
    const path = tempLedger();
    const appended = appendEvent(toolCall, { path });
    expect(appended.ok).toBe(true);

    const events = queryEvents({ sessionId: "sess-1" }, { path });
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({
      ...toolCall,
      executor: { ...toolCall.executor, sessionId: "sess-1" },
      id: 1,
    });
    expect(event?.ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(appended).toEqual({ ok: true, id: 1, ulid: event?.ulid ?? "" });
    expect(new Date(event?.ts ?? "").toISOString()).toBe(event?.ts ?? "");
    expect(validateLedgerEvent(event).ok).toBe(true);
  });

  test("an invalid event is refused with the validator's message and nothing is stored", () => {
    const path = tempLedger();
    appendEvent(toolCall, { path });
    // justification: the test hands the ledger a malformed event on purpose.
    const malformed = {
      kind: "tool.called",
      workspace: "w",
      payload: { tool: "Bash" },
    } as unknown as LedgerEventInput;
    const result = appendEvent(malformed, { path });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("tool.called");
      expect(result.error).toContain("argsHash");
    }
    expect(rawRows(path)).toHaveLength(1);
  });

  test("appendEvent never throws when the ledger directory cannot be created", () => {
    const blocker = join(dirnameOf(tempLedger()), "a file");
    writeFileSync(blocker, "not a directory");
    const result = appendEvent(toolCall, {
      path: join(blocker, "ledger.db"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  test("a secret inside an allowed string is stored redacted", () => {
    const path = tempLedger();
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
    appendEvent(
      {
        kind: "gate.ran",
        workspace: "w",
        payload: { gate: `typecheck ${secret}`, passed: false },
      },
      { path },
    );
    appendEvent(
      {
        kind: "verdict.bound",
        workspace: "w",
        payload: { verdict: "fail", summary: `leaked ${secret} in a log` },
      },
      { path },
    );
    const rows = rawRows(path);
    expect(rows).toHaveLength(2);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(secret);
    for (const row of rows)
      expect(String(row.payload)).toContain("[REDACTED:anthropic-api-key]");
  });

  test("a body smuggled under an unknown payload key is not stored", () => {
    const path = tempLedger();
    // justification: the extra keys are exactly what the contract type forbids.
    const smuggled = {
      ...toolCall,
      payload: {
        ...toolCall.payload,
        output: "total 12 drwxr-xr-x",
        input: { command: "ls -la" },
      },
    } as unknown as LedgerEventInput;
    expect(appendEvent(smuggled, { path }).ok).toBe(true);
    const payload = JSON.parse(String(rawRows(path)[0]?.payload)) as object;
    expect(Object.keys(payload).sort()).toEqual([
      "argsHash",
      "durationMs",
      "tool",
    ]);
  });

  test("an executor nested in a payload keeps only executor keys", () => {
    const path = tempLedger();
    // justification: the extra key is exactly what the contract type forbids.
    const event = {
      kind: "verdict.bound",
      workspace: "w",
      payload: {
        verdict: "pass",
        evaluator: {
          provider: "claude",
          model: "model-2",
          effort: "high",
          smith: "claude-master",
          sessionId: "sess-9",
          transcript: "the whole conversation",
        },
      },
    } as unknown as LedgerEventInput;
    expect(appendEvent(event, { path }).ok).toBe(true);
    const payload = JSON.parse(String(rawRows(path)[0]?.payload)) as {
      evaluator: object;
    };
    expect(payload.evaluator).toEqual({
      provider: "claude",
      model: "model-2",
      effort: "high",
      smith: "claude-master",
      sessionId: "sess-9",
    });
  });

  test("a summary longer than the cap is truncated", () => {
    const path = tempLedger();
    appendEvent(
      {
        kind: "council.run.finished",
        workspace: "w",
        payload: {
          councilRunId: "run-1",
          outcome: "pass",
          summary: "x".repeat(5000),
        },
      },
      { path },
    );
    const payload = JSON.parse(String(rawRows(path)[0]?.payload)) as {
      summary: string;
    };
    expect(payload.summary).toHaveLength(SUMMARY_CAP);
    expect(SUMMARY_CAP).toBe(2000);
  });

  test("a repeated ulid is stored once", () => {
    const path = tempLedger();
    const ulid = "01J0AAAAAAAAAAAAAAAAAAAAAA";
    const first = appendEvent(toolCall, { path, ulid });
    const second = appendEvent(toolCall, { path, ulid });
    expect(first).toEqual({ ok: true, id: 1, ulid });
    expect(second).toEqual({ ok: true, duplicate: true, ulid });
    expect(rawRows(path)).toHaveLength(1);
  });

  test("a second session.started for the same session is ignored", () => {
    const path = tempLedger();
    const started: LedgerEventInput = {
      kind: "session.started",
      workspace: "w",
      sessionId: "sess-1",
      payload: { source: "startup" },
    };
    const first = appendEvent(started, { path });
    const second = appendEvent(started, { path });
    expect(first.ok && !("duplicate" in first)).toBe(true);
    expect(second).toEqual({
      ok: true,
      duplicate: true,
      ulid: first.ok ? first.ulid : "",
    });
    const third = appendEvent(toolCall, { path });
    expect(third.ok && !("duplicate" in third)).toBe(true);
    expect(rawRows(path).map((row) => row.kind)).toEqual([
      "session.started",
      "tool.called",
    ]);
    const other = appendEvent({ ...started, sessionId: "sess-2" }, { path });
    expect(other.ok && !("duplicate" in other)).toBe(true);
  });

  test("an event whose executor names the session is stored under that session", () => {
    const path = tempLedger();
    appendEvent(
      {
        kind: "gate.ran",
        workspace: "w",
        executor: { provider: "claude", model: "model-1", sessionId: "sess-7" },
        payload: { gate: "lint", passed: true },
      },
      { path },
    );
    const [event] = queryEvents({ sessionId: "sess-7" }, { path });
    expect(event?.sessionId).toBe("sess-7");
    expect(event?.executor?.sessionId).toBe("sess-7");
  });

  test("a timestamp given with an offset is stored in UTC, and an absent one is taken from the clock", () => {
    const path = tempLedger();
    appendEvent(
      { ...toolCall, ts: "2026-10-05T14:00:00+02:00" },
      { path, now: () => new Date("2030-01-01T00:00:00.000Z") },
    );
    appendEvent(toolCall, {
      path,
      now: () => new Date("2026-10-06T08:30:00.000Z"),
    });
    expect(rawRows(path).map((row) => row.ts)).toEqual([
      "2026-10-05T12:00:00.000Z",
      "2026-10-06T08:30:00.000Z",
    ]);
  });

  test("an append against a ledger another writer has locked is refused without throwing, and succeeds once the lock is released", () => {
    const path = tempLedger();
    expect(appendEvent(toolCall, { path }).ok).toBe(true);
    const writer = new Database(path);
    try {
      writer.exec("BEGIN IMMEDIATE");
      const blocked = appendEvent(toolCall, { path });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error).toContain("locked");
      writer.exec("COMMIT");
      expect(appendEvent(toolCall, { path }).ok).toBe(true);
    } finally {
      writer.close();
    }
    expect(rawRows(path)).toHaveLength(2);
  });

  test("ten thousand events are all stored", () => {
    const path = tempLedger();
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const result = appendEvent(toolCall, { path });
      if (!result.ok) throw new Error(result.error);
    }
    const elapsedMs = performance.now() - started;
    const db = new Database(path, { readonly: true });
    try {
      expect(
        db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get(),
      ).toEqual({ n: 10_000 });
    } finally {
      db.close();
    }
    // A loose bound only: the measured figure is recorded by scripts/ledger/bench.ts.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 30_000);
});

const ANTHROPIC_KEY = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
const GENERIC_KEY = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345";

describe("secrets in the correlation and executor columns", () => {
  const { sessionId: _session, ...withoutSession } = toolCall;
  const planted: Array<[string, string, (key: string) => LedgerEventInput]> = [
    [
      "workspace",
      "workspace",
      (key) => ({ ...toolCall, workspace: `c:/work/${key}/harness` }),
    ],
    ["beadId", "beadId", (key) => ({ ...toolCall, beadId: key })],
    ["runId", "runId", (key) => ({ ...toolCall, runId: `run-${key}` })],
    ["sessionId", "sessionId", (key) => ({ ...toolCall, sessionId: key })],
    [
      "executor sessionId (stored as the session)",
      "sessionId",
      (key) => ({
        ...withoutSession,
        executor: { provider: "claude", model: "model-1", sessionId: key },
      }),
    ],
  ];

  for (const [name, column, build] of planted) {
    test(`an event whose ${name} holds a key is refused, and neither the key nor a mangled id is stored`, () => {
      const path = tempLedger();
      expect(appendEvent(toolCall, { path }).ok).toBe(true);
      for (const key of [ANTHROPIC_KEY, GENERIC_KEY]) {
        const result = appendEvent(build(key), { path });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain(column);
          expect(result.error).not.toContain(key);
        }
      }
      const rows = rawRows(path);
      expect(rows).toHaveLength(1);
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain(ANTHROPIC_KEY);
      expect(stored).not.toContain(GENERIC_KEY);
      expect(stored).not.toContain("[REDACTED:");
    });
  }

  test("a caller-supplied ulid that holds a key is refused", () => {
    const path = tempLedger();
    const result = appendEvent(toolCall, { path, ulid: GENERIC_KEY });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain(GENERIC_KEY);
    expect(appendEvent(toolCall, { path }).ok).toBe(true);
    expect(JSON.stringify(rawRows(path))).not.toContain(GENERIC_KEY);
  });

  for (const field of ["provider", "model", "effort", "smith"] as const) {
    test(`a key in the executor's ${field} is stored redacted`, () => {
      const path = tempLedger();
      const result = appendEvent(
        {
          ...toolCall,
          executor: {
            provider: "claude",
            model: "model-1",
            [field]: `x ${ANTHROPIC_KEY}`,
          },
        },
        { path },
      );
      expect(result.ok).toBe(true);
      const rows = rawRows(path);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(ANTHROPIC_KEY);
      expect(rows[0]?.[field]).toBe("x [REDACTED:anthropic-api-key]");
    });
  }

  test("ids and a path that have sk- inside an ordinary word are stored as given and found by forge:audit --run and --bead", () => {
    const path = tempLedger();
    const slugged: LedgerEventInput = {
      ...toolCall,
      workspace: "c:/work/trees/task-runner-agent-forge-d3ede1",
      sessionId: "risk-review-session-0001-abcdef",
      beadId: "desk-booking-calendar-sync-2026",
      runId: "task-queue-state-machine-v2",
    };
    expect(appendEvent(slugged, { path }).ok).toBe(true);
    expect(rawRows(path)[0]).toMatchObject({
      workspace: "c:/work/trees/task-runner-agent-forge-d3ede1",
      session_id: "risk-review-session-0001-abcdef",
      bead_id: "desk-booking-calendar-sync-2026",
      run_id: "task-queue-state-machine-v2",
    });

    const context = {
      cwd: dirnameOf(path),
      env: { AGENT_FORGE_HOME: dirnameOf(path) },
    };
    for (const flags of [
      ["--run", "task-queue-state-machine-v2"],
      ["--bead", "desk-booking-calendar-sync-2026"],
      ["--session", "risk-review-session-0001-abcdef"],
    ]) {
      const outcome = runAudit(
        [...flags, "--all-workspaces", "--json"],
        context,
      );
      expect(outcome.code).toBe(0);
      const envelope = JSON.parse(outcome.stdout) as { data: unknown[] };
      expect(envelope.data).toHaveLength(1);
      expect(envelope.data[0]).toMatchObject({
        runId: "task-queue-state-machine-v2",
        beadId: "desk-booking-calendar-sync-2026",
      });
    }
  });
});

describe("an append that finds the ledger busy", () => {
  /**
   * Make the ledger's own connection report SQLITE_BUSY for the first `times`
   * inserts. `appendEvent` reuses the connection `openLedger` caches per path,
   * so this is the connection it writes through.
   */
  function busyFor(path: string, times: number): { attempts: () => number } {
    const db = openLedger(path);
    const query = db.query.bind(db);
    let attempts = 0;
    // justification: the wrapper forwards to the real method and only adds a throw.
    db.query = ((sql: string) => {
      if (sql.trimStart().startsWith("INSERT") && attempts++ < times)
        throw Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
        });
      return query(sql);
    }) as typeof db.query;
    return { attempts: () => attempts };
  }

  test("one busy answer is retried and the event is stored once", () => {
    const path = tempLedger();
    const busy = busyFor(path, 1);
    const result = appendEvent(toolCall, { path });
    expect(result.ok).toBe(true);
    expect(busy.attempts()).toBe(2);
    closeLedger(path);
    expect(rawRows(path)).toHaveLength(1);
  });

  test("a second busy answer is not retried again: the event is refused and nothing is stored", () => {
    const path = tempLedger();
    const busy = busyFor(path, 5);
    const result = appendEvent(toolCall, { path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("locked");
    expect(busy.attempts()).toBe(2);
    closeLedger(path);
    expect(rawRows(path)).toHaveLength(0);
  });

  test("an error that is not busy is not retried", () => {
    const path = tempLedger();
    const db = openLedger(path);
    const query = db.query.bind(db);
    let attempts = 0;
    // justification: the wrapper forwards to the real method and only adds a throw.
    db.query = ((sql: string) => {
      if (sql.trimStart().startsWith("INSERT")) {
        attempts++;
        throw Object.assign(new Error("disk I/O error"), {
          code: "SQLITE_IOERR",
        });
      }
      return query(sql);
    }) as typeof db.query;
    const result = appendEvent(toolCall, { path });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
  });
});
