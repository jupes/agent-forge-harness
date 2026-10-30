import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
import { validateLedgerEvent } from "../hearth/validate";
import { redactSecrets } from "../secret-patterns";
import {
  appendEvent,
  type AppendFailureFacts,
  type JoinField,
  refusedJoinValue,
} from "./append";
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

/**
 * The loose bound on ten thousand appends, each a transaction of its own. The
 * windows-latest CI runner's disk made them 22.8 s against 1.9 s on
 * ubuntu-latest, past the 20 s that holds elsewhere.
 */
const APPEND_10K_BOUND_MS = process.platform === "win32" ? 60_000 : 20_000;

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

  test(
    "ten thousand events are all stored",
    () => {
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
      expect(elapsedMs).toBeLessThan(APPEND_10K_BOUND_MS);
    },
    APPEND_10K_BOUND_MS + 10_000,
  );
});

describe("a tracker write recorded as bead.transitioned", () => {
  const HASH =
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const write = (payload: Record<string, unknown>): LedgerEventInput =>
    // justification: the payloads here include keys the contract type forbids.
    ({
      kind: "bead.transitioned",
      workspace: "c:/work/harness",
      beadId: "bead-1",
      payload,
    }) as unknown as LedgerEventInput;

  test("is stored with its action, hash and length, and with nothing else it was handed", () => {
    const path = tempLedger();
    const result = appendEvent(
      write({
        action: "comment",
        hash: HASH,
        length: 26,
        title: "TITLE-TEXT-MARKER",
        text: "COMMENT-TEXT-MARKER",
      }),
      { path },
    );
    expect(result.ok).toBe(true);
    const [row] = rawRows(path);
    expect(row?.bead_id).toBe("bead-1");
    expect(JSON.parse(String(row?.payload))).toEqual({
      action: "comment",
      hash: HASH,
      length: 26,
    });
    expect(JSON.stringify(rawRows(path))).not.toContain("MARKER");
  });

  test("handed a reason, it is refused whole as a mixed form: no text is stored under the one free-text key of the kind", () => {
    const path = tempLedger();
    const result = appendEvent(
      write({
        action: "close",
        hash: HASH,
        length: 4,
        reason: "REASON-MARKER",
      }),
      { path },
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining(
        "payload.reason: must be absent from a tracker write",
      ),
    });
    openLedger(path);
    expect(rawRows(path)).toEqual([]);
  });

  test("a queue transition keeps its three keys and cannot store a hash or a length", () => {
    const path = tempLedger();
    const queued: LedgerEventInput = {
      kind: "bead.transitioned",
      workspace: "c:/work/harness",
      beadId: "bead-1",
      payload: { from: null, to: "proposed", reason: "minted by auto-task" },
    };
    expect(appendEvent(queued, { path }).ok).toBe(true);
    expect(JSON.parse(String(rawRows(path)[0]?.payload))).toEqual({
      from: null,
      to: "proposed",
      reason: "minted by auto-task",
    });
    const mixed = appendEvent(
      write({ from: null, to: "proposed", hash: "FREE-TEXT-MARKER" }),
      { path },
    );
    expect(mixed.ok).toBe(false);
    expect(rawRows(path)).toHaveLength(1);
  });
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

/**
 * Ordinary names that the scanner flags: `sk-` after a single letter, and
 * after an uppercase one. Put together here so the file does not carry them.
 */
const FLAGGED_CHECKOUT = ["ask", "the", "docs", "chatbot", "service"].join("-");
const FLAGGED_RUN = ["Task", "queue", "state", "machine", "v2"].join("-");

describe("a checkout or id whose ordinary name the scanner flags", () => {
  test("the scanner flags both names, which is what the tests below rely on", () => {
    expect(redactSecrets(FLAGGED_CHECKOUT).redactions).not.toEqual([]);
    expect(redactSecrets(FLAGGED_RUN).redactions).not.toEqual([]);
  });

  test(`an event from a checkout named ${FLAGGED_CHECKOUT} is refused, nothing is stored, and the reason says the ledger refuses every event that carries that workspace`, () => {
    const path = tempLedger();
    const result = appendEvent(
      { ...toolCall, workspace: `c:/work/${FLAGGED_CHECKOUT}` },
      { path },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(
        "workspace looks like a secret (openai-api-key)",
      );
      expect(result.error).toContain("refuses every event that carries it");
      expect(result.error).not.toContain(FLAGGED_CHECKOUT);
    }
    openLedger(path);
    expect(rawRows(path)).toEqual([]);
  });

  test("refusedJoinValue names the field of each value appendEvent refuses and nothing for each it stores, reading a workspace the way it is stored", () => {
    const path = tempLedger();
    // Flagged as spelled with backslashes; not once stored with slashes.
    const backslashed = ["C:", "work", "task-queue-state-machine-v2"].join(
      "\\",
    );
    expect(redactSecrets(backslashed).redactions).not.toEqual([]);
    const cases: Array<
      [
        {
          workspace?: string;
          beadId?: string;
          runId?: string;
          sessionId?: string;
        },
        JoinField | null,
      ]
    > = [
      [{ workspace: `c:/work/${FLAGGED_CHECKOUT}` }, "workspace"],
      [{ workspace: backslashed }, null],
      [{ beadId: FLAGGED_RUN }, "beadId"],
      [{ runId: FLAGGED_RUN }, "runId"],
      [{ sessionId: FLAGGED_RUN }, "sessionId"],
      [{ runId: "task-queue-state-machine-v2" }, null],
    ];
    for (const [values, field] of cases) {
      const refused = refusedJoinValue(values);
      expect(refused === null ? null : refused.field).toBe(field);
      const appended = appendEvent({ ...toolCall, ...values }, { path });
      expect(appended.ok).toBe(field === null);
    }
    expect(rawRows(path)).toHaveLength(2);
  });
});

describe("an append that finds the ledger busy", () => {
  test("failure facts distinguish a busy append from a busy first open", () => {
    const appendPath = tempLedger();
    openLedger(appendPath);
    const appendWriter = new Database(appendPath);
    let appendLocked = false;
    let appendFacts: Readonly<AppendFailureFacts> | undefined;
    try {
      appendWriter.exec("BEGIN IMMEDIATE");
      appendLocked = true;
      const appendResult = appendEvent(toolCall, {
        path: appendPath,
        waitMs: 0,
        onFailure: (facts) => {
          appendFacts = facts;
        },
      });
      expect(appendResult.ok).toBe(false);
      expect(appendFacts).toMatchObject({
        phase: "append-operation",
        sqliteClass: "busy",
        attemptCount: 1,
      });
      expect(Object.isFrozen(appendFacts)).toBe(true);
      expect(Object.keys(appendFacts ?? {}).sort()).toEqual([
        "attemptCount",
        "elapsedMs",
        "phase",
        "sqliteClass",
      ]);
      expect(appendFacts?.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(appendFacts?.elapsedMs).toBeLessThanOrEqual(60_000);
    } finally {
      try {
        if (appendLocked) appendWriter.exec("ROLLBACK");
      } finally {
        appendWriter.close();
      }
    }
    expect(rawRows(appendPath)).toEqual([]);

    const openPath = tempLedger();
    const openWriter = new Database(openPath, { create: true });
    let openLocked = false;
    let openFacts: Readonly<AppendFailureFacts> | undefined;
    try {
      openWriter.exec("BEGIN EXCLUSIVE");
      openLocked = true;
      const openResult = appendEvent(toolCall, {
        path: openPath,
        waitMs: 0,
        onFailure: (facts) => {
          openFacts = facts;
        },
      });
      expect(openResult.ok).toBe(false);
      expect(openFacts).toMatchObject({
        phase: "open-ledger",
        sqliteClass: "busy",
        attemptCount: 1,
      });
      expect(openFacts?.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(openFacts?.elapsedMs).toBeLessThanOrEqual(60_000);
    } finally {
      try {
        if (openLocked) openWriter.exec("ROLLBACK");
      } finally {
        openWriter.close();
      }
    }
    openLedger(openPath);
    expect(rawRows(openPath)).toEqual([]);
  });

  test("observer failures cannot replace the primary append refusal, and nonfailures stay silent", () => {
    const path = tempLedger();
    let calls = 0;
    const started: LedgerEventInput = {
      kind: "session.started",
      workspace: "w",
      sessionId: "session",
      payload: { kind: "subagent", parentSessionId: "parent" },
    };
    expect(appendEvent(started, { path, onFailure: () => calls++ }).ok).toBe(
      true,
    );
    expect(
      appendEvent(started, { path, onFailure: () => calls++ }).ok,
    ).toBe(true);
    // justification: this deliberately violates the validated event contract.
    const malformed = {
      kind: "tool.called",
      workspace: "w",
      payload: { tool: "Bash" },
    } as unknown as LedgerEventInput;
    expect(
      appendEvent(malformed, { path, onFailure: () => calls++ }).ok,
    ).toBe(false);
    expect(calls).toBe(0);

    const writer = new Database(path);
    let locked = false;
    try {
      writer.exec("BEGIN IMMEDIATE");
      locked = true;
      const plain = appendEvent(toolCall, { path, waitMs: 0 });
      const throwingGetter = Object.defineProperty(
        { path, waitMs: 0 },
        "onFailure",
        { get: () => { throw new Error("observer getter failure"); } },
      );
      expect(appendEvent(toolCall, throwingGetter)).toEqual(plain);
      expect(plain.ok).toBe(false);
      if (!plain.ok) expect(plain.error).toContain("locked");
      const refused = appendEvent(toolCall, {
        path,
        waitMs: 0,
        onFailure: () => {
          calls++;
          throw new Error("observer failure");
        },
      });
      expect(refused).toEqual(plain);
      expect(calls).toBe(1);
    } finally {
      try {
        if (locked) writer.exec("ROLLBACK");
      } finally {
        writer.close();
      }
    }
    expect(rawRows(path)).toMatchObject([{ kind: "session.started" }]);
  });

  test("an already recorded session start is a read-only duplicate even while another writer holds the ledger", () => {
    const path = tempLedger();
    const started: LedgerEventInput = {
      kind: "session.started",
      workspace: "w",
      sessionId: "child",
      payload: { kind: "subagent", parentSessionId: "parent" },
    };
    const first = appendEvent(started, { path });
    expect(first.ok).toBe(true);
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    try {
      expect(appendEvent(started, { path })).toEqual({
        ok: true,
        duplicate: true,
        ulid: first.ok ? first.ulid : "",
      });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(rawRows(path)).toHaveLength(1);
  });

  test("retry jitter survives sleepSync truncating milliseconds to integers", () => {
    const path = tempLedger();
    const busy = busyFor(path, 2);
    const random = spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);
    const sleep = spyOn(Bun, "sleepSync");
    try {
      expect(appendEvent(toolCall, { path }).ok).toBe(true);
      // Bun coerces each argument to i32. Fractional 1..2 ms is always 1 ms.
      expect(sleep.mock.calls.map(([ms]) => Math.trunc(ms))).toEqual([1, 4]);
      expect(busy.attempts()).toBe(3);
    } finally {
      random.mockRestore();
      sleep.mockRestore();
    }
  });

  /**
   * Make the ledger's own connection report SQLITE_BUSY for the first `times`
   * inserts. `appendEvent` reuses the connection `openLedger` caches per path,
   * so this is the connection it writes through.
   */
  function busyFor(
    path: string,
    times: number,
  ): { attempts: () => number; busyTimeouts: () => number[] } {
    const db = openLedger(path);
    const query = db.query.bind(db);
    let attempts = 0;
    const busyTimeouts: number[] = [];
    // justification: the wrapper forwards to the real method and only adds a throw.
    db.query = ((sql: string) => {
      if (sql.trimStart().startsWith("INSERT")) {
        busyTimeouts.push(busyTimeout(db));
        if (attempts++ < times)
          throw Object.assign(new Error("database is locked"), {
            code: "SQLITE_BUSY",
          });
      }
      return query(sql);
    }) as typeof db.query;
    return { attempts: () => attempts, busyTimeouts: () => busyTimeouts };
  }

  function busyTimeout(db: Database): number {
    const statement = db.prepare<{ timeout: number }, []>(
      "PRAGMA busy_timeout",
    );
    try {
      return statement.get()?.timeout ?? -1;
    } finally {
      statement.finalize();
    }
  }

  for (const waitMs of [NaN, Infinity, -Infinity]) {
    test(`a non-finite busy wait (${waitMs}) uses the finite default and returns`, async () => {
      const path = tempLedger();
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { Database } from "bun:sqlite";
        import { appendEvent } from ${JSON.stringify(join(import.meta.dir, "append.ts"))};
        import { closeLedger, openLedger } from ${JSON.stringify(join(import.meta.dir, "db.ts"))};
        const path = ${JSON.stringify(path)};
        openLedger(path);
        const holder = new Database(path);
        holder.exec("BEGIN IMMEDIATE");
        console.log("lock held");
        const began = performance.now();
        const result = appendEvent({kind:"tool.called",workspace:"w",payload:{tool:"Bash",argsHash:"fixture"}}, {path, waitMs: ${String(waitMs)}});
        if (result.ok || !result.error.includes("locked")) throw Error("expected busy refusal");
        if (performance.now() - began < 100) throw Error("default wait was not used");
        holder.exec("ROLLBACK");
        holder.close();
        closeLedger(path);
        console.log("returned busy");
      `,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stdout, stderr }).toEqual({
        code: 0,
        stdout: "lock held\nreturned busy\n",
        stderr: "ledger: event not recorded: database is locked\n",
      });
      expect(rawRows(path)).toHaveLength(0);
    }, 15_000);
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

  test("several busy answers inside the append's wait are waited out, each try with SQLite's own busy wait off, and the connection gets its 50 ms wait back", () => {
    const path = tempLedger();
    const busy = busyFor(path, 3);
    expect(appendEvent(toolCall, { path }).ok).toBe(true);
    expect(busy.attempts()).toBe(4);
    expect(busy.busyTimeouts()).toEqual([0, 0, 0, 0]);
    expect(busyTimeout(openLedger(path))).toBe(50);
    closeLedger(path);
    expect(rawRows(path)).toHaveLength(1);
  });

  test("a ledger that stays busy is retried for its default 100 ms, then the event is refused and nothing is stored", () => {
    const path = tempLedger();
    const busy = busyFor(path, Number.POSITIVE_INFINITY);
    const began = performance.now();
    const result = appendEvent(toolCall, { path });
    const waited = performance.now() - began;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("locked");
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(1000);
    expect(busy.attempts()).toBeGreaterThan(2);
    expect(busyTimeout(openLedger(path))).toBe(50);
    closeLedger(path);
    expect(rawRows(path)).toHaveLength(0);
  });

  test("another connection's write lock held throughout: the append given waitMs 300 gives up after 300 ms and stores nothing", () => {
    const path = tempLedger();
    openLedger(path);
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    const began = performance.now();
    const result = appendEvent(toolCall, { path, waitMs: 300 });
    const waited = performance.now() - began;
    holder.exec("ROLLBACK");
    holder.close();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("locked");
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(1500);
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

describe("ledger invisible assignment boundary", () => {
  for (const invisible of ["\u200b", "\u00ad", "\u2060", "\u{e0020}"]) {
    for (const prefix of ["", `sk-${"Q7a".repeat(10)}`]) {
      test(`stores no value fragments or secret join IDs (${JSON.stringify(invisible)}, glued=${prefix !== ""})`, () => {
        const path = tempLedger();
        const value = "ValueHead_" + "9aZ".repeat(8) + "\ud800\ufeff_ValueTail";
        const text = `${prefix}OPENAI_API_KEY${invisible}=${value}`;
        expect(
          appendEvent(
            {
              kind: "verdict.bound",
              workspace: "w",
              payload: { verdict: "fail", summary: text },
              executor: { provider: text, model: text },
            },
            { path },
          ).ok,
        ).toBe(true);
        const stored = JSON.stringify(rawRows(path));
        expect(stored).not.toContain("ValueHead");
        expect(stored).not.toContain("ValueTail");
        expect(stored).toContain("[REDACTED:");
        expect(appendEvent({ ...toolCall, runId: text }, { path }).ok).toBe(
          false,
        );
        expect(rawRows(path)).toHaveLength(1);
      });
    }
  }
});
