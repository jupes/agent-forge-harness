import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { startTestHearth, type TestHearth } from "../hearth/testing";

const base = {
  requestId: "ab000000-0000-4000-8000-000000000001",
  expectedRevision: 0,
  acknowledge90Days: true,
};
test("compaction is protected and strictly validated; the audit precedes backup and fixed-ledger compaction", async () => {
  let backups = 0,
    compactions = 0,
    h: TestHearth | null = null;
  const fixture = await startTestHearth({
    api: {
      ledgerCompaction: {
        backup(options) {
          expect(options?.path).toBe(h?.ledger);
          expect(h?.events(["operator.action"]).at(-1)?.payload).toMatchObject({
            action: "app.ledger.compact",
            target: base.requestId,
          });
          backups++;
          return { path: "fixture", pruned: [] };
        },
        compact() {
          expect(backups).toBe(1);
          compactions++;
          return { events: 0, days: 0 };
        },
      },
    },
  });
  h = fixture;
  const request = {
    ...base,
    expectedLedgerKey: createHash("sha256")
      .update(resolve(fixture.ledger))
      .digest("hex"),
  };
  const post = (
    body: unknown,
    token: string | null = fixture.hearth.token,
    suffix = "",
  ) =>
    fetch(fixture.api + "/app-settings/ledger/compact" + suffix, {
      method: "POST",
      headers: fixture.headers(token),
      body: JSON.stringify(body),
    });
  try {
    for (const token of [null, "wrong"]) {
      expect((await post(request, token)).status).toBe(403);
      expect(
        (
          await fetch(fixture.api + "/app-settings/ledger/compaction", {
            headers: fixture.headers(token),
          })
        ).status,
      ).toBe(403);
    }
    expect((await post({ ...request, cutoff: "2099" })).status).toBe(400);
    expect(
      (await post(request, fixture.hearth.token, "?path=other")).status,
    ).toBe(400);
    expect(backups).toBe(0);
    expect((await post(request)).status).toBe(200);
    expect(compactions).toBe(1);
    expect((await post(request)).status).toBe(409);
    expect(backups).toBe(1);
    expect(fixture.bd.calls).toEqual([]);
  } finally {
    await fixture.close();
  }
});
test("audit refusal starts no maintenance or durable intent", async () => {
  let calls = 0;
  const h = await startTestHearth({
    api: {
      appendEvent: () => ({ ok: false, error: "fixture audit refusal" }),
      ledgerCompaction: {
        backup() {
          calls++;
          throw Error("Must not run");
        },
      },
    },
  });
  try {
    const response = await fetch(h.api + "/app-settings/ledger/compact", {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: JSON.stringify({ ...base, expectedLedgerKey: "a".repeat(64) }),
    });
    expect(response.status).toBe(503);
    expect(calls).toBe(0);
  } finally {
    await h.close();
  }
});
