import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { ledgerSink } from "./sinks";

const ledgers: string[] = [];
afterAll(() => {
  for (const ledger of ledgers) closeLedger(ledger);
});

function scratch(): { root: string; ledger: string } {
  const root = mkdtempSync(join(tmpdir(), "forge sink "));
  const ledger = join(root, "forge home", "ledger.db");
  ledgers.push(ledger);
  return { root, ledger };
}

const started: LedgerEventInput = {
  kind: "session.started",
  workspace: "C:/work/harness",
  beadId: "bead-9",
  sessionId: "session-9",
  executor: {
    provider: "claude",
    model: "m-1",
    effort: "low",
    smith: "claude-apprentice",
    sessionId: "session-9",
  },
  payload: { source: "headless:claude" },
};

describe("ledgerSink", () => {
  test("stores an event in the ledger file it was given and says so", async () => {
    const { ledger } = scratch();
    const result = await ledgerSink({ path: ledger })(started);
    expect(result).toEqual({ ok: true });
    const rows = queryEvents({ sessionId: "session-9" }, { path: ledger });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("session.started");
    expect(rows[0]?.executor?.smith).toBe("claude-apprentice");
    expect(rows[0]?.beadId).toBe("bead-9");
  });

  test("an invalid event is refused with a reason, not thrown, and nothing is stored", async () => {
    const { ledger } = scratch();
    const invalid = {
      ...started,
      sessionId: "session-bad",
      kind: "session.exploded",
    } as unknown as LedgerEventInput;
    const result = await ledgerSink({ path: ledger })(invalid);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("error");
    expect(
      queryEvents({ sessionId: "session-bad" }, { path: ledger }),
    ).toHaveLength(0);
  });

  test("a ledger file that cannot be opened is a refusal with a reason, not a throw", async () => {
    const { root } = scratch();
    // A directory where the ledger file should be: SQLite cannot open it.
    const result = await ledgerSink({ path: root })(started);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error.length).toBeGreaterThan(0);
  });
});
